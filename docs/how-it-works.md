# How it works

[hayro](https://github.com/LaurenzV/hayro) (MIT/Apache-2.0) parses, interprets and rasterizes.
The text layer is recto's, and the JavaScript package is a thin mapping over WebAssembly.

## Text

`crates/recto/src/device.rs` receives each glyph hayro's interpreter draws. `text.rs` turns them
into chars with loose font boxes (the advance across, the font's ascent and descent up, not
glyph ink), infers the spaces and line
breaks the content stream implies but does not draw, rebuilds logical order for right-to-left
lines, drops copies drawn on top of themselves (faux bold), and splits words.

The text pass has its own interpreter in vendored hayro-interpret
(`RenderContent::TEXT_ONLY`, `interpret/text_only.rs`): a span lexer instead of hayro's object
tokenizer, `TJ` arrays and plain strings read in place, fonts resolved once per name, paths,
images and shadings skipped. Glyph runs still go through hayro's text, colour, graphics-state,
marked-content and form code, and from an inline image on the rest of the stream runs through
hayro's own loop, so its output equals the full interpreter's. A differential test in `lib.rs`
checks that on 2,000 random streams.

A page crosses into JavaScript as typed columns, so it can cross a thread boundary by transfer.

## Rendering

hayro's renderer (vello_cpu) draws on a white pixmap. Each side rounds up, unless it's within float
error of a whole number (612 pt at 800 px came to 800.00006), and the page stretches to fill that
bitmap. Sizes are capped because hayro sizes pixmaps in `u16`.

A region is drawn by the vendored renderer's `window`: the pixmap is the window's size, and the page's
transform is the whole page's at that scale, moved by the window's corner. So each pixel is computed
from the same coordinates as in a whole render. Points become pixels by the whole bitmap's size over the
page's in f64; the renderer's `f32` scale put a region's edge a pixel off at large scales. The window
starts on the renderer's tiles in the whole bitmap (256 px across, 4 down) and the region is cut from it,
which halved the pixels that differed from a crop (5,015 to 2,640 over 760 regions).

Three things a page draws were sized by the page's pixmap, not by what's visible, and a window at a
large scale made them huge; each is now bounded by the window:

- **A mesh shading** (types 4 to 7) is sampled into a map of every pixel its triangles cover. It's
  sampled only where they meet the area being painted, already cut to the pixmap. A 1 px region of a
  page 40,000 px wide used to sample most of its 1.6 billion pixels, past 3 GB, and trap.
- **A tiling pattern** decides whether its tile repeats from the area it covers: if that's at least a
  step, the tile is drawn once and repeated, otherwise its copies are drawn across the area. A window
  cut the area and changed the decision. In a window it's made over the whole page, as the page's own
  render makes it, while the tile is at most 4,096 px a side; a larger one is drawn across the window
  and two pixels round it.
- What's left of a difference is the renderer's: it steps a texture's sampling position across a run of
  pixels in `f32`, from where the run starts, so at a few thousand pixels a whole render has drifted
  where a window, starting nearer, hasn't. That shows at a sharp edge inside a pattern's tile and on
  an image's nearest-neighbour ties.

A page's decoded content stream is kept while the page is one of the last four read, or while the
ones kept come to under 1 MiB, and decoded again after that; past 256 MiB, only the last one is kept.
Holding every page's made a long document's memory grow with each page read.

## Assets

The wasm leaves out what most files never read: the 14 standard fonts (a file each, 13–25 KB with brotli), the
CJK fallback (`cjk-fallback.ttf`, 5 MB) and the predefined CMaps (`cmaps.deflate`, 0.36 MB). The
engine asks for each synchronously from inside a call, the first time a document needs it, so
reading it has to be synchronous as well: `fs` in Node, a synchronous `XMLHttpRequest` in a Web
Worker. A main thread and a service worker have neither, so there the files are fetched while the
engine is created. A text pass reads no font file it isn't given: a font the document doesn't embed
gets one holding only `.notdef`, since its Unicode comes from `ToUnicode` or the glyph tables and its
widths from `/W` or the metrics in the wasm.

The wasm is one build cut in four by `wasm-split`, by what a call runs. `recto.wasm` holds what reading
text runs; `recto-render.wasm` what drawing an ordinary page adds; `recto-more.wasm` the functions no
profiled file ran; `recto-rare.wasm` the same for image codecs, meshes and the rasterizer's own rare
paths. The lists in `scripts/wasm-parts/` say which is which, by names that hold no build hash, and nothing changes what a function does: a
part's functions start as placeholders in the instance's table, and the first call to one
reads the part, checks it against its pin, instantiates it on the same memory and table, and carries
on, from inside the call that needed it. That's why every thread that can read synchronously can
load a part mid-call, and every thread that can't gets all three up front. Each part is pinned to this
build, so a stale CDN's mixture is refused before it compiles.

`wasm-split` moves functions, not data, so on its own every constant table stays in `recto.wasm`. The
build links with relocations kept, which say where each table starts and ends and which tables point at
which, and `scripts/wasm-data.mjs` finds every address each part's code names. A read-only table that
only parts' code reaches moves into those parts, as data a part writes into memory when it
instantiates, at the address the linker gave it. Anything writable, and anything writable data points
at, stays. That takes 48 KB with brotli off a text-only page.

If a part fails to load in the middle of a call, the throw has gone through wasm frames, whose state
is then unknown. That instance is left alone from then on, and the call throws `missing-asset`. The
next call on any document open on it reopens that document on a new instance, copying the file from the
old instance's memory, so nothing is fetched twice, and tries again.

Crossing a part's boundary is a call through a table or an import, which costs drawing about 2%
(see [the benchmarks](benchmarks.md)) and reading text nothing.

## Transparency groups

Upstream hayro draws every transparency group as an isolated layer, and a layer can't see what's
under it. Vendored hayro and hayro-interpret add the rest (`vendor/hayro/src/group.rs`):

- **A non-isolated group at full strength with no mask** is painted directly, with no layer: the
  spec says it's the same thing, and that's most groups.
- **A non-isolated group that does need its backdrop** (a blend mode inside, and an opacity, mask or
  blend mode of its own): the page is drawn again up to the group, and the group twice, over that
  backdrop for colour and on nothing for alpha. ISO 32000-2 11.4.8 then gives the group's colour
  without the backdrop's part, and it's painted in place as an image. A limit of 32 on a page bounds
  the cost; a nested one inside such a group stays isolated.
- **A knockout group** gives each element a `Copy` layer clipped to its shape, so it replaces what
  the group holds there. Images and subgroups have no shape to hand, so they're painted once to
  erase and again for real.

`bench/render-compare.mjs` renders small generated PDFs for each case in recto, poppler and stock
pdfium (and MuPDF, if PyMuPDF is on `PYTHONPATH`), next to the colour the spec's formulas give.
recto, MuPDF and the formulas agree on all of them. Poppler and pdfium don't knock out inside an
isolated knockout group, and pdfium doesn't draw a non-isolated group with a backdrop.

## Ranged reads

hayro parses a buffer of the file's whole length, zeros until a chunk is copied in. Vendored
hayro-syntax asks for each object's bytes (growing the window until the object parses), each
xref section, and the whole file before a repair. So only those chunks are fetched.

On wasm32 that buffer is fresh pages from `memory.grow`: zero and uncommitted until written, so
memory follows the bytes fetched, not the file's length. The allocator's zeroing would commit
all of it. Measured in Node, reading one page by range from a generated file, memory grew 42 MiB
at 0.5 GiB, 43 MiB at 1.9 GiB and 40 MiB at 3.49 GiB. So the limit is address space, not memory:
wasm32 has 4 GiB, a ranged file is capped at 3.5 GiB, and an instance past its recycle mark goes
soon after its last document closes.

There is no sparse page map. The parser's objects are zero-copy slices of one buffer, addressed by
file offset, so it would be a change through the whole parser, not this layer; it would save no
memory, as above, and its offsets on wasm32 would still stop at 4 GiB.

The loader (`js/src/ranged.ts`) keeps chunks in a flat array, so a read costs what it spans. A
miss that continues the last fetch doubles the read-ahead, so a sequential scan of n chunks costs
O(log n) round trips.

**Rounds.** At 40 ms or more a round trip costs more than parsing a first page, so the open is one round:
the head and a suffix range for the tail go out together, before the file's length is known. In Node both
go through the fetcher thread; in a browser, the open is still async, so it uses `fetch`, which can run
them in parallel where a synchronous request can't. Reads after the open block, as before. A suffix the
server doesn't answer with a 206 is dropped unread and costs the round the open used to take; so does one
still out once the head is in and as long again has passed. Not on a file shorter than the head: there the
head has paused where the suffix starts, and it reads on to its end. In Node the two requests are one group
on the fetcher thread, and the head waits there on what the suffix came to.

No byte is fetched twice, so a budget of the file's size is enough, as it was before the suffix. The head
learns the file's length from its own `Content-Range` before its body, and reads no further than where the
suffix starts (with a reader that fills a buffer of exactly that size, where the stream has one). The
suffix starts inside a chunk; the loader keeps a chunk's start and end as pieces until the rest arrives,
and a later fetch of that chunk asks only for the gap.

After the open, rounds come from objects. hayro-syntax first asks for a 4 KB window at an object's offset,
and the xref knows where the next object starts. Two things use that: the window's fetch takes the bytes
up to the next object along, if that's within 1 MiB (the "ahead", passed through `Fill` to the loader,
which fetches it only when it fetches anyway, within the budget); and a window that's too small jumps to
the next object, within 8 MiB, rather than growing fourfold a round at a time. What's left is the depth
of the object graph: a page, its resources, a font, its descriptor, its program, each found only by
reading the one before. Fetching a page's whole graph in one round would need the parser to say what it
will read next, which it doesn't.

