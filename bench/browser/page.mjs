// One page, one engine. `?engine=` picks it, and a first document is opened at once so the page
// load itself is part of what the first page costs.
import "./instrument.mjs";
import { connect } from "./client.mjs";

const params = new URLSearchParams(location.search);
const grid = document.querySelector("#grid");
const bytesOf = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

let stutter = 0;
let longTasks = 0;
let longest = 0;
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    stutter += Math.max(0, entry.duration - 50);
    longTasks += 1;
    longest = Math.max(longest, entry.duration);
  }
}).observe({ entryTypes: ["longtask"] });

const client = await connect(params.get("engine"));
const width = Number(params.get("width") ?? 800);
const pageCount = await client.open(await bytesOf(params.get("doc")));
await client.text(0);
const coldText = performance.now();
// `?textOnly`: for what a page that never draws downloads.
if (!params.has("textOnly")) grid.append(await client.render(0, width));
const coldRender = performance.now();
await client.close();
await new Promise(requestAnimationFrame);

window.bench = {
  cold: { text: coldText, render: coldRender, pageCount },
  /** Warm: the same document's first page again, three times. */
  async warm(url) {
    const bytes = await bytesOf(url);
    const text = [];
    const render = [];
    for (let i = 0; i < 3; i++) {
      let started = performance.now();
      await client.open(bytes.slice());
      await client.text(0);
      text.push(performance.now() - started);
      await client.close();
      started = performance.now();
      await client.open(bytes.slice());
      await client.render(0, width);
      render.push(performance.now() - started);
      await client.close();
    }
    return { text: median(text), render: median(render) };
  },
  async speed(urls, textPages, renderPages) {
    const docs = await Promise.all(urls.map(bytesOf));
    // One pass to warm up, as in Node: fonts and code the first document made it fetch.
    for (const bytes of docs) {
      const count = await client.open(bytes.slice());
      await client.text(0);
      if (count > 0) await client.render(0, width);
      await client.close();
    }
    let started = performance.now();
    let pages = 0;
    for (const bytes of docs) {
      const count = await client.open(bytes.slice());
      for (let i = 0; i < Math.min(count, textPages); i++, pages++) await client.text(i);
      await client.close();
    }
    const text = performance.now() - started;
    started = performance.now();
    let rendered = 0;
    for (const bytes of docs) {
      const count = await client.open(bytes.slice());
      for (let i = 0; i < Math.min(count, renderPages); i++, rendered++) await client.render(i, width);
      await client.close();
    }
    return { text, render: performance.now() - started, pages, rendered };
  },
  /** The large document: open it, read every page's text, draw a few. */
  async large(url, renderCount) {
    const bytes = await bytesOf(url);
    let started = performance.now();
    const count = await client.open(bytes);
    const open = performance.now() - started;
    started = performance.now();
    for (let i = 0; i < count; i++) await client.text(i);
    const text = performance.now() - started;
    started = performance.now();
    for (let i = 0; i < renderCount; i++) await client.render(Math.floor((i * count) / renderCount), width);
    const render = performance.now() - started;
    await client.close();
    return { open, text, render };
  },
  /**
   * What a reader feels: every page read and drawn into the scrolling grid, in order. The document
   * stays open afterwards, so the memory read that follows includes what the engine keeps.
   */
  async load(url) {
    grid.replaceChildren();
    const bytes = await bytesOf(url);
    stutter = longTasks = longest = 0;
    self.__bench.reset();
    const started = performance.now();
    const count = await client.open(bytes);
    for (let i = 0; i < count; i++) {
      await client.text(i);
      grid.append(await client.render(i, width));
    }
    const done = performance.now() - started;
    await new Promise(requestAnimationFrame);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { done, pages: count, stutter, longTasks, longestTask: longest };
  },
  /** recto's renderAsync, on the page that `load` holds a worker for the whole of. */
  async sliced(url) {
    const bytes = await bytesOf(url);
    const started = performance.now();
    await client.sliced(bytes, width);
    return { done: performance.now() - started };
  },
  /** The page can't be asked to stop in a synchronous engine; pdf.js's render task can. */
  async abort(url) {
    const pdfjs = await import("/pdfjs/build/pdf.min.mjs");
    const task = pdfjs.getDocument({ data: await bytesOf(url), verbosity: 0, isEvalSupported: false });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const render = page.render({ canvas, canvasContext: context, viewport });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const asked = performance.now();
    render.cancel();
    await render.promise.catch(() => {});
    const stopped = performance.now() - asked;
    await task.destroy();
    return stopped;
  },
  wasmBytes: () => self.__bench.wasmBytes(),
  /** A fixed CPU loop, to state the slowdown. */
  spin() {
    const started = performance.now();
    let x = 1;
    for (let i = 0; i < 2e8; i++) x = (x * 31 + i) | 0;
    return { ms: performance.now() - started, x };
  },
};
window.dispatchEvent(new Event("bench-ready"));
