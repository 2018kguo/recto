// <recto-viewer src="file.pdf">: the viewer with a small toolbar (the file's name, the page, zoom and
// find), in a shadow root. Defined by `defineViewerElement()`, never on import, so importing the
// viewer has no side effects and works where there is no DOM.

import type { ViewerEngine } from "./client.ts";
import type { ViewerOutlineItem } from "./protocol.ts";
import { safeLinkHref } from "./text-layer.ts";
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
    --recto-sidebar-overlay: #262628;
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
.main { position: relative; display: flex; flex: 1 1 auto; min-height: 0; }
.body { position: relative; flex: 1 1 auto; min-width: 0; }
.sidebar {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 184px;
  box-sizing: border-box;
  background: var(--recto-toolbar-background);
  border-right: 1px solid var(--recto-toolbar-border);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
}
.tabs {
  display: flex;
  margin: 8px 10px 4px;
  padding: 2px;
  border-radius: 8px;
  background: var(--recto-control-hover);
}
.tabs button { flex: 1; height: 24px; border-radius: 6px; font-size: 12px; color: var(--recto-toolbar-muted); }
.tabs button[aria-selected="true"] { background: var(--recto-toolbar-background); color: var(--recto-toolbar-text); box-shadow: 0 1px 2px rgb(0 0 0 / 0.12); }
.panel { flex: 1 1 auto; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.thumbs ol { list-style: none; margin: 0; padding: 8px 0 12px; }
.thumbs li { display: flex; justify-content: center; }
.thumbs button { display: flex; flex-direction: column; gap: 4px; height: auto; padding: 6px; color: var(--recto-toolbar-muted); font-size: 11px; }
.thumbs button:hover:not(:disabled) { background: transparent; }
.frame-thumb {
  display: block;
  width: 112px;
  background: var(--recto-page-background, #fff);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.08), 0 1px 2px rgb(0 0 0 / 0.08);
  border-radius: 2px;
  overflow: hidden;
}
.frame-thumb canvas { display: block; width: 100%; height: 100%; }
.thumbs button[aria-current="page"] .frame-thumb { box-shadow: 0 0 0 2px var(--recto-accent); }
.thumbs button[aria-current="page"] { color: var(--recto-toolbar-text); }
.outline ul { list-style: none; margin: 0; padding: 0; }
.outline { padding: 4px 6px 12px; }
.outline ul ul { padding-left: 14px; }
.outline .row { display: flex; align-items: center; }
.outline .row button { height: 28px; justify-content: start; }
.outline .twist { min-width: 20px; width: 20px; padding: 0; color: var(--recto-toolbar-muted); }
.outline .twist svg { width: 10px; height: 10px; transition: transform 0.15s; }
.outline .twist[aria-expanded="true"] svg { transform: rotate(90deg); }
.outline .spacer { width: 20px; flex: none; }
.outline .item { flex: 1; min-width: 0; display: block; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 28px; }
.outline .item[aria-current="true"] { color: var(--recto-accent); }
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
  /* Over the pages, not beside them: a phone has no width to give. */
  .sidebar {
    position: absolute;
    inset: 0 auto 0 0;
    z-index: 2;
    width: min(280px, 85%);
    /* Opaque over the pages: blurred text behind a list reads as noise. */
    background: var(--recto-sidebar-overlay, #f7f7f9);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
    box-shadow: 0 0 0 1px var(--recto-toolbar-border), 0 8px 32px rgb(0 0 0 / 0.18);
  }
  .tabs button { height: 30px; }
  .outline .row button { height: 40px; }
  .outline .item { line-height: 40px; }
}
`;

const ICONS = {
  minus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9"/></svg>',
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="m10.2 10.2 3.3 3.3"/></svg>',
  up: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>',
  down: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
  sidebar: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6.5 3v10"/></svg>',
  chevron: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="m3.5 2 3 3-3 3"/></svg>',
};

const TEMPLATE = `
<style>${ELEMENT_CSS}</style>
<div class="frame">
  <div class="bar" role="toolbar" aria-label="Document">
    <button class="sidebar-toggle" aria-label="Sidebar" aria-expanded="false" aria-controls="sidebar">${ICONS.sidebar}</button>
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
  <div class="main">
    <nav class="sidebar" id="sidebar" part="sidebar" aria-label="Pages and outline" hidden>
      <div class="tabs" role="tablist" aria-label="Sidebar" hidden>
        <button class="tab-thumbs" role="tab" id="tab-thumbs" aria-selected="true" aria-controls="thumbs">Pages</button>
        <button class="tab-outline" role="tab" id="tab-outline" aria-selected="false" aria-controls="outline" tabindex="-1">Outline</button>
      </div>
      <div class="panel thumbs" id="thumbs"></div>
      <div class="panel outline" id="outline" hidden></div>
    </nav>
    <div class="body" part="body"><div class="status" aria-live="polite"></div></div>
  </div>
</div>`;

/** How wide a thumbnail is drawn, in CSS pixels; its bitmap is at most twice that. */
const THUMB_CSS_WIDTH = 112;
/** The container width at or below which the sidebar covers the pages instead of sitting beside them. */
const OVERLAY_MAX_WIDTH = 520;

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
  /** Shows the sidebar of page thumbnails and the outline, or hides it; flips it without `open`. */
  toggleSidebar(open?: boolean): void;
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
      sidebarToggle: HTMLButtonElement;
      sidebar: HTMLElement;
      tabs: HTMLElement;
      tabThumbs: HTMLButtonElement;
      tabOutline: HTMLButtonElement;
      thumbs: HTMLElement;
      outline: HTMLElement;
    };
    // The sidebar's contents, made for the open viewer the first time it's shown.
    #sidebarFor: Viewer | null = null;
    #thumbObserver: IntersectionObserver | null = null;
    readonly #thumbJobs = new Map<HTMLElement, AbortController>();
    #roving: { thumbs: HTMLElement | null; outline: HTMLElement | null } = { outline: null, thumbs: null };

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
        outline: $(".outline"),
        prev: $(".find-prev"),
        sidebar: $(".sidebar"),
        sidebarToggle: $(".sidebar-toggle"),
        status: $(".status"),
        tabOutline: $(".tab-outline"),
        tabThumbs: $(".tab-thumbs"),
        tabs: $(".tabs"),
        thumbs: $(".thumbs"),
        zoomIn: $(".zoom-in"),
        zoomOut: $(".zoom-out"),
      };
      const p = this.#parts;
      p.sidebarToggle.addEventListener("click", () => this.toggleSidebar());
      p.tabThumbs.addEventListener("click", () => this.#showTab("thumbs"));
      p.tabOutline.addEventListener("click", () => this.#showTab("outline"));
      p.tabs.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const next = p.tabThumbs.getAttribute("aria-selected") === "true" ? "outline" : "thumbs";
          this.#showTab(next);
          (next === "thumbs" ? p.tabThumbs : p.tabOutline).focus();
        }
      });
      p.sidebar.addEventListener("click", (event) => this.#onSidebarClick(event));
      p.sidebar.addEventListener("keydown", (event) => this.#onSidebarKey(event));
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
      this.#resetSidebar();
      this.#viewer?.destroy();
      this.#viewer = null;
    }

    #showName() {
      this.#parts.name.textContent = this.getAttribute("name") ?? nameOf(this.#source);
      this.#parts.name.title = this.#parts.name.textContent;
    }

    #open() {
      this.#resetSidebar();
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
        if (!p.sidebar.hidden) {
          this.#buildSidebar();
        }
        const CustomEventImpl = this.ownerDocument.defaultView?.CustomEvent ?? CustomEvent;
        this.dispatchEvent(new CustomEventImpl("open", { detail: { pageCount: viewer.pageCount } }));
      });
      viewer.addEventListener("pagechange", () => {
        if (this.#root.activeElement !== p.pageInput) {
          p.pageInput.value = String(viewer.page);
        }
        this.#markCurrent();
      });
      viewer.addEventListener("zoomchange", update);
      viewer.addEventListener("error", (event) => {
        if (event.detail.stage === "open") {
          p.status.textContent = "This PDF couldn’t be opened.";
        }
      });
    }

    toggleSidebar(open = this.#parts.sidebar.hidden) {
      const p = this.#parts;
      p.sidebar.hidden = !open;
      p.sidebarToggle.setAttribute("aria-expanded", String(open));
      if (open) {
        // Focus stays on the button; Tab reaches the list at the page being read.
        this.#buildSidebar();
      } else if (p.sidebar.contains(this.#root.activeElement)) {
        p.sidebarToggle.focus();
      }
    }

    /** Covering the pages (a narrow element), where choosing a place closes it. */
    #overlaid(): boolean {
      const width = this.clientWidth;
      return width > 0 && width <= OVERLAY_MAX_WIDTH;
    }

    #resetSidebar() {
      this.#thumbObserver?.disconnect();
      this.#thumbObserver = null;
      for (const job of this.#thumbJobs.values()) {
        job.abort();
      }
      this.#thumbJobs.clear();
      this.#sidebarFor = null;
      this.#roving = { outline: null, thumbs: null };
      const p = this.#parts;
      p.thumbs.replaceChildren();
      p.outline.replaceChildren();
      p.tabs.hidden = true;
      for (const panel of [p.thumbs, p.outline]) {
        panel.removeAttribute("role");
        panel.removeAttribute("aria-labelledby");
      }
      this.#showTab("thumbs");
    }

    /** Fills the sidebar for the open viewer: a placeholder per page, drawn as it scrolls into view, and the outline. */
    #buildSidebar() {
      const viewer = this.#viewer;
      if (!viewer || viewer.state !== "ready" || this.#sidebarFor === viewer) {
        return;
      }
      this.#sidebarFor = viewer;
      const p = this.#parts;
      const document = this.ownerDocument;
      const fragment = document.createDocumentFragment();
      const first = viewer.pageElement(1);
      const ratio = `${first?.style.getPropertyValue("--w") || 612} / ${first?.style.getPropertyValue("--h") || 792}`;
      for (let page = 1; page <= viewer.pageCount; page++) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.className = "thumb";
        button.dataset.page = String(page);
        button.tabIndex = -1;
        button.setAttribute("aria-label", `Page ${page}`);
        const frame = document.createElement("span");
        frame.className = "frame-thumb";
        frame.style.aspectRatio = ratio;
        const label = document.createElement("span");
        label.textContent = String(page);
        label.setAttribute("aria-hidden", "true");
        button.append(frame, label);
        item.append(button);
        fragment.append(item);
      }
      const list = document.createElement("ol");
      list.setAttribute("aria-label", "Pages");
      list.append(fragment);
      p.thumbs.replaceChildren(list);
      const IntersectionObserverImpl = document.defaultView?.IntersectionObserver ?? globalThis.IntersectionObserver;
      if (IntersectionObserverImpl) {
        this.#thumbObserver = new IntersectionObserverImpl(
          (entries) => {
            for (const entry of entries) {
              this.#thumbVisible(entry.target as HTMLElement, entry.isIntersecting);
            }
          },
          { root: p.thumbs, rootMargin: "240px 0px" }
        );
        const observer = this.#thumbObserver;
        p.thumbs.querySelectorAll<HTMLElement>(".thumb").forEach((button) => observer.observe(button));
      }
      this.#markCurrent();
      void viewer.outline().then(
        (items) => {
          if (this.#sidebarFor !== viewer || items.length === 0) {
            return;
          }
          const list = this.#outlineList(items, items.length === 1);
          p.outline.replaceChildren(list);
          const firstItem = list.querySelector<HTMLElement>(".item");
          if (firstItem) {
            firstItem.tabIndex = 0;
            this.#roving.outline = firstItem;
          }
          // Two views now: tabs, and panels they name.
          p.tabs.hidden = false;
          for (const [panel, tab] of [
            [p.thumbs, "tab-thumbs"],
            [p.outline, "tab-outline"],
          ] as const) {
            panel.setAttribute("role", "tabpanel");
            panel.setAttribute("aria-labelledby", tab);
          }
        },
        () => {
          // No outline to show: the pages alone.
        }
      );
    }

    #outlineList(items: readonly ViewerOutlineItem[], open: boolean): HTMLElement {
      const document = this.ownerDocument;
      const list = document.createElement("ul");
      for (const entry of items) {
        const item = document.createElement("li");
        const row = document.createElement("div");
        row.className = "row";
        const button = document.createElement("button");
        button.className = "item";
        button.tabIndex = -1;
        button.textContent = entry.title;
        button.title = entry.title;
        const href = entry.url ? safeLinkHref(entry.url) : null;
        if (entry.page !== null) {
          button.dataset.page = String(entry.page);
        } else if (href) {
          button.dataset.href = href;
        } else {
          button.disabled = true;
        }
        if (entry.children.length > 0) {
          const twist = document.createElement("button");
          twist.className = "twist";
          twist.tabIndex = -1;
          twist.innerHTML = ICONS.chevron;
          twist.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${entry.title}`);
          twist.setAttribute("aria-expanded", String(open));
          button.setAttribute("aria-expanded", String(open));
          const children = this.#outlineList(entry.children, false);
          children.hidden = !open;
          row.append(twist, button);
          item.append(row, children);
        } else {
          const spacer = document.createElement("span");
          spacer.className = "spacer";
          row.append(spacer, button);
          item.append(row);
        }
        list.append(item);
      }
      return list;
    }

    /** Opens or closes an outline entry's children. */
    #expand(item: HTMLElement, open: boolean) {
      const li = item.closest("li");
      const children = li?.querySelector<HTMLElement>(":scope > ul");
      const twist = li?.querySelector<HTMLElement>(":scope > .row > .twist");
      if (!children || !twist) {
        return;
      }
      children.hidden = !open;
      twist.setAttribute("aria-expanded", String(open));
      item.setAttribute("aria-expanded", String(open));
      const title = item.textContent ?? "";
      twist.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${title}`);
    }

    #thumbVisible(button: HTMLElement, visible: boolean) {
      const viewer = this.#viewer;
      const canvas = button.querySelector("canvas");
      if (!visible) {
        // Far out of view: its bitmap goes, and a drawing on its way stops.
        this.#thumbJobs.get(button)?.abort();
        this.#thumbJobs.delete(button);
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
          canvas.remove();
        }
        return;
      }
      if (!viewer || canvas || this.#thumbJobs.has(button)) {
        return;
      }
      const controller = new AbortController();
      this.#thumbJobs.set(button, controller);
      const ratio = Math.min(2, Math.max(1, this.ownerDocument.defaultView?.devicePixelRatio ?? 1));
      viewer.renderThumbnail(Number(button.dataset.page), { signal: controller.signal, width: THUMB_CSS_WIDTH * ratio }).then(
        (bitmap) => {
          if (this.#thumbJobs.get(button) !== controller) {
            return;
          }
          this.#thumbJobs.delete(button);
          const drawn = this.ownerDocument.createElement("canvas");
          drawn.width = bitmap.width;
          drawn.height = bitmap.height;
          const context = drawn.getContext("2d");
          const ImageDataImpl = this.ownerDocument.defaultView?.ImageData ?? globalThis.ImageData;
          context?.putImageData(new ImageDataImpl(bitmap.rgba, bitmap.width, bitmap.height), 0, 0);
          const frame = button.querySelector<HTMLElement>(".frame-thumb")!;
          frame.style.aspectRatio = `${bitmap.width} / ${bitmap.height}`;
          frame.replaceChildren(drawn);
        },
        () => {
          if (this.#thumbJobs.get(button) === controller) {
            this.#thumbJobs.delete(button);
          }
        }
      );
    }

    /** Marks the page being read in the thumbnails, and keeps it in view there. */
    #markCurrent() {
      const viewer = this.#viewer;
      const p = this.#parts;
      if (!viewer || this.#sidebarFor !== viewer) {
        return;
      }
      const current = p.thumbs.querySelector<HTMLElement>(`.thumb[data-page="${viewer.page}"]`);
      const previous = p.thumbs.querySelector<HTMLElement>('.thumb[aria-current="page"]');
      if (!current || current === previous) {
        return;
      }
      previous?.removeAttribute("aria-current");
      current.setAttribute("aria-current", "page");
      // The list's one tab stop follows the page unless the reader is moving through the list.
      if (!p.thumbs.contains(this.#root.activeElement)) {
        this.#rove("thumbs", current);
        if (!p.sidebar.hidden && !p.thumbs.hidden) {
          const top = current.offsetTop - p.thumbs.offsetTop;
          if (top < p.thumbs.scrollTop || top + current.offsetHeight > p.thumbs.scrollTop + p.thumbs.clientHeight) {
            p.thumbs.scrollTop = top - (p.thumbs.clientHeight - current.offsetHeight) / 2;
          }
        }
      }
    }

    /** Makes `target` its list's one tab stop. */
    #rove(list: "thumbs" | "outline", target: HTMLElement) {
      const previous = this.#roving[list];
      if (previous && previous !== target) {
        previous.tabIndex = -1;
      }
      target.tabIndex = 0;
      this.#roving[list] = target;
    }

    #showTab(which: "thumbs" | "outline") {
      const p = this.#parts;
      const thumbs = which === "thumbs";
      p.thumbs.hidden = !thumbs;
      p.outline.hidden = thumbs;
      p.tabThumbs.setAttribute("aria-selected", String(thumbs));
      p.tabOutline.setAttribute("aria-selected", String(!thumbs));
      p.tabThumbs.tabIndex = thumbs ? 0 : -1;
      p.tabOutline.tabIndex = thumbs ? -1 : 0;
    }

    #onSidebarClick(event: MouseEvent) {
      const target = (event.target as Element | null)?.closest?.<HTMLElement>("button");
      const viewer = this.#viewer;
      if (!target || !viewer) {
        return;
      }
      if (target.classList.contains("twist")) {
        const item = target.parentElement?.querySelector<HTMLElement>(".item");
        if (item) {
          this.#expand(item, target.getAttribute("aria-expanded") !== "true");
        }
        return;
      }
      if (!(target.classList.contains("thumb") || target.classList.contains("item"))) {
        return;
      }
      this.#rove(target.classList.contains("thumb") ? "thumbs" : "outline", target);
      if (target.dataset.href) {
        this.ownerDocument.defaultView?.open(target.dataset.href, "_blank", "noopener,noreferrer");
        return;
      }
      const page = Number(target.dataset.page);
      if (page > 0) {
        void viewer.goToPage(page);
        if (this.#overlaid()) {
          this.toggleSidebar(false);
          viewer.element.focus({ preventScroll: true });
        }
      }
    }

    /** Arrows move through the list shown, Home and End to its ends; Right and Left open and close outline entries. */
    #onSidebarKey(event: KeyboardEvent) {
      const p = this.#parts;
      if (event.key === "Escape") {
        event.preventDefault();
        this.toggleSidebar(false);
        return;
      }
      const target = event.target as HTMLElement;
      const list = p.thumbs.contains(target) ? "thumbs" : p.outline.contains(target) ? "outline" : null;
      if (!list) {
        return;
      }
      const panel = list === "thumbs" ? p.thumbs : p.outline;
      const selector = list === "thumbs" ? ".thumb" : ".item";
      // Only entries whose lists are open.
      const items = Array.from(panel.querySelectorAll<HTMLElement>(selector)).filter((item) => !item.closest("ul[hidden]"));
      const at = items.indexOf(target);
      let next: HTMLElement | undefined;
      if (event.key === "ArrowDown") {
        next = items[Math.min(items.length - 1, at + 1)];
      } else if (event.key === "ArrowUp") {
        next = items[Math.max(0, at - 1)];
      } else if (event.key === "Home") {
        next = items[0];
      } else if (event.key === "End") {
        next = items.at(-1);
      } else if (list === "outline" && event.key === "ArrowRight" && target.hasAttribute("aria-expanded")) {
        if (target.getAttribute("aria-expanded") === "true") {
          next = items[at + 1];
        } else {
          this.#expand(target, true);
        }
      } else if (list === "outline" && event.key === "ArrowLeft") {
        if (target.getAttribute("aria-expanded") === "true") {
          this.#expand(target, false);
        } else {
          next = target.closest("ul")?.closest("li")?.querySelector<HTMLElement>(":scope > .row > .item") ?? undefined;
        }
      } else {
        return;
      }
      event.preventDefault();
      if (next) {
        this.#rove(list, next);
        next.focus();
      }
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
