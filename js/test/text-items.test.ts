// Text items, reading order and page measures against documents whose
// text, rotation and paths we wrote (synthetic-pdf.ts).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { degrees, PDFDocument, StandardFonts } from "pdf-lib";

import {
  annotationTextItems,
  BREAK_LINE,
  BREAK_SPACE,
  createPdfEngine,
  NOT_TEXT,
  type PdfDocument,
  readingOrder,
  rasterMeasures,
  showsGlyphs,
  textItems,
  vectorMeasures,
  visibleCodepoint,
} from "../src/index.ts";
import { syntheticPageText, syntheticPdf } from "./synthetic-pdf.ts";

const engine = await createPdfEngine();

/** Latin in three standard fonts and CJK in an embedded subset, on pages at every /Rotate. */
async function languageRotationsPdf(): Promise<Uint8Array> {
  const cjk = await PDFDocument.load(
    readFileSync(new URL("fixtures/cjk-embedded.pdf", import.meta.url))
  );
  const pdf = await PDFDocument.create();
  const fonts = await Promise.all(
    [StandardFonts.Helvetica, StandardFonts.TimesRoman, StandardFonts.Courier].map((font) =>
      pdf.embedFont(font)
    )
  );
  const [cjkPage] = await pdf.embedPdf(cjk);
  assert.ok(cjkPage);
  for (const rotation of [0, 90, 180, 270]) {
    const page = pdf.addPage([612, 792]);
    page.setRotation(degrees(rotation));
    for (const [i, font] of fonts.entries()) {
      page.drawText(`Line ${i} in font number ${i}, with some words`, {
        x: 72,
        y: 700 - i * 40,
        size: 12 + i * 4,
        font,
      });
    }
    page.drawPage(cjkPage, { x: 0, y: -300 });
  }
  return await pdf.save();
}

const words = (text: string) => text.split(/\s+/u).filter(Boolean);

const HELVETICA = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

