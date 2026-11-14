import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { crc32, deflateSync } from "node:zlib";

import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import {
  ANNOT_SUBTYPE,
  boxAt,
  CHAR_GENERATED,
  CHAR_UNMAPPED,
  charsText,
  createPdfEngine,
  PATH_FILL,
  type PdfBox,
  PdfError,
} from "../src/index.ts";
import { pagePdf, tensorPdf } from "./rare-pdfs.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";
import { startRangeServer } from "./range-server.ts";

const fixture = (name: string) =>
  readFile(new URL(`fixtures/${name}`, import.meta.url));

const engine = await createPdfEngine();

/** pdf.js's view of the same bytes. */
async function pdfjsOpen(bytes: Uint8Array) {
  return await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    verbosity: 0,
  }).promise;
}

async function pdfjsError(bytes: Uint8Array): Promise<string> {
  try {
    await (await pdfjsOpen(bytes)).destroy();
    return "opened";
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

async function engineError(bytes: Uint8Array): Promise<string> {
  try {
    (await engine.open(bytes)).close();
    return "opened";
  } catch (error) {
    return error instanceof PdfError ? error.code : String(error);
  }
}

/** pdf.js's error names for the failures both engines report. */
const PDFJS_NAMES: Record<string, string> = {
  "invalid-file": "InvalidPDFException",
  "password-required": "PasswordException",
  opened: "opened",
};

const HELVETICA_SIZE = 12;
const WORDS = ["Alpha", "Bravo", "Charlie"];

/** Pages whose text, geometry and pixels we wrote, so the truth is known. */
async function truthPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const line = WORDS.join(" ");
  const lefts = WORDS.map(
    (_, i) =>
      50 +
      font.widthOfTextAtSize(
        WORDS.slice(0, i).join(" ") + (i ? " " : ""),
        HELVETICA_SIZE
      )
  );
  for (const rotation of [0, 90]) {
    const page = pdf.addPage([400, 300]);
    page.setRotation(degrees(rotation));
    page.drawText(line, { x: 50, y: 200, size: HELVETICA_SIZE, font });
    page.drawRectangle({
      x: 50,
      y: 20,
      width: 100,
      height: 40,
      color: rgb(0, 0, 0),
    });
  }
  const odd = pdf.addPage([300, 500]);
  odd.setRotation(degrees(270));
  const cropped = pdf.addPage([600, 800]);
  cropped.setCropBox(100, 100, 300, 200);
  pdf.addPage([200, 200]).setRotation(degrees(180));
  return { bytes: await pdf.save(), lefts };
}
const truth = await truthPdf();

const spans = (box: PdfBox, axis: "x" | "y", at: number) =>
  axis === "x"
    ? box.x <= at && at <= box.x + box.width
    : box.y <= at && at <= box.y + box.height;

test("page count, sizes and rotation match pdf.js", async () => {
  const docs = [
    truth.bytes,
    syntheticPdf({ pages: 12, vary: true }),
    await fixture("linearized.pdf"),
  ];
  for (const bytes of docs) {
    const reference = await pdfjsOpen(bytes);
    const doc = await engine.open(bytes);
    try {
      assert.equal(doc.pageCount, reference.numPages);
      for (let i = 0; i < doc.pageCount; i++) {
        const page = await reference.getPage(i + 1);
        const viewport = page.getViewport({ scale: 1 });
        const info = doc.pageInfo(i);
        assert.equal(info.rotation, page.rotate);
        assert.ok(
          Math.abs(info.width - viewport.width) < 0.01,
          `page ${i + 1} width`
        );
        assert.ok(
          Math.abs(info.height - viewport.height) < 0.01,
          `page ${i + 1} height`
        );
      }
    } finally {
      doc.close();
      await reference.destroy();
    }
  }
});

test("text and word boxes match the text we wrote, upright and rotated", async () => {
  const doc = await engine.open(truth.bytes);
  try {
    for (const [pageIndex, rotation] of [
      [0, 0],
      [1, 90],
    ] as const) {
      const text = doc.text(pageIndex);
      assert.match(text.text, /Alpha Bravo Charlie/);
      const words = Array.from({ length: text.words.count }, (_, w) => ({
        text: charsText(
          text,
          text.words.firstChar[w] ?? 0,
          text.words.lastChar[w] ?? 0
        ),
        box: boxAt(text.words.boxes, w),
      }));
      assert.deepEqual(
        words.map((w) => w.text),
        WORDS
      );
      const glyphMiddle = 200 + HELVETICA_SIZE * 0.35;
      for (const [i, word] of words.entries()) {
        const left = truth.lefts[i] ?? Number.NaN;
        if (rotation === 0) {
          // Viewer frame: y grows down from the top of a 300 pt page.
          assert.ok(Math.abs(word.box.x - left) <= 1, `${word.text} left`);
          assert.ok(
            spans(word.box, "y", 300 - glyphMiddle),
            `${word.text} middle`
          );
        } else {
          // /Rotate 90 turns the page clockwise: viewer (x, y) = PDF (y, x).
          assert.ok(Math.abs(word.box.y - left) <= 1, `${word.text} left`);
          assert.ok(spans(word.box, "x", glyphMiddle), `${word.text} middle`);
        }
      }
      for (let i = 0; i < text.count; i++) {
        const flags = text.flags[i] ?? 0;
        if (flags & CHAR_GENERATED) {
          continue;
        }
        assert.ok(Math.abs((text.fontSizes[i] ?? 0) - HELVETICA_SIZE) < 0.01);
        assert.equal(text.fills[i], 0x00_00_00_ff);
        assert.equal(flags & CHAR_UNMAPPED, 0);
        assert.equal(text.fontIds[i], 0);
      }
    }
  } finally {
    doc.close();
  }
});

/** A minimal RGBA PNG (no filtering), to embed a bitmap with pdf-lib. */
function encodePng(width: number, height: number, rgba: Uint8Array) {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1
    );
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.byteLength + 8);
    out.writeUInt32BE(data.byteLength, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.byteLength + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

test("plainText(i) is text(i).text on every page: ligatures, multi-code-point and unmapped chars included", async () => {
  // Codes 41-43 map to a ligature, two code points and one; 44 maps to nothing and reads as its code.
  const toUnicode = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <00> <FF> endcodespacerange " +
    "3 beginbfchar <41> <FB01> <42> <00650301> <43> <0043> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
  const odd = pagePdf("BT /F 12 Tf 10 50 Td (ABCD) Tj ET", "/Font << /F 5 0 R >>", [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [68 /g68] >> /ToUnicode 6 0 R >>",
    { dict: "", data: new TextEncoder().encode(toUnicode) },
  ]);
  const files = [odd, truth.bytes, syntheticPdf({ pages: 3, charsPerPage: 400, vary: true })];
  for (const name of ["chrome-mixed-rtl.pdf", "cjk-embedded.pdf", "cjk-predefined-cmap.pdf", "encrypted-objstm-shifted.pdf", "linearized.pdf"]) {
    files.push(await fixture(name));
  }
  let pages = 0;
  for (const bytes of files) {
    const doc = await engine.open(bytes);
    for (let i = 0; i < doc.pageCount; i++, pages++) {
      assert.equal(doc.plainText(i), doc.text(i).text, `page ${i}`);
    }
    doc.close();
  }
  assert.ok(pages >= files.length);
  const doc = await engine.open(odd);
  const text = doc.text(0);
  assert.equal(doc.plainText(0), "fiéCD");
  assert.ok(text.flags.some((f) => f & CHAR_UNMAPPED));
  assert.throws(() => doc.plainText(1), RangeError);
  doc.close();
  assert.throws(() => doc.plainText(0), PdfError);
});

test("a patch mesh's memory doesn't grow with its patches", async () => {
  // Each patch is 722 triangles; 4,000 patches held them all at once, 1.5 GiB. Measured while the
  // document is open: closing one that grew past the mark gives its memory back.
  const meshEngine = await createPdfEngine();
  const heaps = [];
  for (const patches of [1, 4_000]) {
    using doc = await meshEngine.open(tensorPdf(patches));
    const { rgba, width } = doc.render(0, { width: 64 });
    assert.deepEqual([...rgba.subarray((32 * width + 32) * 4, (32 * width + 32) * 4 + 3)], [0, 0, 255]);
    heaps.push(meshEngine.stats().heapBytes);
  }
  const [one = 0, many = 0] = heaps;
  assert.ok(many - one < 16 * 1024 * 1024, `${(one / 2 ** 20).toFixed(0)} MiB, then ${(many / 2 ** 20).toFixed(0)} MiB`);
});

test("render draws what we wrote, at pdf.js's size rule", async () => {
  const doc = await engine.open(truth.bytes);
  try {
    // 400x300 pt at width 800: scale 2. The rectangle is PDF (50,20)-(150,60).
    const bitmap = doc.render(0, { width: 800 });
    assert.deepEqual([bitmap.width, bitmap.height], [800, 600]);
    const px = (x: number, y: number) => {
      const at = (y * bitmap.width + x) * 4;
      return [...bitmap.rgba.subarray(at, at + 4)];
    };
    assert.deepEqual(px(200, 500), [0, 0, 0, 255], "inside the rectangle");
    assert.deepEqual(px(102, 482), [0, 0, 0, 255], "just inside its corner");
    assert.deepEqual(px(97, 477), [255, 255, 255, 255], "just outside it");
    assert.deepEqual(px(700, 50), [255, 255, 255, 255], "blank page");
    // The height cap wins over the width: ceil(pt * min(w/W, maxH/H)).
    const capped = doc.render(0, { width: 4000, maxHeight: 150 });
    assert.deepEqual([capped.width, capped.height], [200, 150]);
  } finally {
    doc.close();
  }
});

test("filled form widgets render (the form-fill pass)", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 200]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const field = pdf.getForm().createTextField("name");
  field.addToPage(page, {
    x: 20,
    y: 100,
    width: 260,
    height: 40,
    font,
    borderWidth: 0,
  });
  field.setText("WWWWWWWWWW");
  const doc = await engine.open(await pdf.save());
  try {
    const [widget] = doc.annotations(0);
    assert.equal(widget?.subtype, ANNOT_SUBTYPE.widget);
    assert.ok(
      Math.abs(widget.box.x - 20) < 0.01 && Math.abs(widget.box.y - 60) < 0.01
    );
    const bitmap = doc.render(0, { width: 300 });
    let ink = 0;
    for (let i = 0; i < bitmap.rgba.length; i += 4) {
      ink += (bitmap.rgba[i] ?? 255) < 128 ? 1 : 0;
    }
    assert.ok(ink > 500, `field value drawn (${ink} dark pixels)`);
  } finally {
    doc.close();
  }
});

