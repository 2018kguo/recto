//! Reading the pages of a PDF document.

use crate::content::{TypedIter, UntypedIter};
use crate::object::Array;
use crate::object::Dict;
use crate::object::Name;
use crate::object::Rect;
use crate::object::Stream;
use crate::object::array::ArrayIter;
use crate::object::dict::keys::*;
use crate::object::{MaybeRef, Object};
use crate::reader::ReaderContext;
use crate::object::ObjectIdentifier;
use crate::sync::{FxHashMap, FxHashSet, Mutex, MutexExt, OnceLock};
use crate::transform::Transform;
use crate::util::FloatExt;
use crate::xref::XRef;
use alloc::vec;
use alloc::vec::Vec;
use core::ops::Deref;

/// Attributes that can be inherited.
#[derive(Debug, Clone)]
struct PagesContext<'a> {
    media_box: Option<Rect>,
    crop_box: Option<Rect>,
    rotate: Option<i32>,
    resources: Dict<'a>,
}

impl PagesContext<'_> {
    fn new() -> Self {
        Self {
            media_box: None,
            crop_box: None,
            rotate: None,
            resources: Dict::empty(),
        }
    }
}

/// A structure holding the pages of a PDF document.
pub struct Pages<'a> {
    pages: Vec<Page<'a>>,
    // recto: page `i` found on first use, when the tree's counts hold up.
    lazy: Option<LazyPages<'a>>,
    xref: &'a XRef,
}

/// recto: pages found on demand by descending the tree by each kid's
/// `/Count`, so a ranged file fetches only the nodes on the way to a page and
/// a whole file builds only the pages asked for. Equal to the eager walk when
/// every `/Count` is right; `Deref` still builds the eager list for other callers.
struct LazyPages<'a> {
    root: Dict<'a>,
    ctx: ReaderContext<'a>,
    found: Vec<OnceLock<Option<Page<'a>>>>,
    eager: OnceLock<Vec<Page<'a>>>,
    /// Tree nodes by their dict's address, each resolved as far as asked,
    /// so reading every page of a flat tree is linear, not quadratic.
    nodes: Mutex<FxHashMap<usize, Option<Node<'a>>>>,
    /// Kids already met, skipped when met again (as the eager walk does).
    visited: Mutex<FxHashSet<ObjectIdentifier>>,
}

struct Node<'a> {
    frame: PageTreeFrame<'a>,
    /// As many kids as `/Count`: all pages (see `counts_add_up`), so kid `i`
    /// is page `i`, read directly.
    flat: Option<Vec<MaybeRef<Object<'a>>>>,
    /// Resolved kids in order: the first page index each covers, and itself.
    kids: Vec<(usize, Kid<'a>)>,
    /// Pages covered by `kids`.
    end: usize,
}

enum Kid<'a> {
    Page(Dict<'a>),
    Pages(Dict<'a>),
}

fn node_key(dict: &Dict<'_>) -> usize {
    dict.data().as_ptr() as usize
}

impl<'a> LazyPages<'a> {
    fn find(&self, mut index: usize) -> Option<Page<'a>> {
        let mut nodes = self.nodes.get();
        let mut key = node_key(&self.root);
        nodes
            .entry(key)
            .or_insert_with(|| new_node(&self.root, PagesContext::new()));
        loop {
            let node = nodes.get_mut(&key)?.as_mut()?;
            if let Some(kids) = &node.flat {
                let dict = match kids.get(index)? {
                    MaybeRef::Ref(id) => self.ctx.xref().get_with::<Dict<'a>>((*id).into(), &self.ctx)?,
                    MaybeRef::NotRef(object) => object.clone().into_dict()?,
                };
                if dict.get::<Name<'_>>(TYPE).as_deref() != Some(PAGES) {
                    return Page::new(&dict, &node.frame.ctx, &self.ctx, false);
                }
                // A node of one page takes that page's place. Any other only gets
                // here by the coincidence `counts_add_up` lists for a ranged file.
                if dict.get::<usize>(COUNT) != Some(1) {
                    return None;
                }
                index = 0;
                let ctx = node.frame.ctx.clone();
                key = node_key(&dict);
                nodes.entry(key).or_insert_with(|| new_node(&dict, ctx));
                continue;
            }
            while node.end <= index {
                let dict = match node.frame.kids.next()? {
                    MaybeRef::Ref(id) => {
                        if !self.visited.get().insert(id.into()) {
                            continue;
                        }
                        self.ctx.xref().get_with::<Dict<'a>>(id.into(), &self.ctx)?
                    }
                    MaybeRef::NotRef(object) => object.into_dict()?,
                };
                let (kid, span) = if dict.get::<Name<'_>>(TYPE).as_deref() == Some(PAGES) {
                    let count = dict.get::<usize>(COUNT)?;
                    (Kid::Pages(dict), count)
                } else {
                    (Kid::Page(dict), 1)
                };
                node.kids.push((node.end, kid));
                node.end += span;
            }
            let at = node.kids.partition_point(|(start, _)| *start <= index) - 1;
            let (start, kid) = &node.kids[at];
            match kid {
                Kid::Page(dict) => return Page::new(dict, &node.frame.ctx, &self.ctx, false),
                Kid::Pages(dict) => {
                    index -= start;
                    let (child, ctx) = (dict.clone(), node.frame.ctx.clone());
                    key = node_key(&child);
                    nodes.entry(key).or_insert_with(|| new_node(&child, ctx));
                }
            }
        }
    }
}

