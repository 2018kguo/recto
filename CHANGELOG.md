# Changelog

## 0.3.0

Rendered pixels are now compared with pdfium, pdf.js and poppler, with `bench/scorecard.mjs`: on 539
small, mostly adversarial files recto agrees on 96.7% of the pages two of the others agree on, from 93.8%,
and the threshold can hide a missing line. See
`docs/benchmarks.md`.

### Added

- `doc.pageLabels()`: what each page is called. The same as pdf.js on all 16 suite files that have any.
- `bench/scorecard.mjs`, `bench/fuzz.mjs`, `bench/api-cases.mjs`, and a bounded fuzz test in CI.

### Fixed

Rendering:

- An annotation with no appearance stream was left out. Highlights, underlines, squiggles, strikeouts,
  squares, circles, lines, polylines, polygons, ink, free text and form fields are drawn from their
  dictionaries.
- A TrueType font whose `loca` runs backwards lost those glyphs.
- A hybrid file's `XRefStm` with the table's own `Prev` lost the xref, and the repair took old objects.
- A visibility expression (`/VE`) was ignored, and so was `/OC` on an annotation.
- A `Q` with no `q` in a form undid its caller's state.
- A form's `BBox` with its corners the other way round.
- From upstream hayro since 0.9.0: sub-pixel dashes drawn solid, a lone sign read as zero, streams only as an indirect
  object's value, xref streams not decrypted, nesting bounds on colour spaces and functions.

Text:

- CJK text in an embedded font with no `ToUnicode`, `Identity-H` included, was garbage. It now reads through the
  font's character collection.
- A `ToUnicode` map written with cidranges, and one with empty destinations (from upstream).

Damaged files, each a `crash`, a hang or all of memory before:

- A predictor with no columns or colours, or more than fit a byte.
- A short dash along a very long path. Past 65,536 dashes it's drawn solid.
- A huge dash offset.

Opening:

- A file whose password protects only its attachments opens without one.
- An xref that gives no pages is repaired by scanning the file.
- A page tree whose kids are all lost falls back to a scan, and the file is refused if that finds no page. It used to open with no
  pages. A tree that's honestly empty still does.
- A page with an empty, zero-area or missing `/MediaBox` takes the valid box above it, then Letter. It was A4.

## 0.2.0

The API is unchanged, with one addition. Numbers are from `docs/benchmarks.md`, measured on the same
set of PDFs before and after, in `bench/results`.

### Added

- `doc.renderAsync(i, { width, maxHeight?, signal?, sliceMs? })`: the same pixels as `render`, with
  the thread given back between slices, and a `signal` that stops it within one. The document stays
  usable. The last step, rasterizing, runs as one call: on a 300,000-shape page the longest hold
  falls from about 237 ms to about 59 ms, and a render stops in 0.3 ms.

### Changed

- **Two wasm builds.** In a browser a document starts on `recto-text.wasm` (0.50 MB with brotli,
  1.26 MB of download before, 0.53 MB now) and moves to `recto.wasm` on the first `render`,
  `renderAsync`, `objects` or `scan`, with no call to make. A page that does both now downloads both:
  1.72 MB where it was 1.26 MB, or about 1.22 MB with `preloadAssets: ["recto.wasm"]`. Node starts on
  the full engine, having no download to save; `preloadAssets: []` starts it on the text one.
- **A fresh page's first text** went from 99 ms to 32 ms, and first pixels from 108 ms to 66 ms: the
  smaller text wasm, and a wasm fetched up front is hashed by `crypto.subtle`, not in JavaScript. Every
  byte is still hashed before it compiles.
- **Opening** a whole file walks the page tree and builds each page the first time it's asked for.
  `/Count` no longer decides which page is which there. 2,000 pages in Node: 6.9 ms to 4.3 ms. A ranged file still finds a page by `/Count`,
  fetching what it did for wide nodes, and takes the walk when something on the way doesn't add up. Nodes
  of up to 32 kids are read in order, so a tree with pages deleted reads right: over 469 PDFs, reading the
  last page fetches 15% more in all, on 23 files, and at most 3 MB more on one.
- **`open` no longer copies the file in JavaScript** on top of copying it into WebAssembly memory,
  when an instance is ready.
- **Memory:** a render holds its pixels once. WebAssembly memory with a 40-page report open went from
  15.9 MB to 12.3 MB. By default an instance past 64 MiB now goes a second after its last
  document closes, unless an open reuses it first, and one past 512 MiB goes at the close, as it did. 300
  cycles on a 70 MiB file take 2.0 s and peak at 329 MB, with no WebAssembly memory held at rest (`recycle.json`). An
  explicit `recycleAboveBytes` still works as it did.
- A text pass reads no font file. The CMaps asset is now `cmaps.deflate` (0.36 MB, was
  `cmaps.brotli`, 0.25 MB), so neither wasm carries a brotli decoder. `preloadAssets` still takes the
  old name. A setup that copies the package's files by name to `assetBase` also needs
  `recto-text.wasm` and `cmaps.deflate`; copying `wasm/*`, as the docs say, needs nothing new.

### Fixed

- A ranged file with an inner page-tree node of one page lost that page.
- A page tree that repeats a kid now keeps the repeats: `/Kids [3 0 R 3 0 R 3 0 R]` is three pages, as
  in pdfium, pdf.js and poppler, where it was one. Only a node that's its own ancestor is skipped, and
  a tree built to multiply stops at a limit. A bookmark to a repeated page goes to its first place.
- A ranged file whose page tree loops ends with an error, and a node with as many kids as its `/Count`
  but a kid that isn't one page falls back to the walk.
