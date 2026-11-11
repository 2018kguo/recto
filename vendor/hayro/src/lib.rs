/*!
A crate for rendering PDF files.

This crate allows you to render pages of a PDF file into bitmaps. It is supposed to be relatively
lightweight, since we do not have any dependencies on the GPU. All the rendering happens on the CPU.

The ultimate goal of this crate is to be a *feature-complete* and *performant* PDF rasterizer.
With that said, we are currently still very far away from reaching that goal: So far, no effort
has been put into performance optimizations, as we are still working on implementing missing features.
However, this crate is currently the most comprehensive and feature-complete
implementation of a PDF rasterizer in pure Rust. This claim is supported by the fact that we currently
include over 1000 PDF files in our regression test suite. The majority of those have been scraped
from the `pdf.js` and `PDFBOX` test suites and therefore represent a very large and diverse sample
of PDF files.

As mentioned, there are still some serious limitations, including lack of support for
encrypted/password-protected PDF files, blending and isolation, knockout groups as well as a range
of smaller features such as color key masking. But you should be able to render the vast majority
of PDF files without too many issues.

## Safety
This crate forbids unsafe code via a crate-level attribute.

## Examples
For usage examples, see the [example](https://github.com/LaurenzV/hayro/tree/master/hayro/examples) in
the GitHub repository.

## Cargo features
This crate has one optional feature:
- `embed-fonts`: See the description of [`hayro-interpret`](https://docs.rs/hayro-interpret/latest/hayro_interpret/#cargo-features) for more information.
*/

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use fearless_simd::Level;
use glyph_cache::{GlyphCache, PageGlyphs};
use hayro_interpret::Device;
use hayro_interpret::FillRule;
use hayro_interpret::InterpreterCache;
use hayro_interpret::InterpreterSettings;
use hayro_interpret::font::{GlyphRun, HintingCache};
use hayro_interpret::hayro_syntax::page::Page;
use hayro_interpret::util::{RectExt, TransformExt};
use hayro_interpret::{BlendMode, Context, DrawMode, DrawProps, ImageDrawProps, SoftMask};
use hayro_interpret::{ClipPath, PageRun, interpret_page};
use kurbo::{Affine, BezPath, Rect};
use pic_scale::Scaler;
use rustc_hash::FxHashMap;
use std::cell::RefCell;
use std::rc::Rc;

pub use hayro_interpret;
pub use hayro_interpret::hayro_syntax;
pub use kurbo;
pub use vello_cpu;

use vello_cpu::color::palette::css::TRANSPARENT;
use vello_cpu::color::{AlphaColor, Srgb};
use vello_cpu::peniko::{Compose, Fill, Mix};
use vello_cpu::{Mask, Pixmap, RenderContext, peniko};

mod clip;
mod glyph;
mod glyph_cache;
mod group;
mod image;
mod image_cache;
mod mask;
mod paint;
mod path;
mod tiling;

type OutlineCache = FxHashMap<(u128, u32), Option<Rc<BezPath>>>;

pub(crate) struct GlobalState {
    level: Level,
    outline_cache: Rc<RefCell<OutlineCache>>,
    glyph_cache: Rc<RefCell<GlyphCache>>,
    // recto: see `glyph_cache::MAX_PAGE_GLYPH_BYTES`.
    page_glyphs: RefCell<PageGlyphs>,
    hinting_cache: HintingCache,
    scaler: Scaler,
    force_image_interpolation: bool,
    aliasing_threshold: Option<u8>,
    hinting: bool,
    glyph_caching: bool,
    degraded: Rc<std::cell::Cell<bool>>,
    // recto: in a window's render, the whole page's pixmap in the window's pixels; see `Window`.
    page: Option<Rect>,
    // recto: see `image_cache`.
    image_cache: Rc<RefCell<image_cache::ImageCache>>,
}

