// What renderAsync costs and gives, on a page too slow to wait for: the render against the
// synchronous one, the longest the thread is held per slice length, and how fast a stop is.
//   node bench/sliced.mjs [--out bench/results/sliced.json]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { heavyPagePdf } from "./generate.mjs";

const { values } = parseArgs({
  options: { out: { type: "string", default: path.join(import.meta.dirname, "results/sliced.json") } },
});
const { openPdf } = await import("../js/dist/index.js");
const WIDTH = 1024;
const RUNS = 7;
const median = (list) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)];
const round = (ms) => Math.round(ms * 10) / 10;

const doc = await openPdf(heavyPagePdf({ paths: 300_000 }));
doc.render(0, { width: WIDTH });
const sync = [];
for (let i = 0; i < RUNS; i++) {
  const started = performance.now();
  doc.render(0, { width: WIDTH });
  sync.push(performance.now() - started);
}

const slices = {};
for (const sliceMs of [2, 4, 8, 16]) {
  const whole = [];
  const held = [];
  for (let i = 0; i < RUNS; i++) {
    let last = performance.now();
    let longest = 0;
    let going = true;
    const beat = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      if (going) setImmediate(beat);
    };
    setImmediate(beat);
    const started = performance.now();
    await doc.renderAsync(0, { width: WIDTH, sliceMs });
    whole.push(performance.now() - started);
    // The last piece of the render is only seen by the beat after it.
    await new Promise((resolve) => setImmediate(resolve));
    going = false;
    held.push(longest);
  }
  slices[sliceMs] = { whole: round(median(whole)), longestHeld: round(median(held)) };
}
doc.close();

// A page that takes seconds, stopped partway: how long the stop takes, and whether it was mid-page.
const long = await openPdf(heavyPagePdf({ paths: 4_000_000 }));
const stops = [];
for (let i = 0; i < RUNS; i++) {
  const controller = new AbortController();
  const render = long.renderAsync(0, { width: WIDTH, signal: controller.signal }).catch((error) => error.code);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const asked = performance.now();
  controller.abort();
  if ((await render) !== "aborted") throw new Error("the render finished before it was stopped");
  stops.push(performance.now() - asked);
}
const started = performance.now();
const pixels = long.render(0, { width: WIDTH });
const longWhole = performance.now() - started;
if (pixels.width !== WIDTH) throw new Error("the document didn't survive being stopped");
long.close();

const results = {
  date: new Date().toISOString(),
  width: WIDTH,
  sync: round(median(sync)),
  slices,
  stop: { pageTakes: round(longWhole), stopped: round(median(stops)) },
};
fs.writeFileSync(values.out, `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify(results));
