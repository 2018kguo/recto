//! The document outline (bookmarks), read-only.

use crate::annots::text_string;
use hayro::hayro_syntax::Pdf;
use hayro::hayro_syntax::object::{Array, Dict, Name, Object, ObjectIdentifier, String as PdfString};
use rustc_hash::{FxHashMap, FxHashSet};

/// A file can hold any number; a viewer's panel needs far fewer than this.
const MAX_ITEMS: usize = 1 << 16;
const MAX_DEPTH: u32 = 64;

/// In document order; an item's children follow it, one level deeper.
#[derive(Clone, Debug, PartialEq)]
pub struct OutlineItem {
    pub title: String,
    pub level: u32,
    /// Where it goes: a page index, or -1 if it goes nowhere in this file.
    pub page: i32,
    /// A link out, if that's what it is.
    pub url: Option<String>,
}

struct Reader<'a> {
    dests: Destinations<'a>,
    items: Vec<OutlineItem>,
    seen: FxHashSet<ObjectIdentifier>,
}

/// Where destinations go: by name (the catalog's `Dests` and its name tree), and to which page.
/// The outline's, and links'.
pub(crate) struct Destinations<'a> {
    pdf: &'a Pdf,
    /// Each page's object and its index, made on first use: it walks the whole page tree.
    pages: Option<FxHashMap<ObjectIdentifier, i32>>,
    /// `Dests` of the catalog, and the name tree's entries, read on first use.
    names: Option<FxHashMap<Vec<u8>, Object<'a>>>,
    root: Dict<'a>,
    walked: Walked,
}

/// What a read of the outline found out about itself.
#[derive(Default, Clone, Copy)]
pub struct Walked {
    /// Name tree nodes visited.
    pub names: usize,
    /// A limit was reached, so items may be missing or go nowhere.
    pub stopped: bool,
}

/// A name tree's nodes can name each other twice, so depth alone leaves 2^32 visits.
pub const MAX_NAME_NODES: usize = MAX_ITEMS * 4;

impl<'a> Destinations<'a> {
    pub(crate) fn new(pdf: &'a Pdf, root: Dict<'a>) -> Self {
        Self { pdf, pages: None, names: None, root, walked: Walked::default() }
    }

    fn pages(&mut self) -> &FxHashMap<ObjectIdentifier, i32> {
        let pdf = self.pdf;
        self.pages.get_or_insert_with(|| page_map(pdf))
    }

    fn names(&mut self) -> &FxHashMap<Vec<u8>, Object<'a>> {
        let root = self.root.clone();
        let walked = &mut self.walked;
        self.names.get_or_insert_with(|| {
            let mut out = FxHashMap::default();
            if let Some(dests) = root.get::<Dict<'_>>(b"Dests") {
                for key in dests.keys() {
                    if let Some(value) = dests.get::<Object<'_>>(key.clone()) {
                        out.insert(key.as_ref().to_vec(), value);
                    }
                }
            }
            if let Some(tree) = root.get::<Dict<'_>>(b"Names").and_then(|n| n.get::<Dict<'_>>(b"Dests")) {
                name_tree(&tree, 0, walked, &mut out);
            }
            out
        })
    }

    /// A destination: an array whose first entry is the page, a name for one, or either of those
    /// wrapped in a dictionary with a `D`.
    pub(crate) fn page_of(&mut self, dest: Object<'a>) -> i32 {
        self.explicit(dest, 0).map_or(-1, |array| self.page_of_array(&array))
    }

    /// The array a destination comes to, following names and dictionaries.
    pub(crate) fn explicit(&mut self, dest: Object<'a>, hops: u32) -> Option<Array<'a>> {
        if hops > 4 {
            return None;
        }
        match dest {
            Object::Array(array) => Some(array),
            Object::Dict(dict) => dict.get::<Object<'_>>(b"D").and_then(|d| self.explicit(d, hops + 1)),
            Object::Name(name) => {
                let found = self.names().get(name.as_ref()).cloned();
                found.and_then(|d| self.explicit(d, hops + 1))
            }
            Object::String(string) => {
                let found = self.names().get(string.as_bytes()).cloned();
                found.and_then(|d| self.explicit(d, hops + 1))
            }
            _ => None,
        }
    }

    pub(crate) fn page_of_array(&mut self, array: &Array<'a>) -> i32 {
        use hayro::hayro_syntax::object::MaybeRef;
        match array.raw_iter().next() {
            Some(MaybeRef::Ref(r)) => self.pages().get(&r.into()).copied().unwrap_or(-1),
            // Some producers write the page's index rather than a reference to it.
            Some(MaybeRef::NotRef(Object::Number(n))) => {
                let page = n.as_i64();
                i32::try_from(page).ok().filter(|p| self.pages().values().any(|v| v == p)).unwrap_or(-1)
            }
            _ => -1,
        }
    }
}

