# Benchmarks

recto against pdf.js 6.5.438 and stock pdfium (`@embedpdf/pdfium` 2.15.1), on an Apple M5 Pro (18
cores, 64 GB) that had other work running, so compare the ratios. The raw results, with the machine
and versions, are in [`bench/results/`](../bench/results). Each section ends with the command that
reproduces it. A megabyte here is 10^6 bytes.

Each number is the median of 3 runs, in a fresh process or page, with the engines alternating run by
run. The brackets are 95% confidence intervals on the ratio to recto, bootstrapped: resampled from
the runs to see how much the ratio could move, and with 3 runs they're rough. Above 1× recto is faster;
below it, the other engine is. The PDFs are 37 public and generated documents
(25 MB) that all three engines open, plus generated ones; none is committed, so bring your
own. [Text quality](#text-quality), [Ranged reads](#ranged-reads) and [Rendering](#rendering) were
measured earlier on a different set of 60 and aren't comparable with the tables here; recto's output
on this set is byte for byte what it was before 0.2.0.

## In Node

Node 25.9.0, load average 5.2. Every engine runs on the calling thread: pdf.js with its fake
worker, drawing through `@napi-rs/canvas`, and pdfium through its `FPDF_` functions. All three end
with the same thing, a page's text or its RGBA bytes.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Text, first 20 pages of each (348 pages) | 296 ms | 1,184 ms (4.0× [3.9–4.1]) | 679 ms (2.3× [2.3–2.3]) |
| Render at 1024 px, first 2 pages of each (64 pages) | 227 ms | 1,238 ms (5.5× [5.4–5.9]) | 921 ms (4.1× [4.0–4.1]) |
| A fresh process to the first page's text | 53.9 ms | 178 ms (3.3× [3.1–3.4]) | 57.4 ms (1.1× [1.0–1.1]) |
| A fresh process to the first page's pixels | 65.2 ms | 213 ms (3.3× [3.1–3.3]) | 71.0 ms (1.1× [1.1–1.1]) |
| Warm: open, first page's text, close | 0.5 ms | 4.7 ms (9.4× [7.6–10.7]) | 0.9 ms (1.8× [1.6–2.0]) |
| Warm: open, first page's pixels, close | 2.6 ms | 12.7 ms (4.9× [4.5–5.5]) | 3.4 ms (1.3× [1.3–1.4]) |
| 2,000-page report: open | 4.9 ms | 38.3 ms (7.9× [7.5–8.5]) | 3.2 ms (0.7× [0.6–0.7]) |
| 2,000-page report: every page's text | 573 ms | 1,536 ms (2.7× [2.6–2.7]) | 792 ms (1.4× [1.4–1.4]) |
| 2,000-page report: render 5 pages | 26.4 ms | 78.7 ms (3.0× [2.9–3.1]) | 29.0 ms (1.1× [1.1–1.1]) |

- **Totals**, not per-file medians, so a slow file counts for what it costs. A warm-up pass comes
  first, and the buffer copies are outside the clock.
- **The columns differ.** recto's text call also builds every char's box and the word columns;
  pdf.js's `getTextContent` builds its items; pdfium's `FPDFText_GetText` returns a string. pdfium
  gives less for its time, and there are other calls to get more.
- **The characters** agree: 976,693 in recto, 967,399 in pdf.js, 976,704 in pdfium, not
  counting whitespace, over the same pages. That's a count. [Text quality](#text-quality) compares
  the words.
- **pdfium still opens a large file faster** (0.7×): 3.2 ms against 4.9 ms, first open in a fresh process. Warm it's about
  0.6 ms against 1.1 ms. recto reads every kid of the page tree on open, so a wrong `/Count` can't change
  the page count, and that's what's left between them. A fresh process is about even.

### Peak memory

The peak resident size of a process of its own, doing what the table above did.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| The 37 documents, text and render | 308 MB | 696 MB (2.3× [2.2–2.4]) | 297 MB (1.0× [0.9–1.0]) |
| The 2,000-page report | 237 MB | 453 MB (1.9× [1.9–2.0]) | 194 MB (0.8× [0.8–0.8]) |

pdf.js's includes its canvas package. pdfium uses less on the large file.

### What it does to the thread

The event loop's delay when an engine runs on the main thread, yielding between calls, as a server
would be if it did that, over the 37 documents. `monitorEventLoopDelay` at a 1 ms resolution. The
99th percentile equals the maximum on every engine, since a document makes only a few dozen calls,
so only the maximum is here.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| A typical document: its longest stall (median) | 3.1 ms | 12.4 ms | 3.6 ms |
| The worst document: its longest stall | 15.9 ms | 53.7 ms | 260 ms |

A stall that short comes from small calls. A page that's slow to draw stalls for as long as it
takes with `render`: use `renderAsync`, or put the work on a worker thread.

### Stopping a slow page

One generated page of 300,000 small shapes, rendered at 1024 px.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Rendering it to the end | 328 ms | 1,891 ms | 630 ms |
| Asked to stop 100 ms in: the time until the thread is free | 0.3 ms | 1,794 ms | 3.2 ms |

recto's is `renderAsync` with a `signal`, on the same thread, and the document stays open. pdf.js has a
real `cancel()`, but in Node the fake worker and the canvas share the thread, so the request waits for
most of the draw. pdfium has no way to stop a call: all you can do is `worker.terminate()`, which is
immediate and takes the engine and its open documents with it, as it does for recto's `render`.

What slicing costs and gives, from `bench/sliced.mjs`, on the same page: `render` takes 239 ms and holds
the thread for all of it.

| `sliceMs` | Whole render | Longest the thread is held |
|---:|---:|---:|
| 2 | 244 ms | 66.2 ms |
| 4 | 242 ms | 65.6 ms |
| 8 | 244 ms | 66.5 ms |
| 16 | 242 ms | 65.8 ms |

The whole render costs about the same, within this machine's noise. The longest hold is the last step, rasterizing, which runs as
one call whatever `sliceMs` says; every other slice keeps to it. On a 4.2 s page of 4 million shapes, stopped
200 ms in, the stop took 0.3 ms, and the document rendered in full afterwards.

```sh
npm run build
npm run bench -- path/to/pdfs
node bench/sliced.mjs
```

## In a browser

Chromium, at full speed (load average 5.7) and slowed to 4.5× (load average 7.5), at
800 px. Each engine in the arrangement its documentation gives: pdf.js with its parser in a worker
and drawing on the main thread, recto and pdfium doing both in a dedicated worker and posting the
bitmap. Each page is a fresh browser context, with no cache.

**The slowdown** stops the browser's whole process tree and resumes it, 2 ms on and 6 ms off, the way
`cpulimit` does. A fixed loop, timed in the page, measures what that comes to: 4.5× here, with the 4× it's set to. Two others were tried and rejected. DevTools CPU throttling can't reach workers,
so it would slow pdf.js's drawing and not recto's. macOS background QoS slowed everything, but it
also made every timer and frame take 200 ms, which charged pdf.js 20× for the frames it waits on.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Text, first 20 pages of each (52 pages) | 57.9 ms | 185 ms (3.2× [3.2–3.2]) | 146 ms (2.5× [2.5–2.5]) |
| at 4.5× | 260 ms | 848 ms (3.3× [3.2–3.5]) | 700 ms (2.7× [2.5–2.8]) |
| Render at 800 px, first 2 of each (13 pages) | 59.1 ms | 214 ms (3.6× [3.4–3.6]) | 89.7 ms (1.5× [1.4–1.5]) |
| at 4.5× | 271 ms | 408 ms (1.5× [1.4–1.5]) | 429 ms (1.6× [1.4–1.6]) |
| A fresh page to the first page's text | 31.2 ms | 52.2 ms (1.7× [1.5–1.8]) | 38.6 ms (1.2× [1.1–1.3]) |
| at 4.5× | 184 ms | 253 ms (1.4× [1.2–1.8]) | 198 ms (1.1× [0.9–1.3]) |
| A fresh page to the first page's pixels | 64.8 ms | 87.8 ms (1.4× [1.2–1.5]) | 50.2 ms (0.8× [0.7–0.8]) |
| at 4.5× | 326 ms | 388 ms (1.2× [1.1–1.3]) | 245 ms (0.8× [0.7–0.8]) |
| Warm: open, first page's text, close | 0.5 ms | 1.4 ms (2.8× [2.0–2.8]) | 0.8 ms (1.6× [1.3–1.6]) |
| at 4.5× | 0.6 ms | 1.5 ms (2.5× [0.2–14.8]) | 1.0 ms (1.7× [0.1–1.8]) |
| Warm: open, first page's pixels, close | 2.4 ms | 15.1 ms (6.3× [5.4–6.3]) | 4.3 ms (1.8× [1.6–1.8]) |
| at 4.5× | 10.3 ms | 19.5 ms (1.9× [1.6–2.6]) | 20.1 ms (1.9× [1.7–2.0]) |
| A 40-page report, every page read and drawn in a grid | 101 ms | 668 ms (6.6× [6.5–6.7]) | 139 ms (1.4× [1.4–1.4]) |
| at 4.5× | 454 ms | 1,190 ms (2.6× [2.6–2.7]) | 629 ms (1.4× [1.3–1.4]) |
| A 500-page report: open | 0.4 ms | 2.1 ms (5.2× [4.0–7.3]) | 0.2 ms (0.5× [0.4–1.0]) |
| at 4.5× | 1.5 ms | 9.4 ms (6.3× [1.1–19.4]) | 0.3 ms (0.2× [0.0–0.6]) |
| A 500-page report: every page's text | 130 ms | 306 ms (2.4× [2.3–2.4]) | 208 ms (1.6× [1.6–1.6]) |
| at 4.5× | 599 ms | 1,397 ms (2.3× [2.2–2.6]) | 1,003 ms (1.7× [1.6–1.9]) |
| A 500-page report: render 5 pages | 9.8 ms | 88.9 ms (9.1× [7.4–9.2]) | 15.3 ms (1.6× [1.4–1.6]) |
| at 4.5× | 47.2 ms | 110 ms (2.3× [2.2–3.1]) | 67.4 ms (1.4× [1.3–1.8]) |

- **A fresh page**: recto is first to text (31.2 ms against 52.2 ms and 38.6 ms), on the 0.5 MB text engine, its wasm checked by
  the browser's own `fetch` `integrity` as it streams. **pdfium is first to pixels** (50.2 ms against 64.8 ms):
  a render pays once for loading the full engine and reopening the file on it.
- **pdfium opens faster** here too: 0.2 ms against 0.4 ms on 500 pages at full speed. At the slowdown both are
  close to a cycle's length.
- **pdf.js waits for a frame** as it draws, so that it won't hold the main thread. At full speed
  that's about 16 ms a page whatever the page costs, and it's most of the 40-page report's 6× and
  the warm render's 5×. It's a design choice, and a reader on a page may well prefer it. Slowed, the
  drawing weighs more than the frame and the ratio falls to about 2×. Text and the corpus render
  are the ones to read for raw speed.
- **At the slowdown**, anything very small is close to the 8 ms a cycle takes, so warm numbers and
  the open times mean little there.

### What a page downloads

From the responses a real page load made: JavaScript, wasm and assets, then the same with brotli in
brackets.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| A report, first page's text, never drawn | 1.84 MB (0.53 MB) | 1.75 MB (0.42 MB) | 4.94 MB (1.70 MB) |
| A report, first page's text and pixels | 5.95 MB (1.72 MB) | 1.75 MB (0.42 MB) | 4.94 MB (1.70 MB) |
| A CJK document without embedded fonts, first page | 11.11 MB (3.73 MB) | 1.82 MB (0.48 MB) | 4.94 MB (1.70 MB) |

**pdf.js is still the smallest.** recto without drawing is 0.53 MB, of which the wasm is 0.50 MB, 334 KB of code and
160 KB of tables. What a text call needs keeps it there: the colour conversion behind `fills`, the glyph-name
tables, shadings and functions.

**A page that text-reads and then draws downloads both engines**, 0.50 MB more than one that starts on the
full one: 1.72 MB on the second row. A thread that knows it will draw avoids that with
`preloadAssets: ["recto.wasm"]`, which comes to about 1.22 MB by adding up the files. On the CJK row most of the
difference is recto's 5 MB fallback font, which draws CJK the document doesn't embed in any environment. pdf.js
and pdfium downloaded no font for it, so what they draw depends on the system; this benchmark doesn't compare what
they drew.

### What's left in memory

With the 40-page report still open, after a full collection, in a page of its own. Canvases are not
counted, and those are the same on all three.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| JS heap, page and workers | 1.3 MB | 5.6 MB | 2.0 MB |
| WebAssembly memory | 12.3 MB | 0.0 MB | 18.6 MB |

pdf.js holds the least. recto and pdfium keep the file and their state in WebAssembly memory, which
never shrinks while the instance lives. Of recto's 12.3 MB: the 2 MB file, 1.8 MB of stack and static data, a
page's pixels at 3.3 MB and what the page's drawing used, which then stays. Past 64 MiB, closing the last document gives it all back.

### What it does to the threads

Full speed / slowed. **Stutter** is the time the main thread spent past 50 ms in long tasks, which a
reader feels as dropped frames and delayed input. **A stretch in a worker** is the longest time a
worker took no timer: there, the longest call it couldn't interrupt. The floor at the slowdown is
about 20 ms.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| 40-page report: main-thread stutter | 0.0 ms / 0.0 ms | 0.0 ms / 0.0 ms | 0.0 ms / 0.0 ms |
| 40-page report: longest stretch in a worker | 8.7 ms / 22.3 ms | 6.5 ms / 11.6 ms | 7.2 ms / 25.2 ms |
| Heavy page: all of it | 307 ms / 1,374 ms | 978 ms / 4,510 ms | 756 ms / 3,572 ms |
| Heavy page: main-thread stutter | 0.0 ms / 0.0 ms | 0.0 ms / 469 ms | 0.0 ms / 0.0 ms |
| Heavy page: longest main-thread task | 0.0 ms / 0.0 ms | 0.0 ms / 150 ms | 0.0 ms / 0.0 ms |
| Heavy page: longest stretch in a worker | 232 ms / 1,040 ms | 204 ms / 882 ms | 521 ms / 2,491 ms |
| Heavy page with `renderAsync`: all of it | 258 ms / 1,166 ms | | |
| Heavy page with `renderAsync`: longest stretch in a worker | 60.9 ms / 261 ms | | |

The heavy page is the same 300,000 shapes.

- **On the report, nobody stutters**, pdf.js included, drawing on the main thread: it slices its
  drawing and yields.
- **On the heavy page**, pdf.js's slices stop being short once slowed. recto and pdfium keep the
  main thread free, as a worker does for any engine, and that holds for a page of any weight.
- **Both can be stopped in a browser now.** pdf.js's render task: 0.5 ms at full speed and 0.6 ms slowed, from the moment it's
  asked. recto's `renderAsync` stops at the next pause. pdfium can only have its worker terminated, about 3 ms in Node.
- **With `renderAsync`** the longest stretch falls by about 4×, and that stretch is its one rasterizing call. It's
  under a third of pdf.js's.

```sh
npm run bench:browser -- path/to/pdfs   # add --slowdown 1 for full speed
```

## The film

[`recto-film.gif`](recto-film.gif) is a recording of each engine alone, 240 pages of a generated
report at 800 px, then cut side by side. The counters are measured in the page. Each engine was
recorded three times in turn, and the film shows the median take. It finished 2.2× sooner, close to
the table's 2.6× at the same slowdown; the screencast takes time from both. `npm run assets` remakes
it and everything else generated under `docs/`.

## Text quality

Against `pdftotext` as the reference, on the first 10 pages of 157 public documents (of 200 tried:
the rest had under 50 words in poppler, or an engine failed), by matching the words.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Precision | 99.01% | 99.1% | 98.91% |
| Recall | 98.63% | 98.98% | 98.68% |
| Median F1 | 99.59% | 99.55% | 99.55% |

Poppler's output isn't truth, only a fourth opinion. On this measure the three are the same, so
recto isn't more accurate than pdf.js or pdfium, and nothing here says it is.

```sh
node bench/text-compare.mjs path/to/pdfs
```

## Ranged reads

Reading the page count and the last page's text of a 22.8 MB public PDF from a local server that
honours `Range`, in Node.

| | Bytes | Requests |
|---|---:|---:|
| recto | 1.30 MB | 8 |
| pdf.js with `disableAutoFetch` and `disableStream` | 1.50 MB | 9 |
| pdf.js by default | 23.2 MB | 7 |

With those two options pdf.js does about as well. Its default streams the whole file. Stock pdfium
wasn't measured.

```sh
node bench/ranged-compare.mjs path/to/large.pdf
```

## Rendering

Rendered pixels aren't compared across the public documents, and these numbers say how fast, not how
good. pdfium and pdf.js have had years on files recto hasn't seen.

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

## What this doesn't show

- **Your files.** A different set of PDFs moves these ratios. Rerun it on yours.
- **Pixels** (above), and text on scans: nothing here runs OCR.
- **Firefox and WebKit.** The benchmark ran in Chromium only.
- **Phones.** The slowdown is one machine stopped part of the time; a phone's memory and storage are
  slower too.
- **pdf.js's and pdfium's other strengths.** A viewer, forms and annotations cost time in pdf.js
  that a benchmark of reading doesn't credit.
