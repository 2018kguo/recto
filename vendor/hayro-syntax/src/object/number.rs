//! Numbers.

use crate::math::powi_f64;
use crate::object::macros::object;
use crate::object::{Object, ObjectLike};
use crate::reader::Reader;
use crate::reader::{Readable, ReaderContext, ReaderExt, Skippable};
use crate::trivia::is_regular_character;
use core::fmt::{Debug, Display, Formatter};

#[rustfmt::skip]
static POWERS_OF_10: [f64; 20] = [
    1.0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9,
    1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19,
];

/// A number.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Number(pub(crate) InternalNumber);

impl Number {
    /// The number zero.
    pub const ZERO: Self = Self::from_i32(0);
    /// The number one.
    pub const ONE: Self = Self::from_i32(1);

    /// Returns the number as a f64.
    pub fn as_f64(&self) -> f64 {
        match self.0 {
            InternalNumber::Real(r) => r,
            InternalNumber::Integer(i) => i as f64,
        }
    }

    /// Returns the number as a f32.
    pub fn as_f32(&self) -> f32 {
        match self.0 {
            InternalNumber::Real(r) => r as f32,
            InternalNumber::Integer(i) => i as f32,
        }
    }

    /// Returns the number as an i64.
    pub fn as_i64(&self) -> i64 {
        match self.0 {
            InternalNumber::Real(r) => r as i64,
            InternalNumber::Integer(i) => i,
        }
    }

    /// Create a new `Number` from an f32 number.
    pub const fn from_f32(num: f32) -> Self {
        Self(InternalNumber::Real(num as f64))
    }

    /// Create a new `Number` from an i32 number.
    pub const fn from_i32(num: i32) -> Self {
        Self(InternalNumber::Integer(num as i64))
    }
}

impl Display for Number {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        match self.0 {
            InternalNumber::Real(value) => write!(f, "{value:?}"),
            InternalNumber::Integer(value) => write!(f, "{value}"),
        }
    }
}

impl Skippable for Number {
    fn skip(r: &mut Reader<'_>, _: bool) -> Option<()> {
        let has_sign = r.forward_if(|b| b == b'+' || b == b'-').is_some();

        // Some PDFs have weird trailing minuses, so try to accept those as well.
        match r.peek_byte()? {
            b'.' => {
                r.read_byte()?;
                // See PDFJS-9252 - treat a single . as 0.
                r.forward_while(is_digit_or_minus);
            }
            b'0'..=b'9' | b'-' => {
                r.forward_while_1(is_digit_or_minus)?;
                if let Some(()) = r.forward_tag(b".") {
                    r.forward_while(is_digit_or_minus);
                }
            }
            // See PDFJS-bug1753983 and PDFJS-bug1953099 - accept just + or - as a zero.
            _ if has_sign => {}
            _ => return None,
        }

        // See issue 994. Don't accept numbers that are followed by a regular character.
        if r.peek_byte().is_some_and(is_regular_character) {
            return None;
        }

        Some(())
    }
}

impl Readable<'_> for Number {
    #[inline]
    fn read(r: &mut Reader<'_>, _: &ReaderContext<'_>) -> Option<Self> {
        let old_offset = r.offset();
        Self::read_simple(r)
            .or_else(|| {
                r.jump(old_offset);
                read_inner(r)
            })
            .or_else(|| {
                r.jump(old_offset);
                None
            })
    }
}

impl Number {
    #[inline(always)]
    pub(crate) fn read_simple(r: &mut Reader<'_>) -> Option<Self> {
        let negative = match r.peek_byte() {
            Some(b'-') => {
                r.forward();
                true
            }
            Some(b'+') => {
                r.forward();
                false
            }
            _ => false,
        };

        let mut mantissa: u64 = 0;
        let mut read_digits = |r: &mut Reader<'_>| {
            let start = r.offset();
            while let Some(d) = r
                .peek_byte()
                .map(|b| b.wrapping_sub(b'0'))
                .filter(|d| *d < 10)
            {
                mantissa = mantissa.wrapping_mul(10).wrapping_add(d as u64);
                r.forward();
            }
            r.offset() - start
        };

        let mut digits = read_digits(r);
        let mut decimal_shift = None;
        if r.peek_byte() == Some(b'.') {
            r.forward();
            let fraction_digits = read_digits(r);
            decimal_shift = Some(fraction_digits as u32);
            digits += fraction_digits;
        }

        if digits == 0 || digits > 18 || r.peek_byte().is_some_and(is_regular_character) {
            return None;
        }

        Some(Self::from_parts(negative, mantissa, decimal_shift))
    }

    #[inline(always)]
    fn from_parts(negative: bool, mantissa: u64, decimal_shift: Option<u32>) -> Self {
        match decimal_shift {
            None => {
                let value = mantissa as i64;
                Self(InternalNumber::Integer(if negative {
                    value.wrapping_neg()
                } else {
                    value
                }))
            }
            Some(shift) => {
                let divisor = match POWERS_OF_10.get(shift as usize) {
                    Some(power) => *power,
                    None => powi_f64(10.0, shift),
                };
                let value = mantissa as f64 / divisor;
                Self(InternalNumber::Real(if negative { -value } else { value }))
            }
        }
    }
}

