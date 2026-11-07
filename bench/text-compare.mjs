#!/usr/bin/env node
// How close each engine's words are to poppler's pdftotext, taken as a reference and not as truth:
// precision and recall of word multisets, page by page, over documents with text. pdf.js's text is
// assembled the standard way: each item's `str`, a newline on `hasEOL`.
//
// F1 is reported against every other engine as the reference, not only poppler, and `--worst` writes
// the pages furthest from poppler with the words on each side, for looking at. Worst files are local:
// they quote the PDFs, so they stay out of the repository.
//
//   npm run build
//   node bench/text-compare.mjs <directory of PDFs> [more directories] [--docs 200] [--pages 10] [--out bench/results/text.json] [--worst file.json]
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
    worst: { type: "string" },
  },
});
if (positionals.length === 0) {
  console.error("usage: text-compare.mjs <directory of PDFs> [more directories] [--docs 200] [--pages 10] [--out file.json] [--worst file.json]");
  process.exit(2);
}
const all = positionals.flatMap((directory) => fs.readdirSync(directory).filter((n) => n.toLowerCase().endsWith(".pdf")).sort().map((n) => path.join(directory, n)));
const wanted = Math.min(Number(values.docs), all.length);
const files = Array.from({ length: wanted }, (_, i) => all[Math.floor((i * all.length) / wanted)]);
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

// A line-end hyphen is marked, not dropped: recto and pdfium write U+0002 and keep the word whole,
// as poppler does by removing it. For comparing words, the mark and a soft hyphen count for nothing.
const words = (text) => text.replace(/[\u0002\u00ad]/gu, "").normalize("NFKC").split(/\s+/u).filter(Boolean);
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

const names = [...engines.map((e) => e.name), "poppler"];
const pairTotals = {};
const pairOf = (name, reference) => (pairTotals[`${name} against ${reference}`] ??= { shared: 0, words: 0, reference: 0, f1: [] });
const worst = [];
let used = 0;
for (const file of files) {
  let reference;
  try {
    reference = execFileSync("pdftotext", ["-q", "-f", "1", "-l", String(PAGES), file, "-"], { maxBuffer: 2 ** 28, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 });
  } catch {
    continue;
  }
  if (words(reference).length < 50) continue;
  const popplerPages = reference.split("\f");
  const bytes = new Uint8Array(fs.readFileSync(file));
  const texts = { poppler: popplerPages.map((page) => words(page)) };
  try {
    for (const engine of engines) {
      const doc = await engine.open(bytes);
      texts[engine.name] = [];
      for (let i = 0; i < Math.min(doc.pageCount, PAGES); i++) texts[engine.name].push(words(await doc.text(i)));
      await doc.close();
    }
  } catch {
    continue;
  }
  used++;
  const pages = texts.recto.length;
  for (const name of names) {
    for (const against of names) {
      if (name === against) continue;
      const score = { shared: 0, words: 0, reference: 0 };
      for (let i = 0; i < pages; i++) {
        const mine = texts[name][i] ?? [];
        const theirs = texts[against][i] ?? [];
        score.shared += overlap(counts(mine), counts(theirs));
        score.words += mine.length;
        score.reference += theirs.length;
      }
      const total = pairOf(name, against);
      total.shared += score.shared;
      total.words += score.words;
      total.reference += score.reference;
      const p = score.shared / Math.max(score.words, 1);
      const r = score.shared / Math.max(score.reference, 1);
      total.f1.push(p + r > 0 ? (2 * p * r) / (p + r) : 0);
    }
  }
  for (let i = 0; i < pages; i++) {
    const mine = counts(texts.recto[i] ?? []);
    const theirs = counts(texts.poppler[i] ?? []);
    const only = (a, b) => [...a].flatMap(([word, n]) => Array(Math.max(0, n - (b.get(word) ?? 0))).fill(word));
    const rectoOnly = only(mine, theirs);
    const popplerOnly = only(theirs, mine);
    const size = Math.max((texts.poppler[i] ?? []).length, 1);
    const others = ["pdf.js", "pdfium"].map((name) => overlap(counts(texts[name][i] ?? []), theirs) / size);
    worst.push({ file, page: i, gap: (rectoOnly.length + popplerOnly.length) / size, popplerAgreesWithPdfjs: others[0], popplerAgreesWithPdfium: others[1], rectoOnly: rectoOnly.slice(0, 30), popplerOnly: popplerOnly.slice(0, 30) });
  }
}
const median = (list) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)];
const summary = Object.fromEntries(
  Object.entries(pairTotals).map(([name, t]) => [
    name,
    {
      precision: Math.round((t.shared / t.words) * 1e4) / 100,
      recall: Math.round((t.shared / t.reference) * 1e4) / 100,
      microF1: Math.round(((2 * t.shared) / (t.words + t.reference)) * 1e4) / 100,
      medianF1: Math.round(median(t.f1) * 1e4) / 100,
      words: t.words,
    },
  ]),
);
if (values.worst) fs.writeFileSync(values.worst, JSON.stringify(worst.sort((a, b) => b.gap - a.gap).slice(0, 300), null, 1));
const results = { date: new Date().toISOString(), documents: used, of: files.length, pagesEach: PAGES, reference: execFileSync("pdftotext", ["-v"], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] }), summary };
fs.writeFileSync(values.out, `${JSON.stringify(results, null, 1)}\n`);
for (const name of ["recto", "pdf.js", "pdfium"]) console.log(`${name.padEnd(7)} against poppler: F1 ${summary[`${name} against poppler`].microF1} (median ${summary[`${name} against poppler`].medianF1})`);
for (const [a, b] of [["recto", "pdf.js"], ["recto", "pdfium"], ["pdf.js", "pdfium"]]) console.log(`${a} against ${b}: F1 ${summary[`${a} against ${b}`].microF1} (median ${summary[`${a} against ${b}`].medianF1})`);
console.log(`${used} documents`);
