//! Parsing and reading from PDF objects.

pub use crate::object::array::Array;
pub use crate::object::dict::Dict;
pub use crate::object::name::Name;
use crate::object::name::skip_name_like;
pub use crate::object::null::Null;
pub use crate::object::number::Number;
pub use crate::object::rect::Rect;
pub use crate::object::r#ref::{MaybeRef, ObjRef};
pub use crate::object::stream::Stream;
pub use crate::object::string::String;
use crate::reader::Reader;
use crate::reader::{Readable, ReaderContext, ReaderExt, Skippable};
use core::fmt::{Debug, Display, Formatter};

pub(crate) const MAX_OBJECT_NESTING_DEPTH: usize = 512;

/// recto: while a repair scan probes for a dictionary, where the dictionaries and arrays a skip
/// was inside start, deepest first, when it stopped at `MAX_OBJECT_NESTING_DEPTH`; see
/// `fallback_xref_map_inner`. Each probe of `<< << << ...` past the limit went 512 deep, and one
/// started at every `<<`.
pub(crate) mod depth_chain {
    use alloc::vec::Vec;
    use core::cell::RefCell;
    use core::sync::atomic::{AtomicUsize, Ordering};

    /// How many threads are recording: while none is, a failed skip doesn't look at its thread's
    /// chain, which every container of a deep file's every probe would.
    static RECORDING: AtomicUsize = AtomicUsize::new(0);

    std::thread_local! {
        /// While recording: whether a skip stopped at the limit, and the chain so far.
        static CHAIN: RefCell<Option<(bool, Vec<usize>)>> = const { RefCell::new(None) };
    }

    /// `f`'s result, with `chain` the chain if `on` and a skip in it stopped at the limit (empty
    /// otherwise). `chain`'s allocation is reused, as a scan probes at every `<<`.
    pub(crate) fn recording<T>(on: bool, chain: &mut Vec<usize>, f: impl FnOnce() -> Option<T>) -> Option<T> {
        chain.clear();
        if !on {
            return f();
        }
        let buffer = core::mem::take(chain);
        CHAIN.with_borrow_mut(|recorded| *recorded = Some((false, buffer)));
        RECORDING.fetch_add(1, Ordering::Relaxed);
        let result = f();
        RECORDING.fetch_sub(1, Ordering::Relaxed);
        if let Some((hit, buffer)) = CHAIN.with_borrow_mut(Option::take) {
            *chain = buffer;
            if !hit {
                chain.clear();
            }
        }
        result
    }

    /// A container starting at `start` was asked for at the limit.
    #[inline]
    pub(super) fn stopped(start: usize) {
        if RECORDING.load(Ordering::Relaxed) != 0 {
            note(start, true);
        }
    }

    /// A container starting at `start` couldn't be skipped: one around where a skip stopped, if
    /// one did, since nothing between there and here goes on after a failure.
    #[inline]
    pub(super) fn failed(start: usize) {
        if RECORDING.load(Ordering::Relaxed) != 0 {
            note(start, false);
        }
    }

    #[inline(never)]
    fn note(start: usize, stopped: bool) {
        CHAIN.with_borrow_mut(|chain| {
            if let Some((hit, chain)) = chain
                && (stopped || *hit)
            {
                *hit = true;
                chain.push(start);
            }
        });
    }
}

mod bool;
mod null;
mod number;
mod rect;
mod r#ref;
mod string;
mod tuple;

pub(crate) mod indirect;
pub(crate) mod name;

pub mod array;
pub mod dict;
pub mod stream;

/// A trait for PDF objects.
pub(crate) trait ObjectLike<'a>: TryFrom<Object<'a>> + Readable<'a> + Debug + Clone {}

/// A trait for PDF objects that can be borrowed directly from an [`Object`].
pub(crate) trait ObjectRefLike<'a>: Sized {
    fn cast_ref<'b>(obj: &'b Object<'a>) -> Option<&'b Self>;
}

