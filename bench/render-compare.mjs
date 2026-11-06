#!/usr/bin/env node
// Small generated PDFs for the transparency features, rendered by recto, poppler (pdftoppm) and
// stock pdfium, with the colour each gives at probe points next to what the PDF spec works out to.
//
//   npm run build && node bench/render-compare.mjs [--out directory for PNGs]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { createPdfEngine } from "../js/dist/index.js";
import { pdfiumEngine } from "./engines.mjs";
import { transparencyCases } from "../js/test/transparency-cases.mjs";

const here = import.meta.dirname;
const { values } = parseArgs({ options: { out: { type: "string" } } });
const engine = await createPdfEngine();
const { init } = await import(path.join(here, "node_modules/@embedpdf/pdfium/dist/index.js"));
const pdfium = pdfiumEngine(await init({ wasmBinary: fs.readFileSync(path.join(here, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm")) }));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "recto-compare-"));

const SIZE = 200;
function poppler(bytes) {
  const file = path.join(temp, "case.pdf");
  fs.writeFileSync(file, bytes);
  const ppm = execFileSync("pdftoppm", ["-scale-to-x", String(SIZE), "-scale-to-y", String(SIZE), "-singlefile", file]);
  // P6\nW H\n255\n, then RGB.
  let at = 0;
  for (let lines = 0; lines < 3; at++) if (ppm[at] === 10) lines++;
  const rgb = ppm.subarray(at);
  return (x, y) => [...rgb.subarray((y * SIZE + x) * 3, (y * SIZE + x) * 3 + 3)];
}
/** Optional: MuPDF through PyMuPDF, when PYTHONPATH finds it. */
function mupdf(bytes) {
  const file = path.join(temp, "case.pdf");
  fs.writeFileSync(file, bytes);
  const script = `import pymupdf,sys
p=pymupdf.open(sys.argv[1])[0].get_pixmap(matrix=pymupdf.Matrix(2,2),alpha=False)
sys.stdout.buffer.write(p.samples)`;
  try {
    const rgb = execFileSync("python3", ["-c", script, file], { stdio: ["ignore", "pipe", "ignore"] });
    return (x, y) => [...rgb.subarray((y * SIZE + x) * 3, (y * SIZE + x) * 3 + 3)];
  } catch {
    return null;
  }
}
const fromRgba = (rgba) => (x, y) => [...rgba.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3)];

let disagreements = 0;
for (const { name, pdf, probes } of transparencyCases()) {
  console.log(`\n${name}`);
  const doc = await engine.open(pdf);
  const recto = fromRgba(doc.render(0, { width: SIZE }).rgba);
  doc.close();
  const pd = await pdfium.open(pdf);
  const pdfiumAt = fromRgba((await pd.render(0, SIZE)).rgba);
  pd.close();
  const popplerAt = poppler(pdf);
  const mupdfAt = mupdf(pdf);
  for (const { at, want, note } of probes) {
    const x = Math.round((at[0] / 100) * SIZE);
    const y = Math.round((1 - at[1] / 100) * SIZE);
    const seen = { recto: recto(x, y), poppler: popplerAt(x, y), pdfium: pdfiumAt(x, y), mupdf: mupdfAt?.(x, y) };
    const off = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) > 3;
    const marks = [off(seen.recto, want) ? "RECTO-OFF" : "", off(seen.poppler, want) ? "poppler-off" : "", off(seen.pdfium, want) ? "pdfium-off" : "", seen.mupdf && off(seen.mupdf, want) ? "mupdf-off" : ""].filter(Boolean).join(" ");
    if (off(seen.recto, want)) disagreements++;
    console.log(`  ${note.padEnd(34)} want ${String(want).padEnd(12)} recto ${String(seen.recto).padEnd(12)} poppler ${String(seen.poppler).padEnd(12)} pdfium ${String(seen.pdfium).padEnd(12)} ${seen.mupdf ? `mupdf ${String(seen.mupdf).padEnd(12)} ` : ""}${marks}`);
  }
  if (values.out) {
    fs.mkdirSync(values.out, { recursive: true });
    fs.writeFileSync(path.join(values.out, `${name.replace(/\W+/g, "-")}.pdf`), pdf);
  }
}
fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n${disagreements} probes where recto is off the expected colour`);
