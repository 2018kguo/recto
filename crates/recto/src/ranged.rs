//! A file read by range: hayro parses a buffer of the whole length, zeros
//! until `fill` copies a chunk in. hayro-syntax asks for each object's bytes
//! (grown until the object parses inside it), each xref section, and the whole
//! file before a repair (`PdfData::ranged`), so only those chunks are fetched.

use hayro::hayro_syntax::PdfData;
use std::sync::{Arc, Mutex};

/// Copies `out.len()` bytes at the offset into `out`; false when they could not be read. If that
/// has to fetch, the last argument is how many bytes past `out` the fetch may take along: what's
/// likely read next, for no more round trips.
pub type Fill = Box<dyn Fn(usize, &mut [u8], usize) -> bool + Send + Sync>;

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
/// None when the instance has no address space left for it.
fn zeroed(len: usize) -> Option<*mut u8> {
    #[cfg(target_arch = "wasm32")]
    {
        let old = core::arch::wasm32::memory_grow(0, len.div_ceil(65536).max(1));
        (old != usize::MAX).then(|| (old * 65536) as *mut u8)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        Some(Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8)
    }
}

impl Ranged {
    /// False if a read failed. A fill that has to fetch may take bytes up to `ahead` along.
    fn ensure(&self, start: usize, end: usize, ahead: usize) -> bool {
        if start >= end {
            return true;
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
            if !(self.fill)(a, out, ahead.saturating_sub(b)) {
                return false;
            }
            held[first..c].fill(true);
        }
        true
    }
}

pub fn data(len: usize, chunk: usize, fill: Fill) -> Option<PdfData> {
    let chunk = chunk.max(1);
    let ptr = zeroed(len)?;
    let ranged = Arc::new(Ranged {
        ptr,
        len,
        chunk,
        held: Mutex::new(vec![false; len.div_ceil(chunk)]),
        fill,
    });
    let ensure = ranged.clone();
    Some(PdfData::ranged(ranged, Arc::new(move |a, b, ahead| ensure.ensure(a, b, ahead))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Document;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const PADDING: usize = 1 << 22;

    /// A file whose objects all lie in the head, then `PADDING` bytes nothing asks for until a
    /// repair, then `tail`.
    fn file(tail: impl Fn(usize) -> String) -> Arc<Vec<u8>> {
        let head = "%PDF-1.7\n\
            1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n\
            2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n\
            3 0 obj <</Type/Page/MediaBox[0 0 10 10]>> endobj\n";
        let mut bytes = head.as_bytes().to_vec();
        bytes.resize(head.len() + PADDING, b' ');
        let tail = tail(bytes.len());
        bytes.extend_from_slice(tail.as_bytes());
        Arc::new(bytes)
    }

    /// An open where a read that touches the padding fails, as a stalled server's would. The whole
    /// file is present in `bytes`, but only what was read before the failure can be in the buffer.
    fn open(bytes: &Arc<Vec<u8>>, fail: bool) -> Result<Document, crate::EngineError> {
        open_counting(bytes, fail, Arc::default())
    }

    fn open_counting(
        bytes: &Arc<Vec<u8>>,
        fail: bool,
        failed: Arc<AtomicUsize>,
    ) -> Result<Document, crate::EngineError> {
        let source = bytes.clone();
        let middle = 4096..PADDING / 2;
        let fill = move |offset: usize, out: &mut [u8], _ahead: usize| {
            let touches = offset < middle.end && offset + out.len() > middle.start;
            if fail && touches {
                failed.fetch_add(1, Ordering::Relaxed);
                return false;
            }
            out.copy_from_slice(&source[offset..offset + out.len()]);
            true
        };
        Document::open_ranged(bytes.len(), 1024, Box::new(fill), "")
    }

    // Each file only opens by way of a repair, and a repair after a failed read would scan zeros
    // for nothing: the objects in the buffer, found by that scan, are how a test can see it ran.
    #[test]
    fn no_repair_after_a_failed_read() {
        let no_xref = file(|_| "startxref\n999999999\n%%EOF\n".to_string());
        let lost_tree = file(|at| {
            format!(
                "xref\n0 2\n0000000000 65535 f \n0000000099 00000 n \n\
                 trailer <</Size 2/Root 1 0 R>>\nstartxref\n{at}\n%%EOF\n"
            )
        });
        for bytes in [no_xref, lost_tree] {
            assert_eq!(open(&bytes, false).ok().map(|d| d.page_count()), Some(1));
            assert!(open(&bytes, true).is_err());
        }
    }

    #[test]
    fn an_open_stops_reading_at_the_first_failure() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let fill = move |_: usize, _: &mut [u8], _: usize| {
            counted.fetch_add(1, Ordering::Relaxed);
            false
        };
        assert!(Document::open_ranged(1 << 24, 1024, Box::new(fill), "").is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    // A read that failed isn't retried with a wider window, for a section or for an object: the
    // widening reads 5 and 14 times here. What's left is one ask per stage of the open.
    #[test]
    fn growing_windows_stop_at_a_failed_read() {
        let in_padding = PADDING / 4;
        let section = file(move |_| format!("startxref\n{in_padding}\n%%EOF\n"));
        let object = file(move |at| {
            format!(
                "xref\n0 2\n0000000000 65535 f \n{in_padding:010} 00000 n \n\
                 trailer <</Size 2/Root 1 0 R>>\nstartxref\n{at}\n%%EOF\n"
            )
        });
        for (bytes, asks) in [(section, 2), (object, 4)] {
            let failed = Arc::new(AtomicUsize::new(0));
            assert!(open_counting(&bytes, true, failed.clone()).is_err());
            assert_eq!(failed.load(Ordering::Relaxed), asks);
        }
    }
}
