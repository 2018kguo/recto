//! Browser/Node bindings. Results are typed columns, so a page crosses a thread boundary without copying
//! objects.

use wasm_bindgen::prelude::*;

fn js_error(e: crate::EngineError) -> JsValue {
    let error = js_sys_error(&e.message);
    // `code` is what the JavaScript side maps onto PdfError's codes.
    let _ = js_set(&error, "code", e.kind.code());
    error
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = Error)]
    fn js_sys_error(message: &str) -> JsValue;
    #[wasm_bindgen(js_namespace = Reflect, js_name = set, catch)]
    fn js_set_raw(target: &JsValue, key: &JsValue, value: &JsValue) -> Result<bool, JsValue>;
}

fn js_set(target: &JsValue, key: &str, value: &str) -> Result<bool, JsValue> {
    js_set_raw(target, &JsValue::from_str(key), &JsValue::from_str(value))
}

/// The host's asset loader: `(index) => Uint8Array | undefined`, called
/// synchronously the first time a document needs a built-in font (0..13,
/// `STANDARD_FONTS` order), the CJK fallback (14) or the predefined CMaps (15).
/// Fonts are kept per instance; the CMaps are decompressed once and kept.
#[wasm_bindgen(js_name = setAssetLoader)]
pub fn set_asset_loader(loader: js_sys::Function) {
    crate::assets::set_loader(loader);
}

/// The most bytes one stream may decode to and one image hold, for this instance: past it, it's left
/// out and the page's results say `truncated`.
#[wasm_bindgen(js_name = setMaxDecodedBytes)]
pub fn set_max_decoded_bytes(bytes: f64) {
    hayro::hayro_syntax::set_max_decoded_bytes(if bytes >= usize::MAX as f64 { usize::MAX } else { bytes as usize });
}

/// SHA-256, for the JavaScript side's checks on large assets it read synchronously.
#[wasm_bindgen]
pub fn sha256(bytes: &[u8]) -> Vec<u8> {
    hayro::hayro_syntax::sha256(bytes).to_vec()
}

#[wasm_bindgen]
pub struct Document(std::rc::Rc<crate::Document>);

macro_rules! getters {
    ($ty:ident { $($field:ident : $t:ty => $js:literal),* $(,)? }) => {
        #[wasm_bindgen]
        impl $ty {
            $(
                #[wasm_bindgen(getter, js_name = $js)]
                pub fn $field(&self) -> $t {
                    self.$field.clone()
                }
            )*
        }
    };
}

/// `PdfPageText` as columns: one entry per Unicode code
/// point (a ligature's chars share its box). `fonts`, `words` and `runs` are
/// flattened into `font*`, `word*` and `run*` columns.
#[wasm_bindgen]
pub struct PageText {
    text: String,
    count: u32,
    codepoints: Vec<u32>,
    boxes: Vec<f32>,
    font_sizes: Vec<f32>,
    tf_sizes: Vec<f32>,
    font_ascents: Vec<f32>,
    font_descents: Vec<f32>,
    truncated: bool,
    angles: Vec<f32>,
    fills: Vec<u32>,
    font_ids: Vec<i32>,
    flags: Vec<u8>,
    font_names: Vec<String>,
    font_flags: Vec<u32>,
    font_weights: Vec<u32>,
    /// 1 when embedded.
    font_embedded: Vec<u8>,
    /// First and last char of each word, inclusive.
    word_first_char: Vec<u32>,
    word_last_char: Vec<u32>,
    word_boxes: Vec<f32>,
    run_ids: Vec<i32>,
    run_origins: Vec<f32>,
    run_ems: Vec<f32>,
}

getters!(PageText {
    text: String => "text",
    count: u32 => "count",
    codepoints: Vec<u32> => "codepoints",
    boxes: Vec<f32> => "boxes",
    font_sizes: Vec<f32> => "fontSizes",
    tf_sizes: Vec<f32> => "tfSizes",
    font_ascents: Vec<f32> => "fontAscents",
    font_descents: Vec<f32> => "fontDescents",
    truncated: bool => "truncated",
    angles: Vec<f32> => "angles",
    fills: Vec<u32> => "fills",
    font_ids: Vec<i32> => "fontIds",
    flags: Vec<u8> => "flags",
    font_names: Vec<String> => "fontNames",
    font_flags: Vec<u32> => "fontFlags",
    font_weights: Vec<u32> => "fontWeights",
    font_embedded: Vec<u8> => "fontEmbedded",
    word_first_char: Vec<u32> => "wordFirstChar",
    word_last_char: Vec<u32> => "wordLastChar",
    word_boxes: Vec<f32> => "wordBoxes",
    run_ids: Vec<i32> => "runIds",
    run_origins: Vec<f32> => "runOrigins",
    run_ems: Vec<f32> => "runEms",
});

