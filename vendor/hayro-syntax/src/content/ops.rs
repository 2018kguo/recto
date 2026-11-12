//! Content stream operators.

use crate::content::{INLINE_COLOR_COMPONENTS, Instruction, OperatorTrait, Stack};
use crate::object;
use crate::object::Array;
use crate::object::Name;
use crate::object::Number;
use crate::object::Object;
use crate::object::Stream;
use core::fmt::{Display, Formatter};
use smallvec::{SmallVec, smallvec};

use crate::content::macros::{op_all, op_impl, op0, op1, op2, op3, op4, op6};

include!("ops_generated.rs");

// Need to special-case those because they have variable arguments.

fn parse_named_color<'b, 'a>(
    objects: &'b [Object<'a>],
) -> Option<(
    SmallVec<[Number; INLINE_COLOR_COMPONENTS]>,
    Option<&'b Name<'a>>,
)> {
    let mut nums = smallvec![];
    let mut name = None;

    for o in objects {
        match o {
            Object::Number(n) => nums.push(*n),
            Object::Name(n) => name = Some(n),
            _ => {
                return None;
            }
        }
    }

    Some((nums, name))
}

fn fmt_named_color(
    f: &mut Formatter<'_>,
    operator: &str,
    numbers: &[Number],
    name: Option<&Name<'_>>,
) -> core::fmt::Result {
    f.write_str(operator)?;
    if !numbers.is_empty() || name.is_some() {
        f.write_str("(")?;
        for (index, number) in numbers.iter().enumerate() {
            if index > 0 {
                f.write_str(" ")?;
            }
            Display::fmt(number, f)?;
        }
        if let Some(name) = name {
            if !numbers.is_empty() {
                f.write_str(" ")?;
            }
            Display::fmt(name, f)?;
        }
        f.write_str(")")?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct StrokeColorNamed<'b, 'a>(
    pub SmallVec<[Number; INLINE_COLOR_COMPONENTS]>,
    pub Option<&'b Name<'a>>,
);

impl Display for StrokeColorNamed<'_, '_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        fmt_named_color(f, "StrokeColorNamed", &self.0, self.1)
    }
}

op_impl!(
    StrokeColorNamed<'b, 'a>,
    "SCN",
    u8::MAX as usize,
    |stack: &'b Stack<'a>| {
        let (nums, name) = parse_named_color(stack.as_slice())?;
        Some(StrokeColorNamed(nums, name))
    }
);

#[derive(Debug, PartialEq, Clone)]
pub struct NonStrokeColorNamed<'b, 'a>(
    pub SmallVec<[Number; INLINE_COLOR_COMPONENTS]>,
    pub Option<&'b Name<'a>>,
);

impl Display for NonStrokeColorNamed<'_, '_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        fmt_named_color(f, "NonStrokeColorNamed", &self.0, self.1)
    }
}

op_impl!(
    NonStrokeColorNamed<'b, 'a>,
    "scn",
    u8::MAX as usize,
    |stack: &'b Stack<'a>| {
        let (nums, name) = parse_named_color(stack.as_slice())?;
        Some(NonStrokeColorNamed(nums, name))
    }
);
