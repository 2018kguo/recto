// The viewer in a DOM: what it lays out, what it paints and when, zoom, navigation, links and find.
// Pages are drawn by the real engine in this thread, except where a test needs to hold a render back.

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PdfBox } from "../../src/document.ts";
import { createViewerEngine, type RenderTask, type ViewerBitmap, type ViewerDocument, type ViewerEngine } from "../../src/viewer/client.ts";
import { outputScale } from "../../src/viewer/layout.ts";
import { createViewer, type Viewer } from "../../src/viewer/viewer.ts";
import { fakeLayout } from "./dom.ts";
import { inProcessWorkers, textPdf } from "./fixtures.ts";

function realEngine() {
  const workers = inProcessWorkers();
  return { engine: createViewerEngine({ createWorker: workers.createWorker }), workers };
}

const renderedPages = (viewer: Viewer) =>
  Array.from({ length: viewer.pageCount }, (_, i) => i + 1).filter((page) => viewer.pageElement(page)?.dataset.rendered === "true");

/** The page under the middle of the screen, and how far down it the middle is. */
function middleOf(viewer: Viewer) {
  const center = viewer.element.clientHeight / 2;
  for (let page = 1; page <= viewer.pageCount; page++) {
    const box = viewer.pageElement(page)!.getBoundingClientRect();
    if (box.top <= center && box.bottom >= center) {
      return { fraction: (center - box.top) / box.height, page };
    }
  }
  return null;
}

