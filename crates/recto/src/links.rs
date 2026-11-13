//! A page's links: where each `/Link` annotation goes, and where the outline's items and the
//! document's `/OpenAction` go. A destination resolves to a page and the view the file names, both
//! as the file writes it, in the page's user space, and in that page's viewer frame. A link to
//! another file or a program is reported as what it is, never followed.

use crate::annots::{ANNOT_LINK, subtype_number, text_string, viewer_box};
use crate::outline::Destinations;
use hayro::hayro_interpret::util::TransformExt;
use hayro::hayro_syntax::Pdf;
use hayro::hayro_syntax::object::{Array, Dict, MaybeRef, Name, Null, Object, String as PdfString};
use hayro::hayro_syntax::page::{Page, Rotation};
use hayro::kurbo::{Affine, Point, Rect};

/// Where a destination goes: a page, and how to show it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Destination {
    /// The page's index, or -1 if it goes nowhere in this file. In another file's destination
    /// (`GoToR`, `GoToE`), the index the file gives for that one, or -1 for a destination by name.
    pub page: i32,
    /// How the page is to be shown, as the file names it ("XYZ", "Fit", "FitH", "FitV", "FitR",
    /// "FitB", "FitBH", "FitBV"); None if it names none.
    pub view: Option<String>,
    /// The point to bring to the window's top-left, in the target page's viewer frame; None for a
    /// coordinate the destination leaves as it was, and for a page in another file.
    pub x: Option<f32>,
    pub y: Option<f32>,
    /// `XYZ`'s zoom, 1 for 100%; None to leave it as it was.
    pub zoom: Option<f32>,
    /// `FitR`'s rectangle in the target page's viewer frame: x, y, width, height.
    pub rect: Option<[f32; 4]>,
    /// The view's numbers as the file writes them, in the target page's user space: `XYZ`'s left
    /// and top, `FitH`'s and `FitBH`'s top, `FitV`'s and `FitBV`'s left, `FitR`'s four. None where
    /// it gives none, or null.
    pub left: Option<f32>,
    pub bottom: Option<f32>,
    pub right: Option<f32>,
    pub top: Option<f32>,
    /// The name it was reached by; with `page` -1, a name the file doesn't define.
    pub name: Option<String>,
}

/// A step from one file to another along a `GoToE`'s target: to the parent, or to a child by its
/// name in the embedded files (or None for one attached to an annotation).
#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddedStep {
    pub parent: bool,
    pub name: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// No action and no destination.
    None,
    /// A URI action.
    Uri(String),
    /// A destination in this file: a `GoTo` action's, or the link's `/Dest`.
    Page(Destination),
    /// `GoToR`: a file, as written (a relative path stays relative), its file system (`/FS`, such as
    /// "URL") if it names one, and a destination there. Not followed.
    Remote { file: String, file_system: Option<String>, destination: Destination, new_window: Option<bool> },
    /// `GoToE`: a file embedded in this one, or in `file`, by the steps of its `/T`, and a
    /// destination there. Not followed.
    Embedded { file: Option<String>, path: Vec<EmbeddedStep>, destination: Destination, new_window: Option<bool> },
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
    let mut dests = Destinations::new(pdf, catalog(pdf));
    page.annotations()
        .into_iter()
        .enumerate()
        .filter(|(_, annot)| annot.get::<Name<'_>>(b"Subtype").is_some_and(|n| subtype_number(&n) == ANNOT_LINK))
        .map(|(i, annot)| Link {
            annotation: i as u32,
            bbox: viewer_box(&annot, viewer),
            // `A` wins over `Dest`, which the spec doesn't allow beside it; pdf.js reads them so too.
            target: target(&mut dests, &annot, true),
        })
        .collect()
}

pub(crate) fn catalog(pdf: &Pdf) -> Dict<'_> {
    let xref = pdf.xref();
    xref.get::<Dict<'_>>(xref.root_id()).unwrap_or_default()
}

/// Where the document opens: its catalog's `/OpenAction`, a destination or an action.
pub(crate) fn open_action(pdf: &Pdf) -> Target {
    let root = catalog(pdf);
    let mut dests = Destinations::new(pdf, root.clone());
    match root.get::<Object<'_>>(b"OpenAction") {
        Some(Object::Dict(action)) => action_target(&mut dests, &action),
        Some(dest @ Object::Array(_)) => Target::Page(destination(&mut dests, dest)),
        _ => Target::None,
    }
}

