/*!
PDF content operators.

This module provides facilities to read and interpret PDF content streams using
high-level types.

```
use hayro_syntax::object::Number;
use hayro_syntax::content::*;
use hayro_syntax::content::ops::*;

let content_stream = b"1 0 0 -1 0 200 cm
0 1.0 0 rg
0 0 m
200 0 l
200 200 l
0 200 l
h
f";

let mut iter = TypedIter::new(content_stream);
assert!(matches!(iter.next(), Some(TypedInstruction::Transform(_))));
assert!(matches!(iter.next(), Some(TypedInstruction::NonStrokeColorDeviceRgb(_))));
assert!(matches!(iter.next(), Some(TypedInstruction::MoveTo(_))));
assert!(matches!(iter.next(), Some(TypedInstruction::LineTo(_))));
assert!(matches!(iter.next(), Some(TypedInstruction::LineTo(_))));
assert!(matches!(iter.next(), Some(TypedInstruction::LineTo(_))));
assert!(matches!(iter.next(), Some(TypedInstruction::ClosePath(_))));
assert!(matches!(iter.next(), Some(TypedInstruction::FillPathNonZero(_))));
```
*/

#[allow(missing_docs)]
pub mod ops;

use crate::content::ops::TypedInstruction;
use crate::object;
use crate::object::dict::InlineImageDict;
use crate::object::name::{Name, skip_name_like};
use crate::object::{Array, Number, Object, Stream};
use crate::reader::Reader;
use crate::reader::{Readable, ReaderContext, ReaderExt, Skippable};
use crate::trivia::{is_regular_character, is_white_space_character};
use crate::util::find_needle;
use alloc::vec::Vec;
use core::fmt::{Debug, Display, Formatter};
use core::ops::Deref;
use smallvec::SmallVec;

// `scn` with 32 DeviceN components and a pattern name.
const OPERANDS_THRESHOLD: usize = 33;
const INLINE_COLOR_COMPONENTS: usize = 4;

impl Debug for Operator<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0.as_str())
    }
}

impl Display for Operator<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0.as_str())
    }
}

/// A content stream operator.
#[derive(Clone, PartialEq)]
pub struct Operator<'a>(Name<'a>);

impl Deref for Operator<'_> {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.0.as_ref()
    }
}

impl Skippable for Operator<'_> {
    fn skip(r: &mut Reader<'_>, _: bool) -> Option<()> {
        skip_name_like(r, false).map(|_| ())
    }
}

impl<'a> Readable<'a> for Operator<'a> {
    fn read(r: &mut Reader<'a>, _: &ReaderContext<'a>) -> Option<Self> {
        let start = r.offset();
        let mut escaped = false;
        while let Some(b) = r.peek_byte().filter(|b| is_regular_character(*b)) {
            escaped |= b == b'#';
            r.forward();
        }

        let data = r.range(start..r.offset())?;
        if data.is_empty() {
            return None;
        }

        let name = if escaped {
            Name::new_escaped(data)?
        } else {
            Name::new_unescaped(data)
        };

        Some(Self(name))
    }
}

/// An iterator over operators in the PDF content streams, providing raw access to the instructions.
#[derive(Debug, Clone)]
pub struct UntypedIter<'a> {
    reader: Reader<'a>,
    stack: Stack<'a>,
    operator: Option<Operator<'a>>,
}

impl<'a> UntypedIter<'a> {
    /// Create a new untyped iterator.
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            reader: Reader::new(data),
            stack: Stack::new(),
            operator: None,
        }
    }

    /// Create a new empty untyped iterator.
    pub fn empty() -> Self {
        Self {
            reader: Reader::new(&[]),
            stack: Stack::new(),
            operator: None,
        }
    }

    /// recto: how far into the data the next instruction starts.
    pub fn offset(&self) -> usize {
        self.reader.offset()
    }

    /// Return the next instruction.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<Instruction<'_, 'a>> {
        self.stack.clear();

        let operator = read_instruction(&mut self.reader, &mut self.stack)?;
        self.operator = Some(operator);
        Some(Instruction {
            operands: &self.stack,
            operator: self.operator.as_ref().unwrap(),
        })
    }
}

