# Vendored hayro crates

Patched copies of five crates from [hayro](https://github.com/LaurenzV/hayro), by Laurenz
Stampfl and contributors, under their own licences (MIT or Apache-2.0; each crate has its
`LICENSE-*` files). The workspace's `[patch.crates-io]` points at them. The other hayro
crates come from crates.io as they are.

They are patched for what upstream does not have:

- **hayro**: isolated and knockout transparency groups (`src/group.rs`), which upstream draws all
  as isolated layers, with a group's backdrop the page drawn so far without the paper, as the page group is
  isolated; an image drawn at under twice its size smoothed, as pdfium does; luminosity
  masks by PDF's weights; a hairline in a pattern at least a pixel wide; an axial or radial shading
  drawn as a gradient sampled at pixel centres, without upstream's extra half-pixel shift (`src/paint.rs`).
- **hayro-syntax**: reading a file by range. Bytes arrive on first use (`PdfData::ranged`),
  objects and xref sections fetch what they need, and pages are found on demand. Offsets past
  2 GiB. Repairing an encrypted file whose trailer is gone.
- **hayro-interpret**: a text-only interpreter (`RenderContent::TEXT_ONLY`) that skips paths,
  images and shadings and lexes content streams in place, plus what a device needs to tell
  `re` rectangles from other paths, the `Tf` operand and a substitute's stretch per glyph, and
  the two flags of `/Group`.
- **hayro-font**: one table per font for what each character code does (glyph, stretch,
  advance), instead of per-glyph lookups and an atomic refcount per glyph; generated tables as sorted
  bytes rather than `phf` maps, which leaves `phf` out of the build; how a substituted
  font's glyphs fit the PDF's widths; what a font's dictionary says about it.
- **hayro-syntax**: pages built on first use, from a walk that counts repeated kids and skips cycles
  (for a ranged file, from a descent by `/Count` until something doesn't add up), and reading through
  a ranged buffer; **hayro-interpret** and **hayro**: a page drawn a slice at a time (`PageRun`,
  `PageJob`). Features every build turns on (`std`, `unsafe`, `images`, `outlines`, `raster`,
  `embed-cmaps`) are gone, with the code for builds without them: the split wasm, not a feature,
  keeps drawing's code out of what reading text downloads.
- **hayro-syntax**: a page's decoded content kept only while it's among the last read, not for as
  long as its document is open (`recent` in `src/page.rs`), and `FlateDecode` inflated in one call
  into a sized buffer rather than through a reader; a limit on what one stream or image decodes to
  (`set_max_decoded_bytes`), and an inline image's end found in one pass.
- **hayro-syntax**: the chain of objects a read came through (`parent_chain` in `src/reader.rs`), which
  refuses a reference back into it, keeps its last 64 objects and refuses any read once it has held
  131,072, rather than being copied and searched whole at every step of a list linked by `/Next`.
- **hayro-interpret**: a function listed again at the same depth built once and shared.
- **hayro-interpret**: an even-odd clip whose first subpath is a rectangle around the current clip, as Word
  cuts holes in a page, given to the renderer with that rectangle far past the viewport, so it's culled
  rather than rasterized again on every push (`widen_covering_rect` in `src/context.rs`).
- **hayro-font**, **hayro-interpret** and **hayro**: a document's embedded font programs shared between
  the cache that reads its text and the one that draws it (`FontCache::sharing_programs`,
  `RenderCache::text_interpreter_cache`); programs a font resolver gives stay with each cache. The
  generated name tables index each entry's key and value once per thread rather than scanning for them
  at every step of a lookup.
- **hayro-font** and **hayro-interpret**: a cache that loads an embedded font program only when something is
  asked of the font that its dictionary doesn't answer (`FontCache::loading_programs_on_use`,
  `InterpreterCache::sharing_font_programs_loaded_on_use`): a glyph's outline, `OutlineGlyph::font_data`,
  or a simple font's built-in encoding or missing `Widths`, which load it as before. Its codes leave the
  glyph unmapped (`CodeMetrics::glyph` is `None`) until an outline needs it.
- **hayro-interpret**: what a form's dictionary says read once per page rather than at every `Do`
  (`XObjectInfo` in `src/x_object/form.rs`); **hayro-syntax**: `XRef::is_repaired`, after which it's
  read again.
- **hayro-cmap**: `host-cmaps`, so a WebAssembly build gets its CMaps from the host on first
  use instead of embedding them, deflated rather than brotli so the wasm needs no brotli decoder.

- **hayro-syntax** and **hayro-interpret**: a JPEG decoded at 1/2, 1/4 or 1/8 when it's drawn that much
  smaller (`dct_scale_shift`), but never under a `/Matte`, a colour key or an indexed colour space; **hayro**:
  the images a document draws again at the same size kept as drawn (`src/image_cache.rs`).

- **hayro**: a cached glyph kept as its coverage, a byte a pixel and column by column, rather than an RGBA image
  with only its alpha set, and drawn through `vello_cpu`'s `RenderContext::fill_coverage` (below) rather than as
  an image paint; the image is made from the mask only where that can't draw it (`src/glyph_cache.rs`). A page
  rasterized in parts once what it has drawn holds more than 32 MB, at its own level, outside any layer or group
  (`MAX_RECORDED_BYTES` in `src/lib.rs`).

`vello_cpu` (0.3.0, by the Vello authors, MIT or Apache-2.0) is vendored as well, without its examples, for
two things it lacks. `RenderContext::fill_coverage` (`src/coverage.rs`) fills a coverage mask with a solid
paint as the strips' own alphas, one strip a row of tiles, so a glyph is a fill like a path's: no image paint
encoded for every glyph drawn (its own TODO, "Add caching?"), no image sampled and tinted per pixel. It draws
only what an image paint of the mask would draw the same: a whole-pixel translation, the normal blend mode, no
mask, filter or aliasing threshold, and a clip rectangle that cuts it on whole pixels. For black, every colour
channel is what the image paint gave, and an opaque page stays opaque where a clip path's edge crosses a glyph
(the image's alpha could come to 254 there); for a colour, a pixel the glyph partly covers can be a level or two
off, as the fill rounds once where the image's tint and composite rounded twice, as any path filled in that
colour already is. `RenderContext::render_and_clear` rasterizes what's been drawn into a target and forgets it, keeping
the state and the clips, with `recorded_bytes` to say how much that is; a part rasterized over the parts
before it is what rasterizing them at once gives, except where a non-default blend mode at the page's root
blends over the earlier parts rather than apart from them.

`zune-jpeg` (0.5.15, by Caleb Etemesi, MIT, Apache-2.0 or Zlib) is vendored as well, for the decode at
1/2, 1/4 or 1/8 it lacks (`src/scaled.rs`): each component's blocks go through a truncated IDCT, as
libjpeg's `jidctred.c`, into a plane at the reduced size, chroma at as many pixels a block as its sampling
gives it, so nothing is upsampled. A decoder only scales where its sampling allows and falls back to the
full decode otherwise.

Every change is marked with a `recto:` comment, and `vello_cpu/src/coverage.rs` is recto's own. The Foxit fonts and their licence are in
`hayro-font/assets`, the CMaps and theirs in `hayro-cmap/assets`.
