#!/usr/bin/env node
// recto, pdf.js, stock pdfium and MuPDF in Node, each engine in processes of its own, on a directory of
// PDFs you provide plus generated ones. Nothing here ships PDFs: use files you may read, and do
// not commit them. docs/benchmarks.md says what each number means.
//
//   npm run build
//   npm run bench -- <directory of PDFs> [--docs 60] [--min-rounds 6] [--max-rounds 20] [--tolerance 5]
//                    [--min-idle 10 --max-wait 60] [--runs 7] [--out bench/results/node.json]
//
// Rounds are paired: each round runs one job for all four engines back to back, in a shuffled order,
// then the next job, so the ratio of a round is taken over the same minute of the machine. A job stops
// once every row it feeds is decided (stats.mjs: its interval leaves out 1, or is within --tolerance %
// of its estimate), and in any case at --max-rounds; --runs N runs exactly N rounds. Rows where the work
// is the engine's own on the calling thread report that thread's CPU time, which a busy machine moves far
// less than wall time (meter.mjs); cold start, blocking and stopping stay in wall time. Each row says which.
// `--max-load` and `--min-idle` hold each measured process for a quieter machine (see quiet.mjs);
// `--max-wait` makes that hold soft. What each started at is in the results.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { generatedPdf } from "./cache.mjs";
import { mupdfEngine, pdfiumEngine, pdfjsEngine, rectoEngine } from "./engines.mjs";
import { heavyPagePdf, posterPdf, reportPdf } from "./generate.mjs";
import { meter, sinceStart } from "./meter.mjs";
import { quietGate } from "./quiet.mjs";
import { compareRow, decided, median, pairedRatio, seeded, shuffled } from "./stats.mjs";

const here = import.meta.dirname;
const TEXT_PAGES = 20;
const RENDER_PAGES = 2;
const WIDTH = 1024;
const LARGE_PAGES = 2000;
const LARGE_RENDERED = 5;
const ENGINES = ["recto", "pdf.js", "pdfium", "mupdf"];
const ms = (value) => Math.round(value * 10) / 10;

