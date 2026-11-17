//! recto: a fast path for reading a dictionary outside a content stream, after lol_html's tag
//! scanner, which reads only what a document plainly says and hands anything else to its full
//! lexer. `dict` reads the common, clean forms (names without `#`, plain numbers, references,
//! strings, arrays, dictionaries, `true`, `false` and `null`, one token after another) in one pass
//! over the bytes, without the reader's backtracking: a number that isn't a reference is read once,
//! not once as the start of a reference and again as a number. Anything else (a comment, a key with
//! `#`, stray tokens, a keyword glued to what follows, deep nesting) gives `None`, and the caller
//! reads the dictionary the full way, so what's accepted, where it ends and the offset of each value
//! are exactly what `parse_dict_with` gives (`dict_both`, for recto's test that they agree).

use crate::trivia::{is_regular_character, is_white_space_character};

/// Deeper than this goes the full way (whose limit is far deeper).
const MAX_DEPTH: usize = 32;

/// The dictionary at the start of `d` (from its `<<`): its length, with `on_entry` given each
/// top-level key's name (after `/`, without `#`) and the offset of its value, in order. `None` for
/// anything this doesn't read; `on_entry` may have been called for some keys by then.
pub(crate) fn dict<'a>(d: &'a [u8], on_entry: &mut dyn FnMut(&'a [u8], usize)) -> Option<usize> {
    if d.get(..2)? != b"<<" {
        return None;
    }
    let mut i = 2;
    loop {
        i = white(d, i)?;
        match *d.get(i)? {
            b'>' => return (d.get(i + 1) == Some(&b'>')).then_some(i + 2),
            b'/' => {
                let end = regular_end(d, i + 1);
                let name = &d[i + 1..end];
                if name.contains(&b'#') {
                    return None;
                }
                i = white(d, end)?;
                on_entry(name, i);
                i = value(d, i, 1)?;
            }
            _ => return None,
        }
    }
}

/// Past white space; `None` at a comment, which goes the full way.
#[inline]
fn white(d: &[u8], mut i: usize) -> Option<usize> {
    while let Some(&b) = d.get(i) {
        if is_white_space_character(b) {
            i += 1;
        } else if b == b'%' {
            return None;
        } else {
            break;
        }
    }
    Some(i)
}

#[inline]
fn regular_end(d: &[u8], mut i: usize) -> usize {
    while d.get(i).is_some_and(|&b| is_regular_character(b)) {
        i += 1;
    }
    i
}

fn digits_end(d: &[u8], mut i: usize) -> usize {
    while d.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    i
}

/// Whether what's at `i` is followed by nothing or a delimiter or white space.
#[inline]
fn ends(d: &[u8], i: usize) -> bool {
    !d.get(i).is_some_and(|&b| is_regular_character(b))
}

/// An integer as `u32`'s and `i32`'s skip read one, sign and all: where it ends, if it does.
fn int_end(d: &[u8], i: usize) -> Option<usize> {
    let start = i + usize::from(matches!(d.get(i), Some(b'+' | b'-')));
    let end = digits_end(d, start);
    (end > start && d.get(end) != Some(&b'.') && ends(d, end)).then_some(end)
}

/// Past the value at `i` (a dictionary's or an array's), as `MaybeRef<Object>` skips it.
fn value(d: &[u8], i: usize, depth: usize) -> Option<usize> {
    let end = match *d.get(i)? {
        b'/' => regular_end(d, i + 1),
        b'0'..=b'9' | b'+' | b'-' | b'.' => {
            // A reference: what `ObjRef`'s skip reads, tried first as `MaybeRef` tries it.
            if let Some(first) = int_end(d, i) {
                let mut j = first;
                while d.get(j).is_some_and(|&b| is_white_space_character(b)) {
                    j += 1;
                }
                if let Some(second) = int_end(d, j) {
                    let mut k = second;
                    while d.get(k).is_some_and(|&b| is_white_space_character(b)) {
                        k += 1;
                    }
                    if d.get(k) == Some(&b'R') {
                        return ends(d, k + 1).then_some(k + 1);
                    }
                }
                first
            } else {
                // Otherwise a number as `Number`'s skip reads it, in its plain forms only.
                let start = i + usize::from(matches!(d[i], b'+' | b'-'));
                let whole = digits_end(d, start);
                let end = if d.get(whole) == Some(&b'.') {
                    let frac = digits_end(d, whole + 1);
                    (frac > whole + 1).then_some(frac)?
                } else {
                    whole
                };
                (whole > start || end > whole).then_some(end)?
            }
        }
        b'(' => {
            // `skip_literal`.
            let mut depth = 1;
            let mut j = i + 1;
            while depth > 0 {
                match *d.get(j)? {
                    b'\\' => j += 1,
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                j += 1;
            }
            return Some(j);
        }
        b'<' if d.get(i + 1) == Some(&b'<') => {
            if depth >= MAX_DEPTH {
                return None;
            }
            let mut j = i + 2;
            loop {
                j = white(d, j)?;
                match *d.get(j)? {
                    b'>' if d.get(j + 1) == Some(&b'>') => return Some(j + 2),
                    b'/' => {
                        j = white(d, regular_end(d, j + 1))?;
                        j = value(d, j, depth + 1)?;
                    }
                    _ => return None,
                }
            }
        }
        b'<' => {
            // `skip_hex`.
            let mut j = i + 1;
            while d
                .get(j)
                .is_some_and(|&b| b.is_ascii_hexdigit() || is_white_space_character(b))
            {
                j += 1;
            }
            return (d.get(j) == Some(&b'>')).then_some(j + 1);
        }
        b'[' => {
            if depth >= MAX_DEPTH {
                return None;
            }
            let mut j = i + 1;
            loop {
                j = white(d, j)?;
                if d.get(j) == Some(&b']') {
                    return Some(j + 1);
                }
                j = value(d, j, depth + 1)?;
            }
        }
        b't' if d[i..].starts_with(b"true") => i + 4,
        b'f' if d[i..].starts_with(b"false") => i + 5,
        b'n' if d[i..].starts_with(b"null") => i + 4,
        _ => return None,
    };
    ends(d, end).then_some(end)
}

/// recto: the dictionary at the start of `d` read this way and the full way, each as its length and
/// its keys with their values' offsets, for the test that they agree wherever this way reads one.
#[doc(hidden)]
#[allow(clippy::type_complexity)]
pub fn dict_both(d: &[u8]) -> [Option<(usize, Vec<(Vec<u8>, usize)>)>; 2] {
    use crate::object::Name;
    use crate::reader::{Reader, ReaderContext};
    let mut entries = Vec::new();
    let fast = dict(d, &mut |name, offset| entries.push((name.to_vec(), offset)))
        .map(|len| (len, entries));
    let mut entries = Vec::new();
    let full = crate::object::dict::parse_dict_with(
        &mut Reader::new(d),
        &ReaderContext::dummy(),
        Some(b"<<"),
        b">>",
        |name: Name<'_>, offset, _: &Reader<'_>| {
            entries.push((name.to_vec(), offset));
            Some(())
        },
    )
    .map(|data| (data.len(), entries));
    [fast, full]
}
