// <recto-viewer src="file.pdf">: the viewer with a small toolbar (the file's name, the page, zoom and
// find), in a shadow root. Defined by `defineViewerElement()`, never on import, so importing the
// viewer has no side effects and works where there is no DOM.

import type { ViewerEngine } from "./client.ts";
import type { FindMatch, Viewer, ViewerInput } from "./viewer.ts";
import { createViewer } from "./viewer.ts";

const ELEMENT_CSS = `
:host {
  --recto-toolbar-background: rgb(250 250 252 / 0.86);
  --recto-toolbar-border: rgb(0 0 0 / 0.08);
  --recto-toolbar-text: #1d1d1f;
  --recto-toolbar-muted: #6e6e73;
  --recto-control-hover: rgb(0 0 0 / 0.06);
  --recto-accent: #007aff;
  display: block;
  position: relative;
  height: 480px;
  overflow: hidden;
  container-type: inline-size;
  font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: var(--recto-toolbar-text);
  background: var(--recto-background, #f3f3f5);
}
@media (prefers-color-scheme: dark) {
  :host {
    --recto-toolbar-background: rgb(36 36 38 / 0.86);
    --recto-toolbar-border: rgb(255 255 255 / 0.1);
    --recto-toolbar-text: #f5f5f7;
    --recto-toolbar-muted: #a1a1a6;
    --recto-control-hover: rgb(255 255 255 / 0.1);
    --recto-accent: #0a84ff;
    background: #1c1c1e;
  }
}
[hidden] { display: none !important; }
.frame { display: flex; flex-direction: column; height: 100%; }
.bar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 0 8px 0 14px;
  box-sizing: border-box;
  background: var(--recto-toolbar-background);
  border-bottom: 1px solid var(--recto-toolbar-border);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
  flex: none;
  z-index: 1;
}
.name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 590;
}
.group { display: flex; align-items: center; gap: 2px; flex: none; }
.sep { width: 1px; height: 18px; background: var(--recto-toolbar-border); margin: 0 6px; }
button {
  all: unset;
  box-sizing: border-box;
  display: inline-grid;
  place-items: center;
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
  border-radius: 7px;
  color: var(--recto-toolbar-text);
  cursor: default;
  font-variant-numeric: tabular-nums;
}
button:hover:not(:disabled) { background: var(--recto-control-hover); }
button:disabled { opacity: 0.35; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--recto-accent); outline-offset: 1px; }
button[aria-pressed="true"] { color: var(--recto-accent); }
svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.percent { min-width: 52px; color: var(--recto-toolbar-muted); }
.pages { display: flex; align-items: center; gap: 4px; color: var(--recto-toolbar-muted); font-variant-numeric: tabular-nums; }
input {
  all: unset;
  box-sizing: border-box;
  height: 26px;
  border-radius: 6px;
  background: var(--recto-control-hover);
  color: var(--recto-toolbar-text);
  padding: 0 8px;
}
.page-input { width: 3.2em; text-align: center; }
.findbar { gap: 6px; }
.find-input { flex: 1 1 auto; min-width: 0; max-width: 320px; }
.count { color: var(--recto-toolbar-muted); min-width: 64px; text-align: right; font-variant-numeric: tabular-nums; }
.body { position: relative; flex: 1 1 auto; min-height: 0; }
.status {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--recto-toolbar-muted);
  pointer-events: none;
  z-index: 1;
}
@container (max-width: 520px) {
  .name, .sep { display: none; }
  .bar { padding: 0 4px; justify-content: space-between; }
  button { min-width: 36px; height: 36px; }
  .percent { min-width: 44px; }
}
`;

const ICONS = {
  minus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9"/></svg>',
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="m10.2 10.2 3.3 3.3"/></svg>',
  up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
};