/// recto: a node's `/Count`, if it adds up. A whole file has every kid read,
/// so a tree that passes holds exactly what the eager walk would find and
/// anything odd (a missing or repeated kid, a wrong `/Count`) goes to that
/// walk. A ranged file can't afford that: a node with as many kids as its
/// `/Count` is taken as all pages (the usual bottom level) without fetching
/// them, the others have their kids read and summed.
/// Limit (ranged only): a bottom node whose kid count matches by coincidence
/// (a node of 2 pages plus a missing page) passes.
fn counts_add_up<'a>(
    dict: &Dict<'a>,
    ctx: &ReaderContext<'a>,
    visited: &mut FxHashSet<ObjectIdentifier>,
    depth: usize,
) -> Option<usize> {
    // Not the eager walk's own stack: a chain of nodes mustn't overflow this one.
    if depth == MAX_CHECKED_DEPTH {
        return None;
    }
    let count = dict.get::<usize>(COUNT)?;
    let kids = dict.get::<Array<'a>>(KIDS)?;
    if ctx.xref().is_ranged() && kids.raw_iter().count() == count {
        return Some(count);
    }
    let mut sum: usize = 0;
    for kid in kids.raw_iter() {
        let kid = match kid {
            MaybeRef::Ref(id) => {
                if !visited.insert(id.into()) {
                    return None;
                }
                ctx.xref().get_with::<Dict<'a>>(id.into(), ctx)?
            }
            MaybeRef::NotRef(object) => object.into_dict()?,
        };
        sum = sum.checked_add(if kid.get::<Name<'_>>(TYPE).as_deref() == Some(PAGES) {
            counts_add_up(&kid, ctx, visited, depth + 1)?
        } else {
            1
        })?;
    }
    (sum == count).then_some(count)
}

const MAX_CHECKED_DEPTH: usize = 64;

fn new_node<'a>(dict: &Dict<'a>, ctx: PagesContext<'a>) -> Option<Node<'a>> {
    let flat = dict
        .get::<Array<'a>>(KIDS)
        .map(|kids| kids.raw_iter().collect::<Vec<_>>())
        .filter(|kids| Some(kids.len()) == dict.get::<usize>(COUNT));
    Some(Node {
        flat,
        frame: PageTreeFrame::new(dict, ctx)?,
        kids: vec![],
        end: 0,
    })
}

impl<'a> Pages<'a> {
    /// Create a new `Pages` object.
    pub(crate) fn new(
        pages_dict: &Dict<'a>,
        ctx: &ReaderContext<'a>,
        xref: &'a XRef,
    ) -> Option<Self> {
        // recto: when the root's `/Count` holds up (see `counts_add_up`), and is
        // no more than the file's objects, pages are built on demand.
        if let Some(count) = pages_dict.get::<usize>(COUNT)
            && count <= xref.len()
            && counts_add_up(pages_dict, ctx, &mut FxHashSet::default(), 0) == Some(count)
        {
            return Some(Self {
                pages: vec![],
                lazy: Some(LazyPages {
                    root: pages_dict.clone(),
                    ctx: ctx.clone(),
                    found: (0..count).map(|_| OnceLock::new()).collect(),
                    eager: OnceLock::new(),
                    nodes: Mutex::new(FxHashMap::default()),
                    visited: Mutex::new(pages_dict.obj_id().into_iter().collect()),
                }),
                xref,
            });
        }
        let mut pages = vec![];
        let pages_ctx = PagesContext::new();
        resolve_pages(pages_dict, &mut pages, pages_ctx, ctx)?;

        Some(Self {
            pages,
            lazy: None,
            xref,
        })
    }

