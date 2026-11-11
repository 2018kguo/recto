//! Reading and querying the xref table of a PDF file.

use crate::crypto::{DecryptionError, DecryptionTarget, Decryptor, get};
use crate::data::Data;
use crate::object::Name;
use crate::object::ObjectIdentifier;
use crate::object::Stream;
use crate::object::dict::keys::{
    ENCRYPT, FILTER, FIRST, ID, INDEX, N, O, P, PAGES, PREV, R, ROOT, SIZE, TYPE, U, VERSION, W, XREF_STM,
};
use crate::object::dict::probe_dict;
use crate::object::indirect::IndirectObject;
use crate::object::{Array, MaybeRef};
use crate::object::Dict;
use crate::object::{Object, ObjectLike};
use crate::pdf::PdfVersion;
use crate::reader::Reader;
use crate::reader::{Readable, ReaderContext, ReaderExt};
use crate::sync::{Arc, FxHashMap, RwLock, RwLockExt};
use crate::trivia::is_white_space_character;
use crate::util::findr_needle;
use crate::{PdfData, object};
use alloc::collections::BTreeSet;
use alloc::vec;
use alloc::vec::Vec;
use core::cmp::max;
use core::iter;
use core::ops::Deref;

pub(crate) const XREF_ENTRY_LEN: usize = 20;

#[derive(Debug, Copy, Clone)]
pub(crate) enum XRefError {
    Unknown,
    Encryption(DecryptionError),
}

/// Parse the "root" xref from the PDF.
pub(crate) fn root_xref(data: PdfData, password: &[u8]) -> Result<XRef, XRefError> {
    let mut xref_map = FxHashMap::default();
    let xref_pos = find_last_xref_pos(data.as_ref()).ok_or(XRefError::Unknown)?;
    let trailer =
        populate_xref_impl(&data, xref_pos, &mut xref_map).ok_or(XRefError::Unknown)?;

    XRef::new(
        data.clone(),
        xref_map,
        XRefInput::TrailerDictData(trailer),
        false,
        password,
    )
}

/// Try to manually parse the PDF to build an xref table and trailer dictionary.
pub(crate) fn fallback(data: PdfData, password: &[u8]) -> Result<XRef, XRefError> {
    // recto: a repair scans the whole file. Not one that's zeros after a failed read.
    if !data.ensure(0, usize::MAX) {
        return Err(XRefError::Unknown);
    }
    let (xref_map, xref_input) = fallback_xref_map(&data, password);

    match xref_input {
        Some(xref_input) => XRef::new(data.clone(), xref_map, xref_input, true, password),
        None => Err(XRefError::Unknown),
    }
}

/// recto: with the trailer gone, nothing points at the encryption dictionary, and reading the file
/// as unencrypted gives garbage that looks like an empty document. Look for the dictionary itself.
fn find_encrypt_dict(data: &PdfData, xref_map: &XrefMap, ctx: &ReaderContext<'_>) -> Option<ObjectIdentifier> {
    let bytes = data.as_ref();
    let mut from = 0;
    while let Some(found) = crate::util::find_needle(&bytes[from..], b"/Standard") {
        let at = from + found;
        from = at + 1;
        // The object it lies in: the nearest start before it.
        let owner = xref_map
            .iter()
            .filter_map(|(id, entry)| match entry {
                EntryType::Normal(offset) if *offset <= at => Some((*offset, *id)),
                _ => None,
            })
            .max_by_key(|(offset, _)| *offset);
        let Some((offset, id)) = owner else { continue };
        let mut reader = Reader::new(&bytes[offset..]);
        let Some(object) = reader.read_with_context::<IndirectObject<Dict<'_>>>(ctx) else {
            continue;
        };
        let dict = object.get();
        if dict.contains_key(FILTER) && dict.contains_key(O) && dict.contains_key(U) && dict.contains_key(P) {
            return Some(id);
        }
    }
    None
}

fn fallback_xref_map<'a>(data: &'a PdfData, password: &[u8]) -> (XrefMap, Option<XRefInput<'a>>) {
    fallback_xref_map_inner(data, ReaderContext::dummy(), true, password)
}

/// recto: what a scan does with a free entry. An object written in an earlier revision is gone. One
/// written in the same revision as the entry says free isn't: no writer does that, so the entry is
/// damaged, and the object is what a repair is for.
fn free_entry(map: &mut XrefMap, number: u32, generation: i32, before: usize, packed_too: bool) {
    for id in [generation, generation - 1].map(|generation| ObjectIdentifier::new(number, generation)) {
        let written = match map.get(&id) {
            Some(EntryType::Normal(offset)) => Some(*offset),
            Some(EntryType::ObjStream(container, _)) if packed_too => {
                match map.get(&ObjectIdentifier::new(*container, 0)) {
                    Some(EntryType::Normal(offset)) => Some(*offset),
                    _ => None,
                }
            }
            _ => None,
        };
        if written.is_some_and(|offset| offset < before) {
            map.remove(&id);
        }
    }
}

/// recto: the free entries of the xref table these bytes start with, as object and generation.
fn xref_table_frees(bytes: &[u8]) -> Vec<(u32, i32)> {
    let mut frees = Vec::new();
    let mut tokens = bytes.split(|b| b.is_ascii_whitespace()).filter(|t| !t.is_empty());
    let number = |token: &[u8]| core::str::from_utf8(token).ok()?.parse::<u32>().ok();
    while let (Some(first), Some(count)) = (tokens.next().and_then(number), tokens.next().and_then(number)) {
        for i in 0..count {
            let (Some(_), Some(generation), Some(kind)) = (tokens.next(), tokens.next().and_then(number), tokens.next()) else {
                return frees;
            };
            if kind == b"f" && let Some(object) = first.checked_add(i).filter(|object| *object > 0) {
                frees.push((object, generation.min(i32::MAX as u32) as i32));
            }
        }
    }
    frees
}