/// A primitive PDF object.
#[derive(Debug, Clone, PartialEq)]
pub enum Object<'a> {
    /// A null object.
    Null(Null),
    /// A boolean object.
    Boolean(bool),
    /// A number object.
    Number(Number),
    /// A string object.
    String(String<'a>),
    /// A name object.
    Name(Name<'a>),
    /// A dict object.
    Dict(Dict<'a>),
    /// An array object.
    Array(Array<'a>),
    /// A stream object.
    // Can only be an indirect object in theory and thus comes with some caveats,
    // but we just treat it the same.
    Stream(Stream<'a>),
}

impl Display for Object<'_> {
    fn fmt(&self, f: &mut Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Null(value) => Display::fmt(value, f),
            Self::Boolean(value) => Display::fmt(value, f),
            Self::Number(value) => Display::fmt(value, f),
            Self::String(value) => Display::fmt(value, f),
            Self::Name(value) => Display::fmt(value, f),
            Self::Dict(value) => Display::fmt(value, f),
            Self::Array(value) => Display::fmt(value, f),
            Self::Stream(value) => Display::fmt(value, f),
        }
    }
}

impl<'a> Object<'a> {
    /// Try casting the object to a specific subtype.
    pub(crate) fn cast<T>(self) -> Option<T>
    where
        T: ObjectLike<'a>,
    {
        self.try_into().ok()
    }

    /// Try casting the object to a reference of the specific type.
    pub(crate) fn cast_ref<T>(&self) -> Option<&T>
    where
        T: ObjectRefLike<'a>,
    {
        T::cast_ref(self)
    }

    /// Try casting the object to a dict.
    #[inline(always)]
    pub fn into_dict(self) -> Option<Dict<'a>> {
        self.cast()
    }

    /// Try casting the object to a name.
    #[inline(always)]
    pub fn into_name(self) -> Option<Name<'a>> {
        self.cast()
    }

    /// Try casting the object to a stream.
    #[inline(always)]
    pub fn into_stream(self) -> Option<Stream<'a>> {
        self.cast()
    }

    /// Try casting the object to an array.
    #[inline(always)]
    pub fn into_array(self) -> Option<Array<'a>> {
        self.cast()
    }

    /// Try casting the object to a number.
    #[inline(always)]
    pub fn into_number(self) -> Option<Number> {
        self.cast()
    }
}

impl<'a> ObjectLike<'a> for Object<'a> {}
impl<'a> ObjectRefLike<'a> for Object<'a> {
    fn cast_ref(obj: &Self) -> Option<&Self> {
        Some(obj)
    }
}

impl Skippable for Object<'_> {
    fn skip(r: &mut Reader<'_>, is_content_stream: bool) -> Option<()> {
        Self::skip_with_depth(r, is_content_stream, 0)
    }

    fn skip_with_depth(r: &mut Reader<'_>, is_content_stream: bool, depth: usize) -> Option<()> {
        match r.peek_byte()? {
            b'n' => Null::skip(r, is_content_stream),
            b't' | b'f' => bool::skip(r, is_content_stream),
            b'/' => Name::skip(r, is_content_stream),
            b'<' => match r.peek_bytes(2)? {
                // A stream can never appear in a dict/array, so it should never be skipped.
                b"<<" => Dict::skip_with_depth(r, is_content_stream, depth),
                _ => String::skip(r, is_content_stream),
            },
            b'(' => String::skip(r, is_content_stream),
            b'.' | b'+' | b'-' | b'0'..=b'9' => Number::skip(r, is_content_stream),
            b'[' => Array::skip_with_depth(r, is_content_stream, depth),
            // See test case operator-in-TJ-array-0: Be lenient and skip content operators in
            // array
            _ => skip_name_like(r, false),
        }
    }
}

