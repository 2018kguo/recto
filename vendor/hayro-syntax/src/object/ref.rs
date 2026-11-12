//! Object references.

use crate::object::ObjectIdentifier;
use crate::object::ObjectLike;
use crate::reader::Reader;
use crate::reader::{Readable, ReaderContext, ReaderExt, Skippable};
use core::fmt::{Debug, Display, Formatter};

/// A reference to an object.
#[derive(PartialEq, Eq, Debug, Clone, Copy, Hash)]
pub struct ObjRef {
    /// The object number.
    pub obj_number: u32,
    /// The generation number.
    pub gen_number: i32,
}

impl ObjRef {
    /// Create a new object reference.
    pub fn new(obj_number: u32, gen_number: i32) -> Self {
        Self {
            obj_number,
            gen_number,
        }
    }
}

impl Display for ObjRef {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        write!(f, "{} {} R", self.obj_number, self.gen_number)
    }
}

impl From<ObjRef> for ObjectIdentifier {
    fn from(value: ObjRef) -> Self {
        Self::new(value.obj_number, value.gen_number)
    }
}

impl From<ObjectIdentifier> for ObjRef {
    fn from(value: ObjectIdentifier) -> Self {
        Self::new(value.obj_number, value.gen_number)
    }
}

impl Skippable for ObjRef {
    fn skip(r: &mut Reader<'_>, _: bool) -> Option<()> {
        r.skip::<u32>(false)?;
        r.skip_white_spaces();
        r.skip::<i32>(false)?;
        r.skip_white_spaces();
        r.forward_tag(b"R")?;

        Some(())
    }
}

impl Readable<'_> for ObjRef {
    fn read(r: &mut Reader<'_>, _: &ReaderContext<'_>) -> Option<Self> {
        let obj_ref = r.read_without_context::<u32>()?;
        r.skip_white_spaces();
        let gen_num = r.read_without_context::<i32>()?;
        r.skip_white_spaces();
        r.forward_tag(b"R")?;

        Some(Self::new(obj_ref, gen_num))
    }
}

/// A struct that is either an object or a reference to an object.
#[derive(PartialEq, Eq)]
pub enum MaybeRef<T> {
    /// A reference to an object.
    Ref(ObjRef),
    /// An object.
    NotRef(T),
}

impl<T> MaybeRef<T> {
    /// If the object is an object reference, return it.
    pub fn as_obj_ref(&self) -> Option<ObjRef> {
        match self {
            Self::Ref(r) => Some(*r),
            Self::NotRef(_) => None,
        }
    }
}

#[allow(private_bounds)]
impl<'a, T> MaybeRef<T>
where
    T: ObjectLike<'a>,
{
    /// Resolve the `MaybeRef` object with the given xref table.
    pub(crate) fn resolve(self, ctx: &ReaderContext<'a>) -> Option<T> {
        match self {
            Self::Ref(r) => ctx.xref().get_with::<T>(r.into(), ctx),
            Self::NotRef(t) => Some(t),
        }
    }
}

impl<T> TryFrom<MaybeRef<T>> for ObjRef {
    type Error = ();

    fn try_from(value: MaybeRef<T>) -> Result<Self, Self::Error> {
        match value {
            MaybeRef::Ref(r) => Ok(r),
            MaybeRef::NotRef(_) => Err(()),
        }
    }
}

impl<T> Debug for MaybeRef<T>
where
    T: Debug,
{
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Ref(r) => write!(f, "{r:?}"),
            Self::NotRef(nr) => write!(f, "{nr:?}"),
        }
    }
}

impl<T: Display> Display for MaybeRef<T> {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Ref(value) => Display::fmt(value, f),
            Self::NotRef(value) => Display::fmt(value, f),
        }
    }
}

impl<T> Skippable for MaybeRef<T>
where
    T: Skippable,
{
    fn skip(r: &mut Reader<'_>, is_content_stream: bool) -> Option<()> {
        Self::skip_with_depth(r, is_content_stream, 0)
    }

    fn skip_with_depth(r: &mut Reader<'_>, is_content_stream: bool, depth: usize) -> Option<()> {
        // recto: a reference starts as a number does; anything else skips trying one.
        (may_start_ref(r) && r.skip::<ObjRef>(is_content_stream).is_some())
            .then_some(())
            .or_else(|| r.skip_with_depth::<T>(is_content_stream, depth).map(|_| {}))
    }
}

impl<'a, T> Readable<'a> for MaybeRef<T>
where
    T: Readable<'a>,
{
    fn read(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self> {
        if may_start_ref(r) && let Some(obj) = r.read::<ObjRef>(ctx) {
            Some(Self::Ref(obj))
        } else {
            Some(Self::NotRef(r.read::<T>(ctx)?))
        }
    }
}

/// recto: whether what's next could begin a reference: its object number is read as a number, which
/// starts with a sign, a point or a digit.
#[inline(always)]
fn may_start_ref(r: &Reader<'_>) -> bool {
    matches!(r.peek_byte(), Some(b'0'..=b'9' | b'+' | b'-' | b'.'))
}