/// recto: the same for an xref stream.
fn xref_stream_frees(stream: &Stream<'_>) -> Option<Vec<(u32, i32)>> {
    let dict = stream.dict();
    let widths = dict.get::<[u8; 3]>(W)?;
    let [type_len, offset_len, generation_len] = widths.map(usize::from);
    let entry = (type_len + offset_len + generation_len).max(1);
    let data = stream.decoded().ok()?;
    let size = dict.get::<u32>(SIZE)?;
    let index: Vec<u32> = dict.get::<Vec<u32>>(INDEX).unwrap_or_else(|| vec![0, size]);
    let mut frees = Vec::new();
    let mut entries = data.chunks_exact(entry);
    for section in index.chunks_exact(2) {
        for i in 0..section[1] {
            let Some(bytes) = entries.next() else {
                return Some(frees);
            };
            if type_len > 0
                && bytes[..type_len].iter().all(|b| *b == 0)
                && let Some(object) = section[0].checked_add(i).filter(|object| *object > 0)
            {
                let generation = xref_stream_num(&bytes[type_len + offset_len..])?;
                frees.push((object, generation.min(i32::MAX as u32) as i32));
            }
        }
    }
    Some(frees)
}

fn fallback_xref_map_inner<'a>(
    data: &'a PdfData,
    mut dummy_ctx: ReaderContext<'a>,
    recurse: bool,
    password: &[u8],
) -> (XrefMap, Option<XRefInput<'a>>) {
    let mut xref_map = FxHashMap::default();
    let mut trailer_dicts = vec![];
    let mut root_ref = None;

    let mut r = Reader::new(data.as_ref());

    let mut last_obj_num = None;
    let mut last_obj_offset = 0;
    // recto: where the last xref section seen is, ending the revision before this one.
    let mut previous_section = 0;

    loop {
        let cur_pos = r.offset();

        let mut old_r = r.clone();

        // First try to check if we have an object identifier.
        if r.peek_byte().is_some_and(|b: u8| b.is_ascii_digit()) {
            if let Some(obj_id) = r.read::<ObjectIdentifier>(&dummy_ctx) {
                let mut cloned = r.clone();
                // Check that the object following it is actually valid before inserting it.
                cloned.skip_white_spaces_and_comments();
                if cloned.skip::<Object<'_>>(false).is_some() {
                    xref_map.insert(obj_id, EntryType::Normal(cur_pos));
                    last_obj_num = Some(obj_id);
                    last_obj_offset = cur_pos;
                    dummy_ctx.set_obj_number(obj_id);
                }
            } else {
                // There must be a white space before the next object number.
                r.forward_while(|b| !is_white_space_character(b));
            }
        } else {
            // Then, try to check whether we have a dictionary, in particular a trailer
            // dictionary.
            let mut probe_reader = r.clone();
            if r.peek_bytes(2).is_some_and(|b| b == b"<<")
                && let Some(probe) =
                    { probe_dict(&mut probe_reader, &dummy_ctx, Some(b"<<"), b">>") }
            {
                r = probe_reader;
                if probe.has_root || probe.has_type {
                    let mut dict_reader = Reader::new(probe.data);
                    if let Some(dict) = dict_reader.read_with_context::<Dict<'_>>(&dummy_ctx) {
                        if probe.has_root && dict.contains_key(ROOT) {
                            trailer_dicts.push(dict.clone());
                        }

                        if dict
                            .get::<Name<'_>>(TYPE)
                            .is_some_and(|n| n.as_str() == "Catalog")
                        {
                            root_ref = last_obj_num;
                        }

                        // recto: an object a later revision removed stays removed. See `free_entry`.
                        if dict.get::<Name<'_>>(TYPE).as_deref() == Some(b"XRef")
                            && let Some(stream) = old_r.clone().read_indirect::<Stream<'_>>(&dummy_ctx)
                        {
                            for (number, generation) in xref_stream_frees(&stream).unwrap_or_default() {
                                free_entry(&mut xref_map, number, generation, previous_section, true);
                            }
                            previous_section = last_obj_offset;
                        }

                        if dict.get::<Name<'_>>(TYPE).as_deref() == Some(b"ObjStm")
                            && {
                                let mut after_dict = r.clone();
                                after_dict.skip_white_spaces_and_comments();
                                after_dict.forward_tag(b"stream").is_some()
                            }
                            && let Some(stream) = old_r.read_indirect::<Stream<'_>>(&dummy_ctx)
                            && let Some(last_obj_num) = last_obj_num
                            && let Some(obj_stream) = ObjectStream::new(&stream)
                        {
                            for (idx, (obj_num, offset)) in obj_stream.offsets.iter().enumerate() {
                                if offset.is_none() {
                                    continue;
                                }

                                // recto: what's later in the file is newer, in a stream or not. An
                                // earlier plain copy is what a later revision replaced.
                                xref_map.insert(
                                    ObjectIdentifier::new(*obj_num, 0),
                                    EntryType::ObjStream(last_obj_num.obj_number, idx as u32),
                                );
                            }
                        }
                    }
                }
            } else {
                // recto: as with an xref stream, but only plain objects: a hybrid file's table marks
                // what's in its object streams as free, and those are in use.
                if r.peek_bytes(4).is_some_and(|b| b == b"xref") {
                    for (number, generation) in xref_table_frees(&data.as_ref()[r.offset + 4..]) {
                        free_entry(&mut xref_map, number, generation, previous_section, false);
                    }
                    previous_section = r.offset;
                }

                // We can skip everything until the next white space character,
                // as there cannot possibly be any new dictionary/object identifier
                // until then.
                let old_pos = r.offset;
                r.forward_while(|b| !is_white_space_character(b));
                if r.offset == old_pos {
                    r.read_byte();
                }
            }
        }

        if r.at_end() {
            break;
        }
    }

    // Try to choose the right trailer dict by doing basic validation.
    let mut trailer_dict = None;

    for dict in trailer_dicts {
        if let Some(root_id) = dict.get_raw::<Dict<'_>>(ROOT) {
            let check = |dict: &Dict<'_>| -> bool { dict.contains_key(PAGES) };

            match root_id {
                MaybeRef::Ref(r) => match xref_map.get(&r.into()) {
                    Some(EntryType::Normal(offset)) => {
                        let mut reader = Reader::new(&data.as_ref()[*offset..]);

                        if let Some(obj) =
                            reader.read_with_context::<IndirectObject<Dict<'_>>>(&dummy_ctx)
                            && {
                                let obj = obj.get();
                                check(&obj)
                            }
                        {
                            trailer_dict = Some(dict);
                        }
                    }
                    Some(EntryType::ObjStream(obj_num, idx)) => {
                        if let Some(EntryType::Normal(offset)) =
                            xref_map.get(&ObjectIdentifier::new(*obj_num, 0))
                        {
                            let mut reader = Reader::new(&data.as_ref()[*offset..]);

                            if let Some(stream) =
                                reader.read_with_context::<IndirectObject<Stream<'_>>>(&dummy_ctx)
                                && {
                                    if let Some(object_stream) = ObjectStream::new(&stream.get())
                                        && let Some(obj) =
                                            object_stream.get::<Dict<'_>>(*idx, &dummy_ctx)
                                    {
                                        check(&obj)
                                    } else {
                                        false
                                    }
                                }
                            {
                                trailer_dict = Some(dict);
                            }
                        }
                    }
                    _ => {}
                },
                MaybeRef::NotRef(d) => {
                    if check(&d) {
                        trailer_dict = Some(dict);
                    }
                }
            }
        }
    }

    let has_encryption = trailer_dict
        .as_ref()
        .is_some_and(|t| t.contains_key(ENCRYPT));

    if has_encryption && recurse {
        // The problem is that in this case, we have used a dummy reader context which does not have
        // a decryptor. Therefore, we were unable to decrypt any of the object streams and missed
        // all objects that are inside of such a stream. Therefore, we need to redo the process
        // using a `ReaderContext` that does have the ability to decrypt.
        if let Ok(xref) = XRef::new(
            data.clone(),
            xref_map.clone(),
            XRefInput::TrailerDictData(trailer_dict.as_ref().map(|d| d.data()).unwrap()),
            true,
            password,
        ) {
            let ctx = ReaderContext::new(&xref, false);
            let (patched_map, _) = fallback_xref_map_inner(data, ctx, false, password);
            xref_map = patched_map;
        }
    }

    if let Some(trailer_dict_data) = trailer_dict.map(|d| d.data()) {
        (
            xref_map,
            Some(XRefInput::TrailerDictData(trailer_dict_data)),
        )
    } else if let Some(root_ref) = root_ref {
        let encrypt = find_encrypt_dict(data, &xref_map, &dummy_ctx);
        (xref_map, Some(XRefInput::RootRef(root_ref, encrypt)))
    } else {
        (xref_map, None)
    }
}

