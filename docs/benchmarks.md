# Benchmarks

recto 0.7.1 against pdf.js 6.5.438, stock pdfium (`@embedpdf/pdfium` 2.15.1) and MuPDF 1.28.1 (Artifex's
`mupdf` package, its own WebAssembly build), measured November 12–13, 2026 on an Apple M5 Pro (18 cores, 64 GB),
macOS 26.6.1, Node 25.9.0 and Chromium 156. MuPDF is licensed under the AGPL-3.0 (with a commercial licence from
Artifex); recto is MIT, pdf.js Apache-2.0, pdfium BSD-3-Clause (the `@embedpdf/pdfium` build MIT). The other engines are dev
dependencies of the benchmark only, in `bench/package.json`.

## At a glance

How recto compares with each, from the tables below. A ratio is the other engine's time or size over recto's, so
above 1× recto is ahead; **bold** is where recto loses. "Level" means the 95% interval holds 1.

| | pdf.js | pdfium | MuPDF |
|---|---|---|---|
| **Size**: download with brotli, text only | level (0.42 MB each) | 4.0× smaller | 8.7× smaller |
| **Size**: download with brotli, text and pixels | **pdf.js 0.30 MB smaller** (0.42 against 0.72) | 2.4× smaller | 5.1× smaller |
| **Cold start**: a fresh Node process to the first text | 3.9× | level (1.03×) | level (1.04×) |
| **Cold start**: a fresh Node process to the first pixels | 3.6× | level (1.01×) | **MuPDF 7% faster** (72 against 77 ms) |
| **Cold start**: a fresh Chromium page to the first text, slowed 3.8× | 1.5× | 1.09× (interval 0.99–1.18) | 1.09× (interval 0.93–1.16) |
| **Cold start**: a fresh Chromium page to the first pixels, slowed 3.8× | 1.5× | **pdfium 7% faster** | **MuPDF 15% faster** |
| **Open**: a 2,000-page report in Node | 14× | 1.17× (interval 0.97–1.25) | 1.8× |
| **Open**: a 500-page report in Chromium | 7.5× | **pdfium faster**, 0.3 against 0.4 ms, at the timer's 0.1 ms | 1.5× |
| **Render**: 50 pages at 1024 px in Node | 7.3× | 6.1× | 6.1× |
| **Render**: 15 pages at 800 px in Chromium | 4.9× | 1.3× | 1.5× |
| **Render**: 5 pages of the 2,000-page report in Node | 3.0× | level (1.06×) | **MuPDF 26% faster** (21 against 28 ms) |
| **Text**: 296 pages in Node | 4.6× | 2.5× | 2.9× |
| **Text**: 79 pages in Chromium | 3.3× | 2.7× | 2.9× |
| **Memory**: peak of a Node process, 29 documents | 2.3× less | **pdfium 6% less** (280 against 298 MB) | 1.8× less |
| **Memory**: peak, the 2,000-page report | 2.1× less | **pdfium 11% less** (195 against 218 MB) | level (1.02×) |
| **Memory**: left with a 40-page report open in Chromium | **pdf.js holds 12.6 MB less WebAssembly** (none) | 1.5× less | 2.2× less |
| **Stopping a slow render** on the same thread, Node | 0.3 against 1,921 ms | 0.3 against 3.1 ms (by `terminate()`) | 0.3 against 1.7 ms (by `terminate()`) |
| **Robustness**: 7,000 web PDFs, files worse than another engine | 0 against 13 | 0 against 6 | 0 against 7 |
| **Fidelity**: agrees with two other engines, of 531 small, mostly adversarial files | 95.6% against 87.0% | 95.6% against 88.6% | 95.6% against 83.8% |
| **Text**: F1 against poppler, 84 documents | 98.55% against 97.84% | 98.55% against 98.33% | 98.55% against 97.35% |
| **Text**: F1 against poppler, the 25 public documents alone | level (99.60% against 99.49%) | level (99.54%) | level (99.59%) |
| **Char boxes**: IoU against the ink, median | not measured (items, not chars) | level (0.846 against 0.848) | 0.846 against 0.826 (`accurate-bboxes`) |