test("page objects: images and path segments in the viewer frame", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 100]);
  const tiny = await engine.open(truth.bytes);
  const tile = tiny.render(4, { width: 8 });
  tiny.close();
  const png = { width: tile.width, height: tile.height };
  page.drawImage(
    await pdf.embedPng(encodePng(tile.width, tile.height, tile.rgba)),
    {
      x: 10,
      y: 10,
      width: 30,
      height: 20,
    }
  );
  page.drawRectangle({
    x: 50,
    y: 20,
    width: 100,
    height: 40,
    color: rgb(1, 0, 0),
  });
  page.drawText("x", { x: 5, y: 90, size: 8 });
  const doc = await engine.open(await pdf.save());
  try {
    const objects = doc.objects(0);
    assert.equal(objects.textObjects, 1);
    assert.equal(objects.images.count, 1);
    assert.deepEqual([...objects.images.pixels], [png.width, png.height]);
    const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
    const image = boxAt(objects.images.boxes, 0);
    assert.ok(
      near(image.x, 10) &&
        near(image.y, 70) &&
        near(image.width, 30) &&
        near(image.height, 20)
    );
    assert.ok(objects.paths.count >= 1);
    assert.equal((objects.paths.flags[0] ?? 0) & PATH_FILL, PATH_FILL);
    const points = [
      ...objects.segments.points.subarray(
        2 * (objects.paths.start[0] ?? 0),
        2 * (objects.paths.start[1] ?? 0)
      ),
    ];
    const corners = points.flatMap((v, k) =>
      k % 2 ? [] : [[v, points[k + 1] ?? Number.NaN] as const]
    );
    for (const [x, y] of [
      [50, 80],
      [150, 80],
      [150, 40],
      [50, 40],
    ] as const) {
      assert.ok(
        corners.some(([cx, cy]) => near(cx, x) && near(cy, y)),
        `corner ${x},${y} in ${JSON.stringify(corners)}`
      );
    }
    const bitmap = doc.render(0, { width: 200 });
    const at = (40 * 200 + 100) * 4; // inside the red rectangle
    assert.deepEqual(
      [...bitmap.rgba.subarray(at, at + 4)],
      [255, 0, 0, 255],
      "RGBA order"
    );
  } finally {
    doc.close();
  }
});