const DUMMY_XREF: XRef = XRef(Inner::Dummy);

/// An xref table.
#[derive(Debug, Clone)]
pub struct XRef(Inner);

impl XRef {
    fn new(
        data: PdfData,
        xref_map: XrefMap,
        input: XRefInput<'_>,
        repaired: bool,
        password: &[u8],
    ) -> Result<Self, XRefError> {
        // This is a bit hacky, but the problem is we can't read the resolved trailer dictionary
        // before we actually created the xref struct. So we first create it using dummy data
        // and then populate the data.
        let trailer_data = TrailerData::dummy();
        let mut starts: Vec<usize> = if data.is_ranged() {
            xref_map
                .values()
                .filter_map(|entry| match entry {
                    EntryType::Normal(offset) => Some(*offset),
                    EntryType::ObjStream(..) => None,
                })
                .collect()
        } else {
            Vec::new()
        };
        starts.sort_unstable();

        let mut xref = Self(Inner::Some(Arc::new(SomeRepr {
            data: Arc::new(Data::new(data)),
            map: Arc::new(RwLock::new(MapRepr { xref_map, repaired })),
            decryptor: Arc::new(Decryptor::None),
            trailer_data,
            password: password.to_vec(),
            starts: Arc::new(starts),
        })));

        // We read the trailer twice, once to determine the encryption used and then a second
        // time to resolve the catalog dictionary, etc. This allows us to support catalog dictionaries
        // that are stored in an encrypted object stream.

        let decryptor = {
            match input {
                XRefInput::TrailerDictData(trailer_dict_data) => {
                    let mut r = Reader::new(trailer_dict_data);

                    let trailer_dict = r
                        .read_with_context::<Dict<'_>>(&ReaderContext::new(&xref, false))
                        .ok_or(XRefError::Unknown)?;

                    get_decryptor(&trailer_dict, password)?
                }
                XRefInput::RootRef(_, None) => Decryptor::None,
                // recto: the key of revisions before 6 hangs on the trailer's ID, which is gone
                // with the trailer: a password can't be told from a wrong one, so don't ask for one.
                XRefInput::RootRef(_, Some(encrypt)) => {
                    let dict = xref.get::<Dict<'_>>(encrypt).ok_or(XRefError::Unknown)?;
                    if dict.get::<u8>(R).is_none_or(|r| r < 5) {
                        return Err(XRefError::Unknown);
                    }
                    get(&dict, &[], password).map_err(XRefError::Encryption)?
                }
            }
        };

        match &mut xref.0 {
            Inner::Dummy => unreachable!(),
            Inner::Some(r) => {
                let mutable = Arc::make_mut(r);
                mutable.decryptor = Arc::new(decryptor.clone());
            }
        }

        let trailer_data = match input {
            XRefInput::TrailerDictData(trailer_dict_data) => {
                let mut r = Reader::new(trailer_dict_data);

                let trailer_dict = r
                    .read_with_context::<Dict<'_>>(&ReaderContext::new(&xref, false))
                    .ok_or(XRefError::Unknown)?;

                let root_ref = trailer_dict.get_ref(ROOT).ok_or(XRefError::Unknown)?;
                let root = trailer_dict
                    .get::<Dict<'_>>(ROOT)
                    .ok_or(XRefError::Unknown)?;
                let pages_ref = root.get_ref(PAGES).ok_or(XRefError::Unknown)?;
                let version = root
                    .get::<Name<'_>>(VERSION)
                    .and_then(|v| PdfVersion::from_bytes(v.deref()));

                let td = TrailerData {
                    pages_ref: pages_ref.into(),
                    root_ref: root_ref.into(),
                    version,
                };

                td
            }
            XRefInput::RootRef(root_ref, _) => {
                let root = xref.get::<Dict<'_>>(root_ref).ok_or(XRefError::Unknown)?;
                let pages_ref = root.get_ref(PAGES).ok_or(XRefError::Unknown)?;

                let td = TrailerData {
                    pages_ref: pages_ref.into(),
                    root_ref,
                    version: None,
                };

                td
            }
        };

        match &mut xref.0 {
            Inner::Dummy => unreachable!(),
            Inner::Some(r) => {
                let mutable = Arc::make_mut(r);
                mutable.trailer_data = trailer_data;
                mutable.decryptor = Arc::new(decryptor);
            }
        }

        Ok(xref)
    }

