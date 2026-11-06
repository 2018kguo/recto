//! recto: a content-stream lexer for the text pass. Operands are spans into
//! the stream (numbers parsed in place); strings, arrays and dicts are skipped
//! to their end and read only when a text operator needs them. Where the
//! stream is malformed it stops, skips or clears operands as `UntypedIter`
//! does.

/// One operand. Spans are byte offsets into the stream.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Operand {
    Num(f64),
    /// The name's bytes after `/`, still `#`-escaped.
    Name(u32, u32),
    /// `(...)` with the parentheses, or `<...>` with the angle brackets.
    Str(u32, u32),
    /// `[...]` with the brackets.
    Array(u32, u32),
    /// `<<...>>` with the brackets.
    Dict(u32, u32),
}

pub struct Lexer<'a> {
    data: &'a [u8],
    pos: usize,
    op_start: usize,
    /// The operands of the operator `next` returned.
    pub operands: Vec<Operand>,
}

use hayro_syntax::object::{Name, Number};

/// The operators the text-only interpreter acts on, for one spelled with
/// `#` escapes (anything else comes back as `#`, which nothing reads).
const ESCAPABLE: &[&[u8]] = &[
    b"q", b"Q", b"cm", b"gs", b"g", b"rg", b"k", b"G", b"RG", b"K", b"sc", b"SC", b"scn", b"SCN",
    b"cs", b"CS", b"BDC", b"BMC", b"EMC", b"BT", b"ET", b"Tf", b"Tc", b"Tw", b"Tz", b"TL", b"Ts",
    b"Tr", b"Td", b"TD", b"Tm", b"T*", b"Tj", b"'", b"\"", b"TJ", b"Do", b"m", b"l", b"v", b"y",
    b"re", b"c", b"BI",
];
use hayro_syntax::reader::{Reader, ReaderExt};

const WHITE: u8 = 1;
const DELIM: u8 = 2;

/// White space and delimiters; 0 is a regular character.
static CLASS: [u8; 256] = {
    let mut t = [0; 256];
    let white = b" \n\r\t\x0c\0";
    let mut i = 0;
    while i < white.len() {
        t[white[i] as usize] = WHITE;
        i += 1;
    }
    let delim = b"()<>[]{}/%";
    let mut i = 0;
    while i < delim.len() {
        t[delim[i] as usize] = DELIM;
        i += 1;
    }
    t
};

#[inline]
fn is_white(b: u8) -> bool {
    CLASS[b as usize] == WHITE
}

#[inline]
fn is_regular(b: u8) -> bool {
    CLASS[b as usize] == 0
}

/// Past white space and comments from `i`.
#[inline]
pub(crate) fn skip_white(d: &[u8], mut i: usize) -> usize {
    while let Some(&b) = d.get(i) {
        if is_white(b) {
            i += 1;
        } else if b == b'%' {
            while d.get(i).is_some_and(|&b| b != b'\n' && b != b'\r') {
                i += 1;
            }
        } else {
            break;
        }
    }
    i
}

#[inline]
fn regular_end(d: &[u8], mut i: usize) -> usize {
    while d.get(i).is_some_and(|&b| is_regular(b)) {
        i += 1;
    }
    i
}

const POW10: [f64; 19] = [
    1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
    1e17, 1e18,
];

/// Whether hayro reads the operand: the lexer only finds where a dict or
/// array ends and leaves a name's escapes, and an operand hayro can't read
/// ends the stream.
pub(crate) fn readable(d: &[u8], o: &Operand) -> bool {
    use hayro_syntax::object::{Array, Dict};
    match *o {
        Operand::Dict(s, e) => Reader::new(&d[s as usize..e as usize])
            .read_without_context::<Dict<'_>>()
            .is_some(),
        Operand::Array(s, e) => Reader::new(&d[s as usize..e as usize])
            .read_without_context::<Array<'_>>()
            .is_some(),
        Operand::Name(s, e) => {
            let raw = &d[s as usize..e as usize];
            !raw.contains(&b'#') || Name::new_escaped(raw).is_some()
        }
        _ => true,
    }
}

/// The number starting at `start` (a sign, digit or `.`) and where it ends;
/// `None` for a bogus one, such as one glued to letters, which ends after them.
#[inline]
pub(crate) fn number(d: &[u8], start: usize) -> (Option<f64>, usize) {
    // hayro's `read_simple`: up to 18 digits with an optional point, then a
    // delimiter or white space.
    let mut i = start;
    let neg = d[i] == b'-';
    if matches!(d[i], b'-' | b'+') {
        i += 1;
    }
    let mut mantissa = 0u64;
    let digits_start = i;
    while let Some(v) = d.get(i).map(|b| b.wrapping_sub(b'0')).filter(|v| *v < 10) {
        mantissa = mantissa.wrapping_mul(10).wrapping_add(u64::from(v));
        i += 1;
    }
    let mut digits = i - digits_start;
    let mut frac = 0;
    if d.get(i) == Some(&b'.') {
        i += 1;
        let frac_start = i;
        while let Some(v) = d.get(i).map(|b| b.wrapping_sub(b'0')).filter(|v| *v < 10) {
            mantissa = mantissa.wrapping_mul(10).wrapping_add(u64::from(v));
            i += 1;
        }
        frac = i - frac_start;
        digits += frac;
    }
    // Limit: an integer past 2^53 rounds to f32 through f64 here, where
    // hayro rounds from i64; only absurd operands (1e16 and up) can differ.
    if digits > 0 && digits <= 18 && !d.get(i).is_some_and(|&b| is_regular(b)) {
        let v = mantissa as f64 / POW10[frac];
        return (Some(if neg { -v } else { v }), i);
    }
    // Anything else (`-` or `.` alone, a trailing minus, overflow, letters
    // after) as hayro's full number reader takes it.
    let mut r = Reader::new(&d[start..]);
    match r.read_without_context::<Number>() {
        Some(n) => (Some(n.as_f64()), start + r.offset()),
        None => (None, regular_end(d, start)),
    }
}

