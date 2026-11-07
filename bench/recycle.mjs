#!/usr/bin/env node
// What a recycle policy costs a repeated large file, and what it holds at rest. Each policy runs in
// a process of its own: 300 cycles of open, text, render, close on a 70 MiB file, then at rest.
//
//   npm run build
//   node bench/recycle.mjs [--repo dir] [--out bench/results/recycle.json]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { reportPdf } from "./generate.mjs";

const here = import.meta.dirname;
const CYCLES = 300;
const FILE_MIB = 70;

if (process.argv[2] === "--child") {
  const [, , , repo, mark] = process.argv;
  const { createPdfEngine } = await import(path.join(repo, "js/dist/index.js"));
  const bytes = new Uint8Array(FILE_MIB * 2 ** 20);
  bytes.set(reportPdf({ pages: 2, imageSize: 240 }));
  const engine = await createPdfEngine(mark === "default" ? {} : { recycleAboveBytes: Number(mark) * 2 ** 20 });
  const started = performance.now();
  // In a function of its own: a suspended async function can hold its last `doc` in a register.
  const cycle = async () => {
    const doc = await engine.open(bytes);
    doc.text(0);
    doc.render(0, { width: 1024 });
    doc.close();
  };
  for (let i = 0; i < CYCLES; i++) {
    await cycle();
  }
  const seconds = (performance.now() - started) / 1000;
  const peakRssMB = process.resourceUsage().maxRSS * 1024 / 1e6;
  const heapAtEndMB = engine.stats().heapBytes / 1e6;
  const generations = engine.stats().generation;
  // At rest, with the file dropped: what a job leaves behind a few seconds later.
  bytes.fill(0);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  globalThis.gc();
  await new Promise((resolve) => setTimeout(resolve, 100));
  globalThis.gc();
  console.log(
    JSON.stringify({
      seconds: +seconds.toFixed(2),
      peakRssMB: Math.round(peakRssMB),
      generations,
      heapAtEndMB: Math.round(heapAtEndMB),
      restHeapMB: Math.round(engine.stats().heapBytes / 1e6),
      restRssMB: Math.round(process.memoryUsage().rss / 1e6),
    })
  );
  process.exit(0);
}

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: path.join(here, "..") },
    out: { type: "string", default: path.join(here, "results/recycle.json") },
  },
});
const results = { cycles: CYCLES, fileMiB: FILE_MIB, policies: {} };
for (const mark of ["default", "64", "128", "256", "512"]) {
  const out = execFileSync(process.execPath, ["--expose-gc", import.meta.filename, "--child", path.resolve(values.repo), mark], { encoding: "utf8" });
  results.policies[mark === "default" ? "default" : `at close past ${mark} MiB`] = JSON.parse(out);
  console.log(mark, out.trim());
}
fs.writeFileSync(values.out, `${JSON.stringify(results, null, 2)}\n`);
