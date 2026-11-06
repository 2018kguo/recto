//! recto: what a font does with each character code (glyph, stretch,
//! advance, origin displacement, width, Unicode), computed once per code and
//! read from a flat two-level table after that. Text shows the same few
//! hundred codes thousands of times; without it every glyph repeats a CMap
//! range search, a glyph-name lookup and the width stretch (~20% of text
//! extraction in our profiles).

use crate::GlyphId;
use hayro_cmap::BfString;
use kurbo::Vec2;
use std::cell::RefCell;

#[derive(Clone, Debug)]
pub(crate) struct CodeInfo {
    pub(crate) gid: GlyphId,
    pub(crate) stretch: f64,
    pub(crate) advance: Vec2,
    pub(crate) displacement: Vec2,
    pub(crate) width: Option<f32>,
    pub(crate) unicode: Option<BfString>,
}

/// Entries stored densely in the order codes are first seen, so memory
/// follows the distinct codes a document shows, never the code space: a
/// one-byte font's index is 1 KB, wider codes go through a hash map. (Pages
/// of 256 entries let one small file fill gigabytes: one code per page, per
/// font.)
#[derive(Debug, Default)]
pub(crate) struct CodeTable(RefCell<Table>, pub(crate) crate::FontFacts);

#[derive(Debug, Default)]
struct Table {
    /// `1 + index` into `infos` for codes below 256, 0 for none yet.
    small: Option<Box<[u32; 256]>>,
    large: rustc_hash::FxHashMap<u32, u32>,
    infos: Vec<CodeInfo>,
}

impl Table {
    fn slot(&self, code: u32) -> Option<usize> {
        let i = match &self.small {
            _ if code >= 256 => return self.large.get(&code).map(|&i| i as usize),
            Some(small) => small[code as usize],
            None => 0,
        };
        (i > 0).then(|| i as usize - 1)
    }
}

impl CodeTable {
    pub(crate) fn with_facts(facts: crate::FontFacts) -> Self {
        Self(RefCell::default(), facts)
    }

    /// The entry for `code` if the font already computed it.
    pub(crate) fn peek<R>(&self, code: u32, read: impl FnOnce(&CodeInfo) -> R) -> Option<R> {
        let t = self.0.borrow();
        Some(read(&t.infos[t.slot(code)?]))
    }

    /// The entry for `code`, computing it with `compute` the first time.
    pub(crate) fn get<R>(
        &self,
        code: u32,
        compute: impl FnOnce() -> CodeInfo,
        read: impl FnOnce(&CodeInfo) -> R,
    ) -> Option<R> {
        {
            let t = self.0.borrow();
            if let Some(i) = t.slot(code) {
                return Some(read(&t.infos[i]));
            }
        }
        // Computed outside any borrow: `compute` may read the table itself.
        let info = compute();
        let out = read(&info);
        let mut t = self.0.borrow_mut();
        let i = t.infos.len() as u32;
        if code < 256 {
            t.small.get_or_insert_with(|| Box::new([0; 256]))[code as usize] = i + 1;
        } else {
            t.large.insert(code, i);
        }
        t.infos.push(info);
        Some(out)
    }
}
