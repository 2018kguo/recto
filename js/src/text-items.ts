// A page's text as pdf.js-style text items (getTextContent's `str`, origin,
// width along the line, height across it, reading direction), made from
// the engine's chars, for code written against pdf.js text items.
//
// Items split at font changes, line breaks, gaps wider than 0.6 em, and
// baseline shifts over 0.25 em. Word breaks come from the reading plan,
// not loose glyph boxes: those are ink bounds, not character advances.
// Logical order and word breaks survive item splits in `flow`.
//
// Each item's baseline and em come from its text object (origin and
// matrix, `PdfPageText.runs`), as pdf.js's do; a char's box is the
// fallback. Coordinates: the viewer frame with y up (x right, y = page
// height - viewer y). An item's direction is the way its chars read in
// that frame, so text on a /Rotate 90 page that reads sideways to the
// viewer is laid out in its own frame.
//
// Data-oriented: one pass over the reading order's index column; the only
// objects made are the items returned.

import {
  ANNOT_SUBTYPE,
  type PdfAnnotation,
  type PdfPageInfo,
  type PdfPageText,
} from "./document.ts";
import {
  BREAK_LINE,
  BREAK_SPACE,
  isInvisibleCodepoint,
  readingOrder,
  viewerTurn,
} from "./reading-order.ts";

const SPACE_IN_FLOW_MAX_FACTOR = 0.6;
const VERTICAL_SHIFT_RATIO = 0.25;
/** Share of the em below the baseline in the layout's box rule (1 - GLYPH_ASCENT). */
const DESCENT_SHARE = 0.2;
const HYPHEN_MARK = 0x02;
const HYPHEN = 0x2d;

/** The token direction (counter-clockwise, y up) of a clockwise viewer turn. */
const DIRECTION_OF_TURN = [0, 270, 180, 90] as const;

function isSpaceCode(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0xa0 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x30_00 ||
    (code >= 0x20_00 && code <= 0x20_0a)
  );
}

export const NOT_TEXT = -1;
const DASHES = new Set([HYPHEN, 0x20_10, 0x20_11, 0x20_13, 0x20_14]);

/**
 * The char as text, or NOT_TEXT for a zero-width break hint. The engine marks a
 * hyphen it reads as a line-end hyphenation with U+0002 (the page shows a
 * hyphen); a no-break space reads as a space. Some PDFs put a soft hyphen
 * after every hard one ("anti-\u00adIL5"): kept, it splits the word for search.
 */
export function visibleCodepoint(code: number, previous = 0): number {
  if (code === HYPHEN_MARK) {
    // A line-end soft hyphen right after a hard one ("anti-" U+0002): the
    // page shows one hyphen.
    return DASHES.has(previous) ? NOT_TEXT : HYPHEN;
  }
  if (code === 0xa0) {
    return 0x20;
  }
  return isInvisibleCodepoint(code) ? NOT_TEXT : code;
}

/** One text item, in the viewer frame with y up. */
export type PdfTextItem = {
  str: string;
  /** Logical char order and word break, independent of painted boxes. */
  flow?: { index: number; breakBefore: "none" | "space" | "line" };
  /** The item's origin: its start on the baseline. */
  x: number;
  y: number;
  /** Advance along the reading direction, and the em across it. */
  width: number;
  height: number;
  /** Counter-clockwise reading direction; absent when upright. */
  direction?: 90 | 180 | 270;
};

