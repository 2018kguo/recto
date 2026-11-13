//! One interpretation pass per page: glyphs for the text layer, plus (when
//! asked) the page's paths, images and text-object count.

use hayro::hayro_interpret::font::{Glyph as HayroGlyph, GlyphRun, OutlineGlyph, Type3Glyph};
use hayro::hayro_interpret::hayro_cmap::{BfString, WritingMode};
use hayro::hayro_interpret::{
    BlendMode, CacheKey, ClipPath, Device, DrawMode, DrawProps, Image, ImageDrawProps, Paint,
    SoftMask,
};
use hayro::kurbo::{Affine, BezPath, PathEl, Point, Rect};

use crate::ctext::Text;
use crate::text::{Font, Glyph, Run, glyph_from};

/// `PageObjects::path_flags` bits.
pub const PATH_FILL: u8 = 1;
pub const PATH_STROKE: u8 = 2;
/// `PageObjects::kinds`: the segment type in the low bits.
pub const SEGMENT_LINE: u8 = 0;
pub const SEGMENT_BEZIER: u8 = 1;
pub const SEGMENT_MOVE: u8 = 2;
/// `PageObjects::kinds` bit: the segment closes its subpath.
pub const SEGMENT_CLOSE: u8 = 4;
/// `PageObjects::kinds` bit on a move: its subpath is a rectangle `re` drew
/// (pdf.js counts only those as rectangles).
pub const SEGMENT_RECT: u8 = 8;

/// A page's images and paths as columns, every box and point in the viewer
/// frame. Form XObjects are
/// flattened.
#[derive(Default, Debug)]
pub struct PageObjects {
    /// One per text-showing operator (Tj, TJ, ', ").
    pub text_objects: u32,
    /// More images or path segments than one page may collect; the rest aren't here.
    pub truncated: bool,
    /// x, y, width, height per image.
    pub image_boxes: Vec<f32>,
    /// Pixel width, height per image.
    pub image_pixels: Vec<u32>,
    /// x, y, width, height per path.
    pub path_boxes: Vec<f32>,
    /// PATH_FILL | PATH_STROKE per path.
    pub path_flags: Vec<u8>,
    /// count + 1 offsets into `points`/`kinds` (pairs into `points`).
    pub path_start: Vec<u32>,
    /// x, y per segment end point.
    pub points: Vec<f32>,
    pub kinds: Vec<u8>,
}

impl PageObjects {
    pub fn path_count(&self) -> usize {
        self.path_flags.len()
    }
}

