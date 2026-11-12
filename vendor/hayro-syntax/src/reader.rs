//! Reading bytes and PDF objects from data.

use crate::object::ObjectIdentifier;
use crate::sync::Arc;
use crate::trivia::{Comment, is_white_space_character};
use crate::xref::XRef;
use smallvec::SmallVec;

pub use crate::byte_reader::Reader;

/// Extension trait for the `Reader` struct.
pub trait ReaderExt<'a> {
    fn read<T: Readable<'a>>(&mut self, ctx: &ReaderContext<'a>) -> Option<T>;
    fn read_with_context<T: Readable<'a>>(&mut self, ctx: &ReaderContext<'a>) -> Option<T>;
    fn read_without_context<T: Readable<'a>>(&mut self) -> Option<T>;
    fn read_indirect<T: Readable<'a>>(&mut self, ctx: &ReaderContext<'a>) -> Option<T>;
    fn skip<T: Skippable>(&mut self, is_content_stream: bool) -> Option<&'a [u8]>;
    fn skip_with_depth<T: Skippable>(
        &mut self,
        is_content_stream: bool,
        depth: usize,
    ) -> Option<&'a [u8]>;
    fn skip_white_spaces(&mut self);
    fn read_white_space(&mut self) -> Option<()>;
    fn read_eol(&mut self) -> Option<()>;
    fn skip_white_spaces_and_comments(&mut self);
}

impl<'a> ReaderExt<'a> for Reader<'a> {
    // Note: If `PLAIN` is true, it means that the data we are about to read _might_ contain
    // an object reference instead of an actual object. if `PLAIN` is false, then an object
    // reference cannot occur. The main reason we make this distinction is that when parsing
    // a number, we cannot unambiguously distinguish whether it's a real number or the
    // start of an object reference. In content streams, object references cannot appear,
    // so in order to speed this up we set `PLAIN` to false, meaning that as soon as we
    // encounter a number we know it's a number, and don't need to do a look-ahead to ensure
    // that it's not an object reference.
    #[inline]
    fn read<T: Readable<'a>>(&mut self, ctx: &ReaderContext<'a>) -> Option<T> {
        let old_offset = self.offset;

        T::read(self, ctx).or_else(|| {
            self.offset = old_offset;

            None
        })
    }

    #[inline]
    fn read_with_context<T: Readable<'a>>(&mut self, ctx: &ReaderContext<'a>) -> Option<T> {
        self.read::<T>(ctx)
    }

    #[inline]
    fn read_without_context<T: Readable<'a>>(&mut self) -> Option<T> {
        self.read::<T>(ReaderContext::dummy_ref())
    }

    #[inline]
    fn read_indirect<T: Readable<'a>>(&mut self, ctx: &ReaderContext<'a>) -> Option<T> {
        let old_offset = self.offset;

        T::read_indirect(self, ctx).or_else(|| {
            self.offset = old_offset;

            None
        })
    }

    #[inline]
    fn skip<T: Skippable>(&mut self, is_content_stream: bool) -> Option<&'a [u8]> {
        self.skip_with_depth::<T>(is_content_stream, 0)
    }

    #[inline]
    fn skip_with_depth<T: Skippable>(
        &mut self,
        is_content_stream: bool,
        depth: usize,
    ) -> Option<&'a [u8]> {
        let old_offset = self.offset;

        T::skip_with_depth(self, is_content_stream, depth).or_else(|| {
            self.offset = old_offset;
            None
        })?;

        self.data.get(old_offset..self.offset)
    }

    #[inline]
    fn skip_white_spaces(&mut self) {
        while let Some(b) = self.peek_byte() {
            if is_white_space_character(b) {
                self.forward();
            } else {
                return;
            }
        }
    }

    #[inline]
    fn read_white_space(&mut self) -> Option<()> {
        if is_white_space_character(self.peek_byte()?) {
            let w = self.read_byte()?;

            if w == b'\r' && self.peek_byte().is_some_and(|b| b == b'\n') {
                self.read_byte()?;
            }

            return Some(());
        }

        None
    }

    #[inline]
    fn read_eol(&mut self) -> Option<()> {
        match self.peek_byte()? {
            b'\n' => self.forward(),
            b'\r' => {
                self.forward();
                let _ = self.forward_if(|b| b == b'\n');
            }
            _ => return None,
        }

        Some(())
    }

    #[inline]
    fn skip_white_spaces_and_comments(&mut self) {
        while let Some(b) = self.peek_byte() {
            if is_white_space_character(b) {
                self.forward();
            } else if b == b'%' {
                Comment::skip(self, true);
            } else {
                return;
            }
        }
    }
}

// recto: the fields a read sets for each object it resolves sit inline, so that setting them doesn't
// clone a shared allocation: `XRef::locate` did that for every object. Only the chain of objects
// being read is shared.
#[derive(Clone, Debug)]
struct ReaderContextData<'a> {
    xref: &'a XRef,
    in_content_stream: bool,
    in_object_stream: bool,
    obj_number: Option<ObjectIdentifier>,
    /// recto: the chain's last object, held here so that a read one object down from a context with no
    /// chain, as most are, doesn't allocate one; the objects before it are in `parent_chain`.
    chain_top: Option<ObjectIdentifier>,
    parent_chain: Option<Arc<SmallVec<[ObjectIdentifier; 8]>>>,
    /// recto: every object the chain has held, of which it keeps the last `CHAIN_WINDOW`.
    chain_len: u32,
}