const TEMPLATE = `
<style>${ELEMENT_CSS}</style>
<div class="frame">
  <div class="bar" role="toolbar" aria-label="Document">
    <div class="name" part="name"></div>
    <div class="group pages">
      <input class="page-input" inputmode="numeric" enterkeyhint="go" aria-label="Page" value="1" />
      <span class="of">of 0</span>
    </div>
    <div class="sep"></div>
    <div class="group">
      <button class="zoom-out" aria-label="Zoom out">${ICONS.minus}</button>
      <button class="percent fit" aria-label="100%, fit to width">100%</button>
      <button class="zoom-in" aria-label="Zoom in">${ICONS.plus}</button>
    </div>
    <div class="sep"></div>
    <button class="find-toggle" aria-label="Find in document" aria-pressed="false" aria-keyshortcuts="Control+F Meta+F">${ICONS.search}</button>
  </div>
  <div class="bar findbar" role="search" hidden>
    <input class="find-input" type="search" placeholder="Find in document" aria-label="Find in document" autocomplete="off" spellcheck="false" />
    <span class="count" aria-live="polite"></span>
    <button class="find-prev" aria-label="Previous match" aria-keyshortcuts="Shift+Enter" disabled>${ICONS.up}</button>
    <button class="find-next" aria-label="Next match" aria-keyshortcuts="Enter" disabled>${ICONS.down}</button>
    <button class="find-close" aria-label="Close find" aria-keyshortcuts="Escape">${ICONS.close}</button>
  </div>
  <div class="body" part="body"><div class="status" aria-live="polite"></div></div>
</div>`;

/** What `<recto-viewer>` adds to HTMLElement. */
export interface ViewerElement extends HTMLElement {
  /** What it shows: set to a File, bytes or a URL. The `src` attribute is the same for a URL. */
  source: ViewerInput | null;
  /** The viewer inside, once there's a source. */
  readonly viewer: Viewer | null;
  /** The engine its viewers use. Default: the page's shared one. */
  engine: ViewerEngine | null;
  /** Opens the find bar, with `query` in it if given. */
  openFind(query?: string): void;
}

function nameOf(source: ViewerInput | null): string {
  if (source === null) {
    return "";
  }
  if (typeof File !== "undefined" && source instanceof File) {
    return source.name;
  }
  if (typeof source === "string" || source instanceof URL) {
    try {
      const path = new URL(String(source), globalThis.location?.href ?? "http://localhost/").pathname;
      return decodeURIComponent(path.split("/").filter(Boolean).at(-1) ?? "");
    } catch {
      return String(source);
    }
  }
  return "";
}

/**
 * Defines `<recto-viewer>` (or `name`) in `registry`. Attributes: `src`, `name` (the title shown;
 * the file's by default), `zoom`, `page`. Returns the element's class.
 */
