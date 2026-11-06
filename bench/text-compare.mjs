#!/usr/bin/env node
// How close each engine's words are to poppler's pdftotext, taken as a reference and not as truth:
// precision and recall of word multisets, page by page, over documents with text. pdf.js's text is
// assembled the standard way: each item's `str`, a newline on `hasEOL`.
//
//   npm run build
//   node bench/text-compare.mjs <directory of PDFs> [--docs 200] [--pages 10] [--out bench/results/text.json]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { pdfiumEngine, pdfjsEngine, rectoEngine } from "./engines.mjs";

const here = import.meta.dirname;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    docs: { type: "string", default: "200" },
    pages: { type: "string", default: "10" },
    out: { type: "string", default: path.join(here, "results/text.json") },
  },
});
const directory = positionals[0];
if (!directory) {
  console.error("usage: text-compare.mjs <directory of PDFs> [--docs 200] [--pages 10] [--out file.json]");
  process.exit(2);
}
const all = fs.readdirSync(directory).filter((n) => n.toLowerCase().endsWith(".pdf")).sort();
const wanted = Math.min(Number(values.docs), all.length);
const files = Array.from({ length: wanted }, (_, i) => path.join(directory, all[Math.floor((i * all.length) / wanted)]));
const PAGES = Number(values.pages);

const { createPdfEngine } = await import(path.join(here, "../js/dist/index.js"));
const pdfjs = await import(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
const root = path.join(here, "node_modules/pdfjs-dist");
const { init } = await import(path.join(here, "node_modules/@embedpdf/pdfium/dist/index.js"));
const engines = [
  rectoEngine(await createPdfEngine()),
  pdfjsEngine(pdfjs, { isEvalSupported: false, verbosity: 0, standardFontDataUrl: `${root}/standard_fonts/`, cMapUrl: `${root}/cmaps/`, cMapPacked: true, wasmUrl: `${root}/wasm/` }),
  pdfiumEngine(await init({ wasmBinary: fs.readFileSync(path.join(here, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm")) })),
];

const words = (text) => text.normalize("NFKC").split(/\s+/u).filter(Boolean);
function counts(list) {
  const map = new Map();
  for (const word of list) map.set(word, (map.get(word) ?? 0) + 1);
  return map;
}
function overlap(a, b) {
  let shared = 0;
  for (const [word, n] of a) shared += Math.min(n, b.get(word) ?? 0);
  return shared;
}

const totals = Object.fromEntries(engines.map((e) => [e.name, { shared: 0, words: 0, reference: 0, f1: [] }]));
let used = 0;
for (const file of files) {
  let reference;
  try {
    reference = execFileSync("pdftotext", ["-q", "-f", "1", "-l", String(PAGES), file, "-"], { maxBuffer: 2 ** 28, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    continue;
  }
  const pages = reference.split("\f");
  if (words(reference).length < 50) continue;
  const bytes = new Uint8Array(fs.readFileSync(file));
  const results = [];
  try {
    for (const engine of engines) {
      const doc = await engine.open(bytes);
      const score = { shared: 0, words: 0, reference: 0 };
      for (let i = 0; i < Math.min(doc.pageCount, PAGES); i++) {
        const theirs = words(pages[i] ?? "");
        const mine = words(await doc.text(i));
        score.shared += overlap(counts(mine), counts(theirs));
        score.words += mine.length;
        score.reference += theirs.length;
      }
      await doc.close();
      results.push([engine.name, score]);
    }
  } catch {
    continue;
  }
  used++;
  for (const [name, score] of results) {
    const total = totals[name];
    total.shared += score.shared;
    total.words += score.words;
    total.reference += score.reference;
    const p = score.shared / Math.max(score.words, 1);
    const r = score.shared / Math.max(score.reference, 1);
    total.f1.push(p + r > 0 ? (2 * p * r) / (p + r) : 0);
  }
}
const summary = Object.fromEntries(
  Object.entries(totals).map(([name, t]) => [
    name,
    {
      precision: Math.round((t.shared / t.words) * 1e4) / 100,
      recall: Math.round((t.shared / t.reference) * 1e4) / 100,
      medianF1: Math.round(t.f1.toSorted((a, b) => a - b)[Math.floor(t.f1.length / 2)] * 1e4) / 100,
      words: t.words,
    },
  ]),
);
const results = { date: new Date().toISOString(), documents: used, of: files.length, pagesEach: PAGES, reference: execFileSync("pdftotext", ["-v"], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }), summary };
fs.writeFileSync(values.out, `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify({ documents: used, summary }, null, 1));