test("page objects inside a form XObject get the form's transform", async () => {
  const source = await PDFDocument.create();
  source.addPage([400, 300]).drawRectangle({
    x: 50,
    y: 20,
    width: 100,
    height: 40,
    color: rgb(1, 0, 0),
  });
  const pdf = await PDFDocument.create();
  const [embedded] = await pdf.embedPdf(await source.save());
  assert.ok(embedded);
  pdf
    .addPage([400, 300])
    .drawPage(embedded, { x: 100, y: 100, xScale: 0.5, yScale: 0.5 });
  const doc = await engine.open(await pdf.save());
  try {
    // PDF (50,20)-(150,60) halved and moved by (100,100): (125,110)-(175,130),
    // so viewer y = 300 - 130 = 170.
    const { paths, segments } = doc.objects(0);
    assert.deepEqual(boxAt(paths.boxes, 0), {
      x: 125,
      y: 170,
      width: 50,
      height: 20,
    });
    const points = [...segments.points.subarray(0, 2 * (paths.start[1] ?? 0))];
    const want = [
      [125, 190],
      [125, 170],
      [175, 170],
      [175, 190],
      [125, 190],
    ];
    // The same closed rectangle, in the form's transform.
    const corners = (flat: number[]) =>
      flat
        .flatMap((v, i) => (i % 2 ? [] : [`${v},${flat[i + 1]}`]))
        .slice(0, -1)
        .sort();
    assert.deepEqual(corners(points), corners(want.flat()));
    assert.deepEqual(points.slice(-2), points.slice(0, 2));
  } finally {
    doc.close();
  }
});