impl GlobalState {
    pub(crate) fn new(cache: &RenderCache<'_>, settings: &RenderSettings) -> Self {
        // recto: see `glyph_cache::MAX_CACHED_GLYPH_BYTES`.
        cache.glyph_cache.borrow_mut().trim();
        Self {
            level: Level::new(),
            outline_cache: cache.outline_cache.clone(),
            glyph_cache: cache.glyph_cache.clone(),
            page_glyphs: RefCell::default(),
            hinting_cache: cache.hinting_cache.clone(),
            scaler: Scaler::new(image::RESAMPLING_FUNCTION),
            force_image_interpolation: settings.force_image_interpolation,
            aliasing_threshold: settings.aliasing_threshold,
            hinting: settings.hinting,
            glyph_caching: settings.glyph_caching,
            degraded: cache.degraded.clone(),
            page: None,
            image_cache: cache.image_cache.clone(),
        }
    }
}

pub(crate) struct Renderer<'r> {
    global: &'r GlobalState,
    pub(crate) ctx: &'r mut RenderContext,
    pub(crate) soft_mask_cache: FxHashMap<u128, Mask>,
    pub(crate) in_type3_glyph: bool,
    // recto: see `group`.
    pub(crate) groups: Vec<group::GroupFrame>,
    pub(crate) captures: Vec<group::Capture>,
    pub(crate) captures_seen: u32,
    pub(crate) events: u32,
    pub(crate) range: (u32, u32),
    pub(crate) replay: Option<&'r (dyn group::Backdrop + 'r)>,
    /// recto: the whole page's pixmap in this context's pixels, in a window's render, where this
    /// context is the window's (or one in its space); None where this context is all of it.
    pub(crate) page: Option<Rect>,
}

impl<'r> Renderer<'r> {
    pub(crate) fn new(ctx: &'r mut RenderContext, global: &'r GlobalState) -> Self {
        Self {
            global,
            ctx,
            soft_mask_cache: FxHashMap::default(),
            in_type3_glyph: false,
            groups: Vec::new(),
            captures: Vec::new(),
            captures_seen: 0,
            events: 0,
            range: (0, u32::MAX),
            replay: None,
            page: global.page,
        }
    }

    fn misses_target(&self, bbox: Rect) -> bool {
        let target = Rect::new(0.0, 0.0, self.ctx.width() as f64, self.ctx.height() as f64);
        !bbox.overlaps(target)
    }

    fn child_context(&self, width: u16, height: u16) -> RenderContext {
        let mut ctx =
            RenderContext::new_with(width, height, derive_settings(self.ctx.render_settings()));
        ctx.set_aliasing_threshold(self.global.aliasing_threshold);
        ctx
    }

    fn apply_draw_props(&mut self, props: &DrawProps<'_>) {
        self.ctx.set_transform(props.transform);
        self.apply_soft_mask(props.soft_mask.as_ref());
        self.ctx
            .set_blend_mode(convert_blend_mode(props.blend_mode));
    }

    fn apply_image_props(&mut self, props: &ImageDrawProps<'_>) {
        self.ctx.set_transform(props.transform);
        self.apply_soft_mask(props.soft_mask.as_ref());
        self.ctx
            .set_blend_mode(convert_blend_mode(props.blend_mode));
    }
}

impl<'a, 'r> Device<'a> for Renderer<'r> {
    fn draw_image(&mut self, image: hayro_interpret::Image<'a, '_>, props: ImageDrawProps<'a>) {
        if !self.muted() {
            Self::draw_pdf_image(self, image, props);
        }
    }

    fn push_clip_path(&mut self, clip_path: &ClipPath) {
        Self::push_clip_path(self, clip_path);
    }

    fn push_clip_rect(&mut self, rect: &Rect) {
        Self::push_clip_rect(self, rect);
    }

    fn push_transparency_group(
        &mut self,
        opacity: f32,
        mask: Option<SoftMask<'a>>,
        blend_mode: BlendMode,
    ) {
        Self::push_transparency_group(self, opacity, mask, blend_mode);
    }

    fn pop_clip(&mut self) {
        Self::pop_clip(self);
    }

    fn pop_transparency_group(&mut self) {
        Self::pop_transparency_group(self);
    }

    fn draw_path(&mut self, path: &BezPath, props: DrawProps<'a>, draw_mode: &DrawMode) {
        if !self.muted() {
            Self::draw_path(self, path, props, draw_mode);
        }
    }

    fn draw_rect(&mut self, rect: &Rect, props: DrawProps<'a>, draw_mode: &DrawMode) {
        if !self.muted() {
            Self::draw_rect(self, rect, props, draw_mode);
        }
    }

