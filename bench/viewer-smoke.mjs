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
server.docs.set("sample.pdf", reportPdf({ pages: 60, imageEvery: 4, imageSize: 320, outline: true }));
let failed = false;

async function check(browserType, viewport, deviceScaleFactor = 1) {
  let browser;
  try {
    browser = await browserType.launch();
  } catch (error) {
    console.log(`${browserType.name()}: not installed, skipped (${String(error.message).split("\n")[0]})`);
    return;
  }
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(String(error)));
  const label = `${browserType.name()} ${viewport.width}x${viewport.height}${deviceScaleFactor > 1 ? ` @${deviceScaleFactor}x` : ""}`;
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
      while (page.querySelector("canvas").width <= before && !page.querySelector(".recto-tile") && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { before, after: page.querySelector("canvas").width, grown, tile: Boolean(page.querySelector(".recto-tile")) };
    }, viewer);
    assert.ok(Math.abs(zoom.grown - 1.5) < 0.01, `${label}: zoom resized the page (${zoom.grown})`);
    assert.ok(zoom.after > zoom.before || zoom.tile, `${label}: a sharper bitmap replaced the stretched one`);

    // 400%: past a whole page's pixel cap, the part on screen is drawn again at the screen's density.
    const tile = await page.evaluate(async (selector) => {
      const viewer = document.querySelector(selector).viewer;
      viewer.setZoom(4);
      // A page 612 x 792 pt gets at most 8 M pixels whole: past that a tile is needed.
      const needed = viewer.scale * Math.min(2, Math.max(1, devicePixelRatio)) > Math.sqrt(8e6 / (612 * 792)) * 1.15;
      if (!needed) return { density: Math.min(2, Math.max(1, devicePixelRatio)), base: 0, ratio: devicePixelRatio, skipped: true };
      const page = viewer.pageElement(viewer.page);
      const deadline = performance.now() + 20_000;
      let shown = null;
      const target = Math.min(2, Math.max(1, devicePixelRatio));
      const densityOf = (canvas) => canvas.width / canvas.getBoundingClientRect().width;
      // A tile from an earlier zoom shows, stretched, until this zoom's lands.
      while (!((shown = page.querySelector("canvas.recto-tile")) && densityOf(shown) > target * 0.95) && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!shown) return null;
      const density = densityOf(shown);
      const base = page.querySelector("canvas:not(.recto-tile)");
      return { density, base: base.width / base.getBoundingClientRect().width, ratio: devicePixelRatio };
    }, viewer);
    assert.ok(tile, `${label}: a tile at 400%`);
    assert.ok(Math.abs(tile.density - Math.min(2, Math.max(1, tile.ratio))) < 0.05, `${label}: the tile is at device density (${tile.density})`);

    // A trackpad pinch (ctrl + wheel): previewed, then laid out once at its end.
    const pinch = await (async () => {
      await page.evaluate((selector) => document.querySelector(selector).viewer.fitWidth(), viewer);
      const box = await page.evaluate((selector) => {
        const rect = document.querySelector(selector).viewer.element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, viewer);
      await page.mouse.move(box.x, box.y);
      await page.keyboard.down("Control");
      for (let i = 0; i < 4; i++) {
        await page.mouse.wheel(0, -20);
      }
      await page.keyboard.up("Control");
      const during = await page.evaluate((selector) => document.querySelector(selector).viewer.zoom, viewer);
      await page.waitForTimeout(400);
      return page.evaluate(
        ([selector, during]) => {
          const viewer = document.querySelector(selector).viewer;
          return { during, after: viewer.zoom, transform: viewer.element.querySelector(".recto-pages").style.transform, pageZoom: visualViewport?.scale ?? 1 };
        },
        [viewer, during]
      );
    })();
    assert.ok(pinch.after > 1.2, `${label}: ctrl + wheel zoomed the viewer (${JSON.stringify(pinch)})`);
    assert.equal(pinch.transform, "", `${label}: the preview is gone once laid out`);
    assert.equal(pinch.pageZoom, 1, `${label}: the browser page did not zoom`);

    // The sidebar: thumbnails drawn, the outline, and a jump.
    await page.evaluate((selector) => document.querySelector(selector).shadowRoot.querySelector(".sidebar-toggle").click(), viewer);
    await page.waitForFunction((selector) => document.querySelector(selector).shadowRoot.querySelectorAll(".thumb canvas").length >= 3, viewer, { timeout: 20_000 });
    await page.waitForFunction((selector) => !document.querySelector(selector).shadowRoot.querySelector(".tabs").hidden, viewer, { timeout: 20_000 });
    const sidebar = await page.evaluate(async (selector) => {
      const element = document.querySelector(selector);
      const root = element.shadowRoot;
      const thumbs = root.querySelectorAll(".thumb canvas").length;
      root.querySelector(".tab-outline").click();
      const items = [...root.querySelectorAll(".outline .item")].filter((item) => !item.closest("ul[hidden]")).map((item) => item.textContent);
      const target = [...root.querySelectorAll(".outline .item")].find((item) => item.textContent.startsWith("Part 3"));
      target.click();
      const deadline = performance.now() + 10_000;
      while (element.viewer.page !== 22 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      const width = root.querySelector(".sidebar").getBoundingClientRect().width;
      return { thumbs, items: items.length, page: element.viewer.page, width, overlaid: getComputedStyle(root.querySelector(".sidebar")).position };
    }, viewer);
    assert.ok(sidebar.thumbs >= 3, `${label}: thumbnails drawn`);
    assert.equal(sidebar.page, 22, `${label}: the outline went to its page`);
    assert.equal(sidebar.overlaid, viewport.width <= 520 ? "absolute" : "static", `${label}: the sidebar overlays only on a phone`);
    assert.deepEqual(problems, [], `${label}: console`);
    console.log(
      `${label}: ok — first page ${firstPageMs} ms, ${found.count} for "corridor", zoom ${zoom.before} → ${zoom.after} px, 400% tile ${tile.density.toFixed(2)} px/px (whole page ${tile.base.toFixed(2)}), ctrl+wheel to ${Math.round(pinch.after * 100)}%, ${sidebar.thumbs} thumbnails, ${sidebar.items} outline entries`
    );
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
// A high-density screen, where 400% is past a whole page's pixel cap.
await check(chromium, { width: 1200, height: 900 }, 2);
// A phone: the toolbar fits, the page fits the width.
await check(chromium, { width: 390, height: 844 });

// A two-finger pinch on a touch screen zooms the viewer about the fingers, not the page around it.
async function touchPinch() {
  const browser = await chromium.launch();
  const label = "chromium touch pinch";
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await page.goto(`${server.origin}/demo/index.html?src=${encodeURIComponent("/doc/sample.pdf")}`);
    await page.waitForFunction(() => document.querySelector("recto-viewer")?.shadowRoot?.querySelector('.recto-page[data-rendered="true"]'), null, { timeout: 60_000 });
    const box = await page.evaluate(() => {
      const rect = document.querySelector("recto-viewer").viewer.element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const cdp = await context.newCDPSession(page);
    const fingers = (spread) => [
      { x: box.x - spread, y: box.y, id: 0 },
      { x: box.x + spread, y: box.y, id: 1 },
    ];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(40) });
    let preview = "";
    for (let spread = 45; spread <= 80; spread += 5) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(spread) });
      await page.waitForTimeout(16);
      if (!preview) {
        preview = await page.evaluate(() => document.querySelector("recto-viewer").viewer.element.querySelector(".recto-pages").style.transform);
      }
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ zoom: document.querySelector("recto-viewer").viewer.zoom, pageZoom: visualViewport.scale }));
    assert.match(preview, /scale\(/u, `${label}: previewed with a transform`);
    assert.ok(Math.abs(after.zoom - 2) < 0.1, `${label}: the viewer zoomed to twice (${after.zoom})`);
    assert.equal(after.pageZoom, 1, `${label}: the page did not zoom`);
    console.log(`${label}: ok — zoom ${after.zoom.toFixed(2)}, page zoom ${after.pageZoom}`);
  } catch (error) {
    failed = true;
    console.error(`${label}: FAILED`, error.message);
  } finally {
    await browser.close();
  }
}
await touchPinch();
await server.close();
process.exit(failed ? 1 : 0);