test("open errors agree with pdf.js on the same bytes", async () => {
  const valid = syntheticPdf({ pages: 3 });
  const encrypted = await fixture("user-password-secret.pdf");
  const cases = {
    garbage: new TextEncoder().encode("%PDF-1.7\nnot really a pdf at all"),
    empty: new Uint8Array(0),
    "no header": valid.subarray(1024),
    encrypted,
  };
  for (const [label, bytes] of Object.entries(cases)) {
    assert.equal(PDFJS_NAMES[await engineError(bytes)], await pdfjsError(bytes), label);
  }
  await assert.rejects(engine.open(encrypted), { code: "password-required" });
  await assert.rejects(engine.open(encrypted, { password: "wrong" }), {
    code: "wrong-password",
  });
  await assert.rejects(engine.open(cases.garbage), { code: "invalid-file" });
  const unlocked = await engine.open(encrypted, { password: "secret" });
  assert.equal(unlocked.pageCount, 1);
  unlocked.close();
});

test("malformed input fails typed and leaves the engine working", async () => {
  // Seeded, so a failure reproduces.
  let seed = 0x5e_ed;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    return seed / 0x80_00_00_00;
  };
  const mutants: Uint8Array[] = [];
  for (const fraction of [0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) {
    mutants.push(
      truth.bytes.subarray(0, Math.floor(truth.bytes.byteLength * fraction))
    );
  }
  for (let m = 0; m < 30; m++) {
    const bytes = new Uint8Array(truth.bytes);
    for (let flips = 0; flips < 12; flips++) {
      bytes[Math.floor(random() * bytes.byteLength)] = Math.floor(
        random() * 256
      );
    }
    mutants.push(bytes);
  }
  const typed = new Set(["invalid-file", "password-required", "unsupported", "failed"]);
  const outcomes = { opened: 0, refused: 0 };
  for (const bytes of mutants) {
    try {
      const doc = await engine.open(bytes);
      outcomes.opened += 1;
      try {
        for (let i = 0; i < doc.pageCount; i++) {
          doc.pageInfo(i);
          doc.text(i);
          doc.objects(i);
          doc.render(i, { width: 64 });
        }
      } finally {
        doc.close();
      }
    } catch (error) {
      assert.ok(error instanceof PdfError && typed.has(error.code), String(error));
      outcomes.refused += 1;
    }
  }
  assert.ok(
    outcomes.opened > 0 && outcomes.refused > 0,
    JSON.stringify(outcomes)
  );
  const after = await engine.open(truth.bytes);
  assert.equal(after.pageCount, 5);
  after.close();
  assert.equal(engine.stats().openDocuments, 0);
});

