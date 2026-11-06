# Benchmarks

Every number here comes from one run of `bench/bench.mjs`, kept in
[`bench/results/0.1.0.json`](../bench/results/0.1.0.json) with the machine and versions.

Node 25.9.0 on an Apple M5 Pro (18 cores, 64 GB), which had other work running (load average 9.1 at the end of the run), so compare the ratios. pdf.js 6.5.438 in the same thread, 120 public PDFs (93 MB). Median of 5 alternating passes, after a warm-up pass.

| | recto | pdf.js | |
|---|---:|---:|---:|
| Text, first 20 pages of each (957 pages) | 593 ms | 3,076 ms | 5.2× |
| Render at 1024 px, first 2 pages of each (237 pages) | 1,599 ms | 6,676 ms | 4.2× |
| A fresh process to the first page's text, on the smallest file | 22 ms | 143 ms | 6.5× |

How to read it:

- **The PDFs** are 120 public documents, spread evenly over a directory of them. 0 were left out. They are not committed; bring your own.
- **Text** opens each document, reads each of its first 20 pages' text and closes it. recto's call also builds every char's box and word columns; pdf.js's `getTextContent` builds its items.
- **Render** opens each document and renders its first 2 pages at 1024 px wide. pdf.js draws through `@napi-rs/canvas`, then `getImageData`, so both sides end with the RGBA bytes.
- **Totals**, not per-file medians, so a slow file counts for what it costs.
- **In one thread**, pdf.js with its fake worker. Its buffer copy is outside the clock.

How much each read: recto found 1,480,941 non-whitespace characters and pdf.js 1,480,919 (100.0%), over the same pages. That is a count, not a comparison of the text itself.

What this does not measure: rendered pixels are not compared, and neither is memory. A browser run is not included.

The passes, in ms:

| | recto | pdf.js |
|---|---|---|
| Text | 578, 593, 577, 659, 626 | 2916, 2875, 3221, 4241, 3076 |
| Render | 1555, 1586, 1599, 1786, 1678 | 6523, 6676, 13853, 9102, 6529 |

## Sizes

`recto.wasm` is 4.1 MB (1.0 MB with brotli at quality 11). The assets load only when a document needs them: `fonts.bin` 0.26 MB, `cmaps.brotli` 0.25 MB, `cjk-fallback.ttf` 5.1 MB.

## Rerun it

```sh
npm run build
npm run bench -- path/to/pdfs --docs 120 --passes 5 --out bench/results/mine.json
```
