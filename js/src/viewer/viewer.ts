// A PDF viewer in plain DOM: pages stacked in a scrolling element, each a placeholder sized in points
// until it nears the screen, then drawn by a worker, with a transparent text layer for selection, its
// links, and a layer for highlights. No framework; a React or Vue component is a ref and an effect.
//
// Layout: every page is one element sized `--w` x `--h` points times `--recto-scale`, so a zoom is one
// style write. The canvas fills its page, so a zoom shows the old bitmap scaled at once, and the sharp
// one replaces it once the layout has been still for a moment and the worker has drawn it.
//
// Painting: only pages within a couple of screens of the reader are drawn, nearest first, two at a
// time. A page that leaves that band has its render cancelled; a render superseded by a newer one never
// lands. Painted pages are held to a pixel budget: the oldest off-screen ones shrink to a thumbnail.

import type { PdfBox } from "../document.ts";
import {
  type DocumentLease,
  isAbort,
  sharedViewerEngine,
  type ViewerBitmap,
  type ViewerDocument,
  type ViewerEngine,
} from "./client.ts";
import { installViewerCss } from "./css.ts";
import { attachZoomGestures } from "./gestures.ts";
import { clampZoom, exceedsCanvasBudget, fitScale, outputScale, pageAt, pixelCost, stepZoom } from "./layout.ts";
import { createPaintQueue, type PaintQueueRecord } from "./paint-queue.ts";
import type { ViewerOpenTiming, ViewerSource } from "./protocol.ts";
import { buildTextLayer } from "./text-layer.ts";

/** A URL (relative to the page), the file's bytes, or a Blob such as a dropped File. */
export type ViewerInput = string | URL | ArrayBuffer | Uint8Array | Blob;

export type ViewerOpenInfo = {
  pageCount: number;
  /** Read by range rather than whole. */
  ranged: boolean;
  /** Where the worker's time went: waiting for the engine, the fetch and the parse. */
  timing: ViewerOpenTiming;
  /** From `createViewer` to the document being open, in ms. */
  ms: number;
};

export type ViewerRenderInfo = {
  page: number;
  /** From asking the worker to the bitmap being on screen, in ms. */
  ms: number;
  /** The bitmap's size in device pixels. */
  width: number;
  height: number;
};

export type ViewerErrorInfo = { stage: "open" | "render" | "text" | "find"; page?: number };

export type ViewerOptions = {
  /** The element to fill. The viewer scrolls inside it, so give it a height. */
  container: HTMLElement;
  source: ViewerInput;
  /** Read a URL with this on the page instead, whole (for headers, or a custom transport). */
  fetch?: (url: string) => Promise<Response>;
  /** Sent with the worker's requests for a URL. Default: the browser's ("same-origin"). */
  credentials?: RequestCredentials;
  /** The engine and workers to use. Default: one shared by every viewer on the page. */
  engine?: ViewerEngine;
  /** 1 fits the first page's width to the viewer; 2 is twice that. Default 1. */
  zoom?: number;
  /** The page to open at. Default 1. */
  page?: number;
  /** Space between pages and around them, in CSS pixels. Default 12. */
  gap?: number;
  /** A selectable text layer over each page. Default true. */
  textLayer?: boolean;
  /** Clickable links over each page (needs the text layer). Default true. */
  links?: boolean;
  /** Pinch, ctrl + wheel and ⌘/Ctrl + plus, minus, 0 zoom the document. Default true. */
  gestures?: boolean;
  /** The scrolling element's accessible name. Default "PDF document". */
  label?: string;
  /** Default: the window's. */
  devicePixelRatio?: () => number;
  onOpen?: (info: ViewerOpenInfo) => void;
  onRender?: (info: ViewerRenderInfo) => void;
  onError?: (error: unknown, info: ViewerErrorInfo) => void;
};

/** A search hit: the page (from 1), where it starts in that page's text, and its boxes in points (y down), one a line. */
export type FindMatch = { page: number; index: number; boxes: PdfBox[] };

export type Highlight = { page: number; boxes: readonly PdfBox[]; active?: boolean };

export type FindOptions = {
  caseSensitive?: boolean;
  signal?: AbortSignal;
  /** Every match found so far, in page order, as pages are searched (from the current page on). */
  onProgress?: (matches: FindMatch[], pagesSearched: number) => void;
};

export interface ViewerEventMap {
  /** The document is open: `detail` is a `ViewerOpenInfo`. */
  open: CustomEvent<ViewerOpenInfo>;
  /** The page most of the screen shows changed: `detail.page`. */
  pagechange: CustomEvent<{ page: number }>;
  /** `detail.zoom` and `detail.scale`, CSS pixels per point. */
  zoomchange: CustomEvent<{ zoom: number; scale: number }>;
  /** `detail.error`, and the stage and page it happened at. */
  error: CustomEvent<ViewerErrorInfo & { error: unknown }>;
}

