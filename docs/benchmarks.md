# Benchmarks

recto against pdf.js 6.5.438 and stock pdfium (`@embedpdf/pdfium` 2.15.1), on an Apple M5 Pro (18
cores, 64 GB) that had other work running, so compare the ratios. The raw results, with the machine
and versions, are in [`bench/results/`](../bench/results). Each section ends with the command that
reproduces it. A megabyte here is 10^6 bytes.

Each number is the median of 5 runs, in a fresh process or page, with the engines alternating run by
run. The brackets are 95% confidence intervals on the ratio to recto, bootstrapped: resampled from
the runs to see how much the ratio could move, and with 5 runs they're rough. Above 1× recto is faster;
below it, the other engine is. The PDFs are 37 public and generated documents
(25 MB) that all three engines open, plus generated ones; none is committed, so bring your
own. [Transparency](#transparency) was measured earlier on a different set of 60, and
[Text quality](#text-quality), [the scorecard](#the-scorecard) and [Damaged files](#damaged-files) on the
sets they name; none is comparable with the tables here; recto's text
on this set is byte for byte what it was before 0.2.0. Its pixels aren't: since 0.3.0 it draws annotations with no appearance, as on page 5 of the
annotations file.

## In Node

Node 24.22.1, load average 2.2. Every engine runs on the calling thread: pdf.js with its fake
worker, drawing through `@napi-rs/canvas`, and pdfium through its `FPDF_` functions. All three end
with the same thing, a page's text or its RGBA bytes.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Text, first 20 pages of each (348 pages) | 306 ms | 1,240 ms (4.1× [3.9–4.3]) | 722 ms (2.4× [2.3–2.4]) |
| Render at 1024 px, first 2 pages of each (64 pages) | 234 ms | 1,207 ms (5.2× [4.7–5.4]) | 980 ms (4.2× [4.0–4.2]) |
| A fresh process to the first page's text | 30.7 ms | 136 ms (4.4× [4.3–4.6]) | 33.5 ms (1.1× [1.1–1.1]) |
| A fresh process to the first page's pixels | 42.2 ms | 169 ms (4.0× [3.9–4.1]) | 46.3 ms (1.1× [1.1–1.1]) |
| Warm: open, first page's text, close | 0.5 ms | 4.4 ms (8.0× [7.1–9.2]) | 1.0 ms (1.8× [1.7–2.0]) |
| Warm: open, first page's pixels, close | 2.7 ms | 12.4 ms (4.7× [4.4–4.7]) | 3.6 ms (1.4× [1.3–1.4]) |
| 2,000-page report: open | 4.1 ms | 36.9 ms (8.9× [8.2–9.1]) | 2.8 ms (0.7× [0.6–0.7]) |
| 2,000-page report: every page's text | 586 ms | 1,712 ms (2.9× [2.8–3.0]) | 917 ms (1.6× [1.5–1.6]) |
| 2,000-page report: render 5 pages | 27.0 ms | 77.0 ms (2.9× [2.6–3.0]) | 29.8 ms (1.1× [1.0–1.1]) |

- **Totals**, not per-file medians, so a slow file counts for what it costs. A warm-up pass comes
  first, and the buffer copies are outside the clock.
- **The columns differ.** recto's text call also builds every char's box and the word columns;
  pdf.js's `getTextContent` builds its items; pdfium's `FPDFText_GetText` returns a string. pdfium
  gives less for its time, and there are other calls to get more.
- **The characters** agree: 976,693 in recto, 967,399 in pdf.js, 976,704 in pdfium, not
  counting whitespace, over the same pages. That's a count. [Text quality](#text-quality) compares
  the words.
- **pdfium still opens a large file faster** (0.7×): 2.8 ms against 4.1 ms, first open in a fresh process, where
  it was 4.8 ms before (the same build run just before, 0.6×). recto walks the whole page tree on open,
  reading every kid, so `/Count` can't change the page count or which page is which; it now notes where
  each page's dictionary is and leaves building it to the page's first read. What's left: both copy the
  file (about 1.1 ms each on 13.9 MB); V8 compiles recto's open lazily on its first call, about 1.7 ms
  against pdfium's 1.25 ms; and the walk itself takes about 0.8 ms, which pdfium defers to the page.

### Peak memory

The peak resident size of a process of its own, doing what the table above did.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| The 37 documents, text and render | 300 MB | 699 MB (2.3× [2.3–2.4]) | 312 MB (1.0× [1.0–1.0]) |
| The 2,000-page report | 206 MB | 450 MB (2.2× [2.1–2.3]) | 196 MB (0.95× [0.93–0.96]) |

pdf.js's includes its canvas package. pdfium uses less on the large file.

### What it does to the thread

The event loop's delay when an engine runs on the main thread, yielding between calls, as a server
would be if it did that, over the 37 documents. `monitorEventLoopDelay` at a 1 ms resolution. The
99th percentile equals the maximum on every engine, since a document makes only a few dozen calls,
so only the maximum is here.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| A typical document: its longest stall (median) | 3.2 ms | 10.9 ms | 3.9 ms |
| The worst document: its longest stall | 17.0 ms | 53.8 ms | 262 ms |

A stall that short comes from small calls. A page that's slow to draw stalls for as long as it
takes with `render`: use `renderAsync`, or put the work on a worker thread.

### Stopping a slow page

One generated page of 300,000 small shapes, rendered at 1024 px.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Rendering it to the end | 325 ms | 1,548 ms | 666 ms |
| Asked to stop 100 ms in: the time until the thread is free | 0.3 ms | 1,483 ms | 2.1 ms |

recto's is `renderAsync` with a `signal`, on the same thread, and the document stays open. pdf.js has a
real `cancel()`, but in Node the fake worker and the canvas share the thread, so the request waits for
most of the draw. pdfium has no way to stop a call: all you can do is `worker.terminate()`, which is
immediate and takes the engine and its open documents with it, as it does for recto's `render`.

What slicing costs and gives, from `bench/sliced.mjs`, on the same page: `render` takes 243 ms and holds
the thread for all of it.

| `sliceMs` | Whole render | Longest the thread is held |
|---:|---:|---:|
| 2 | 247 ms | 65.9 ms |
| 4 | 247 ms | 65.6 ms |
| 8 | 246 ms | 66.0 ms |
| 16 | 247 ms | 66.2 ms |

The whole render costs about the same, within this machine's noise. The longest hold is the last step, rasterizing, which runs as
one call whatever `sliceMs` says; every other slice keeps to it. On a 4.0 s page of 4 million shapes, stopped
200 ms in, the stop took 0.2 ms, and the document rendered in full afterwards.

```sh
npm run build
npm run bench -- path/to/pdfs
node bench/sliced.mjs
```

## In a browser

Chromium, at full speed (load average 2.2) and slowed to 4.6× (load average 1.9), at
800 px. Each engine in the arrangement its documentation gives: pdf.js with its parser in a worker
and drawing on the main thread, recto and pdfium doing both in a dedicated worker and posting the
bitmap. Each page is a fresh browser context, with no cache.

**The slowdown** stops the browser's whole process tree and resumes it, 2 ms on and 6 ms off, the way
`cpulimit` does. A fixed loop, timed in the page, measures what that comes to: 4.6× here, with the 4× it's set to. Two others were tried and rejected. DevTools CPU throttling can't reach workers,
so it would slow pdf.js's drawing and not recto's. macOS background QoS slowed everything, but it
also made every timer and frame take 200 ms, which charged pdf.js 20× for the frames it waits on.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Text, first 20 pages of each (52 pages) | 56.2 ms | 184 ms (3.3× [3.2–3.4]) | 149 ms (2.7× [2.6–2.7]) |
| at 4.6× | 257 ms | 864 ms (3.4× [3.2–3.6]) | 686 ms (2.7× [2.6–2.8]) |
| Render at 800 px, first 2 of each (13 pages) | 61.7 ms | 216 ms (3.5× [3.4–3.6]) | 89.0 ms (1.4× [1.4–1.5]) |
| at 4.6× | 292 ms | 405 ms (1.4× [1.3–1.5]) | 434 ms (1.5× [1.4–1.6]) |
| A fresh page to the first page's text | 34.1 ms | 53.1 ms (1.6× [1.5–1.6]) | 39.9 ms (1.2× [1.1–1.3]) |
| at 4.6× | 182 ms | 261 ms (1.4× [1.4–1.5]) | 201 ms (1.1× [1.0–1.2]) |
| A fresh page to the first page's pixels | 51.9 ms | 99.4 ms (1.9× [1.6–2.0]) | 51.0 ms (1.0× [0.9–1.1]) |
| at 4.6× | 259 ms | 411 ms (1.6× [1.5–1.6]) | 249 ms (1.0× [0.9–1.0]) |
| Warm: open, first page's text, close | 0.6 ms | 1.3 ms (2.2× [1.9–2.3]) | 0.8 ms (1.3× [1.1–1.3]) |
| at 4.6× | 0.7 ms | 1.3 ms (1.9× [1.3–2.1]) | 1.0 ms (1.4× [1.0–12.3]) |
| Warm: open, first page's pixels, close | 2.4 ms | 15.2 ms (6.3× [4.6–6.7]) | 4.2 ms (1.8× [1.7–1.8]) |
| at 4.6× | 10.5 ms | 19.1 ms (1.8× [0.9–2.6]) | 19.7 ms (1.9× [1.1–2.2]) |
| A 40-page report, every page read and drawn in a grid | 101 ms | 665 ms (6.6× [6.6–6.8]) | 140 ms (1.4× [1.4–1.4]) |
| at 4.6× | 456 ms | 1,167 ms (2.6× [2.5–2.7]) | 622 ms (1.4× [1.3–1.5]) |
| A 500-page report: open | 0.4 ms | 2.2 ms (5.5× [1.4–7.3]) | 0.3 ms (0.8× [0.2–1.0]) |
| at 4.6× | 0.4 ms | 9.6 ms (24× [1.2–24.5]) | 0.3 ms (0.8× [0.0–0.8]) |
| A 500-page report: every page's text | 127 ms | 307 ms (2.4× [2.3–2.5]) | 206 ms (1.6× [1.6–1.7]) |
| at 4.6× | 586 ms | 1,402 ms (2.4× [2.3–2.5]) | 988 ms (1.7× [1.7–1.8]) |
| A 500-page report: render 5 pages | 10.1 ms | 89.0 ms (8.8× [8.0–8.9]) | 15.0 ms (1.5× [1.5–1.5]) |
| at 4.6× | 49.8 ms | 121 ms (2.4× [1.9–2.7]) | 66.7 ms (1.3× [1.1–1.4]) |

- **A fresh page**: recto is first to text (34.1 ms against 53.1 ms and 39.9 ms), on 0.38 MB of wasm, hashed in full
  before it compiles. **To pixels it ties pdfium** (51.9 ms against 51.0 ms), where it was 12 ms behind with two builds: the first render
  now adds one part to the same instance, and doesn't reopen the file.
- **pdfium opens faster** here too: 0.3 ms against 0.4 ms on 500 pages at full speed, too close to this timer's 0.1 ms to say by how much. At the slowdown both are
  close to a cycle's length.
- **pdf.js waits for a frame** as it draws, so that it won't hold the main thread. At full speed
  that's about 16 ms a page whatever the page costs, and it's most of the 40-page report's 6× and
  the warm render's 5×. It's a design choice, and a reader on a page may well prefer it. Slowed, the
  drawing weighs more than the frame and the ratio falls to about 2×. Text and the corpus render
  are the ones to read for raw speed.
- **At the slowdown**, anything very small is close to the 8 ms a cycle takes, so warm numbers and
  the open times mean little there.

### What the parts cost

One build cut in four, against the two builds it replaces, in paired runs back to back at load about 2, before the parts took their data (see [What a page downloads](#what-a-page-downloads) for now). The wasm measured here is byte for byte what a release builds on Linux:

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

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| A report, first page's text, never drawn | 1.47 MB (0.41 MB) | 1.75 MB (0.42 MB) | 4.94 MB (1.70 MB) |
| A report, first page's text and pixels | 2.35 MB (0.70 MB) | 1.75 MB (0.42 MB) | 4.94 MB (1.70 MB) |
| A CJK document without embedded fonts, first page | 7.75 MB (2.89 MB) | 1.82 MB (0.48 MB) | 4.94 MB (1.70 MB) |

**For text, recto is now the smallest**: 0.41 MB, 11 KB under pdf.js, where it was 35 KB over (0.46 MB),
of which the wasm is 0.38 MB. `wasm-split` moves functions but not data, so every constant table
stayed in `recto.wasm`, and 0.15 MB of them (before brotli) are read only by drawing or rarer code. The
build now moves those into the parts that read them; see [how it works](how-it-works.md). A page that
goes on to draw adds `recto-render.wasm` (0.26 MB) and only the standard fonts it uses (13 KB each
here), 0.70 MB in all, where it was 0.72 MB. **pdf.js is still the smallest for drawing**: its 0.42 MB
covers that too, and it has the browser's canvas and system fonts to do it with.

A file that runs a function the lists don't hold fetches more. With each of 38 public documents left out of the lists
in turn, 28 fetched nothing more, 10 fetched `recto-more.wasm` (now 0.26 MB), and 4 of those also `recto-rare.wasm` (now 0.19 MB).
Those two grew by 51 KB and 17 KB: a table that more than one part reads is in each of them.

On the CJK row most of the
difference is recto's 5 MB fallback font, which draws CJK the document doesn't embed in any environment. pdf.js
and pdfium downloaded no font for it, so what they draw depends on the system; this benchmark doesn't compare what
they drew.

### What's left in memory

With the 40-page report still open, after a full collection, in a page of its own. Canvases are not
counted, and those are the same on all three.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| JS heap, page and workers | 1.7 MB | 5.6 MB | 2.0 MB |
| WebAssembly memory | 11.9 MB | 0.0 MB | 18.6 MB |

pdf.js holds the least while the document is open. recto and pdfium keep the file and their state in
WebAssembly memory, which never shrinks while the instance lives. The JS heap here doesn't count
`ArrayBuffer`s, so pdf.js's own copy of the 2 MB file isn't in its column, where recto's is in its.

Where recto's 11.9 MB goes, measured stage by stage in Node: 1.5 MB at instantiation (a 1 MiB stack,
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

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| 40-page report: main-thread stutter | 0.0 ms / 0.0 ms | 0.0 ms / 0.0 ms | 0.0 ms / 0.0 ms |
| 40-page report: longest stretch in a worker | 6.5 ms / 26.8 ms | 7.0 ms / 11.3 ms | 7.1 ms / 20.9 ms |
| Heavy page: all of it | 309 ms / 1,421 ms | 960 ms / 4,597 ms | 755 ms / 3,572 ms |
| Heavy page: main-thread stutter | 0.0 ms / 0.0 ms | 0.0 ms / 465 ms | 0.0 ms / 0.0 ms |
| Heavy page: longest main-thread task | 0.0 ms / 0.0 ms | 0.0 ms / 159 ms | 0.0 ms / 0.0 ms |
| Heavy page: longest stretch in a worker | 235 ms / 1,097 ms | 202 ms / 923 ms | 525 ms / 2,491 ms |
| Heavy page with `renderAsync`: all of it | 256 ms / 1,190 ms | | |
| Heavy page with `renderAsync`: longest stretch in a worker | 64.7 ms / 265 ms | | |

The heavy page is the same 300,000 shapes.

- **On the report, nobody stutters**, pdf.js included, drawing on the main thread: it slices its
  drawing and yields.
- **On the heavy page**, pdf.js's slices stop being short once slowed. recto and pdfium keep the
  main thread free, as a worker does for any engine, and that holds for a page of any weight.
- **Both can be stopped in a browser now.** pdf.js's render task: 0.7 ms at full speed and 0.7 ms slowed, from the moment it's
  asked. recto's `renderAsync` stops at the next pause. pdfium can only have its worker terminated, about 3 ms in Node.
- **With `renderAsync`** the longest stretch falls by about 4×, and that stretch is its one rasterizing call. It's
  under a third of pdf.js's. Its runs land near 57 ms or near 65 ms, on this build and the one before it; this
  build's median of two sets of 5 was 64.7 and 61.1 ms, the one before's 58.2 and 58.1 ms.

```sh
npm run bench:browser -- path/to/pdfs   # add --slowdown 1 for full speed
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

[`recto-film.gif`](recto-film.gif) is a recording of each engine alone, 240 pages of a generated
report at 800 px, then cut side by side. The counters are measured in the page. Each engine was
recorded three times in turn, and the film shows the median take. It finished 2.2× sooner, close to
the table's 2.6× at the same slowdown; the screencast takes time from both. `npm run assets` remakes
it and everything else generated under `docs/`.

## Text quality

Against `pdftotext`, on the first 10 pages of each document with at least 50 words in poppler that all
engines open, by matching the words. Poppler's output isn't truth, only a fourth opinion. F1 here is
over all words of the set, so a long document counts for more than a short one; the median by document
is 100 or close to it for all three.

| F1 against poppler | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| 87 documents: the public set, and the pdf.js, pdfium and hayro test suites | 98.66% | 97.82% | 97.00% |
| The 28 of the public set alone | 99.63% | 99.25% | 97.58% |

Before this round recto was at 98.62% and 99.63%: the one fix that moved this is CJK text in an embedded font with no
`ToUnicode`, which was garbage. So recto's lead is mostly what it did already. The same measure among
the others: recto against pdf.js 98.57%, recto against pdfium 97.71%, pdf.js against pdfium 96.73%.
An earlier set of 157 public documents, measured by median, had the three level at about 99.55%. That set wasn't rerun.

Where recto disagrees with poppler on purpose:

- **A superscript stays on its word**: recto reads `WEGOVY®`, poppler `WEGOVY` and a `®` elsewhere.
- **A hard hyphen at a line's end survives** as U+0002: poppler reads `dysfunction-associated` split over
  lines as `dysfunctionassociated`. For matching words, U+0002 and soft hyphens count for nothing.
- **Annotations and form values aren't page text**: poppler includes them. `annotations(i)` has them.

```sh
node bench/text-compare.mjs path/to/pdfs [more/paths] [--worst file.json]
```

## Ranged reads

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
| 0 ms: first text | 89 ms | 86 ms | 352 ms |
| 0 ms: first pixels | 233 ms | 230 ms | 772 ms |
| 40 ms: first text | 3,507 ms | 2,113 ms | 2,126 ms |
| 40 ms: first pixels | 3,733 ms | 2,312 ms | 2,674 ms |
| 120 ms: first text | 9,894 ms | 5,900 ms | 5,350 ms |
| 120 ms: first pixels | 10,160 ms | 6,144 ms | 5,959 ms |
| Bytes fetched, all 39 | 8.3 MB | 10.4 MB | |

**At 120 ms the time is the round trips**: 47 of them are 5.6 s of the 5.9. The open is now one: the head and
the tail go out together. Of the 5 files that take more, each pays for its object graph, a page's fonts and
images found one after another, which the fetch-ahead and the jump to the next object shorten but can't
remove. pdf.js's first request streams the file from the start, so it often has the first page when its
first response is in: at 120 ms it reads text first, by 10%, and draws first, by 3%. Its bytes weren't
counted. At 40 ms and below recto is ahead.

**The bytes are 25% more**: the tail is 2 chunks, asked for before the file's length is known, so for a file
of 4 chunks or fewer the head and the tail overlap and both count. Over every 12th page of the same files read
one by one (225 pages), the rounds per page went from 3.91 to 2.04 and the bytes from 105.0 to 116.4 MB (+11%).

**What it adds to the download**, with brotli, from `scripts/check-wasm-budget.mjs`: text 411,549 → 415,119 bytes
(+3.6 KB, the ranged loader's new paths, which a ranged open needs before it draws), text and drawing 672,177 →
685,390 (+13.2 KB: the region and links code, 5.6 KB of it links, in `recto-render.wasm`, which `links` loads).
A ranged open in 0.4.0 also fetched `recto-more.wasm` (251 KB) for code its lists hadn't profiled; the lists now
include a ranged read, so it fetches no part, and the budget check says so.

```sh
npm run build && npm install --prefix bench
node bench/ranged-latency.mjs path/to/pdfs --against ../recto-0.4.0/js/dist --out bench/results/ranged-latency.json
```

## Rendering

### The scorecard

`bench/scorecard.mjs` renders the first 3 pages of each file at 800 px in recto, stock pdfium (with its
form-fill environment, or it leaves widgets out), pdf.js and poppler, each file in a process of its own
with a 20 s limit per page. Compared over 4×4 cells, so that anti-aliasing and hinting cancel out and a
missing word doesn't, two pages **agree** if under 1% of cells are off by more than 32 of 255 on a
channel, and the mean error is under 3. An engine is judged only where two of the other three agree with
each other, by whether it agrees with either. Each engine gets the same test.

| Of the pages two others agree on | recto | pdfium | pdf.js | poppler |
|---|---:|---:|---:|---:|
| Agrees with them | **97.6%** of 546 | 92.2% of 567 | 88.2% of 583 | 76.7% of 601 |
| Blank where they draw | 2 | 6 | 4 | 9 |
| Fails where they draw | 1 | 4 | 3 | 4 |
| A different page shape | 0 | 2 | 0 | 3 |

| By set (recto) | Pages judged | Agrees |
|---|---:|---:|
| 39 public PDFs | 79 | 98.7% |
| 250 from pdf.js's test suite | 239 | 97.1% |
| 100 from pdfium's | 100 | 98.0% |
| 150 from hayro's | 128 | 97.7% |

0.3.0 agreed on 96.9%, and 0.2.0 on 93.8%. Don't read 97.6% as "better than pdfium". Poppler's low score
is mostly how it hints small text at this size, and that makes pages count against pdf.js and pdfium that
it wouldn't against recto: the others are judged on pages where recto is one of the two that agree. The set is
539 small files, mostly written to break things, and the limit is generous: a missing line of text can
pass, which is why the report also ranks pages under the limit that are well past the references' own
difference. Of 632 pages, 86 aren't judged at all, because no two others agree.

0.4.0 fixed 4 pages: an image enlarged under 2×, a luminosity mask, a hairline in a pattern, and a page a pixel too
wide. What's left of the 13, from looking at each: 3 where recto follows the spec and the references don't (a Type 3
glyph's `ca`, knockout groups), 6 of rounding and thin-line noise, a Brotli stream two references can't read, a file with no page tree that recto refuses,
a tiling pattern on text and a blend against bare paper the references don't agree on either.

Reports (side-by-side crops, every rank) go in `--out`, not the repository. References are cached there, so a rerun
renders recto alone. `bench/api-cases.mjs` writes small PDFs for rotation, boxes, user units and widgets
to run it on: recto matches pdf.js and pdfium on all of the page shapes.

```sh
node bench/scorecard.mjs public=path/to/pdfs other=path/to/more --private public --out scratch/dir
```

The results are in [`bench/results/scorecard.json`](../bench/results/scorecard.json). Files in a suite
given by `--private` appear there as hashes. Credit for the suites: pdf.js, pdfium and hayro.

### Transparency

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

## What this doesn't show

- **Your files.** A different set of PDFs moves these ratios. Rerun it on yours.
- **Text on scans:** nothing here runs OCR.
- **Pixels at scale:** [the scorecard](#the-scorecard) is hundreds of small files, not millions of real ones.
- **Firefox and WebKit.** The benchmark ran in Chromium only.
- **Phones.** The slowdown is one machine stopped part of the time; a phone's memory and storage are
  slower too.
- **pdf.js's and pdfium's other strengths.** A viewer, forms and annotations cost time in pdf.js
  that a benchmark of reading doesn't credit.
