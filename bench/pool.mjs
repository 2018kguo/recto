#!/usr/bin/env node
// What createPdfPool gives over one thread, on a generated report, and what it costs in memory.
//
//   npm run build
//   node bench/pool.mjs [--pages 2000] [--threads 1,2,4,8] [--out bench/results/pool.json]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { createPdfEngine, createPdfPool } from "../js/dist/index.js";
import { reportPdf } from "./generate.mjs";

const { values } = parseArgs({
  options: {
    pages: { type: "string", default: "2000" },
    threads: { type: "string", default: "1,2,4,8" },
    runs: { type: "string", default: "3" },
    out: { type: "string" },
    child: { type: "string" },
  },
});
const RENDERED = 200;
const median = (list) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)];
const bytes = reportPdf({ pages: Number(values.pages), imageEvery: 10, imageSize: 240 });

async function timed(work) {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

/** One process per measurement, so its peak memory is its own. */
if (values.child) {
  const count = Number(values.pages);
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  let text;
  let render;
  if (values.child === "direct") {
    const doc = await (await createPdfEngine()).open(bytes);
    text = await timed(() => range(count).forEach((i) => doc.text(i)));
    render = await timed(() => range(RENDERED).forEach((i) => doc.render(i, { width: 800 })));
  } else {
    const pool = await createPdfPool({ threads: Number(values.child) });
    const doc = await pool.open(bytes);
    // Warm: every thread has started, with its copy of the file. Starting is reported apart.
    const start = await timed(async () => {
      while (pool.stats().threads < Number(values.child)) await Promise.all(range(64).map((i) => doc.text(i)));
    });
    // Each result dropped as it arrives, as the direct run's are: this measures the pool's memory.
    const drop = () => undefined;
    text = await timed(() => Promise.all(range(count).map((i) => doc.text(i).then(drop))));
    render = await timed(() => Promise.all(range(RENDERED).map((i) => doc.render(i, { width: 800 }).then(drop))));
    pool.close();
    console.log(JSON.stringify({ start, text, render, rss: process.resourceUsage().maxRSS * 1024 }));
    process.exit(0);
  }
  console.log(JSON.stringify({ start: 0, text, render, rss: process.resourceUsage().maxRSS * 1024 }));
  process.exit(0);
}

const runs = Number(values.runs);
const sample = (child) => {
  const list = [];
  for (let i = 0; i < runs; i++) {
    list.push(JSON.parse(execFileSync(process.execPath, [import.meta.filename, "--child", child, "--pages", values.pages], { encoding: "utf8", maxBuffer: 1 << 24 })));
  }
  return Object.fromEntries(["start", "text", "render", "rss"].map((key) => [key, Math.round(median(list.map((s) => s[key])) * 10) / 10]));
};
const results = { direct: sample("direct") };
for (const threads of values.threads.split(",")) results[threads] = sample(threads);
const output = {
  date: new Date().toISOString(),
  machine: `${os.cpus()[0].model}, ${os.cpus().length} cores`,
  loadAverage: os.loadavg()[0],
  node: process.version,
  pages: Number(values.pages),
  rendered: RENDERED,
  fileBytes: bytes.length,
  results,
};
if (values.out) fs.writeFileSync(path.resolve(values.out), `${JSON.stringify(output, null, 1)}\n`);
console.log(JSON.stringify(output));
