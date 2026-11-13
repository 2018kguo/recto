//! The text layer: glyphs in content order become chars with loose boxes,
//! plus the spaces and line breaks the content stream implies but does not
//! draw, then words.

use hayro::kurbo::{Affine, Point, Vec2};

use crate::ctext::Text;

/// A space or line break the engine inferred from glyph positions.
pub const CHAR_GENERATED: u8 = 1;
/// A glyph with no Unicode mapping (no ToUnicode, no usable glyph name).
pub const CHAR_UNMAPPED: u8 = 2;

// Loose box in em units, the usual fallback ascent/descent when a font
// gives none. Limit: fixed metrics; hayro does not expose the descriptor's
// /Ascent and /Descent.
/// The box's height where a font doesn't state its own.
pub(crate) const ASCENT: f64 = 0.8;
pub(crate) const DESCENT: f64 = -0.2;
/// A gap wider than this (in em) between two glyphs on a line is a space.
const SPACE_GAP: f64 = 0.15;
/// A baseline shift larger than this (in em) is a new line.
const LINE_SHIFT: f64 = 0.5;

pub(crate) struct Glyph {
    pub(crate) text: Text,
    /// `classify(text)`, computed once: what every direction and space test reads.
    class: u8,
    /// What a glyph with no Unicode reports: its char code.
    pub(crate) code: u32,
    pub(crate) origin: Point,
    /// Unit vectors of the glyph's x and y axes in the viewer frame.
    dir: Vec2,
    up: Vec2,
    /// Font size in viewer points.
    pub(crate) em: f64,
    /// The `Tf` operand.
    pub(crate) tf: f32,
    /// `Tz` over 100.
    pub(crate) h_scale: f32,
    /// Advance along `dir`, in viewer points.
    advance: f64,
    /// `Tc` along `dir`, in viewer points: letter spacing inside a text run.
    pub(crate) char_space: f64,
    bbox: [f32; 4],
    /// The glyph's own bounds, with `Boxes::Tight`; `None` keeps `bbox`.
    pub(crate) tight: Option<[f32; 4]>,
    /// The char's angle (see `Char::angle`).
    pub(crate) angle: f32,
    /// 0xRRGGBBAA.
    pub(crate) fill: u32,
    /// The device's font and text-object (run) indices.
    pub(crate) font: u32,
    pub(crate) run: u32,
}

pub(crate) fn glyph_from(
    transform: Affine,
    text: Text,
    advance_units: f64,
    vertical: bool,
    (ascent, descent): (f64, f64),
) -> Option<Glyph> {
    // The matrix's columns, read off rather than mapped as points.
    let [a, b, c, d, e, f] = transform.as_coeffs();
    let origin = Point::new(e, f);
    let x_axis = Vec2::new(a * 1000.0, b * 1000.0);
    let y_axis = Vec2::new(c * 1000.0, d * 1000.0);
    let em = y_axis.length();
    if !(em.is_finite() && em > 0.0) {
        return None;
    }
    let up = y_axis / em;
    let x_len = x_axis.length();
    // `Tz 0` or a singular Tm squashes the x axis; keep the char, with no width.
    let x_dir = if x_len > 0.0 {
        x_axis / x_len
    } else {
        Vec2::new(-up.y, up.x)
    };
    let advance_units = if advance_units > 0.0 {
        advance_units
    } else {
        1000.0
    };
    // The box's corners: the baseline start moved down to the descent, then
    // across by the advance and up to the ascent.
    let along = x_axis * (advance_units / 1000.0);
    let low = origin + y_axis * descent;
    let high = origin + y_axis * ascent;
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in [low, low + along, high + along, high] {
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x);
        y1 = y1.max(p.y);
    }
    let bbox = [x0 as f32, y0 as f32, (x1 - x0) as f32, (y1 - y0) as f32];
    // Limit: text scaled past f32 (Tm 1e39) is dropped.
    if !bbox.iter().all(|v| v.is_finite()) {
        return None;
    }
    // Vertical writing advances down the glyph's y axis, one em per glyph
    // (hayro does not expose the W2 vertical advance), and lines sit side by side.
    let (dir, up, advance) = if vertical {
        (-up, x_dir, em)
    } else {
        (x_dir, up, x_len * advance_units / 1000.0)
    };
    Some(Glyph {
        class: classify(&text),
        text,
        code: 0,
        origin,
        dir,
        up,
        em,
        tf: 0.0,
        h_scale: 1.0,
        advance,
        char_space: 0.0,
        bbox,
        tight: None,
        angle: 0.0,
        fill: 0,
        font: 0,
        run: 0,
    })
}

pub struct Char {
    pub text: Text,
    class: u8,
    /// The code point for an unmapped glyph (its char code); 0 otherwise.
    pub code: u32,
    /// x, y, width, height in the viewer frame.
    pub bbox: [f32; 4],
    pub flags: u8,
    /// Font size as drawn, in points (Tf × Tm × CTM).
    pub em: f32,
    /// The `Tf` operand itself. The two agree wherever Tm and the CTM don't scale.
    pub tf: f32,
    /// The horizontal scale it was shown with: `Tz` over 100, 1 where none was set. A generated char
    /// takes the char before it's.
    pub h_scale: f32,
    /// `atan2(c, a)` of the char's page-space matrix, in [0, 2π). Its `c` is
    /// the y axis's x part, so a skewed italic
    /// reads about 0.18 and text turned θ counter-clockwise reads 2π - θ.
    pub angle: f32,
    /// 0xRRGGBBAA.
    pub fill: u32,
    /// Index into `TextPage::fonts`, or -1 for a generated char.
    pub font: i32,
    /// Index into `TextPage::runs`, or -1 for a generated char.
    pub run: i32,
    /// Position along the line's own direction (origin · dir): which way a
    /// right-to-left run was drawn, on any page rotation.
    pub along: f32,
}

/// A text font.
#[derive(Clone, Debug, PartialEq)]
pub struct Font {
    pub name: String,
    /// PDF font descriptor flags.
    pub flags: u32,
    pub weight: u32,
    pub embedded: bool,
    /// Top and bottom of the char boxes, in ems from the baseline.
    pub ascent: f32,
    pub descent: f32,
}

/// One text-showing operator: its text origin on the baseline and drawn size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Run {
    pub origin: [f32; 2],
    pub em: f32,
    /// The text rendering matrix its first glyph was drawn with, `[a, b, c, d, e, f]` into the
    /// viewer frame: `[Tf·Tz/100 0 0 Tf 0 Ts] × Tm × CTM`, then the page's flip to a top-left origin,
    /// so one unit of text space (Tf 1) is `(a, b)` across and `(c, d)` up. `e, f` is where the glyph
    /// is placed. All of the run's glyphs share `a..d`.
    pub matrix: [f32; 6],
}

pub struct Word {
    /// Char range `[start, end)`.
    pub start: u32,
    pub end: u32,
    pub bbox: [f32; 4],
}

