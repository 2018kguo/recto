# Changelog

## Unreleased

### Changed

- **The viewer's first page no longer waits for the whole file.** A URL is opened by range from its first
  request, which goes out while the engine's wasm is still downloading, so the first page needs only the
  file's head, tail and its own objects; a file up to 8 MiB then downloads the rest in one background
  request once that page is drawn (a search waits for it), and a larger one is read only by range, as
  before. The viewer and its worker ship bundled, a file each, so the code is two round trips, not ten;
  the standard fonts a page names are fetched together before it's drawn, not one after another while it
  is. On bench/compare's 200-page report, the first page at Slow 4G: FIRST_PAGE_TABLE.
- **A zoom past a whole page's pixel cap is sharp at once.** The part on screen is drawn at the screen's
  density first, with no margin, and the whole pages at the cap after it, where it was the other way
  round, each behind a pause: 300% sharp in ZOOM_NUMBER.

### Added

- `startRangedRead(url)` starts a ranged read before there is an engine; `engine.openRanged(read)` opens
  it. `doc.fetchRest()` downloads the rest of a ranged file in the background, in pieces that follow the reader and never fetch a byte twice, after which no read blocks.
  `engine.preload(names)` fetches fonts and other assets together, ahead of the call that needs them.
  `stats().heldBytes` is what a ranged read's loader still holds.

### Fixed

- A file past the viewer's whole-file cut was asked for whole first, then by range: 27.4 MB downloaded for a
  13.2 MB file at Slow 4G. Every request for it is a range now.
- A ranged read held each byte twice, once in the loader and once in the engine; the loader now drops what
  the engine has read. A document reopened on a fresh instance fetches it again.

## 0.7.0

### Added

