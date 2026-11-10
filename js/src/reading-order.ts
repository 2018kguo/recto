// The order a page's chars are read in, and where the word and line breaks
// fall, as flat arrays over the page's char columns.
//
// On an upright page the order is the content stream's, and generated chars
// (a space at a gap, CR LF at a new line) mark the breaks. On a page displayed
// with /Rotate 90, 180 or 270, content order can split words and lines along
// the wrong axis and reverse runs on a 180 page. There the chars are laid out again in the frame
// the text reads in: each char's box is turned back by the page rotation
// less its own angle, clustered into lines across that frame, sorted along
// it, and a space marked where a gap is wider than a word gap.
//
// Data-oriented: the plan is two typed columns (`order`, `breaks`) over
// char indices; the reflow sorts an index array, never char objects.

import { CHAR_GENERATED, type PdfPageInfo, type PdfPageText } from "./document.ts";

export const BREAK_NONE = 0;
export const BREAK_SPACE = 1;
export const BREAK_LINE = 2;

export type ReadingOrder = {
  /** Char indices in reading order: real chars only (no generated chars, no CR/LF). */
  order: Uint32Array<ArrayBuffer>;
  /** BREAK_NONE | BREAK_SPACE | BREAK_LINE before `order[k]`. */
  breaks: Uint8Array<ArrayBuffer>;
  length: number;
};

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
/** Break hints without a visible glyph, even when the font supplies bounds. */
export function isInvisibleCodepoint(code: number): boolean {
  return (
    code === 0xad || code === 0x20_0b || code === 0x20_60 || code === 0xfe_ff
  );
}
/** A gap wider than this share of the font height is a word break (pdf.js's TRACKING_SPACE_FACTOR band starts at 0.102). */
const WORD_GAP_RATIO = 0.15;
/** Chars whose centres are within this share of their height across the reading axis share a line. */
const LINE_TOLERANCE_RATIO = 0.5;

/** Content order, with its generated chars turned into breaks. */
function streamOrder(
  page: Pick<PdfPageText, "count" | "codepoints" | "flags">
): ReadingOrder {
  const { count, codepoints, flags } = page;
  const order = new Uint32Array(count);
  const breaks = new Uint8Array(count);
  let length = 0;
  let pending = BREAK_NONE;
  for (let i = 0; i < count; i++) {
    const code = codepoints[i] ?? 0;
    if (isInvisibleCodepoint(code)) {
      continue;
    }
    if ((flags[i] ?? 0) & CHAR_GENERATED) {
      pending = Math.max(
        pending,
        code === LF ? BREAK_LINE : code === SPACE ? BREAK_SPACE : BREAK_NONE
      );
      continue;
    }
    if (code === CR || code === LF) {
      pending = BREAK_LINE;
      continue;
    }
    order[length] = i;
    breaks[length] = length === 0 ? BREAK_NONE : pending;
    pending = BREAK_NONE;
    length += 1;
  }
  return { order, breaks, length };
}

/**
 * Quarter turns clockwise in the viewer frame that a char reads along: the
 * page's clockwise /Rotate plus the char's angle, snapped to 0, 1, 2, 3. A
 * char's angle is `atan2(c, a)`, which grows clockwise on the page (text
 * turned θ counter-clockwise reads 2π - θ), so the two turns add.
 */
export function viewerTurn(rotation: number, angle: number): number {
  const degrees = rotation + (angle * 180) / Math.PI;
  return ((Math.round(degrees / 90) % 4) + 4) % 4;
}

/**
 * Reflow for a rotated page. Each char's box centre and extent go into the
 * frame its text reads in (x along the line, y down the page), then lines
 * are clustered by y and read by x.
 */