export function textItems(
  page: Pick<
    PdfPageText,
    | "count"
    | "codepoints"
    | "flags"
    | "boxes"
    | "angles"
    | "fontIds"
    | "fontSizes"
    | "runIds"
    | "runs"
  >,
  info: Pick<PdfPageInfo, "width" | "height" | "rotation">
): PdfTextItem[] {
  const { codepoints, boxes, angles, fontIds, fontSizes, runIds, runs } = page;
  const plan = readingOrder(page, info);
  const height = info.height;
  const tokens: PdfTextItem[] = [];

  // The open item, as scalars (no per-char objects).
  let open = false;
  let str = "";
  let direction = 0;
  let font = -1;
  let size = 0;
  let em = 1;
  // Reading frame: `along` grows in the reading direction, `across` is the
  // baseline offset; the item's start, end and baseline.
  let startAlong = 0;
  let endAlong = 0;
  let baseline = 0;
  let previousStart = 0;
  let previousEnd = 0;
  let flowIndex = 0;
  let breakBefore: "none" | "space" | "line" = "none";
  /** A space glyph since the last char. */
  let sawSpace = false;

  const flush = () => {
    if (open && str.trim().length > 0) {
      // The run's origin (its start on the baseline) back in token space.
      const [x, y] =
        direction === 0
          ? [startAlong, baseline]
          : direction === 90
            ? [-baseline, startAlong]
            : direction === 180
              ? [-startAlong, -baseline]
              : [baseline, -startAlong];
      tokens.push({
        str,
        flow: { index: flowIndex, breakBefore },
        x,
        y,
        width: Math.max(0, endAlong - startAlong),
        height: em,
        ...(direction === 0 ? {} : { direction: direction as 90 | 180 | 270 }),
      });
    }
    open = false;
    str = "";
  };

  for (let k = 0; k < plan.length; k++) {
    const i = plan.order[k] ?? 0;
    const code = codepoints[i] ?? 0;
    const lineBreak = plan.breaks[k] === BREAK_LINE;
    if (lineBreak) {
      flush();
      sawSpace = false;
    }
    // The engine's own word break (a generated space, from glyph origins and
    // advances) counts like a space glyph: a char box can be wider than its
    // advance (a bullet, a bold face), and then the box gap alone hides it.
    if (plan.breaks[k] === BREAK_SPACE) {
      sawSpace = true;
    }
    if (isSpaceCode(code)) {
      sawSpace = true;
      continue;
    }
    const visible = visibleCodepoint(
      code,
      k > 0 ? (codepoints[plan.order[k - 1] ?? 0] ?? 0) : 0
    );
    if (visible === NOT_TEXT) {
      continue;
    }
    const vx = boxes[4 * i] ?? 0;
    const vy = boxes[4 * i + 1] ?? 0;
    const vw = boxes[4 * i + 2] ?? 0;
    const vh = boxes[4 * i + 3] ?? 0;
    // The char's box in token space (y up).
    const x0 = vx;
    const x1 = vx + vw;
    const y0 = height - (vy + vh);
    const y1 = height - vy;
    const turn = viewerTurn(info.rotation, angles[i] ?? 0);
    const dir = DIRECTION_OF_TURN[turn] ?? 0;
    // Along/across extents for this direction, and the char's em.
    let a0: number;
    let a1: number;
    let charBaseline: number;
    let charEm: number;
    if (dir === 0) {
      [a0, a1] = [x0, x1];
      charEm = y1 - y0;
      charBaseline = y0 + DESCENT_SHARE * charEm;
    } else if (dir === 90) {
      [a0, a1] = [y0, y1];
      charEm = x1 - x0;
      charBaseline = -(x1 - DESCENT_SHARE * charEm);
    } else if (dir === 180) {
      [a0, a1] = [-x1, -x0];
      charEm = y1 - y0;
      charBaseline = -(y1 - DESCENT_SHARE * charEm);
    } else {
      [a0, a1] = [-y1, -y0];
      charEm = x1 - x0;
      charBaseline = x0 + DESCENT_SHARE * charEm;
    }
    // The run's baseline and drawn size where the engine gives them (the text
    // object's origin and matrix); the box's split is the fallback.
    const run = runIds[i] ?? -1;
    const runEm = run >= 0 ? (runs.ems[run] ?? 0) : 0;
    if (runEm > 0) {
      const ox = runs.origins[2 * run] ?? 0;
      const oy = height - (runs.origins[2 * run + 1] ?? 0);
      charEm = runEm;
      charBaseline = dir === 0 ? oy : dir === 90 ? -ox : dir === 180 ? -oy : ox;
    }
    charEm = Math.max(charEm, 0.01);
    const charFont = fontIds[i] ?? -1;
    const charSize = fontSizes[i] ?? 0;
    let joinWithSpace = false;
    // Logical RTL chars move backwards. Compare adjacent glyphs, not the
    // growing item's right edge, and retain the union as its geometry.
    const advance = Math.max(a0 - previousEnd, previousStart - a1);
    if (open) {
      const sameRun =
        dir === direction && charFont === font && charSize === size;
      const shift = Math.abs(charBaseline - baseline);
      if (
        !sameRun ||
        shift > VERTICAL_SHIFT_RATIO * em ||
        advance > SPACE_IN_FLOW_MAX_FACTOR * em
      ) {
        flush();
      } else if (sawSpace) {
        // A space glyph in the stream is a word break even where the font's
        // char boxes overlap it (pdf.js measures the glyph's advance).
        joinWithSpace = true;
      }
    }
    if (!open) {
      open = true;
      flowIndex = k;
      breakBefore = lineBreak ? "line" : sawSpace ? "space" : "none";
      direction = dir;
      font = charFont;
      size = charSize;
      em = charEm;
      startAlong = a0;
      endAlong = a1;
      baseline = charBaseline;
    }
    if (joinWithSpace) {
      str += " ";
    }
    sawSpace = false;
    str += String.fromCodePoint(visible);
    endAlong = Math.max(endAlong, a1);
    startAlong = Math.min(startAlong, a0);
    previousStart = a0;
    previousEnd = a1;
  }
  flush();
  return tokens;
}

