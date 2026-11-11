//! What drawing many glyphs holds at its peak. A page draws everything it records before it
//! rasterizes any of it, so whatever one glyph's draw keeps until then is multiplied by every glyph
//! on the page: 320,000 small glyphs took 250 MB, and a page within the decode limit could take
//! gigabytes. Its own process (an integration test is its own binary), so the counting allocator
//! sees only this.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        PEAK.fetch_max(LIVE.fetch_add(l.size(), Relaxed) + l.size(), Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        PEAK.fetch_max(LIVE.fetch_add(l.size(), Relaxed) + l.size(), Relaxed);
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        PEAK.fetch_max(LIVE.fetch_add(n, Relaxed) + n, Relaxed);
        LIVE.fetch_sub(l.size(), Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}

#[global_allocator]
static A: Counting = Counting;

fn pdf(objects: &[&[u8]]) -> Vec<u8> {
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for o in offsets {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer << /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    out
}

/// One page of `lines` lines of 100 glyphs of 4 pt Helvetica, black or in `colour`, over and over the
/// same 180 lines of the page.
fn page_of_glyphs(lines: usize, colour: &str) -> Vec<u8> {
    let mut content = format!("BT /F1 4 Tf {colour}\n");
    let text = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore";
    for i in 0..lines {
        content += &format!("1 0 0 1 {} {} Tm ({text}) Tj\n", 10 + i % 7, 780 - (i % 180) * 4);
    }
    content += "ET";
    let content = format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len());
    pdf(&[
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
        content.as_bytes(),
    ])
}

/// The peak the render of the page adds to what was live before it, past its own pixmap.
fn render_peak(bytes: Vec<u8>) -> usize {
    let doc = recto::Document::open(bytes, "").unwrap();
    // Text first, so the fonts are loaded and outside what's measured.
    doc.text(0).unwrap();
    let before = LIVE.load(Relaxed);
    PEAK.store(before, Relaxed);
    let bitmap = doc.render(0, 1024.0, f32::INFINITY).unwrap();
    let peak = PEAK.load(Relaxed) - before - bitmap.rgba.len();
    assert!(!bitmap.truncated);
    let drawn = bitmap.rgba.chunks(4).filter(|p| p[1] < 128).count();
    assert!(drawn > 100_000, "the glyphs are drawn: {drawn} pixels");
    peak
}

/// Each glyph drawn from the cache holds its coverage as strips until the page is rasterized, without
/// an image paint of its own besides (330 bytes a glyph here, from 885), and a page that draws more
/// than hayro's `MAX_RECORDED_BYTES` is rasterized in parts, so 640,000 glyphs take what 320,000 do:
/// 65 MB, from 570 MB (and 1.1 GB for 1,280,000). One test, as the counter is the process's.
#[test]
fn a_page_of_glyphs_holds_a_bounded_amount() {
    for colour in ["", "0.8 0.1 0.1 rg"] {
        let small = render_peak(page_of_glyphs(400, colour));
        assert!(small < 40_000 * 400, "{small} bytes for 40,000 glyphs");
    }
    let large = render_peak(page_of_glyphs(6_400, ""));
    assert!(large < 96 << 20, "{large} bytes for 640,000 glyphs");
}
