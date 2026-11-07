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

hayro's renderer (vello_cpu) draws on a white pixmap. Each side rounds up and the page stretches
to fill that bitmap. Sizes are capped because hayro sizes pixmaps in `u16`.

## Assets

The wasm leaves out what most files never read: the 14 standard fonts (`fonts.bin`, 0.26 MB), the
CJK fallback (`cjk-fallback.ttf`, 5 MB) and the predefined CMaps (`cmaps.deflate`, 0.36 MB). The
engine asks for each synchronously from inside a call, the first time a document needs it, so
reading it has to be synchronous as well: `fs` in Node, a synchronous `XMLHttpRequest` in a Web
Worker. A main thread and a service worker have neither, so there the files are fetched while the
engine is created. A text pass reads no font file it isn't given: a font the document doesn't embed
gets one holding only `.notdef`, since its Unicode comes from `ToUnicode` or the glyph tables and its
widths from `/W` or the metrics in the wasm.

The wasm comes in two builds from one crate. `recto-text.wasm` is built with no `render` feature and
for size, except for the crates text speed depends on (`profile.text` in `Cargo.toml`), and has no
rasterizer, outline code or image decoders. Both share one glue file, and the build checks that the
text build imports nothing the full one doesn't. A document moves by opening its bytes again on the
other instance, so a call needs no second path through the engine, and the text instance is dropped
with its last document. Its results are the same as the full build's, which the tests hold it to.

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
when its last document closes.

There is no sparse page map. The parser's objects are zero-copy slices of one buffer, addressed by
file offset, so it would be a change through the whole parser, not this layer; it would save no
memory, as above, and its offsets on wasm32 would still stop at 4 GiB.

The loader (`js/src/ranged.ts`) keeps chunks in a flat array, so a read costs what it spans. A
miss that continues the last fetch doubles the read-ahead, so a sequential scan of n chunks costs
O(log n) round trips.

## Opening and slices

A whole file's pages come from walking the tree in order, depth first. A kid that's a `/Pages` node
with `/Kids` is entered, and any other dictionary is a page, whatever its `/Type` says. `/Count` plays
no part. A node that's its own ancestor is skipped. Any other repeat counts again, as it does in
pdfium, pdf.js and poppler, so a tree can multiply: the walk stops after the file's objects plus 2^18
kids, which a tree with no repeats can't reach. It uses its own stack, so a deep chain is fine. `open`
does the walk and keeps each page's dictionary, and a page is built the first time it's asked for.

A ranged file can't afford that: the walk fetches every page's dictionary before the one you want. It
descends by `/Count` instead, like pdf.js (pdfium's page lookup walks in order). A node with as many
kids as its `/Count` is taken to hold a page per kid, so kid `i` is read directly; any other has its
kids read in order, as far as needed. On the way down, a kid that's missing, a node without `/Kids` or
`/Count`, a node in its own path, a kid of a one-page-per-kid node holding more or fewer than one page,
or running out of kids all switch that document to the walk, for this page and the ones after, within
`maxBytes`. A ranged file's `pageCount` is the root's `/Count`, if that's no more than the file's
objects and the nodes add up to it (a one-page-per-kid node passes unread); otherwise it's walked at open.

What's off that path can't be seen. If every `/Count` is true and no node with as many kids as its
`/Count` holds an empty node, a ranged read gives what the walk gives, and a test holds it to that on
generated trees. Otherwise it can give a different page of the file, which depends on what was read
first, or promise a page that isn't there, which fails with `failed`, or hide pages at the end. It
always ends. `js/test/page-tree.test.ts` pins these cases.

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

WebAssembly memory never shrinks, so the only way to give it back is to drop the instance. Past the
recycle mark, the engine drops it when its last document closes, and the next open builds a new one;
compiling is cached, so that costs only instantiation.
