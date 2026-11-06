# Benchmarks

recto against pdf.js 6.5.438 and stock pdfium (`@embedpdf/pdfium` 2.15.1), on an Apple M5 Pro (18
cores, 64 GB) that had other work running, so compare the ratios. The raw results, with the machine
and versions, are in [`bench/results/`](../bench/results). Each section ends with the command that
reproduces it. A megabyte here is 10^6 bytes.

Each number is the median of 5 runs, in a fresh process or page, with the engines alternating run by
run. The brackets are 95% confidence intervals on the ratio to recto, bootstrapped: resampled from
the runs to see how much the ratio could move. Above 1× recto is faster; below it, the other engine
is. The PDFs are 60 public documents (33 MB) spread evenly over a directory of them, plus
generated ones; none is committed, so bring your own.

## In Node

Node 25.9.0, load average 5.4. Every engine runs on the calling thread: pdf.js with its fake
worker, drawing through `@napi-rs/canvas`, and pdfium through its `FPDF_` functions. All three end
with the same thing, a page's text or its RGBA bytes.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Text, first 20 pages of each (477 pages) | 275 ms | 1,296 ms (4.7× [4.4–9.2]) | 693 ms (2.5× [2.4–2.7]) |
| Render at 1024 px, first 2 pages of each (119 pages) | 649 ms | 2,898 ms (4.5× [4.2–5.3]) | 1,184 ms (1.8× [1.8–2.0]) |
| A fresh process to the first page's text | 61.6 ms | 189 ms (3.1× [2.8–4.0]) | 64.5 ms (1.1× [1.0–1.1]) |
| A fresh process to the first page's pixels | 73.6 ms | 225 ms (3.0× [2.8–3.9]) | 79.0 ms (1.1× [1.0–1.2]) |
| Warm: open, first page's text, close | 1.1 ms | 7.1 ms (6.2× [5.5–6.8]) | 1.7 ms (1.4× [1.4–1.6]) |
| Warm: open, first page's pixels, close | 5.3 ms | 21.4 ms (4.0× [4.0–4.5]) | 6.0 ms (1.1× [1.1–1.3]) |
| 2,000-page report: open | 8.3 ms | 40.8 ms (4.9× [4.5–5.4]) | 3.6 ms (0.4× [0.4–0.5]) |
| 2,000-page report: every page's text | 598 ms | 1,612 ms (2.7× [2.6–3.2]) | 823 ms (1.4× [1.3–1.5]) |
| 2,000-page report: render 5 pages | 27.7 ms | 84.2 ms (3.0× [2.8–3.4]) | 29.8 ms (1.1× [1.0–1.2]) |

- **Totals**, not per-file medians, so a slow file counts for what it costs. A warm-up pass comes
  first, and the buffer copies are outside the clock.
- **The columns differ.** recto's text call also builds every char's box and the word columns;
  pdf.js's `getTextContent` builds its items; pdfium's `FPDFText_GetText` returns a string. pdfium
  gives less for its time, and there are other calls to get more.
- **The characters** agree: 760,858 in recto, 760,844 in pdf.js, 760,858 in pdfium, not
  counting whitespace, over the same pages. That's a count. [Text quality](#text-quality) compares
  the words.
- **pdfium opens a large file faster** than recto (0.4×), and a fresh process is about even.

### Peak memory

The peak resident size of a process of its own, doing what the table above did.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| The 60 documents, text and render | 313 MB | 826 MB (2.6× [2.4–3.1]) | 346 MB (1.1× [1.0–1.1]) |
| The 2,000-page report | 257 MB | 439 MB (1.7× [1.7–1.9]) | 194 MB (0.8× [0.7–0.8]) |

pdf.js's includes its canvas package. pdfium uses less on the large file.

### What it does to the thread

The event loop's delay when an engine runs on the main thread, yielding between calls, as a server
would be if it did that, over the 60 documents. `monitorEventLoopDelay` at a 1 ms resolution. The
99th percentile equals the maximum on every engine, since a document makes only a few dozen calls,
so only the maximum is here.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| A typical document: its longest stall (median) | 6.3 ms | 18.8 ms | 10.5 ms |
| The worst document: its longest stall | 18.1 ms | 111 ms | 51.4 ms |

A stall that short comes from small calls. A page that's slow to draw stalls for as long as it
takes: put the work on a worker thread.

