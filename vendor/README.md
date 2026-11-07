# Vendored hayro crates

Patched copies of five crates from [hayro](https://github.com/LaurenzV/hayro), by Laurenz
Stampfl and contributors, under their own licences (MIT or Apache-2.0; each crate has its
`LICENSE-*` files). The workspace's `[patch.crates-io]` points at them. The other hayro
crates come from crates.io as they are.

They are patched for what upstream does not have:

- **hayro**: isolated and knockout transparency groups (`src/group.rs`), which upstream draws all
  as isolated layers.
- **hayro-syntax**: reading a file by range. Bytes arrive on first use (`PdfData::ranged`),
  objects and xref sections fetch what they need, and pages are found on demand. Offsets past
  2 GiB. Repairing an encrypted file whose trailer is gone.
- **hayro-interpret**: a text-only interpreter (`RenderContent::TEXT_ONLY`) that skips paths,
  images and shadings and lexes content streams in place, plus what a device needs to tell
  `re` rectangles from other paths, the `Tf` operand and a substitute's stretch per glyph, and
  the two flags of `/Group`.
- **hayro-font**: one table per font for what each character code does (glyph, stretch,
  advance), instead of per-glyph lookups and an atomic refcount per glyph; how a substituted
  font's glyphs fit the PDF's widths; what a font's dictionary says about it.
- **hayro-syntax**: pages found on demand when a tree's counts hold up, and reading through a
  ranged buffer; **hayro-interpret** and **hayro**: a page drawn a slice at a time (`PageRun`,
  `PageJob`) and a `raster` feature the text build leaves out.
- **hayro-cmap**: `host-cmaps`, so a WebAssembly build gets its CMaps from the host on first
  use instead of embedding them, deflated rather than brotli so the wasm needs no brotli decoder.

Every change is marked with a `recto:` comment. The Foxit fonts and their licence are in
`hayro-font/assets`, the CMaps and theirs in `hayro-cmap/assets`.
