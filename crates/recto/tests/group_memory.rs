//! What a page of many non-isolated groups that need their backdrop holds at its peak. Each such
//! group draws the page again up to itself for its backdrop; the groups before it in that drawing
//! paint the result kept from the page's own drawing, cut to where they paint, rather than drawing
//! their contents and backdrops again and holding page-sized pixmaps for each. A page of 16 small
//! drop shadows took 280 MB at 1000 px wide, from 12 MB for one. Its own process (an integration
//! test is its own binary), so the counting allocator sees only this.
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

fn pdf(objects: &[String]) -> Vec<u8> {
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for o in offsets {
        out.extend_from_slice(format!("{o:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer << /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    out
}

fn stream(dict: &str, data: &str) -> String {
    format!("<< {dict} /Length {} >>\nstream\n{data}\nendstream", data.len())
}

/// A 100 pt square page, yellow, with `groups` 10 pt squares on a grid: each a non-isolated group
/// filling cyan with a multiply inside, under a luminosity mask of 50% grey, so it needs its backdrop.
fn page_of_groups(groups: usize) -> Vec<u8> {
    let mut content = String::from("1 1 0 rg 0 0 100 100 re f\n");
    for i in 0..groups {
        content += &format!("q 1 0 0 1 {} {} cm /Shadow gs /G Do Q\n", 2 + i % 6 * 16, 2 + i / 6 * 16);
    }
    pdf(&[
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << /XObject << /G 5 0 R >> /ExtGState << /Shadow << /SMask << /Type /Mask /S /Luminosity /G 6 0 R >> >> >> >> >>".into(),
        stream("", &content),
        stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Group << /S /Transparency >> /Resources << /ExtGState << /Mul << /BM /Multiply >> >> >>",
            "/Mul gs 0 1 1 rg 1 1 8 8 re f",
        ),
        stream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Group << /S /Transparency /CS /DeviceRGB >>", "0.5 g 0 0 10 10 re f"),
    ])
}

const WIDTH: f32 = 1000.0;

/// The render's peak past what was live before it, and the bitmap.
fn render_peak(groups: usize) -> (usize, recto::Bitmap) {
    let doc = recto::Document::open(page_of_groups(groups), "").unwrap();
    let before = LIVE.load(Relaxed);
    PEAK.store(before, Relaxed);
    let bitmap = doc.render(0, WIDTH, f32::INFINITY).unwrap();
    let peak = PEAK.load(Relaxed) - before;
    assert!(!bitmap.truncated);
    (peak, bitmap)
}

fn pixel(bitmap: &recto::Bitmap, x: f32, y: f32) -> [u8; 3] {
    let scale = bitmap.width as f32 / 100.0;
    let (x, y) = ((x * scale) as usize, ((100.0 - y) * scale) as usize);
    let at = (y * bitmap.width as usize + x) * 4;
    [bitmap.rgba[at], bitmap.rgba[at + 1], bitmap.rgba[at + 2]]
}

/// Each group past the first costs under 2 bytes a page pixel at the peak: its mask (1 byte a pixel,
/// held until the page is rasterized) and its result where it paints. Before, it was a backdrop, a
/// result and a drawing of every group before it, all page-sized: over 12 bytes a pixel each, and
/// time that grew with the square of their number. One test, as the counter is the process's.
#[test]
fn a_page_of_backdrop_groups_holds_a_bounded_amount() {
    let (few, _) = render_peak(3);
    let (many, bitmap) = render_peak(24);
    let page = bitmap.width as usize * bitmap.height as usize;
    let per_group = (many.saturating_sub(few)) / 21;
    assert!(per_group < 2 * page, "{per_group} bytes a group past the first, for a page of {page} px ({few} for 3, {many} for 24)");

    // Every group paints its own result in its own place: multiply's green, half over the yellow.
    let first = pixel(&bitmap, 7.0, 7.0);
    assert!(first[0] > 100 && first[0] < 160 && first[1] > 240 && first[2] < 10, "{first:?}");
    for i in 0..24 {
        let (x, y) = (2.0 + (i % 6 * 16) as f32, 2.0 + (i / 6 * 16) as f32);
        assert_eq!(pixel(&bitmap, x + 5.0, y + 5.0), first, "group {i}");
        assert_eq!(pixel(&bitmap, x + 12.0, y + 5.0), [255, 255, 0], "beside group {i}");
    }
}
