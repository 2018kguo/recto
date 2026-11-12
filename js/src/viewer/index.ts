// A PDF viewer on the engine, in plain DOM, its pages drawn in Web Workers:
//
//   import { createViewer } from "@2018kguo/recto/viewer";
//   const viewer = createViewer({ container, source: "report.pdf" });
//
// Or the element, with a toolbar: `defineViewerElement()`, then `<recto-viewer src="report.pdf">`.

export {
  createViewerEngine,
  isAbort,
  sharedViewerEngine,
  type DocumentLease,
  type RenderTask,
  type ViewerBitmap,
  type ViewerDocument,
  type ViewerEngine,
  type ViewerEngineOptions,
  type ViewerError,
  type WorkerPort,
} from "./client.ts";
export { installViewerCss, VIEWER_CSS } from "./css.ts";
export { defineViewerElement, type ViewerElement } from "./element.ts";
export { ZOOM_LEVELS } from "./layout.ts";
export type {
  ViewerFindHit,
  ViewerLink,
  ViewerOpenTiming,
  ViewerOutlineItem,
  ViewerPageInfo,
  ViewerSource,
  ViewerTextRun,
} from "./protocol.ts";
export { buildTextLayer, safeLinkHref } from "./text-layer.ts";
export {
  createViewer,
  type FindMatch,
  type FindOptions,
  type Highlight,
  type Viewer,
  type ViewerErrorInfo,
  type ViewerEventMap,
  type ViewerInput,
  type ViewerOpenInfo,
  type ViewerOptions,
  type ViewerRenderInfo,
} from "./viewer.ts";
