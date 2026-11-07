//! Page labels: what a viewer calls each page ("iv", "A-5"), from the catalog's number tree.

use crate::annots::text_string;
use hayro::hayro_syntax::Pdf;
use hayro::hayro_syntax::object::{Array, Dict, Name, String as PdfString};

const MAX_DEPTH: u32 = 32;
const MAX_RANGES: usize = 1 << 16;

struct Range {
    first: usize,
    style: Option<u8>,
    prefix: String,
    start: i64,
}

fn collect(node: &Dict<'_>, depth: u32, out: &mut Vec<Range>) {
    if depth > MAX_DEPTH || out.len() >= MAX_RANGES {
        return;
    }
    if let Some(nums) = node.get::<Array<'_>>(b"Nums") {
        let mut items = nums.iter::<hayro::hayro_syntax::object::Object<'_>>();
        while let (Some(key), Some(value)) = (items.next(), items.next()) {
            let (Ok(first), Some(label)) = (i64::try_from(key).and_then(|n| usize::try_from(n).map_err(|_| ())), value.into_dict()) else {
                continue;
            };
            out.push(Range {
                first,
                style: label.get::<Name<'_>>(b"S").and_then(|s| s.as_ref().first().copied()),
                prefix: label.get::<PdfString<'_>>(b"P").map_or_else(String::new, |p| text_string(p.as_bytes())),
                start: label.get::<i64>(b"St").unwrap_or(1).max(1),
            });
            if out.len() >= MAX_RANGES {
                return;
            }
        }
    }
    if let Some(kids) = node.get::<Array<'_>>(b"Kids") {
        for kid in kids.iter::<Dict<'_>>() {
            collect(&kid, depth + 1, out);
        }
    }
}

fn roman(mut value: i64) -> String {
    const NUMERALS: [(i64, &str); 13] = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")];
    // Past this it's only a run of m's, and a damaged /St could make it any length.
    value = value.min(100_000);
    let mut out = String::new();
    for (size, numeral) in NUMERALS {
        while value >= size {
            out.push_str(numeral);
            value -= size;
        }
    }
    out
}

/// a..z, then aa, bb, .. zz, then aaa: the same letter repeated, as the spec has it.
fn letters(value: i64) -> String {
    let index = (value - 1) as u64;
    let letter = (b'a' + (index % 26) as u8) as char;
    // As with roman numerals: a damaged /St mustn't ask for a gigabyte of a letter.
    let count = (index / 26 + 1).min(4096) as usize;
    std::iter::repeat_n(letter, count).collect()
}

fn number(style: Option<u8>, value: i64) -> String {
    match style {
        Some(b'D') => value.to_string(),
        Some(b'r') => roman(value),
        Some(b'R') => roman(value).to_uppercase(),
        Some(b'a') => letters(value),
        Some(b'A') => letters(value).to_uppercase(),
        _ => String::new(),
    }
}

/// A label for every page, or None if the file doesn't give any. A page before the first range is
/// numbered from 1, as a page with no labels would be.
pub fn read(pdf: &Pdf, pages: usize) -> Option<Vec<String>> {
    let xref = pdf.xref();
    let root = xref.get::<Dict<'_>>(xref.root_id())?;
    let tree = root.get::<Dict<'_>>(b"PageLabels")?;
    let mut ranges = Vec::new();
    collect(&tree, 0, &mut ranges);
    if ranges.is_empty() {
        return None;
    }
    ranges.sort_by_key(|range| range.first);
    let mut out = Vec::with_capacity(pages);
    let mut next = 0;
    for page in 0..pages {
        while ranges.get(next).is_some_and(|range| range.first <= page) {
            next += 1;
        }
        out.push(match next.checked_sub(1).and_then(|i| ranges.get(i)) {
            Some(range) => {
                let offset = i64::try_from(page - range.first).unwrap_or(i64::MAX);
                format!("{}{}", range.prefix, number(range.style, range.start.saturating_add(offset)))
            }
            None => (page + 1).to_string(),
        });
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{letters, roman};

    #[test]
    fn numerals_and_letters() {
        assert_eq!(roman(1994), "mcmxciv");
        assert_eq!(roman(4), "iv");
        assert_eq!(letters(1), "a");
        assert_eq!(letters(26), "z");
        assert_eq!(letters(27), "aa");
        assert_eq!(letters(53), "aaa");
        assert!(letters(i64::MAX).len() <= 4096);
        assert!(roman(i64::MAX).len() <= 100);
    }
}