## Opening and slices

A whole file's pages come from walking the tree in order, depth first. A kid that's a `/Pages` node
is entered, and dropped if it has no `/Kids`. Any other dictionary is a page, whatever its `/Type` says.
`/Count` plays no part. A node that's its own ancestor is skipped. Any other repeat counts again, as it does in
pdfium, pdf.js and poppler, so a tree can multiply: the walk stops after the file's objects plus 2^18
kids, which a tree with no repeats can't reach. It uses its own stack, so a deep chain is fine. `open`
does the walk and keeps where each page's dictionary is and its `/Type`, and a page's dictionary is
indexed, and the page built, the first time it's asked for.

A ranged file can't afford that: the walk fetches every page's dictionary before the one you want. It
descends by `/Count` instead, reading a node's kids in order only as far as the page. Past 32 kids, a
node with as many kids as its `/Count` is taken to hold a page per kid, so kid `i` is read directly.
pdf.js fetches every leaf kid before a page and pdfium walks in order, so that shortcut is recto's alone.
It's what lets a jump in a 2,000-page flat file fetch 0.41 MB where pdf.js fetches all 14.9 MB. On the way
down, a kid that's missing or a node under that shortcut, a node without `/Kids` or `/Count`, a node in
its own path, or running out of kids all switch that document to the walk, for this page and the ones
after, within `maxBytes`. A ranged file's `pageCount` is the root's `/Count`, if that's no more than the
file's objects and the nodes add up to it (a node with as many kids as its `/Count` passes unread);
otherwise it's walked at open.

