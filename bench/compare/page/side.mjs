// One side of the comparison, in a frame of its own so each run starts with nothing loaded: recto's
// viewer or pdf.js's stock viewer components, behind one small interface the page drives.
//
// Times are absolute (`performance.timeOrigin + performance.now()`), so the page can subtract the
// moment it created this frame. Every file this frame asks for is under its own path on the server,
// which counts the bytes.
const params = new URLSearchParams(location.search);
const kind = location.pathname.split("/").at(-2);
const docUrl = new URL(`./doc/${encodeURI(params.get("doc"))}`, location.href).href;
const now = () => performance.timeOrigin + performance.now();
const view = document.getElementById("view");
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

// Main-thread tasks over 50 ms, from the start.
const longTasks = [];
if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push({ start: performance.timeOrigin + entry.startTime, ms: entry.duration });
  }).observe({ type: "longtask", buffered: true });
}

const events = { firstPaintAt: null, openAt: null, error: null };
let resolveOpen;
let rejectOpen;
const opened = new Promise((resolve, reject) => {
  resolveOpen = resolve;
  rejectOpen = reject;
});
const fail = (error) => {
  events.error = String(error?.message ?? error);
  rejectOpen(error);
};
const firstPaint = () => {
  events.firstPaintAt ??= now();
};

// The width that fits a page, as recto computes it: both sides start at the same scale.
const GAP = 12;
const fitFor = (scroller, pageWidth) => (scroller.clientWidth - 2 * GAP) / pageWidth;

/** What each side has to say for itself. */
let adapter;