### Stopping a slow page

One generated page of 300,000 small shapes, rendered at 1024 px.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Rendering it to the end | 343 ms | 2,054 ms | 667 ms |
| Asked to stop 100 ms in: the time until the thread is free | 2.8 ms | 1,960 ms | 3.1 ms |

pdf.js has a real `cancel()`, but in Node the fake worker and the canvas share the thread, so the
request waits for most of the draw. recto and pdfium have no way to stop a call. All you can do is
`worker.terminate()`, which is immediate and takes the engine and its open documents with it.

```sh
npm run build
npm run bench -- path/to/pdfs
```

## In a browser

Chromium, at full speed (load average 5.9) and slowed to 3.3× (load average 7.4), at
800 px. Each engine in the arrangement its documentation gives: pdf.js with its parser in a worker
and drawing on the main thread, recto and pdfium doing both in a dedicated worker and posting the
bitmap. Each page is a fresh browser context, with no cache.

**The slowdown** stops the browser's whole process tree and resumes it, 2 ms on and 6 ms off, the way
`cpulimit` does. A fixed loop, timed in the page, measures what that comes to: 3.3× in place of
the 4× it's set to. Two others were tried and rejected. DevTools CPU throttling can't reach workers,
so it would slow pdf.js's drawing and not recto's. macOS background QoS slowed everything, but it
also made every timer and frame take 200 ms, which charged pdf.js 20× for the frames it waits on.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| Text, first 20 pages of each (41 pages) | 25.7 ms | 70.3 ms (2.7× [2.4–3.1]) | 54.5 ms (2.1× [1.8–2.1]) |
| at 3.3× | 106 ms | 292 ms (2.8× [2.4–3.0]) | 216 ms (2.0× [1.8–2.3]) |
| Render at 800 px, first 2 of each (16 pages) | 93.7 ms | 311 ms (3.3× [2.7–3.6]) | 186 ms (2.0× [1.6–2.1]) |
| at 3.3× | 358 ms | 726 ms (2.0× [1.8–2.2]) | 703 ms (2.0× [1.8–2.2]) |
| A fresh page to the first page's text | 107 ms | 61.7 ms (0.6× [0.5–0.6]) | 43.5 ms (0.4× [0.3–0.5]) |
| at 3.3× | 446 ms | 270 ms (0.6× [0.6–0.7]) | 221 ms (0.5× [0.5–0.6]) |
| A fresh page to the first page's pixels | 117 ms | 99.4 ms (0.8× [0.7–0.9]) | 55.6 ms (0.5× [0.4–0.5]) |
| at 3.3× | 484 ms | 417 ms (0.9× [0.8–0.9]) | 261 ms (0.5× [0.5–0.7]) |
| Warm: open, first page's text, close | 0.9 ms | 1.4 ms (1.6× [1.3–1.7]) | 0.8 ms (0.9× [0.8–1.1]) |
| at 3.3× | 0.9 ms | 2.0 ms (2.2× [1.3–10.1]) | 1.1 ms (1.2× [1.0–8.0]) |
| Warm: open, first page's pixels, close | 3.0 ms | 14.3 ms (4.8× [4.1–5.3]) | 4.7 ms (1.6× [1.3–1.8]) |
| at 3.3× | 10.8 ms | 21.1 ms (1.9× [1.2–2.6]) | 19.1 ms (1.8× [1.1–2.3]) |
| A 40-page report, every page read and drawn in a grid | 112 ms | 665 ms (5.9× [4.5–6.0]) | 150 ms (1.3× [1.0–1.4]) |
| at 3.3× | 430 ms | 993 ms (2.3× [2.1–2.4]) | 598 ms (1.4× [1.3–1.7]) |
| A 500-page report: every page's text | 140 ms | 321 ms (2.3× [1.8–2.6]) | 226 ms (1.6× [1.3–1.7]) |
| at 3.3× | 542 ms | 1,282 ms (2.4× [2.2–2.4]) | 898 ms (1.7× [1.6–2.1]) |
| A 500-page report: render 5 pages | 11.5 ms | 75.8 ms (6.6× [5.6–7.2]) | 16.6 ms (1.4× [1.2–1.5]) |
| at 3.3× | 47.1 ms | 108 ms (2.3× [1.9–2.6]) | 65.7 ms (1.4× [1.2–1.6]) |