What's off that path can't be seen. With true counts a ranged read gives what the walk gives, tested on
generated trees including ones with pages deleted, with one exception: a node of over 32 kids, as many as
its `/Count`, where a kid jumped over isn't a page. With a false `/Count`, it can give a different page of
the file, which depends on what was read first, or promise a page that isn't there, which fails with
`failed`, or hide pages at the end. It always ends. `js/test/page-tree.test.ts` pins these cases.

`renderAsync` runs the same interpreter with a stack of frames in place of the recursion into forms
(`hayro-interpret/src/interpret/page_run.rs`), checks the clock every 64 operators and returns when
it's out of time, and the device is rebuilt from what it kept for the next slice. Rasterizing is one
call into vello_cpu; slicing that by row would mean vendoring it.

## Instances

The wasm is compiled once per thread and per location. Each instance gets its own wasm-bindgen
glue closure (`scripts/package-wasm.mjs`), because the stock glue keeps its instance in module
scope, and one module record per instance would pin every retired instance's memory. A trap
retires the instance: `panic = abort` on wasm32, so a panic or a failed allocation arrives as a
`WebAssembly.RuntimeError`, and its state is unknown after that.

WebAssembly memory never shrinks, so the only way to give it back is to drop the instance. Once it has
grown past what it started with, the engine drops it when nothing has been open on it for a second, or
at the close past 512 MiB. An open
within that second reuses it: dropping it at every close made a repeated 70 MiB file 2.1 times slower
for 1.2 times the peak memory (`bench/results/recycle.json`). An explicit `recycleAboveBytes` drops
it at the close past that mark. Compiling is cached, so a new instance costs only instantiation.
