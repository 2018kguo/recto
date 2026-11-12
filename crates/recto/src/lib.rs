//! A PDF engine. hayro parses, interprets and rasterizes; the text layer
//! (char boxes, generated spaces, line breaks, words) is this crate's.
//!
//! Coordinates are PDF points in the viewer frame, a
//! top-left origin, with `/Rotate` and the crop box applied. Char boxes are
//! loose font boxes (advance × em), not glyph ink.

mod annots;
mod labels;
pub mod links;
pub mod outline;
mod assets;
mod ctext;
mod device;
mod forms;
mod ranged;
mod text;
#[cfg(feature = "wasm")]
mod wasm;

use hayro::hayro_interpret::util::TransformExt;
use hayro::hayro_interpret::{
    Context, InterpreterCache, InterpreterSettings, RenderContent, interpret_page,
};
use hayro::hayro_syntax::{LoadPdfError, Pdf};
use hayro::kurbo::Rect;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings, render};

pub use annots::{Annotation, Field};
pub use ctext::Text;
pub use device::{
    PATH_FILL, PATH_STROKE, PageObjects, SEGMENT_BEZIER, SEGMENT_CLOSE, SEGMENT_LINE, SEGMENT_MOVE,
};
pub use links::{Destination, Link, Target};
pub use outline::OutlineItem;
pub use text::{CHAR_GENERATED, CHAR_UNMAPPED, Char, Font, Run, TextPage, Word};

/// What went wrong, for callers that branch on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Not a PDF this engine can open: garbage, truncated, a broken xref.
    InvalidFile,
    /// The file is encrypted and no password was given.
    PasswordRequired,
    /// The file is encrypted and the password given does not open it.
    WrongPassword,
    /// A valid file this engine cannot read (a security handler other than
    /// Standard, e.g. DRM).
    Unsupported,
    /// A ranged file longer than the address space left.
    TooLarge,
    /// Any other refusal: a page with no area, an invalid render size.
    Failed,
}

impl ErrorKind {
    /// The JavaScript package's `PdfError` code.
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidFile => "invalid-file",
            Self::PasswordRequired => "password-required",
            Self::WrongPassword => "wrong-password",
            Self::Unsupported => "unsupported",
            Self::TooLarge => "too-large",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    pub kind: ErrorKind,
    pub message: String,
}

impl EngineError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

pub struct PageInfo {
    pub width: f32,
    pub height: f32,
    /// Clockwise quarter turns from `/Rotate`, in degrees.
    pub rotation: u32,
}

/// Whether a limit cut a tree of the document short: see `Document::structure_truncated`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StructureTruncated {
    pub pages: bool,
    pub page_labels: bool,
    pub outline: bool,
}

/// A page's text, objects and annotations from one load.
pub struct Scan {
    /// Nested streams, annotation points and the largest `/VE`: see `PageBudget`.
    pub budget_used: (u32, usize, u32),
    pub text: TextPage,
    /// Empty unless asked for.
    pub objects: PageObjects,
    pub annotations: Vec<Annotation>,
}

pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    /// Premultiplied RGBA on a white background, so effectively opaque RGBA.
    pub rgba: Vec<u8>,
    /// The page asked for more than one render may do; see `Engine::render`.
    pub truncated: bool,
    /// Where this bitmap's top-left pixel is in the whole page's bitmap at the same scale, and
    /// that bitmap's size: 0, 0 and this one's own size unless a region was asked for.
    pub x: u32,
    pub y: u32,
    pub page_width: u32,
    pub page_height: u32,
}

/// A part of a page to draw, in the viewer frame: points from the top-left of the page as it's
/// shown, with `/Rotate` and the crop box applied, as char and annotation boxes are.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Font, CMap and glyph caches shared by every page of one document, so a
/// font is parsed once per document rather than once per page.
/// Limit: unbounded for the document's life.
struct Caches<'a> {
    text: InterpreterCache<'a>,
    render: RenderCache<'a>,
    /// The last page's glyph buffer, emptied: the next page fills it without
    /// regrowing (and recopying) it from nothing.
    glyphs: std::cell::RefCell<Vec<text::Glyph>>,
}

self_cell::self_cell!(
    struct Inner {
        owner: Pdf,
        #[not_covariant]
        dependent: Caches,
    }
);

pub struct Document(Inner);

/// Neither side of a render exceeds this (hayro sizes pixmaps in `u16`).
pub const MAX_RENDER_SIDE: f32 = 16384.0;
/// 64 Mpx, 256 MiB of RGBA.
pub const MAX_RENDER_PIXELS: f32 = 64.0 * 1024.0 * 1024.0;

/// With a region, the whole page's bitmap at that scale may be this wide or high: past it, an f32
/// coordinate on it is coarser than 1/64 of a pixel.
pub const MAX_REGION_PAGE_SIDE: f32 = 262_144.0;

/// `min(width / pageWidth, maxHeight / pageHeight)`, shrunk to fit the
/// render limits. `max_height` may be infinite ("fit to width").
fn render_scale(page_w: f32, page_h: f32, width: f32, max_height: f32) -> Result<f32, EngineError> {
    let scale = unlimited_scale(page_w, page_h, width, max_height)?;
    Ok(scale
        .min(MAX_RENDER_SIDE / page_w)
        .min(MAX_RENDER_SIDE / page_h)
        .min((MAX_RENDER_PIXELS / (page_w * page_h)).sqrt()))
}

/// `min(width / pageWidth, maxHeight / pageHeight)`, the scale a region is drawn at: the limits
/// are on the region's bitmap, not the page's.
fn unlimited_scale(page_w: f32, page_h: f32, width: f32, max_height: f32) -> Result<f32, EngineError> {
    if !(width.is_finite() && width > 0.0 && max_height > 0.0) {
        return Err(EngineError::new(
            ErrorKind::Failed,
            format!("invalid render size {width}x{max_height}"),
        ));
    }
    // A MediaBox past f32 range is infinite: no scale fits it.
    if !(page_w > 0.0 && page_h > 0.0 && page_w.is_finite() && page_h.is_finite()) {
        return Err(EngineError::new(ErrorKind::Failed, "page has no area"));
    }
    Ok((width / page_w).min(max_height / page_h))
}

/// A side of the bitmap: `page * scale`, rounded up. Within float error of a whole number it is that
/// number: a page 612 wide asked for 800 pixels came to 800.00006 and drew 801.
fn pixel_side(exact: f32) -> f32 {
    whole_pixels(exact).clamp(1.0, MAX_RENDER_SIDE)
}

fn whole_pixels(exact: f32) -> f32 {
    let near = exact.round();
    if (exact - near).abs() <= near * f32::EPSILON * 4.0 { near } else { exact.ceil() }
}

/// The scale that makes `page * scale` come to `side` once hayro floors it: `side / page`, stepped
/// up by one ULP when float error would lose a pixel.
fn fit_scale(page: f32, side: f32) -> f32 {
    let exact = side / page;
    if (page * exact) as u32 >= side as u32 { exact } else { exact.next_up() }
}

/// The pixels a region covers in the whole page's bitmap, `page` pixels for `points`: grown out to
/// whole pixels, a coordinate within 1/1024 px of a whole one taken as it, and cut to the page.
/// Points become pixels by `pixels / points` in f64, so a caller that scales by the bitmap's size
/// over `pageInfo`'s lands on whole pixels exactly.
fn region_pixels(region: Region, points: (f32, f32), page: (u32, u32)) -> Option<(u32, u32, u32, u32)> {
    let snap = |v: f64| if (v - v.round()).abs() <= 1.0 / 1024.0 { v.round() } else { v };
    let span = |start: f64, length: f64, points: f32, side: u32| {
        let scale = f64::from(side) / f64::from(points);
        let from = snap(start * scale).floor().max(0.0);
        let to = snap((start + length) * scale).ceil().min(f64::from(side));
        (to > from).then_some((from as u32, to as u32))
    };
    let (x0, x1) = span(region.x, region.width, points.0, page.0)?;
    let (y0, y1) = span(region.y, region.height, points.1, page.1)?;
    Some((x0, y0, x1 - x0, y1 - y0))
}

impl Document {
    pub fn open(bytes: Vec<u8>, password: &str) -> Result<Self, EngineError> {
        Self::open_data(bytes.into(), password)
    }

    /// A file of `len` bytes read by range: `fill` copies the bytes at an
    /// offset into its buffer the first time the parser needs them
    /// (chunk-aligned runs of at most 1 MiB).
    pub fn open_ranged(
        len: usize,
        chunk: usize,
        fill: ranged::Fill,
        password: &str,
    ) -> Result<Self, EngineError> {
        let data = ranged::data(len, chunk, fill).ok_or_else(|| {
            EngineError::new(
                ErrorKind::TooLarge,
                "this instance has no address space left for a file of this length; close other documents",
            )
        })?;
        Self::open_data(data, password)
    }

    fn open_data(data: hayro::hayro_syntax::PdfData, password: &str) -> Result<Self, EngineError> {
        Pdf::new_with_password(data, password)
            .map(|pdf| {
                Self(Inner::new(pdf, |_| {
                    let render = RenderCache::new();
                    Caches {
                        // Drawing and reading text load each embedded font program once between them,
                        // and reading text loads one only for what the font's dictionary doesn't say.
                        text: render.text_interpreter_cache().sharing_font_programs_loaded_on_use(),
                        render,
                        glyphs: Default::default(),
                    }
                }))
            })
            .map_err(|error| match error {
                LoadPdfError::Decryption(
                    hayro::hayro_syntax::DecryptionError::PasswordProtected,
                ) if password.is_empty() => {
                    EngineError::new(ErrorKind::PasswordRequired, "the document needs a password")
                }
                LoadPdfError::Decryption(
                    hayro::hayro_syntax::DecryptionError::PasswordProtected,
                ) => EngineError::new(
                    ErrorKind::WrongPassword,
                    "the password does not open the document",
                ),
                LoadPdfError::Decryption(
                    hayro::hayro_syntax::DecryptionError::UnsupportedAlgorithm,
                ) => EngineError::new(ErrorKind::Unsupported, "unsupported security handler"),
                other => EngineError::new(
                    ErrorKind::InvalidFile,
                    format!("not a readable PDF: {other:?}"),
                ),
            })
    }

    pub fn page_count(&self) -> usize {
        self.0.borrow_owner().pages().len()
    }