fn ligature(c: char) -> Option<&'static str> {
    Some(match c {
        '\u{FB00}' => "ff",
        '\u{FB01}' => "fi",
        '\u{FB02}' => "fl",
        '\u{FB03}' => "ffi",
        '\u{FB04}' => "ffl",
        '\u{FB05}' => "\u{17F}t",
        '\u{FB06}' => "st",
        _ => return None,
    })
}

fn page_text(page: &crate::TextPage) -> PageText {
    let n = page.chars.len();
    let mut t = PageText {
        text: String::new(),
        count: 0,
        codepoints: Vec::with_capacity(n),
        boxes: Vec::with_capacity(n * 4),
        font_sizes: Vec::with_capacity(n),
        tf_sizes: Vec::with_capacity(n),
        font_ascents: page.fonts.iter().map(|f| f.ascent).collect(),
        font_descents: page.fonts.iter().map(|f| f.descent).collect(),
        truncated: page.truncated,
        angles: Vec::with_capacity(n),
        fills: Vec::with_capacity(n),
        font_ids: Vec::with_capacity(n),
        flags: Vec::with_capacity(n),
        font_names: page.fonts.iter().map(|f| f.name.clone()).collect(),
        font_flags: page.fonts.iter().map(|f| f.flags).collect(),
        font_weights: page.fonts.iter().map(|f| f.weight).collect(),
        font_embedded: page.fonts.iter().map(|f| u8::from(f.embedded)).collect(),
        word_first_char: Vec::with_capacity(page.words.len()),
        word_last_char: Vec::with_capacity(page.words.len()),
        word_boxes: Vec::with_capacity(page.words.len() * 4),
        run_ids: Vec::with_capacity(n),
        run_origins: page.runs.iter().flat_map(|r| r.origin).collect(),
        run_ems: page.runs.iter().map(|r| r.em).collect(),
    };
    // Where each char's code points start, plus the end.
    let mut first = Vec::with_capacity(n + 1);
    for c in &page.chars {
        first.push(t.codepoints.len() as u32);
        let mut push = |cp: u32| {
            t.codepoints.push(cp);
            t.boxes.extend_from_slice(&c.bbox);
            t.font_sizes.push(c.em);
            t.tf_sizes.push(c.tf);
            t.angles.push(c.angle);
            t.fills.push(c.fill);
            t.font_ids.push(c.font);
            t.flags.push(c.flags);
            t.run_ids.push(c.run);
        };
        if c.text.is_empty() {
            // An unmapped glyph stands in as its char code. A code that is no
            // scalar value (4-byte codespaces, surrogates) reads as U+FFFD.
            let ch = char::from_u32(c.code).unwrap_or('\u{FFFD}');
            push(ch as u32);
            t.text.push(ch);
        } else {
            for ch in c.text.chars() {
                // The Latin ligatures U+FB00..FB06 split into their letters, each with the ligature's box.
                match ligature(ch) {
                    Some(letters) => {
                        for l in letters.chars() {
                            push(l as u32);
                            t.text.push(l);
                        }
                    }
                    None => {
                        push(ch as u32);
                        t.text.push(ch);
                    }
                }
            }
        }
    }
    first.push(t.codepoints.len() as u32);
    t.count = t.codepoints.len() as u32;
    for w in &page.words {
        t.word_first_char.push(first[w.start as usize]);
        t.word_last_char.push(first[w.end as usize] - 1);
        t.word_boxes.extend_from_slice(&w.bbox);
    }
    t
}

/// `PdfPageObjects` as columns: `images.boxes` is `imageBoxes`, and so on.
#[wasm_bindgen]
pub struct PageObjects {
    text_objects: u32,
    image_boxes: Vec<f32>,
    image_pixels: Vec<u32>,
    path_boxes: Vec<f32>,
    path_flags: Vec<u8>,
    path_start: Vec<u32>,
    segment_points: Vec<f32>,
    segment_kinds: Vec<u8>,
    truncated: bool,
}