test("a long document lays out every page and paints only those near the screen", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const opened: unknown[] = [];
  const viewer = createViewer({ container: layout.container, engine, onOpen: (info) => opened.push(info), source: textPdf({ pages: 300 }) });
  try {
    await viewer.ready;
    assert.equal(viewer.state, "ready");
    assert.equal(viewer.pageCount, 300);
    assert.equal(layout.container.querySelectorAll(".recto-page").length, 300);
    assert.equal(opened.length, 1);
    // Fit to width: 800 less 12 px a side over 612 points.
    assert.ok(Math.abs(viewer.scale - 776 / 612) < 1e-9);
    await layout.until(() => renderedPages(viewer).length >= 2, "the first pages to paint");
    await layout.idle();
    const painted = renderedPages(viewer);
    // About two screens ahead of a 600 px screen of ~1000 px pages: a handful, never the document.
    assert.ok(painted.length > 0 && painted.length <= 4, `painted ${painted.join(", ")}`);
    assert.equal(painted[0], 1);
    // A text layer for each, and a canvas at device density: 2x of 776 px.
    const first = viewer.pageElement(1)!;
    assert.match(first.querySelector(".recto-text")?.textContent ?? "", /Page 1 line 0/u);
    assert.equal(layout.drawn.find((draw) => draw.page === 1)?.width, 1552);
    // Placeholders for the rest: no canvas, no text.
    assert.equal(viewer.pageElement(200)!.querySelector("canvas"), null);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("scrolling paints where the reader went, and tracks the page they are on", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 60 }) });
  const changes: number[] = [];
  viewer.addEventListener("pagechange", (event) => changes.push(event.detail.page));
  try {
    await viewer.ready;
    await viewer.goToPage(40);
    assert.equal(viewer.page, 40);
    await layout.until(() => renderedPages(viewer).includes(40), "page 40 to paint");
    assert.ok(!renderedPages(viewer).includes(20));
    assert.deepEqual(changes, [40]);
    // A hand scroll moves the page with it.
    viewer.element.scrollTop += 3000;
    await layout.until(() => viewer.page > 40, "the page to follow the scroll");
    assert.equal(middleOf(viewer)?.page, viewer.page);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("zooming is one style write that keeps the drawn page, and the sharp one replaces it", async () => {
  const layout = fakeLayout();
  const { engine, workers } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 20 }) });
  try {
    await viewer.ready;
    await layout.until(() => renderedPages(viewer).includes(1), "page 1 to paint");
    await layout.idle();
    const canvas = viewer.pageElement(1)!.querySelector("canvas")!;
    const writes = layout.scaleWrites();
    const renders = () => workers.ports.flatMap((port) => port.sent).filter((message) => message.op === "render" && !message.region).length;
    const before = renders();
    // A pinch: many small steps within one quiet window.
    for (let step = 0; step < 10; step++) {
      viewer.setZoom(viewer.zoom * 1.08);
    }
    assert.equal(layout.scaleWrites() - writes, 10, "one style write per step, however many pages");
    // The old bitmap is still on screen, scaled, until a new one is drawn.
    assert.equal(viewer.pageElement(1)!.querySelector("canvas"), canvas);
    await layout.until(() => viewer.pageElement(1)!.querySelector("canvas") !== canvas, "the sharp bitmap");
    const sharp = layout.drawn.findLast((draw) => draw.page === 1 && !draw.tile)!;
    // Two device pixels a CSS pixel, up to the most pixels a canvas is given.
    const wanted = outputScale({ devicePixelRatio: 2, displayScale: viewer.scale, pageArea: 612 * 792 });
    assert.ok(wanted < viewer.scale * 2, "fixture check: this zoom reaches the canvas cap");
    assert.ok(Math.abs(sharp.width - Math.round(612 * wanted)) <= 1, `${sharp.width} px for scale ${viewer.scale}`);
    assert.ok(sharp.width > 1552, "sharper than before the zoom");
    await layout.idle();
    // One repaint per page near the screen for the whole gesture, not one per step.
    const repaints = renders() - before;
    const near = renderedPages(viewer).length;
    assert.ok(repaints <= near + 2, `${repaints} renders for ${near} pages`);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("does not repaint when the zoom doesn't change, and zooms back down the ladder", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 4 }) });
  const zooms: number[] = [];
  viewer.addEventListener("zoomchange", (event) => zooms.push(event.detail.zoom));
  try {
    await viewer.ready;
    viewer.setZoom(1);
    viewer.fitWidth();
    assert.deepEqual(zooms, []);
    viewer.zoomIn();
    viewer.zoomIn();
    viewer.zoomOut();
    viewer.setZoom(99);
    viewer.setZoom(0.001);
    assert.deepEqual(zooms, [1.25, 1.5, 1.25, 4, 0.25]);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("a zoom keeps the reader on the same part of the page", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 30 }) });
  try {
    await viewer.ready;
    await viewer.goToPage(12, { y: 300 });
    const before = middleOf(viewer)!;
    viewer.setZoom(2);
    const after = middleOf(viewer)!;
    assert.equal(after.page, before.page);
    assert.ok(Math.abs(after.fraction - before.fraction) < 0.01, `${before.fraction} then ${after.fraction}`);
    // Under a pointer: the point under it stays under it.
    const pointer = { clientX: 400, clientY: 100 };
    const page = viewer.pageElement(after.page)!;
    const box = page.getBoundingClientRect();
    const at = (pointer.clientY - box.top) / box.height;
    viewer.setZoom(3, pointer);
    const moved = page.getBoundingClientRect();
    assert.ok(Math.abs((pointer.clientY - moved.top) / moved.height - at) < 0.01);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("a page of another size is laid out at its own when it nears the screen, and the reader stays put", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  // Every page is letter but the last, which is landscape A4-ish.
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 6, lastSize: [842, 595] }) });
  try {
    await viewer.ready;
    assert.equal(viewer.pageElement(6)!.style.getPropertyValue("--w"), "612", "sized from page 1 until read");
    await viewer.goToPage(6);
    await layout.until(() => renderedPages(viewer).includes(6), "page 6 to paint");
    assert.equal(viewer.pageElement(6)!.style.getPropertyValue("--w"), "842");
    assert.equal(viewer.pageElement(6)!.style.getPropertyValue("--h"), "595");
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("a link to a page scrolls to its destination; the text layer carries only safe links", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ links: true, pages: 3 }) });
  try {
    await viewer.ready;
    await layout.until(() => viewer.pageElement(1)!.querySelectorAll("a").length > 0, "page 1's links");
    const anchors = [...viewer.pageElement(1)!.querySelectorAll("a")];
    assert.deepEqual(
      anchors.map((anchor) => anchor.getAttribute("href")),
      ["https://example.com/a?b=1", "mailto:someone@example.com", "#page=2"]
    );
    const internal = anchors[2]!;
    const click = new layout.window.MouseEvent("click", { bubbles: true, cancelable: true });
    internal.dispatchEvent(click);
    assert.ok(click.defaultPrevented);
    await layout.until(() => viewer.page === 2, "the jump to page 2");
    // XYZ 36 400 on a 792-point page: 392 points from its top, at the top of the screen.
    const top = viewer.pageElement(2)!.getBoundingClientRect().top;
    assert.ok(Math.abs(top + 392 * viewer.scale) < 1, `page 2 top at ${top}`);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("find searches every page in the worker and highlights its hits", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 40 }) });
  try {
    await viewer.ready;
    const progress: number[] = [];
    const matches = await viewer.find("line 2", { onProgress: (_, searched) => progress.push(searched) });
    assert.equal(matches.length, 40);
    assert.deepEqual(
      matches.map((match) => match.page),
      Array.from({ length: 40 }, (_, i) => i + 1)
    );
    assert.equal(progress.at(-1), 40);
    assert.equal((await viewer.find("PAGE 17 LINE 1")).length, 1);
    assert.equal((await viewer.find("PAGE 17 LINE 1", { caseSensitive: true })).length, 0);
    // A newer search stops an older one.
    const older = viewer.find("line");
    const newer = viewer.find("Page 3 ");
    await assert.rejects(older, { name: "AbortError" });
    // "Page 3 " is whitespace-trimmed to "Page 3", which is in Page 3, 30..39.
    assert.equal((await newer).length, 11 * 3);
    const [hit] = await viewer.find("Page 25 line 0");
    // Many hits far from the screen cost no DOM until the reader gets there.
    const everywhere = await viewer.find("line");
    viewer.setHighlights(everywhere.map((match) => ({ boxes: match.boxes, page: match.page })));
    assert.equal(viewer.pageElement(25)!.querySelectorAll(".recto-highlights > div").length, 0);
    viewer.setHighlights([{ active: true, boxes: hit!.boxes, page: hit!.page }]);
    await viewer.scrollToBox(hit!.page, hit!.boxes[0]!);
    assert.equal(viewer.page, 25);
    layout.flushObservers();
    const marks = viewer.pageElement(25)!.querySelectorAll(".recto-highlights > div");
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.className, "recto-active");
    // In points, under the scale the layer shares with its page.
    assert.equal(Number.parseFloat((marks[0] as HTMLElement).style.left), Math.round(hit!.boxes[0]!.x * 1000) / 1000);
    viewer.setHighlights([]);
    assert.equal(viewer.pageElement(25)!.querySelectorAll(".recto-highlights > div").length, 0);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("keys turn pages and zoom", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 5 }) });
  try {
    await viewer.ready;
    const press = (key: string, init: KeyboardEventInit = {}) =>
      viewer.element.dispatchEvent(new layout.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }));
    press("ArrowRight");
    await layout.until(() => viewer.page === 2, "page 2");
    press("End");
    await layout.until(() => viewer.page === 5, "the last page");
    press("Home");
    await layout.until(() => viewer.page === 1, "the first page");
    press("=", { ctrlKey: true });
    assert.equal(viewer.zoom, 1.25);
    press("-", { metaKey: true });
    assert.equal(viewer.zoom, 1);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("a file that can't be opened is an error, not a hang", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const errors: string[] = [];
  const viewer = createViewer({
    container: layout.container,
    engine,
    onError: (_, info) => errors.push(info.stage),
    source: new TextEncoder().encode("not a pdf"),
  });
  try {
    await assert.rejects(viewer.ready, { code: "invalid-file" });
    assert.equal(viewer.state, "error");
    assert.equal(viewer.element.dataset.state, "error");
    assert.deepEqual(errors, ["open"]);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("destroy lets go of the document and removes what the viewer added", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 3 }) });
  await viewer.ready;
  assert.equal(engine.liveWorkers(), 1);
  viewer.destroy();
  assert.equal(layout.container.children.length, 0);
  // Read from bytes, nothing caches it.
  assert.equal(engine.liveWorkers(), 0);
  engine.close();
});