/// A named destination of the document, or one with `page` -1 and the name if it has none by it.
pub(crate) fn named(pdf: &Pdf, name: &str) -> Destination {
    let mut dests = Destinations::new(pdf, catalog(pdf));
    match dests.lookup(name) {
        Some(found) => Destination { name: Some(name.to_owned()), ..destination(&mut dests, found) },
        None => Destination { name: Some(name.to_owned()), ..Destination::nowhere() },
    }
}

/// `dest` on this document's page `dest.page`, its viewer frame coordinates from its user space
/// ones: for a destination read from another file that names a page here.
pub(crate) fn placed(pdf: &Pdf, dest: &Destination) -> Destination {
    let mut out = Destination { x: None, y: None, rect: None, ..dest.clone() };
    match usize::try_from(dest.page).ok().and_then(|p| pdf.pages().get(p)) {
        Some(page) => place(page, &mut out),
        None => out.page = -1,
    }
    out
}

/// Where an item with an action `A` and a destination `Dest` goes: a link's action wins, an outline
/// item's destination does, as each was read before either was resolved in full.
pub(crate) fn target<'a>(dests: &mut Destinations<'a>, item: &Dict<'a>, action_first: bool) -> Target {
    let action = || item.get::<Dict<'_>>(b"A");
    let dest = || item.get::<Object<'_>>(b"Dest");
    if action_first {
        if let Some(action) = action() {
            return action_target(dests, &action);
        }
        dest().map_or(Target::None, |d| Target::Page(destination(dests, d)))
    } else if let Some(d) = dest() {
        Target::Page(destination(dests, d))
    } else {
        action().map_or(Target::None, |a| action_target(dests, &a))
    }
}

