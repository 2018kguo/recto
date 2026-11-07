//! A PDF engine. hayro parses, interprets and rasterizes; the text layer
//! (char boxes, generated spaces, line breaks, words) is this crate's.
//!
//! Coordinates are PDF points in the viewer frame, a
//! top-left origin, with `/Rotate` and the crop box applied. Char boxes are
//! loose font boxes (advance × em), not glyph ink.

mod annots;
mod outline;
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
#[cfg(feature = "render")]
use hayro::vello_cpu::color::palette::css::WHITE;
#[cfg(feature = "render")]
use hayro::{PixmapSettings, RenderCache, RenderSettings, render};

pub use annots::{Annotation, Field};
pub use ctext::Text;
pub use device::{
    PATH_FILL, PATH_STROKE, PageObjects, SEGMENT_BEZIER, SEGMENT_CLOSE, SEGMENT_LINE, SEGMENT_MOVE,
};
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

/// A page's text, objects and annotations from one load.
pub struct Scan {
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
}

/// Font, CMap and glyph caches shared by every page of one document, so a
/// font is parsed once per document rather than once per page.
/// Limit: unbounded for the document's life.
struct Caches<'a> {
    text: InterpreterCache<'a>,
    #[cfg(feature = "render")]
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

/// `min(width / pageWidth, maxHeight / pageHeight)`, shrunk to fit the
/// render limits. `max_height` may be infinite ("fit to width").
fn render_scale(page_w: f32, page_h: f32, width: f32, max_height: f32) -> Result<f32, EngineError> {
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
    Ok((width / page_w)
        .min(max_height / page_h)
        .min(MAX_RENDER_SIDE / page_w)
        .min(MAX_RENDER_SIDE / page_h)
        .min((MAX_RENDER_PIXELS / (page_w * page_h)).sqrt()))
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
                Self(Inner::new(pdf, |_| Caches {
                    text: InterpreterCache::new(),
                    #[cfg(feature = "render")]
                    render: RenderCache::new(),
                    glyphs: Default::default(),
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
        self.page(index)?;
        Ok(self.0.with_dependent(|pdf, caches| {
            let Some(page) = pdf.pages().get(index) else {
                unreachable!("self.page(index) found it")
            };
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
            let mut text = text::build_page(&device.glyphs, &device.fonts, &device.runs);
            text.truncated = device.text_truncated;
            device.glyphs.clear();
            caches.glyphs.replace(device.glyphs);
            Scan {
                text,
                objects: device.objects.unwrap_or_default(),
                annotations: if annotations {
                    annots::read(page, &caches.text, viewer)
                } else {
                    Vec::new()
                },
            }
        }))
    }

    /// The file as it was opened, in place.
    pub fn file_bytes(&self) -> &[u8] {
        self.0.borrow_owner().data().as_ref()
    }

    /// The document's outline, in order; each item's children follow it, one level deeper.
    pub fn outline(&self) -> Vec<outline::OutlineItem> {
        self.0.with_dependent(|pdf, _| outline::read(pdf))
    }

    /// The page's annotations alone, without interpreting its content.
    pub fn annotations(&self, index: usize) -> Result<Vec<Annotation>, EngineError> {
        self.page(index)?;
        Ok(self.0.with_dependent(|pdf, caches| {
            let Some(page) = pdf.pages().get(index) else {
                unreachable!("self.page(index) found it")
            };
            annots::read(page, &caches.text, page.initial_transform(true).to_kurbo())
        }))
    }

    #[cfg(feature = "render")]
    fn pixmap_settings(
        &self,
        index: usize,
        width: f32,
        max_height: f32,
    ) -> Result<PixmapSettings, EngineError> {
        let info = self.page_info(index)?;
        let scale = render_scale(info.width, info.height, width, max_height)?;
        // Each side rounds up, and the page stretches to
        // fill that bitmap (under a pixel). hayro floors `side * scale`, so
        // step the exact scale up by one ULP when float error would lose a pixel.
        let fit = |page: f32| {
            let side = (page * scale).ceil().clamp(1.0, MAX_RENDER_SIDE);
            let exact = side / page;
            if (page * exact) as u16 >= side as u16 {
                exact
            } else {
                exact.next_up()
            }
        };
        Ok(PixmapSettings {
            x_scale: fit(info.width),
            y_scale: fit(info.height),
            bg_color: WHITE,
        })
    }

    #[cfg(feature = "render")]
    fn pixmap(
        &self,
        index: usize,
        width: f32,
        max_height: f32,
    ) -> Result<(hayro::vello_cpu::Pixmap, bool), EngineError> {
        let settings = self.pixmap_settings(index, width, max_height)?;
        Ok(self.0.with_dependent(|pdf, caches| {
            let Some(page) = pdf.pages().get(index) else {
                unreachable!("self.page(index) found it")
            };
            let pixmap = render(
                page,
                &caches.render,
                &crate::assets::settings(),
                &RenderSettings::default(),
                &settings,
            );
            (pixmap, caches.render.take_degraded())
        }))
    }

    /// Scale is `min(width / pageWidth, maxHeight / pageHeight)`.
    #[cfg(feature = "render")]
    pub fn render(&self, index: usize, width: f32, max_height: f32) -> Result<Bitmap, EngineError> {
        let (pixmap, truncated) = self.pixmap(index, width, max_height)?;
        Ok(bitmap_of(pixmap, truncated))
    }
}

/// A page being drawn a slice at a time, the same pixels as `Document::render`.
#[cfg(feature = "render")]
pub struct RenderTask {
    // Before the document it borrows from, so it's dropped first.
    job: hayro::PageJob<'static, 'static>,
    _document: std::rc::Rc<Document>,
}

#[cfg(feature = "render")]
impl RenderTask {
    pub fn new(
        document: std::rc::Rc<Document>,
        index: usize,
        width: f32,
        max_height: f32,
    ) -> Result<Self, EngineError> {
        let settings = document.pixmap_settings(index, width, max_height)?;
        let job = document.0.with_dependent(|pdf, caches| {
            let Some(page) = pdf.pages().get(index) else {
                unreachable!("pixmap_settings found it")
            };
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
        });
        Ok(Self {
            job,
            _document: document,
        })
    }

    /// Runs until `expired` says so; true once the page's content is done.
    pub fn step(&mut self, expired: &dyn Fn() -> bool) -> bool {
        self.job.step(expired)
    }

    /// Rasterizes what `step` drew. One call, after `step` returned true.
    pub fn finish(&mut self) -> Bitmap {
        let (pixmap, truncated) = self.job.finish();
        bitmap_of(pixmap, truncated)
    }
}

/// The pixmap's own buffer, with no second page-sized allocation at the render's peak.
#[cfg(feature = "render")]
fn bitmap_of(pixmap: hayro::vello_cpu::Pixmap, truncated: bool) -> Bitmap {
    Bitmap {
        width: u32::from(pixmap.width()),
        height: u32::from(pixmap.height()),
        rgba: pixmap.take_rgba8(hayro::vello_cpu::peniko::ImageAlphaType::AlphaPremultiplied),
        truncated,
    }
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
}