    fn draw_glyph_run(
        &mut self,
        glyph_run: &GlyphRun<'_, 'a>,
        props: DrawProps<'a>,
        draw_mode: &DrawMode,
    ) {
        if !self.muted() {
            Self::draw_glyph_run(self, glyph_run, props, draw_mode);
        }
    }

    fn set_group_knockout(&mut self) {
        if let Some(group) = self.groups.last_mut() {
            group.knockout = true;
        }
    }

    fn in_knockout(&self) -> bool {
        self.groups.last().is_some_and(|g| g.knockout)
    }

    fn begin_backdrop_group(
        &mut self,
        opacity: f32,
        mask: &Option<SoftMask<'a>>,
        blend_mode: BlendMode,
        knockout: bool,
    ) -> bool {
        self.begin_capture(opacity, mask.as_ref(), blend_mode, knockout)
    }

    fn next_backdrop_pass(&mut self) {
        self.next_capture_pass();
    }

    fn end_backdrop_group(&mut self) {
        self.end_capture();
    }

    fn push_knockout_erase(&mut self) {
        self.push_erase();
    }

    fn pop_knockout_erase(&mut self) {
        self.pop_erase();
    }
}

/// A cache used by the renderer.
///
/// Ideally, such a cache should be constructed once per PDF and then reused across
/// multiple render invocations on the same document.
// TODO: Allow clearing the cache.
#[derive(Default)]
pub struct RenderCache<'a> {
    pub(crate) interpreter_cache: InterpreterCache<'a>,
    pub(crate) outline_cache: Rc<RefCell<OutlineCache>>,
    pub(crate) glyph_cache: Rc<RefCell<GlyphCache>>,
    pub(crate) hinting_cache: HintingCache,
    pub(crate) degraded: Rc<std::cell::Cell<bool>>,
    // recto: see `image_cache`.
    pub(crate) image_cache: Rc<RefCell<image_cache::ImageCache>>,
}

impl<'a> RenderCache<'a> {
    /// recto: whether a page drawn since the last call passed a limit on what it may ask for, and
    /// so isn't what the file says everywhere.
    pub fn take_degraded(&self) -> bool {
        self.degraded.replace(false)
    }

    /// recto: the bytes of the glyph images the cache holds, for tests and `examples/budgets.rs`.
    #[doc(hidden)]
    pub fn glyph_cache_bytes(&self) -> usize {
        self.glyph_cache.borrow().bytes()
    }

    /// recto: the bytes of decoded images the cache holds, for tests.
    #[doc(hidden)]
    pub fn image_cache_bytes(&self) -> usize {
        self.image_cache.borrow().bytes()
    }

    /// recto: an interpreter cache for reading this document's text, with its own fonts (its
    /// font resolver differs) but the embedded font programs this cache decodes and parses.
    pub fn text_interpreter_cache(&self) -> InterpreterCache<'a> {
        self.interpreter_cache.sharing_font_programs()
    }

    /// Create a new render cache.
    pub fn new() -> Self {
        Self {
            interpreter_cache: InterpreterCache::new(),
            outline_cache: Rc::new(RefCell::new(FxHashMap::default())),
            glyph_cache: Rc::new(RefCell::new(GlyphCache::default())),
            hinting_cache: HintingCache::new(),
            degraded: Rc::default(),
            image_cache: Rc::default(),
        }
    }
}

/// Settings for rendering a page.
#[derive(Clone, Copy)]
pub struct RenderSettings {
    /// Whether all images should forcibly be rendered with bilinear interpolation.
    pub force_image_interpolation: bool,
    /// The aliasing threshold for fills and strokes.
    ///
    /// `None` (the default) enables anti-aliasing; `Some(threshold)` paints pixels
    /// whose coverage exceeds the threshold.
    pub aliasing_threshold: Option<u8>,
    /// Whether text should be hinted.
    pub hinting: bool,
    /// Whether rasterized glyphs should be cached and reused.
    pub glyph_caching: bool,
    /// recto: what the page is drawn on, for groups that need the backdrop under them.
    pub background: AlphaColor<Srgb>,
}

impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            force_image_interpolation: false,
            aliasing_threshold: None,
            hinting: true,
            glyph_caching: true,
            background: TRANSPARENT,
        }
    }
}

