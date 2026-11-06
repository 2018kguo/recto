//! A page's annotations: subtype numbers, the /Rect in the viewer frame, /Contents, a widget's
//! field type and value, and what its normal appearance paints.

use hayro::hayro_interpret::{
    Context, InterpreterCache, InterpreterSettings, RenderContent, interpret,
};
use hayro::hayro_syntax::content::TypedIter;
use hayro::hayro_syntax::content::ops::TypedInstruction;
use hayro::hayro_syntax::object::{Array, Dict, Name, Object, Rect, Stream};
use hayro::hayro_syntax::page::{Page, Resources};
use hayro::kurbo::{self, Affine};

use crate::device::PageDevice;

pub const ANNOT_WIDGET: u8 = 20;

/// Subtype numbers in the PDF spec's table order; 0 for an unknown or missing /Subtype.
pub fn subtype_number(name: &[u8]) -> u8 {
    const NAMES: [&[u8]; 28] = [
        b"Text",
        b"Link",
        b"FreeText",
        b"Line",
        b"Square",
        b"Circle",
        b"Polygon",
        b"PolyLine",
        b"Highlight",
        b"Underline",
        b"Squiggly",
        b"StrikeOut",
        b"Stamp",
        b"Caret",
        b"Ink",
        b"Popup",
        b"FileAttachment",
        b"Sound",
        b"Movie",
        b"Widget",
        b"Screen",
        b"PrinterMark",
        b"TrapNet",
        b"Watermark",
        b"3D",
        b"RichMedia",
        b"XFAWidget",
        b"Redact",
    ];
    NAMES
        .iter()
        .position(|n| *n == name)
        .map_or(0, |i| i as u8 + 1)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    /// /FT: "Tx", "Ch", "Btn", "Sig"; "" when no level of the field has one.
    pub kind: String,
    /// /V as text; "" for an array (multi-select) or a missing value.
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Annotation {
    pub subtype: u8,
    /// x, y, width, height in the viewer frame.
    pub bbox: [f32; 4],
    pub contents: String,
    /// Widgets only.
    pub field: Option<Field>,
    /// Top-level objects of the normal appearance (a form XObject is one).
    pub appearance_objects: u32,
    pub appearance_text_objects: u32,
    /// One trimmed line per top-level text object that paints any text.
    pub appearance_text: String,
}

/// PDFDocEncoding's code points for 0x18..=0x1F and 0x80..=0xA0 (0 where
/// undefined); the rest is Latin-1.
const DOC_LOW: [u16; 8] = [
    0x02D8, 0x02C7, 0x02C6, 0x02D9, 0x02DD, 0x02DB, 0x02DA, 0x02DC,
];
const DOC_HIGH: [u16; 33] = [
    0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039, 0x203A, 0x2212, 0x2030,
    0x201E, 0x201C, 0x201D, 0x2018, 0x2019, 0x201A, 0x2122, 0xFB01, 0xFB02, 0x0141, 0x0152, 0x0160,
    0x0178, 0x017D, 0x0131, 0x0142, 0x0153, 0x0161, 0x017E, 0, 0x20AC,
];

/// A PDF text string: UTF-16 (either byte order) or UTF-8 with a BOM, else
/// PDFDocEncoding.
pub fn text_string(bytes: &[u8]) -> String {
    let utf16 = |be: bool| {
        let units = bytes[2..].chunks_exact(2).map(|p| {
            if be {
                u16::from_be_bytes([p[0], p[1]])
            } else {
                u16::from_le_bytes([p[0], p[1]])
            }
        });
        char::decode_utf16(units)
            .map(|c| c.unwrap_or('\u{FFFD}'))
            .collect()
    };
    match bytes {
        [0xFE, 0xFF, ..] => utf16(true),
        [0xFF, 0xFE, ..] => utf16(false),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => bytes
            .iter()
            .filter_map(|&b| {
                let cp = match b {
                    0x18..=0x1F => DOC_LOW[usize::from(b - 0x18)],
                    0x80..=0xA0 => DOC_HIGH[usize::from(b - 0x80)],
                    0xAD => 0,
                    _ => u16::from(b),
                };
                (cp != 0 || b == 0).then(|| char::from_u32(u32::from(cp)).unwrap_or('\u{FFFD}'))
            })
            .collect(),
    }
}

/// CPDF_Object::GetUnicodeText: strings and names decode, a stream's data
/// decodes; anything else (an array, a number) is "".
fn object_text(object: &Object<'_>) -> String {
    match object {
        Object::String(s) => text_string(s.as_bytes()),
        Object::Name(n) => text_string(n.as_ref()),
        Object::Stream(s) => s.decoded().map(|d| text_string(&d)).unwrap_or_default(),
        _ => String::new(),
    }
}

/// How deep a field's /Parent chain is followed (stops at loops).
const MAX_FIELD_DEPTH: usize = 32;

/// A field attribute, inherited through /Parent (CPDF_FormField::GetFieldAttrForDict).
fn field_attr<'a>(annot: &Dict<'a>, key: &[u8]) -> Option<Object<'a>> {
    let mut level = annot.clone();
    for _ in 0..MAX_FIELD_DEPTH {
        if let Some(v) = level.get::<Object<'_>>(key) {
            return Some(v);
        }
        level = level.get::<Dict<'_>>(b"Parent")?;
    }
    None
}

