#!/usr/bin/env node
// How far recto's pixels are from pdfium's, pdf.js's and poppler's (and MuPDF's, asked), page by page, where those agree
// with each other. See docs/benchmarks.md#the-scorecard for what each number means. Commits nothing
// from the PDFs: page images stay in --out, and --results gets counts and a ranking, with the names
// of suites given by --private replaced by hashes.
//
//   npm run build
//   node bench/scorecard.mjs label=dir [label=dir...] --out scratch/dir [--private label]
//        [--width 800] [--pages 3] [--timeout 20] [--jobs 6] [--crops 60] [--results bench/results/scorecard.json]
//        [--engines recto,pdfium,pdf.js,poppler,mupdf]
//
// References are cached in --out by file and width; recto is cached by the wasm's own hash, so a
// rerun after a fix renders recto alone and compares only the pages whose pixels changed.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

const here = import.meta.dirname;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    width: { type: "string", default: "800" },
    pages: { type: "string", default: "3" },
    timeout: { type: "string", default: "20" },
    jobs: { type: "string", default: "6" },
    crops: { type: "string", default: "60" },
    private: { type: "string", multiple: true, default: [] },
    results: { type: "string" },
    limit: { type: "string" },
    // MuPDF is asked for, so that the scoreboard's measure, over four engines, stays what it was.
    engines: { type: "string", default: "recto,pdfium,pdf.js,poppler" },
  },
});
if (!values.out || positionals.length === 0) {
  console.error("usage: scorecard.mjs label=dir [label=dir...] --out directory [--private label] [--width 800] [--pages 3] [--timeout 20] [--jobs 6] [--crops 60] [--results file.json]");
  process.exit(2);
}
const WIDTH = Number(values.width);
const PAGES = Number(values.pages);
const TIMEOUT_MS = Number(values.timeout) * 1000;
const JOBS = Number(values.jobs);
const out = path.resolve(values.out);
fs.mkdirSync(out, { recursive: true });

const ENGINES = values.engines.split(",");
if (ENGINES[0] !== "recto") throw new Error("--engines starts with recto");
/** Pixels: a channel off by more than this, with nothing that close in the 3×3 around it, is reported as `real`. */
const CHANNEL = 48;
/** Two pages agree when, over 4×4 cells, under both: this % of cells off by past CELL, and this mean error of 255. */
const AGREE_CELLS = 1;
const AGREE_COARSE_MAE = 3;
const CELL_SIZE = 4;
const CELL = 32;

// Every part: a change to drawing alone leaves recto.wasm as it was.
const wasmHash = (() => {
  const hash = createHash("sha1");
  const dir = path.join(here, "../js/wasm");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".wasm")).sort()) hash.update(name).update(fs.readFileSync(path.join(dir, name)));
  return hash.digest("hex").slice(0, 12);
})();

const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex").slice(0, 16);
const files = [];
for (const spec of positionals) {
  const [label, directory] = spec.includes("=") ? spec.split(/=(.*)/s) : [path.basename(spec), spec];
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const file = path.join(directory, name);
    const hash = sha1(fs.readFileSync(file));
    const id = values.private.includes(label) ? `${label}/${hash.slice(0, 8)}` : `${label}/${name}`;
    files.push({ id, label, file, hash, localName: `${label}/${name}` });
  }
}
if (values.limit) files.length = Math.min(files.length, Number(values.limit));

// ---- Running the engines

function runWorker(engine, file, directory, first, limit, onEvent) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "scorecard-worker.mjs"), engine, file, directory, String(WIDTH), String(first), String(limit)], { stdio: ["ignore", "pipe", "ignore"] });
    let timedOut = false;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, TIMEOUT_MS);
    };
    arm();
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      arm();
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf("\n")) >= 0) {
        onEvent(JSON.parse(buffered.slice(0, at)));
        buffered = buffered.slice(at + 1);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ timedOut, code, signal });
    });
  });
}