fn read_instruction<'a>(r: &mut Reader<'a>, stack: &mut Stack<'a>) -> Option<Operator<'a>> {
    // Keeps the read position in a register; must be written back before calling out.
    let mut cur = r.clone();

    loop {
        cur.skip_white_spaces_and_comments();

        let Some(first) = cur.peek_byte() else {
            *r = cur;
            return None;
        };

        if matches!(first, b'.' | b'+' | b'-' | b'0'..=b'9') {
            let start = cur.offset();
            match Number::read_simple(&mut cur) {
                Some(number) => {
                    if stack.push(Object::Number(number)).is_none() {
                        *r = cur;
                        return None;
                    }
                    continue;
                }
                None => cur.jump(start),
            }
        }

        match first {
            // I believe booleans/null never appear as an operator?
            b'.' | b'+' | b'-' | b'0'..=b'9' | b'/' | b'[' | b'<' | b'(' => {
                *r = cur;
                read_operand(r, stack)?;
                cur = r.clone();
            }
            _ => {
                *r = cur;
                let Some(operator) = r.read_without_context::<Operator<'a>>() else {
                    r.jump_to_end();
                    return None;
                };

                // Inline images need special casing...
                if operator.as_ref() == b"BI" {
                    read_inline_image(r, stack)?;
                }

                return Some(operator);
            }
        }
    }
}

fn read_operand<'a>(r: &mut Reader<'a>, stack: &mut Stack<'a>) -> Option<()> {
    // See issue 994. In all sane scenarios, if the next byte is a number
    // it has to be an operand (a number). However, it's possible that
    // the number is followed by a regular character, in which case it
    // should behave more like an operator (even though there exists
    // no operator that starts with a number). In order to preserve
    // similar behavior to Acrobat and Chromium, we try to consume
    // such an operator and then simply skip it.
    if let Some(object) = r.read_without_context::<Object<'a>>() {
        stack.push(object)
    } else if r.read_without_context::<Operator<'a>>().is_some() {
        stack.clear();
        Some(())
    } else {
        None
    }
}

// recto: where an inline image ends. Each `EI` in its data followed by white space is a candidate,
// tried in order, and upstream decided each by reading on through the `EI`s and `BI`s after it, so
// data of n `EI`s and a binary byte after them read n²/2: 16,000 of them took 1.1 s a call.
// `Ends` gives every candidate the answer upstream's reading gives it (`ends_by_rereading`, kept for
// the test that compares them), with each byte after the data read a bounded number of times, by
// what that reading depends on:
//
// - the first `BI` at or after the candidate that starts an inline-image dictionary (`v`): the
//   reading ends there, the candidate the end;
// - every `EI` before `v`: the candidate isn't the end if the bytes between it and that `EI` hold a
//   binary byte outside a string, or if what follows the candidate doesn't read as content;
// - nothing else.
//
// Whether a binary byte comes before a point depends on where the reading starts, through the
// strings it sees, so one pass carries every candidate's reading at once: readings outside a
// string are in the same state and move as one group; those inside strings are grouped by depth,
// which every byte changes alike for all of them, and a string's backslash too.

#[cfg(feature = "std")]
std::thread_local! {
    static INLINE_IMAGE_WORK: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
}

/// recto: the steps this thread has taken to end inline images, for the test that it's linear.
#[cfg(feature = "std")]
#[doc(hidden)]
pub fn inline_image_work() -> usize {
    INLINE_IMAGE_WORK.with(|n| n.get())
}

#[inline]
fn work(_n: usize) {
    #[cfg(feature = "std")]
    INLINE_IMAGE_WORK.with(|n| n.set(n.get() + _n));
}

/// The candidates for an image's end in `data` (from just after `ID` and its white space), in the
/// order they're tried: an `EI` followed by white space or the end. One followed by anything else
/// is skipped with the byte after it. With none, how far that went.
fn next_candidate(data: &[u8], from: usize) -> Result<usize, usize> {
    let mut at = from;
    loop {
        let Some(ei) = data.get(at..).and_then(|tail| find_needle(tail, b"EI")) else {
            return Err(at);
        };
        let ei = at + ei;
        match data.get(ei + 2) {
            Some(&b) if !is_white_space_character(b) => at = ei + 3,
            _ => return Ok(ei),
        }
    }
}