if (kind === "recto") {
  const { createViewer } = await import("./recto/dist/viewer/index.js");
  const viewer = createViewer({ container: view, source: docUrl, onRender: firstPaint, onError: (error, info) => info.stage === "open" && fail(error) });
  viewer.ready.then(() => {
    events.openAt = now();
    resolveOpen();
  }, fail);
  adapter = {
    viewer,
    get scroller() {
      return viewer.element;
    },
    pageSelector: ".recto-page",
    pageCount: () => viewer.pageCount,
    currentPage: () => viewer.page,
    /** CSS pixels per point. */
    scale: () => viewer.scale,
    fit: () => viewer.scale / viewer.zoom,
    setScale: (scale) => viewer.setZoom(scale / adapter.fit()),
    shown: (canvas) => canvas.width > 0,
    busy: () => false,
    onScale: (callback) => viewer.addEventListener("zoomchange", () => callback(viewer.scale)),
    async find(word) {
      const hits = await viewer.find(word);
      const after = hits.findIndex((hit) => hit.page >= viewer.page);
      const active = after < 0 ? 0 : after;
      viewer.setHighlights(hits.map((hit, i) => ({ page: hit.page, boxes: hit.boxes, active: i === active })));
      if (hits[active]) viewer.scrollToBox(hits[active].page, hits[active].boxes[0]);
      return hits.length;
    },
  };
} else {
  const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "./pdfjs/web/pdf_viewer.css" });
  const cssLoaded = new Promise((resolve) => css.addEventListener("load", resolve, { once: true }));
  document.head.append(css);
  const pdfjsLib = await import("./pdfjs/build/pdf.min.mjs");
  globalThis.pdfjsLib = pdfjsLib;
  const { EventBus, PDFFindController, PDFLinkService, PDFViewer } = await import("./pdfjs/web/pdf_viewer.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/build/pdf.worker.min.mjs", location.href).href;
  view.className = "pdfjs";
  const inner = Object.assign(document.createElement("div"), { className: "pdfViewer" });
  view.append(inner);
  await cssLoaded;
  // The setup of pdf.js's own components example: an event bus, a link service, a find controller.
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });
  const viewer = new PDFViewer({ container: view, viewer: inner, eventBus, linkService, findController });
  linkService.setViewer(viewer);
  eventBus.on("pagerendered", firstPaint);
  let firstWidth = 612;
  eventBus.on("pagesinit", () => {
    viewer.currentScale = fitFor(view, firstWidth) / (96 / 72);
    // Once the pages are in, a scrollbar may have taken some of the width, as it does on recto's side.
    requestAnimationFrame(() => {
      const fit = fitFor(view, firstWidth) / (96 / 72);
      if (Math.abs(fit - viewer.currentScale) > 1e-4) viewer.currentScale = fit;
    });
  });
  const asset = (dir) => new URL(`./pdfjs/${dir}/`, location.href).href;
  // Its defaults otherwise: a worker, range requests and streaming on, auto-fetch on.
  const task = pdfjsLib.getDocument({ url: docUrl, cMapUrl: asset("cmaps"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts"), wasmUrl: asset("wasm"), iccUrl: asset("iccs") });
  task.promise.then(async (pdf) => {
    const page = await pdf.getPage(1);
    firstWidth = page.view[2] - page.view[0];
    viewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
    await new Promise((resolve) => (viewer.pagesCount ? resolve() : eventBus.on("pagesinit", resolve, { once: true })));
    events.openAt = now();
    resolveOpen();
  }, fail);
  adapter = {
    viewer,
    scroller: view,
    pageSelector: ".page",
    pageCount: () => viewer.pagesCount,
    currentPage: () => viewer.currentPageNumber,
    scale: () => viewer.currentScale * (96 / 72),
    fit: () => fitFor(view, firstWidth),
    setScale(scale) {
      const rect = view.getBoundingClientRect();
      viewer.updateScale({ scaleFactor: scale / adapter.scale(), origin: [rect.left + view.clientWidth / 2, rect.top + view.clientHeight / 2] });
    },
    shown: (canvas) => canvas.width > 0 && !canvas.hidden,
    // A page whose render is under way or paused (its canvas may already show part of the new one).
    busy: () => viewer._getVisiblePages().views.some(({ view: page }) => [1, 2].includes(page.renderingState) || [1, 2].includes(page.detailView?.renderingState)),
    onScale: (callback) => eventBus.on("scalechanging", ({ scale }) => callback(scale * (96 / 72))),
    find(word) {
      return new Promise((resolve) => {
        const count = () => {
          const matches = findController.pageMatches;
          let total = 0;
          for (let i = 0; i < viewer.pagesCount; i++) {
            if (!matches[i]) return;
            total += matches[i].length;
          }
          eventBus.off("updatefindmatchescount", count);
          eventBus.off("updatefindcontrolstate", count);
          resolve(total);
        };
        eventBus.on("updatefindmatchescount", count);
        eventBus.on("updatefindcontrolstate", count);
        eventBus.dispatch("find", { source: null, type: "", query: word, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false });
      });
    },
  };
}

const target = Math.min(2, devicePixelRatio || 1);

/** Pages near the current one, with their rects. */
function pagesInView() {
  const scroller = adapter.scroller;
  const box = scroller.getBoundingClientRect();
  const viewport = { left: box.left, top: box.top, right: box.left + scroller.clientWidth, bottom: box.top + scroller.clientHeight };
  const elements = scroller.querySelectorAll(adapter.pageSelector);
  const current = adapter.currentPage();
  const out = [];
  for (let n = Math.max(1, current - 4); n <= Math.min(elements.length, current + 4); n++) {
    const rect = elements[n - 1].getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right) out.push({ n, element: elements[n - 1], rect });
  }
  return { viewport, pages: out };
}

/**
 * How sharp the screen is: at a grid of points over the pages, the densest canvas drawn there,
 * as a share of the screen's density. 1 means every visible part of every page is sharp.
 */
function sharpness() {
  const { viewport, pages } = pagesInView();
  if (pages.length === 0) return 0;
  const canvases = pages.map(({ element }) => [...element.querySelectorAll("canvas")].filter(adapter.shown).map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() })));
  let worst = Infinity;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const x = viewport.left + ((i + 0.5) / 6) * (viewport.right - viewport.left);
      const y = viewport.top + ((j + 0.5) / 6) * (viewport.bottom - viewport.top);
      const at = pages.findIndex(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
      if (at < 0) continue;
      let best = 0;
      for (const { canvas, rect } of canvases[at]) {
        if (rect.width > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) best = Math.max(best, canvas.width / rect.width);
      }
      worst = Math.min(worst, best / target);
    }
  }
  return worst === Infinity ? 0 : worst;
}

