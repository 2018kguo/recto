//! What an open document keeps after a page is done. Its own process (an integration test is its own
//! binary), so the counting allocator sees only this.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        LIVE.fetch_add(l.size(), Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        LIVE.fetch_add(l.size(), Relaxed);
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        LIVE.fetch_add(n, Relaxed);
        LIVE.fetch_sub(l.size(), Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}

#[global_allocator]
static A: Counting = Counting;

/// The tests count one allocator, so they take turns.
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn pdf(objects: &[Vec<u8>]) -> Vec<u8> {
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

/// `pages` pages that share one `/Resources` of `fonts` fonts, each page showing `glyphs` glyphs.
fn document(pages: usize, fonts: usize, glyphs: usize) -> Vec<u8> {
    let font_entries: String = (0..fonts).map(|i| format!("/F{i} 4 0 R ")).collect();
    let mut content = String::from("BT /F0 4 Tf 10 780 Td\n");
    for line in 0..glyphs.div_ceil(100) {
        let n = (glyphs - line * 100).min(100);
        content += &format!("0 -4 Td ({}) Tj\n", "x".repeat(n));
    }
    content += "ET";
    let mut objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        format!(
            "<< /Type /Pages /Count {pages} /Kids [{}] >>",
            (0..pages).map(|i| format!("{} 0 R", 6 + i)).collect::<Vec<_>>().join(" ")
        )
        .into_bytes(),
        format!("<< /Font << {font_entries}>> /ExtGState << /G0 << /CA 1 >> >> >>").into_bytes(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()).into_bytes(),
    ];
    for _ in 0..pages {
        objects.push(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources 3 0 R /Contents 5 0 R >>".to_vec());
    }
    pdf(&objects)
}

/// A built page keeps its dictionary, not its resources: they're read again when the page is
/// interpreted. Each page kept its own parsed dictionaries of fonts and states, 2 KB a page of a
/// report and more the more fonts it lists, so reading a 9,000-page file through held 18 MB.
#[test]
fn a_built_page_keeps_nothing_of_its_resources() {
    let _turn = ONE_AT_A_TIME.lock().unwrap();
    for fonts in [2, 200] {
        let doc = recto::Document::open(document(500, fonts, 10), "").unwrap();
        doc.text(0).unwrap();
        let before = LIVE.load(Relaxed);
        for i in 0..doc.page_count() {
            doc.page_info(i).unwrap();
        }
        let per_page = (LIVE.load(Relaxed) - before) / doc.page_count();
        // 1,061 bytes, either way; 3,001 and 14,738 before.
        assert!(per_page < 1500, "{fonts} fonts: a built page holds {per_page} bytes");
        // And its resources are still there to read.
        assert_eq!(doc.text(doc.page_count() - 1).unwrap().text().trim(), "xxxxxxxxxx");
    }
}

/// A page's glyphs are kept in a buffer the next page fills, but not a buffer past 16,384 glyphs,
/// which would stay as long as the document did: one page of 500,000 glyphs left 92 MB.
#[test]
fn a_large_pages_glyph_buffer_goes_with_it() {
    let _turn = ONE_AT_A_TIME.lock().unwrap();
    let small = recto::Document::open(document(1, 1, 300), "").unwrap();
    small.text(0).unwrap();
    assert!(small.kept_glyph_capacity() >= 300, "a small page's buffer is kept for the next");

    let large = recto::Document::open(document(1, 1, 40_000), "").unwrap();
    let before = LIVE.load(Relaxed);
    let text = large.text(0).unwrap();
    assert_eq!(text.chars.iter().filter(|c| &*c.text == "x").count(), 40_000);
    drop(text);
    assert_eq!(large.kept_glyph_capacity(), 0);
    let held = LIVE.load(Relaxed).saturating_sub(before);
    assert!(held < 1 << 20, "reading the page left {held} bytes held");
    // The next page reads the same without it.
    assert_eq!(large.text(0).unwrap().chars.iter().filter(|c| &*c.text == "x").count(), 40_000);
}
