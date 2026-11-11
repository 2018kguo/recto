use crate::cache::{Cache, CacheKey};
use crate::color::{Color, ColorComponents, ColorSpace};
use crate::convert::convert_transform;
use crate::font::{FontCache, PositionedGlyph, StandardFont};
use crate::interpret::stack::StateStack;
use crate::interpret::state::{
    ClipType, CompositingState, PaintData, PaintState, State, TextState, TextStateFont,
};
use crate::ocg::OcgState;
use crate::util::{BezPathExt, Float64Ext};
use crate::{
    ClipPath, Device, DrawProps, FillRule, InterpreterSettings, InterpreterWarning, Paint,
    StrokeProps,
};
use hayro_syntax::content::ops::Transform;
use hayro_syntax::object::Dict;
use hayro_syntax::object::Name;
use hayro_syntax::object::ObjectIdentifier;
use hayro_syntax::page::Resources;
use hayro_syntax::xref::XRef;
use kurbo::{Affine, BezPath, PathEl, Point, Rect, Shape};
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use smallvec::smallvec;

std::thread_local! {
    static DICTIONARY_READS: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
}

/// recto: how many form dictionaries this thread has read to draw them, for the
/// tests that a page reads each once however often it draws it.
#[doc(hidden)]
pub fn dictionary_reads() -> usize {
    DICTIONARY_READS.with(|n| n.get())
}

pub(crate) fn count_dictionary_read() {
    DICTIONARY_READS.with(|n| n.set(n.get() + 1));
}

/// recto: what a page may spend on drawing that costs far more than its size. Shared by the contexts
/// nested in a page's, through their settings, so each page's interpretation needs its own, as
/// `InterpreterSettings::default` gives it. Past any of these the page is incomplete, and `tripped` says so.
#[derive(Debug)]
pub struct PageBudget {
    nested: AtomicU32,
    annotation_points: AtomicUsize,
    expression_nodes: AtomicU32,
    tripped: AtomicBool,
}

impl PageBudget {
    /// See `Context::charge_nested`. At a run a form in a form, that's 262,144 on a page.
    pub const NESTED: u32 = 1 << 20;
    /// All of a page's annotations with no appearance. Each of a list's items can ask for
    /// thousands of points, so a cap on one list leaves gigabytes of stream.
    pub const ANNOTATION_POINTS: usize = 1 << 17;
    /// One `/VE`: an operand can name the same expression twice, so depth alone leaves 2^32.
    pub const EXPRESSION_NODES: u32 = 1 << 10;

    /// Whether anything on the page was left out for this budget.
    pub fn tripped(&self) -> bool {
        self.tripped.load(Ordering::Relaxed)
    }

    pub(crate) fn trip(&self) {
        self.tripped.store(true, Ordering::Relaxed);
    }

    /// How much of each limit this page used: nested streams, annotation points, and the most
    /// any one `/VE` visited.
    pub fn used(&self) -> (u32, usize, u32) {
        (
            Self::NESTED - self.nested.load(Ordering::Relaxed),
            Self::ANNOTATION_POINTS - self.annotation_points.load(Ordering::Relaxed),
            self.expression_nodes.load(Ordering::Relaxed),
        )
    }

    pub(crate) fn annotation_points(&self) -> usize {
        self.annotation_points.load(Ordering::Relaxed)
    }

    pub(crate) fn set_annotation_points(&self, left: usize) {
        self.annotation_points.store(left, Ordering::Relaxed);
    }

    pub(crate) fn note_expression(&self, nodes: u32) {
        self.expression_nodes.fetch_max(nodes, Ordering::Relaxed);
    }
}

impl Default for PageBudget {
    fn default() -> Self {
        Self {
            nested: AtomicU32::new(Self::NESTED),
            annotation_points: AtomicUsize::new(Self::ANNOTATION_POINTS),
            expression_nodes: AtomicU32::new(0),
            tripped: AtomicBool::new(false),
        }
    }
}

/// Maximum nesting depth for interpreting `XObject`'s/patterns/streams.
pub(crate) const MAX_NESTED_INTERPRETATION_DEPTH: u32 = 50;

/// A cache used by the interpreter.
///
/// Ideally, such a cache should be constructed once per PDF and then reused across
/// multiple interpreter invocations on the same document.
// TODO: Cache keys are only unique within a document (streams, for example, are keyed by
// their object identifier), so a cache shared across documents can mix up their objects.
#[derive(Clone)]
pub struct InterpreterCache<'a> {
    pub(crate) font_cache: FontCache<'a>,
    pub(crate) object_cache: Cache,
}

