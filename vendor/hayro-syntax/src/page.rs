//! Reading the pages of a PDF document.

use crate::content::{TypedIter, UntypedIter};
use crate::object::Array;
use crate::object::Dict;
use crate::object::Name;
use crate::object::Rect;
use crate::object::Stream;
use crate::object::array::ArrayIter;
use crate::object::dict::keys::*;
use crate::object::{MaybeRef, Object};
use crate::reader::ReaderContext;
use crate::object::ObjectIdentifier;
use crate::sync::{FxHashMap, FxHashSet, Mutex, MutexExt, OnceLock};
use crate::transform::Transform;
use crate::util::FloatExt;
use crate::xref::XRef;
use alloc::vec;
use alloc::vec::Vec;
use core::ops::Deref;

/// Attributes that can be inherited.
#[derive(Debug, Clone)]
struct PagesContext<'a> {
    media_box: Option<Rect>,
    crop_box: Option<Rect>,
    rotate: Option<i32>,
    resources: Dict<'a>,
}

impl PagesContext<'_> {
    fn new() -> Self {
        Self {
            media_box: None,
            crop_box: None,
            rotate: None,
            resources: Dict::empty(),
        }
    }
}

/// A structure holding the pages of a PDF document.
pub struct Pages<'a> {
    pages: Vec<Page<'a>>,
    // recto: the tree's kids in walk order, each built into a page on first use.
    lazy: Option<LazyPages<'a>>,
    xref: &'a XRef,
}

/// recto: pages built on first use. A whole file is walked at open, so `/Count` can't change which
/// page is which. A ranged file can't afford that: it descends by `/Count` (see `Descent`), and
/// takes the walk from the first thing that doesn't add up.
struct LazyPages<'a> {
    reader: ReaderContext<'a>,
    built: Vec<OnceLock<Option<Page<'a>>>>,
    walked: Mutex<Walked<'a>>,
    eager: OnceLock<Vec<Page<'a>>>,
}

struct Walked<'a> {
    /// A ranged file's way to a page, until it meets something that doesn't add up.
    descent: Option<Descent<'a>>,
    walk: PageWalk<'a>,
    /// Pages found so far, and which entry of `walk.contexts` each inherits from.
    found: Vec<(Dict<'a>, u32)>,
}

impl<'a> Walked<'a> {
    fn walk_to(&mut self, index: usize, reader: &ReaderContext<'a>) -> Option<&(Dict<'a>, u32)> {
        while self.found.len() <= index {
            let page = self.walk.next(reader)?;
            self.found.push(page);
        }
        self.found.get(index)
    }
}

/// recto: past this many kids, a node with as many kids as its `/Count` is taken to hold one page
/// each without fetching those before the one asked for. Narrower ones are read in order, which is what
/// deleting pages leaves true: nodes of a few kids, some now empty, adding up by coincidence.
const FLAT_ABOVE_KIDS: usize = 32;

/// recto: page `i` of a ranged file, found by each kid's `/Count` so that only the nodes on the way
/// to it are fetched. pdf.js fetches every leaf kid before a page and pdfium walks in order, so the
/// flat shortcut is recto's alone. Everything on the path is checked, and `None` means something
/// there doesn't add up. What isn't on it can't be checked: a node before it whose `/Count` is wrong
/// moves the page unseen, and so does a node among the kids a wide flat node jumps over.
struct Descent<'a> {
    root: Dict<'a>,
    /// What's known of each node by its dict's address, so reading every page stays linear.
    nodes: FxHashMap<usize, NodeKids<'a>>,
}

