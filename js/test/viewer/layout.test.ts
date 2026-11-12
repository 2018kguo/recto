// The viewer's arithmetic: fit, paint density, the pixel budget, the zoom ladder, the page in view.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { clampZoom, exceedsCanvasBudget, fitScale, outputScale, pageAt, pixelCost, stepZoom, ZOOM_LEVELS } from "../../src/viewer/layout.ts";

const LETTER_AREA = 612 * 792;

describe("fitScale", () => {
  test("enlarges a page to fill the width, less the inset", () => {
    assert.equal(fitScale({ availableWidth: 1248, naturalWidth: 612, sideInsetPx: 24 }), 2);
  });
  test("shrinks a page for a narrow pane", () => {
    assert.ok(Math.abs(fitScale({ availableWidth: 390, naturalWidth: 612, sideInsetPx: 24 }) - 366 / 612) < 1e-12);
  });
  test("ignores a negative inset, and falls back to 1 for unusable measurements", () => {
    assert.equal(fitScale({ availableWidth: 612, naturalWidth: 612, sideInsetPx: -50 }), 1);
    for (const [availableWidth, naturalWidth] of [
      [0, 612],
      [Number.NaN, 612],
      [800, 0],
      [800, Number.POSITIVE_INFINITY],
      [10, 612],
    ] as const) {
      const scale = fitScale({ availableWidth, naturalWidth, sideInsetPx: 24 });
      assert.ok(Number.isFinite(scale) && scale > 0, `${availableWidth} / ${naturalWidth}`);
    }
  });
});

describe("outputScale", () => {
  test("paints more pixels as the page is shown larger", () => {
    // A page shown twice as wide gets twice the pixels, so it is no blurrier at 200%.
    assert.equal(outputScale({ devicePixelRatio: 2, displayScale: 1, pageArea: LETTER_AREA }), 2);
    assert.equal(outputScale({ devicePixelRatio: 2, displayScale: 2, pageArea: LETTER_AREA }), 4);
  });
  test("caps the pixels rather than ask for a canvas the browser hands back blank", () => {
    const poster = 3370 * 2384;
    const scale = outputScale({ devicePixelRatio: 2, displayScale: 4, pageArea: poster });
    assert.ok(scale * scale * poster <= 8_000_000 && scale > 0);
  });
  test("spends at most two device pixels per CSS pixel, and at least one", () => {
    assert.equal(outputScale({ devicePixelRatio: 3, displayScale: 1, pageArea: LETTER_AREA }), 2);
    // The ceiling is on the density: zoom still multiplies on top.
    assert.equal(outputScale({ devicePixelRatio: 3, displayScale: 1.5, pageArea: LETTER_AREA }), 3);
    assert.equal(outputScale({ devicePixelRatio: 0.5, displayScale: 2, pageArea: LETTER_AREA }), 2);
    assert.equal(outputScale({ devicePixelRatio: Number.NaN, displayScale: 1, pageArea: LETTER_AREA }), 1);
  });
  test("ignores an unusable page area or display scale", () => {
    for (const pageArea of [Number.NaN, 0, -1]) {
      assert.equal(outputScale({ devicePixelRatio: 2, displayScale: 1.5, pageArea }), 3);
    }
    for (const displayScale of [Number.NaN, 0, -2]) {
      assert.equal(outputScale({ devicePixelRatio: 2, displayScale, pageArea: LETTER_AREA }), 2);
    }
  });
});

describe("exceedsCanvasBudget", () => {
  const costAt = (areaMultiple: number, scale: number) => pixelCost({ outputScale: scale, pageArea: LETTER_AREA * areaMultiple });
  test("holds a pixel budget rather than a page count", () => {
    assert.equal(exceedsCanvasBudget({ liveCount: 12, livePixels: costAt(1, 2) * 12 }), false);
    assert.equal(exceedsCanvasBudget({ liveCount: 4, livePixels: costAt(1, 4) * 4 }), true);
  });
  test("a small page does not raise the allowance for the large ones beside it", () => {
    assert.equal(exceedsCanvasBudget({ liveCount: 5, livePixels: costAt(0.25, 1) + costAt(4, 2) * 4 }), true);
  });
  test("keeps a floor of live pages when one page eats the whole budget, and a ceiling however cheap", () => {
    assert.equal(exceedsCanvasBudget({ liveCount: 3, livePixels: 100_000_000 }), false);
    assert.equal(exceedsCanvasBudget({ liveCount: 4, livePixels: 100_000_000 }), true);
    assert.equal(exceedsCanvasBudget({ liveCount: 13, livePixels: 1000 }), true);
  });
  test("never evicts on an unusable measurement", () => {
    for (const livePixels of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      for (const liveCount of [12, 13]) {
        assert.equal(exceedsCanvasBudget({ liveCount, livePixels }), false);
      }
    }
  });
  test("an unpainted page costs nothing, never NaN", () => {
    for (const [scale, pageArea] of [
      [0, LETTER_AREA],
      [Number.NaN, LETTER_AREA],
      [-2, LETTER_AREA],
      [2, Number.NaN],
      [2, 0],
      [Number.POSITIVE_INFINITY, LETTER_AREA],
      [2, Number.POSITIVE_INFINITY],
    ]) {
      assert.equal(pixelCost({ outputScale: scale!, pageArea: pageArea! }), 0);
    }
    assert.equal(pixelCost({ outputScale: 2, pageArea: LETTER_AREA }), 4 * LETTER_AREA);
  });
});

describe("zoom ladder", () => {
  test("steps to the next level, from on or between levels, and stops at the ends", () => {
    assert.equal(stepZoom(1, 1), 1.25);
    assert.equal(stepZoom(1, -1), 0.75);
    // A pinch left it between steps: the next step is the next level, not a level past it.
    assert.equal(stepZoom(1.1, 1), 1.25);
    assert.equal(stepZoom(1.1, -1), 1);
    assert.equal(stepZoom(1.249, 1), 1.5);
    assert.equal(stepZoom(ZOOM_LEVELS.at(-1)!, 1), ZOOM_LEVELS.at(-1));
    assert.equal(stepZoom(ZOOM_LEVELS[0], -1), ZOOM_LEVELS[0]);
  });
  test("clamps a pinch to the ladder's ends", () => {
    assert.equal(clampZoom(100), 4);
    assert.equal(clampZoom(0.01), 0.25);
    assert.equal(clampZoom(Number.NaN), 1);
    assert.equal(clampZoom(1.7), 1.7);
  });
});

describe("pageAt", () => {
  // Pages 100 tall with 10 between: page i spans [110i, 110i + 100].
  const pages = Array.from({ length: 50 }, (_, i) => ({ top: 110 * i, bottom: 110 * i + 100 }));
  test("the page under the point, by binary search", () => {
    let measured = 0;
    const measure = (page: { top: number; bottom: number }) => {
      measured += 1;
      return page;
    };
    assert.equal(pageAt({ center: 2250, measure, pages }), 20);
    assert.ok(measured <= 10, `${measured} measurements for 50 pages`);
  });
  test("the nearest neighbour in a gap, and the ends past either side", () => {
    const measure = (page: { top: number; bottom: number }) => page;
    assert.equal(pageAt({ center: 102, measure, pages }), 0);
    assert.equal(pageAt({ center: 108, measure, pages }), 1);
    assert.equal(pageAt({ center: -50, measure, pages }), 0);
    assert.equal(pageAt({ center: 1e9, measure, pages }), 49);
    assert.equal(pageAt({ center: 5, measure, pages: [] }), 0);
  });
});
