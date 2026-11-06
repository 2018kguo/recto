# @2018kguo/recto

A PDF engine for JavaScript: text with positions, page objects and rendering, in Rust compiled
to WebAssembly. No runtime dependencies and no install scripts; the built wasm ships in this
package, so you don't need Rust.

```js
import { readFile } from "node:fs/promises";
import { openPdf } from "@2018kguo/recto";

const bytes = await readFile("report.pdf");
await using doc = await openPdf(bytes);
doc.pageCount;
doc.text(0).text;
const { width, height, rgba } = doc.render(0, { width: 1024 });
```

Calls run synchronously on the calling thread, so put heavy work on a `worker_threads` worker. In
a browser, use a dedicated Web Worker: `import` it there and call `openPdf`. Nothing else is
needed. It also runs on a page's main thread and in a service worker, where it fetches its assets
up front, but a main thread freezes for the length of each call.

[Documentation](https://github.com/2018kguo/recto#readme) ·
[Reference](https://github.com/2018kguo/recto/blob/main/docs/reference.md)

MIT. The bundled fonts and CMaps have their own licences: see `wasm/THIRD_PARTY_NOTICES`.