enum NodeKids<'a> {
    /// Wide, with as many kids as `/Count`, so each is taken for a page: kid `i` is read directly.
    OnePageEach(Vec<MaybeRef<Object<'a>>>),
    /// Kids read in order as far as asked: where each starts, itself, and where they end so far.
    InOrder {
        rest: ArrayIter<'a>,
        seen: Vec<(usize, Dict<'a>)>,
        end: usize,
    },
}

fn is_node(dict: &Dict<'_>) -> bool {
    dict.get::<Name<'_>>(TYPE).as_deref() == Some(PAGES)
}

impl<'a> Descent<'a> {
    fn find(
        &mut self,
        mut index: usize,
        reader: &ReaderContext<'a>,
    ) -> Option<(Dict<'a>, PagesContext<'a>)> {
        let resolve = |kid: MaybeRef<Object<'a>>| match kid {
            MaybeRef::Ref(id) => reader.xref().get_with::<Dict<'a>>(id.into(), reader),
            MaybeRef::NotRef(object) => object.into_dict(),
        };
        let mut node = self.root.clone();
        let mut context = inherit(&node, PagesContext::new());
        let mut path: FxHashSet<usize> = FxHashSet::default();
        loop {
            let key = node.data().as_ptr() as usize;
            if !path.insert(key) {
                return None;
            }
            if !self.nodes.contains_key(&key) {
                let array = node.get::<Array<'a>>(KIDS)?;
                let length = array.raw_iter().count();
                let kids = if length > FLAT_ABOVE_KIDS && Some(length) == node.get::<usize>(COUNT) {
                    NodeKids::OnePageEach(array.raw_iter().collect())
                } else {
                    NodeKids::InOrder {
                        rest: array.raw_iter(),
                        seen: vec![],
                        end: 0,
                    }
                };
                self.nodes.insert(key, kids);
            }
            let kids = self.nodes.get_mut(&key)?;
            let kid = match kids {
                NodeKids::OnePageEach(kids) => {
                    let kid = match kids.get(index)? {
                        MaybeRef::Ref(id) => reader.xref().get_with::<Dict<'a>>((*id).into(), reader),
                        MaybeRef::NotRef(object) => object.clone().into_dict(),
                    }?;
                    // A node here means they aren't all pages, so position says nothing.
                    if is_node(&kid) {
                        return None;
                    }
                    return Some((kid, context));
                }
                NodeKids::InOrder { rest, seen, end } => {
                    while *end <= index {
                        let kid = resolve(rest.next()?)?;
                        let span = if is_node(&kid) { kid.get::<usize>(COUNT)? } else { 1 };
                        seen.push((*end, kid));
                        *end = end.checked_add(span)?;
                    }
                    let at = seen.partition_point(|(start, _)| *start <= index) - 1;
                    let (start, kid) = &seen[at];
                    index -= start;
                    kid.clone()
                }
            };
            if !is_node(&kid) {
                return Some((kid, context));
            }
            context = inherit(&kid, context);
            node = kid;
        }
    }
}

/// recto: past this many kids beyond the file's objects, the walk stops. A tree that repeats no
/// node visits each object once, so only one built to multiply gets here: nodes of repeated nodes
/// double with each level.
const MAX_REPEATED_KIDS: usize = 1 << 18;

/// recto: the page tree's pages in order, depth first, one at a time. A node that's its own
/// ancestor is skipped. Any other repeat counts again, as it does in other readers.
struct PageWalk<'a> {
    stack: Vec<WalkFrame<'a>>,
    /// The nodes on the way to the current one.
    path: FxHashSet<ObjectIdentifier>,
    /// What pages inherit, one entry per node that changes it.
    contexts: Vec<PagesContext<'a>>,
    kids_left: usize,
    /// recto: read once each, or a large page repeated in `/Kids` is parsed every time: 2^18 times.
    read: FxHashMap<ObjectIdentifier, Option<Dict<'a>>>,
    /// A kid was missing or broken, so the tree isn't all the file's pages.
    lost_kid: bool,
}

struct WalkFrame<'a> {
    kids: ArrayIter<'a>,
    context: u32,
    id: Option<ObjectIdentifier>,
}

impl<'a> PageWalk<'a> {
    fn new(root: &Dict<'a>, objects: usize) -> Option<Self> {
        let mut walk = Self {
            stack: vec![],
            path: FxHashSet::default(),
            contexts: vec![PagesContext::new()],
            kids_left: objects.saturating_add(MAX_REPEATED_KIDS),
            read: FxHashMap::default(),
            lost_kid: false,
        };
        walk.enter(root, root.obj_id(), 0)?;
        Some(walk)
    }

    fn enter(
        &mut self,
        dict: &Dict<'a>,
        id: Option<ObjectIdentifier>,
        parent: u32,
    ) -> Option<()> {
        let kids = dict.get::<Array<'a>>(KIDS)?.raw_iter();
        let context = if [MEDIA_BOX, CROP_BOX, ROTATE, RESOURCES]
            .iter()
            .any(|key| dict.contains_key(key))
        {
            let inherited = self.contexts[parent as usize].clone();
            self.contexts.push(inherit(dict, inherited));
            (self.contexts.len() - 1) as u32
        } else {
            parent
        };
        if let Some(id) = id {
            self.path.insert(id);
        }
        self.stack.push(WalkFrame { kids, context, id });
        Some(())
    }