    fn page(&self, index: usize) -> Result<&hayro::hayro_syntax::page::Page<'_>, EngineError> {
        self.0
            .borrow_owner()
            .pages()
            .get(index)
            .ok_or_else(|| EngineError::new(ErrorKind::Failed, format!("no page {index}")))
    }

    /// `f` on page `index`, its document and the document's caches.
    fn with_page<R>(
        &self,
        index: usize,
        f: impl for<'q> FnOnce(&'q Pdf, &'q hayro::hayro_syntax::page::Page<'q>, &Caches<'q>) -> R,
    ) -> Result<R, EngineError> {
        self.page(index)?;
        Ok(self.0.with_dependent(|pdf, caches| {
            let Some(page) = pdf.pages().get(index) else {
                unreachable!("self.page(index) found it")
            };
            f(pdf, page, caches)
        }))
    }

    pub fn page_info(&self, index: usize) -> Result<PageInfo, EngineError> {
        let page = self.page(index)?;
        let (width, height) = page.render_dimensions();
        use hayro::hayro_syntax::page::Rotation;
        let rotation = match page.rotation() {
            Rotation::None => 0,
            Rotation::Horizontal => 90,
            Rotation::Flipped => 180,
            Rotation::FlippedHorizontal => 270,
        };
        Ok(PageInfo {
            width,
            height,
            rotation,
        })
    }

    pub fn text(&self, index: usize) -> Result<TextPage, EngineError> {
        self.scan(index, false, false).map(|s| s.text)
    }

    /// Text, and when asked the page's objects and annotations, from one
    /// interpretation of the page.
    pub fn scan(
        &self,
        index: usize,
        objects: bool,
        annotations: bool,
    ) -> Result<Scan, EngineError> {
        let cuts = hayro::hayro_syntax::decodes_cut();
        self.with_page(index, |_, page, caches| {
            let (w, h) = page.render_dimensions();
            let viewer = page.initial_transform(true).to_kurbo();
            let mut ctx = Context::new(
                viewer,
                Rect::new(0.0, 0.0, w as f64, h as f64),
                &caches.text,
                page.xref(),
                // Text is the page's own content: widget and
                // other annotation appearances are not part of it.
                InterpreterSettings {
                    // Without objects only glyph runs are read, so the text-only
                    // interpreter skips paths and images.
                    render_content: if objects {
                        RenderContent::PAGE
                    } else {
                        RenderContent::PAGE | RenderContent::TEXT_ONLY
                    },
                    ..crate::assets::text_settings()
                },
            );
            let mut device = device::PageDevice::new(viewer, objects);
            device.glyphs = caches.glyphs.take();
            interpret_page(page, &mut ctx, &mut device);
            let mut device = device.finish();
            // A stream or image past the limit on decoded bytes is left out, as a budget leaves out.
            let tripped = ctx.budget_tripped() || hayro::hayro_syntax::decodes_cut() != cuts;
            let budget_used = ctx.budget_used();
            let mut text = text::build_page(&device.glyphs, &device.fonts, &device.runs);
            text.truncated = device.text_truncated || tripped;
            if tripped && let Some(objects) = &mut device.objects {
                objects.truncated = true;
            }
            device.glyphs.clear();
            caches.glyphs.replace(device.glyphs);
            Scan {
                text,
                budget_used,
                objects: device.objects.unwrap_or_default(),
                annotations: if annotations {
                    annots::read(page, &caches.text, viewer)
                } else {
                    Vec::new()
                },
            }
        })
    }

    /// The file as it was opened, in place.
    pub fn file_bytes(&self) -> &[u8] {
        self.0.borrow_owner().data().as_ref()
    }

    /// What each page is called, if the file says: "iv", "A-5".
    pub fn page_labels(&self) -> Option<Vec<String>> {
        let pages = self.page_count();
        self.0.with_dependent(|pdf, _| labels::read(pdf, pages))
    }

    /// Which of the document's trees were cut short: by a limit, which only a file built to cost
    /// reaches, or for pages by a tree that lost its kids and left none. Walks the outline and labels
    /// again to find out.
    pub fn structure_truncated(&self) -> StructureTruncated {
        self.0.with_dependent(|pdf, _| StructureTruncated {
            // A tree that lost its kids, with nothing found by a scan, looks like an empty one.
            pages: pdf.pages().walk_stopped() || pdf.pages().lost_everything(),
            page_labels: labels::walked(pdf).stopped,
            outline: outline::walked(pdf).stopped,
        })
    }

    /// For tests and `examples/budgets.rs`: the bytes of glyph images the render cache holds.
    #[doc(hidden)]
    pub fn glyph_cache_bytes(&self) -> usize {
        self.0.with_dependent(|_, caches| caches.render.glyph_cache_bytes())
    }

    /// For tests: the bytes of decoded images the render cache holds.
    #[doc(hidden)]
    pub fn image_cache_bytes(&self) -> usize {
        self.0.with_dependent(|_, caches| caches.render.image_cache_bytes())
    }

    /// For `examples/budgets.rs`: what a render of the page spent, and whether it was cut short.
    #[doc(hidden)]
    pub fn render_budget(&self, index: usize, width: f32) -> Result<((u32, usize, u32), bool), EngineError> {
        let (settings, _) = self.pixmap_settings(index, width, 4096.0, None)?;
        self.with_page(index, |_, page, caches| {
            let interpreter = crate::assets::settings();
            let budget = interpreter.budget.clone();
            let _ = render(page, &caches.render, &interpreter, &RenderSettings::default(), &settings);
            (budget.used(), caches.render.take_degraded())
        })
    }

    /// For `examples/budgets.rs`: what the walks of the file's trees used: page tree kids and their
    /// limit, label nodes, name tree nodes, and whether the tree was lost altogether.
    #[doc(hidden)]
    pub fn tree_use(&self) -> ((usize, usize), usize, usize, bool) {
        self.0.with_dependent(|pdf, _| {
            (pdf.pages().kids_read(), labels::walked(pdf).nodes, outline::walked(pdf).names, pdf.pages().lost_everything())
        })
    }

    /// The page's links, in the order `annotations` lists them, with where each goes.
    pub fn links(&self, index: usize) -> Result<Vec<Link>, EngineError> {
        self.with_page(index, |pdf, page, _| links::read(pdf, page, page.initial_transform(true).to_kurbo()))
    }

    /// The document's outline, in order; each item's children follow it, one level deeper.
    pub fn outline(&self) -> Vec<outline::OutlineItem> {
        self.0.with_dependent(|pdf, _| outline::read(pdf))
    }

    /// The page's annotations alone, without interpreting its content.
    pub fn annotations(&self, index: usize) -> Result<Vec<Annotation>, EngineError> {
        self.with_page(index, |_, page, caches| annots::read(page, &caches.text, page.initial_transform(true).to_kurbo()))
    }

    /// The pixmap's scales, and with a region, its window on the page's bitmap and that bitmap's size.
    fn pixmap_settings(
        &self,
        index: usize,
        width: f32,
        max_height: f32,
        region: Option<Region>,
    ) -> Result<(PixmapSettings, Option<Placed>), EngineError> {
        let info = self.page_info(index)?;
        let Some(region) = region else {
            let scale = render_scale(info.width, info.height, width, max_height)?;
            // Each side rounds up, and the page stretches to
            // fill that bitmap (under a pixel). hayro floors `side * scale`, so
            // step the exact scale up by one ULP when float error would lose a pixel.
            let fit = |page: f32| fit_scale(page, pixel_side(page * scale));
            let settings = PixmapSettings {
                x_scale: fit(info.width),
                y_scale: fit(info.height),
                bg_color: WHITE,
                window: None,
            };
            return Ok((settings, None));
        };
        // The scale and sides the whole page would have, without the limits a whole page's
        // bitmap has: those are on the region's.
        let scale = unlimited_scale(info.width, info.height, width, max_height)?;
        let (page_w, page_h) = (whole_pixels(info.width * scale), whole_pixels(info.height * scale));
        if !(page_w <= MAX_REGION_PAGE_SIDE && page_h <= MAX_REGION_PAGE_SIDE) {
            return Err(EngineError::new(
                ErrorKind::Failed,
                format!("at this scale the page is {page_w}x{page_h} px; a region's page may be up to {MAX_REGION_PAGE_SIDE} a side"),
            ));
        }
        let (page_w, page_h) = (page_w.max(1.0), page_h.max(1.0));
        let scales = (fit_scale(info.width, page_w), fit_scale(info.height, page_h));
        let page = (page_w as u32, page_h as u32);
        let finite = [region.x, region.y, region.width, region.height].iter().all(|v| v.is_finite());
        let Some((x, y, w, h)) = region_pixels(region, (info.width, info.height), page).filter(|_| finite && region.width > 0.0 && region.height > 0.0)
        else {
            return Err(EngineError::new(ErrorKind::Failed, "the region has no area on the page"));
        };
        if w as f32 > MAX_RENDER_SIDE || h as f32 > MAX_RENDER_SIDE || (w as f32) * (h as f32) > MAX_RENDER_PIXELS {
            return Err(EngineError::new(
                ErrorKind::Failed,
                format!("the region is {w}x{h} px; one render is at most {MAX_RENDER_SIDE} a side and {MAX_RENDER_PIXELS} px"),
            ));
        }
        // The window drawn starts where the renderer's own tiles do in the whole page's pixmap, so
        // each pixel is computed as there, from the same tile's start; the region is cut from it.
        let (wx, wy) = (x - x % WINDOW_ALIGN.0, y - y % WINDOW_ALIGN.1);
        let settings = PixmapSettings {
            x_scale: scales.0,
            y_scale: scales.1,
            bg_color: WHITE,
            window: Some(hayro::Window { x: wx, y: wy, width: (w + x - wx) as u16, height: (h + y - wy) as u16 }),
        };
        Ok((settings, Some(Placed { page, region: (x, y, w, h) })))
    }

    fn pixmap(
        &self,
        index: usize,
        settings: &PixmapSettings,
    ) -> Result<(hayro::vello_cpu::Pixmap, bool), EngineError> {
        let cuts = hayro::hayro_syntax::decodes_cut();
        self.with_page(index, |_, page, caches| {
            let pixmap = render(
                page,
                &caches.render,
                &crate::assets::settings(),
                &RenderSettings::default(),
                settings,
            );
            (pixmap, caches.render.take_degraded() || hayro::hayro_syntax::decodes_cut() != cuts)
        })
    }

    /// Scale is `min(width / pageWidth, maxHeight / pageHeight)`.
    pub fn render(&self, index: usize, width: f32, max_height: f32) -> Result<Bitmap, EngineError> {
        self.render_region(index, width, max_height, None)
    }

    /// `render`, or with a region the part of that page's bitmap it covers, at the same scale
    /// but without a whole page's size limits: those are on the region. The page's bitmap at that
    /// scale may be up to `MAX_REGION_PAGE_SIDE` a side.
    pub fn render_region(&self, index: usize, width: f32, max_height: f32, region: Option<Region>) -> Result<Bitmap, EngineError> {
        let (settings, page) = self.pixmap_settings(index, width, max_height, region)?;
        let (pixmap, truncated) = self.pixmap(index, &settings)?;
        Ok(bitmap_of(pixmap, truncated, &settings, page))
    }
}

/// A page being drawn a slice at a time, the same pixels as `Document::render`.
pub struct RenderTask {
    // Before the document it borrows from, so it's dropped first.
    job: hayro::PageJob<'static, 'static>,
    _document: std::rc::Rc<Document>,
    /// Whether a stream or image was left out for its size, in any slice.
    cut: bool,
    settings: PixmapSettings,
    page: Option<Placed>,
}

impl RenderTask {
    pub fn new(
        document: std::rc::Rc<Document>,
        index: usize,
        width: f32,
        max_height: f32,
        region: Option<Region>,
    ) -> Result<Self, EngineError> {
        let (settings, page) = document.pixmap_settings(index, width, max_height, region)?;
        let cuts = hayro::hayro_syntax::decodes_cut();
        let job = document.with_page(index, |_, page, caches| {
            let job = hayro::PageJob::new(
                page,
                &caches.render,
                &crate::assets::settings(),
                &RenderSettings::default(),
                &settings,
            );
            // SAFETY: the job borrows only from the document's self-cell, whose owner and
            // dependent live on the heap at a fixed address. `_document` keeps that alive for as
            // long as the job, and the job goes first. Nothing mutable is borrowed across a return:
            // the caches it shares with other calls are behind RefCells held only inside a call.
            unsafe {
                std::mem::transmute::<hayro::PageJob<'_, '_>, hayro::PageJob<'static, 'static>>(job)
            }
        })?;
        Ok(Self {
            job,
            _document: document,
            cut: hayro::hayro_syntax::decodes_cut() != cuts,
            settings,
            page,
        })
    }

    /// Runs until `expired` says so; true once the page's content is done.
    pub fn step(&mut self, expired: &dyn Fn() -> bool) -> bool {
        let cuts = hayro::hayro_syntax::decodes_cut();
        let done = self.job.step(expired);
        self.cut |= hayro::hayro_syntax::decodes_cut() != cuts;
        done
    }

    /// Rasterizes what `step` drew. One call, after `step` returned true.
    pub fn finish(&mut self) -> Bitmap {
        let cuts = hayro::hayro_syntax::decodes_cut();
        let (pixmap, truncated) = self.job.finish();
        self.cut |= hayro::hayro_syntax::decodes_cut() != cuts;
        bitmap_of(pixmap, truncated || self.cut, &self.settings, self.page)
    }
}

