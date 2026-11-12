//! Arrays.

use crate::object::macros::object;
use crate::object::r#ref::MaybeRef;
use crate::object::{FromBytes, Object, ObjectLike};
use crate::reader::Reader;
use crate::reader::{Readable, ReaderContext, ReaderExt, Skippable};
use alloc::vec::Vec;
use core::fmt::{Debug, Display, Formatter};
use core::marker::PhantomData;
use smallvec::SmallVec;

/// An array of PDF objects.
#[derive(Clone)]
pub struct Array<'a> {
    data: &'a [u8],
    ctx: ReaderContext<'a>,
}

// Note that this is not structural equality, i.e. two arrays with the same
// items are still considered different if they have different whitespaces.
impl PartialEq for Array<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.data == other.data
    }
}

impl<'a> Array<'a> {
    /// Returns an iterator over the objects of the array.
    pub fn raw_iter(&self) -> ArrayIter<'a> {
        ArrayIter::new(self.data, &self.ctx)
    }

    /// Returns an iterator over the resolved objects of the array.
    #[allow(
        private_bounds,
        reason = "users shouldn't be able to implement `ObjectLike` for custom objects."
    )]
    pub fn iter<T>(&self) -> ResolvedArrayIter<'a, T>
    where
        T: ObjectLike<'a>,
    {
        ResolvedArrayIter::new(self.data, &self.ctx)
    }

    /// Return a flex iterator over the items in the array.
    pub fn flex_iter(&self) -> FlexArrayIter<'a> {
        FlexArrayIter::new(self.data, &self.ctx)
    }

    /// Return the raw data of the array.
    pub fn data(&self) -> &'a [u8] {
        self.data
    }
}

impl Debug for Array<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        let mut debug_list = f.debug_list();

        self.raw_iter().for_each(|i| {
            debug_list.entry(&i);
        });

        debug_list.finish()
    }
}

impl Display for Array<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        f.write_str("[")?;
        for (index, item) in self.raw_iter().enumerate() {
            if index > 0 {
                f.write_str(" ")?;
            }
            Display::fmt(&item, f)?;
        }
        f.write_str("]")
    }
}

object!(Array<'a>, Array);

impl Skippable for Array<'_> {
    fn skip(r: &mut Reader<'_>, is_content_stream: bool) -> Option<()> {
        Self::skip_with_depth(r, is_content_stream, 0)
    }

    fn skip_with_depth(r: &mut Reader<'_>, is_content_stream: bool, depth: usize) -> Option<()> {
        // recto: where a skip stops and what it was inside, for a repair scan.
        let start = r.offset();
        if depth >= super::MAX_OBJECT_NESTING_DEPTH {
            super::depth_chain::stopped(start);
            return None;
        }
        let skipped = Self::skip_inside(r, is_content_stream, depth);
        if skipped.is_none() {
            super::depth_chain::failed(start);
        }
        skipped
    }
}

impl Array<'_> {
    fn skip_inside(r: &mut Reader<'_>, is_content_stream: bool, depth: usize) -> Option<()> {
        r.forward_tag(b"[")?;

        loop {
            r.skip_white_spaces_and_comments();

            if let Some(()) = r.forward_tag(b"]") {
                return Some(());
            } else if is_content_stream {
                r.skip_with_depth::<Object<'_>>(true, depth + 1)?;
            } else {
                r.skip_with_depth::<MaybeRef<Object<'_>>>(false, depth + 1)?;
            }
        }
    }
}

impl Default for Array<'_> {
    fn default() -> Self {
        Self::from_bytes(b"[]").unwrap()
    }
}

impl<'a> Readable<'a> for Array<'a> {
    fn read(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self> {
        let bytes = r.skip::<Array<'_>>(ctx.in_content_stream())?;

        Some(Self {
            data: &bytes[1..bytes.len() - 1],
            ctx: ctx.clone(),
        })
    }
}

/// An iterator over the items of an array.
pub struct ArrayIter<'a> {
    reader: Reader<'a>,
    ctx: ReaderContext<'a>,
}

impl<'a> ArrayIter<'a> {
    fn new(data: &'a [u8], ctx: &ReaderContext<'a>) -> Self {
        Self {
            reader: Reader::new(data),
            ctx: ctx.clone(),
        }
    }
}

impl<'a> Iterator for ArrayIter<'a> {
    type Item = MaybeRef<Object<'a>>;

    fn next(&mut self) -> Option<Self::Item> {
        self.reader.skip_white_spaces_and_comments();

        if self.reader.at_end() {
            return None;
        }

        // The array was validated by skipping its items, which accepts some items that
        // can't be read.
        self.reader
            .read_with_context::<MaybeRef<Object<'_>>>(&self.ctx)
    }
}

/// An iterator over the array that resolves objects of a specific type.
pub struct ResolvedArrayIter<'a, T> {
    flex_iter: FlexArrayIter<'a>,
    phantom_data: PhantomData<T>,
}

