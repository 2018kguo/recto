//! What each call costs on the files in the given directories: per open, page of text and page drawn,
//! the median time over runs (after one to warm up), with the median, 90th and 99th percentile over
//! pages, and the allocations, reallocations and bytes allocated, counted by a global allocator.
//!
//! `cargo run --release -p recto --example costs -- [--runs 3] [--width 1280] [--text-pages 20]
//! [--render-pages 2] [--only text|render|both|textfirst] dir...`
//!
//! By default each file is opened, its first `--text-pages` read, then opened again and its first
//! `--render-pages` drawn. `both` draws each of those pages and then reads its text, as a viewer does;
//! `textfirst` reads each page's text and then draws it. `COSTS_WORST=n` lists the n slowest items.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Instant;
use std::{env, fs};

struct Counting;
static ALLOCS: AtomicU64 = AtomicU64::new(0);
static REALLOCS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);
static LIVE: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        BYTES.fetch_add(l.size() as u64, Relaxed);
        let live = LIVE.fetch_add(l.size() as u64, Relaxed) + l.size() as u64;
        PEAK.fetch_max(live, Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        BYTES.fetch_add(l.size() as u64, Relaxed);
        let live = LIVE.fetch_add(l.size() as u64, Relaxed) + l.size() as u64;
        PEAK.fetch_max(live, Relaxed);
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size() as u64, Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        REALLOCS.fetch_add(1, Relaxed);
        if n > l.size() {
            BYTES.fetch_add((n - l.size()) as u64, Relaxed);
        }
        let live = LIVE.fetch_add(n as u64, Relaxed) + n as u64 - l.size() as u64;
        LIVE.fetch_sub(l.size() as u64, Relaxed);
        PEAK.fetch_max(live, Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}

#[global_allocator]
static A: Counting = Counting;

#[derive(Default, Clone, Copy)]
struct Cost {
    ns: u128,
    allocs: u64,
    reallocs: u64,
    bytes: u64,
}

fn measure<T>(f: impl FnOnce() -> T) -> (T, Cost) {
    let (a, r, b) = (ALLOCS.load(Relaxed), REALLOCS.load(Relaxed), BYTES.load(Relaxed));
    let t = Instant::now();
    let out = f();
    let ns = t.elapsed().as_nanos();
    (
        out,
        Cost { ns, allocs: ALLOCS.load(Relaxed) - a, reallocs: REALLOCS.load(Relaxed) - r, bytes: BYTES.load(Relaxed) - b },
    )
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        return 0.0;
    }
    v[((v.len() - 1) as f64 * p).round() as usize]
}

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let mut take = |flag: &str, default: &str| -> String {
        if let Some(i) = args.iter().position(|a| a == flag) {
            let v = args.remove(i + 1);
            args.remove(i);
            v
        } else {
            default.to_string()
        }
    };
    let runs: usize = take("--runs", "3").parse().unwrap();
    let width: f32 = take("--width", "1280").parse().unwrap();
    let only = take("--only", "");
    let text_pages: usize = take("--text-pages", "20").parse().unwrap();
    let render_pages: usize = take("--render-pages", "2").parse().unwrap();
    let mut files = Vec::new();
    for dir in &args {
        let mut paths: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
        paths.sort();
        for p in paths {
            if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) {
                files.push((p.file_name().unwrap().to_string_lossy().into_owned(), fs::read(&p).unwrap()));
            }
        }
    }
    // Per (op, file, page): the min-of-runs time; per run: totals.
    let mut per_item: std::collections::BTreeMap<(String, String, usize), (Vec<u128>, Cost)> = Default::default();
    let mut run_totals: Vec<[u128; 3]> = Vec::new();
    for run in 0..runs + 1 {
        let mut totals = [0u128; 3];
        for (name, bytes) in &files {
            let (doc, c) = measure(|| recto::Document::open(bytes.clone(), ""));
            let Ok(doc) = doc else { continue };
            totals[0] += c.ns;
            per_item.entry(("open".into(), name.clone(), 0)).or_insert_with(|| (Vec::new(), c)).0.push(c.ns);
            if only != "render" && only != "both" && only != "textfirst" {
                for i in 0..doc.page_count().min(text_pages) {
                    let (_t, c) = measure(|| doc.text(i));
                    totals[1] += c.ns;
                    per_item.entry(("text".into(), name.clone(), i)).or_insert_with(|| (Vec::new(), c)).0.push(c.ns);
                }
            }
            drop(doc);
            if only != "text" {
                let doc = recto::Document::open(bytes.clone(), "").unwrap();
                for i in 0..doc.page_count().min(render_pages) {
                    if only == "textfirst" {
                        let (_t, c) = measure(|| doc.text(i));
                        totals[1] += c.ns;
                        per_item.entry(("text".into(), name.clone(), i)).or_insert_with(|| (Vec::new(), c)).0.push(c.ns);
                    }
                    let (_b, c) = measure(|| doc.render(i, width, 16384.0));
                    totals[2] += c.ns;
                    per_item.entry(("render".into(), name.clone(), i)).or_insert_with(|| (Vec::new(), c)).0.push(c.ns);
                    if only == "both" {
                        // A viewer: the page drawn, then its text layer.
                        let (_t, c) = measure(|| doc.text(i));
                        totals[1] += c.ns;
                        per_item.entry(("text".into(), name.clone(), i)).or_insert_with(|| (Vec::new(), c)).0.push(c.ns);
                    }
                }
            }
        }
        if run > 0 {
            run_totals.push(totals);
        }
    }
    for (k, op) in ["open", "text", "render"].iter().enumerate() {
        let mut ms: Vec<f64> = Vec::new();
        let (mut allocs, mut reallocs, mut bytes, mut n) = (0u64, 0u64, 0u64, 0u64);
        let mut worst: Vec<(f64, String)> = Vec::new();
        for ((o, f, p), (times, c)) in &per_item {
            if o != op {
                continue;
            }
            // skip the warm-up run
            let mut t: Vec<f64> = times.iter().skip(1).map(|&x| x as f64 / 1e6).collect();
            let med = pct(&mut t, 0.5);
            ms.push(med);
            worst.push((med, format!("{f} p{p}")));
            allocs += c.allocs;
            reallocs += c.reallocs;
            bytes += c.bytes;
            n += 1;
        }
        if n == 0 {
            continue;
        }
        let tot: Vec<f64> = run_totals.iter().map(|t| t[k] as f64 / 1e6).collect();
        let sum: f64 = ms.iter().sum();
        worst.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
        println!(
            "{op:6} n={n:4} total_med={:8.1}ms runs=[{}] p50={:.3} p90={:.3} p99={:.3} ms | allocs/item={:.0} reallocs/item={:.0} MB/item={:.2}",
            sum,
            tot.iter().map(|t| format!("{t:.1}")).collect::<Vec<_>>().join(","),
            pct(&mut ms.clone(), 0.5),
            pct(&mut ms.clone(), 0.9),
            pct(&mut ms, 0.99),
            allocs as f64 / n as f64,
            reallocs as f64 / n as f64,
            bytes as f64 / n as f64 / 1e6
        );
        if env::var("COSTS_WORST").is_ok() {
            for (t, w) in worst.iter().take(env::var("COSTS_WORST").unwrap().parse().unwrap_or(8)) {
                println!("    {t:8.2} ms {w}");
            }
        }
    }
    println!("peak live heap {:.1} MB", PEAK.load(Relaxed) as f64 / 1e6);
}