async function load(name) {
  if (name === "recto") {
    const { createPdfEngine } = await import(path.join(here, "../js/dist/index.js"));
    return rectoEngine(await createPdfEngine());
  }
  if (name === "pdf.js") {
    const pdfjs = await import(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
    const root = path.join(here, "node_modules/pdfjs-dist");
    return pdfjsEngine(pdfjs, {
      isEvalSupported: false,
      verbosity: 0,
      standardFontDataUrl: path.join(root, "standard_fonts/"),
      cMapUrl: path.join(root, "cmaps/"),
      cMapPacked: true,
      wasmUrl: path.join(root, "wasm/"),
    });
  }
  if (name === "mupdf") return mupdfEngine(await import(path.join(here, "node_modules/mupdf/dist/mupdf.js")));
  const { init } = await import(path.join(here, "node_modules/@embedpdf/pdfium/dist/index.js"));
  const wasmBinary = fs.readFileSync(path.join(here, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm"));
  return pdfiumEngine(await init({ wasmBinary }));
}

/** Ends every engine at the same place: the RGBA bytes in JavaScript. */
async function renderBytes(doc, page, width) {
  const out = await doc.render(page, width);
  return out.rgba ?? out.context.getImageData(0, 0, out.width, out.height).data;
}

async function textPass(engine, docs) {
  let chars = 0;
  let pages = 0;
  const stop = meter();
  for (const bytes of docs) {
    const doc = await engine.open(bytes);
    const count = Math.min(doc.pageCount, TEXT_PAGES);
    for (let i = 0; i < count; i++) chars += (await doc.text(i)).replace(/\s+/gu, "").length;
    pages += count;
    await doc.close();
  }
  return { ...stop(), pages, chars };
}

async function renderPass(engine, docs) {
  let pages = 0;
  const stop = meter();
  for (const bytes of docs) {
    const doc = await engine.open(bytes);
    const count = Math.min(doc.pageCount, RENDER_PAGES);
    for (let i = 0; i < count; i++) await renderBytes(doc, i, WIDTH);
    pages += count;
    await doc.close();
  }
  return { ...stop(), pages };
}

/** Each field's median over a list of meter readings. */
const medians = (list) => Object.fromEntries(Object.keys(list[0]).map((key) => [key, list[0][key] === null ? null : median(list.map((m) => m[key]))]));
const peakRss = () => process.resourceUsage().maxRSS * 1024;
const corpus = (request) => request.files.map((file) => new Uint8Array(fs.readFileSync(file)));

/** What each kind of child process does. The parent sees what it prints as one JSON line. */
const jobs = {
  /** Which files this engine opens and reads; a file any engine refuses is left out for all. */
  async probe({ engine: name, files }) {
    const engine = await load(name);
    const ok = [];
    for (const file of files) {
      try {
        const doc = await engine.open(new Uint8Array(fs.readFileSync(file)));
        if (doc.pageCount > 0) await doc.text(0);
        if (doc.pageCount > 0) await renderBytes(doc, 0, 256);
        await doc.close();
        ok.push(file);
      } catch {
        // left out
      }
    }
    return { ok };
  },
  /** From the process starting to the first page, nothing warmed up. */
  async cold({ engine: name, report }) {
    const bytes = new Uint8Array(fs.readFileSync(report));
    const engine = await load(name);
    const doc = await engine.open(bytes);
    await doc.text(0);
    const text = sinceStart();
    await renderBytes(doc, 0, WIDTH);
    return { text, render: sinceStart() };
  },
  /** One warm-up pass over the files, then the same passes counted. */
  async speed(request) {
    const engine = await load(request.engine);
    const docs = corpus(request);
    await textPass(engine, docs);
    await renderPass(engine, docs);
    const text = await textPass(engine, docs);
    const render = await renderPass(engine, docs);
    // Each document's first page, timed alone.
    const first = async (draw) => {
      const each = [];
      for (const bytes of docs) {
        const stop = meter();
        const doc = await engine.open(bytes);
        await draw(doc);
        each.push(stop());
        await doc.close();
      }
      return medians(each);
    };
    const firstText = await first((doc) => doc.text(0));
    const firstRender = await first((doc) => renderBytes(doc, 0, WIDTH));
    return { text, render, firstText, firstRender, rss: peakRss() };
  },
  /** The generated large document, alone in its process, so the peak is its own. */
  async large({ engine: name, large }) {
    const engine = await load(name);
    const bytes = new Uint8Array(fs.readFileSync(large));
    let stop = meter();
    const doc = await engine.open(bytes);
    const open = stop();
    stop = meter();
    for (let i = 0; i < doc.pageCount; i++) await doc.text(i);
    const text = stop();
    stop = meter();
    for (let i = 0; i < LARGE_RENDERED; i++) await renderBytes(doc, i * 300, WIDTH);
    const render = stop();
    await doc.close();
    return { open, text, render, rss: peakRss() };
  },
  /** The generated poster, opened and drawn in a fresh process: large images drawn small. */
  async poster({ engine: name, poster }) {
    const engine = await load(name);
    const bytes = new Uint8Array(fs.readFileSync(poster));
    const stop = meter();
    const doc = await engine.open(bytes);
    await renderBytes(doc, 0, WIDTH);
    const render = stop();
    await doc.close();
    return { render };
  },
  /** The engine on the main thread, yielding between calls, as a server would be if it did that. */
  async blocking(request) {
    const engine = await load(request.engine);
    const docs = corpus(request);
    await textPass(engine, docs.slice(0, 3));
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    const maxes = [];
    const p99s = [];
    for (const bytes of docs) {
      delay.reset();
      const doc = await engine.open(bytes);
      await turn();
      for (let i = 0; i < Math.min(doc.pageCount, TEXT_PAGES); i++) {
        await doc.text(i);
        await turn();
      }
      for (let i = 0; i < Math.min(doc.pageCount, RENDER_PAGES); i++) {
        await renderBytes(doc, i, WIDTH);
        await turn();
      }
      await doc.close();
      await turn();
      maxes.push(delay.max / 1e6);
      p99s.push(delay.percentile(99) / 1e6);
    }
    return { maxMedian: median(maxes), maxWorst: Math.max(...maxes), p99Median: median(p99s) };
  },
  /** A page too slow to wait for: how long the whole render takes, and how soon it can be stopped. */
  async abort({ engine: name, heavy }) {
    const bytes = new Uint8Array(fs.readFileSync(heavy));
    const AFTER = 100;
    if (name === "pdf.js") {
      const pdfjs = await import(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
      const task = pdfjs.getDocument({ data: bytes, verbosity: 0, isEvalSupported: false });
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: WIDTH / page.getViewport({ scale: 1 }).width });
      const draw = async (cancel) => {
        const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const render = page.render({ canvas, canvasContext: context, viewport });
        const started = performance.now();
        if (cancel) setTimeout(() => render.cancel(), AFTER);
        await render.promise.catch(() => {});
        // From when the stop was asked for, not from when the thread got to the timer: a thread that is
        // still drawing runs the timer late, and that wait is part of stopping.
        return { whole: performance.now() - started, stopped: cancel ? performance.now() - (started + AFTER) : null };
      };
      // The operator list is cached after the first draw; a fresh document for each is fairer.
      const first = await draw(true);
      await task.destroy();
      const again = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(heavy)), verbosity: 0, isEvalSupported: false });
      const doc2 = await again.promise;
      const page2 = await doc2.getPage(1);
      const started = performance.now();
      const { canvas, context } = doc2.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page2.render({ canvas, canvasContext: context, viewport }).promise;
      const whole = performance.now() - started;
      await again.destroy();
      return { whole, stopped: first.stopped, how: "renderTask.cancel(), on the same thread" };
    }
    if (name === "recto") {
      const { openPdf } = await import("../js/dist/index.js");
      const doc = await openPdf(bytes);
      const started = performance.now();
      await doc.renderAsync(0, { width: WIDTH });
      const whole = performance.now() - started;
      const controller = new AbortController();
      const begun = performance.now();
      const render = doc.renderAsync(0, { width: WIDTH, signal: controller.signal }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, AFTER));
      controller.abort();
      await render;
      // As for pdf.js: from when the stop was asked for.
      const stopped = performance.now() - (begun + AFTER);
      doc.close();
      return { whole, stopped, how: "renderAsync's signal, on the same thread; the document stays open" };
    }
    // A synchronous call can't be asked to stop: the thread hosting it can only be ended.
    const worker = new Worker(import.meta.filename, { workerData: { engine: name, heavy } });
    const whole = await new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", resolve);
    });
    await worker.terminate();
    const second = new Worker(import.meta.filename, { workerData: { engine: name, heavy, started: true } });
    await new Promise((resolve) => second.once("message", resolve));
    await new Promise((resolve) => setTimeout(resolve, AFTER));
    const asked = performance.now();
    await second.terminate();
    return { whole, stopped: performance.now() - asked, how: "worker.terminate(); the call itself can't be stopped" };
  },
};