getters!(PageObjects {
    text_objects: u32 => "textObjects",
    image_boxes: Vec<f32> => "imageBoxes",
    image_pixels: Vec<u32> => "imagePixels",
    path_boxes: Vec<f32> => "pathBoxes",
    path_flags: Vec<u8> => "pathFlags",
    path_start: Vec<u32> => "pathStart",
    segment_points: Vec<f32> => "segmentPoints",
    segment_kinds: Vec<u8> => "segmentKinds",
    truncated: bool => "truncated",
});

impl From<crate::PageObjects> for PageObjects {
    fn from(o: crate::PageObjects) -> Self {
        Self {
            text_objects: o.text_objects,
            image_boxes: o.image_boxes,
            image_pixels: o.image_pixels,
            path_boxes: o.path_boxes,
            path_flags: o.path_flags,
            path_start: o.path_start,
            segment_points: o.points,
            segment_kinds: o.kinds,
            truncated: o.truncated,
        }
    }
}

/// `PdfAnnotation[]` as columns, entry `i` per annotation. `hasField[i]` is
/// 0 where `field` is null.
#[wasm_bindgen]
pub struct Annotations {
    count: u32,
    subtypes: Vec<u8>,
    boxes: Vec<f32>,
    contents: Vec<String>,
    has_field: Vec<u8>,
    field_types: Vec<String>,
    field_values: Vec<String>,
    appearance_objects: Vec<u32>,
    appearance_text_objects: Vec<u32>,
    appearance_text: Vec<String>,
}

getters!(Annotations {
    count: u32 => "count",
    subtypes: Vec<u8> => "subtypes",
    boxes: Vec<f32> => "boxes",
    contents: Vec<String> => "contents",
    has_field: Vec<u8> => "hasField",
    field_types: Vec<String> => "fieldTypes",
    field_values: Vec<String> => "fieldValues",
    appearance_objects: Vec<u32> => "appearanceObjects",
    appearance_text_objects: Vec<u32> => "appearanceTextObjects",
    appearance_text: Vec<String> => "appearanceText",
});

impl From<Vec<crate::Annotation>> for Annotations {
    fn from(a: Vec<crate::Annotation>) -> Self {
        let field = |f: &Option<crate::Field>, kind: bool| {
            f.as_ref()
                .map(|f| {
                    if kind {
                        f.kind.clone()
                    } else {
                        f.value.clone()
                    }
                })
                .unwrap_or_default()
        };
        Self {
            count: a.len() as u32,
            subtypes: a.iter().map(|x| x.subtype).collect(),
            boxes: a.iter().flat_map(|x| x.bbox).collect(),
            contents: a.iter().map(|x| x.contents.clone()).collect(),
            has_field: a.iter().map(|x| u8::from(x.field.is_some())).collect(),
            field_types: a.iter().map(|x| field(&x.field, true)).collect(),
            field_values: a.iter().map(|x| field(&x.field, false)).collect(),
            appearance_objects: a.iter().map(|x| x.appearance_objects).collect(),
            appearance_text_objects: a.iter().map(|x| x.appearance_text_objects).collect(),
            appearance_text: a.iter().map(|x| x.appearance_text.clone()).collect(),
        }
    }
}

/// `scan`'s result: take each part once.
#[wasm_bindgen]
pub struct PageScan {
    text: Option<PageText>,
    objects: Option<PageObjects>,
    annotations: Option<Annotations>,
}

#[wasm_bindgen]
impl PageScan {
    #[wasm_bindgen(js_name = takeText)]
    pub fn take_text(&mut self) -> Option<PageText> {
        self.text.take()
    }
    #[wasm_bindgen(js_name = takeObjects)]
    pub fn take_objects(&mut self) -> Option<PageObjects> {
        self.objects.take()
    }
    #[wasm_bindgen(js_name = takeAnnotations)]
    pub fn take_annotations(&mut self) -> Option<Annotations> {
        self.annotations.take()
    }
}

#[wasm_bindgen]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub truncated: bool,
    rgba: Vec<u8>,
    /// Where it is in the page's bitmap, and that bitmap's size: see `Bitmap`.
    pub x: u32,
    pub y: u32,
    #[wasm_bindgen(js_name = pageWidth)]
    pub page_width: u32,
    #[wasm_bindgen(js_name = pageHeight)]
    pub page_height: u32,
}

