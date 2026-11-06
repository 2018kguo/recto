//! Fonts a document names but does not embed. Native builds use hayro's
//! embedded Foxit fonts. The WASM build leaves them out and asks the host on
//! first use for `fonts.bin` (the same Foxit fonts, entries 0..13) and
//! `cjk-fallback.ttf` (entry 14).

use hayro::hayro_interpret::InterpreterSettings;
#[cfg(feature = "wasm")]
use hayro::hayro_interpret::font::{FontData, FontQuery, StandardFont};

/// `fonts.bin` index of each standard font (scripts/pack-fonts.mjs).
#[cfg(feature = "wasm")]
fn font_index(font: StandardFont) -> u32 {
    match font {
        StandardFont::Courier => 0,
        StandardFont::CourierBold => 1,
        StandardFont::CourierBoldOblique => 2,
        StandardFont::CourierOblique => 3,
        StandardFont::Helvetica => 4,
        StandardFont::HelveticaBold => 5,
        StandardFont::HelveticaBoldOblique => 6,
        StandardFont::HelveticaOblique => 7,
        StandardFont::TimesRoman => 8,
        StandardFont::TimesBold => 9,
        StandardFont::TimesBoldItalic => 10,
        StandardFont::TimesItalic => 11,
        StandardFont::Symbol => 12,
        StandardFont::ZapfDingBats => 13,
    }
}

/// The asset index of the CJK glyph fallback.
#[cfg(feature = "wasm")]
pub const CJK_FONT: u32 = 14;

/// hayro's predefined CMaps (`cmaps.brotli`), read once per instance the first
/// time a file names one.
#[cfg(feature = "wasm")]
pub const CMAPS: u32 = 15;

#[cfg(feature = "wasm")]
mod host {
    use super::FontData;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::Arc;

    thread_local! {
        static LOADER: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
        static CACHE: RefCell<HashMap<u32, FontData>> = RefCell::new(HashMap::new());
    }

    pub fn set_loader(loader: js_sys::Function) {
        LOADER.with(|l| *l.borrow_mut() = Some(loader));
        CACHE.with(|c| c.borrow_mut().clear());
        hayro_cmap::set_bundle_source(|| fetch(super::CMAPS));
    }

    /// Asset `index` from the host, uncached. A host that could not read it
    /// answers undefined and fails the call in progress itself, so a missing
    /// asset never reads as blank text.
    fn fetch(index: u32) -> Option<Vec<u8>> {
        LOADER.with(|l| {
            let loader = l.borrow();
            let value = loader
                .as_ref()?
                .call1(&wasm_bindgen::JsValue::NULL, &index.into())
                .ok()?;
            let array = js_sys::Uint8Array::new(&value);
            (!value.is_undefined() && !value.is_null() && array.length() > 0)
                .then(|| array.to_vec())
        })
    }

    /// Asset `index`, asked of the host once per instance once it arrives.
    pub fn asset(index: u32) -> Option<FontData> {
        if let Some(hit) = CACHE.with(|c| c.borrow().get(&index).cloned()) {
            return Some(hit);
        }
        let data: FontData = Arc::new(fetch(index)?);
        CACHE.with(|c| c.borrow_mut().insert(index, data.clone()));
        Some(data)
    }
}

#[cfg(feature = "wasm")]
pub use host::set_loader;

#[cfg(feature = "wasm")]
fn resolve(query: &FontQuery) -> Option<(FontData, u32)> {
    let index = match query {
        FontQuery::Standard(font) => font_index(*font),
        // A CID font it does not embed, of any ordering (Identity-H included):
        // the CJK fallback, which also covers Latin. hayro maps its glyphs
        // through the ToUnicode map and keeps the PDF's widths. Simple fonts
        // take the closest standard font.
        FontQuery::Fallback(f) if f.character_collection.is_some() => CJK_FONT,
        FontQuery::Fallback(f) => font_index(f.pick_standard_font()),
    };
    host::asset(index).map(|data| (data, 0))
}

/// A TrueType font holding only `.notdef` (238 bytes, a subset of
/// cjk-fallback.ttf). A text pass gives a CID font the document does not
/// embed this instead of the 5 MB CJK fallback: hayro takes its Unicode from
/// ToUnicode and its widths from /W, so no glyph program is needed. Simple
/// fonts still get their standard font, whose metrics set char widths.
static NOTDEF: &[u8] = include_bytes!("notdef.ttf");

/// Settings for passes that read text, objects and annotations.
pub fn text_settings() -> InterpreterSettings {
    let render = settings().font_resolver;
    InterpreterSettings {
        font_resolver: std::sync::Arc::new(move |query| match query {
            hayro::hayro_interpret::font::FontQuery::Fallback(f)
                if f.character_collection.is_some() =>
            {
                Some((
                    std::sync::Arc::new(NOTDEF) as hayro::hayro_interpret::font::FontData,
                    0,
                ))
            }
            _ => render(query),
        }),
        ..Default::default()
    }
}

/// Interpreter settings for rendering, with this build's font resolver.
pub fn settings() -> InterpreterSettings {
    #[cfg(feature = "wasm")]
    {
        InterpreterSettings {
            font_resolver: std::sync::Arc::new(resolve),
            ..Default::default()
        }
    }
    #[cfg(not(feature = "wasm"))]
    {
        InterpreterSettings::default()
    }
}
