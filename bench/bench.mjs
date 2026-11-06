#!/usr/bin/env node
// recto against pdf.js in Node, on a directory of PDFs you provide. Nothing here ships PDFs:
// use files you may read, and do not commit them.
//
//   npm run build
//   npm run bench -- <directory of PDFs> [--docs 30] [--passes 5] [--out bench/results/x.json]
//
// Each pass opens every sampled document, reads text from its first 20 pages, and renders its
// first 2 pages at 1024 px wide (recto's RGBA; pdf.js through @napi-rs/canvas, with
// getImageData so both end at the same bytes). Engines alternate by pass in one thread; the
// first pass of each is warm-up and is not counted. Reported: the median over passes of each
// engine's total, so a slow file counts for what it costs. Also the characters each read, and
// the time from a fresh process to the first page's text, on the smallest file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    docs: { type: "string", default: "30" },
    passes: { type: "string", default: "5" },
    out: { type: "string" },
  },
});
const directory = positionals[0];
if (!directory) {
  console.error("usage: bench.mjs <directory of PDFs> [--docs 30] [--passes 5] [--out file.json]");
  process.exit(2);
}
const TEXT_PAGES = 20;
const RENDER_PAGES = 2;
const WIDTH = 1024;
const here = import.meta.dirname;

const { createPdfEngine } = await import(path.join(here, "../js/dist/index.js"));
const pdfjs = await import(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
const pdfjsRoot = path.join(here, "node_modules/pdfjs-dist");
const pdfjsOptions = {
  isEvalSupported: false,
  verbosity: 0,
  standardFontDataUrl: path.join(pdfjsRoot, "standard_fonts/"),
  cMapUrl: path.join(pdfjsRoot, "cmaps/"),
  cMapPacked: true,
  wasmUrl: path.join(pdfjsRoot, "wasm/"),
};

const all = fs
  .readdirSync(directory)
  .filter((name) => name.toLowerCase().endsWith(".pdf"))
  .sort();
const wanted = Math.min(Number(values.docs), all.length);
// Every nth file, so the sample is spread over however the directory is ordered.
const sampled = Array.from({ length: wanted }, (_, i) => all[Math.floor((i * all.length) / wanted)]);
const docs = sampled.map((name) => fs.readFileSync(path.join(directory, name)));

/** Characters other than whitespace: each engine lays out spaces in its own way. */
const visible = (text) => text.replace(/\s+/gu, "").length;

const engine = await createPdfEngine();
const recto = {
  name: "recto",
  async text(bytes, countChars) {
    using doc = await engine.open(bytes);
    let chars = 0;
    const pages = Math.min(doc.pageCount, TEXT_PAGES);
    for (let i = 0; i < pages; i++) {
      const { text } = doc.text(i);
      chars += countChars ? visible(text) : text.length;
    }
    return { pages, chars };
  },
  async render(bytes) {
    using doc = await engine.open(bytes);
    const pages = Math.min(doc.pageCount, RENDER_PAGES);
    let sum = 0;
    for (let i = 0; i < pages; i++) {
      sum += doc.render(i, { width: WIDTH }).rgba.length;
    }
    return { pages, sum };
  },
};
const pdfjsEngine = {
  name: "pdf.js",
  async text(bytes, countChars) {
    const task = pdfjs.getDocument({ ...pdfjsOptions, data: bytes });
    const doc = await task.promise;
    try {
      let chars = 0;
      const pages = Math.min(doc.numPages, TEXT_PAGES);
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const { items } = await page.getTextContent();
        for (const item of items) {
          chars += countChars ? visible(item.str) : item.str.length;
        }
        page.cleanup();
      }
      return { pages, chars };
    } finally {
      await task.destroy();
    }
  },
  async render(bytes) {
    const task = pdfjs.getDocument({ ...pdfjsOptions, data: bytes });
    const doc = await task.promise;
    try {
      const pages = Math.min(doc.numPages, RENDER_PAGES);
      let sum = 0;
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const unscaled = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: WIDTH / unscaled.width });
        const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        sum += context.getImageData(0, 0, canvas.width, canvas.height).data.length;
        page.cleanup();
      }
      return { pages, sum };
    } finally {
      await task.destroy();
    }
  },
};
const engines = [recto, pdfjsEngine];

