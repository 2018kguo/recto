#!/usr/bin/env node
// The side-by-side comparison, scripted, in headless Chromium: for each network preset, `--runs`
// fresh browsers each open the page and play the script (open, scroll to page 50, zoom to 300%,
// find a word) on recto and then pdf.js, alternating which goes first. Writes every run and the
// medians to a JSON file and prints a table.
//
//   npm run build && npm run bench:compare -- [--doc report-200.pdf] [--network none,fast-4g,slow-3g]
//     [--runs 3] [--out bench/results/compare.json] [--video dir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

import { sampleDocs } from "./samples.mjs";
import { NETWORKS, serveCompare } from "./serve.mjs";

const { values } = parseArgs({
  options: {
    doc: { type: "string", default: "report-200.pdf" },
    network: { type: "string", default: "none,fast-4g,slow-3g" },
    runs: { type: "string", default: "3" },
    out: { type: "string" },
    video: { type: "string" },
    headed: { type: "boolean", default: false },
  },
});
const networks = values.network.split(",");
for (const network of networks) {
  if (!NETWORKS[network]) throw new Error(`unknown network ${network}; one of ${Object.keys(NETWORKS).join(", ")}`);
}
const runs = Number(values.runs);
const docs = sampleDocs();
if (!docs.has(values.doc)) {
  const file = values.doc;
  docs.set(`local/${path.basename(file)}`, { label: path.basename(file), bytes: new Uint8Array(fs.readFileSync(file)) });
  values.doc = `local/${path.basename(file)}`;
}
const server = await serveCompare({ docs });
const SIDES = ["recto", "pdfjs"];
const METRICS = [
  ["firstPaintMs", "First page", "ms"],
  ["sharpMs", "Screen sharp", "ms"],
  ["downloadedBytes", "Downloaded", "bytes"],
  ["codeBrotliBytes", "JS + wasm, brotli", "bytes"],
  ["scrollLongTasks", "Long tasks, scrolling", "n"],
  ["scrollLongTaskMs", "Long-task time, scrolling", "ms"],
  ["scrollP95FrameMs", "p95 frame, scrolling", "ms"],
  ["scrollSharpMs", "Page 50 sharp after scroll", "ms"],
  ["zoomSharpMs", "300% sharp", "ms"],
  ["zoomDensity", "300% density reached", "x"],
  ["findMs", "Find", "ms"],
  ["findHits", "Find hits", "n"],
  ["memoryMB", "Memory, incl. workers", "MB"],
  ["canvasMB", "Canvas pixels held", "MB"],
];
const median = (list) => {
  const sorted = list.filter((value) => typeof value === "number").sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};

async function once(network, run) {
  const browser = await chromium.launch({
    // Full Chromium, not the headless shell, which has no memory measure.
    channel: "chromium",
    headless: !values.headed,
    // Lets the page's memory measure answer at once instead of at the next garbage collection.
    args: ["--enable-blink-features=ForceEagerMeasureMemory"],
  });
  const context = await browser.newContext({
    // Tall enough that the panes and every number are on screen at once (the frames are 520 px either way).
    viewport: { width: 1280, height: 1320 },
    deviceScaleFactor: 2,
    ...(values.video && { recordVideo: { dir: values.video, size: { width: 1280, height: 1320 } } }),
  });
  out.browser = `Chromium ${browser.version()}`;
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`page error: ${error.message}`));
  const order = run % 2 === 0 ? "recto,pdfjs" : "pdfjs,recto";
  try {
    await page.goto(`${server.origin}/compare/?doc=${encodeURIComponent(values.doc)}&network=${network}&order=${order}&run`);
    await page.waitForFunction(() => window.compare?.done, null, { timeout: 40 * 60_000, polling: 500 });
    // On film, hold the finished numbers a moment.
    if (values.video) await page.waitForTimeout(3000);
    return await page.evaluate(() => window.compare.result);
  } finally {
    await context.close();
    if (values.video) {
      const name = path.join(values.video, `compare-${path.basename(values.doc, ".pdf")}-${network}-${run + 1}.webm`);
      await page.video()?.saveAs(name);
      await page.video()?.delete();
      console.error(name);
    }
    await browser.close();
  }
}

const out = { doc: values.doc, docBytes: docs.get(values.doc).bytes.length, runs, machine: `${os.cpus()[0]?.model} · ${os.platform()} ${os.release()}`, browser: null, networks: {} };
for (const network of networks) {
  const all = [];
  for (let run = 0; run < runs; run++) {
    const result = await once(network, run);
    if (result?.error) console.error(`${network} run ${run + 1}: ${result.error}`);
    // Both must draw the same pixels, or nothing else here compares.
    for (const key of ["scale", "zoomScale"]) {
      const [a, b] = SIDES.map((side) => result?.[side]?.[key]);
      if (a && b && Math.abs(a - b) > 0.01 * a) console.error(`${network} run ${run + 1}: the sides' ${key} differ, ${a} and ${b}`);
    }
    all.push(result);
    process.stderr.write(`${network} run ${run + 1}/${runs} done\n`);
  }
  const medians = {};
  for (const side of SIDES) {
    medians[side] = {};
    for (const [key] of METRICS) medians[side][key] = median(all.map((result) => result?.[side]?.[key]));
  }
  out.networks[network] = { label: NETWORKS[network].label, medians, runs: all };
}
await server.close();

const format = (value, unit) => {
  if (value === null || value === undefined) return "—";
  if (unit === "bytes") return value >= 1e6 ? `${(value / 1e6).toFixed(2)} MB` : `${Math.round(value / 1e3)} KB`;
  if (unit === "ms") return `${Math.round(value).toLocaleString("en-US")} ms`;
  if (unit === "MB") return `${value} MB`;
  return String(value);
};
for (const [network, { label, medians }] of Object.entries(out.networks)) {
  console.log(`\n${label} · ${values.doc} · median of ${runs}\n`);
  const rows = [["", "recto", "pdf.js"], ...METRICS.map(([key, name, unit]) => [name, format(medians.recto[key], unit), format(medians.pdfjs[key], unit)])];
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i].length)));
  for (const row of rows) console.log(`${row[0].padEnd(widths[0])}  ${row[1].padStart(widths[1])}  ${row[2].padStart(widths[2])}`);
}
const file = values.out ?? path.join(import.meta.dirname, "../results/compare.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\n${file}`);
