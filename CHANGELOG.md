# Changelog

## 0.3.0

Rendered pixels are now compared with pdfium, pdf.js and poppler, with `bench/scorecard.mjs`: on 539
small, mostly adversarial files recto agrees on 96.9% of the pages two of the others agree on, from 93.8%,
and the threshold can hide a missing line. See
`docs/benchmarks.md`.

### Added

- `createPdfPool`: pages read and drawn across worker threads, in Node and in a browser, with no
  special headers. See [the numbers](docs/benchmarks.md#across-threads).
- `doc.structureTruncated()`: whether a limit cut the page tree, labels or outline short, or a damaged tree left no pages.
- `doc.pageLabels()`: what each page is called. The same as pdf.js on all 16 suite files that have any.
- `totalTimeoutMs` on `openRanged`: wall time for the whole read. A stalled fetch is cut at what's left. It bounds the network
  waits, not the parsing between them: on a stalled 255 MB file the call threw about 15 ms past the limit. In WebKit, a
  response that keeps trickling is cut by neither this nor `timeoutMs`; a full stall is, about a second after a 500 ms limit.
- `error.status` on `fetch-failed`: the HTTP status when one is known, undefined when none is (a refused connection, a
  redirect loop, a response cut mid-stream).
- `@2018kguo/recto/wasm/*` in `exports`: the files, and `wasm/pins.mjs` for the list of them.
- `bench/scorecard.mjs`, `bench/fuzz.mjs`, `bench/fuzz-structures.mjs`, `bench/api-cases.mjs`, `examples/budgets.rs`, and a bounded fuzz test in CI.

### Fixed

A ranged read that failed went on to repair the file: a scan of its length of zeros, 0.7 s on a 255 MB file, before the call threw. It stops at the failed read now.

Rendering:

- An annotation with no appearance stream was left out. Highlights, underlines, squiggles, strikeouts,
  squares, circles, lines, polylines, polygons, ink, free text and form fields are drawn from their
  dictionaries; a combo box shows its option's display text, and a list box its options. A widget the form doesn't list stays
  blank, as in pdfium, pdf.js and poppler.
- A TrueType font whose `loca` runs backwards lost those glyphs.
- A hybrid file's `XRefStm` with the table's own `Prev` lost the xref, and the repair took old objects.
- A visibility expression (`/VE`) was ignored, and so was `/OC` on an annotation, direct or not.
- A `Q` with no `q` in a form undid its caller's state.
- A form's `BBox` with its corners the other way round.
- From upstream hayro since 0.9.0: sub-pixel dashes drawn solid, a lone sign read as zero, streams only as an indirect
  object's value, xref streams not decrypted, nesting bounds on colour spaces and functions.

Text:

- CJK text in an embedded font with no `ToUnicode`, `Identity-H` included, was garbage. It now reads through the
  font's character collection.
- A `ToUnicode` map written with cidranges, and one with empty destinations (from upstream).

Files built to cost, a hang or a `crash` before, now stopping at a budget: page labels, destination names and `/VE` whose nodes
name the next twice; forms, patterns and Type 3 glyphs that draw the next twice; a large page repeated in `/Kids` or a large
annotation in `/Annots` (read once each, drawn once each); annotations with no appearance that ask for gigabytes of stream.
A page cut short has `truncated` true on what `text`, `objects`, `render` and `renderAsync` return.

Damaged files, each a `crash`, a hang or all of memory before:

- A predictor with no columns or colours, or more than fit a byte.
- A short dash along a very long path. Past 65,536 dashes it's drawn solid.
- A huge dash offset.

Opening:

- A file whose password protects only its attachments opens without one.
- An xref that gives no pages is repaired by scanning the file.
- A page tree whose kids are all lost falls back to a scan. A tree that's honestly empty is a document with no pages, with
  nothing scanned or fetched.
- A repair took an older plain copy over a newer one in an object stream, and free entries were ignored, in the scan and in the
  xref chain. What a later revision removes stays removed.
- A page a scan finds inherits through its `/Parent`.
- A page with an empty, zero-area or missing `/MediaBox` takes the valid box above it, then Letter. It was A4.
- A `/CropBox` with no area, or outside the media box, gives way to the media box. It was A4.
- `/Identity` names planted in a file before `/V` 4 don't open it with no password.
- A one-row image under a TIFF predictor was empty.

### Changed

- **One wasm in four parts**: `recto.wasm` for text (0.38 MB with brotli),
  `recto-render.wasm` for drawing (0.26 MB), `recto-more.wasm` and `recto-rare.wasm` for functions few files run (0.26
  and 0.19 MB). A part loads inside the call that needs it, onto the same instance, and the constant tables only a
  part's code reads go with it. Text then pixels in a browser
  downloads 0.70 MB and text alone 0.41 MB, 11 KB under pdf.js, where 0.1.0 downloaded 1.26 MB for either, and a fresh page's first pixels go from
  108 ms to 52 ms; its first text from 99 ms to 34 ms. Output is byte for byte
  the same on 2,170 PDFs, whole and ranged. Drawing costs 2% more in Node, calls across the boundary, and text 2% less. The build is the same bytes on any machine.
  If a part fails to load mid-call, the call throws `missing-asset`, open documents stay usable and the next call retries.
- **The standard fonts are a file each**, not `fonts.bin`: a page that draws one fetches 13–25 KB where it fetched
  213 KB. `preloadAssets` still takes `fonts.bin`, meaning all 14; an `assetBase` directory needs the new files.
- **`createPdfPool` can't wait for ever**: a thread that can't start fails what's waiting, typed, and a pool from a CDN starts its threads through a blob.
- `preloadAssets` means one thing everywhere: what's named is fetched and verified while the engine is created. Name
  `recto-render.wasm` to save the first `render` the wait, or all three parts to find a missing one at startup.
- **Glyph and metric tables** are sorted bytes, not `phf` maps, and the table from a character to its
  glyph name is built on first use: 40 KB less to download with brotli. Reading text costs about 2% more, since
  opening a font bisects where it hashed.
- **Opening a large file is faster**: the open notes where each page's dictionary is and builds it at the page's first
  read. A 2,000-page report opens in 4.1 ms in a fresh process, from 4.8 ms (pdfium 2.8 ms), and a page tree of
  32,768 pages takes 46.8 MB opened and read through, from 62.8 MB. Page counts, damaged trees and every page's output
  are the same on 2,170 PDFs and 6,000 damaged or generated ones, whole and ranged.
- **An idle instance gives its memory back at any size**: by default it goes a second after its last document closes
  once it has grown at all, where it waited for 64 MiB. A 40-page report, read and drawn through in Node, left 16.4 MB
  of WebAssembly memory held for as long as the engine lived; now none. An open after that second gets a fresh
  instance, which parses its fonts and CMaps again: open, first page and close took 2.7–6 ms longer (standard fonts,
  text 2.8 to 5.5 ms and render 4.7 to 10.4 ms; CJK, text 2.4 to 8.3 ms and render 2.4 to 9.5 ms). To keep the
  instance, pass a high `recycleAboveBytes`, such as 512 MiB: below it, an instance stays however long it's idle.

### Building

- Building recto from source needs `wasm-split` and `wasm-dis` from binaryen version_133 and Rust 1.96.0. Installing the package doesn't.

## 0.2.0

Never published: everything here reached npm in 0.3.0, read from 0.1.0. The API is unchanged, with one addition.
Numbers are from `docs/benchmarks.md`, measured on the same set of PDFs before and after, in `bench/results`.

### Added

- `doc.renderAsync(i, { width, maxHeight?, signal?, sliceMs? })`: the same pixels as `render`, with
  the thread given back between slices, and a `signal` that stops it within one. The document stays
  usable. The last step, rasterizing, runs as one call: on a 300,000-shape page the longest hold
  falls from about 237 ms to about 59 ms, and a render stops in 0.3 ms.

### Changed

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
  `cmaps.brotli`, 0.25 MB), so the wasm carries no brotli decoder. `preloadAssets` still takes the
  old name. A setup that copies the package's files by name to `assetBase` also needs
  `cmaps.deflate`; copying `wasm/*`, as the docs say, needs nothing new.

### Fixed

- A ranged file with an inner page-tree node of one page lost that page.
- A page tree that repeats a kid now keeps the repeats: `/Kids [3 0 R 3 0 R 3 0 R]` is three pages, as
  in pdfium, pdf.js and poppler, where it was one. Only a node that's its own ancestor is skipped, and
  a tree built to multiply stops at a limit. A bookmark to a repeated page goes to its first place.
- A ranged file whose page tree loops ends with an error, and a node with as many kids as its `/Count`
  but a kid that isn't one page falls back to the walk.
