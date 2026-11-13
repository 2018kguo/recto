#!/usr/bin/env node
// recto, pdf.js, stock pdfium and MuPDF in Node, each engine in processes of its own, on a directory of
// PDFs you provide plus generated ones. Nothing here ships PDFs: use files you may read, and do
// not commit them. docs/benchmarks.md says what each number means.
//
//   npm run build
//   npm run bench -- <directory of PDFs> [--docs 60] [--runs 5] [--max-load 8 --min-idle 55] [--out bench/results/node.json]
//
// `--max-load` and `--min-idle` hold each measured process until the 1-minute load average is under
// the one or the CPUs are at least that % idle (see quiet.mjs), so a busy machine delays the numbers
// instead of moving them; what each started at is in the results.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { mupdfEngine, pdfiumEngine, pdfjsEngine, rectoEngine } from "./engines.mjs";
import { heavyPagePdf, reportPdf } from "./generate.mjs";
import { quietGate } from "./quiet.mjs";

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
  const started = performance.now();
  for (const bytes of docs) {
    const doc = await engine.open(bytes);
    const count = Math.min(doc.pageCount, TEXT_PAGES);
    for (let i = 0; i < count; i++) chars += (await doc.text(i)).replace(/\s+/gu, "").length;
    pages += count;
    await doc.close();
  }
  return { ms: performance.now() - started, pages, chars };
}

async function renderPass(engine, docs) {
  let pages = 0;
  const started = performance.now();
  for (const bytes of docs) {
    const doc = await engine.open(bytes);
    const count = Math.min(doc.pageCount, RENDER_PAGES);
    for (let i = 0; i < count; i++) await renderBytes(doc, i, WIDTH);
    pages += count;
    await doc.close();
  }
  return { ms: performance.now() - started, pages };
}

const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
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
    const text = performance.now();
    await renderBytes(doc, 0, WIDTH);
    return { text, render: performance.now() };
  },
  /** One warm-up pass over the files, then the same passes counted. */
  async speed(request) {
    const engine = await load(request.engine);
    const docs = corpus(request);
    await textPass(engine, docs);
    await renderPass(engine, docs);
    const text = await textPass(engine, docs);
    const render = await renderPass(engine, docs);
    const firstText = [];
    const firstRender = [];
    for (const bytes of docs) {
      let started = performance.now();
      let doc = await engine.open(bytes);
      await doc.text(0);
      firstText.push(performance.now() - started);
      await doc.close();
      started = performance.now();
      doc = await engine.open(bytes);
      await renderBytes(doc, 0, WIDTH);
      firstRender.push(performance.now() - started);
      await doc.close();
    }
    return { text, render, firstText: median(firstText), firstRender: median(firstRender), rss: peakRss() };
  },
  /** The generated large document, alone in its process, so the peak is its own. */
  async large({ engine: name, large }) {
    const engine = await load(name);
    const bytes = new Uint8Array(fs.readFileSync(large));
    let started = performance.now();
    const doc = await engine.open(bytes);
    const open = performance.now() - started;
    started = performance.now();
    for (let i = 0; i < doc.pageCount; i++) await doc.text(i);
    const text = performance.now() - started;
    started = performance.now();
    for (let i = 0; i < LARGE_RENDERED; i++) await renderBytes(doc, i * 300, WIDTH);
    const render = performance.now() - started;
    await doc.close();
    return { open, text, render, rss: peakRss() };
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
        let asked = 0;
        if (cancel) {
          setTimeout(() => {
            asked = performance.now();
            render.cancel();
          }, AFTER);
        }
        await render.promise.catch(() => {});
        return { whole: performance.now() - started, stopped: cancel ? performance.now() - (asked || started + AFTER) : null };
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
      const render = doc.renderAsync(0, { width: WIDTH, signal: controller.signal }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, AFTER));
      const asked = performance.now();
      controller.abort();
      await render;
      const stopped = performance.now() - asked;
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

