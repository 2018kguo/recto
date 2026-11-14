//! Results from decoding filtered data streams.

mod ascii_85;
pub(crate) mod ascii_hex;
mod ccitt;
mod dct;
mod jbig2;
mod jpx;
mod lzw_flate;
mod png;
mod run_length;

use crate::object::Dict;
use crate::object::Name;
use crate::object::dict::keys::*;
use crate::object::stream::{DecodeFailure, FilterResult, ImageDecodeParams};
use core::ops::Deref;

/// recto: how many bytes one stream may decode to, and one image hold at a byte a component, before
/// it's left out as if it couldn't be read. A few hundred bytes of `FlateDecode` can ask for a GB,
/// and 16 bytes of `CCITTFaxDecode` declaring 32,000 by 32,000 pixels did; on wasm32, past about a
/// GB, drawing it runs out of memory. A page 600 dpi at A0 in gray is 558 MB, and drew in 2.1 GB;
/// in RGB it's 1.7 GB, and didn't draw before there was a limit. The most any page of the 543 suite
/// and public files that open asked for was 151 MB (`examples/budgets.rs`).
pub const DEFAULT_MAX_DECODED_BYTES: usize = 768 << 20;

std::thread_local! {
    static MAX_DECODED_BYTES: core::cell::Cell<usize> = const { core::cell::Cell::new(DEFAULT_MAX_DECODED_BYTES) };
    static DECODES_CUT: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
    static LARGEST_DECODE: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
    static HELD: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
    static SCALED_DCT: core::cell::Cell<bool> = const { core::cell::Cell::new(true) };
}

/// recto: whether a JPEG drawn well under its size is decoded at 1/2, 1/4 or 1/8 of it, and an image of
/// a byte a sample from another filter averaged to that, on this thread (on by default). Off, for tests
/// and comparisons, every image decodes at full size.
#[doc(hidden)]
pub fn set_scaled_dct_decode(on: bool) {
    SCALED_DCT.with(|scaled| scaled.set(on));
}

/// recto: how far a JPEG of `width` by `height` can be reduced in its decode, as log2 of the factor
/// (0 to 3), and still be at least `target` (the size it's drawn at in device pixels, each side
/// rounded up): the largest reduction that leaves it at or above that size on both axes, so a
/// renderer scaling it down to the target loses nothing it would have shown.
pub fn dct_scale_shift(width: u32, height: u32, target: Option<(u32, u32)>) -> u8 {
    let Some((target_width, target_height)) = target else {
        return 0;
    };
    if !SCALED_DCT.with(|scaled| scaled.get()) {
        return 0;
    }
    (1..=3u8)
        .rev()
        .find(|&shift| {
            width.div_ceil(1 << shift) >= target_width.max(1)
                && height.div_ceil(1 << shift) >= target_height.max(1)
        })
        .unwrap_or(0)
}

/// recto: decoded content held while what it draws runs, which counts against the limit for
/// everything decoded meanwhile: a form drawing a form drawing a form, each of 600 MiB, held 1.8 GB at
/// once. Released when dropped; a clone counts again, as it's a copy.
pub struct HeldDecoded(usize);

/// recto: holds `bytes` of decoded content until the result is dropped; see [`HeldDecoded`].
pub fn hold_decoded(bytes: usize) -> HeldDecoded {
    HELD.with(|held| held.set(held.get().saturating_add(bytes)));
    HeldDecoded(bytes)
}

impl Clone for HeldDecoded {
    fn clone(&self) -> Self {
        hold_decoded(self.0)
    }
}

impl Drop for HeldDecoded {
    fn drop(&mut self) {
        let _ = HELD.try_with(|held| held.set(held.get().saturating_sub(self.0)));
    }
}

/// recto: the most bytes a stream or image asked to decode to since the last call, for
/// `examples/budgets.rs`.
#[doc(hidden)]
pub fn take_largest_decode() -> usize {
    LARGEST_DECODE.with(|n| n.replace(0))
}

/// recto: sets, for this thread, how many bytes one stream may decode to and one image hold; see
/// [`DEFAULT_MAX_DECODED_BYTES`].
pub fn set_max_decoded_bytes(bytes: usize) {
    MAX_DECODED_BYTES.with(|max| max.set(bytes));
}

/// recto: how many streams or images this thread has left out for decoding to more than the limit.
pub fn decodes_cut() -> usize {
    DECODES_CUT.with(|n| n.get())
}

/// recto: `f`'s result, and whether a stream or image was left out for its size while it ran. A
/// cache keeps that with what it built, and calls [`repeat_cut`] each time it hands it out, so every
/// call that uses it says so, not only the one that built it.
pub fn noting_cuts<T>(f: impl FnOnce() -> T) -> (T, bool) {
    let before = decodes_cut();
    let value = f();
    (value, decodes_cut() != before)
}

/// recto: `f`'s result, and the most bytes a stream or image asked to decode to while it ran: a
/// cache keeps that with what it built, and hands it out only while the limit would let it be built
/// again ([`max_decoded_bytes`]), so a cache never lets through what a decode would have cut.
pub fn noting_largest_decode<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let outer = LARGEST_DECODE.with(|n| n.replace(0));
    let value = f();
    let inner = LARGEST_DECODE.with(|n| n.get());
    LARGEST_DECODE.with(|n| n.set(outer.max(inner)));
    (value, inner)
}