    pub(crate) fn dummy() -> &'static Self {
        &DUMMY_XREF
    }

    /// recto: whether the file's bytes are fetched on first use.
    pub(crate) fn is_ranged(&self) -> bool {
        match &self.0 {
            Inner::Some(r) => r.data.get().is_ranged(),
            Inner::Dummy => false,
        }
    }

    pub(crate) fn len(&self) -> usize {
        match &self.0 {
            Inner::Dummy => 0,
            Inner::Some(r) => r.map.get().xref_map.len(),
        }
    }

    pub(crate) fn trailer_data(&self) -> &TrailerData {
        match &self.0 {
            Inner::Dummy => unreachable!(),
            Inner::Some(r) => &r.trailer_data,
        }
    }

    /// Return the object ID of the root dictionary.
    pub fn root_id(&self) -> ObjectIdentifier {
        self.trailer_data().root_ref
    }

    pub(crate) fn objects(&self) -> impl IntoIterator<Item = Object<'_>> + '_ {
        match &self.0 {
            Inner::Dummy => unimplemented!(),
            Inner::Some(r) => {
                let locked = r.map.get();
                let mut elements = locked
                    .xref_map
                    .iter()
                    .map(|(id, e)| {
                        let offset = match e {
                            EntryType::Normal(o) => (*o, 0),
                            EntryType::ObjStream(id, index) => {
                                if let Some(EntryType::Normal(offset)) =
                                    locked.xref_map.get(&ObjectIdentifier::new(*id, 0))
                                {
                                    (*offset, *index)
                                } else {
                                    (usize::MAX, 0)
                                }
                            }
                        };

                        (*id, offset)
                    })
                    .collect::<Vec<_>>();

                // Try to yield in the order the objects appeared in the
                // PDF.
                elements.sort_by_key(|e1| e1.1);

                let mut iter = elements.into_iter();

                iter::from_fn(move || {
                    for next in iter.by_ref() {
                        if let Some(obj) = self.get_with(next.0, &ReaderContext::new(self, false)) {
                            return Some(obj);
                        } else {
                            // Skip invalid objects.
                            continue;
                        }
                    }

                    None
                })
            }
        }
    }

    /// recto: whether the table has been rebuilt by scanning the file, which can change what a
    /// reference reads. What was read from an object before stands until then.
    pub fn is_repaired(&self) -> bool {
        match &self.0 {
            Inner::Some(r) => r.map.get().repaired,
            Inner::Dummy => false,
        }
    }

    /// recto: repairs, and says whether that's new.
    pub(crate) fn repair_if_not_repaired(&self) -> bool {
        let Inner::Some(r) = &self.0 else {
            return false;
        };
        if r.map.get().repaired {
            return false;
        }
        self.repair();
        true
    }

    pub(crate) fn repair(&self) {
        let Inner::Some(r) = &self.0 else {
            unreachable!();
        };

        let mut locked = r.map.put();
        if locked.repaired {
            return;
        }

        // recto: a repair scans the whole file. Not one that's zeros after a failed read.
        if r.data.get().ensure(0, usize::MAX) {
            let (xref_map, _) = fallback_xref_map(r.data.get(), &r.password);
            locked.xref_map = xref_map;
        }
        locked.repaired = true;
    }

    #[inline]
    pub(crate) fn needs_decryption(&self, ctx: &ReaderContext<'_>) -> bool {
        match &self.0 {
            Inner::Dummy => false,
            Inner::Some(r) => {
                if matches!(r.decryptor.as_ref(), Decryptor::None) {
                    false
                } else {
                    !ctx.in_content_stream() && !ctx.in_object_stream()
                }
            }
        }
    }

    #[inline]
    pub(crate) fn decrypt(
        &self,
        id: ObjectIdentifier,
        data: &[u8],
        target: DecryptionTarget<'_>,
    ) -> Option<Vec<u8>> {
        match &self.0 {
            Inner::Dummy => Some(data.to_vec()),
            Inner::Some(r) => r.decryptor.decrypt(id, data, target),
        }
    }

    /// Return the object with the given identifier.
    #[allow(private_bounds)]
    pub fn get<'a, T>(&'a self, id: ObjectIdentifier) -> Option<T>
    where
        T: ObjectLike<'a>,
    {
        let ctx = ReaderContext::new(self, false);
        self.get_with(id, &ctx)
    }

    /// Return the object with the given identifier.
    #[allow(private_bounds)]
    pub(crate) fn get_with<'a, T>(
        &'a self,
        id: ObjectIdentifier,
        ctx: &ReaderContext<'a>,
    ) -> Option<T>
    where
        T: ObjectLike<'a>,
    {
        object_read();
        // recto: where the object is doesn't depend on T, and this is called for dozens of Ts:
        // it's 10% of the wasm with all of it in here.
        match self.locate(id, ctx)? {
            Located::File {
                offset,
                ctx: inner,
                was_repaired,
            } => {
                let Inner::Some(repr) = &self.0 else {
                    return None;
                };
                let mut r = Reader::new(repr.data.get().as_ref());
                r.jump(offset);

                if let Some(object) = r.read_with_context::<IndirectObject<T>>(&inner) {
                    if object.id() == &id {
                        return Some(object.get());
                    }
                } else {
                    // There is a valid object at the offset, it's just not of the type the caller
                    // expected, which is fine.
                    if r.skip::<IndirectObject<Object<'_>>>(false).is_some() {
                        return None;
                    }
                };

                self.repair_and_get(id, ctx, was_repaired)
            }
            Located::InStream {
                stream,
                index,
                ctx: inner,
            } => stream.get(index, &inner),
            Located::Repair { was_repaired } => self.repair_and_get(id, ctx, was_repaired),
        }
    }

    fn locate<'a>(&'a self, id: ObjectIdentifier, ctx: &ReaderContext<'a>) -> Option<Located<'a>> {
        let Inner::Some(repr) = &self.0 else {
            return None;
        };

        // The flag must describe the map this entry came from.
        let (entry, was_repaired) = {
            let locked = repr.map.get();
            // References to undefined objects are treated as null.
            (*locked.xref_map.get(&id)?, locked.repaired)
        };

        let mut ctx = ctx.clone();
        ctx.set_obj_number(id);
        ctx.set_in_content_stream(false);
        // recto: a ranged file fetches an object on first use. Grow the
        // window until the object parses inside it (then every byte the
        // parse read was fetched); one that does not parse, up to the
        // next object's offset (a live object ends before it).
        // The first window is 4 KB, and if that has to be fetched and the
        // next object is at most `AHEAD` on, the fetch takes the rest up to
        // it along: it costs the round trip it would anyway. One that doesn't
        // parse there (a stream, mostly) is then asked for up to that offset
        // in one go, if that's at most `JUMP` away: one round trip where
        // growing took one for each fourfold step. Further, it grows fourfold
        // as before. So a gap after an object, that nothing reads, is fetched
        // only if it's under `AHEAD`, and only by a fetch that was needed.
        // (Before any Reader borrows the bytes: the fill writes into them.)
        if let EntryType::Normal(offset) = entry
            && repr.data.get().is_ranged()
        {
            const JUMP: usize = 8 << 20;
            const AHEAD: usize = 1 << 20;
            ctx.set_in_object_stream(false);
            let data = repr.data.get();
            let next = repr.starts.partition_point(|&start| start <= offset);
            let bound = repr.starts.get(next).copied().unwrap_or(data.as_ref().len());
            let reach = bound.saturating_sub(offset);
            let grow = |want: usize| {
                if want < reach && reach <= JUMP {
                    reach
                } else {
                    want.saturating_mul(4)
                }
            };
            let mut want: usize = 4096;
            let ahead = if reach <= AHEAD { offset.saturating_add(reach) } else { offset };
            loop {
                if !data.ensure_ahead(offset, offset.saturating_add(want), ahead) {
                    break;
                }
                let mut probe = Reader::new(data.as_ref());
                probe.jump(offset);
                let end = probe
                    .read_with_context::<IndirectObject<Object<'_>>>(&ctx)
                    .map(|_| probe.offset());
                match end {
                    Some(end) if end <= offset.saturating_add(want) => break,
                    // A parse over unfetched zeros can find a later
                    // `endstream` far away: grow toward it, don't jump
                    // past it (nor past the next object, if that's nearer).
                    Some(end) => want = grow(want).min(end - offset),
                    None if offset.saturating_add(want) >= bound => break,
                    None => want = grow(want).min(reach),
                }
            }
        }

        match entry {
            EntryType::Normal(offset) => {
                ctx.set_in_object_stream(false);
                Some(Located::File {
                    offset,
                    ctx,
                    was_repaired,
                })
            }
            EntryType::ObjStream(obj_stram_gen_num, index) => {
                // Generation number is implicitly 0.
                let obj_stream_id = ObjectIdentifier::new(obj_stram_gen_num, 0);

                if obj_stream_id == id || ctx.parent_chain_contains(&id) {
                    return None;
                }

                // An object stream is a stream, so it can't itself be stored in an object
                // stream (ISO 32000-2, 7.5.7).
                if !matches!(
                    repr.map.get().xref_map.get(&obj_stream_id),
                    Some(EntryType::Normal(_))
                ) {
                    return None;
                }

                ctx.parent_chain_push(id);

                let stream = repr.data.object_stream(obj_stream_id, &ctx)?;

                if stream.obj_number(index) == Some(id.obj_number) {
                    return Some(Located::InStream { stream, index, ctx });
                }

                Some(Located::Repair { was_repaired })
            }
        }
    }

    fn repair_and_get<'a, T>(
        &'a self,
        id: ObjectIdentifier,
        ctx: &ReaderContext<'a>,
        was_repaired: bool,
    ) -> Option<T>
    where
        T: ObjectLike<'a>,
    {
        // The xref table is broken, try to repair if not already repaired.
        if was_repaired {
            None
        } else {
            self.repair();

            // Now try reading again.
            self.get_with::<T>(id, ctx)
        }
    }
}