    fn next(&mut self, reader: &ReaderContext<'a>) -> Option<(Dict<'a>, u32)> {
        loop {
            let frame = self.stack.last_mut()?;
            let context = frame.context;
            let Some(kid) = frame.kids.next() else {
                if let Some(id) = frame.id {
                    self.path.remove(&id);
                }
                self.stack.pop();
                continue;
            };
            if self.kids_left == 0 {
                self.stack.clear();
                return None;
            }
            self.kids_left -= 1;
            let (id, dict) = match kid {
                MaybeRef::Ref(id) => {
                    let id: ObjectIdentifier = id.into();
                    if self.path.contains(&id) {
                        continue;
                    }
                    let dict = self
                        .read
                        .entry(id)
                        .or_insert_with(|| reader.xref().get_with::<Dict<'a>>(id, reader))
                        .clone();
                    (Some(id), dict)
                }
                MaybeRef::NotRef(object) => (None, object.into_dict()),
            };
            let Some(dict) = dict else {
                self.lost_kid = true;
                continue;
            };
            match dict.get::<Name<'_>>(TYPE).as_deref() {
                Some(PAGES) => {
                    self.lost_kid |= self.enter(&dict, id, context).is_none();
                }
                // Let's be lenient and assume it's a `Page` in case it's `None` or something else
                // (see corpus test case 0083781).
                _ => return Some((dict, context)),
            }
        }
    }
}

/// recto: a ranged file's page count, from the root's `/Count` if the tree's nodes add up to it.
/// The nodes are read, and pages aren't: a node with as many kids as its `/Count` passes unread.
fn counts_add_up<'a>(
    dict: &Dict<'a>,
    ctx: &ReaderContext<'a>,
    visited: &mut FxHashSet<ObjectIdentifier>,
    depth: usize,
) -> Option<usize> {
    // Not the walk's own stack: a chain of nodes mustn't overflow this one.
    if depth == MAX_CHECKED_DEPTH {
        return None;
    }
    let count = dict.get::<usize>(COUNT)?;
    let kids = dict.get::<Array<'a>>(KIDS)?;
    if kids.raw_iter().count() == count {
        return Some(count);
    }
    let mut sum: usize = 0;
    for kid in kids.raw_iter() {
        let kid = match kid {
            MaybeRef::Ref(id) => {
                if !visited.insert(id.into()) {
                    return None;
                }
                ctx.xref().get_with::<Dict<'a>>(id.into(), ctx)?
            }
            MaybeRef::NotRef(object) => object.into_dict()?,
        };
        sum = sum.checked_add(if kid.get::<Name<'_>>(TYPE).as_deref() == Some(PAGES) {
            counts_add_up(&kid, ctx, visited, depth + 1)?
        } else {
            1
        })?;
    }
    (sum == count).then_some(count)
}

const MAX_CHECKED_DEPTH: usize = 64;

impl<'a> Pages<'a> {
    /// Create a new `Pages` object.
    pub(crate) fn new(
        pages_dict: &Dict<'a>,
        ctx: &ReaderContext<'a>,
        xref: &'a XRef,
    ) -> Option<Self> {
        let mut walked = Walked {
            descent: None,
            walk: PageWalk::new(pages_dict, xref.len())?,
            found: vec![],
        };
        // recto: a ranged file takes the root's `/Count` when the nodes agree and it's no more
        // than the file's objects. Anything else is walked now, like a whole file.
        let trusted = pages_dict.get::<usize>(COUNT).filter(|count| {
            xref.is_ranged()
                && *count <= xref.len()
                && counts_add_up(pages_dict, ctx, &mut FxHashSet::default(), 0) == Some(*count)
        });
        let count = if let Some(count) = trusted {
            walked.descent = Some(Descent {
                root: pages_dict.clone(),
                nodes: FxHashMap::default(),
            });
            count
        } else {
            walked.walk_to(usize::MAX, ctx);
            walked.found.shrink_to_fit();
            walked.found.len()
        };
        Some(Self {
            pages: vec![],
            lazy: Some(LazyPages {
                reader: ctx.clone(),
                built: (0..count).map(|_| OnceLock::new()).collect(),
                walked: Mutex::new(walked),
                eager: OnceLock::new(),
            }),
            xref,
        })
    }

