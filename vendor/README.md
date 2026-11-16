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
  `re` rectangles from other paths, the `Tf` operand, the `Tz` scale (`PositionedGlyph::h_scale`) and a
  substitute's stretch per glyph, and the two flags of `/Group`.
- **hayro-font**: one table per font for what each character code does (glyph, stretch,
  advance), instead of per-glyph lookups and an atomic refcount per glyph; generated tables as sorted
  bytes rather than `phf` maps, which leaves `phf` out of the build; how a substituted
  font's glyphs fit the PDF's widths; what a font's dictionary says about it; and what any other code of a
  glyph's font maps to, its glyph and Unicode (`OutlineGlyph::code_mapping`, `code_unicode` on both kinds of glyph).
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
  131,072, rather than being copied and searched whole at every step of a list linked by `/Next`. Its last
  object is held inline (`chain_top`), so reading an object one down from a context with no chain, as the
  page walk does for every page, allocates nothing.
- **hayro-syntax**: what opening a large file costs. A reference is tried only where a number can start
  (`may_start_ref` in `src/object/ref.rs`); the page walk makes room for a node's kids at once; and a page
  not yet built takes a pointer, not a `Page`, in `LazyPages::built`.
- **hayro-interpret**: a function listed again at the same depth built once and shared.
- **hayro-interpret**: a patch mesh (shading types 6 and 7) sampled a patch at a time (`sample_patches` in
  `src/encode.rs`), not after every patch's 722 triangles are built: on one real page they took 1.8 GB.
- **hayro-interpret**: a page drawn without its text (`RenderContent::NO_TEXT`): `Tf` and the text-showing
  operators skipped in `run_ops`, and an ExtGState's `/Font` in `handle_gs`, so no font loads, no glyph draws
  and a clipping mode adds no clip.
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
- **hayro-syntax**: a repair scan that doesn't probe a `<<` it can tell can't end: inside one that
  stopped at the nesting limit, with too few `>>` and `]` after it (`Doomed` in `src/xref.rs`).
- **hayro-interpret**: what a form's dictionary says read once per page rather than at every `Do`
  (`XObjectInfo` in `src/x_object/form.rs`); **hayro-syntax**: `XRef::is_repaired`, after which it's
  read again.
- **hayro-syntax**: a built page keeps its dictionary and what it inherits, not its resources: `Page::resources`
  reads them from those at each call, so a document read through holds about 1 KB a page, not 3 KB and more
  the more fonts its resources list.
- **hayro-syntax**: spaces or tabs between `stream` and its end of line skipped (`stream_eol` in
  `src/object/stream.rs`), as pdf.js and pdfium do.
- **hayro-cmap**: `host-cmaps`, so a WebAssembly build gets its CMaps from the host on first
  use instead of embedding them, deflated rather than brotli so the wasm needs no brotli decoder.

- **hayro-syntax** and **hayro-interpret**: a JPEG decoded at 1/2, 1/4 or 1/8 when it's drawn that much
  smaller (`dct_scale_shift`), but never under a `/Matte`, a colour key or an indexed colour space; **hayro**:
  the images a document draws again at the same size kept as drawn (`src/image_cache.rs`), with their soft
  mask when it's the image's own size (`Renderer::alpha_fits` in `src/image.rs`).
- **hayro-interpret**: an image of a byte a sample that isn't a JPEG or JPEG 2000 (Flate, LZW, run-length or
  none), averaged in 2x2, 4x4 or 8x8 blocks before its colour is converted when it's drawn at under half of
  that (`box_reduce` in `src/x_object/decode/mod.rs`), under the same conditions as a JPEG's smaller decode;
  **hayro**: an image drawn again in the same render, as a drawing of the page for a group's backdrop draws
  every image before the group, taken from that render's earlier drawing (`RenderImages` in
  `src/image_cache.rs`) rather than decoded again.
- **hayro-syntax**: a stream naming a filter that isn't a standard one (`/BrotliDecode`) is undecodable, rather
  than the filter dropped and the data handed out as if decoded. **hayro-interpret**: a knockout
  group's element takes away what it covers by its shape, so opacities and soft masks its graphics states set,
  at any depth, don't weaken that (`Context::shape_only`).
- **hayro-syntax**: AES decryption a column at a time from tables of InvMixColumns of InvSubBytes, FIPS-197's
  equivalent inverse cipher, rather than byte by byte (`TD` in `src/crypto/aes.rs`).
- **hayro** and **hayro-interpret**: a group that needs its backdrop kept once drawn, cut to where it paints,
  with its mask and the group events its contents took (`DrawnGroup` in `src/group.rs`), and painted from
  there in the drawings of the page for later groups' backdrops, which skip its contents
  (`Device::backdrop_group_known`); a backdrop is no longer kept once used. Without it, n groups drew
  n^2 / 2 groups and held page-sized pixmaps for each.

