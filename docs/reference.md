# Reference

Everything is exported from `@2018kguo/recto`. Coordinates are PDF points in the viewer's
frame: top-left origin, with `/Rotate` and the crop box applied.

## Opening

```ts
openPdf(bytes: Uint8Array | ArrayBuffer, options?: { password?: string; signal?: AbortSignal }): Promise<PdfDocument>
createPdfEngine(options?: { assetBase?: string | URL; recycleAboveBytes?: number; maxDecodedBytes?: number; preloadAssets?: string[] }): Promise<PdfEngine>

engine.open(bytes, options?): Promise<PdfDocument>
engine.openRanged(source: string | URL | Uint8Array | PdfRangedRead, options?: PdfRangedOpenOptions): Promise<PdfRangedDocument>
engine.preload(names: string[]): Promise<void>
engine.stats(): { heapBytes: number; generation: number; openDocuments: number }
startRangedRead(source: string | URL | Uint8Array, options?: PdfRangedOpenOptions): PdfRangedRead
```

`openPdf` uses one shared engine per thread, created on first use. Create your own to set
options, or to keep a job's memory apart. WebAssembly memory never shrinks, so memory comes back
by dropping the instance. By default, an instance that has grown since it started goes a second after its last document
closes, unless an open reuses it first, and one past 512 MiB goes at the close. With
`recycleAboveBytes` set, an instance past it goes at the close. Then `stats().heapBytes` reads 0 until
the next open. Below the mark an instance stays however long it's idle, so a high `recycleAboveBytes` (512 MiB, say)
keeps an engine that opens a file every few seconds from paying for a fresh instance each time: 2.7–6 ms more for
open, first page and close, since fonts and CMaps are parsed again. If a document is still open past the mark, the next open gets a fresh instance and the
old one goes when its documents close. A crashed instance is replaced at the next open.

**The bytes are copied** before the call returns its promise, whether by `open` or by a ranged
open of bytes, so you can reuse a pooled `Buffer`, change the buffer, or transfer it straight
away, without waiting. `open` then holds the file in WebAssembly memory for as long as the
document is open, in memory that comes back only when the instance is replaced.

**One engine, in parts.** The wasm comes in four files, loaded by what a call runs: reading text takes
`recto.wasm` (1.3 MB, 0.38 MB with brotli); the first `render` adds `recto-render.wasm` (0.85 MB, 0.26 MB);
functions most files never run are in `recto-more.wasm` (0.99 MB, 0.26 MB) and `recto-rare.wasm` (0.88 MB,
0.19 MB). There's nothing to call. If a part can't be loaded, the call throws `missing-asset`, every open
document stays usable, and the next call tries again. A thread that will draw can save the first `render` that
wait with `preloadAssets: ["recto-render.wasm"]`. To find a missing file at startup and not at the first page
that needs it, name all three parts: `preloadAssets: ["recto-render.wasm", "recto-more.wasm", "recto-rare.wasm"]`
fetches, hashes and compiles them while the engine is created, and creating it fails with `missing-asset` if one
isn't there. Fonts and CMaps can be named the same way. `engine.preload(names)` does the same later: a
thread that knows which fonts a page names (a non-embedded `doc.text(i).fonts` entry) fetches them
together before drawing it, where the engine would otherwise wait a round trip for each as it meets them.

## A document