enum Located<'a> {
    File {
        offset: usize,
        ctx: ReaderContext<'a>,
        was_repaired: bool,
    },
    InStream {
        stream: &'a ObjectStream,
        index: u32,
        ctx: ReaderContext<'a>,
    },
    Repair {
        was_repaired: bool,
    },
}

/// An input that is passed to the xref constructor so that we can fully resolve
/// the PDF.
#[derive(Debug, Copy, Clone)]
pub(crate) enum XRefInput<'a> {
    /// This option is going to be uesd in 99.999% of the case. It contains the
    /// raw data of the trailer dictionary which is then going to be processed.
    TrailerDictData(&'a [u8]),
    /// In case the trailer dictionary could not be read (for example because
    /// it is cut-off), we just pass the object ID of the root dictionary
    /// in case we have found one, and try our best to build the PDF just
    /// with the information we have there. recto: and the encryption dictionary, if found.
    ///
    /// Note that this won't work if the document is encrypted, as we
    /// can't access the crypto dictionary.
    RootRef(ObjectIdentifier, Option<ObjectIdentifier>),
}

pub(crate) fn find_last_xref_pos(data: &[u8]) -> Option<usize> {
    let needle = b"startxref";
    let pos = findr_needle(data, needle)?;
    let mut finder = Reader::new(data);
    finder.jump(pos);
    finder.forward_tag(needle)?;
    finder.skip_white_spaces_and_comments();
    // recto: i64, for offsets past 2 GiB.
    finder.read_without_context::<i64>()?.try_into().ok()
}

