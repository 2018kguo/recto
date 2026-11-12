//! Strings.

use crate::crypto::DecryptionTarget;
use crate::filter::ascii_hex;
use crate::object::Object;
use crate::object::macros::object;
use crate::reader::Reader;
use crate::reader::{Readable, ReaderContext, ReaderExt, Skippable};
use crate::trivia::is_white_space_character;
use alloc::vec::Vec;
use core::borrow::Borrow;
use core::hash::{Hash, Hasher};
use core::ops::Deref;
use smallvec::SmallVec;

#[derive(Clone)]
enum StringInner<'a> {
    Borrowed(&'a [u8]),
    Owned(SmallVec<[u8; 23]>),
}

impl AsRef<[u8]> for StringInner<'_> {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Borrowed(data) => data,
            Self::Owned(data) => data,
        }
    }
}

/// A PDF string object.
#[derive(Clone)]
pub struct String<'a>(StringInner<'a>);

impl<'a> String<'a> {
    /// Returns the string data as a byte slice.
    pub fn as_bytes(&self) -> &[u8] {
        self.as_ref()
    }
}

impl Deref for String<'_> {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.as_ref()
    }
}

impl AsRef<[u8]> for String<'_> {
    fn as_ref(&self) -> &[u8] {
        match &self.0 {
            StringInner::Borrowed(data) => data,
            StringInner::Owned(data) => data,
        }
    }
}

impl Borrow<[u8]> for String<'_> {
    fn borrow(&self) -> &[u8] {
        self.as_ref()
    }
}

impl PartialEq for String<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.as_ref() == other.as_ref()
    }
}

impl Eq for String<'_> {}

impl Hash for String<'_> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.as_ref().hash(state);
    }
}

impl core::fmt::Debug for String<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        <[u8] as core::fmt::Debug>::fmt(self.as_ref(), f)
    }
}

impl core::fmt::Display for String<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match core::str::from_utf8(self.as_bytes()) {
            Ok(value) => write!(f, "{value:?}"),
            Err(_) => write!(f, "{:?}", self.as_bytes()),
        }
    }
}

object!(String<'a>, String);

impl Skippable for String<'_> {
    fn skip(r: &mut Reader<'_>, _: bool) -> Option<()> {
        match r.peek_byte()? {
            b'<' => skip_hex(r),
            b'(' => skip_literal(r),
            _ => None,
        }
    }
}

impl<'a> Readable<'a> for String<'a> {
    fn read(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self> {
        let decoded = match r.peek_byte()? {
            b'<' => StringInner::Owned(read_hex(r)?),
            b'(' => read_literal(r)?,
            _ => return None,
        };

        // Apply decryption if needed.
        let final_data = if ctx.xref().needs_decryption(ctx) {
            if let Some(obj_number) = ctx.obj_number() {
                ctx.xref()
                    .decrypt(obj_number, decoded.as_ref(), DecryptionTarget::String)
                    .map(StringInner::from)
                    .unwrap_or(decoded)
            } else {
                decoded
            }
        } else {
            decoded
        };

        Some(Self(final_data))
    }
}

impl From<Vec<u8>> for StringInner<'_> {
    fn from(value: Vec<u8>) -> Self {
        Self::Owned(SmallVec::from_vec(value))
    }
}

fn skip_hex(r: &mut Reader<'_>) -> Option<()> {
    r.forward_tag(b"<")?;
    while let Some(b) = r.peek_byte() {
        let is_hex = b.is_ascii_hexdigit();
        let is_whitespace = is_white_space_character(b);

        if !is_hex && !is_whitespace {
            break;
        }

        r.read_byte()?;
    }
    r.forward_tag(b">")?;

    Some(())
}

fn read_hex(r: &mut Reader<'_>) -> Option<SmallVec<[u8; 23]>> {
    let start = r.offset();
    skip_hex(r)?;
    let end = r.offset();

    // Exclude outer brackets.
    let raw = r.range(start + 1..end - 1)?;
    let decoded = ascii_hex::decode_into(raw)?;

    Some(decoded)
}

fn skip_literal(r: &mut Reader<'_>) -> Option<()> {
    r.forward_tag(b"(")?;
    let mut bracket_counter = 1;

    while bracket_counter > 0 {
        let byte = r.read_byte()?;

        match byte {
            b'\\' => {
                let _ = r.read_byte()?;
            }
            b'(' => bracket_counter += 1,
            b')' => bracket_counter -= 1,
            _ => {}
        };
    }

    Some(())
}

fn read_literal<'a>(r: &mut Reader<'a>) -> Option<StringInner<'a>> {
    let start = r.offset();
    skip_literal(r)?;
    let end = r.offset();

    // Exclude outer parentheses.
    let data = r.range(start + 1..end - 1)?;

    if !data.iter().any(|b| matches!(b, b'\\' | b'\n' | b'\r')) {
        return Some(StringInner::Borrowed(data));
    }

    let mut r = Reader::new(data);
    let mut result = SmallVec::new();

    loop {
        // An end-of-line marker appearing within a literal string
        // without a preceding REVERSE SOLIDUS shall be treated as
        // a byte value of (0Ah), irrespective of whether the end-of-line
        // marker was a CARRIAGE RETURN (0Dh), a LINE FEED (0Ah), or both.
        if r.read_eol().is_some() {
            result.push(b'\n');
            continue;
        }

        let Some(byte) = r.read_byte() else {
            break;
        };

        match byte {
            b'\\' => {
                // A conforming reader shall disregard the REVERSE SOLIDUS
                // and the end-of-line marker following it when reading
                // the string; the resulting string value shall be
                // identical to that which would be read if the string
                // were not split.
                if r.read_eol().is_some() {
                    continue;
                }

                let next = r.read_byte()?;

                if is_octal_digit(next) {
                    let second = r.read_byte();
                    let third = r.read_byte();

                    let bytes = match (second, third) {
                        (Some(n1), Some(n2)) => match (is_octal_digit(n1), is_octal_digit(n2)) {
                            (true, true) => [next, n1, n2],
                            (true, _) => {
                                r.jump(r.offset() - 1);
                                [b'0', next, n1]
                            }
                            _ => {
                                r.jump(r.offset() - 2);
                                [b'0', b'0', next]
                            }
                        },
                        (Some(n1), None) => {
                            if is_octal_digit(n1) {
                                [b'0', next, n1]
                            } else {
                                r.jump(r.offset() - 1);
                                [b'0', b'0', next]
                            }
                        }
                        _ => [b'0', b'0', next],
                    };

                    let str = core::str::from_utf8(&bytes).unwrap();

                    if let Ok(num) = u8::from_str_radix(str, 8) {
                        result.push(num);
                    }
                } else {
                    match next {
                        b'n' => result.push(0xA),
                        b'r' => result.push(0xD),
                        b't' => result.push(0x9),
                        b'b' => result.push(0x8),
                        b'f' => result.push(0xC),
                        b'(' => result.push(b'('),
                        b')' => result.push(b')'),
                        b'\\' => result.push(b'\\'),
                        _ => result.push(next),
                    }
                }
            }
            b'(' | b')' => result.push(byte),
            other => result.push(other),
        }
    }

    Some(StringInner::Owned(result))
}

fn is_octal_digit(byte: u8) -> bool {
    matches!(byte, b'0'..=b'7')
}
