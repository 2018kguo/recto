// Damaged files must end in pixels or a PdfError that isn't `crash`, and never hang. bench/fuzz.mjs is
// the long version of this over real files. Bounded in time, so a slow machine tests fewer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { STRUCTURES } from "../../bench/fuzz-structures.mjs";

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