function child(request) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [import.meta.filename], {
      env: { ...process.env, RECTO_BENCH_JOB: JSON.stringify(request) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    // No job takes this long unless something is stuck.
    const limit = setTimeout(() => proc.kill("SIGKILL"), 10 * 60_000);
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.once("exit", (code) => {
      clearTimeout(limit);
      const line = out.split("\n").find((l) => l.startsWith("@@"));
      if (line) resolve(JSON.parse(line.slice(2)));
      else reject(new Error(`${request.job} ${request.engine} exited ${code}`));
    });
  });
}

/**
 * Every row: the job that measures it, how to find it in a job's result, and the measure its ratio is
 * taken on (meter.mjs). `thread` is the calling thread's CPU time, for an engine's own work on that thread,
 * which a busy machine moves far less than wall time; `wall` stays for a cold start (a process starting
 * waits on the disk and compiles on other threads, which a user waits for), the event loop's delays and
 * stopping; `bytes` is memory.
 */
const ROWS = {
  text: { job: "speed", pick: (s) => s.text, measure: "thread" },
  render: { job: "speed", pick: (s) => s.render, measure: "thread" },
  coldText: { job: "cold", pick: (s) => s.text, measure: "wall" },
  coldRender: { job: "cold", pick: (s) => s.render, measure: "wall" },
  firstText: { job: "speed", pick: (s) => s.firstText, measure: "thread" },
  firstRender: { job: "speed", pick: (s) => s.firstRender, measure: "thread" },
  largeOpen: { job: "large", pick: (s) => s.open, measure: "thread" },
  largeText: { job: "large", pick: (s) => s.text, measure: "thread" },
  largeRender: { job: "large", pick: (s) => s.render, measure: "thread" },
  rss: { job: "speed", pick: (s) => s.rss, measure: "bytes" },
  largeRss: { job: "large", pick: (s) => s.rss, measure: "bytes" },
  posterRender: { job: "poster", pick: (s) => s.render, measure: "thread" },
  maxMedian: { job: "blocking", pick: (s) => s.maxMedian, measure: "wall" },
  maxWorst: { job: "blocking", pick: (s) => s.maxWorst, measure: "wall" },
  p99Median: { job: "blocking", pick: (s) => s.p99Median, measure: "wall" },
  abortWhole: { job: "abort", pick: (s) => s.whole, measure: "wall" },
  abortStopped: { job: "abort", pick: (s) => s.stopped, measure: "wall" },
};
const JOBS = ["cold", "speed", "large", "poster", "blocking", "abort"];

