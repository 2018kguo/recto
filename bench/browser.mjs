#!/usr/bin/env node
// The same four engines in Chromium: what a page downloads, how long it takes, what the main
// thread feels, and what memory is left. docs/benchmarks.md says what each number means.
//
//   npm run build
//   npm run bench:browser -- <directory of PDFs> [--docs 8] [--runs 5] [--slowdown 4] [--max-load 4] [--out bench/results/browser.json]
//
// The slowdown stops and resumes the whole browser (see cdp.mjs); --slowdown 1 runs at full speed.
// `--max-load` holds each engine's run until the 1-minute load average is under it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { launch, newPage } from "./cdp.mjs";
import { cjkPdf, heavyPagePdf, reportPdf } from "./generate.mjs";
import { serve } from "./serve.mjs";

const here = import.meta.dirname;
const ENGINES = ["recto", "pdf.js", "pdfium", "mupdf"];
const WIDTH = 800;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    docs: { type: "string", default: "8" },
    runs: { type: "string", default: "5" },
    slowdown: { type: "string", default: "4" },
    out: { type: "string", default: path.join(here, "results/browser.json") },
    "max-load": { type: "string" },
  },
});
const directory = positionals[0];
if (!directory) {
  console.error("usage: browser.mjs <directory of PDFs> [--docs 8] [--runs 5] [--out file.json]");
  process.exit(2);
}