impl<'a> Readable<'a> for Object<'a> {
    fn read(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self> {
        let object = match r.peek_byte()? {
            b'n' => Self::Null(Null::read(r, ctx)?),
            b't' | b'f' => Self::Boolean(bool::read(r, ctx)?),
            b'/' => Self::Name(Name::read(r, ctx)?),
            b'<' => match r.peek_bytes(2)? {
                b"<<" => Self::Dict(Dict::read(r, ctx)?),
                _ => Self::String(String::read(r, ctx)?),
            },
            b'(' => Self::String(String::read(r, ctx)?),
            b'.' | b'+' | b'-' | b'0'..=b'9' => Self::Number(Number::read(r, ctx)?),
            b'[' => Self::Array(Array::read(r, ctx)?),
            // See the comment in `skip`.
            _ => {
                skip_name_like(r, false)?;
                Self::Null(Null)
            }
        };

        Some(object)
    }

    fn read_indirect(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self> {
        if r.peek_bytes(2) == Some(b"<<") {
            let mut cloned = r.clone();
            let dict = Dict::read(&mut cloned, ctx)?;
            cloned.skip_white_spaces_and_comments();

            if cloned.forward_tag(b"stream").is_some() {
                return Some(Self::Stream(Stream::read_indirect(r, ctx)?));
            }

            r.jump(cloned.offset());

            return Some(Self::Dict(dict));
        }

        Self::read(r, ctx)
    }
}

/// A trait for objects that can be parsed from a simple byte stream.
pub trait FromBytes<'a>: Sized {
    /// Try to read the object from the given bytes.
    fn from_bytes(b: &'a [u8]) -> Option<Self>;
}

impl<'a, T: Readable<'a>> FromBytes<'a> for T {
    fn from_bytes(b: &'a [u8]) -> Option<Self> {
        Self::from_bytes_impl(b)
    }
}

/// An identifier for a PDF object.
#[derive(Copy, Clone, Debug, Eq, PartialEq, Hash, PartialOrd, Ord)]
pub struct ObjectIdentifier {
    /// The object number.
    pub obj_number: u32,
    /// The generation number.
    pub gen_number: i32,
}

impl ObjectIdentifier {
    /// Create a new `ObjectIdentifier`.
    pub fn new(obj_number: u32, gen_number: i32) -> Self {
        Self {
            obj_number,
            gen_number,
        }
    }
}

impl Readable<'_> for ObjectIdentifier {
    fn read(r: &mut Reader<'_>, _: &ReaderContext<'_>) -> Option<Self> {
        let obj_number = r.read_without_context::<u32>()?;
        r.skip_white_spaces_and_comments();
        let gen_number = r.read_without_context::<i32>()?;
        r.skip_white_spaces_and_comments();
        r.forward_tag(b"obj")?;

        Some(Self {
            obj_number,
            gen_number,
        })
    }
}

impl Skippable for ObjectIdentifier {
    fn skip(r: &mut Reader<'_>, _: bool) -> Option<()> {
        r.skip::<u32>(false)?;
        r.skip_white_spaces_and_comments();
        r.skip::<i32>(false)?;
        r.skip_white_spaces_and_comments();
        r.forward_tag(b"obj")?;

        Some(())
    }
}

/// A convenience function that extracts a dict and a stream from an object.
/// If the object is just a dictionary, it will return `None` for the stream.
/// If the object is a stream, it will return its dictionary as well as the stream
/// itself.
pub fn dict_or_stream<'a, 'b>(
    obj: &'b Object<'a>,
) -> Option<(&'b Dict<'a>, Option<&'b Stream<'a>>)> {
    if let Some(stream) = obj.cast_ref::<Stream<'a>>() {
        Some((stream.dict(), Some(stream)))
    } else {
        obj.cast_ref::<Dict<'a>>().map(|dict| (dict, None))
    }
}

mod macros {
    macro_rules! object {
        ($t:ident $(<$l:lifetime>),*, $s:ident) => {
            impl<'a> TryFrom<Object<'a>> for $t$(<$l>),* {
                type Error = ();

                fn try_from(value: Object<'a>) -> core::result::Result<Self, Self::Error> {
                    match value {
                        Object::$s(b) => Ok(b),
                        _ => Err(()),
                    }
                }
            }

            impl<'a> crate::object::ObjectLike<'a> for $t$(<$l>),* {}

            impl<'a> crate::object::ObjectRefLike<'a> for $t$(<$l>),* {
                fn cast_ref<'b>(obj: &'b crate::object::Object<'a>) -> Option<&'b Self> {
                    match obj {
                        crate::object::Object::$s(b) => Some(b),
                        _ => None,
                    }
                }
            }
        };
    }

    pub(crate) use object;
}