/**
 * An engine whose renders the test finishes by hand, in any order, each a bitmap of the asked width.
 * Every page is letter, 612 x 792 points; the bitmaps are stand-ins of the right size.
 */
function heldEngine(pageCount: number) {
  const renders: { page: number; width: number; region: PdfBox | undefined; cancelled: boolean; resolve(): void; reject(cause: unknown): void }[] = [];
  const doc: ViewerDocument = {
    find: async () => [],
    outline: async () => [],
    pageCount,
    pageInfo: async () => ({ height: 792, rotation: 0, width: 612 }),
    ranged: false,
    render(page, { width, region }): RenderTask {
      let settle!: { resolve(): void; reject(cause: unknown): void };
      const k = width / 612;
      const pageHeight = Math.round(792 * k);
      const bitmap = (): ViewerBitmap =>
        region
          ? {
              height: Math.round(region.height * k),
              region: { pageHeight, pageWidth: width, x: Math.round(region.x * k), y: Math.round(region.y * k) },
              rgba: new Uint8ClampedArray(4),
              width: Math.round(region.width * k),
            }
          : { height: pageHeight, rgba: new Uint8ClampedArray(4), width };
      const promise = new Promise<ViewerBitmap>((resolve, reject) => {
        settle = { reject, resolve: () => resolve(bitmap()) };
      });
      const entry = { cancelled: false, page, region, width, ...settle };
      renders.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
          entry.reject(Object.assign(new Error("cancelled"), { code: "aborted", name: "AbortError" }));
        },
        promise,
      };
    },
    text: async () => ({ links: [], runs: [] }),
    timing: { bytes: 0, engineMs: 0, fetchMs: 0, parseMs: 0 },
  };
  const engine: ViewerEngine = {
    close() {},
    liveWorkers: () => 0,
    open: () => ({ promise: Promise.resolve(doc), release() {} }),
    prefetch: async () => {},
  };
  return { engine, renders };
}

