import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { degrees, PDFDocument } from "pdf-lib";

import { createPdfEngine } from "../src/index.ts";

test("native ActualText parentheses retain semantic Unicode in RTL", async () => {
  // Chromium with an embedded DejaVu Sans subset, source: הסכם ABC 123 בתוקף (2026).
  const source = await PDFDocument.load(
    readFileSync(new URL("fixtures/chrome-mixed-rtl.pdf", import.meta.url))
  );
  const pdf = await PDFDocument.create();
  for (const rotation of [0, 90, 180, 270]) {
    const [page] = await pdf.copyPages(source, [0]);
    assert.ok(page);
    page.setRotation(degrees(rotation));
    pdf.addPage(page);
  }
  const engine = await createPdfEngine();
  const doc = await engine.open(await pdf.save());
  try {
    for (let index = 0; index < 4; index++) {
      assert.ok(doc.text(index).text.includes("בתוקף (2026)"));
    }
  } finally {
    doc.close();
  }
});