impl<'a> Lexer<'a> {
    /// A lexer at the start of `data`.
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            op_start: 0,
            operands: Vec::with_capacity(8),
        }
    }

    /// The next operator, its operands in `self.operands`; `None` at the end.
    pub fn next(&mut self) -> Option<&'a [u8]> {
        self.operands.clear();
        loop {
            self.pos = skip_white(self.data, self.pos);
            let &b = self.data.get(self.pos)?;
            let start = self.pos;
            let operand = match b {
                b'0'..=b'9' | b'+' | b'-' | b'.' => {
                    let (n, end) = number(self.data, start);
                    self.pos = end;
                    match n {
                        Some(n) => Operand::Num(n),
                        // hayro skips a number glued to letters as a
                        // bogus operator, dropping the operands before it.
                        None => {
                            if !self.operands.iter().all(|o| readable(self.data, o)) {
                                return self.stop();
                            }
                            self.operands.clear();
                            continue;
                        }
                    }
                }
                b'/' => {
                    let end = regular_end(self.data, start + 1);
                    self.pos = end;
                    Operand::Name(start as u32 + 1, end as u32)
                }
                b'(' => {
                    self.pos = skip_literal(self.data, start);
                    Operand::Str(start as u32, self.pos as u32)
                }
                b'<' if self.data.get(start + 1) == Some(&b'<') => {
                    self.pos = skip_nested(self.data, start);
                    Operand::Dict(start as u32, self.pos as u32)
                }
                b'<' => match hex_end(self.data, start) {
                    Some(end) => {
                        self.pos = end;
                        Operand::Str(start as u32, end as u32)
                    }
                    // An unreadable operand ends the stream.
                    None => return self.stop(),
                },
                b'[' => {
                    self.pos = skip_nested(self.data, start);
                    Operand::Array(start as u32, self.pos as u32)
                }
                // Not an operand, nor an operator: the stream ends.
                b')' | b'>' | b']' | b'}' | b'{' => return self.stop(),
                _ => {
                    let end = regular_end(self.data, start);
                    self.pos = end;
                    let op = &self.data[start..end];
                    self.op_start = start;
                    // `true`, `false` and `null` read as (unknown) operators too.
                    if op.contains(&b'#') {
                        // hayro decodes an operator's escapes; a bad one ends the stream.
                        let Some(name) = Name::new_escaped(op) else {
                            return self.stop();
                        };
                        return Some(
                            ESCAPABLE
                                .iter()
                                .find(|k| **k == &*name)
                                .copied()
                                .unwrap_or(b"#"),
                        );
                    }
                    return Some(op);
                }
            };
            // More operands than any operator takes end the stream.
            if self.operands.len() >= 33 {
                return self.stop();
            }
            self.operands.push(operand);
        }
    }

    /// Where the operator `next` returned starts.
    pub fn op_start(&self) -> usize {
        self.op_start
    }

    fn stop(&mut self) -> Option<&'a [u8]> {
        self.pos = self.data.len();
        None
    }
}

/// Past the `)` closing the literal string at `start`.
/// Past the `>` closing the hex string at `start`, if only hex digits and
/// white space come before it.
pub(crate) fn hex_end(d: &[u8], start: usize) -> Option<usize> {
    let p = d[start + 1..]
        .iter()
        .position(|&b| !b.is_ascii_hexdigit() && !is_white(b))?;
    (d[start + 1 + p] == b'>').then_some(start + p + 2)
}

pub(crate) fn skip_literal(d: &[u8], start: usize) -> usize {
    let mut depth = 0u32;
    let mut i = start;
    while let Some(&b) = d.get(i) {
        match b {
            b'\\' => i += 1,
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    d.len()
}

/// Past the bracket closing the array or dict at `start`, strings skipped.
fn skip_nested(d: &[u8], start: usize) -> usize {
    let mut depth = 0u32;
    let mut i = start;
    while let Some(&b) = d.get(i) {
        match b {
            b'(' => {
                i = skip_literal(d, i);
                continue;
            }
            b'[' => depth += 1,
            b'<' if d.get(i + 1) == Some(&b'<') => {
                depth += 1;
                i += 1;
            }
            // A hex string: its `>` must not pair with the next one as `>>`.
            b'<' => {
                i = d[i..]
                    .iter()
                    .position(|&b| b == b'>')
                    .map_or(d.len(), |p| i + p + 1);
                continue;
            }
            b'>' if d.get(i + 1) == Some(&b'>') => {
                depth -= 1;
                i += 1;
            }
            b']' => depth -= 1,
            b'%' => {
                while d.get(i).is_some_and(|&b| b != b'\n' && b != b'\r') {
                    i += 1;
                }
                continue;
            }
            _ => {}
        }
        i += 1;
        if depth == 0 {
            return i;
        }
    }
    d.len()
}