fn action_target<'a>(dests: &mut Destinations<'a>, action: &Dict<'a>) -> Target {
    let name = |key: &[u8]| action.get::<Name<'_>>(key).map(|n| String::from_utf8_lossy(&n).into_owned());
    let new_window = || match action.get::<Object<'_>>(b"NewWindow") {
        Some(Object::Boolean(b)) => Some(b),
        _ => None,
    };
    match action.get::<Name<'_>>(b"S").as_deref() {
        None => Target::None,
        Some(b"URI") => Target::Uri(
            action
                .get::<PdfString<'_>>(b"URI")
                .map(|u| String::from_utf8_lossy(u.as_bytes()).into_owned())
                .unwrap_or_default(),
        ),
        Some(b"GoTo") => Target::Page(action.get::<Object<'_>>(b"D").map_or_else(Destination::nowhere, |d| destination(dests, d))),
        Some(b"GoToR") => {
            let spec = action.get::<Object<'_>>(b"F");
            Target::Remote {
                file: file_spec(spec.clone()),
                file_system: file_system(spec),
                destination: elsewhere(dests.pdf(), action.get::<Object<'_>>(b"D")),
                new_window: new_window(),
            }
        }
        Some(b"GoToE") => {
            let mut path = vec![];
            let mut step = action.get::<Dict<'_>>(b"T");
            // A target's own `/T` is the next step; a chain that loops ends at the limit.
            while let Some(t) = step.take()
                && path.len() < 32
            {
                path.push(EmbeddedStep {
                    parent: t.get::<Name<'_>>(b"R").is_some_and(|r| r.as_ref() == b"P"),
                    name: t.get::<PdfString<'_>>(b"N").map(|n| text_string(n.as_bytes())),
                });
                step = t.get::<Dict<'_>>(b"T");
            }
            let file = action.get::<Object<'_>>(b"F");
            Target::Embedded {
                file: file.is_some().then(|| file_spec(file)),
                path,
                destination: elsewhere(dests.pdf(), action.get::<Object<'_>>(b"D")),
                new_window: new_window(),
            }
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
    }
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

/// A file specification dictionary's `/FS`: "URL" for a file named by its URL.
fn file_system(spec: Option<Object<'_>>) -> Option<String> {
    match spec {
        Some(Object::Dict(d)) => d.get::<Name<'_>>(b"FS").map(|n| String::from_utf8_lossy(&n).into_owned()),
        _ => None,
    }
}

impl Destination {
    fn nowhere() -> Self {
        Self { page: -1, ..Self::default() }
    }
}

/// An entry of a destination array, by position: a resolving iterator would skip one that names
/// nothing, the page first.
fn entries<'a>(pdf: &'a Pdf, array: &Array<'a>) -> impl Iterator<Item = Object<'a>> {
    array.raw_iter().map(move |entry| match entry {
        MaybeRef::NotRef(object) => object,
        MaybeRef::Ref(r) => pdf.xref().get::<Object<'_>>(r.into()).unwrap_or(Object::Null(Null)),
    })
}

/// A destination's view and its numbers, in user space, from the array's second entry on.
fn view_of<'a>(pdf: &'a Pdf, array: &Array<'a>, page: i32) -> Destination {
    let mut entries = entries(pdf, array).skip(1);
    let view = entries.next().and_then(|v| match v {
        Object::Name(n) => Some(String::from_utf8_lossy(&n).into_owned()),
        _ => None,
    });
    let numbers: Vec<Option<f32>> = entries
        .take(4)
        .map(|v| match v {
            Object::Number(n) => Some(n.as_f64() as f32),
            _ => None,
        })
        .collect();
    let at = |i: usize| numbers.get(i).copied().flatten();
    let mut out = Destination { page, view, ..Destination::nowhere() };
    match out.view.as_deref() {
        Some("XYZ") => {
            (out.left, out.top) = (at(0), at(1));
            out.zoom = at(2).filter(|z| *z > 0.0);
        }
        Some("FitH" | "FitBH") => out.top = at(0),
        Some("FitV" | "FitBV") => out.left = at(0),
        Some("FitR") => (out.left, out.bottom, out.right, out.top) = (at(0), at(1), at(2), at(3)),
        _ => {}
    }
    out
}

/// A destination in this file, resolved to its page and placed on it.
fn destination<'a>(dests: &mut Destinations<'a>, dest: Object<'a>) -> Destination {
    let mut name = None;
    let Some(array) = dests.explicit(dest, 0, &mut name) else {
        return Destination { name, ..Destination::nowhere() };
    };
    // The outline's page map, built once a call however many links there are, so a link goes
    // where a bookmark to the same place does, whole or ranged.
    let page = dests.page_of_array(&array);
    let mut out = Destination { name, ..view_of(dests.pdf(), &array, page) };
    if let Some(target) = usize::try_from(page).ok().and_then(|p| dests.pdf().pages().get(p)) {
        place(target, &mut out);
    }
    out
}

/// A destination in another file: by name, or an array whose first entry is that file's page index.
fn elsewhere<'a>(pdf: &'a Pdf, dest: Option<Object<'a>>) -> Destination {
    match dest {
        Some(Object::Name(n)) => Destination { name: Some(String::from_utf8_lossy(&n).into_owned()), ..Destination::nowhere() },
        Some(Object::String(s)) => Destination { name: Some(text_string(s.as_bytes())), ..Destination::nowhere() },
        Some(Object::Array(array)) => {
            let page = match entries(pdf, &array).next() {
                Some(Object::Number(n)) => i32::try_from(n.as_i64()).ok().filter(|p| *p >= 0).unwrap_or(-1),
                _ => -1,
            };
            view_of(pdf, &array, page)
        }
        _ => Destination::nowhere(),
    }
}