/// A type of xref entry.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum EntryType {
    /// An indirect object that is at a specific offset in the original data.
    Normal(usize),
    /// An indirect object that is part of an object stream. First number indicates the object
    /// number of the _object stream_ (the generation number is always 0), the second number indicates
    /// the index in the object stream.
    ObjStream(u32, u32),
}

type XrefMap = FxHashMap<ObjectIdentifier, EntryType>;

/// Representation of a proper xref table.
#[derive(Debug)]
struct MapRepr {
    xref_map: XrefMap,
    repaired: bool,
}

#[derive(Debug, Copy, Clone)]
pub(crate) struct TrailerData {
    pub(crate) pages_ref: ObjectIdentifier,
    pub(crate) root_ref: ObjectIdentifier,
    pub(crate) version: Option<PdfVersion>,
}

impl TrailerData {
    pub(crate) fn dummy() -> Self {
        Self {
            pages_ref: ObjectIdentifier::new(0, 0),
            root_ref: ObjectIdentifier::new(0, 0),
            version: None,
        }
    }
}

#[derive(Debug, Clone)]
struct SomeRepr {
    data: Arc<Data>,
    map: Arc<RwLock<MapRepr>>,
    decryptor: Arc<Decryptor>,
    password: Vec<u8>,
    trailer_data: TrailerData,
    /// recto: a ranged file's object offsets, sorted. An object that does not
    /// parse is fetched up to the next one's offset at most. Empty otherwise.
    starts: Arc<Vec<usize>>,
}

#[derive(Debug, Clone)]
enum Inner {
    /// A dummy xref table that doesn't have any entries.
    Dummy,
    /// A proper xref table.
    Some(Arc<SomeRepr>),
}

#[derive(Debug)]
struct XRefEntry {
    offset: usize,
    gen_number: i32,
    used: bool,
}

impl XRefEntry {
    pub(crate) fn read(data: &[u8]) -> Option<Self> {
        #[inline(always)]
        fn parse_u32(data: &[u8]) -> Option<u32> {
            let mut accum = 0_u32;

            for byte in data {
                accum = accum.checked_mul(10)?;

                match *byte {
                    b'0'..=b'9' => accum = accum.checked_add((*byte - b'0') as u32)?,
                    _ => return None,
                }
            }

            Some(accum)
        }

        let offset = parse_u32(&data[0..10])? as usize;
        let gen_number = i32::try_from(parse_u32(&data[11..16])?).ok()?;

        let used = data[17] == b'n';

        Some(Self {
            offset,
            gen_number,
            used,
        })
    }
}

fn populate_xref_impl<'a>(data: &'a PdfData, pos: usize, xref_map: &mut XrefMap) -> Option<&'a [u8]> {
    let mut visited = BTreeSet::new();
    populate_xref_impl_inner(data, pos, xref_map, &mut visited)
}

/// Maximum number of allowed xref `Prev` pointers before we abort.
const MAX_XREF_CHAIN_DEPTH: usize = 256;

fn populate_xref_impl_inner<'a>(
    data: &'a PdfData,
    pos: usize,
    xref_map: &mut XrefMap,
    visited: &mut BTreeSet<usize>,
) -> Option<&'a [u8]> {
    if !visited.insert(pos) {
        return None;
    }

    if visited.len() > MAX_XREF_CHAIN_DEPTH {
        return None;
    }

    // recto: a ranged file fetches a section on first use. Grow the window
    // until the section (table and trailer, or stream object) reads whole.
    // (A table's check jumps over its entries, so ensure up to where it ends.)
    if data.is_ranged() {
        let mut want: usize = 64 * 1024;
        loop {
            if !data.ensure(pos, pos.saturating_add(want)) {
                break;
            }
            match section_end(data.as_ref(), pos) {
                Some(end) if end <= pos.saturating_add(want) => break,
                Some(end) => want = want.saturating_mul(4).min(end - pos),
                None if pos.saturating_add(want) >= data.as_ref().len() => break,
                None => want = want.saturating_mul(4),
            }
        }
    }

    let mut reader = Reader::new(data.as_ref());
    reader.jump(pos);
    // In case the position points to before the object number of a xref stream.
    reader.skip_white_spaces_and_comments();

    let mut r2 = reader.clone();
    if reader
        .clone()
        .read_without_context::<ObjectIdentifier>()
        .is_some()
    {
        populate_from_xref_stream(data, &mut r2, xref_map, visited)
    } else {
        populate_from_xref_table(data, &mut r2, xref_map, visited)
    }
}

/// recto: where the xref section at `pos` ends, if it parses (no side effects).
fn section_end(data: &[u8], pos: usize) -> Option<usize> {
    let mut reader = Reader::new(data);
    reader.jump(pos);
    reader.skip_white_spaces_and_comments();
    if reader
        .clone()
        .read_without_context::<ObjectIdentifier>()
        .is_some()
    {
        reader.read_with_context::<IndirectObject<Stream<'_>>>(&ReaderContext::dummy())?;
    } else {
        read_xref_table_trailer(&mut reader, &ReaderContext::dummy())?;
    }
    Some(reader.offset())
}

pub(super) struct SubsectionHeader {
    pub(super) start: u32,
    pub(super) num_entries: u32,
}

impl Readable<'_> for SubsectionHeader {
    fn read(r: &mut Reader<'_>, _: &ReaderContext<'_>) -> Option<Self> {
        r.skip_white_spaces();
        let start = r.read_without_context::<u32>()?;
        r.skip_white_spaces();
        let num_entries = r.read_without_context::<u32>()?;
        r.skip_white_spaces();

        Some(Self { start, num_entries })
    }
}

