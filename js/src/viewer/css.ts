// The viewer's stylesheet. Pages are sized in points times one scale variable, so zooming is one
// style write however long the document is. Override the custom properties to theme it.

export const VIEWER_CSS = `
.recto-viewer {
  --recto-background: #f3f3f5;
  --recto-page-background: #fff;
  --recto-page-shadow: 0 0 0 1px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.08);
  --recto-highlight: rgb(255 214 10 / 0.38);
  --recto-highlight-active: rgb(255 149 0 / 0.55);
  --recto-selection: rgb(0 122 255 / 0.28);
  box-sizing: border-box;
  position: relative;
  height: 100%;
  overflow: auto;
  overflow-anchor: none;
  overscroll-behavior: contain;
  /* A scrollbar that comes and goes with the fit would narrow the fit, and so on, for ever. */
  scrollbar-gutter: stable;
  background: var(--recto-background);
  outline: none;
}
@media (prefers-color-scheme: dark) {
  .recto-viewer {
    --recto-background: #1c1c1e;
    --recto-page-shadow: 0 0 0 1px rgb(255 255 255 / 0.08);
  }
}
.recto-viewer:focus-visible {
  box-shadow: inset 0 0 0 2px var(--recto-focus, rgb(0 122 255 / 0.6));
}
/* "safe": a page zoomed wider than the pane starts at the scroll origin, where plain centering would
   put its left half at an offset no scroll can reach. */
.recto-pages {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: safe center;
  gap: var(--recto-gap, 12px);
  padding: var(--recto-gap, 12px);
  min-width: min-content;
}
.recto-page {
  position: relative;
  flex: none;
  width: calc(var(--w) * var(--recto-scale, 1) * 1px);
  height: calc(var(--h) * var(--recto-scale, 1) * 1px);
  background: var(--recto-page-background);
  box-shadow: var(--recto-page-shadow);
  overflow: hidden;
  contain: layout paint;
}
.recto-page > canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.recto-text,
.recto-highlights {
  position: absolute;
  left: 0;
  top: 0;
  width: calc(var(--w) * 1px);
  height: calc(var(--h) * 1px);
  transform: scale(var(--recto-scale, 1));
  transform-origin: 0 0;
}
.recto-text {
  color: transparent;
  line-height: 1;
  text-size-adjust: none;
  -webkit-text-size-adjust: none;
  forced-color-adjust: none;
}
.recto-text span {
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
}
.recto-text span::selection {
  background: var(--recto-selection);
  color: transparent;
}
.recto-text br::selection {
  background: transparent;
}
.recto-text > .recto-link {
  position: absolute;
  cursor: pointer;
}
.recto-highlights {
  pointer-events: none;
}
.recto-highlights > div {
  position: absolute;
  border-radius: 1.5px;
  background: var(--recto-highlight);
  mix-blend-mode: multiply;
}
.recto-highlights > .recto-active {
  background: var(--recto-highlight-active);
}
`.trim();

const STYLE_ID = "recto-viewer-style";

/** Adds the stylesheet to the document or shadow root `node` is in, once. */
export function installViewerCss(node: Node): void {
  const root = node.getRootNode();
  const isShadow = typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot;
  const owner = node.ownerDocument;
  if (!owner) {
    return;
  }
  const parent: ParentNode | null = isShadow ? (root as ShadowRoot) : owner.head;
  if (!parent || parent.querySelector?.(`style#${STYLE_ID}`)) {
    return;
  }
  const style = owner.createElement("style");
  style.id = STYLE_ID;
  style.textContent = VIEWER_CSS;
  parent.appendChild(style);
}