const server = await serve();
const { origin, docs } = server;
// A stuck page ends the run; the clock restarts with each engine's run, so waiting for a quiet
// machine doesn't count.
let deadline;
const arm = () => {
  clearTimeout(deadline);
  deadline = setTimeout(() => {
    console.error("browser bench: a run took over 30 minutes");
    process.exit(1);
  }, 30 * 60_000);
};
arm();
const loads = [];
const maxLoad = values["max-load"] ? Number(values["max-load"]) : Infinity;
const quiet = async () => {
  for (let waited = 0; os.loadavg()[0] > maxLoad; waited += 5) {
    if (waited % 300 === 0) console.error(`load ${os.loadavg()[0].toFixed(1)}, waiting for under ${maxLoad}`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  arm();
  loads.push(os.loadavg()[0]);
};

docs.set("report.pdf", reportPdf({ pages: 40, imageSize: 240 }));
docs.set("cjk.pdf", cjkPdf());
docs.set("large.pdf", reportPdf({ pages: 500, imageEvery: 10, imageSize: 240 }));
docs.set("heavy.pdf", heavyPagePdf({ paths: 300_000 }));
const all = fs
  .readdirSync(directory)
  .filter((name) => name.toLowerCase().endsWith(".pdf"))
  .sort();
const wanted = Math.min(Number(values.docs), all.length);
const corpus = [];
for (let i = 0; i < wanted; i++) {
  const name = all[Math.floor((i * all.length) / wanted)];
  docs.set(`c${i}.pdf`, new Uint8Array(fs.readFileSync(path.join(directory, name))));
  corpus.push(`/doc/c${i}.pdf`);
}

async function openPage(browser, engine, doc, extra = "") {
  const page = await newPage(browser);
  await page.goto(`${origin}/app/index.html?engine=${encodeURIComponent(engine)}&doc=${encodeURIComponent(doc)}&width=${WIDTH}${extra}`);
  const deadline = Date.now() + 120_000;
  while (!(await page.evaluate("Boolean(window.bench)").catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`${engine} never became ready: ${page.logs.join("; ")}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return page;
}

/** Past a full collection, the page's JS heap and every worker's, and WebAssembly memory. */
async function memory(page, browser) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  let heap = 0;
  let wasm = 0;
  for (const session of [undefined, ...page.workers]) {
    await browser.send("HeapProfiler.collectGarbage", {}, session ?? page.sessionId);
    const { usedSize } = await browser.send("Runtime.getHeapUsage", {}, session ?? page.sessionId);
    heap += usedSize;
    wasm += (await page.evaluate("self.__bench?.wasmBytes() ?? 0", session ? { session } : undefined)) ?? 0;
  }
  return { heap, wasm };
}

const longestWorkerGap = async (page) => {
  let longest = 0;
  for (const session of page.workers) {
    longest = Math.max(longest, (await page.evaluate("self.__bench?.longestGap ?? 0", { session })) ?? 0);
  }
  return longest;
};

const median = (list) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)];
const interval = (slower, faster, draws = 2000) => {
  const pick = (list) => median(Array.from(list, () => list[Math.floor(Math.random() * list.length)]));
  const ratios = Array.from({ length: draws }, () => pick(slower) / pick(faster)).sort((a, b) => a - b);
  return [ratios[Math.floor(draws * 0.025)], ratios[Math.floor(draws * 0.975)]].map((v) => Math.round(v * 100) / 100);
};

// At full speed: what each page downloads, then the fixed loop that states the slowdown.
const fast = await launch();
const bundle = {};
for (const engine of ENGINES) {
  bundle[engine] = {};
  for (const [label, doc, extra] of [
    ["text", "/doc/report.pdf"],
    ["cjk", "/doc/cjk.pdf"],
    ["textOnly", "/doc/report.pdf", "&textOnly"],
  ]) {
    const responses = server.responses;
    responses.length = 0;
    const page = await openPage(fast, engine, doc, extra);
    bundle[engine][label] = {
      raw: responses.reduce((sum, r) => sum + r.raw, 0),
      brotli: responses.reduce((sum, r) => sum + r.brotli, 0),
      files: [...responses],
    };
    await page.close();
  }
}
const spin = async (browser) => {
  await quiet();
  const page = await openPage(browser, "recto", "/doc/report.pdf");
  const list = [];
  for (let i = 0; i < 3; i++) list.push((await page.evaluate("window.bench.spin()")).ms);
  await page.close();
  return median(list);
};
const fastSpin = await spin(fast);
await fast.close();

const browser = await launch({ slowdown: Number(values.slowdown) });
const browserVersion = (await browser.send("Browser.getVersion", {})).product;
const slowSpin = await spin(browser);
console.error(`slowdown: ${(slowSpin / fastSpin).toFixed(1)}x (${Math.round(fastSpin)} ms to ${Math.round(slowSpin)} ms)`);

const samples = Object.fromEntries(ENGINES.map((engine) => [engine, []]));
const runs = Number(values.runs);
for (let run = 0; run < runs; run++) {
  for (let k = 0; k < ENGINES.length; k++) {
    const engine = ENGINES[(run + k) % ENGINES.length];
    await quiet();
    const started = Date.now();
    const page = await openPage(browser, engine, "/doc/report.pdf");
    const cold = await page.evaluate("window.bench.cold");
    const call = (name, ...args) => page.evaluate(`window.bench.${name}(...${JSON.stringify(args)})`);
    const warm = await call("warm", "/doc/report.pdf");
    const speed = await call("speed", corpus, 20, 2);
    const large = await call("large", "/doc/large.pdf", 5);
    await page.close();
    // In a page of its own, so the memory left is this document's and nothing else's.
    const fresh = await openPage(browser, engine, "/doc/report.pdf");
    for (const session of fresh.workers) await fresh.evaluate("self.__bench?.reset()", { session });
    const load = await fresh.evaluate(`window.bench.load("/doc/report.pdf")`);
    load.longestGapInWorker = await longestWorkerGap(fresh);
    const left = await memory(fresh, browser);
    await fresh.close();
    // One page too slow to wait for: what its render does to each thread.
    const heavyPage = await openPage(browser, engine, "/doc/report.pdf");
    for (const session of heavyPage.workers) await heavyPage.evaluate("self.__bench?.reset()", { session });
    const heavy = await heavyPage.evaluate(`window.bench.load("/doc/heavy.pdf")`);
    heavy.longestGapInWorker = await longestWorkerGap(heavyPage);
    await heavyPage.close();
    let sliced = { done: 0, longestGapInWorker: 0 };
    if (engine === "recto") {
      const page = await openPage(browser, engine, "/doc/report.pdf");
      for (const session of page.workers) await page.evaluate("self.__bench?.reset()", { session });
      sliced = await page.evaluate(`window.bench.sliced("/doc/heavy.pdf")`);
      sliced.longestGapInWorker = await longestWorkerGap(page);
      await page.close();
    }
    samples[engine].push({ cold, warm, speed, large, load, heavy, sliced, memory: left });
    console.error(`run ${run + 1}/${runs} ${engine}: ${Date.now() - started} ms`);
  }
}
const abortPage = await openPage(browser, "pdf.js", "/doc/report.pdf");
const pdfjsAbort = await abortPage.evaluate(`window.bench.abort("/doc/heavy.pdf")`);
await abortPage.close();
await browser.close();
await server.close();
clearTimeout(deadline);

const pickers = {
  coldText: (s) => s.cold.text,
  coldRender: (s) => s.cold.render,
  warmText: (s) => s.warm.text,
  warmRender: (s) => s.warm.render,
  text: (s) => s.speed.text,
  render: (s) => s.speed.render,
  largeOpen: (s) => s.large.open,
  largeText: (s) => s.large.text,
  largeRender: (s) => s.large.render,
  loadDone: (s) => s.load.done,
  stutter: (s) => s.load.stutter,
  longestTask: (s) => s.load.longestTask,
  longestGapInWorker: (s) => s.load.longestGapInWorker,
  heavyDone: (s) => s.heavy.done,
  heavyStutter: (s) => s.heavy.stutter,
  heavyLongestTask: (s) => s.heavy.longestTask,
  heavyGapInWorker: (s) => s.heavy.longestGapInWorker,
  slicedDone: (s) => s.sliced.done,
  slicedGapInWorker: (s) => s.sliced.longestGapInWorker,
  heap: (s) => s.memory.heap,
  wasm: (s) => s.memory.wasm,
};
const summary = {};
for (const [key, pick] of Object.entries(pickers)) {
  summary[key] = {};
  const recto = samples.recto.map(pick);
  for (const engine of ENGINES) {
    const mine = samples[engine].map(pick);
    summary[key][engine] = { median: Math.round(median(mine) * 10) / 10, runs: mine.map((v) => Math.round(v * 10) / 10) };
    if (engine !== "recto" && median(recto) > 0) {
      summary[key][engine].ratio = Math.round((median(mine) / median(recto)) * 100) / 100;
      summary[key][engine].interval = interval(mine, recto);
    }
  }
}
const results = {
  date: new Date().toISOString(),
  machine: `${os.cpus()[0].model}, ${os.cpus().length} cores`,
  loadAverage: os.loadavg()[0],
  // The 1-minute load average as each engine's run started.
  loads: { maxAllowed: Number.isFinite(maxLoad) ? maxLoad : null, median: Math.round(median(loads) * 10) / 10, max: Math.round(Math.max(...loads) * 10) / 10 },
  browser: browserVersion,
  slowdown: { how: "the browser's processes stopped and resumed", asked: Number(values.slowdown), factor: Math.round((slowSpin / fastSpin) * 10) / 10 },
  width: WIDTH,
  documents: corpus.length,
  pages: { read: samples.recto[0].speed.pages, rendered: samples.recto[0].speed.rendered, report: samples.recto[0].load.pages },
  pdfjsCancel: Math.round(pdfjsAbort * 10) / 10,
  bundle,
  summary,
};
fs.writeFileSync(values.out, `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify({ bundle: Object.fromEntries(ENGINES.map((e) => [e, { text: [bundle[e].text.raw, bundle[e].text.brotli], cjk: [bundle[e].cjk.raw, bundle[e].cjk.brotli], textOnly: [bundle[e].textOnly.raw, bundle[e].textOnly.brotli] }])), slowdown: results.slowdown, pdfjsCancel: results.pdfjsCancel, medians: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, ENGINES.map((e) => v[e].median)])) }, null, 0));
process.exit(0);