/** Everything one engine does with one file; restarted past a page that hung or killed the process. */
async function renderFile(engine, entry) {
  const key = engine === "recto" ? `${entry.hash}-${WIDTH}-${PAGES}-${wasmHash}` : `${entry.hash}-${WIDTH}-${PAGES}`;
  const directory = path.join(out, "cache", engine, key);
  const metaFile = path.join(directory, "meta.json");
  if (fs.existsSync(metaFile)) return JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const meta = { pageCount: null, openFailed: null, pages: {}, maxRssMb: 0 };
  fs.mkdirSync(directory, { recursive: true });
  let first = 0;
  while (first < PAGES) {
    let current = first;
    let finished = false;
    const end = await runWorker(engine, entry.file, directory, first, PAGES - first, (event) => {
      if (event.open) meta.pageCount = event.pageCount;
      else if (event.start !== undefined) current = event.start;
      else if (event.done !== undefined) meta.pages[event.done] = { ok: true };
      else if (event.failed !== undefined) meta.pages[event.failed] = { ok: false, code: event.code, message: event.message };
      else if (event.openFailed) {
        meta.openFailed = { code: event.code, message: event.message };
        finished = true;
      } else if (event.finished) {
        meta.maxRssMb = Math.max(meta.maxRssMb, event.maxRssMb);
        finished = true;
      }
    });
    if (finished) break;
    const what = end.timedOut ? "timeout" : "died";
    if (meta.pageCount === null) {
      meta.openFailed = { code: what, message: `${what} while opening` };
      break;
    }
    meta.pages[current] = { ok: false, code: what, message: `${what} on page ${current}` };
    first = current + 1;
  }
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  meta.directory = directory;
  return meta;
}

const rendered = new Map();
const queue = [];
for (const entry of files) for (const engine of ENGINES) queue.push({ engine, entry });
let doneTasks = 0;
await Promise.all(
  Array.from({ length: JOBS }, async () => {
    while (queue.length > 0) {
      const { engine, entry } = queue.shift();
      const meta = await renderFile(engine, entry);
      const key = engine === "recto" ? `${entry.hash}-${WIDTH}-${PAGES}-${wasmHash}` : `${entry.hash}-${WIDTH}-${PAGES}`;
      meta.directory = path.join(out, "cache", engine, key);
      rendered.set(`${engine}|${entry.id}`, meta);
      if (++doneTasks % 200 === 0) console.error(`${doneTasks} of ${files.length * ENGINES.length} engine-file runs`);
    }
  }),
);

// ---- Comparing

function loadPage(meta, page) {
  if (!meta.pages[page]?.ok) return null;
  const raw = fs.readFileSync(path.join(meta.directory, `${page}.rgb`));
  return { width: raw.readUInt32LE(0), height: raw.readUInt32LE(4), rgb: zlib.inflateSync(raw.subarray(8)), hash: sha1(raw) };
}

function nearbyMatch(pixels, stride, rows, columns, x, y, r, g, b) {
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= columns) continue;
      const at = yy * stride + xx * 3;
      if (Math.abs(pixels[at] - r) <= CHANNEL && Math.abs(pixels[at + 1] - g) <= CHANNEL && Math.abs(pixels[at + 2] - b) <= CHANNEL) return true;
    }
  }
  return false;
}

/**
 * Averaged over 4×4 cells, where anti-aliasing and hinting cancel out and a missing word doesn't.
 * Returns the mean error of 255 per channel, and the % of cells off by past CELL on some channel.
 */
function coarse(a, b, w, h) {
  const columns = Math.floor(w / CELL_SIZE);
  const rows = Math.floor(h / CELL_SIZE);
  let sum = 0;
  let off = 0;
  const totals = new Int32Array(3);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      totals.fill(0);
      for (let y = row * CELL_SIZE; y < (row + 1) * CELL_SIZE; y++) {
        let pa = (y * a.width + column * CELL_SIZE) * 3;
        let pb = (y * b.width + column * CELL_SIZE) * 3;
        for (let x = 0; x < CELL_SIZE; x++, pa += 3, pb += 3) {
          totals[0] += a.rgb[pa] - b.rgb[pb];
          totals[1] += a.rgb[pa + 1] - b.rgb[pb + 1];
          totals[2] += a.rgb[pa + 2] - b.rgb[pb + 2];
        }
      }
      const area = CELL_SIZE * CELL_SIZE;
      const d0 = Math.abs(totals[0]) / area;
      const d1 = Math.abs(totals[1]) / area;
      const d2 = Math.abs(totals[2]) / area;
      sum += d0 + d1 + d2;
      if (d0 > CELL || d1 > CELL || d2 > CELL) off++;
    }
  }
  const cells = Math.max(columns * rows, 1);
  return { coarseMae: sum / (cells * 3), cells: (off * 100) / cells };
}

