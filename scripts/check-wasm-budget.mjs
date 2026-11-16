#!/usr/bin/env node
// Holds the built package to what the README says, so that a build the lists no longer fit, on any machine,
// fails here rather than quietly fetching every part. Run after `npm run build`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { createPdfEngine } from "../js/dist/index.js";
import { reportPdf } from "../bench/generate.mjs";

const here = (...parts) => path.join(import.meta.dirname, "..", "js", ...parts);
const brotli = (file) =>
  zlib.brotliCompressSync(fs.readFileSync(file), { params: { [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }).length;
// index.js and the chunk it imports, which holds the glue and the pins: everything but the pool's own files.
const dist = fs.readdirSync(here("dist")).filter((name) => /^(?!pool).*\.js$/u.test(name));
assert.equal(dist.length, 2, `dist/ is index.js and one chunk, not ${dist.join(", ")}`);
const script = dist.reduce((sum, name) => sum + brotli(here("dist", name)), 0);
const text = script + brotli(here("wasm/recto.wasm"));
const drawing = text + brotli(here("wasm/recto-render.wasm"));

// Since the bundle, the script counted is what a browser loads, ranged's code (9 KB) included, which the
// count of dist/ before it left out: 259 bytes more counted, and 8.7 KB less downloaded.
const BUDGET = { text: 420_000, drawing: 694_000 };
console.log(`text ${text} of ${BUDGET.text} bytes, text and drawing ${drawing} of ${BUDGET.drawing}`);
assert.ok(text <= BUDGET.text, "reading text downloads more than the budget");
assert.ok(drawing <= BUDGET.drawing, "drawing downloads more than the budget");

// Only recto.wasm, and recto-render for drawing: anything else missing would fail the call.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recto-budget-"));
const put = (name) => fs.copyFileSync(here("wasm", name), path.join(dir, name));
put("recto.wasm");
const bytes = reportPdf({ pages: 40, imageEvery: 10, imageSize: 240 });
const engine = await createPdfEngine({ assetBase: dir });
const doc = await engine.open(bytes);
for (let i = 0; i < doc.pageCount; i++) {
  assert.ok(doc.text(i).text.length > 0, `page ${i} has text`);
}
doc.outline();
// A ranged read's own code is text's too: a viewer's first look at a file by URL waits on no part.
const ranged = await engine.openRanged(bytes);
assert.ok(ranged.text(ranged.pageCount - 1).text.length > 0, "a ranged read has text");
ranged.close();
assert.equal(engine.stats().generation, 0, "reading text fetched a part");
put("recto-render.wasm");
for (const font of fs.readdirSync(here("wasm")).filter((name) => name.endsWith(".pfb"))) put(font);
for (let i = 0; i < 4; i++) {
  assert.ok(doc.render(i, { width: 400 }).rgba.some((value) => value !== 255), `page ${i} has ink`);
}
assert.equal(engine.stats().generation, 0, "drawing fetched more than its part");
doc.close();
console.log("text-only fetches no part, whole or ranged; drawing fetches recto-render only");