/// Where the image in `data` ends, the offset of its `EI`; or if none does, how far reading it went.
fn inline_image_end(data: &[u8]) -> Result<usize, usize> {
    let mut ends = Ends::new(data);
    let mut at = 0;
    loop {
        let candidate = next_candidate(data, at)?;
        if ends.is_end(candidate) {
            return Ok(candidate);
        }
        at = candidate + 2;
    }
}

struct Ends<'a> {
    data: &'a [u8],
    /// Every `EI` before `eis_to`.
    eis: Vec<usize>,
    eis_to: usize,
    /// Every `BI` before `bis_to`, with whether it starts a dictionary, once asked.
    bis: Vec<(usize, Option<bool>)>,
    bis_to: usize,
    /// The last answer for the first dictionary `BI`: asked from where, and where it is.
    dict_bi: Option<(usize, Option<usize>)>,
    /// The candidates found so far, whether there are more, and where each one's reading met a
    /// binary byte outside a string.
    candidates: Vec<usize>,
    candidates_done: bool,
    binary_at: Vec<Option<usize>>,
    /// The pass: the next byte, how many candidates' readings have started, those outside a string,
    /// and those inside, by depth (`depth + shift`), deepest first.
    at: usize,
    joined: usize,
    outside: Vec<u32>,
    inside: Vec<(isize, Vec<u32>)>,
    shift: isize,
    escaped: bool,
}

