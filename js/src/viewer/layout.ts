// The viewer's arithmetic, apart from the DOM: how large a page is shown, how many pixels to paint
// for it, how many painted pages to keep, and the zoom ladder.

/** Device pixels painted per CSS pixel of a displayed page, at most. */
const MAX_CANVAS_DENSITY = 2;
// Refuse to ask for a canvas larger than browsers reliably allocate. Safari silently hands back a
// blank canvas above roughly 16M pixels.
const MAX_CANVAS_PIXELS = 8_000_000;
// Painted pixels held at once across all pages, and the most pages kept regardless. Holding the
// pixel budget flat means zooming in trades live page count for sharpness rather than growing memory.
const CANVAS_PIXEL_BUDGET = 24_000_000;
const MAX_LIVE_CANVASES = 12;
const MIN_LIVE_CANVASES = 3;

export const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
/** Steps land on the ladder: within this factor of a level counts as on it. */
const ZOOM_LEVEL_TOLERANCE = 1.01;

/** The scale that fits a page `naturalWidth` points wide into `availableWidth` less a side inset. */
export function fitScale({
  availableWidth,
  naturalWidth,
  sideInsetPx,
}: {
  availableWidth: number;
  naturalWidth: number;
  sideInsetPx: number;
}): number {
  if (!Number.isFinite(availableWidth) || !Number.isFinite(naturalWidth) || availableWidth <= 0 || naturalWidth <= 0) {
    return 1;
  }
  const fitWidth = availableWidth - Math.max(0, sideInsetPx);
  return fitWidth > 0 ? fitWidth / naturalWidth : 1;
}

/**
 * Device pixels to paint per point of a page displayed `displayScale` CSS pixels per point. A page
 * shown 1.5x larger needs 1.5x the pixels to stay as sharp. Capped by area, since the alternative is
 * the blank canvas a browser hands back past its limit.
 */
export function outputScale({
  devicePixelRatio,
  displayScale,
  pageArea,
}: {
  devicePixelRatio: number;
  displayScale: number;
  /** In points². */
  pageArea: number;
}): number {
  const density = Number.isFinite(devicePixelRatio) ? Math.max(1, Math.min(MAX_CANVAS_DENSITY, devicePixelRatio)) : 1;
  const scale = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
  const wanted = density * scale;
  if (!(Number.isFinite(pageArea) && pageArea > 0)) {
    return wanted;
  }
  // Area grows with the square of the scale, so the pixel ceiling is a scale ceiling by square root.
  return Math.min(wanted, Math.sqrt(MAX_CANVAS_PIXELS / pageArea));
}

/** The device pixels one painted page holds. */
export function pixelCost({ outputScale, pageArea }: { outputScale: number; pageArea: number }): number {
  if (!(Number.isFinite(outputScale) && Number.isFinite(pageArea) && outputScale > 0 && pageArea > 0)) {
    return 0;
  }
  return pageArea * outputScale * outputScale;
}

/**
 * Whether the painted pages cost more than the budget allows. Aggregate, not per page: a page count
 * derived from one page's cost is only right when every page is the same size. The floor keeps enough
 * pages to cover a scroll even when one page costs more than the whole budget.
 */
export function exceedsCanvasBudget({ liveCount, livePixels }: { liveCount: number; livePixels: number }): boolean {
  if (!(Number.isFinite(livePixels) && livePixels > 0)) {
    return false;
  }
  if (liveCount > MAX_LIVE_CANVASES) {
    return true;
  }
  return livePixels > CANVAS_PIXEL_BUDGET && liveCount > MIN_LIVE_CANVASES;
}

/** The next level up (1) or down (-1) the ladder from `current`, which may sit between levels. */
export function stepZoom(current: number, direction: -1 | 1, levels: readonly number[] = ZOOM_LEVELS): number {
  if (direction === 1) {
    return levels.find((level) => level > current * ZOOM_LEVEL_TOLERANCE) ?? levels.at(-1) ?? current;
  }
  return levels.findLast((level) => level < current / ZOOM_LEVEL_TOLERANCE) ?? levels[0] ?? current;
}

/** `current` scaled by a pinch's `factor`, held within the ladder's ends. */
export function clampZoom(zoom: number, levels: readonly number[] = ZOOM_LEVELS): number {
  const min = levels[0] ?? 0.1;
  const max = levels.at(-1) ?? 10;
  return Number.isFinite(zoom) ? Math.min(max, Math.max(min, zoom)) : 1;
}

/** Pages stack in order: the page under `center`, or its nearest neighbour in a gap. Binary search. */
export function pageAt<Page>({
  center,
  measure,
  pages,
}: {
  center: number;
  measure: (page: Page) => { top: number; bottom: number };
  pages: readonly Page[];
}): number {
  let low = 0;
  let high = pages.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const page = pages[middle];
    if (page !== undefined && measure(page).bottom < center) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const nextPage = pages[low];
  const next = nextPage === undefined ? undefined : measure(nextPage);
  if (next && next.top <= center) {
    return low;
  }
  const previousPage = pages[low - 1];
  const previous = previousPage === undefined ? undefined : measure(previousPage);
  if (!previous) {
    return next ? low : 0;
  }
  if (!next) {
    return low - 1;
  }
  const distance = ({ top, bottom }: { top: number; bottom: number }) => Math.abs((top + bottom) / 2 - center);
  return distance(previous) <= distance(next) ? low - 1 : low;
}
