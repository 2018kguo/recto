import assert from "node:assert/strict";
import { test } from "node:test";

import { degrees, PDFDocument, PDFName } from "pdf-lib";

import { createPdfEngine } from "../src/index.ts";

const engine = await createPdfEngine();
type Rectangle = readonly [number, number, number, number];

function rectangle(
  [x, y, w, h]: Rectangle,
  split: boolean,
  implicit: boolean
): string {
  if (!split) {
    if (implicit) {
      return `${x} ${y} m ${x + w} ${y} l ${x + w} ${y + h} l ${x} ${y + h} l`;
    }
    return `${x} ${y} ${w} ${h} re`;
  }
  // Collinear vertices force the general path renderer, without changing ink.
  return `${x} ${y} m ${x + w / 2} ${y} l ${x + w} ${y} l
    ${x + w} ${y + h / 2} l ${x + w} ${y + h} l
    ${x + w / 2} ${y + h} l ${x} ${y + h} l h`;
}

async function pairedPdf(
  rectangles: readonly Rectangle[],
  {
    rotation = 0,
    prefix = "",
    size = 32,
    operation = "f",
    implicit = false,
  } = {}
) {
  const pdf = await PDFDocument.create();
  for (const split of [false, true]) {
    const page = pdf.addPage([size, size]);
    page.setRotation(degrees(rotation));
    page.node.set(
      PDFName.of("Resources"),
      pdf.context.obj({
        ExtGState: {
          Translucent: { Type: "ExtGState", ca: 0.5 },
          Multiply: { Type: "ExtGState", BM: "Multiply" },
        },
      })
    );
    page.node.set(
      PDFName.of("Contents"),
      pdf.context.register(
        pdf.context.flateStream(
          `${prefix}\n${rectangles
            .map(
              (r, i) =>
                `${(i % 5) / 5} g ${rectangle(r, split, implicit)} ${operation}`
            )
            .join("\n")}`
        )
      )
    );
  }
  return await engine.open(await pdf.save());
}

test("rectangle AA preserves fractional edges, corners and subpixel slivers", async () => {
  for (const [left, top, width, height] of [
    [2.25, 3.5, 4.5, 6.25],
    [2.3, 3.7, 4.2, 6.1],
    [2.25, 3.25, 0.25, 0.25],
    [2.996_093_75, 3.003_906_25, 0.007_812_5, 2.5],
  ] as const) {
    const doc = await pairedPdf([[left, 32 - top - height, width, height]]);
    try {
      const image = doc.render(0, { width: 32 });
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const dx = Math.max(
            0,
            Math.min(x + 1, left + width) - Math.max(x, left)
          );
          const dy = Math.max(
            0,
            Math.min(y + 1, top + height) - Math.max(y, top)
          );
          const expected = 255 * (1 - dx * dy);
          const pixel = (y * 32 + x) * 4;
          for (let c = 0; c < 3; c++) {
            assert.ok(
              Math.abs((image.rgba[pixel + c] ?? -255) - expected) <= 2,
              `edge/corner at ${x},${y}: ${image.rgba[pixel + c]} vs ${expected}`
            );
          }
          assert.equal(image.rgba[pixel + 3], 255);
        }
      }
    } finally {
      doc.close();
    }
  }
});

test("rectangle AA agrees with general paths across winding, rotation, transforms and clipping", async () => {
  const rectangles: Rectangle[] = [
    [2.3, 3.7, 4.2, 6.1],
    [12.1, 17.6, -7.8, -0.3],
    [-0.25, -0.5, 2.75, 1.3],
    [30.75, 31.125, 4.25, 7.5],
    [5.003_906_25, 3.996_093_75, 0.007_812_5, 0.015_625],
    [2.9, 4.1, 0.0001, 0.5],
    [18.1, 12.4, 1.3, -5.5],
    [29.8, 15.3, -5.1, 6.4],
  ];
  for (const rotation of [0, 90, 180, 270]) {
    for (const prefix of [
      "",
      "0.2 0.6 0.8 rg 0 0 32 32 re f",
      "-1 0 0 1 32 0 cm",
      "0 1 -1 0 32 0 cm",
      "1.2 0 0 0.7 0.3 2.4 cm",
      "1 0.2 -0.1 1 0 0 cm",
      "1.3 2.1 27.5 25.7 re W n",
      "1 1 m 31 1 l 16 30 l h W n",
      "/Translucent gs",
      "0.2 g 0 0 32 32 re f /Multiply gs",
    ]) {
      const doc = await pairedPdf(rectangles, { rotation, prefix });
      try {
        for (const width of [32, 97, 256]) {
          const actual = doc.render(0, { width });
          const expected = doc.render(1, { width });
          // The engine has no rectangle fast path; its clip and fill coverage
          // differ by at most one level.
          for (let i = 0; i < actual.rgba.length; i++) {
            assert.ok(
              Math.abs((actual.rgba[i] ?? 0) - (expected.rgba[i] ?? 0)) <= 1
            );
          }
        }
      } finally {
        doc.close();
      }
    }
  }
  for (const [operation, implicit] of [
    ["f*", false],
    ["B", false],
    ["B*", false],
    ["f", true],
  ] as const) {
    const doc = await pairedPdf(rectangles, { operation, implicit });
    try {
      const a = doc.render(0, { width: 97 });
      const b = doc.render(1, { width: 97 });
      assert.ok(a.rgba.every((v, i) => Math.abs(v - (b.rgba[i] ?? 0)) <= 1));
    } finally {
      doc.close();
    }
  }
});
