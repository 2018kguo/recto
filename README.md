<h1 align="center">recto</h1>
<p align="center">A PDF engine for JavaScript: text with positions, page objects and rendering, in Rust compiled to WebAssembly.</p>
<p align="center">
  <a href="#use-it">Get started</a> ·
  <a href="docs/reference.md">Reference</a> ·
  <a href="docs/benchmarks.md">Benchmarks</a> ·
  <a href="docs/how-it-works.md">How it works</a>
</p>

recto opens a PDF and gives you each page's text, the box and font of every character, its
images, paths and annotations, and a rendered bitmap. It has no runtime dependencies and no
install scripts, and the built WebAssembly ships in the package, so you don't need Rust. In the
benchmark below it reads text **5.2× faster** than pdf.js and renders **4.2× faster**.

## Use it

```sh
npm install @2018kguo/recto
```

```js
import { readFile } from "node:fs/promises";
import { openPdf } from "@2018kguo/recto";

const bytes = await readFile("report.pdf");
await using doc = await openPdf(bytes);
console.log(doc.pageCount, doc.text(0).text);
const { width, height, rgba } = doc.render(0, { width: 1024 });
console.log(width, height, rgba.length);
```

That is all the setup: fonts and CMaps load from the package when a document first needs them.
`using` closes the document; so does `doc.close()`. The bytes are copied, so you can reuse the
buffer as soon as `openPdf` returns.

**Every call is synchronous CPU work.** It blocks the thread it runs on, so a server should not
run it on its main loop. Put it on a worker thread:

```js
// pdf-thread.js
import { parentPort } from "node:worker_threads";
import { openPdf } from "@2018kguo/recto";

parentPort.on("message", async (bytes) => {
  using doc = await openPdf(bytes);
  const pages = [];
  for (let i = 0; i < doc.pageCount; i++) pages.push(doc.text(i).text);
  parentPort.postMessage(pages);
});
```

```js
// server.js
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";

const thread = new Worker(new URL("./pdf-thread.js", import.meta.url));
thread.once("message", (pages) => {
  console.log(pages);
  thread.terminate();
});
thread.postMessage(await readFile("report.pdf"));
```

recto has no thread pool of its own; how many threads you want is up to you.

### In a browser