test("memory is recycled once it grows past the mark; open documents keep working", async () => {
  const recycling = await createPdfEngine({
    recycleAboveBytes: 48 * 1024 * 1024,
  });
  const old = await recycling.open(truth.bytes);
  old.render(0, { width: 6000 }); // 6000x4500 RGBA: 108 MB inside WASM
  assert.ok(recycling.stats().heapBytes > 48 * 1024 * 1024);
  const fresh = await recycling.open(truth.bytes);
  const { heapBytes, ...rest } = recycling.stats();
  // 0 the engine that drew, 1 the replacement.
  assert.deepEqual(rest, { generation: 1, openDocuments: 2 });
  assert.ok(heapBytes < 16 * 1024 * 1024, `a fresh heap, not the old one's: ${heapBytes}`);
  assert.match(
    old.text(0).text,
    /Alpha/,
    "a document on the retired instance still reads"
  );
  old.close();
  fresh.close();
});

test("by default a page drawn past 64 MiB gives its memory back a second after the document closes", async () => {
  const engine = await createPdfEngine();
  const doc = await engine.open(truth.bytes);
  doc.render(0, { width: 6000 });
  assert.ok(engine.stats().heapBytes > 64 * 1024 * 1024);
  doc.close();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(engine.stats().heapBytes, 0);
  const again = await engine.open(truth.bytes);
  assert.equal(again.pageCount, 5);
  again.close();
});

test("a recycled instance's memory is released, not kept per generation", async () => {
  // Each retired instance used to stay pinned by its glue module record
  // (+8 MB of heap per generation here, forever).
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const settle = async () => {
    for (let k = 0; k < 3; k++) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return process.memoryUsage().rss;
  };
  const recycling = await createPdfEngine({ recycleAboveBytes: 1 });
  const bytes = syntheticPdf({ pages: 3000 });
  const generations = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const doc = await recycling.open(bytes);
      doc.text(0);
      doc.close();
    }
  };
  await generations(5);
  const before = await settle();
  await generations(20);
  const grown = (await settle()) - before;
  assert.ok(recycling.stats().generation >= 24);
  assert.ok(
    grown < 64 * 1024 * 1024,
    `RSS grew ${grown} bytes over 20 generations`
  );
});