test("an older render that finishes last does not replace a newer one", async () => {
  const layout = fakeLayout();
  const { engine, renders } = heldEngine(3);
  const viewer = createViewer({ container: layout.container, engine, source: "held.pdf" });
  try {
    await viewer.ready;
    await layout.until(() => renders.some((render) => render.page === 1), "page 1's first render");
    renders.find((render) => render.page === 1)!.resolve();
    await layout.until(() => renderedPages(viewer).includes(1), "page 1 on screen");
    viewer.setZoom(1.25);
    await layout.until(() => renders.filter((render) => render.page === 1).length === 2, "the repaint for 125%");
    viewer.setZoom(1.5);
    await layout.until(() => renders.filter((render) => render.page === 1).length === 3, "the repaint for 150%");
    const [, atLow, atHigh] = renders.filter((render) => render.page === 1);
    // The 125% render was superseded, and stopped.
    assert.ok(atLow!.cancelled);
    atHigh!.resolve();
    const shown = () => viewer.pageElement(1)!.querySelector("canvas")!.width;
    await layout.until(() => shown() === atHigh!.width, "the 150% bitmap");
    atLow!.resolve();
    await layout.idle(50);
    assert.equal(shown(), atHigh!.width);
  } finally {
    viewer.destroy();
  }
});

