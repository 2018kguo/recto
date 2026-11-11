pub(crate) mod glyph_names;
pub(crate) mod mac_expert;
pub(crate) mod mac_os_roman;
pub(crate) mod mac_roman;
pub(crate) mod metrics;
pub(crate) mod standard;
pub(crate) mod symbol;
pub(crate) mod tex_glyph_names;
pub(crate) mod win_ansi;
pub(crate) mod zapf_dings;

// recto: the tables were phf maps. As sorted bytes they lose a pointer pair per entry and a SipHash per
// lookup, and compress better: `key 0xFE value 0xFF`, repeated, sorted by key's bytes. Neither
// separator can occur in UTF-8, so a key from a file can't be mistaken for one.

/// The value for `key`, by bisecting the table's entries. Where each entry starts, splits and ends is
/// found the first time a table is read on a thread, one scan of its bytes, so a step only compares
/// one key: a font asks for 256 names as it's opened, and scanning for the separators at each step
/// cost more than the comparisons.
pub(crate) fn by_name(table: &'static [u8], key: &str) -> Option<&'static str> {
    /// An entry's key start, separator and end (its 0xFF).
    type Entries = std::rc::Rc<[[u32; 3]]>;
    thread_local! {
        static ENTRIES: std::cell::RefCell<Vec<(usize, Entries)>> = const { std::cell::RefCell::new(Vec::new()) };
    }
    let entries = ENTRIES.with_borrow_mut(|known| {
        let at = table.as_ptr() as usize;
        if let Some((_, entries)) = known.iter().find(|(t, _)| *t == at) {
            return entries.clone();
        }
        let (mut entries, mut start, mut split) = (Vec::new(), 0, None);
        for (i, &b) in table.iter().enumerate() {
            match b {
                0xFE if split.is_none() => split = Some(i),
                0xFF => {
                    if let Some(split) = split {
                        entries.push([start as u32, split as u32, i as u32]);
                    }
                    (start, split) = (i + 1, None);
                }
                _ => {}
            }
        }
        let entries: Entries = entries.into();
        known.push((at, entries.clone()));
        entries
    });
    let entry = |i: usize| {
        let [start, split, end] = entries[i].map(|n| n as usize);
        Some((&table[start..split], &table[split + 1..end]))
    };
    let (mut low, mut high) = (0, entries.len());
    while low < high {
        let middle = (low + high) / 2;
        let (name, value) = entry(middle)?;
        match name.cmp(key.as_bytes()) {
            core::cmp::Ordering::Less => low = middle + 1,
            core::cmp::Ordering::Greater => high = middle,
            core::cmp::Ordering::Equal => return core::str::from_utf8(value).ok(),
        }
    }
    None
}

const HEX: &[u8; 16] = b"0123456789ABCDEF";

/// A table keyed by a byte, as an array the first time it's read: reading a font's encoding asks
/// about all 256 codes, so bisecting for each costs more than the array, which only a font using
/// that encoding builds.
pub(crate) struct Codes(std::sync::OnceLock<[Option<&'static str>; 256]>);

impl Codes {
    pub(crate) const fn new() -> Self {
        Self(std::sync::OnceLock::new())
    }

    pub(crate) fn get(&self, table: &'static [u8], code: u8) -> Option<&'static str> {
        self.0.get_or_init(|| {
            let mut codes = [None; 256];
            for entry in table.split(|&b| b == 0xFF).filter(|entry| !entry.is_empty()) {
                let (key, value) = (&entry[..2], &entry[3..]);
                let digit = |b: u8| HEX.iter().position(|&h| h == b).unwrap_or(0);
                codes[digit(key[0]) * 16 + digit(key[1])] = core::str::from_utf8(value).ok();
            }
            codes
        })[usize::from(code)]
    }
}

/// A value that's a whole number: a width, or a character code.
pub(crate) fn number(value: &str) -> Option<u16> {
    value.parse().ok()
}

/// A standard font's width for a glyph name.
pub(crate) fn width(table: &'static [u8], name: &str) -> Option<f32> {
    by_name(table, name).and_then(number).map(f32::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bisecting needs every table sorted, and every entry whole.
    #[test]
    fn tables_are_sorted_and_find_each_of_their_keys() {
        let tables = [
            glyph_names::GLYPH_NAMES, tex_glyph_names::TEX_GLYPH_NAMES,
            mac_expert::MAC_EXPERT, mac_os_roman::MAC_OS_ROMAN, mac_os_roman::MAC_OS_ROMAN_INVERSE,
            mac_roman::MAC_ROMAN, mac_roman::MAC_ROMAN_INVERSE, standard::STANDARD, symbol::SYMBOL,
            win_ansi::WIN_ANSI, zapf_dings::ZAPF_DING_BATS, zapf_dings::GLYPH_NAMES,
            metrics::COURIER, metrics::COURIER_BOLD, metrics::COURIER_BOLD_OBLIQUE, metrics::COURIER_OBLIQUE,
            metrics::HELVETICA, metrics::HELVETICA_BOLD, metrics::HELVETICA_BOLD_OBLIQUE, metrics::HELVETICA_OBLIQUE,
            metrics::SYMBOL, metrics::TIMES_BOLD, metrics::TIMES_BOLD_ITALIC, metrics::TIMES_ITALIC,
            metrics::TIMES_ROMAN, metrics::ZAPF_DING_BATS,
        ];
        for table in tables {
            assert_eq!(table.last(), Some(&0xFF));
            let mut previous: &[u8] = &[];
            for entry in table.split(|&b| b == 0xFF).filter(|entry| !entry.is_empty()) {
                let split = entry.iter().position(|&b| b == 0xFE).unwrap();
                let (key, value) = (&entry[..split], &entry[split + 1..]);
                assert!(previous < key, "{key:?} after {previous:?}");
                previous = key;
                assert_eq!(by_name(table, core::str::from_utf8(key).unwrap()).unwrap().as_bytes(), value);
            }
        }
    }

    #[test]
    fn what_a_lookup_answers() {
        assert_eq!(glyph_names::get("A"), Some("A"));
        assert_eq!(glyph_names::get("AEacute"), Some("\u{01FC}"));
        // Control characters are values, so they mustn't read as separators.
        assert_eq!(glyph_names::get("controlHT"), Some("\t"));
        assert_eq!(glyph_names::get_reverse('\n'), Some("controlLF"));
        assert_eq!(glyph_names::get_reverse('A'), Some("A"));
        assert_eq!(glyph_names::get_reverse('\u{A9}'), Some("copyright"));
        assert_eq!(glyph_names::get_reverse('\u{10FFFF}'), None);
        assert_eq!(glyph_names::get(""), None);
        assert_eq!(glyph_names::get("A\u{FE}"), None);
        assert_eq!(glyph_names::get("no such glyph"), None);
        assert_eq!(width(metrics::HELVETICA, "space"), Some(278.0));
        assert_eq!(width(metrics::COURIER, "no such glyph"), None);
        assert_eq!(mac_roman::get_inverse("Adieresis"), Some(128));
        assert_eq!(win_ansi::get(0x41), Some("A"));
        assert_eq!(win_ansi::get(0x7F), Some("bullet"));
        assert_eq!(zapf_dings::glyph_name_to_unicode("a100"), Some('\u{275E}'));
    }
}