impl<'a, T> ResolvedArrayIter<'a, T> {
    fn new(data: &'a [u8], ctx: &ReaderContext<'a>) -> Self {
        Self {
            flex_iter: FlexArrayIter::new(data, ctx),
            phantom_data: PhantomData,
        }
    }
}

impl<'a, T> Iterator for ResolvedArrayIter<'a, T>
where
    T: ObjectLike<'a>,
{
    type Item = T;

    fn next(&mut self) -> Option<Self::Item> {
        self.flex_iter.next::<T>()
    }
}

/// An iterator over the array that allows reading a different object each time.
pub struct FlexArrayIter<'a> {
    reader: Reader<'a>,
    ctx: ReaderContext<'a>,
}

impl<'a> FlexArrayIter<'a> {
    fn new(data: &'a [u8], ctx: &ReaderContext<'a>) -> Self {
        Self {
            reader: Reader::new(data),
            ctx: ctx.clone(),
        }
    }

    #[allow(
        private_bounds,
        reason = "users shouldn't be able to implement `ObjectLike` for custom objects."
    )]
    #[allow(clippy::should_implement_trait)]
    /// Try reading the next item as a specific object from the array.
    pub fn next<T: ObjectLike<'a>>(&mut self) -> Option<T> {
        self.reader.skip_white_spaces_and_comments();

        if !self.reader.at_end() {
            return match self.reader.read_with_context::<MaybeRef<T>>(&self.ctx)? {
                MaybeRef::Ref(r) => self.ctx.xref().get_with::<T>(r.into(), &self.ctx),
                MaybeRef::NotRef(i) => Some(i),
            };
        }

        None
    }
}

impl<'a, T: ObjectLike<'a> + Copy + Default, const C: usize> TryFrom<Array<'a>> for [T; C] {
    type Error = ();

    fn try_from(value: Array<'a>) -> Result<Self, Self::Error> {
        let mut iter = value.iter::<T>();

        let mut val = [T::default(); C];

        for i in 0..C {
            val[i] = iter.next().ok_or(())?;
        }

        if iter.next().is_some() {
            return Err(());
        }

        Ok(val)
    }
}

impl<'a, T: ObjectLike<'a> + Copy + Default, const C: usize> TryFrom<Object<'a>> for [T; C]
where
    [T; C]: TryFrom<Array<'a>, Error = ()>,
{
    type Error = ();

    fn try_from(value: Object<'a>) -> Result<Self, Self::Error> {
        match value {
            Object::Array(a) => a.try_into(),
            _ => Err(()),
        }
    }
}

impl<'a, T: ObjectLike<'a> + Copy + Default, const C: usize> Readable<'a> for [T; C] {
    fn read(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self> {
        let array = Array::read(r, ctx)?;
        array.try_into().ok()
    }
}

impl<'a, T: ObjectLike<'a> + Copy + Default, const C: usize> ObjectLike<'a> for [T; C] {}

impl<'a, T: ObjectLike<'a>> TryFrom<Array<'a>> for Vec<T> {
    type Error = ();

    fn try_from(value: Array<'a>) -> Result<Self, Self::Error> {
        Ok(value.iter::<T>().collect())
    }
}

impl<'a, T: ObjectLike<'a>> TryFrom<Object<'a>> for Vec<T> {
    type Error = ();

    fn try_from(value: Object<'a>) -> Result<Self, Self::Error> {
        match value {
            Object::Array(a) => a.try_into(),
            _ => Err(()),
        }
    }
}

impl<'a, T: ObjectLike<'a>> Readable<'a> for Vec<T> {
    fn read(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self> {
        let array = Array::read(r, ctx)?;
        array.try_into().ok()
    }
}

impl<'a, T: ObjectLike<'a>> ObjectLike<'a> for Vec<T> {}

impl<'a, U: ObjectLike<'a>, T: ObjectLike<'a> + smallvec::Array<Item = U>> TryFrom<Array<'a>>
    for SmallVec<T>
{
    type Error = ();

    fn try_from(value: Array<'a>) -> Result<Self, Self::Error> {
        Ok(value.iter::<U>().collect())
    }
}

impl<'a, U: ObjectLike<'a>, T: ObjectLike<'a> + smallvec::Array<Item = U>> TryFrom<Object<'a>>
    for SmallVec<T>
{
    type Error = ();

    fn try_from(value: Object<'a>) -> Result<Self, Self::Error> {
        match value {
            Object::Array(a) => a.try_into(),
            _ => Err(()),
        }
    }
}

impl<'a, U: ObjectLike<'a>, T: ObjectLike<'a> + smallvec::Array<Item = U>> Readable<'a>
    for SmallVec<T>
{
    fn read(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self> {
        let array = Array::read(r, ctx)?;
        array.try_into().ok()
    }
}

impl<'a, U: ObjectLike<'a>, T: ObjectLike<'a> + smallvec::Array<Item = U>> ObjectLike<'a>
    for SmallVec<T>
where
    U: Clone,
    U: Debug,
{
}
