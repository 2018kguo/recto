//! Results from decoding filtered data streams.

mod ascii_85;
pub(crate) mod ascii_hex;
#[cfg(feature = "images")]
mod ccitt;
#[cfg(feature = "images")]
mod dct;
#[cfg(feature = "images")]
mod jbig2;
#[cfg(feature = "images")]
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

#[cfg(feature = "std")]
std::thread_local! {
    static MAX_DECODED_BYTES: core::cell::Cell<usize> = const { core::cell::Cell::new(DEFAULT_MAX_DECODED_BYTES) };
    static DECODES_CUT: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
    static LARGEST_DECODE: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
    static HELD: core::cell::Cell<usize> = const { core::cell::Cell::new(0) };
}

/// recto: decoded content held while what it draws runs, which counts against the limit for
/// everything decoded meanwhile: a form drawing a form drawing a form, each of 600 MiB, held 1.8 GB at
/// once. Released when dropped; a clone counts again, as it's a copy.
pub struct HeldDecoded(usize);

/// recto: holds `bytes` of decoded content until the result is dropped; see [`HeldDecoded`].
pub fn hold_decoded(bytes: usize) -> HeldDecoded {
    #[cfg(feature = "std")]
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
        #[cfg(feature = "std")]
        let _ = HELD.try_with(|held| held.set(held.get().saturating_sub(self.0)));
    }
}

/// recto: the most bytes a stream or image asked to decode to since the last call, for
/// `examples/budgets.rs`.
#[cfg(feature = "std")]
#[doc(hidden)]
pub fn take_largest_decode() -> usize {
    LARGEST_DECODE.with(|n| n.replace(0))
}

/// recto: sets, for this thread, how many bytes one stream may decode to and one image hold; see
/// [`DEFAULT_MAX_DECODED_BYTES`].
#[cfg(feature = "std")]
pub fn set_max_decoded_bytes(bytes: usize) {
    MAX_DECODED_BYTES.with(|max| max.set(bytes));
}

/// recto: how many streams or images this thread has left out for decoding to more than the limit.
#[cfg(feature = "std")]
pub fn decodes_cut() -> usize {
    DECODES_CUT.with(|n| n.get())
}

/// recto: `f`'s result, and whether a stream or image was left out for its size while it ran. A
/// cache keeps that with what it built, and calls [`repeat_cut`] each time it hands it out, so every
/// call that uses it says so, not only the one that built it.
pub fn noting_cuts<T>(f: impl FnOnce() -> T) -> (T, bool) {
    #[cfg(feature = "std")]
    {
        let before = decodes_cut();
        let value = f();
        (value, decodes_cut() != before)
    }
    #[cfg(not(feature = "std"))]
    (f(), false)
}

/// recto: counts a cut again, for what was built from a cut decode and is used once more.
pub fn repeat_cut() {
    #[cfg(feature = "std")]
    DECODES_CUT.with(|n| n.set(n.get() + 1));
}

/// recto: `f` with the limit lowered to `max` (never raised), for decodes that add up to one
/// buffer, as a page's content streams do.
pub fn with_max_decoded<T>(max: usize, f: impl FnOnce() -> T) -> T {
    #[cfg(feature = "std")]
    {
        let old = MAX_DECODED_BYTES.with(|max| max.get());
        let held = HELD.with(|held| held.get());
        set_max_decoded_bytes(max.saturating_add(held).min(old));
        let value = f();
        set_max_decoded_bytes(old);
        value
    }
    #[cfg(not(feature = "std"))]
    {
        let _ = max;
        f()
    }
}

/// recto: what one stream may decode to now, on this thread: the limit, less what's held.
#[doc(hidden)]
pub fn max_decoded_bytes() -> usize {
    #[cfg(feature = "std")]
    return MAX_DECODED_BYTES.with(|max| max.get()).saturating_sub(HELD.with(|held| held.get()));
    #[cfg(not(feature = "std"))]
    DEFAULT_MAX_DECODED_BYTES
}

/// recto: whether `bytes` is within the limit; if not, the decode is counted as cut.
#[doc(hidden)]
pub fn fits_decoded(bytes: usize) -> bool {
    let fits = bytes <= max_decoded_bytes();
    #[cfg(feature = "std")]
    {
        LARGEST_DECODE.with(|n| n.set(n.get().max(bytes)));
        if !fits {
            DECODES_CUT.with(|n| n.set(n.get() + 1));
        }
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
        #[cfg_attr(not(feature = "images"), allow(unused))] image_params: &ImageDecodeParams,
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
            #[cfg(feature = "images")]
            Self::DctDecode => {
                dct::decode(data, params, image_params).ok_or(DecodeFailure::ImageDecode)
            }
            #[cfg(feature = "images")]
            Self::CcittFaxDecode => {
                ccitt::decode(data, params, image_params).ok_or(DecodeFailure::ImageDecode)
            }
            #[cfg(feature = "images")]
            Self::Jbig2Decode => {
                jbig2::decode(data, params, image_params).ok_or(DecodeFailure::ImageDecode)
            }
            #[cfg(feature = "images")]
            Self::JpxDecode => jpx::decode(data, image_params).ok_or(DecodeFailure::ImageDecode),
            #[cfg(not(feature = "images"))]
            Self::DctDecode | Self::CcittFaxDecode | Self::Jbig2Decode | Self::JpxDecode => {
                Err(DecodeFailure::ImageDecode)
            }
            _ => Err(DecodeFailure::StreamDecode),
        }
    }
}