/// recto: counts a cut again, for what was built from a cut decode and is used once more.
pub fn repeat_cut() {
    DECODES_CUT.with(|n| n.set(n.get() + 1));
}

/// recto: `f` with the limit lowered to `max` (never raised), for decodes that add up to one
/// buffer, as a page's content streams do.
pub fn with_max_decoded<T>(max: usize, f: impl FnOnce() -> T) -> T {
    let old = MAX_DECODED_BYTES.with(|max| max.get());
    let held = HELD.with(|held| held.get());
    set_max_decoded_bytes(max.saturating_add(held).min(old));
    let value = f();
    set_max_decoded_bytes(old);
    value
}

/// recto: what one stream may decode to now, on this thread: the limit, less what's held.
#[doc(hidden)]
pub fn max_decoded_bytes() -> usize {
    MAX_DECODED_BYTES.with(|max| max.get()).saturating_sub(HELD.with(|held| held.get()))
}

/// recto: whether `bytes` is within the limit; if not, the decode is counted as cut.
#[doc(hidden)]
pub fn fits_decoded(bytes: usize) -> bool {
    let fits = bytes <= max_decoded_bytes();
    LARGEST_DECODE.with(|n| n.set(n.get().max(bytes)));
    if !fits {
        DECODES_CUT.with(|n| n.set(n.get() + 1));
    }
    fits
}

/// recto: a `FlateDecode` stream's data decoded as a stream's is, without parameters. For tests.
#[doc(hidden)]
pub fn flate_decode(data: &[u8]) -> Option<Vec<u8>> {
    lzw_flate::flate::decode(data, &Dict::empty())
}

/// A data filter.
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum Filter {
    /// ASCII hexadecimal encoding.
    AsciiHexDecode,
    /// ASCII base-85 encoding.
    Ascii85Decode,
    /// Lempel-Ziv-Welch (LZW) compression.
    LzwDecode,
    /// DEFLATE compression (zlib/gzip).
    FlateDecode,
    /// Run-length encoding compression.
    RunLengthDecode,
    /// CCITT Group 3 or Group 4 fax compression.
    CcittFaxDecode,
    /// JBIG2 compression for bi-level images.
    Jbig2Decode,
    /// JPEG (DCT) compression.
    DctDecode,
    /// JPEG 2000 compression.
    JpxDecode,
    /// Encryption filter.
    Crypt,
}

impl Filter {
    pub(crate) fn from_name(name: Name<'_>) -> Option<Self> {
        match name.deref() {
            ASCII_HEX_DECODE | ASCII_HEX_DECODE_ABBREVIATION => Some(Self::AsciiHexDecode),
            ASCII85_DECODE | ASCII85_DECODE_ABBREVIATION => Some(Self::Ascii85Decode),
            LZW_DECODE | LZW_DECODE_ABBREVIATION => Some(Self::LzwDecode),
            FLATE_DECODE | FLATE_DECODE_ABBREVIATION => Some(Self::FlateDecode),
            RUN_LENGTH_DECODE | RUN_LENGTH_DECODE_ABBREVIATION => Some(Self::RunLengthDecode),
            CCITTFAX_DECODE | CCITTFAX_DECODE_ABBREVIATION => Some(Self::CcittFaxDecode),
            JBIG2_DECODE => Some(Self::Jbig2Decode),
            DCT_DECODE | DCT_DECODE_ABBREVIATION => Some(Self::DctDecode),
            JPX_DECODE => Some(Self::JpxDecode),
            CRYPT => Some(Self::Crypt),
            _ => None,
        }
    }

    pub(crate) fn apply(
        &self,
        data: &[u8],
        params: &Dict<'_>,
        image_params: &ImageDecodeParams,
    ) -> Result<FilterResult<'static>, DecodeFailure> {
        match self {
            Self::AsciiHexDecode => ascii_hex::decode(data)
                .map(FilterResult::from_data)
                .ok_or(DecodeFailure::StreamDecode),
            Self::Ascii85Decode => ascii_85::decode(data)
                .map(FilterResult::from_data)
                .ok_or(DecodeFailure::StreamDecode),
            Self::RunLengthDecode => run_length::decode(data)
                .map(FilterResult::from_data)
                .ok_or(DecodeFailure::StreamDecode),
            Self::LzwDecode => lzw_flate::lzw::decode(data, params)
                .map(FilterResult::from_data)
                .ok_or(DecodeFailure::StreamDecode),
            Self::FlateDecode => lzw_flate::flate::decode(data, params)
                .map(FilterResult::from_data)
                .ok_or(DecodeFailure::StreamDecode),
            Self::DctDecode => {
                dct::decode(data, params, image_params).ok_or(DecodeFailure::ImageDecode)
            }
            Self::CcittFaxDecode => {
                ccitt::decode(data, params, image_params).ok_or(DecodeFailure::ImageDecode)
            }
            Self::Jbig2Decode => {
                jbig2::decode(data, params, image_params).ok_or(DecodeFailure::ImageDecode)
            }
            Self::JpxDecode => jpx::decode(data, image_params).ok_or(DecodeFailure::ImageDecode),
            _ => Err(DecodeFailure::StreamDecode),
        }
    }
}