test("runs in a worker thread with the same results", async () => {
  const bytes = await fixture("linearized.pdf");
  const local = await engine.open(bytes);
  const expected = {
    pageCount: local.pageCount,
    sizes: Array.from({ length: local.pageCount }, (_, i) => local.pageInfo(i)),
    text: local.text(0).text,
    bitmap: local.render(0, { width: 512 }),
  };
  local.close();
  const worker = new Worker(
    new URL("worker-entry.ts", import.meta.url)
  );
  try {
    const reply = await new Promise<typeof expected>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (message: { ready?: true } & typeof expected) => {
        if (message.ready) {
          worker.postMessage({ bytes });
          return;
        }
        resolve(message);
      });
    });
    assert.equal(reply.pageCount, expected.pageCount);
    assert.deepEqual(reply.sizes, expected.sizes);
    assert.equal(reply.text, expected.text);
    assert.ok(
      Buffer.from(reply.bitmap.rgba).equals(Buffer.from(expected.bitmap.rgba))
    );
  } finally {
    await worker.terminate();
  }
});

test("a ranged open on a worker thread blocks that thread, not the caller's", async () => {
  const bytes = syntheticPdf({ pages: 300, charsPerPage: 1500, vary: true });
  const local = await engine.open(bytes);
  const sizes = Array.from({ length: local.pageCount }, (_, i) =>
    local.pageInfo(i)
  );
  local.close();
  // 40 ms a response: the worker waits on several round trips.
  const server = await startRangeServer(bytes, { latencyMs: 40 });
  const worker = new Worker(
    new URL("worker-entry.ts", import.meta.url)
  );
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 5);
  try {
    const started = performance.now();
    const reply = await new Promise<{ pageCount: number; sizes: unknown[] }>(
      (resolve, reject) => {
        worker.on("error", reject);
        worker.on(
          "message",
          (message: { ready?: true; pageCount: number; sizes: unknown[] }) => {
            if (message.ready) {
              worker.postMessage({ url: server.url });
              return;
            }
            resolve(message);
          }
        );
      }
    );
    const elapsed = performance.now() - started;
    assert.equal(reply.pageCount, sizes.length);
    assert.deepEqual(reply.sizes, sizes);
    // This loop kept turning (a 5 ms timer) while the worker waited.
    assert.ok(
      ticks >= elapsed / 5 / 4,
      `${ticks} ticks in ${elapsed.toFixed(0)} ms`
    );
  } finally {
    clearInterval(ticker);
    await worker.terminate();
    await server.close();
  }
});

test("caller bugs are RangeErrors", async () => {
  const doc = await engine.open(syntheticPdf({ pages: 2 }));
  for (const options of [
    { width: 0 },
    { width: Number.NaN },
    { width: 16_385 },
    { width: 64, maxHeight: 0 },
  ]) {
    assert.throws(
      () => doc.render(0, options),
      RangeError,
      JSON.stringify(options)
    );
  }
  assert.throws(() => doc.text(2), RangeError);
  doc.close();
});

test("a document behind an unsupported security handler says so, and is not invalid", async () => {
  // A valid one-page file whose trailer names a DRM handler (not /Standard).
  const plain = await PDFDocument.create();
  plain.addPage([200, 200]);
  const text = new TextDecoder("latin1").decode(
    await plain.save({ useObjectStreams: false })
  );
  assert.ok(text.includes("trailer\n<<"));
  const drm = new Uint8Array(
    Buffer.from(
      text.replace(
        "trailer\n<<",
        "trailer\n<< /Encrypt << /Filter /Adobe.APS /V 4 /R 4 >> /ID [<00> <00>]"
      ),
      "latin1"
    )
  );
  // Without the dictionary the same bytes open, so the handler is the cause.
  (await engine.open(new Uint8Array(Buffer.from(text, "latin1")))).close();
  await assert.rejects(engine.open(drm), { code: "unsupported" });
});

test("the file a new engine opens to compile the open's code leaves nothing open or pending", async () => {
  const engine = await createPdfEngine();
  const started = engine.stats();
  assert.equal(started.openDocuments, 0);
  assert.ok(started.heapBytes > 0);
  // Not counted as a document that closed, so no idle drop is pending: the instance stays.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(engine.stats(), started);
  const doc = await engine.open(syntheticPdf({ pages: 2 }));
  assert.equal(doc.pageCount, 2);
  doc.close();
});