/** A row's value in one sample, by `measure`: a meter reading's field (wall where it has none), or the number itself. */
function valueOf(row, sample, measure = row.measure) {
  const picked = row.pick(sample);
  if (typeof picked === "number") return picked;
  return picked[measure] ?? picked.wall;
}

const round2 = (value) => Math.round(value * 100) / 100;
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      docs: { type: "string", default: "60" },
      runs: { type: "string" },
      "min-rounds": { type: "string", default: "6" },
      "max-rounds": { type: "string", default: "20" },
      tolerance: { type: "string", default: "5" },
      jobs: { type: "string", default: JOBS.join(",") },
      seed: { type: "string", default: "1" },
      out: { type: "string" },
      raw: { type: "string" },
      "max-load": { type: "string" },
      "min-idle": { type: "string", default: "10" },
      "max-wait": { type: "string", default: "60" },
    },
  });
  const directory = positionals[0];
  if (!directory) {
    console.error("usage: bench.mjs <directory of PDFs> [--docs 60] [--min-rounds 6] [--max-rounds 20] [--tolerance 5] [--runs N] [--out file.json]");
    process.exit(2);
  }
  const begun = Date.now();
  const all = fs
    .readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort();
  const wanted = Math.min(Number(values.docs), all.length);
  // Every nth file, so the sample is spread over however the directory is ordered.
  let files = Array.from({ length: wanted }, (_, i) => path.join(directory, all[Math.floor((i * all.length) / wanted)]));
  const minRounds = Number(values.runs ?? values["min-rounds"]);
  const maxRounds = Number(values.runs ?? values["max-rounds"]);
  const tolerance = Number(values.tolerance) / 100;
  const jobs = values.jobs.split(",");

  const report = generatedPdf("report-40", () => reportPdf({ pages: 40, imageSize: 240 }));
  const large = generatedPdf(`report-${LARGE_PAGES}`, () => reportPdf({ pages: LARGE_PAGES, imageEvery: 10, imageSize: 240 }));
  const heavy = generatedPdf("heavy-300000", () => heavyPagePdf({ paths: 300_000 }));
  const poster = generatedPdf("poster", () => posterPdf());

  const probes = await Promise.all(ENGINES.map((engine) => child({ job: "probe", engine, files })));
  const total = files.length;
  files = files.filter((file) => probes.every(({ ok }) => ok.includes(file)));
  const leftOut = Object.fromEntries(ENGINES.map((engine, i) => [engine, total - probes[i].ok.length]));
  console.error(`${files.length} of ${total} documents opened in all four (refused: ${JSON.stringify(leftOut)})`);
  const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);

  /** samples[job][engine][round] */
  const samples = Object.fromEntries(jobs.map((job) => [job, Object.fromEntries(ENGINES.map((engine) => [engine, []]))]));
  const shared = { files, report, large, heavy, poster };
  const gate = quietGate({
    maxLoad: values["max-load"] ? Number(values["max-load"]) : undefined,
    minIdle: values["min-idle"] ? Number(values["min-idle"]) / 100 : undefined,
    maxWait: values["max-wait"] ? Number(values["max-wait"]) : undefined,
  });
  const random = seeded(Number(values.seed));
  const rowsOf = (job) => Object.entries(ROWS).filter(([, row]) => row.job === job);
  const settled = (job) =>
    rowsOf(job).every(([, row]) => {
      const recto = samples[job].recto.map((s) => valueOf(row, s));
      return ENGINES.slice(1).every((engine) => {
        const mine = samples[job][engine].map((s) => valueOf(row, s));
        // A value that can't be a ratio (a 0 ms stop) has nothing to settle.
        return mine.some((v) => !(v > 0)) || recto.some((v) => !(v > 0)) || decided(pairedRatio(mine, recto), tolerance);
      });
    });
  const active = new Set(jobs);
  const roundsRun = {};
  for (let round = 0; round < maxRounds && active.size > 0; round++) {
    const started = Date.now();
    for (const job of jobs) {
      if (!active.has(job)) continue;
      for (const engine of shuffled(ENGINES, random)) {
        const at = await gate.wait();
        const result = await child({ job, engine, ...shared });
        samples[job][engine].push({ ...result, at: { load: round2(at.load), idle: round2(at.idle), forced: at.forced } });
      }
      roundsRun[job] = round + 1;
    }
    for (const job of [...active]) if (round + 1 >= minRounds && settled(job)) active.delete(job);
    console.error(`round ${round + 1}: ${Date.now() - started} ms, ${active.size ? `still running ${[...active].join(", ")}` : "all settled"}`);
  }

  const summary = {};
  for (const [key, row] of Object.entries(ROWS)) {
    if (!samples[row.job]) continue;
    const recto = samples[row.job].recto.map((s) => valueOf(row, s));
    summary[key] = { measure: row.measure, rounds: samples[row.job].recto.length };
    for (const engine of ENGINES) {
      const mine = samples[row.job][engine].map((s) => valueOf(row, s));
      summary[key][engine] = { median: ms(median(mine)), runs: mine.map(ms) };
      if (engine !== "recto") Object.assign(summary[key][engine], compareRow(mine, recto));
      // A CPU row keeps its wall time beside it, so the two can be read together.
      if (row.measure === "thread") {
        const wall = samples[row.job][engine].map((s) => valueOf(row, s, "wall"));
        const rectoWall = samples[row.job].recto.map((s) => valueOf(row, s, "wall"));
        summary[key][engine].wall = { median: ms(median(wall)), ...(engine !== "recto" ? compareRow(wall, rectoWall) : {}) };
      }
    }
  }
  const first = (job) => samples[job]?.recto[0];
  const results = {
    date: new Date().toISOString(),
    node: process.version,
    machine: `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
    loadAverage: os.loadavg()[0],
    method: {
      rounds: { min: minRounds, max: maxRounds, run: roundsRun },
      tolerance,
      order: "each job's four engines back to back, shuffled each round",
      interval: "Hodges-Lehmann estimate of the paired ratio, exact Wilcoxon signed-rank interval",
      seconds: Math.round((Date.now() - begun) / 1000),
    },
    // The 1-minute load average and the CPUs' idle share as each measured process started.
    quiet: gate.summary(),
    versions: Object.fromEntries(
      ["pdfjs-dist", "@embedpdf/pdfium", "mupdf"].map((name) => [name, JSON.parse(fs.readFileSync(path.join(here, "node_modules", name, "package.json"))).version]),
    ),
    documents: { used: files.length, of: total, refused: leftOut, bytes, largePages: LARGE_PAGES, largeRendered: LARGE_RENDERED },
    widths: { render: WIDTH, textPages: TEXT_PAGES, renderPages: RENDER_PAGES },
    pagesRead: first("speed")?.text.pages,
    pagesRendered: first("speed")?.render.pages,
    chars: samples.speed ? Object.fromEntries(ENGINES.map((engine) => [engine, samples.speed[engine][0].text.chars])) : undefined,
    how: samples.abort ? { abort: Object.fromEntries(ENGINES.map((engine) => [engine, samples.abort[engine][0].how])) } : undefined,
    summary,
  };
  const out = values.out ?? path.join(here, "results/node.json");
  fs.writeFileSync(out, `${JSON.stringify(results, null, 1)}\n`);
  if (values.raw) fs.writeFileSync(values.raw, `${JSON.stringify(samples)}\n`);
  console.log(
    JSON.stringify(
      Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, Object.fromEntries(ENGINES.map((e) => [e, v[e].ratio ? `${v[e].median} (${v[e].ratio}x ${v[e].interval})` : v[e].median]))])),
      null,
      1,
    ),
  );
  console.error(`wrote ${out} in ${results.method.seconds} s`);
}

if (!isMainThread) {
  const engine = await load(workerData.engine);
  const doc = await engine.open(new Uint8Array(fs.readFileSync(workerData.heavy)));
  if (workerData.started) parentPort.postMessage("started");
  const started = performance.now();
  await renderBytes(doc, 0, WIDTH);
  if (!workerData.started) parentPort.postMessage(performance.now() - started);
} else if (process.env.RECTO_BENCH_JOB) {
  const request = JSON.parse(process.env.RECTO_BENCH_JOB);
  const result = await jobs[request.job](request);
  console.log(`\n@@${JSON.stringify(result)}`);
  process.exit(0);
} else {
  await main();
}
