//! recto: what to draw for an annotation that has no appearance stream, from its dictionary, as
//! pdf.js, pdfium and poppler do: markup, shapes, ink, and a free text box's lines. A content stream
//! is written and run through the interpreter, so it clips, transforms and blends like any other.

use crate::context::Context;
use crate::device::Device;
use crate::interpret::interpret;
use crate::types::BlendMode;
use core::cell::Cell;
use core::fmt::Write;
use hayro_syntax::content::TypedIter;
use hayro_syntax::object::dict::keys::{RECT, SUBTYPE};
use hayro_syntax::object::{Array, Dict, Name, Rect};
use hayro_syntax::page::Resources;
use hayro_syntax::reader::{Reader, ReaderContext, ReaderExt};

/// How many points and lines all of a page's annotations with no appearance may draw. Far more than
/// a real page has; each of a list's items can ask for thousands, and the same one can be listed
/// thousands of times, so a cap on one list leaves gigabytes of stream.
pub(crate) const PAGE_POINTS: usize = 1 << 19;

fn spend(left: &Cell<usize>, amount: usize) {
    left.set(left.get().saturating_sub(amount));
}

fn numbers(array: &Array<'_>, left: &Cell<usize>) -> Vec<f64> {
    let out: Vec<f64> = array.iter::<f64>().take(left.get().saturating_mul(2)).collect();
    spend(left, out.len().div_ceil(2));
    out
}

/// A colour-setting operator from `/C` or `/IC`: None for none, or an empty array, which is
/// transparent.
fn colour_op(values: &[f64], stroke: bool) -> Option<String> {
    let op = match (values.len(), stroke) {
        (1, true) => "G",
        (1, false) => "g",
        (3, true) => "RG",
        (3, false) => "rg",
        (4, true) => "K",
        (4, false) => "k",
        _ => return None,
    };
    let mut out = String::new();
    for value in values {
        let _ = write!(out, "{value} ");
    }
    let _ = writeln!(out, "{op}");
    Some(out)
}

/// The width and dash `/BS`, or else `/Border`, gives a stroke.
fn border(annot: &Dict<'_>, left: &Cell<usize>) -> (f64, String) {
    if let Some(style) = annot.get::<Dict<'_>>(&b"BS"[..]) {
        let width = style.get::<f64>(&b"W"[..]).unwrap_or(1.0);
        let dashed = style.get::<Name<'_>>(&b"S"[..]).is_some_and(|s| s.as_ref() == b"D");
        let dash = if dashed {
            let values = style.get::<Array<'_>>(&b"D"[..]).map(|d| numbers(&d, left)).unwrap_or_else(|| vec![3.0]);
            dash_op(&values)
        } else {
            String::new()
        };
        return (width, dash);
    }
    if let Some(array) = annot.get::<Array<'_>>(&b"Border"[..]) {
        let width = array.iter::<f64>().nth(2).unwrap_or(1.0);
        let dash = array.iter::<Array<'_>>().next().map(|d| dash_op(&numbers(&d, left))).unwrap_or_default();
        return (width, dash);
    }
    (1.0, String::new())
}

fn dash_op(values: &[f64]) -> String {
    let mut out = String::from("[");
    for value in values.iter().take(16) {
        let _ = write!(out, "{value} ");
    }
    out.push_str("] 0 d\n");
    out
}

fn polyline(out: &mut String, points: &[f64]) {
    for (i, point) in points.chunks_exact(2).enumerate() {
        let _ = writeln!(out, "{} {} {}", point[0], point[1], if i == 0 { "m" } else { "l" });
    }
}

/// Four Bézier arcs in the rectangle, for `Circle`.
fn ellipse(out: &mut String, x0: f64, y0: f64, x1: f64, y1: f64) {
    const K: f64 = 0.552_284_75;
    let (cx, cy, rx, ry) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0, (x1 - x0) / 2.0, (y1 - y0) / 2.0);
    let (kx, ky) = (rx * K, ry * K);
    let _ = writeln!(out, "{} {cy} m", cx + rx);
    let _ = writeln!(out, "{} {} {} {} {cx} {} c", cx + rx, cy + ky, cx + kx, cy + ry, cy + ry);
    let _ = writeln!(out, "{} {} {} {} {} {cy} c", cx - kx, cy + ry, cx - rx, cy + ky, cx - rx);
    let _ = writeln!(out, "{} {} {} {} {cx} {} c", cx - rx, cy - ky, cx - kx, cy - ry, cy - ry);
    let _ = writeln!(out, "{} {} {} {} {} {cy} c", cx + kx, cy - ry, cx + rx, cy - ky, cx + rx);
    out.push_str("h\n");
}