impl From<crate::Bitmap> for RenderedPage {
    fn from(b: crate::Bitmap) -> Self {
        Self {
            width: b.width,
            height: b.height,
            truncated: b.truncated,
            rgba: b.rgba,
            x: b.x,
            y: b.y,
            page_width: b.page_width,
            page_height: b.page_height,
        }
    }
}

/// A region from four numbers, NaN for none.
fn region(x: f64, y: f64, width: f64, height: f64) -> Option<crate::Region> {
    (!x.is_nan()).then_some(crate::Region { x, y, width, height })
}

#[wasm_bindgen]
impl RenderedPage {
    /// Moves the pixels out; call once.
    #[wasm_bindgen(js_name = takeRgba)]
    pub fn take_rgba(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgba)
    }
}

impl Document {
    fn scan_parts(
        &self,
        index: usize,
        objects: bool,
        annotations: bool,
    ) -> Result<PageScan, JsValue> {
        let s = self.0.scan(index, objects, annotations).map_err(js_error)?;
        Ok(PageScan {
            text: Some(page_text(&s.text)),
            objects: objects.then(|| s.objects.into()),
            annotations: annotations.then(|| s.annotations.into()),
        })
    }
}

#[wasm_bindgen]
impl Document {
    #[wasm_bindgen(constructor)]
    pub fn open(bytes: Vec<u8>, password: Option<String>) -> Result<Document, JsValue> {
        crate::Document::open(bytes, password.as_deref().unwrap_or(""))
            .map(|document| Document(document.into()))
            .map_err(js_error)
    }