/** The ratio's 95% interval, resampling the runs. */
function ratioInterval(slower, faster, draws = 2000) {
  const pick = (values) => median(Array.from(values, () => values[Math.floor(Math.random() * values.length)]));
  const ratios = Array.from({ length: draws }, () => pick(slower) / pick(faster)).sort((a, b) => a - b);
  return [ratios[Math.floor(draws * 0.025)], ratios[Math.floor(draws * 0.975)]];
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      docs: { type: "string", default: "60" },
      runs: { type: "string", default: "5" },
      out: { type: "string" },
      "max-load": { type: "string" },
      "min-idle": { type: "string" },
    },
  });
  const directory = positionals[0];
  if (!directory) {
    console.error("usage: bench.mjs <directory of PDFs> [--docs 60] [--runs 5] [--out file.json]");
    process.exit(2);
  }
  const all = fs
    .readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort();
  const wanted = Math.min(Number(values.docs), all.length);
  // Every nth file, so the sample is spread over however the directory is ordered.
  let files = Array.from({ length: wanted }, (_, i) => path.join(directory, all[Math.floor((i * all.length) / wanted)]));
  const runs = Number(values.runs);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "recto-bench-"));
  const report = path.join(temp, "report.pdf");
  const large = path.join(temp, "large.pdf");
  const heavy = path.join(temp, "heavy.pdf");
  fs.writeFileSync(report, reportPdf({ pages: 40, imageSize: 240 }));
  fs.writeFileSync(large, reportPdf({ pages: LARGE_PAGES, imageEvery: 10, imageSize: 240 }));
  fs.writeFileSync(heavy, heavyPagePdf({ paths: 300_000 }));

  const probes = await Promise.all(ENGINES.map((engine) => child({ job: "probe", engine, files })));
  const total = files.length;
  files = files.filter((file) => probes.every(({ ok }) => ok.includes(file)));
  const leftOut = Object.fromEntries(ENGINES.map((engine, i) => [engine, total - probes[i].ok.length]));
  console.error(`${files.length} of ${total} documents opened in all four (refused: ${JSON.stringify(leftOut)})`);
  const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);

  const samples = Object.fromEntries(ENGINES.map((engine) => [engine, []]));
  const shared = { files, report, large, heavy };
  const gate = quietGate({
    maxLoad: values["max-load"] ? Number(values["max-load"]) : undefined,
    minIdle: values["min-idle"] ? Number(values["min-idle"]) / 100 : undefined,
  });
  const quiet = gate.wait;
  for (let run = 0; run < runs; run++) {
    for (let k = 0; k < ENGINES.length; k++) {
      const engine = ENGINES[(run + k) % ENGINES.length];
      const started = Date.now();
      const sample = {};
      for (const job of ["cold", "speed", "large", "blocking", "abort"]) {
        await quiet();
        sample[job] = await child({ job, engine, ...shared });
      }
      samples[engine].push(sample);
      console.error(`run ${run + 1}/${runs} ${engine}: ${Date.now() - started} ms`);
    }
  }
  fs.rmSync(temp, { recursive: true, force: true });

  const pickers = {
    text: (s) => s.speed.text.ms,
    render: (s) => s.speed.render.ms,
    coldText: (s) => s.cold.text,
    coldRender: (s) => s.cold.render,
    firstText: (s) => s.speed.firstText,
    firstRender: (s) => s.speed.firstRender,
    largeOpen: (s) => s.large.open,
    largeText: (s) => s.large.text,
    largeRender: (s) => s.large.render,
    rss: (s) => s.speed.rss,
    largeRss: (s) => s.large.rss,
    maxMedian: (s) => s.blocking.maxMedian,
    maxWorst: (s) => s.blocking.maxWorst,
    p99Median: (s) => s.blocking.p99Median,
    abortWhole: (s) => s.abort.whole,
    abortStopped: (s) => s.abort.stopped,
  };
  const summary = {};
  for (const [key, pick] of Object.entries(pickers)) {
    const recto = samples.recto.map(pick);
    summary[key] = {};
    for (const engine of ENGINES) {
      const mine = samples[engine].map(pick);
      summary[key][engine] = { median: ms(median(mine)), runs: mine.map(ms) };
      if (engine !== "recto") {
        summary[key][engine].ratio = Math.round((median(mine) / median(recto)) * 100) / 100;
        summary[key][engine].interval = ratioInterval(mine, recto).map((v) => Math.round(v * 100) / 100);
      }
    }
  }
  const results = {
    date: new Date().toISOString(),
    node: process.version,
    machine: `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
    loadAverage: os.loadavg()[0],
    // The 1-minute load average and the CPUs' idle share as each measured process started.
    quiet: gate.summary(),
    versions: Object.fromEntries(
      ["pdfjs-dist", "@embedpdf/pdfium", "mupdf"].map((name) => [name, JSON.parse(fs.readFileSync(path.join(here, "node_modules", name, "package.json"))).version]),
    ),
    documents: { used: files.length, of: total, refused: leftOut, bytes, largePages: LARGE_PAGES, largeRendered: LARGE_RENDERED },
    widths: { render: WIDTH, textPages: TEXT_PAGES, renderPages: RENDER_PAGES },
    pagesRead: samples.recto[0].speed.text.pages,
    pagesRendered: samples.recto[0].speed.render.pages,
    chars: Object.fromEntries(ENGINES.map((engine) => [engine, samples[engine][0].speed.text.chars])),
    how: { abort: Object.fromEntries(ENGINES.map((engine) => [engine, samples[engine][0].abort.how])) },
    summary,
  };
  const out = values.out ?? path.join(here, "results/node.json");
  fs.writeFileSync(out, `${JSON.stringify(results, null, 1)}\n`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, Object.fromEntries(ENGINES.map((e) => [e, v[e].ratio ? `${v[e].median} (${v[e].ratio}x ${v[e].interval})` : v[e].median]))])), null, 1));
  console.error(`wrote ${out}`);
}