    /// recto: the number of pages (for a ranged file, the root's `/Count` if the tree's nodes agree).
    pub fn len(&self) -> usize {
        match &self.lazy {
            Some(lazy) => lazy.built.len(),
            None => self.pages.len(),
        }
    }

    /// recto: whether a kid was lost and no pages were found: the tree is damaged, where one that's
    /// honestly empty, or a document with no pages, isn't.
    pub(crate) fn lost_everything(&self) -> bool {
        self.is_empty() && self.lazy.as_ref().is_some_and(|lazy| lazy.walked.get().walk.lost_kid)
    }

    /// recto: whether there are no pages.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// recto: page `index`, built on first use.
    pub fn get(&self, index: usize) -> Option<&Page<'a>> {
        let Some(lazy) = &self.lazy else {
            return self.pages.get(index);
        };
        if let Some(pages) = lazy.eager.get() {
            return pages.get(index);
        }
        lazy.built
            .get(index)?
            .get_or_init(|| {
                let mut walked = lazy.walked.get();
                if let Some(descent) = &mut walked.descent {
                    if let Some((dict, context)) = descent.find(index, &lazy.reader) {
                        return Page::new(&dict, &context, &lazy.reader, false);
                    }
                    walked.descent = None;
                }
                let (dict, context) = walked.walk_to(index, &lazy.reader)?.clone();
                Page::new(&dict, &walked.walk.contexts[context as usize], &lazy.reader, false)
            })
            .as_ref()
    }

    /// Create a new `Pages` object by bruteforce-searching.
    ///
    /// Of course this could result in the order of pages being messed up, but
    /// this is still better than nothing.
    pub(crate) fn new_brute_force(ctx: &ReaderContext<'a>, xref: &'a XRef) -> Option<Self> {
        let mut pages = vec![];

        for object in xref.objects() {
            if let Some(dict) = object.into_dict()
                && let Some(page) = Page::new(&dict, &PagesContext::new(), ctx, true)
            {
                pages.push(page);
            }
        }

        if pages.is_empty() {
            return None;
        }

        Some(Self {
            pages,
            lazy: None,
            xref,
        })
    }

    /// Return the xref table (of the document the pages belong to).   
    pub fn xref(&self) -> &'a XRef {
        self.xref
    }
}

impl<'a> Deref for Pages<'a> {
    type Target = [Page<'a>];

    fn deref(&self) -> &Self::Target {
        match &self.lazy {
            Some(lazy) => lazy.eager.get_or_init(|| {
                let mut walked = lazy.walked.get();
                walked.walk_to(usize::MAX, &lazy.reader);
                let walked = &*walked;
                walked
                    .found
                    .iter()
                    .filter_map(|(dict, context)| {
                        Page::new(dict, &walked.walk.contexts[*context as usize], &lazy.reader, false)
                    })
                    .collect()
            }),
            None => &self.pages,
        }
    }
}

fn inherit<'a>(dict: &Dict<'a>, mut ctx: PagesContext<'a>) -> PagesContext<'a> {
    ctx.media_box = dict.get::<Rect>(MEDIA_BOX).or(ctx.media_box);
    ctx.crop_box = dict.get::<Rect>(CROP_BOX).or(ctx.crop_box);
    ctx.rotate = dict.get::<i32>(ROTATE).or(ctx.rotate);
    if let Some(resources) = dict.get::<Dict<'a>>(RESOURCES) {
        ctx.resources = resources;
    }
    ctx
}

/// The rotation of the page.
#[derive(Debug, Copy, Clone)]
pub enum Rotation {
    /// No rotation.
    None,
    /// A rotation of 90 degrees.
    Horizontal,
    /// A rotation of 180 degrees.
    Flipped,
    /// A rotation of 270 degrees.
    FlippedHorizontal,
}

/// A PDF page.
pub struct Page<'a> {
    inner: Dict<'a>,
    media_box: Rect,
    crop_box: Rect,
    rotation: Rotation,
    page_streams: OnceLock<Option<Vec<u8>>>,
    resources: Resources<'a>,
    ctx: ReaderContext<'a>,
}