/// The pixmap's own buffer, with no second page-sized allocation at the render's peak.
/// A region's place: the whole page's pixmap's size, and the region's pixels in it.
#[derive(Clone, Copy, Debug)]
struct Placed {
    page: (u32, u32),
    region: (u32, u32, u32, u32),
}

/// Where a region's window starts: on the renderer's wide tiles across (256 px) and its strips
/// down (4 px). A window there draws each pixel as the whole page's pixmap does; one elsewhere
/// starts the renderer's per-tile stepping somewhere else, and a tiling pattern sampled far from
/// its origin, or an image on a nearest-neighbour tie, can come out differently.
const WINDOW_ALIGN: (u32, u32) = (256, 4);

fn bitmap_of(
    pixmap: hayro::vello_cpu::Pixmap,
    truncated: bool,
    settings: &PixmapSettings,
    placed: Option<Placed>,
) -> Bitmap {
    let (width, height) = (u32::from(pixmap.width()), u32::from(pixmap.height()));
    let rgba = pixmap.take_rgba8(hayro::vello_cpu::peniko::ImageAlphaType::AlphaPremultiplied);
    let (Some(placed), Some(window)) = (placed, settings.window) else {
        return Bitmap { width, height, rgba, truncated, x: 0, y: 0, page_width: width, page_height: height };
    };
    // The region, cut from the window drawn round it.
    let (x, y, w, h) = placed.region;
    let (dx, dy) = ((x - window.x) as usize, (y - window.y) as usize);
    let rgba = if (dx, dy, w, h) == (0, 0, width, height) {
        rgba
    } else {
        let (stride, row) = (width as usize * 4, w as usize * 4);
        (0..h as usize).flat_map(|r| {
            let at = (dy + r) * stride + dx * 4;
            rgba[at..at + row].iter().copied()
        }).collect()
    };
    Bitmap { width: w, height: h, rgba, truncated, x, y, page_width: placed.page.0, page_height: placed.page.1 }
}