export function defineViewerElement(name = "recto-viewer", registry: CustomElementRegistry = customElements): CustomElementConstructor {
  const existing = registry.get(name);
  if (existing) {
    return existing;
  }

  class RectoViewerElement extends HTMLElement implements ViewerElement {
    static observedAttributes = ["src", "name"];
    #source: ViewerInput | null = null;
    #viewer: Viewer | null = null;
    #engine: ViewerEngine | null = null;
    #matches: FindMatch[] = [];
    #active = -1;
    #findTimer: ReturnType<typeof setTimeout> | undefined;
    #findQuery = "";
    readonly #root: ShadowRoot;
    readonly #parts: {
      name: HTMLElement;
      pageInput: HTMLInputElement;
      of: HTMLElement;
      zoomOut: HTMLButtonElement;
      fit: HTMLButtonElement;
      zoomIn: HTMLButtonElement;
      findToggle: HTMLButtonElement;
      findbar: HTMLElement;
      findInput: HTMLInputElement;
      count: HTMLElement;
      prev: HTMLButtonElement;
      next: HTMLButtonElement;
      close: HTMLButtonElement;
      body: HTMLElement;
      status: HTMLElement;
    };

    constructor() {
      super();
      this.#root = this.attachShadow({ mode: "open" });
      this.#root.innerHTML = TEMPLATE;
      const $ = <T extends HTMLElement>(selector: string) => this.#root.querySelector<T>(selector)!;
      this.#parts = {
        body: $(".body"),
        close: $(".find-close"),
        count: $(".count"),
        findInput: $(".find-input"),
        findToggle: $(".find-toggle"),
        findbar: $(".findbar"),
        fit: $(".fit"),
        name: $(".name"),
        next: $(".find-next"),
        of: $(".of"),
        pageInput: $(".page-input"),
        prev: $(".find-prev"),
        status: $(".status"),
        zoomIn: $(".zoom-in"),
        zoomOut: $(".zoom-out"),
      };
      const p = this.#parts;
      p.zoomOut.addEventListener("click", () => this.#viewer?.zoomOut());
      p.zoomIn.addEventListener("click", () => this.#viewer?.zoomIn());
      p.fit.addEventListener("click", () => this.#viewer?.fitWidth());
      p.findToggle.addEventListener("click", () => (p.findbar.hidden ? this.openFind() : this.#closeFind()));
      p.close.addEventListener("click", () => this.#closeFind());
      p.next.addEventListener("click", () => this.#step(1));
      p.prev.addEventListener("click", () => this.#step(-1));
      p.pageInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void this.#viewer?.goToPage(Number.parseInt(p.pageInput.value, 10) || 1);
          this.#viewer?.element.focus({ preventScroll: true });
        } else if (event.key === "Escape") {
          p.pageInput.value = String(this.#viewer?.page ?? 1);
          p.pageInput.blur();
        }
      });
      p.pageInput.addEventListener("focus", () => p.pageInput.select());
      p.pageInput.addEventListener("blur", () => {
        p.pageInput.value = String(this.#viewer?.page ?? 1);
      });
      p.findInput.addEventListener("input", () => {
        clearTimeout(this.#findTimer);
        this.#findTimer = setTimeout(() => this.#search(p.findInput.value), 150);
      });
      p.findInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          if (p.findInput.value !== this.#findQuery) {
            clearTimeout(this.#findTimer);
            void this.#search(p.findInput.value);
          } else {
            this.#step(event.shiftKey ? -1 : 1);
          }
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.#closeFind();
        }
      });
      this.addEventListener("keydown", (event) => {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && !event.altKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          this.openFind();
        } else if (mod && event.key.toLowerCase() === "g" && this.#matches.length > 0) {
          event.preventDefault();
          this.#step(event.shiftKey ? -1 : 1);
        }
      });
    }

    get source() {
      return this.#source;
    }
    set source(source: ViewerInput | null) {
      this.#source = source;
      this.#open();
    }
    get viewer() {
      return this.#viewer;
    }
    get engine() {
      return this.#engine;
    }
    set engine(engine: ViewerEngine | null) {
      this.#engine = engine;
    }

    attributeChangedCallback(attribute: string, previous: string | null, value: string | null) {
      if (previous === value) {
        return;
      }
      if (attribute === "src") {
        this.source = value;
      } else {
        this.#showName();
      }
    }

    connectedCallback() {
      if (this.#source !== null && !this.#viewer) {
        this.#open();
      }
    }

    disconnectedCallback() {
      this.#viewer?.destroy();
      this.#viewer = null;
    }

    #showName() {
      this.#parts.name.textContent = this.getAttribute("name") ?? nameOf(this.#source);
      this.#parts.name.title = this.#parts.name.textContent;
    }

    #open() {
      this.#viewer?.destroy();
      this.#viewer = null;
      this.#resetFind();
      this.#showName();
      const p = this.#parts;
      if (this.#source === null || this.#source === "" || !this.isConnected) {
        p.status.textContent = "";
        return;
      }
      p.status.textContent = "Opening…";
      const zoom = Number(this.getAttribute("zoom"));
      const page = Number(this.getAttribute("page"));
      const viewer = createViewer({
        container: p.body,
        label: this.getAttribute("name") ?? (nameOf(this.#source) || "PDF document"),
        source: this.#source,
        ...(this.#engine ? { engine: this.#engine } : {}),
        ...(zoom > 0 ? { zoom } : {}),
        ...(page > 0 ? { page } : {}),
      });
      this.#viewer = viewer;
      const update = () => {
        p.pageInput.value = String(viewer.page);
        p.of.textContent = `of ${viewer.pageCount}`;
        p.fit.textContent = `${Math.round(viewer.zoom * 100)}%`;
        // The name starts with what it shows (WCAG label in name), and says what it does.
        p.fit.setAttribute("aria-label", `${p.fit.textContent}, fit to width`);
        p.zoomOut.disabled = viewer.zoom <= 0.25 + 1e-6;
        p.zoomIn.disabled = viewer.zoom >= 4 - 1e-6;
      };
      viewer.addEventListener("open", () => {
        p.status.textContent = "";
        update();
        const CustomEventImpl = this.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;
        this.dispatchEvent(new CustomEventImpl("open", { detail: { pageCount: viewer.pageCount } }));
      });
      viewer.addEventListener("pagechange", () => {
        if (this.#root.activeElement !== p.pageInput) {
          p.pageInput.value = String(viewer.page);
        }
      });
      viewer.addEventListener("zoomchange", update);
      viewer.addEventListener("error", (event) => {
        if (event.detail.stage === "open") {
          p.status.textContent = "This PDF couldn’t be opened.";
        }
      });
    }

    openFind(query?: string) {
      const p = this.#parts;
      p.findbar.hidden = false;
      p.findToggle.setAttribute("aria-pressed", "true");
      if (query !== undefined) {
        p.findInput.value = query;
        void this.#search(query);
      }
      p.findInput.focus();
      p.findInput.select();
    }

    #closeFind() {
      const p = this.#parts;
      p.findbar.hidden = true;
      p.findToggle.setAttribute("aria-pressed", "false");
      this.#resetFind();
      this.#viewer?.element.focus({ preventScroll: true });
    }

    #resetFind() {
      clearTimeout(this.#findTimer);
      this.#matches = [];
      this.#active = -1;
      this.#findQuery = "";
      this.#viewer?.setHighlights([]);
      this.#parts.count.textContent = "";
      this.#parts.prev.disabled = true;
      this.#parts.next.disabled = true;
    }

    async #search(query: string) {
      const viewer = this.#viewer;
      if (!viewer) {
        return;
      }
      this.#findQuery = query;
      this.#matches = [];
      this.#active = -1;
      if (!query.trim()) {
        this.#resetFind();
        return;
      }
      const p = this.#parts;
      p.count.textContent = "Searching…";
      const startPage = viewer.page;
      const show = (matches: FindMatch[], done: boolean) => {
        if (this.#findQuery !== query) {
          return;
        }
        // Matches arrive out of page order, from the reader's page on: keep the current one by identity.
        const current = this.#matches[this.#active];
        this.#matches = matches;
        this.#active = current ? matches.findIndex((match) => match.page === current.page && match.index === current.index) : -1;
        if (this.#active < 0 && matches.length > 0) {
          // The first match at or after the reader's page, once one is known.
          const at = matches.findIndex((match) => match.page >= startPage);
          if (at >= 0 || done) {
            this.#active = Math.max(0, at);
            const match = matches[this.#active];
            if (match?.boxes[0]) {
              void viewer.scrollToBox(match.page, match.boxes[0]);
            }
          }
        }
        this.#paintMatches();
        // Announced once, when the search ends, not on every page searched.
        p.count.setAttribute("aria-busy", String(!done));
        p.count.textContent =
          matches.length === 0 ? (done ? "No matches" : "Searching…") : `${Math.max(1, this.#active + 1)} of ${matches.length}${done ? "" : "…"}`;
        p.prev.disabled = p.next.disabled = matches.length === 0;
      };
      try {
        const matches = await viewer.find(query, { onProgress: (found) => show(found, false) });
        show(matches, true);
      } catch {
        // A newer search replaced it.
      }
    }

    #paintMatches() {
      this.#viewer?.setHighlights(this.#matches.map((match, i) => ({ active: i === this.#active, boxes: match.boxes, page: match.page })));
    }

    #step(direction: 1 | -1) {
      const viewer = this.#viewer;
      if (!viewer || this.#matches.length === 0) {
        return;
      }
      this.#active =
        this.#active < 0 ? (direction === 1 ? 0 : this.#matches.length - 1) : (this.#active + direction + this.#matches.length) % this.#matches.length;
      const match = this.#matches[this.#active]!;
      this.#paintMatches();
      this.#parts.count.textContent = `${this.#active + 1} of ${this.#matches.length}`;
      if (match.boxes[0]) {
        void viewer.scrollToBox(match.page, match.boxes[0]);
      }
    }
  }

  registry.define(name, RectoViewerElement);
  return RectoViewerElement;
}