impl<'a> Default for InterpreterCache<'a> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> InterpreterCache<'a> {
    /// Create a new interpreter cache.
    pub fn new() -> Self {
        Self {
            font_cache: FontCache::new(),
            object_cache: Cache::new(),
        }
    }

    /// recto: an empty cache that shares `self`'s embedded font programs (see
    /// `FontCache::sharing_programs`), for reading the same document with other settings.
    pub fn sharing_font_programs(&self) -> Self {
        Self {
            font_cache: self.font_cache.sharing_programs(),
            object_cache: Cache::new(),
        }
    }

    /// recto: as `sharing_font_programs`, but its fonts load an embedded program only when
    /// something is asked of them that their dictionary doesn't answer (see
    /// `FontCache::loading_programs_on_use`), for passes that read text rather than draw it.
    pub fn sharing_font_programs_loaded_on_use(&self) -> Self {
        Self {
            font_cache: self.font_cache.loading_programs_on_use(),
            object_cache: Cache::new(),
        }
    }

    /// recto: how many embedded font programs this cache and those sharing them have decoded, for tests.
    #[doc(hidden)]
    pub fn embedded_font_programs_decoded(&self) -> usize {
        self.font_cache.embedded_programs_decoded()
    }
}

/// A per-page interpretation context that borrows shared data from an [`InterpreterCache`].
pub struct Context<'a> {
    stack: StateStack<'a>,
    path: BezPath,
    /// recto: where in `path` each `re` rectangle starts (element indices,
    /// ascending), for `Device::path_rects`.
    pub(crate) rect_starts: Vec<u32>,
    sub_path_start: Point,
    last_point: Point,
    clip: Option<FillRule>,
    root_transforms: Vec<Affine>,
    bbox: Vec<Rect>,
    pub(crate) settings: InterpreterSettings,
    pub(crate) interpreter_cache: InterpreterCache<'a>,
    pub(crate) xref: &'a XRef,
    pub(crate) ocg_state: OcgState,
    nesting_depth: u32,
    pub(crate) glyph_scratch: Vec<PositionedGlyph<'a>>,
    /// recto: the fields the form lists, read when a widget with no appearance needs them.
    pub(crate) form_fields: Option<std::collections::HashSet<ObjectIdentifier>>,
    /// recto: what each form drawn here says of itself, read once.
    pub(crate) x_objects: crate::x_object::XObjectInfos<'a>,
}

impl<'a> Context<'a> {
    /// Create a new context.
    pub fn new(
        initial_transform: Affine,
        bbox: Rect,
        cache: &InterpreterCache<'a>,
        xref: &'a XRef,
        settings: InterpreterSettings,
    ) -> Self {
        let state = State::new(initial_transform);
        Self::new_with(initial_transform, bbox, cache, xref, settings, state, 0)
    }

    pub(crate) fn new_with(
        initial_transform: Affine,
        bbox: Rect,
        cache: &InterpreterCache<'a>,
        xref: &'a XRef,
        settings: InterpreterSettings,
        state: State<'a>,
        nesting_depth: u32,
    ) -> Self {
        let ocg_state = {
            let root_ref = xref.root_id();
            xref.get::<Dict<'_>>(root_ref)
                .map(|catalog| OcgState::from_catalog(&catalog))
                .unwrap_or_default()
                .with_budget(settings.budget.clone())
        };

        Self {
            stack: StateStack::new(state),
            settings,
            xref,
            root_transforms: vec![initial_transform],
            last_point: Point::default(),
            sub_path_start: Point::default(),
            clip: None,
            bbox: vec![bbox],
            path: BezPath::new(),
            rect_starts: Vec::new(),
            interpreter_cache: cache.clone(),
            ocg_state,
            nesting_depth,
            glyph_scratch: Vec::new(),
            form_fields: None,
            x_objects: Default::default(),
        }
    }

    pub(crate) fn save_state(&mut self) {
        self.stack.save();
    }

    pub(crate) fn bbox(&self) -> Rect {
        self.bbox
            .last()
            .copied()
            .unwrap_or_else(|| Rect::new(0.0, 0.0, 1.0, 1.0))
    }