export interface Viewer extends EventTarget {
  /** Settles once the document is open and laid out; rejects if it can't be opened. */
  readonly ready: Promise<void>;
  /** "loading", "ready" or "error"; also the scrolling element's `data-state`. */
  readonly state: "loading" | "ready" | "error";
  /** 0 until open. */
  readonly pageCount: number;
  /** The page most of the screen shows, from 1. */
  readonly page: number;
  readonly zoom: number;
  /** CSS pixels per point at the current zoom. */
  readonly scale: number;
  /** The scrolling element the viewer made inside its container. */
  readonly element: HTMLElement;
  /** The open document, for calls the viewer doesn't make itself; null until open. */
  readonly document: ViewerDocument | null;
  goToPage(page: number, options?: { x?: number | null; y?: number | null; behavior?: ScrollBehavior }): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  /** Zooms, keeping the point under `anchor` (client coordinates) still; the screen's middle by default. */
  setZoom(zoom: number, anchor?: { clientX: number; clientY: number }): void;
  zoomIn(): void;
  zoomOut(): void;
  /** Zoom 1: the first page's width fits the viewer. */
  fitWidth(): void;
  /** Searches every page's text in the worker. Whitespace in `query` matches any break. */
  find(query: string, options?: FindOptions): Promise<FindMatch[]>;
  /** Draws these boxes over their pages, replacing what was drawn. */
  setHighlights(highlights: readonly Highlight[]): void;
  /** Scrolls so `box` (points, y down) on `page` is in the middle of the screen. */
  scrollToBox(page: number, box: PdfBox, options?: { behavior?: ScrollBehavior }): Promise<void>;
  /** The element a page is laid out in. */
  pageElement(page: number): HTMLElement | null;
  /** Stops everything, lets go of the document and removes what the viewer added. */
  destroy(): void;
  addEventListener<K extends keyof ViewerEventMap>(type: K, listener: (event: ViewerEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof ViewerEventMap>(type: K, listener: (event: ViewerEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
}

type PageRecord = PaintQueueRecord & {
  element: HTMLElement;
  canvas: HTMLCanvasElement | null;
  textEl: HTMLElement | null;
  highlightEl: HTMLElement | null;
  /** What its highlight layer shows, to skip drawing it again. */
  highlightKey: string;
  /** In points; page 1's until this page's own size is read. */
  width: number;
  height: number;
  sized: Promise<void> | null;
  /** Inside the prefetch band. A page there is never evicted: it would only repaint at once, a loop. */
  near: boolean;
  /** The output scale a render is in flight for, or 0. */
  pendingOutputScale: number;
  /** Bumped by every render; a render that finds it changed was superseded and must not land. */
  renderToken: number;
};

// Start drawing at least two screens ahead of the reader: a fixed margin shorter than a page exposed
// placeholders in ordinary scrolling.
const MIN_PREFETCH_MARGIN_PX = 1200;
const PREFETCH_SCREENS = 2;
// Repaint for a new zoom only once the bitmap held is meaningfully off the size shown: without a
// deadband, the sub-percent jitter of a resize would repaint every page.
const RASTER_REFRESH_THRESHOLD = 1.15;
// Wait for the layout to stop moving before repainting at the new density: a pinch or a pane drag
// crosses the threshold several times, and each crossing would draw a generation thrown away.
const RASTER_REFRESH_QUIET_MS = 180;
// An evicted page keeps a bitmap this wide, so scrolling back shows a blur, not a blank.
const EVICTED_CANVAS_MAX_WIDTH_PX = 160;
const DEFAULT_GAP_PX = 12;

function resolveSource(input: ViewerInput, credentials: RequestCredentials | undefined): ViewerSource | Promise<ViewerSource> {
  if (typeof input === "string" || input instanceof URL) {
    const url = String(input);
    return credentials ? { kind: "url", url, credentials } : { kind: "url", url };
  }
  if (input instanceof ArrayBuffer) {
    return { kind: "bytes", bytes: input };
  }
  if (ArrayBuffer.isView(input)) {
    return { kind: "bytes", bytes: input.slice().buffer };
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return input.arrayBuffer().then((bytes) => ({ kind: "bytes", bytes }));
  }
  throw new TypeError("source must be a URL, an ArrayBuffer, a Uint8Array or a Blob");
}

/** Shrinks a canvas's bitmap in place to a thumbnail, keeping the element its page holds. */
function reduceCanvas(canvas: HTMLCanvasElement): void {
  if (canvas.width <= EVICTED_CANVAS_MAX_WIDTH_PX) {
    return;
  }
  const shrink = EVICTED_CANVAS_MAX_WIDTH_PX / canvas.width;
  const preview = canvas.ownerDocument.createElement("canvas");
  preview.width = Math.max(1, Math.round(canvas.width * shrink));
  preview.height = Math.max(1, Math.round(canvas.height * shrink));
  const previewContext = preview.getContext("2d");
  const context = canvas.getContext("2d");
  if (!previewContext || !context) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }
  previewContext.drawImage(canvas, 0, 0, preview.width, preview.height);
  canvas.width = preview.width;
  canvas.height = preview.height;
  context.drawImage(preview, 0, 0);
}

class PdfViewer extends EventTarget implements Viewer {
  readonly ready: Promise<void>;
  readonly element: HTMLElement;
  #state: Viewer["state"] = "loading";
  readonly #options: ViewerOptions;
  readonly #container: HTMLElement;
  readonly #pages: HTMLElement;
  readonly #engine: ViewerEngine;
  readonly #gap: number;
  readonly #started = performance.now();
  #lease: DocumentLease | null = null;
  #doc: ViewerDocument | null = null;
  #records: PageRecord[] = [];
  readonly #recordByElement = new Map<Element, PageRecord>();
  // Painted pages, oldest first, held to the pixel budget.
  readonly #live: PageRecord[] = [];
  #zoom: number;
  #fit = 1;
  #appliedScale = 0;
  #page = 1;
  #destroyed = false;
  #contentWidth: number | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #scrollFrame = 0;
  #resizeFrame = 0;
  #programmaticTop: number | null = null;
  #highlights = new Map<PageRecord, Highlight[]>();
  #findController: AbortController | null = null;
  #queue: ReturnType<typeof createPaintQueue<PageRecord>> | null = null;
  readonly #cleanups: (() => void)[] = [];

  constructor(options: ViewerOptions) {
    super();
    if (!options?.container) {
      throw new TypeError("createViewer needs a container element");
    }
    this.#options = options;
    this.#container = options.container;
    this.#engine = options.engine ?? sharedViewerEngine();
    this.#gap = Math.max(0, options.gap ?? DEFAULT_GAP_PX);
    this.#zoom = clampZoom(options.zoom ?? 1);
    const document = this.#container.ownerDocument;
    installViewerCss(this.#container);
    const scroller = document.createElement("div");
    scroller.className = "recto-viewer";
    scroller.tabIndex = 0;
    scroller.setAttribute("role", "region");
    scroller.setAttribute("aria-label", options.label ?? "PDF document");
    scroller.setAttribute("aria-busy", "true");
    scroller.dataset.state = "loading";
    scroller.style.setProperty("--recto-gap", `${this.#gap}px`);
    this.#pages = document.createElement("div");
    this.#pages.className = "recto-pages";
    scroller.append(this.#pages);
    this.#container.append(scroller);
    this.element = scroller;
    this.ready = this.#open();
    // Nobody has to await it: a failure is also an `error` event.
    this.ready.catch(() => {});
  }

  get state() {
    return this.#state;
  }
  get pageCount() {
    return this.#doc?.pageCount ?? 0;
  }
  get page() {
    return this.#page;
  }
  get zoom() {
    return this.#zoom;
  }
  get scale() {
    return this.#fit * this.#zoom;
  }
  get document() {
    return this.#doc;
  }

  #setState(state: Viewer["state"]) {
    this.#state = state;
    this.element.dataset.state = state;
    this.element.setAttribute("aria-busy", String(state === "loading"));
  }

  #report(error: unknown, info: ViewerErrorInfo) {
    if (this.#destroyed || isAbort(error)) {
      return;
    }
    this.#options.onError?.(error, info);
    this.dispatchEvent(new CustomEvent("error", { detail: { ...info, error } }));
  }

  #view() {
    return this.#container.ownerDocument.defaultView;
  }

  #frame(callback: () => void): number {
    const view = this.#view();
    return view?.requestAnimationFrame ? view.requestAnimationFrame(callback) : (setTimeout(callback, 16) as unknown as number);
  }

  #cancelFrame(id: number) {
    const view = this.#view();
    if (view?.cancelAnimationFrame) {
      view.cancelAnimationFrame(id);
    } else {
      clearTimeout(id);
    }
  }

