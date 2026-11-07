# Changelog

## 0.2.0

The API is unchanged, with one addition. Numbers are from `docs/benchmarks.md`, measured on the same
set of PDFs before and after.

### Added

- `doc.renderAsync(i, { width, maxHeight?, signal?, sliceMs? })`: the same pixels as `render`, with
  the thread given back between slices, and a `signal` that stops it within one. The document stays
  usable. The last step, rasterizing, runs as one call: on a 300,000-shape page the longest hold
  falls from about 235 ms to about 61 ms, and a render stops in 0.3 ms.

### Changed

- **Two wasm builds.** In a browser a document starts on `recto-text.wasm` (0.50 MB with brotli,
  1.26 MB of download before, 0.53 MB now) and moves to `recto.wasm` on the first `render`,
  `renderAsync`, `objects` or `scan`, with no call to make. A page that does both now downloads both:
  1.72 MB where it was 1.26 MB, or about 1.22 MB with `preloadAssets: ["recto.wasm"]`. Node starts on
  the full engine, having no download to save; `preloadAssets: []` starts it on the text one.
- **A fresh page's first text** went from 109 ms to 31 ms, and first pixels from 119 ms to 65 ms: a
  wasm fetched up front is checked by `fetch`'s `integrity` and compiled as it streams, not hashed in
  JavaScript.
- **Opening** a whole file walks the page tree and builds each page the first time it's asked for.
  `/Count` no longer decides which page is which there. A ranged file still finds a page by `/Count`,
  fetching what it did, and takes the walk when something on the way doesn't add up.
- **`open` no longer copies the file in JavaScript** on top of copying it into WebAssembly memory,
  when an instance is ready.
- **Memory:** a render holds its pixels once. WebAssembly memory with a 40-page report open went from
  15.9 MB to 12.3 MB. `recycleAboveBytes` now defaults to 64 MiB, from 512 MiB.
- A text pass reads no font file. The CMaps asset is now `cmaps.deflate` (0.36 MB, was
  `cmaps.brotli`, 0.25 MB), so neither wasm carries a brotli decoder.

### Fixed

- A ranged file with an inner page-tree node of one page lost that page.
- A page tree that repeats a kid now keeps the repeats: `/Kids [3 0 R 3 0 R 3 0 R]` is three pages, as
  in pdfium, pdf.js and poppler, where it was one. Only a node that's its own ancestor is skipped, and
  a tree built to multiply stops at a limit. A bookmark to a repeated page goes to its first place.
- A ranged file whose page tree loops ends with an error, and a node with as many kids as its `/Count`
  but a kid that isn't one page falls back to the walk.