What to take from it: recto is fastest at reading text and drawing pages in bulk, by 2.5–7× in Node, and of 7,000 web
PDFs it did worse than another engine on none. It ties pdfium and MuPDF to a first page in a fresh process, and loses the first pixels in
a fresh browser page by 7–15% slowed. MuPDF draws the generated report's image pages faster, and pdfium holds a
little less memory. pdf.js downloads 0.30 MB less to draw, and holds no WebAssembly memory. The fidelity score has a
built-in lean, explained in [the scorecard](#the-scorecard): read it as "rarely the odd one out", not "most correct".

Each row, one command (after `npm run build`; PDFs aren't committed, so bring your own, as `pdfs/` here):

```sh
npm run bench -- pdfs --runs 7 --max-load 8 --min-idle 55                       # Node: cold start, open, render, text, memory, stopping
npm run bench:browser -- pdfs --runs 7 --max-load 8 --min-idle 55               # Chromium slowed, and what a page downloads (--slowdown 1 for full speed)
node bench/wild.mjs fetch && node bench/wild.mjs run --jobs 6 --results out.json # robustness, 7,000 web PDFs
node bench/scorecard.mjs pub=pdfs --engines recto,pdfium,pdf.js,poppler,mupdf --out scratch  # fidelity
node bench/text-compare.mjs pdfs                                                 # text against poppler
node bench/box-compare.mjs pdfs --tight                                          # char boxes
```

## How it was measured

Timed numbers are medians of 7 rounds, each in a fresh process or page, with the engines taking turns round by
round. The brackets are 95% confidence intervals on the ratio to recto, bootstrapped: resampled from the rounds to
see how much the ratio could move. The machine was shared: an indexer kept the 1-minute load average between about
10 and 30 throughout, while leaving most of the 18 cores idle. So each measured process started only when the
1-minute load was under 8 **or** the CPUs were at least 55% idle over a second (`--max-load 8 --min-idle 55`,
`bench/quiet.mjs`); the results record what each started at. Read the ratios, not the absolute times, which are
higher than a quiet machine's. The raw results are in [`bench/results/`](../bench/results), with files named by hash
only. A megabyte here is 10^6 bytes.

The timed PDFs are the 29 public documents of the scoreboard's `pub` set (25 MB), which all four engines open, and
generated ones. [Text quality](#text-quality), [the scorecard](#the-scorecard), [character boxes](#character-boxes)
and [real-world files](#real-world-files) use the sets they name. Sections marked as not rerun keep the version and
the set they were measured on, and aren't comparable with the tables here.

## In Node

recto 0.7.1, Node 25.9.0 on macOS 26.6.1, 7 rounds, November 13. Every engine runs on the calling thread: pdf.js
with its fake worker, drawing through `@napi-rs/canvas`; pdfium through its `FPDF_` functions; MuPDF through its own
JavaScript API. All four end with the same thing, a page's text or its RGBA bytes. The PDFs are the 29 public
documents of the [scoreboard](#the-scoreboard)'s `pub` set (25 MB), which all four open, and generated ones.

| | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| Text, first 20 pages of each (296 pages) | 213 ms | 977 ms (4.6× [4.4–4.9]) | 532 ms (2.5× [2.4–2.6]) | 622 ms (2.9× [2.8–3.0]) |
| Render at 1024 px, first 2 pages of each (50 pages) | 139 ms | 1,023 ms (7.3× [6.6–7.7]) | 849 ms (6.1× [5.9–6.5]) | 844 ms (6.1× [5.8–6.3]) |
| A fresh process to the first page's text | 62.0 ms | 240 ms (3.9× [3.1–4.8]) | 64.1 ms (1.03× [1.00–1.11]) | 64.5 ms (1.04× [1.02–1.11]) |
| A fresh process to the first page's pixels | 77.2 ms | 278 ms (3.6× [3.0–4.2]) | 78.0 ms (1.01× [0.98–1.08]) | **72.1 ms (0.93× [0.92–0.99])** |
| Warm: open, first page's text, close | 0.5 ms | 4.7 ms (9.1× [7.9–11]) | 1.1 ms (2.1× [2.0–2.3]) | 1.6 ms (3.0× [2.9–3.2]) |
| Warm: open, first page's pixels, close | 2.4 ms | 13.3 ms (5.5× [5.1–6.8]) | 3.5 ms (1.5× [1.4–1.6]) | 3.3 ms (1.4× [1.3–1.4]) |
| 2,000-page report: open | 3.0 ms | 41.9 ms (14× [12–15]) | 3.5 ms (1.17× [0.97–1.25]) | 5.4 ms (1.8× [1.5–1.9]) |
| 2,000-page report: every page's text | 557 ms | 1,682 ms (3.0× [2.8–3.5]) | 820 ms (1.5× [1.4–1.6]) | 1,005 ms (1.8× [1.7–1.9]) |
| 2,000-page report: render 5 pages | 28.2 ms | 85.5 ms (3.0× [2.6–3.3]) | 29.8 ms (1.06× [0.93–1.08]) | **20.8 ms (0.74× [0.65–0.81])** |

- **The machine.** An Apple M5 Pro, 18 cores, 64 GB, shared with an indexer that keeps the load average high while
  leaving most cores idle. Each measured process started only when the 1-minute load was under 8 or the CPUs were at
  least 55% idle over a second (`--max-load 8 --min-idle 55`); at the 140 starts the load's median was 20.5 and the
  idle share's 71% (55% at the least). The engines take turns round by round, so what the machine did falls on all
  four; read the ratios. Absolute times are higher than this page's earlier tables (a fresh process's first text was
  30.7 ms then), which were on Node 24 at a load of 2.
- **Totals**, not per-file medians, so a slow file counts for what it costs. A warm-up pass comes
  first, and the buffer copies are outside the clock. The brackets are 95% intervals on the ratio, bootstrapped
  from the 7 rounds.
- **The columns differ.** recto's text call also builds every char's box and the word columns;
  pdf.js's `getTextContent` builds its items; pdfium's `FPDFText_GetText` returns a string; MuPDF's
  `toStructuredText().asText()` builds its blocks and lines, then a string. MuPDF renders with alpha, the paper
  left clear, which every reader here composites over white.
- **The characters** agree: 802,592 in recto, 802,596 in pdf.js, 802,603 in pdfium and 802,699 in MuPDF, not
  counting whitespace, over the same pages. That's a count. [Text quality](#text-quality) compares the words.
- **Where recto loses.** MuPDF draws the 2,000-page report's 5 pages in 20.8 ms against recto's 28.2 (each page is
  text and, every 10th, a 240-px image), and is first to a fresh process's pixels by 5 ms, 72.1 against 77.2.
  A fresh process's first text is level with pdfium and MuPDF: the intervals hold 1 or touch it. recto opens a large
  file first now, 3.0 ms against pdfium's 3.5, though that interval also reaches under 1.

### Peak memory

The peak resident size of a process of its own, doing what the table above did.

| | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| The 29 documents, text and render | 298 MB | 684 MB (2.3× [2.1–2.4]) | **280 MB (0.94× [0.89–0.96])** | 542 MB (1.8× [1.7–1.9]) |
| The 2,000-page report | 218 MB | 452 MB (2.1× [2.1–2.1]) | **195 MB (0.89× [0.89–0.90])** | 222 MB (1.02× [1.01–1.02]) |

pdf.js's includes its canvas package. **pdfium uses less**, 6% and 11%: recto keeps a page's decoded content and
fonts for the pages read last, and WebAssembly memory only grows. MuPDF keeps decoded resources in a store of its
own across documents (`emptyStore()` drops it), which the benchmark leaves as its defaults do.

### What it does to the thread

The event loop's delay when an engine runs on the main thread, yielding between calls, as a server
would be if it did that, over the 29 documents. `monitorEventLoopDelay` at a 1 ms resolution. The
99th percentile equals the maximum on almost every document, since a document makes only a few dozen calls,
so only the maximum is here.

| | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| A typical document: its longest stall (median) | 2.7 ms | 12.8 ms | 3.6 ms | 3.0 ms |
| The worst document: its longest stall | 16.8 ms | 46.3 ms | 271 ms | 231 ms |

A stall that short comes from small calls. A page that's slow to draw stalls for as long as it
takes with `render`: use `renderAsync`, or put the work on a worker thread.

### Stopping a slow page

One generated page of 300,000 small shapes, rendered at 1024 px.

| | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| Rendering it to the end | 323 ms | 2,019 ms | 650 ms | 1,252 ms |
| Asked to stop 100 ms in: the time until the thread is free | 0.3 ms | 1,921 ms | 3.1 ms | 1.7 ms |

recto's is `renderAsync` with a `signal`, on the same thread, and the document stays open. pdf.js has a
real `cancel()`, but in Node the fake worker and the canvas share the thread, so the request waits for
most of the draw. pdfium's and MuPDF's JavaScript calls can't be asked to stop: all you can do is
`worker.terminate()`, which is immediate and takes the engine and its open documents with it, as it does for recto's
`render`. (MuPDF's C library has a cookie that aborts a render; its JavaScript API doesn't take one.)

What slicing costs and gives, from `bench/sliced.mjs`, on the same page, 0.7.1 (one run, not gated): `render` takes 243 ms and holds
the thread for all of it.

| `sliceMs` | Whole render | Longest the thread is held |
|---:|---:|---:|
| 2 | 245 ms | 25.6 ms |
| 4 | 250 ms | 27.9 ms |
| 8 | 254 ms | 27.4 ms |
| 16 | 251 ms | 33.9 ms |

The whole render costs about the same, within this machine's noise. The longest hold is the last step, rasterizing, which runs as
one call whatever `sliceMs` says; every other slice keeps to it. On a 4.0 s page of 4 million shapes, stopped
200 ms in, the stop took 0.2 ms, and the document rendered in full afterwards.

```sh
npm run build
npm run bench -- path/to/pdfs --runs 7 --max-load 8 --min-idle 55 --out bench/results/node.json
node bench/sliced.mjs
```

## In a browser

Chromium 156 (Playwright's, headless), at full speed and slowed to 3.8×, at 800 px, 7 rounds, with the same quiet
gate as Node (at the starts, a median load of 14.5 and 64% idle at full speed, 9.9 and 69% slowed). Each engine in
the arrangement its documentation gives: pdf.js with its parser in a worker and drawing on the main thread; recto,
pdfium and MuPDF doing both in a dedicated worker and posting the bitmap. Each page is a fresh browser context, with
no cache. The corpus is 8 of the 29 public documents.

**The slowdown** stops the browser's whole process tree and resumes it, 2 ms on and 6 ms off, the way
`cpulimit` does. A fixed loop, timed in the page, measures what that comes to: 3.8× here, with the 4× it's set to. Two others were tried and rejected. DevTools CPU throttling can't reach workers,
so it would slow pdf.js's drawing and not recto's. macOS background QoS slowed everything, but it
also made every timer and frame take 200 ms, which charged pdf.js 20× for the frames it waits on.

| | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| Text, first 20 pages of each (79 pages) | 90.5 ms | 295 ms (3.3× [3.1–3.5]) | 248 ms (2.7× [2.6–2.9]) | 261 ms (2.9× [2.7–3.0]) |
| at 3.8× | 363 ms | 1,149 ms (3.2× [3.0–3.7]) | 975 ms (2.7× [2.5–2.9]) | 1,010 ms (2.8× [2.6–3.0]) |
| Render at 800 px, first 2 of each (15 pages) | 54.4 ms | 269 ms (4.9× [4.4–5.2]) | 69.0 ms (1.3× [1.2–1.4]) | 83.2 ms (1.5× [1.4–1.6]) |
| at 3.8× | 213 ms | 549 ms (2.6× [2.3–2.8]) | 280 ms (1.3× [1.2–1.4]) | 336 ms (1.6× [1.4–1.8]) |
| A fresh page to the first page's text | 35.7 ms | 58.4 ms (1.6× [1.1–1.8]) | 43.0 ms (1.2× [0.8–1.3]) | 43.1 ms (1.2× [0.8–1.3]) |
| at 3.8× | 187 ms | 281 ms (1.5× [1.3–1.6]) | 204 ms (1.09× [0.99–1.18]) | 204 ms (1.09× [0.93–1.16]) |
| A fresh page to the first page's pixels | 56.4 ms | 104 ms (1.8× [1.3–2.1]) | 55.8 ms (0.99× [0.72–1.10]) | 51.2 ms (0.91× [0.67–1.01]) |
| at 3.8× | 273 ms | 420 ms (1.5× [1.3–1.6]) | **253 ms (0.93× [0.82–0.98])** | **232 ms (0.85× [0.75–0.90])** |
| Warm: open, first page's text, close | 0.6 ms | 1.4 ms (2.3× [2.0–2.5]) | 0.9 ms (1.5× [1.3–1.8]) | 1.9 ms (3.2× [2.6–3.5]) |
| at 3.8× | 0.8 ms | 1.8 ms (2.3× [1.5–3.3]) | 1.1 ms (1.4× [1.1–14]) | 8.7 ms (11× [8.3–16]) |
| Warm: open, first page's pixels, close | 3.1 ms | 12.8 ms (4.1× [3.6–4.9]) | 5.0 ms (1.6× [1.4–1.7]) | 5.6 ms (1.8× [1.6–1.9]) |
| at 3.8× | 11.1 ms | 19.4 ms (1.8× [1.1–2.4]) | 19.0 ms (1.7× [1.1–1.8]) | 20.9 ms (1.9× [1.2–2.4]) |
| A 40-page report, every page read and drawn in a grid | 101 ms | 665 ms (6.6× [6.2–7.0]) | 152 ms (1.5× [1.4–1.7]) | 129 ms (1.3× [1.2–1.4]) |
| at 3.8× | 402 ms | 1,228 ms (3.1× [2.8–3.2]) | 630 ms (1.6× [1.4–1.7]) | 493 ms (1.2× [1.1–1.4]) |
| A 500-page report: open | 0.4 ms | 3.0 ms (7.5× [7.0–10]) | **0.3 ms (0.75× [0.75–1.0])** | 0.6 ms (1.5× [1.3–2.0]) |
| at 3.8× | 0.4 ms | 9.9 ms (25× [20–25]) | **0.3 ms (0.75× [0.75–1.0])** | 0.6 ms (1.5× [1.5–2.0]) |
| A 500-page report: every page's text | 145 ms | 324 ms (2.2× [2.1–2.5]) | 224 ms (1.5× [1.4–1.8]) | 265 ms (1.8× [1.8–2.0]) |
| at 3.8× | 579 ms | 1,289 ms (2.2× [2.1–2.7]) | 897 ms (1.5× [1.4–1.9]) | 1,013 ms (1.7× [1.7–2.1]) |
| A 500-page report: render 5 pages | 10.5 ms | 80.2 ms (7.6× [7.3–8.4]) | 16.0 ms (1.5× [1.5–1.7]) | 13.2 ms (1.3× [1.2–1.4]) |
| at 3.8× | 45.9 ms | 106 ms (2.3× [2.2–3.5]) | 68.0 ms (1.5× [1.2–1.9]) | 48.0 ms (1.05× [1.01–1.39]) |

- **A fresh page to text**: recto is first, 35.7 ms against 43 ms for pdfium and MuPDF, though at full speed the
  intervals reach under 1. **To pixels it loses, slowed**: MuPDF is 15% ahead and pdfium 7%, and at full speed the
  three are within noise. recto's first pixels add the drawing part (`recto-render.wasm`, see
  [what a page downloads](#what-a-page-downloads)) to an instance that started with text's; pdfium and MuPDF
  start whole, which is why they download 2.4 and 5 times as much.
- **pdfium opens faster**: 0.3 ms against 0.4 ms on 500 pages, at this timer's 0.1 ms resolution, so by an unknown
  amount under a tenth of a millisecond.
- **MuPDF's warm text slowed** (8.7 ms, against 1.9 at full speed) is past what the slowdown explains; it wasn't
  looked into.
- **pdf.js waits for a frame** as it draws, so that it won't hold the main thread. At full speed
  that's about 16 ms a page whatever the page costs, and it's most of the 40-page report's 6.6× and
  the warm render's 4×. It's a design choice, and a reader on a page may well prefer it. Slowed, the
  drawing weighs more than the frame and the ratio falls. Text and the corpus render
  are the ones to read for raw speed.
- **At the slowdown**, anything very small is close to the 8 ms a cycle takes, so warm numbers and
  the open times mean little there.

### What the parts cost

Measured when the parts were introduced, and not rerun for this page: one build cut in four, against the two builds it replaces, in paired runs back to back at load about 2, before the parts took their data (see [What a page downloads](#what-a-page-downloads) for now). The wasm measured here is byte for byte what a release builds on Linux:

| | Two builds | Parts |
|---|---:|---:|
| Download with brotli, text then pixels | 1.72 MB | 0.71 MB |
| Download with brotli, text only | 0.53 MB | 0.46 MB |
| Chromium, a fresh page's first pixels | 65.4 ms | 51.9 ms |
| Chromium, a fresh page's first text | 31.7 ms | 34.2 ms |
| Node, text, the 37 | 301 ms | 296 ms |
| Node, render, the 37 at 1024 px | 225 ms | 229 ms (+1.6%) |
| Instructions, text, each further pass over the 37 | 7.21 B | 7.19 B |
| Instructions, render, each further pass | 5.86 B | 5.98 B (+2.0%) |

**A fresh page's first text is about 2.5 ms later**: instantiating with 1,859 placeholder imports takes 0.8 ms where it took 0.1 ms, and
the rest is V8 compiling code built for speed where the text build's was built for size. Sizing the font crates that way cost sustained text 4.6%.
**Drawing's 2%** is calls across the boundary between `recto.wasm` and `recto-render.wasm`, through an import or a table. A third of
the 3.2% it started at was one call to `roundf` per pixel of each glyph, now gone. Moving `hayro_interpret`'s 75 drawing functions across too gave
nothing for 32 KB; moving all of it gives most of the rest back, for 0.22 MB on every text-only page, so the boundary stays. Node
takes the same parts: a second wasm would add 2.8 MB to the package and a second path through the engine, for 2%.

### What a page downloads

From the responses a real page load made: JavaScript, wasm and assets, then the same with brotli in
brackets.

| | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| A report, first page's text, never drawn | 1.52 MB (**0.42 MB**) | 1.75 MB (0.42 MB) | 4.94 MB (1.70 MB) | 10.54 MB (3.65 MB) |
| A report, first page's text and pixels | 2.45 MB (0.72 MB) | 1.75 MB (**0.42 MB**) | 4.94 MB (1.70 MB) | 10.54 MB (3.65 MB) |
| A CJK document without embedded fonts, first page | 7.85 MB (2.92 MB) | 1.82 MB (**0.48 MB**) | 4.94 MB (1.70 MB) | 10.54 MB (3.65 MB) |

MuPDF's 3.65 MB is one 9.9 MB wasm (3.62 MB with brotli) that holds everything, whatever the
page needs. **For text, recto is the smallest, by a hair**: 420,868 bytes with brotli against pdf.js's 424,332,
of which the wasm is 0.39 MB. `wasm-split` moves functions but not data, so every constant table
stayed in `recto.wasm`, and 0.15 MB of them (before brotli) are read only by drawing or rarer code. The
build now moves those into the parts that read them; see [how it works](how-it-works.md). A page that
goes on to draw adds `recto-render.wasm` (0.26 MB) and only the standard fonts it uses (13 KB each
here), 0.72 MB in all. **pdf.js is the smallest for drawing**, by 0.30 MB: its 0.42 MB
covers that too, and it has the browser's canvas and system fonts to do it with.

A file that runs a function the lists don't hold fetches more. With each of 38 public documents left out of the lists
in turn, 28 fetched nothing more, 10 fetched `recto-more.wasm` (now 0.26 MB), and 4 of those also `recto-rare.wasm` (now 0.19 MB).
Those two grew by 51 KB and 17 KB: a table that more than one part reads is in each of them.

On the CJK row most of the
difference is recto's 5 MB fallback font, which draws CJK the document doesn't embed in any environment. pdf.js
and pdfium downloaded no font for it, so what they draw depends on the system; MuPDF downloads the same one wasm for every page; this benchmark doesn't compare what
they drew.

### What's left in memory

With the 40-page report still open, after a full collection, in a page of its own. Canvases are not
counted, and those are the same on all four.

| | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| JS heap, page and workers | 1.7 MB | 5.6 MB | 2.0 MB | 1.6 MB |
| WebAssembly memory | 12.6 MB | 0.0 MB | 18.6 MB | 27.7 MB |

pdf.js holds the least while the document is open. recto, pdfium and MuPDF keep the file and their state in
WebAssembly memory, which never shrinks while the instance lives. The JS heap here doesn't count
`ArrayBuffer`s, so pdf.js's own copy of the 2 MB file isn't in its column, where recto's is in its.

Where recto's memory goes (11.9 MB when this was measured), stage by stage in Node: 1.5 MB at instantiation (a 1 MiB stack,
of which no file in the corpus used more than 70 KB, nor a crafted deep one 130 KB, and static data); the open, with the file, to
3.6 MB; text to 4.9 MB; the first render to 9.3 MB, of which the page's pixels are 3.3 MB; drawing the
other pages to 12.4 MB. What's live at the end is 6.4 MB above the file, so about 2.5 MB is the
allocator's gaps: a large block freed between pages can't be returned or always reused. All of that is
what WebAssembly costs: a module's memory only grows, and the pixels have to be in it to be drawn.
Keeping one pixel buffer for every page was tried and rejected: it saved 2.1 MB on this file and cost
13 MB across the corpus, where page sizes vary. What changed is after the close: a second with nothing
open now drops the instance at any size, where it waited for 64 MiB, so a closed document holds nothing.

### What it does to the threads

Full speed / slowed. **Stutter** is the time the main thread spent past 50 ms in long tasks, which a
reader feels as dropped frames and delayed input. **A stretch in a worker** is the longest time a
worker took no timer: there, the longest call it couldn't interrupt. The floor at the slowdown is
about 20 ms.

| | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| 40-page report: main-thread stutter | 0 ms / 0 ms | 0 ms / 0 ms | 0 ms / 0 ms | 0 ms / 0 ms |
| 40-page report: longest stretch in a worker | 6.3 ms / 21.4 ms | 7.0 ms / 11.3 ms | 7.5 ms / 26.0 ms | 7.5 ms / 29.4 ms |
| Heavy page: all of it | 337 ms / 1,322 ms | 1,112 ms / 4,296 ms | 836 ms / 3,397 ms | 1,327 ms / 5,284 ms |
| Heavy page: main-thread stutter | 0 ms / 0 ms | 0 ms / 511 ms | 0 ms / 0 ms | 0 ms / 0 ms |
| Heavy page: longest main-thread task | 0 ms / 0 ms | 0 ms / 162 ms | 0 ms / 0 ms | 0 ms / 0 ms |
| Heavy page: longest stretch in a worker | 254 ms / 1,002 ms | 228 ms / 848 ms | 577 ms / 2,406 ms | 1,022 ms / 4,174 ms |
| Heavy page with `renderAsync`: all of it | 274 ms / 1,081 ms | | | |
| Heavy page with `renderAsync`: longest stretch in a worker | 52.3 ms / 158 ms | | | |

The heavy page is the same 300,000 shapes.

- **On the report, nobody stutters**, pdf.js included, drawing on the main thread: it slices its
  drawing and yields.
- **On the heavy page**, pdf.js's slices stop being short once slowed. recto, pdfium and MuPDF keep the
  main thread free, as a worker does for any engine, and that holds for a page of any weight.
- **Both can be stopped in a browser now.** pdf.js's render task: 0.7 ms at full speed and 0.7 ms slowed, from the moment it's
  asked. recto's `renderAsync` stops at the next pause. pdfium and MuPDF can only have their worker terminated, about 3 ms and 2 ms in Node.
- **With `renderAsync`** the longest stretch falls by about 5×, and that stretch is its one rasterizing call. It's
  under a quarter of pdf.js's.

```sh
npm run bench:browser -- path/to/pdfs --runs 7 --max-load 8 --min-idle 55 --slowdown 1 --out bench/results/browser-full-speed.json
npm run bench:browser -- path/to/pdfs --runs 7 --max-load 8 --min-idle 55 --out bench/results/browser.json
```

## Before and after 0.2.0

The same 37 PDFs and the same machine, 0.1 from its own build, in `bench/results/before/`.

| | 0.1 | 0.2 |
|---|---:|---:|
| A fresh page to the first text | 99.2 ms | 32.4 ms |
| A fresh page to the first pixels | 108 ms | 65.9 ms |
| Slowed: first text | 453 ms | 178 ms |
| Slowed: first pixels | 492 ms | 341 ms |
| Node: open a 2,000-page report | 6.9 ms | 4.3 ms |
| Node: text of the 37 documents | 313 ms | 311 ms |
| Node: render of the 37 documents | 236 ms | 229 ms |
| Heavy page in a worker, longest stretch (`render`, then `renderAsync`) | 237 ms | 58.6 ms |
| WebAssembly memory, 40-page report | 15.9 MB | 12.3 MB |
| Download with brotli, first text, never drawn | 1.26 MB | 0.53 MB |
| Download with brotli, first text and pixels | 1.26 MB | 1.72 MB |

## Before and after 0.4.0

The 37 public PDFs and the same machine, 0.3.0 and 0.4.0 built from source, in Node 24: 8 rounds alternating the
two builds, each round a process per build doing 4 passes, medians. The machine was shared and busy, so the
instructions retired are the steadier number.

| | 0.3.0 | 0.4.0 |
|---|---:|---:|
| Text of the first 20 pages of each: time | 305 ms | 294 ms (−3.6%) |
| Instructions | 31.99 B | 30.69 B (−4.1%) |
| Cycles | 6.42 B | 6.20 B (−3.4%) |
| Render of the first 2 pages of each at 1024 px: time | 248 ms | 247 ms (−0.2%) |
| Instructions | 29.13 B | 29.06 B (−0.2%) |
| A fresh process to the first text of a 40-page report | 30.7 ms | 29.9 ms |
| Open a 2,000-page report | 5.05 ms | 4.97 ms |

WebAssembly memory with the document still open, after reading every page in order:

| | 0.3.0 | 0.4.0 |
|---|---:|---:|
| A 2,000-page report (14.1 MB), text | 36.8 MB | 22.5 MB |
| An 85-page credit agreement (0.4 MB), text | 15.3 MB | 6.6 MB |
| A 28-page drug label (5.0 MB), text | 17.1 MB | 14.1 MB |
| The credit agreement, drawn | 20.1 MB | 10.0 MB |

A page's decoded content is now kept only while it's among the last read, so reading the same pages a second
time decodes them again: about 3% more time on the credit agreement. Download is 3.9 KB more with brotli for text
(411,060 bytes) and 4.5 KB more for text and drawing (671,263), from the counters, caches and limits that bound the
inputs in [damaged files](#damaged-files).

A large `FlateDecode` stream peaks where it did in 0.3.0: one inflating to 200 MiB took 514 MiB of WebAssembly
memory in 0.3.0 and 513 MiB now (100 MiB: 258 and 258; 300 MiB: 1,027 and 1,024). A build of 0.4.0 that started
the buffer at four times the input took 798 MiB.

## Giving memory back

recto alone, on an earlier version; not rerun for this page.

300 cycles of open, text, render and close on a 70 MiB file. At rest is 2.5 s later, after a collection, in a
process that still holds the file. The default is a second idle once the instance has grown, and the close past 512 MiB.

| Policy | Time | Peak resident | WebAssembly memory at rest | Resident at rest |
|---|---:|---:|---:|---:|
| default | 2.0 s | 329 MB | 0 MB | 248 MB |
| at close past 64 MiB | 4.2 s | 409 MB | 0 MB | 252 MB |
| at close past 128 MiB | 2.0 s | 334 MB | 82 MB | 334 MB |
| at close past 256 MiB | 2.0 s | 334 MB | 82 MB | 334 MB |
| at close past 512 MiB | 2.0 s | 329 MB | 82 MB | 329 MB |

Retiring at every close past 64 MiB builds a heap per cycle. Not retiring below 512 MiB is as fast as the default, and
holds the memory for as long as the engine lives.

```sh
node bench/recycle.mjs
```

## Across threads

recto alone, on an earlier version and Node 24; not rerun for this page.

`createPdfPool` on a generated 2,000-page report (13.9 MB) in Node 24, every page's text and then 200 pages drawn at
800 px, with each result dropped as it arrives. Threads are warm: starting them and giving each the file is
apart, about 40 ms for 8. Medians of 3, each in its own process, load average 2.

| | Text | Render | Peak memory |
|---:|---:|---:|---:|
| No pool, on the calling thread | 591 ms | 260 ms | 266 MB |
| 1 thread | 643 ms | 256 ms | 361 MB |
| 2 threads | 323 ms (1.8×) | 140 ms (1.9×) | 416 MB |
| 4 threads | 170 ms (3.5×) | 85 ms (3.1×) | 516 MB |
| 8 threads | 103 ms (5.7×) | 65 ms (4.0×) | 713 MB |
| 16 threads | 73 ms (8.1×) | 57 ms (4.5×) | 1,116 MB |

A pool of one costs about 9% for text over calling directly: the message each way. Plan on about 315 MB plus 50 MB a thread
on a file this size. Each thread has its own WebAssembly memory, with the file in it (14 MB here) and what its pages used, and its
own JavaScript heap, none of which can be shared without a threaded wasm build. What can be shared is: threads get one
`SharedArrayBuffer` copy of the file where that's allowed (Node, or a page with COOP and COEP), saving about a file's size per
thread at the peak, and V8 keeps one copy of compiled code for identical wasm. In a page without those headers, expect a file's
size more per thread. Node's version matters too: the same build peaks about 160 MB lower at 8 threads on Node 25 than on Node 24.
Past 8 the gain is small for the memory, so that's the default's limit. Drawing scales less than text because each thread decodes
the images and fonts it meets for itself.

In Chromium, one run of a 500-page report, from a page's main thread, medians of 3 fresh pages:

| | Text, 500 pages | Render, 100 pages |
|---:|---:|---:|
| 1 thread | 166 ms | 160 ms |
| 2 threads | 84 ms | 102 ms |
| 4 threads | 47 ms | 74 ms |
| 8 threads | 30 ms | 64 ms |

```sh
npm run build
node bench/pool.mjs
```

## The film

Three engines, recorded on an earlier version; not remade for this page.

[`recto-film.gif`](recto-film.gif) is a recording of each engine alone, 240 pages of a generated
report at 800 px, then cut side by side. The counters are measured in the page. Each engine was
recorded three times in turn, and the film shows the median take. It finished 2.2× sooner, close to
the table's 2.6× at the same slowdown; the screencast takes time from both. `npm run assets` remakes
it and everything else generated under `docs/`.

## Text quality

Against `pdftotext`, on the first 10 pages of each document with at least 50 words in poppler that all
engines open, by matching the words. Poppler's output isn't truth, only a fourth opinion. F1 here is
over all words of the set, so a long document counts for more than a short one; the median by document
is 100 or close to it for all four.

| F1 against poppler | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| 84 documents: the public set, and the pdf.js, pdfium and hayro test suites | **98.55%** | 97.84% | 98.33% | 97.35% |
| The 25 of the public set alone | **99.60%** | 99.49% | 99.54% | 99.59% |

On the public set all four are level: the spread is 0.1 point, recto on top by 0.01. recto's lead is on the suites,
which are written to break things, and it's narrow over pdfium (0.2 point). The same measure among the engines, all
84: recto against pdfium 99.10%, recto against pdf.js 98.64%, recto against MuPDF 98.16%, pdf.js against pdfium
98.28%, pdfium against MuPDF 98.06%. MuPDF's text is `toStructuredText("preserve-whitespace").asText()`.
The earlier run of this table had 39 public documents where this has 29 (25 with enough words), so pdfium's 97.00%
then and 98.33% now aren't a change in pdfium. The recto column is 0.9's: a gap between glyphs is a space past
0.12 em measured across, `Tz` included (0.15 em of the font size before), which parts a dot leader from its page
number and words kerned apart under `Tz`, and a letter-spaced stretch like `D o c I D #` reads `Doc ID#` as
poppler reads it (pdfium and pdf.js keep its letters apart, which is why recto agrees with them a little less).

Where recto disagrees with poppler on purpose:

- **A superscript stays on its word**: recto reads `WEGOVY®`, poppler `WEGOVY` and a `®` elsewhere.
- **A hard hyphen at a line's end survives** as U+0002: poppler reads `dysfunction-associated` split over
  lines as `dysfunctionassociated`. For matching words, U+0002 and soft hyphens count for nothing.
- **Annotations and form values aren't page text**: poppler includes them. `annotations(i)` has them.

```sh
node bench/text-compare.mjs path/to/pdfs [more/paths] [--worst file.json]
```

## Character boxes

Against pdfium's tight char boxes (`FPDFText_GetCharBox`, the bounds of each glyph's outline), on the first
5 pages of the 226 files of the public set and the pdf.js, pdfium and hayro test suites that recto, pdf.js
and pdfium open and that have text: 388,076 chars, 99.7% of them matched to one of pdfium's by code point in
content order, whitespace and the chars the engines add left out. IoU is the area two boxes share over the
area of both; 1 is the same box.

| IoU against pdfium's tight box | Median | 10th percentile | At least 0.8 |
|---|---:|---:|---:|
| Chars: recto, `text(i, { boxes: "tight" })` | 0.998 | 0.982 | 96.5% |
| Chars: recto's font boxes (the default, and every box before this) | 0.426 | 0.255 | 0.4% |
| Chars: pdfium's own loose boxes (`FPDFText_GetLooseCharBox`) | 0.384 | 0.235 | 0.1% |
| Words: recto, tight | 0.999 | 0.984 | 99.7% |
| Words: recto, font boxes | 0.634 | 0.479 | 12.6% |
| Words: pdfium's loose boxes, united | 0.580 | 0.426 | 4.5% |
| Chars: MuPDF's quads, `accurate-bboxes` | 0.816 | 0.440 | 58.8% |
| Chars: MuPDF's quads (its default) | 0.411 | 0.254 | 0.5% |
| Text items: pdf.js | 0.629 | 0.415 | 0.3% |
| Text items: recto's `textItems` | 0.629 | 0.448 | 0.2% |

MuPDF's chars are the bounds of the quad its structured text gives each char, matched to pdfium's as recto's are
(383,794 chars). By default a quad is the advance by the font's ascent and descent, like recto's font boxes; with
the `accurate-bboxes` option it measures the glyph.

A word is recto's, against the union of pdfium's boxes for the chars it matched (69,325 words). Text
items, pdf.js's and `textItems`'s, are upright ones only, and are baseline-and-em boxes by design, for
laying text over a page; they're here for scale.

pdfium's box is an outline's bounds, not ink, so here are both against the ink itself: for each upright
char, the bounds of the inked pixels around it in pdfium's render at 4 px a point, leaving out the pixels
inside other chars' boxes, where that can be read cleanly (302,280 chars; not where ink runs on past the
char, as a rule or a filled background does):

| IoU against the ink | Median | 10th percentile | At least 0.8 |
|---|---:|---:|---:|
| pdfium's tight boxes | 0.848 | 0.551 | 64.8% |
| recto's tight boxes | 0.846 | 0.543 | 63.8% |
| recto's font boxes | 0.471 | 0.321 | 0.3% |
| MuPDF, `accurate-bboxes` | 0.826 | 0.529 | 59.1% |
| MuPDF, its default | 0.456 | 0.311 | 0.3% |

Neither engine's box is the ink to the pixel: a curve's control points reach past the curve, and the
render's pixels and anti-aliasing blur the edges by a quarter of a point. On this measure recto and pdfium are
level, and MuPDF's measured boxes a little behind, with fewer at 0.8 or more (59% against 64–65%). The ink here is
pdfium's render, which favours pdfium's boxes if anything.

**What font boxes are.** A char's font box is its advance across, by its font's ascent and descent: the
same height for every char of a font, whether `x`, `.` or `H`, and the side bearings and an italic's
overhang come with the advance. The ascent and descent are the font descriptor's, or 0.8 and −0.2 em for a
font that states none: all of the 14 standard fonts a document doesn't embed, and every Type 3 font,
whose glyphs can be drawn anywhere their matrix puts them. On the 7 files with Type 3 text, font boxes
matched pdfium's at a median of 0.086 and tight boxes match at 0.989. Rise, skew and rotation were
already in font boxes; a turned or skewed box is the upright bounds of the turned one, as pdfium's is. Font
boxes stay the default, for selection and highlighting, where a line's boxes should be one height, and
because they cost nothing: they come from the font's dictionary alone.

**What tight boxes are.** The control box of the glyph's outline in its font program (the same box
FreeType gives pdfium), or for a Type 3 glyph the bounds of what its procedure draws, through the matrix
the glyph is drawn with. A font the document doesn't embed is measured in the font recto draws it with.
A glyph with no outline, such as a space, keeps its font box. The text is the same either way: on every
page measured, `text` reads the same string with either.

**Where they still differ.** Of the 13,528 chars under 0.8, 11,649 are in one file whose Garamond isn't
embedded, and pdfium and recto draw it in different stand-ins, so the glyphs themselves differ. Without
it, 99.5% of chars are at 0.8 or more. Most of the rest are where the two place a glyph differently by a
fraction of a point, which a thin glyph's IoU feels: an `i` a tenth of a point to the side is 0.75. And
for a few CJK, Arabic and Type 3 fonts pdfium's tight box has no height at all, where recto's has the glyph's.

**What they cost.** Font boxes are what `text` always read, at the same speed. Tight boxes load what
drawing loads for fonts: each embedded font program, which reading text otherwise loads only when the
font's dictionary leaves its codes or widths to it, the standard fonts a document names, and drawing's part
of the wasm. On the public set, reading the first 10 pages of each file in a fresh document, so that
the fonts load in the time: 1.35 ms a page at the median file where font boxes take 0.99, and 6.9 ms
at the 90th percentile where they take 3.1 (WebAssembly in Node, best of 3).

```sh
npm run build
node bench/box-compare.mjs path/to/pdfs [more/paths] --tight [--no-ink] [--worst file.json]
```

`--worst` writes the chars furthest from pdfium's, by page, for looking at; like the PDFs, it stays out of
the repository.

## Ranged reads

Not rerun for this page; MuPDF wasn't measured.

Reading the page count and the last page's text of a generated 14.1 MB report of 2,000 pages, in one
flat `/Kids`, from a local server that honours `Range`, in Node.

| | Bytes | Requests |
|---|---:|---:|
| recto | 0.41 MB | 4 |
| pdf.js with `disableAutoFetch` and `disableStream` | 14.90 MB | 216 |
| pdf.js by default | 14.26 MB | 4 |

recto takes the last kid at its word, since a node of over 32 kids, as many as its `/Count`, is read as one
page each. pdf.js fetches every kid before it, which is why this file costs it all its bytes, and why it gets the
right page in the cases where recto may not (see [the limit](reference.md#ranged-reads)). On a file whose page
tree has more levels the gap is smaller. Stock pdfium wasn't measured.

```sh
node -e 'import("./bench/generate.mjs").then((g) => require("fs").writeFileSync("report.pdf", g.reportPdf({ pages: 2000, imageEvery: 10, imageSize: 240 })))'
node bench/ranged-compare.mjs report.pdf
```

### The first page over a slow link

Time to a ranged document's first page at three latencies: open by URL, read page 1's text, draw it at 1024 px.
The 37 public PDFs and the generated 40- and 2,000-page reports, from the tests' range server holding each
response back by the latency, in Node 24. 0.4.0 and 0.5.0 built from source and pdf.js 4.10 by its defaults
(one streamed request, ranges for what it hasn't reached), alternating in one process, 5 runs each after one
unmeasured; sums of per-file medians.

| | 0.4.0 | 0.5.0 | pdf.js |
|---|---:|---:|---:|
| Round trips to the first pixels, all 39 | 79 | 47 | |
| Files done in one round trip | 19 | 34 | |
| 0 ms: first text | 83 ms | 82 ms | 330 ms |
| 0 ms: first pixels | 223 ms | 224 ms | 734 ms |
| 40 ms: first text | 3,453 ms | 2,077 ms | 2,133 ms |
| 40 ms: first pixels | 3,703 ms | 2,282 ms | 2,710 ms |
| 120 ms: first text | 9,936 ms | 5,925 ms | 5,446 ms |
| 120 ms: first pixels | 10,227 ms | 6,209 ms | 6,102 ms |
| Bytes fetched, all 39 | 8.3 MB | 9.5 MB | |

**At 120 ms the time is the round trips**: 47 of them are 5.6 s of the 5.9 to first text. The open is now one: the head and
the tail go out together. Of the 5 files that take more, each pays for its object graph, a page's fonts and
images found one after another, which the fetch-ahead and the jump to the next object shorten but can't
remove. pdf.js's first request streams the file from the start, so it often has the first page when its
first response is in: at 120 ms it reads text first, by 8%, and draws first, by 2%. Its bytes weren't
counted. At 40 ms and below recto is ahead.

**The bytes are 14% more**: the tail is 2 chunks where 0.4.0 fetched 1, since it's asked for before the file's
length is known and so before `startxref` says how much is needed. No byte is fetched twice: in a file shorter
than the head and the tail, the head stops where the suffix starts. Over every 12th page of the same files read
one by one (225 pages), the rounds per page went from 3.91 to 2.04 and the bytes from 105.0 to 112.7 MB (+7%).

**What it adds to the download**, with brotli, from `scripts/check-wasm-budget.mjs`: text 411,549 → 415,372 bytes
(+3.8 KB, the ranged loader's new paths, which a ranged open needs before it draws), text and drawing 672,177 →
683,494 (+11.3 KB: the region and links code, in `recto-render.wasm`, which `links` loads).
A ranged open in 0.4.0 also fetched `recto-more.wasm` (251 KB) for code its lists hadn't profiled; the lists now
include a ranged read, so it fetches no part, and the budget check says so.

```sh
npm run build && npm install --prefix bench
node bench/ranged-latency.mjs path/to/pdfs --against ../recto-0.4.0/js/dist --out bench/results/ranged-latency.json
```

## Rendering

### The scorecard

`bench/scorecard.mjs` renders the first 3 pages of each file at 800 px in recto, stock pdfium (with its
form-fill environment, or it leaves widgets out), pdf.js, poppler and, with `--engines`, MuPDF, each file in a
process of its own with a 20 s limit per page. Compared over 4×4 cells, so that anti-aliasing and hinting cancel
out and a missing word doesn't, two pages **agree** if under 1% of cells are off by more than 32 of 255 on a
channel, and the mean error is under 3. An engine is judged only where two of the others agree with each other,
by whether it agrees with either. Each engine gets the same test. On 0.7.1, 531 files:

| Of the pages two others agree on | recto | pdfium | pdf.js | poppler | MuPDF |
|---|---:|---:|---:|---:|---:|
| Agrees with them | **95.6%** of 568 | 88.6% of 580 | 87.0% of 592 | 77.5% of 595 | 83.8% of 588 |
| Blank where they draw | 2 | 5 | 3 | 9 | 13 |
| Fails where they draw | 1 | 7 | 6 | 7 | 6 |
| A different page shape | 0 | 3 | 0 | 3 | 4 |

| By set (recto) | Pages judged | Agrees |
|---|---:|---:|
| 29 public PDFs | 65 | 92.3% |
| 251 from pdf.js's test suite | 259 | 95.4% |
| 100 from pdfium's | 103 | 98.1% |
| 151 from hayro's | 141 | 95.7% |

**A fifth engine lowered recto's score**, from 97.9% of 530 with the four (the scoreboard's measure, which stays four)
to 95.6% of 568. That's the test working: MuPDF agrees with one of the others on 38 more pages, and on 14 of them recto
agrees with neither. Of recto's 25 that differ, 19 have MuPDF as one of the two references. Most are pages where the
references split two and two: on 5 public pages of small text and underlines, which look the same side by side,
recto and pdfium draw the strokes one way and pdf.js and MuPDF another, past the limit. The closer pair is the reference,
so recto and pdfium both count as differing there. The rest are what the four-engine run found:
knockout groups and a Type 3 glyph's `ca`, where recto follows the spec and the references don't, a Brotli stream two
references can't read, a file with no page tree, and rounding and thin lines. MuPDF draws 13 pages blank where two
others draw; poppler's low score is mostly how it hints small text at this size.

Don't read 95.6% as "better than pdfium". The others are judged on pages where recto is often one of the two that
agree, and the set is small files, mostly written to break things; the limit is generous, so a missing line of text
can pass, which is why the report also ranks pages under the limit that are well past the references' own
difference.

Reports (side-by-side crops, every rank) go in `--out`, not the repository. References are cached there, so a rerun
renders recto alone. `bench/api-cases.mjs` writes small PDFs for rotation, boxes, user units and widgets
to run it on: recto matches pdf.js and pdfium on all of the page shapes.

```sh
node bench/scorecard.mjs public=path/to/pdfs other=path/to/more --private public --engines recto,pdfium,pdf.js,poppler,mupdf --out scratch/dir
```

The results are in [`bench/results/scorecard.json`](../bench/results/scorecard.json). Files in a suite
given by `--private` appear there as hashes. Credit for the suites: pdf.js, pdfium and hayro.

### Scanned pages

recto alone, 0.5.1 against the build of the time; not rerun for this page.

A Letter page scanned at 300 dpi, 2550 by 3300 pixels: paper with grain, ten-point text as strokes, a stamp in
colour and a photo, generated by `crates/recto/examples/scans.rs` (no scan is committed). In colour as a baseline
JPEG (4:2:0, 1.36 MB) and a progressive one, and in gray. 0.5.1 against this build, in Node, each render in a
document opened for it, medians of 9; the machine was shared and busy (load 30-40), so take a few ms either way.
Memory is the WebAssembly instance's after the render, in an instance of its own: it only grows, so its peak.

| | 0.5.1 | Now |
|---|---:|---:|
| Colour, baseline, at 1600 px | 69.4 ms, 38.6 MB | 58.5 ms, 38.6 MB |
| at 1024 px | 45.8 ms, 32.8 MB | 34.3 ms, 22.4 MB |
| at 400 px | 40.7 ms, 29.2 MB | 21.7 ms, 8.3 MB |
| at 160 px | 59.5 ms, 28.6 MB | 16.8 ms, 4.7 MB |
| Colour, progressive, at 1600 px | 63.9 ms, 54.1 MB | 69.9 ms, 54.1 MB |
| at 1024 px | 65.1 ms, 54.1 MB | 43.6 ms, 48.0 MB |
| at 400 px | 59.7 ms, 54.1 MB | 29.8 ms, 33.7 MB |
| Gray, at 1600 px | 40.3 ms, 41.3 MB | 32.8 ms, 41.3 MB |
| at 1024 px | 30.2 ms, 18.2 MB | 22.3 ms, 20.1 MB |
| at 400 px | 32.3 ms, 11.5 MB | 17.1 ms, 5.4 MB |
| The scan as a background on 6 pages, every page, at 1024 px | 285 ms, 32.8 MB | 69.9 ms, 26.7 MB |
| at 1600 px | 358 ms, 38.6 MB | 118 ms, 63.9 MB |
| A logo twice on each of 12 pages, every page, at 1024 px | 60.4 ms, 8.2 MB | 9.5 ms, 8.1 MB |

At 1600 px nothing changed for one page: the image is drawn at 0.63 of its size, and a decode at half would be
smaller than what's drawn, so it's decoded whole as before; the rows differ by the machine's noise. Where the
time went, from rendering the same pixels uncompressed at the size the JPEG decodes to (no decode) and at the
page's size in device pixels (no decode, no scaling), colour baseline:

| | Decode | Scaling to the page | Rasterizing |
|---|---:|---:|---:|
| 0.5.1 at 1024 px | 31.6 ms (full) | 12.3 ms | 1.9 ms |
| Now at 1024 px | 27.8 ms (1/2) | 4.6 ms | 1.9 ms |
| 0.5.1 at 400 px | 32.0 ms (full) | 8.4 ms | 0.3 ms |
| Now at 400 px | 20.5 ms (1/4) | 0.9 ms | 0.3 ms |

**A JPEG drawn at under half its size is decoded at 1/2, 1/4 or 1/8 of it**, in the IDCT, as libjpeg's
`scale_denom` does: the largest reduction that still leaves it at or above the size it's drawn at, on both axes
of its transform, so the renderer only ever scales it down. The entropy decode is the same work at any size and
is most of what's left; the IDCT, colour conversion, the buffers and the scaling after it shrink. A thumbnail
gains most. The size comes from the whole page's scale, so a region draws the same pixels as the page.

**An image drawn again at the same size comes from the document's cache**: the pixmap the renderer made from it,
premultiplied RGBA at the size it's drawn, shared, never copied, kept the second time it's drawn, so an image
drawn once costs nothing. A page drawn as tiles, a page drawn again, a logo or a scanned letterhead on every
page decode once. It holds at most 256 images and 48 MiB, or an eighth of `maxDecodedBytes` if that's less, the least recently
used going first; it hands an image out only while the decode limit would let its decode through, and never
one from a decode that was cut, so it changes no pixel and no `truncated`. What it costs is memory: the 6-page
letterhead at 1600 px holds a 13 MB pixmap, and the instance grew to 63.9 MB where it was 38.6 MB, since a block
held across pages splits a heap that never shrinks.

**The pixels.** Against 0.5.1 at the same width, measured as `crates/recto/tests/scans.rs` does:

| | Mean error of 255 a channel | Largest | Pixels past 48 | 4×4 cells: mean | Cells past 16 |
|---|---:|---:|---:|---:|---:|
| Colour (baseline or progressive), 1600 px | 0 | 0 | 0 | 0 | 0 |
| 1024 px (1/2) | 1.03 | 33 | 0 | 0.36 | 0 |
| 400 px (1/4) | 2.40 | 55 | 0.009% | 0.61 | 0 |
| 160 px (1/8) | 2.36 | 38 | 0 | 0.61 | 0 |
| Gray, 1024 px (1/2) | 0.98 | 20 | 0 | 0.35 | 0 |
| 400 px (1/4) | 2.07 | 55 | 0.008% | 0.58 | 0 |
| 160 px (1/8) | 2.31 | 38 | 0 | 0.58 | 0 |

The scorecard's "agree" allows 1% of cells past 32 and a mean of 3 over cells; no cell here is past 16. The
differences are on the edges of strokes, where a reduced IDCT and the full decode scaled down by the renderer
filter differently, a few levels; side by side at 3× they look the same. The tests hold every kind of JPEG to
this, on a 96 dpi page drawn at each scale: baseline and progressive, 4:2:0, 4:2:2, 4:4:4, gray, Adobe CMYK and
YCCK with `/Decode`, an inverted `/Decode`, rotated, skewed, drawn twice at two sizes, with a soft mask of its own
in Flate or JPEG; over 4×4 cells a mean under 1 and at most 0.1% of cells past 16, and at most 0.1% of pixels
past 48. An image whose soft mask has `/Matte`, one with a colour key `/Mask`, and an indexed one decode at full
size as before, as do JPEGs whose sampling a reduction can't follow (4:1:1 at 1/2) and baseline files whose
components come in scans of their own.

A JPEG declaring a huge size is held to the decode limit at its full size whatever it's drawn at, as before:
a progressive file's coefficients are held at full size either way.

```sh
cargo run --release -p recto --example scans -- /tmp/scans
node bench/scans.mjs /tmp/scans --compare path/to/0.5.1/js/dist
```

The results are in [`bench/results/scans.json`](../bench/results/scans.json), and 0.5.1's in
[`bench/results/before/scans-0.5.1.json`](../bench/results/before/scans-0.5.1.json).

### Transparency

Not rerun for this page. MuPDF here is PyMuPDF, from before it was an engine of the benchmark.

Transparency is checked on small generated PDFs, with recto, poppler, stock pdfium and MuPDF sampled
at points where the spec's formulas give the colour. recto is on the expected colour at every point.
Where the others differ:

- **An isolated knockout group**, and a group inside a knockout group: recto and MuPDF knock the
  earlier object out as the spec says. Poppler and pdfium don't.
- **A non-isolated group at part opacity, or masked, or blended, and a non-isolated knockout group**:
  pdfium is off. Poppler and MuPDF agree with recto.

```sh
PYTHONPATH=path/to/pymupdf node bench/render-compare.mjs   # PYTHONPATH only for the MuPDF column
```

## Damaged files

recto alone, with a count for three other engines at the end; not rerun for this page.

`bench/fuzz.mjs` damages PDFs by a seed (bit flips, overwritten ranges, truncation, xrefs, `startxref`,
stream lengths, keywords, numbers), including copies of the files with their streams uncompressed, so
that the damage reaches what parses them, and runs text, objects, annotations, rendering, outline and
labels on up to 3 pages of each. A file must end in a result or a `PdfError` that isn't `crash`.

| 60,000 files, one seed | Before | Now |
|---|---:|---:|
| `crash` | 7 | 0 |
| Past 15 s | 2 | 0 |
| Past 1.5 GB | 5 | 0 |
| A failure that isn't a `PdfError` | 0 | 0 |
| Peak memory of a process | 3.9 GB | 0.4 GB |

Damage rarely makes a file built to cost, so `bench/fuzz-structures.mjs` generates them: repeats and chains in the
page labels, destination names, outlines, `/Kids`, field parents and visibility expressions, and forms, patterns, Type 3
glyphs, soft masks and annotations that ask for far more drawing than their size. That found hangs from a few KB and a
crash at 2.6 GB. Each now stops at a limit and says so: `truncated` on the page's results, or `doc.structureTruncated()`.
3,000 of them, seed 21, each in a process of its own: no failures, and a peak of 0.75 GB. CI runs each kind, 15 s and 1.5 GB per file,
and checks exactly which results say so. 0.4.0 added four kinds, which the 3,000 above predate: a named resource
used thousands of times, a membership dictionary named by thousands of `BDC`s, an inline image full of `EI`s, and a
stitching function nested 20 to 31 levels. The build before took over 300 s on the first of them; now each takes 7–64 ms.
A function repeats the ones it lists at most 2^14 times; the most any of these files repeated was 44.

The limits mustn't reach a real page. `crates/recto/examples/budgets.rs` reports the most any page or tree used of each,
over all 543 files that open here (2,408 pages, text, objects and a render of each). Nothing is `truncated`. These are small
suite files and 39 public ones, not a survey: a page far costlier than these could exist, and would say so.

| Limit | The most used | Of | Room |
|---|---:|---:|---:|
| Nested streams | 800 | 2^20 | 1,310× |
| Annotation points | 495 | 2^17 | 264× |
| `/VE` nodes | 2 | 2^10 | 512× |
| Page tree kids | 248 | objects + 2^18 | 1,059× |
| Page label nodes | 1 | 2^16 | 65,536× |
| Name tree nodes | 1 | 2^18 | 262,144× |
| Bytes one stream or image decodes to | 151 MB | 768 MiB | 5.3× |

Three more seeds (180,000 files) also found nothing. That says it's hard to find another with this
fuzzer, not that there isn't one: a page can still take seconds and hold hundreds of megabytes.

Which of 1,000 such files each engine opens with at least one page: recto 753, poppler 510, pdf.js 506, pdfium 501.
That's less of a win than it looks. In 23 files two others open one where recto doesn't, and many of those pages are only a
trusted `/Count`: of the 27 such files before this fix, pdf.js reported a page in 16 and then couldn't load it. 44 open with no
pages, down from 55: 43 lost their kids, where the page object itself is damaged and a scan can't find it, and
`doc.structureTruncated().pages` says so; one is honestly empty. A tree with nothing lost isn't scanned, and a scan doesn't bring
back what a later revision removed.

`js/test/fuzz.test.ts` does the same to generated PDFs in CI, 20,000 files in 3 s, stopping at 30 s.

```sh
node bench/fuzz.mjs path/to/pdfs [--seed 1] [--count 2000] [--repair] [--results file.json]
node bench/fuzz.mjs --structures [--seed 1] [--count 2000]
```

## The scoreboard

One command for what a change must not make worse, against a base ref, on this machine:

```sh
npm run scoreboard -- --base origin/main     # 8 rounds; --quick for 2, --rounds n for n
```

It builds the working tree, and the base in `~/.cache/recto-scoreboard/trees/<commit>` (kept for the next
run), with this tree's harness for both: only the engine is the base's. Then, in fresh processes, one at a
time, base and new taking turns to go first round by round:

- **Speed**, WASM in Node and native (`crates/recto/examples/scoreboard.rs`): the open, each page's text,
  then each page drawn at 1024 and 1600 px, over the first 100 pages of each file in `pub`; p50 and p90
  over pages, for the first 2 pages of each file and for all of them.
- **Load**: a fresh Node process from `import` through `createPdfEngine` to the first page's text, and to
  the first page drawn (median of 3 a round); each wasm part's size raw, gzip and brotli; the JS; and
  `scripts/check-wasm-budget.mjs`'s numbers.
- **Memory**: the most linear memory the WASM instance had, and the native peak live heap.
- **Growth**: generated files at 3 sizes, 4× apart, in pages, characters a page, paths a page, clip
  nesting and file bytes; the native time to open, read and draw every page, and the slope of log time
  on log size. Past 1.15 is flagged.
- **Fidelity**: [the scorecard](#the-scorecard) on all four sets, and a hash of every page's text per
  file, with the count of files whose text differs from the base.
- **Simplicity**: Rust lines in `crates/` and `vendor/` (not blank, not generated), JS lines, crates in
  `Cargo.lock`, npm dependencies, the patches `vendor/README.md` lists, the names `js/src/index.ts`
  exports and the functions `recto.wasm` exports.

A timed metric is the median over rounds of new ÷ base within each round, and its noise half the width of
that median's 95% interval, bootstrapped from the rounds; a change whose interval holds 1 prints as `=`.
Exponents compare the same way by difference, and one under 0.1 is `=` too. Without `--base` the noise
is the interval of the tree's own median. 2 rounds give an interval in name only; trust 8. Results go to `bench/scoreboard/<name>.json` (`--name`, else the commit), files named
by hash only. The PDFs are read from `~/.cache/recto-corpus/{pub,suites/pdfjs,suites/pdfium,suites/hayro}`
(`--corpus`); bring your own. [`bench/scoreboard/0.5.3.json`](../bench/scoreboard/0.5.3.json) is 0.5.3
(65b2e9d) on its own, for the sizes, lines and fidelity a later run can be read against without rebuilding it;
its times are this machine's on that day, so compare times only within one run.

## Real-world files

The other sections use small sets, mostly files written to break things. This one is a random sample of PDFs as
they are found on the web: 7,000 files (10.6 GB) from the DARPA SafeDocs
[CC-MAIN-2021-31-PDF-UNTRUNCATED](https://digitalcorpora.org/corpora/file-corpora/cc-main-2021-31-pdf-untruncated)
corpus, about 8 million PDFs from Common Crawl's July–August 2021 crawl, fetched again in full where the crawl had
cut them. The corpus comes as 7,933 zips of up to 1,000 files, numbered by each file's SHA-256, so each zip is
itself a random draw. `bench/wild.mjs fetch` takes 7 whole zips: zip *n* is the first 4 bytes of
`sha256("recto-wild-n")` modulo 7,933, which picks 7153, 1534, 1388, 3486, 5418, 5695 and 3200. It writes each
file's SHA-256 to `~/.cache/recto-corpus/wild/hashes.txt`, whose own SHA-256 is
`b3e99cc9f944c84c6b627cbb53dcfbe09fbc808d1e50678e6a1e4fd94651c7f9`. No file is committed.

Each file and engine gets a fresh Node process with 20 s and 2 GB (resident, polled every 200 ms): open it,
read the page count, read the text of up to 5 pages, then draw the first 2 at 1024 px. pdfium has its form-fill
environment; MuPDF opens the bytes as `PDFDocument`, since its `openDocument` would open an HTML error page as a
document of its own. A process that dies or traps counts as a crash. recto at 0.7.1:

| 7,000 files | recto | pdf.js | pdfium | MuPDF |
|---|---:|---:|---:|---:|
| Opened, and every page asked for read and drawn | 6,974 | 6,963 | 6,968 | 6,975 |
| Refused as not a PDF, or too damaged | 18 | 23 | 24 | 16 |
| Refused for a password | 8 | 8 | 8 | 8 |
| Opened, then a page failed | 0 | 0 | 0 | 0 |
| Past 20 s | 0 | 0 | 0 | 1 |
| Past 2 GB | 0 | 6 | 0 | 0 |
| Crashed | 0 | 0 | 0 | 0 |
| **Worse than another engine on the same file** | **0** | 13 | 6 | 7 |
| Fewer than half the words all three others agree on (to look at) | 8 | 27 | 7 | 42 |
| Time per file, median (99th percentile) | 124 ms (693) | 293 ms (1,970) | 97 ms (896) | 88 ms (757) |
| Peak memory per process, median (largest) | 121 MB (728) | 221 MB (2,195) | 116 MB (1,072) | 134 MB (758) |

**Worse than another engine** means that on a file another engine opened with at least one page, this one failed,
ran out of time or memory, gave a different page count, drew a blank page where at least two others drew
something, or found no text on a page where at least two others found 20 words or more. recto has none. pdf.js's 13
are 6 files past 2 GB, 2 pages with no text, and 5 damaged files it refuses that others open; pdfium's 6 are damaged
files it refuses; MuPDF's 7 are 3 pages with no text, 2 files it refuses ("Invalid number of pages"), one page count
and one file past 20 s while reading text. MuPDF's 6,975 include 4 damaged files the other three refuse, in
which it finds no page, so it reads pages from 6,971. One truncated file that the others refuse or
read as empty, recto opens as 45 blank pages; it isn't counted against anyone.

**Fewer than half the words** flags pages where every other engine found at least 30 words and agrees within a
factor of two. recto's 8, read against `pdftotext`: in 3 the others count each dot of a leader as a word, and
recto reads the dots as one; in 3 recto's count is close to poppler's (49 and 49, 330 and 283, 280 and 292); in one
poppler too reads far fewer than the other three (47 recto, 68 poppler). One is a fault, the one this table found
before: in a table of contents whose letters are kerned tighter than the gap between words, recto runs the words
together ("Supplementaryobservations") where the others split them. That's for the text code to fix.

**The times are a busy machine's**, and not one moment's: the other engines ran at a 1-minute load of 16 to 160
(median 41) with 6 files at a time, MuPDF again at 16 to 39 once its open was fixed, and recto again on 0.7.1, at a
different time again. Compare the times within a column, or read [In Node](#in-node) for speed. The engines'
slowest files are mostly the same: large scanned or Illustrator pages.

```sh
node bench/wild.mjs fetch                    # 7 zips, 10.6 GB, into ~/.cache/recto-corpus/wild
npm run build
node bench/wild.mjs run --jobs 6 --results bench/results/wild.json
```

A run caches one line per file and engine, with recto's keyed by its wasm, so a rerun after a change runs recto
alone. It writes counts and file hashes to [`bench/results/wild.json`](../bench/results/wild.json), and each
engine's worse files, by local name, to `~/.cache/recto-corpus/wild/worse.json`. Run it on an idle machine:
with a load average past 100, 74 runs across the three engines then went past 20 s, and none did when they were run again.

## What this doesn't show

- **Your files.** A different set of PDFs moves these ratios. Rerun it on yours.
- **Text on scans:** nothing here runs OCR.
- **Pixels at scale:** [the scorecard](#the-scorecard) is hundreds of small files, not millions of real ones.
- **Firefox and WebKit.** The benchmark ran in Chromium only.
- **Phones.** The slowdown is one machine stopped part of the time; a phone's memory and storage are
  slower too.
- **The other engines' other strengths.** A viewer, forms and annotations cost time in pdf.js
  that a benchmark of reading doesn't credit. MuPDF also writes and edits PDFs, and opens EPUB, XPS
  and images; none of that is measured here.