// recto: the chain of objects being read is the reads from the top down, and it carries on into what
// an object's dictionary resolves later, so walking a list of n objects by `/Next` (an outline's items)
// copied and searched a chain of k objects at the k-th: 64,000 bookmarks took 0.8 s. The chain keeps its
// last `CHAIN_WINDOW` objects (outside such lists, no chain in the 531 files of the test corpus passes
// 12), so a cycle through up to that many is refused where it was. A longer one, which went round once
// before, is refused once the chain has held `MAX_CHAIN` objects: a walk of one is still bounded.
const CHAIN_WINDOW: usize = 64;
const MAX_CHAIN: u32 = 1 << 17;

#[derive(Clone, Debug)]
enum ReaderContextInner<'a> {
    Shared(ReaderContextData<'a>),
    Dummy { in_content_stream: bool },
}

/// Context for reading PDF objects.
#[derive(Clone, Debug)]
pub struct ReaderContext<'a>(ReaderContextInner<'a>);

impl<'a> ReaderContext<'a> {
    pub(crate) fn new(xref: &'a XRef, in_content_stream: bool) -> Self {
        Self(ReaderContextInner::Shared(ReaderContextData {
            xref,
            in_content_stream,
            obj_number: None,
            in_object_stream: false,
            chain_top: None,
            parent_chain: None,
            chain_len: 0,
        }))
    }

    pub fn dummy() -> Self {
        Self(ReaderContextInner::Dummy {
            in_content_stream: false,
        })
    }

    pub(crate) fn dummy_ref() -> &'static Self {
        &Self(ReaderContextInner::Dummy {
            in_content_stream: true,
        })
    }

    #[inline]
    pub(crate) fn xref(&self) -> &'a XRef {
        match &self.0 {
            ReaderContextInner::Shared(inner) => inner.xref,
            ReaderContextInner::Dummy { .. } => XRef::dummy(),
        }
    }

    #[inline]
    pub(crate) fn in_content_stream(&self) -> bool {
        match &self.0 {
            ReaderContextInner::Shared(inner) => inner.in_content_stream,
            ReaderContextInner::Dummy { in_content_stream } => *in_content_stream,
        }
    }

    #[inline]
    pub(crate) fn in_object_stream(&self) -> bool {
        match &self.0 {
            ReaderContextInner::Shared(inner) => inner.in_object_stream,
            ReaderContextInner::Dummy { .. } => false,
        }
    }

    #[inline]
    pub(crate) fn obj_number(&self) -> Option<ObjectIdentifier> {
        match &self.0 {
            ReaderContextInner::Shared(inner) => inner.obj_number,
            ReaderContextInner::Dummy { .. } => None,
        }
    }

    #[inline]
    pub(crate) fn set_obj_number(&mut self, id: ObjectIdentifier) {
        match &mut self.0 {
            ReaderContextInner::Shared(inner) => inner.obj_number = Some(id),
            ReaderContextInner::Dummy { .. } => {}
        }
    }

    #[inline]
    pub(crate) fn set_in_content_stream(&mut self, val: bool) {
        match &mut self.0 {
            ReaderContextInner::Shared(inner) => inner.in_content_stream = val,
            ReaderContextInner::Dummy { in_content_stream } => *in_content_stream = val,
        }
    }

    #[inline]
    pub(crate) fn set_in_object_stream(&mut self, val: bool) {
        match &mut self.0 {
            ReaderContextInner::Shared(inner) => inner.in_object_stream = val,
            ReaderContextInner::Dummy { .. } => {}
        }
    }

    #[inline]
    pub(crate) fn parent_chain_contains(&self, id: &ObjectIdentifier) -> bool {
        match &self.0 {
            ReaderContextInner::Shared(inner) => {
                inner.chain_len >= MAX_CHAIN
                    || inner.chain_top.as_ref() == Some(id)
                    || inner.parent_chain.as_ref().is_some_and(|chain| chain.contains(id))
            }
            ReaderContextInner::Dummy { .. } => false,
        }
    }

    #[inline]
    pub(crate) fn parent_chain_push(&mut self, id: ObjectIdentifier) {
        match &mut self.0 {
            ReaderContextInner::Shared(inner) => {
                inner.chain_len = inner.chain_len.saturating_add(1);
                let Some(below) = inner.chain_top.replace(id) else {
                    return;
                };
                let chain = Arc::make_mut(inner.parent_chain.get_or_insert_with(Default::default));
                if chain.len() >= CHAIN_WINDOW - 1 {
                    chain.remove(0);
                }
                chain.push(below)
            }
            ReaderContextInner::Dummy { .. } => {}
        }
    }
}

pub trait Readable<'a>: Sized {
    fn read(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self>;
    fn read_indirect(r: &mut Reader<'a>, ctx: &ReaderContext<'a>) -> Option<Self> {
        Self::read(r, ctx)
    }
    fn from_bytes_impl(b: &'a [u8]) -> Option<Self> {
        let mut r = Reader::new(b);
        Self::read_indirect(&mut r, &ReaderContext::dummy())
    }
}

pub trait Skippable {
    fn skip(r: &mut Reader<'_>, is_content_stream: bool) -> Option<()>;

    fn skip_with_depth(r: &mut Reader<'_>, is_content_stream: bool, _: usize) -> Option<()> {
        Self::skip(r, is_content_stream)
    }
}