impl<'a> Ends<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            eis: Vec::new(),
            eis_to: 0,
            bis: Vec::new(),
            bis_to: 0,
            dict_bi: None,
            candidates: Vec::new(),
            candidates_done: false,
            binary_at: Vec::new(),
            at: 0,
            joined: 0,
            outside: Vec::new(),
            inside: Vec::new(),
            shift: 0,
            escaped: false,
        }
    }

    /// Whether `candidate`, the next one tried, is where the image ends.
    fn is_end(&mut self, candidate: usize) -> bool {
        let from = candidate + 2;
        let v = self.first_dict_bi(from).unwrap_or(self.data.len());
        let Some(first) = self.first_ei(from).filter(|&ei| ei < v) else {
            return true;
        };
        let index = self.candidate_index(candidate);
        if self.binary_before(index, first) || !starts_with_content(&self.data[from..]) {
            return false;
        }
        // Not the end if a binary byte comes before any later `EI` before `v`: before the last.
        self.first_ei(v);
        let last = self.eis[self.eis.partition_point(|&ei| ei < v) - 1];
        !self.binary_before(index, last)
    }

    fn more_candidates(&mut self) -> bool {
        if self.candidates_done {
            return false;
        }
        let from = self.candidates.last().map_or(0, |&last| last + 2);
        match next_candidate(self.data, from) {
            Ok(next) => {
                self.candidates.push(next);
                self.binary_at.push(None);
                true
            }
            Err(_) => {
                self.candidates_done = true;
                false
            }
        }
    }

    fn candidate_index(&mut self, candidate: usize) -> usize {
        while self.candidates.last().is_none_or(|&last| last < candidate) && self.more_candidates() {}
        self.candidates.partition_point(|&c| c < candidate)
    }

    /// The first `EI` at or after `from`.
    fn first_ei(&mut self, from: usize) -> Option<usize> {
        loop {
            if let Some(&ei) = self.eis.get(self.eis.partition_point(|&ei| ei < from)) {
                return Some(ei);
            }
            work(1);
            match self.data.get(self.eis_to..).and_then(|tail| find_needle(tail, b"EI")) {
                Some(ei) => {
                    self.eis.push(self.eis_to + ei);
                    self.eis_to += ei + 1;
                }
                None => {
                    self.eis_to = self.data.len();
                    return None;
                }
            }
        }
    }

    /// The first `BI` at or after `from` that starts an inline image's dictionary. `from` never goes
    /// back, so each `BI` is read once.
    fn first_dict_bi(&mut self, from: usize) -> Option<usize> {
        if let Some((asked, answer)) = self.dict_bi {
            if asked <= from && answer.is_none_or(|bi| bi >= from) {
                return answer;
            }
        }
        let mut i = self.bis.partition_point(|&(bi, _)| bi < from);
        let answer = loop {
            if i == self.bis.len() {
                let Some(found) = self.data.get(self.bis_to..).and_then(|tail| find_needle(tail, b"BI")) else {
                    self.bis_to = self.data.len();
                    break None;
                };
                self.bis.push((self.bis_to + found, None));
                self.bis_to += found + 1;
            }
            if self.bis[i].0 < from {
                i += 1;
                continue;
            }
            work(1);
            let data = self.data;
            let (bi, dict) = &mut self.bis[i];
            let bi = *bi;
            let starts = *dict.get_or_insert_with(|| {
                Reader::new(&data[bi + 2..]).read_without_context::<InlineImageDict<'_>>().is_some()
            });
            if starts {
                break Some(bi);
            }
            i += 1;
        };
        self.dict_bi = Some((from, answer));
        answer
    }

    /// Whether the candidate's reading meets a binary byte outside a string before `end`.
    fn binary_before(&mut self, index: usize, end: usize) -> bool {
        while self.binary_at[index].is_none() && self.at < end.min(self.data.len()) {
            if self.outside.is_empty() && self.inside.is_empty() {
                // No reading under way: on to where the next one starts.
                let next = self.candidates[self.joined] + 2;
                self.at = self.at.max(next);
                if self.at >= end.min(self.data.len()) {
                    break;
                }
            }
            self.step();
        }
        self.binary_at[index].is_some_and(|binary| binary < end)
    }

    /// The pass reads one byte, for every reading at once.
    fn step(&mut self) {
        work(1);
        let at = self.at;
        while self.candidates.last().is_none_or(|&last| last + 2 <= at) && self.more_candidates() {}
        while self.candidates.get(self.joined).is_some_and(|&c| c + 2 == at) {
            self.outside.push(self.joined as u32);
            self.joined += 1;
        }
        let b = self.data[at];
        let mut closed = Vec::new();
        if !self.inside.is_empty() {
            if self.escaped {
                self.escaped = false;
            } else if b == b'\\' {
                self.escaped = true;
            } else if b == b'(' {
                self.shift += 1;
            } else if b == b')' {
                self.shift -= 1;
                while self.inside.last().is_some_and(|&(depth, _)| depth + self.shift == 0) {
                    if let Some((_, group)) = self.inside.pop() {
                        merge(&mut closed, group);
                    }
                }
            }
        }
        if !self.outside.is_empty() {
            if !b.is_ascii() {
                for i in self.outside.drain(..) {
                    self.binary_at[i as usize] = Some(at);
                }
            } else if b == b'(' {
                // A string opens: in it, after a `(`, nothing is escaped, for any reading.
                self.inside.push((1 - self.shift, core::mem::take(&mut self.outside)));
                self.escaped = false;
            }
        }
        merge(&mut self.outside, closed);
        self.at += 1;
    }
}

/// Adds one group of readings to another, the smaller into the larger.
fn merge(into: &mut Vec<u32>, mut other: Vec<u32>) {
    if other.len() > into.len() {
        core::mem::swap(into, &mut other);
    }
    into.extend(other);
}

fn read_inline_image<'a>(r: &mut Reader<'a>, stack: &mut Stack<'a>) -> Option<()> {
    // The ID operator will already be consumed by this.
    let inline_dict = r.read_without_context::<InlineImageDict<'_>>()?;
    let dict = inline_dict.get_dict().clone();

    // One whitespace after "ID".
    r.read_white_space()?;

    let stream_data = r.tail()?;
    match inline_image_end(stream_data) {
        Ok(end) => {
            // Note that the encoded data may hold "EI" itself, in which case we can't know for
            // sure where it ends; see <https://github.com/pdf-association/pdf-issues/issues/543>.
            // PDF 2.0 has a `/Length` we could read, but it's new enough not to bother.
            stack.push(Object::Stream(Stream::new(&stream_data[..end], dict)))?;
            r.read_bytes(end + 2)?;
            r.skip_white_spaces();
        }
        Err(read) => {
            r.read_bytes(read)?;
        }
    }

    Some(())
}