/** One page drawing `content` with font /F1, cross-reference table and all. */
function pdfOf(content: string, font: string, page = "/MediaBox [0 0 400 200]"): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R ${page} /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    font,
  ];
  let body = "%PDF-1.7\n";
  const offsets = objects.map((object, i) => {
    const offset = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows.join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

test("letter spacing is no word gap, in every way a file can draw it", async () => {
  const helvetica = HELVETICA;
  const substituted =
    "<< /Type /Font /Subtype /TrueType /BaseFont /NoSuchFont /FirstChar 99 /LastChar 99 /Widths [300] /Encoding /WinAnsiEncoding >>";
  const cases = [
    ["2 Tc (Doc) Tj", helvetica, "Doc"],
    // A TJ cancelling Tc draws the letters tight, whichever way each goes.
    ["-3 Tc [(D)-300(o)-300(c)] TJ", helvetica, "Doc"],
    ["50 Tc [(D)5000(o)5000(c)] TJ", helvetica, "Doc"],
    // A substitute font's width stretch is not letter spacing.
    ["3 Tc (ccc) Tj", substituted, "ccc"],
  ] as const;
  for (const [ops, font, expected] of cases) {
    const content = `BT /F1 10 Tf 20 150 Td ${ops} ET`;
    const doc = await engine.open(pdfOf(content, font));
    try {
      const items = textItems(doc.text(0), doc.pageInfo(0));
      assert.equal(items.map((item) => item.str).join(" "), expected, ops);
    } finally {
      doc.close();
    }
  }
});

test("native language item bounds enclose their glyphs across fonts and rotations", async () => {
  const doc = await engine.open(await languageRotationsPdf());
  try {
    for (let p = 0; p < doc.pageCount; p++) {
      const info = doc.pageInfo(p);
      const page = doc.text(p);
      const plan = readingOrder(page, info);
      const items = textItems(page, info);
      assert.ok(items.length > 0);
      for (const [index, item] of items.entries()) {
        assert.ok(item.flow);
        const next = items[index + 1]?.flow?.index ?? plan.length;
        assert.ok(next > item.flow.index);
        const direction = item.direction ?? 0;
        const start =
          direction === 0
            ? item.x
            : direction === 90
              ? item.y
              : direction === 180
                ? -item.x
                : -item.y;
        assert.ok(item.width > 0 && item.height > 0);
        for (let k = item.flow.index; k < next; k++) {
          const c = plan.order[k] ?? 0;
          if (/\s/u.test(String.fromCodePoint(page.codepoints[c] ?? 0))) {
            continue;
          }
          const x = page.boxes[c * 4] ?? 0;
          const y = info.height - (page.boxes[c * 4 + 1] ?? 0);
          const w = page.boxes[c * 4 + 2] ?? 0;
          const h = page.boxes[c * 4 + 3] ?? 0;
          const [low, high] =
            direction === 0
              ? [x, x + w]
              : direction === 90
                ? [y - h, y]
                : direction === 180
                  ? [-x - w, -x]
                  : [-y, h - y];
          assert.ok(
            low >= start - 0.001 && high <= start + item.width + 0.001,
            `${item.str}: char ${c} outside item bounds`
          );
        }
      }
    }
  } finally {
    doc.close();
  }
});

test("text items read every page's words in order, upright or under /Rotate 90, 180, 270", async () => {
  // Page i has /Rotate (i % 4) * 90; content order breaks words on the
  // rotated ones, so those pages are read through the reflow.
  const doc = await engine.open(
    syntheticPdf({ pages: 4, charsPerPage: 200, vary: true })
  );
  try {
    for (let i = 0; i < 4; i++) {
      const info = doc.pageInfo(i);
      assert.equal(info.rotation, (i % 4) * 90);
      const items = textItems(doc.text(i), info);
      assert.deepEqual(
        words(items.map((item) => item.str).join(" ")),
        words(syntheticPageText(i, 200).join(" ")),
        `page ${i + 1}`
      );
      // Items carry the drawn em, and no item is empty.
      for (const item of items) {
        assert.ok(item.str.trim().length > 0);
        assert.ok(item.height > 0 && item.width > 0);
      }
    }
  } finally {
    doc.close();
  }
});

/** The plan as text: chars in reading order, a space or newline at each break. */
function planText(page: ReturnType<PdfDocument["text"]>, info: ReturnType<PdfDocument["pageInfo"]>): string {
  const plan = readingOrder(page, info);
  let out = "";
  for (let k = 0; k < plan.length; k++) {
    const brk = plan.breaks[k];
    out += brk === BREAK_LINE ? "\n" : brk === BREAK_SPACE ? " " : "";
    out += String.fromCodePoint(page.codepoints[plan.order[k] ?? 0] ?? 0);
  }
  return out;
}

test("a landscape page stored as /Rotate 90 reads its lines top to bottom, as displayed", async () => {
  // /Rotate 90 shows PDF (x, y) at viewer (y, x). Text turned a quarter
  // counter-clockwise on the page reads upright on screen, line i at viewer
  // y = 100 + 30i: the first line drawn is the top one.
  const lines = ["Success factor relevance by contract", "Relevance Yes Yes No Yes", "Third line here"];
  const content = lines
    .map((line, i) => `BT /F1 12 Tf 0 1 -1 0 ${100 + 30 * i} 72 Tm (${line}) Tj ET`)
    .join("\n");
  const doc = await engine.open(pdfOf(content, HELVETICA, "/MediaBox [0 0 612 792] /Rotate 90"));
  try {
    const info = doc.pageInfo(0);
    const page = doc.text(0);
    assert.equal(planText(page, info), lines.join("\n"));
    const items = textItems(page, info);
    assert.deepEqual(
      items.map((item) => item.str),
      lines
    );
    for (const [i, item] of items.entries()) {
      // Upright to the viewer, at the viewer position the matrix gave it (y up).
      assert.equal(item.direction, undefined, item.str);
      assert.ok(Math.abs(item.x - 72) < 0.01 && Math.abs(item.y - (612 - 100 - 30 * i)) < 0.01, item.str);
    }
  } finally {
    doc.close();
  }
});

test("sideways header cells read up the page as one row, in reading order", async () => {
  // A table whose header cells are turned a quarter counter-clockwise and
  // bottom-aligned on y = 700, then upright rows; and one sideways label
  // drawn as two runs ("% " then "Dissolved").
  const headers = [
    ["Drug", 100],
    ["Dose mg", 200],
    ["Route", 300],
  ] as const;
  const content = [
    ...headers.map(([text, x]) => `BT /F1 10 Tf 0 1 -1 0 ${x} 700 Tm (${text}) Tj ET`),
    "BT /F1 10 Tf 1 0 0 1 90 680 Tm (Aspirin 100 oral) Tj ET",
    "BT /F1 10 Tf 0 1 -1 0 60 500 Tm (% ) Tj ET",
    "BT /F1 10 Tf 0 1 -1 0 60 511.67 Tm (Dissolved) Tj ET",
  ].join("\n");
  // The same table on a /Rotate 90 page, landscape: the rows upright to the
  // viewer, the header cells reading up the screen above them. Viewer (X, Y)
  // is PDF (Y, X); a cell bottom-aligned on viewer Y = 130 starts at PDF x = 130.
  const turned = [
    ...headers.map(([text, x]) => `BT /F1 10 Tf -1 0 0 -1 130 ${x} Tm (${text}) Tj ET`),
    "BT /F1 10 Tf 0 1 -1 0 150 90 Tm (Aspirin 100 oral) Tj ET",
  ].join("\n");
  for (const [bytes, row] of [
    [pdfOf(content, HELVETICA, "/MediaBox [0 0 612 792]"), 700],
    [pdfOf(turned, HELVETICA, "/MediaBox [0 0 612 792] /Rotate 90"), 612 - 130],
  ] as const) {
    const doc = await engine.open(bytes);
    try {
      const info = doc.pageInfo(0);
      const items = textItems(doc.text(0), info);
      assert.deepEqual(
        items.slice(0, 4).map((item) => item.str),
        ["Drug", "Dose mg", "Route", "Aspirin 100 oral"],
        `rotation ${info.rotation}`
      );
      // Each cell reads up the page (90 counter-clockwise) from the shared
      // baseline start: one row, left to right.
      for (const [i, item] of items.slice(0, 3).entries()) {
        assert.equal(item.direction, 90, item.str);
        assert.ok(Math.abs(item.y - row) < 0.01, `${item.str} starts at ${item.y}`);
        assert.ok(Math.abs(item.x - (headers[i]?.[1] ?? 0)) < 0.01, `${item.str} at ${item.x}`);
      }
      if (info.rotation === 0) {
        // The label's two runs join in the order they read, up the page.
        const label = items.at(-1);
        assert.deepEqual([label?.str, label?.direction], ["% Dissolved", 90]);
        assert.ok(Math.abs((label?.y ?? 0) - 500) < 0.01 && label?.x === 60);
      }
    } finally {
      doc.close();
    }
  }
});

test("reading order marks each written line break", async () => {
  const doc = await engine.open(
    syntheticPdf({ pages: 2, charsPerPage: 400, vary: true })
  );
  try {
    for (const i of [0, 1]) {
      const plan = readingOrder(doc.text(i), doc.pageInfo(i));
      let lines = 1;
      for (let k = 0; k < plan.length; k++) {
        if (plan.breaks[k] === BREAK_LINE) {
          lines += 1;
        }
      }
      assert.equal(lines, syntheticPageText(i, 400).length, `page ${i + 1}`);
    }
  } finally {
    doc.close();
  }
});

test("page measures: filled rectangles are found, no raster, glyphs shown", async () => {
  const doc = await engine.open(
    syntheticPdf({ pages: 1, charsPerPage: 40, pathsPerPage: 12 })
  );
  try {
    const { text, objects } = doc.scan(0);
    const info = doc.pageInfo(0);
    const vector = vectorMeasures(objects);
    assert.equal(vector.filledRectangles.length, 12);
    assert.equal(vector.chartSegmentCount, 0);
    for (const box of vector.filledRectangles) {
      assert.ok(box.right > box.left && box.bottom > box.top);
    }
    const raster = rasterMeasures(objects.images, info.width * info.height);
    assert.deepEqual(raster, { largestImageRatio: 0, rasterCoverageRatio: 0 });
    assert.equal(showsGlyphs(text), true);
  } finally {
    doc.close();
  }
});

test("annotation text items: FreeText contents and field values fill their rect", () => {
  const box = { x: 100, y: 200, width: 300, height: 40 };
  const { items, read } = annotationTextItems(
    [
      { subtype: 3, box, contents: "SECTION 3\nCLINICAL", field: null },
      { subtype: 13, box, contents: "a note", field: null },
      { subtype: 20, box, contents: "", field: { type: "Tx", value: "Jane" } },
      { subtype: 20, box, contents: "", field: { type: "Btn", value: "Yes" } },
    ],
    { height: 792 }
  );
  assert.deepEqual(
    items.map((item) => item.str),
    ["SECTION 3", "CLINICAL", "Jane"]
  );
  assert.deepEqual([...read], [0, 2]);
  // Two lines share the rect: each is half its height, top line first.
  assert.equal(items[0]?.height, 20);
  assert.ok((items[0]?.y ?? 0) > (items[1]?.y ?? 0));
});

test("zero-width break hints are not text; a no-break space reads as a space", () => {
  // "anti-\u00adIL5": a soft hyphen after a hard one must not split the word.
  for (const code of [0xad, 0x20_0b, 0x20_60, 0xfe_ff]) {
    assert.equal(visibleCodepoint(code), NOT_TEXT);
  }
  assert.equal(visibleCodepoint(0xa0), 0x20);
  assert.equal(visibleCodepoint(0x02), 0x2d);
  // "anti-" then the line-end mark: one hyphen, not "anti--".
  assert.equal(visibleCodepoint(0x02, 0x2d), NOT_TEXT);
  assert.equal(visibleCodepoint(0x41), 0x41);
});

test("invisible hints cannot change text item spacing or geometry", () => {
  const page = (hint: string) => {
    const chars = [...`anti-${hint}IL5\u00a0B\nC`];
    let x = 72;
    let y = 30;
    const boxes: number[] = [];
    const fontIds: number[] = [];
    const runIds: number[] = [];
    for (const char of chars) {
      if (char === "\n") {
        y = 70;
        x = 72;
      }
      const hidden = char === hint && hint !== "";
      boxes.push(...(hidden ? [300, 5, 20, 48] : [x, y - 10, 6, 12]));
      fontIds.push(hidden ? 1 : 0);
      runIds.push(hidden ? 1 : y === 30 ? 0 : 2);
      if (!hidden) {
        x += 6;
      }
    }
    return {
      count: chars.length,
      codepoints: Uint32Array.from(chars, (char) => char.codePointAt(0) ?? 0),
      flags: new Uint8Array(chars.length),
      angles: new Float32Array(chars.length),
      boxes: Float32Array.from(boxes),
      fontIds: Int32Array.from(fontIds),
      fontSizes: Float32Array.from(fontIds, (font) => (font === 1 ? 48 : 12)),
      runIds: Int32Array.from(runIds),
      runs: {
        count: 3,
        origins: Float32Array.from([72, 30, 300, 5, 72, 70]),
        ems: Float32Array.from([12, 48, 12]),
      },
    };
  };
  const info = { width: 400, height: 200, rotation: 0 as const };
  const expected = textItems(page(""), info);
  assert.deepEqual(
    expected.map((item) => item.str),
    ["anti-IL5 B", "C"]
  );
  assert.equal(expected[1]?.flow?.breakBefore, "line");
  for (const hint of ["\u200b", "\u2060", "\ufeff", "\u00ad"]) {
    assert.deepEqual(
      textItems(page(hint), info),
      expected,
      hint.codePointAt(0)?.toString(16)
    );
  }
});