/// The destination's viewer frame coordinates on `target`, from its user space ones.
fn place(target: &Page<'_>, out: &mut Destination) {
    let to_viewer = target.initial_transform(true).to_kurbo();
    let turned = matches!(target.rotation(), Rotation::Horizontal | Rotation::FlippedHorizontal);
    let f = |v: Option<f32>| v.map(f64::from);
    // A point with a coordinate missing: under a quarter turn, page x is viewer y.
    let point = |left: Option<f64>, top: Option<f64>| {
        let p = to_viewer * Point::new(left.unwrap_or(0.0), top.unwrap_or(0.0));
        let (has_x, has_y) = if turned { (top.is_some(), left.is_some()) } else { (left.is_some(), top.is_some()) };
        (has_x.then_some(p.x as f32), has_y.then_some(p.y as f32))
    };
    (out.x, out.y) = match out.view.as_deref() {
        Some("XYZ") => point(f(out.left), f(out.top)),
        Some("FitH" | "FitBH") => point(None, f(out.top)),
        Some("FitV" | "FitBV") => point(f(out.left), None),
        Some("FitR") => match (out.left, out.bottom, out.right, out.top) {
            (Some(l), Some(b), Some(r), Some(t)) => {
                let r = to_viewer.transform_rect_bbox(Rect::new(l.into(), b.into(), r.into(), t.into()).abs());
                out.rect = Some([r.x0 as f32, r.y0 as f32, r.width() as f32, r.height() as f32]);
                (Some(r.x0 as f32), Some(r.y0 as f32))
            }
            _ => (None, None),
        },
        _ => (None, None),
    };
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
        file(&objects)
    }

    /// A file of these objects, numbered from 1, with the first the catalog.
    fn file(objects: &[String]) -> Vec<u8> {
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

    /// `n` pages, and on the first a link to each by its index, last first, as some producers write
    /// a destination's page.
    fn numbered(n: usize) -> Vec<u8> {
        let mut objects = vec![
            "<</Type/Catalog/Pages 2 0 R>>".to_string(),
            format!("<</Type/Pages/Count {n}/Kids[{}]>>", (0..n).map(|i| format!("{} 0 R", i + 3)).collect::<Vec<_>>().join(" ")),
        ];
        let annots: String = (0..n).map(|i| format!("<</Type/Annot/Subtype/Link/Rect[0 0 1 1]/Dest[{} /Fit]>>", n - 1 - i)).collect();
        for i in 0..n {
            let extra = if i == 0 { format!("/Annots[{annots}]") } else { String::new() };
            objects.push(format!("<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]{extra}>>"));
        }
        file(&objects)
    }

    // Each link that named its page by index looked for that index among every page's, so a page of
    // links to each of n pages took n² steps: 16,000 took 0.14 s. Eight times the links and pages take
    // about eight times as long now, where they took 64.
    #[test]
    fn links_to_pages_by_index_take_time_linear_in_them() {
        let time = |n: usize| {
            let doc = Document::open(numbered(n), "").unwrap();
            let pages: Vec<i32> = doc
                .links(0)
                .unwrap()
                .into_iter()
                .map(|l| match l.target {
                    Target::Page(d) => d.page,
                    other => panic!("{other:?}"),
                })
                .collect();
            assert_eq!(pages, (0..n as i32).rev().collect::<Vec<_>>());
            (0..3)
                .map(|_| {
                    let start = std::time::Instant::now();
                    assert_eq!(doc.links(0).unwrap().len(), n);
                    start.elapsed().as_secs_f64()
                })
                .fold(f64::INFINITY, f64::min)
        };
        let (small, large) = (time(1_000), time(8_000));
        assert!(large < 24.0 * small, "{small:.4} s for 1,000 links, {large:.4} s for 8,000");
    }

    use crate::{Destination, EmbeddedStep};

    /// Page 0 links to every kind of destination. Pages 1 to 4 share a crop box offset from the media
    /// box's origin, turned 0, 90, 180 and 270 degrees; page 1 has a `/UserUnit` too. A point (100, 700)
    /// in their user space is (50, 60) in an unturned page's viewer frame, its crop box 500 by 700.
    fn destinations_pdf() -> Vec<u8> {
        let annots = [
            "/Dest [4 0 R /XYZ 100 700 1.5]",
            "/Dest [5 0 R /XYZ 100 700 0]",
            "/Dest [6 0 R /XYZ 100 700 null]",
            "/Dest [7 0 R /XYZ 100 700 null]",
            "/Dest [4 0 R /Fit]",
            "/Dest [5 0 R /FitH 700]",
            "/Dest [5 0 R /FitV 100]",
            "/Dest [4 0 R /FitR 100 200 300 400]",
            "/Dest [6 0 R /FitR 300 400 100 200]",
            "/Dest [4 0 R /FitB]",
            "/Dest [4 0 R /FitBH 700]",
            "/Dest [4 0 R /FitBV 100]",
            "/Dest [4 0 R /XYZ null 700 null]",
            "/Dest (missing)",
            "/A << /S /GoToR /F (../other/report.pdf) /D [2 /XYZ 10 20 3] /NewWindow true >>",
            "/A << /S /GoToR /F << /Type /Filespec /F (http://example.com/x.pdf) /FS /URL >> /D /Chapter2 >>",
            "/A << /S /GoToE /T << /R /C /N (attached.pdf) /T << /R /P >> >> /D (inner) /NewWindow false >>",
            "/Dest /legacy",
            "/A << /S /GoTo /D (deep) >>",
            "/Dest /k-name",
            "/Dest (early)",
        ]
        .map(|a| format!("<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] {a} >>"))
        .join(" ");
        let turned = |rotate: u32, extra: &str| {
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /CropBox [50 60 550 760] /Rotate {rotate} {extra}>>")
        };
        file(&[
            "<< /Type /Catalog /Pages 2 0 R /Dests 8 0 R /Names << /Dests 9 0 R >> /Outlines 13 0 R /OpenAction [4 0 R /FitH 650] >>".into(),
            "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R 7 0 R] /Count 5 >>".into(),
            format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Annots [{annots}] >>"),
            turned(0, "/UserUnit 2 "),
            turned(90, ""),
            turned(180, ""),
            turned(270, ""),
            // 8: the catalog's Dests, a dictionary's /D.
            "<< /legacy << /D [4 0 R /XYZ 100 700 null] >> >>".into(),
            // 9 to 12: a name tree, two levels down on one side, with limits, and a key written as a name.
            "<< /Kids [10 0 R 11 0 R] >>".into(),
            "<< /Limits [(a) (f)] /Names [(deep) [6 0 R /Fit] (early) << /D [3 0 R /XYZ 0 800 null] >>] >>".into(),
            "<< /Limits [(g) (z)] /Kids [12 0 R] >>".into(),
            "<< /Limits [(k-name) (k-name)] /Names [/k-name [7 0 R /FitH 700]] >>".into(),
            // 13 to 16: an outline by name, to another file, and to a name that isn't there.
            "<< /First 14 0 R /Last 16 0 R >>".into(),
            "<< /Title (A) /Parent 13 0 R /Next 15 0 R /Dest (deep) >>".into(),
            "<< /Title (B) /Parent 13 0 R /Next 16 0 R /A << /S /GoToR /F (other.pdf) /D [0 /FitR 1 2 3 4] >> >>".into(),
            "<< /Title (C) /Parent 13 0 R /Dest (nowhere-at-all) >>".into(),
        ])
    }

    fn at(page: i32, view: &str) -> Destination {
        Destination { page, view: Some(view.into()), ..Destination::default() }
    }

    fn page_target(target: &Target) -> &Destination {
        match target {
            Target::Page(d) => d,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn every_kind_of_destination_in_user_space_and_on_the_page_as_shown() {
        let doc = Document::open(destinations_pdf(), "").unwrap();
        let links: Vec<Target> = doc.links(0).unwrap().into_iter().map(|l| l.target).collect();
        let d = |i: usize| page_target(&links[i]).clone();
        let xyz = |page, x, y, zoom| Destination {
            x: Some(x),
            y: Some(y),
            zoom,
            left: Some(100.0),
            top: Some(700.0),
            ..at(page, "XYZ")
        };
        // The same point on each turn of the page: the crop box's corner is the frame's origin, and
        // the user unit, which scales neither the page's size nor its frame, leaves it as it is.
        assert_eq!(doc.page_info(1).unwrap().width, 500.0);
        assert_eq!(d(0), xyz(1, 50.0, 60.0, Some(1.5)));
        assert_eq!(d(1), xyz(2, 640.0, 50.0, None), "90: a zoom of 0 leaves it as it was");
        assert_eq!(d(2), xyz(3, 450.0, 640.0, None), "180");
        assert_eq!(d(3), xyz(4, 60.0, 450.0, None), "270");
        assert_eq!(d(4), at(1, "Fit"));
        // A quarter turn: FitH's top is a viewer x, FitV's left a viewer y.
        assert_eq!(d(5), Destination { x: Some(640.0), top: Some(700.0), ..at(2, "FitH") });
        assert_eq!(d(6), Destination { y: Some(50.0), left: Some(100.0), ..at(2, "FitV") });
        let fit_r = |page, rect: [f32; 4], [left, bottom, right, top]: [f32; 4]| Destination {
            x: Some(rect[0]),
            y: Some(rect[1]),
            rect: Some(rect),
            left: Some(left),
            bottom: Some(bottom),
            right: Some(right),
            top: Some(top),
            ..at(page, "FitR")
        };
        assert_eq!(d(7), fit_r(1, [50.0, 360.0, 200.0, 200.0], [100.0, 200.0, 300.0, 400.0]));
        // Corners in either order, as written; on the page turned half, the rectangle turns with it.
        assert_eq!(d(8), fit_r(3, [250.0, 140.0, 200.0, 200.0], [300.0, 400.0, 100.0, 200.0]));
        assert_eq!(d(9), at(1, "FitB"));
        assert_eq!(d(10), Destination { y: Some(60.0), top: Some(700.0), ..at(1, "FitBH") });
        assert_eq!(d(11), Destination { x: Some(50.0), left: Some(100.0), ..at(1, "FitBV") });
        assert_eq!(d(12), Destination { y: Some(60.0), top: Some(700.0), ..at(1, "XYZ") }, "a null left");
        // A name the file doesn't define is reported, not dropped.
        assert_eq!(d(13), Destination { page: -1, name: Some("missing".into()), ..Destination::default() });
        // By name: the catalog's Dests, through a /D; the name tree, through a GoTo, down its kids, by a
        // key written as a name, and to a dictionary's /D.
        assert_eq!(d(17), Destination { name: Some("legacy".into()), ..xyz(1, 50.0, 60.0, None) });
        assert_eq!(d(18), Destination { name: Some("deep".into()), ..at(3, "Fit") });
        assert_eq!(d(19), Destination { x: Some(60.0), top: Some(700.0), name: Some("k-name".into()), ..at(4, "FitH") });
        assert_eq!(d(20), Destination { x: Some(0.0), y: Some(0.0), left: Some(0.0), top: Some(800.0), name: Some("early".into()), ..at(0, "XYZ") });
    }

    #[test]
    fn destinations_in_other_files_as_written() {
        let doc = Document::open(destinations_pdf(), "").unwrap();
        let links: Vec<Target> = doc.links(0).unwrap().into_iter().map(|l| l.target).collect();
        // An explicit destination there: its page index and view in its user space, and nothing placed.
        assert_eq!(
            links[14],
            Target::Remote {
                file: "../other/report.pdf".into(),
                file_system: None,
                destination: Destination { left: Some(10.0), top: Some(20.0), zoom: Some(3.0), ..at(2, "XYZ") },
                new_window: Some(true),
            }
        );
        assert_eq!(
            links[15],
            Target::Remote {
                file: "http://example.com/x.pdf".into(),
                file_system: Some("URL".into()),
                destination: Destination { page: -1, name: Some("Chapter2".into()), ..Destination::default() },
                new_window: None,
            }
        );
        assert_eq!(
            links[16],
            Target::Embedded {
                file: None,
                path: vec![EmbeddedStep { parent: false, name: Some("attached.pdf".into()) }, EmbeddedStep { parent: true, name: None }],
                destination: Destination { page: -1, name: Some("inner".into()), ..Destination::default() },
                new_window: Some(false),
            }
        );
        // Once that file is open: an explicit destination placed on its page, and a name looked up.
        let placed = doc.place_destination(&Destination { left: Some(100.0), top: Some(700.0), ..at(2, "XYZ") });
        assert_eq!(placed, Destination { x: Some(640.0), y: Some(50.0), left: Some(100.0), top: Some(700.0), ..at(2, "XYZ") });
        assert_eq!(doc.place_destination(&at(9, "Fit")).page, -1);
        assert_eq!(doc.destination("k-name").page, 4);
        assert_eq!(doc.destination("legacy"), Destination { name: Some("legacy".into()), ..page_target(&links[17]).clone() });
        assert_eq!(doc.destination("missing"), Destination { page: -1, name: Some("missing".into()), ..Destination::default() });
    }

    #[test]
    fn outline_items_and_the_open_action_go_to_exact_places() {
        for doc in [Document::open(destinations_pdf(), "").unwrap(), ranged(destinations_pdf())] {
            let items = doc.outline();
            assert_eq!(items[0].target, Target::Page(Destination { name: Some("deep".into()), ..at(3, "Fit") }));
            assert_eq!(items[0].page, 3);
            let Target::Remote { file, destination, .. } = &items[1].target else { panic!("{:?}", items[1].target) };
            assert_eq!((file.as_str(), destination.page, destination.right), ("other.pdf", 0, Some(3.0)));
            assert_eq!(items[1].page, -1);
            assert_eq!(items[2].target, Target::Page(Destination { page: -1, name: Some("nowhere-at-all".into()), ..Destination::default() }));
            // FitH 650 on the unturned crop: 110 down from the crop box's top.
            assert_eq!(doc.open_action(), Target::Page(Destination { y: Some(110.0), top: Some(650.0), ..at(1, "FitH") }));
        }
        let none = Document::open(wide(1, 0), "").unwrap();
        assert_eq!(none.open_action(), Target::None);
    }
}
