#!/usr/bin/env node
// The viewer in real browsers: the built package, its worker and its wasm, as a page loads them.
// Opens the demo on a generated report and checks what a reader would: a page drawn, its text
// selectable, find, zoom, links, and nothing on the console. Chromium always; WebKit and Firefox
// when Playwright has them.
//
//   npm run build && npm install --prefix bench && node bench/viewer-smoke.mjs
import assert from "node:assert/strict";
import path from "node:path";

import { chromium, firefox, webkit } from "playwright";

import { reportPdf } from "./generate.mjs";
import { serve } from "./serve.mjs";

const here = import.meta.dirname;
const server = await serve({ extraRoots: { demo: path.join(here, "viewer-demo") } });
server.docs.set("sample.pdf", reportPdf({ pages: 60, imageEvery: 4, imageSize: 320 }));
let failed = false;

async function check(browserType, viewport) {
  let browser;
  try {
    browser = await browserType.launch();
  } catch (error) {
    console.log(`${browserType.name()}: not installed, skipped (${String(error.message).split("\n")[0]})`);
    return;
  }
  const page = await browser.newPage({ viewport });
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(String(error)));
  const label = `${browserType.name()} ${viewport.width}x${viewport.height}`;
  try {
    const started = Date.now();
    await page.goto(`${server.origin}/demo/index.html?src=${encodeURIComponent("/doc/sample.pdf")}`);
    const viewer = "recto-viewer";
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.shadowRoot?.querySelector('.recto-page[data-rendered="true"]'),
      viewer,
      { timeout: 60_000 }
    );
    const firstPageMs = Date.now() - started;
    const state = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      const root = element.shadowRoot;
      const canvas = root.querySelector('.recto-page[data-page-number="1"] canvas');
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 4 * 97) if (pixels[i] < 200) ink++;
      return {
        pageCount: element.viewer.pageCount,
        of: root.querySelector(".of").textContent,
        canvas: [canvas.width, canvas.height],
        ink,
        pageWidth: root.querySelector('.recto-page[data-page-number="1"]').getBoundingClientRect().width,
        scrollWidth: element.viewer.element.scrollWidth,
        clientWidth: element.viewer.element.clientWidth,
      };
    }, viewer);
    assert.equal(state.pageCount, 60, label);
    assert.equal(state.of, "of 60");
    assert.ok(state.ink > 50, `${label}: page 1 is drawn (${state.ink} dark samples)`);
    assert.ok(state.canvas[0] >= state.pageWidth, `${label}: the canvas is at least device density`);
    assert.ok(state.scrollWidth <= state.clientWidth + 1, `${label}: fits the width at 100%`);
    // The text layer: selectable text over the page.
    await page.waitForFunction(
      (selector) => document.querySelector(selector).shadowRoot.querySelector('.recto-page[data-page-number="1"] .recto-text span'),
      viewer
    );
    const text = await page.evaluate(
      (selector) => document.querySelector(selector).shadowRoot.querySelector('.recto-page[data-page-number="1"] .recto-text').textContent,
      viewer
    );
    assert.match(text, /Tern & Alder Freight/u, `${label}: the text layer reads the page`);
    // Find: a word on many pages, the current hit scrolled to and highlighted.
    await page.evaluate((selector) => document.querySelector(selector).openFind("corridor"), viewer);
    await page.waitForFunction(
      (selector) => /^\d+ of \d+$/u.test(document.querySelector(selector).shadowRoot.querySelector(".count").textContent),
      viewer,
      { timeout: 30_000 }
    );
    const found = await page.evaluate((selector) => {
      const root = document.querySelector(selector).shadowRoot;
      return { count: root.querySelector(".count").textContent, active: root.querySelectorAll(".recto-highlights > .recto-active").length };
    }, viewer);
    assert.equal(found.active, 1, `${label}: one current hit`);
    // Zoom: the page grows at once, and a sharper bitmap follows.
    const zoom = await page.evaluate(async (selector) => {
      const viewer = document.querySelector(selector).viewer;
      const page = viewer.pageElement(viewer.page);
      const before = page.querySelector("canvas").width;
      const width = page.getBoundingClientRect().width;
      viewer.zoomIn();
      viewer.zoomIn();
      const grown = page.getBoundingClientRect().width / width;
      const deadline = performance.now() + 15_000;
      while (page.querySelector("canvas").width <= before && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { before, after: page.querySelector("canvas").width, grown };
    }, viewer);
    assert.ok(Math.abs(zoom.grown - 1.5) < 0.01, `${label}: zoom resized the page (${zoom.grown})`);
    assert.ok(zoom.after > zoom.before, `${label}: a sharper bitmap replaced the stretched one`);
    assert.deepEqual(problems, [], `${label}: console`);
    console.log(`${label}: ok — first page ${firstPageMs} ms, ${found.count} for "corridor", zoom ${zoom.before} → ${zoom.after} px`);
  } catch (error) {
    failed = true;
    console.error(`${label}: FAILED`, error.message, problems);
  } finally {
    await browser.close();
  }
}

for (const browserType of [chromium, webkit, firefox]) {
  await check(browserType, { width: 1200, height: 900 });
}
// A phone: the toolbar fits, the page fits the width.
await check(chromium, { width: 390, height: 844 });
await server.close();
process.exit(failed ? 1 : 0);
