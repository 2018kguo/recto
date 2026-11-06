# Vendored hayro crates

Patched copies of four crates from [hayro](https://github.com/LaurenzV/hayro), by Laurenz
Stampfl and contributors, under their own licences (MIT or Apache-2.0; each crate has its
`LICENSE-*` files). The workspace's `[patch.crates-io]` points at them. The other hayro
crates come from crates.io as they are.

They are patched for what upstream does not have:

- **hayro-syntax**: reading a file by range. Bytes arrive on first use (`PdfData::ranged`),
  objects and xref sections fetch what they need, and pages are found on demand.
- **hayro-interpret**: a text-only interpreter (`RenderContent::TEXT_ONLY`) that skips paths,
  images and shadings and lexes content streams in place, plus what a device needs to tell
  `re` rectangles from other paths.
- **hayro-font**: one table per font for what each character code does (glyph, stretch,
  advance), instead of per-glyph lookups and an atomic refcount per glyph; how a substituted
  font's glyphs fit the PDF's widths.
- **hayro-cmap**: `host-cmaps`, so a WebAssembly build gets its CMaps from the host on first
  use instead of embedding them.

Every change is marked with a `recto:` comment. The Foxit fonts and their licence are in
`hayro-font/assets`, the CMaps and theirs in `hayro-cmap/assets`.