/// `/Contents` as single-byte text for a standard font: PDFDocEncoding is close enough to WinAnsi
/// for what a box without an appearance holds, and past Latin-1 a `?` says something was there.
fn contents_lines(annot: &Dict<'_>) -> Vec<Vec<u8>> {
    let Some(contents) = annot.get::<hayro_syntax::object::String<'_>>(&b"Contents"[..]) else {
        return Vec::new();
    };
    text_lines(contents.as_bytes())
}

fn text_lines(bytes: &[u8]) -> Vec<Vec<u8>> {
    let decoded: Vec<u8> = if let Some(wide) = bytes.strip_prefix(&[0xfe, 0xff]) {
        wide.chunks_exact(2)
            .map(|pair| if pair[0] == 0 { pair[1] } else { b'?' })
            .collect()
    } else {
        bytes.to_vec()
    };
    let normal: Vec<u8> = decoded
        .iter()
        .enumerate()
        .filter(|&(i, &b)| !(b == b'\n' && i > 0 && decoded[i - 1] == b'\r'))
        .map(|(_, &b)| if b == b'\r' { b'\n' } else { b })
        .collect();
    normal.split(|&b| b == b'\n').map(<[u8]>::to_vec).collect()
}

/// The size and colour operators of `/DA`, which may name a font this page doesn't have.
fn default_appearance(annot: &Dict<'_>) -> (f64, String) {
    let da = annot.get::<hayro_syntax::object::String<'_>>(&b"DA"[..]);
    default_appearance_of(da.as_ref().map_or(b"", |da| da.as_bytes()))
}

fn default_appearance_of(da: &[u8]) -> (f64, String) {
    let text = core::str::from_utf8(da).unwrap_or("");
    let tokens: Vec<&str> = text.split_ascii_whitespace().collect();
    let mut size = 12.0;
    let mut colour = "0 g\n".to_owned();
    for (i, token) in tokens.iter().enumerate() {
        let take = match *token {
            "g" | "G" => 1,
            "rg" | "RG" => 3,
            "k" | "K" => 4,
            "Tf" => {
                if let Some(value) = i.checked_sub(1).and_then(|at| tokens[at].parse::<f64>().ok())
                    && value > 0.0
                {
                    size = value;
                }
                continue;
            }
            _ => continue,
        };
        let Some(start) = i.checked_sub(take) else { continue };
        let values: Option<Vec<f64>> = tokens[start..i].iter().map(|t| t.parse().ok()).collect();
        if let Some(op) = values.and_then(|v| colour_op(&v, false)) {
            colour = op;
        }
    }
    (size, colour)
}

fn free_text(annot: &Dict<'_>, rect: &Rect, content: &mut String, left: &Cell<usize>) {
    let (width, dash) = border(annot, left);
    let (x0, y0, x1, y1) = (rect.x0, rect.y0, rect.x1, rect.y1);
    let interior = annot.get::<Array<'_>>(&b"C"[..]).map(|c| numbers(&c, left)).and_then(|c| colour_op(&c, false));
    if let Some(fill) = &interior {
        let _ = write!(content, "{fill}{x0} {y0} {} {} re f\n", x1 - x0, y1 - y0);
    }
    if width > 0.0 {
        let _ = write!(content, "0 G {width} w {dash}{} {} {} {} re S\n", x0 + width / 2.0, y0 + width / 2.0, x1 - x0 - width, y1 - y0 - width);
    }
    let (size, colour) = default_appearance(annot);
    let _ = write!(content, "q {x0} {y0} {} {} re W n BT {colour}/Helv {size} Tf\n", x1 - x0, y1 - y0);
    let mut y = y1 - width - size;
    for line in contents_lines(annot) {
        if left.get() == 0 {
            break;
        }
        text_line(content, x0 + width + 2.0, y, &line, left);
        y -= size * 1.2;
    }
    content.push_str("ET Q\n");
}