pub struct TextPage {
    pub chars: Vec<Char>,
    pub words: Vec<Word>,
    /// Fonts in the order their chars first appear.
    pub fonts: Vec<Font>,
    /// Text objects in the order their chars first appear.
    pub runs: Vec<Run>,
    /// The page held more glyphs than one page may collect; the rest aren't here.
    pub truncated: bool,
    /// Which of the device's fonts each of `fonts` is.
    pub(crate) font_order: Vec<u32>,
}

impl TextPage {
    /// The page's text: chars in order, generated spaces and breaks included.
    pub fn text(&self) -> String {
        self.chars.iter().map(|c| &*c.text).collect()
    }

    pub fn word_text(&self, word: &Word) -> String {
        self.chars[word.start as usize..word.end as usize]
            .iter()
            .map(|c| &*c.text)
            .collect()
    }
}

fn generated(text: &str, at: &Glyph) -> Char {
    let end = at.origin + at.dir * at.advance;
    let text = Text::from(text);
    Char {
        class: classify(&text),
        text,
        code: 0,
        bbox: [end.x as f32, at.bbox[1], 0.0, at.bbox[3]],
        flags: CHAR_GENERATED,
        // A generated char takes the size and angle of the char before it.
        em: at.em as f32,
        tf: 0.0,
        h_scale: at.h_scale,
        angle: at.angle,
        fill: 0,
        font: -1,
        run: -1,
        along: end.to_vec2().dot(at.dir) as f32,
    }
}

fn is_space(text: &Text) -> bool {
    if text.is_one_char() {
        return text.first().is_some_and(char::is_whitespace);
    }
    !text.is_empty() && text.chars().all(char::is_whitespace)
}

/// Fake bold is the same text drawn again a hair away (glyph by glyph or as
/// a whole string): within a tenth of the smaller em. Each kept glyph is
/// indexed by origin on the grid of its em's power of two, `2^L <= em <
/// 2^(L+1)`, whose cells are `2^(L-2)` wide: wider than its copy distance
/// (under `0.2 * 2^L`), so its copies land in the 3x3 cells around it, and
/// under a glyph wide, so a cell holds a glyph or two at any text size. A
/// probe checks those 3x3 cells on each level the page uses, however many
/// glyphs back the original is.
const MIN_LEVEL: i32 = -40;
const MAX_LEVEL: i32 = 40;

/// `floor(log2(em))` from the exponent bits (`em` is finite and positive).
/// Limit: past 2^41 pt (no page is that large) the grid stops growing
/// and copies further than its cell apart are missed.
fn level(em: f64) -> i32 {
    (((em.to_bits() >> 52) & 0x7FF) as i32 - 1023).clamp(MIN_LEVEL, MAX_LEVEL)
}

/// Scaling by a power of two is exact, so a point's cell never depends on
/// rounding.
fn cell(p: Point, level: i32) -> (i32, i32) {
    let scale = f64::from_bits(((1023 + 2 - level) as u64) << 52);
    ((p.x * scale).floor() as i32, (p.y * scale).floor() as i32)
}

/// A level's cell as one key: the level in 7 bits, x and y in 28 each. Cells
/// 2^28 apart share a key; that only adds candidates, which are checked
/// against the real origin.
fn cell_key(level: i32, x: i32, y: i32) -> u64 {
    const M: u64 = (1 << 28) - 1;
    (((level - MIN_LEVEL) as u64) << 56) | ((x as u32 as u64 & M) << 28) | (y as u32 as u64 & M)
}

const NONE: u32 = u32::MAX;

/// Each cell's newest glyph, by key: open addressing with linear probing, sized once to more than
/// one and a half times the glyphs, so it never fills or rehashes. Insert-only, as `copies` uses it;
/// a general hash map's probing cost more than the rest of the pass.
struct Cells {
    keys: Vec<u64>,
    glyphs: Vec<u32>,
    shift: u32,
}

impl Cells {
    /// No key is this: a cell key's top bits are a level under 81.
    const EMPTY: u64 = u64::MAX;

    fn with_capacity(n: usize) -> Self {
        let size = (n.saturating_add(n / 2) + 1).max(16).next_power_of_two();
        Self {
            keys: vec![Self::EMPTY; size],
            glyphs: vec![NONE; size],
            shift: 64 - size.trailing_zeros(),
        }
    }

