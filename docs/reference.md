# Reference

Everything is exported from `@2018kguo/recto`. Coordinates are PDF points in the viewer's
frame: top-left origin, with `/Rotate` and the crop box applied.

## Opening

```ts
openPdf(bytes: Uint8Array | ArrayBuffer, options?: { password?: string; signal?: AbortSignal }): Promise<PdfDocument>
createPdfEngine(options?: { assetBase?: string | URL; recycleAboveBytes?: number }): Promise<PdfEngine>

engine.open(bytes, options?): Promise<PdfDocument>
engine.openRanged(source: string | URL | Uint8Array, options?: PdfRangedOpenOptions): Promise<PdfRangedDocument>
engine.stats(): { heapBytes: number; generation: number; openDocuments: number }
```

`openPdf` uses one shared engine per thread, created on first use. Create your own to set
options, or to keep a job's memory apart. An engine replaces its WebAssembly instance when
memory passes `recycleAboveBytes` (512 MiB by default; WebAssembly memory never shrinks) or
when it crashed. Documents opened earlier keep their instance until they close.

**The bytes are copied** before the call returns its promise, whether by `open` or by a ranged
open of bytes, so you can reuse a pooled `Buffer`, change the buffer, or transfer it straight
away, without waiting. `open` then holds the file in WebAssembly memory for as long as the
document is open, in memory that comes back only when the instance is replaced, and briefly
twice during the open.

## A document

| Member | What it returns |
|---|---|
| `pageCount` | The number of pages |
| `pageInfo(i)` | `{ width, height, rotation }` |
| `text(i)` | `PdfPageText`: the page's `text`, and columns per char: `codepoints`, `boxes`, `fontSizes`, `angles`, `fills`, `fontIds`, `flags`, `runIds`; plus `fonts`, `words`, `runs` |
| `objects(i)` | `PdfPageObjects`: image boxes and pixel sizes, path boxes and flags, path segments |
| `annotations(i)` | `PdfAnnotation[]`: subtype, box, contents, form field, appearance text |
| `scan(i)` | `text`, `objects` and `annotations` from one interpretation of the page |
| `textAndAnnotations(i)` | `text` and `annotations` from one interpretation of the page |
| `render(i, { width, maxHeight? })` | `{ width, height, rgba }`: opaque RGBA, four bytes a pixel, on white |
| `close()`, `[Symbol.dispose]()` | Frees the document. Closing twice does nothing |

Columns are typed arrays, so a page crosses a thread boundary by transfer. Char `i` is entry
`i` of each column and entries `4i..4i+3` of `boxes`; `boxAt` and `charsText` read them.

A render is capped at 16,384 px a side and 64 Mpx, and shrinks to fit. `maxHeight` defaults to
4096; pass `Infinity` to fit the width alone.

Helpers over those columns: `textItems(page, info)` makes pdf.js-style text items,
`readingOrder(page, info)` gives the reading order and breaks (it re-lays out rotated pages),
`annotationTextItems` does the same for annotation text, and `rasterMeasures`,
`vectorMeasures`, `showsGlyphs` measure what a page paints.

## Errors

Every failure is a `PdfError` with a `code`. A bad argument is a `RangeError` or `TypeError`.

| `code` | Meaning |
|---|---|
| `invalid-file` | Not a PDF the engine can open: garbage, truncated, a broken xref |
| `password-required` | Encrypted, and no password given |
| `wrong-password` | Encrypted, and the password does not open it |
| `unsupported` | A valid file the engine cannot read: a security handler other than Standard |
| `aborted` | The `signal` was aborted; `cause` is its reason |
| `crash` | The instance trapped. Open documents on it fail with this; the next open gets a fresh instance |
| `closed` | The document was closed |
| `missing-asset` | The wasm, a font or CMaps are missing, unreadable, or not this build's |
| `wrong-thread` | Called on a page's main thread or in a service worker |
| `fetch-failed` | A ranged read failed: the network, an HTTP error, a bad Range answer |
| `timeout` | A ranged fetch waited longer than `timeoutMs` |
| `too-large` | A ranged read would pass `maxBytes`, or the file is past 2 GiB |
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
| `signal` | | Checked before the open and each fetch. It cannot interrupt a fetch, because the thread is blocked; `timeoutMs` bounds that |
| `password` | | |

What a server gets wrong:

- **It ignores Range** (a 200 with the whole file): the file is used, as long as it fits
  `maxBytes`; otherwise `too-large`.
- **A wrong length, a shifted range, no `Content-Range` total, a size or ETag that changes**:
  `fetch-failed`, with the reason. A file replaced by one of the same size, from a server that
  sends no ETag, can't be detected, and reads as a mix of the two.
- **A total past 2 GiB**: `too-large`.
- **Cross-origin in a browser**: it must allow the request and send
  `Access-Control-Expose-Headers: Content-Range`, or the read fails with `fetch-failed` and
  says so.
- A failed fetch is final for that document: reopen to retry. Error messages never include the
  URL, since a presigned query is a credential.

## Setup per environment

The wasm and assets are found with `new URL("../wasm/…", import.meta.url)`.

- **Node 24 and newer**: nothing to configure.
- **Vite 8** (dev server and build): nothing to configure. CI runs both in Chromium; both were
  also run by hand in Firefox and WebKit.
- **Vite 7**: the build works. The dev server's dependency pre-bundling loses the URLs, and the
  worker's first call fails with `missing-asset`. Add
  `optimizeDeps: { exclude: ["@2018kguo/recto"] }`. Run by hand, not in CI.
- **Other bundlers**: webpack 5 and Rollup also rewrite `new URL(…, import.meta.url)` but have
  not been run. A bundler that does not (esbuild) leaves the files behind: copy
  `node_modules/@2018kguo/recto/wasm/*` somewhere it serves and pass that directory:

  ```js
  const engine = await createPdfEngine({ assetBase: "/recto/" });
  ```

- **A Content-Security-Policy** must allow `wasm-unsafe-eval`, and `connect-src` for the assets.
- **A page's main thread and service workers** cannot run the engine: they cannot read an asset
  synchronously. `openPdf` and `createPdfEngine` fail there with `wrong-thread`, saying what to
  do. No headers (COOP, COEP) are needed in a dedicated worker.

Every file is pinned by SHA-256, checked when it is first read, so a dev server's HTML fallback
page cannot read as a font. A missing asset throws from the call that needed it; it never reads
as blank text.

## The Rust crate

`crates/recto` is the engine without JavaScript: `recto::Document::open(bytes, password)`, then
`text`, `scan`, `annotations`, `render`. It is not on crates.io, because it depends on the
vendored hayro crates through `[patch]`, which crates.io does not honour.