/**
 * Text that annotations show and the page's content stream does not: a
 * FreeText's /Contents and a text or choice field's value, as pdf.js
 * exposes them (`textContent` on getAnnotations). Each line becomes an item
 * filling its share of the annotation's rect, in the same frame as
 * `textItems`. `read` lists the annotations (by index) turned into items,
 * so a caller can tell glyphs it read from glyphs it did not.
 */
export function annotationTextItems(
  annotations: readonly PdfAnnotationText[],
  info: Pick<PdfPageInfo, "height">
): { items: PdfTextItem[]; read: Set<number> } {
  const items: PdfTextItem[] = [];
  const read = new Set<number>();
  for (const [index, annotation] of annotations.entries()) {
    const lines = annotationShownText(annotation)
      .split(/\r\n|\r|\n/u)
      .filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      continue;
    }
    const { x, y, width, height } = annotation.box;
    const top = info.height - y;
    const lineHeight = Math.max(height / lines.length, 1);
    for (const [i, line] of lines.entries()) {
      items.push({
        str: line,
        x,
        y: top - lineHeight * (i + 1) + lineHeight * DESCENT_SHARE,
        width: Math.max(width, 0),
        height: lineHeight,
      });
    }
    read.add(index);
  }
  return { items, read };
}

/** What an annotation shows as text: a FreeText's /Contents, a text or choice field's value. */
export function annotationShownText(annotation: PdfAnnotationText): string {
  if (annotation.subtype === ANNOT_SUBTYPE.freeText) {
    return annotation.contents;
  }
  if (
    annotation.field &&
    (annotation.field.type === "Tx" || annotation.field.type === "Ch")
  ) {
    return annotation.field.value;
  }
  return "";
}

/**
 * Everything an annotation shows as text, for an extractor: what
 * `annotationShownText` reads, else the text its appearance paints (a
 * stamp's words, a list box's options).
 */
export function annotationPaintedText(
  annotation: PdfAnnotationText & Pick<PdfAnnotation, "appearanceText">
): string {
  return annotationShownText(annotation).trim() || annotation.appearanceText;
}

type PdfAnnotationText = Pick<
  PdfAnnotation,
  "subtype" | "box" | "contents" | "field"
>;