/// recto: `inline_image_end`, for the test that compares it with `ends_by_rereading`.
#[doc(hidden)]
pub fn inline_image_end_for_tests(data: &[u8]) -> Result<usize, usize> {
    inline_image_end(data)
}

/// recto: upstream's search for where an inline image ends, which reads on from each candidate, for
/// the test that `inline_image_end` answers the same.
#[doc(hidden)]
pub fn ends_by_rereading(data: &[u8]) -> Result<usize, usize> {
    let mut r = Reader::new(data);
    'outer: while let Some(pos) = find_needle(r.tail().unwrap_or_default(), b"EI") {
        r.read_bytes(pos);
        if r.peek_bytes(3).is_some_and(|b| !is_white_space_character(b[2])) {
            r.read_bytes(3);
            continue;
        }
        let candidate = r.offset();
        let tail = &data[candidate + 2..];
        let mut find_reader = Reader::new(tail);
        let mut binary = BinaryTracker::default();
        let mut is_content = None;
        let mut next_bi = find_needle(tail, b"BI");
        while !find_reader.at_end() {
            let offset = find_reader.offset();
            if next_bi.is_some_and(|bi| bi < offset) {
                next_bi = find_needle(&tail[offset..], b"BI").map(|bi| offset + bi);
            }
            let next_ei = find_needle(&tail[offset..], b"EI").map(|ei| offset + ei);
            let (next_pos, is_ei) = match (next_ei, next_bi) {
                (Some(ei), Some(bi)) if ei <= bi => (ei, true),
                (Some(_), Some(bi)) => (bi, false),
                (Some(ei), None) => (ei, true),
                (None, Some(bi)) => (bi, false),
                (None, None) => break,
            };
            find_reader.read_bytes(next_pos - offset);
            if is_ei {
                if binary.found_before(tail, next_pos) || !*is_content.get_or_insert_with(|| starts_with_content(tail)) {
                    r.read_bytes(2);
                    continue 'outer;
                }
            } else {
                let mut cloned = find_reader.clone();
                cloned.read_bytes(2);
                if cloned.read_without_context::<InlineImageDict<'_>>().is_some() {
                    break;
                }
            }
            find_reader.read_byte();
        }
        return Ok(candidate);
    }
    Err(r.offset())
}

fn starts_with_content(data: &[u8]) -> bool {
    let mut iter = TypedIter::new(data);
    let mut counter = 0;

    while let Some(op) = iter.next() {
        // If we have read more than 20 valid operators, it should be
        // safe to assume that we are in a content stream, so abort
        // early. The only situation where this could reasonably
        // be violated is if we have 20 subsequent instances of
        // q/Q in the image data, which seems very unlikely.
        if counter >= 20 {
            return true;
        }

        if matches!(
            op,
            TypedInstruction::NextLineAndShowText(_)
                | TypedInstruction::ShowText(_)
                | TypedInstruction::ShowTexts(_)
                | TypedInstruction::ShowTextWithParameters(_)
        ) {
            return true;
        }

        counter += 1;
    }

    false
}

// Content streams only hold non-ASCII bytes within strings, so one outside
// of them means that we are still within binary image data.
#[derive(Default)]
struct BinaryTracker {
    pos: usize,
    string_depth: usize,
    escaped: bool,
    found: bool,
}

impl BinaryTracker {
    fn found_before(&mut self, data: &[u8], end: usize) -> bool {
        if self.found || end <= self.pos {
            return self.found;
        }

        for (i, &b) in data[self.pos..end].iter().enumerate() {
            if self.string_depth > 0 {
                if self.escaped {
                    self.escaped = false;
                } else if b == b'\\' {
                    self.escaped = true;
                } else if b == b'(' {
                    self.string_depth += 1;
                } else if b == b')' {
                    self.string_depth -= 1;
                }
            } else if !b.is_ascii() {
                self.found = true;
                self.pos += i;
                return true;
            } else if b == b'(' {
                self.string_depth = 1;
            }
        }

        self.pos = end;
        false
    }
}