/// Populate the xref table, and return the trailer dict.
fn populate_from_xref_table<'a>(
    data: &'a PdfData,
    reader: &mut Reader<'a>,
    insert_map: &mut XrefMap,
    visited: &mut BTreeSet<usize>,
) -> Option<&'a [u8]> {
    let trailer = {
        let mut reader = reader.clone();
        read_xref_table_trailer(&mut reader, &ReaderContext::dummy())?
    };

    reader.skip_white_spaces();
    reader.forward_tag(b"xref")?;
    reader.skip_white_spaces();

    let mut max_obj = 0;

    if let Some(prev) = trailer.get::<i64>(PREV) {
        // First insert the entries from any previous xref tables.
        populate_xref_impl_inner(data, prev as usize, insert_map, visited)?;
    }

    // In hybrid files, entries in `XRefStm` should have higher priority, therefore we insert them
    // after looking at `PREV`.
    if let Some(xref_stm) = trailer.get::<i64>(XREF_STM) {
        populate_xref_impl_inner(data, xref_stm as usize, insert_map, visited)?;
    }

    while let Some(header) = reader.read_without_context::<SubsectionHeader>() {
        reader.skip_white_spaces();

        let start = header.start;
        let end = start.checked_add(header.num_entries)?;
        // recto: room for the section at once, rather than doubling and rehashing on the way; no more
        // than the entries the bytes left can hold.
        insert_map.reserve((header.num_entries as usize).min(reader.tail().map_or(0, |tail| tail.len()) / XREF_ENTRY_LEN));

        for obj_number in start..end {
            max_obj = max(max_obj, obj_number);
            let bytes = reader.read_bytes(XREF_ENTRY_LEN)?;
            let entry = XRefEntry::read(bytes)?;

            // Specification says we should ignore any object number > SIZE, but probably
            // not important?
            if entry.used {
                insert_map.insert(
                    ObjectIdentifier::new(obj_number, entry.gen_number),
                    EntryType::Normal(entry.offset),
                );
            } else {
                // recto: removed by this revision, so not left over from an older one. Only a
                // plain object: a hybrid file marks what's in its object streams as free.
                for generation in [entry.gen_number, entry.gen_number - 1] {
                    let id = ObjectIdentifier::new(obj_number, generation);
                    if matches!(insert_map.get(&id), Some(EntryType::Normal(_))) {
                        insert_map.remove(&id);
                    }
                }
            }
        }
    }

    Some(trailer.data())
}

fn populate_from_xref_stream<'a>(
    data: &'a PdfData,
    reader: &mut Reader<'a>,
    insert_map: &mut XrefMap,
    visited: &mut BTreeSet<usize>,
) -> Option<&'a [u8]> {
    let stream = reader
        .read_with_context::<IndirectObject<Stream<'_>>>(&ReaderContext::dummy())?
        .get();

    if let Some(prev) = stream.dict().get::<i64>(PREV)
        // recto: the `XRefStm` of a hybrid file usually has the same `Prev` as the table that
        // names it, already read. That is no reason to give the whole xref up for a repair, which
        // takes the first copy of an object where the xref would take the last.
        && !visited.contains(&(prev as usize))
    {
        // First insert the entries from any previous xref tables.
        let _ = populate_xref_impl_inner(data, prev as usize, insert_map, visited)?;
    }

    let size = stream.dict().get::<u32>(SIZE)?;

    let [f1_len, f2_len, f3_len] = stream.dict().get::<[u8; 3]>(W)?;

    if f2_len == 0 || f2_len > size_of::<u64>() as u8 {
        return None;
    }

    let xref_data = stream.decoded_data().ok()?;
    let mut xref_reader = Reader::new(xref_data.as_ref());

    if let Some(arr) = stream.dict().get::<Array<'_>>(INDEX) {
        let iter = arr.iter::<(u32, u32)>();

        for (start, num_elements) in iter {
            xref_stream_subsection(
                &mut xref_reader,
                start,
                num_elements,
                f1_len,
                f2_len,
                f3_len,
                insert_map,
            )?;
        }
    } else {
        xref_stream_subsection(
            &mut xref_reader,
            0,
            size,
            f1_len,
            f2_len,
            f3_len,
            insert_map,
        )?;
    }

    Some(stream.dict().data())
}

fn xref_stream_num(data: &[u8]) -> Option<u32> {
    Some(match data.len() {
        0 => return None,
        1 => u8::from_be(data[0]) as u32,
        2 => u16::from_be_bytes(data[0..2].try_into().ok()?) as u32,
        3 => u32::from_be_bytes([0, data[0], data[1], data[2]]),
        4 => u32::from_be_bytes(data[0..4].try_into().ok()?),
        8 => {
            if let Ok(num) = u32::try_from(u64::from_be_bytes(data[0..8].try_into().ok()?)) {
                return Some(num);
            } else {
                return None;
            }
        }
        _n => {
            return None;
        }
    })
}

fn xref_stream_subsection<'a>(
    xref_reader: &mut Reader<'a>,
    start: u32,
    num_elements: u32,
    f1_len: u8,
    f2_len: u8,
    f3_len: u8,
    insert_map: &mut XrefMap,
) -> Option<()> {
    for i in 0..num_elements {
        let f_type = if f1_len == 0 {
            1
        } else {
            // We assume a length of 1.
            xref_reader.read_bytes(1)?[0]
        };

        let obj_number = start.checked_add(i)?;

        match f_type {
            // recto: removed by this revision, so not left over from an older one.
            0 => {
                xref_reader.skip_bytes(f2_len as usize)?;
                let generation = if f3_len > 0 {
                    xref_stream_num(xref_reader.read_bytes(f3_len as usize)?)?
                } else {
                    0
                };
                let generation = generation.min(i32::MAX as u32) as i32;
                insert_map.remove(&ObjectIdentifier::new(obj_number, generation));
                insert_map.remove(&ObjectIdentifier::new(obj_number, generation - 1));
            }
            1 => {
                let offset = if f2_len > 0 {
                    let data = xref_reader.read_bytes(f2_len as usize)?;
                    xref_stream_num(data)?
                } else {
                    0
                };

                let gen_number = if f3_len > 0 {
                    let data = xref_reader.read_bytes(f3_len as usize)?;
                    xref_stream_num(data)?
                } else {
                    0
                };

                insert_map.insert(
                    ObjectIdentifier::new(obj_number, gen_number as i32),
                    EntryType::Normal(offset as usize),
                );
            }
            2 => {
                let obj_stream_number = {
                    let data = xref_reader.read_bytes(f2_len as usize)?;
                    xref_stream_num(data)?
                };
                let gen_number = 0;
                let index = if f3_len > 0 {
                    let data = xref_reader.read_bytes(f3_len as usize)?;
                    xref_stream_num(data)?
                } else {
                    0
                };

                insert_map.insert(
                    ObjectIdentifier::new(obj_number, gen_number),
                    EntryType::ObjStream(obj_stream_number, index),
                );
            }
            _ => {
                return None;
            }
        }
    }

    Some(())
}