/// The normal appearance: /N itself, or the state /AS (else /V, else
/// /Off) picks from it (CPDF_Annot's GetAnnotAP).
fn normal_appearance<'a>(annot: &Dict<'a>) -> Option<Stream<'a>> {
    match annot.get::<Dict<'_>>(b"AP")?.get::<Object<'_>>(b"N")? {
        Object::Stream(s) => Some(s),
        Object::Dict(states) => {
            let named = |n: Name<'_>| states.get::<Stream<'_>>(n);
            annot
                .get::<Name<'_>>(b"AS")
                .and_then(named)
                .or_else(|| {
                    field_attr(annot, b"V")
                        .and_then(|v| v.into_name())
                        .and_then(named)
                })
                .or_else(|| states.get::<Stream<'_>>(b"Off"))
        }
        _ => None,
    }
}

/// Top-level page objects a stream makes: one
/// per text-showing operator with text, per painted path, per Do that names
/// an image or form, per inline image and per `sh`. Returns (objects, text).
fn count_objects(ops: TypedIter<'_>, resources: &Resources<'_>) -> (u32, u32) {
    let (mut objects, mut texts) = (0, 0);
    let mut ops = ops;
    let mut path = false;
    while let Some(op) = ops.next() {
        use TypedInstruction as I;
        let painted_text = match &op {
            I::ShowText(t) => !t.0.is_empty(),
            I::NextLineAndShowText(t) => !t.0.is_empty(),
            I::ShowTextWithParameters(t) => !t.2.is_empty(),
            I::ShowTexts(t) => {
                t.0.iter::<Object<'_>>()
                    .any(|o| matches!(o, Object::String(s) if !s.is_empty()))
            }
            _ => false,
        };
        if painted_text {
            texts += 1;
            objects += 1;
            continue;
        }
        match op {
            I::MoveTo(_)
            | I::LineTo(_)
            | I::CubicTo(_)
            | I::CubicStartTo(_)
            | I::CubicEndTo(_)
            | I::RectPath(_) => path = true,
            I::StrokePath(_)
            | I::CloseAndStrokePath(_)
            | I::FillPathNonZero(_)
            | I::FillPathNonZeroCompatibility(_)
            | I::FillPathEvenOdd(_)
            | I::FillAndStrokeNonZero(_)
            | I::FillAndStrokeEvenOdd(_)
            | I::CloseFillAndStrokeNonZero(_)
            | I::CloseFillAndStrokeEvenOdd(_) => {
                objects += u32::from(path);
                path = false;
            }
            I::EndPath(_) => path = false,
            I::XObject(x) => {
                let kind = resources
                    .get_x_object(x.0)
                    .and_then(|s| s.dict().get::<Name<'_>>(b"Subtype"));
                objects += u32::from(matches!(kind, Some(k) if &*k == b"Image" || &*k == b"Form"));
            }
            I::InlineImage(_) => objects += 1,
            I::Shading(s) => objects += u32::from(resources.get_shading(s.0).is_some()),
            _ => {}
        }
    }
    (objects, texts)
}

fn appearance<'a>(
    stream: &Stream<'a>,
    page: &Page<'a>,
    cache: &InterpreterCache<'a>,
) -> (u32, u32, String) {
    let Ok(decoded) = stream.decoded() else {
        return (0, 0, String::new());
    };
    let mut resources = stream
        .dict()
        .get::<Dict<'_>>(b"Resources")
        .map_or_else(|| page.resources().clone(), Resources::new);
    let (objects, texts) = count_objects(TypedIter::new(&decoded), &resources);
    if texts == 0 {
        return (objects, 0, String::new());
    }
    // Only the stream's own text objects: a nested form counts as one object
    // and is not read inside, so XObjects are left unresolved.
    resources.x_objects = Dict::default();
    let mut ctx = Context::new(
        Affine::IDENTITY,
        kurbo::Rect::new(-1e9, -1e9, 1e9, 1e9),
        cache,
        page.xref(),
        InterpreterSettings {
            render_content: RenderContent::PAGE,
            ..crate::assets::text_settings()
        },
    );
    let mut device = PageDevice::new(Affine::IDENTITY, false);
    device.run_texts = Some(Vec::new());
    interpret(TypedIter::new(&decoded), &resources, &mut ctx, &mut device);
    let lines: Vec<&str> = device
        .run_texts
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    (objects, texts, lines.join("\n"))
}