impl<'a> Page<'a> {
    fn new(
        dict: &Dict<'a>,
        ctx: &PagesContext<'a>,
        reader_ctx: &ReaderContext<'a>,
        brute_force: bool,
    ) -> Option<Self> {
        // In general, pages without content are allowed, but in case we are brute-forcing
        // we ignore them.
        if brute_force && !dict.contains_key(CONTENTS) {
            return None;
        }

        // recto: a box with no area is no box. The first valid one applies, then Letter, as in
        // pdf.js and pdfium.
        let media_box = dict
            .get::<Rect>(MEDIA_BOX)
            .filter(has_area)
            .or(ctx.media_box.filter(has_area))
            .unwrap_or(LETTER);

        let crop_box = dict
            .get::<Rect>(CROP_BOX)
            .or(ctx.crop_box)
            .unwrap_or(media_box);

        let rotation = match dict
            .get::<i32>(ROTATE)
            .or(ctx.rotate)
            .unwrap_or(0)
            .rem_euclid(360)
        {
            0 => Rotation::None,
            90 => Rotation::Horizontal,
            180 => Rotation::Flipped,
            270 => Rotation::FlippedHorizontal,
            _ => Rotation::None,
        };

        let resources = Resources::new(
            dict.get::<Dict<'a>>(RESOURCES)
                .unwrap_or_else(|| ctx.resources.clone()),
        );

        Some(Self {
            inner: dict.clone(),
            media_box,
            crop_box,
            rotation,
            page_streams: OnceLock::new(),
            resources,
            ctx: reader_ctx.clone(),
        })
    }

    fn operations_impl(&self) -> Option<UntypedIter<'_>> {
        let stream = self.page_stream()?;
        let iter = UntypedIter::new(stream);

        Some(iter)
    }

    /// Return the decoded content stream of the page.
    pub fn page_stream(&self) -> Option<&[u8]> {
        let convert_single = |s: Stream<'_>| {
            let data = s.decoded_data().ok()?;
            Some(data.into_owned())
        };

        self.page_streams
            .get_or_init(|| {
                if let Some(stream) = self.inner.get::<Stream<'_>>(CONTENTS) {
                    convert_single(stream)
                } else if let Some(array) = self.inner.get::<Array<'_>>(CONTENTS) {
                    let streams = array
                        .raw_iter()
                        .filter_map(|item| item.resolve(&self.ctx)?.into_stream())
                        .flat_map(convert_single);

                    let mut collected = vec![];

                    for stream in streams {
                        collected.extend(stream);
                        // Streams must have at least one whitespace in-between.
                        collected.push(b' ');
                    }

                    Some(collected)
                } else {
                    None
                }
            })
            .as_ref()
            .map(|d| d.as_slice())
    }

    /// Get the resources of the page.
    pub fn resources(&self) -> &Resources<'a> {
        &self.resources
    }

    /// Get the media box of the page.
    pub fn media_box(&self) -> Rect {
        self.media_box
    }

    /// Get the rotation of the page.
    pub fn rotation(&self) -> Rotation {
        self.rotation
    }

    /// Get the crop box of the page.
    pub fn crop_box(&self) -> Rect {
        self.crop_box
    }

    /// Return the intersection of crop box and media box.
    pub fn intersected_crop_box(&self) -> Rect {
        self.crop_box().intersect(self.media_box())
    }

    /// recto: the page's annotations, each read once. One listed thousands of times would be parsed
    /// thousands of times, however large.
    pub fn annotations(&self) -> Vec<Dict<'a>> {
        let Some(annotations) = self.raw().get::<Array<'a>>(ANNOTS) else {
            return Vec::new();
        };
        let mut seen = FxHashSet::default();
        annotations
            .raw_iter()
            .filter_map(|annotation| match annotation {
                MaybeRef::Ref(id) => {
                    let id: ObjectIdentifier = id.into();
                    seen.insert(id).then(|| self.xref().get_with::<Dict<'a>>(id, &self.ctx))?
                }
                MaybeRef::NotRef(object) => object.into_dict(),
            })
            .collect()
    }

    /// Return the base dimensions of the page (same as `intersected_crop_box`, but with special
    /// handling applied for zero-area pages).
    pub fn base_dimensions(&self) -> (f32, f32) {
        let crop_box = self.intersected_crop_box();

        if (crop_box.width() as f32).is_nearly_zero() || (crop_box.height() as f32).is_nearly_zero()
        {
            (A4.width() as f32, A4.height() as f32)
        } else {
            (
                crop_box.width().max(1.0) as f32,
                crop_box.height().max(1.0) as f32,
            )
        }
    }

    /// Return the with and height of the page that should be assumed when rendering the page.
    ///
    /// Depending on the document, it is either based on the media box or the crop box
    /// of the page. In addition to that, it also takes the rotation of the page into account.
    pub fn render_dimensions(&self) -> (f32, f32) {
        let (mut base_width, mut base_height) = self.base_dimensions();

        if matches!(
            self.rotation(),
            Rotation::Horizontal | Rotation::FlippedHorizontal
        ) {
            core::mem::swap(&mut base_width, &mut base_height);
        }

        (base_width, base_height)
    }

    /// Return an untyped iterator over the operators of the page's content stream.
    pub fn operations(&self) -> UntypedIter<'_> {
        self.operations_impl().unwrap_or(UntypedIter::empty())
    }

    /// Get the raw dictionary of the page.
    pub fn raw(&self) -> &Dict<'a> {
        &self.inner
    }

    /// Get the xref table (of the document the page belongs to).
    pub fn xref(&self) -> &'a XRef {
        self.ctx.xref()
    }

    /// Return a typed iterator over the operators of the page's content stream.
    pub fn typed_operations(&self) -> TypedIter<'_> {
        TypedIter::from_untyped(self.operations())
    }

    /// Return the initial transform that should be applied when rendering.
    ///
    /// This accounts for the mismatch between PDF's y-up and most renderers'
    /// y-down coordinate system, the rotation of the page and the offset of
    /// the crop box.
    pub fn initial_transform(&self, invert_y: bool) -> Transform {
        let crop_box = self.intersected_crop_box();
        let (_, base_height) = self.base_dimensions();
        let (width, height) = self.render_dimensions();

        let horizontal_t = Transform::ROTATE_CW_90 * Transform::translate((0.0, -width as f64));
        let flipped_horizontal_t =
            Transform::translate((0.0, height as f64)) * Transform::ROTATE_CCW_90;

        let rotation_transform = match self.rotation() {
            Rotation::None => Transform::IDENTITY,
            Rotation::Horizontal => {
                if invert_y {
                    horizontal_t
                } else {
                    flipped_horizontal_t
                }
            }
            Rotation::Flipped => {
                Transform::scale(-1.0) * Transform::translate((-width as f64, -height as f64))
            }
            Rotation::FlippedHorizontal => {
                if invert_y {
                    flipped_horizontal_t
                } else {
                    horizontal_t
                }
            }
        };

        let inversion_transform = if invert_y {
            Transform::new([1.0, 0.0, 0.0, -1.0, 0.0, base_height as f64])
        } else {
            Transform::IDENTITY
        };

        rotation_transform
            * inversion_transform
            * Transform::translate((-crop_box.x0, -crop_box.y0))
    }
}

