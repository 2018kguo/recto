// A page's transparent text layer: one span per text run, placed over its glyphs, so the reader can
// select and copy the page's text. The page's links sit on top as empty anchors, which add no text to
// what a selection reads.

import type { ViewerLink, ViewerTextRun } from "./protocol.ts";

export const LINK_CLASS = "recto-link";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** A link's URI as an href, or null for any scheme but http, https and mailto. */
export function safeLinkHref(uri: string): string | null {
  // The URL parser drops tabs, newlines and leading control characters, so "java\tscript:" and
  // "\u0001javascript:" read as the javascript: they are. A relative or malformed URI throws.
  try {
    const url = new URL(uri);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * An anchor over a link's box, in CSS pixels at `scale`. A URI opens in a new tab; a page link carries
 * its destination for the viewer to scroll to.
 */
function linkAnchor(document: Document, { box, target }: ViewerLink, scale: number): HTMLAnchorElement | null {
  const anchor = document.createElement("a");
  if (target.kind === "uri") {
    const href = safeLinkHref(target.uri);
    if (!href) {
      return null;
    }
    anchor.href = href;
    anchor.setAttribute("aria-label", href);
    anchor.rel = "noopener noreferrer";
    // A mail link hands off to the mail app; only a web page gets a tab.
    if (!href.startsWith("mailto:")) {
      anchor.target = "_blank";
    }
  } else {
    anchor.href = `#page=${target.page}`;
    anchor.dataset.destPage = String(target.page);
    if (target.x !== null) {
      anchor.dataset.destX = String(target.x);
    }
    if (target.y !== null) {
      anchor.dataset.destY = String(target.y);
    }
    anchor.setAttribute("aria-label", `Go to page ${target.page}`);
  }
  anchor.className = LINK_CLASS;
  anchor.style.left = `${box.x * scale}px`;
  anchor.style.top = `${box.y * scale}px`;
  anchor.style.width = `${box.width * scale}px`;
  anchor.style.height = `${box.height * scale}px`;
  return anchor;
}

// The share of a line's em above its baseline. The engine's own char boxes use 0.8 for a font that
// states no ascent, and the spans are sized by the em alone, so this puts a span's top where the
// glyphs start.
const TEXT_ASCENT = 0.8;
// Text is measured at one size and scaled: canvas widths are linear in size, and setting `font` per
// run costs more than the measurement itself.
const MEASURE_FONT_PX = 100;

/**
 * Where a run's span goes, in CSS pixels: its top-left corner, which is the baseline origin moved up
 * the run's ascent along the run's own "up" (θ + 90° for a run read at θ counter-clockwise). The span
 * then rotates about that corner.
 */
export function placeTextSpan(params: {
  run: Pick<ViewerTextRun, "direction" | "height" | "x" | "y">;
  pageHeight: number;
  scale: number;
}): { fontSize: number; left: number; top: number } {
  const { run, pageHeight, scale } = params;
  const fontSize = run.height * scale;
  const radians = (run.direction * Math.PI) / 180;
  const ascent = TEXT_ASCENT * fontSize;
  const originX = run.x * scale;
  const originY = (pageHeight - run.y) * scale;
  return { fontSize, left: originX - ascent * Math.sin(radians), top: originY - ascent * Math.cos(radians) };
}

let measureContext: CanvasRenderingContext2D | null | undefined;
function measureText(document: Document, text: string, family: ViewerTextRun["family"]): number {
  if (measureContext === undefined) {
    try {
      measureContext = document.createElement("canvas").getContext("2d");
    } catch {
      measureContext = null;
    }
  }
  if (!measureContext) {
    return 0;
  }
  const font = `${MEASURE_FONT_PX}px ${family}`;
  if (measureContext.font !== font) {
    measureContext.font = font;
  }
  return measureContext.measureText(text).width;
}

/**
 * Fills `container` with one page's text: each line run one transparent span whose box covers its
 * glyphs, pivoted on its top-left corner and stretched to the run's width. Line breaks are <br>, word
 * gaps a trailing space, so a selection copies as the page reads. Links follow the spans.
 */
export function buildTextLayer(params: {
  container: HTMLElement;
  pageHeight: number;
  runs: readonly ViewerTextRun[];
  links?: readonly ViewerLink[];
  scale: number;
}): void {
  const { container, pageHeight, runs, links = [], scale } = params;
  const document = container.ownerDocument;
  const fragment = document.createDocumentFragment();
  let previous: HTMLSpanElement | null = null;
  for (const run of runs) {
    if (previous && run.breakBefore === "line") {
      const br = document.createElement("br");
      br.setAttribute("role", "presentation");
      fragment.appendChild(br);
    } else if (previous && run.breakBefore === "space") {
      previous.append(" ");
    }
    if (!run.str || !(run.height > 0)) {
      continue;
    }
    const { fontSize, left, top } = placeTextSpan({ run, pageHeight, scale });
    const span = document.createElement("span");
    span.textContent = run.str;
    span.style.left = `${left}px`;
    span.style.top = `${top}px`;
    span.style.fontSize = `${fontSize}px`;
    span.style.fontFamily = run.family;
    const measured = (measureText(document, run.str, run.family) * fontSize) / MEASURE_FONT_PX;
    const stretch = measured > 0 ? (run.width * scale) / measured : 1;
    const transforms: string[] = [];
    if (run.direction !== 0) {
      transforms.push(`rotate(${-run.direction}deg)`);
    }
    if (Number.isFinite(stretch) && Math.abs(stretch - 1) > 0.001) {
      transforms.push(`scaleX(${stretch})`);
    }
    if (transforms.length > 0) {
      span.style.transform = transforms.join(" ");
    }
    fragment.appendChild(span);
    previous = span;
  }
  for (const link of links) {
    const anchor = linkAnchor(document, link, scale);
    if (anchor) {
      fragment.appendChild(anchor);
    }
  }
  container.replaceChildren(fragment);
}
