# Reference

Everything is exported from `@2018kguo/recto`. Coordinates are PDF points in the viewer's
frame: top-left origin, with `/Rotate` and the crop box applied.

## Opening

```ts
openPdf(bytes: Uint8Array | ArrayBuffer, options?: { password?: string; signal?: AbortSignal }): Promise<PdfDocument>
createPdfEngine(options?: { assetBase?: string | URL; recycleAboveBytes?: number; preloadAssets?: string[] }): Promise<PdfEngine>

engine.open(bytes, options?): Promise<PdfDocument>
engine.openRanged(source: string | URL | Uint8Array, options?: PdfRangedOpenOptions): Promise<PdfRangedDocument>
engine.stats(): { heapBytes: number; generation: number; openDocuments: number }
```

`openPdf` uses one shared engine per thread, created on first use. Create your own to set
options, or to keep a job's memory apart. WebAssembly memory never shrinks, so memory comes back
by dropping the instance. By default, an instance past 64 MiB goes a second after its last document
closes, unless an open reuses it first, and one past 512 MiB goes at the close. With
`recycleAboveBytes` set, an instance past it goes at the close. Then `stats().heapBytes` reads 0 until
the next open. If a document is still open past the mark, the next open gets a fresh instance and the
old one goes when its documents close. A crashed instance is replaced at the next open.

**The bytes are copied** before the call returns its promise, whether by `open` or by a ranged
open of bytes, so you can reuse a pooled `Buffer`, change the buffer, or transfer it straight
away, without waiting. `open` then holds the file in WebAssembly memory for as long as the
document is open, in memory that comes back only when the instance is replaced.

**One engine, in parts.** The wasm comes in four files, loaded by what a call runs: reading text takes
`recto.wasm` (1.5 MB, 0.43 MB with brotli); the first `render` adds `recto-render.wasm` (0.77 MB, 0.23 MB);
functions most files never run are in `recto-more.wasm` (0.86 MB, 0.21 MB) and `recto-rare.wasm` (0.79 MB,
0.17 MB). There's nothing to call. If a part can't be loaded, the call throws `missing-asset`, every open
document stays usable, and the next call tries again. A thread that will draw can save the first `render` that
wait with `preloadAssets: ["recto-render.wasm"]`. To find a missing file at startup and not at the first page
that needs it, name all three parts: `preloadAssets: ["recto-render.wasm", "recto-more.wasm", "recto-rare.wasm"]`
fetches, hashes and compiles them while the engine is created, and creating it fails with `missing-asset` if one
isn't there. Fonts and CMaps can be named the same way.

## A document

| Member | What it returns |
|---|---|
| `pageCount` | The number of pages |
| `outline()` | The bookmarks: `PdfOutlineItem[]` of `{ title, page, url, children }`. `page` is -1 if it goes nowhere in this file; `url` is set if it links out. Empty if there are none |
| `structureTruncated()` | `{ pages, pageLabels, outline }`: whether each was cut short. `pages` means `pageCount` may be short: a limit, or a damaged tree that left no pages, which an honestly empty document doesn't say. Walks the outline and labels again |
| `pageLabels()` | What each page is called, one string per page: `"iv"`, `"A-5"`. `null` if the file doesn't say |
| `pageInfo(i)` | `{ width, height, rotation }`, in the page's own units: `/UserUnit` doesn't scale them. Rendering by `width` doesn't depend on it |
| `text(i)` | `PdfPageText`: the page's `text`, and columns per char: `codepoints`, `boxes`, `fontSizes`, `tfSizes`, `angles`, `fills`, `fontIds`, `flags`, `runIds`; plus `fonts`, `words`, `runs`, `truncated` |
| `objects(i)` | `PdfPageObjects`: image boxes and pixel sizes, path boxes and flags, path segments, `truncated` |
| `annotations(i)` | `PdfAnnotation[]`: subtype, box, contents, form field, appearance text |
| `scan(i)` | `text`, `objects` and `annotations` from one interpretation of the page |
| `textAndAnnotations(i)` | `text` and `annotations` from one interpretation of the page |
| `render(i, { width, maxHeight? })` | `{ width, height, rgba, truncated }`: opaque RGBA, four bytes a pixel, on white |
| `renderAsync(i, { width, maxHeight?, signal?, sliceMs? })` | A promise of the same bitmap, the same pixels, with the thread given back every `sliceMs` (8 by default). A `signal` stops it at the next pause, with `aborted` |
| `close()`, `[Symbol.dispose]()` | Frees the document. Closing twice does nothing |

Columns are typed arrays, so a page crosses a thread boundary by transfer. Char `i` is entry
`i` of each column and entries `4i..4i+3` of `boxes`; `boxAt` and `charsText` read them.

What the columns mean:

- **`boxes`** are each char's advance across, by its font's ascent and descent. The font's are in
  `fonts[fontIds[i]]`: the descriptor's values, or 0.8 and -0.2 em for a font that states none (the
  standard fonts, Type 3). They are not glyph ink. For a substituted font the width is the one the
  PDF states.
- **`fontSizes`** is the size a char is drawn at, in points: `Tf` scaled by the text and page
  matrices. **`tfSizes`** is the `Tf` operand itself.
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

A render is capped at 16,384 px a side and 64 Mpx, and shrinks to fit. `maxHeight` defaults to
4096; pass `Infinity` to fit the width alone.

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
createPdfPool(options?: { threads?: number; assetBase?: string }): Promise<PdfPool>

pool.open(bytes, { password? }): Promise<PdfPoolDocument>
pool.stats(): { threads: number; queued: number }
pool.close()      // or `using`: stops every thread; what's unfinished fails with `closed`

doc.pageCount
doc.text(i)  doc.render(i, { width, maxHeight? })  doc.objects(i)
doc.annotations(i)  doc.pageInfo(i)  doc.outline()     // each a promise
doc.close()       // or `await using`: frees it on every thread
```

Each call goes to a free thread, and results are what a `PdfDocument` returns. `threads` is a limit,
by default one less than the machine's cores and at most 8. A thread starts only when a call has to
wait and none is free, so calls awaited one at a time stay on one thread. Each thread that gets a
page of a document holds its own copy of the file, and the pool holds one more until `doc.close()`.

It needs no COOP or COEP headers; with them, threads share one copy of the file. `threads` goes up to 64. Loaded
from another origin, such as a CDN, threads start through a one-line blob that imports `dist/pool-worker.js`, so
the CDN must send CORS headers for `dist/` as it does for the wasm, and a Content-Security-Policy must allow
`worker-src blob:`. A thread with no way to start workers (a service worker) gets `wrong-thread`.

A thread that can't start fails what's waiting with its reason, usually `missing-asset`, and the next call tries again; one
that says nothing for 90 seconds counts as stopped. A thread that stops fails its call with `crash`, and another takes its
place. An argument or result that can't cross between threads fails that call alone. `render` takes `width` and
`maxHeight`, and refuses `signal` with a `TypeError`: a call can't be stopped once it runs, only `pool.close()` ends all of them.
The synchronous API doesn't change, and the pool's code loads only when `createPdfPool` is called.

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
| `fetch-failed` | A ranged read failed: the network, an HTTP error, a bad Range answer. `error.status` is the answer's HTTP status; undefined if the server never answered |
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
cross-reference section, then each object on first use. `doc.stats()` reports the bytes
fetched.

The engine's calls are synchronous, so a read that misses **blocks its thread for the round
trip**. In Node a small fetcher thread does the fetch while yours waits on `Atomics.wait`; in a
Web Worker it is a synchronous request. Run it on a worker thread, not a server's main loop. A
server on the same thread cannot answer, and the read fails with `timeout` and says why.

| Option | Default | |
|---|---|---|
| `chunkBytes` | 64 KiB | The smallest fetch |
| `maxBytes` | 64 MiB | Total to fetch before failing with `too-large` |
| `timeoutMs` | 30 s | How long one fetch round may block |
| `totalTimeoutMs` | none | Wall time for the whole read, from the first fetch: a fetch in flight is cut when it runs out, a stalled one included, and none starts after. It keeps counting while the document sits open. What's already fetched still reads |
| `signal` | | Checked before the open and each fetch. It cannot interrupt a fetch, because the thread is blocked; `timeoutMs` and `totalTimeoutMs` bound that |
| `password` | | |

**A ranged read trusts `/Count`.** It finds a page by each node's `/Count`, so that it fetches only
the nodes on the way there, and checks what it reads on that path. If something doesn't add up it walks
the tree in order instead, within `maxBytes`. It can still return a different page than a whole-file read,
and which one can depend on what was read first, in two cases: a file whose `/Count` values are false
where that path doesn't look; and, with true counts, a node of over 32 kids, as many as its `/Count`,
where a kid before the page is an empty node or holds more than one page. `pageCount` can be wrong in the
first case, so a page can fail with `failed`, or pages at the end can go unseen. If you need the
guarantee, open the whole file: there `/Count` plays no part.

What a server gets wrong:

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
  so, the assets are fetched while the engine is created: all of them by default, 9.5 MB, or only
  what `preloadAssets` names (a font such as `FoxitSans.pfb`, 15–30 KB, or `fonts.bin` for all 14, 0.26 MB;
  `cmaps.deflate` 0.36 MB; `cjk-fallback.ttf` 5.1 MB), and a call that needs one you left out fails with
  `missing-asset`. The wasm's four parts (3.8 MB) come whatever you name, so it can always draw. It works, tested
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
`text`, `scan`, `annotations`, `render`. It is not on crates.io, because it depends on the
vendored hayro crates through `[patch]`, which crates.io does not honour.