// A file either engine refuses (a password, say) is left out for both.
const usable = [];
const visibleChars = { recto: 0, pdfjs: 0 };
for (const bytes of docs) {
  try {
    const ours = await recto.text(bytes, true);
    const theirs = await pdfjsEngine.text(new Uint8Array(bytes), true);
    usable.push(bytes);
    visibleChars.recto += ours.chars;
    visibleChars.pdfjs += theirs.chars;
  } catch (error) {
    console.error(`left out: ${error}`);
  }
}

if (usable.length === 0) {
  console.error("no document opened in both engines");
  process.exit(1);
}

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[sorted.length >> 1];
};
const passes = Number(values.passes);
const totals = { recto: { text: [], render: [] }, "pdf.js": { text: [], render: [] } };
let textPages = 0;
let renderPages = 0;
let failures = 0;
for (let pass = 0; pass <= passes; pass++) {
  for (const side of pass % 2 ? engines : engines.toReversed()) {
    for (const capability of ["text", "render"]) {
      let total = 0;
      let pages = 0;
      for (const bytes of usable) {
        // pdf.js takes ownership of its buffer, so it gets a copy, outside the clock.
        const input = side === recto ? bytes : new Uint8Array(bytes);
        const started = performance.now();
        try {
          pages += (await side[capability](input)).pages;
        } catch (error) {
          failures += 1;
          console.error(`${side.name} ${capability}: ${error}`);
        }
        total += performance.now() - started;
      }
      if (pass > 0) {
        totals[side.name][capability].push(total);
      }
      if (capability === "text") {
        textPages = pages;
      } else {
        renderPages = pages;
      }
    }
    console.error(`pass ${pass}/${passes} ${side.name} done`);
  }
}

// A fresh process to the first page's text, on the smallest file.
const smallest = sampled[docs.indexOf(docs.toSorted((a, b) => a.byteLength - b.byteLength)[0])];
const coldScript = (side) => `
  import { readFileSync } from "node:fs";
  const bytes = new Uint8Array(readFileSync(${JSON.stringify(path.join(directory, smallest))}));
  const started = performance.now();
  ${
    side === "recto"
      ? `const { openPdf } = await import(${JSON.stringify(path.join(here, "../js/dist/index.js"))});
         const doc = await openPdf(bytes); doc.text(0);`
      : `const pdfjs = await import(${JSON.stringify(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"))});
         const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
         await (await doc.getPage(1)).getTextContent();`
  }
  console.log(performance.now() - started);
  process.exit(0);`;
const cold = (side) =>
  median(
    Array.from({ length: 7 }, () =>
      Number(execFileSync("node", ["--input-type=module", "-e", coldScript(side)], { encoding: "utf8" }).trim().split("\n").at(-1)),
    ),
  );

const ms = (values) => Math.round(median(values));
const result = {
  machine: {
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    platform: `${os.platform()} ${os.arch()}`,
    node: process.version,
    loadAverage: os.loadavg().map((load) => Math.round(load * 10) / 10),
  },
  pdfjs: JSON.parse(fs.readFileSync(path.join(pdfjsRoot, "package.json"), "utf8")).version,
  corpus: {
    documents: usable.length,
    leftOut: docs.length - usable.length,
    megabytes: Math.round(usable.reduce((sum, bytes) => sum + bytes.byteLength, 0) / 1e6),
    textPages,
    renderPages,
    visibleChars,
  },
  passes,
  failedCalls: failures,
  textMs: { recto: ms(totals.recto.text), pdfjs: ms(totals["pdf.js"].text) },
  renderMs: { recto: ms(totals.recto.render), pdfjs: ms(totals["pdf.js"].render) },
  coldFirstTextMs: { recto: Math.round(cold("recto")), pdfjs: Math.round(cold("pdf.js")) },
  raw: totals,
};
const report = JSON.stringify(result, null, 2);
console.log(report);
if (values.out) {
  fs.mkdirSync(path.dirname(values.out), { recursive: true });
  fs.writeFileSync(values.out, `${report}\n`);
}
process.exit(0);