    /// recto: the number of pages (the root's `/Count` when lazy).
    pub fn len(&self) -> usize {
        match &self.lazy {
            Some(lazy) => lazy.found.len(),
            None => self.pages.len(),
        }
    }

    /// recto: whether there are no pages.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// recto: page `index`, found on first use when lazy.
    pub fn get(&self, index: usize) -> Option<&Page<'a>> {
        match &self.lazy {
            Some(lazy) => lazy.found.get(index)?.get_or_init(|| lazy.find(index)).as_ref(),
            None => self.pages.get(index),
        }
    }

    /// Create a new `Pages` object by bruteforce-searching.
    ///
    /// Of course this could result in the order of pages being messed up, but
    /// this is still better than nothing.
    pub(crate) fn new_brute_force(ctx: &ReaderContext<'a>, xref: &'a XRef) -> Option<Self> {
        let mut pages = vec![];

        for object in xref.objects() {
            if let Some(dict) = object.into_dict()
                && let Some(page) = Page::new(&dict, &PagesContext::new(), ctx, true)
            {
                pages.push(page);
            }
        }

        if pages.is_empty() {
            return None;
        }

        Some(Self {
            pages,
            lazy: None,
            xref,
        })
    }

    /// Return the xref table (of the document the pages belong to).   
    pub fn xref(&self) -> &'a XRef {
        self.xref
    }
}

impl<'a> Deref for Pages<'a> {
    type Target = [Page<'a>];

    fn deref(&self) -> &Self::Target {
        match &self.lazy {
            Some(lazy) => lazy.eager.get_or_init(|| {
                let mut pages = vec![];
                let _ = resolve_pages(&lazy.root, &mut pages, PagesContext::new(), &lazy.ctx);
                pages
            }),
            None => &self.pages,
        }
    }
}

struct PageTreeFrame<'a> {
    kids: ArrayIter<'a>,
    ctx: PagesContext<'a>,
}

impl<'a> PageTreeFrame<'a> {
    fn new(dict: &Dict<'a>, mut ctx: PagesContext<'a>) -> Option<Self> {
        ctx.media_box = dict.get::<Rect>(MEDIA_BOX).or(ctx.media_box);
        ctx.crop_box = dict.get::<Rect>(CROP_BOX).or(ctx.crop_box);
        ctx.rotate = dict.get::<i32>(ROTATE).or(ctx.rotate);
        if let Some(resources) = dict.get::<Dict<'a>>(RESOURCES) {
            ctx.resources = resources;
        }

        Some(Self {
            kids: dict.get::<Array<'a>>(KIDS)?.raw_iter(),
            ctx,
        })
    }
}

fn resolve_pages<'a>(
    pages_dict: &Dict<'a>,
    entries: &mut Vec<Page<'a>>,
    ctx: PagesContext<'a>,
    reader_ctx: &ReaderContext<'a>,
) -> Option<()> {
    let mut visited = FxHashSet::default();

    if let Some(id) = pages_dict.obj_id() {
        visited.insert(id);
    }

    let mut stack = vec![PageTreeFrame::new(pages_dict, ctx)?];

    while let Some(frame) = stack.last_mut() {
        let Some(kid) = frame.kids.next() else {
            stack.pop();

            continue;
        };

        let dict = match kid {
            MaybeRef::Ref(id) => {
                if !visited.insert(id.into()) {
                    continue;
                }

                reader_ctx
                    .xref()
                    .get_with::<Dict<'a>>(id.into(), reader_ctx)
            }
            MaybeRef::NotRef(object) => object.into_dict(),
        };

        let Some(dict) = dict else {
            continue;
        };

        match dict.get::<Name<'_>>(TYPE).as_deref() {
            Some(PAGES) => {
                if let Some(child) = PageTreeFrame::new(&dict, frame.ctx.clone()) {
                    stack.push(child);
                }
            }
            // Let's be lenient and assume it's a `Page` in case it's `None` or something else
            // (see corpus test case 0083781).
            _ => {
                if let Some(page) = Page::new(&dict, &frame.ctx, reader_ctx, false) {
                    entries.push(page);
                }
            }
        }
    }

    Some(())
}