/// A structure keeping track of the resources of a page.
#[derive(Clone, Debug)]
pub struct Resources<'a> {
    /// The raw dictionary of external graphics states.
    pub ext_g_states: Dict<'a>,
    /// The raw dictionary of fonts.
    pub fonts: Dict<'a>,
    /// The raw dictionary of properties.
    pub properties: Dict<'a>,
    /// The raw dictionary of color spaces.
    pub color_spaces: Dict<'a>,
    /// The raw dictionary of x objects.
    pub x_objects: Dict<'a>,
    /// The raw dictionary of patterns.
    pub patterns: Dict<'a>,
    /// The raw dictionary of shadings.
    pub shadings: Dict<'a>,
}

impl<'a> Resources<'a> {
    /// Create a new `Resources` object.
    pub fn new(resources: Dict<'a>) -> Self {
        let ext_g_states = resources.get::<Dict<'_>>(EXT_G_STATE).unwrap_or_default();
        let fonts = resources.get::<Dict<'_>>(FONT).unwrap_or_default();
        let color_spaces = resources.get::<Dict<'_>>(COLORSPACE).unwrap_or_default();
        let x_objects = resources.get::<Dict<'_>>(XOBJECT).unwrap_or_default();
        let patterns = resources.get::<Dict<'_>>(PATTERN).unwrap_or_default();
        let shadings = resources.get::<Dict<'_>>(SHADING).unwrap_or_default();
        let properties = resources.get::<Dict<'_>>(PROPERTIES).unwrap_or_default();

        Self {
            ext_g_states,
            fonts,
            color_spaces,
            properties,
            x_objects,
            patterns,
            shadings,
        }
    }

