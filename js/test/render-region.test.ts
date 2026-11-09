// Rendering part of a page: a region's pixels are the whole page's, at the same scale.

import assert from "node:assert/strict";
import { test } from "node:test";

import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";

import { createPdfEngine, PdfError, type PdfBitmap, type PdfBox, type PdfDocument } from "../src/index.ts";
import { pdfOf } from "./transparency-cases.mjs";

const engine = await createPdfEngine();

/**
 * A page of text, strokes, fills and curves that reach its edges, at a rotation, with a crop box
 * offset from the media box when asked.
 */
async function drawnPage(rotation: number, crop: boolean): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 300]);
  page.drawRectangle({ x: -10, y: -10, width: 120.3, height: 80.7, color: rgb(0.9, 0.2, 0.1) });
  page.drawEllipse({ x: 250.4, y: 160.2, xScale: 90.3, yScale: 61.7, borderColor: rgb(0, 0.3, 0.8), borderWidth: 3.3 });
  page.drawLine({ start: { x: 3.1, y: 297.6 }, end: { x: 397.2, y: 2.4 }, thickness: 0.7, color: rgb(0, 0, 0) });
  page.drawText("Region rendering, every pixel", { x: 31.7, y: 211.3, size: 17.3, font });
  page.drawText("rotated text", { x: 300, y: 40, size: 11, font, rotate: degrees(33) });
  page.setRotation(degrees(rotation));
  if (crop) {
    page.setCropBox(37.5, 23.25, 311, 241.5);
  }
  return await pdf.save();
}

/**
 * How `region` differs from the same pixels of `whole`: the largest channel difference, and the
 * share of pixels that differ at all.
 */
function diffFromCrop(whole: PdfBitmap, region: PdfBitmap & { x: number; y: number }): { most: number; share: number } {
  let most = 0;
  let differ = 0;
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const a = ((region.y + y) * whole.width + region.x + x) * 4;
      const b = (y * region.width + x) * 4;
      let pixel = 0;
      for (let c = 0; c < 4; c++) {
        pixel = Math.max(pixel, Math.abs((whole.rgba[a + c] ?? 0) - (region.rgba[b + c] ?? 0)));
      }
      most = Math.max(most, pixel);
      differ += pixel > 0 ? 1 : 0;
    }
  }
  return { most, share: differ / (region.width * region.height) };
}

/**
 * The tolerance: an anti-aliased edge's coverage, computed from coordinates a whole number of
 * pixels apart, can round differently, by 1 or 2 of 255 on under 1% of the pixels. (Measured here:
 * 272 of 334 regions exact, the rest off by 1 on at most 0.22%.) A region in the wrong place is off
 * by far more.
 */
function assertSameAsCrop(whole: PdfBitmap, region: PdfBitmap & { x: number; y: number }, at: string): void {
  const { most, share } = diffFromCrop(whole, region);
  assert.ok(most <= 2 && share < 0.01, `${at}: off by up to ${most} on ${(share * 100).toFixed(3)}% of pixels`);
}

/** Points to pixels as the engine takes them: a coordinate within 1/1024 px of a whole one is that. */
const snap = (v: number) => (Math.abs(v - Math.round(v)) <= 1 / 1024 ? Math.round(v) : v);

/** Regions as fractions of the page: whole, fractional inside, at each corner, past the edges, thin. */
const REGIONS: [number, number, number, number][] = [
  [0, 0, 1, 1],
  [0.137, 0.271, 0.413, 0.329],
  [0, 0, 0.25, 0.25],
  [0.75, 0.75, 0.25, 0.25],
  [0.6, -0.2, 0.7, 0.5],
  [-0.1, 0.5, 0.3, 0.9],
  [0.5, 0.003, 0.0011, 0.9],
];

function regionOf(doc: PdfDocument, page: number, [fx, fy, fw, fh]: [number, number, number, number]): PdfBox {
  const { width, height } = doc.pageInfo(page);
  return { x: fx * width, y: fy * height, width: fw * width, height: fh * height };
}

