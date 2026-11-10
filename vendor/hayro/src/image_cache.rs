//! recto: images as they're drawn, kept for a document, so that one drawn again at the same size (a
//! logo on every page, a page drawn as tiles, a page drawn again) isn't decoded and resized again.
//!
//! What's kept is the pixmap the renderer made from the decode: premultiplied RGBA at the size it's
//! drawn at (or the decode's own size, when it's drawn larger), shared, never copied. A key is the
//! image object, the size its decode was asked for, and the linear part of its transform, which
//! together decide every pixel of it; where something else does too (an inline image, a transfer
//! function, a soft mask), nothing is kept.
//!
//! An image is kept the second time it's drawn, so one drawn once costs nothing; the least
//! recently used goes first past the limit. A pixmap is handed out only while the thread's decode
//! limit would let its decode through, and never from a decode that was cut, so the cache changes
//! no pixel and no `truncated`.

use kurbo::Affine;
use std::sync::Arc;
use vello_cpu::Pixmap;
use vello_cpu::peniko::ImageQuality;

/// The most pixmap bytes a document keeps, or an eighth of what one decode may come to on this
/// thread if that's less (`hayro_syntax::max_decoded_bytes`). A Letter or A4 page scanned at 300
/// dpi is 34-35 MB as RGBA at its own size.
pub(crate) const MAX_CACHED_IMAGE_BYTES: usize = 48 << 20;
/// How many images drawn once the cache remembers, to keep the second.
const MAX_SEEN_IMAGES: usize = 1024;
/// How many it keeps, whatever their size: a file of many tiny images drawn twice would otherwise
/// fill 48 MiB with entries, each found by a search through all of them.
const MAX_CACHED_IMAGES: usize = 256;

/// What decides an image's pixmap: its decode (`RasterImage::decode_key`), the linear part of its
/// transform, exactly, and whether every image is smoothed.
pub(crate) type ImageKey = (u128, [u64; 4], bool);

/// What's drawn for a key: the pixmap, its sampling, and the transform from the image's own space
/// to the pixmap's.
#[derive(Clone)]
pub(crate) struct DrawnImage {
    pub(crate) pixmap: Arc<Pixmap>,
    pub(crate) quality: ImageQuality,
    pub(crate) transform: Affine,
}

struct Entry {
    key: ImageKey,
    image: DrawnImage,
    bytes: usize,
    /// The most a stream or image of it asked to decode to.
    asked: usize,
    used: u64,
}

/// A few images at most fit, so lists, searched in order.
#[derive(Default)]
pub(crate) struct ImageCache {
    entries: Vec<Entry>,
    seen: Vec<ImageKey>,
    bytes: usize,
    clock: u64,
}

impl ImageCache {
    pub(crate) fn get(&mut self, key: ImageKey) -> Option<DrawnImage> {
        self.clock += 1;
        let clock = self.clock;
        let hit = self
            .entries
            .iter_mut()
            .find(|e| e.key == key && e.asked <= hayro_interpret::hayro_syntax::max_decoded_bytes())?;
        hit.used = clock;
        Some(hit.image.clone())
    }

    /// Keeps `image` under `key` if it's been drawn before. `asked` is the most its decode asked
    /// for; nothing from a cut decode comes here.
    pub(crate) fn insert(&mut self, key: ImageKey, image: &DrawnImage, asked: usize) {
        let bytes = image.pixmap.data_as_u8_slice().len();
        let limit = MAX_CACHED_IMAGE_BYTES.min(hayro_interpret::hayro_syntax::max_decoded_bytes() / 8);
        if bytes > limit || self.entries.iter().any(|e| e.key == key) {
            return;
        }
        if !self.seen.contains(&key) {
            if self.seen.len() >= MAX_SEEN_IMAGES {
                self.seen.clear();
            }
            self.seen.push(key);
            return;
        }
        while self.bytes + bytes > limit || self.entries.len() >= MAX_CACHED_IMAGES {
            let Some(oldest) = (0..self.entries.len()).min_by_key(|&i| self.entries[i].used) else {
                break;
            };
            self.bytes -= self.entries.swap_remove(oldest).bytes;
        }
        self.bytes += bytes;
        self.entries.push(Entry {
            key,
            image: image.clone(),
            bytes,
            asked,
            used: self.clock,
        });
    }

    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
}