    /// A file of `length` bytes read by range. `read(offset, length)`
    /// returns those bytes (a Uint8Array), or undefined when it could not
    /// read them; it is called synchronously, chunk-aligned, at most 1 MiB.
    #[wasm_bindgen(js_name = openRanged)]
    pub fn open_ranged(
        length: usize,
        chunk: usize,
        #[wasm_bindgen(
            unchecked_param_type = "(offset: number, length: number, ahead: number) => Uint8Array | undefined"
        )]
        read: js_sys::Function,
        password: Option<String>,
    ) -> Result<Document, JsValue> {
        struct Host(js_sys::Function);
        // Sound because wasm32 has one thread; nothing sends this anywhere.
        unsafe impl Send for Host {}
        unsafe impl Sync for Host {}
        let host = Host(read);
        let fill = move |offset: usize, out: &mut [u8], ahead: usize| {
            let Ok(value) = host
                .0
                .call3(&JsValue::NULL, &offset.into(), &out.len().into(), &ahead.into())
            else {
                return false;
            };
            let bytes = js_sys::Uint8Array::new(&value);
            if value.is_undefined() || bytes.length() as usize != out.len() {
                return false;
            }
            bytes.copy_to(out);
            true
        };
        crate::Document::open_ranged(
            length,
            chunk,
            Box::new(fill),
            password.as_deref().unwrap_or(""),
        )
        .map(|document| Document(document.into()))
        .map_err(js_error)
    }

    /// Where the file is in this instance's memory, to reopen it on the full engine without a copy.
    #[wasm_bindgen(js_name = filePointer)]
    pub fn file_pointer(&self) -> usize {
        self.0.file_bytes().as_ptr() as usize
    }

    #[wasm_bindgen(js_name = fileLength)]
    pub fn file_length(&self) -> usize {
        self.0.file_bytes().len()
    }

    #[wasm_bindgen(getter, js_name = pageCount)]
    pub fn page_count(&self) -> usize {
        self.0.page_count()
    }

    /// [width, height, rotation]
    #[wasm_bindgen(js_name = pageInfo)]
    pub fn page_info(&self, index: usize) -> Result<Vec<f32>, JsValue> {
        let p = self.0.page_info(index).map_err(js_error)?;
        Ok(vec![p.width, p.height, p.rotation as f32])
    }

    /// `PdfPageText` columns; `tight` for `Boxes::Tight`.
    #[wasm_bindgen(js_name = pageText)]
    pub fn page_text(&self, index: usize, tight: bool) -> Result<PageText, JsValue> {
        let boxes = if tight { crate::Boxes::Tight } else { crate::Boxes::Font };
        let page = self.0.text_with(index, boxes).map_err(js_error)?;
        Ok(page_text(&page))
    }

    /// Text, objects and annotations from one interpretation of the page.
    pub fn scan(&self, index: usize) -> Result<PageScan, JsValue> {
        self.scan_parts(index, true, true)
    }

    /// Text and annotations (no objects).
    #[wasm_bindgen(js_name = textAndAnnotations)]
    pub fn text_and_annotations(&self, index: usize) -> Result<PageScan, JsValue> {
        self.scan_parts(index, false, true)
    }

    pub fn objects(&self, index: usize) -> Result<PageObjects, JsValue> {
        let s = self.0.scan(index, true, false).map_err(js_error)?;
        Ok(s.objects.into())
    }

    /// One string per page, or null if the file gives no labels.
    #[wasm_bindgen(js_name = pageLabels)]
    pub fn page_labels(&self) -> JsValue {
        self.0.page_labels().map_or(JsValue::NULL, |labels| {
            JsValue::from(labels.into_iter().map(|label| JsValue::from_str(&label)).collect::<js_sys::Array>())
        })
    }

    /// `[pages, pageLabels, outline]`: whether a limit cut each short.
    #[wasm_bindgen(js_name = structureTruncated)]
    pub fn structure_truncated(&self) -> Vec<u8> {
        let cut = self.0.structure_truncated();
        vec![cut.pages as u8, cut.page_labels as u8, cut.outline as u8]
    }

    /// Flat, in order: `[title, url or "", level, page, target]` per item, `target` as `links` gives one.
    pub fn outline(&self) -> js_sys::Array {
        self.0
            .outline()
            .into_iter()
            .map(|item| {
                let entry = js_sys::Array::new();
                entry.push(&JsValue::from_str(&item.title));
                entry.push(&JsValue::from_str(item.url.as_deref().unwrap_or("")));
                entry.push(&JsValue::from(item.level));
                entry.push(&JsValue::from(item.page));
                entry.push(&target(item.target));
                JsValue::from(entry)
            })
            .collect()
    }

    /// Per link: `[annotation, x, y, width, height, target]`, `target` as `target` below makes it.
    pub fn links(&self, index: usize) -> Result<js_sys::Array, JsValue> {
        let links = self.0.links(index).map_err(js_error)?;
        Ok(links
            .into_iter()
            .map(|link| {
                let entry = js_sys::Array::new();
                entry.push(&JsValue::from(link.annotation));
                for v in link.bbox {
                    entry.push(&JsValue::from(v));
                }
                entry.push(&target(link.target));
                JsValue::from(entry)
            })
            .collect())
    }

    /// The catalog's `/OpenAction`, as `links` gives a target.
    #[wasm_bindgen(js_name = openAction)]
    pub fn open_action(&self) -> JsValue {
        target(self.0.open_action())
    }

    /// A named destination, flat as `destination` below makes one.
    pub fn destination(&self, name: &str) -> JsValue {
        destination(self.0.destination(name))
    }

    /// Another file's destination for a page here, placed on it: the user space numbers given
    /// (NaN for none), back as `destination` makes one.
    #[wasm_bindgen(js_name = placeDestination)]
    #[allow(clippy::too_many_arguments)]
    pub fn place_destination(
        &self,
        page: i32,
        view: Option<String>,
        left: f32,
        bottom: f32,
        right: f32,
        top: f32,
        zoom: f32,
        name: Option<String>,
    ) -> JsValue {
        let n = |v: f32| (!v.is_nan()).then_some(v);
        let given = crate::Destination {
            page,
            view,
            left: n(left),
            bottom: n(bottom),
            right: n(right),
            top: n(top),
            zoom: n(zoom),
            name,
            ..Default::default()
        };
        destination(self.0.place_destination(&given))
    }

    pub fn annotations(&self, index: usize) -> Result<Annotations, JsValue> {
        let a = self.0.annotations(index).map_err(js_error)?;
        Ok(a.into())
    }

    /// A render that returns to its caller between slices, for as long as it's asked to run.
    /// The region is x, y, width, height in the viewer frame, or NaNs for the whole page.
    #[wasm_bindgen(js_name = renderTask)]
    #[allow(clippy::too_many_arguments)]
    pub fn render_task(
        &self,
        index: usize,
        width: f32,
        max_height: f32,
        x: f64,
        y: f64,
        region_width: f64,
        region_height: f64,
    ) -> Result<RenderTask, JsValue> {
        crate::RenderTask::new(self.0.clone(), index, width, max_height, region(x, y, region_width, region_height))
            .map(RenderTask)
            .map_err(js_error)
    }

    /// The region as `renderTask`'s.
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &self,
        index: usize,
        width: f32,
        max_height: f32,
        x: f64,
        y: f64,
        region_width: f64,
        region_height: f64,
    ) -> Result<RenderedPage, JsValue> {
        let b = self
            .0
            .render_region(index, width, max_height, region(x, y, region_width, region_height))
            .map_err(js_error)?;
        Ok(b.into())
    }
}

