//! A page's links: where each `/Link` annotation goes. A destination resolves as the outline's do,
//! to a page and a place on it in that page's viewer frame. A link to another file or a program is
//! reported as what it is, never followed.

use crate::annots::{ANNOT_LINK, subtype_number, text_string, viewer_box};
use crate::outline::Destinations;
use hayro::hayro_interpret::util::TransformExt;
use hayro::hayro_syntax::Pdf;
use hayro::hayro_syntax::object::{Array, Dict, MaybeRef, Name, Null, Object, ObjectIdentifier, String as PdfString};
use hayro::hayro_syntax::page::{Page, Rotation};
use hayro::kurbo::{Affine, Point, Rect};

/// Where in this file a link goes.
#[derive(Clone, Debug, PartialEq)]
pub struct Destination {
    /// The page, or -1 if it goes nowhere in this file.
    pub page: i32,
    /// How the page is to be shown, as the file names it ("XYZ", "Fit", "FitH", "FitV", "FitR",
    /// "FitB", "FitBH", "FitBV"); None if it names none.
    pub view: Option<String>,
    /// The point to bring to the window's top-left, in the target page's viewer frame; None for a
    /// coordinate the destination leaves as it was.
    pub x: Option<f32>,
    pub y: Option<f32>,
    /// `XYZ`'s zoom, 1 for 100%; None to leave it as it was.
    pub zoom: Option<f32>,
    /// `FitR`'s rectangle in the target page's viewer frame: x, y, width, height.
    pub rect: Option<[f32; 4]>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// No action and no destination.
    None,
    /// A URI action.
    Uri(String),
    /// A destination in this file: a `GoTo` action's, or the link's `/Dest`.
    Page(Destination),
    /// `GoToR`: a file, and a destination there, by name or by page number. Not followed.
    Remote { file: String, page: Option<i32>, name: Option<String> },
    /// `Launch`: a file or program. Not followed.
    Launch { file: String },
    /// Any other action, by its `/S`; a `Named` action's `/N` (`NextPage`, ...) is `name`.
    Action { action: String, name: Option<String> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    /// Its index among the page's annotations, as `annotations` lists them.
    pub annotation: u32,
    /// Its `/Rect` in the viewer frame, as `annotations` gives it: x, y, width, height.
    pub bbox: [f32; 4],
    pub target: Target,
}

/// The links of `page`, `viewer` mapping its space to the viewer frame.
pub(crate) fn read<'a>(pdf: &'a Pdf, page: &Page<'a>, viewer: Affine) -> Vec<Link> {
    let xref = pdf.xref();
    let mut dests = Destinations::new(pdf, xref.get::<Dict<'_>>(xref.root_id()).unwrap_or_default());
    page.annotations()
        .into_iter()
        .enumerate()
        .filter(|(_, annot)| annot.get::<Name<'_>>(b"Subtype").is_some_and(|n| subtype_number(&n) == ANNOT_LINK))
        .map(|(i, annot)| Link {
            annotation: i as u32,
            bbox: viewer_box(&annot, viewer),
            target: target(&mut dests, pdf, &annot),
        })
        .collect()
}

fn target<'a>(dests: &mut Destinations<'a>, pdf: &'a Pdf, annot: &Dict<'a>) -> Target {
    // `A` wins over `Dest`, which the spec doesn't allow beside it; pdf.js reads them so too.
    if let Some(action) = annot.get::<Dict<'_>>(b"A") {
        let name = |key: &[u8]| action.get::<Name<'_>>(key).map(|n| String::from_utf8_lossy(&n).into_owned());
        return match action.get::<Name<'_>>(b"S").as_deref() {
            None => Target::None,
            Some(b"URI") => Target::Uri(
                action
                    .get::<PdfString<'_>>(b"URI")
                    .map(|u| String::from_utf8_lossy(u.as_bytes()).into_owned())
                    .unwrap_or_default(),
            ),
            Some(b"GoTo") => Target::Page(action.get::<Object<'_>>(b"D").map_or_else(Destination::nowhere, |d| destination(dests, pdf, d))),
            Some(b"GoToR") => {
                let (page, name) = match action.get::<Object<'_>>(b"D") {
                    Some(Object::Name(n)) => (None, Some(String::from_utf8_lossy(&n).into_owned())),
                    Some(Object::String(s)) => (None, Some(text_string(s.as_bytes()))),
                    Some(Object::Array(a)) => (a.iter::<Object<'_>>().next().and_then(whole_number), None),
                    _ => (None, None),
                };
                Target::Remote { file: file_spec(action.get::<Object<'_>>(b"F")), page, name }
            }
            Some(b"Launch") => {
                let file = action
                    .get::<Object<'_>>(b"F")
                    .or_else(|| action.get::<Dict<'_>>(b"Win").and_then(|w| w.get::<Object<'_>>(b"F")));
                Target::Launch { file: file_spec(file) }
            }
            Some(other) => Target::Action {
                action: String::from_utf8_lossy(other).into_owned(),
                name: if other == b"Named" { name(b"N") } else { None },
            },
        };
    }
    annot
        .get::<Object<'_>>(b"Dest")
        .map_or(Target::None, |d| Target::Page(destination(dests, pdf, d)))
}

/// A file specification as text: a string, or a dictionary's `UF`, `F`, `Unix`, `DOS` or `Mac`.
fn file_spec(spec: Option<Object<'_>>) -> String {
    match spec {
        Some(Object::String(s)) => text_string(s.as_bytes()),
        Some(Object::Dict(d)) => [&b"UF"[..], b"F", b"Unix", b"DOS", b"Mac"]
            .iter()
            .find_map(|key| d.get::<PdfString<'_>>(*key))
            .map(|s| text_string(s.as_bytes()))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn whole_number(object: Object<'_>) -> Option<i32> {
    match object {
        Object::Number(n) => i32::try_from(n.as_i64()).ok(),
        _ => None,
    }
}

impl Destination {
    fn nowhere() -> Self {
        Self { page: -1, view: None, x: None, y: None, zoom: None, rect: None }
    }
}

fn destination<'a>(dests: &mut Destinations<'a>, pdf: &'a Pdf, dest: Object<'a>) -> Destination {
    let Some(array) = dests.explicit(dest, 0) else {
        return Destination::nowhere();
    };
    let page = ranged_page(pdf, &array).unwrap_or_else(|| dests.page_of_array(&array));
    // By position: a resolving iterator would skip an entry that names nothing, the page first.
    let mut entries = array.raw_iter().skip(1).map(|entry| match entry {
        MaybeRef::NotRef(object) => object,
        MaybeRef::Ref(r) => pdf.xref().get::<Object<'_>>(r.into()).unwrap_or(Object::Null(Null)),
    });
    let view = entries.next().and_then(|v| match v {
        Object::Name(n) => Some(String::from_utf8_lossy(&n).into_owned()),
        _ => None,
    });
    let numbers: Vec<Option<f64>> = entries
        .take(4)
        .map(|v| match v {
            Object::Number(n) => Some(n.as_f64()),
            _ => None,
        })
        .collect();
    let at = |i: usize| numbers.get(i).copied().flatten();
    let mut out = Destination { page, view, ..Destination::nowhere() };
    let Some(target) = usize::try_from(page).ok().and_then(|p| pdf.pages().get(p)) else {
        return out;
    };
    let to_viewer = target.initial_transform(true).to_kurbo();
    let turned = matches!(target.rotation(), Rotation::Horizontal | Rotation::FlippedHorizontal);
    // A point with a coordinate missing: under a quarter turn, page x is viewer y.
    let point = |left: Option<f64>, top: Option<f64>| {
        let p = to_viewer * Point::new(left.unwrap_or(0.0), top.unwrap_or(0.0));
        let (has_x, has_y) = if turned { (top.is_some(), left.is_some()) } else { (left.is_some(), top.is_some()) };
        (has_x.then_some(p.x as f32), has_y.then_some(p.y as f32))
    };
    let (x, y) = match out.view.as_deref() {
        Some("XYZ") => {
            out.zoom = at(2).filter(|z| *z > 0.0).map(|z| z as f32);
            point(at(0), at(1))
        }
        Some("FitH" | "FitBH") => point(None, at(0)),
        Some("FitV" | "FitBV") => point(at(0), None),
        Some("FitR") => match (at(0), at(1), at(2), at(3)) {
            (Some(l), Some(b), Some(r), Some(t)) => {
                let r = to_viewer.transform_rect_bbox(Rect::new(l, b, r, t).abs());
                out.rect = Some([r.x0 as f32, r.y0 as f32, r.width() as f32, r.height() as f32]);
                (Some(r.x0 as f32), Some(r.y0 as f32))
            }
            _ => (None, None),
        },
        _ => (None, None),
    };
    out.x = x;
    out.y = y;
    out
}

/// A ranged file's page for a destination that names its page object: found up its `/Parent`
/// chain, counting the pages before it, and checked against the page at that index, so that
/// only that chain is read and not the whole tree. None for anything else, which the outline's
/// page map then finds.
fn ranged_page(pdf: &Pdf, array: &Array<'_>) -> Option<i32> {
    let xref = pdf.xref();
    if !xref.is_ranged() {
        return None;
    }
    let Some(MaybeRef::Ref(first)) = array.raw_iter().next() else {
        return None;
    };
    let id: ObjectIdentifier = first.into();
    let mut node = xref.get::<Dict<'_>>(id)?;
    let mut current = id;
    let mut index: usize = 0;
    for _ in 0..64 {
        let Some(parent_ref) = node.get_ref(b"Parent") else {
            break;
        };
        let parent = node.get::<Dict<'_>>(b"Parent")?;
        let kids: Vec<MaybeRef<Object<'_>>> = parent.get::<Array<'_>>(b"Kids")?.raw_iter().collect();
        let at = kids.iter().position(|kid| matches!(kid, MaybeRef::Ref(r) if ObjectIdentifier::from(*r) == current))?;
        // As the ranged descent takes it: a wide node with a kid per page holds one page each.
        if kids.len() > 32 && parent.get::<i64>(b"Count") == Some(kids.len() as i64) {
            index += at;
        } else {
            for kid in &kids[..at] {
                let kid = match kid {
                    MaybeRef::Ref(r) => xref.get::<Dict<'_>>((*r).into()),
                    MaybeRef::NotRef(Object::Dict(d)) => Some(d.clone()),
                    MaybeRef::NotRef(_) => None,
                };
                index += match kid {
                    Some(kid) if kid.get::<Name<'_>>(b"Type").as_deref() == Some(&b"Pages"[..]) => {
                        usize::try_from(kid.get::<i64>(b"Count")?).ok()?
                    }
                    Some(_) => 1,
                    None => 0,
                };
            }
        }
        current = parent_ref.into();
        node = parent;
    }
    let index = i32::try_from(index).ok()?;
    let found = pdf.pages().get(index as usize)?;
    (found.raw().obj_id() == Some(id)).then_some(index)
}
