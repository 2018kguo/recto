// `render(i, { text: false })`: the page drawn without its text, on every path a render takes. Imports
// the built package, as a pool's threads start from dist.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createPdfEngine, createPdfPool } from "../dist/index.js";
import { pdfOf } from "./transparency-cases.mjs";

const CELL = "0.8 0.9 1 rg 10 40 80 30 re f";
const TEXT = "BT 0 0 0 rg /F1 14 Tf 14 50 Td (Cell) Tj [(te) -100 (xt)] TJ ET";
const page = (content: string): Uint8Array => pdfOf({ content, resources: "/Font <</F1 <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>>>" });
const withText = page(`${CELL} ${TEXT}`);
const cellOnly = page(CELL);
const region = { x: 10, y: 25, width: 50, height: 30 };

const engine = await createPdfEngine();

test("without text, a cell's text is gone and its fill is the page's without text", async () => {
  using doc = await engine.open(withText);
  using reference = await engine.open(cellOnly);
  const bare = doc.render(0, { width: 200, text: false });
  assert.deepEqual(bare, reference.render(0, { width: 200 }));
  assert.notDeepEqual(doc.render(0, { width: 200 }).rgba, bare.rgba, "the text draws nothing");
  assert.deepEqual(doc.render(0, { width: 200, text: true }), doc.render(0, { width: 200 }));
  assert.deepEqual(doc.render(0, { width: 200, region, text: false }), reference.render(0, { width: 200, region }));
  assert.deepEqual(await doc.renderAsync(0, { width: 200, text: false, sliceMs: 0 }), reference.render(0, { width: 200 }));
  assert.deepEqual(await doc.renderAsync(0, { width: 200, region, text: false }), reference.render(0, { width: 200, region }));
  assert.throws(() => doc.render(0, { width: 200, text: "no" as unknown as boolean }), RangeError);
});

test("a pool's render takes text too", async () => {
  using reference = await engine.open(cellOnly);
  using pool = await createPdfPool({ threads: 1 });
  await using doc = await pool.open(withText);
  assert.deepEqual(await doc.render(0, { width: 200, text: false }), reference.render(0, { width: 200 }));
  assert.deepEqual(await doc.render(0, { width: 200, region, text: false }), reference.render(0, { width: 200, region }));
  assert.notDeepEqual((await doc.render(0, { width: 200 })).rgba, reference.render(0, { width: 200 }).rgba);
});

test("without text, no font is loaded", async () => {
  // Only the wasm, no fonts: drawing the text needs Helvetica's file, drawing without it doesn't.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recto-no-text-"));
  for (const name of ["recto.wasm", "recto-render.wasm"]) {
    fs.copyFileSync(path.join(import.meta.dirname, "..", "wasm", name), path.join(dir, name));
  }
  const bare = await createPdfEngine({ assetBase: dir });
  using reference = await engine.open(cellOnly);
  {
    using doc = await bare.open(withText);
    assert.deepEqual(doc.render(0, { width: 200, text: false }), reference.render(0, { width: 200 }));
  }
  {
    using doc = await bare.open(withText);
    assert.throws(() => doc.render(0, { width: 200 }), { code: "missing-asset" });
  }
  // A font set by an ExtGState, with no text shown, is loaded only when text is drawn.
  const font = "/Font <</F1 <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>>>";
  const gsFont = pdfOf({ content: `/G gs ${CELL}`, resources: `/ExtGState <</G <</Font [<</Type /Font /Subtype /Type1 /BaseFont /Times-Roman>> 12]>>>> ${font}` });
  using doc = await bare.open(gsFont);
  assert.deepEqual(doc.render(0, { width: 200, text: false }), reference.render(0, { width: 200 }));
  assert.throws(() => doc.render(0, { width: 200 }), { code: "missing-asset" });
  fs.rmSync(dir, { recursive: true });
});