#[wasm_bindgen]
pub struct RenderTask(crate::RenderTask);

#[wasm_bindgen]
impl RenderTask {
    /// Runs for about `budget_ms`; true once the page's content is done.
    pub fn step(&mut self, budget_ms: f64) -> bool {
        let deadline = js_sys::Date::now() + budget_ms;
        self.0.step(&|| js_sys::Date::now() >= deadline)
    }

    /// Rasterizes what `step` drew: the rest of the page, in one call.
    pub fn finish(&mut self) -> RenderedPage {
        self.0.finish().into()
    }
}

fn optional_number(v: Option<f32>) -> JsValue {
    JsValue::from(v.map_or(f64::NAN, f64::from))
}

fn optional_string(v: Option<&str>) -> JsValue {
    v.map_or(JsValue::NULL, JsValue::from_str)
}

/// `[page, view, x, y, zoom, rectX, rectY, rectWidth, rectHeight, left, bottom, right, top, name]`,
/// NaN for a number that isn't there.
fn destination(dest: crate::Destination) -> JsValue {
    let entry = js_sys::Array::new();
    entry.push(&JsValue::from(dest.page));
    entry.push(&optional_string(dest.view.as_deref()));
    for v in [dest.x, dest.y, dest.zoom] {
        entry.push(&optional_number(v));
    }
    for v in dest.rect.map_or([None; 4], |r| r.map(Some)) {
        entry.push(&optional_number(v));
    }
    for v in [dest.left, dest.bottom, dest.right, dest.top] {
        entry.push(&optional_number(v));
    }
    entry.push(&optional_string(dest.name.as_deref()));
    JsValue::from(entry)
}

/// `[kind, text, destination, name, fileSystem, newWindow, path]`. `kind` is "none", "uri", "page",
/// "remote", "embedded", "launch" or "action"; `text` the URI, the file (null for an embedded file in
/// this one), or the action's `/S`; `name` a `Named` action's `/N`; `path` an embedded file's steps,
/// `[parent, name]` each.
fn target(target: crate::Target) -> JsValue {
    use crate::Target;
    let entry = js_sys::Array::new();
    let (kind, text, dest, name, file_system, new_window, path) = match target {
        Target::None => ("none", None, None, None, None, None, None),
        Target::Uri(uri) => ("uri", Some(uri), None, None, None, None, None),
        Target::Page(dest) => ("page", None, Some(dest), None, None, None, None),
        Target::Remote { file, file_system, destination, new_window } => {
            ("remote", Some(file), Some(destination), None, file_system, new_window, None)
        }
        Target::Embedded { file, path, destination, new_window } => {
            ("embedded", file, Some(destination), None, None, new_window, Some(path))
        }
        Target::Launch { file } => ("launch", Some(file), None, None, None, None, None),
        Target::Action { action, name } => ("action", Some(action), None, name, None, None, None),
    };
    entry.push(&JsValue::from_str(kind));
    entry.push(&optional_string(text.as_deref()));
    entry.push(&dest.map_or(JsValue::NULL, destination));
    entry.push(&optional_string(name.as_deref()));
    entry.push(&optional_string(file_system.as_deref()));
    entry.push(&new_window.map_or(JsValue::NULL, JsValue::from_bool));
    entry.push(&path.map_or(JsValue::NULL, |steps| {
        JsValue::from(
            steps
                .into_iter()
                .map(|step| {
                    let pair = js_sys::Array::new();
                    pair.push(&JsValue::from_bool(step.parent));
                    pair.push(&optional_string(step.name.as_deref()));
                    JsValue::from(pair)
                })
                .collect::<js_sys::Array>(),
        )
    }));
    JsValue::from(entry)
}