/// Settings for the output pixmap.
#[derive(Clone, Copy)]
pub struct PixmapSettings {
    /// Horizontal scale factor.
    pub x_scale: f32,
    /// Vertical scale factor.
    pub y_scale: f32,
    /// Background color.
    pub bg_color: AlphaColor<Srgb>,
    /// recto: only this window of the page's pixmap at this scale, or all of it.
    pub window: Option<Window>,
}

/// recto: a window on a page's pixmap: its top-left pixel there, and its size. The pixmap is the
/// window's size, so a part of a page costs what the part does, and the page's own size may be
/// past what a pixmap holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    /// The window's left edge, in the page's pixmap.
    pub x: u32,
    /// Its top edge.
    pub y: u32,
    /// Its width, and the pixmap's.
    pub width: u16,
    /// Its height, and the pixmap's.
    pub height: u16,
}

impl PixmapSettings {
    /// recto: the pixmap's size, the transform from the page's space into it, and in a window's
    /// render, the whole page's pixmap in the window's pixels.
    fn target(&self, page: &Page<'_>) -> (u16, u16, Affine, Option<Rect>) {
        let (width, height) = page.render_dimensions();
        let scale = Affine::scale_non_uniform(self.x_scale as f64, self.y_scale as f64);
        let initial = page.initial_transform(true).to_kurbo();
        match self.window {
            None => (
                (width * self.x_scale) as u16,
                (height * self.y_scale) as u16,
                scale * initial,
                None,
            ),
            Some(window) => {
                let (x, y) = (f64::from(window.x), f64::from(window.y));
                let whole = Rect::new(
                    -x,
                    -y,
                    f64::from(width * self.x_scale).floor() - x,
                    f64::from(height * self.y_scale).floor() - y,
                );
                (
                    window.width,
                    window.height,
                    Affine::translate((-x, -y)) * scale * initial,
                    Some(whole),
                )
            }
        }
    }
}

impl Default for PixmapSettings {
    fn default() -> Self {
        Self {
            x_scale: 1.0,
            y_scale: 1.0,
            bg_color: TRANSPARENT,
            window: None,
        }
    }
}

/// Render a page to a pixmap with the given settings.
///
/// This is a "simplified" method in case all you want to achieve is rendering a
/// page with a certain scale factor.
///
pub fn render<'a>(
    page: &'a Page<'a>,
    cache: &RenderCache<'a>,
    interpreter_settings: &InterpreterSettings,
    render_settings: &RenderSettings,
    pixmap_settings: &PixmapSettings,
) -> Pixmap {
    let mut rgba = Vec::new();
    let (width, height) = render_rgba(page, cache, interpreter_settings, render_settings, pixmap_settings, &mut rgba);
    let metadata = vello_cpu::PixelMetadata::new(peniko::ImageAlphaType::AlphaPremultiplied, true);
    Pixmap::from_parts(rgba, width, height, metadata)
}

/// recto: [`render`] into `rgba`, premultiplied, four bytes a pixel, resized to the page; returns
/// its width and height. Every pixel is written, so a caller can pass the last page's buffer back
/// and nothing page-sized is allocated or cleared.
pub fn render_rgba<'a>(
    page: &'a Page<'a>,
    cache: &RenderCache<'a>,
    interpreter_settings: &InterpreterSettings,
    render_settings: &RenderSettings,
    pixmap_settings: &PixmapSettings,
    rgba: &mut Vec<u8>,
) -> (u16, u16) {
    let mut recorded = record(page, cache, interpreter_settings, render_settings, pixmap_settings);
    let size = recorded.rasterize(rgba);
    recorded.0.keep();
    size
}

/// recto: what drawing a page leaves for the next page drawn on this thread: the recorded scene's
/// buffers, whose capacity `reset` keeps, and the rasterizer's resources. A page drawn from fresh
/// grows each of them from empty, a thousand reallocations or so.
struct Kit {
    ctx: RenderContext,
    resources: vello_cpu::Resources,
}

thread_local! {
    static KIT: RefCell<Option<Kit>> = const { RefCell::new(None) };
}