#[cfg(test)]
mod sha256_tests {
    fn hex(data: &[u8]) -> String {
        hayro::hayro_syntax::sha256(data).iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn known_answers_at_the_padding_boundaries() {
        assert_eq!(hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        // 56 bytes: the length no longer fits in the block it would end.
        assert_eq!(
            hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(hex(&[b'a'; 55]), "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318");
        assert_eq!(hex(&[b'a'; 64]), "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
        assert_eq!(hex(&[b'a'; 119]), "31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_sizes_are_bounded() {
        assert_eq!(render_scale(300.0, 300.0, 600.0, 4096.0), Ok(2.0));
        let huge = render_scale(300.0, 300.0, 70000.0, 70000.0).unwrap();
        assert!(300.0 * huge <= MAX_RENDER_SIDE);
        // Fit to width on a very tall page stays under both limits.
        let tall = render_scale(200.0, 14400.0, 1000.0, f32::INFINITY).unwrap();
        assert!(14400.0 * tall <= MAX_RENDER_SIDE);
        assert!(200.0 * tall * 14400.0 * tall <= MAX_RENDER_PIXELS * 1.0001);
        for (w, h) in [
            (0.0, 100.0),
            (f32::NAN, 100.0),
            (-5.0, 100.0),
            (100.0, 0.0),
            (f32::INFINITY, 100.0),
        ] {
            assert!(render_scale(300.0, 300.0, w, h).is_err(), "{w}x{h}");
        }
    }

    /// A PDF from `objects` (object 1 is the catalog), with a correct xref.
    fn pdf(objects: &[&[u8]]) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        out.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for o in offsets {
            out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer << /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        out
    }

    fn stream(dict: &str, data: &[u8]) -> Vec<u8> {
        let mut s = format!("<< {dict} /Length {} >>\nstream\n", data.len()).into_bytes();
        s.extend_from_slice(data);
        s.extend_from_slice(b"\nendstream");
        s
    }

    /// A stream or image that decodes past the limit is left out, and what the page says is
    /// `truncated`, rather than taking memory it can't give back. 60,000 by 60,000 pixels declared by
    /// 16 bytes of `CCITTFaxDecode` crashed the wasm; a content stream inflating past the limit is
    /// cut there, and the page's other content still reads.
    #[test]
    fn what_decodes_past_the_limit_is_left_out_and_says_so() {
        use std::io::Write;
        let font = "/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>";
        let page = |resources: String| format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents [4 0 R 5 0 R] /Resources << {resources} >> >>");

        // An image declaring 3.6 GB, from 16 bytes.
        let image = stream("/Type /XObject /Subtype /Image /Width 60000 /Height 60000 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 60000 /Rows 60000 >>", &[0; 16]);
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                page(format!("{font} /XObject << /Im 6 0 R >>")).as_bytes(),
                &stream("", b"BT /F1 10 Tf 10 10 Td (kept) Tj ET"),
                &stream("", b"q 100 0 0 100 0 0 cm /Im Do Q"),
                &image,
            ]),
            "",
        )
        .unwrap();
        let bitmap = doc.render(0, 100.0, f32::INFINITY).unwrap();
        assert!(bitmap.truncated);
        assert!(bitmap.rgba.chunks(4).any(|px| px[0] < 128), "the text is still drawn");
        let text = doc.text(0).unwrap();
        assert!(text.text().contains("kept") && !text.truncated, "text doesn't decode the image");

        // A content stream inflating to 4 MiB, under a limit of 1 MiB.
        let mut zipped = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        zipped.write_all(&vec![b' '; 4 << 20]).unwrap();
        let bomb = stream("/Filter /FlateDecode", &zipped.finish().unwrap());
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                page(font.to_string()).as_bytes(),
                &stream("", b"BT /F1 10 Tf 10 10 Td (kept) Tj ET"),
                &bomb,
            ]),
            "",
        )
        .unwrap();
        let whole = doc.text(0).unwrap();
        hayro::hayro_syntax::set_max_decoded_bytes(1 << 20);
        let cut = Document::open(doc.file_bytes().to_vec(), "").unwrap().text(0).unwrap();
        hayro::hayro_syntax::set_max_decoded_bytes(hayro::hayro_syntax::DEFAULT_MAX_DECODED_BYTES);
        assert!(cut.truncated && !whole.truncated);
        assert!(cut.text().contains("kept"), "the page's other stream still reads: {:?}", cut.text());
    }

    /// A page's content streams are joined, and a form's content is held while what it draws runs,
    /// so the limit is on what they add up to: one 700 MiB stream listed five times in `/Contents`,
    /// or forms of 600 MiB nested five deep, crashed the wasm with the limit on each alone. And what
    /// a limit left out is kept that way, in the page's content and in a font, so every call that
    /// uses it says `truncated`, whatever was read before, and after the page's content is let go.
    #[test]
    fn what_a_limit_left_out_says_so_on_every_call_in_any_order() {
        use std::io::Write;
        const MAX: usize = 1 << 20;
        let zip = |data: &[u8]| {
            let mut zipped = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
            zipped.write_all(data).unwrap();
            zipped.finish().unwrap()
        };
        let spaces = vec![b' '; 300 << 10];
        let font = "/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
        let text = b"BT /F1 10 Tf 10 10 Td (kept) Tj ET";
        // Page 1: one 300 KiB stream listed five times. Page 2: three nested forms of 400 KiB. Page 3:
        // a font whose 2 MiB program is past the limit. Pages 4 to 8 read 300 KiB each, to let page 1's
        // content go.
        let page = |contents: &str, resources: &str| {
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents {contents} /Resources << /Font << {font} >> {resources} >> >>")
        };
        let form = |inner: Option<u32>| {
            let (resources, draw) = match inner {
                Some(n) => (format!("/Resources << /XObject << /N {n} 0 R >> >>"), "/N Do\n"),
                None => (String::new(), ""),
            };
            let mut data = draw.as_bytes().to_vec();
            data.extend_from_slice(&[b' '; 400 << 10]);
            stream(&format!("/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Filter /FlateDecode {resources}"), &zip(&data))
        };
        let objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 6 0 R 6 0 R 6 0 R 6 0 R 17 0 R 18 0 R] /Count 10 >>".to_vec(),
            page("[7 0 R 8 0 R 8 0 R 8 0 R 8 0 R 8 0 R]", "").into_bytes(),
            page("9 0 R", "/XObject << /N 10 0 R >>").into_bytes(),
            page("13 0 R", "/Font << /F2 14 0 R >>").into_bytes(),
            page("[7 0 R 8 0 R]", "").into_bytes(),
            stream("", text),
            stream("/Filter /FlateDecode", &zip(&spaces)),
            stream("", b"/N Do"),
            form(Some(11)),
            form(Some(12)),
            form(None),
            stream("", b"BT /F2 10 Tf 10 10 Td (kept) Tj ET"),
            b"<< /Type /Font /Subtype /TrueType /BaseFont /Big /FirstChar 32 /LastChar 126 /FontDescriptor 15 0 R >>".to_vec(),
            b"<< /Type /FontDescriptor /FontName /Big /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 16 0 R >>".to_vec(),
            stream("/Filter /FlateDecode", &zip(&vec![0; 2 << 20])),
            // Page 9 uses the same font, so reading it first caches the font before page 3 reads it.
            page("13 0 R", "/Font << /F2 14 0 R >>").into_bytes(),
            // Page 10: a colour space whose ICC profile is past the limit, kept in the object cache.
            page("19 0 R", "/ColorSpace << /C 20 0 R >>").into_bytes(),
            stream("", b"/C cs 0.5 0.5 0.5 sc 0 0 50 50 re f"),
            b"[/ICCBased 21 0 R]".to_vec(),
            stream("/N 3 /Filter /FlateDecode", &zip(&vec![0; 2 << 20])),
        ];
        let bytes = pdf(&objects.iter().map(Vec::as_slice).collect::<Vec<_>>());
        hayro::hayro_syntax::set_max_decoded_bytes(MAX);
        type Read = fn(&std::rc::Rc<Document>, usize) -> bool;
        let reads: [(&str, Read); 4] = [
            ("text", |d, i| d.text(i).unwrap().truncated),
            ("objects", |d, i| d.scan(i, true, false).unwrap().objects.truncated),
            ("render", |d, i| d.render(i, 50.0, f32::INFINITY).unwrap().truncated),
            ("sliced", |d, i| {
                let mut task = RenderTask::new(d.clone(), i, 50.0, f32::INFINITY, None).unwrap();
                while !task.step(&|| true) {}
                task.finish().truncated
            }),
        ];
        let orders: [&[usize]; 4] = [&[0, 1, 2, 3], &[3, 2, 1, 0], &[2, 0, 3, 1], &[1, 3, 0, 2]];
        for (o, order) in orders.iter().enumerate() {
            let doc = std::rc::Rc::new(Document::open(bytes.clone(), "").unwrap());
            // Different things read first: the font through page 9, page 1's content, or nothing.
            match o {
                1 => assert!(doc.render(8, 50.0, f32::INFINITY).unwrap().truncated),
                2 => assert!(doc.text(0).unwrap().truncated),
                _ => {}
            }
            for round in 0..2 {
                for &r in *order {
                    let (name, read) = reads[r];
                    // Page 3's text: a font with no program reads the same, but it's still cut.
                    for page in [0, 1, 2, 9] {
                        // Text reads neither page 2's forms (no text in them) nor page 10's colours.
                        if name == "text" && (page == 1 || page == 9) {
                            continue;
                        }
                        assert!(read(&doc, page), "order {o} round {round}: {name} of page {} says nothing", page + 1);
                    }
                }
                // Let page 1's content go, so it's decoded again.
                for page in 3..8 {
                    doc.text(page).unwrap();
                }
            }
        }
        hayro::hayro_syntax::set_max_decoded_bytes(hayro::hayro_syntax::DEFAULT_MAX_DECODED_BYTES);
    }

    /// A page switching among many fonts finds each one's id in one lookup: comparing with every
    /// font met so far made a page of n fonts, each shown a few times, cost n² comparisons.
    #[test]
    fn a_font_switch_costs_the_same_however_many_fonts_a_page_has() {
        const FONTS: usize = 300;
        const RUNS: usize = 4 * FONTS;
        let names: String = (0..FONTS).map(|i| format!("/F{i} {} 0 R ", 5 + i)).collect();
        let page = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << /Font << {names}>> >> >>"
        );
        let content: String = (0..RUNS)
            .map(|i| format!("/F{} 1 Tf 1 0 0 1 {} {} Tm (a) Tj ", i % FONTS, i % 500, i / 500))
            .collect();
        let content = stream("", format!("BT {content}ET").as_bytes());
        // Each font its own dictionary: a width tells them apart.
        let fonts: Vec<String> = (0..FONTS)
            .map(|i| format!("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 97 /LastChar 97 /Widths [{}] >>", 500 + i))
            .collect();
        let mut objects: Vec<&[u8]> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            page.as_bytes(),
            &content,
        ];
        objects.extend(fonts.iter().map(|f| f.as_bytes()));
        let doc = Document::open(pdf(&objects), "").unwrap();
        let before = device::FONT_PROBES.with(|n| n.get());
        let text = doc.text(0).unwrap();
        let probes = device::FONT_PROBES.with(|n| n.get()) - before;
        assert_eq!(text.fonts.len(), FONTS);
        assert!(text.chars.iter().filter(|c| &*c.text == "a").count() >= RUNS - 10);
        assert!(probes <= 2 * RUNS, "{probes} comparisons for {RUNS} runs");
    }

    /// Every glyph drawn at a size of its own is a mask of its own. One page's are bounded, and
    /// the cache doesn't keep them past the next page: 12,000 glyphs a hair apart in size took 320 MB
    /// as images and kept it for as long as the document was open.
    #[test]
    fn glyph_images_are_bounded_per_page_and_not_kept() {
        const GLYPHS: usize = 12_000;
        let content: String = (0..GLYPHS)
            .map(|i| format!("{:.4} 0 0 60 {} {} Tm (W) Tj ", 60.0 + i as f64 * 1e-4, i * 13 % 500, i * 7 % 700))
            .collect();
        let big = stream("", format!("BT /F1 1 Tf {content}ET").as_bytes());
        let small = stream("", b"BT /F1 12 Tf 10 10 Td (W) Tj ET");
        let page = |contents: u32| {
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents {contents} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>"
            )
        };
        let (first, second) = (page(4), page(6));
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
                first.as_bytes(),
                &big,
                second.as_bytes(),
                &small,
            ]),
            "",
        )
        .unwrap();
        let bitmap = doc.render(0, 1000.0, f32::INFINITY).unwrap();
        assert!(!bitmap.truncated);
        let held = doc.glyph_cache_bytes();
        assert!(held <= (64 << 20) + (64 << 10), "{held} bytes of glyph masks for one page");
        doc.render(1, 1000.0, f32::INFINITY).unwrap();
        let kept = doc.glyph_cache_bytes();
        assert!(kept < 1 << 20, "{kept} bytes kept after a page of one glyph");
    }

    /// A page that draws more than a limit is rasterized in parts, so what it holds is bounded; a
    /// part rasterized over the others is what rasterizing them together gives. Here after every
    /// draw: glyphs black, coloured, translucent, clipped by a rectangle and by a path, rotated, and
    /// paths, strokes, an image and a group among them.
    #[test]
    fn a_page_rasterized_in_parts_is_the_page() {
        let mut content = String::from("q 0.2 0.5 0.9 rg 20 20 200 120 re f Q BT /F1 9 Tf ");
        for (i, colour) in ["0 g", "0.8 0.1 0.1 rg", "0.1 0.4 0.2 rg /Half gs", "0.5 g"].iter().enumerate() {
            content += &format!("{colour} 1 0 0 1 {} {} Tm (Rasterized in parts, one draw at a time) Tj ", 10 + i * 3, 180 - i * 11);
        }
        content += "ET q 30 60 150.5 40.25 re W n BT 0 g /F1 14 Tf 20 70 Td (Clipped by a rectangle) Tj ET Q ";
        content += "q 100 100 m 220 130 l 120 40 l h W n BT 0 g /F1 16 Tf 60 80 Td (Clipped by a path) Tj ET Q ";
        content += "BT 0 g /F1 10 Tf 0.9 0.4 -0.4 0.9 40 20 Tm (Turned) Tj ET 2 w 0 0 1 RG 10 10 m 230 190 l S ";
        content += "q 40 0 0 30 160 150 cm BI /W 2 /H 2 /CS /G /BPC 8 /F /AHx ID 0080C0FF> EI Q /G0 Do";
        let group = stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 240 200] /Group << /S /Transparency /I true >> /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>",
            b"BT 0.3 g /F1 12 Tf 120 20 Td (In a group) Tj ET",
        );
        let page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> /ExtGState << /Half << /ca 0.5 >> >> /XObject << /G0 5 0 R >> >> >>";
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                page.as_bytes(),
                &stream("", content.as_bytes()),
                &group,
            ]),
            "",
        )
        .unwrap();
        let whole = doc.render(0, 960.0, f32::INFINITY).unwrap();
        hayro::set_max_recorded_bytes(1);
        let parts = doc.render(0, 960.0, f32::INFINITY);
        hayro::set_max_recorded_bytes(32 << 20);
        let parts = parts.unwrap();
        assert!(whole.rgba.chunks(4).filter(|p| p[0] < 64).count() > 1000);
        assert!(whole.rgba == parts.rgba, "the page in parts differs");
    }

    /// A stitching function that lists the same function twice at every level asks for 2^levels of
    /// them from a few hundred bytes: 20 levels took 17 s to draw. A repeat is built once, and one
    /// holding more than 2^14 repeats isn't built.
    #[test]
    fn a_function_listing_the_next_twice_costs_a_bounded_amount() {
        use hayro::hayro_interpret::function_work;
        let work = |levels: usize| {
            let page = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Shading << /S << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 100 0] /Function 5 0 R >> >> >> >>";
            let content = stream("", b"/S sh");
            let functions: Vec<String> = (0..levels)
                .map(|i| {
                    if i == levels - 1 {
                        "<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>".to_string()
                    } else {
                        format!("<< /FunctionType 3 /Domain [0 1] /Functions [{n} 0 R {n} 0 R] /Bounds [0.5] /Encode [0 1 0 1] >>", n = 6 + i)
                    }
                })
                .collect();
            let mut objects: Vec<&[u8]> = vec![b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page, &content];
            objects.extend(functions.iter().map(|f| f.as_bytes()));
            let doc = Document::open(pdf(&objects), "").unwrap();
            let before = function_work();
            doc.scan(0, true, false).unwrap();
            let bitmap = doc.render(0, 100.0, f32::INFINITY).unwrap();
            (function_work() - before, bitmap)
        };
        // Under the limit it draws, as before: 2^11 pieces, each black to white, finer than a pixel.
        let (_, bitmap) = work(12);
        let row: Vec<u8> = bitmap.rgba[..4 * 100].iter().step_by(4).copied().collect();
        assert!(row.iter().any(|&v| v < 16) && row.iter().any(|&v| v > 240), "{row:?}");
        let (work, _) = work(22);
        assert!(work <= 4 << 14, "{work} functions built or visited");
    }

    /// A stitching function of many distinct functions isn't a repeat, so it's drawn whole: one of
    /// 20,000 was left blank by a limit on the functions one may hold.
    #[test]
    fn a_function_of_many_distinct_ones_is_drawn() {
        const N: usize = 20_000;
        let functions: String = (0..N).map(|i| format!("<< /FunctionType 2 /Domain [0 1] /C0 [{}] /C1 [{}] /N 1 >> ", i as f32 / N as f32, (i + 1) as f32 / N as f32)).collect();
        let bounds: String = (1..N).map(|i| format!("{} ", i as f32 / N as f32)).collect();
        let page = format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Shading << /S << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 100 0] /Function << /FunctionType 3 /Domain [0 1] /Functions [{functions}] /Bounds [{bounds}] /Encode [{}] >> >> >> >> >>", "0 1 ".repeat(N));
        let content = stream("", b"/S sh");
        let doc = Document::open(pdf(&[b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page.as_bytes(), &content]), "").unwrap();
        let bitmap = doc.render(0, 100.0, f32::INFINITY).unwrap();
        assert!(bitmap.rgba[0] < 16 && bitmap.rgba[4 * 99] > 240 && (100..156).contains(&bitmap.rgba[4 * 50]), "{:?} {:?}", &bitmap.rgba[..4], &bitmap.rgba[4 * 50..4 * 51]);
    }

    /// Every `EI` in an inline image's data is a candidate end, which upstream checked by reading on
    /// through the later ones: 16,000 of them and a binary byte after them took 1.1 s a call. The
    /// work is linear now, and the text after the image still reads.
    #[test]
    fn ending_an_inline_image_is_linear_in_its_eis() {
        use hayro::hayro_syntax::content::inline_image_work;
        let work = |eis: usize| {
            let mut data = format!("q 10 0 0 10 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /G ID {}", "EI ".repeat(eis)).into_bytes();
            // Binary after them: every EI before it is image data.
            data.extend_from_slice(b"\x80 EI Q BT /F1 10 Tf (after) Tj ET");
            let content = stream("", &data);
            let doc = Document::open(
                pdf(&[
                    b"<< /Type /Catalog /Pages 2 0 R >>",
                    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
                    &content,
                ]),
                "",
            )
            .unwrap();
            let before = inline_image_work();
            let text = doc.text(0).unwrap().text();
            assert!(text.contains("after"), "{text:?}");
            inline_image_work() - before
        };
        let (small, large) = (work(2000), work(8000));
        assert!(large <= 5 * small, "{small} steps for 2,000 EIs, {large} for 8,000");
        assert!(large <= 8 * 8000 * 3, "{large} steps for 8,000 EIs");
    }

    /// An outline of n bookmarks, each the `/Next` of the one before.
    fn outline_of(n: usize) -> Vec<u8> {
        let mut objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>".to_vec(),
            format!("<< /Type /Outlines /First 5 0 R /Last {} 0 R /Count {n} >>", 4 + n).into_bytes(),
        ];
        for i in 0..n {
            let id = 5 + i;
            let prev = if i > 0 { format!("/Prev {} 0 R", id - 1) } else { String::new() };
            let next = if i + 1 < n { format!("/Next {} 0 R", id + 1) } else { String::new() };
            objects.push(format!("<< /Title (Item {i}) /Parent 4 0 R {prev} {next} /Dest [3 0 R /Fit] >>").into_bytes());
        }
        pdf(&objects.iter().map(Vec::as_slice).collect::<Vec<_>>())
    }

    /// The fastest of three runs of `f`, in seconds.
    fn fastest(mut f: impl FnMut()) -> f64 {
        (0..3)
            .map(|_| {
                let start = std::time::Instant::now();
                f();
                start.elapsed().as_secs_f64()
            })
            .fold(f64::INFINITY, f64::min)
    }

    /// Each object read carried the chain of objects read to reach it, copied and searched at every
    /// step, so a list linked by `/Next` cost the square of its length: 64,000 bookmarks took 0.8 s.
    /// Eight times the bookmarks take about eight times as long now, where they took 64.
    #[test]
    fn an_outline_reads_in_time_linear_in_its_items() {
        let time = |n: usize| {
            let doc = Document::open(outline_of(n), "").unwrap();
            let items = doc.outline();
            assert_eq!(items.len(), n);
            assert!(items.iter().all(|item| item.page == 0), "{:?}", items.last());
            assert_eq!(items[n - 1].title, format!("Item {}", n - 1));
            fastest(|| assert_eq!(doc.outline().len(), n))
        };
        let (small, large) = (time(2_000), time(16_000));
        assert!(large < 24.0 * small, "{small:.4} s for 2,000 bookmarks, {large:.4} s for 16,000");
    }

    /// A walk through objects that refer to each other in a ring stops where it did: the read that
    /// comes back to an object it's still reading from is refused. Past the objects the chain keeps,
    /// a ring is still walked a bounded number of times.
    #[test]
    fn a_ring_of_references_ends_a_walk() {
        use hayro::hayro_syntax::object::{Dict, ObjectIdentifier};
        let hops = |n: usize| {
            let mut objects = vec![b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(), b"<< /Type /Pages /Kids [] /Count 0 >>".to_vec()];
            objects.extend((0..n).map(|i| format!("<< /Next {} 0 R >>", 3 + (i + 1) % n).into_bytes()));
            let pdf = hayro::hayro_syntax::Pdf::new(pdf(&objects.iter().map(Vec::as_slice).collect::<Vec<_>>())).unwrap();
            let mut node = pdf.xref().get::<Dict<'_>>(ObjectIdentifier::new(3, 0)).unwrap();
            let mut hops = 0usize;
            while let Some(next) = node.get::<Dict<'_>>(b"Next") {
                node = next;
                hops += 1;
            }
            hops
        };
        assert_eq!(hops(1), 0);
        assert_eq!(hops(10), 9);
        assert_eq!(hops(64), 63);
        assert_eq!(hops(65), (1 << 17) - 1);
    }

    /// A file repaired by scanning it probes for a dictionary at each `<<`, and in `<< << << ...`
    /// nested past the parser's limit of 512 each probe went 512 deep before it failed: 50,000 of
    /// them in 150 KB took 180 ms to open. A probe that can't find enough `>>` and `]` after where
    /// the last one stopped isn't run, and the objects after them are still found.
    #[test]
    fn repairing_dictionaries_nested_past_the_limit_is_linear() {
        use hayro::hayro_syntax::xref::repair_probes;
        let probes = |depth: usize| {
            let mut file = b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n\
                2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n\
                3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 5 0 R \
                /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >> endobj\n\
                4 0 obj "
                .to_vec();
            file.extend_from_slice(&b"<< ".repeat(depth));
            file.extend_from_slice(b"endobj\n");
            file.extend_from_slice(b"5 0 obj\n");
            file.extend_from_slice(&stream("", b"BT /F1 10 Tf 10 10 Td (after) Tj ET"));
            file.extend_from_slice(b"\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
            let before = repair_probes();
            let doc = Document::open(file, "").unwrap();
            assert_eq!(doc.text(0).unwrap().text(), "after");
            repair_probes() - before
        };
        let (small, large) = (probes(2000), probes(8000));
        // A probe at each `<<` was 8,000. Those within the limit of the end still run, each failing at
        // `endobj` without reaching the limit: at most 512, however deep.
        assert!(large <= 5 * small && large <= 1000, "{small} probes for 2,000 deep, {large} for 8,000");
    }

    /// Skipping the probes that can't end changes nothing a scan finds: random files of nested
    /// dictionaries and arrays past the limit, closed or not, with objects, trailers and strings of
    /// `>>` among them, scan and read the same with every probe run.
    #[test]
    fn repairing_skips_only_probes_that_fail() {
        use hayro::hayro_syntax::xref::{repair_probes, repair_scan_for_tests, set_repair_skips_doomed_probes};
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        let read = |file: &[u8]| {
            let Ok(doc) = Document::open(file.to_vec(), "") else { return None };
            let pages: Vec<_> = (0..doc.page_count()).map(|i| doc.text(i).map(|t| t.text()).ok()).collect();
            Some(pages)
        };
        let mut skipped = 0;
        for _ in 0..24 {
            let mut file = b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n".to_vec();
            for _ in 0..1 + next(3) {
                let depth = 400 + next(900) as usize;
                file.extend_from_slice(format!("{} 0 obj ", 10 + next(5)).as_bytes());
                for d in 0..depth {
                    file.extend_from_slice(match next(10) {
                        0 => b"[ ".as_slice(),
                        1 if d % 7 == 0 => b"/A (>>) << ",
                        2 if d % 5 == 0 => b"6 0 R << ",
                        3 if d % 11 == 0 => b"<< /Type /Pages /Kids [3 0 R] /Count 1 >> << ",
                        _ => b"<< /K ",
                    });
                }
                let closers = match next(3) {
                    0 => 0,
                    1 => depth - next(40) as usize,
                    _ => depth + 2,
                };
                file.extend_from_slice(&b">> ] ".repeat(closers / 2));
                file.extend_from_slice(b"endobj\n");
            }
            file.extend_from_slice(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n\
                3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 5 0 R \
                /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >> endobj\n");
            file.extend_from_slice(b"5 0 obj\n");
            file.extend_from_slice(&stream("", b"BT /F1 10 Tf 10 10 Td (after) Tj ET"));
            file.extend_from_slice(b"\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
            let before = repair_probes();
            let skipping = (repair_scan_for_tests(file.clone()), read(&file));
            let (middle, _) = (repair_probes(), set_repair_skips_doomed_probes(false));
            let probing = (repair_scan_for_tests(file.clone()), read(&file));
            set_repair_skips_doomed_probes(true);
            assert_eq!(skipping, probing);
            skipped += (repair_probes() - middle) - (middle - before);
        }
        assert!(skipped > 10_000, "only {skipped} probes skipped");
    }

    /// The one-pass search for an inline image's end answers what upstream's rereading does, on
    /// random data made of what decides it: `EI`, `BI`, white space, strings and their escapes,
    /// binary bytes, operators, and dictionaries that start an image.
    #[test]
    fn an_inline_image_ends_where_rereading_says() {
        use hayro::hayro_syntax::content::{ends_by_rereading, inline_image_end_for_tests};
        let pieces: [&[u8]; 16] = [
            b"EI", b"EI ", b" EI\n", b"BI", b"BI /W 1 /H 1 /BPC 8 /CS /G ID ", b" ", b"(", b")", b"\\", b"\x80",
            b"\xff", b"q ", b"Q ", b"(a) Tj ", b"x", b"1 0 0 1 0 0 cm ",
        ];
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for round in 0..20_000 {
            let length = 1 + (next() % 60) as usize;
            let data: Vec<u8> = (0..length).flat_map(|_| pieces[(next() % 16) as usize].iter().copied()).collect();
            assert_eq!(inline_image_end_for_tests(&data), ends_by_rereading(&data), "round {round}: {:?} {:?}", String::from_utf8_lossy(&data), data);
        }
    }

    /// A membership dictionary of n groups, named by m `BDC`s, was read m times: 16,000 of each took
    /// 13 s a call. It's read once a page.
    #[test]
    fn a_membership_dictionary_is_read_once_a_page() {
        use hayro::hayro_interpret::ocmd_reads;
        const BDCS: usize = 500;
        let content = stream("", format!("{}BT /F1 10 Tf 10 10 Td (on) Tj ET /OC /M BDC BT /F1 10 Tf 10 30 Td (off) Tj ET EMC", "/OC /M BDC EMC ".repeat(BDCS)).as_bytes());
        let ocmd = format!("<< /Type /OCMD /OCGs [{}] /P /AllOn >>", "6 0 R ".repeat(BDCS));
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] >> >> >>",
                b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Properties << /M 5 0 R >> /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
                &content,
                ocmd.as_bytes(),
                b"<< /Type /OCG /Name (x) >>",
            ]),
            "",
        )
        .unwrap();
        let before = ocmd_reads();
        let text = doc.text(0).unwrap().text();
        let reads = ocmd_reads() - before;
        assert_eq!(text.trim(), "on");
        assert!(reads <= 1, "{reads} reads of one dictionary");
    }

    /// Each use of a named resource parsed the object it names, so naming one of n bytes m times cost
    /// m×n: 8,000 `gs`, `Do`, `cs` or `BDC` naming a 16 KB object took 0.6 s a call. A stream looks
    /// each name up once.
    #[test]
    fn a_stream_looks_each_named_resource_up_once() {
        use hayro::hayro_interpret::named_reads;
        const USES: usize = 300;
        let junk = "0 ".repeat(2000);
        let uses = "/G gs /X Do /C cs 0.5 sc /P scn /S sh /Tag /M BDC EMC /F1 10 Tf (a) Tj /F2 10 Tf (b) Tj ".repeat(USES);
        let content = stream("", format!("BT {uses}ET").replace("/X Do", "ET /X Do BT").replace("/S sh", "ET /S sh BT").as_bytes());
        let page = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << \
             /ExtGState << /G << /LW 1 /Junk [{junk}] >> >> /XObject << /X 5 0 R >> \
             /ColorSpace << /C [/Indexed /DeviceRGB 0 <000000> {junk}] >> \
             /Pattern << /P << /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 1 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >> /Junk [{junk}] >> >> \
             /Shading << /S << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 1 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> /Junk [{junk}] >> >> \
             /Properties << /M << /Junk [{junk}] >> >> \
             /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Junk [{junk}] >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >> >>"
        );
        let form = stream(&format!("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Junk [{junk}]"), b"");
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                page.as_bytes(),
                &content,
                &form,
            ]),
            "",
        )
        .unwrap();
        let calls: [(&str, &dyn Fn()); 3] = [
            ("text", &|| drop(doc.text(0).unwrap())),
            ("objects", &|| drop(doc.scan(0, true, false).unwrap())),
            ("render", &|| drop(doc.render(0, 100.0, f32::INFINITY).unwrap())),
        ];
        for (call, run) in calls {
            let before = named_reads();
            run();
            let reads = named_reads() - before;
            assert!(reads <= 9, "{call}: {reads} lookups of 9 names used {USES} times each");
        }
    }

    /// Each `Do` of a form read its dictionary (resources, matrix, box, group) again, which cost
    /// more than drawing a small form. A page reads each once, however often it draws it, and two
    /// forms that use the same names for different resources still each draw their own.
    #[test]
    fn a_form_drawn_again_reads_its_dictionary_once() {
        use hayro::hayro_interpret::dictionary_reads;
        const USES: usize = 200;
        let form = |font: usize, text: &str| {
            stream(
                &format!("/Type /XObject /Subtype /Form /BBox [0 0 50 20] /Resources << /Font << /F {font} 0 R >> >>"),
                format!("BT /F 10 Tf 0 5 Td ({text}) Tj ET").as_bytes(),
            )
        };
        let content: String = (0..USES)
            .map(|i| format!("q 1 0 0 1 {} {} cm /{} Do Q\n", i % 10 * 50, i / 10 * 20, ["A", "B"][i % 2]))
            .collect();
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 400] /Contents 4 0 R \
                   /Resources << /XObject << /A 5 0 R /B 6 0 R >> >> >>",
                &stream("", content.as_bytes()),
                &form(7, "a"),
                &form(8, "b"),
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
            ]),
            "",
        )
        .unwrap();
        let before = dictionary_reads();
        let text = doc.text(0).unwrap();
        // Each form's `/Subtype`, and its dictionary.
        assert!(dictionary_reads() - before <= 4, "{} reads", dictionary_reads() - before);
        assert_eq!(text.text().matches('a').count(), USES / 2);
        assert_eq!(text.text().matches('b').count(), USES / 2);
        for c in text.chars.iter().filter(|c| c.font >= 0) {
            let font = &text.fonts[c.font as usize].name;
            assert_eq!(font.as_str(), if &*c.text == "a" { "Helvetica" } else { "Courier" });
        }
        let before = dictionary_reads();
        doc.render(0, 500.0, f32::INFINITY).unwrap();
        assert!(dictionary_reads() - before <= 4, "render: {} reads", dictionary_reads() - before);
    }

    /// An inline image naming its colour space parsed it again: 8,000 naming one of 16 KB took 1 s a
    /// call.
    #[test]
    fn inline_images_look_their_colour_space_up_once() {
        use hayro::hayro_interpret::named_reads;
        let content = stream("", &b"q 10 0 0 10 0 0 cm BI /W 1 /H 1 /BPC 8 /CS /C ID \x00 EI Q ".repeat(300));
        let page = format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /ColorSpace << /C [/Indexed /DeviceRGB 0 <000000> {}] >> >> >>",
            "0 ".repeat(2000)
        );
        let doc = Document::open(
            pdf(&[b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page.as_bytes(), &content]),
            "",
        )
        .unwrap();
        let before = named_reads();
        doc.text(0).unwrap();
        doc.render(0, 100.0, f32::INFINITY).unwrap();
        let reads = named_reads() - before;
        assert!(reads <= 2, "{reads} lookups of one colour space");
    }

    /// A node, and a page, listed many times in `/Kids`: each dictionary is built at most twice, at
    /// open and through every page's read, so a large one repeated doesn't cost its size per repeat.
    #[test]
    fn a_repeated_tree_object_is_built_at_most_twice() {
        use hayro::hayro_syntax::object::dict::dict_head_builds;
        const N: usize = 2000;
        let kids = format!("<< /Type /Pages /Count {N} /Kids [{}] >>", "3 0 R ".repeat(N));
        let junk = format!("({})", "a".repeat(4096));
        let page = "/Type /Page /MediaBox [0 0 100 100]";
        let node_repeated = pdf(&[
            b"<< /Type /Catalog /Pages 2 0 R >>",
            kids.as_bytes(),
            format!("<< /Type /Pages /Count 1 /Kids [4 0 R] /Junk {junk} >>").as_bytes(),
            format!("<< {page} >>").as_bytes(),
        ]);
        let page_repeated = pdf(&[
            b"<< /Type /Catalog /Pages 2 0 R >>",
            kids.as_bytes(),
            format!("<< {page} /Junk {junk} >>").as_bytes(),
        ]);
        for (name, file) in [("node", node_repeated), ("page", page_repeated)] {
            let before = dict_head_builds();
            let doc = Document::open(file, "").unwrap();
            assert_eq!(doc.page_count(), N, "{name}");
            for i in 0..N {
                doc.page_info(i).unwrap();
            }
            let built = dict_head_builds() - before;
            assert!(built <= 4, "{name}: {built} dictionaries built for 2 objects");
        }
    }

    /// A page's decoded content is kept while it's among the last read, so its text and then its
    /// pixels decode it once, and reading a document through holds a few pages' worth, not all.
    #[test]
    fn page_content_is_decoded_once_per_use_and_not_kept_for_every_page() {
        use hayro::hayro_syntax::page::Page;
        const N: usize = 30;
        // Half a MiB of content per page, mostly a comment: past the bytes kept, so only the last
        // few pages hold theirs.
        let content = format!("BT /F1 12 Tf 10 50 Td (Hello) Tj ET\n%{}\n", "x".repeat(512 << 10));
        let mut objects: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            format!(
                "<< /Type /Pages /Count {N} /Kids [{}] >>",
                (0..N).map(|i| format!("{} 0 R ", 4 + 2 * i)).collect::<String>()
            )
            .into_bytes(),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        ];
        for i in 0..N {
            objects.push(
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents {} 0 R \
                     /Resources << /Font << /F1 3 0 R >> >> >>",
                    5 + 2 * i
                )
                .into_bytes(),
            );
            objects.push(stream("", content.as_bytes()));
        }
        let refs: Vec<&[u8]> = objects.iter().map(Vec::as_slice).collect();
        let doc = Document::open(pdf(&refs), "").unwrap();
        let before = Page::content_decodes();
        for i in 0..N {
            assert!(doc.text(i).unwrap().text().starts_with("Hello"));
            doc.render(i, 20.0, f32::INFINITY).unwrap();
            doc.annotations(i).unwrap();
        }
        assert_eq!(Page::content_decodes() - before, N, "each page's content decoded once");
        let held = doc.0.with_dependent(|pdf, _| {
            (0..N).filter(|&i| pdf.pages().get(i).unwrap().holds_contents()).count()
        });
        assert!(held <= 4, "{held} pages of {N} still hold their content");
        // Read again, a page decodes it again.
        doc.text(0).unwrap();
        assert_eq!(Page::content_decodes() - before, N + 1);
    }

    /// The flate decoder's single call gives what reading the stream did, for whole, raw,
    /// truncated, trailing and damaged data.
    #[test]
    fn flate_decodes_as_a_reader_did() {
        use std::io::{Read, Write};
        let reference = |data: &[u8]| -> Option<Vec<u8>> {
            let mut out = Vec::new();
            if flate2::read::ZlibDecoder::new(data).read_to_end(&mut out).is_ok() {
                return Some(out);
            }
            out.clear();
            flate2::read::DeflateDecoder::new(data).read_to_end(&mut out).ok().map(|_| out)
        };
        let mut seed = 1u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut checked = 0;
        for size in [0usize, 1, 100, 4095, 4096, 70_000, 1 << 20] {
            // Text-like data, and runs that inflate far past four times their size.
            for repetitive in [false, true] {
                let plain: Vec<u8> = (0..size)
                    .map(|i| if repetitive { b'a' + (i / 5000 % 3) as u8 } else { b"abcdefgh ()TjBT"[(next() % 15) as usize] })
                    .collect();
                let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
                zlib.write_all(&plain).unwrap();
                let zlib = zlib.finish().unwrap();
                let mut raw = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                raw.write_all(&plain).unwrap();
                let raw = raw.finish().unwrap();
                let mut cases = vec![zlib.clone(), raw.clone(), [&zlib[..], b"garbage after"].concat()];
                for cut in [1, 2, 6, zlib.len() / 2, zlib.len().saturating_sub(4)] {
                    cases.push(zlib[..cut.min(zlib.len())].to_vec());
                }
                for _ in 0..8 {
                    let mut damaged = zlib.clone();
                    let at = (next() as usize) % damaged.len();
                    damaged[at] ^= 1 << (next() % 8);
                    cases.push(damaged);
                }
                for case in cases {
                    let ours = hayro::hayro_syntax::flate_decode(&case);
                    match reference(&case) {
                        Some(expected) => assert_eq!(ours.as_deref(), Some(&expected[..]), "{size}"),
                        // The reader gave up; the stream then tried the fallback decoder, as it does.
                        None => {}
                    }
                    checked += 1;
                }
            }
        }
        assert!(checked > 200);
    }

    /// One 200x200 page: a filled-and-stroked rect, `Tr 2` text, a `sh`, an
    /// image, a line; a stamp, a note and a choice widget.
    fn synthetic() -> Document {
        let content = b"q 1 0 0 rg 2 w 10 10 50 20 re B Q \
            BT /F1 12 Tf 2 Tr 0 0 1 rg 20 100 Td (Hi) Tj ET \
            /Sh sh \
            q 30 0 0 20 100 150 cm /Im Do Q \
            10 180 m 50 180 l S";
        let stamp_ap = b"q /Fm Do Q BT /F1 10 Tf 2 2 Td (APPROVED) Tj ET 0 0 m 5 5 l S";
        let nested = b"BT /F1 10 Tf 0 0 Td (HIDDEN) Tj ET";
        let page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R \
            /Resources << /Font << /F1 3 0 R >> /XObject << /Im 5 0 R >> \
            /Shading << /Sh << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] \
            /Function << /FunctionType 2 /Domain [0 1] /C0 [0 0 0] /C1 [1 1 1] /N 1 >> >> >> >> \
            /Annots [6 0 R 9 0 R 10 0 R] >>";
        let ap = stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 60 20] \
             /Resources << /Font << /F1 3 0 R >> /XObject << /Fm 8 0 R >> >>",
            stamp_ap,
        );
        let fm = stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 60 20] /Resources << /Font << /F1 3 0 R >> >>",
            nested,
        );
        Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [7 0 R] /Count 1 >>",
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                &stream("", content),
                &stream(
                    "/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
                    b"\x00\xff",
                ),
                b"<< /Type /Annot /Subtype /Stamp /Rect [100 20 160 40] /AP << /N 11 0 R >> >>",
                page.as_bytes(),
                &fm,
                b"<< /Type /Annot /Subtype /Text /Rect [10 10 20 20] /Contents <FEFF00E9> >>",
                b"<< /Type /Annot /Subtype /Widget /Rect [0 0 10 10] /Parent 12 0 R >>",
                &ap,
                b"<< /FT /Ch /V [(a) (b)] /Kids [10 0 R] >>",
            ]),
            "",
        )
        .unwrap()
    }

    #[test]
    fn text_only_interpreter_reads_text_as_the_full_one_does() {
        // `text` runs hayro-interpret's text-only interpreter, `scan` with
        // objects the full one; both must hand the device the same runs.
        let content: &[u8] = b"% a comment (with a paren\n\
            /Span<</ActualText<feff0009>/Alt (a\\)b)>> BDC EMC \
            q 1 0 0 1 5 5 cm 0.5 g BT /F1 12 Tf 20 150 Td (plain) Tj \
            [(A) -250 <4243> 120.5 (D\\(E\\)\\101) ( \\n )] TJ \
            14 TL T* (next) ' 2 1 (quoted) \" 110 Tz 1 Tc 2 Tw 3 Ts (spaced out) Tj \
            /Missing 9 Tf (fallback) Tj 0 1 0 rg /F1 10 Tf 1 0 0 1 30 60 Tm \
            [(set) 1 [(nested)] /N (after)] TJ 3 Tr (invisible) Tj 0 Tr \
            5 -12 TD (td) Tj ET Q \
            BI /W 2 /H 1 /BPC 8 /CS /G ID \x00EI\x01 EI \
            2x 1 true BT /F1 8 Tf 10 20 Td (after image) Tj ET \
            q 2 0 0 2 0 0 cm /Fm Do /Im Do Q \
            /DeviceRGB cs 0 0 1 sc BT /F1 7 Tf 50 10 Td (blue) Tj ET \
            1 m BT /F1 7 Tf (after a bad path) Tj ET";
        let form: &[u8] = b"BT /F1 6 Tf 1 1 Td (in form) Tj ET \
            /P <</Alt (a)b\\)>> BDC BT /F1 6 Tf (after a bad dict) Tj ET";
        let page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R \
            /Resources << /Font << /F1 3 0 R >> /XObject << /Fm 5 0 R /Im 6 0 R >> >> >>";
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [7 0 R] /Count 1 >>",
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                &stream("", content),
                &stream(
                    "/Type /XObject /Subtype /Form /BBox [0 0 100 100] \
                     /Resources << /Font << /F1 3 0 R >> >>",
                    form,
                ),
                &stream(
                    "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
                    b"\x00",
                ),
                page.as_bytes(),
            ]),
            "",
        )
        .unwrap();
        let rows = |t: &TextPage| -> Vec<String> {
            t.chars
                .iter()
                .map(|c| {
                    format!(
                        "{:?} {} {} {} {} {} {:?} {} {}",
                        &*c.text, c.code, c.flags, c.fill, c.font, c.run, c.bbox, c.em, c.angle
                    )
                })
                .collect()
        };
        let fast = doc.text(0).unwrap();
        let full = doc.scan(0, true, false).unwrap().text;
        let text: String = fast.chars.iter().map(|c| &*c.text).collect();
        for shown in [
            "plain", "BCD(E)A", "quoted", "fallback", "setafter", "in form", "blue",
        ] {
            assert!(text.contains(shown), "{shown:?} missing from {text:?}");
        }
        // A malformed path operator or an unreadable dict ends the stream, as
        // in hayro.
        assert!(
            !text.contains("bad path") && !text.contains("bad dict"),
            "{text:?}"
        );
        assert_eq!(rows(&fast), rows(&full));
        assert_eq!(fast.words.len(), full.words.len());
    }

    #[test]
    fn text_only_interpreter_matches_the_full_one_on_random_streams() {
        // Random streams from text, state, path, colour, marked-content and
        // form operators, with operands of every kind (and malformed ones):
        // `text` (text-only) and `scan` with objects (full) must agree.
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut rand = move |n: usize| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % n as u64) as usize
        };
        // Each operator with well-formed operands; 15% of the time random
        // ones instead, and rarely one that ends the stream.
        const OPS: &[(&str, &str)] = &[
            ("Tj", "(Hi there)"),
            ("Tj", "(a\\)b\\101\\12c)"),
            ("Tj", "(x\ny\r\nz)"),
            ("Tj", "<48 69>"),
            ("TJ", "[(A) -120 (B) 300 <4344>]"),
            ("TJ", "[(D) [1] /N (E)]"),
            ("'", "(quote)"),
            ("\"", "2 1 (dq)"),
            ("Tf", "/F1 9"),
            ("Tf", "/F2 14"),
            ("Tf", "/F#31 8"),
            ("Tf", "/Missing 7"),
            ("Td", "5 -12"),
            ("TD", "0 -14"),
            ("Tm", "1 0 0 1 20 150"),
            ("Tm", "0 1 -1 0 100 50"),
            ("T*", ""),
            ("Tc", "0.5"),
            ("Tw", "2"),
            ("Tz", "80"),
            ("TL", "11"),
            ("Ts", "3"),
            ("Tr", "1"),
            ("Tr", "3"),
            ("Tr", "7"),
            ("Tr", "0"),
            ("BT", ""),
            ("ET", ""),
            ("q", ""),
            ("Q", ""),
            ("cm", "1 0 0 1 3 4"),
            ("g", "0.5"),
            ("rg", "1 0 0"),
            ("k", "0 0 0 1"),
            ("G", "0"),
            ("RG", "0 0 1"),
            ("cs", "/DeviceRGB"),
            ("cs", "/Cs1"),
            ("sc", "0 1 0"),
            ("scn", "0 0 1"),
            ("SC", "1"),
            ("gs", "/GS1"),
            ("BDC", "/P <</MCID 1>>"),
            ("BDC", "/Span <</ActualText<feff0041>>>"),
            ("BDC", "/P /P"),
            ("BMC", "/X"),
            ("EMC", ""),
            ("MP", "/X"),
            ("DP", "/X <</A 1>>"),
            ("Do", "/Fm"),
            ("Do", "/Im"),
            ("m", "1 2"),
            ("l", "3 4"),
            ("c", "1 2 3 4 5 6"),
            ("v", "1 2 3 4"),
            ("re", "0 0 5 5"),
            ("h", ""),
            ("f", ""),
            ("S", ""),
            ("W", ""),
            ("n", ""),
            ("sh", "/Sh"),
            ("d", "[3 2] 0"),
            ("w", "2"),
            ("BI", "/W 1 /H 1 /BPC 8 /CS /G ID \x00 EI"),
            ("%", "comment\n"),
        ];
        const ODD: &[&str] = &[
            "1",
            "-2.5",
            ".5",
            "2x",
            "-",
            "+.",
            "1e3",
            "/F1",
            "/P",
            "(s)",
            "<41>",
            "[(A) 1]",
            "<</MCID 3>>",
            "true",
            "null",
            "%c\n",
        ];
        const ENDS: &[&str] = &[
            ")",
            "]",
            "{",
            "<4g>",
            "<</A (a)b\\)>>",
            "[1 (x) a]",
            "/F#zz",
        ];
        let mut stream_of = |len: usize| {
            let mut s = String::from("BT /F1 10 Tf 10 100 Td ");
            for _ in 0..len {
                let (op, operands) = OPS[rand(OPS.len())];
                if rand(7) == 0 {
                    for _ in 0..rand(4) {
                        s.push_str(if rand(40) == 0 {
                            ENDS[rand(ENDS.len())]
                        } else {
                            ODD[rand(ODD.len())]
                        });
                        s.push(' ');
                    }
                } else {
                    s.push_str(operands);
                    s.push(' ');
                }
                s.push_str(op);
                s.push(if rand(3) == 0 { '\n' } else { ' ' });
            }
            s
        };
        let mut chars = 0;
        for _ in 0..2000 {
            let (content, form) = (stream_of(40), stream_of(10));
            let page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R \
                /Resources << /Font << /F1 3 0 R /F2 3 0 R >> /XObject << /Fm 5 0 R /Im 6 0 R >> \
                /ExtGState << /GS1 << /ca 0.5 /Font [3 0 R 8] >> >> \
                /ColorSpace << /Cs1 /DeviceRGB >> /Properties << /P << /MCID 2 >> >> >> >>";
            let doc = Document::open(
                pdf(&[
                    b"<< /Type /Catalog /Pages 2 0 R >>",
                    b"<< /Type /Pages /Kids [7 0 R] /Count 1 >>",
                    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                    &stream("", content.as_bytes()),
                    &stream(
                        "/Type /XObject /Subtype /Form /BBox [0 0 100 100] \
                         /Resources << /Font << /F1 3 0 R >> >>",
                        form.as_bytes(),
                    ),
                    &stream(
                        "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
                        b"\x00",
                    ),
                    page.as_bytes(),
                ]),
                "",
            )
            .unwrap();
            let rows = |t: &TextPage| -> Vec<String> {
                t.chars
                    .iter()
                    .map(|c| {
                        format!(
                            "{:?} {} {} {} {} {} {:?} {} {}",
                            &*c.text, c.code, c.flags, c.fill, c.font, c.run, c.bbox, c.em, c.angle
                        )
                    })
                    .collect()
            };
            let fast = doc.text(0).unwrap();
            let full = doc.scan(0, true, false).unwrap().text;
            assert_eq!(rows(&fast), rows(&full), "page {content:?}\nform {form:?}");
            chars += fast.chars.len();
        }
        // Most streams show text (a generator that ends them early proves nothing).
        assert!(chars > 10_000, "{chars} chars");
    }

    #[test]
    fn render_draws_paths_and_text_alike() {
        // The red `B` rect (10,10 50x20 in PDF space, y up from 200) is
        // painted: rendering runs the full interpreter, not the text-only one.
        let b = synthetic().render(0, 200.0, 200.0).unwrap();
        let px = |x: usize, y: usize| {
            let i = (y * b.width as usize + x) * 4;
            [b.rgba[i], b.rgba[i + 1], b.rgba[i + 2]]
        };
        assert_eq!(px(30, 180), [255, 0, 0]);
    }

    #[test]
    fn a_pattern_fill_is_a_path_even_when_its_matrix_is_the_ctm() {
        // An `scn` shading pattern with an identity matrix at the identity
        // CTM fills an `re`: a path, not `sh`.
        let content = b"/Pattern cs /P0 scn 90 140 100 27 re f*";
        let page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 3 0 R \
            /Resources << /Pattern << /P0 << /PatternType 2 /Shading << /ShadingType 2 \
            /ColorSpace /DeviceRGB /Coords [0 0 1 0] /Function << /FunctionType 2 \
            /Domain [0 1] /C0 [0 0 0] /C1 [1 1 1] /N 1 >> >> >> >> >> >>";
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
                &stream("", content),
                page.as_bytes(),
            ]),
            "",
        )
        .unwrap();
        let o = doc.scan(0, true, false).unwrap().objects;
        assert_eq!(o.path_flags, [PATH_FILL]);
        assert_eq!(o.kinds[0], SEGMENT_MOVE | crate::device::SEGMENT_RECT);
    }

    #[test]
    fn synthetic_page_objects() {
        let scan = synthetic().scan(0, true, true).unwrap();
        let o = &scan.objects;
        // One text object: `Tr 2` draws the run twice, it is one object.
        assert_eq!(o.text_objects, 1);
        // `B` is one path, filled and stroked; `sh` is not a path.
        assert_eq!(o.path_flags, [PATH_FILL | PATH_STROKE, PATH_STROKE]);
        assert_eq!(o.path_start, [0, 5, 7]);
        // The rect, 2pt line, in the viewer frame (y down from 200).
        assert_eq!(&o.path_boxes[..4], &[8.0, 168.0, 54.0, 24.0]);
        assert_eq!(&o.kinds[5..], &[SEGMENT_MOVE, SEGMENT_LINE]);
        assert_eq!(&o.points[10..], &[10.0, 20.0, 50.0, 20.0]);
        assert_eq!(o.image_boxes, [100.0, 30.0, 30.0, 20.0]);
        assert_eq!(o.image_pixels, [2, 1]);

        let t = &scan.text;
        assert_eq!(t.text(), "Hi");
        assert_eq!(t.runs.len(), 1);
        assert_eq!(t.runs[0].origin, [20.0, 100.0]);
        assert_eq!(t.runs[0].em, 12.0);
        let h = &t.chars[0];
        assert_eq!(
            (h.fill, h.font, h.run, h.em, h.angle),
            (0x0000_ffff, 0, 0, 12.0, 0.0)
        );
        assert_eq!(
            t.fonts,
            [Font {
                name: "Helvetica".into(),
                flags: 32,
                weight: 400,
                embedded: false,
                ascent: 0.8,
                descent: -0.2,
            }]
        );
    }

    #[test]
    fn synthetic_annotations() {
        let a = synthetic().scan(0, false, true).unwrap().annotations;
        assert_eq!(a.len(), 3);
        // The stamp: the nested form is one object and its text is not read.
        assert_eq!(a[0].subtype, 13);
        assert_eq!(a[0].bbox, [100.0, 160.0, 60.0, 20.0]);
        assert_eq!(
            (a[0].appearance_objects, a[0].appearance_text_objects),
            (3, 1)
        );
        assert_eq!(a[0].appearance_text, "APPROVED");
        assert_eq!(a[0].field, None);
        assert_eq!((a[1].subtype, a[1].contents.as_str()), (1, "é"));
        // A multi-select choice's /V array, inherited from /Parent, reads "".
        assert_eq!(
            a[2].field,
            Some(Field {
                kind: "Ch".into(),
                value: String::new()
            })
        );
    }

    /// Text and drawing share a document's embedded font programs, so whichever reads a page first,
    /// the other gives what it gives on a document of its own.
    #[test]
    fn text_and_render_read_the_same_whichever_goes_first() {
        let text = |t: TextPage| {
            let chars: Vec<_> = t.chars.iter().map(|c| (c.code, c.bbox, c.em, c.font, c.flags)).collect();
            let fonts: Vec<_> = t.fonts.iter().map(|f| (f.name.clone(), f.embedded, f.ascent, f.descent)).collect();
            (t.text(), chars, fonts, t.truncated)
        };
        for name in ["chrome-mixed-rtl.pdf", "cjk-embedded.pdf", "linearized.pdf"] {
            let path = format!("{}/../../js/test/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
            let bytes = std::fs::read(path).unwrap();
            let open = || Document::open(bytes.clone(), "").unwrap();
            let pixels = |d: &Document| d.render(0, 400.0, f32::INFINITY).unwrap().rgba;
            let (alone_text, alone_pixels) = (text(open().text(0).unwrap()), pixels(&open()));
            assert!(!alone_text.0.trim().is_empty(), "{name}");
            let drawn_first = open();
            assert!(pixels(&drawn_first) == alone_pixels, "{name}: drawn first");
            assert!(text(drawn_first.text(0).unwrap()) == alone_text, "{name}: text after drawing");
            let read_first = open();
            assert!(text(read_first.text(0).unwrap()) == alone_text, "{name}: read first");
            assert!(pixels(&read_first) == alone_pixels, "{name}: drawn after text");
        }
    }

    /// Reading text decodes a font's embedded program only for what the font's dictionary leaves
    /// out; drawing decodes every one. Here the dictionary names the codes (WinAnsi), their widths
    /// and the weight, so text alone decodes nothing, until the weight is left to the program.
    #[test]
    fn text_decodes_a_font_program_only_for_what_its_dictionary_leaves_out() {
        let open = |weight: &str| {
            let font = format!(
                "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Probe /FirstChar 72 /LastChar 105 \
                 /Widths [{}] /Encoding /WinAnsiEncoding /FontDescriptor 6 0 R >>",
                "600 ".repeat(34)
            );
            let descriptor = format!(
                "<< /Type /FontDescriptor /FontName /ABCDEF+Probe /Flags 32 {weight} /Ascent 800 /Descent -200 \
                 /FontFile2 7 0 R >>"
            );
            Document::open(
                pdf(&[
                    b"<< /Type /Catalog /Pages 2 0 R >>",
                    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
                    &stream("", b"BT /F1 10 Tf 10 10 Td (Hi) Tj ET"),
                    font.as_bytes(),
                    descriptor.as_bytes(),
                    &stream("", include_bytes!("notdef.ttf")),
                ]),
                "",
            )
            .unwrap()
        };
        let decoded = |d: &Document| d.with_page(0, |_, _, c| c.text.embedded_font_programs_decoded()).unwrap();
        let text = |d: &Document| {
            let t = d.text(0).unwrap();
            let chars: Vec<_> = t.chars.iter().map(|c| (c.code, c.bbox, c.em, c.font, c.flags)).collect();
            (t.text(), chars, t.fonts, t.truncated)
        };

        let doc = open("/FontWeight 400");
        let alone = text(&doc);
        assert_eq!(alone.0, "Hi");
        assert_eq!((alone.2[0].weight, alone.2[0].embedded), (400, true));
        assert_eq!(decoded(&doc), 0, "text alone decodes no program");
        doc.render(0, 100.0, f32::INFINITY).unwrap();
        assert_eq!(decoded(&doc), 1, "drawing decodes it");
        assert!(text(&doc) == alone, "and the text is the same");
        let drawn_first = open("/FontWeight 400");
        drawn_first.render(0, 100.0, f32::INFINITY).unwrap();
        assert!(text(&drawn_first) == alone, "text after drawing");

        // Without `FontWeight` the weight is the program's (its OS/2 table), so text loads it.
        let doc = open("");
        assert_eq!(text(&doc).0, "Hi");
        assert_eq!(decoded(&doc), 1);
    }

    /// The linearized fixture, whose text and geometry were written by hand.
    #[test]
    fn linearized_fixture() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../js/test/fixtures/linearized.pdf"
        );
        let doc = Document::open(std::fs::read(path).unwrap(), "").unwrap();
        let scan = doc.scan(0, true, true).unwrap();
        assert_eq!(scan.objects.text_objects, 30);
        assert_eq!(scan.objects.path_count(), 0);
        assert_eq!(scan.text.runs.len(), 30);
        assert_eq!(scan.text.runs[0].origin, [40.0, 52.0]);
        let c = &scan.text.chars[0];
        assert_eq!((c.fill, c.em, c.angle, c.font), (0xff, 11.0, 0.0, 0));
        assert_eq!(
            scan.annotations,
            [Annotation {
                subtype: 20,
                bbox: [39.5, 707.5, 301.0, 25.0],
                contents: String::new(),
                field: Some(Field {
                    kind: "Tx".into(),
                    value: "Filled value".into()
                }),
                appearance_objects: 2,
                appearance_text_objects: 1,
                appearance_text: "Filled value".into(),
            }]
        );
        // Page 2 is turned 90°: boxes and origins in the viewer frame, the
        // angle in page space. Lines are in content order, so the last line's
        // run is the last run.
        let turned = doc.text(1).unwrap();
        assert_eq!(turned.runs.len(), 30);
        assert_eq!(turned.runs[29].origin, [160.0, 40.0]);
        let last_line = turned.chars.iter().rev().find(|c| c.run == 29).unwrap();
        assert_eq!(last_line.angle, 0.0);
        let first = turned.chars.iter().find(|c| c.run == 29).unwrap().bbox;
        // The box spans a fixed 0.8/-0.2 em, not Helvetica's real ascent and
        // descent.
        assert!(
            (first[0] - 157.536).abs() < 0.5 && first[1] == 40.0,
            "{first:?}"
        );
    }

    /// An image drawn at under twice its size is smoothed, as pdfium, pdf.js and poppler smooth it;
    /// one drawn much larger keeps sharp pixels, as pdfium and pdf.js keep them.
    #[test]
    fn a_slightly_enlarged_image_is_smoothed() {
        // A 20x20 checkerboard of black and white pixels, drawn at `side` points on a 100 pt page.
        let checker: Vec<u8> = (0..400).map(|i| if (i % 20 + i / 20) % 2 == 0 { 0 } else { 255 }).collect();
        let grey_share = |side: u32| {
            let content = format!("q {side} 0 0 {side} 0 0 cm /Im Do Q");
            let doc = Document::open(
                pdf(&[
                    b"<< /Type /Catalog /Pages 2 0 R >>",
                    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R \
                       /Resources << /XObject << /Im 5 0 R >> >> >>",
                    &stream("", content.as_bytes()),
                    &stream(
                        "/Type /XObject /Subtype /Image /Width 20 /Height 20 /ColorSpace /DeviceGray /BitsPerComponent 8",
                        &checker,
                    ),
                ]),
                "",
            )
            .unwrap();
            let bitmap = doc.render(0, 100.0, f32::INFINITY).unwrap();
            let inside = (side as usize).min(bitmap.width as usize) - 1;
            let mut grey = 0;
            for y in 0..inside {
                for x in 0..inside {
                    let v = bitmap.rgba[((bitmap.height as usize - 1 - y) * bitmap.width as usize + x) * 4];
                    if (16..240).contains(&v) {
                        grey += 1;
                    }
                }
            }
            grey as f64 / (inside * inside) as f64
        };
        // 1.5 device pixels to an image pixel: most pixels blend two image pixels.
        assert!(grey_share(30) > 0.3, "{}", grey_share(30));
        // 4.5: blocks of black and white.
        assert!(grey_share(90) < 0.05, "{}", grey_share(90));
    }

    /// A luminosity soft mask weighs red, green and blue 0.30, 0.59 and 0.11, as the spec, pdfium,
    /// pdf.js and poppler do: pure red masks black to 30% over white.
    #[test]
    fn a_luminosity_mask_weighs_colours_as_pdf_does() {
        let shade = |rgb: &str| {
            let mask_group = format!("{rgb} rg 0 0 100 100 re f");
            let doc = Document::open(
                pdf(&[
                    b"<< /Type /Catalog /Pages 2 0 R >>",
                    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R \
                       /Resources << /ExtGState << /M << /SMask << /S /Luminosity /G 5 0 R >> >> >> >> >>",
                    &stream("", b"/M gs 0 g 0 0 100 100 re f"),
                    &stream(
                        "/Type /XObject /Subtype /Form /BBox [0 0 100 100] \
                         /Group << /S /Transparency /CS /DeviceRGB >>",
                        mask_group.as_bytes(),
                    ),
                ]),
                "",
            )
            .unwrap();
            let bitmap = doc.render(0, 100.0, f32::INFINITY).unwrap();
            bitmap.rgba[(50 * bitmap.width as usize + 50) * 4]
        };
        for (rgb, weight) in [("1 0 0", 0.30), ("0 1 0", 0.59), ("0 0 1", 0.11)] {
            let expected = 255.0 * (1.0 - weight);
            let got = f64::from(shade(rgb));
            assert!((got - expected).abs() <= 2.0, "{rgb}: {got}, not {expected}");
        }
    }

    /// A hairline in a tiling pattern is at least a pixel wide, as everywhere else on the page and
    /// as pdfium and pdf.js draw it: a 0.1 pt hatch was a faint grey.
    #[test]
    fn a_thin_line_in_a_pattern_is_a_pixel_wide() {
        let doc = Document::open(
            pdf(&[
                b"<< /Type /Catalog /Pages 2 0 R >>",
                b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R \
                   /Resources << /Pattern << /P 5 0 R >> >> >>",
                &stream("", b"/Pattern cs /P scn 0 0 100 100 re f"),
                &stream(
                    "/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 5 5] /XStep 5 /YStep 5 /Resources << >>",
                    b"0.1 w 0 G 2.5 0 m 2.5 5 l S",
                ),
            ]),
            "",
        )
        .unwrap();
        let bitmap = doc.render(0, 100.0, f32::INFINITY).unwrap();
        // Ink across one row of the page, in pixels' worth of black: 20 lines.
        let row = 50 * bitmap.width as usize * 4;
        let ink: f64 = (0..bitmap.width as usize)
            .map(|x| f64::from(255 - bitmap.rgba[row + x * 4]) / 255.0)
            .sum();
        assert!(ink > 15.0, "{ink} pixels of ink for 20 lines");
    }

    /// A bitmap asked for `width` pixels across is that wide, whatever float error the page's own
    /// width brings: 800 across a 612 pt page was 801.
    #[test]
    fn a_render_is_as_wide_as_asked() {
        let mut wrong = Vec::new();
        for page in [612.0_f32, 595.0, 595.276, 841.89, 792.0, 419.53, 1224.0, 100.0, 3.0, 14400.0] {
            for width in (1..=4096).map(|w| w as f32) {
                let scale = render_scale(page, page, width, f32::INFINITY).unwrap();
                if pixel_side(page * scale) != width {
                    wrong.push((page, width));
                }
            }
        }
        assert!(wrong.is_empty(), "{} sizes off, such as {:?}", wrong.len(), &wrong[..wrong.len().min(5)]);
        // A side that isn't whole still rounds up.
        assert_eq!(pixel_side(100.4), 101.0);
        assert_eq!(pixel_side(0.2), 1.0);
    }

    /// Word's nested even-odd clips, a rectangle with a hole each: when the rectangle is the first
    /// subpath and covers the current clip, it's drawn as one far larger (`widen_covering_rect` in
    /// hayro-interpret), and the page must come out as it does with the same clips listing the hole
    /// first, which are left as they are. With the rectangle on whole pixels, nothing may differ;
    /// with a clip around it that it doesn't cover, the rectangle must still cut.
    #[test]
    fn a_covering_rectangle_in_an_even_odd_clip_draws_the_same_widened() {
        let holes: Vec<String> = (0..24)
            .map(|i| {
                let (x, y) = (12.3 + 3.1 * i as f64, 14.5 + 2.9 * i as f64);
                format!("{x} {y} m {} {y} l {} {} l {x} {} l h", x + 6.25, x + 6.25, y + 5.5, y + 5.5)
            })
            .collect();
        let render = |outer: &str, rect_first: bool| {
            let rect = "10 10 m 90 10 l 90 90 l 10 90 l 10 10 l h";
            let mut content = format!("q {outer} re W n ");
            for hole in &holes {
                let path = if rect_first { format!("{rect} {hole}") } else { format!("{hole} {rect}") };
                content += &format!("{path} W* n ");
            }
            content += "1 0 0 rg 0 0 100 100 re f Q";
            let doc = Document::open(
                pdf(&[
                    b"<< /Type /Catalog /Pages 2 0 R >>",
                    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
                    &stream("", content.as_bytes()),
                ]),
                "",
            )
            .unwrap();
            doc.render(0, 100.0, f32::INFINITY).unwrap()
        };
        let px = |b: &Bitmap, x: usize, y: usize| b.rgba[(y * b.width as usize + x) * 4..][..4].to_vec();
        for outer in ["10 10 80 80", "5 5 90 90"] {
            let widened = render(outer, true);
            let kept = render(outer, false);
            assert_eq!(widened.rgba, kept.rgba, "clip {outer}");
            assert_eq!(px(&widened, 30, 20), [255, 0, 0, 255], "red between the holes");
            assert_eq!(px(&widened, 15, 82), [255, 255, 255, 255], "white in the first hole");
            assert_eq!(px(&widened, 7, 50), [255, 255, 255, 255], "white outside the rectangle");
        }
    }
}