    fn slot(&self, key: u64) -> usize {
        let mask = self.keys.len() - 1;
        let mut at = (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize;
        while self.keys[at] != key && self.keys[at] != Self::EMPTY {
            at = (at + 1) & mask;
        }
        at
    }

    /// The cell's newest glyph, or `NONE`.
    fn get(&self, key: u64) -> u32 {
        self.glyphs[self.slot(key)]
    }

    /// Makes `glyph` the cell's newest and returns the one before it, or `NONE`.
    fn replace(&mut self, key: u64, glyph: u32) -> u32 {
        let at = self.slot(key);
        self.keys[at] = key;
        std::mem::replace(&mut self.glyphs[at], glyph)
    }
}

const FAKE_BOLD_CHAIN: usize = 64;

#[cfg(test)]
pub(crate) fn build(glyphs: Vec<Glyph>) -> TextPage {
    build_page(&glyphs, &[], &[])
}

const RECENT_RUNS: usize = 7;
const WHOLE_RUN_COPY: f64 = 0.15;

/// Which glyphs redraw text already on the page (fake bold, a shadow, a block
/// drawn twice): one landing on a kept glyph with the same text. A run with a
/// glyph exactly on an earlier run's different glyph is a second text drawn
/// over the first, not a copy, so it is kept whole: a file can stamp
/// "Document ID: 4111111" and "Document ID: 4222222" at one origin, and
/// dropping the shared prefix would splice them into an ID neither drew.
fn copies(glyphs: &[Glyph]) -> Vec<bool> {
    let mut copy = vec![false; glyphs.len()];
    let mut kept: Vec<&Glyph> = Vec::with_capacity(glyphs.len());
    // Kept glyphs by origin cell: the cell's newest glyph, then each glyph's
    // older neighbour in `next` (a chain through one flat array, no Vec per
    // cell). Sized once, so it never rehashes.
    let mut head = Cells::with_capacity(glyphs.len());
    let mut next: Vec<u32> = Vec::with_capacity(glyphs.len());
    // Bit `L - MIN_LEVEL` set once a glyph is indexed on level L.
    let mut levels: u128 = 0;
    let mut recent: Vec<(usize, usize)> = Vec::with_capacity(RECENT_RUNS);
    let mut start = 0;
    while start < glyphs.len() {
        let run = glyphs[start].run;
        let end = glyphs[start..]
            .iter()
            .position(|g| g.run != run)
            .map_or(glyphs.len(), |n| start + n);
        // Faux bold: the whole text object again, a little off, in any font. Two glyphs at least: a lone glyph near its twin is often
        // real text (see the per-glyph bound below).
        let span = &glyphs[start..end];
        let shown = || span.iter().filter(|g| !g.text.is_empty() && !g.is_space());
        let repeats = shown().count() >= 2
            && recent.iter().any(|&(s, e): &(usize, usize)| {
                let earlier = || {
                    glyphs[s..e]
                        .iter()
                        .filter(|g| !g.text.is_empty() && !g.is_space())
                };
                let (a, b) = (shown().next(), earlier().next());
                a.zip(b).is_some_and(|(a, b)| {
                    (a.origin - b.origin).hypot2() < (a.em.min(b.em) * WHOLE_RUN_COPY).powi(2)
                }) && shown().map(|g| &g.text).eq(earlier().map(|g| &g.text))
            });
        if repeats {
            copy[start..end].fill(true);
            start = end;
            continue;
        }
        if recent.len() == RECENT_RUNS {
            recent.remove(0);
        }
        recent.push((start, end));
        let mut over_another = false;
        for i in start..end {
            let g = &glyphs[i];
            // A copy lands on or behind the last kept glyph; text that moves
            // forward never pays for the scan.
            let advanced = kept
                .last()
                .is_some_and(|p| (g.origin - p.origin).dot(p.dir) >= p.advance * 0.5);
            let mut same = false;
            let mut different = false;
            if !over_another && !advanced && !g.text.is_empty() {
                let mut rest = levels;
                while rest != 0 && !same {
                    let l = rest.trailing_zeros() as i32 + MIN_LEVEL;
                    rest &= rest - 1;
                    let (cx, cy) = cell(g.origin, l);
                    'scan: for x in cx.saturating_sub(1)..=cx.saturating_add(1) {
                        for y in cy.saturating_sub(1)..=cy.saturating_add(1) {
                            let mut c = head.get(cell_key(l, x, y));
                            // A cell holds a glyph or two; the cap keeps thousands of
                            // different glyphs stacked on one point (only a hostile
                            // file draws that) linear.
                            let mut steps = 0;
                            while c != NONE && steps < FAKE_BOLD_CHAIN {
                                steps += 1;
                                let k = kept[c as usize];
                                let d2 = (g.origin - k.origin).hypot2();
                                let em = k.em.min(g.em);
                                // Zero-width glyphs (`Tz 0`) share one origin and are not copies.
                                if d2 < (em * 0.07).powi(2) && k.text == g.text && k.font == g.font
                                {
                                    same = true;
                                    break 'scan;
                                } else if d2 < (em * 0.07).powi(2)
                                    && k.text != g.text
                                    && k.run != g.run
                                    && !k.is_space()
                                    && !g.is_space()
                                {
                                    different = true;
                                }
                                c = next[c as usize];
                            }
                        }
                    }
                }
            }
            if !same && different {
                over_another = true;
                copy[start..i].fill(false);
            }
            if same && !over_another {
                copy[i] = true;
                continue;
            }
            // Only glyphs with width are indexed (zero-width ones are not copies).
            let at = kept.len() as u32;
            next.push(if g.advance > 0.0 {
                let l = level(g.em);
                levels |= 1 << (l - MIN_LEVEL);
                let (x, y) = cell(g.origin, l);
                head.replace(cell_key(l, x, y), at)
            } else {
                NONE
            });
            kept.push(g);
        }
        start = end;
    }
    copy
}

/// Chars, generated spaces and breaks, words, and the fonts and runs the
/// chars use, renumbered in the order they first appear.
pub(crate) fn build_page(glyphs: &[Glyph], fonts: &[Font], runs: &[Run]) -> TextPage {
    // Room for the usual few generated spaces and breaks; a page that needs
    // more regrows once.
    let mut chars: Vec<Char> = Vec::with_capacity(glyphs.len() + glyphs.len() / 4 + 16);
    let mut kept: Vec<&Glyph> = Vec::with_capacity(glyphs.len());
    let copies = copies(glyphs);
    for (g, _) in glyphs.iter().zip(&copies).filter(|(_, copy)| !**copy) {
        if let Some(&p) = kept.last() {
            let d = g.origin - p.origin;
            // Superscripts and subscripts shift by a fraction of the larger size.
            let shift = d.dot(p.up).abs();
            let em = p.em.min(g.em);
            let along = d.dot(p.dir);
            let gap = along - p.advance;
            // Letter spacing is no gap between words, so "Doc" under a 0.2 em
            // `Tc` stays one word. Only within a run: the next run is placed
            // on its own, and a scan's text layer sets a word per run. It can
            // only remove a space: a TJ that cancels `Tc` leaves no gap at all.
            let tracking = if p.run == g.run {
                p.char_space.max(0.0)
            } else {
                0.0
            };
            // A right-to-left run drawn in logical order: each glyph left of the last.
            let back = -along - g.advance;
            let both_rtl = p.dir() == Dir::Rtl && g.dir() == Dir::Rtl;
            let spaced = !p.is_space() && !g.is_space();
            if g.dir.dot(p.dir) <= 0.95
                || shift > p.em.max(g.em) * LINE_SHIFT
                || (gap < -em * 4.0 && !(both_rtl && back > -em))
            {
                let same_way = g.dir.dot(p.dir) > 0.95
                    && shift > p.em.max(g.em) * LINE_SHIFT
                    && g.dir() != Dir::Rtl;
                if !(same_way && join_hyphenated(&mut chars, g))
                    && chars.last().is_none_or(|c| c.text != "\n")
                {
                    chars.push(generated("\n", p));
                }
            } else if spaced
                && (gap - tracking > em * SPACE_GAP || (both_rtl && back > em * SPACE_GAP))
            {
                chars.push(generated(" ", p));
            }
        }
        let flags = if g.text.is_empty() { CHAR_UNMAPPED } else { 0 };
        chars.push(Char {
            class: g.class,
            text: g.text.clone(),
            code: g.code,
            bbox: g.tight.unwrap_or(g.bbox),
            flags,
            em: g.em as f32,
            tf: g.tf,
            h_scale: g.h_scale,
            angle: g.angle,
            fill: g.fill,
            font: g.font as i32,
            run: g.run as i32,
            along: g.origin.to_vec2().dot(g.dir) as f32,
        });
        kept.push(g);
    }

    close_lines(&mut chars);
    for line in chars.split_mut(|c| c.text == "\n") {
        logical_order(line);
    }
    let ((fonts, font_order), (runs, _)) = (
        renumber(&mut chars, fonts, |c| &mut c.font),
        renumber(&mut chars, runs, |c| &mut c.run),
    );

    let mut words = Vec::new();
    let mut start: Option<usize> = None;
    let close = |start: usize, end: usize, chars: &[Char], words: &mut Vec<Word>| {
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for c in &chars[start..end] {
            x0 = x0.min(c.bbox[0]);
            y0 = y0.min(c.bbox[1]);
            x1 = x1.max(c.bbox[0] + c.bbox[2]);
            y1 = y1.max(c.bbox[1] + c.bbox[3]);
        }
        words.push(Word {
            start: start as u32,
            end: end as u32,
            bbox: [x0, y0, x1 - x0, y1 - y0],
        });
    };
    for (i, c) in chars.iter().enumerate() {
        let breaks = c.is_space() || c.text.is_empty();
        match (start, breaks) {
            (Some(s), true) => {
                close(s, i, &chars, &mut words);
                start = None;
            }
            (None, false) => start = Some(i),
            _ => {}
        }
    }
    if let Some(s) = start {
        close(s, chars.len(), &chars, &mut words);
    }
    TextPage {
        truncated: false,
        chars,
        words,
        fonts,
        runs,
        font_order,
    }
}