impl Kit {
    /// The kept one, reset to this size, or a new one. One that last drew more than four times
    /// these pixels is let go, so a huge page doesn't pin its buffers for the small ones after it.
    fn take(width: u16, height: u16) -> Self {
        let area = |w: u16, h: u16| u32::from(w) * u32::from(h);
        // One too large is dropped here, before a new one is made, so the two are never both held.
        let kept = KIT
            .with(|k| k.borrow_mut().take())
            .filter(|kit| area(kit.ctx.width(), kit.ctx.height()) <= area(width, height).max(1 << 16) * 4);
        match kept {
            Some(mut kit) => {
                kit.ctx.reset_and_resize(width, height);
                kit
            }
            None => Self {
                ctx: RenderContext::new(width, height),
                resources: vello_cpu::Resources::default(),
            },
        }
    }

    /// Kept for the next page. A render run while another is paused between slices makes a
    /// second; whichever finishes last is kept.
    fn keep(self) {
        KIT.with(|k| *k.borrow_mut() = Some(self));
    }

    /// Rasterizes the scene into `rgba`, sized to it. The scene covers the whole buffer, so
    /// `TargetInit::Clear` paints the background as it packs, with no pass to clear it first.
    fn rasterize(&mut self, background: AlphaColor<Srgb>, rgba: &mut Vec<u8>) -> (u16, u16) {
        self.ctx.flush();
        let (width, height) = (self.ctx.width(), self.ctx.height());
        let len = usize::from(width) * usize::from(height) * 4;
        // One far larger than this page is let go too.
        if rgba.capacity() < len || rgba.capacity() > len.max(1 << 20) * 4 {
            // The old one goes first. Zeroed by the allocator, which for a large one is fresh
            // pages, not a pass over them.
            *rgba = Vec::new();
            *rgba = vec![0; len];
        } else {
            rgba.resize(len, 0);
        }
        let target = vello_cpu::PixmapMut::new(width, height, rgba).expect("sized to the scene");
        self.ctx.render_with(
            target,
            &mut self.resources,
            vello_cpu::RasterizerSettings {
                target_init: vello_cpu::TargetInit::Clear(background),
                ..Default::default()
            },
        );
        (width, height)
    }
}

/// recto: for benchmarks: a page interpreted into a scene and not yet rasterized, so the
/// rasterizer can be timed alone, as often as asked.
#[doc(hidden)]
pub struct Recorded(Kit, AlphaColor<Srgb>);

/// recto: see [`Recorded`]. Takes what [`render`] takes.
#[doc(hidden)]
pub fn record<'a>(
    page: &'a Page<'a>,
    cache: &RenderCache<'a>,
    interpreter_settings: &InterpreterSettings,
    render_settings: &RenderSettings,
    pixmap_settings: &PixmapSettings,
) -> Recorded {
    let (width, height, transform, whole) = pixmap_settings.target(page);
    let mut kit = Kit::take(width, height);
    let render_settings = RenderSettings { background: pixmap_settings.bg_color, ..*render_settings };
    render_into_page(page, cache, interpreter_settings, &render_settings, &mut kit.ctx, transform, whole);
    Recorded(kit, pixmap_settings.bg_color)
}

impl Recorded {
    /// The scene's pixels, as [`render_rgba`] leaves them.
    pub fn rasterize(&mut self, rgba: &mut Vec<u8>) -> (u16, u16) {
        self.0.rasterize(self.1, rgba)
    }
}

/// recto: lets go of what drawing keeps on this thread between pages.
pub fn release_render_memory() {
    KIT.with(|k| k.borrow_mut().take());
}

/// recto: a page being drawn a slice at a time: the same result as [`render`], with the thread
/// given back between slices. Between them nothing here is borrowed from the caches.
pub struct PageJob<'a, 'c> {
    /// Taken back by the thread when the page is finished.
    kit: Option<Kit>,
    state: Context<'a>,
    run: Option<PageRun<'a>>,
    replay: group::PageReplay<'a, 'c>,
    global: Rc<GlobalState>,
    kept: Kept,
    clip_crop_box: bool,
    background: AlphaColor<Srgb>,
    degraded: Rc<std::cell::Cell<bool>>,
}

/// What a [`Renderer`] holds that outlives a slice.
#[derive(Default)]
struct Kept {
    soft_mask_cache: FxHashMap<u128, Mask>,
    groups: Vec<group::GroupFrame>,
    captures: Vec<group::Capture>,
    captures_seen: u32,
    events: u32,
}