/// An iterator over PDF content streams that provide access to the instructions
/// in a typed fashion.
#[derive(Clone)]
pub struct TypedIter<'a> {
    untyped: UntypedIter<'a>,
}

impl<'a> TypedIter<'a> {
    /// Create a new typed iterator.
    pub fn new(data: &'a [u8]) -> Self {
        Self {
            untyped: UntypedIter::new(data),
        }
    }

    pub(crate) fn from_untyped(untyped: UntypedIter<'a>) -> Self {
        Self { untyped }
    }

    /// recto: how far into the data the next instruction starts.
    pub fn offset(&self) -> usize {
        self.untyped.offset()
    }

    /// Return the next typed instruction.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<TypedInstruction<'_, 'a>> {
        let op = self.untyped.next()?;
        // TODO: Explore whether dispatching can be made more efficient.
        match TypedInstruction::dispatch(&op) {
            Some(op) => Some(op),
            // In case this returns `None`, the content stream is invalid. In case a path-drawing
            // operator was used, let's abort completely, otherwise we might end up drawing random stuff.
            // However, for other operators it could be worth it to just skip it but keep attempting
            // to read other content operators.
            None => {
                if [
                    &b"m"[..],
                    &b"l"[..],
                    &b"c"[..],
                    &b"v"[..],
                    &b"y"[..],
                    &b"h"[..],
                    &b"re"[..],
                ]
                .contains(&op.operator.0.deref())
                {
                    None
                } else {
                    Some(TypedInstruction::Fallback(op.operator))
                }
            }
        }
    }
}

/// An instruction (= operator and its operands) in a content stream.
#[derive(Debug)]
pub struct Instruction<'b, 'a> {
    /// The stack containing the operands.
    pub operands: &'b Stack<'a>,
    /// The actual operator.
    pub operator: &'b Operator<'a>,
}

impl<'b, 'a> Instruction<'b, 'a> {
    /// An iterator over the operands of the instruction.
    pub fn operands(&self) -> OperandIterator<'b, 'a> {
        OperandIterator::new(self.operands)
    }
}

/// A stack holding the arguments of an operator.
#[derive(Clone, PartialEq)]
pub struct Stack<'a> {
    // TODO: Explore using an object pool to avoid repeatedly
    // allocating/deallocating objects.
    data: Vec<Object<'a>>,
}

impl<'a> Default for Stack<'a> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> Stack<'a> {
    /// Create a new, empty stack.
    pub fn new() -> Self {
        Self { data: Vec::new() }
    }

    fn push(&mut self, operand: Object<'a>) -> Option<()> {
        if self.data.len() >= OPERANDS_THRESHOLD {
            return None;
        }

        self.data.push(operand);
        Some(())
    }

    fn clear(&mut self) {
        self.data.clear();
    }

    fn len(&self) -> usize {
        self.data.len()
    }

    fn as_slice(&self) -> &[Object<'a>] {
        &self.data
    }

    fn get<'b, T>(&'b self, index: usize) -> Option<T>
    where
        T: Operand<'b, 'a>,
    {
        self.as_slice().get(index).and_then(T::from_object)
    }

    fn get_all<'b, T>(&'b self) -> Option<SmallVec<[T; INLINE_COLOR_COMPONENTS]>>
    where
        T: Operand<'b, 'a>,
    {
        let mut operands = SmallVec::new();

        for op in self.as_slice() {
            let converted = T::from_object(op)?;
            operands.push(converted);
        }

        Some(operands)
    }
}

impl Debug for Stack<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        f.debug_list().entries(self.as_slice()).finish()
    }
}

trait Operand<'b, 'a>: Sized {
    fn from_object(object: &'b Object<'a>) -> Option<Self>;
}

impl<'b, 'a> Operand<'b, 'a> for Number {
    fn from_object(object: &'b Object<'a>) -> Option<Self> {
        match object {
            Object::Number(n) => Some(*n),
            _ => None,
        }
    }
}

impl<'b, 'a> Operand<'b, 'a> for &'b object::String<'a> {
    fn from_object(object: &'b Object<'a>) -> Option<Self> {
        match object {
            Object::String(s) => Some(s),
            _ => None,
        }
    }
}

