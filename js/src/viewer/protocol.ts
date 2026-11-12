// Messages between a viewer and its worker. The worker owns every open document; the page only
// ever holds ids, page sizes, text runs, links, search hits and finished bitmaps.

import type { PdfBox } from "../document.ts";

export type ViewerSource =
  | { kind: "url"; url: string; credentials?: RequestCredentials }
  | { kind: "bytes"; bytes: ArrayBuffer };

export type ViewerPageInfo = {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
};

/** One line run of text, in the page's viewer frame with y up (as `textItems` gives it). */
export type ViewerTextRun = {
  str: string;
  breakBefore: "none" | "space" | "line";
  x: number;
  y: number;
  width: number;
  height: number;
  direction: 0 | 90 | 180 | 270;
  /** The generic family the run's font flags ask for. */
  family: "monospace" | "serif" | "sans-serif";
};

/**
 * A link a viewer can follow: a URI as the file states it (the text layer decides which schemes are
 * safe), or a page of this file (1-based) and, where the link names one, the point to show there, in
 * points in that page's viewer frame (y down).
 */
export type ViewerLink = {
  box: PdfBox;
  target: { kind: "uri"; uri: string } | { kind: "page"; page: number; x: number | null; y: number | null };
};

/** A bookmark: the page it goes to (from 1; null if none in this file), or the web address it opens. */
export type ViewerOutlineItem = { title: string; page: number | null; url: string | null; children: ViewerOutlineItem[] };

/** One hit of a search: where it starts in the page's text, and its boxes, one a line, in points (y down). */
export type ViewerFindHit = { index: number; boxes: PdfBox[] };

export type ViewerRequest =
  | {
      op: "open";
      id: number;
      docId: number;
      source: ViewerSource;
      /** Where the engine's wasm lives, if not beside the package's script. */
      assetBase?: string;
      /**
       * The worker is shared: a file too large to read whole fails with `needs-own-worker` instead of
       * opening by range, since its blocking reads would stall every other document on the worker.
       */
      wholeOnly?: boolean;
      /** Files up to this size are downloaded whole (after the first page); larger ones only by range. */
      wholeFileMaxBytes?: number;
    }
  | { op: "pageInfo"; id: number; docId: number; page: number }
  | {
      op: "render";
      id: number;
      docId: number;
      page: number;
      /** The whole page's width in pixels, as without a region. */
      width: number;
      /** Draw only this part of the page, in points (y down). */
      region?: PdfBox;
    }
  | { op: "text"; id: number; docId: number; page: number }
  | { op: "outline"; id: number; docId: number }
  | { op: "find"; id: number; docId: number; page: number; query: string; caseSensitive: boolean }
  | { op: "cancel"; id: number }
  | { op: "close"; docId: number };

export type ViewerOpenTiming = {
  /** Waiting for the engine's wasm; about 0 once the worker has it. */
  engineMs: number;
  /** 0 for a file opened by range: its first reads overlap `engineMs`, and the rest are in `parseMs`. */
  fetchMs: number;
  parseMs: number;
  /** Bytes read before parsing; 0 for a file read by range. */
  bytes: number;
};

export type ViewerResult = {
  open: { pageCount: number; firstPage: ViewerPageInfo; ranged: boolean; timing: ViewerOpenTiming };
  pageInfo: ViewerPageInfo;
  render: {
    width: number;
    height: number;
    rgba: Uint8ClampedArray<ArrayBuffer>;
    /** A region's bitmap: its top-left in the whole page's bitmap, and that bitmap's size. */
    region?: { x: number; y: number; pageWidth: number; pageHeight: number };
  };
  text: { runs: ViewerTextRun[]; links: ViewerLink[] };
  find: ViewerFindHit[];
  outline: ViewerOutlineItem[];
};

export type ViewerFailure = { code: string; message: string };

export type ViewerResponse =
  | { id: number; ok: true; value: ViewerResult[keyof ViewerResult] }
  | { id: number; ok: false; error: ViewerFailure };