impl<'a, 'c> PageJob<'a, 'c> {
    /// Takes what [`render`] takes.
    pub fn new(
        page: &'a Page<'a>,
        cache: &'c RenderCache<'a>,
        interpreter_settings: &InterpreterSettings,
        render_settings: &RenderSettings,
        pixmap_settings: &PixmapSettings,
    ) -> Self {
        let (width, height, transform, whole) = pixmap_settings.target(page);
        let mut kit = Kit::take(width, height);
        let ctx = &mut kit.ctx;
        let render_settings = RenderSettings {
            background: pixmap_settings.bg_color,
            ..*render_settings
        };
        let degraded = Rc::new(std::cell::Cell::new(false));
        let mut global = GlobalState::new(cache, &render_settings);
        // Its own, so a synchronous render between two slices can't take this job's.
        global.degraded = degraded.clone();
        global.page = whole;
        let global = Rc::new(global);
        let replay = group::PageReplay::new(
            page,
            cache,
            interpreter_settings,
            global.clone(),
            transform,
            ctx,
            render_settings.background,
        );

        let target = Rect::new(0.0, 0.0, ctx.width() as f64, ctx.height() as f64);
        let mut state = Context::new(
            transform,
            target,
            &cache.interpreter_cache,
            page.xref(),
            interpreter_settings.clone(),
        );
        ctx.take_current_state();
        ctx.reset_mask();
        ctx.reset_filter_effect();
        ctx.set_aliasing_threshold(render_settings.aliasing_threshold);

        let crop_box = page.intersected_crop_box().to_kurbo();
        let [a, b, c, d, _, _] = transform.as_coeffs();
        let axis_aligned = (b == 0.0 && c == 0.0) || (a == 0.0 && d == 0.0);
        let mapped_crop_box = transform
            .transform_rect_bbox(crop_box)
            .inflate(1.0 / 256.0, 1.0 / 256.0);
        let clip_crop_box = !axis_aligned || !mapped_crop_box.contains_rect(target);
        if clip_crop_box {
            ctx.set_transform(transform);
            ctx.push_clip_rect(&crop_box);
        }

        let run = PageRun::new(page, &mut state);
        Self {
            kit: Some(kit),
            state,
            run: Some(run),
            replay,
            global,
            kept: Kept::default(),
            clip_crop_box,
            background: pixmap_settings.bg_color,
            degraded,
        }
    }

    /// Runs until `expired` says so, and says whether the page's content is done. Rasterizing
    /// what it drew is [`Self::finish`]: one call, and a large share of the page's time.
    pub fn step(&mut self, expired: &dyn Fn() -> bool) -> bool {
        let Some(run) = self.run.as_mut() else {
            return true;
        };
        let kept = std::mem::take(&mut self.kept);
        let ctx = &mut self.kit.as_mut().expect("not finished").ctx;
        let mut device = Renderer::new(ctx, &self.global);
        device.soft_mask_cache = kept.soft_mask_cache;
        device.groups = kept.groups;
        device.captures = kept.captures;
        device.captures_seen = kept.captures_seen;
        device.events = kept.events;
        device.replay = Some(&self.replay);
        let done = run.step(&mut self.state, &mut device, expired);
        if done && self.clip_crop_box {
            device.pop_clip();
        }
        self.kept = Kept {
            soft_mask_cache: device.soft_mask_cache,
            groups: device.groups,
            captures: device.captures,
            captures_seen: device.captures_seen,
            events: device.events,
        };
        if done {
            self.run = None;
        }
        done
    }

    /// The finished page in `rgba`, as [`render_rgba`] leaves it, its width and height, and
    /// whether it passed a limit. Once, after `step` said it's done.
    pub fn finish(&mut self, rgba: &mut Vec<u8>) -> ((u16, u16), bool) {
        let mut kit = self.kit.take().expect("finished once");
        let size = kit.rasterize(self.background, rgba);
        kit.keep();
        (size, self.degraded.replace(false) || self.state.budget_tripped())
    }
}

