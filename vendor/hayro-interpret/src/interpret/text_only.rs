//! recto: the interpreter for `RenderContent::TEXT_ONLY`. It reads the stream
//! with `lex::Lexer` and runs only what moves text or its fill: the graphics
//! and text state, colour, `gs`, marked content, form XObjects and the text
//! operators, through the same code as `interpret`, so the device sees the
//! same glyph runs. Paths, images and shadings are skipped (a malformed path
//! operator still ends the stream, as it does there).

use super::lex::{self, Lexer, Operand};
use super::state::{TextStateFont, handle_gs};
use super::text::{self, TextRenderingMode};
use crate::FillRule;
use crate::color::ColorSpace;
use crate::context::Context;
use crate::device::Device;
use crate::pattern::Pattern;
use crate::x_object::FormXObject;
use hayro_syntax::content::TypedIter;
use hayro_syntax::object::dict::keys::{OC, SUBTYPE};
use hayro_syntax::object::{self, Array, Dict, Name, Object, dict_or_stream};
use hayro_syntax::page::Resources;
use hayro_syntax::reader::{Reader, ReaderExt};
use kurbo::Affine;
use rustc_hash::FxHashMap;
use smallvec::SmallVec;

/// The last `N` operands, as hayro's typed operators take them.
fn last<const N: usize>(ops: &[Operand]) -> Option<&[Operand; N]> {
    ops.get(ops.len().checked_sub(N)?..)?.try_into().ok()
}

fn num(o: &Operand) -> Option<f64> {
    match o {
        Operand::Num(n) => Some(*n),
        _ => None,
    }
}

fn nums<const N: usize>(ops: &[Operand]) -> Option<[f64; N]> {
    let ops = last::<N>(ops)?;
    let mut out = [0.0; N];
    for (o, n) in out.iter_mut().zip(ops) {
        *o = num(n)?;
    }
    Some(out)
}

fn name<'d>(d: &'d [u8], o: &Operand) -> Option<Name<'d>> {
    let Operand::Name(s, e) = *o else { return None };
    let raw = &d[s as usize..e as usize];
    if raw.contains(&b'#') {
        Name::new_escaped(raw)
    } else {
        Some(Name::new_unescaped(raw))
    }
}

fn read<'d, T: hayro_syntax::reader::Readable<'d>>(d: &'d [u8], s: u32, e: u32) -> Option<T> {
    Reader::new(&d[s as usize..e as usize]).read_without_context::<T>()
}

/// A string's bytes: a literal without escapes or line breaks in place,
/// others decoded into `buf`.
fn string<'s>(d: &'s [u8], o: &Operand, buf: &'s mut Vec<u8>) -> Option<&'s [u8]> {
    let Operand::Str(s, e) = *o else { return None };
    string_at(d, s as usize, e as usize, buf)
}

fn string_at<'s>(d: &'s [u8], s: usize, e: usize, buf: &'s mut Vec<u8>) -> Option<&'s [u8]> {
    buf.clear();
    if d[s] == b'<' {
        // The lexer let through only hex digits and white space.
        let mut hi = None;
        for &b in &d[s + 1..e - 1] {
            let Some(v) = (b as char).to_digit(16) else {
                continue;
            };
            match hi.take() {
                None => hi = Some(v as u8),
                Some(h) => buf.push(h << 4 | v as u8),
            }
        }
        buf.extend(hi.map(|h| h << 4));
        return Some(buf);
    }
    let inner = d.get(s + 1..e.checked_sub(1)?)?;
    if d[e - 1] == b')' && !inner.iter().any(|b| matches!(b, b'\\' | b'\n' | b'\r')) {
        return Some(inner);
    }
    // Escapes and line breaks go through hayro's reader.
    buf.extend_from_slice(&read::<object::String<'_>>(d, s as u32, e as u32)?);
    Some(buf)
}

/// One TJ array, read in place; `false` when it holds anything but numbers
/// and strings, for `TJ` to read it the slow way.
fn show_texts<'a>(
    d: &[u8],
    s: usize,
    e: usize,
    context: &mut Context<'a>,
    resources: &Resources<'a>,
    buf: &mut Vec<u8>,
) -> bool {
    // Checked whole before anything is applied.
    let mut i = s + 1;
    loop {
        i = lex::skip_white(d, i);
        match d.get(i) {
            Some(b']') if i + 1 == e => break,
            Some(b'0'..=b'9' | b'+' | b'-' | b'.') => match lex::number(d, i) {
                (Some(_), end) => i = end,
                _ => return false,
            },
            Some(b'(') => i = lex::skip_literal(d, i),
            Some(b'<') if d.get(i + 1) != Some(&b'<') => match lex::hex_end(d, i) {
                Some(end) => i = end,
                None => return false,
            },
            _ => return false,
        }
    }
    text::begin_glyph_run(context);
    let mut i = s + 1;
    loop {
        i = lex::skip_white(d, i);
        match d[i] {
            b'(' | b'<' => {
                let end = if d[i] == b'(' {
                    lex::skip_literal(d, i)
                } else {
                    lex::hex_end(d, i).unwrap_or(e)
                };
                if let Some(t) = string_at(d, i, end, buf) {
                    text::append_text_string(context, resources, t);
                }
                i = end;
            }
            b']' => break,
            _ => {
                let (n, end) = lex::number(d, i);
                text::apply_glyph_run_adjustment(context, n.unwrap_or_default() as f32);
                i = end;
            }
        }
    }
    true
}