/** mae: mean per-channel error of 255. over: % of pixels off by past CHANNEL. real: % with no match within a pixel. */
function distance(a, b) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  // A pixel or two is how each engine rounds. More is a different page shape, and nothing to compare.
  if (Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) return { mae: 255, over: 100, real: 100, coarseMae: 255, cells: 100, shape: true };
  const sa = a.width * 3;
  const sb = b.width * 3;
  let sum = 0;
  let over = 0;
  let real = 0;
  for (let y = 0; y < h; y++) {
    let pa = y * sa;
    let pb = y * sb;
    for (let x = 0; x < w; x++, pa += 3, pb += 3) {
      const d0 = Math.abs(a.rgb[pa] - b.rgb[pb]);
      const d1 = Math.abs(a.rgb[pa + 1] - b.rgb[pb + 1]);
      const d2 = Math.abs(a.rgb[pa + 2] - b.rgb[pb + 2]);
      sum += d0 + d1 + d2;
      if (d0 <= CHANNEL && d1 <= CHANNEL && d2 <= CHANNEL) continue;
      over++;
      if (!nearbyMatch(b.rgb, sb, h, w, x, y, a.rgb[pa], a.rgb[pa + 1], a.rgb[pa + 2]) || !nearbyMatch(a.rgb, sa, h, w, x, y, b.rgb[pb], b.rgb[pb + 1], b.rgb[pb + 2])) real++;
    }
  }
  const pixels = Math.max(w * h, 1);
  return { mae: sum / (pixels * 3), over: (over * 100) / pixels, real: (real * 100) / pixels, ...coarse(a, b, w, h) };
}

/** 1 is the edge of agreeing; past it, how many times over the limit. */
const score = (d) => Math.max(d.cells / AGREE_CELLS, d.coarseMae / AGREE_COARSE_MAE);

function isBlank(page) {
  let marked = 0;
  for (let i = 0; i < page.rgb.length; i += 3) if (page.rgb[i] < 247 || page.rgb[i + 1] < 247 || page.rgb[i + 2] < 247) marked++;
  return (marked * 3) / page.rgb.length < 0.0005;
}

const pairCacheFile = path.join(out, "pairs.json");
const pairCache = fs.existsSync(pairCacheFile) ? JSON.parse(fs.readFileSync(pairCacheFile, "utf8")) : {};
function cachedDistance(a, b) {
  const key = a.hash < b.hash ? `${a.hash}:${b.hash}` : `${b.hash}:${a.hash}`;
  return (pairCache[key] ??= distance(a, b));
}

const emptyTally = () => ({ pages: 0, judged: 0, agrees: 0, differs: 0, blankWhereOthersDraw: 0, failedWhereOthersDraw: 0, wrongShape: 0 });
const tally = Object.fromEntries(ENGINES.map((engine) => [engine, emptyTally()]));
const bySuite = {};
const failures = Object.fromEntries(ENGINES.map((engine) => [engine, { openFailed: {}, pageFailed: {}, examples: [] }]));
const pageCountDisagreements = [];
const pageRows = [];
const contested = [];
const maxRss = Object.fromEntries(ENGINES.map((engine) => [engine, 0]));