/// A glyph of a font, kept to ask the font about its other codes (`Document::fonts`).
pub(crate) enum FontGlyph<'a> {
    Outline(OutlineGlyph<'a>),
    Type3(Box<Type3Glyph<'a>>),
}

/// The last drawing call, so the second half of a fill-and-stroke path (hayro
/// draws `B` as a fill then a stroke) is folded into the first. A glyph run
/// says so itself (`GlyphRun::repeats_fill`).
#[derive(Clone, Copy, PartialEq)]
enum Last {
    None,
    /// A filled path, by index.
    FillPath(usize),
}

pub(crate) struct PageDevice<'a> {
    pub glyphs: Vec<Glyph>,
    pub fonts: Vec<Font>,
    font_ids: rustc_hash::FxHashMap<u128, u32>,
    pub runs: Vec<Run>,
    /// The texts of each run, for appearance streams (off for pages).
    pub run_texts: Option<Vec<String>>,
    pub objects: Option<PageObjects>,
    /// Viewer frame back to page space, for page-space char angles.
    to_page: Affine,
    last: Last,
    /// The last run's fill and its RGBA: runs nearly always share one, and a
    /// calibrated or ICC space converts at a cost.
    fill: Option<(hayro::hayro_interpret::color::Color, u32)>,
    /// The last font met on the page (a glyph of it) and its id: runs nearly
    /// always repeat it.
    last_font: Option<(hayro::hayro_interpret::font::OutlineGlyph<'a>, u32)>,
    /// Every font met on the page, by `font_identity`, and its id: a font switch
    /// finds its id here without hashing the program again. A glyph of each is
    /// kept, so an identity is never reused while this lives.
    seen_fonts: rustc_hash::FxHashMap<usize, (hayro::hayro_interpret::font::OutlineGlyph<'a>, u32)>,
    /// Where the next drawn path's `re` rectangles start (`Device::path_rects`).
    rect_starts: Vec<u32>,
    /// Inside the fill that paints `sh` (`Device::shading_fill`).
    in_shading_fill: bool,
    /// More glyphs than `MAX_PAGE_GLYPHS` were shown.
    pub text_truncated: bool,
    /// Measure each glyph's own bounds (`Boxes::Tight`).
    pub tight: bool,
    /// Glyph bounds measured on this page, in glyph space (1000 units to the em): an outline glyph's
    /// by its font's identity and glyph id, a Type 3 glyph's by its cache key. `None`: nothing drawn.
    outline_bounds: rustc_hash::FxHashMap<(usize, u32), Option<Rect>>,
    type3_bounds: rustc_hash::FxHashMap<u128, Option<Rect>>,
    /// With `Document::fonts`: per font, its dictionary's key and a glyph of it.
    pub font_glyphs: Option<Vec<(u128, FontGlyph<'a>)>>,
}

#[cfg(test)]
thread_local! {
    /// Fonts `font_of` compared a glyph's with, for tests that count its work.
    pub(crate) static FONT_PROBES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl<'a> PageDevice<'a> {
    /// `viewer` maps the content's space to the viewer frame.
    pub fn new(viewer: Affine, objects: bool) -> Self {
        Self {
            glyphs: Vec::new(),
            fonts: Vec::new(),
            font_ids: Default::default(),
            runs: Vec::new(),
            run_texts: None,
            objects: objects.then(PageObjects::default),
            to_page: viewer.inverse(),
            last: Last::None,
            fill: None,
            last_font: None,
            seen_fonts: Default::default(),
            rect_starts: Vec::new(),
            in_shading_fill: false,
            text_truncated: false,
            tight: false,
            outline_bounds: Default::default(),
            type3_bounds: Default::default(),
            font_glyphs: None,
        }
    }

    pub fn finish(mut self) -> Self {
        if let Some(o) = &mut self.objects {
            o.path_start.push(o.kinds.len() as u32);
        }
        self
    }

    fn font_of(&mut self, glyph: &HayroGlyph<'a>) -> u32 {
        // The glyphs kept here hold their fonts alive, so a match is the same
        // font. Runs nearly always repeat the last one; a switch is one lookup,
        // however many fonts the page has (a page switching among thousands
        // was quadratic in them).
        let HayroGlyph::Outline(g) = glyph else {
            return self.font_id(glyph);
        };
        #[cfg(test)]
        FONT_PROBES.with(|n| n.set(n.get() + 2));
        if let Some((f, id)) = &self.last_font
            && g.same_font(f)
        {
            return *id;
        }
        let id = match self.seen_fonts.get(&g.font_identity()) {
            Some((_, id)) => *id,
            None => {
                let id = self.font_id(glyph);
                self.seen_fonts.insert(g.font_identity(), (g.clone(), id));
                id
            }
        };
        self.last_font = Some((g.clone(), id));
        id
    }

    /// A glyph's bounds in glyph space, measured once per page: the control box of its outline, or of
    /// what a Type 3 glyph's procedure draws. `None` where it draws nothing.
    fn glyph_bounds(&mut self, glyph: &HayroGlyph<'a>, paint: &Paint<'a>) -> Option<Rect> {
        match glyph {
            HayroGlyph::Outline(g) => {
                let key = (g.font_identity(), g.glyph_id().to_u32());
                *self.outline_bounds.entry(key).or_insert_with(|| outline_box(g))
            }
            HayroGlyph::Type3(g) => {
                let key = g.cache_key();
                if let Some(bounds) = self.type3_bounds.get(&key) {
                    return *bounds;
                }
                let mut ink = Ink::default();
                g.interpret(&mut ink, Affine::IDENTITY, Affine::IDENTITY, paint);
                self.type3_bounds.insert(key, ink.0);
                ink.0
            }
        }
    }

    /// One id per font dictionary, as the file has them.
    fn font_id(&mut self, glyph: &HayroGlyph<'a>) -> u32 {
        let key = match glyph {
            HayroGlyph::Outline(g) => g.font_facts().key,
            HayroGlyph::Type3(g) => g.font_facts().key,
        };
        if let Some(&id) = self.font_ids.get(&key) {
            return id;
        }
        let font = match glyph {
            HayroGlyph::Outline(g) => {
                let facts = g.font_facts();
                // The dictionary first, then the program for what it leaves out: only then is
                // a text pass's program loaded for this.
                let program = std::cell::OnceCell::new();
                let program = || program.get_or_init(|| g.font_data()).as_ref();
                let name = if facts.name.is_empty() {
                    program().and_then(|d| d.postscript_name.clone()).unwrap_or_default()
                } else {
                    facts.name.clone()
                };
                let bold_name = name.to_ascii_lowercase().contains("bold");
                let weight = match facts.weight {
                    0 => match program().and_then(|d| d.weight) {
                        Some(w) => w,
                        None if bold_name => 700,
                        None if !name.is_empty() => 400,
                        None => 0,
                    },
                    w => w,
                };
                // Descriptor flags, or rebuilt from the program's style bits: fixed pitch 1,
                // serif 2, nonsymbolic 32, italic 64.
                let flags = facts.flags.unwrap_or_else(|| {
                    program().map_or(32, |d| {
                        u32::from(d.is_monospace)
                            | (u32::from(d.is_serif) << 1)
                            | 32
                            | (u32::from(d.is_italic) << 6)
                    })
                });
                Font {
                    name,
                    flags,
                    weight,
                    embedded: facts.embedded,
                    ascent: facts.ascent.unwrap_or(crate::text::ASCENT as f32),
                    descent: facts.descent.unwrap_or(crate::text::DESCENT as f32),
                }
            }
            HayroGlyph::Type3(g) => Font {
                name: g.font_facts().name.clone(),
                flags: 0,
                weight: 0,
                embedded: true,
                ascent: crate::text::ASCENT as f32,
                descent: crate::text::DESCENT as f32,
            },
        };
        let id = self.fonts.len() as u32;
        self.fonts.push(font);
        self.font_ids.insert(key, id);
        if let Some(kept) = &mut self.font_glyphs {
            kept.push((key, match glyph {
                HayroGlyph::Outline(g) => FontGlyph::Outline(g.clone()),
                HayroGlyph::Type3(g) => FontGlyph::Type3(g.clone()),
            }));
        }
        id
    }
}

/// What one page may collect. A form drawn thousands of times multiplies
/// its glyphs and paths: a 2 KB file once asked for 3.5 GB and trapped.
/// Real pages stay far below (a dense page is about 10k chars). Past these the
/// rest of the page is left out, and `truncated` says so.
const MAX_PAGE_GLYPHS: usize = 1 << 19;
const MAX_PAGE_SEGMENTS: usize = 1 << 21;
const MAX_PAGE_IMAGES: usize = 1 << 19;

impl<'a> PageDevice<'a> {
    fn add_path(&mut self, path: &BezPath, t: Affine, flags: u8, stroke: Option<f32>) {
        let last = std::mem::replace(&mut self.last, Last::None);
        let Some(o) = &mut self.objects else { return };
        if o.kinds.len() >= MAX_PAGE_SEGMENTS {
            o.truncated = true;
            return;
        }
        let from = o.kinds.len();
        push_segments(path, t, &self.rect_starts, &mut o.points, &mut o.kinds);
        // Marks are for the one path drawn after them.
        self.rect_starts.clear();
        // The stroke half of a fill-and-stroke: the same segments again.
        if let (Last::FillPath(p), PATH_STROKE) = (last, flags) {
            let prev = o.path_start[p] as usize;
            if from - prev == o.kinds.len() - from
                && o.kinds[prev..from] == o.kinds[from..]
                && o.points[2 * prev..2 * from] == o.points[2 * from..]
            {
                o.kinds.truncate(from);
                o.points.truncate(2 * from);
                o.path_flags[p] |= PATH_STROKE;
                o.path_boxes[4 * p..4 * p + 4].copy_from_slice(&path_box(path, t, stroke));
                return;
            }
        }
        o.path_start.push(from as u32);
        o.path_flags.push(flags);
        o.path_boxes.extend_from_slice(&path_box(path, t, stroke));
        if flags == PATH_FILL {
            self.last = Last::FillPath(o.path_flags.len() - 1);
        }
    }
}

/// 0xRRGGBBAA of a solid paint.
/// Limit: a pattern paint has no single colour; it reads as opaque black.
fn rgba(paint: &Paint<'_>) -> u32 {
    match paint {
        Paint::Color(c) => u32::from_be_bytes(c.to_rgba().to_rgba8()),
        Paint::Pattern(_) => 0xff,
    }
}

/// The axis-aligned box of `rect` under `t`: x, y, width, height.
fn box_of(t: Affine, rect: Rect) -> [f32; 4] {
    let b = t.transform_rect_bbox(rect);
    [
        b.x0 as f32,
        b.y0 as f32,
        b.width() as f32,
        b.height() as f32,
    ]
}

/// The control box of a glyph's outline, `None` if it has none (a space, a program that doesn't
/// parse). The control box is what pdfium's tight char box is (FreeType's glyph bounds), and needs no
/// curve solving.
fn outline_box(glyph: &OutlineGlyph<'_>) -> Option<Rect> {
    let path = glyph.outline();
    if path.elements().is_empty() {
        return None;
    }
    let r = path.control_box();
    (r.width() > 0.0 || r.height() > 0.0).then_some(r)
}

/// Collects the bounds of everything a Type 3 glyph's procedure draws.
#[derive(Default)]
struct Ink(Option<Rect>);

impl Ink {
    fn add(&mut self, t: Affine, r: Rect) {
        let r = t.transform_rect_bbox(r);
        self.0 = Some(self.0.map_or(r, |b| b.union(r)));
    }
}

impl<'a> Device<'a> for Ink {
    fn draw_path(&mut self, path: &BezPath, props: DrawProps<'a>, mode: &DrawMode) {
        if path.elements().is_empty() {
            return;
        }
        let r = path.control_box();
        match mode {
            DrawMode::Invisible => {}
            DrawMode::Fill(_) => self.add(props.transform, r),
            DrawMode::Stroke(s) | DrawMode::FillAndStroke(_, s) => {
                let w = f64::from(s.line_width) / 2.0;
                self.add(props.transform, r.inflate(w, w));
            }
        }
    }

    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, mode: &DrawMode) {
        if matches!(mode, DrawMode::Invisible) {
            return;
        }
        for glyph in run.glyphs() {
            // A Type 3 glyph drawing text of another Type 3 font: left out.
            if let HayroGlyph::Outline(g) = &**glyph
                && let Some(r) = outline_box(g)
            {
                self.add(props.transform * glyph.transform(), r);
            }
        }
    }

    fn draw_image(&mut self, image: Image<'a, '_>, props: ImageDrawProps<'a>) {
        let (w, h) = (image.width(), image.height());
        self.add(props.transform, Rect::new(0.0, 0.0, f64::from(w), f64::from(h)));
    }

    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}
}

/// Appends a path's segments: a cubic is three Bezier points, and a close
/// that is not already at the start adds the closing line, flagged.
fn push_segments(
    path: &BezPath,
    t: Affine,
    rect_starts: &[u32],
    points: &mut Vec<f32>,
    kinds: &mut Vec<u8>,
) {
    let push = |p: Point, kind: u8, points: &mut Vec<f32>, kinds: &mut Vec<u8>| {
        let p = t * p;
        points.extend_from_slice(&[p.x as f32, p.y as f32]);
        kinds.push(kind);
    };
    let (mut start, mut current) = (None::<Point>, Point::ZERO);
    let mut rects = rect_starts.iter().peekable();
    for (i, el) in path.elements().iter().enumerate() {
        match *el {
            PathEl::MoveTo(p) => {
                // A move straight after a move folds into the later one.
                if start.is_some() && kinds.last().is_some_and(|k| k & 3 == SEGMENT_MOVE) {
                    kinds.pop();
                    points.truncate(points.len() - 2);
                }
                while rects.next_if(|&&r| (r as usize) < i).is_some() {}
                let rect = rects.next_if(|&&r| r as usize == i).is_some();
                push(
                    p,
                    SEGMENT_MOVE | if rect { SEGMENT_RECT } else { 0 },
                    points,
                    kinds,
                );
                (start, current) = (Some(p), p);
            }
            PathEl::LineTo(p) => {
                push(p, SEGMENT_LINE, points, kinds);
                current = p;
            }
            PathEl::QuadTo(c, p) => {
                push(
                    current + (c - current) * (2.0 / 3.0),
                    SEGMENT_BEZIER,
                    points,
                    kinds,
                );
                push(p + (c - p) * (2.0 / 3.0), SEGMENT_BEZIER, points, kinds);
                push(p, SEGMENT_BEZIER, points, kinds);
                current = p;
            }
            PathEl::CurveTo(c1, c2, p) => {
                push(c1, SEGMENT_BEZIER, points, kinds);
                push(c2, SEGMENT_BEZIER, points, kinds);
                push(p, SEGMENT_BEZIER, points, kinds);
                current = p;
            }
            PathEl::ClosePath => {
                let Some(s) = start else { continue };
                // hayro nudges a zero-length `l` 1e-4 right (for round caps);
                // it stays at the start, so the close only flags it.
                let at_start = current == s || (current.y == s.y && current.x == s.x + 0.0001);
                if !at_start {
                    push(s, SEGMENT_LINE | SEGMENT_CLOSE, points, kinds);
                    current = s;
                } else if let Some(k) = kinds.last_mut() {
                    *k |= SEGMENT_CLOSE;
                }
            }
        }
    }
}

/// A path's box: its points (control points included), widened by the line
/// width on every side when stroked (a 1.4pt rule's box is 2.8pt tall), and
/// by half a point for a hairline.
fn path_box(path: &BezPath, t: Affine, stroke: Option<f32>) -> [f32; 4] {
    let mut r = path.control_box();
    if let Some(w) = stroke.filter(|w| *w > 0.0) {
        r = r.inflate(f64::from(w), f64::from(w));
    }
    let mut b = box_of(t, r);
    if stroke == Some(0.0) {
        b = [b[0] - 0.5, b[1] - 0.5, b[2] + 1.0, b[3] + 1.0];
    }
    b
}

impl<'a> Device<'a> for PageDevice<'a> {
    fn draw_path(&mut self, path: &BezPath, props: DrawProps<'a>, mode: &DrawMode) {
        let (flags, stroke) = match mode {
            DrawMode::Fill(_) => (PATH_FILL, None),
            DrawMode::Stroke(s) => (PATH_STROKE, Some(s.line_width)),
            DrawMode::FillAndStroke(_, s) => (PATH_FILL | PATH_STROKE, Some(s.line_width)),
            DrawMode::Invisible => (0, None),
        };
        // `sh` is a shading object, not a path.
        if flags == 0 || (flags == PATH_FILL && self.in_shading_fill) {
            self.last = Last::None;
            return;
        }
        self.add_path(path, props.transform, flags, stroke);
    }

    fn shading_fill(&mut self, on: bool) {
        self.in_shading_fill = on;
    }

    fn path_rects(&mut self, starts: &[u32]) {
        if self.objects.is_some() {
            self.rect_starts.clear();
            self.rect_starts.extend_from_slice(starts);
        }
    }

    fn push_clip_path(&mut self, _: &ClipPath) {
        self.last = Last::None;
    }

    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {
        self.last = Last::None;
    }

    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, mode: &DrawMode) {
        let glyphs = run.glyphs();
        let Some(first) = glyphs.first() else { return };
        self.last = Last::None;
        if matches!(mode, DrawMode::Stroke(_)) && run.repeats_fill() {
            // `Tr 2`/`6`: the same run stroked after it was filled.
            return;
        }
        if let Some(o) = &mut self.objects {
            o.text_objects += 1;
        }
        let run_id = self.runs.len() as u32;
        let font = self.font_of(first);
        let metrics = {
            let f = &self.fonts[font as usize];
            (f64::from(f.ascent), f64::from(f.descent))
        };
        // Limit: for stroke-only text (`Tr 1`) hayro passes the stroke paint,
        // so this is the stroke colour, not the fill colour.
        let fill = match &props.paint {
            Paint::Color(c) => match &self.fill {
                Some((last, rgba)) if last.same_as(c) => *rgba,
                _ => {
                    let rgba = rgba(&props.paint);
                    self.fill = Some((c.clone(), rgba));
                    rgba
                }
            },
            paint => rgba(paint),
        };
        let vertical = run.writing_mode() == WritingMode::Vertical;
        let mut run_text = self.run_texts.as_ref().map(|_| String::new());
        let mut origin = None;
        let mut matrix = [0.0f32; 6];
        let mut angle_of = ((f64::NAN, f64::NAN), 0.0_f32);
        for glyph in glyphs {
            // Built in place: one scalar (nearly every glyph) never allocates.
            let (unicode, advance) = match &**glyph {
                HayroGlyph::Outline(g) => g.unicode_and_width(),
                HayroGlyph::Type3(g) => (glyph.as_unicode(), g.advance_width()),
            };
            let text = match unicode {
                Some(BfString::Char(c)) => {
                    crate::forms::base_letters(c).map_or_else(|| Text::from_char(c), Text::from)
                }
                Some(BfString::String(s)) => Text::from(crate::forms::normalize(s).as_str()),
                // A Type3 code with no ToUnicode or glyph name: its code is the
                // only hint left, and printable ASCII is the fallback.
                None => match &**glyph {
                    HayroGlyph::Type3(g) if (0x20..0x7f).contains(&g.char_code()) => {
                        char::from_u32(g.char_code()).map_or(Text::EMPTY, Text::from_char)
                    }
                    _ => Text::EMPTY,
                },
            };
            if let Some(t) = &mut run_text {
                t.push_str(&text);
            }
            let advance = advance.unwrap_or(0.0);
            let code = if text.is_empty() {
                glyph.char_code()
            } else {
                0
            };
            let transform = props.transform * glyph.transform();
            if self.glyphs.len() >= MAX_PAGE_GLYPHS {
                self.text_truncated = true;
                break;
            }
            // A substituted font's glyphs are widened to the PDF's width. The advance already is
            // that width, so the box takes the transform without the widening.
            let stretch = f64::from(glyph.stretch());
            let unstretched = if stretch > 0.0 && stretch != 1.0 {
                let [a, b, c, d, e, f] = transform.as_coeffs();
                Affine::new([a / stretch, b / stretch, c, d, e, f])
            } else {
                transform
            };
            if let Some(mut g) = glyph_from(unstretched, text, f64::from(advance), vertical, metrics) {
                if self.tight {
                    // As drawn: a substituted font's glyph widened to the PDF's width.
                    g.tight = self
                        .glyph_bounds(glyph, &props.paint)
                        .map(|r| box_of(transform, r))
                        .filter(|b| b.iter().all(|v| v.is_finite()));
                }
                if origin.is_none() {
                    // The text rendering matrix: glyph space is 1000 units an em, and the
                    // substitute's widening is the font's, not the text state's.
                    let [a, b, c, d, e, f] = unstretched.as_coeffs();
                    matrix = [a * 1000.0, b * 1000.0, c * 1000.0, d * 1000.0, e, f].map(|v| v as f32);
                    origin = Some((g.origin, g.em));
                }
                g.code = code;
                g.tf = glyph.font_size();
                g.h_scale = glyph.h_scale();
                if !vertical {
                    let [a, b, ..] = transform.as_coeffs();
                    g.char_space = a.hypot(b) * f64::from(glyph.char_space());
                }
                // Limit: this matrix includes Tf and Tz, which only moves the angle of
                // skewed or turned text drawn with a horizontal scale.
                // atan2 once per matrix: a run's glyphs nearly always share one.
                // The a and c of `to_page * transform`, as kurbo multiplies.
                let ([pa, _, pc, ..], [ta, tb, tc, td, ..]) =
                    (self.to_page.as_coeffs(), transform.as_coeffs());
                let (a, c) = (pa * ta + pc * tb, pa * tc + pc * td);
                if (a, c) != angle_of.0 {
                    angle_of = (
                        (a, c),
                        (c.atan2(a) as f32).rem_euclid(std::f32::consts::TAU),
                    );
                }
                g.angle = angle_of.1;
                g.fill = fill;
                g.font = font;
                g.run = run_id;
                self.glyphs.push(g);
            }
        }
        let (o, em) = origin.unwrap_or((props.transform * first.transform() * Point::ZERO, 0.0));
        self.runs.push(Run {
            origin: [o.x as f32, o.y as f32],
            em: em as f32,
            matrix,
        });
        if let (Some(texts), Some(t)) = (&mut self.run_texts, run_text) {
            texts.push(t);
        }
    }

    fn draw_image(&mut self, image: Image<'a, '_>, props: ImageDrawProps<'a>) {
        self.last = Last::None;
        let Some(o) = &mut self.objects else { return };
        if o.image_pixels.len() / 2 >= MAX_PAGE_IMAGES {
            o.truncated = true;
            return;
        }
        let (w, h) = (image.width(), image.height());
        // hayro's image transform maps the pixel grid, 0..w by 0..h.
        o.image_boxes.extend_from_slice(&box_of(
            props.transform,
            Rect::new(0.0, 0.0, f64::from(w), f64::from(h)),
        ));
        o.image_pixels.extend_from_slice(&[w, h]);
    }

    fn pop_clip(&mut self) {
        self.last = Last::None;
    }

    fn pop_transparency_group(&mut self) {
        self.last = Last::None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hayro::kurbo::Shape;

    fn segments(path: &BezPath) -> (Vec<f32>, Vec<u8>) {
        let (mut p, mut k) = (Vec::new(), Vec::new());
        push_segments(path, Affine::IDENTITY, &[], &mut p, &mut k);
        (p, k)
    }

    #[test]
    fn rect_segments_end_on_a_closing_line() {
        // `re` reaches the device as m l l l h: five points, the last a
        // closing line.
        let path = Rect::new(10.0, 20.0, 30.0, 40.0).to_path(0.1);
        let (p, k) = segments(&path);
        assert_eq!(
            k,
            [
                SEGMENT_MOVE,
                SEGMENT_LINE,
                SEGMENT_LINE,
                SEGMENT_LINE,
                SEGMENT_LINE | SEGMENT_CLOSE
            ]
        );
        assert_eq!(&p[8..], &[10.0, 20.0]);
    }

    #[test]
    fn curves_and_closes_at_the_start() {
        let mut path = BezPath::new();
        path.move_to((0.0, 0.0));
        path.curve_to((1.0, 1.0), (2.0, 1.0), (3.0, 0.0));
        // Back at the start, give or take hayro's 1e-4 nudge.
        path.line_to((0.0001, 0.0));
        path.close_path();
        // Two moves in a row are one, at the later point.
        path.move_to((4.0, 4.0));
        path.move_to((5.0, 5.0));
        path.quad_to((6.0, 8.0), (9.0, 5.0));
        let (p, k) = segments(&path);
        assert_eq!(
            k,
            [
                SEGMENT_MOVE,
                SEGMENT_BEZIER,
                SEGMENT_BEZIER,
                SEGMENT_BEZIER,
                // Already at the start: the close flags the last line.
                SEGMENT_LINE | SEGMENT_CLOSE,
                SEGMENT_MOVE,
                SEGMENT_BEZIER,
                SEGMENT_BEZIER,
                SEGMENT_BEZIER
            ]
        );
        // The quad's cubic control points: start + 2/3 (c - start), end + 2/3 (c - end).
        assert!((p[12] - 5.0 - 2.0 / 3.0).abs() < 1e-5 && (p[13] - 7.0).abs() < 1e-5);
        assert!((p[14] - 7.0).abs() < 1e-5 && (p[15] - 7.0).abs() < 1e-5);
    }

    #[test]
    fn stroked_boxes_widen_by_the_line() {
        let path = Rect::new(10.0, 10.0, 20.0, 20.0).to_path(0.1);
        assert_eq!(
            path_box(&path, Affine::IDENTITY, None),
            [10.0, 10.0, 10.0, 10.0]
        );
        assert_eq!(
            path_box(&path, Affine::IDENTITY, Some(2.0)),
            [8.0, 8.0, 14.0, 14.0]
        );
        assert_eq!(
            path_box(&path, Affine::IDENTITY, Some(0.0)),
            [9.5, 9.5, 11.0, 11.0]
        );
        // Boxes land in the viewer frame: a y flip.
        let flip = Affine::new([1.0, 0.0, 0.0, -1.0, 0.0, 100.0]);
        assert_eq!(path_box(&path, flip, None), [10.0, 80.0, 10.0, 10.0]);
    }

    #[test]
    fn fill_then_stroke_is_one_path() {
        let path = Rect::new(0.0, 0.0, 10.0, 10.0).to_path(0.1);
        let other = Rect::new(0.0, 0.0, 5.0, 5.0).to_path(0.1);
        let t = Affine::IDENTITY;
        let mut d = PageDevice::new(Affine::IDENTITY, true);
        d.add_path(&path, t, PATH_FILL, None);
        d.add_path(&path, t, PATH_STROKE, Some(1.0));
        // A separate stroke of the same path, after a clip, is its own object.
        d.push_clip_path(&ClipPath {
            path: path.clone(),
            fill: hayro::hayro_interpret::FillRule::NonZero,
        });
        d.add_path(&path, t, PATH_STROKE, Some(1.0));
        // A fill then a stroke of a different path are two objects.
        d.add_path(&path, t, PATH_FILL, None);
        d.add_path(&other, t, PATH_STROKE, Some(1.0));
        let o = d.finish().objects.unwrap();
        assert_eq!(
            o.path_flags,
            [PATH_FILL | PATH_STROKE, PATH_STROKE, PATH_FILL, PATH_STROKE]
        );
        assert_eq!(o.path_start, [0, 5, 10, 15, 20]);
        assert_eq!(&o.path_boxes[..4], &[-1.0, -1.0, 12.0, 12.0]);
    }
}
