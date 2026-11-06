//! A file read by range: hayro parses a buffer of the whole length, zeros
//! until `fill` copies a chunk in. hayro-syntax asks for each object's bytes
//! (grown until the object parses inside it), each xref section, and the whole
//! file before a repair (`PdfData::ranged`), so only those chunks are fetched.

use hayro::hayro_syntax::PdfData;
use std::sync::{Arc, Mutex};

/// Copies `out.len()` bytes at the offset into `out`; false when they could not be read.
pub type Fill = Box<dyn Fn(usize, &mut [u8]) -> bool + Send + Sync>;

/// The most one `fill` call asks for.
const MAX_FILL: usize = 1 << 20;

struct Ranged {
    ptr: *mut u8,
    len: usize,
    chunk: usize,
    held: Mutex<Vec<bool>>,
    fill: Fill,
}

// Sound because `ptr` is written only in chunks no parse has read yet (a held
// chunk is never written again), and hayro-syntax reads a range only after
// asking for it, so readers never see a write.
unsafe impl Send for Ranged {}
unsafe impl Sync for Ranged {}

impl AsRef<[u8]> for Ranged {
    fn as_ref(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
    }
}

impl Drop for Ranged {
    fn drop(&mut self) {
        #[cfg(not(target_arch = "wasm32"))]
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(self.ptr, self.len)) });
    }
}

/// A zeroed buffer of `len` bytes. On wasm32 it is fresh pages from
/// `memory.grow`: zero and uncommitted until a fill writes them, so memory
/// follows the bytes fetched, not the file length (the allocator's zeroing
/// would commit all of it).
/// Limit: wasm32 never frees it (linear memory never shrinks anyway); the
/// host retires the instance once memory passes its recycle threshold.
fn zeroed(len: usize) -> *mut u8 {
    #[cfg(target_arch = "wasm32")]
    {
        let old = core::arch::wasm32::memory_grow(0, len.div_ceil(65536).max(1));
        if old == usize::MAX {
            std::alloc::handle_alloc_error(
                std::alloc::Layout::array::<u8>(len).unwrap_or(std::alloc::Layout::new::<u8>()),
            );
        }
        (old * 65536) as *mut u8
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
    }
}

impl Ranged {
    fn ensure(&self, start: usize, end: usize) {
        if start >= end {
            return;
        }
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        let last = (end - 1) / self.chunk;
        // Contiguous missing chunks in one call (one miss for the host's
        // read-ahead), at most MAX_FILL bytes, so the host never buffers much
        // before its byte budget can refuse.
        let per_call = (MAX_FILL / self.chunk).max(1);
        let mut c = start / self.chunk;
        while c <= last {
            if held[c] {
                c += 1;
                continue;
            }
            let first = c;
            while c <= last && !held[c] && c - first < per_call {
                c += 1;
            }
            let (a, b) = (first * self.chunk, (c * self.chunk).min(self.len));
            let out = unsafe { std::slice::from_raw_parts_mut(self.ptr.add(a), b - a) };
            // A failed read leaves zeros; the host fails the call that made it.
            if !(self.fill)(a, out) {
                return;
            }
            held[first..c].fill(true);
        }
    }
}

pub fn data(len: usize, chunk: usize, fill: Fill) -> PdfData {
    let chunk = chunk.max(1);
    let ptr = zeroed(len);
    let ranged = Arc::new(Ranged {
        ptr,
        len,
        chunk,
        held: Mutex::new(vec![false; len.div_ceil(chunk)]),
        fill,
    });
    let ensure = ranged.clone();
    PdfData::ranged(ranged, Arc::new(move |a, b| ensure.ensure(a, b)))
}
