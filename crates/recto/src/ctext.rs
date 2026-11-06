//! A glyph's or char's text without a heap allocation: what one glyph maps
//! to is almost always one scalar, at most a ligature's few letters. Up to
//! 22 UTF-8 bytes live inline (24 bytes in all, a `String`'s size without
//! its allocation); longer mappings spill to the heap.

use std::ops::Deref;

const INLINE: usize = 22;

#[derive(Clone, PartialEq, Eq)]
pub struct Text(Repr);

#[derive(Clone, PartialEq, Eq)]
enum Repr {
    Inline { len: u8, bytes: [u8; INLINE] },
    Heap(Box<str>),
}

impl Text {
    pub const EMPTY: Text = Text(Repr::Inline {
        len: 0,
        bytes: [0; INLINE],
    });

    pub fn from_char(c: char) -> Self {
        let mut bytes = [0; INLINE];
        let len = c.encode_utf8(&mut bytes).len() as u8;
        Text(Repr::Inline { len, bytes })
    }

    /// The first char, if any: what the text layer's direction and space
    /// tests read, decoded straight from the bytes (no UTF-8 check).
    pub fn first(&self) -> Option<char> {
        match &self.0 {
            Repr::Inline { len: 0, .. } => None,
            Repr::Inline { bytes, .. } => {
                let b0 = bytes[0];
                if b0 < 0x80 {
                    return Some(char::from(b0));
                }
                let width = if b0 >= 0xF0 {
                    4
                } else if b0 >= 0xE0 {
                    3
                } else {
                    2
                };
                let mut c = u32::from(b0) & (0x7F >> width);
                for &b in &bytes[1..width] {
                    c = (c << 6) | u32::from(b & 0x3F);
                }
                char::from_u32(c)
            }
            Repr::Heap(s) => s.chars().next(),
        }
    }

    /// Without the `str` (a heap text is never empty).
    pub fn is_empty(&self) -> bool {
        matches!(self.0, Repr::Inline { len: 0, .. })
    }

    /// Whether the text is exactly one char.
    pub fn is_one_char(&self) -> bool {
        match &self.0 {
            Repr::Inline { len, bytes } => *len > 0 && usize::from(*len) == utf8_width(bytes[0]),
            Repr::Heap(_) => false,
        }
    }
}

fn utf8_width(b0: u8) -> usize {
    match b0 {
        0..0x80 => 1,
        0xF0.. => 4,
        0xE0.. => 3,
        _ => 2,
    }
}

impl From<&str> for Text {
    fn from(s: &str) -> Self {
        if s.len() <= INLINE {
            let mut bytes = [0; INLINE];
            bytes[..s.len()].copy_from_slice(s.as_bytes());
            Text(Repr::Inline {
                len: s.len() as u8,
                bytes,
            })
        } else {
            Text(Repr::Heap(s.into()))
        }
    }
}

impl Deref for Text {
    type Target = str;
    fn deref(&self) -> &str {
        match &self.0 {
            // SAFETY: `Repr` is private and only `from_char` and `From<&str>`
            // fill it, each copying whole UTF-8 from a char or a str. The check
            // this skips was 2% of a WASM text pass.
            Repr::Inline { len, bytes } => unsafe {
                std::str::from_utf8_unchecked(&bytes[..*len as usize])
            },
            Repr::Heap(s) => s,
        }
    }
}

impl Text {
    /// The UTF-8 bytes, without the check `Deref` makes.
    pub fn as_bytes(&self) -> &[u8] {
        match &self.0 {
            Repr::Inline { len, bytes } => &bytes[..usize::from(*len)],
            Repr::Heap(s) => s.as_bytes(),
        }
    }
}

impl PartialEq<str> for Text {
    fn eq(&self, other: &str) -> bool {
        self.as_bytes() == other.as_bytes()
    }
}

impl PartialEq<&str> for Text {
    fn eq(&self, other: &&str) -> bool {
        self.as_bytes() == other.as_bytes()
    }
}

impl std::fmt::Debug for Text {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        (**self).fmt(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_and_heap_read_back() {
        for s in [
            "",
            "a",
            "ﬁ",
            "لا",
            "ffi",
            "abcdefghijklmnopqrstuv",
            "abcdefghijklmnopqrstuvw",
            "日本語のテキスト",
        ] {
            let t = Text::from(s);
            assert_eq!(&*t, s);
            assert_eq!(t, Text::from(s));
        }
        assert_eq!(Text::from_char('𝄞'), Text::from("𝄞"));
        for s in ["", "a", "é", "ש", "日", "𝄞", "fi", "日本"] {
            let t = Text::from(s);
            assert_eq!(t.first(), s.chars().next(), "{s}");
            assert_eq!(t.is_one_char(), s.chars().count() == 1, "{s}");
        }
        assert_eq!(Text::EMPTY, Text::from(""));
        assert_eq!(std::mem::size_of::<Text>(), 24);
    }
}
