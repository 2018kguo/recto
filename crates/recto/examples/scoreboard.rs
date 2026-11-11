//! The native half of `scripts/scoreboard.mjs`, which copies this file into the tree it measures, so
//! it may use only the API every compared version has. Prints one line of JSON.
//!
//! `speed --pages N --widths 1024,1600 file...`: per file, the open, then each of its first N pages'
//! text, then each drawn at each width, each timed once; and the peak live heap over all of it.
//! `whole --reps N file...`: per file, the median over N of opening it, reading every page's text
//! and drawing every page at 1024 px.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Instant;
use std::{env, fs};

struct Counting;
static LIVE: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        PEAK.fetch_max(LIVE.fetch_add(l.size() as u64, Relaxed) + l.size() as u64, Relaxed);
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        PEAK.fetch_max(LIVE.fetch_add(l.size() as u64, Relaxed) + l.size() as u64, Relaxed);
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size() as u64, Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let live = LIVE.fetch_add(n as u64, Relaxed) + n as u64;
        PEAK.fetch_max(live, Relaxed);
        LIVE.fetch_sub(l.size() as u64, Relaxed);
        unsafe { System.realloc(p, l, n) }
    }
}

#[global_allocator]
static A: Counting = Counting;

fn ms(t: Instant) -> String {
    format!("{:.4}", t.elapsed().as_secs_f64() * 1e3)
}

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let mode = args.remove(0);
    let mut take = |flag: &str, default: &str| match args.iter().position(|a| a == flag) {
        Some(i) => {
            let v = args.remove(i + 1);
            args.remove(i);
            v
        }
        None => default.to_string(),
    };
    let pages: usize = take("--pages", "100").parse().unwrap();
    let reps: usize = take("--reps", "3").parse().unwrap();
    let widths: Vec<f32> = take("--widths", "1024,1600").split(',').map(|w| w.parse().unwrap()).collect();
    let mut files = Vec::new();
    for path in &args {
        let bytes = fs::read(path).unwrap();
        if mode == "whole" {
            let mut times: Vec<f64> = (0..reps)
                .map(|_| {
                    let t = Instant::now();
                    if let Ok(doc) = recto::Document::open(bytes.clone(), "") {
                        for i in 0..doc.page_count() {
                            drop(doc.text(i));
                            drop(doc.render(i, 1024.0, 16384.0));
                        }
                    }
                    t.elapsed().as_secs_f64() * 1e3
                })
                .collect();
            times.sort_by(f64::total_cmp);
            files.push(format!("{:.4}", times[times.len() / 2]));
            continue;
        }
        let t = Instant::now();
        let Ok(doc) = recto::Document::open(bytes, "") else {
            files.push("null".into());
            continue;
        };
        let open = ms(t);
        let n = doc.page_count().min(pages);
        let text: Vec<String> = (0..n)
            .map(|i| {
                let t = Instant::now();
                drop(doc.text(i));
                ms(t)
            })
            .collect();
        let render: Vec<String> = widths
            .iter()
            .map(|&w| {
                let times: Vec<String> = (0..n)
                    .map(|i| {
                        let t = Instant::now();
                        drop(doc.render(i, w, 16384.0));
                        ms(t)
                    })
                    .collect();
                format!("[{}]", times.join(","))
            })
            .collect();
        files.push(format!(r#"{{"open":{open},"text":[{}],"render":[{}]}}"#, text.join(","), render.join(",")));
    }
    println!(r#"{{"files":[{}],"peakHeapBytes":{}}}"#, files.join(","), PEAK.load(Relaxed));
}