/// A line that ends in `-` or a soft
/// hyphen after a letter, before a line that starts with a letter or digit,
/// is one hyphenated word. The hyphen becomes U+0002 (read as a visible
/// hyphen), trailing spaces go, and no break is
/// generated. Without it a soft hyphen reads as invisible: "to-be­\nmarketed".
fn join_hyphenated(chars: &mut Vec<Char>, next: &Glyph) -> bool {
    let end = chars
        .iter()
        .rposition(|c| c.text != " ")
        .map_or(0, |i| i + 1);
    let [.., before, hyphen] = &chars[..end] else {
        return false;
    };
    let alpha = |t: &str| t.chars().next().is_some_and(char::is_alphabetic);
    if !(hyphen.text == "-" || hyphen.text == "\u{ad}")
        || !alpha(&before.text)
        || !next.text.chars().next().is_some_and(char::is_alphanumeric)
    {
        return false;
    }
    chars.truncate(end);
    if let Some(h) = chars.last_mut() {
        h.text = "\u{2}".into();
    }
    true
}

/// Before the bidi pass: on each line a
/// run of U+0020 spaces (the PDF's own or generated) keeps only its first,
/// and a line of two or more chars drops a trailing space. Word pads columns
/// with dozens of spaces and ends lines on one.
fn close_lines(chars: &mut Vec<Char>) {
    let mut write = 0;
    let mut line_start = 0;
    let mut prev_space = false;
    for read in 0..chars.len() {
        let space = chars[read].text == " ";
        if chars[read].text == "\n" {
            if prev_space && write - line_start > 1 {
                write -= 1;
                // The break goes after the last char kept.
                let [x, _, w, _] = chars[write - 1].bbox;
                chars[read].bbox[0] = x + w;
            }
            if write != read {
                chars.swap(write, read);
            }
            write += 1;
            line_start = write;
            prev_space = false;
            continue;
        }
        if space && prev_space {
            continue;
        }
        prev_space = space;
        if write != read {
            chars.swap(write, read);
        }
        write += 1;
    }
    if prev_space && write - line_start > 1 {
        write -= 1;
    }
    chars.truncate(write);
}

/// Renumbers one id column in order of first appearance, keeping only the
/// table entries some char uses; an id with no entry becomes -1.
fn renumber<T: Clone>(
    chars: &mut [Char],
    table: &[T],
    id: impl Fn(&mut Char) -> &mut i32,
) -> (Vec<T>, Vec<u32>) {
    let mut new_id = vec![-1i32; table.len()];
    let mut out = Vec::new();
    let mut from = Vec::new();
    for c in chars {
        let slot = id(c);
        if *slot < 0 {
            continue;
        }
        *slot = match new_id.get_mut(*slot as usize) {
            Some(n) if *n >= 0 => *n,
            Some(n) => {
                *n = out.len() as i32;
                out.push(table[*slot as usize].clone());
                from.push(*slot as u32);
                *n
            }
            None => -1,
        };
    }
    (out, from)
}

#[derive(Clone, Copy, PartialEq)]
#[repr(u8)]
enum Dir {
    Rtl,
    Ltr,
    Number,
    /// Currency, percent and the like: they travel with an adjacent number.
    Terminator,
    Neutral,
}

const SPACE: u8 = 0x80;

/// A text's direction and whether it is all whitespace, packed in one byte.
fn classify(text: &Text) -> u8 {
    // One ASCII char (most glyphs): a table read.
    if let [b] = text.as_bytes()
        && b.is_ascii()
    {
        return ASCII_CLASS[usize::from(*b)];
    }
    dir_of(text) as u8 | if is_space(text) { SPACE } else { 0 }
}

/// `classify` for each one-byte ASCII text, built at compile time.
const ASCII_CLASS: [u8; 128] = {
    let mut table = [0u8; 128];
    let mut b = 0;
    while b < 128 {
        let c = b as u8;
        let dir = if c.is_ascii_digit() {
            Dir::Number
        } else if matches!(c, b'%' | b'$' | b'#' | b'+') {
            Dir::Terminator
        } else if c.is_ascii_alphabetic() {
            Dir::Ltr
        } else {
            Dir::Neutral
        };
        // char::is_whitespace for ASCII: \t \n \v \f \r and space.
        let space = matches!(c, b'\t' | b'\n' | 0x0B | 0x0C | b'\r' | b' ');
        table[b] = dir as u8 | if space { SPACE } else { 0 };
        b += 1;
    }
    table
};

impl Dir {
    fn from_class(class: u8) -> Dir {
        match class & 0x7F {
            0 => Dir::Rtl,
            1 => Dir::Ltr,
            2 => Dir::Number,
            3 => Dir::Terminator,
            _ => Dir::Neutral,
        }
    }
}

trait Classed {
    fn class(&self) -> u8;
    fn dir(&self) -> Dir {
        Dir::from_class(self.class())
    }
    fn is_space(&self) -> bool {
        self.class() & SPACE != 0
    }
}

impl Classed for Glyph {
    fn class(&self) -> u8 {
        self.class
    }
}

impl Classed for Char {
    fn class(&self) -> u8 {
        self.class
    }
}

fn dir_of(text: &Text) -> Dir {
    let Some(c) = text.first() else {
        return Dir::Neutral;
    };
    if c.is_numeric() {
        // Before the RTL ranges: Arabic-Indic digits read left to right.
        return Dir::Number;
    }
    match c {
        '%' | '$' | '#' | '+' | '°' | '‰' | '٪' | '¢' | '£' | '¥' | '€' | '₪' => {
            return Dir::Terminator;
        }
        _ => {}
    }
    match c as u32 {
        0x0590..=0x08FF
        | 0xFB1D..=0xFDFF
        | 0xFE70..=0xFEFF
        | 0x10800..=0x10FFF
        | 0x1E800..=0x1EFFF => Dir::Rtl,
        _ if c.is_alphabetic() => Dir::Ltr,
        _ => Dir::Neutral,
    }
}

