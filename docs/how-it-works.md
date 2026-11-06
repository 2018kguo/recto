# How it works

[hayro](https://github.com/LaurenzV/hayro) (MIT/Apache-2.0) parses, interprets and rasterizes.
The text layer is recto's, and the JavaScript package is a thin mapping over WebAssembly.

## Text

`crates/recto/src/device.rs` receives each glyph hayro's interpreter draws. `text.rs` turns them
into chars with loose font boxes (advance × em, not glyph ink), infers the spaces and line
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
CJK fallback (`cjk-fallback.ttf`, 5 MB) and the predefined CMaps (`cmaps.brotli`, 0.25 MB). The
engine asks for each synchronously from inside a call, the first time a document needs it, so
reading it has to be synchronous as well: `fs` in Node, a synchronous `XMLHttpRequest` in a Web
Worker. A text pass gives a CID font the document does not embed a font holding only `.notdef`
instead of the 5 MB fallback, since its Unicode comes from `ToUnicode` and its widths from `/W`.

## Ranged reads

hayro parses a buffer of the file's whole length, zeros until a chunk is copied in. Vendored
hayro-syntax asks for each object's bytes (growing the window until the object parses), each
xref section, and the whole file before a repair. So only those chunks are fetched.

On wasm32 that buffer is fresh pages from `memory.grow`: zero and uncommitted until written, so
memory follows the bytes fetched, not the file's length. The allocator's zeroing would commit
all of it. wasm32 has 4 GiB in all, so a ranged file is capped at 2 GiB, and an instance past its
recycle mark is replaced.

The loader (`js/src/ranged.ts`) keeps chunks in a flat array, so a read costs what it spans. A
miss that continues the last fetch doubles the read-ahead, so a sequential scan of n chunks costs
O(log n) round trips.

## Instances

The wasm is compiled once per thread and per location. Each instance gets its own wasm-bindgen
glue closure (`scripts/package-wasm.mjs`), because the stock glue keeps its instance in module
scope, and one module record per instance would pin every retired instance's memory. A trap
retires the instance: `panic = abort` on wasm32, so a panic or a failed allocation arrives as a
`WebAssembly.RuntimeError`, and its state is unknown after that.