/// The annotations of `page`, `viewer` mapping page space to the viewer frame.
pub(crate) fn read<'a>(
    page: &Page<'a>,
    cache: &InterpreterCache<'a>,
    viewer: Affine,
) -> Vec<Annotation> {
    let Some(annots) = page.raw().get::<Array<'_>>(b"Annots") else {
        return Vec::new();
    };
    annots
        .iter::<Dict<'_>>()
        .map(|annot| {
            let subtype = annot
                .get::<Name<'_>>(b"Subtype")
                .map_or(0, |n| subtype_number(&n));
            let bbox = annot.get::<Rect>(b"Rect").map_or([0.0; 4], |r| {
                let b = viewer.transform_rect_bbox(kurbo::Rect::new(r.x0, r.y0, r.x1, r.y1).abs());
                [
                    b.x0 as f32,
                    b.y0 as f32,
                    b.width() as f32,
                    b.height() as f32,
                ]
            });
            let contents = annot
                .get::<Object<'_>>(b"Contents")
                .map(|o| object_text(&o))
                .unwrap_or_default();
            let field = (subtype == ANNOT_WIDGET).then(|| Field {
                kind: field_attr(&annot, b"FT")
                    .map(|o| object_text(&o))
                    .unwrap_or_default(),
                value: field_attr(&annot, b"V")
                    .map(|o| object_text(&o))
                    .unwrap_or_default(),
            });
            let (appearance_objects, appearance_text_objects, appearance_text) =
                normal_appearance(&annot)
                    .map_or((0, 0, String::new()), |s| appearance(&s, page, cache));
            Annotation {
                subtype,
                bbox,
                contents,
                field,
                appearance_objects,
                appearance_text_objects,
                appearance_text,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subtypes_use_the_table_numbers() {
        assert_eq!(subtype_number(b"Text"), 1);
        assert_eq!(subtype_number(b"Link"), 2);
        assert_eq!(subtype_number(b"FreeText"), 3);
        assert_eq!(subtype_number(b"Stamp"), 13);
        assert_eq!(subtype_number(b"Widget"), 20);
        assert_eq!(subtype_number(b"Redact"), 28);
        assert_eq!(subtype_number(b"Nonsense"), 0);
    }

    #[test]
    fn text_strings_decode() {
        assert_eq!(text_string(b"plain"), "plain");
        assert_eq!(text_string(b"\xFE\xFF\x00h\x00\xE9"), "hé");
        assert_eq!(text_string(b"\xFF\xFEh\x00\xE9\x00"), "hé");
        assert_eq!(text_string(b"\xEF\xBB\xBFh\xC3\xA9"), "hé");
        // PDFDocEncoding: 0x80 bullet, 0x93 fi ligature, 0xA0 euro, 0xE9 é.
        assert_eq!(text_string(b"\x80\x93\xA0\xE9"), "•ﬁ€é");
    }
}
