#!/usr/bin/env node
// The viewer's numbers in a real browser, on generated reports: time to the first page, frames and
// long tasks while scrolling a long document, what is held after scrolling all of it, and how long a
// deep zoom takes to turn sharp (and how sharp it gets).
//
//   npm run build && npm install --prefix bench && node bench/viewer-perf.mjs [--browser chromium] [--out file.json]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium, firefox, webkit } from "playwright";

import { reportPdf } from "./generate.mjs";
import { serve } from "./serve.mjs";

const { values } = parseArgs({ options: { browser: { type: "string", default: "chromium" }, out: { type: "string" }, runs: { type: "string", default: "3" } } });
const browserType = { chromium, firefox, webkit }[values.browser];
const runs = Number(values.runs);
const here = import.meta.dirname;
const server = await serve({ extraRoots: { demo: path.join(here, "viewer-demo") } });
// 520 pages read whole (under the 8 MiB cut), and 600 heavier ones past it, read by range.
const docs = {
  "long.pdf": reportPdf({ pages: 520, imageEvery: 40, imageSize: 240 }),
  "ranged.pdf": reportPdf({ pages: 600, imageEvery: 4, imageSize: 320 }),
};
for (const [name, bytes] of Object.entries(docs)) {
  server.docs.set(name, bytes);
}

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function once(name) {
  const browser = await browserType.launch();
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const cdp = browserType === chromium ? await context.newCDPSession(page) : null;
  await cdp?.send("Performance.enable");
  const result = { doc: name, bytes: docs[name].length };
  try {
    const started = Date.now();
    await page.goto(`${server.origin}/demo/index.html?src=${encodeURIComponent(`/doc/${name}`)}`);
    await page.waitForFunction(() => document.querySelector("recto-viewer")?.shadowRoot?.querySelector('.recto-page[data-rendered="true"]'), null, { timeout: 60_000 });
    result.firstPageMs = Date.now() - started;
    result.pageCount = await page.evaluate(() => document.querySelector("recto-viewer").viewer.pageCount);

    // Scrolling: a steady 2400 px/s through the document for 4 s, frames timed by rAF.
    Object.assign(
      result,
      await page.evaluate(async () => {
        const scroller = document.querySelector("recto-viewer").viewer.element;
        const longTasks = [];
        let observer = null;
        if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
          observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)));
          observer.observe({ type: "longtask" });
        }
        const frames = [];
        let last = performance.now();
        const end = last + 4000;
        await new Promise((resolve) => {
          const step = (now) => {
            frames.push(now - last);
            scroller.scrollTop += (2400 * (now - last)) / 1000;
            last = now;
            if (now < end) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        });
        observer?.disconnect();
        const sorted = frames.slice(1).sort((a, b) => a - b);
        return {
          scrollFps: Math.round((1000 * sorted.length) / sorted.reduce((a, b) => a + b, 0)),
          scrollP95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
          scrollDroppedFrames: sorted.filter((ms) => ms > 25).length,
          longTasks: longTasks.length,
          longTaskMs: Math.round(longTasks.reduce((a, b) => a + b, 0)),
        };
      })
    );

    // The whole document, a screen at a time, then let it settle.
    await page.evaluate(async () => {
      const scroller = document.querySelector("recto-viewer").viewer.element;
      scroller.scrollTop = 0;
      while (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) {
        scroller.scrollTop += scroller.clientHeight;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    });
    if (cdp) {
      await cdp.send("HeapProfiler.collectGarbage");
      const { metrics } = await cdp.send("Performance.getMetrics");
      const metric = (key) => metrics.find((entry) => entry.name === key)?.value ?? 0;
      result.heapMB = Math.round(metric("JSHeapUsedSize") / 1e5) / 10;
      result.domNodes = metric("Nodes");
    }
    result.canvasMB = await page.evaluate(() => {
      let pixels = 0;
      for (const canvas of document.querySelector("recto-viewer").shadowRoot.querySelectorAll("canvas")) pixels += canvas.width * canvas.height;
      return Math.round((pixels * 4) / 1e5) / 10;
    });

    // Deep zoom: page 3 at 100%, then 400% around the middle; how long until the middle of the screen
    // is drawn at the screen's density, and how close it gets.
    Object.assign(
      result,
      await page.evaluate(async () => {
        const viewer = document.querySelector("recto-viewer").viewer;
        const root = document.querySelector("recto-viewer").shadowRoot;
        viewer.fitWidth();
        await viewer.goToPage(3);
        const target = Math.min(2, devicePixelRatio);
        const rect = viewer.element.getBoundingClientRect();
        const cx = rect.left + viewer.element.clientWidth / 2;
        const cy = rect.top + viewer.element.clientHeight / 2;
        // Device pixels per CSS pixel at the middle of the screen: the densest canvas over it.
        const density = () => {
          let best = 0;
          for (const canvas of root.querySelectorAll(".recto-page canvas")) {
            const box = canvas.getBoundingClientRect();
            if (box.width > 0 && cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) best = Math.max(best, canvas.width / box.width);
          }
          return best;
        };
        // Until the middle is at the screen's density, or nothing has changed there for 1.5 s: when
        // the last change landed (the time to the sharpest it gets).
        const settle = async (started) => {
          let last = density();
          let changedAt = started;
          while (last < target * 0.97 && performance.now() - changedAt < 1500 && performance.now() - started < 15_000) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            const now = density();
            if (now !== last) {
              last = now;
              changedAt = performance.now();
            }
          }
          return changedAt - started;
        };
        await settle(performance.now());
        const out = {};
        for (const zoom of [2, 4]) {
          viewer.fitWidth();
          await new Promise((resolve) => setTimeout(resolve, 600));
          await settle(performance.now());
          const started = performance.now();
          viewer.setZoom(zoom);
          out[`zoom${zoom * 100}SharpMs`] = Math.round(await settle(started));
          out[`zoom${zoom * 100}Density`] = Math.round((density() / target) * 100) / 100;
        }
        return out;
      })
    );
  } finally {
    await browser.close();
  }
  return result;
}

const results = {};
for (const name of Object.keys(docs)) {
  const all = [];
  for (let run = 0; run < runs; run++) {
    try {
      all.push(await once(name));
    } catch (error) {
      all.push({ doc: name, error: String(error.message).split("\n")[0] });
    }
  }
  const ok = all.filter((entry) => !entry.error);
  const summary = { doc: name, runs: all.length, failures: all.length - ok.length };
  for (const key of Object.keys(ok[0] ?? {})) {
    if (typeof ok[0][key] === "number") summary[key] = median(ok.map((entry) => entry[key]));
  }
  if (ok.length === 0) summary.error = all[0]?.error;
  results[name] = summary;
  console.log(JSON.stringify(summary));
}
if (values.out) fs.writeFileSync(values.out, JSON.stringify({ browser: values.browser, results }, null, 2));
await server.close();