It runs in a dedicated Web Worker. A bundler that understands `new URL(…, import.meta.url)` finds
the WebAssembly and fonts by itself ([which ones were tested](docs/reference.md#setup-per-environment)).
No special headers are needed.

```js
// pdf-worker.js
import { openPdf } from "@2018kguo/recto";

self.onmessage = async ({ data: bytes }) => {
  using doc = await openPdf(bytes);
  const { width, height, rgba } = doc.render(0, { width: 1024 });
  self.postMessage({ text: doc.text(0).text, width, height, rgba }, [rgba.buffer]);
};
```

```js
// main.js
const worker = new Worker(new URL("./pdf-worker.js", import.meta.url), { type: "module" });
worker.onmessage = ({ data }) => console.log(data.text);
worker.postMessage(await (await fetch("/report.pdf")).arrayBuffer());
```

On a page's main thread `openPdf` fails with a `PdfError` that says to do this: the engine reads
fonts synchronously from inside a call, which a main thread can't do.

### When things go wrong

Every failure is a `PdfError` with a `code` to branch on:

```js
import { openPdf, PdfError } from "@2018kguo/recto";

try {
  using doc = await openPdf(bytes, { password });
  // ...
} catch (error) {
  if (!(error instanceof PdfError)) throw error;
  if (error.code === "password-required" || error.code === "wrong-password") askAgain();
  else if (error.code === "invalid-file") reject();
  else throw error;
}
```

If the WebAssembly instance crashes, documents open on it fail with `crash` and the next open
gets a fresh one. A missing font file throws `missing-asset` from the call that needed it. It
never reads as blank text. The [reference](docs/reference.md#errors) lists every code.

### Only the bytes you read

`engine.openRanged(url)` fetches just the parts of the file the parser needs:

```js
import { createPdfEngine } from "@2018kguo/recto";

const engine = await createPdfEngine();
using doc = await engine.openRanged("https://example.com/large.pdf");
doc.pageCount;
doc.stats().bytesFetched;
```

A read that misses blocks its thread for the round trip, so run it on a worker thread. A server
that ignores `Range` is read whole, within `maxBytes`; a wrong answer fails clearly. See
[ranged reads](docs/reference.md#ranged-reads).

## How fast

Node 25.9.0 on an Apple M5 Pro (18 cores, 64 GB), which had other work running (load average 9.1 at the end of the run), so compare the ratios. pdf.js 6.5.438 in the same thread, 120 public PDFs (93 MB). Median of 5 alternating passes, after a warm-up pass.

| | recto | pdf.js | |
|---|---:|---:|---:|
| Text, first 20 pages of each (957 pages) | 593 ms | 3,076 ms | 5.2× |
| Render at 1024 px, first 2 pages of each (237 pages) | 1,599 ms | 6,676 ms | 4.2× |
| A fresh process to the first page's text, on the smallest file | 22 ms | 143 ms | 6.5× |

[benchmarks.md](docs/benchmarks.md) has how it's measured and the raw results. To rerun it on PDFs
of your own (it commits none):

```sh
npm run build
npm run bench -- path/to/pdfs
```

These numbers say how fast, not how good: this benchmark doesn't compare rendered pixels.

## What's in the package

| File | Size | When it loads |
|---|---:|---|
| `wasm/recto.wasm` | 4.1 MB (1.0 MB brotli) | Creating an engine |
| `wasm/recto.gen.mjs`, `dist/` | 32 KB, 73 KB of JavaScript | Importing the package |
| `wasm/fonts.bin` | 0.26 MB | A document names a standard font it doesn't embed |
| `wasm/cmaps.brotli` | 0.25 MB | A document uses a predefined CJK CMap |
| `wasm/cjk-fallback.ttf` | 5.1 MB | Rendering CJK from a font the document doesn't embed |

## Limits

- **Browsers:** a dedicated Web Worker only, not a main thread, a service worker or an edge runtime
  without synchronous requests.
- **Memory:** `open` copies the file into WebAssembly memory, and that memory only shrinks when an
  instance is replaced (past 512 MiB by default). A ranged read holds files up to 2 GiB.
- **Char boxes** are loose font boxes, with a fixed ascent and descent of 0.8 and −0.2 em. They are
  not glyph ink, and for a substituted font they are off by its width stretch.
- **`fontSizes`** is the drawn size, not the `Tf` operand. **`fonts`** tells fonts apart by program, so
  two dictionaries over one program merge; names and weights come only for embedded TrueType and CID
  fonts. A fill colour reads as the stroke colour for stroke-only text, and as opaque black for a pattern.
- **Hostile pages:** past 2^19 glyphs or 2^21 path segments on a page, the rest of the page is dropped
  silently.
- **Rendering** inherits hayro's gaps: knockout groups, blend isolation, colour-key masks.
- **Encryption:** the Standard security handler only; a repair of an encrypted file can fail where
  other readers manage it.
- **Not here:** writing or editing PDFs, filling forms, outlines, OCR. A scanned page has no text.

Tested on Node 24 and 25, and in Chromium, Firefox and WebKit. CI runs Node 24 and Chromium.

## Documentation

- [reference.md](docs/reference.md): the whole API, every error code, ranged reads, setup per environment
- [benchmarks.md](docs/benchmarks.md): every number, how it's measured, how to rerun it
- [how-it-works.md](docs/how-it-works.md): the text layer, assets, ranged reads, instances
- [development.md](docs/development.md): building it, tests, the repository layout

## License

MIT. recto is built on [hayro](https://github.com/LaurenzV/hayro) (MIT or Apache-2.0). `vendor/` holds
patched copies of four of its crates, with their licences and a [note on what changed](vendor/README.md).
The Foxit fonts are BSD-licensed and the Droid Sans fallback Apache-2.0; `wasm/THIRD_PARTY_NOTICES` in
the package has these and every compiled crate's licence.
