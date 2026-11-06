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
    pages: FxHashMap<ObjectIdentifier, i32>,
    /// `Dests` of the catalog, and the name tree's entries, read on first use.
    names: Option<FxHashMap<Vec<u8>, Object<'a>>>,
    root: Dict<'a>,
    items: Vec<OutlineItem>,
    seen: FxHashSet<ObjectIdentifier>,
}

impl<'a> Reader<'a> {
    fn names(&mut self) -> &FxHashMap<Vec<u8>, Object<'a>> {
        let root = self.root.clone();
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
                name_tree(&tree, 0, &mut out);
            }
            out
        })
    }

    /// A destination: an array whose first entry is the page, a name for one, or either of those
    /// wrapped in a dictionary with a `D`.
    fn page_of(&mut self, dest: Object<'a>, hops: u32) -> i32 {
        if hops > 4 {
            return -1;
        }
        match dest {
            Object::Array(array) => self.page_of_array(&array),
            Object::Dict(dict) => dict.get::<Object<'_>>(b"D").map_or(-1, |d| self.page_of(d, hops + 1)),
            Object::Name(name) => {
                let found = self.names().get(name.as_ref()).cloned();
                found.map_or(-1, |d| self.page_of(d, hops + 1))
            }
            Object::String(string) => {
                let found = self.names().get(string.as_bytes()).cloned();
                found.map_or(-1, |d| self.page_of(d, hops + 1))
            }
            _ => -1,
        }
    }

    fn page_of_array(&self, array: &Array<'a>) -> i32 {
        use hayro::hayro_syntax::object::MaybeRef;
        match array.raw_iter().next() {
            Some(MaybeRef::Ref(r)) => self.pages.get(&r.into()).copied().unwrap_or(-1),
            // Some producers write the page's index rather than a reference to it.
            Some(MaybeRef::NotRef(Object::Number(n))) => {
                let page = n.as_i64();
                i32::try_from(page).ok().filter(|p| self.pages.values().any(|v| v == p)).unwrap_or(-1)
            }
            _ => -1,
        }
    }

    fn walk(&mut self, first: Option<(Dict<'a>, Option<ObjectIdentifier>)>, level: u32) {
        let mut next = first;
        while let Some((item, id)) = next.take() {
            // A sibling or child list that loops back on itself ends there.
            if self.items.len() >= MAX_ITEMS || level > MAX_DEPTH {
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
            let page = dest.map_or(-1, |d| self.page_of(d, 0));
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

fn name_tree<'a>(node: &Dict<'a>, depth: u32, out: &mut FxHashMap<Vec<u8>, Object<'a>>) {
    if depth > 32 || out.len() >= MAX_ITEMS {
        return;
    }
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
            name_tree(&kid, depth + 1, out);
        }
    }
}

pub fn read(pdf: &Pdf) -> Vec<OutlineItem> {
    let xref = pdf.xref();
    let Some(root) = xref.get::<Dict<'_>>(xref.root_id()) else {
        return Vec::new();
    };
    let Some(outlines) = root.get::<Dict<'_>>(b"Outlines") else {
        return Vec::new();
    };
    let Some(first) = outlines.get::<Dict<'_>>(b"First") else {
        return Vec::new();
    };
    let first_id = outlines.get_ref(b"First").map(Into::into);
    let pages = pdf
        .pages()
        .iter()
        .enumerate()
        .filter_map(|(i, page)| Some((page.raw().obj_id()?, i as i32)))
        .collect();
    let mut reader = Reader {
        pages,
        names: None,
        root,
        items: Vec::new(),
        seen: FxHashSet::default(),
    };
    reader.walk(Some((first, first_id)), 0);
    reader.items
}