let fileIndex = 0;
for (const entry of files) {
  if (++fileIndex % 100 === 0) console.error(`compared ${fileIndex} of ${files.length} files`);
  const metas = Object.fromEntries(ENGINES.map((engine) => [engine, rendered.get(`${engine}|${entry.id}`)]));
  const counts = {};
  for (const engine of ENGINES) {
    const meta = metas[engine];
    maxRss[engine] = Math.max(maxRss[engine], meta.maxRssMb ?? 0);
    if (meta.openFailed) {
      failures[engine].openFailed[meta.openFailed.code] = (failures[engine].openFailed[meta.openFailed.code] ?? 0) + 1;
      failures[engine].examples.push({ id: entry.id, code: meta.openFailed.code, message: meta.openFailed.message });
    } else counts[engine] = meta.pageCount;
    for (const [page, info] of Object.entries(meta.pages)) {
      if (info.ok) continue;
      failures[engine].pageFailed[info.code] = (failures[engine].pageFailed[info.code] ?? 0) + 1;
      failures[engine].examples.push({ id: entry.id, page: Number(page), code: info.code, message: info.message });
    }
  }
  if (new Set(Object.values(counts)).size > 1) pageCountDisagreements.push({ id: entry.id, ...counts });
  // Who opened it, when somebody didn't, is the point of the repair section; it counts here too.
  const opened = Object.keys(counts);
  const refsOpened = opened.filter((engine) => engine !== "recto");
  if (metas.recto.openFailed && refsOpened.length >= 2) failures.recto.examples.push({ id: entry.id, code: "open-where-others-open", refsOpened });

  const lastPage = Math.min(PAGES, Math.max(0, ...Object.values(counts)));
  for (let page = 0; page < lastPage; page++) {
    const images = {};
    for (const engine of ENGINES) images[engine] = loadPage(metas[engine], page);
    const drawn = ENGINES.filter((engine) => images[engine]);
    if (drawn.length < 2) continue;
    const pair = {};
    for (let i = 0; i < drawn.length; i++) {
      for (let j = i + 1; j < drawn.length; j++) {
        const d = cachedDistance(images[drawn[i]], images[drawn[j]]);
        pair[`${drawn[i]}|${drawn[j]}`] = d;
        pair[`${drawn[j]}|${drawn[i]}`] = d;
      }
    }
    const blanks = Object.fromEntries(drawn.map((engine) => [engine, isBlank(images[engine])]));
    const row = { id: entry.id, localName: entry.localName, page, label: entry.label };
    for (const engine of ENGINES) {
      const others = drawn.filter((other) => other !== engine);
      let best = null;
      for (let i = 0; i < others.length; i++) {
        for (let j = i + 1; j < others.length; j++) {
          const d = pair[`${others[i]}|${others[j]}`];
          if (!best || score(d) < score(best.d)) best = { a: others[i], b: others[j], d };
        }
      }
      if (!best) continue;
      const suite = (bySuite[entry.label] ??= Object.fromEntries(ENGINES.map((name) => [name, emptyTally()])));
      for (const t of [tally[engine], suite[engine]]) t.pages++;
      if (score(best.d) > 1) {
        // The others don't agree: no verdict. Still worth a look if this engine is further from all of them.
        if (engine === "recto" && images.recto) {
          const nearest = Math.min(...others.map((other) => score(pair[`recto|${other}`])));
          if (nearest > score(best.d)) contested.push({ id: entry.id, localName: entry.localName, page, score: nearest, referenceScore: score(best.d), reference: [best.a, best.b], excess: nearest - score(best.d) });
        }
        continue;
      }
      const mine = images[engine];
      const judged = { reference: [best.a, best.b], referenceScore: score(best.d) };
      for (const t of [tally[engine], suite[engine]]) t.judged++;
      if (!mine) {
        for (const t of [tally[engine], suite[engine]]) {
          t.failedWhereOthersDraw++;
          t.differs++;
        }
        judged.score = Infinity;
        judged.status = metas[engine].openFailed?.code ?? metas[engine].pages[page]?.code ?? "missing";
      } else {
        const toA = pair[`${engine}|${best.a}`];
        const toB = pair[`${engine}|${best.b}`];
        const nearest = score(toA) < score(toB) ? toA : toB;
        judged.score = score(nearest);
        judged.cells = nearest.cells;
        judged.real = nearest.real;
        judged.mae = nearest.mae;
        const agrees = judged.score <= 1;
        for (const t of [tally[engine], suite[engine]]) {
          if (agrees) t.agrees++;
          else t.differs++;
          if (toA.shape && toB.shape) t.wrongShape++;
          if (blanks[engine] && !blanks[best.a] && !blanks[best.b]) t.blankWhereOthersDraw++;
        }
        judged.blank = blanks[engine] && !blanks[best.a] && !blanks[best.b];
        judged.shape = Boolean(toA.shape && toB.shape);
        judged.size = [mine.width, mine.height];
        judged.referenceSize = [images[best.a].width, images[best.a].height];
      }
      row[engine] = judged;
    }
    pageRows.push(row);
  }
}
fs.writeFileSync(pairCacheFile, JSON.stringify(pairCache));