fn object<'d>(d: &'d [u8], o: &Operand) -> Option<Object<'d>> {
    match *o {
        Operand::Num(_) => None,
        Operand::Name(..) => name(d, o).map(Object::Name),
        Operand::Str(s, e) | Operand::Array(s, e) | Operand::Dict(s, e) => read(d, s, e),
    }
}

/// `sc`/`scn` operands: numbers then at most a pattern name; anything else
/// voids the operator.
fn color<'d>(d: &'d [u8], ops: &[Operand]) -> Option<(SmallVec<[f32; 4]>, Option<Name<'d>>)> {
    let mut c = SmallVec::new();
    let mut pattern = None;
    for o in ops {
        match o {
            Operand::Num(n) => c.push(*n as f32),
            Operand::Name(..) => pattern = name(d, o),
            _ => return None,
        }
    }
    Some((c, pattern))
}

pub(crate) fn interpret<'a>(
    d: &[u8],
    resources: &Resources<'a>,
    context: &mut Context<'a>,
    device: &mut impl Device<'a>,
) {
    let num_states = context.num_states();
    // Resolved once per name: resolving hashes the font dict.
    let mut fonts = FxHashMap::<&[u8], Option<TextStateFont<'a>>>::default();
    let mut lexer = Lexer::new(d);
    let mut buf = Vec::new();

    context.save_state();

    while let Some(op) = lexer.next() {
        let ops = &lexer.operands[..];
        // hayro reads every operand while tokenizing, and one it can't read
        // ends the stream. TJ reads its array itself, BDC (after a tag) its
        // property list.
        let own = usize::from(match op {
            b"TJ" => matches!(ops.last(), Some(Operand::Array(..))),
            b"BDC" => ops.len() >= 2 && matches!(ops[ops.len() - 2], Operand::Name(..)),
            _ => false,
        });
        let unreadable = !ops[..ops.len() - own.min(ops.len())]
            .iter()
            .all(|o| lex::readable(d, o));
        if unreadable {
            break;
        }
        match op {
            b"q" => context.save_state(),
            b"Q" => {
                // As in `run_ops`: a `Q` without a `q` in this stream is ignored.
                if context.num_states() > num_states + 1 {
                    context.restore_state(device);
                }
            }
            b"cm" => {
                if let Some(m) = nums::<6>(ops) {
                    context.pre_concat_affine(Affine::new(m));
                }
            }
            b"gs" => {
                if let Some(gs) = last::<1>(ops)
                    .and_then(|[n]| name(d, n))
                    .and_then(|n| resources.get_ext_g_state(&n))
                {
                    handle_gs(&gs, context, resources);
                }
            }
            b"g" | b"rg" | b"k" | b"G" | b"RG" | b"K" => {
                let c: Option<SmallVec<[f32; 4]>> = match op {
                    b"g" | b"G" => {
                        nums::<1>(ops).map(|c| SmallVec::from_slice(&c.map(|v| v as f32)))
                    }
                    b"rg" | b"RG" => {
                        nums::<3>(ops).map(|c| SmallVec::from_slice(&c.map(|v| v as f32)))
                    }
                    _ => nums::<4>(ops).map(|c| SmallVec::from_slice(&c.map(|v| v as f32))),
                };
                if let Some(c) = c {
                    let space = match op {
                        b"g" | b"G" => ColorSpace::device_gray(),
                        b"rg" | b"RG" => ColorSpace::device_rgb(),
                        _ => ColorSpace::device_cmyk(),
                    };
                    let paint = if op[0].is_ascii_lowercase() {
                        context.fill_paint_mut()
                    } else {
                        context.stroke_paint_mut()
                    };
                    paint.color_space = space;
                    paint.color = c;
                    paint.pattern = None;
                }
            }
            b"sc" | b"SC" => {
                if let Some((c, None)) = color(d, ops) {
                    let paint = if op == b"sc" {
                        context.fill_paint_mut()
                    } else {
                        context.stroke_paint_mut()
                    };
                    paint.color = c;
                    paint.pattern = None;
                }
            }
            b"scn" | b"SCN" => {
                if let Some((c, p)) = color(d, ops) {
                    let pattern = p.and_then(|name| {
                        resources
                            .get_pattern(&name)
                            .and_then(|d| Pattern::new(d, context))
                    });
                    let paint = if op == b"scn" {
                        context.fill_paint_mut()
                    } else {
                        context.stroke_paint_mut()
                    };
                    paint.color = c;
                    paint.pattern = pattern;
                }
            }
            b"cs" | b"CS" => {
                if let Some(n) = last::<1>(ops).and_then(|[n]| name(d, n)) {
                    let cs = ColorSpace::new_from_name(&n).unwrap_or_else(|| {
                        context
                            .get_color_space(resources, &n)
                            .unwrap_or(ColorSpace::device_gray())
                    });
                    let paint = if op == b"cs" {
                        context.fill_paint_mut()
                    } else {
                        context.stroke_paint_mut()
                    };
                    if !cs.is_pattern() {
                        paint.pattern = None;
                    }
                    paint.color = cs.initial_color();
                    paint.color_space = cs;
                }
            }
            b"BDC" => {
                let Some([tag, props]) = last::<2>(ops) else {
                    continue;
                };
                let Some(tag) = name(d, tag) else { continue };
                // A number here is a property list with nothing in it.
                let props = object(d, props);
                if props.is_none() && !matches!(ops[ops.len() - 1], Operand::Num(_)) {
                    break;
                }
                let properties = props
                    .clone()
                    .and_then(Object::into_name)
                    .and_then(|name| resources.properties.get::<Dict<'_>>(name))
                    .or_else(|| dict_or_stream(props.as_ref()?).map(|(props, _)| props.clone()));
                let oc = props
                    .clone()
                    .and_then(Object::into_name)
                    .and_then(|name| {
                        let r = resources.properties.get_ref(name.as_ref())?;
                        let d = resources
                            .properties
                            .get::<Dict<'_>>(name)
                            .unwrap_or_default();
                        Some((d, r))
                    })
                    .or_else(|| {
                        let (props, _) = dict_or_stream(props.as_ref()?)?;
                        let r = props.get_ref(OC)?;
                        let d = props.get::<Dict<'_>>(OC).unwrap_or_default();
                        Some((d, r))
                    });
                if let Some((dict, oc_ref)) = oc {
                    context.ocg_state.begin_ocg(&dict, oc_ref.into());
                } else {
                    context.ocg_state.begin_marked_content();
                }
                device.begin_marked_content(&tag, properties.as_ref());
            }
            b"BMC" => {
                if let Some(tag) = last::<1>(ops).and_then(|[n]| name(d, n)) {
                    context.ocg_state.begin_marked_content();
                    device.begin_marked_content(&tag, None);
                }
            }
            b"EMC" => {
                context.ocg_state.end_marked_content();
                device.end_marked_content();
            }
            b"BT" => {
                let t = context.text_state_mut();
                t.text_matrix = Affine::IDENTITY;
                t.text_line_matrix = Affine::IDENTITY;
            }
            b"ET" => {
                if context.text_state().clip_paths.segments().next().is_some() {
                    let clip_path = context.ctm() * context.text_state().clip_paths.clone();
                    context.push_clip_path(clip_path, FillRule::NonZero, device);
                }
                context.text_state_mut().clip_paths.truncate(0);
            }
            b"Tf" => {
                let Some([n, size]) = last::<2>(ops) else {
                    continue;
                };
                let (Some(Operand::Name(s, e)), Some(size)) = (Some(*n), num(size)) else {
                    continue;
                };
                let key = &d[s as usize..e as usize];
                let font = match fonts.get(key) {
                    Some(font) => font.clone(),
                    None => {
                        let font = match name(d, n).and_then(|n| resources.get_font(&n)) {
                            Some(dict) => context.resolve_font(&dict),
                            None => context.fallback_font(),
                        };
                        fonts.insert(key, font.clone());
                        font
                    }
                };
                let t = context.text_state_mut();
                t.font_size = size as f32;
                t.font = font;
            }
            b"Tc" | b"Tw" | b"Tz" | b"TL" | b"Ts" => {
                if let Some([v]) = nums::<1>(ops) {
                    let t = context.text_state_mut();
                    let v = v as f32;
                    match op {
                        b"Tc" => t.char_space = v,
                        b"Tw" => t.word_space = v,
                        b"Tz" => t.horizontal_scaling = v,
                        b"TL" => t.leading = v,
                        _ => t.rise = v,
                    }
                }
            }
            b"Tr" => {
                if let Some([v]) = nums::<1>(ops) {
                    context.text_state_mut().render_mode = match v as i64 {
                        1 => TextRenderingMode::Stroke,
                        2 => TextRenderingMode::FillStroke,
                        3 => TextRenderingMode::Invisible,
                        4 => TextRenderingMode::FillAndClip,
                        5 => TextRenderingMode::StrokeAndClip,
                        6 => TextRenderingMode::FillAndStrokeAndClip,
                        7 => TextRenderingMode::Clip,
                        _ => TextRenderingMode::Fill,
                    };
                }
            }
            b"Td" | b"TD" => {
                if let Some([tx, ty]) = nums::<2>(ops) {
                    if op == b"TD" {
                        context.text_state_mut().leading = -ty as f32;
                    }
                    text::next_line(context, tx, ty);
                }
            }
            b"Tm" => {
                if let Some(m) = nums::<6>(ops) {
                    let t = context.text_state_mut();
                    t.text_line_matrix = Affine::new(m);
                    t.text_matrix = t.text_line_matrix;
                }
            }
            b"T*" => text::next_line(context, 0.0, -context.text_state().leading as f64),
            b"Tj" | b"'" | b"\"" => {
                let s = match op {
                    b"\"" => {
                        let Some([aw, ac, s]) = last::<3>(ops) else {
                            continue;
                        };
                        let (Some(aw), Some(ac), Some(s)) =
                            (num(aw), num(ac), string(d, s, &mut buf))
                        else {
                            continue;
                        };
                        let t = context.text_state_mut();
                        t.word_space = aw as f32;
                        t.char_space = ac as f32;
                        s
                    }
                    _ => match last::<1>(ops).and_then(|[s]| string(d, s, &mut buf)) {
                        Some(s) => s,
                        None => continue,
                    },
                };
                if op != b"Tj" {
                    text::next_line(context, 0.0, -context.text_state().leading as f64);
                } else if context.text_state().font.is_none() {
                    // Helvetica when no font was set, as `interpret` (and Acrobat) do
                    // for `Tj` and `TJ`.
                    context.text_state_mut().font = context.fallback_font();
                }
                text::show_text_string(context, device, resources, s);
            }
            b"TJ" => {
                let Some(Operand::Array(s, e)) = last::<1>(ops).map(|[a]| *a) else {
                    continue;
                };
                if context.text_state().font.is_none() {
                    context.text_state_mut().font = context.fallback_font();
                }
                if !show_texts(d, s as usize, e as usize, context, resources, &mut buf) {
                    let Some(array) = read::<Array<'_>>(d, s, e) else {
                        break;
                    };
                    text::begin_glyph_run(context);
                    for obj in array.iter::<Object<'_>>() {
                        match obj {
                            Object::Number(n) => {
                                text::apply_glyph_run_adjustment(context, n.as_f32());
                            }
                            Object::String(s) => text::append_text_string(context, resources, &s),
                            _ => {}
                        }
                    }
                }
                text::show_glyph_run(context, device);
            }
            b"Do" => {
                let Some(stream) = last::<1>(ops)
                    .and_then(|[n]| name(d, n))
                    .and_then(|n| resources.get_x_object(&n))
                else {
                    continue;
                };
                // Images draw no text; only forms are read.
                if stream.dict().get::<Name<'_>>(SUBTYPE).as_deref() == Some(b"Form".as_slice())
                    && let Some(form) = FormXObject::new(&stream)
                {
                    form.draw(resources, context, device);
                }
            }
            // Where an inline image ends is hayro's call (its `EI` heuristics), so
            // the rest of the stream goes to `interpret`'s loop from here.
            b"BI" => {
                let mut rest = TypedIter::new(&d[lexer.op_start()..]);
                super::run_ops(&mut rest, resources, context, device, None, num_states + 1);
                break;
            }
            // A malformed path operator ends the stream in `interpret`.
            b"m" | b"l" => {
                if nums::<2>(ops).is_none() {
                    break;
                }
            }
            b"v" | b"y" | b"re" => {
                if nums::<4>(ops).is_none() {
                    break;
                }
            }
            b"c" => {
                if nums::<6>(ops).is_none() {
                    break;
                }
            }
            _ => {}
        }
    }

    // As `interpret`: a path (from a handed-off rest) ends with its stream.
    context.clear_path();
    *(context.clip_mut()) = None;

    while context.num_states() > num_states {
        context.restore_state(device);
    }
}
