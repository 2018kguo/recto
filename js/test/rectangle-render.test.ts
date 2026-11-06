import assert from "node:assert/strict";
import { test } from "node:test";

import { PDFDocument, rgb } from "pdf-lib";

import { createPdfEngine } from "../src/index.ts";

test("filled rectangles preserve fractional pixel coverage", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([100, 100]);
  page.drawRectangle({
    x: 20.25,
    y: 30.25,
    width: 35.5,
    height: 20.5,
    color: rgb(0, 0, 0),
    borderWidth: 0,
  });
  const engine = await createPdfEngine();
  const doc = await engine.open(await pdf.save());
  try {
    const rendered = doc.render(0, { width: 100, maxHeight: 100 });
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const coverageX = Math.max(
          0,
          Math.min(x + 1, 55.75) - Math.max(x, 20.25)
        );
        const coverageY = Math.max(
          0,
          Math.min(y + 1, 69.75) - Math.max(y, 49.25)
        );
        const expected = 255 * (1 - coverageX * coverageY);
        const offset = (y * 100 + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          assert.ok(
            Math.abs((rendered.rgba[offset + channel] ?? 0) - expected) <= 2,
            `pixel ${x},${y}, channel ${channel}: area coverage ${expected}`
          );
        }
        assert.equal(rendered.rgba[offset + 3], 255);
      }
    }
  } finally {
    doc.close();
  }
});
