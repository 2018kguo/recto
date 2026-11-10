#!/usr/bin/env node
// Time to a ranged document's first page over a slow link: each response held back by a latency
// (js/test/range-server.ts, the tests' range server), at 0, 40 and 120 ms. Counts the round trips
// as well as the time, since at a latency L a read can't be faster than L times its rounds.
//
// It opens each file by URL, reads page 1's text and draws it at 1024 px, then closes it. With
// --against, a second build's js/dist runs in the same process, alternating with this one run by
// run, so both see the same machine. pdf.js runs too, by its defaults (one streamed request, ranges
// for what the stream hasn't reached yet), unless --no-pdfjs.
//
//   npm run build && npm install --prefix bench
//   node bench/ranged-latency.mjs path/to/pdfs [--against ../other/js/dist] [--runs 5] [--out file.json]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const here = import.meta.dirname;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    against: { type: "string" },
    runs: { type: "string", default: "5" },
    latency: { type: "string", default: "0,40,120" },
    out: { type: "string" },
    "no-pdfjs": { type: "boolean", default: false },
  },
});
const files = positionals.flatMap((p) =>
  fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).filter((name) => name.endsWith(".pdf")).sort().map((name) => path.join(p, name))
    : [p]
);
if (files.length === 0) {
  console.error("usage: ranged-latency.mjs <PDFs or directories> [--against dist] [--runs n] [--latency 0,40,120] [--out file.json]");
  process.exit(2);
}
const runs = Number(values.runs);
const latencies = values.latency.split(",").map(Number);
const { startRangeServer } = await import(path.join(here, "../js/test/range-server.ts"));

async function rectoBuild(name, dist) {
  const { createPdfEngine } = await import(path.join(dist, "index.js"));
  const engine = await createPdfEngine();
  return {
    name,
    async firstPage(url) {
      const started = performance.now();
      const doc = await engine.openRanged(url, { maxBytes: 2 ** 31 });
      const opened = performance.now();
      doc.text(0);
      const text = performance.now();
      const { rgba } = doc.render(0, { width: 1024 });
      const pixels = performance.now();
      const { rounds, requests, bytesFetched } = doc.stats();
      doc.close();
      return { open: opened - started, text: text - started, pixels: pixels - started, rounds, requests, bytes: bytesFetched, ink: rgba.length };
    },
  };
}

async function pdfjsBuild() {
  const pdfjs = await import(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
  const root = path.join(here, "node_modules/pdfjs-dist");
  const options = { verbosity: 0, standardFontDataUrl: `${root}/standard_fonts/`, cMapUrl: `${root}/cmaps/`, cMapPacked: true, wasmUrl: `${root}/wasm/` };
  return {
    name: "pdf.js",
    async firstPage(url) {
      const started = performance.now();
      const task = pdfjs.getDocument({ ...options, url });
      const doc = await task.promise;
      const opened = performance.now();
      const page = await doc.getPage(1);
      await page.getTextContent();
      const text = performance.now();
      const viewport = page.getViewport({ scale: 1024 / page.getViewport({ scale: 1 }).width });
      const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const pixels = performance.now();
      await task.destroy();
      return { open: opened - started, text: text - started, pixels: pixels - started };
    },
  };
}

const builds = [await rectoBuild("recto", path.join(here, "../js/dist"))];
if (values.against) builds.push(await rectoBuild("recto (against)", path.resolve(values.against)));
if (!values["no-pdfjs"]) builds.push(await pdfjsBuild());

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const results = { runs, files: files.map((file) => path.basename(file)), latencies: {} };
for (const latencyMs of latencies) {
  const perBuild = Object.fromEntries(builds.map((b) => [b.name, []]));
  for (const file of files) {
    const server = await startRangeServer(new Uint8Array(fs.readFileSync(file)), { latencyMs });
    try {
      const samples = Object.fromEntries(builds.map((b) => [b.name, []]));
      // One unmeasured run each, so fonts and parts are loaded; then alternate, the order turning.
      for (const build of builds) await build.firstPage(server.url);
      for (let run = 0; run < runs; run++) {
        for (let k = 0; k < builds.length; k++) {
          const build = builds[(run + k) % builds.length];
          samples[build.name].push(await build.firstPage(server.url));
        }
      }
      for (const build of builds) {
        const s = samples[build.name];
        const row = { file: path.basename(file) };
        for (const key of Object.keys(s[0])) row[key] = median(s.map((x) => x[key]));
        perBuild[build.name].push(row);
      }
    } finally {
      await server.close();
    }
  }
  results.latencies[latencyMs] = perBuild;
  for (const build of builds) {
    const rows = perBuild[build.name];
    const sum = (key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
    const rounds = rows[0].rounds === undefined ? "" : ` rounds ${sum("rounds")} (mean ${(sum("rounds") / rows.length).toFixed(2)})`;
    console.log(
      `${String(latencyMs).padStart(3)} ms  ${build.name.padEnd(16)} first text ${sum("text").toFixed(0).padStart(6)} ms  first pixels ${sum("pixels").toFixed(0).padStart(6)} ms  (sums of per-file medians over ${rows.length})${rounds}`
    );
  }
}
// One row a line, times to 0.1 ms.
const json = JSON.stringify(results, (key, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v), 1);
if (values.out) fs.writeFileSync(values.out, `${json.replace(/\{\n\s+"file"[^}]*\}/gu, (row) => row.replace(/\s*\n\s*/gu, " "))}\n`);
process.exit(0);