/**
 * The moment every visible part of the screen is drawn at the screen's density, checked each frame;
 * if it never gets there, when it last improved, and how close it got.
 */
async function untilSharp({ timeoutMs = 60_000, giveUpAfterMs = 4000 } = {}) {
  const started = now();
  let best = 0;
  let bestAt = started;
  for (;;) {
    await frame();
    const sharp = adapter.busy() ? Math.min(0.99, sharpness()) : sharpness();
    if (sharp >= 0.97) return { at: now(), density: Math.round(Math.min(1, sharp) * 100) / 100 };
    if (sharp > best + 0.005) {
      best = sharp;
      bestAt = now();
    }
    if (now() - started > timeoutMs || (best > 0 && now() - bestAt > giveUpAfterMs && !adapter.busy())) {
      return { at: bestAt, density: Math.round(best * 100) / 100, capped: true };
    }
  }
}

/** Where a page's top is, in the scroller's own coordinates. */
function pageTop(n) {
  const scroller = adapter.scroller;
  const element = scroller.querySelectorAll(adapter.pageSelector)[n - 1];
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/** The page at the middle of the screen, and how far down and across it the middle is. */
function position() {
  const { pages } = pagesInView();
  const scroller = adapter.scroller;
  const box = scroller.getBoundingClientRect();
  const cx = box.left + scroller.clientWidth / 2;
  const cy = box.top + scroller.clientHeight / 2;
  const hit = pages.find(({ rect }) => cy >= rect.top && cy <= rect.bottom) ?? pages[0];
  if (!hit) return null;
  return { page: hit.n, y: (cy - hit.rect.top) / hit.rect.height, x: (cx - hit.rect.left) / hit.rect.width };
}

function setPosition({ page, x, y }) {
  const scroller = adapter.scroller;
  const element = scroller.querySelectorAll(adapter.pageSelector)[page - 1];
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  scroller.scrollTop += rect.top + y * rect.height - (box.top + scroller.clientHeight / 2);
  scroller.scrollLeft += rect.left + x * rect.width - (box.left + scroller.clientWidth / 2);
}

/** Scrolls to a page's top over `ms`, eased, a frame at a time; the frames and long tasks on the way. */
async function scrollToPage(n, ms) {
  const scroller = adapter.scroller;
  const from = scroller.scrollTop;
  const to = Math.min(pageTop(n) - GAP, scroller.scrollHeight - scroller.clientHeight);
  const started = now();
  const frames = [];
  let last = performance.now();
  for (;;) {
    await frame();
    const t = Math.min(1, (now() - started) / ms);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    scroller.scrollTop = from + (to - from) * eased;
    frames.push(performance.now() - last);
    last = performance.now();
    if (t >= 1) break;
  }
  const ended = now();
  const sorted = frames.slice(1).sort((a, b) => a - b);
  return {
    started,
    ended,
    p95FrameMs: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10,
    droppedFrames: sorted.filter((frameMs) => frameMs > 25).length,
  };
}

/** The long tasks that started between two moments; they're reported a little late, so ask after. */
function longTasksBetween(started, ended) {
  const during = longTasks.filter((task) => task.start >= started && task.start < ended);
  return { longTasks: during.length, longTaskMs: Math.round(during.reduce((sum, task) => sum + task.ms, 0)) };
}

/** The canvases each side holds, in megabytes of pixels. */
function canvasMB() {
  let pixels = 0;
  for (const canvas of document.querySelectorAll("canvas")) pixels += canvas.width * canvas.height;
  return Math.round((pixels * 4) / 1e5) / 10;
}

window.side = {
  kind,
  events,
  opened,
  adapter,
  longTasks,
  untilSharp,
  sharpness,
  position,
  setPosition,
  scrollToPage,
  longTasksBetween,
  canvasMB,
  pageCount: () => adapter.pageCount(),
  scale: () => adapter.scale(),
  fit: () => adapter.fit(),
  setScale: (scale) => adapter.setScale(scale),
  onScale: (callback) => adapter.onScale(callback),
  async find(word) {
    const started = now();
    const hits = await adapter.find(word);
    return { ms: now() - started, hits };
  },
};
window.dispatchEvent(new Event("side-ready"));
window.parent?.postMessage({ type: "side-ready", kind }, location.origin);