const rate = (t) => (t.judged ? Math.round((t.agrees / t.judged) * 1e4) / 100 : null);
const ranking = pageRows
  .filter((row) => row.recto)
  .map((row) => ({ ...row.recto, id: row.id, localName: row.localName, page: row.page }))
  .filter((row) => row.score > 1)
  .sort((a, b) => b.score - a.score);

// ---- Report: crops side by side, for looking at. Never committed.

const { createCanvas, ImageData } = await import(path.join(here, "node_modules/@napi-rs/canvas/index.js"));
function canvasOf(image) {
  const canvas = createCanvas(image.width, image.height);
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  for (let i = 0, o = 0; o < rgba.length; i += 3, o += 4) {
    rgba[o] = image.rgb[i];
    rgba[o + 1] = image.rgb[i + 1];
    rgba[o + 2] = image.rgb[i + 2];
    rgba[o + 3] = 255;
  }
  canvas.getContext("2d").putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
  return canvas;
}
/** The 360×270 window holding the most difference, by a coarse grid. */
function worstWindow(a, b) {
  const GRID = 30;
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const cells = new Float64Array(Math.ceil(w / GRID) * Math.ceil(h / GRID));
  const stride = Math.ceil(w / GRID);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pa = (y * a.width + x) * 3;
      const pb = (y * b.width + x) * 3;
      if (Math.abs(a.rgb[pa] - b.rgb[pb]) + Math.abs(a.rgb[pa + 1] - b.rgb[pb + 1]) + Math.abs(a.rgb[pa + 2] - b.rgb[pb + 2]) > CHANNEL) cells[Math.floor(y / GRID) * stride + Math.floor(x / GRID)]++;
    }
  }
  let best = { x: 0, y: 0, total: -1 };
  for (let cy = 0; cy * GRID < h; cy += 3) {
    for (let cx = 0; cx * GRID < w; cx += 3) {
      let total = 0;
      for (let dy = 0; dy < 9 && (cy + dy) * GRID < h; dy++) for (let dx = 0; dx < 12 && cx + dx < stride; dx++) total += cells[(cy + dy) * stride + cx + dx];
      if (total > best.total) best = { x: cx * GRID, y: cy * GRID, total };
    }
  }
  return best;
}
const contestedRanking = contested.sort((a, b) => b.excess - a.excess);
// Under the limit, which is generous enough to hide a line of text, but well past the references' own
// difference: where to look for a small thing missing.
const nearMisses = pageRows
  .filter((row) => row.recto && row.recto.score <= 1 && row.recto.score > 0.1 && row.recto.score > 3 * row.recto.referenceScore)
  .map((row) => ({ ...row.recto, id: row.id, localName: row.localName, page: row.page, excess: row.recto.score - row.recto.referenceScore }))
  .sort((a, b) => b.excess - a.excess);
const cropDir = path.join(out, "crops");
fs.rmSync(cropDir, { recursive: true, force: true });
fs.mkdirSync(cropDir, { recursive: true });
const PANEL = 360;
const reportRows = [];
const toCrop = [...ranking.slice(0, Number(values.crops)).map((row) => ["", row]), ...contestedRanking.slice(0, Number(values.crops)).map((row) => ["c", row]), ...nearMisses.slice(0, Number(values.crops)).map((row) => ["n", row])];
for (const [index, [prefix, row]] of toCrop.entries()) {
  const entry = files.find((f) => f.id === row.id);
  const images = ENGINES.map((engine) => [engine, loadPage(rendered.get(`${engine}|${entry.id}`), row.page)]);
  const reference = images.find(([engine, image]) => engine === row.reference[0] && image)?.[1];
  const recto = images[0][1];
  const window = recto && reference && !row.shape ? worstWindow(recto, reference) : { x: 0, y: 0 };
  const whole = Math.max(...images.map(([, image]) => (image?.width && image.height ? (image.height * PANEL) / image.width : 0)));
  const canvas = createCanvas(PANEL * ENGINES.length + 10 * (ENGINES.length - 1), Math.ceil(whole) + 270 + 44);
  const context = canvas.getContext("2d");
  context.fillStyle = "#888";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "14px sans-serif";
  for (const [i, [engine, image]] of images.entries()) {
    const x = i * (PANEL + 10);
    context.fillStyle = "#fff";
    context.fillText(`${engine}${row.reference.includes(engine) ? " *" : ""}${image ? ` ${image.width}x${image.height}` : " FAILED"}`, x + 4, 15);
    if (!image?.width || !image.height) continue;
    const source = canvasOf(image);
    context.drawImage(source, x, 20, PANEL, (image.height * PANEL) / image.width);
    context.drawImage(source, window.x, window.y, PANEL, 270, x, whole + 24, PANEL, 270);
  }
  const name = `${prefix}${String(index + 1).padStart(3, "0")}.png`;
  fs.writeFileSync(path.join(cropDir, name), canvas.toBuffer("image/png"));
  reportRows.push({ name, row });
}
const html = `<!doctype html><meta charset="utf-8"><title>recto scorecard</title><style>body{font:14px sans-serif;margin:16px}img{max-width:100%}</style>
<h1>recto against the references</h1>
${ENGINES.map((engine) => `<p>${engine}: agrees on ${rate(tally[engine])}% of ${tally[engine].judged} judged pages</p>`).join("")}
${reportRows.map(({ name, row }) => `<h3>${name} ${row.localName} p${row.page + 1}: score ${row.score === null || row.score === Infinity ? row.status : row.score.toFixed(1)}${row.blank ? ", blank" : ""}${row.shape ? ", wrong shape" : ""}</h3><img src="crops/${name}" loading="lazy">`).join("\n")}`;
fs.writeFileSync(path.join(out, "report.html"), html);

