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
own. [Transparency](#transparency) was measured earlier on a different set of 60, and
[Text quality](#text-quality), [the scorecard](#the-scorecard) and [Damaged files](#damaged-files) on the
sets they name; none is comparable with the tables here; recto's output
on this set is byte for byte what it was before 0.2.0.

## In Node

Node 24.22.1, load average 2.1. Every engine runs on the calling thread: pdf.js with its fake
worker, drawing through `@napi-rs/canvas`, and pdfium through its `FPDF_` functions. All three end
with the same thing, a page's text or its RGBA bytes.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Text, first 20 pages of each (348 pages) | 311 ms | 1,166 ms (3.8× [3.6–4.0]) | 723 ms (2.3× [2.3–2.4]) |
| Render at 1024 px, first 2 pages of each (64 pages) | 229 ms | 1,192 ms (5.2× [5.1–5.3]) | 980 ms (4.3× [4.3–4.3]) |
| A fresh process to the first page's text | 31.1 ms | 136 ms (4.4× [4.3–4.8]) | 32.7 ms (1.1× [1.0–1.1]) |
| A fresh process to the first page's pixels | 40.9 ms | 168 ms (4.1× [4.0–4.4]) | 45.4 ms (1.1× [1.1–1.1]) |
| Warm: open, first page's text, close | 0.5 ms | 4.1 ms (8.5× [7.5–8.6]) | 1.0 ms (2.0× [1.8–2.0]) |
| Warm: open, first page's pixels, close | 2.6 ms | 12.3 ms (4.8× [4.6–5.0]) | 3.6 ms (1.4× [1.3–1.6]) |
| 2,000-page report: open | 4.3 ms | 36.3 ms (8.5× [8.4–8.6]) | 2.9 ms (0.7× [0.7–0.7]) |
| 2,000-page report: every page's text | 610 ms | 1,659 ms (2.7× [2.7–2.8]) | 910 ms (1.5× [1.5–1.5]) |
| 2,000-page report: render 5 pages | 24.6 ms | 76.2 ms (3.1× [3.0–3.2]) | 29.4 ms (1.2× [1.2–1.2]) |

- **Totals**, not per-file medians, so a slow file counts for what it costs. A warm-up pass comes
  first, and the buffer copies are outside the clock.
- **The columns differ.** recto's text call also builds every char's box and the word columns;
  pdf.js's `getTextContent` builds its items; pdfium's `FPDFText_GetText` returns a string. pdfium
  gives less for its time, and there are other calls to get more.
- **The characters** agree: 976,693 in recto, 967,399 in pdf.js, 976,704 in pdfium, not
  counting whitespace, over the same pages. That's a count. [Text quality](#text-quality) compares
  the words.
- **pdfium still opens a large file faster** (0.7×): 2.9 ms against 4.3 ms, first open in a fresh process. recto walks
  the whole page tree on open, reading every kid, so `/Count` can't change the page count or which page is which. A fresh process is about even.

### Peak memory

The peak resident size of a process of its own, doing what the table above did.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| The 37 documents, text and render | 300 MB | 703 MB (2.3× [2.2–2.4]) | 312 MB (1.0× [1.0–1.0]) |
| The 2,000-page report | 215 MB | 456 MB (2.1× [2.1–2.2]) | 196 MB (0.9× [0.9–0.9]) |

pdf.js's includes its canvas package. pdfium uses less on the large file.

### What it does to the thread

The event loop's delay when an engine runs on the main thread, yielding between calls, as a server
would be if it did that, over the 37 documents. `monitorEventLoopDelay` at a 1 ms resolution. The
99th percentile equals the maximum on every engine, since a document makes only a few dozen calls,
so only the maximum is here.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| A typical document: its longest stall (median) | 3.1 ms | 11.3 ms | 3.7 ms |
| The worst document: its longest stall | 16.0 ms | 53.2 ms | 262 ms |

A stall that short comes from small calls. A page that's slow to draw stalls for as long as it
takes with `render`: use `renderAsync`, or put the work on a worker thread.

### Stopping a slow page

One generated page of 300,000 small shapes, rendered at 1024 px.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Rendering it to the end | 315 ms | 1,568 ms | 664 ms |
| Asked to stop 100 ms in: the time until the thread is free | 0.3 ms | 1,472 ms | 2.2 ms |

recto's is `renderAsync` with a `signal`, on the same thread, and the document stays open. pdf.js has a
real `cancel()`, but in Node the fake worker and the canvas share the thread, so the request waits for
most of the draw. pdfium has no way to stop a call: all you can do is `worker.terminate()`, which is
immediate and takes the engine and its open documents with it, as it does for recto's `render`.

What slicing costs and gives, from `bench/sliced.mjs`, on the same page: `render` takes 246 ms and holds
the thread for all of it.

| `sliceMs` | Whole render | Longest the thread is held |
|---:|---:|---:|
| 2 | 249 ms | 66.2 ms |
| 4 | 250 ms | 67.8 ms |
| 8 | 248 ms | 67.0 ms |
| 16 | 249 ms | 67.6 ms |

The whole render costs about the same, within this machine's noise. The longest hold is the last step, rasterizing, which runs as
one call whatever `sliceMs` says; every other slice keeps to it. On a 4.0 s page of 4 million shapes, stopped
200 ms in, the stop took 0.2 ms, and the document rendered in full afterwards.

```sh
npm run build
npm run bench -- path/to/pdfs
node bench/sliced.mjs
```

## In a browser

Chromium, at full speed (load average 3.1) and slowed to 4.8× (load average 1.5), at
800 px. Each engine in the arrangement its documentation gives: pdf.js with its parser in a worker
and drawing on the main thread, recto and pdfium doing both in a dedicated worker and posting the
bitmap. Each page is a fresh browser context, with no cache.

**The slowdown** stops the browser's whole process tree and resumes it, 2 ms on and 6 ms off, the way
`cpulimit` does. A fixed loop, timed in the page, measures what that comes to: 4.8× here, with the 4× it's set to. Two others were tried and rejected. DevTools CPU throttling can't reach workers,
so it would slow pdf.js's drawing and not recto's. macOS background QoS slowed everything, but it
also made every timer and frame take 200 ms, which charged pdf.js 20× for the frames it waits on.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Text, first 20 pages of each (52 pages) | 56.7 ms | 185 ms (3.3× [3.1–3.4]) | 149 ms (2.6× [2.5–2.6]) |
| at 4.8× | 255 ms | 844 ms (3.3× [3.1–3.7]) | 698 ms (2.7× [2.5–3.0]) |
| Render at 800 px, first 2 of each (13 pages) | 60.6 ms | 216 ms (3.6× [3.5–3.6]) | 89.0 ms (1.5× [1.4–1.6]) |
| at 4.8× | 274 ms | 438 ms (1.6× [1.6–1.8]) | 434 ms (1.6× [1.5–1.7]) |
| A fresh page to the first page's text | 32.4 ms | 55.2 ms (1.7× [1.5–1.8]) | 43.1 ms (1.3× [1.1–1.4]) |
| at 4.8× | 178 ms | 277 ms (1.6× [1.4–1.7]) | 199 ms (1.1× [1.0–1.4]) |
| A fresh page to the first page's pixels | 65.9 ms | 84.6 ms (1.3× [1.2–1.5]) | 54.2 ms (0.8× [0.7–0.8]) |
| at 4.8× | 341 ms | 415 ms (1.2× [1.2–1.3]) | 251 ms (0.7× [0.7–0.9]) |
| Warm: open, first page's text, close | 0.5 ms | 1.3 ms (2.6× [2.2–2.8]) | 0.8 ms (1.6× [1.3–1.6]) |
| at 4.8× | 7.2 ms | 1.4 ms (0.2× [0.2–2.3]) | 1.2 ms (0.2× [0.1–2.0]) |
| Warm: open, first page's pixels, close | 2.5 ms | 15.1 ms (6.0× [4.8–6.4]) | 4.4 ms (1.8× [1.7–1.8]) |
| at 4.8× | 9.9 ms | 20.8 ms (2.1× [1.7–3.0]) | 20.3 ms (2.0× [1.8–2.2]) |
| A 40-page report, every page read and drawn in a grid | 102 ms | 663 ms (6.5× [6.4–6.6]) | 141 ms (1.4× [1.4–1.4]) |
| at 4.8× | 445 ms | 1,177 ms (2.6× [2.5–2.7]) | 631 ms (1.4× [1.4–1.4]) |
| A 500-page report: open | 0.4 ms | 2.0 ms (5.0× [5.0–7.3]) | 0.3 ms (0.8× [0.5–1.0]) |
| at 4.8× | 1.1 ms | 9.6 ms (8.7× [7.9–25.2]) | 0.3 ms (0.3× [0.2–1.0]) |
| A 500-page report: every page's text | 131 ms | 306 ms (2.3× [2.2–2.4]) | 205 ms (1.6× [1.5–1.6]) |
| at 4.8× | 603 ms | 1,387 ms (2.3× [2.3–2.3]) | 986 ms (1.6× [1.6–1.7]) |
| A 500-page report: render 5 pages | 9.7 ms | 87.3 ms (9.0× [7.9–9.1]) | 15.0 ms (1.6× [1.4–1.6]) |
| at 4.8× | 48.9 ms | 107 ms (2.2× [2.0–2.9]) | 60.3 ms (1.2× [1.2–1.3]) |

- **A fresh page**: recto is first to text (32.4 ms against 55.2 ms and 43.1 ms), on the 0.5 MB text engine, its wasm hashed by
  `crypto.subtle` before it compiles. **pdfium is first to pixels** (54.2 ms against 65.9 ms):
  a render pays once for loading the full engine and reopening the file on it.
- **pdfium opens faster** here too: 0.3 ms against 0.4 ms on 500 pages at full speed. At the slowdown both are
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
| A report, first page's text, never drawn | 1.85 MB (0.53 MB) | 1.75 MB (0.42 MB) | 4.94 MB (1.70 MB) |
| A report, first page's text and pixels | 5.95 MB (1.72 MB) | 1.75 MB (0.42 MB) | 4.94 MB (1.70 MB) |
| A CJK document without embedded fonts, first page | 11.12 MB (3.73 MB) | 1.82 MB (0.48 MB) | 4.94 MB (1.70 MB) |

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
page's pixels at 3.3 MB and what the page's drawing used, which then stays. Past 64 MiB, a second with nothing open gives it all back.

### What it does to the threads

Full speed / slowed. **Stutter** is the time the main thread spent past 50 ms in long tasks, which a
reader feels as dropped frames and delayed input. **A stretch in a worker** is the longest time a
worker took no timer: there, the longest call it couldn't interrupt. The floor at the slowdown is
about 20 ms.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| 40-page report: main-thread stutter | 0.0 ms / 0.0 ms | 0.0 ms / 0.0 ms | 0.0 ms / 0.0 ms |
| 40-page report: longest stretch in a worker | 6.4 ms / 22.0 ms | 6.9 ms / 11.5 ms | 7.2 ms / 20.5 ms |
| Heavy page: all of it | 305 ms / 1,396 ms | 953 ms / 4,632 ms | 749 ms / 3,511 ms |
| Heavy page: main-thread stutter | 0.0 ms / 0.0 ms | 0.0 ms / 458 ms | 0.0 ms / 0.0 ms |
| Heavy page: longest main-thread task | 0.0 ms / 0.0 ms | 0.0 ms / 148 ms | 0.0 ms / 0.0 ms |
| Heavy page: longest stretch in a worker | 230 ms / 1,042 ms | 204 ms / 911 ms | 520 ms / 2,465 ms |
| Heavy page with `renderAsync`: all of it | 256 ms / 1,190 ms | | |
| Heavy page with `renderAsync`: longest stretch in a worker | 58.6 ms / 273 ms | | |

The heavy page is the same 300,000 shapes.

- **On the report, nobody stutters**, pdf.js included, drawing on the main thread: it slices its
  drawing and yields.
- **On the heavy page**, pdf.js's slices stop being short once slowed. recto and pdfium keep the
  main thread free, as a worker does for any engine, and that holds for a page of any weight.
- **Both can be stopped in a browser now.** pdf.js's render task: 0.5 ms at full speed and 0.7 ms slowed, from the moment it's
  asked. recto's `renderAsync` stops at the next pause. pdfium can only have its worker terminated, about 3 ms in Node.
- **With `renderAsync`** the longest stretch falls by about 4×, and that stretch is its one rasterizing call. It's
  under a third of pdf.js's.

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

## Giving memory back

300 cycles of open, text, render and close on a 70 MiB file. At rest is 2.5 s later, after a collection, in a
process that still holds the file. The default is a second idle past 64 MiB, and the close past 512 MiB.

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
| Agrees with them | **96.7%** of 546 | 92.2% of 565 | 88.0% of 582 | 76.5% of 600 |
| Blank where they draw | 3 | 6 | 4 | 8 |
| Fails where they draw | 1 | 4 | 3 | 4 |
| A different page shape | 1 | 1 | 0 | 2 |

| By set (recto) | Pages judged | Agrees |
|---|---:|---:|
| 39 public PDFs | 79 | 98.7% |
| 250 from pdf.js's test suite | 239 | 96.2% |
| 100 from pdfium's | 100 | 98.0% |
| 150 from hayro's | 128 | 95.3% |

Before this round recto agreed on 93.8%. Don't read 96.7% as "better than pdfium". Poppler's low score
is mostly how it hints small text at this size, and that makes pages count against pdf.js and pdfium that
it wouldn't against recto: the others are judged on pages where recto is one of the two that agree. The set is
539 small files, mostly written to break things, and the limit is generous: a missing line of text can
pass, which is why the report also ranks pages under the limit that are well past the references' own
difference. Of 632 pages, 86 aren't judged at all, because no two others agree.

What's left of the 18 pages, from looking at each: an empty `/CropBox` that recto draws at A4 where the others use
the media box, 3 where recto follows the spec and the references don't (a Type 3 glyph's `ca`, knockout groups), 8 of
rounding and thin-line noise, a Brotli stream two references can't read, a file with no page tree that recto refuses,
a tiling pattern on text and a blend against bare paper the references don't agree on either, and 2 small differences in a
mask and an image's edges.

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

Three more seeds (180,000 files) also found nothing. That says it's hard to find another with this
fuzzer, not that there isn't one: a page can still take seconds and hold hundreds of megabytes.

Which of 1,000 such files each engine opens with at least one page: recto 753, poppler 510, pdf.js 506, pdfium 501.
That's less of a win than it looks. In 23 files two others open one where recto doesn't, and many of those pages are only a
trusted `/Count`: of the 27 such files before this fix, pdf.js reported a page in 16 and then couldn't load it. Where the page object itself
is damaged recto refuses the file. One file opened with no pages, down from 55; the others now scan or are refused.

`js/test/fuzz.test.ts` does the same to generated PDFs in CI, 20,000 files in 3 s, stopping at 30 s.

```sh
node bench/fuzz.mjs path/to/pdfs [--seed 1] [--count 2000] [--repair] [--results file.json]
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
