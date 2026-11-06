import assert from "node:assert/strict";
import { test } from "node:test";

import { degrees, PDFDocument, PDFName } from "pdf-lib";

import { createPdfEngine, vectorMeasures } from "../src/index.ts";

const engine = await createPdfEngine();

async function paintedPdf(content: string, rotation = 0) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.setRotation(degrees(rotation));
  page.node.set(
    PDFName.of("Contents"),
    pdf.context.register(pdf.context.flateStream(content))
  );
  return await engine.open(await pdf.save());
}

test("filled rectangles: re under every fill operator; m/l only where re cannot be told apart", async () => {
  const rect = { left: 72, top: 492, right: 192, bottom: 692 };
  for (const operator of ["f", "f*", "B", "B*"]) {
    for (const path of [
      "72 100 120 200 re",
      "72 100 m 72 300 l 192 300 l 192 100 l",
    ]) {
      const doc = await paintedPdf(`${path} ${operator}`);
      try {
        const objects = doc.objects(0);
        // pdf.js counts only `re`, and so does the engine.
        const counted = path.endsWith(" re");
        assert.deepEqual(vectorMeasures(objects), {
          chartSegmentCount: 0,
          chartSegmentBounds: null,
          filledRectangles: counted ? [rect] : [],
        });
      } finally {
        doc.close();
      }
    }
  }
});

test("implicit fills match explicit closure in pixels and transformed subpath measurements", async () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const operator of ["f", "f*"]) {
      const paths = [
        "72 100 m 72 300 l 192 300 l 192 100 l",
        "220 100 m 220 400 l 250 400 l 250 100 l",
        "300 100 m 300 450 l 330 450 l 330 100 l",
      ];
      const docs = await Promise.all(
        [false, true].map((closed) =>
          paintedPdf(
            `0.75 0 0 0.75 20 30 cm ${paths.map((path) => `${path}${closed ? " h" : ""}`).join(" ")} ${operator}`,
            rotation
          )
        )
      );
      try {
        const [implicit, explicit] = docs;
        assert.ok(implicit && explicit);
        const objects = explicit.objects(0);
        const expected = vectorMeasures(objects);
        assert.equal(expected.filledRectangles.length, 0);
        assert.deepEqual(vectorMeasures(implicit.objects(0)), expected);
        assert.deepEqual(
          implicit.render(0, { width: 612 }),
          explicit.render(0, { width: 612 })
        );
      } finally {
        for (const doc of docs) {
          doc.close();
        }
      }
    }
  }
});

test("implicit closing diagonals count like explicit closing lines, but not for stroke-only paths", async () => {
  const path = "72 100 m 72 300 l 192 300 l";
  for (const operator of ["f", "f*", "B", "B*", "S"]) {
    const implicit = await paintedPdf(`${path} ${operator}`);
    const explicit = await paintedPdf(`${path} h ${operator}`);
    try {
      const measured = vectorMeasures(implicit.objects(0));
      assert.equal(measured.chartSegmentCount, operator === "S" ? 0 : 1);
      assert.deepEqual(measured.filledRectangles, []);
      if (operator === "f" || operator === "f*") {
        assert.deepEqual(measured, vectorMeasures(explicit.objects(0)));
      }
    } finally {
      implicit.close();
      explicit.close();
    }
  }
});

test("backtracking paths have no filled rectangles or dark pixels", async () => {
  const doc = await paintedPdf("72 72 m 112 72 l 112 112 l 112 72 l h f");
  try {
    assert.deepEqual(vectorMeasures(doc.objects(0)).filledRectangles, []);
    assert.ok(
      doc.render(0, { width: 612 }).rgba.every((value) => value >= 128)
    );
  } finally {
    doc.close();
  }
});

test("open non-rectangles and stroke-only rectangles are not filled bars", async () => {
  for (const content of [
    "72 72 m 112 72 l 112 112 l 112 72 l h f",
    "72 72 m 112 72 l 112 112 l 92 112 l f",
    "72 100 m 72 300 l 192 300 l 192 400 l f",
    "72 100 m 192 100 l 72 100 l 72 300 l f",
    "72 100 m 192 100 l 192 100 l 72 100 l f",
    "72 100 m 72 300 l 192 300 l 192 100 l h S",
  ]) {
    const doc = await paintedPdf(content);
    try {
      assert.deepEqual(vectorMeasures(doc.objects(0)).filledRectangles, []);
    } finally {
      doc.close();
    }
  }
});
