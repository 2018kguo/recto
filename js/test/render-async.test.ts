// renderAsync: the same pixels as render, the thread back between slices, and a real stop.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { createPdfEngine, openPdf, PdfError } from "../src/index.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";
import { pdfOf, transparencyCases } from "./transparency-cases.mjs";

function shapes(count: number, seed = 0): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const x = (i * 7 + seed) % 97;
    const y = (i * 13 + seed) % 97;
    out += `0.${(i % 9) + 1} 0.2 0.5 rg ${x} ${y} 1.5 1.5 re f\n`;
  }
  return out;
}

/** Its whole weight inside two levels of forms, the case a page-level loop couldn't pause in. */
function heavyFormPdf(count: number): Uint8Array {
  return pdfOf({
    content: "q /Outer Do Q\n",
    resources: "/XObject <</Outer 5 0 R>>",
    objects: [
      { dict: " /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources <</XObject <</Inner 6 0 R>>>>", data: "/Inner Do\n" },
      { dict: " /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group <</S /Transparency /I true>>", data: shapes(count) },
    ],
  });
}

test("the same pixels as render", async (t) => {
  const inputs: [string, Uint8Array][] = [
    ["forms", heavyFormPdf(5000)],
    ["synthetic", syntheticPdf({ pages: 2, charsPerPage: 500 })],
    ...transparencyCases().map(({ name, pdf }: { name: string; pdf: Uint8Array }): [string, Uint8Array] => [name, pdf]),
  ];
  const fixtures = new URL("./fixtures/", import.meta.url);
  for (const name of readdirSync(fixtures)) {
    if (name.endsWith(".pdf") && !/password|encrypted/u.test(name)) {
      inputs.push([name, readFileSync(new URL(name, fixtures))]);
    }
  }
  for (const [name, pdf] of inputs) {
    await t.test(name, async () => {
      await using doc = await openPdf(pdf);
      const sync = doc.render(0, { width: 300 });
      // A slice this short pauses as often as it can.
      const sliced = await doc.renderAsync(0, { width: 300, sliceMs: 0 });
      assert.deepEqual([sliced.width, sliced.height, sliced.truncated], [sync.width, sync.height, sync.truncated]);
      assert.ok(Buffer.from(sliced.rgba).equals(Buffer.from(sync.rgba)), "pixels differ");
    });
  }
});

test("a render stopped inside a form really stops, and the document is usable after", async () => {
  await using doc = await openPdf(heavyFormPdf(200_000));
  const controller = new AbortController();
  const started = performance.now();
  let turns = 0;
  const ticking = setInterval(() => {
    turns += 1;
    if (turns === 3) {
      controller.abort();
    }
  }, 1);
  const stopped = doc.renderAsync(0, { width: 800, signal: controller.signal, sliceMs: 4 });
  await assert.rejects(stopped, (error: PdfError) => error.code === "aborted");
  clearInterval(ticking);
  const stoppedAfter = performance.now() - started;

  const whole = performance.now();
  const sync = doc.render(0, { width: 800 });
  const wholeMs = performance.now() - whole;
  assert.ok(
    stoppedAfter < wholeMs / 2,
    `stopped after ${stoppedAfter.toFixed(0)} ms of a ${wholeMs.toFixed(0)} ms render`
  );
  const again = await doc.renderAsync(0, { width: 800 });
  assert.ok(Buffer.from(again.rgba).equals(Buffer.from(sync.rgba)));
});

test("the thread comes back between slices", async () => {
  await using doc = await openPdf(heavyFormPdf(200_000));
  let turns = 0;
  let last = performance.now();
  let longest = 0;
  let running = true;
  const beat = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    turns += 1;
    if (running) {
      setImmediate(beat);
    }
  };
  setImmediate(beat);
  const before = performance.now();
  const sync = doc.render(0, { width: 800 });
  const syncMs = performance.now() - before;
  await new Promise((resolve) => setImmediate(resolve));
  turns = 0;
  longest = 0;
  last = performance.now();
  await doc.renderAsync(0, { width: 800, sliceMs: 4 });
  running = false;
  assert.ok(sync.width === 800);
  assert.ok(turns > 5, `only ${turns} turns of the event loop`);
  assert.ok(longest < syncMs, `longest stall ${longest.toFixed(0)} ms, the sync render ${syncMs.toFixed(0)} ms`);
});

test("an already aborted signal, a closed document and a bad width all refuse", async () => {
  const doc = await openPdf(heavyFormPdf(200));
  await assert.rejects(doc.renderAsync(0, { width: 0 }), RangeError);
  await assert.rejects(doc.renderAsync(0, { width: 100, signal: AbortSignal.abort() }), { code: "aborted" });
  const running = doc.renderAsync(0, { width: 100, sliceMs: 0 });
  doc.close();
  await assert.rejects(running, { code: "closed" });
  await assert.rejects(doc.renderAsync(0, { width: 100 }), { code: "closed" });
});

test("other calls and other renders can run between slices", async () => {
  const engine = await createPdfEngine();
  await using doc = await engine.open(heavyFormPdf(20_000));
  const sync = doc.render(0, { width: 200 });
  const a = doc.renderAsync(0, { width: 200, sliceMs: 0 });
  const b = doc.renderAsync(0, { width: 200, sliceMs: 0 });
  assert.ok(doc.text(0));
  assert.ok(doc.render(0, { width: 50 }));
  for (const result of await Promise.all([a, b])) {
    assert.ok(Buffer.from(result.rgba).equals(Buffer.from(sync.rgba)));
  }
});