    fn push_bbox(&mut self, bbox: Rect) {
        let new = self.bbox().intersect(bbox);
        self.bbox.push(new);
    }

    pub(crate) fn push_clip_path(
        &mut self,
        clip_path: BezPath,
        fill: FillRule,
        device: &mut impl Device<'a>,
    ) {
        if let Some(clip_rect) = path_as_rect(&clip_path) {
            let cur_bbox = self.bbox();

            // If the clip path is a rect and completely covers the current bbox, don't emit it.
            if cur_bbox
                .min_x()
                .is_nearly_greater_or_equal(clip_rect.min_x())
                && cur_bbox
                    .min_y()
                    .is_nearly_greater_or_equal(clip_rect.min_y())
                && cur_bbox.max_x().is_nearly_less_or_equal(clip_rect.max_x())
                && cur_bbox.max_y().is_nearly_less_or_equal(clip_rect.max_y())
            {
                self.stack.push_clip(ClipType::Dummy);
                return;
            }

            device.push_clip_rect(&clip_rect);
            self.push_bbox(clip_rect);
            self.stack.push_clip(ClipType::Real);
            return;
        }

        let bbox = clip_path.bounding_box();
        let clip_path = match fill {
            FillRule::EvenOdd => widen_covering_rect(clip_path, self.bbox()),
            FillRule::NonZero => clip_path,
        };
        device.push_clip_path(&ClipPath {
            path: clip_path,
            fill,
        });
        self.push_bbox(bbox);
        self.stack.push_clip(ClipType::Real);
    }

    pub(crate) fn pop_clip(&mut self, device: &mut impl Device<'a>) {
        if let Some(ClipType::Real) = self.stack.pop_clip() {
            device.pop_clip();
            self.pop_bbox();
        }
    }

    fn pop_bbox(&mut self) {
        self.bbox.pop();
    }

    pub(crate) fn push_root_transform(&mut self) {
        self.root_transforms.push(self.ctm());
    }

    pub(crate) fn pop_root_transform(&mut self) {
        self.root_transforms.pop();
    }

    pub(crate) fn root_transform(&self) -> Affine {
        self.root_transforms
            .last()
            .copied()
            .unwrap_or(Affine::IDENTITY)
    }

    pub(crate) fn restore_state(&mut self, device: &mut impl Device<'a>) {
        let Some(target_clips) = self.stack.restore_target_clips() else {
            return;
        };

        while self.stack.num_clips() > target_clips {
            self.pop_clip(device);
        }

        self.stack.restore();
    }