/// The maximal run from `i` that starts and ends on a char in `ends`, with
/// only chars in `inside` between: `[i, end]` inclusive.
fn run_end(line: &[Char], i: usize, ends: &[Dir], inside: &[Dir]) -> usize {
    let mut end = i;
    for (j, c) in line.iter().enumerate().skip(i) {
        match c.dir() {
            d if ends.contains(&d) => end = j,
            d if inside.contains(&d) => {}
            _ => break,
        }
    }
    end
}

/// A right-to-left segment in visual order to logical order: reverse it,
/// then put its left-to-right words and numbers (with their %, $ and so on)
/// back the right way round.
fn rtl_segment(seg: &mut [Char]) {
    seg.reverse();
    // Brackets that read right to left show mirrored: the glyph drawn as ")"
    // opens the parenthesis (Unicode's Bidi_Mirrored pairs). Those inside a
    // restored LTR run are flipped back with it below.
    for c in seg.iter_mut() {
        if let Some(m) = mirrored(&c.text) {
            c.text = m.into();
        }
    }
    let mut i = 0;
    while i < seg.len() {
        let d = seg[i].dir();
        if d != Dir::Ltr && d != Dir::Number {
            i += 1;
            continue;
        }
        let mut start = i;
        let mut end = ltr_run_end(seg, i);
        while start > 0 && seg[start - 1].dir() == Dir::Terminator {
            start -= 1;
        }
        while end + 1 < seg.len() && seg[end + 1].dir() == Dir::Terminator {
            end += 1;
        }
        if seg[start..=end].iter().any(|c| c.dir() == Dir::Ltr) {
            // Words (and the numbers after them, UBA W7) read as one run.
            seg[start..=end].reverse();
            for c in &mut seg[start..=end] {
                if let Some(m) = mirrored(&c.text) {
                    c.text = m.into();
                }
            }
        } else {
            number_groups(&mut seg[start..=end]);
        }
        i = end + 1;
    }
}

/// The end of the left-to-right run from `i` in a reversed RTL segment:
/// letters and numbers, and the neutrals between them. A number before a
/// word across a gap (`321 CBA`, drawn `ABC 123`) is the one place the drawn
/// order is ambiguous (a gap with a space: `ABC-123` and `ABC:12` read as
/// one run, as codes and references nearly always are). Read as one run, the number came after the word (UBA
/// W7 turns it into L); read as two, it came before it (`… 123 ABC …`, the
/// number EN, the gap taking the paragraph's direction under N1). Only the
/// file can tell: the two read as one run when one text-showing operator
/// drew both sides of the gap and everything in it, as a layout engine that
/// shaped them as one run does. Otherwise they are two runs. The split is
/// only ever before the first word: of LTR runs side by side in an RTL line,
/// all but the last (in logical order) are numbers alone, since a word
/// before a number joins it (W7). So `ABC 123 DEF` on the page is one run.
fn ltr_run_end(seg: &[Char], i: usize) -> usize {
    let mut end = i;
    let mut word = seg[i].dir() == Dir::Ltr;
    for (j, c) in seg.iter().enumerate().skip(i + 1) {
        match c.dir() {
            Dir::Ltr | Dir::Number => {
                if c.dir() == Dir::Ltr {
                    if !word
                        && seg[end + 1..j].iter().any(Char::is_space)
                        && !one_run(&seg[end..=j])
                    {
                        break;
                    }
                    word = true;
                }
                end = j;
            }
            Dir::Neutral | Dir::Terminator => {}
            Dir::Rtl => break,
        }
    }
    end
}

/// Whether one text-showing operator drew every char here that the file drew.
fn one_run(chars: &[Char]) -> bool {
    let mut drawn = chars.iter().filter(|c| c.flags & CHAR_GENERATED == 0);
    let run = drawn.next().map(|c| c.run);
    drawn.all(|c| Some(c.run) == run)
}

/// Numbers alone in right-to-left text: each number reads left to right,
/// but the numbers keep right-to-left order between them (`מאי 12, 2024`,
/// a phone number's groups). A number spans digits, its terminators, and a
/// single separator between digits (`1,234`, `3.5`, `12:30`).
fn number_groups(run: &mut [Char]) {
    let is_number = |c: &Char| matches!(c.dir(), Dir::Number | Dir::Terminator);
    let separator = |c: &Char| {
        matches!(
            &*c.text,
            "," | "." | ":" | "/" | "-" | "\u{066B}" | "\u{066C}"
        )
    };
    let mut k = 0;
    while k < run.len() {
        if !is_number(&run[k]) {
            k += 1;
            continue;
        }
        let mut g = k;
        loop {
            if g + 1 < run.len() && is_number(&run[g + 1]) {
                g += 1;
            } else if g + 2 < run.len()
                && run[g].dir() == Dir::Number
                && separator(&run[g + 1])
                && run[g + 2].dir() == Dir::Number
            {
                g += 2;
            } else {
                break;
            }
        }
        run[k..=g].reverse();
        k = g + 1;
    }
}

fn mirrored(text: &str) -> Option<&'static str> {
    Some(match text {
        "(" => ")",
        ")" => "(",
        "[" => "]",
        "]" => "[",
        "{" => "}",
        "}" => "{",
        "<" => ">",
        ">" => "<",
        "«" => "»",
        "»" => "«",
        "‹" => "›",
        "›" => "‹",
        _ => return None,
    })
}