/// The rotation of the page.
#[derive(Debug, Copy, Clone)]
pub enum Rotation {
    /// No rotation.
    None,
    /// A rotation of 90 degrees.
    Horizontal,
    /// A rotation of 180 degrees.
    Flipped,
    /// A rotation of 270 degrees.
    FlippedHorizontal,
}

/// A PDF page.
pub struct Page<'a> {
    inner: Dict<'a>,
    media_box: Rect,
    crop_box: Rect,
    rotation: Rotation,
    page_streams: OnceLock<Option<Vec<u8>>>,
    resources: Resources<'a>,
    ctx: ReaderContext<'a>,
}

impl<'a> Page<'a> {
    fn new(
        dict: &Dict<'a>,
        ctx: &PagesContext<'a>,
        reader_ctx: &ReaderContext<'a>,
        brute_force: bool,
    ) -> Option<Self> {
        // In general, pages without content are allowed, but in case we are brute-forcing
        // we ignore them.
        if brute_force && !dict.contains_key(CONTENTS) {
            return None;
        }

        let media_box = dict.get::<Rect>(MEDIA_BOX).or(ctx.media_box).unwrap_or(A4);

        let crop_box = dict
            .get::<Rect>(CROP_BOX)
            .or(ctx.crop_box)
            .unwrap_or(media_box);

        let rotation = match dict
            .get::<i32>(ROTATE)
            .or(ctx.rotate)
            .unwrap_or(0)
            .rem_euclid(360)
        {
            0 => Rotation::None,
            90 => Rotation::Horizontal,
            180 => Rotation::Flipped,
            270 => Rotation::FlippedHorizontal,
            _ => Rotation::None,
        };

        let resources = Resources::new(
            dict.get::<Dict<'a>>(RESOURCES)
                .unwrap_or_else(|| ctx.resources.clone()),
        );

        Some(Self {
            inner: dict.clone(),
            media_box,
            crop_box,
            rotation,
            page_streams: OnceLock::new(),
            resources,
            ctx: reader_ctx.clone(),
        })
    }

    fn operations_impl(&self) -> Option<UntypedIter<'_>> {
        let stream = self.page_stream()?;
        let iter = UntypedIter::new(stream);