test("a page the reader scrolled past stops painting, and one on screen is never released", async () => {
  const layout = fakeLayout();
  const { engine, renders } = heldEngine(400);
  const viewer = createViewer({ container: layout.container, engine, source: "held.pdf" });
  try {
    await viewer.ready;
    await layout.until(() => renders.length >= 2, "the first paints");
    const first = renders[0]!;
    // Far away before it finished: its render is stopped.
    await viewer.goToPage(300);
    layout.flushObservers();
    assert.ok(first.cancelled);
    // Paint everything that asks, zoomed in so the pixel budget is tight, scrolling as we go.
    viewer.setZoom(4);
    for (let round = 0; round < 40; round++) {
      for (const render of renders) {
        render.resolve();
      }
      viewer.element.scrollTop += 200;
      await layout.idle(10);
      // Every page on screen holds its bitmap.
      for (let page = 1; page <= viewer.pageCount; page++) {
        const box = viewer.pageElement(page)!.getBoundingClientRect();
        const onScreen = box.bottom > 0 && box.top < viewer.element.clientHeight;
        const canvas = viewer.pageElement(page)!.querySelector("canvas");
        if (onScreen && canvas) {
          assert.ok(canvas.width > 160, `page ${page} is on screen with an evicted bitmap`);
        }
      }
    }
    // Some pages that scrolled away were shrunk to thumbnails: memory stays flat.
    const shrunk = [...layout.container.querySelectorAll("canvas")].filter((canvas) => canvas.width <= 160);
    assert.ok(shrunk.length > 0);
    // And past a few dozen of those, the oldest go entirely: a long read holds what a short one does.
    for (let round = 0; round < 120; round++) {
      for (const render of renders) {
        render.resolve();
      }
      viewer.element.scrollTop += 2500;
      await layout.idle(5);
    }
    const kept = [...layout.container.querySelectorAll("canvas")].filter((canvas) => canvas.width <= 160);
    assert.ok(kept.length <= 48, `${kept.length} shrunk bitmaps kept`);
    assert.ok(viewer.page > 200, `read to page ${viewer.page}`);
  } finally {
    viewer.destroy();
  }
});

/** A touch event with these fingers down, as the gestures read it. */
function touch(layout: ReturnType<typeof fakeLayout>, type: string, fingers: [number, number][]): Event {
  const event = new layout.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: fingers.map(([clientX, clientY]) => ({ clientX, clientY })) });
  return event;
}

/** Where `point` falls on the page under it, as shares of the page. */
function pointOnPage(viewer: Viewer, point: { clientX: number; clientY: number }) {
  for (let page = 1; page <= viewer.pageCount; page++) {
    const box = viewer.pageElement(page)!.getBoundingClientRect();
    if (box.top <= point.clientY && box.bottom >= point.clientY) {
      return { page, x: (point.clientX - box.left) / box.width, y: (point.clientY - box.top) / box.height };
    }
  }
  return null;
}