impl<'b, 'a> Operand<'b, 'a> for &'b Name<'a> {
    fn from_object(object: &'b Object<'a>) -> Option<Self> {
        match object {
            Object::Name(n) => Some(n),
            _ => None,
        }
    }
}

impl<'b, 'a> Operand<'b, 'a> for &'b Array<'a> {
    fn from_object(object: &'b Object<'a>) -> Option<Self> {
        match object {
            Object::Array(a) => Some(a),
            _ => None,
        }
    }
}

impl<'b, 'a> Operand<'b, 'a> for &'b Stream<'a> {
    fn from_object(object: &'b Object<'a>) -> Option<Self> {
        match object {
            Object::Stream(s) => Some(s),
            _ => None,
        }
    }
}

impl<'b, 'a> Operand<'b, 'a> for &'b Object<'a> {
    fn from_object(object: &'b Object<'a>) -> Option<Self> {
        Some(object)
    }
}

/// An iterator over the operands of an operator.
pub struct OperandIterator<'b, 'a> {
    stack: &'b Stack<'a>,
    cur_index: usize,
}

impl<'b, 'a> OperandIterator<'b, 'a> {
    fn new(stack: &'b Stack<'a>) -> Self {
        Self {
            stack,
            cur_index: 0,
        }
    }
}

impl<'b, 'a> Iterator for OperandIterator<'b, 'a> {
    type Item = &'b Object<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(item) = self.stack.as_slice().get(self.cur_index) {
            self.cur_index += 1;

            Some(item)
        } else {
            None
        }
    }
}

pub(crate) trait OperatorTrait<'b, 'a>: Sized {
    fn from_stack(stack: &'b Stack<'a>) -> Option<Self>;
}