    /// Get an external graphics state by name.
    pub fn get_ext_g_state(&self, name: &Name<'_>) -> Option<Dict<'a>> {
        self.ext_g_states.get(name)
    }

    /// Get a color space by name.
    pub fn get_color_space(&self, name: &Name<'_>) -> Option<Object<'a>> {
        self.color_spaces.get(name)
    }

    /// Get a font by name.
    pub fn get_font(&self, name: &Name<'_>) -> Option<Dict<'a>> {
        self.fonts.get(name)
    }

    /// Get a pattern by name.
    pub fn get_pattern(&self, name: &Name<'_>) -> Option<Object<'a>> {
        self.patterns.get(name)
    }

    /// Get an x object by name.
    pub fn get_x_object(&self, name: &Name<'_>) -> Option<Stream<'a>> {
        self.x_objects.get(name)
    }

    /// Get a shading by name.
    pub fn get_shading(&self, name: &Name<'_>) -> Option<Object<'a>> {
        self.shadings.get(name)
    }
}

// <https://github.com/apache/pdfbox/blob/a53a70db16ea3133994120bcf1e216b9e760c05b/pdfbox/src/main/java/org/apache/pdfbox/pdmodel/common/PDRectangle.java#L38>
const POINTS_PER_INCH: f64 = 72.0;
const POINTS_PER_MM: f64 = 1.0 / (10.0 * 2.54) * POINTS_PER_INCH;

/// recto: the size a page with no usable `/MediaBox` gets.
const LETTER: Rect = Rect {
    x0: 0.0,
    y0: 0.0,
    x1: 8.5 * POINTS_PER_INCH,
    y1: 11.0 * POINTS_PER_INCH,
};

fn has_area(rect: &Rect) -> bool {
    !(rect.width() as f32).is_nearly_zero() && !(rect.height() as f32).is_nearly_zero()
}

/// The dimension of an A4 page.
pub const A4: Rect = Rect {
    x0: 0.0,
    y0: 0.0,
    x1: 210.0 * POINTS_PER_MM,
    y1: 297.0 * POINTS_PER_MM,
};

pub(crate) mod cached {
    use crate::page::Pages;
    use crate::reader::ReaderContext;
    use crate::xref::XRef;
    use core::ops::Deref;

    // Keep in sync with the implementation in `sync`. We duplicate it here
    // to make it more visible since we have unsafe code here.
    #[cfg(feature = "std")]
    pub(crate) use std::sync::Arc;

    #[cfg(not(feature = "std"))]
    pub(crate) use alloc::rc::Rc as Arc;

    pub(crate) struct CachedPages {
        pages: Pages<'static>,
        // NOTE: `pages` references the data in `xref`, so it's important that `xref`
        // appears after `pages` in the struct definition to ensure correct drop order.
        _xref: Arc<XRef>,
    }

    impl CachedPages {
        pub(crate) fn new(xref: Arc<XRef>) -> Option<Self> {
            // SAFETY:
            // - The XRef's location is stable in memory:
            //   - We wrapped it in a `Arc` (or `Rc` in `no_std`), which implements `StableDeref`.
            //   - The struct owns the `Arc`, ensuring that the inner value is not dropped during the whole
            //     duration.
            // - The internal 'static lifetime is not leaked because its rewritten
            //   to the self-lifetime in `pages()`.
            let xref_reference: &'static XRef = unsafe { core::mem::transmute(xref.deref()) };

            let ctx = ReaderContext::new(xref_reference, false);
            let tree = xref_reference
                .get_with(xref.trailer_data().pages_ref, &ctx)
                .and_then(|p| Pages::new(&p, &ctx, xref_reference));
            let pages = if tree.as_ref().is_none_or(Pages::lost_everything) {
                Pages::new_brute_force(&ctx, xref_reference).or(tree)?
            } else {
                tree?
            };

            Some(Self { pages, _xref: xref })
        }

        pub(crate) fn get(&self) -> &Pages<'_> {
            // SAFETY (recto): `LazyPages`' OnceLocks make `Pages` invariant, so
            // shorten the fake 'static by hand. The cells are filled only from
            // the stored root and context (this document's data), never from
            // a caller's value, so no shorter-lived data gets in.
            unsafe { core::mem::transmute::<&Pages<'static>, &Pages<'_>>(&self.pages) }
        }
    }
}