test("a two-finger pinch zooms the viewer around the fingers: a transform while it moves, one layout and one repaint at its end", async () => {
  const layout = fakeLayout();
  const { engine, workers } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 30 }) });
  try {
    await viewer.ready;
    await viewer.goToPage(5, { y: 200 });
    await layout.until(() => renderedPages(viewer).includes(5), "page 5 to paint");
    await layout.idle();
    const pages = viewer.element.querySelector<HTMLElement>(".recto-pages")!;
    const writes = layout.scaleWrites();
    const renders = () => workers.ports.flatMap((port) => port.sent).filter((message) => message.op === "render" && !message.region).length;
    const before = renders();
    const middle = { clientX: 400, clientY: 300 };
    const under = pointOnPage(viewer, middle)!;
    viewer.element.dispatchEvent(touch(layout, "touchstart", [[350, 250], [450, 350]]));
    // The fingers spread to twice as far apart, and slide 30 px down together.
    for (const spread of [1.25, 1.5, 1.75, 2]) {
      const move = touch(layout, "touchmove", [
        [400 - 50 * spread, 300 - 50 * spread + 30],
        [400 + 50 * spread, 300 + 50 * spread + 30],
      ]);
      viewer.element.dispatchEvent(move);
      assert.ok(move.defaultPrevented, "the browser does not zoom the page");
      await layout.idle(40);
    }
    // While it moves: a picture of the pages scaled about the pinch, no layout, no render.
    assert.match(pages.style.transform, /translate\(0px, 30px\) scale\(2\)/u);
    assert.equal(layout.scaleWrites(), writes);
    assert.equal(viewer.zoom, 1);
    assert.equal(renders(), before);
    viewer.element.dispatchEvent(touch(layout, "touchend", []));
    // At its end: the zoom it reached, one style write, and the point under the fingers where they left it.
    assert.equal(pages.style.transform, "");
    assert.ok(Math.abs(viewer.zoom - 2) < 1e-9, `zoom ${viewer.zoom}`);
    assert.equal(layout.scaleWrites() - writes, 1);
    const after = pointOnPage(viewer, { clientX: middle.clientX, clientY: middle.clientY + 30 })!;
    assert.equal(after.page, under.page);
    assert.ok(Math.abs(after.x - under.x) < 0.01 && Math.abs(after.y - under.y) < 0.01, `${JSON.stringify(under)} then ${JSON.stringify(after)}`);
    // Then one sharp render of each page near the screen.
    await layout.until(() => renders() > before, "the sharp render");
    await layout.idle();
    const near = renderedPages(viewer).length;
    assert.ok(renders() - before <= near, `${renders() - before} renders for ${near} pages`);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("a trackpad pinch (ctrl + wheel) previews the same way and lays out once it stops", async () => {
  const layout = fakeLayout();
  const { engine } = realEngine();
  const viewer = createViewer({ container: layout.container, engine, source: textPdf({ pages: 10 }) });
  try {
    await viewer.ready;
    const pages = viewer.element.querySelector<HTMLElement>(".recto-pages")!;
    const writes = layout.scaleWrites();
    const pointer = { clientX: 300, clientY: 200 };
    const under = pointOnPage(viewer, pointer)!;
    for (let step = 0; step < 6; step++) {
      const wheel = new layout.window.WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 * Math.log(1.2), ...pointer });
      viewer.element.dispatchEvent(wheel);
      assert.ok(wheel.defaultPrevented);
      await layout.idle(20);
    }
    assert.match(pages.style.transform, /scale\(2\.98/u);
    assert.equal(layout.scaleWrites(), writes);
    await layout.idle(250);
    assert.equal(pages.style.transform, "");
    assert.ok(Math.abs(viewer.zoom - 1.2 ** 6) < 1e-6, `zoom ${viewer.zoom}`);
    assert.equal(layout.scaleWrites() - writes, 1);
    const after = pointOnPage(viewer, pointer)!;
    assert.ok(after.page === under.page && Math.abs(after.y - under.y) < 0.01 && Math.abs(after.x - under.x) < 0.01);
    // Pinching on past the largest zoom holds there, and turning back zooms out at once.
    for (const delta of [-400, -400, -400, 40]) {
      viewer.element.dispatchEvent(new layout.window.WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: delta / 4, ...pointer }));
    }
    await layout.idle(250);
    assert.ok(viewer.zoom < 4 && viewer.zoom > 3.5, `zoom ${viewer.zoom}`);
  } finally {
    viewer.destroy();
    engine.close();
  }
});