/// Most producers (Chrome, Word) draw right-to-left text in visual order, so
/// lines are rebuilt into logical order. An RTL-base line is one RTL segment. An LTR-base line
/// converts each segment that starts and ends on an RTL letter, with the
/// numbers and neutrals inside it. A line whose RTL letters already run
/// leftward was drawn in logical order and is left alone.
fn logical_order(line: &mut [Char]) {
    let (mut rtl, mut ltr) = (0, 0);
    let (mut rightward, mut leftward) = (0, 0);
    let mut last_rtl: Option<f32> = None;
    for c in line.iter() {
        match c.dir() {
            Dir::Rtl => {
                rtl += 1;
                if let Some(at) = last_rtl {
                    if c.along > at {
                        rightward += 1;
                    } else if c.along < at {
                        leftward += 1;
                    }
                }
                last_rtl = Some(c.along);
            }
            Dir::Ltr => ltr += 1,
            _ => {}
        }
    }
    if rtl == 0 || leftward > rightward {
        return;
    }
    // The base direction: an LTR line starts and ends (visually) on LTR
    // letters, whatever it quotes; an RTL one on RTL letters. Mixed ends
    // go by the majority.
    let strong = |c: &Char| match c.dir() {
        d @ (Dir::Ltr | Dir::Rtl) => Some(d),
        _ => None,
    };
    let first = line.iter().find_map(strong);
    let last = line.iter().rev().find_map(strong);
    let rtl_base = match (first, last) {
        (Some(Dir::Ltr), Some(Dir::Ltr)) => false,
        (Some(Dir::Rtl), Some(Dir::Rtl)) => true,
        _ => rtl > ltr,
    };
    if rtl_base {
        rtl_segment(line);
        return;
    }
    let mut i = 0;
    while i < line.len() {
        if line[i].dir() != Dir::Rtl {
            i += 1;
            continue;
        }
        let end = run_end(
            line,
            i,
            &[Dir::Rtl],
            &[Dir::Neutral, Dir::Number, Dir::Terminator],
        );
        rtl_segment(&mut line[i..=end]);
        i = end + 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn in_run(mut g: Glyph, run: usize) -> Glyph {
        g.run = run as u32;
        g
    }

    fn at(text: &str, x: f64, y: f64, size: f64) -> Glyph {
        // Viewer frame: y grows down, so glyph "up" is -y.
        let t = Affine::new([size / 1000.0, 0.0, 0.0, -size / 1000.0, x, y]);
        glyph_from(t, text.into(), 500.0, false, (ASCENT, DESCENT)).unwrap()
    }

    /// The cells' table answers as a map does, through collisions and replacements.
    #[test]
    fn cells_answer_as_a_map_does() {
        let mut map = std::collections::HashMap::new();
        let mut cells = Cells::with_capacity(5000);
        let mut seed = 7u64;
        for i in 0..5000u32 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            // Few distinct keys, so most inserts replace one; keys that share low bits collide.
            let key = cell_key((seed >> 60) as i32 - 8, (seed >> 40 & 15) as i32 * 1024, (seed >> 20 & 7) as i32);
            assert_eq!(cells.get(key), map.get(&key).copied().unwrap_or(NONE));
            assert_eq!(cells.replace(key, i), map.insert(key, i).unwrap_or(NONE));
        }
    }

    #[test]
    fn spaces_lines_and_words() {
        let page = build(vec![
            at("a", 10.0, 100.0, 10.0),
            at("b", 15.0, 100.0, 10.0), // touching: same word
            at("c", 25.0, 100.0, 10.0), // 5pt gap: generated space
            at("d", 10.0, 120.0, 10.0), // next line
        ]);
        assert_eq!(page.text(), "ab c\nd");
        let words: Vec<String> = page.words.iter().map(|w| page.word_text(w)).collect();
        assert_eq!(words, ["ab", "c", "d"]);
        let ab = &page.words[0].bbox;
        assert_eq!((ab[0], ab[2]), (10.0, 10.0));
        // Box spans 0.8em above to 0.2em below the baseline.
        assert!((ab[1] - 92.0).abs() < 1e-4 && (ab[3] - 10.0).abs() < 1e-4);
        assert_eq!(page.chars[2].flags, CHAR_GENERATED);
    }

    fn line(visual: &str) -> String {
        let glyphs = visual
            .chars()
            .enumerate()
            .map(|(i, c)| at(&c.to_string(), 10.0 + 5.0 * i as f64, 100.0, 10.0))
            .collect();
        build(glyphs).text()
    }

    #[test]
    fn rtl_lines_read_in_logical_order() {
        // Drawn left to right on the page, as Chrome and Word emit it.
        assert_eq!(line("םולש"), "שלום");
        // RTL base with a number: the digits keep their own order.
        assert_eq!(line("2024 תנש"), "שנת 2024");
        // LTR base with an RTL word inside.
        assert_eq!(line("see םולש now"), "see שלום now");
    }

    #[test]
    fn rtl_numbers_symbols_and_digits() {
        // Arabic-Indic digits keep their order inside RTL text.
        assert_eq!(line("٢٠٢٤ مسق"), "قسم ٢٠٢٤");
        // Percent and currency stay with their number.
        assert_eq!(line("50% םולש"), "שלום 50%");
        assert_eq!(line("$100 םולש"), "שלום $100");
        // On an LTR line a number inside a Hebrew phrase stays inside it.
        assert_eq!(
            line("see this םולש 2024 תנש now"),
            "see this שנת 2024 שלום now"
        );
    }

    #[test]
    fn rtl_number_groups_keep_rtl_order() {
        assert_eq!(line("2024 ,12 יאמ"), "מאי 12, 2024");
        assert_eq!(line("4567 123 050 ןופלט"), "טלפון 050 123 4567");
        // One number with its separators and terminator stays whole.
        assert_eq!(line("1,234.5% ךס"), "סך 1,234.5%");
        // A word and the number after it read as one run.
        assert_eq!(line("תכרעמ Windows 11 לש"), "של Windows 11 מערכת");
    }

    /// A line drawn left to right as `pieces`, one text-showing operator each.
    fn runs(pieces: &[&str]) -> String {
        let mut glyphs = Vec::new();
        for (run, piece) in pieces.iter().enumerate() {
            for c in piece.chars() {
                let x = 10.0 + 5.0 * glyphs.len() as f64;
                glyphs.push(in_run(at(&c.to_string(), x, 100.0, 10.0), run));
            }
        }
        build(glyphs).text()
    }

    #[test]
    fn rtl_latin_and_number_shown_apart_keep_their_logical_order() {
        // "هذه الاتفاقية 123 ABC سارية": in an RTL paragraph the number and
        // the word after it are two LTR runs (W7 needs a strong L before the
        // digits), so on the page the word sits left of the number. Shown as
        // separate runs, they read back right to left: 123, then ABC.
        assert_eq!(
            runs(&["ةيراس", " ", "ABC", " ", "123", " ", "ةيقافتالا هذه"]),
            "هذه الاتفاقية 123 ABC سارية"
        );
        assert_eq!(
            runs(&["ףקותב", " ", "ABC", " ", "123", " ", "םכסה"]),
            "הסכם 123 ABC בתוקף"
        );
        // One run from the word through the number: they were laid out as one
        // LTR run, "ABC 123" (W7), and stay so.
        assert_eq!(
            runs(&["ףקותב ", "ABC 123", " םכסה"]),
            "הסכם ABC 123 בתוקף"
        );
        // Words and numbers shown apart: Latin words with only neutrals
        // between them are one LTR run whatever drew them (N1), numbers keep
        // RTL order between them.
        assert_eq!(
            runs(&["ةيراس", " ", "DEF", " ", "ABC", " ", "456", " ", "123", " ", "هذه"]),
            "هذه 123 456 DEF ABC سارية"
        );
        // Joined by a hyphen or slash, not a space: one run, as codes are.
        assert_eq!(
            runs(&["ףקותב", " ", "ABC", "-", "123", " ", "םכסה"]),
            "הסכם ABC-123 בתוקף"
        );
        // A number between two words can't stand apart: the word before it
        // would have joined it (W7). One LTR run, however it was drawn.
        assert_eq!(
            runs(&["ףקותב", " ", "ABC", " ", "123", " ", "DEF", " ", "םכסה"]),
            "הסכם ABC 123 DEF בתוקף"
        );
    }

    #[test]
    fn ltr_line_quoting_a_long_rtl_name_keeps_its_ends() {
        assert_eq!(
            line("Supplier: מ\"עב תופורת תרבח Ltd"),
            "Supplier: חברת תרופות בע\"מ Ltd"
        );
    }

    #[test]
    fn rtl_brackets_are_mirrored() {
        // Drawn as the shapes "(2026) ףקותב": logically "בתוקף (2026)".
        assert_eq!(line("(2026) ףקותב"), "בתוקף (2026)");
        assert_eq!(line("(םולש)"), "(שלום)");
    }

    #[test]
    fn rtl_drawn_in_logical_order_is_kept() {
        // שלום עולם drawn leftward, a 3pt gap and no space glyph between words.
        let mut glyphs = Vec::new();
        let mut x = 100.0;
        for (i, c) in "שלוםעולם".chars().enumerate() {
            x -= 5.0;
            if i == 4 {
                x -= 3.0;
            }
            glyphs.push(at(&c.to_string(), x, 100.0, 10.0));
        }
        assert_eq!(build(glyphs).text(), "שלום עולם");
    }

    #[test]
    fn superscripts_stay_on_the_line() {
        let mut glyphs: Vec<Glyph> = "word"
            .chars()
            .enumerate()
            .map(|(i, c)| at(&c.to_string(), 10.0 + 5.0 * i as f64, 100.0, 10.0))
            .collect();
        glyphs.push(at("1", 30.0, 96.7, 6.5)); // footnote marker, raised 3.3pt
        glyphs.push(at("n", 38.0, 100.0, 10.0));
        assert_eq!(build(glyphs).text(), "word1 n");
    }

    #[test]
    fn vertical_text_is_one_line() {
        let glyphs = "日本語"
            .chars()
            .enumerate()
            .map(|(i, c)| {
                let t = Affine::new([0.01, 0.0, 0.0, -0.01, 50.0, 100.0 + 10.0 * i as f64]);
                glyph_from(t, Text::from_char(c), 1000.0, true, (ASCENT, DESCENT)).unwrap()
            })
            .collect();
        assert_eq!(build(glyphs).text(), "日本語");
    }

    #[test]
    fn letter_spacing_is_no_word_gap_within_a_run() {
        // 10pt glyphs 5pt wide, drawn 7pt apart: 0.2 em past the advance.
        let spaced = |char_space: f64, run_of: fn(usize) -> u32| {
            let glyphs = "Doc"
                .chars()
                .enumerate()
                .map(|(i, c)| {
                    let t = Affine::new([0.01, 0.0, 0.0, -0.01, 10.0 + 7.0 * i as f64, 100.0]);
                    let mut g = glyph_from(t, Text::from_char(c), 500.0, false, (ASCENT, DESCENT)).unwrap();
                    g.char_space = char_space;
                    g.run = run_of(i);
                    g
                })
                .collect();
            build(glyphs).text()
        };
        assert_eq!(spaced(2.0, |_| 0), "Doc");
        assert_eq!(spaced(0.0, |_| 0), "D o c");
        // A scan's text layer places each run itself: the gap to the next is real.
        assert_eq!(spaced(2.0, |i| i as u32), "D o c");
        // A TJ cancelling `Tc` draws them tight (the 5pt advance apart here is
        // not, so measure from a gapless line): a negative `Tc` adds no space.
        let tight: Vec<_> = "Doc"
            .chars()
            .enumerate()
            .map(|(i, c)| {
                let t = Affine::new([0.01, 0.0, 0.0, -0.01, 10.0 + 5.0 * i as f64, 100.0]);
                let mut g = glyph_from(t, Text::from_char(c), 500.0, false, (ASCENT, DESCENT)).unwrap();
                g.char_space = -3.0;
                g
            })
            .collect();
        assert_eq!(build(tight).text(), "Doc");
    }

    #[test]
    fn degenerate_transforms() {
        // Past f32: dropped rather than reported with infinite boxes.
        let huge = Affine::new([1e36, 0.0, 0.0, -1e36, 0.0, 0.0]);
        assert!(glyph_from(huge, "a".into(), 500.0, false, (ASCENT, DESCENT)).is_none());
        // Tz 0: kept, with no width.
        let flat = Affine::new([0.0, 0.0, 0.0, -0.01, 10.0, 100.0]);
        let g = glyph_from(flat, "a".into(), 500.0, false, (ASCENT, DESCENT)).unwrap();
        assert_eq!(g.bbox[2], 0.0);
        let squeezed = "squeezed"
            .chars()
            .map(|c| glyph_from(flat, Text::from_char(c), 500.0, false, (ASCENT, DESCENT)).unwrap())
            .collect();
        assert_eq!(build(squeezed).text(), "squeezed");
    }

    #[test]
    fn fake_bold_string_is_drawn_once() {
        let mut glyphs = Vec::new();
        for (run, dx) in [0.0, 0.3].into_iter().enumerate() {
            for (i, c) in "Important".chars().enumerate() {
                glyphs.push(in_run(
                    at(&c.to_string(), 10.0 + dx + 5.0 * i as f64, 100.0, 10.0),
                    run,
                ));
            }
        }
        assert_eq!(build(glyphs).text(), "Important");
    }

    #[test]
    fn ascii_class_table_matches_the_general_path() {
        for b in 0u8..128 {
            let t = Text::from_char(char::from(b));
            assert_eq!(
                classify(&t),
                dir_of(&t) as u8 | if is_space(&t) { SPACE } else { 0 },
                "byte {b}"
            );
        }
    }

    #[test]
    fn fake_bold_line_longer_than_any_window_is_drawn_once() {
        let line: String = "abcdefghij".repeat(30);
        let mut glyphs = Vec::new();
        for (run, dx) in [0.0, 0.3].into_iter().enumerate() {
            for (i, c) in line.chars().enumerate() {
                glyphs.push(in_run(
                    at(&c.to_string(), 10.0 + dx + 5.0 * i as f64, 100.0, 10.0),
                    run,
                ));
            }
        }
        assert_eq!(build(glyphs).text(), line);
    }

    #[test]
    fn a_copy_lands_in_the_three_by_three_cells_of_its_level() {
        // Any copy within a tenth of an em sits within one cell of the original
        // on the original's level, at every size and position.
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rand = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..200_000 {
            let em = 2f64.powf(rand() * 40.0 - 20.0);
            let p = Point::new((rand() - 0.5) * 2e4, (rand() - 0.5) * 2e4);
            let (r, a) = (rand() * em * 0.1, rand() * std::f64::consts::TAU);
            let q = p + Vec2::new(r * a.cos(), r * a.sin());
            let ((px, py), (qx, qy)) = (cell(p, level(em)), cell(q, level(em)));
            assert!(
                (px - qx).abs() <= 1 && (py - qy).abs() <= 1,
                "em {em} {p:?} {q:?}"
            );
        }
    }

    #[test]
    fn fake_bold_tiny_and_huge_text_is_drawn_once() {
        // Thumbnails redraw whole blocks at a fraction of a point; posters
        // draw letters thousands of points tall.
        for size in [0.3, 3000.0] {
            let line: String = "abcdefghij".repeat(30);
            let mut glyphs = Vec::new();
            for (run, dx) in [0.0, size * 0.03].into_iter().enumerate() {
                for (i, c) in line.chars().enumerate() {
                    glyphs.push(in_run(
                        at(&c.to_string(), dx + size * 0.5 * i as f64, 100.0, size),
                        run,
                    ));
                }
            }
            assert_eq!(build(glyphs).text(), line, "size {size}");
        }
    }

    #[test]
    fn space_runs_collapse_and_lines_drop_a_trailing_space() {
        // "a", three spaces, "b", a space; next line a lone space.
        let page = build(vec![
            at("a", 10.0, 100.0, 10.0),
            at(" ", 15.0, 100.0, 10.0),
            at(" ", 20.0, 100.0, 10.0),
            at(" ", 25.0, 100.0, 10.0),
            at("b", 30.0, 100.0, 10.0),
            at(" ", 35.0, 100.0, 10.0),
            at(" ", 10.0, 80.0, 10.0),
        ]);
        assert_eq!(page.text(), "a b\n ");
    }

    #[test]
    fn fake_bold_is_drawn_once() {
        let page = build(vec![
            at("a", 10.0, 100.0, 10.0),
            in_run(at("a", 10.3, 100.0, 10.0), 1),
        ]);
        assert_eq!(page.text(), "a");
    }

    #[test]
    fn a_line_end_hyphen_joins_the_word() {
        let line = |text: &str, y: f64| -> Vec<Glyph> {
            text.chars()
                .enumerate()
                .map(|(i, c)| at(&c.to_string(), 10.0 + 5.0 * i as f64, y, 10.0))
                .collect()
        };
        for hyphen in ["-", "\u{ad}"] {
            let glyphs = [
                line(&format!("to-be{hyphen} "), 100.0),
                line("marketed", 120.0),
            ]
            .into_iter()
            .flatten()
            .collect();
            assert_eq!(build(glyphs).text(), "to-be\u{2}marketed");
        }
        // Not after a letter, or before a non-alphanumeric: a plain break.
        let glyphs = [line("18-", 100.0), line("40", 120.0)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(build(glyphs).text(), "18-\n40");
        let glyphs = [line("a-", 100.0), line("(b)", 120.0)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(build(glyphs).text(), "a-\n(b)");
    }

    #[test]
    fn a_copy_with_a_trailing_space_or_more_text_is_still_a_copy() {
        let run = |text: &str, run: usize| -> Vec<Glyph> {
            text.chars()
                .enumerate()
                .map(|(i, c)| in_run(at(&c.to_string(), 10.0 + 5.0 * i as f64, 100.0, 10.0), run))
                .collect()
        };
        // A grey shadow, then the text with a space: "N=647" must not become "N=6477".
        let glyphs = [run("N=647", 0), run("N=647 ", 1)]
            .into_iter()
            .flatten()
            .collect();
        assert_eq!(build(glyphs).text().trim_end(), "N=647");
        let glyphs = [run("Hello", 0), run("Hello world", 1)]
            .into_iter()
            .flatten()
            .collect();
        assert_eq!(build(glyphs).text(), "Hello world");
        // Both copies in one TJ.
        let glyphs = [run("Hello", 0), run("Hello", 0)]
            .into_iter()
            .flatten()
            .collect();
        assert_eq!(build(glyphs).text(), "Hello");
    }

    #[test]
    fn a_near_neighbour_is_not_a_copy() {
        // OCR layers squeeze words: "≥" read as "2" just before "20%" must not
        // turn 20% into 0%. The tolerance is 0.07 em, in the same font.
        let page = build(vec![
            at("2", 10.0, 100.0, 10.0),
            in_run(at("2", 10.8, 100.0, 10.0), 1),
            in_run(at("0", 15.8, 100.0, 10.0), 1),
        ]);
        assert_eq!(page.text(), "220");
        let mut other_font = in_run(at("a", 10.3, 100.0, 10.0), 1);
        other_font.font = 1;
        assert_eq!(
            build(vec![at("a", 10.0, 100.0, 10.0), other_font]).text(),
            "aa"
        );
    }

    #[test]
    fn a_whole_run_redrawn_a_little_off_or_in_another_font_is_a_copy() {
        let run = |text: &str, run: usize, dx: f64, size: f64, font: u32| -> Vec<Glyph> {
            text.chars()
                .enumerate()
                .map(|(i, c)| {
                    let mut g = in_run(
                        at(
                            &c.to_string(),
                            10.0 + dx + size * 0.5 * i as f64,
                            100.0,
                            size,
                        ),
                        run,
                    );
                    g.font = font;
                    g
                })
                .collect()
        };
        // 0.5pt on 6pt text: past the per-glyph bound.
        let glyphs = [
            run("Quarterly", 0, 0.0, 6.0, 0),
            run("Quarterly", 1, 0.5, 6.0, 0),
        ];
        assert_eq!(
            build(glyphs.into_iter().flatten().collect()).text(),
            "Quarterly"
        );
        let glyphs = [
            run("Heading", 0, 0.0, 10.0, 0),
            run("Heading", 1, 0.3, 10.0, 1),
        ];
        assert_eq!(
            build(glyphs.into_iter().flatten().collect()).text(),
            "Heading"
        );
        // A stamp a little off the first still is not a copy.
        let glyphs = [
            run("ID: 4111", 0, 0.0, 10.0, 0),
            run("ID: 4222", 1, 0.5, 10.0, 0),
        ];
        let text = build(glyphs.into_iter().flatten().collect()).text();
        assert!(text.contains("4111") && text.contains("4222"), "{text}");
    }

    #[test]
    fn a_stamp_drawn_over_a_different_stamp_keeps_both() {
        // A document stamped "Document ID: …" twice at one origin; the
        // shared prefix is not a copy of the first stamp.
        let mut glyphs = Vec::new();
        for (run, id) in ["Document ID: 4111111", "Document ID: 4222222"]
            .into_iter()
            .enumerate()
        {
            for (i, c) in id.chars().enumerate() {
                glyphs.push(in_run(
                    at(&c.to_string(), 10.0 + 5.0 * i as f64, 100.0, 10.0),
                    run,
                ));
            }
        }
        let text = build(glyphs).text();
        assert!(
            text.contains("4111111") && text.contains("4222222"),
            "{text}"
        );
    }

    #[test]
    fn unmapped_glyphs_split_words() {
        let page = build(vec![
            at("a", 10.0, 100.0, 10.0),
            at("", 15.0, 100.0, 10.0),
            at("b", 20.0, 100.0, 10.0),
        ]);
        assert_eq!(page.chars[1].flags, CHAR_UNMAPPED);
        assert_eq!(page.words.len(), 2);
    }
}