#[inline(always)]
fn read_inner(r: &mut Reader<'_>) -> Option<Number> {
    let start_offset = r.offset();
    let (has_sign, negative) = match r.peek_byte()? {
        b'-' => {
            r.forward();
            (true, true)
        }
        b'+' => {
            r.forward();
            (true, false)
        }
        _ => (false, false),
    };

    let mut mantissa: u64 = 0;
    let mut has_dot = false;
    let mut decimal_shift: u32 = 0;
    let mut has_digits = false;
    let mut overflowed = false;
    let mut number_end = None;

    loop {
        match r.peek_byte() {
            Some(b'0'..=b'9') => {
                let d = r.read_byte().unwrap();
                if !overflowed {
                    if let Some(value) = mantissa
                        .checked_mul(10)
                        .and_then(|v| v.checked_add((d - b'0') as u64))
                    {
                        mantissa = value;
                    } else {
                        overflowed = true;
                    }
                }
                has_digits = true;
                if has_dot {
                    decimal_shift += 1;
                }
            }
            Some(b'.') if !has_dot => {
                r.forward();
                has_dot = true;
            }
            // Some weird PDFs have trailing minus in the fraction of number.
            Some(b'-') if has_digits => {
                number_end = Some(r.offset());
                r.forward();
                r.forward_while(is_digit_or_minus);
                break;
            }
            _ => break,
        }
    }

    if !has_digits {
        if has_dot || (has_sign && r.peek_byte().is_some_and(|b| !is_regular_character(b))) {
            // Treat numbers like just `-`, `+` or `-.` as zero.
            return Some(Number(InternalNumber::Integer(0)));
        }
        return None;
    }

    // See issue 994. Don't accept numbers that are followed by a regular character
    // without any white space in-between.
    if r.peek_byte().is_some_and(is_regular_character) {
        return None;
    }

    let integer_overflow = !has_dot && mantissa > i64::MAX as u64;

    if overflowed || integer_overflow {
        let end_offset = number_end.unwrap_or_else(|| r.offset());
        let number = core::str::from_utf8(r.range(start_offset..end_offset)?).ok()?;

        if !has_dot && let Ok(value) = number.parse::<i64>() {
            return Some(Number(InternalNumber::Integer(value)));
        }

        let value = number.parse::<f64>().ok()?;
        return Some(Number(InternalNumber::Real(value)));
    }

    Some(Number::from_parts(
        negative,
        mantissa,
        has_dot.then_some(decimal_shift),
    ))
}

object!(Number, Number);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum InternalNumber {
    Real(f64),
    Integer(i64),
}

macro_rules! int_num {
    ($i:ident) => {
        impl Skippable for $i {
            fn skip(r: &mut Reader<'_>, _: bool) -> Option<()> {
                r.forward_if(|b| b == b'+' || b == b'-');
                r.forward_while_1(is_digit)?;

                // We have a float instead of an integer.
                if r.peek_byte() == Some(b'.') {
                    return None;
                }

                // See issue 994. Don't accept numbers that are followed by a regular character
                // without any white space in-between.
                if r.peek_byte().is_some_and(is_regular_character) {
                    return None;
                }

                Some(())
            }
        }

        impl<'a> Readable<'a> for $i {
            fn read(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<$i> {
                r.read::<Number>(ctx)
                    .map(|n| n.as_i64())
                    .and_then(|n| n.try_into().ok())
            }
        }

        impl TryFrom<Object<'_>> for $i {
            type Error = ();

            fn try_from(value: Object<'_>) -> core::result::Result<Self, Self::Error> {
                match value {
                    Object::Number(n) => n.as_i64().try_into().ok().ok_or(()),
                    _ => Err(()),
                }
            }
        }

        impl<'a> ObjectLike<'a> for $i {}
    };
}

int_num!(i32);
int_num!(i64);
int_num!(u32);
int_num!(u16);
int_num!(usize);
int_num!(u8);

impl Skippable for f32 {
    fn skip(r: &mut Reader<'_>, is_content_stream: bool) -> Option<()> {
        r.skip::<Number>(is_content_stream).map(|_| {})
    }
}

impl Readable<'_> for f32 {
    fn read(r: &mut Reader<'_>, _: &ReaderContext<'_>) -> Option<Self> {
        r.read_without_context::<Number>()
            .map(|n| n.as_f64() as Self)
    }
}

impl TryFrom<Object<'_>> for f32 {
    type Error = ();

    fn try_from(value: Object<'_>) -> Result<Self, Self::Error> {
        match value {
            Object::Number(n) => Ok(n.as_f64() as Self),
            _ => Err(()),
        }
    }
}

impl ObjectLike<'_> for f32 {}

impl Skippable for f64 {
    fn skip(r: &mut Reader<'_>, is_content_stream: bool) -> Option<()> {
        r.skip::<Number>(is_content_stream).map(|_| {})
    }
}

impl Readable<'_> for f64 {
    fn read(r: &mut Reader<'_>, _: &ReaderContext<'_>) -> Option<Self> {
        r.read_without_context::<Number>().map(|n| n.as_f64())
    }
}

impl TryFrom<Object<'_>> for f64 {
    type Error = ();

    fn try_from(value: Object<'_>) -> Result<Self, Self::Error> {
        match value {
            Object::Number(n) => Ok(n.as_f64()),
            _ => Err(()),
        }
    }
}

impl ObjectLike<'_> for f64 {}

pub(crate) fn is_digit(byte: u8) -> bool {
    byte.is_ascii_digit()
}

pub(crate) fn is_digit_or_minus(byte: u8) -> bool {
    is_digit(byte) || byte == b'-'
}
