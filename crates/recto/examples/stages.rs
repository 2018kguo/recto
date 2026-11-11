//! One stage of the pipeline at a time, over the files in the given directories, so a change to
//! one shows in its own number rather than in a whole render's noise:
//!
//! - `inflate`: every Flate stream in each file, decoded from its raw bytes.
//! - `lex`: each page's decoded content, split into operators and operands.
//! - `interpret`: each page run through the interpreter onto a device that draws nothing.
//! - `raster`: each page's recorded scene rasterized into a buffer kept from the last.
//! - `render`: `Document::render`, all of it. `text`: `Document::text`.
//!
//! Inputs are prepared before the clock starts. Prints each stage's total, the median over
//! runs (after one to warm up), and the median and 90th percentile over items.
//!
//! `cargo run --release -p recto --example stages -- [--stages lex,raster] [--runs 5]
//! [--width 1024] [--pages 3] dir...`
use std::time::Instant;
use std::{env, fs};

use hayro::hayro_interpret::font::GlyphRun;
use hayro::hayro_interpret::hayro_syntax::Pdf;
use hayro::hayro_interpret::hayro_syntax::content::UntypedIter;
use hayro::hayro_interpret::hayro_syntax::object::Object;
use hayro::hayro_interpret::util::TransformExt;
use hayro::hayro_interpret::{
    BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image, ImageDrawProps, InterpreterCache,
    InterpreterSettings, SoftMask, interpret_page,
};
use hayro::kurbo::{BezPath, Rect};
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings};

/// Takes everything the interpreter emits and draws none of it.
struct Nothing;

impl<'a> Device<'a> for Nothing {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_glyph_run(&mut self, _: &GlyphRun<'_, 'a>, _: DrawProps<'a>, _: &DrawMode) {}
    fn draw_image(&mut self, _: Image<'a, '_>, _: ImageDrawProps<'a>) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.total_cmp(b));
    if v.is_empty() { 0.0 } else { v[((v.len() - 1) as f64 * p).round() as usize] }
}

/// Times `f` on each of `n` items, `runs` times after a warm-up; prints the stage's line.
fn stage(name: &str, n: usize, runs: usize, mut f: impl FnMut(usize)) {
    let mut per_item = vec![Vec::new(); n];
    let mut totals = Vec::new();
    for run in 0..=runs {
        let mut total = 0.0;
        for (i, times) in per_item.iter_mut().enumerate() {
            let t = Instant::now();
            f(i);
            let ms = t.elapsed().as_secs_f64() * 1e3;
            total += ms;
            if run > 0 {
                times.push(ms);
            }
        }
        if run > 0 {
            totals.push(total);
        }
    }
    let mut items: Vec<f64> = per_item.iter_mut().map(|t| pct(t, 0.5)).collect();
    let runs_list = totals.iter().map(|t| format!("{t:.1}")).collect::<Vec<_>>().join(",");
    println!(
        "{name:9} n={n:4} total_med={:9.1}ms runs=[{runs_list}] p50={:.3} p90={:.3} ms",
        pct(&mut totals, 0.5),
        pct(&mut items.clone(), 0.5),
        pct(&mut items, 0.9),
    );
}

fn main() {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let mut take = |flag: &str, default: &str| -> String {
        match args.iter().position(|a| a == flag) {
            Some(i) => {
                let v = args.remove(i + 1);
                args.remove(i);
                v
            }
            None => default.to_string(),
        }
    };
    let stages = take("--stages", "inflate,lex,interpret,raster,render,text");
    let runs: usize = take("--runs", "5").parse().unwrap();
    let width: f32 = take("--width", "1024").parse().unwrap();
    let pages: usize = take("--pages", "3").parse().unwrap();
    let mut files = Vec::new();
    for dir in &args {
        let mut paths: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
        paths.sort();
        files.extend(paths.into_iter().filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"))));
    }
    let bytes: Vec<Vec<u8>> = files.iter().map(|p| fs::read(p).unwrap()).collect();
    let pdfs: Vec<Pdf> = bytes.iter().filter_map(|b| Pdf::new(b.clone()).ok()).collect();
    let page_list: Vec<(usize, usize)> =
        pdfs.iter().enumerate().flat_map(|(d, pdf)| (0..pdf.pages().len().min(pages)).map(move |p| (d, p))).collect();
    let page = |(d, p): (usize, usize)| pdfs[d].pages().get(p).unwrap();
    let settings = |(d, p): (usize, usize)| {
        let (w, h) = page((d, p)).render_dimensions();
        let scale = (width / w).min(16384.0 / h);
        PixmapSettings { x_scale: scale, y_scale: scale, bg_color: WHITE, window: None }
    };

    for name in stages.split(',') {
        match name {
            "inflate" => {
                let raw: Vec<Vec<u8>> = pdfs
                    .iter()
                    .flat_map(|pdf| pdf.objects().into_iter())
                    .filter_map(|o| match o {
                        Object::Stream(s) => Some(s.raw_data().into_owned()),
                        _ => None,
                    })
                    .filter(|r| hayro::hayro_syntax::flate_decode(r).is_some())
                    .collect();
                stage(name, raw.len(), runs, |i| drop(hayro::hayro_syntax::flate_decode(&raw[i])));
            }
            "lex" => {
                let content: Vec<_> = page_list.iter().map(|&k| page(k).page_stream().unwrap_or_default()).collect();
                stage(name, content.len(), runs, |i| {
                    let (mut ops, mut iter) = (0u32, UntypedIter::new(&content[i]));
                    while iter.next().is_some() {
                        ops += 1;
                    }
                    std::hint::black_box(ops);
                });
            }
            "interpret" => {
                let caches: Vec<InterpreterCache> = pdfs.iter().map(|_| InterpreterCache::new()).collect();
                stage(name, page_list.len(), runs, |i| {
                    let k = page_list[i];
                    let p = page(k);
                    let (w, h) = p.render_dimensions();
                    let mut ctx = Context::new(
                        p.initial_transform(true).to_kurbo(),
                        Rect::new(0.0, 0.0, w as f64, h as f64),
                        &caches[k.0],
                        p.xref(),
                        InterpreterSettings::default(),
                    );
                    interpret_page(p, &mut ctx, &mut Nothing);
                });
            }
            "raster" => {
                let caches: Vec<RenderCache> = pdfs.iter().map(|_| RenderCache::new()).collect();
                let mut scenes: Vec<_> = page_list
                    .iter()
                    .map(|&k| {
                        let s = settings(k);
                        hayro::record(page(k), &caches[k.0], &InterpreterSettings::default(), &RenderSettings::default(), &s)
                    })
                    .collect();
                let mut rgba = Vec::new();
                stage(name, scenes.len(), runs, |i| {
                    scenes[i].rasterize(&mut rgba);
                });
            }
            "render" | "text" => {
                let docs: Vec<recto::Document> = bytes.iter().filter_map(|b| recto::Document::open(b.clone(), "").ok()).collect();
                let items: Vec<(usize, usize)> =
                    docs.iter().enumerate().flat_map(|(d, doc)| (0..doc.page_count().min(pages)).map(move |p| (d, p))).collect();
                stage(name, items.len(), runs, |i| {
                    let (d, p) = items[i];
                    if name == "render" {
                        drop(docs[d].render(p, width, 16384.0));
                    } else {
                        drop(docs[d].text(p));
                    }
                });
            }
            other => panic!("no stage {other}"),
        }
    }
}
