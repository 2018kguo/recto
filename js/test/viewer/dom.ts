// A DOM for the viewer's tests: jsdom, with the layout it lacks. Pages stack as the stylesheet stacks
// them (each `--w` x `--h` points times `--recto-scale`, a gap between and around them), the scroller
// scrolls, and intersection observers answer from that geometry. Canvases record what was drawn.

import { JSDOM } from "jsdom";

export type FakeLayout = {
  window: Window & typeof globalThis;
  document: Document;
  container: HTMLElement;
  /** Delivers what each intersection observer would report now. */
  flushObservers(): void;
  /** Polls `check`, delivering observer entries and letting workers answer, until it holds. */
  until(check: () => boolean, what: string, timeoutMs?: number): Promise<void>;
  /** Lets everything queued run for a while: renders, timers, observer entries. */
  idle(ms?: number): Promise<void>;
  /** Style writes of `--recto-scale` so far. */
  scaleWrites(): number;
  /** Renders drawn into canvases so far, by page; `tile` for a sharp drawing of part of one. */
  drawn: { page: number; width: number; height: number; tile: boolean }[];
};

const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 600;
const THUMB_ROW_PX = 160;

export function fakeLayout(options: { width?: number; height?: number } = {}): FakeLayout {
  const width = options.width ?? VIEW_WIDTH;
  const height = options.height ?? VIEW_HEIGHT;
  const dom = new JSDOM("<!doctype html><html><head></head><body><div id=host></div></body></html>", { pretendToBeVisual: true });
  const window = dom.window as unknown as Window & typeof globalThis;
  const { document } = window;
  const container = document.getElementById("host")!;
  const drawn: FakeLayout["drawn"] = [];
  let scaleWrites = 0;

  const scrollers = new WeakMap<Element, { top: number; left: number }>();
  const scrollerOf = (element: Element): HTMLElement | null => element.closest(".recto-viewer");
  const numberVar = (element: HTMLElement, name: string, fallback: number) => {
    const value = Number.parseFloat(element.style.getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  };
  // Laid out again only after a style write or a new page: a flush measures every page.
  let styleVersion = 0;
  const laidOut = new WeakMap<HTMLElement, { key: string; value: ReturnType<typeof layoutOf> }>();
  const geometry = (scroller: HTMLElement) => {
    const key = `${styleVersion} ${scroller.firstElementChild?.childElementCount ?? 0}`;
    const cached = laidOut.get(scroller);
    if (cached?.key === key) {
      return cached.value;
    }
    const value = layoutOf(scroller);
    laidOut.set(scroller, { key, value });
    return value;
  };
  const layoutOf = (scroller: HTMLElement) => {
    const scale = numberVar(scroller, "--recto-scale", 1);
    const gap = numberVar(scroller, "--recto-gap", 12);
    const pages = [...scroller.querySelectorAll<HTMLElement>(".recto-page")];
    let y = gap;
    let widest = 0;
    const boxes = new Map<HTMLElement, { x: number; y: number; width: number; height: number }>();
    for (const page of pages) {
      const w = numberVar(page, "--w", 0) * scale;
      const h = numberVar(page, "--h", 0) * scale;
      widest = Math.max(widest, w);
      boxes.set(page, { height: h, width: w, x: Math.max(gap, (width - w) / 2), y });
      y += h + gap;
    }
    return { boxes, contentHeight: y, contentWidth: Math.max(width, widest + 2 * gap) };
  };
  const state = (scroller: Element) => {
    let current = scrollers.get(scroller);
    if (!current) {
      current = { left: 0, top: 0 };
      scrollers.set(scroller, current);
    }
    return current;
  };
  const isScroller = (element: Element) => element.classList.contains("recto-viewer");
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(window.Element.prototype, "getBoundingClientRect")!;
  const rect = (x: number, y: number, w: number, h: number) =>
    ({ bottom: y + h, height: h, left: x, right: x + w, top: y, width: w, x, y, toJSON() {} }) as DOMRect;
  Object.defineProperty(window.Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (isScroller(this)) {
        return rect(0, 0, width, height);
      }
      // A sidebar thumbnail: 160 px a page down its list, under a 44 px toolbar.
      if (this.classList.contains("thumb")) {
        const list = this.closest<HTMLElement>(".thumbs");
        const index = Number(this.dataset.page) - 1;
        return rect(0, 44 + index * THUMB_ROW_PX - (list?.scrollTop ?? 0), 112, THUMB_ROW_PX - 10);
      }
      const scroller = scrollerOf(this);
      if (scroller && this.classList.contains("recto-page")) {
        const box = geometry(scroller).boxes.get(this);
        const { left, top } = state(scroller);
        if (box) {
          return rect(box.x - left, box.y - top, box.width, box.height);
        }
      }
      return original.value.call(this);
    },
  });
  const getter = (name: string, value: (element: HTMLElement) => number, fallback?: PropertyDescriptor) =>
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? value(this) : (fallback?.get?.call(this) ?? 0);
      },
    });
  getter("clientWidth", () => width, Object.getOwnPropertyDescriptor(window.Element.prototype, "clientWidth"));
  getter("clientHeight", () => height, Object.getOwnPropertyDescriptor(window.Element.prototype, "clientHeight"));
  getter("scrollHeight", (element) => geometry(element).contentHeight);
  getter("scrollWidth", (element) => geometry(element).contentWidth);
  const clampScroll = (element: HTMLElement) => {
    const { contentHeight, contentWidth } = geometry(element);
    const current = state(element);
    current.top = Math.max(0, Math.min(contentHeight - height, current.top));
    current.left = Math.max(0, Math.min(contentWidth - width, current.left));
  };
  for (const [name, key] of [
    ["scrollTop", "top"],
    ["scrollLeft", "left"],
  ] as const) {
    Object.defineProperty(proto, name, {
      configurable: true,
      get(this: HTMLElement) {
        return state(this)[key];
      },
      set(this: HTMLElement, value: number) {
        // Another element (the sidebar's list) scrolls without bounds: it has no layout here.
        state(this)[key] = value;
        if (isScroller(this)) {
          clampScroll(this);
        }
        this.dispatchEvent(new window.Event("scroll"));
      },
    });
  }
  proto.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options === "object") {
      if (options.top !== undefined) {
        this.scrollTop = options.top;
      }
      if (options.left !== undefined) {
        this.scrollLeft = options.left;
      }
    }
  } as HTMLElement["scrollTo"];

  // Style writes of the scale: zooming must be one, however many pages.
  const setProperty = window.CSSStyleDeclaration.prototype.setProperty;
  window.CSSStyleDeclaration.prototype.setProperty = function (this: CSSStyleDeclaration, name: string, ...rest: [string | null, string?]) {
    styleVersion += 1;
    if (name === "--recto-scale") {
      scaleWrites += 1;
    }
    return setProperty.call(this, name, ...rest);
  };

  // A canvas that records what was put on it.
  Object.defineProperty(window.HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(this: HTMLCanvasElement) {
      const canvas = this;
      return {
        canvas,
        font: "",
        drawImage() {},
        measureText: (text: string) => ({ width: text.length * 50 }),
        putImageData(image: { width: number; height: number }) {
          // Drawn before it's swapped in: its page is read when asked.
          drawn.push({
            height: image.height,
            get page() {
              return Number(canvas.closest<HTMLElement>(".recto-page")?.dataset.pageNumber ?? 0);
            },
            get tile() {
              return canvas.classList.contains("recto-tile");
            },
            width: image.width,
          });
        },
      };
    },
  });
  (window as unknown as { ImageData: unknown }).ImageData = class {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, w: number, h: number) {
      // A real one checks `data` is w x h x 4 bytes; the held renders' bitmaps are stand-ins.
      this.data = data;
      this.width = w;
      this.height = h;
    }
  };

  type Observed = { element: Element; last: boolean | undefined };
  const observers = new Set<{ flush(): void }>();
  class FakeIntersectionObserver {
    readonly #callback: IntersectionObserverCallback;
    readonly #margin: number;
    readonly #observed: Observed[] = [];
    constructor(callback: IntersectionObserverCallback, init: IntersectionObserverInit = {}) {
      this.#callback = callback;
      this.#margin = Number.parseFloat(init.rootMargin ?? "0") || 0;
      observers.add(this);
    }
    observe(element: Element) {
      this.#observed.push({ element, last: undefined });
    }
    unobserve(element: Element) {
      const at = this.#observed.findIndex((entry) => entry.element === element);
      if (at >= 0) {
        this.#observed.splice(at, 1);
      }
    }
    disconnect() {
      this.#observed.length = 0;
      observers.delete(this);
    }
    takeRecords() {
      return [];
    }
    flush() {
      const entries: IntersectionObserverEntry[] = [];
      for (const observed of this.#observed) {
        const box = observed.element.getBoundingClientRect();
        const isIntersecting = box.bottom > -this.#margin && box.top < height + this.#margin && box.height > 0;
        if (observed.last !== isIntersecting) {
          observed.last = isIntersecting;
          entries.push({ boundingClientRect: box, isIntersecting, target: observed.element } as unknown as IntersectionObserverEntry);
        }
      }
      if (entries.length > 0) {
        this.#callback(entries, this as unknown as IntersectionObserver);
      }
    }
  }
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(window, { IntersectionObserver: FakeIntersectionObserver, ResizeObserver: FakeResizeObserver, devicePixelRatio: 2 });

  const flushObservers = () => {
    for (const observer of [...observers]) {
      observer.flush();
    }
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    container,
    document,
    drawn,
    flushObservers,
    async idle(ms = 300) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        flushObservers();
        await sleep(5);
      }
      flushObservers();
    },
    scaleWrites: () => scaleWrites,
    async until(check, what, timeoutMs = 10_000) {
      const end = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > end) {
          throw new Error(`timed out waiting for ${what}`);
        }
        flushObservers();
        await sleep(5);
      }
    },
    window,
  };
}
