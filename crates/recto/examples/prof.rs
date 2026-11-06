// One process, every PDF in a directory, warm: the profiling target and a
// native bench for the hot paths.
//
//   CARGO_PROFILE_RELEASE_DEBUG=true cargo build --release --example prof
//   samply record target/release/examples/prof <dir> scan 5
//   target/release/examples/prof <dir> all 5   # ms per capability
//
// Capabilities: text (60 pages), scan (60 pages, objects + annotations),
// render (4 pages at 1024 px), all, and digest: a hash of every char
// (text, box, flags, angle, fill), word, object column and render, so a
// speedup can be proven output-identical against a baseline build.

use std::time::Instant;

use recto::Document;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = args
        .get(1)
        .expect("usage: prof <dir> [text|scan|render|all] [runs]");
    let what = args.get(2).map_or("all", String::as_str);
    let runs: usize = args.get(3).and_then(|r| r.parse().ok()).unwrap_or(3);
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .expect("dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "pdf"))
        .collect();
    files.sort();
    let docs: Vec<Vec<u8>> = files.iter().map(|p| std::fs::read(p).unwrap()).collect();
    if what == "digest" {
        use std::hash::{Hash, Hasher};
        let mut total = std::collections::hash_map::DefaultHasher::new();
        let mut ranged_open = (0usize, 0usize);
        for (path, bytes) in files.iter().zip(&docs) {
            let mut h = std::collections::hash_map::DefaultHasher::new();
            // RANGED=1: open by range, as `openRanged` does; the digest must not change.
            let fetched = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let opened = if std::env::var_os("RANGED").is_some() {
                let (file, count) = (std::sync::Arc::new(bytes.clone()), fetched.clone());
                let fill = move |at: usize, out: &mut [u8]| {
                    count.fetch_add(out.len(), std::sync::atomic::Ordering::Relaxed);
                    out.copy_from_slice(&file[at..at + out.len()]);
                    true
                };
                Document::open_ranged(
                    bytes.len(),
                    std::env::var("CHUNK")
                        .ok()
                        .and_then(|c| c.parse().ok())
                        .unwrap_or(64 * 1024),
                    Box::new(fill),
                    "",
                )
            } else {
                Document::open(bytes.clone(), "")
            };
            if std::env::var_os("RANGED").is_some() {
                let at_open = fetched.load(std::sync::atomic::Ordering::Relaxed);
                ranged_open.0 += at_open;
                ranged_open.1 += bytes.len();
                if bytes.len() > 4 << 20 || std::env::var_os("OPEN_ALL").is_some() {
                    println!(
                        "open {:>9} of {:>9} {}",
                        at_open,
                        bytes.len(),
                        path.display()
                    );
                }
            }
            if let Ok(doc) = opened {
                for i in 0..doc.page_count().min(60) {
                    let Ok(s) = doc.scan(i, true, true) else {
                        continue;
                    };
                    for c in &s.text.chars {
                        c.text.hash(&mut h);
                        c.bbox.map(f32::to_bits).hash(&mut h);
                        (
                            c.flags,
                            c.angle.to_bits(),
                            c.fill,
                            c.font,
                            c.run,
                            c.em.to_bits(),
                        )
                            .hash(&mut h);
                    }
                    s.text.words.len().hash(&mut h);
                    let o = &s.objects;
                    (
                        o.text_objects,
                        &o.path_flags,
                        &o.path_start,
                        o.path_boxes.len(),
                    )
                        .hash(&mut h);
                    o.path_boxes
                        .iter()
                        .map(|v| v.to_bits())
                        .collect::<Vec<_>>()
                        .hash(&mut h);
                    s.annotations.len().hash(&mut h);
                }
                for i in 0..doc.page_count().min(2) {
                    if let Ok(b) = doc.render(i, 512.0, 2048.0) {
                        (b.width, b.height, &b.rgba).hash(&mut h);
                    }
                }
            }
            let d = h.finish();
            d.hash(&mut total);
            if std::env::var_os("DIGEST_EACH").is_some() {
                println!("{d:016x} {}", path.display());
            }
        }
        if ranged_open.1 > 0 {
            println!(
                "ranged open fetched {} of {} bytes",
                ranged_open.0, ranged_open.1
            );
        }
        println!("digest {:016x}", total.finish());
        return;
    }
    if what == "dump" {
        // Every char and word of every page as text lines, for `bench/same.py`:
        // a speedup that moves float low bits must keep text, flags, ids and
        // words exact and boxes within its tolerance.
        use std::io::Write;
        let mut out = std::io::BufWriter::new(std::io::stdout().lock());
        for (path, bytes) in files.iter().zip(&docs) {
            let name = path.file_name().unwrap().to_string_lossy();
            let Ok(doc) = Document::open(bytes.clone(), "") else {
                writeln!(out, "{name} open-error").unwrap();
                continue;
            };
            // DUMP_TEXT: the text pass alone (`Document::text`, the text-only
            // interpreter), without the objects line, to diff against a scan.
            let text_only = std::env::var_os("DUMP_TEXT").is_some();
            for i in 0..doc.page_count().min(60) {
                let s = if text_only {
                    doc.text(i).map(|text| recto::Scan {
                        text,
                        objects: Default::default(),
                        annotations: Vec::new(),
                    })
                } else {
                    doc.scan(i, true, true)
                };
                let Ok(s) = s else {
                    writeln!(out, "{name} {i} scan-error").unwrap();
                    continue;
                };
                for c in &s.text.chars {
                    let [x, y, w, h] = c.bbox;
                    writeln!(
                        out,
                        "{name} {i} c {:?} {} {} {} {} {} {x} {y} {w} {h} {} {}",
                        &*c.text, c.code, c.flags, c.fill, c.font, c.run, c.em, c.angle
                    )
                    .unwrap();
                }
                for w in &s.text.words {
                    let [x, y, ww, h] = w.bbox;
                    writeln!(out, "{name} {i} w {} {} {x} {y} {ww} {h}", w.start, w.end).unwrap();
                }
                if text_only {
                    continue;
                }
                let o = &s.objects;
                writeln!(
                    out,
                    "{name} {i} o {} {:?} {:?} {}",
                    o.text_objects,
                    o.path_flags,
                    o.path_start,
                    o.path_boxes.len()
                )
                .unwrap();
            }
        }
        return;
    }
    if what == "floor" {
        // The floor for any interpreter over hayro-syntax: decode each page's
        // content stream (cold, as the text pass does), then tokenize it.
        for stage in ["decode", "tokenize", "typed", "lex"] {
            let mut best = f64::INFINITY;
            for _ in 0..runs {
                let t = Instant::now();
                let mut n = 0usize;
                for bytes in &docs {
                    let Ok(pdf) = hayro::hayro_syntax::Pdf::new(bytes.clone()) else {
                        continue;
                    };
                    for page in pdf.pages().iter().take(60) {
                        match stage {
                            "decode" => n += page.page_stream().map_or(0, <[u8]>::len),
                            "lex" => {
                                if let Some(d) = page.page_stream() {
                                    let mut l = hayro::hayro_interpret::lex::Lexer::new(d);
                                    while l.next().is_some() {
                                        n += 1;
                                    }
                                }
                            }
                            "tokenize" => {
                                let mut it = page.operations();
                                while it.next().is_some() {
                                    n += 1;
                                }
                            }
                            _ => {
                                let mut it = page.typed_operations();
                                while it.next().is_some() {
                                    n += 1;
                                }
                            }
                        }
                    }
                }
                std::hint::black_box(n);
                best = best.min(t.elapsed().as_secs_f64() * 1e3);
            }
            println!("{stage}: {best:.0} ms");
        }
        return;
    }
    if what == "perdoc" || what == "perdocscan" {
        let full = what == "perdocscan";
        // Time, pages and chars per document: ns per char exposes the slow
        // paths and anything super-linear.
        for (path, bytes) in files.iter().zip(&docs) {
            let mut best = f64::INFINITY;
            let (mut pages, mut chars) = (0, 0);
            for _ in 0..runs {
                let t = Instant::now();
                let Ok(doc) = Document::open(bytes.clone(), "") else {
                    break;
                };
                pages = doc.page_count().min(60);
                chars = (0..pages)
                    .filter_map(|i| {
                        if full {
                            doc.scan(i, true, true).ok().map(|s| s.text)
                        } else {
                            doc.text(i).ok()
                        }
                    })
                    .map(|p| p.chars.len())
                    .sum();
                best = best.min(t.elapsed().as_secs_f64() * 1e3);
            }
            if best.is_finite() {
                println!(
                    "{best:8.2} ms {pages:3} pages {chars:7} chars {:8.0} ns/char  {}",
                    best * 1e6 / chars.max(1) as f64,
                    path.file_name().unwrap().to_string_lossy()
                );
            }
        }
        return;
    }
    let caps: &[&str] = if what == "all" {
        &["text", "scan", "render"]
    } else {
        std::slice::from_ref(&what)
    };
    for cap in caps {
        let mut best = f64::INFINITY;
        for _ in 0..runs {
            let t = Instant::now();
            for bytes in &docs {
                let Ok(doc) = Document::open(bytes.clone(), "") else {
                    continue;
                };
                let n = doc.page_count();
                match *cap {
                    "text" => (0..n.min(60)).for_each(|i| drop(doc.text(i))),
                    "scan" => (0..n.min(60)).for_each(|i| drop(doc.scan(i, true, true))),
                    "render" => (0..n.min(4)).for_each(|i| drop(doc.render(i, 1024.0, 4096.0))),
                    other => panic!("unknown capability {other}"),
                }
            }
            best = best.min(t.elapsed().as_secs_f64() * 1e3);
        }
        println!("{cap}: {best:.0} ms (best of {runs})");
    }
}
