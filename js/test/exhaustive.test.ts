// Exhaustive small PDFs: every combination of page size, /Rotate, crop box,
// Standard 14 font and font size, written with pdf-lib so the truth is
// known. Each page is checked against what we wrote (not against another
// engine): its size in the viewer frame, every word, and each word's box
// containing the word's true glyph middle after crop and rotation.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { degrees, PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { boxAt, charsText, createPdfEngine } from "../src/index.ts";

const engine = await createPdfEngine();

const SIZES = [
  [612, 792],
  [300, 500],
] as const;
const ROTATIONS = [0, 90, 180, 270] as const;
const CROPS = [null, [10, 20, 30, 40]] as const; // inset left, bottom, right, top
const FONTS = [
  StandardFonts.Helvetica,
  StandardFonts.TimesRoman,
  StandardFonts.Courier,
] as const;
const FONT_SIZES = [9, 14] as const;
const SENTENCE = "Alpha Bravo Charlie Delta 1234";

type Case = {
  size: readonly [number, number];
  rotation: (typeof ROTATIONS)[number];
  crop: (typeof CROPS)[number];
  font: (typeof FONTS)[number];
  fontSize: number;
};

const cases: Case[] = SIZES.flatMap((size) =>
  ROTATIONS.flatMap((rotation) =>
    CROPS.flatMap((crop) =>
      FONTS.flatMap((font) =>
        FONT_SIZES.map((fontSize) => ({ size, rotation, crop, font, fontSize }))
      )
    )
  )
);

/** A PDF point to the viewer frame: crop origin removed, then /Rotate (clockwise). */
function toViewer(
  c: Case,
  px: number,
  py: number
): { x: number; y: number; width: number; height: number } {
  const [w0, h0] = c.size;
  const [l, b, r, t] = c.crop ?? [0, 0, 0, 0];
  const w = w0 - l - r;
  const h = h0 - b - t;
  const u = px - l;
  const v = py - b;
  const rotated = {
    0: { x: u, y: h - v, width: w, height: h },
    90: { x: v, y: u, width: h, height: w },
    180: { x: w - u, y: v, width: w, height: h },
    270: { x: h - v, y: w - u, width: h, height: w },
  } as const;
  return rotated[c.rotation];
}

test(`${cases.length} generated pages: size, words and word boxes equal what we wrote`, async () => {
  const pdf = await PDFDocument.create();
  const truths = [];
  for (const c of cases) {
    const font = await pdf.embedFont(c.font);
    const [w, h] = c.size;
    const page = pdf.addPage([w, h]);
    page.setRotation(degrees(c.rotation));
    if (c.crop) {
      const [l, b, r, t] = c.crop;
      page.setCropBox(l, b, w - l - r, h - b - t);
    }
    const x0 = 60;
    const y0 = 120;
    page.drawText(SENTENCE, { x: x0, y: y0, font, size: c.fontSize });
    // Each word's true glyph middle in PDF space, from the font's advances.
    let at = x0;
    const words = SENTENCE.split(" ").map((word) => {
      const width = font.widthOfTextAtSize(word, c.fontSize);
      const middle = { x: at + width / 2, y: y0 + c.fontSize * 0.35 };
      at += width + font.widthOfTextAtSize(" ", c.fontSize);
      return { word, middle };
    });
    truths.push({ c, words });
  }
  const doc = await engine.open(await pdf.save());
  try {
    assert.equal(doc.pageCount, cases.length);
    for (const [index, { c, words }] of truths.entries()) {
      const label = `${c.size.join("x")} rot ${c.rotation} crop ${c.crop ? "inset" : "none"} ${c.font} ${c.fontSize}`;
      const frame = toViewer(c, 0, 0);
      const info = doc.pageInfo(index);
      assert.ok(
        Math.abs(info.width - frame.width) < 0.01 &&
          Math.abs(info.height - frame.height) < 0.01,
        `${label}: size ${info.width}x${info.height}, wrote ${frame.width}x${frame.height}`
      );
      assert.equal(info.rotation, c.rotation, label);
      const text = doc.text(index);
      const found = Array.from({ length: text.words.count }, (_, w) => ({
        text: charsText(
          text,
          text.words.firstChar[w] ?? 0,
          text.words.lastChar[w] ?? 0
        ),
        box: boxAt(text.words.boxes, w),
      }));
      assert.deepEqual(
        found.map((w) => w.text),
        words.map((w) => w.word),
        label
      );
      for (const [i, { word, middle }] of words.entries()) {
        const p = toViewer(c, middle.x, middle.y);
        const box = found[i]?.box;
        assert.ok(
          box &&
            p.x >= box.x - 1 &&
            p.x <= box.x + box.width + 1 &&
            p.y >= box.y - 1 &&
            p.y <= box.y + box.height + 1,
          `${label}: "${word}" middle (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) outside ${JSON.stringify(box)}`
        );
      }
    }
  } finally {
    doc.close();
  }
});

test("page counts 1..64 and every page's index round-trip", async () => {
  for (const pages of [1, 2, 3, 7, 16, 17, 64]) {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < pages; i++) {
      pdf.addPage([100 + i, 200 + i]);
    }
    const doc = await engine.open(
      await pdf.save({ useObjectStreams: pages % 2 === 0 })
    );
    try {
      assert.equal(doc.pageCount, pages);
      for (let i = 0; i < pages; i++) {
        const info = doc.pageInfo(i);
        assert.deepEqual([info.width, info.height], [100 + i, 200 + i]);
      }
      assert.throws(() => doc.pageInfo(pages), RangeError);
    } finally {
      doc.close();
    }
  }
});

// An encrypted (AES-128) file whose page tree lives in object streams,
// with a span inserted near the head so every recorded offset is wrong.
// A repair has to know the file is encrypted before it reads the object streams, or it
// finds no pages. Made with MuPDF.
test("an encrypted object-stream file with shifted offsets opens, as other engines open it", async () => {
  const bytes = await readFile(
    new URL("fixtures/encrypted-objstm-shifted.pdf", import.meta.url)
  );
  const reference = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
  const doc = await engine.open(bytes);
  try {
    assert.equal(doc.pageCount, 3);
    assert.equal(doc.pageCount, reference.numPages);
    assert.match(doc.text(0).text, /Encrypted page 1/u);
  } finally {
    doc.close();
    await reference.destroy();
  }
});