        Some(iter)
    }

    /// Return the decoded content stream of the page.
    pub fn page_stream(&self) -> Option<&[u8]> {
        let convert_single = |s: Stream<'_>| {
            let data = s.decoded_data().ok()?;
            Some(data.into_owned())
        };

        self.page_streams
            .get_or_init(|| {
                if let Some(stream) = self.inner.get::<Stream<'_>>(CONTENTS) {
                    convert_single(stream)
                } else if let Some(array) = self.inner.get::<Array<'_>>(CONTENTS) {
                    let streams = array
                        .raw_iter()
                        .filter_map(|item| item.resolve(&self.ctx)?.into_stream())
                        .flat_map(convert_single);

                    let mut collected = vec![];

                    for stream in streams {
                        collected.extend(stream);
                        // Streams must have at least one whitespace in-between.
                        collected.push(b' ');
                    }

                    Some(collected)
                } else {
                    None
                }
            })
            .as_ref()
            .map(|d| d.as_slice())
    }

    /// Get the resources of the page.
    pub fn resources(&self) -> &Resources<'a> {
        &self.resources
    }

    /// Get the media box of the page.
    pub fn media_box(&self) -> Rect {
        self.media_box
    }

    /// Get the rotation of the page.
    pub fn rotation(&self) -> Rotation {
        self.rotation
    }

    /// Get the crop box of the page.
    pub fn crop_box(&self) -> Rect {
        self.crop_box
    }

    /// Return the intersection of crop box and media box.
    pub fn intersected_crop_box(&self) -> Rect {
        self.crop_box().intersect(self.media_box())
    }

    /// Return the base dimensions of the page (same as `intersected_crop_box`, but with special
    /// handling applied for zero-area pages).
    pub fn base_dimensions(&self) -> (f32, f32) {
        let crop_box = self.intersected_crop_box();

        if (crop_box.width() as f32).is_nearly_zero() || (crop_box.height() as f32).is_nearly_zero()
        {
            (A4.width() as f32, A4.height() as f32)
        } else {
            (
                crop_box.width().max(1.0) as f32,
                crop_box.height().max(1.0) as f32,
            )
        }
    }

    /// Return the with and height of the page that should be assumed when rendering the page.
    ///
    /// Depending on the document, it is either based on the media box or the crop box
    /// of the page. In addition to that, it also takes the rotation of the page into account.
    pub fn render_dimensions(&self) -> (f32, f32) {
        let (mut base_width, mut base_height) = self.base_dimensions();

        if matches!(
            self.rotation(),
            Rotation::Horizontal | Rotation::FlippedHorizontal
        ) {
            core::mem::swap(&mut base_width, &mut base_height);
        }

        (base_width, base_height)
    }

    /// Return an untyped iterator over the operators of the page's content stream.
    pub fn operations(&self) -> UntypedIter<'_> {
        self.operations_impl().unwrap_or(UntypedIter::empty())
    }

    /// Get the raw dictionary of the page.
    pub fn raw(&self) -> &Dict<'a> {
        &self.inner
    }

    /// Get the xref table (of the document the page belongs to).
    pub fn xref(&self) -> &'a XRef {
        self.ctx.xref()
    }

    /// Return a typed iterator over the operators of the page's content stream.
    pub fn typed_operations(&self) -> TypedIter<'_> {
        TypedIter::from_untyped(self.operations())
    }

    /// Return the initial transform that should be applied when rendering.
    ///
    /// This accounts for the mismatch between PDF's y-up and most renderers'
    /// y-down coordinate system, the rotation of the page and the offset of
    /// the crop box.
    pub fn initial_transform(&self, invert_y: bool) -> Transform {
        let crop_box = self.intersected_crop_box();
        let (_, base_height) = self.base_dimensions();
        let (width, height) = self.render_dimensions();

        let horizontal_t = Transform::ROTATE_CW_90 * Transform::translate((0.0, -width as f64));
        let flipped_horizontal_t =
            Transform::translate((0.0, height as f64)) * Transform::ROTATE_CCW_90;

        let rotation_transform = match self.rotation() {
            Rotation::None => Transform::IDENTITY,
            Rotation::Horizontal => {
                if invert_y {
                    horizontal_t
                } else {
                    flipped_horizontal_t
                }
            }
            Rotation::Flipped => {
                Transform::scale(-1.0) * Transform::translate((-width as f64, -height as f64))
            }
            Rotation::FlippedHorizontal => {
                if invert_y {
                    flipped_horizontal_t
                } else {
                    horizontal_t
                }
            }
        };

        let inversion_transform = if invert_y {
            Transform::new([1.0, 0.0, 0.0, -1.0, 0.0, base_height as f64])
        } else {
            Transform::IDENTITY
        };

        rotation_transform
            * inversion_transform
            * Transform::translate((-crop_box.x0, -crop_box.y0))
    }
}

/// A structure keeping track of the resources of a page.
#[derive(Clone, Debug)]
pub struct Resources<'a> {
    /// The raw dictionary of external graphics states.
    pub ext_g_states: Dict<'a>,
    /// The raw dictionary of fonts.
    pub fonts: Dict<'a>,
    /// The raw dictionary of properties.
    pub properties: Dict<'a>,
    /// The raw dictionary of color spaces.
    pub color_spaces: Dict<'a>,
    /// The raw dictionary of x objects.
    pub x_objects: Dict<'a>,
    /// The raw dictionary of patterns.
    pub patterns: Dict<'a>,
    /// The raw dictionary of shadings.
    pub shadings: Dict<'a>,
}