- **Tight character boxes: `text(i, { boxes: "tight" })`.** Each char's box is its glyph's outline bounds
  from the font program (for a Type 3 glyph, what its procedure draws), through the matrix it's drawn with,
  as pdfium's `FPDFText_GetCharBox` gives; word boxes unite them. Against pdfium's tight boxes on 388,076
  chars of the public set and the three test suites, the median char's IoU is 0.998 (10th percentile
  0.982, 96.5% at 0.8 or more), where font boxes were at 0.426; words 0.999, from 0.634. Against the ink of
  a render, recto's tight boxes and pdfium's are level (0.846 and 0.848). Type 3 text, whose font boxes
  were a fixed 0.8 and −0.2 em wherever its glyphs were drawn, goes from 0.086 to 0.989. The text is the
  same with either box, and font boxes stay the default: they cost nothing, since they come from the
  font's dictionary, where tight boxes load the font programs, standard fonts and the part of the wasm
  that drawing loads (1.35 ms a page at the median file, from 0.99, including the loading). `PdfPool`'s
  `text` takes the option too. `bench/box-compare.mjs` measures it, and
  [character boxes](docs/benchmarks.md#character-boxes) has the numbers. The Rust crate has
  `Document::text_with` and `scan_with` and `Boxes`.

  Text reads the same on all 531 files of the scoreboard, at the same speed; reading text downloads 1.8 kB
  more (brotli), drawing 1.4 kB.
- **`bench/wild.mjs`, and a "Real-world files" section in docs/benchmarks.md.** It runs 7,000 PDFs drawn at random
  from Common Crawl (the SafeDocs CC-MAIN-2021-31-PDF-UNTRUNCATED corpus) through recto, pdf.js and pdfium, each
  file and engine in a fresh process with 20 s and 2 GB. recto had no crash, no timeout and nothing past the memory
  limit. It did worse than another engine on 2 files, and the cause is fixed separately. `bench/engines.mjs`'s
  pdfium adapter now throws when a page doesn't load, instead of passing a null page on.
- **A viewer: `@2018kguo/recto/viewer`.** `createViewer({ container, source })` shows a PDF in a scrolling
  element, in plain DOM with no dependencies, about 17 kB brotli on the page and nothing for a program
  that doesn't import it. Pages are drawn in Web Workers only as they near the screen, nearest first,
  and a page the reader left has its render stopped; painted pages are held to a pixel budget. Zoomed
  past a whole page's pixel cap, the part on screen is drawn again at the screen's density as a tile.
  A text layer makes text selectable, with links (web and mail only; links within the file scroll to
  their destination). Zoom stretches the drawn page at once and swaps in a sharp one when the zoom
  settles, keeping the point under the pointer still; a pinch (touch, trackpad, ctrl + wheel) is
  previewed as a transform and laid out once at its end, and the keyboard zooms. `find` searches every
  page in the worker, Unicode-normalized (ligatures, full width, combining accents, case folding), and
  returns boxes; `setHighlights` draws them. A failed read or a crashed worker reopens the document on
  the next call, backing off while a server stays down. Hooks for open and render timing.
  `defineViewerElement()` adds `<recto-viewer src>` with a small toolbar (sidebar, name, page, zoom,
  find) and a sidebar of lazily drawn page thumbnails and the outline. `npm run demo` opens a dropped
  file in it, by range when it's large. See [docs/viewer.md](docs/viewer.md).

### Changed

- **A large file's first open is about 30% faster, level with pdfium's where it was 0.7×.** On a 2,000-page
  report in Node, 8 alternating rounds: 5.0 ms where 0.6.0 took 7.0, and pdfium 5.4. V8 compiles a wasm function
  on its first call, so the first open in a process paid 1.5–2 ms to compile the open's code. A module's first
  instance now opens a one-page file of its own as `createPdfEngine` starts it, so that's paid before a caller's
  file arrives; a fresh process's time to its first text or pixels is unchanged, since the same code is compiled
  either way. The open's page walk, which reads every page's dictionary so that `/Count` can't change the page
  count, does 9% less work (instructions, natively, on a 2,000-page report): the chain of objects a read came
  through holds its last object inline, so reading a page's dictionary allocates nothing; a reference is tried only
  where a number can start; the walk makes room for a node's kids at once; and a page not yet built takes a pointer,
  not a `Page`, which also leaves 0.46 MB less WebAssembly memory after opening that report. Pages and text
  are unchanged.

### Fixed

- **A stream whose `stream` keyword has spaces before its end of line is read.** Some writers (a report
  server, here) put `stream \r\n`; recto took every such stream as unreadable, so the pages of those files
  drew nothing and had no text, where pdf.js and pdfium read them. Spaces and tabs before the end of line are
  now skipped, as theirs do. Found by the real-world sample in docs/benchmarks.md: 2 files of 7,000 (174 pages), and
  no other file's text or pixels changed.

## 0.6.0

Pages draw a quarter to a third faster and in less memory, the scorecard rises to 97.92%, and the
package downloads less. Against 0.5.3 on the scoreboard (`bench/scoreboard/0.6.0.json`, 8 alternating
rounds), the median page draws 15 to 33% faster and the 90th-percentile page 16 to 21% faster, in
WebAssembly and natively, at 1024 and 1600 px; peak memory is 4 to 5% lower; a cold engine's first page
comes about 6% sooner; text is unchanged, character for character, and as fast. Reading text and drawing
download 7.2 kB and 5.6 kB less (brotli). The vendored renderer this needed leaves recto with more vendored
Rust (48,681 lines, from 43,630) and 13 fewer crates.

### Changed

- **The vendored crates hold only what recto builds: 7,983 fewer lines and 13 fewer crates in the lock.**
  `vello_cpu` drops what `hayro` never turned on (multithreading, the f32 pipeline, glyph runs, PNG, and
  `RenderMode` and `num_threads`, which only chose between those) and its tests; `hayro` drops `image`,
  which it didn't use; `zune-jpeg` drops `portable_simd`; `hayro-syntax` and `hayro-interpret` drop unit
  tests that can't be built in this repository; `js-sys` is built without its default features, which only
  brought `futures-util` in. `Cargo.lock` lists 76 crates, from 89. Pages and text are the same to the byte
  on the corpus (1,337 pages of 531 files at 1024 px), and so is the wasm's code but for line numbers in
  `vello_cpu`'s panic messages and the parameters it no longer passes; vendor/README.md lists what went.
- **Text draws faster, and a page holds a bounded amount however many glyphs it draws.** A cached glyph was an
  RGBA image of which only the alpha was set, and every glyph drawn encoded an image paint of its own that was
  sampled, tinted and composited pixel by pixel, and held until the page was rasterized: 885 bytes a glyph, so
  320,000 small glyphs took 283 MB and 1,280,000 took 1.1 GB. A glyph is now a coverage mask, a byte a pixel,
  filled as a solid colour's coverage like any path (`vello_cpu`, now vendored, gains `fill_coverage`), and a
  page whose drawing holds more than 32 MB is rasterized in parts at its own level: 330 bytes a glyph, and
  65 MB for 320,000 glyphs or 1,280,000. Rendering, median page over 8 alternating runs of the scoreboard: 2.03 ms
  where it took 2.81 at 1024 px in WebAssembly in Node (90th percentile 4.32 from 5.21), 3.06 from 4.24 at
  1600 px; 1.17 ms from 1.79 natively at 1024 px. Black text is the same to the byte, except that an opaque page
  now stays opaque where a clip path's edge crosses a glyph (its alpha came to 254 on 12 renders). Coloured text
  rounds once where the image's tint and composite rounded twice, as a path filled in that colour already did:
  132 of 1,306 pages change, by at most 3 levels a channel and almost all by 1, on pixels a glyph partly covers.
  The scorecard is unchanged (519 of 530 agree). The drawing part of the wasm is 1.3 kB larger.
- **Repairing a file of dictionaries nested past the parser's limit is linear.** A file without a
  usable xref table is scanned for its objects, with a probe for a dictionary at each `<<`, and in
  `<< << << ...` nested past the limit of 512 each probe went 512 levels deep before it failed: 50,000
  of them in 150 KB took 180 ms to open. A probe that stops at the limit now records what it was
  inside, and one that would start inside that and can't find enough `>>` and `]` after it to end
  isn't run, since it can only fail; the scan goes on as after any failed probe, and finds the same
  objects (checked against probing every `<<` on random nestings, and on the corpus). That file opens
  in 0.9 ms. Only where too few `>` and `]` follow to end a chain is one recorded, so a deep file that
  closes everything opens as fast as it did. The text part of the wasm is 0.4 kB larger.
- **Reading text downloads 8.0 kB less (brotli), and so does drawing.** The package's JavaScript shipped its
  source comments, and the wasm glue wasm-bindgen's JSDoc, to every page that loads it: 27.6 kB of the
  download. Both are now emitted without comments (19.7 kB); the `.d.ts` files keep theirs, so editors show
  the same documentation. The code is the same: the same tests pass and the wasm is the same to the byte.
  The download budget's numbers are 405.7 kB of 420 for text and 681.5 kB of 690 for drawing, from 413.6
  and 689.5.
- **A form drawn again reads its dictionary once a page.** Each `Do` read the form's resources, matrix, box
  and group again, which cost more than drawing a small form. A page now reads them once for each of the
  first 256 forms it draws, however often it draws them; the content is still decoded at each `Do`, so the
  limit on what decoding holds is as it was. A page drawing a one-glyph form 5,000 times reads its text in
  3.4 ms where it took 4.7 natively, and draws in 6.2 ms where it took 7.5. Every char, box, font and flag
  of the 10,354 pages, and every pixel of the first three of each file, are the same. The text part of the
  wasm is 0.8 kB larger.
- **A list of objects each linked to the next reads in time linear in its length.** Every object read carried
  the chain of objects read to reach it, and copied and searched it at each step, so walking a list linked by
  `/Next`, as an outline's bookmarks are, took time in the square of its length: listing 64,000 bookmarks took
  0.78 s, and takes 0.04 s now (natively). The chain keeps its last 64 objects (no chain in the 531 files of the
  benchmark corpus holds more than 12), so a ring of references through up to 64 objects is refused where it
  was; a longer ring, which was refused after one turn, is refused after 131,072 steps. Every pixel and
  character of the corpus's pages is unchanged.
- **A link or bookmark that names its page by index no longer looks through every page.** Some producers
  write a destination's page as its index rather than a reference to it, and each such destination was checked
  against the index of every page in turn, so n of them in an n-page file took time in n²: the outline of a
  16,000-page file with a bookmark to each page took 0.14 s to list, and takes 0.02 s now (natively); a page of
  8,000 such links, 0.038 s and now 0.012. The pages' indexes are gathered once a call. Every pixel and character
  of the benchmark corpus's pages is unchanged.
- **A pool's threads take `recto.wasm` as the pool compiled it.** The pool reads, checks and compiles the
  wasm once as its first thread starts and hands each thread the compiled module, where every thread read,
  hashed and compiled it again; a thread that can't take it loads its own, as before. A pool's first text
  comes 5 to 11 ms sooner in Node. A changed wasm is still never compiled.
- `npm run scoreboard -- --base <ref>`: speed, load, memory, size, growth exponents, fidelity and code size
  of the tree against any ref, in alternating fresh processes, with each timed row's noise.

### Fixed

- **A non-isolated group's blend modes no longer blend with the paper.** The page group is isolated
  (ISO 32000-2, 11.4.7): the paper is under the page, not in a group's backdrop. A group recto draws over a
  backdrop (one with a blend mode inside and an opacity, soft mask, blend mode or knockout of its own) took
  the white paper into that backdrop, so `/Color`, `/Screen` and the like blended to white where the page had
  drawn nothing; an InDesign card in pdf.js's test suite, an orange gradient blended `/Color` in a knockout
  group, came out blank. It now draws as poppler, pdf.js and mupdf draw it, and as recto already drew the same
  blend outside a group. Of the scorecard's 616 pages, that one page's pixels change, and it now agrees.
- **Axial and radial shadings are no longer drawn half a pixel up and to the left.** The renderer samples a
  gradient at pixel centres already, and the shading's transform shifted it by another half pixel, so every
  smooth shading drawn as a gradient was half a pixel off the same shading drawn as a texture, and off the
  formula. Most pages can't tell; on a steep one the colour at a pixel was a band ahead, and the
  edge of a cone (two circles apart, extended) a pixel out. Of the scorecard's 616 pages, the 21 with such
  shadings change, 15 of them closer to the references and the rest by a level or two of rounding; the radial
  gradients page in pdf.js's tests now agrees.

## 0.5.3

Word-made pages, and reading text, are faster; every pixel and every character is unchanged.

### Changed

- **Reading text decodes a font's embedded program only for what the font's dictionary leaves out.** A
  `ToUnicode` map or an encoding names the codes and `Widths` gives their advances, so a font that has them, and
  states its weight, no longer inflates and parses its program to be read. A Type 1 font on its built-in encoding,
  a TrueType font without `Widths`, a font without `FontWeight` (the weight is the program's), a glyph's outline and
  drawing still load it, as before. Text alone, median page over 936 pages, in 8 alternating runs: 0.256 ms where
  it took 0.295 in WebAssembly in Node (90th percentile 1.93 ms from 2.14), 0.149 ms from 0.174 natively (1.13 from
  1.25); the instance's heap after them is 17.4 MB where it was 24.0. Every char, box, font and flag of 10,354
  pages is the same, read alone or after drawing, and so is every pixel.
- **Word's page-with-a-hole clips are no longer rasterized in full on every push.** Word exports clip text
  with an even-odd path per hole: a page-sized rectangle and the hole, nested dozens deep, and drawing the
  rectangle's outline again for each was a third to half of such a page's time. A rectangle that already
  covers the current clip is now given to the renderer far outside the viewport, where its edges are culled.
  On two public Word files, every page drawn at 1280 px takes 13% less in total in WebAssembly in Node and
  17% less natively, and the 90th-percentile page 28% and 30% less. Every pixel is unchanged, on those
  files and on the 650 pages of the scorecard's set.
- **A page's text after it's drawn, or drawn after its text, no longer loads its fonts' programs again.**
  Reading text and drawing keep their own fonts (they resolve missing fonts differently), but now share the
  document's embedded font programs, each decoded and parsed once. Drawing a page and then reading its text, as
  a viewer does, reads the text in 0.48 ms where it took 0.56 (median page, WebAssembly in Node), and
  0.22 ms where it took 0.32 natively; drawing after text takes 6% less in total, natively. Text alone and drawing alone
  are unchanged, and so is every pixel.
- **Glyph-name and standard-width lookups compare names only**: each table's entries are indexed once per
  thread, where every step of the search scanned for the entry's separators. Opening a font asks for up to
  256 names.
- `examples/costs.rs`: time, allocations and bytes per open, text page and drawn page over a directory.

## 0.5.2

Scanned pages draw faster at the sizes viewers and thumbnails use, with the scorecard unchanged.

### Changed

- **A JPEG drawn at under half its size decodes at 1/2, 1/4 or 1/8 scale**, the largest reduction that still
  covers its drawn size on both axes. A 2550×3300 scan as a 160 px thumbnail takes 17 ms and 4.7 MB of heap
  instead of 60 ms and 28.6 MB; at 400 px, 22 ms instead of 41. At 1600 px nothing changes. Against full-size
  decoding, no 4×4 cell differs by more than 16 at any width; see [Scanned pages](docs/benchmarks.md).
- **An image drawn more than once is decoded once**: a cache of up to 256 images and 48 MiB (or
  `maxDecodedBytes / 8`), least recently used first, keeping an image from its second draw. The same scan on
  6 pages at 1600 px renders in 118 ms instead of 358; a logo on 12 pages in 10 ms instead of 60.

## 0.5.1

Fixes and a cleanup pass. Text on pages with only left-to-right text is unchanged apart from rotated pages, and
the scorecard is unchanged.

### Fixed

- **Quarter-turned text read in the wrong order.** The page's `/Rotate` was combined with each character's angle
  with the wrong sign, so a `/Rotate 90` page drawn to read upright came out bottom-up, and sideways table
  headers came out as separate lines after the table body. Both now read as the page is shown.
- **Mixed right-to-left lines.** A Latin word and a number drawn by separate operators inside an RTL line now
  read back as two runs in RTL order (`هذه الاتفاقية 123 ABC سارية`); one operator drawing both keeps them
  together, and a hyphen or slash never splits.
- **Clearer errors for a link that isn't a PDF.** A 4xx or 5xx answer (after redirects) is `fetch-failed` with
  `error.status`, and its body is no longer read in a browser. Bytes with no `%PDF` near the start and no
  `endobj` or `startxref` at either end are `invalid-file` "not a PDF", where a ranged open used to report
  `maxBytes`.
- Tests that read a child process's output pass when run in a terminal (`node --test` colours it there).

### Changed

- About 1,000 lines of unused vendored code removed (features every build enables, the `/Info` chain nothing
  read, unused render entry points), the ranged loader's round helpers merged, one page lookup in place of six.
  `recto.wasm` is 0.4% smaller.

## 0.5.0

What a viewer needs: a ranged open in one round trip, part of a page drawn on its own, and where links go.
At 120 ms of latency the first page of 39 files comes 39% sooner, 10.2 → 6.2 s in all; see
[the numbers](docs/benchmarks.md#the-first-page-over-a-slow-link). Everything 0.4.0 returned is byte for byte
the same on 2,172 files, read whole and by range, and the scorecard is unchanged.

### Added

- **`render(i, { width, region })`** and `renderAsync` with the same: only the pixels of the whole page's bitmap
  that `region` covers, given in points in the viewer frame (top left of the page as shown, after `/Rotate`
  and the crop box), grown out to whole pixels and cut to the page. The result adds `x`, `y`, `pageWidth` and
  `pageHeight`: where it is in the whole bitmap. The caps (16,384 px a side, 64 Mpx) are on the region, past
  them it fails rather than shrinks, and `width` may go to 262,144. Memory follows the region: its pixmap, a
  mesh shading sampled over it alone, and a tiling pattern's tile, up to 4,096 px a side. A tile of a page
  drawn 200,000 px wide grows the heap by under 16 MiB. Against a crop of the whole render, tested at every
  rotation and with an offset crop box: a channel differs by at most 2, on under 1% of pixels, where the
  region's edge cuts an antialiased shape (734 of 760 regions on 39 files identical). Two exceptions,
  from the renderer stepping its sampling position in single precision from where a run of pixels starts: an
  image drawn close to 1:1 on a nearest-neighbour tie (4 of the 760, up to 156 on at most 0.17% of a region),
  and a tiling pattern past 1,000 px wide, at edges inside its tile (up to 72 on up to 16% of a small region,
  in a sweep to 8,000 px). The pool's `render` takes it too.
- **`links(i)`**: each `/Link` annotation's index in `annotations(i)`, its box, and its target: a URI; a page
  and a destination (view, point, zoom, `FitR` box) moved into the target page's viewer frame, from a
  `GoTo`, a `/Dest`, or a name in `/Dests` or the `/Names` tree, resolved as the outline's are, with the page
  found once a call in the tree's order, so whole and ranged agree and a page listed twice is where it first
  appears; `GoToR` and `Launch` reported with their file, never followed; any other action by its name.
  `annotations` is unchanged. In the pool too.
- `bench/ranged-latency.mjs`: time and round trips to a ranged first page at a set of latencies, against
  another build and pdf.js.

### Changed

- **A ranged open is one round trip** from the same origin, from two or three: the head and the tail (a suffix
  range, `bytes=-131072` by default) are asked for together. No byte is fetched twice: in a file shorter than
  the two, the head stops where the suffix starts, and a chunk the suffix starts inside of is kept in parts. So
  a `maxBytes` of the file's size is still always enough, and `bytesFetched` never passes it. A server that
  won't answer the suffix with a 206, or hasn't once the head is in and as long again has passed, costs the
  round back on a file longer than the head (the tail is fetched by offset), and none on a shorter one, whose
  head reads on to its end; the open never fails for it. Cross-origin the suffix range
  needs a CORS preflight, a second round unless it's cached. In a browser the open's fetches are now async
  `fetch` calls, and a whole-file answer to a range is read no further than the budget.
- **Fewer rounds after the open**: an object's first window takes the bytes up to the next object along
  (within 1 MiB) when it's fetched anyway, and a window too small jumps to the next object (within 8 MiB)
  rather than growing fourfold a round at a time. Over every 12th page of the files above, rounds per page
  went from 3.91 to 2.04. What's left is the object graph's depth: a page's resources, fonts and images found
  one after another.
- **More bytes for fewer rounds**: 14% more for the first pages above, 7% more for pages read one by one, from
  a tail of 2 chunks where 0.4.0 fetched 1.
- **Download**: 3.8 KB more with brotli for text and 11.3 KB more for text and drawing. A ranged open no longer
  fetches `recto-more.wasm` (251 KB), which in 0.4.0 it did.
- **Less code**: an open no longer reads the document-information dictionary (`/Info`, and its dates) or
  `/OCProperties`, which nothing used; the vendored hayro crates lose features every build turned on, with the code
  for builds without them, and functions nothing called (1,064 lines). recto.wasm is 5.8 KB smaller (1.2 KB brotli);
  reading text downloads 1.1 KB less. Output, rounds and the scorecard are unchanged.

### Fixed

- **A ranged open of a URL that answers with a page, not the file**, says so. An HTML page served with a 200 or
  206 (a soft 404, a sign-in page) failed with `invalid-file` "not a readable PDF: Invalid", or, when it was large or
  the budget small, with `too-large` "would pass 67108864 bytes (maxBytes)". Now an open that fails, or runs into
  `maxBytes`, on bytes with no `%PDF` in their first 1 KiB (nor `endobj` or `startxref` in what's held of either end, which a
  damaged PDF without its header still has) fails with `invalid-file` "not a PDF: no %PDF header…".
  A 4xx or 5xx, after any redirects, is `fetch-failed` with the status in `error.status` and the message "the server
  answered HTTP 404, not the file", and in a browser its body is no longer downloaded up to the budget first.
- **Turned text in `readingOrder` and `textItems`** read a char's angle the wrong way round, so text turned a
  quarter on the page took the opposite turn. On a `/Rotate 90` page drawn to read upright (a landscape page
  stored portrait), lines came out bottom to top. Text reading up the page had `direction: 270` and an origin at
  its far end, so the header cells of a table, turned and bottom-aligned, didn't line up as one row. Every
  direction now agrees with pdf.js's. On a rotated page, text in more than one direction reads each direction's
  lines in the order the content stream first draws that direction, not by the angle, so a sideways header row
  drawn before its table reads before it.
- **An RTL line's number and Latin word drawn by separate text-showing operators** read in the order they were
  laid out. `هذه الاتفاقية 123 ABC سارية`, printed by a browser, came back with `ABC 123`. The page alone can't
  say whether `ABC 123` on it is one left-to-right run (the number after the word) or two (the number before
  it), so where a space parts them recto takes them as one run if one operator drew the word, the number and the
  space, and as two otherwise, which is what a layout engine that shaped them separately draws. Text from one
  operator, as Word writes a line, and `ABC-123` without a space are unchanged. A file that draws every glyph by
  its own operator now reads `… Windows 11 …` in an RTL line as two runs, `11 Windows`, as pdfium does.

## 0.4.0

recto agrees with the other engines' pixels on 97.6% of the pages two of them agree on, from 96.9%, and a long
document read page by page no longer holds every page's decoded content. Measured with paired, alternating
runs against 0.3.0 on the same machine; see [the numbers](docs/benchmarks.md#before-and-after-040).

### Added

- `maxDecodedBytes` on `createPdfEngine` and `createPdfPool`, and `set_max_decoded_bytes` in Rust: the most
  one stream may decode to and one image hold at a byte a component, 768 MiB by default. Past it that stream
  or image is left out and the page's `text`, `objects`, `render` or `renderAsync` result says `truncated`,
  on every call that uses what it was left out of, since the page's content, fonts and colour spaces are
  cached that way. It's on what a page holds at once: its content streams together (one 700 MiB stream listed
  five times in `/Contents`, from 714 KB, crashed it), and nested forms with what they draw (five of 600 MiB).
  A 3.7 MB file of four FlateDecode pages inflating to 300, 700, 1,100 and 1,500 MB crashed the instance at
  the third page; now the third and fourth come back empty and `truncated`. 16 bytes of `CCITTFaxDecode`
  declaring 60,000 by 60,000 pixels crashed it; now the image is left out. What it changes: an image or stream
  over 768 MiB that drew before is left out, such as one declaring 32,000 by 32,000 gray pixels (1 GB), which
  0.3.0 drew, as white, in 978 MB. The most any page of the 543 suite and public files that open asked for
  was 151 MB; a 600 dpi gray scan of an A0 page is 558 MB and still draws.

### Changed

- **Memory**: a page's decoded content stream is kept while the page is among the last four read (or the
  ones kept come to under 1 MiB), not for as long as the document is open. WebAssembly memory after reading
  the text of every page: a 2,000-page report 36.8 → 22.5 MB, an 85-page credit agreement 15.3 → 6.6 MB; after
  drawing every page of the agreement, 20.1 → 10.0 MB. Reading the same pages a second time decodes them again,
  about 3% more on the agreement. Once those kept come to over 256 MiB, only the last page read is kept.
- **Speed**: reading text on 37 public PDFs takes 3.6% less time, 4.1% fewer instructions: a FlateDecode
  stream inflates in one call into a buffer sized from its input, fake-bold copies are found in a flat table
  instead of a hash map, and a glyph-name lookup bisects entries instead of bytes. Rendering is unchanged
  (−0.2% instructions, −0.2% time). The download is 3.9 KB more with brotli for text, 4.5 KB for drawing. The
  inflated buffer starts at a power of two, as 0.3.0's grew, so a large stream peaks where it did: a stream of
  200 MiB at 514 MiB of WebAssembly memory in 0.3.0 and 513 MiB now.

### Fixed

Inputs whose cost grew faster than their size, each with a test that counts the work. Times are per call,
in native release builds unless they say wasm:

- A named resource (`gs`, `Do`, `cs`, `scn`, `sh`, `BDC`, `Tf`, an inline image's `/CS`) was parsed again at
  every use: 8,000 uses of a 16 KB object took 0.6 s, and 1 ms now. Each name is read once a stream.
- An optional-content membership dictionary was read again at every `BDC` naming it: 16,000 of each took
  13.3 s, and 1.1 ms now.
- Finding where an inline image ends rechecked every later `EI` from each candidate: 16,000 of them and a
  binary byte after took 1.7 s in wasm, and take 5.8 ms now, linearly (256,000: 97 ms). One pass carries
  every candidate's reading at once, so each is decided as before: a test compares the two on 20,000 random
  streams of `EI`, `BI`, strings, escapes and binary bytes.
- A stitching function listing the same function twice at every level doubled per level: 20 levels took 17 s.
  A function listed again at the same depth is now built once and shared, and one repeating functions over
  2^14 times in all isn't built (the most any of the 543 suite and public files repeated was 44). 30 levels
  take 7 ms in wasm. A function of many distinct ones isn't limited: one of 20,000 draws as in 0.3.0.
- A page switching among n fonts compared each run's font with every one before it: 8,000 fonts took 66 ms
  for `objects`, and 21 ms now, linearly.
- Each glyph drawn at a size of its own was cached as an image for as long as the document was open: 16,000
  glyphs a hair apart peaked at 541 MB, now 395 MB. Past 256 MiB on a page the rest are filled as paths, and
  the cache is emptied before a page once it holds over 64 MiB.

These change no output on the corpora. What the limits change, on files built to reach them: a function
repeating over 2^14 times isn't drawn, and past 256 MiB of glyph images on a page the rest are filled as
paths. Still unbounded: a large object shared by thousands of referrers is parsed once by each, and several
pages under `maxDecodedBytes` can together take more memory than there is.

Rendering, each checked against pdfium, pdf.js and poppler in the scorecard:

- An image drawn at under twice its size was sampled without smoothing, so a slightly enlarged image looked
  blocky. It's smoothed now, as pdfium does.
- A luminosity soft mask weighed its colours by the wrong coefficients; it uses PDF's 0.30, 0.59 and 0.11.
- A hairline inside a tiling pattern could be thinner than a pixel and disappear.
- A page asked for at 800 px could come out 801 wide, when its scale times its width landed a hair above a
  whole number.
- The scorecard's cache of recto's renders was keyed by `recto.wasm` alone, so a change in another part
  reused stale pixels.

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