test("a region's pixels are the whole render's, at every rotation and with a crop box", async () => {
  for (const rotation of [0, 90, 180, 270]) {
    for (const crop of [false, true]) {
      const doc = await engine.open(await drawnPage(rotation, crop));
      const label = `rotation ${rotation}${crop ? ", cropped" : ""}`;
      const info = doc.pageInfo(0);
      assert.equal(info.rotation, rotation);
      for (const width of [517, 1200]) {
        const whole = doc.render(0, { width, maxHeight: Infinity });
        assert.ok(whole.rgba.some((v) => v < 128), label);
        for (const fractions of REGIONS) {
          const region = regionOf(doc, 0, fractions);
          const part = doc.render(0, { width, maxHeight: Infinity, region });
          const at = `${label}, ${width} px, region ${fractions}`;
          // Where it is: the region grown out to whole pixels and cut to the page, by the bitmap's
          // own scale (its size over the page's).
          const sx = whole.width / info.width;
          const sy = whole.height / info.height;
          const x0 = Math.max(0, Math.floor(snap(region.x * sx)));
          const y0 = Math.max(0, Math.floor(snap(region.y * sy)));
          assert.deepEqual(
            [part.x, part.y, part.width, part.height, part.pageWidth, part.pageHeight],
            [
              x0,
              y0,
              Math.min(whole.width, Math.ceil(snap((region.x + region.width) * sx))) - x0,
              Math.min(whole.height, Math.ceil(snap((region.y + region.height) * sy))) - y0,
              whole.width,
              whole.height,
            ],
            at
          );
          assert.equal(part.rgba.length, part.width * part.height * 4, at);
          assertSameAsCrop(whole, part, at);
          assert.equal(part.truncated, whole.truncated, at);
        }
      }
      // renderAsync takes the same region and draws the same pixels.
      const region = regionOf(doc, 0, [0.2, 0.3, 0.5, 0.4]);
      const sync = doc.render(0, { width: 800, region });
      const sliced = await doc.renderAsync(0, { width: 800, region, sliceMs: 1 });
      assert.deepEqual([sliced.x, sliced.y, sliced.width, sliced.height], [sync.x, sync.y, sync.width, sync.height]);
      assert.ok(Buffer.from(sliced.rgba).equals(Buffer.from(sync.rgba)), label);
      doc.close();
    }
  }
});

test("a region of pixels named by the bitmap's own scale lands on them exactly", async () => {
  const doc = await engine.open(await drawnPage(90, true));
  const info = doc.pageInfo(0);
  const whole = doc.render(0, { width: 777, maxHeight: Infinity });
  const sx = whole.width / info.width;
  const sy = whole.height / info.height;
  // 64 px tiles: points from pixels by the same scales, so float error mustn't grow a tile.
  for (let ty = 0; ty < whole.height; ty += 64) {
    for (let tx = 0; tx < whole.width; tx += 64) {
      const w = Math.min(64, whole.width - tx);
      const h = Math.min(64, whole.height - ty);
      const tile = doc.render(0, { width: 777, maxHeight: Infinity, region: { x: tx / sx, y: ty / sy, width: w / sx, height: h / sy } });
      assert.deepEqual([tile.x, tile.y, tile.width, tile.height], [tx, ty, w, h]);
      assertSameAsCrop(whole, tile, `tile ${tx},${ty}`);
    }
  }
  doc.close();
});

test("an image in a region is within 2 of 255 of the whole render", async () => {
  // A 23 by 17 RGB image of a gradient, drawn over most of the page at a scale that isn't whole.
  const w = 23;
  const h = 17;
  const pixels = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    pixels.set([(i * 37) % 256, (i * 11) % 256, (i * 5) % 256], i * 3);
  }
  const content = "q 331.7 0 0 247.3 20.1 30.9 cm /Im Do Q";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Rotate 90 /Contents 4 0 R /Resources << /XObject << /Im 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const head = new TextEncoder().encode(out);
  const imageHead = new TextEncoder().encode(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`);
  const imageTail = new TextEncoder().encode("\nendstream\nendobj\n");
  offsets.push(head.length);
  const xrefAt = head.length + imageHead.length + pixels.length + imageTail.length;
  const trailer = new TextEncoder().encode(
    `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  );
  const bytes = Buffer.concat([head, imageHead, pixels, imageTail, trailer]);
  const doc = await engine.open(bytes);
  for (const width of [313, 900]) {
    const whole = doc.render(0, { width });
    for (const fractions of REGIONS) {
      const part = doc.render(0, { width, region: regionOf(doc, 0, fractions) });
      assertSameAsCrop(whole, part, `${width} px, region ${fractions}`);
    }
  }
  doc.close();
});

test("a region of a page far past a whole render's limits: drawn, in memory the region's size", async () => {
  // A black square whose edges fall inside pixels, so the coverage at each edge can be checked.
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  page.drawRectangle({ x: 100.3, y: 100.6, width: 50.2, height: 40.1, color: rgb(0, 0, 0) });
  const doc = await engine.open(await pdf.save());
  doc.render(0, { width: 100 });
  const before = engine.stats().heapBytes;
  // 200,000 px wide: 500 px a point. The whole page would be 200,000 by 150,000 px, 120 GB.
  const scale = 500;
  const left = 100.3 * scale;
  const top = (300 - 100.6 - 40.1) * scale;
  const part = doc.render(0, {
    width: 400 * scale,
    maxHeight: Infinity,
    region: { x: (left - 100) / scale, y: (top - 50) / scale, width: 256 / scale, height: 256 / scale },
  });
  assert.deepEqual([part.width, part.height, part.pageWidth, part.pageHeight], [256, 256, 400 * scale, 300 * scale]);
  assert.ok(engine.stats().heapBytes - before < 16 * 1024 * 1024, `grew ${engine.stats().heapBytes - before} bytes`);
  // The square's top-left corner at (left, top), 100 and 50 px into the region (both whole here:
  // 100.3 * 500 and 159.3 * 500). Left of it and above it white, inside black.
  const at = (x: number, y: number) => part.rgba[((y - part.y) * part.width + (x - part.x)) * 4] ?? -1;
  for (const y of [top + 10, top + 200]) {
    assert.equal(at(left - 1, y), 255, `left of the edge, row ${y}`);
    assert.equal(at(left, y), 0, `the edge, row ${y}`);
    assert.equal(at(left + 150, y), 0, `inside, row ${y}`);
  }
  assert.equal(at(left + 10, top - 1), 255);
  assert.equal(at(left + 10, top), 0);
  doc.close();
});