function reflowedOrder(
  page: Pick<
    PdfPageText,
    "count" | "codepoints" | "flags" | "boxes" | "angles"
  >,
  info: Pick<PdfPageInfo, "width" | "height" | "rotation">
): ReadingOrder {
  const { count, codepoints, flags, boxes, angles } = page;
  // Real, visible chars and their reading-frame geometry, as columns.
  const ids = new Uint32Array(count);
  const along = new Float64Array(count);
  const across = new Float64Array(count);
  const start = new Float64Array(count);
  const end = new Float64Array(count);
  const size = new Float64Array(count);
  const turnOf = new Uint8Array(count);
  const generatedBreaks = new Uint32Array(count + 1);
  let n = 0;
  for (let i = 0; i < count; i++) {
    const code = codepoints[i] ?? 0;
    const generated = ((flags[i] ?? 0) & CHAR_GENERATED) !== 0;
    generatedBreaks[i + 1] =
      (generatedBreaks[i] ?? 0) +
      (generated && (code === SPACE || code === CR || code === LF) ? 1 : 0);
    if (generated || isInvisibleCodepoint(code) || code === CR || code === LF) {
      continue;
    }
    const x = boxes[4 * i] ?? 0;
    const y = boxes[4 * i + 1] ?? 0;
    const w = boxes[4 * i + 2] ?? 0;
    const h = boxes[4 * i + 3] ?? 0;
    const turn = viewerTurn(info.rotation, angles[i] ?? 0);
    // (along, across) of the box's two corners in the reading frame.
    let a0: number;
    let a1: number;
    let c0: number;
    let c1: number;
    if (turn === 0) {
      [a0, a1, c0, c1] = [x, x + w, y, y + h];
    } else if (turn === 1) {
      // Reads down the viewer frame; later lines further left.
      [a0, a1, c0, c1] = [y, y + h, info.width - (x + w), info.width - x];
    } else if (turn === 2) {
      [a0, a1, c0, c1] = [
        info.width - (x + w),
        info.width - x,
        info.height - (y + h),
        info.height - y,
      ];
    } else {
      [a0, a1, c0, c1] = [info.height - (y + h), info.height - y, x, x + w];
    }
    ids[n] = i;
    turnOf[n] = turn;
    start[n] = a0;
    end[n] = a1;
    along[n] = (a0 + a1) / 2;
    across[n] = (c0 + c1) / 2;
    size[n] = Math.max(c1 - c0, 0.01);
    n += 1;
  }
  // Lines: sort by turn, then across; a new line starts where the centre
  // moves past the tolerance. Native traversal within a line is independent
  // of the page rotation. The turns come in the order the content stream
  // first draws them, as on an upright page: a table's sideways header row
  // drawn before its rows reads before them.
  const turnRank = [n, n, n, n];
  for (let k = n - 1; k >= 0; k--) {
    turnRank[turnOf[k] ?? 0] = k;
  }
  const byLine = Array.from({ length: n }, (_, k) => k).toSorted(
    (p, q) =>
      (turnRank[turnOf[p] ?? 0] ?? 0) - (turnRank[turnOf[q] ?? 0] ?? 0) ||
      (across[p] ?? 0) - (across[q] ?? 0)
  );
  const lineOf = new Uint32Array(n);
  let line = 0;
  for (let k = 1; k < byLine.length; k++) {
    const p = byLine[k - 1] ?? 0;
    const q = byLine[k] ?? 0;
    if (
      turnOf[p] !== turnOf[q] ||
      (across[q] ?? 0) - (across[p] ?? 0) >
        LINE_TOLERANCE_RATIO * Math.max(size[p] ?? 0, size[q] ?? 0)
    ) {
      line += 1;
    }
    lineOf[q] = line;
  }
  const reading = byLine.toSorted(
    (p, q) =>
      (lineOf[p] ?? 0) - (lineOf[q] ?? 0) || (ids[p] ?? 0) - (ids[q] ?? 0)
  );
  const order = new Uint32Array(n);
  const breaks = new Uint8Array(n);
  for (let k = 0; k < reading.length; k++) {
    const q = reading[k] ?? 0;
    order[k] = ids[q] ?? 0;
    if (k === 0) {
      continue;
    }
    const p = reading[k - 1] ?? 0;
    if (lineOf[p] !== lineOf[q]) {
      breaks[k] = BREAK_LINE;
    } else {
      const first = Math.min(ids[p] ?? 0, ids[q] ?? 0);
      const last = Math.max(ids[p] ?? 0, ids[q] ?? 0);
      const hasBreak =
        (generatedBreaks[last] ?? 0) > (generatedBreaks[first + 1] ?? 0);
      const gap = Math.max(
        (start[q] ?? 0) - (end[p] ?? 0),
        (start[p] ?? 0) - (end[q] ?? 0)
      );
      // Native rotation can generate a break inside a word. Conversely,
      // loose CJK boxes can have a gap without a word boundary at all.
      if (
        hasBreak &&
        gap > WORD_GAP_RATIO * Math.max(size[p] ?? 0, size[q] ?? 0)
      ) {
        breaks[k] = BREAK_SPACE;
      }
    }
  }
  return { order, breaks, length: n };
}

export function readingOrder(
  page: Pick<
    PdfPageText,
    "count" | "codepoints" | "flags" | "boxes" | "angles"
  >,
  info: Pick<PdfPageInfo, "width" | "height" | "rotation">
): ReadingOrder {
  return info.rotation === 0 ? streamOrder(page) : reflowedOrder(page, info);
}
