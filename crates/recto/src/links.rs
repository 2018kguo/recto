//! A page's links: where each `/Link` annotation goes. A destination resolves as the outline's do,
//! to a page and a place on it in that page's viewer frame. A link to another file or a program is
//! reported as what it is, never followed.

use crate::annots::{ANNOT_LINK, subtype_number, text_string, viewer_box};
use crate::outline::Destinations;
use hayro::hayro_interpret::util::TransformExt;
use hayro::hayro_syntax::Pdf;
use hayro::hayro_syntax::object::{Dict, MaybeRef, Name, Null, Object, String as PdfString};
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
    // The outline's page map, built once a call however many links there are, so a link goes
    // where a bookmark to the same place does, whole or ranged.
    let page = dests.page_of_array(&array);
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

#[cfg(test)]
mod tests {
    use crate::{Document, Target};
    use hayro::hayro_syntax::xref::object_reads;

    /// `pages` pages in one node whose `/Count` is off by one, so nothing can take the node's kids
    /// as a page each; page 0 links to the last `links` pages.
    fn wide(pages: usize, links: usize) -> Vec<u8> {
        let mut objects = vec![
            "<</Type/Catalog/Pages 2 0 R>>".to_string(),
            format!("<</Type/Pages/Count {}/Kids[{}]>>", pages + 1, (0..pages).map(|i| format!("{} 0 R", i + 3)).collect::<Vec<_>>().join(" ")),
        ];
        let annots: String = (0..links)
            .map(|i| format!("<</Type/Annot/Subtype/Link/Rect[0 0 1 1]/Dest[{} 0 R/Fit]>>", pages + 2 - i))
            .collect();
        for i in 0..pages {
            let extra = if i == 0 { format!("/Annots[{annots}]") } else { String::new() };
            objects.push(format!("<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]{extra}>>"));
        }
        let mut out = b"%PDF-1.7\n".to_vec();
        let mut offsets = vec![];
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
        }
        let xref = out.len();
        out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
        for at in offsets {
            out.extend(format!("{at:010} 00000 n \n").bytes());
        }
        out.extend(format!("trailer\n<</Size {}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).bytes());
        out
    }

    fn ranged(bytes: Vec<u8>) -> Document {
        let len = bytes.len();
        let fill = move |offset: usize, out: &mut [u8], _: usize| {
            out.copy_from_slice(&bytes[offset..offset + out.len()]);
            true
        };
        Document::open_ranged(len, 1024, Box::new(fill), "").unwrap()
    }

    /// Objects read by `links(0)`, and the pages its links go to.
    fn reads(doc: &Document) -> (usize, Vec<i32>) {
        let before = object_reads();
        let pages = doc
            .links(0)
            .unwrap()
            .into_iter()
            .map(|l| match l.target {
                Target::Page(d) => d.page,
                other => panic!("{other:?}"),
            })
            .collect();
        (object_reads() - before, pages)
    }

    // A link's page is found once a call: links to many pages cost what one does, whole or ranged,
    // and not a walk of the tree each.
    #[test]
    fn links_to_many_pages_read_the_tree_once() {
        let pages = 4000;
        for open in [|b: Vec<u8>| Document::open(b, "").unwrap(), ranged as fn(Vec<u8>) -> Document] {
            let (one, to) = reads(&open(wide(pages, 1)));
            assert_eq!(to, [pages as i32 - 1]);
            let (many, to) = reads(&open(wide(pages, 400)));
            assert_eq!(to, (0..400).map(|i| pages as i32 - 1 - i).collect::<Vec<_>>());
            // What 400 links add is theirs: a few reads each, not the 4,000 pages again.
            assert!(many < one + 400 * 8, "{one} reads for one link, {many} for 400");
        }
    }
}