test("a mesh shading in a region costs the region, not the page at that scale", async () => {
  // A type 4 mesh: one triangle across the page, red, green and blue at its corners.
  const doc = await engine.open(
    pdfOf({
      content: "/S sh",
      resources: "/Shading <</S 5 0 R>>",
      objects: [
        {
          dict: " /ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 100 0 100 0 1 0 1 0 1]",
          data: "\x00\x00\x00\xff\x00\x00\x00\xff\x00\x00\xff\x00\x00\x00\xff\x00\x00\xff\x00\x00\xff",
        },
      ],
    })
  );
  const whole = doc.render(0, { width: 600 });
  for (const box of [{ x: 10.3, y: 40.1, width: 30.7, height: 22.2 }, { x: 60, y: 70, width: 40, height: 30 }]) {
    assertSameAsCrop(whole, doc.render(0, { width: 600, region: box }), `mesh ${JSON.stringify(box)}`);
  }
  // At 100,000 px wide the whole page's mesh would be sampled over 10^10 pixels: the region's are.
  const before = engine.stats().heapBytes;
  const part = doc.render(0, { width: 100_000, maxHeight: Infinity, region: { x: 40, y: 40, width: 0.5, height: 0.5 } });
  assert.deepEqual([part.width, part.height], [500, 500]);
  assert.ok(engine.stats().heapBytes - before < 64 * 1024 * 1024, `grew ${engine.stats().heapBytes - before} bytes`);
  assert.ok(part.rgba.some((v, i) => i % 4 !== 3 && v < 250), "the mesh is drawn");
  doc.close();
});

test("a tiling pattern repeats in a region as it does across the whole page", async () => {
  // The pattern fills the page's right half; a region over only a few points of it still repeats
  // the tile, as the page's render does, and doesn't draw the copies across the region instead.
  const doc = await engine.open(
    pdfOf({
      content: "/Pattern cs /P scn 50 0 50 100 re f 0 0 1 rg 0 0 50 50 re f",
      resources: "/Pattern <</P 5 0 R>>",
      objects: [{ dict: " /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10", data: "1 0 0 rg 0 0 5 5 re f" }],
    })
  );
  for (const width of [97, 233, 1000]) {
    const whole = doc.render(0, { width, maxHeight: Infinity });
    for (const box of [{ x: 10.84, y: 26.77, width: 45.58, height: 57.12 }, { x: 48.2, y: 3.3, width: 4.1, height: 7.7 }, { x: 70.1, y: 60.6, width: 29.9, height: 9.1 }]) {
      // Within 2, as an edge is; here the edge is the pattern's, a column of this small region.
      const { most } = diffFromCrop(whole, doc.render(0, { width, maxHeight: Infinity, region: box }));
      assert.ok(most <= 2, `pattern at ${width} px, ${JSON.stringify(box)}: off by up to ${most}`);
    }
  }
  doc.close();
});

test("a region's arguments: checked as a render's are", async () => {
  const doc = await engine.open(await drawnPage(0, false));
  const render = (options: Parameters<PdfDocument["render"]>[1]) => () => doc.render(0, options);
  for (const region of [
    { x: 0, y: 0, width: 0, height: 10 },
    { x: 0, y: 0, width: 10, height: -1 },
    { x: Number.NaN, y: 0, width: 10, height: 10 },
    { x: 0, y: Infinity, width: 10, height: 10 },
  ]) {
    assert.throws(render({ width: 400, region }), RangeError, JSON.stringify(region));
  }
  // Without a region a render is at most 16,384 px wide; with one, the page may be 262,144.
  assert.throws(render({ width: 20_000 }), RangeError);
  assert.equal(doc.render(0, { width: 20_000, maxHeight: Infinity, region: { x: 0, y: 0, width: 1, height: 1 } }).width, 50);
  assert.throws(render({ width: 300_000, region: { x: 0, y: 0, width: 1, height: 1 } }), RangeError);
  // Off the page, and too large a region: the engine's refusal.
  const failed = (error: unknown) => error instanceof PdfError && error.code === "failed";
  assert.throws(render({ width: 400, region: { x: 500, y: 0, width: 10, height: 10 } }), failed);
  assert.throws(render({ width: 100_000, maxHeight: Infinity, region: { x: 0, y: 0, width: 400, height: 10 } }), failed);
  // A whole page's limits don't apply to a region's page: this one is 75,000 px tall.
  assert.equal(doc.render(0, { width: 100_000, maxHeight: Infinity, region: { x: 0, y: 0, width: 4, height: 4 } }).pageHeight, 75_000);
  doc.close();
});