/// The nearest of a widget and the fields above it that states `key`.
fn owner<'a>(annot: &Dict<'a>, key: &[u8]) -> Option<Dict<'a>> {
    let mut node = annot.clone();
    for _ in 0..16 {
        if node.contains_key(key) {
            return Some(node);
        }
        node = node.get::<Dict<'_>>(&b"Parent"[..])?;
    }
    None
}

/// Writes a line of text, as a hex string, starting at `x`.
fn text_line(out: &mut String, x: f64, y: f64, line: &[u8], left: &Cell<usize>) {
    spend(left, 1 + line.len() / 32);
    let _ = write!(out, "1 0 0 1 {x} {y} Tm <");
    for byte in line {
        let _ = write!(out, "{byte:02x}");
    }
    out.push_str("> Tj\n");
}

/// A form field with no appearance: its `/MK` background and border, a text field's value and a push
/// button's caption. Helvetica's letters average about half an em, which is close enough to centre by.
fn widget(annot: &Dict<'_>, rect: &Rect, out: &mut String, left: &Cell<usize>) -> Option<()> {
    const PUSH_BUTTON: u32 = 1 << 16;
    const MULTILINE: u32 = 1 << 12;
    const PASSWORD: u32 = 1 << 13;
    let (x0, y0, x1, y1) = (rect.x0, rect.y0, rect.x1, rect.y1);
    let (width, height) = (x1 - x0, y1 - y0);
    let characteristics = annot.get::<Dict<'_>>(&b"MK"[..]);
    let colour_of = |key: &[u8], stroke| {
        let values = characteristics.as_ref()?.get::<Array<'_>>(key)?;
        colour_op(&numbers(&values, left), stroke)
    };
    let (mut line_width, dash) = border(annot, left);
    if let Some(fill) = colour_of(b"BG", false) {
        let _ = writeln!(out, "{fill}{x0} {y0} {width} {height} re f");
    }
    let stroke = colour_of(b"BC", true);
    if let Some(stroke) = stroke.filter(|_| line_width > 0.0) {
        let half = line_width / 2.0;
        let _ = writeln!(out, "{stroke}{line_width} w {dash}{} {} {} {} re S", x0 + half, y0 + half, width - line_width, height - line_width);
    } else {
        line_width = 0.0;
    }

    let kind = owner(annot, b"FT")?.get::<Name<'_>>(&b"FT"[..])?;
    let flags = owner(annot, b"Ff").and_then(|o| o.get::<u32>(&b"Ff"[..])).unwrap_or(0);
    let da = owner(annot, b"DA").and_then(|o| o.get::<hayro_syntax::object::String<'_>>(&b"DA"[..]));
    let (size, colour) = default_appearance_of(da.as_ref().map_or(b"", |da| da.as_bytes()));
    let auto_size = da.as_ref().is_some_and(|da| {
        let text = core::str::from_utf8(da.as_bytes()).unwrap_or("");
        let tokens: Vec<&str> = text.split_ascii_whitespace().collect();
        tokens.windows(2).any(|pair| pair[1] == "Tf" && pair[0].parse::<f64>() == Ok(0.0))
    });
    let size = if auto_size { (height * 0.7).clamp(4.0, 12.0) } else { size };
    let (lines, centred) = match kind.as_ref() {
        b"Btn" if flags & PUSH_BUTTON != 0 => {
            let caption = characteristics.as_ref()?.get::<hayro_syntax::object::String<'_>>(&b"CA"[..])?;
            (text_lines(caption.as_bytes()), true)
        }
        b"Tx" | b"Ch" if flags & PASSWORD == 0 => {
            let value = owner(annot, b"V")?.get::<hayro_syntax::object::String<'_>>(&b"V"[..])?;
            (text_lines(value.as_bytes()), false)
        }
        _ => return Some(()),
    };
    let _ = writeln!(out, "q {x0} {y0} {width} {height} re W n BT {colour}/Helv {size} Tf");
    let padding = line_width + 2.0;
    let multiline = kind.as_ref() == b"Tx" && flags & MULTILINE != 0;
    let mut y = if multiline { y1 - padding - size } else { y0 + (height - size) / 2.0 + size * 0.15 };
    for line in lines {
        let x = if centred { x0 + (width - line.len() as f64 * size * 0.5) / 2.0 } else { x0 + padding };
        text_line(out, x, y, &line, left);
        y -= size * 1.2;
        if !multiline || left.get() == 0 {
            break;
        }
    }
    out.push_str("ET Q\n");
    Some(())
}

/// The stream, and whether it multiplies, as a highlight does.
fn appearance(annot: &Dict<'_>, left: &Cell<usize>) -> Option<(String, bool)> {
    let subtype = annot.get::<Name<'_>>(SUBTYPE)?;
    let rect = annot.get::<Rect>(RECT);
    let colour = annot.get::<Array<'_>>(&b"C"[..]).map(|c| numbers(&c, left));
    let stroke_op = |default: &[f64]| colour_op(colour.as_deref().unwrap_or(default), true);
    let fill_op = |default: &[f64]| colour_op(colour.as_deref().unwrap_or(default), false);
    let quads = || -> Vec<f64> {
        annot.get::<Array<'_>>(&b"QuadPoints"[..]).map(|q| numbers(&q, left)).unwrap_or_default()
    };
    let mut out = String::new();
    let mut multiply = false;
    match subtype.as_ref() {
        b"Highlight" => {
            out.push_str(&fill_op(&[1.0, 1.0, 0.0])?);
            for q in quads().chunks_exact(8) {
                // In the order they're written: top left, top right, bottom left, bottom right.
                let _ = writeln!(out, "{} {} m {} {} l {} {} l {} {} l h f", q[0], q[1], q[2], q[3], q[6], q[7], q[4], q[5]);
            }
            multiply = true;
        }
        b"Underline" | b"Squiggly" | b"StrikeOut" => {
            out.push_str(&stroke_op(&[0.0, 0.0, 0.0])?);
            out.push_str("1 w\n");
            for q in quads().chunks_exact(8) {
                let strike = subtype.as_ref() == b"StrikeOut";
                let (ax, ay, bx, by) = if strike {
                    ((q[0] + q[4]) / 2.0, (q[1] + q[5]) / 2.0, (q[2] + q[6]) / 2.0, (q[3] + q[7]) / 2.0)
                } else {
                    (q[4], q[5], q[6], q[7])
                };
                if subtype.as_ref() == b"Squiggly" {
                    let length = (bx - ax).hypot(by - ay);
                    let steps = ((length / 2.0).ceil() as usize).clamp(1, 4096).min(left.get().max(1));
                    spend(left, steps);
                    let (ux, uy) = (q[0] - q[4], q[1] - q[5]);
                    let norm = ux.hypot(uy).max(1e-6);
                    let _ = writeln!(out, "{ax} {ay} m");
                    for step in 1..=steps {
                        let t = step as f64 / steps as f64;
                        let lift = if step % 2 == 1 { 1.5 / norm } else { 0.0 };
                        let _ = writeln!(out, "{} {} l", ax + (bx - ax) * t + ux * lift, ay + (by - ay) * t + uy * lift);
                    }
                    out.push_str("S\n");
                } else {
                    let _ = writeln!(out, "{ax} {ay} m {bx} {by} l S");
                }
            }
        }
        b"Square" | b"Circle" => {
            let rect = rect?;
            let (width, dash) = border(annot, left);
            let differences = annot.get::<Array<'_>>(&b"RD"[..]).map(|d| numbers(&d, left)).filter(|d| d.len() == 4).unwrap_or_else(|| vec![0.0; 4]);
            let x0 = rect.x0 + differences[0] + width / 2.0;
            let y0 = rect.y0 + differences[1] + width / 2.0;
            let x1 = rect.x1 - differences[2] - width / 2.0;
            let y1 = rect.y1 - differences[3] - width / 2.0;
            let interior = annot.get::<Array<'_>>(&b"IC"[..]).map(|c| numbers(&c, left)).and_then(|c| colour_op(&c, false));
            let stroke = if width > 0.0 { stroke_op(&[0.0, 0.0, 0.0]) } else { None };
            let op = match (interior.is_some(), stroke.is_some()) {
                (true, true) => "B",
                (true, false) => "f",
                (false, true) => "S",
                (false, false) => return None,
            };
            let _ = write!(out, "{width} w {dash}");
            out.push_str(interior.as_deref().unwrap_or(""));
            out.push_str(stroke.as_deref().unwrap_or(""));
            if subtype.as_ref() == b"Square" {
                let _ = writeln!(out, "{x0} {y0} {} {} re", x1 - x0, y1 - y0);
            } else {
                ellipse(&mut out, x0, y0, x1, y1);
            }
            let _ = writeln!(out, "{op}");
        }
        b"Line" | b"PolyLine" | b"Polygon" => {
            let key: &[u8] = if subtype.as_ref() == b"Line" { b"L" } else { b"Vertices" };
            let points = numbers(&annot.get::<Array<'_>>(key)?, left);
            let (width, dash) = border(annot, left);
            if width <= 0.0 {
                return None;
            }
            out.push_str(&stroke_op(&[0.0, 0.0, 0.0])?);
            let _ = write!(out, "{width} w {dash}");
            polyline(&mut out, &points);
            let closed = subtype.as_ref() == b"Polygon";
            let interior = annot.get::<Array<'_>>(&b"IC"[..]).map(|c| numbers(&c, left)).and_then(|c| colour_op(&c, false));
            match (closed, interior) {
                (true, Some(fill)) => {
                    out.insert_str(0, &fill);
                    out.push_str("h B\n");
                }
                (true, None) => out.push_str("h S\n"),
                (false, _) => out.push_str("S\n"),
            }
        }
        b"Ink" => {
            let (width, dash) = border(annot, left);
            if width <= 0.0 {
                return None;
            }
            out.push_str(&stroke_op(&[0.0, 0.0, 0.0])?);
            let _ = write!(out, "{width} w 1 J 1 j {dash}");
            for stroke in annot.get::<Array<'_>>(&b"InkList"[..])?.iter::<Array<'_>>() {
                if left.get() == 0 {
                    break;
                }
                spend(left, 1);
                let points = numbers(&stroke, left);
                // An odd count isn't a list of points; the references leave it out too.
                if points.len() % 2 == 0 {
                    polyline(&mut out, &points);
                    out.push_str("S\n");
                }
            }
        }
        b"FreeText" => free_text(annot, &rect?, &mut out, left),
        b"Widget" => {
            let _ = widget(annot, &rect?, &mut out, left);
        }
        _ => return None,
    }
    Some((out, multiply))
}

/// A font for a free text box: `/DA` names one from the form's resources, which a page may not have.
fn own_resources<'a>() -> Option<Resources<'a>> {
    let dict: Dict<'a> = Reader::new(b"<</Font <</Helv <</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>>>>>")
        .read_with_context::<Dict<'_>>(&ReaderContext::dummy())?;
    Some(Resources::new(dict))
}

pub(super) fn draw<'a>(
    annot: &Dict<'a>,
    resources: &Resources<'a>,
    context: &mut Context<'a>,
    device: &mut impl Device<'a>,
) {
    if context.annot_points == 0 {
        return;
    }
    // Each costs something, drawing or not: the same one can be listed thousands of times.
    let left = Cell::new(context.annot_points - 1);
    let drawn = appearance(annot, &left);
    context.annot_points = left.get();
    let Some((content, multiply)) = drawn else {
        return;
    };
    let opacity = annot.get::<f32>(&b"CA"[..]).unwrap_or(1.0);
    let own = if content.contains("/Helv") { own_resources() } else { None };
    context.save_state();
    context.compositing_mut().blend_mode = if multiply { BlendMode::Multiply } else { BlendMode::Normal };
    context.fill_paint_mut().alpha = opacity;
    context.stroke_paint_mut().alpha = opacity;
    interpret(TypedIter::new(content.as_bytes()), own.as_ref().unwrap_or(resources), context, device);
    context.restore_state(device);
}