    pub(crate) fn draw_props(&self, is_stroke: bool) -> DrawProps<'a> {
        DrawProps {
            transform: self.ctm(),
            paint: self.get_paint(is_stroke),
            soft_mask: self.compositing().soft_mask.clone(),
            blend_mode: self.compositing().blend_mode,
        }
    }

    pub(crate) fn get_paint(&self, is_stroke: bool) -> Paint<'a> {
        let paint = if is_stroke {
            self.stroke_paint()
        } else {
            self.fill_paint()
        };
        let data = PaintData {
            alpha: paint.alpha,
            // recto: a memcpy (SmallVec::clone copies element by element).
            color: ColorComponents::from_slice(&paint.color),
            color_space: paint.color_space.clone(),
            pattern: paint.pattern.clone(),
            transfer_function: self.compositing().transfer_function.clone(),
        };

        if data.color_space.is_pattern() || data.pattern.is_some() {
            if let Some(mut pattern) = data.pattern {
                pattern.set_opacity(data.alpha);

                if let Some(tf) = &data.transfer_function {
                    pattern.set_transfer_function(tf.clone());
                }

                pattern.pre_concat_transform(self.root_transform());

                Paint::Pattern(Box::new(pattern))
            } else {
                // Pattern was likely invalid, use transparent paint.
                Paint::Color(Color::new(ColorSpace::device_gray(), smallvec![0.0], 0.0))
            }
        } else {
            let color = Color::new(data.color_space, data.color, data.alpha);

            if let Some(tf) = &data.transfer_function {
                Paint::Color(Color::from_rgba(tf.apply(&color.to_rgba())))
            } else {
                Paint::Color(color)
            }
        }
    }

    pub(crate) fn path(&self) -> &BezPath {
        &self.path
    }

    /// recto: ends the current path, and what `re` marked in it.
    pub(crate) fn clear_path(&mut self) {
        self.path.truncate(0);
        self.rect_starts.clear();
    }

    pub(crate) fn path_mut(&mut self) -> &mut BezPath {
        &mut self.path
    }

    pub(crate) fn sub_path_start(&self) -> &Point {
        &self.sub_path_start
    }

    pub(crate) fn sub_path_start_mut(&mut self) -> &mut Point {
        &mut self.sub_path_start
    }

    pub(crate) fn last_point(&self) -> &Point {
        &self.last_point
    }

    pub(crate) fn last_point_mut(&mut self) -> &mut Point {
        &mut self.last_point
    }

    pub(crate) fn clip_mut(&mut self) -> &mut Option<FillRule> {
        &mut self.clip
    }

    pub(crate) fn ctm(&self) -> Affine {
        *self.stack.ctm()
    }

    pub(crate) fn ctm_mut(&mut self) -> &mut Affine {
        self.stack.ctm_mut()
    }

    pub(crate) fn stroke_paint(&self) -> &PaintState<'a> {
        self.stack.stroke()
    }

    pub(crate) fn stroke_paint_mut(&mut self) -> &mut PaintState<'a> {
        self.stack.stroke_mut()
    }

    pub(crate) fn fill_paint(&self) -> &PaintState<'a> {
        self.stack.fill()
    }

    pub(crate) fn fill_paint_mut(&mut self) -> &mut PaintState<'a> {
        self.stack.fill_mut()
    }

    pub(crate) fn stroke_props(&self) -> &StrokeProps {
        self.stack.stroke_props()
    }

    pub(crate) fn stroke_props_mut(&mut self) -> &mut StrokeProps {
        self.stack.stroke_props_mut()
    }

    pub(crate) fn text_state(&self) -> &TextState<'a> {
        self.stack.text()
    }

    pub(crate) fn text_state_mut(&mut self) -> &mut TextState<'a> {
        self.stack.text_mut()
    }

    pub(crate) fn compositing(&self) -> &CompositingState<'a> {
        self.stack.compositing()
    }

    pub(crate) fn compositing_mut(&mut self) -> &mut CompositingState<'a> {
        self.stack.compositing_mut()
    }

    /// A copy of the current graphics state.
    pub(crate) fn snapshot(&self) -> State<'a> {
        self.stack.snapshot()
    }

    pub(crate) fn pre_concat_transform(&mut self, transform: Transform) {
        self.pre_concat_affine(convert_transform(transform));
    }

    pub(crate) fn pre_concat_affine(&mut self, transform: Affine) {
        *self.ctm_mut() *= transform;
    }

    pub(crate) fn get_color_space(
        &mut self,
        resources: &Resources<'_>,
        name: &Name<'_>,
    ) -> Option<ColorSpace> {
        let cs_object = resources.get_color_space(name)?;
        self.interpreter_cache
            .object_cache
            .get_or_insert_with(cs_object.cache_key(), || {
                ColorSpace::new(cs_object.clone(), &self.interpreter_cache.object_cache)
            })
    }

    pub(crate) fn num_states(&self) -> usize {
        self.stack.len()
    }

    pub(crate) fn nesting_depth(&self) -> u32 {
        self.nesting_depth
    }

    pub(crate) fn begin_nested_interpretation(&mut self) -> bool {
        if self.nesting_depth >= MAX_NESTED_INTERPRETATION_DEPTH {
            self.settings.budget.trip();
            return false;
        }

        self.nesting_depth += 1;

        true
    }

    /// recto: pays to run a stream at this depth, and says whether the page can afford it. A form that
    /// draws the next one twice is 2^depth runs from a few KB, and so is a pattern or a Type 3 glyph.
    /// Nothing else limits that, so each level down costs four times as much. The page's own
    /// streams are as long as the file makes them, and cost nothing.
    pub(crate) fn charge_nested(&self) -> bool {
        if self.nesting_depth <= 1 {
            return true;
        }
        let cost = 1u32 << (2 * (self.nesting_depth - 1).min(8));
        let paid = self
            .settings
            .budget
            .nested
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |left| left.checked_sub(cost))
            .is_ok();
        if !paid {
            self.settings.budget.trip();
        }
        paid
    }

    /// recto: what this page has spent of its budget: see `PageBudget::used`.
    pub fn budget_used(&self) -> (u32, usize, u32) {
        self.settings.budget.used()
    }

    /// recto: whether this page left anything out for its budget.
    pub fn budget_tripped(&self) -> bool {
        self.settings.budget.tripped()
    }

    pub(crate) fn end_nested_interpretation(&mut self) {
        self.nesting_depth = self.nesting_depth.saturating_sub(1);
    }

    pub(crate) fn fallback_font(&self) -> Option<TextStateFont<'a>> {
        self.interpreter_cache
            .font_cache
            .standard_font(StandardFont::Helvetica, &self.settings.font_resolver)
            .map(TextStateFont::Fallback)
    }

    pub(crate) fn resolve_font(&mut self, font_dict: &Dict<'a>) -> Option<TextStateFont<'a>> {
        let resolved = self.interpreter_cache.font_cache.font(
            font_dict,
            &self.settings.font_resolver,
            &self.settings.cmap_resolver,
        );

        if let Some(resolved) = resolved {
            Some(TextStateFont::Font(resolved))
        } else {
            (self.settings.warning_sink)(InterpreterWarning::UnsupportedFont);

            self.fallback_font()
        }
    }
}