impl<'a> Resources<'a> {
    /// Create a new `Resources` object.
    pub fn new(resources: Dict<'a>) -> Self {
        let ext_g_states = resources.get::<Dict<'_>>(EXT_G_STATE).unwrap_or_default();
        let fonts = resources.get::<Dict<'_>>(FONT).unwrap_or_default();
        let color_spaces = resources.get::<Dict<'_>>(COLORSPACE).unwrap_or_default();
        let x_objects = resources.get::<Dict<'_>>(XOBJECT).unwrap_or_default();
        let patterns = resources.get::<Dict<'_>>(PATTERN).unwrap_or_default();
        let shadings = resources.get::<Dict<'_>>(SHADING).unwrap_or_default();
        let properties = resources.get::<Dict<'_>>(PROPERTIES).unwrap_or_default();

        Self {
            ext_g_states,
            fonts,
            color_spaces,
            properties,
            x_objects,
            patterns,
            shadings,
        }
    }

    /// Get an external graphics state by name.
    pub fn get_ext_g_state(&self, name: &Name<'_>) -> Option<Dict<'a>> {
        self.ext_g_states.get(name)
    }

    /// Get a color space by name.
    pub fn get_color_space(&self, name: &Name<'_>) -> Option<Object<'a>> {
        self.color_spaces.get(name)
    }

    /// Get a font by name.
    pub fn get_font(&self, name: &Name<'_>) -> Option<Dict<'a>> {
        self.fonts.get(name)
    }

    /// Get a pattern by name.
    pub fn get_pattern(&self, name: &Name<'_>) -> Option<Object<'a>> {
        self.patterns.get(name)
    }

    /// Get an x object by name.
    pub fn get_x_object(&self, name: &Name<'_>) -> Option<Stream<'a>> {
        self.x_objects.get(name)
    }

    /// Get a shading by name.
    pub fn get_shading(&self, name: &Name<'_>) -> Option<Object<'a>> {
        self.shadings.get(name)
    }
}

// <https://github.com/apache/pdfbox/blob/a53a70db16ea3133994120bcf1e216b9e760c05b/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/common/PDRectangle.java#L38>
const POINTS_PER_INCH: f64 = 72.0;
const POINTS_PER_MM: f64 = 1.0 / (10.0 * 2.54) * POINTS_PER_INCH;

/// The dimension of an A4 page.
pub const A4: Rect = Rect {
    x0: 0.0,
    y0: 0.0,
    x1: 210.0 * POINTS_PER_MM,
    y1: 297.0 * POINTS_PER_MM,
};

pub(crate) mod cached {
    use crate::page::Pages;
    use crate::reader::ReaderContext;
    use crate::xref::XRef;
    use core::ops::Deref;

    // Keep in sync with the implementation in `sync`. We duplicate it here
    // to make it more visible since we have unsafe code here.
    #[cfg(feature = "std")]
    pub(crate) use std::sync::Arc;

    #[cfg(not(feature = "std"))]
    pub(crate) use alloc::rc::Rc as Arc;

    pub(crate) struct CachedPages {
        pages: Pages<'static>,
        // NOTE: `pages` references the data in `xref`, so it's important that `xref`
        // appears after `pages` in the struct definition to ensure correct drop order.
        _xref: Arc<XRef>,
    }

    impl CachedPages {
        pub(crate) fn new(xref: Arc<XRef>) -> Option<Self> {
            // SAFETY:
            // - The XRef's location is stable in memory:
            //   - We wrapped it in a `Arc` (or `Rc` in `no_std`), which implements `StableDeref`.
            //   - The struct owns the `Arc`, ensuring that the inner value is not dropped during the whole
            //     duration.
            // - The internal 'static lifetime is not leaked because its rewritten
            //   to the self-lifetime in `pages()`.
            let xref_reference: &'static XRef = unsafe { core::mem::transmute(xref.deref()) };

            let ctx = ReaderContext::new(xref_reference, false);
            let pages = xref_reference
                .get_with(xref.trailer_data().pages_ref, &ctx)
                .and_then(|p| Pages::new(&p, &ctx, xref_reference))
                .or_else(|| Pages::new_brute_force(&ctx, xref_reference))?;

            Some(Self { pages, _xref: xref })
        }

        pub(crate) fn get(&self) -> &Pages<'_> {
            // SAFETY (recto): `LazyPages`' OnceLocks make `Pages` invariant, so
            // shorten the fake 'static by hand. The cells are filled only from
            // the stored root and context (this document's data), never from
            // a caller's value, so no shorter-lived data gets in.
            unsafe { core::mem::transmute::<&Pages<'static>, &Pages<'_>>(&self.pages) }
        }
    }
}