- **A fresh page** is where recto loses: it's the slowest to start, by about 2.4× against pdfium on
  text. It loads 12 unminified modules and a 4.1 MB wasm, plus the standard fonts here.
- **pdf.js waits for a frame** as it draws, so that it won't hold the main thread. At full speed
  that's about 16 ms a page whatever the page costs, and it's most of the 40-page report's 6× and
  the warm render's 5×. It's a design choice, and a reader on a page may well prefer it. Slowed, the
  drawing weighs more than the frame and the ratio falls to about 2×. Text and the corpus render
  are the ones to read for raw speed.
- **At the slowdown**, anything very small is close to the 8 ms a cycle takes, so warm numbers and
  the open times mean little there.

### What a page downloads

From the responses a real page load made, for that document's first page: JavaScript, wasm and
assets, then the same with brotli in brackets.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| A text-only report, first page | 4.52 MB (1.26 MB) | 1.75 MB (0.42 MB) | 4.94 MB (1.70 MB) |
| A CJK document without embedded fonts, first page | 9.58 MB (3.16 MB) | 1.82 MB (0.48 MB) | 4.94 MB (1.70 MB) |

With brotli, pdf.js is about a third of the size. recto's JavaScript isn't minified, though that's 110 KB out of
4.5 MB; the wasm is what weighs. On the CJK row the difference is recto's 5 MB fallback font, which draws
CJK the document doesn't embed in any environment. pdf.js and pdfium downloaded no font for it, so
what they draw depends on the system; this benchmark doesn't compare what they drew.

### What's left in memory

With the 40-page report still open, after a full collection, in a page of its own. Canvases are not
counted, and those are the same on all three.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| JS heap, page and workers | 1.3 MB | 5.6 MB | 2.0 MB |
| WebAssembly memory | 15.9 MB | 0.0 MB | 18.6 MB |

pdf.js holds the least. recto and pdfium keep the file and their state in WebAssembly memory, which
never shrinks while the instance lives.

### What it does to the threads

Full speed / slowed. **Stutter** is the time the main thread spent past 50 ms in long tasks, which a
reader feels as dropped frames and delayed input. **A stretch in a worker** is the longest time a
worker took no timer: there, the longest call it couldn't interrupt. The floor at the slowdown is
about 20 ms.

| | recto | pdf.js | pdfium |
|---|---:|---:|---:|
| 40-page report: main-thread stutter | 0.0 ms / 0.0 ms | 0.0 ms / 0.0 ms | 0.0 ms / 0.0 ms |
| 40-page report: longest stretch in a worker | 6.3 ms / 21.1 ms | 6.8 ms / 11.9 ms | 7.3 ms / 20.5 ms |
| Heavy page: all of it | 337 ms / 1,290 ms | 1,066 ms / 4,348 ms | 814 ms / 3,284 ms |
| Heavy page: main-thread stutter | 0.0 ms / 0.0 ms | 0.0 ms / 464 ms | 0.0 ms / 0.0 ms |
| Heavy page: longest main-thread task | 0.0 ms / 0.0 ms | 0.0 ms / 149 ms | 0.0 ms / 0.0 ms |
| Heavy page: longest stretch in a worker | 258 ms / 987 ms | 214 ms / 813 ms | 564 ms / 2,319 ms |

The heavy page is the same 300,000 shapes.

- **On the report, nobody stutters**, pdf.js included, drawing on the main thread: it slices its
  drawing and yields.
- **On the heavy page**, pdf.js's slices stop being short once slowed. recto and pdfium keep the
  main thread free, as a worker does for any engine, and that holds for a page of any weight.
- **pdf.js's render task can be cancelled**: 2.7 ms at full speed and 0.8 ms slowed, from
  the moment it's asked. In a browser that works, because the drawing is what's yielding. recto and
  pdfium can only have their worker terminated, about 3 ms in Node.

```sh
npm run bench:browser -- path/to/pdfs   # add --slowdown 1 for full speed
```

## The film

[`recto-film.gif`](recto-film.gif) is a recording of each engine alone, 240 pages of a generated
report at 800 px, then cut side by side. The counters are measured in the page. Each engine was
recorded three times in turn, and the film shows the median take. It finished 2.1× sooner, close to
the table's 2.3× at the same slowdown; the screencast takes time from both. `npm run assets` remakes
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