/// recto: an even-odd clip whose first subpath is a rectangle around all of `cur_bbox`, with holes cut
/// in it by the others. Word draws these: a page-sized rectangle with one hole, a clip per hole, nested
/// dozens deep, and rasterizing the rectangle's outline on every push took a third to half of such a
/// page's time. Inside `cur_bbox` that rectangle and any larger one cover everything, so it becomes one
/// far past any viewport, whose edges the rasterizer culls (the left one only adds winding). As when a
/// rectangle clip around `cur_bbox` is dropped (`push_clip_path`), all that can change is the pixels the
/// rectangle's edge crosses, if the current clip lets them through: they're no longer cut by it again.
fn widen_covering_rect(path: BezPath, cur_bbox: Rect) -> BezPath {
    // Past the largest viewport (u16 a side), in every direction.
    const FAR: f64 = 100_000.0;
    let els = path.elements();
    let Some(second) = els.iter().skip(1).position(|e| matches!(e, PathEl::MoveTo(_))) else {
        return path;
    };
    let first = &els[..second + 1];
    // Word closes its `m l l l l` back at the start with an `h` as well.
    let outline = match first {
        [head @ .., PathEl::LineTo(_), PathEl::ClosePath] if head.len() == 4 => &first[..5],
        _ => first,
    };
    let Some(rect) = path_as_rect(&BezPath::from_vec(outline.to_vec())) else {
        return path;
    };
    let covers = cur_bbox.min_x().is_nearly_greater_or_equal(rect.min_x())
        && cur_bbox.min_y().is_nearly_greater_or_equal(rect.min_y())
        && cur_bbox.max_x().is_nearly_less_or_equal(rect.max_x())
        && cur_bbox.max_y().is_nearly_less_or_equal(rect.max_y());
    let wide = Rect::new(-FAR, -FAR, FAR, FAR);
    if !covers || !wide.contains_rect(cur_bbox) {
        return path;
    }
    let mut out = BezPath::with_capacity(els.len() - first.len() + 5);
    out.move_to((-FAR, -FAR));
    out.line_to((FAR, -FAR));
    out.line_to((FAR, FAR));
    out.line_to((-FAR, FAR));
    out.close_path();
    for &el in &els[first.len()..] {
        out.push(el);
    }
    out
}

pub(crate) fn path_as_rect(path: &BezPath) -> Option<Rect> {
    let points = match path.elements() {
        [
            PathEl::MoveTo(first),
            PathEl::LineTo(second),
            PathEl::LineTo(third),
            PathEl::LineTo(fourth),
            PathEl::ClosePath,
        ] => [*first, *second, *third, *fourth, *first],
        [
            PathEl::MoveTo(first),
            PathEl::LineTo(second),
            PathEl::LineTo(third),
            PathEl::LineTo(fourth),
            PathEl::LineTo(last),
        ] if first.x.is_nearly_equal(last.x) && first.y.is_nearly_equal(last.y) => {
            [*first, *second, *third, *fourth, *last]
        }
        _ => return None,
    };

    let mut previous_axis = None;
    for edge in points.windows(2) {
        let same_x = edge[0].x.is_nearly_equal(edge[1].x);
        let same_y = edge[0].y.is_nearly_equal(edge[1].y);
        if same_x == same_y || previous_axis == Some(same_x) {
            return None;
        }
        previous_axis = Some(same_x);
    }

    Some(path.fast_bounding_box())
}