impl<'a> Reader<'a> {
    fn walk(&mut self, first: Option<(Dict<'a>, Option<ObjectIdentifier>)>, level: u32) {
        let mut next = first;
        while let Some((item, id)) = next.take() {
            // A sibling or child list that loops back on itself ends there.
            if self.items.len() >= MAX_ITEMS || level > MAX_DEPTH {
                self.dests.walked.stopped = true;
                return;
            }
            if let Some(id) = id
                && !self.seen.insert(id)
            {
                return;
            }
            let title = item
                .get::<PdfString<'_>>(b"Title")
                .map_or_else(String::new, |t| text_string(t.as_bytes()));
            let action = item.get::<Dict<'_>>(b"A");
            let dest = item.get::<Object<'_>>(b"Dest").or_else(|| {
                action
                    .as_ref()
                    .filter(|a| a.get::<Name<'_>>(b"S").is_some_and(|s| s.as_ref() == b"GoTo"))
                    .and_then(|a| a.get::<Object<'_>>(b"D"))
            });
            let page = dest.map_or(-1, |d| self.dests.page_of(d));
            let url = action
                .as_ref()
                .filter(|a| a.get::<Name<'_>>(b"S").is_some_and(|s| s.as_ref() == b"URI"))
                .and_then(|a| a.get::<PdfString<'_>>(b"URI"))
                .map(|u| String::from_utf8_lossy(u.as_bytes()).into_owned());
            self.items.push(OutlineItem { title, level, page, url });
            if let Some(child) = item.get::<Dict<'_>>(b"First") {
                let child_id = item.get_ref(b"First").map(Into::into);
                self.walk(Some((child, child_id)), level + 1);
            }
            next = item
                .get::<Dict<'_>>(b"Next")
                .map(|sibling| (sibling, item.get_ref(b"Next").map(Into::into)));
        }
    }
}

fn name_tree<'a>(node: &Dict<'a>, depth: u32, walked: &mut Walked, out: &mut FxHashMap<Vec<u8>, Object<'a>>) {
    if depth > 32 || out.len() >= MAX_ITEMS || walked.names == MAX_NAME_NODES {
        walked.stopped = true;
        return;
    }
    walked.names += 1;
    if let Some(names) = node.get::<Array<'_>>(b"Names") {
        let mut entries = names.iter::<Object<'_>>();
        while let (Some(key), Some(value)) = (entries.next(), entries.next()) {
            if let Object::String(key) = key {
                out.insert(key.as_bytes().to_vec(), value);
            }
        }
    }
    if let Some(kids) = node.get::<Array<'_>>(b"Kids") {
        for kid in kids.iter::<Dict<'_>>() {
            name_tree(&kid, depth + 1, walked, out);
        }
    }
}

pub fn read(pdf: &Pdf) -> Vec<OutlineItem> {
    read_walked(pdf).0
}

/// How the outline's read went, which is as much work as reading it.
pub fn walked(pdf: &Pdf) -> Walked {
    read_walked(pdf).1
}

fn read_walked(pdf: &Pdf) -> (Vec<OutlineItem>, Walked) {
    let xref = pdf.xref();
    let first = xref
        .get::<Dict<'_>>(xref.root_id())
        .and_then(|root| Some((root.get::<Dict<'_>>(b"Outlines")?, root)));
    let Some((outlines, root)) = first else {
        return Default::default();
    };
    let Some(first) = outlines.get::<Dict<'_>>(b"First") else {
        return Default::default();
    };
    let first_id = outlines.get_ref(b"First").map(Into::into);
    let mut reader = Reader {
        dests: Destinations::new(pdf, root),
        items: Vec::new(),
        seen: FxHashSet::default(),
    };
    // Up front, as it always was: the walk it takes is what `structure_truncated` reports on.
    reader.dests.pages();
    reader.walk(Some((first, first_id)), 0);
    (reader.items, reader.dests.walked)
}

/// Each page's object and its index: every page, so it walks the whole tree.
pub(crate) fn page_map(pdf: &Pdf) -> FxHashMap<ObjectIdentifier, i32> {
    pdf.pages()
        .iter()
        .enumerate()
        // Last first: a page the tree repeats goes to where it first appears.
        .rev()
        .filter_map(|(i, page)| Some((page.raw().obj_id()?, i as i32)))
        .collect()
}