  async #open(): Promise<void> {
    try {
      const { fetch: fetchFile, credentials } = this.#options;
      let source = await resolveSource(this.#options.source, credentials);
      if (fetchFile && source.kind === "url") {
        const response = await fetchFile(source.url);
        if (!response.ok) {
          throw Object.assign(new Error(`the PDF could not be read (HTTP ${response.status})`), { name: "PdfError", code: "fetch-failed" });
        }
        source = { kind: "bytes", bytes: await response.arrayBuffer() };
      }
      if (this.#destroyed) {
        return;
      }
      this.#lease = this.#engine.open(source);
      const doc = await this.#lease.promise;
      if (this.#destroyed) {
        return;
      }
      const first = await doc.pageInfo(1);
      if (this.#destroyed) {
        return;
      }
      this.#doc = doc;
      this.#layout(first.width, first.height);
      this.#setState("ready");
      const info: ViewerOpenInfo = {
        ms: Math.round(performance.now() - this.#started),
        pageCount: doc.pageCount,
        ranged: doc.ranged,
        timing: doc.timing,
      };
      this.#options.onOpen?.(info);
      this.dispatchEvent(new CustomEvent("open", { detail: info }));
      const start = this.#options.page;
      if (start !== undefined && start > 1) {
        await this.#goTo(start, {});
      }
    } catch (error) {
      if (this.#destroyed) {
        return;
      }
      this.#setState("error");
      this.#report(error, { stage: "open" });
      throw error;
    }
  }

  #layout(width: number, height: number) {
    const doc = this.#doc!;
    const scroller = this.element;
    const document = scroller.ownerDocument;
    this.#updateFit(width);
    this.#appliedScale = this.scale;
    scroller.style.setProperty("--recto-scale", String(this.scale));

    const queue = createPaintQueue<PageRecord>({
      isStopped: () => this.#destroyed,
      paintCanvas: (record) => this.#paintCanvas(record),
      paintText: (record) => this.#paintText(record),
    });
    this.#queue = queue;
    const IntersectionObserverImpl = this.#view()?.IntersectionObserver ?? globalThis.IntersectionObserver;
    // Which pages are on screen, so the queue paints outward from them; computed off the layout path.
    const screen = new IntersectionObserverImpl(
      (entries) => {
        for (const entry of entries) {
          const record = this.#recordByElement.get(entry.target);
          if (record) {
            queue.setOnScreen(record, entry.isIntersecting);
          }
        }
        queue.pump();
      },
      { root: scroller }
    );
    const near = new IntersectionObserverImpl(
      (entries) => {
        for (const entry of entries) {
          const record = this.#recordByElement.get(entry.target);
          if (record) {
            record.near = entry.isIntersecting;
            if (this.#highlights.has(record)) {
              this.#paintHighlights(record);
            }
            queue.setNearViewport(record, entry.isIntersecting);
          }
        }
        queue.pump();
      },
      { root: scroller, rootMargin: `${Math.max(MIN_PREFETCH_MARGIN_PX, scroller.clientHeight * PREFETCH_SCREENS)}px 0px` }
    );
    this.#cleanups.push(() => {
      screen.disconnect();
      near.disconnect();
    });

    // Every placeholder is sized from page 1: reading every page's size first would cost a request per
    // page on a file read by range. A page's own size replaces it when the page nears the screen.
    const fragment = document.createDocumentFragment();
    for (let pageNumber = 1; pageNumber <= doc.pageCount; pageNumber++) {
      const element = document.createElement("div");
      element.className = "recto-page";
      element.dataset.pageNumber = String(pageNumber);
      element.setAttribute("role", "group");
      element.setAttribute("aria-label", `Page ${pageNumber} of ${doc.pageCount}`);
      element.style.setProperty("--w", String(width));
      element.style.setProperty("--h", String(height));
      const record: PageRecord = {
        canvas: null,
        canvasRendered: false,
        element,
        failures: 0,
        height,
        highlightEl: null,
        highlightKey: "",
        near: false,
        outputScale: 0,
        pageNumber,
        pendingOutputScale: 0,
        renderTask: null,
        renderToken: 0,
        sized: pageNumber === 1 ? Promise.resolve() : null,
        textEl: null,
        textRendered: this.#options.textLayer === false,
        textTask: null,
        width,
      };
      this.#records.push(record);
      this.#recordByElement.set(element, record);
      fragment.append(element);
    }
    this.#pages.append(fragment);
    for (const record of this.#records) {
      screen.observe(record.element);
      near.observe(record.element);
    }

    const ResizeObserverImpl = this.#view()?.ResizeObserver ?? globalThis.ResizeObserver;
    if (ResizeObserverImpl) {
      const resize = new ResizeObserverImpl((entries) => {
        const entry = entries.at(-1);
        if (entry) {
          this.#contentWidth = entry.contentRect.width;
        }
        this.#cancelFrame(this.#resizeFrame);
        this.#resizeFrame = this.#frame(() => {
          // A resize rescales every page: keep the reader on the same part of the document.
          this.#keepAnchor(() => this.#applyScale());
        });
      });
      resize.observe(scroller);
      this.#cleanups.push(() => resize.disconnect());
    }

    const onScroll = () => {
      this.#cancelFrame(this.#scrollFrame);
      this.#scrollFrame = this.#frame(() => this.#trackPage());
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const onClick = (event: MouseEvent) => this.#followLink(event);
    scroller.addEventListener("click", onClick);
    const onKey = (event: KeyboardEvent) => this.#onKey(event);
    scroller.addEventListener("keydown", onKey);
    this.#cleanups.push(() => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("click", onClick);
      scroller.removeEventListener("keydown", onKey);
    });
    if (this.#options.gestures !== false) {
      this.#cleanups.push(
        attachZoomGestures(scroller, {
          onReset: () => this.fitWidth(),
          onStep: (direction) => this.setZoom(stepZoom(this.#zoom, direction)),
          onZoomBy: (factor, anchor) => this.setZoom(this.#zoom * factor, anchor),
        })
      );
    }
  }

  /** The width pages fit into: the scroller's content box less the gaps on either side. */
  #updateFit(firstPageWidth: number) {
    const available = this.#contentWidth ?? this.element.clientWidth;
    this.#fit = fitScale({ availableWidth: available, naturalWidth: firstPageWidth, sideInsetPx: 2 * this.#gap });
  }

  #applyScale() {
    const first = this.#records[0];
    if (!first) {
      return;
    }
    this.#updateFit(first.width);
    if (Math.abs(this.#appliedScale - this.scale) > 1e-9) {
      this.#appliedScale = this.scale;
      this.element.style.setProperty("--recto-scale", String(this.scale));
      this.#scheduleRefresh();
    }
  }

  /**
   * Runs `change` and scrolls so that the point under `anchor` (the screen's middle by default) stays
   * where it was: the same offset points somewhere else once every page is taller.
   */
  #keepAnchor(change: () => void, anchor?: { clientX: number; clientY: number }) {
    const scroller = this.element;
    const rect = scroller.getBoundingClientRect();
    const anchorY = anchor ? anchor.clientY - rect.top : scroller.clientHeight / 2;
    const anchorX = anchor ? anchor.clientX - rect.left : scroller.clientWidth / 2;
    const record = this.#records[this.#indexAt(rect.top + anchorY)];
    if (!record) {
      change();
      return;
    }
    const before = record.element.getBoundingClientRect();
    const fractionY = before.height > 0 ? (rect.top + anchorY - before.top) / before.height : 0;
    const fractionX = before.width > 0 ? (rect.left + anchorX - before.left) / before.width : 0;
    change();
    const after = record.element.getBoundingClientRect();
    const dy = after.top + fractionY * after.height - (rect.top + anchorY);
    const dx = after.left + fractionX * after.width - (rect.left + anchorX);
    if (Math.abs(dy) >= 0.5) {
      scroller.scrollTop += dy;
    }
    if (Math.abs(dx) >= 0.5) {
      scroller.scrollLeft += dx;
    }
  }

  /** The index of the page at `clientY`, or its nearest neighbour in a gap. */
  #indexAt(clientY: number): number {
    return pageAt({
      center: clientY,
      measure: (record: PageRecord) => {
        const box = record.element.getBoundingClientRect();
        return { bottom: box.bottom, top: box.top };
      },
      pages: this.#records,
    });
  }

  #trackPage() {
    const scroller = this.element;
    if (this.#programmaticTop !== null && Math.abs(scroller.scrollTop - this.#programmaticTop) < 2) {
      // Where goToPage put it: that page, even if it is too short to reach the middle of the screen.
      return;
    }
    this.#programmaticTop = null;
    const rect = scroller.getBoundingClientRect();
    this.#setPage(this.#indexAt(rect.top + scroller.clientHeight / 2) + 1);
  }

  #setPage(page: number) {
    if (page !== this.#page && page >= 1 && page <= this.pageCount) {
      this.#page = page;
      this.dispatchEvent(new CustomEvent("pagechange", { detail: { page } }));
    }
  }

  /** Reads a page's own size, and lays it out again if it isn't page 1's. */
  #ensureSized(record: PageRecord): Promise<void> {
    record.sized ??= this.#doc!.pageInfo(record.pageNumber).then(
      ({ width, height }) => {
        if (this.#destroyed || (Math.abs(width - record.width) < 0.01 && Math.abs(height - record.height) < 0.01)) {
          return;
        }
        const resize = () => {
          record.width = width;
          record.height = height;
          record.element.style.setProperty("--w", String(width));
          record.element.style.setProperty("--h", String(height));
        };
        // A page at or above the middle of the screen moves what the reader is looking at.
        if (record.pageNumber <= this.#page) {
          this.#keepAnchor(resize);
        } else {
          resize();
        }
      },
      (cause: unknown) => {
        record.sized = null;
        throw cause;
      }
    );
    return record.sized;
  }

  #outputScaleFor(record: PageRecord): number {
    const ratio = this.#options.devicePixelRatio?.() ?? this.#view()?.devicePixelRatio ?? 1;
    return outputScale({ devicePixelRatio: ratio, displayScale: this.scale, pageArea: record.width * record.height });
  }

  async #paintCanvas(record: PageRecord): Promise<boolean> {
    try {
      await this.#ensureSized(record);
    } catch (cause) {
      this.#report(cause, { page: record.pageNumber, stage: "render" });
      return isAbort(cause);
    }
    if (this.#destroyed || !record.near) {
      // Scrolled past while its size was read.
      return true;
    }
    return this.#render(record, this.#outputScaleFor(record));
  }

  /** Draws the page at `scale` device pixels a point. Resolves false if it failed. */
  async #render(record: PageRecord, scale: number): Promise<boolean> {
    const doc = this.#doc!;
    record.canvasRendered = true;
    record.renderToken += 1;
    const token = record.renderToken;
    record.pendingOutputScale = scale;
    // Whatever was drawing this page is obsolete: stop it rather than pay for a bitmap that won't land.
    record.renderTask?.cancel();
    const started = performance.now();
    const task = doc.render(record.pageNumber, { width: Math.max(1, Math.round(record.width * scale)) });
    record.renderTask = task;
    let bitmap: ViewerBitmap;
    try {
      bitmap = await task.promise;
    } catch (cause) {
      if (record.renderToken === token) {
        record.canvasRendered = false;
        record.renderTask = null;
        record.pendingOutputScale = 0;
      }
      if (isAbort(cause) || this.#destroyed) {
        return true;
      }
      this.#report(cause, { page: record.pageNumber, stage: "render" });
      return false;
    }
    if (record.renderToken !== token || this.#destroyed) {
      // A later render, for another zoom, owns this page now.
      return true;
    }
    record.renderTask = null;
    record.pendingOutputScale = 0;
    try {
      this.#draw(record, bitmap);
    } catch (cause) {
      record.canvasRendered = false;
      this.#report(cause, { page: record.pageNumber, stage: "render" });
      return false;
    }
    record.outputScale = scale;
    this.#options.onRender?.({ height: bitmap.height, ms: Math.round(performance.now() - started), page: record.pageNumber, width: bitmap.width });
    this.#noteRasterized(record);
    // A first paint that began before a zoom lands at the old density: reconcile once it does.
    this.#scheduleRefresh();
    return true;
  }

  /** Puts a bitmap on screen in a new canvas, swapped in whole: the old one shows until then. */
  #draw(record: PageRecord, bitmap: ViewerBitmap) {
    const canvas = record.element.ownerDocument.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.setAttribute("aria-hidden", "true");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("the browser gave no 2D context for a page's canvas");
    }
    const ImageDataImpl = this.#view()?.ImageData ?? globalThis.ImageData;
    context.putImageData(new ImageDataImpl(bitmap.rgba, bitmap.width, bitmap.height), 0, 0);
    if (record.canvas) {
      record.canvas.replaceWith(canvas);
    } else {
      record.element.prepend(canvas);
    }
    record.canvas = canvas;
    record.element.dataset.rendered = "true";
  }

  /** Holds the painted pages to the pixel budget, oldest and off-screen first. */
  #noteRasterized(record: PageRecord) {
    if (record.outputScale <= 0) {
      return;
    }
    const live = this.#live;
    const at = live.indexOf(record);
    if (at !== -1) {
      live.splice(at, 1);
    }
    live.push(record);
    const costOf = (candidate: PageRecord) => pixelCost({ outputScale: candidate.outputScale, pageArea: candidate.width * candidate.height });
    let livePixels = live.reduce((total, candidate) => total + costOf(candidate), 0);
    let liveCount = live.length;
    if (!exceedsCanvasBudget({ liveCount, livePixels })) {
      return;
    }
    const kept: PageRecord[] = [];
    for (const candidate of live) {
      // Never a page in the band (it would repaint at once, a loop), nor one whose repaint is in flight.
      const evictable = candidate !== record && !candidate.near && candidate.pendingOutputScale === 0;
      if (exceedsCanvasBudget({ liveCount, livePixels }) && evictable) {
        livePixels -= costOf(candidate);
        liveCount -= 1;
        this.#release(candidate);
        continue;
      }
      kept.push(candidate);
    }
    live.length = 0;
    live.push(...kept);
  }

  #release(record: PageRecord) {
    if (record.canvas) {
      reduceCanvas(record.canvas);
    }
    record.canvasRendered = false;
    record.outputScale = 0;
    delete record.element.dataset.rendered;
    if (record.textEl && this.#options.textLayer !== false) {
      record.textEl.replaceChildren();
      record.textRendered = false;
      record.textTask = null;
    }
  }

  #scheduleRefresh() {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => this.#refreshRaster(), RASTER_REFRESH_QUIET_MS);
  }

  /**
   * After a zoom, every painted page holds a bitmap drawn for another size. Pages near the screen are
   * drawn again in place (swapped in when ready, so they never blank); the rest are marked to be drawn
   * again when they come back.
   */
  #refreshRaster() {
    if (this.#destroyed) {
      return;
    }
    for (const record of [...this.#live]) {
      if (!record.canvasRendered) {
        continue;
      }
      const wanted = this.#outputScaleFor(record);
      // Against what is already on its way, not just what landed, or a drag restarts the same page.
      const current = record.pendingOutputScale || record.outputScale;
      if (current <= 0) {
        continue;
      }
      const ratio = wanted / current;
      // Two-sided: zooming back out reclaims the oversized bitmaps too.
      if (ratio <= RASTER_REFRESH_THRESHOLD && ratio >= 1 / RASTER_REFRESH_THRESHOLD) {
        continue;
      }
      if (record.near) {
        void this.#render(record, wanted).then((ok) => {
          if (!ok) {
            this.#queue?.pump();
          }
        });
      } else {
        record.canvasRendered = false;
      }
    }
    this.#queue?.pump();
  }

  async #paintText(record: PageRecord): Promise<boolean> {
    const doc = this.#doc!;
    record.textTask ??= (async () => {
      await this.#ensureSized(record);
      const { runs, links } = await doc.text(record.pageNumber);
      if (this.#destroyed) {
        return;
      }
      if (!record.textEl) {
        record.textEl = record.element.ownerDocument.createElement("div");
        record.textEl.className = "recto-text";
        record.element.append(record.textEl);
      }
      buildTextLayer({
        container: record.textEl,
        links: this.#options.links === false ? [] : links,
        pageHeight: record.height,
        runs,
        scale: 1,
      });
      record.textRendered = true;
    })();
    try {
      await record.textTask;
      return true;
    } catch (cause) {
      // Free the slot, so a later pass tries again.
      record.textTask = null;
      if (isAbort(cause)) {
        return true;
      }
      this.#report(cause, { page: record.pageNumber, stage: "text" });
      return false;
    }
  }

  #followLink(event: MouseEvent) {
    const target = event.target as Element | null;
    const link = target?.closest?.<HTMLElement>("a[data-dest-page]");
    if (!link) {
      return;
    }
    event.preventDefault();
    const point = (value: string | undefined) => (value === undefined ? null : Number(value));
    void this.goToPage(Number(link.dataset.destPage), { x: point(link.dataset.destX), y: point(link.dataset.destY) });
  }

  #onKey(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const scroller = this.element;
    // Left and right turn pages unless the page is wider than the screen, where they scroll it.
    const sideways = scroller.scrollWidth > scroller.clientWidth + 1;
    if (event.key === "ArrowRight" && !sideways) {
      event.preventDefault();
      void this.next();
    } else if (event.key === "ArrowLeft" && !sideways) {
      event.preventDefault();
      void this.previous();
    } else if (event.key === "Home" && !event.shiftKey) {
      event.preventDefault();
      void this.goToPage(1);
    } else if (event.key === "End" && !event.shiftKey) {
      event.preventDefault();
      void this.goToPage(this.pageCount);
    }
  }

  async goToPage(page: number, options: { x?: number | null; y?: number | null; behavior?: ScrollBehavior } = {}): Promise<void> {
    await this.ready.catch(() => {});
    await this.#goTo(page, options);
  }

  async #goTo(page: number, options: { x?: number | null; y?: number | null; behavior?: ScrollBehavior }): Promise<void> {
    const record = this.#records[Math.min(this.pageCount, Math.max(1, Math.round(page))) - 1];
    if (!record || this.#destroyed) {
      return;
    }
    // A point on the page is in its own size's points.
    await this.#ensureSized(record).catch(() => {});
    if (this.#destroyed) {
      return;
    }
    const scroller = this.element;
    const rect = scroller.getBoundingClientRect();
    const box = record.element.getBoundingClientRect();
    const { x = null, y = null } = options;
    const top = scroller.scrollTop + box.top - rect.top + (y === null ? -this.#gap : y * this.scale);
    const left = x === null ? scroller.scrollLeft : scroller.scrollLeft + box.left - rect.left + x * this.scale;
    this.#scrollTo(top, left, options.behavior);
    this.#setPage(record.pageNumber);
  }

  #scrollTo(top: number, left: number, behavior: ScrollBehavior = "auto") {
    const scroller = this.element;
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const clamped = Math.min(maxTop, Math.max(0, top));
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ behavior, left: Math.max(0, left), top: clamped });
    } else {
      scroller.scrollTop = clamped;
      scroller.scrollLeft = Math.max(0, left);
    }
    this.#programmaticTop = scroller.scrollTop;
  }

  next() {
    return this.goToPage(this.#page + 1);
  }

  previous() {
    return this.goToPage(this.#page - 1);
  }

  setZoom(zoom: number, anchor?: { clientX: number; clientY: number }) {
    const next = clampZoom(zoom);
    if (Math.abs(next - this.#zoom) < 1e-6) {
      return;
    }
    if (this.#records.length === 0) {
      this.#zoom = next;
    } else {
      this.#keepAnchor(() => {
        this.#zoom = next;
        this.#applyScale();
      }, anchor);
    }
    this.dispatchEvent(new CustomEvent("zoomchange", { detail: { scale: this.scale, zoom: this.#zoom } }));
  }

  zoomIn() {
    this.setZoom(stepZoom(this.#zoom, 1));
  }

  zoomOut() {
    this.setZoom(stepZoom(this.#zoom, -1));
  }

  fitWidth() {
    this.setZoom(1);
  }

  async find(query: string, options: FindOptions = {}): Promise<FindMatch[]> {
    this.#findController?.abort();
    const controller = new AbortController();
    this.#findController = controller;
    const { signal } = controller;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      controller.abort();
    }
    try {
      return await this.#find(query, options, signal, controller);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async #find(query: string, options: FindOptions, signal: AbortSignal, controller: AbortController): Promise<FindMatch[]> {
    await this.ready;
    const doc = this.#doc;
    if (!doc || this.#destroyed) {
      throw Object.assign(new Error("the viewer was destroyed"), { name: "AbortError", code: "aborted" });
    }
    const stopped = () => Object.assign(new Error("the search was stopped"), { name: "AbortError", code: "aborted" });
    if (!query.trim()) {
      return [];
    }
    const count = doc.pageCount;
    const found: FindMatch[][] = Array.from({ length: count }, () => []);
    const flat = () => found.flat();
    // From the reader's page on, wrapping, so the first hits found are the ones nearest.
    const order = Array.from({ length: count }, (_, i) => ((this.#page - 1 + i) % count) + 1);
    let next = 0;
    let searched = 0;
    let reported = 0;
    const caseSensitive = options.caseSensitive ?? false;
    const worker = async () => {
      while (next < order.length) {
        if (signal.aborted) {
          throw stopped();
        }
        const page = order[next++]!;
        let hit = false;
        try {
          const hits = await doc.find(page, query, { caseSensitive });
          found[page - 1] = hits.map((match) => ({ boxes: match.boxes, index: match.index, page }));
          hit = hits.length > 0;
        } catch (cause) {
          this.#report(cause, { page, stage: "find" });
        }
        searched += 1;
        if (signal.aborted) {
          throw stopped();
        }
        // On the first hit, at the end, and otherwise a few times a second: not once a page.
        const at = performance.now();
        if (options.onProgress && ((hit && reported === 0) || searched === count || at - reported > 150)) {
          reported = at;
          options.onProgress(flat(), searched);
        }
      }
    };
    // Two in flight: the worker reads one page while the answer for the last crosses back.
    await Promise.all([worker(), worker()]);
    if (this.#findController === controller) {
      this.#findController = null;
    }
    return flat();
  }

  setHighlights(highlights: readonly Highlight[]) {
    const byPage = new Map<PageRecord, Highlight[]>();
    for (const highlight of highlights) {
      const record = this.#records[highlight.page - 1];
      if (record) {
        const list = byPage.get(record);
        if (list) {
          list.push(highlight);
        } else {
          byPage.set(record, [highlight]);
        }
      }
    }
    const before = this.#highlights;
    this.#highlights = byPage;
    for (const record of before.keys()) {
      if (!byPage.has(record)) {
        this.#paintHighlights(record);
      }
    }
    // Drawn now only near the screen; the rest when they come near. A search for a common word on a
    // long document is thousands of boxes.
    for (const record of byPage.keys()) {
      this.#paintHighlights(record);
    }
  }

  #paintHighlights(record: PageRecord) {
    const list = record.near ? (this.#highlights.get(record) ?? []) : [];
    const key = list.map(({ active, boxes }) => `${active ? 1 : 0}${boxes.map((box) => `${box.x},${box.y},${box.width},${box.height}`).join(";")}`).join("|");
    if (key === record.highlightKey) {
      return;
    }
    record.highlightKey = key;
    if (list.length === 0) {
      record.highlightEl?.replaceChildren();
      return;
    }
    const document = record.element.ownerDocument;
    if (!record.highlightEl) {
      record.highlightEl = document.createElement("div");
      record.highlightEl.className = "recto-highlights";
      // Under the text layer, so text stays selectable through a highlight.
      if (record.textEl) {
        record.textEl.before(record.highlightEl);
      } else {
        record.element.append(record.highlightEl);
      }
    }
    const fragment = document.createDocumentFragment();
    for (const { boxes, active } of list) {
      for (const box of boxes) {
        if (!(Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0 && box.height > 0)) {
          continue;
        }
        const mark = document.createElement("div");
        if (active) {
          mark.className = "recto-active";
        }
        mark.style.left = `${box.x}px`;
        mark.style.top = `${box.y}px`;
        mark.style.width = `${box.width}px`;
        mark.style.height = `${box.height}px`;
        fragment.append(mark);
      }
    }
    record.highlightEl.replaceChildren(fragment);
  }

  async scrollToBox(page: number, box: PdfBox, options: { behavior?: ScrollBehavior } = {}): Promise<void> {
    await this.ready.catch(() => {});
    const record = this.#records[page - 1];
    if (!record || this.#destroyed) {
      return;
    }
    await this.#ensureSized(record).catch(() => {});
    const scroller = this.element;
    const rect = scroller.getBoundingClientRect();
    const element = record.element.getBoundingClientRect();
    const scale = this.scale;
    const boxTop = element.top - rect.top + box.y * scale;
    const boxLeft = element.left - rect.left + box.x * scale;
    const top = scroller.scrollTop + boxTop - (scroller.clientHeight - box.height * scale) / 2;
    // Sideways only when the box is out of view.
    const outside = boxLeft < 0 || boxLeft + box.width * scale > scroller.clientWidth;
    const left = outside ? scroller.scrollLeft + boxLeft - (scroller.clientWidth - box.width * scale) / 2 : scroller.scrollLeft;
    this.#scrollTo(top, left, options.behavior);
    this.#setPage(record.pageNumber);
  }

  pageElement(page: number): HTMLElement | null {
    return this.#records[page - 1]?.element ?? null;
  }

  destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.#findController?.abort();
    clearTimeout(this.#refreshTimer);
    this.#cancelFrame(this.#scrollFrame);
    this.#cancelFrame(this.#resizeFrame);
    for (const cleanup of this.#cleanups.splice(0)) {
      cleanup();
    }
    for (const record of this.#records) {
      record.renderTask?.cancel();
    }
    this.#lease?.release();
    this.#lease = null;
    this.#records = [];
    this.#recordByElement.clear();
    this.#live.length = 0;
    this.element.remove();
  }
}

/** Opens `source` in a new viewer filling `container`. */
export function createViewer(options: ViewerOptions): Viewer {
  return new PdfViewer(options);
}
