# The viewer

`@2018kguo/recto/viewer` shows a PDF in a scrolling element. It is plain DOM with no dependencies, and
it's a separate entry point: a program that doesn't import it doesn't download it.

- Pages are laid out at once as placeholders and drawn only when they near the screen, nearest first,
  in Web Workers. A page that leaves before it's drawn has its render stopped; painted pages are held to
  a pixel budget, the oldest off-screen ones shrinking to a thumbnail.
- Each page has a transparent text layer, so text can be selected and copied, and its links: web and
  mail links open (other schemes are dropped), links within the file scroll to their destination.
- Zoom is one style write: the page grows at once with its old bitmap stretched, and the sharp one
  replaces it once the zoom has stopped moving. ⌘/Ctrl + plus, minus and 0 zoom.
- A pinch (two fingers on a touch screen, a trackpad pinch, ctrl + wheel, Safari's gesture events) zooms
  the viewer, not the browser's page, about the point under the fingers. While the fingers move the
  pages are scaled as one picture, which costs no layout and no render; when they lift, the zoom is laid
  out once and drawn sharp once.
- A page is drawn whole up to about 8 million pixels. Zoomed past that, the part of it on screen (and a
  little around it) is drawn again at the screen's density over the stretched whole, and replaced as
  the reader scrolls or zooms; a tile asked for that no longer covers the screen is stopped.
- `find` searches every page's text in the worker and returns boxes; `setHighlights` draws them. Text is
  compared in NFKC with case folded: a ligature matches its letters, a full-width letter its plain one,
  an accent written as a separate mark the accented letter, "ß" matches "ss"; a soft hyphen is ignored.
  Accents still count ("cafe" doesn't match "café"). A hit on part of a ligature covers that part of
  its box.
- A failed read (a 403, a dropped connection) or a crashed worker doesn't end the document: the next
  call opens it again, backing off while the server stays down.

## Plain JavaScript

```html
<div id="pdf" style="height: 100vh"></div>
<script type="module">
  import { createViewer } from "@2018kguo/recto/viewer";

  const viewer = createViewer({
    container: document.getElementById("pdf"),
    source: "/report.pdf",
    onOpen: ({ pageCount, ms, timing }) => console.log(`${pageCount} pages in ${ms} ms`, timing),
  });
  await viewer.ready;
  viewer.goToPage(3);
  viewer.zoomIn();
</script>
```

The viewer fills its container and scrolls inside it, so give the container a height.

## The element

```html
<script type="module">
  import { defineViewerElement } from "@2018kguo/recto/viewer";
  defineViewerElement(); // <recto-viewer>; pass a name for another tag
</script>
<recto-viewer src="/report.pdf" style="height: 80vh"></recto-viewer>
```

A toolbar with a sidebar button, the file's name, the page (type a number to go there), zoom out, fit
to width, zoom in and find. ⌘/Ctrl + F opens find, Enter and Shift + Enter step through the hits,
⌘/Ctrl + G too, Escape closes it. In the pages, arrows scroll, Left and Right turn pages, Home and End
go to the first and last. At phone widths the name is hidden and the buttons grow.

The sidebar, hidden until its button is pressed, shows the pages as thumbnails and, when the file has
bookmarks, its outline. Thumbnails are drawn small and only near view, through the viewer's paint queue
behind the pages on screen, and let go of their bitmaps once scrolled far away; the page being read is
marked. Up and Down move through either list, Home and End to its ends, Right and Left open and close
outline entries, Escape closes the sidebar. Beside the pages it narrows them; at phone widths it covers
them instead, and choosing a page closes it.

Attributes: `src`, `name` (the title shown; the file's name by default), `zoom`, `page`. Properties:
`source` (a URL, a `File`, an `ArrayBuffer` or a `Uint8Array`), `viewer` (the viewer inside), `engine`,
`openFind(query?)` and `toggleSidebar(open?)`. It fires `open` with `detail.pageCount`.

```js
const element = document.querySelector("recto-viewer");
input.addEventListener("change", () => (element.source = input.files[0]));
```

## React

There's no React package: the viewer is a ref and an effect.

```jsx
import { useEffect, useRef, useState } from "react";
import { createViewer } from "@2018kguo/recto/viewer";

export function PdfViewer({ src }) {
  const container = useRef(null);
  const [viewer, setViewer] = useState(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const created = createViewer({ container: container.current, source: src });
    created.addEventListener("pagechange", (event) => setPage(event.detail.page));
    setViewer(created);
    return () => created.destroy();
  }, [src]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div>
        <button onClick={() => viewer?.zoomOut()} aria-label="Zoom out">−</button>
        <button onClick={() => viewer?.fitWidth()}>Fit</button>
        <button onClick={() => viewer?.zoomIn()} aria-label="Zoom in">+</button>
        <span>{page} of {viewer?.pageCount ?? "…"}</span>
      </div>
      <div ref={container} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
```

Server rendering is fine: importing the module touches no DOM. Create the viewer in an effect.

## `createViewer(options)`

| Option | | |
|---|---|---|
| `container` | `HTMLElement` | Required. The viewer adds one scrolling element to it. |
| `source` | `string \| URL \| ArrayBuffer \| Uint8Array \| Blob` | A URL is read by the worker: whole up to 8 MiB, by range past that. Bytes and a `Blob` (a dropped `File`) are copied to it. |
| `fetch` | `(url) => Promise<Response>` | Read a URL with this on the page instead, whole: for headers, signed requests, or another transport. |
| `credentials` | `RequestCredentials` | Sent with the worker's requests. |
| `zoom` | `number` | 1 (the default) fits the first page's width; 0.25 to 4. |
| `page` | `number` | The page to open at. |
| `gap` | `number` | Pixels between and around pages. Default 12. |
| `textLayer`, `links`, `gestures` | `boolean` | Each default true. |
| `label` | `string` | The scrolling element's accessible name. |
| `engine` | `ViewerEngine` | The workers to use; by default one engine is shared by every viewer on the page. |
| `onOpen(info)` | | `{ pageCount, ranged, ms, timing: { engineMs, fetchMs, parseMs, bytes } }`, once the document is open. |
| `onRender(info)` | | `{ page, ms, width, height }` for each bitmap put on screen. |
| `onError(error, info)` | | `info.stage` is `open`, `render`, `text` or `find`, with `info.page`. A stopped render is not an error. |

The hooks are where timing goes: send them to whatever records your metrics.

## The viewer

| | |
|---|---|
| `ready` | Settles once the document is open and laid out; rejects with the error if it can't be opened. |
| `state` | `"loading"`, `"ready"` or `"error"`, also the scrolling element's `data-state`. |
| `pageCount`, `page`, `zoom`, `scale` | `page` is the one at the middle of the screen; `scale` is CSS pixels per point. |
| `goToPage(n, { x, y, behavior })` | To a page from 1, or a point on it in points from its top-left. |
| `next()`, `previous()` | |
| `setZoom(zoom, anchor?)` | Keeps the point under `anchor` (`clientX`, `clientY`) still; the middle of the screen by default. |
| `zoomIn()`, `zoomOut()`, `fitWidth()` | Steps of 25, 50, 75, 100, 125, 150, 200, 300 and 400%. |
| `find(query, { caseSensitive, signal, onProgress })` | Every hit as `{ page, index, boxes }`, boxes in points from the page's top-left, one a line. Whitespace in the query matches any break, and a word hyphenated across lines matches unbroken. A newer search stops an older one, which rejects with an `AbortError`. |
| `setHighlights([{ page, boxes, active? }])` | Draws boxes over pages, replacing the last set. |
| `scrollToBox(page, box)` | Centres a box on the screen. |
| `pageElement(n)` | A page's element, to put your own overlay in. |
| `outline()` | The bookmarks, `[{ title, page, url, children }]`, `page` from 1 (null when it goes nowhere in the file). |
| `renderThumbnail(n, { width, signal })` | Page `n` drawn `width` pixels wide, queued behind the pages near the screen, newest first; dropped if `signal` aborts first. |
| `element`, `document` | The scrolling element, and the open `ViewerDocument` for calls of your own. |
| `destroy()` | Stops everything and removes what the viewer added. |

Events, on the viewer: `open`, `pagechange` (`detail.page`), `zoomchange` (`detail.zoom`,
`detail.scale`), `error` (`detail.error`, `detail.stage`, `detail.page`).

### Highlights of your own

```js
const [hit] = await viewer.find("net revenue");
viewer.setHighlights([{ page: hit.page, boxes: hit.boxes, active: true }]);
viewer.scrollToBox(hit.page, hit.boxes[0]);
```

Boxes from the engine's own `text(i)` or `objects(i)` are in the same frame (points, top-left origin,
`/Rotate` applied), so anything the engine finds can be drawn the same way.

### Styling

The viewer adds one stylesheet to the document, or to the shadow root its container is in
(`VIEWER_CSS` is the text, if you'd rather add it yourself). Override its custom properties on
`.recto-viewer`: `--recto-background`, `--recto-page-background`, `--recto-page-shadow`,
`--recto-highlight`, `--recto-highlight-active`, `--recto-selection`, `--recto-focus`. On
`<recto-viewer>`, `--recto-toolbar-background`, `--recto-toolbar-text`, `--recto-toolbar-muted` and
`--recto-accent` style the toolbar and the sidebar, and `::part(name)`, `::part(sidebar)` and
`::part(body)` reach inside.

## Documents without a viewer

`createViewerEngine()` gives the worker side alone: open a document and ask for page sizes, bitmaps
(whole, or a `region` of the page in points), text, search hits and the outline, with the same
reopening on failure. Thumbnails, say:

```js
import { sharedViewerEngine } from "@2018kguo/recto/viewer";

const lease = sharedViewerEngine().open({ kind: "url", url: "/report.pdf" });
const doc = await lease.promise;
const { width, height, rgba } = await doc.render(1, { width: 160 }).promise;
lease.release();
```

A document opened by URL stays open a while after its last `release()` (the three most recent), so a
viewer opened on the same file after a thumbnail starts at once. `engine.prefetch(url)` opens one
ahead of time.

`createViewerEngine({ maxWorkers, wholeFileMaxBytes, assetBase, createWorker })`: one worker per open
document up to `maxWorkers` (4), because a ranged read blocks its worker for a round trip and a slow
server should only ever block its own document. Past that, documents read whole share the least busy
worker. `assetBase` is `createPdfEngine`'s, for wasm that isn't beside the package's script.

## Bundlers and CDNs

The client starts its worker as `new Worker(new URL("./worker.js", import.meta.url), { type: "module" })`,
the form Vite, webpack 5, Rollup and esbuild recognise, and the worker finds the wasm the way the engine
always does. From another origin (a CDN), it starts a one-line worker that imports the real one, which
needs the CDN to allow CORS, as the wasm does. Pass `createWorker` to start it some other way.

## Not here yet

No printing, no form filling or annotation editing, and no rotation control. The outline shows titles
and pages, not the point on the page a bookmark names, and not page labels ("iv", "A-5"). A pinch shows
the stretched bitmap while the fingers move and past the edge of the document can't scroll beyond it,
so a pinch that ends there settles at the edge. Find tells accents apart. A file opened by URL is
cached as it was read: to show a changed file, give it a new URL.

## The demo

`npm run demo [-- file.pdf]` serves the viewer, a generated 60-page sample with bookmarks, and the file
named, answering `Range` requests, so a file past 8 MiB opens by range as it would from any static
server. `node bench/viewer-perf.mjs` measures it in Chromium (`--browser webkit` or `firefox` too): the
first page, scrolling a 520-page document read whole and a 600-page one read by range, what is held
after scrolling all of it, and how long a zoom to 200% and 400% takes to turn sharp.

### Beside pdf.js

`npm run demo:compare [-- file.pdf]` serves a page with the same file open in this viewer and in
pdf.js's own viewer components (`PDFViewer`, `EventBus`, `PDFLinkService`, `PDFFindController`, set
up as its components example does: a worker, range requests and streaming on). Both get a frame of the
same size and the same scale; scrolling or zooming one moves the other. Choose a generated sample or
drop a PDF of your own (it is sent only to the local server, so both sides read it the same way).

**Run** plays one script on the left and then on the right, never both at once: open, scroll to page 50
in 2.5 s, zoom to 300%, find a word. Each side starts in a new frame from URLs no run has used, so
nothing is cached, and the next side waits until the last has stopped downloading. Under each side:
the time to the first page and until everything on screen is sharp (from the frame's creation, so
downloading the viewer counts), bytes downloaded, its JS and wasm under brotli, main-thread long tasks
while scrolling, how long page 50 and 300% take to turn sharp, the search, and memory (Chromium's
`measureUserAgentSpecificMemory`, the frame and its workers) and the canvas pixels each holds.

The server sends code brotli-compressed and PDFs as they are, answering `Range`. A network preset
(none, fast 4G, slow 4G, slow 3G: Chrome DevTools' round trips and bandwidths) delays each response by
a round trip and shares the bandwidth among every response in flight, as one link would.

`npm run bench:compare -- [--doc report-200.pdf] [--network none,fast-4g,slow-4g,slow-3g] [--runs 3]
[--video dir]` plays the script in headless Chromium, a fresh browser per run, alternating which side
goes first, prints the medians and writes every run to `bench/results/compare.json`.
