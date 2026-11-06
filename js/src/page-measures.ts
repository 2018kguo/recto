// What a page paints, measured over its page objects and chars: raster
// coverage, vector chart segments and filled rectangles, and whether the
// text layer shows glyphs. A caller applies its own thresholds to these. Boxes are in the viewer frame.

import {
  CHAR_GENERATED,
  CHAR_UNMAPPED,
  PATH_FILL,
  type PdfPageObjects,
  SEGMENT_BEZIER,
  SEGMENT_LINE,
  SEGMENT_MOVE,
  SEGMENT_RECT,
} from "./document.ts";

/** left/top/right/bottom, top < bottom (viewer frame). */
export type PageBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** pdf.js's lineTo test: a chart segment moves in both axes by more than this. */
const CHART_SEGMENT_MIN_DELTA = 0.01;
const AXIS_TOLERANCE = 0.01;

/**
 * The raster measures over a page's image objects: the largest image's
 * share of the page and the summed share (overlaps count twice).
 */
export function rasterMeasures(
  images: PdfPageObjects["images"],
  pageArea: number
): { largestImageRatio: number; rasterCoverageRatio: number } {
  let largest = 0;
  let total = 0;
  for (let k = 0; k < images.count; k++) {
    const area =
      Math.max(0, images.boxes[4 * k + 2] ?? 0) *
      Math.max(0, images.boxes[4 * k + 3] ?? 0);
    largest = Math.max(largest, area);
    total += area;
  }
  return {
    largestImageRatio: pageArea > 0 ? largest / pageArea : 0,
    rasterCoverageRatio: pageArea > 0 ? total / pageArea : 0,
  };
}

/** The axis-aligned box of a filled four-sided subpath, or null. */
function rectangleOf(
  points: Float32Array,
  kinds: Uint8Array,
  from: number,
  to: number
): PageBox | null {
  // MOVE then three or four LINEs (the fourth returning to the start).
  const lines = to - from - 1;
  if (lines !== 3 && lines !== 4) {
    return null;
  }
  for (let s = from + 1; s < to; s++) {
    if (((kinds[s] ?? 0) & 3) !== SEGMENT_LINE) {
      return null;
    }
  }
  const sx = points[2 * from] ?? 0;
  const sy = points[2 * from + 1] ?? 0;
  if (
    lines === 4 &&
    (Math.abs((points[2 * (to - 1)] ?? 0) - sx) > AXIS_TOLERANCE ||
      Math.abs((points[2 * (to - 1) + 1] ?? 0) - sy) > AXIS_TOLERANCE)
  ) {
    return null;
  }
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let previousHorizontal: boolean | null = null;
  // Fill closes the last edge even without `h`. Alternating nonzero edges
  // reject backtracking paths whose bounding box has area but fill does not.
  for (let s = from; s < from + 4; s++) {
    const x = points[2 * s] ?? 0;
    const y = points[2 * s + 1] ?? 0;
    const next = s === from + 3 ? from : s + 1;
    const dx = Math.abs((points[2 * next] ?? 0) - x);
    const dy = Math.abs((points[2 * next + 1] ?? 0) - y);
    const horizontal = dy <= AXIS_TOLERANCE && dx > AXIS_TOLERANCE;
    const vertical = dx <= AXIS_TOLERANCE && dy > AXIS_TOLERANCE;
    if ((!horizontal && !vertical) || previousHorizontal === horizontal) {
      return null;
    }
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    previousHorizontal = horizontal;
  }
  return right - left > 0 && bottom - top > 0
    ? { left, top, right, bottom }
    : null;
}

/**
 * Over a page's painted path objects: the line segments that move in both
 * x and y by more than 0.01 plus curves (a cubic is three Bezier points,
 * counted once), the union box of the paths that have any, and the
 * rectangles of filled paths (four-sided axis-aligned subpaths, implicitly
 * closed by fill; `re` is stored that way, so m/l/l/l rectangles count too).
 */
export function vectorMeasures(
  objects: Pick<PdfPageObjects, "paths" | "segments">
) {
  const { paths, segments } = objects;
  const { points, kinds } = segments;
  let chartSegmentCount = 0;
  let chartSegmentBounds: PageBox | null = null;
  const filledRectangles: PageBox[] = [];
  for (let p = 0; p < paths.count; p++) {
    const from = paths.start[p] ?? 0;
    const to = paths.start[p + 1] ?? from;
    const filled = ((paths.flags[p] ?? 0) & PATH_FILL) !== 0;
    let pathChartSegments = 0;
    let beziers = 0;
    let subpathStart = from;
    for (let s = from; s <= to; s++) {
      const kind = (kinds[s] ?? 0) & 3;
      if (s === to || kind === SEGMENT_MOVE) {
        // pdf.js counts only `re` rectangles, and so does this.
        const drawnByRe = ((kinds[subpathStart] ?? 0) & SEGMENT_RECT) !== 0;
        if (filled && s > subpathStart) {
          const rect = drawnByRe
            ? rectangleOf(points, kinds, subpathStart, s)
            : null;
          if (rect) {
            filledRectangles.push(rect);
          }
          const dx =
            (points[2 * (s - 1)] ?? 0) - (points[2 * subpathStart] ?? 0);
          const dy =
            (points[2 * (s - 1) + 1] ?? 0) -
            (points[2 * subpathStart + 1] ?? 0);
          if (
            Math.abs(dx) > CHART_SEGMENT_MIN_DELTA &&
            Math.abs(dy) > CHART_SEGMENT_MIN_DELTA
          ) {
            pathChartSegments += 1;
          }
        }
        subpathStart = s;
        continue;
      }
      if (kind === SEGMENT_BEZIER) {
        beziers += 1;
        continue;
      }
      if (kind === SEGMENT_LINE && s > from) {
        const dx = (points[2 * s] ?? 0) - (points[2 * s - 2] ?? 0);
        const dy = (points[2 * s + 1] ?? 0) - (points[2 * s - 1] ?? 0);
        if (
          Math.abs(dx) > CHART_SEGMENT_MIN_DELTA &&
          Math.abs(dy) > CHART_SEGMENT_MIN_DELTA
        ) {
          pathChartSegments += 1;
        }
      }
    }
    // A cubic is three Bezier points.
    pathChartSegments += Math.ceil(beziers / 3);
    if (pathChartSegments > 0) {
      chartSegmentCount += pathChartSegments;
      const x = paths.boxes[4 * p] ?? 0;
      const y = paths.boxes[4 * p + 1] ?? 0;
      const box = {
        left: x,
        top: y,
        right: x + (paths.boxes[4 * p + 2] ?? 0),
        bottom: y + (paths.boxes[4 * p + 3] ?? 0),
      };
      chartSegmentBounds = chartSegmentBounds
        ? {
            left: Math.min(chartSegmentBounds.left, box.left),
            top: Math.min(chartSegmentBounds.top, box.top),
            right: Math.max(chartSegmentBounds.right, box.right),
            bottom: Math.max(chartSegmentBounds.bottom, box.bottom),
          }
        : box;
    }
  }
  return { chartSegmentCount, chartSegmentBounds, filledRectangles };
}

/** Whether a page's text layer shows glyphs (non-space or unmapped chars). */
export function showsGlyphs(text: {
  count: number;
  codepoints: Uint32Array;
  flags: Uint8Array;
}): boolean {
  for (let i = 0; i < text.count; i++) {
    const flags = text.flags[i] ?? 0;
    if (flags & CHAR_GENERATED) {
      continue;
    }
    if (
      flags & CHAR_UNMAPPED ||
      String.fromCodePoint(text.codepoints[i] ?? 0x20).trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}
