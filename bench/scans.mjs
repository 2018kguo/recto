// Scanned pages: the time a render takes, and the most WebAssembly memory it grew to, at three widths.
// The decode, scaling and rasterizing are told apart by rendering the same pixels three ways: as
// the JPEG; uncompressed at the size the JPEG decodes to (no decode); and uncompressed at the page's
// size in device pixels (no decode, no scaling). With --compare, how each page's pixels differ from
// another build's, as tests/scans.rs measures it. Make the PDFs first:
//   cargo run --release -p recto --example scans -- /tmp/scans
//   node bench/scans.mjs /tmp/scans [--dist other/js/dist] [--compare before/js/dist] [--out bench/results/scans.json]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dist: { type: "string", default: path.join(import.meta.dirname, "../js/dist") },
    out: { type: "string" },
    compare: { type: "string" },
    runs: { type: "string", default: "7" },
  },
});
const dir = positionals[0];
if (!dir) throw new Error("usage: node bench/scans.mjs <dir of PDFs from examples/scans.rs>");
const { createPdfEngine } = await import(path.resolve(values.dist, "index.js"));
const RUNS = Number(values.runs);
const WIDTHS = [1600, 1024, 400];
const median = (list) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)];
const round = (ms) => Math.round(ms * 10) / 10;
const mb = (bytes) => Math.round(bytes / 1e5) / 10;
// Paths as recorded: from the repository, so a result names no machine.
const relative = (p) => path.relative(path.join(import.meta.dirname, ".."), path.resolve(p));
const read = (name) => fs.readFileSync(path.join(dir, name));

/** Median time to render `pages` of a file freshly opened each run, so no document state carries over. */
async function time(engine, bytes, width, pages = [0], region) {
  const times = [];
  for (let i = 0; i < RUNS + 1; i++) {
    const doc = await engine.open(bytes);
    const started = performance.now();
    for (const page of pages) doc.render(page, { width, region });
    const elapsed = performance.now() - started;
    doc.close();
    if (i > 0) times.push(elapsed);
  }
  return round(median(times));
}

/** The instance's memory after one render in an instance of its own: memory only grows, so its peak. */
async function peak(bytes, width, pages = [0], region) {
  const engine = await createPdfEngine({ recycleAboveBytes: 2 ** 32 });
  const doc = await engine.open(bytes);
  const before = engine.stats().heapBytes;
  for (const page of pages) doc.render(page, { width, region });
  const after = engine.stats().heapBytes;
  doc.close();
  return { opened: mb(before), peak: mb(after) };
}

const engine = await createPdfEngine({ recycleAboveBytes: 2 ** 32 });
const results = { node: process.version, dist: relative(values.dist), runs: RUNS, pages: {}, stages: {}, documents: {} };

for (const name of ["scan-baseline.pdf", "scan-progressive.pdf", "scan-gray.pdf"]) {
  const bytes = read(name);
  for (const width of WIDTHS) {
    const ms = await time(engine, bytes, width);
    const memory = await peak(bytes, width);
    results.pages[`${name} @${width}`] = { ms, ...memory };
    console.log(`${name} @${width}: ${ms} ms, heap ${memory.opened} → ${memory.peak} MB`);
  }
}

// Stages, from the uncompressed pages.
for (const width of WIDTHS) {
  const raw = {};
  for (const f of [1, 2, 4, 8]) raw[f] = await time(engine, read(`raw-${f}.pdf`), width);
  const device = await time(engine, read(`raw-device-${width}.pdf`), width);
  results.stages[width] = { raw, device };
  console.log(`stages @${width}: uncompressed at 1/1 ${raw[1]}, 1/2 ${raw[2]}, 1/4 ${raw[4]}, 1/8 ${raw[8]}, at device size ${device} ms`);
}

// A whole-page region at 4x the width, the top-left quarter of the page; a thumbnail; and documents
// with one image on every page, every page drawn in turn.
const scan = read("scan-baseline.pdf");
const region = { x: 0, y: 0, width: 306, height: 396 };
for (const [label, bytes, width, pages, reg] of [
  ["region: top-left quarter at a 3200 px page", scan, 3200, [0], region],
  ["thumbnail at 160 px", scan, 160, [0]],
  ["letterhead scan on 6 pages @1024", read("letterhead-6-pages.pdf"), 1024, [0, 1, 2, 3, 4, 5]],
  ["letterhead scan on 6 pages @1600", read("letterhead-6-pages.pdf"), 1600, [0, 1, 2, 3, 4, 5]],
  ["logo on 12 pages @1024", read("logo-12-pages.pdf"), 1024, [...Array(12).keys()]],
]) {
  const ms = await time(engine, bytes, width, pages, reg);
  const memory = await peak(bytes, width, pages, reg);
  results.documents[label] = { ms, ...memory };
  console.log(`${label}: ${ms} ms, heap ${memory.opened} → ${memory.peak} MB`);
}

/** As tests/scans.rs: per pixel the mean error of 255 a channel, the largest and the % of pixels a
 * channel past 48; over 4x4 cells, the mean and the % of cells a channel past 16. */
function diff(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error("sizes differ");
  const { width: w, height: h } = a;
  let sum = 0;
  let max = 0;
  let over = 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.rgba[i + c] - b.rgba[i + c]);
      sum += d;
      worst = Math.max(worst, d);
    }
    max = Math.max(max, worst);
    if (worst > 48) over++;
  }
  let cellSum = 0;
  let cellsOff = 0;
  let cells = 0;
  for (let row = 0; row + 4 <= h; row += 4) {
    for (let column = 0; column + 4 <= w; column += 4) {
      const totals = [0, 0, 0];
      for (let y = row; y < row + 4; y++) {
        for (let x = column; x < column + 4; x++) {
          for (let c = 0; c < 3; c++) totals[c] += a.rgba[(y * w + x) * 4 + c] - b.rgba[(y * w + x) * 4 + c];
        }
      }
      const d = totals.map((t) => Math.abs(t) / 16);
      cellSum += d[0] + d[1] + d[2];
      if (d.some((v) => v > 16)) cellsOff++;
      cells++;
    }
  }
  const r = (v, digits = 2) => Number(v.toFixed(digits));
  return {
    mae: r(sum / (w * h * 3)),
    max,
    over48: r((over * 100) / (w * h), 3),
    cellMae: r(cellSum / (cells * 3)),
    cells16: r((cellsOff * 100) / cells, 3),
  };
}

if (values.compare) {
  const other = await (await import(path.resolve(values.compare, "index.js"))).createPdfEngine({ recycleAboveBytes: 2 ** 32 });
  results.compare = { against: relative(values.compare), pages: {} };
  for (const name of ["scan-baseline.pdf", "scan-progressive.pdf", "scan-gray.pdf"]) {
    const bytes = read(name);
    for (const width of [...WIDTHS, 160]) {
      const [a, b] = [engine, other].map(async (e) => {
        const doc = await e.open(bytes);
        const bitmap = doc.render(0, { width });
        doc.close();
        return bitmap;
      });
      const d = diff(await a, await b);
      results.compare.pages[`${name} @${width}`] = d;
      console.log(`${name} @${width} against ${values.compare}: ${JSON.stringify(d)}`);
    }
  }
}

if (values.out) fs.writeFileSync(values.out, `${JSON.stringify(results, null, 2)}\n`);