mod macros {
    macro_rules! display_op {
        ($t:ident $(<$($l:lifetime),+>)?;) => {
            impl$(<$($l),+>)? core::fmt::Display for $t$(<$($l),+>)? {
                fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                    f.write_str(stringify!($t))
                }
            }
        };
        ($t:ident $(<$($l:lifetime),+>)?; $first:tt $(, $field:tt)*) => {
            impl$(<$($l),+>)? core::fmt::Display for $t$(<$($l),+>)? {
                fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                    f.write_str(concat!(stringify!($t), "("))?;
                    core::fmt::Display::fmt(&self.$first, f)?;
                    $(
                        f.write_str(" ")?;
                        core::fmt::Display::fmt(&self.$field, f)?;
                    )*
                    f.write_str(")")
                }
            }
        };
    }

    macro_rules! display_variadic_op {
        ($t:ident $(<$($l:lifetime),+>)?) => {
            impl$(<$($l),+>)? core::fmt::Display for $t$(<$($l),+>)? {
                fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                    f.write_str(stringify!($t))?;
                    if let Some((first, rest)) = self.0.split_first() {
                        f.write_str("(")?;
                        core::fmt::Display::fmt(first, f)?;
                        for value in rest {
                            f.write_str(" ")?;
                            core::fmt::Display::fmt(value, f)?;
                        }
                        f.write_str(")")?;
                    }
                    Ok(())
                }
            }
        };
    }

    macro_rules! op_impl {
        ($t:ident $(<$($l:lifetime),+>)?, $e:expr, $n:expr, |$stack:ident : $stack_ty:ty| $body:block) => {
            impl<'b, 'a> OperatorTrait<'b, 'a> for $t$(<$($l),+>)? {
                #[inline(always)]
                fn from_stack($stack: $stack_ty) -> Option<Self> {
                    $body
                }
            }

            impl<'b, 'a> From<$t$(<$($l),+>)?> for TypedInstruction<'b, 'a> {
                fn from(value: $t$(<$($l),+>)?) -> Self {
                    TypedInstruction::$t(value)
                }
            }

            impl<'b, 'a> TryFrom<TypedInstruction<'b, 'a>> for $t$(<$($l),+>)? {
                type Error = ();

                fn try_from(value: TypedInstruction<'b, 'a>) -> core::result::Result<Self, Self::Error> {
                    match value {
                        TypedInstruction::$t(e) => Ok(e),
                        _ => Err(())
                    }
                }
            }
        };
    }

    // The `shift` parameter will always be 0 in valid PDFs. The purpose of the parameter is
    // so that in case there are garbage operands in the content stream, we prefer to use
    // the operands that are closer to the operator instead of the values at the bottom
    // of the stack.

    macro_rules! op0 {
        ($t:ident $(<$($l:lifetime),+>)?, $e:expr) => {
            crate::content::macros::display_op!($t$(<$($l),+>)?;);
            crate::content::macros::op_impl!($t$(<$($l),+>)?, $e, 0, |_stack: &'b Stack<'a>| {
                Some(Self)
            });
        }
    }

    macro_rules! op1 {
        ($t:ident $(<$($l:lifetime),+>)?, $e:expr) => {
            crate::content::macros::display_op!($t$(<$($l),+>)?; 0);
            crate::content::macros::op_impl!($t$(<$($l),+>)?, $e, 1, |stack: &'b Stack<'a>| {
                let shift = stack.len().saturating_sub(1);
                Some(Self(stack.get(0 + shift)?))
            });
        }
    }

    macro_rules! op_all {
        ($t:ident $(<$($l:lifetime),+>)?, $e:expr) => {
            crate::content::macros::display_variadic_op!($t$(<$($l),+>)?);
            crate::content::macros::op_impl!($t$(<$($l),+>)?, $e, u8::MAX as usize, |stack: &'b Stack<'a>| {
                Some(Self(stack.get_all()?))
            });
        }
    }

    macro_rules! op2 {
        ($t:ident $(<$($l:lifetime),+>)?, $e:expr) => {
            crate::content::macros::display_op!($t$(<$($l),+>)?; 0, 1);
            crate::content::macros::op_impl!($t$(<$($l),+>)?, $e, 2, |stack: &'b Stack<'a>| {
                let shift = stack.len().saturating_sub(2);
                Some(Self(stack.get(0 + shift)?, stack.get(1 + shift)?))
            });
        }
    }

    macro_rules! op3 {
        ($t:ident $(<$($l:lifetime),+>)?, $e:expr) => {
            crate::content::macros::display_op!($t$(<$($l),+>)?; 0, 1, 2);
            crate::content::macros::op_impl!($t$(<$($l),+>)?, $e, 3, |stack: &'b Stack<'a>| {
                let shift = stack.len().saturating_sub(3);
                Some(Self(stack.get(0 + shift)?, stack.get(1 + shift)?,
                stack.get(2 + shift)?))
            });
        }
    }

    macro_rules! op4 {
        ($t:ident $(<$($l:lifetime),+>)?, $e:expr) => {
            crate::content::macros::display_op!($t$(<$($l),+>)?; 0, 1, 2, 3);
            crate::content::macros::op_impl!($t$(<$($l),+>)?, $e, 4, |stack: &'b Stack<'a>| {
               let shift = stack.len().saturating_sub(4);
            Some(Self(stack.get(0 + shift)?, stack.get(1 + shift)?,
            stack.get(2 + shift)?, stack.get(3 + shift)?))
            });
        }
    }

    macro_rules! op6 {
        ($t:ident $(<$($l:lifetime),+>)?, $e:expr) => {
            crate::content::macros::display_op!($t$(<$($l),+>)?; 0, 1, 2, 3, 4, 5);
            crate::content::macros::op_impl!($t$(<$($l),+>)?, $e, 6, |stack: &'b Stack<'a>| {
                let shift = stack.len().saturating_sub(6);
            Some(Self(stack.get(0 + shift)?, stack.get(1 + shift)?,
            stack.get(2 + shift)?, stack.get(3 + shift)?,
            stack.get(4 + shift)?, stack.get(5 + shift)?))
            });
        }
    }

    pub(crate) use display_op;
    pub(crate) use display_variadic_op;
    pub(crate) use op_all;
    pub(crate) use op_impl;
    pub(crate) use op0;
    pub(crate) use op1;
    pub(crate) use op2;
    pub(crate) use op3;
    pub(crate) use op4;
    pub(crate) use op6;
}