fn read_xref_table_trailer<'a>(
    reader: &mut Reader<'a>,
    ctx: &ReaderContext<'a>,
) -> Option<Dict<'a>> {
    reader.skip_white_spaces();
    reader.forward_tag(b"xref")?;
    reader.skip_white_spaces();

    while let Some(header) = reader.read_without_context::<SubsectionHeader>() {
        let len = XREF_ENTRY_LEN.checked_mul(header.num_entries as usize)?;
        reader.jump(reader.offset().checked_add(len)?);
    }

    reader.skip_white_spaces();
    reader.forward_tag(b"trailer")?;
    reader.skip_white_spaces();

    reader.read_with_context::<Dict<'_>>(ctx)
}

fn get_decryptor(trailer_dict: &Dict<'_>, password: &[u8]) -> Result<Decryptor, XRefError> {
    if let Some(encryption_dict) = trailer_dict.get::<Dict<'_>>(ENCRYPT) {
        let id = if let Some(id) = trailer_dict
            .get::<Array<'_>>(ID)
            .and_then(|a| a.flex_iter().next::<object::String<'_>>())
        {
            id.to_vec()
        } else {
            // Assume an empty ID entry.
            vec![]
        };

        get(&encryption_dict, &id, password).map_err(XRefError::Encryption)
    } else {
        Ok(Decryptor::None)
    }
}

pub(crate) struct ObjectStream {
    data: Vec<u8>,
    offsets: Vec<(u32, Option<usize>)>,
}

impl ObjectStream {
    pub(crate) fn new(stream: &Stream<'_>) -> Option<Self> {
        let data = stream.decoded_data().ok()?.into_owned();
        let offsets = Self::read_offsets(stream, &data).unwrap_or_default();

        Some(Self { data, offsets })
    }

    fn read_offsets(stream: &Stream<'_>, data: &[u8]) -> Option<Vec<(u32, Option<usize>)>> {
        let num_objects = stream.dict().get::<usize>(N)?;
        let first_offset = stream.dict().get::<usize>(FIRST)?;

        let mut r = Reader::new(data);

        let mut offsets = vec![];
        let mut last_offset = None;

        for _ in 0..num_objects {
            r.skip_white_spaces_and_comments();
            // Skip object number
            let obj_num = r.read_without_context::<u32>()?;
            r.skip_white_spaces_and_comments();
            let relative_offset = r.read_without_context::<usize>()?;
            let offset = first_offset + relative_offset;

            // Offsets must increase, otherwise any number of objects could share one member.
            // The start of the previous member excludes the white space before it, so that
            // offsets into that white space can't share it either.
            if offset >= data.len() || last_offset.is_some_and(|last| offset <= last) {
                offsets.push((obj_num, None));
            } else {
                let mut member = Reader::new(data);
                member.jump(offset);
                member.skip_white_spaces_and_comments();
                last_offset = Some(member.offset());
                offsets.push((obj_num, Some(member.offset())));
            }
        }

        Some(offsets)
    }

    fn obj_number(&self, index: u32) -> Option<u32> {
        Some(self.offsets.get(index as usize)?.0)
    }

    fn get<'a, T>(&'a self, index: u32, ctx: &ReaderContext<'a>) -> Option<T>
    where
        T: ObjectLike<'a>,
    {
        let offset = self.offsets.get(index as usize)?.1?;
        let mut r = Reader::new(&self.data);
        r.jump(offset);

        let mut ctx = ctx.clone();
        ctx.set_in_object_stream(true);

        r.read_with_context::<T>(&ctx)
    }
}

std::thread_local! {
    static OBJECT_READS: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
}

/// recto: the objects this thread has asked the cross-reference table for, for tests that count a
/// call's work.
#[doc(hidden)]
pub fn object_reads() -> usize {
    OBJECT_READS.with(|n| n.get())
}

#[inline]
fn object_read() {
    OBJECT_READS.with(|n| n.set(n.get() + 1));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circular_prev_chain() {
        let mut pdf = b"%PDF-1.0\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".to_vec();
        let expected_xref_pos = pdf.len();
        pdf.extend_from_slice(
            format!(
                "xref\n\
                 0 1\n\
                 0000000000 65535 f \r\n\
                 trailer\n<< /Size 1 /Root 1 0 R /Prev {expected_xref_pos} >>\n\
                 startxref\n{expected_xref_pos}\n%%EOF"
            )
            .as_bytes(),
        );

        let mut xref_map = FxHashMap::default();
        let xref_pos = find_last_xref_pos(pdf.as_ref()).unwrap();
        let _result = populate_xref_impl(pdf.as_ref(), xref_pos, &mut xref_map);
    }

    #[test]
    fn find_last_xref_uses_last_startxref() {
        let pdf = b"%PDF-1.0\nstartxref\n5\n%%EOF\nstartxref\n42\n%%EOF";
        assert_eq!(find_last_xref_pos(pdf), Some(42));
    }

    #[test]
    fn xref_table_trailer_rejects_overflowing_entry_skip() {
        let data = b"xref\n0 999999999999999999999\ntrailer\n<<>>";
        let mut reader = Reader::new(data);
        assert!(read_xref_table_trailer(&mut reader, &ReaderContext::dummy()).is_none());
    }

    #[test]
    fn xref_stream_subsection_rejects_overflowing_object_number() {
        let data = [1, 0, 1, 0];
        let mut xref_map = FxHashMap::default();
        let result =
            xref_stream_subsection(&mut Reader::new(&data), u32::MAX, 2, 1, 1, 0, &mut xref_map);
        assert!(result.is_none());
        assert!(xref_map.contains_key(&ObjectIdentifier::new(u32::MAX, 0)));
    }
}