/// Render a page into the given [`RenderContext`] with the given transform. recto: with the whole
/// page's pixmap in `ctx`'s pixels when `ctx` is a window.
fn render_into_page<'a>(
    page: &'a Page<'a>,
    cache: &RenderCache<'a>,
    interpreter_settings: &InterpreterSettings,
    render_settings: &RenderSettings,
    ctx: &mut RenderContext,
    transform: Affine,
    whole: Option<Rect>,
) {
    let mut global = GlobalState::new(cache, render_settings);
    global.page = whole;
    let global = Rc::new(global);
    let replay = group::PageReplay::new(
        page,
        cache,
        interpreter_settings,
        global.clone(),
        transform,
        ctx,
        render_settings.background,
    );
    draw_page(page, cache, interpreter_settings, render_settings.aliasing_threshold, ctx, transform, &global, &replay, (0, u32::MAX));
    // recto: a limit passed is a page incomplete, wherever it was.
    if interpreter_settings.budget.tripped() {
        global.degraded.set(true);
    }
}

// recto: split from `render_into`, so a group can draw part of the page again for its backdrop.
#[allow(clippy::too_many_arguments)]
fn draw_page<'a, 'r>(
    page: &'a Page<'a>,
    cache: &RenderCache<'a>,
    interpreter_settings: &InterpreterSettings,
    aliasing_threshold: Option<u8>,
    ctx: &'r mut RenderContext,
    transform: Affine,
    global: &'r GlobalState,
    replay: &'r (dyn group::Backdrop + 'r),
    range: (u32, u32),
) {
    let target = Rect::new(0.0, 0.0, ctx.width() as f64, ctx.height() as f64);
    let mut state = Context::new(
        transform,
        target,
        &cache.interpreter_cache,
        page.xref(),
        interpreter_settings.clone(),
    );
    ctx.take_current_state();
    ctx.reset_mask();
    ctx.reset_filter_effect();
    ctx.set_aliasing_threshold(aliasing_threshold);

    let mut device = Renderer::new(ctx, global);
    device.replay = Some(replay);
    device.range = range;
    let crop_box = page.intersected_crop_box().to_kurbo();
    let [a, b, c, d, _, _] = transform.as_coeffs();
    let axis_aligned = (b == 0.0 && c == 0.0) || (a == 0.0 && d == 0.0);
    let mapped_crop_box = transform
        .transform_rect_bbox(crop_box)
        .inflate(1.0 / 256.0, 1.0 / 256.0);
    let clip_crop_box = !axis_aligned || !mapped_crop_box.contains_rect(target);

    if clip_crop_box {
        device.ctx.set_transform(transform);
        device.ctx.push_clip_rect(&crop_box);
    }

    interpret_page(page, &mut state, &mut device);

    if clip_crop_box {
        device.pop_clip();
    }
}

pub(crate) fn derive_settings(settings: &vello_cpu::RenderSettings) -> vello_cpu::RenderSettings {
    vello_cpu::RenderSettings {
        num_threads: 0,
        ..*settings
    }
}

fn convert_fill_rule(fill_rule: FillRule) -> Fill {
    match fill_rule {
        FillRule::NonZero => Fill::NonZero,
        FillRule::EvenOdd => Fill::EvenOdd,
    }
}

fn convert_blend_mode(blend_mode: BlendMode) -> peniko::BlendMode {
    let mix = match blend_mode {
        BlendMode::Normal => Mix::Normal,
        BlendMode::Multiply => Mix::Multiply,
        BlendMode::Screen => Mix::Screen,
        BlendMode::Overlay => Mix::Overlay,
        BlendMode::Darken => Mix::Darken,
        BlendMode::Lighten => Mix::Lighten,
        BlendMode::ColorDodge => Mix::ColorDodge,
        BlendMode::ColorBurn => Mix::ColorBurn,
        BlendMode::HardLight => Mix::HardLight,
        BlendMode::SoftLight => Mix::SoftLight,
        BlendMode::Difference => Mix::Difference,
        BlendMode::Exclusion => Mix::Exclusion,
        BlendMode::Hue => Mix::Hue,
        BlendMode::Saturation => Mix::Saturation,
        BlendMode::Color => Mix::Color,
        BlendMode::Luminosity => Mix::Luminosity,
    };

    peniko::BlendMode::new(mix, Compose::SrcOver)
}