test("past a whole page's pixel cap, the part on screen is drawn sharp over it, and a stale tile is stopped", async () => {
  const layout = fakeLayout();
  const { engine, renders } = heldEngine(10);
  const viewer = createViewer({ container: layout.container, engine, source: "held.pdf" });
  const settleAll = () => {
    for (const render of renders) {
      render.resolve();
    }
  };
  try {
    await viewer.ready;
    await layout.until(() => renders.length > 0, "the first paint");
    settleAll();
    const zoomed = renders.length;
    viewer.setZoom(4);
    // The part on screen first, at once, and nothing else: the whole pages wait until it has landed.
    await layout.until(() => renders.some((render) => render.region), "a tile");
    assert.deepEqual(
      renders.slice(zoomed).map((render) => Boolean(render.region)),
      [true],
      "the tile is asked for before the whole page is drawn again"
    );
    const sharp = 2 * viewer.scale;
    const capped = outputScale({ devicePixelRatio: 2, displayScale: viewer.scale, pageArea: 612 * 792 });
    assert.ok(capped * 1.5 < sharp, "fixture check: the whole page is soft at this zoom");
    const tile = renders.find((render) => render.region)!;
    assert.equal(tile.page, 1);
    assert.equal(tile.width, Math.round(612 * sharp), "the page's width at the screen's density");
    // Just the part on screen, in points: no margin, which would only make it later.
    const region = tile.region!;
    const box = viewer.pageElement(1)!.getBoundingClientRect();
    const seen = { x: -box.left / viewer.scale, y: -box.top / viewer.scale, width: 800 / viewer.scale, height: 600 / viewer.scale };
    assert.ok(seen.x > 0 && seen.y > 0, "fixture check: the zoom kept the middle of the page in view");
    for (const key of ["x", "y", "width", "height"] as const) {
      assert.ok(Math.abs(region[key] - seen[key]) < 0.5, JSON.stringify({ region, seen }));
    }
    await layout.idle(400);
    assert.ok(!renders.some((render) => !render.region && render.width > 2000), "no whole page while the tile is out");
    settleAll();
    const page = viewer.pageElement(1)!;
    await layout.until(() => page.querySelector(".recto-tile") !== null, "the tile on screen");
    const shown = page.querySelector<HTMLCanvasElement>(".recto-tile")!;
    // Over the whole-page bitmap, under the text, at two device pixels a CSS pixel.
    assert.equal(shown.previousElementSibling, page.querySelector("canvas:not(.recto-tile)"));
    const cssWidth = (Number.parseFloat(shown.style.width) / 100) * page.getBoundingClientRect().width;
    assert.ok(Math.abs(shown.width / cssWidth - 2) < 0.02, `${shown.width} px over ${cssWidth} CSS px`);
    // Then the whole pages again, at the cap.
    await layout.until(() => renders.some((render) => !render.region && render.width > 2000), "the repaint at 400%");
    settleAll();
    // Scroll down the page: a new tile is asked for, with a margin now; scroll on before it lands and it's stopped.
    const asked = () => renders.filter((render) => render.region);
    viewer.element.scrollTop += 900;
    await layout.until(() => asked().length === 2, "a tile for the new part");
    const margined = asked()[1]!.region!;
    assert.ok(margined.width * viewer.scale > 800 + 128 && margined.width * viewer.scale <= 800 + 2 * 128 + 1, JSON.stringify(margined));
    viewer.element.scrollTop += 900;
    await layout.idle(20);
    assert.ok(asked()[1]!.cancelled, "the tile for a part scrolled past is stopped");
    await layout.until(() => asked().length === 3, "a tile for where the reader stopped");
    // The old tile shows until the new one lands.
    assert.equal(page.querySelector(".recto-tile"), shown);
    // Zoomed back out, the whole page is sharp enough: no tile.
    viewer.setZoom(1);
    await layout.idle(400);
    settleAll();
    await layout.idle(400);
    assert.ok(asked()[2]!.cancelled, "a tile at the old zoom is stopped");
    assert.equal(layout.container.querySelectorAll(".recto-tile").length, 0);
  } finally {
    viewer.destroy();
  }
});