// ---- Results

const summary = {
  date: new Date().toISOString(),
  settings: { width: WIDTH, pagesPerFile: PAGES, timeoutSeconds: TIMEOUT_MS / 1000, channel: CHANNEL, cellSize: CELL_SIZE, cellLevel: CELL, agreeCellsPercent: AGREE_CELLS, agreeCoarseMae: AGREE_COARSE_MAE },
  engines: ENGINES,
  files: files.length,
  suites: Object.fromEntries(Object.entries(Object.groupBy(files, (f) => f.label)).map(([label, list]) => [label, list.length])),
  agreement: Object.fromEntries(ENGINES.map((engine) => [engine, { ...tally[engine], percent: rate(tally[engine]) }])),
  agreementBySuite: Object.fromEntries(Object.entries(bySuite).map(([label, suite]) => [label, Object.fromEntries(ENGINES.map((engine) => [engine, { judged: suite[engine].judged, agrees: suite[engine].agrees, percent: rate(suite[engine]) }]))])),
  failures: Object.fromEntries(ENGINES.map((engine) => [engine, { openFailed: failures[engine].openFailed, pageFailed: failures[engine].pageFailed }])),
  rectoOpenFailedWhereTwoReferencesOpened: failures.recto.examples.filter((e) => e.code === "open-where-others-open").map((e) => e.id),
  pageCountDisagreements: pageCountDisagreements.length,
  maxRssMb: maxRss,
  contestedWhereRectoIsFurthest: contested.length,
  nearMisses: nearMisses.length,
  ranking: ranking.slice(0, 50).map(({ id, page, score: s, status, real, mae, blank, shape }) => ({ id, page, score: s === Infinity ? null : Math.round(s * 10) / 10, status, real: real === undefined ? undefined : Math.round(real * 100) / 100, mae: mae === undefined ? undefined : Math.round(mae * 10) / 10, blank: blank || undefined, shape: shape || undefined })),
};
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ ...summary, ranking, contested: contestedRanking, nearMisses, pageCountDisagreements, failureExamples: Object.fromEntries(ENGINES.map((e) => [e, failures[e].examples])) }, null, 1));
if (values.results) fs.writeFileSync(values.results, `${JSON.stringify(summary, null, 1)}\n`);
const line = (engine) => `${engine.padEnd(8)} ${String(rate(tally[engine])).padStart(6)}% of ${String(tally[engine].judged).padStart(5)} judged  differs ${String(tally[engine].differs).padStart(4)}  blank ${String(tally[engine].blankWhereOthersDraw).padStart(3)}  failed ${String(tally[engine].failedWhereOthersDraw).padStart(3)}  shape ${String(tally[engine].wrongShape).padStart(3)}`;
for (const engine of ENGINES) console.log(line(engine));
console.log(`page-count disagreements: ${pageCountDisagreements.length}; contested pages where recto is furthest: ${contested.length}`);
console.log(JSON.stringify(summary.failures));
console.log(`report: ${path.join(out, "report.html")}`);