| Member | What it returns |
|---|---|
| `pageCount` | The number of pages |
| `outline()` | The bookmarks: `PdfOutlineItem[]` of `{ title, page, url, target, children }`. `page` is -1 if it goes nowhere in this file; `url` is set if it links out; `target` is where it goes in full, as a link's. Empty if there are none. [Destinations](#destinations) |
| `openAction()` | Where the document opens, its catalog's `/OpenAction`, as a link's `target`; `{ kind: "none" }` if it names none |
| `destination(nameOrDest)` | A named destination of this file, or another file's destination for a page of this one, placed on it. [Destinations](#destinations) |
| `structureTruncated()` | `{ pages, pageLabels, outline }`: whether each was cut short. `pages` means `pageCount` may be short: a limit, or a damaged tree that left no pages, which an honestly empty document doesn't say. Walks the outline and labels again |
| `pageLabels()` | What each page is called, one string per page: `"iv"`, `"A-5"`. `null` if the file doesn't say |
| `pageInfo(i)` | `{ width, height, rotation }`, in the page's own units: `/UserUnit` doesn't scale them. Rendering by `width` doesn't depend on it |
| `text(i, { boxes? })` | `PdfPageText`: the page's `text`, and columns per char: `codepoints`, `boxes`, `fontSizes`, `tfSizes`, `hScales`, `angles`, `fills`, `fontIds`, `flags`, `runIds`; plus `fonts`, `words`, `runs`, `truncated`. `boxes: "tight"` for glyph bounds, below |
| `fonts(i)` | `PdfFontInfo[]`: the fonts page `i`'s text uses, in `text(i).fonts` order, with what their dictionaries say and the program each embeds. [Fonts](#fonts) |
| `fontProgram(id)` | The bytes of an embedded font program `fonts` listed, as its stream decodes; `null` for an id that names none. [Fonts](#fonts) |
| `objects(i)` | `PdfPageObjects`: image boxes and pixel sizes, path boxes and flags, path segments, `truncated` |
| `annotations(i)` | `PdfAnnotation[]`: subtype, box, contents, form field, appearance text |
| `links(i)` | `PdfLink[]`: each `/Link` annotation's index in `annotations(i)`, its box, and its `target`. [Links](#links) |
| `scan(i)` | `text`, `objects` and `annotations` from one interpretation of the page |
| `textAndAnnotations(i)` | `text` and `annotations` from one interpretation of the page |
| `render(i, { width, maxHeight?, region?, text? })` | `{ width, height, rgba, truncated }`: opaque RGBA, four bytes a pixel, on white. With a `region`, only that part, and where it is: [part of a page](#part-of-a-page). `text: false` draws it [without its text](#without-text) |
| `renderAsync(i, { width, maxHeight?, region?, text?, signal?, sliceMs? })` | A promise of the same bitmap, the same pixels, with the thread given back every `sliceMs` (8 by default). A `signal` stops it at the next pause, with `aborted` |
| `close()`, `[Symbol.dispose]()` | Frees the document. Closing twice does nothing |

Columns are typed arrays, so a page crosses a thread boundary by transfer. Char `i` is entry
`i` of each column and entries `4i..4i+3` of `boxes`; `boxAt` and `charsText` read them.

What the columns mean:

- **`boxes`** are, by default, each char's advance across, by its font's ascent and descent: font
  boxes, a line's height whatever the glyph, for selecting and highlighting. The font's are in
  `fonts[fontIds[i]]`: the descriptor's values, or 0.8 and -0.2 em for a font that states none (the
  standard fonts, Type 3). For a substituted font the width is the one the PDF states. `readingOrder`
  and `textItems` expect these.
- **`text(i, { boxes: "tight" })`** gives each glyph's own bounds instead: the control box of its outline
  from the font program, or of what a Type 3 glyph's procedure draws, through the same matrix it's drawn
  with (rise, skew, rotation and a substituted font's widening included), as the axis-aligned box in the
  viewer frame. This is pdfium's `FPDFText_GetCharBox`; [character boxes](benchmarks.md#character-boxes)
  compares them. A font the document doesn't embed is measured in the font recto draws it with, so the box
  is that font's glyph, not the original's. A glyph with no outline, such as a space, keeps its font box,
  and so do the spaces and line breaks the engine adds. Word boxes are the union of their chars' either
  way, and the text is the same. The cost is what drawing pays for fonts: tight boxes load the embedded
  font programs that reading text otherwise leaves alone, the standard fonts a document names but doesn't
  embed (and the CJK fallback, for a CJK font it doesn't embed), and drawing's part of the wasm.
- **`fontSizes`** is the size a char is drawn at, in points: `Tf` scaled by the text and page
  matrices. **`tfSizes`** is the `Tf` operand itself.
- **`hScales`** is the horizontal scale a char was shown with: `Tz` over 100, 1 where no `Tz` was set. It's
  text state, so it holds across `BT` and `ET` and `q` and `Q` save and restore it. A space or line break
  the engine adds has the char before it's.
- **`runs.matrices`** is six numbers a run, `a, b, c, d, e, f`: the text rendering matrix its first glyph
  was drawn with, `[Tf·Tz/100 0 0 Tf 0 Ts] × Tm × CTM`, then the page's flip into the viewer frame, so upright
  text has `d` negative (12 pt at `Tz 50` is `6, 0, 0, -12`). One unit of text space is `(a, b)` across and
  `(c, d)` up: rotation is `atan2(b, a)`, and a skew shows as `(c, d)` not at a right angle to `(a, b)`. `e, f`
  is where that glyph is placed. The run's glyphs share `a` to `d`; their positions are in `boxes`.
- **`fonts`** has one entry per font dictionary: `{ name, flags, weight, embedded, ascent, descent }`.
  `name` is `BaseFont` without a subset prefix; `weight` is the descriptor's `FontWeight`, or the
  program's, or what the name says (bold 700, otherwise 400); 0 for a Type 3 font.
- **A fill colour** reads as the stroke colour for stroke-only text, and as opaque black for a
  pattern, since a char has one colour in this column.

**A hostile page** can ask for almost anything by drawing a form thousands of times, so what one
page collects has limits: 2^19 glyphs, 2^21 path segments, 2^19 images. Past them the rest is left
out and `truncated` is true on that result. A render has one limit of its own: past 32 groups on a
page that need the page drawn again under them, the rest draw as isolated, and its `truncated` is
true.

A page can also ask for far more drawing than its size, and a budget per page stops it, with `truncated`
true on what `text`, `objects`, `render` and `renderAsync` return for that page. Streams nested in
streams (forms, patterns, Type 3 glyphs, soft masks) cost four times more each level down from the
second, out of 2^20, and stop at 50 levels; annotations with no appearance share 2^17 points; a `/VE` visits
2^10 nodes. The document's own trees have limits too, which `structureTruncated()` reports: a page tree's repeats
stop at 2^18 kids, page labels at 2^16 nodes or ranges, an outline at 2^16 items and 64 levels, its name tree at
2^18 nodes. [The costliest real pages we measured](benchmarks.md#damaged-files) leave over 250× room on each.

Two limits change what's drawn without setting `truncated`. A function (a shading's, or a transfer
function's) listing the same one again at the same depth builds it once and shares it, and one that would
repeat functions over 2^14 times in all isn't built, so what needs it isn't drawn: a few KB listing the next
level twice, 30 levels down, asks for 2^30. Distinct functions don't count, so one of 20,000 draws; the most
any of the 543 test-suite and public files that open repeated was 44. Past 256 MiB of glyph images on a
page, the rest of its glyphs are filled as paths, as a glyph too large to cache already is.

**What a stream decodes to** is limited by `maxDecodedBytes`, on `createPdfEngine` and `createPdfPool`:
768 MiB by default. No stream may decode to more, and no image hold more at a byte a component. Past it,
that stream or image is left out, as one that can't be read is, and `truncated` is true on what `text`,
`objects`, `render` and `renderAsync` return for the page. That's `truncated` and not an error, as with the
other limits on a page, because the rest of the page still reads. The limit is on what's held at once: a
page's content streams count together, as they're joined, and the content of a page, form, tiling pattern or
Type 3 glyph counts against what's decoded while it runs. What a limit left out stays left out in what's
cached (the page's content, a font, a colour space), so every call that uses it says `truncated`, whatever
was read before. A stream read outside a page's call (an object stream, an outline's) is left out the same
way, with nothing to say so; so is an annotation's text that `annotations` reads, which has no `truncated`. The most any page of those
543 files asked for was 151 MB. A 600 dpi scan of an A0 page is 558 MB in gray, and draws in about 2.1 GB of
WebAssembly memory; in RGB it's 1.7 GB, which ended in `crash` before and is left out now. Several pages
under the limit can still add up to more than the instance has.

A render is capped at 16,384 px a side and 64 Mpx, and shrinks to fit. `maxHeight` defaults to
4096; pass `Infinity` to fit the width alone.

### Part of a page

`render(i, { width, maxHeight?, region: { x, y, width, height } })`, and `renderAsync` with the same,
draws only the pixels of the whole page's bitmap that the region covers, for a tile or a zoomed-in view.

- **The region** is in points in the viewer frame, as text and annotation boxes are: origin at the top
  left of the page as shown, after its `/Rotate` and with its crop box's corner at 0, 0; x to the right, y
  down, up to `pageInfo(i).width` and `height`. On a page turned a quarter, `width` runs along the PDF's y.
- **The scale** is the one `width` and `maxHeight` give the whole page, without the whole page's caps:
  `width` may be up to 262,144 with a region. The region's bitmap is capped instead, at 16,384 px a side
  and 64 Mpx, and a larger one fails with `failed` rather than shrinking, since a tile shrunk is at the
  wrong scale. A region with no area on the page fails with `failed` too.
- **The pixels** are the region grown out to whole pixels (a coordinate within 1/1024 px of a whole one
  is taken as it) and cut to the page. The result says where they are: `x`, `y` is its top-left pixel in
  the whole page's bitmap, and `pageWidth`, `pageHeight` that bitmap's size. To name pixels exactly, scale
  points by `pageWidth / pageInfo(i).width`.
- **They match a whole render** at the same scale, cropped. On the 37 public PDFs and 2 generated ones,
  at 400 and 1000 px wide, 734 of 760 regions are identical and 22 differ by 1 or 2 in a channel on a
  few edge pixels, where the region's edge cuts an antialiased shape. Two kinds of content can differ
  by more, because the renderer steps its sampling position across a run of pixels in single precision,
  from where the run starts, and a region starts runs elsewhere:
  - **An image drawn close to 1:1**, where nearest-neighbour sampling falls on a tie: the other 4 of the
    760, scanned pages, with pixels off by up to 156 on at most 0.17% of the region.
  - **A tiling pattern at large scales**, at the edges inside its tile. In a sweep of patterns with tiles
    of 0.7 to 10 points, none differed by more than 2 at 1,000 px wide or under; between 1,000 and 8,000
    px wide, pixels at tile edges differed by up to 72 on up to 16% of a small region.

  Which tiles a pattern repeats, and where, is decided over the whole page, as the page's own render
  decides it, for a tile of up to 4,096 px a side; a larger one is drawn across the region instead.
- **Memory** follows the region, not the page at that scale: the pixmap is the region's size, plus up
  to 255 px to its left and 3 above, where the renderer's tiles start in the whole page's bitmap; a
  mesh shading is sampled only over the region; a tiling pattern's tile is drawn once, up to 4,096 px a
  side. A tile of a page drawn 200,000 px wide, 120 GB whole, grows the heap by under 16 MiB, and a 500 px
  square of a mesh-shaded page 100,000 px wide by 12 MiB (a mesh holds about 60 bytes a pixel of what it
  covers, for the region alone). The page's content is still interpreted whole, so
  time follows what the page draws as much as the region.

`truncated` means what it does for a whole render.

### Without text

`render(i, { width, text: false })`, and `renderAsync` and a pool's `render` with the same, with or without a
`region`, draws the page without its text: what the text-showing operators (`Tj`, `TJ`, `'`, `"`) would
paint is left out, wherever they are, and all else draws as it would, pixel for pixel the page with its text
taken out of the content. `text` is true by default, which draws as before.

| Text rendering mode (`Tr`) | Drawn by default | With `text: false` |
|---|---|---|
| 0, 1, 2: fill, stroke, both | The glyphs | Nothing |
| 3: invisible | Nothing | Nothing |
| 4, 5, 6: fill, stroke or both, and clip | The glyphs, then their clip from `ET` | Nothing, and no clip: what follows draws unclipped |
| 7: clip | Their clip from `ET` | No clip: what follows draws unclipped |

- **Type 3 glyphs are text,** so their procedures don't run, whatever they draw.
- **Everything else draws:** paths, shadings, images and inline images, patterns, transparency groups and
  soft masks, forms (a form's text is left out and the rest of it drawn), and annotation appearances, whose
  text is left out too, as is the text of a free text annotation drawn without one.
- **Fonts aren't loaded:** `Tf` is skipped with the text, so a page's fonts aren't read, nor their programs,
  nor the standard fonts' files fetched. Pages heavy with text draw faster.

**`renderAsync`** pauses between a page's drawing operators, including inside forms. Three things
run whole: the final rasterizing (about a quarter of a render, the longest hold on a heavy page),
and a pattern, soft mask or Type 3 glyph, or a knockout or backdrop group. Other calls may run
between slices, on the same document too, and `close` stops the render with `closed`. `text` and
`open` have no such version: on the 300,000-shape page `text` takes 40 ms, and `open` takes about
1 ms for 2,000 pages.

Helpers over those columns: `textItems(page, info)` makes pdf.js-style text items,
`readingOrder(page, info)` gives the reading order and breaks (it re-lays out rotated pages),
`annotationTextItems` does the same for annotation text, and `rasterMeasures`,
`vectorMeasures`, `showsGlyphs` measure what a page paints.

## A pool of threads

```ts
createPdfPool(options?: { threads?: number; assetBase?: string; maxDecodedBytes?: number }): Promise<PdfPool>

pool.open(bytes, { password? }): Promise<PdfPoolDocument>
pool.stats(): { threads: number; queued: number }
pool.close()      // or `using`: stops every thread; what's unfinished fails with `closed`

doc.pageCount
doc.text(i)  doc.render(i, { width, maxHeight?, region?, text? })  doc.objects(i)
doc.annotations(i)  doc.links(i)  doc.pageInfo(i)  doc.outline()     // each a promise
doc.openAction()  doc.destination(nameOrDest)  doc.fonts(i)  doc.fontProgram(id)
doc.close()       // or `await using`: frees it on every thread
```

Each call goes to a free thread, and results are what a `PdfDocument` returns. `threads` is a limit,
by default one less than the machine's cores and at most 8. A thread starts only when a call has to
wait and none is free, so calls awaited one at a time stay on one thread. Each thread that gets a
page of a document holds its own copy of the file, and the pool holds one more until `doc.close()`.

A bundled server build must keep the package external: `assetBase` moves the wasm and fonts, not the thread's own
`dist/pool-worker.js`, and a pool can't start a thread without that file.

It needs no COOP or COEP headers; with them, threads share one copy of the file. `threads` goes up to 64. Loaded
from another origin, such as a CDN, threads start through a one-line blob that imports `dist/pool-worker.js`, so
the CDN must send CORS headers for `dist/` as it does for the wasm, and a Content-Security-Policy must allow
`worker-src blob:`. A thread with no way to start workers (a service worker) gets `wrong-thread`.

A thread that can't start fails what's waiting with its reason, usually `missing-asset`, and the next call tries again; one
that says nothing for 90 seconds counts as stopped. A thread that stops fails its call with `crash`, and another takes its
place. An argument or result that can't cross between threads fails that call alone. `render` takes `width`,
`maxHeight`, `region` and `text`, and refuses `signal` with a `TypeError`: a call can't be stopped once it runs, only `pool.close()` ends all of them.
The synchronous API doesn't change, and the pool's code loads only when `createPdfPool` is called.

## Links

`doc.links(i)` lists page `i`'s `/Link` annotations, in the order `annotations(i)` has them:

```ts
type PdfLink = { annotation: number; box: PdfBox; target: PdfLinkTarget };

type PdfLinkTarget =
  | { kind: "uri"; uri: string }
  | { kind: "page"; destination: PdfDestination }      // GoTo, or the link's /Dest
  | {                                                   // GoToR
      kind: "remote";
      file: string;                // as written: a relative path stays relative
      fileSystem: string | null;   // the file specification's /FS, such as "URL"
      destination: PdfDestination; // its page is that file's page index, or -1 for a name there
      newWindow: boolean | null;   // /NewWindow, null if not given
      name: string | null;         // destination.name again
      page: number | null;         // destination.page again, null for none
    }
  | {                                                   // GoToE
      kind: "embedded";
      file: string | null;         // the file the embedded one is in, if not this one
      path: { relation: "parent" | "child"; name: string | null }[];  // /T, step by step
      destination: PdfDestination; // as remote's
      newWindow: boolean | null;
    }
  | { kind: "launch"; file: string }
  | { kind: "action"; action: string; name: string | null }  // any other /S; Named's /N is name
  | { kind: "none" };
```

- **`annotation` and `box`** are the link's index in `annotations(i)` and the box it has there, in the
  viewer frame.
- **An action wins over `/Dest`** when a link has both, as the spec says. A bookmark's `/Dest` wins over
  its action, as its `page` always has.
- **Another file or a program** (`GoToR`, `GoToE`, `Launch`) is reported, with the file's name from a string or a
  file specification's `/UF`, `/F` or a platform's key, and never opened or followed. Neither is JavaScript, which is
  `{ kind: "action", action: "JavaScript" }` without its script. A `GoToE` path's steps are its `/T`
  dictionaries: `/R /P` to the parent, `/R /C` to the child its `/N` names in the embedded files (`name`
  null for one attached to an annotation, whose `/P` and `/A` aren't reported).
- **The page** is found in the page tree's order, once a call however many links there are, as the
  outline's are: a page the tree lists twice is where it first appears. On a ranged read that reads the
  whole tree, as `outline()` does, so a link's page is the same whole or ranged.

`links` loads `recto-render.wasm`, as `render` does: the code is in that part.

## Destinations

A link's, a bookmark's, the open action's, or one looked up by name:

```ts
type PdfDestination = {
  page: number;              // the page's index; -1 if it goes nowhere in this file
  view: string | null;       // "XYZ", "Fit", "FitH", "FitV", "FitR", "FitB", "FitBH", "FitBV"
  // On the page as shown: the viewer frame, as boxes and a region to render are.
  x: number | null;          // the point to bring to the top left
  y: number | null;
  zoom: number | null;       // XYZ's, 1 for 100%
  box: PdfBox | null;        // FitR's rectangle
  // As the file writes them, in the page's user space (y up, before /Rotate and the crop box).
  left: number | null;       // XYZ, FitV, FitBV, FitR
  bottom: number | null;     // FitR
  right: number | null;      // FitR
  top: number | null;        // XYZ, FitH, FitBH, FitR
  name: string | null;       // the named destination it came by
};
```

| View | Its numbers | `x`, `y` | What a viewer does |
|---|---|---|---|
| `XYZ left top zoom` | `left`, `top`, `zoom` | the point | That point at the top-left; `zoom` if it has one, else the zoom it had |
| `Fit`, `FitB` | none | null | The whole page in the window (FitB: what's drawn on it) |
| `FitH top`, `FitBH top` | `top` | `y` (`x` on a page turned a quarter) | The page's width in the window, `top` at the top |
| `FitV left`, `FitBV left` | `left` | `x` (`y` turned a quarter) | The page's height in the window, `left` at the left |
| `FitR l b r t` | all four | the rectangle's top-left | The rectangle in the window |

- **Named destinations** are found in the catalog's `/Dests` dictionary and its `/Names` `/Dests` tree:
  every node, down its `/Kids`, whatever its `/Limits` say, by string keys and keys written as names. A
  value may be the array or a dictionary with `/D`. `name` says which name a destination came by; one the
  file doesn't define is `{ page: -1, name }` with the rest null, not dropped.
- **On the page as shown**: `x`, `y` and `box` are in the target page's viewer frame, its `/Rotate` and crop
  box applied, so they compare with that page's boxes. A coordinate the destination leaves as it was is
  `null`; on a page turned a quarter, a `FitH`'s top is a viewer `x`, so `y` is the null one. `/UserUnit`
  scales neither this frame nor `pageInfo`'s sizes, so it doesn't move a destination on its page; multiply
  by it for physical size. `zoom` is `null` for none, 0 or less.
- **In another file**, `destination.page` is the page index that file has, or -1 for a destination by
  name, and only the user space numbers are set: there's no page here to place them on. Open that file
  and ask it: `other.destination(target.destination.name)` for a name, or
  `other.destination(target.destination)` to place an explicit one on its page. Either gives `page` -1
  if it has no such name or page.
- **`openAction()`** is the catalog's `/OpenAction`: a destination array, or an action dictionary read as a
  link's action is.

`openAction` and `destination` load `recto-render.wasm` too, as `links` does.

## Fonts

`doc.fonts(i)` lists the fonts page `i`'s text uses, one per font dictionary, entry `k` for
`text(i).fonts[k]`: a char's `fontIds` entry indexes both. `doc.fontProgram(program.id)` gives a program's bytes.

```ts
type PdfFontInfo = {
  id: number;                  // its index in text(i).fonts, what fontIds holds
  name: string;                // BaseFont without a subset prefix (Type 3: /Name), as PdfFont's
  baseFont: string;            // BaseFont as written; "" if none
  subset: boolean;             // BaseFont starts with a tag of six capitals and a "+"
  subtype: string;             // "Type1", "MMType1", "TrueType", "Type0", "Type3"
  cidSubtype: string | null;   // a Type0 font's descendant: "CIDFontType0", "CIDFontType2"
  encoding: string | null;     // /Encoding by name, or a differences dictionary's /BaseEncoding
  embedded: boolean;           // a font file in its descriptor, or a Type 3 font
  kind: "type1" | "truetype" | "cff" | "cid-cff" | "opentype" | "type3" | null;
  program: { id: string; file: "FontFile" | "FontFile2" | "FontFile3"; subtype: string | null } | null;
  flags: number | null;        // the descriptor's /Flags, /ItalicAngle, /FontWeight
  italicAngle: number | null;
  weight: number | null;
  italic: boolean;
  bold: boolean;
  toUnicode: boolean;          // the dictionary has a /ToUnicode CMap
  codes: { count: number; codes: Uint32Array; glyphs: Int32Array; unicode: string[] };
};
```

- **`kind`** is what the program is, from the descriptor's key and the stream's `/Subtype`: `/FontFile` is
  `"type1"`, `/FontFile2` `"truetype"`, `/FontFile3` with `Type1C` `"cff"`, `CIDFontType0C` `"cid-cff"`,
  `OpenType` `"opentype"`. A Type 3 font is `"type3"`, with `program` null: its glyphs are content streams.
  A font that embeds nothing has `kind` and `program` null and `embedded` false; text and drawing use a
  standard font for it.
- **`program.id`** is the program stream's object number and generation, `"12 0"`: the same on every page that
  uses it, in every instance and on every thread of a pool, so it's also what to key a set of programs by.
- **`fontProgram(id)`** returns the stream's data after its filters, exactly as the file stores the program:
  nothing is parsed, repaired or re-encoded, so a Type 1 program keeps its encrypted portion and its
  `Length1`, `Length2` and `Length3` parts, and a CFF is bare CFF. It's a new copy at each call.
- **`italic` and `bold`** come from the descriptor where it says (the italic flag or a nonzero `/ItalicAngle`;
  `ForceBold` or a `/FontWeight` of 600 or more), and otherwise from the name: "Italic" or "Oblique", "Bold",
  "Black" or "Heavy". `flags`, `italicAngle` and `weight` are the descriptor's alone, null where it doesn't state
  them.
- **`codes`** is what the font's codes map to, entry `j` of each column, in code order: `unicode` is the text
  a code reads as, from `/ToUnicode`, or else the encoding's glyph names, as `text` reads it before
  normalising; `glyphs` the glyph id in the embedded program, -1 where there's none (not embedded, Type 3, or a
  code that maps to `.notdef`). A simple font lists those of its 256 codes that have either. A Type0 font
  lists its codes up to `0xFFFF` that have Unicode, so one without `/ToUnicode` or a predefined Unicode CMap
  lists none, and codes of three or four bytes aren't listed.
- **The fonts** are found by walking the page's resources, those of the forms and tiling patterns it draws,
  and Type 3 fonts' own, down 32 levels and through 4,096 forms. A font the content names but the walk
  doesn't reach (past those limits), and the font text is read in when the content names one it doesn't
  define, are listed with `subtype` "" and what `text(i).fonts` says of them.

`fonts` interprets the page again, as `text` does, and loads `recto-render.wasm` and `recto-more.wasm`;
`fontProgram` loads `recto-more.wasm`. Reading text alone never runs either.

## Errors

Every failure is a `PdfError` with a `code`. A bad argument is a `RangeError` or `TypeError`.

| `code` | Meaning |
|---|---|
| `invalid-file` | Not a PDF the engine can open: garbage, or too damaged to repair. An encrypted file before revision 6 that lost its trailer lands here, since its key needs the trailer's ID |
| `password-required` | Encrypted, and no password given |
| `wrong-password` | Encrypted, and the password does not open it |
| `unsupported` | A valid file the engine cannot read: a security handler other than Standard, such as public-key |
| `aborted` | The `signal` was aborted; `cause` is its reason |
| `crash` | The instance trapped. Open documents on it fail with this; the next open gets a fresh instance |
| `closed` | The document was closed |
| `missing-asset` | The wasm, a font or CMaps are missing, unreadable, or not this build's |
| `wrong-thread` | A ranged read on a thread that can't block for one: a page's main thread, a service worker |
| `fetch-failed` | A ranged read failed: the network, an HTTP error, a bad Range answer. `error.status` is the HTTP status when one is known; undefined when none is (a refused connection, a redirect loop, a response cut mid-stream) |
| `timeout` | A ranged fetch waited longer than `timeoutMs`, or the read passed `totalTimeoutMs` |
| `too-large` | A ranged read would pass `maxBytes`, the file is past 3.5 GiB, or the instance has no address space left for it (other open documents hold it) |
| `failed` | Any other refusal, such as a page with no area |

```js
import { openPdf, PdfError } from "@2018kguo/recto";

try {
  await using doc = await openPdf(bytes, { password });
} catch (error) {
  if (error instanceof PdfError && error.code === "password-required") askForPassword();
  else throw error;
}
```

## Ranged reads

`engine.openRanged(url)` fetches only the chunks the parser reads: the head, the tail and last
cross-reference section, then each object on first use. `doc.stats()` reports `bytesFetched`,
`requests` and `rounds`, the round trips; a round's requests run in parallel.

**The open is one round** from the same origin. It asks for the head (4 chunks) and the last 2 chunks at
once, the second by a suffix range (`bytes=-131072`), since the file's length isn't known yet. In a file
shorter than the two, the head is read only up to where the suffix starts, so no byte is fetched twice, and
a chunk that the suffix starts inside of is kept in its two parts. So `bytesFetched` never passes the file's
length, and a `maxBytes` of the file's length is always enough. That covers a small file's objects and
most files' cross-reference tables, so the first page usually costs one or two rounds more, for its
objects and their fonts and images. These cases take more:

- **A cross-reference table longer than the tail**, or one the tail's doesn't lead to, takes a round for
  each section.
- **A server that won't answer the suffix** with a 206 (it sends 200, 416 or the wrong range) costs one
  more round on a file longer than the head: the last chunk is fetched by its offset, and the answer to
  the suffix is cancelled unread. On a shorter one the head, which paused where the suffix starts, reads
  on to its end instead, so the open is still one round: Express answers a suffix longer than the file
  with a 416. A suffix still unanswered once the head is in gets as long again as the head took (at least
  250 ms), then counts as refused: it never fails the open.
- **Cross-origin**, `bytes=-n` isn't a safelisted `Range` value, so the browser sends a preflight first:
  two rounds for the suffix unless the preflight is cached (`Access-Control-Max-Age`), and a server that
  refuses it lands in the case above.

**Start it before the engine.** `startRangedRead(url, options)` sends the open's round at once and
returns a handle; `engine.openRanged(handle)` opens it when the engine is ready. Created together, the
file's head and tail download alongside the engine's wasm instead of after it. Only `password` is taken
at the open; the rest of the options are the read's.

**Download the rest.** `await doc.fetchRest({ signal, stallMs })` asks for every byte not held yet, at low
priority, in 256 KiB pieces starting from where the engine last read past what it had, the next piece asked
for a round trip before the last one ends, and keeps each chunk as it arrives: reads after it never block.
A read that misses meanwhile shares the link with one piece at most (it can't make the download stop:
its thread is blocked on its own request), and nothing it fetched is fetched again. It's how a viewer
reads a file whole while drawing its first page from a few ranges. It counts toward
`maxBytes`, and gives up after `stallMs` (default `timeoutMs`) without a byte. A failure fails no read.

**The file is held once.** What the engine reads it copies into its own memory, and the loader drops it
(`stats().heldBytes` is what it still holds), keeping only the first KiB and the last chunk. A document
reopened on a fresh instance (after a crash or a part that failed to load) fetches what it reads again.

`bytesFetched` counts what was read from each response. A response that's cancelled (a 200 to the suffix,
the head of a file the suffix covers) isn't read, but a server may have sent some of it before the cancel
reached it. So on a small file, or from a server that ignores Range, the server can send more than
`bytesFetched` counts: on a local server, a whole small file twice, all of a 0.4 MB file again, and 0.9 MB
of a 9 MB one.

An object that doesn't parse in its first 4 KB window is asked for up to the next object in the file, in
one round, when that's within 8 MiB; past that the window grows fourfold, a round each. When a window is
fetched anyway, the bytes up to the next object (within 1 MiB) come with it, so a content stream or font
next to what's read costs no round of its own.

The engine's calls are synchronous, so a read that misses **blocks its thread for the round
trip**. In Node a small fetcher thread does the fetch while yours waits on `Atomics.wait`; in a
Web Worker it is a synchronous request. Run it on a worker thread, not a server's main loop. A
server on the same thread cannot answer, and the read fails with `timeout` and says why.

| Option | Default | |
|---|---|---|
| `chunkBytes` | 64 KiB | The smallest fetch |
| `maxBytes` | 64 MiB | Total to fetch before failing with `too-large` |
| `timeoutMs` | 30 s | How long one fetch round may block |
| `totalTimeoutMs` | none | Wall time for the whole read, from the first fetch: a fetch in flight is cut when it runs out, a stalled one included, and none starts after. It keeps counting while the document sits open, and it bounds the network waits, not the parsing between them |
| `signal` | | Checked before the open and each fetch. It cannot interrupt a fetch, because the thread is blocked; `timeoutMs` and `totalTimeoutMs` bound that |
| `password` | | |

**A failed read ends the document.** What's already fetched reads, past `totalTimeoutMs` too, until a read fails.
After that every call on it, a page it already holds included, throws the same failure: close it and reopen to go on.

**In WebKit a trickling response isn't cut.** Its synchronous request runs until the response stops, so a server that keeps
sending a little passes both `timeoutMs` and `totalTimeoutMs` (over 85 s, measured with a 500 ms limit), with nothing
to interrupt it from the blocked thread. A full stall is cut, about a second after a 500 ms limit. Chromium, Firefox and Node cut both on time.

**A ranged read trusts `/Count`.** It finds a page by each node's `/Count`, so that it fetches only
the nodes on the way there, and checks what it reads on that path. If something doesn't add up it walks
the tree in order instead, within `maxBytes`. It can still return a different page than a whole-file read,
and which one can depend on what was read first, in two cases: a file whose `/Count` values are false
where that path doesn't look; and, with true counts, a node of over 32 kids, as many as its `/Count`,
where a kid before the page is an empty node or holds more than one page. `pageCount` can be wrong in the
first case, so a page can fail with `failed`, or pages at the end can go unseen. If you need the
guarantee, open the whole file: there `/Count` plays no part.

What a server gets wrong:

- **It answers with an error** (a 4xx or 5xx, after any redirects): `fetch-failed`, with that
  status in `error.status`. Nothing of the error page's body is read.
- **It answers with a page that isn't the file** (a soft 404 or a sign-in page, as a 200 or a
  206): an open that fails, or runs into `maxBytes`, on bytes with no `%PDF` in their first 1 KiB, and no
  `endobj` or `startxref` in what's held of either end, fails with `invalid-file`, saying it isn't a PDF. A damaged
  file without the header is read as before.
- **It ignores Range** (a 200 with the whole file): the file is used, as long as it fits
  `maxBytes`; otherwise `too-large`.
- **A wrong length, a shifted range, no `Content-Range` total, a size or ETag that changes**:
  `fetch-failed`, with the reason. A file replaced by one of the same size, from a server that
  sends no ETag, can't be detected, and reads as a mix of the two.
- **A total past 3.5 GiB**: `too-large`. WebAssembly has 4 GiB of addresses, and a ranged read
  takes the file's length of them, though memory use follows the bytes fetched.
- **Cross-origin in a browser**: it must allow the request and send
  `Access-Control-Expose-Headers: Content-Range`, or the read fails with `fetch-failed` and
  says so.
- A failed fetch is final for that document: reopen to retry. Error messages never include the
  URL, since a presigned query is a credential.

## Setup per environment

The wasm and assets are found with `new URL("../wasm/…", import.meta.url)`.

- **Node 24 and newer**: nothing to configure.
- **Vite 8** (dev server and client build): nothing to configure. CI runs both in Chromium, in a
  dedicated worker, on the main thread and in a service worker; the same were run by hand in
  Firefox and WebKit.
- **Vite 7**: the build works. The dev server's dependency pre-bundling loses the URLs, and the
  worker's first call fails with `missing-asset`. Add
  `optimizeDeps: { exclude: ["@2018kguo/recto"] }`. Run by hand, not in CI.
- **A bundled server build (SSR)**: keep the package external, so it stays in `node_modules` with its files: in
  Vite, `ssr: { external: ["@2018kguo/recto"] }` (and the same in a Nitro or similar output's own bundling, if it
  runs this code). Vite rewrites `new URL(…, import.meta.url)` only for client builds. Bundled for a server,
  the code moves and the files don't, so the first engine fails with `missing-asset`:
  `recto could not load recto.wasm from file:///…/server/wasm/recto.wasm: ENOENT`. Shipping `node_modules` must then
  include the whole package, `wasm/` too. If the package can't stay external, copy `wasm/*` and pass `assetBase`.
- **Other bundlers**: webpack 5 and Rollup also rewrite `new URL(…, import.meta.url)` but have
  not been run. A bundler that does not (esbuild) leaves the files behind: copy
  `node_modules/@2018kguo/recto/wasm/*` somewhere it serves and pass that directory:

  ```js
  const engine = await createPdfEngine({ assetBase: "/recto/" });
  ```

- **A Content-Security-Policy** must allow `wasm-unsafe-eval`, and `connect-src` for the assets.
- **A page's main thread and service workers** can't read a file synchronously, so where that's
  so, the assets are fetched while the engine is created: all of them by default, about 9.6 MB, or only
  what `preloadAssets` names (a font such as `FoxitSans.pfb`, 15–30 KB, or `fonts.bin` for all 14, 0.26 MB;
  `cmaps.deflate` 0.36 MB; `cjk-fallback.ttf` 5.1 MB), and a call that needs one you left out fails with
  `missing-asset`. The wasm's four parts (3.89 MB) come whatever you name, so it can always draw. It works, tested
  in Chromium, Firefox and WebKit, but **every call blocks that thread**: on a main thread the page
  freezes for the length of each call, so prefer a dedicated worker, where nothing is fetched
  until a document needs it. A ranged read still needs a thread that may block: `wrong-thread`.
- **Edge runtimes** without `XMLHttpRequest` take the same path in principle. None has been run.
- No headers (COOP, COEP) are needed anywhere.

The files can also be reached by name, through `@2018kguo/recto/wasm/*`: `@2018kguo/recto/wasm/pins.mjs` exports
`PINS`, each file's SHA-256 by name, which is also the list of what a deploy must ship.

Every file is pinned by SHA-256, and every byte is hashed before it's used, so a dev server's HTML
fallback page cannot read as a font, and a changed wasm is never compiled. A wasm is fetched whole and
hashed with `crypto.subtle`, or in JavaScript where there is none (a page on plain http), then
compiled. A missing asset throws from the call that needed it; it never reads
as blank text.

## The Rust crate

`crates/recto` is the engine without JavaScript: `recto::Document::open(bytes, password)`, then
`text`, `scan`, `annotations`, `render`, and `fonts(i)` (`Vec<FontInfo>`) and `font_program(ProgramId)`
(`Option<Vec<u8>>`). A char's `h_scale` and a run's `matrix` are `hScales` and `runs.matrices`. It is not on crates.io, because it depends on the
vendored hayro crates through `[patch]`, which crates.io does not honour.