- **hayro**: a cached glyph drawn without its outline: its key is made from the transform and whether it's asked
  for hinted, which with the glyph and its size decides whether it is, so the outline is looked up only to rasterize
  it or fill it as a path (`draw_cached_glyph` in `src/glyph_cache.rs`). A cached glyph holds the stamp of the
  render that last drew it, so drawing it again on a page takes one lookup rather than three. **hayro-font**: a glyph's
  cache key is its program's content hash with its ID in the low bits (`glyph_key` in `src/lib.rs`), rather than both
  hashed again with SipHash at every glyph, and `OutlineGlyph::cache_key` makes it without copying the program.

- **hayro**: a cached glyph kept as its coverage, a byte a pixel and column by column, rather than an RGBA image
  with only its alpha set, and drawn through `vello_cpu`'s `RenderContext::fill_coverage` (below) rather than as
  an image paint; the image is made from the mask only where that can't draw it (`src/glyph_cache.rs`). A page
  rasterized in parts once what it has drawn holds more than 2 MB, at its own level, outside any layer or group
  (`MAX_RECORDED_BYTES` in `src/lib.rs`): a part's rasterization is one call a sliced render can't stop in.

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

`vello_cpu`'s fine rasterizer writes a strip row nothing draws in straight into the target, the clear colour or
nothing over what's there, and puts a row something draws in through its scratch buffer only across the span its
commands reach, writing the rest as an empty row (`rasterize_region` and `row_extent` in `src/fine/mod.rs`), where it
filled and packed every row whole. Its glyph coverage goes into a strip's alphas a column of 4 bytes at a time
(`src/coverage.rs`).

What `hayro` doesn't turn on is gone from `vello_cpu`, so it has no features: its `multithreading`
(`dispatch/multi_threaded`, `Regions::update_par`, and with them `rayon`, `crossbeam-channel`,
`ordered-channel` and `thread_local`, and `RenderSettings::num_threads`); `f32_pipeline` (`F32Kernel` and
`fine/highp` but for `blend.rs`, which the u8 kernel uses for the non-separable blend modes, the filters'
`execute_highp`, and `RenderMode`, which only chose between the two); `text` (`text.rs`, `text_debug.rs`,
`glyph_run` and `glifo`); `png` and `libm`; and its tests. A re-vendor can drop these again by building
without the features and deleting what no longer compiles in. `hayro` no longer lists `image`, which it
didn't use. `zune-jpeg` loses `portable_simd` (nightly only) and `log`; its `x86` and `neon` code stays, as
native builds run it. `hayro-syntax` and `hayro-interpret` lose their unit tests and the dev-dependencies
(`aes`, `cbc`, `md5`, `sha2`, `image`) only those used: outside this workspace they resolve the crates.io
hayro rather than these copies, inside it a dependency with dev-dependencies can't be tested, and one no
longer compiled against the patched code. The tests that do run here (`hayro`, `hayro-font`, `hayro-cmap`,
`zune-jpeg`) stay.

`zune-jpeg` (0.5.15, by Caleb Etemesi, MIT, Apache-2.0 or Zlib) is vendored as well, for the decode at
1/2, 1/4 or 1/8 it lacks (`src/scaled.rs`): each component's blocks go through a truncated IDCT, as
libjpeg's `jidctred.c`, into a plane at the reduced size, chroma at as many pixels a block as its sampling
gives it, so nothing is upsampled. A decoder only scales where its sampling allows and falls back to the
full decode otherwise.

A first draw compiles each function it runs, so the hayro crates and `vello_cpu` keep rarely taken code out of
the large functions every draw runs, with `#[inline(never)]` and no change to what anything does: the operators
a page seldom uses, out of `run_ops` (`hayro-interpret`); a pattern's paint, out of `set_paint`, and a stencil
image's drawing, premultiplication and downscaling with alpha out of the image path (`hayro`); samples other than plain 8-bit, `/Matte`
and colour-key decoding out of the image decoder (`hayro-interpret`); and a painter's composite, tint and blend,
and each kind of gradient, out of `vello_cpu`'s `indexed_fill`, so one copy serves every painter. `hayro-syntax`
makes its SHA-256 constants and last blocks public (`sha256_parts`), for recto's lane hash.

Every change is marked with a `recto:` comment, and `vello_cpu/src/coverage.rs` is recto's own. The Foxit fonts and their licence are in
`hayro-font/assets`, the CMaps and theirs in `hayro-cmap/assets`.
