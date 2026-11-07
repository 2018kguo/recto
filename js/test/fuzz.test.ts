// Damaged files must end in pixels or a PdfError that isn't `crash`, and never hang. bench/fuzz.mjs is
// the long version of this over real files. Bounded in time, so a slow machine tests fewer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { STRUCTURES, TRIPS, structure } from "../../bench/fuzz-structures.mjs";
import { createPdfEngine } from "../src/index.ts";
import { seedCorpus } from "./fuzz-corpus.mjs";

const BUDGET_MS = 30_000;
const HANG_MS = 60_000;

async function run(workerData: object) {
  const failures: unknown[] = [];
  let current: unknown = null;
  let finished = 0;
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL("./fuzz-entry.ts", import.meta.url), { workerData });
    let hang = setTimeout(() => worker.terminate(), HANG_MS);
    worker.on("message", (message: { current?: number; failed?: number; finished?: number }) => {
      if (message.current !== undefined) {
        current = message;
        clearTimeout(hang);
        hang = setTimeout(() => {
          failures.push({ hang: current });
          worker.terminate();
        }, HANG_MS);
      }
      if (message.failed !== undefined) failures.push(message);
      if (message.finished !== undefined) {
        finished = message.finished;
        clearTimeout(hang);
        worker.terminate();
      }
    });
    worker.on("error", reject);
    worker.on("exit", () => {
      clearTimeout(hang);
      resolve();
    });
  });
  return { failures, finished };
}

test("seeded damage to generated PDFs is always a typed failure", { timeout: 120_000 }, async () => {
  const { failures, finished } = await run({ seed: 1, count: 20_000, budgetMs: BUDGET_MS });
  assert.deepEqual(failures, []);
  assert.ok(finished > 200, `only ${finished} files in the time`);
});

test("files built to cost stay within a time and memory budget", { timeout: 120_000 }, async () => {
  const { failures, finished } = await run({ seed: 1, count: 0, budgetMs: 45_000, structures: true });
  assert.deepEqual(failures, []);
  assert.equal(finished, STRUCTURES.length);
});

test("a budget that stops says so on every result, and nothing else does", async () => {
  const engine = await createPdfEngine();
  for (const [offset, name] of STRUCTURES.entries()) {
    for (const round of [1, 2]) {
      const { bytes } = structure(Math.imul(round + 40, STRUCTURES.length) + offset);
      const doc = await engine.open(bytes);
      const trips = (TRIPS as Record<string, string[]>)[name]!;
      const cut = doc.structureTruncated();
      assert.equal(doc.text(0).truncated, trips.includes("text"), `${name}: text`);
      assert.equal(doc.objects(0).truncated, trips.includes("objects"), `${name}: objects`);
      assert.equal(doc.render(0, { width: 100 }).truncated, trips.includes("render"), `${name}: render`);
      assert.equal((await doc.renderAsync(0, { width: 100 })).truncated, trips.includes("render"), `${name}: renderAsync`);
      assert.equal(cut.pages, trips.includes("pages"), `${name}: pages`);
      assert.equal(cut.pageLabels, trips.includes("pageLabels"), `${name}: pageLabels`);
      assert.equal(cut.outline, trips.includes("outline"), `${name}: outline`);
      doc.close();
    }
  }
  // The generated corpus, undamaged; examples/budgets.rs does this on real files.
  for (const { name, pdf } of seedCorpus()) {
    const doc = await engine.open(pdf);
    assert.deepEqual(doc.structureTruncated(), { pages: false, pageLabels: false, outline: false }, name);
    for (let page = 0; page < doc.pageCount; page++) {
      assert.equal(doc.text(page).truncated, false, name);
      assert.equal(doc.objects(page).truncated, false, name);
      assert.equal(doc.render(page, { width: 100 }).truncated, false, name);
      assert.equal((await doc.renderAsync(page, { width: 100 })).truncated, false, name);
    }
    doc.close();
  }
});
