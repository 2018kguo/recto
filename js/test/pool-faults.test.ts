// Every way a pool's thread can go wrong, each promise with a time limit: nothing may wait for ever.
// Threads run from files, so the faults go into a copy of the built package.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createPdfPool } from "../dist/index.js";
import { syntheticPdf } from "./synthetic-pdf.ts";

const LIMIT_MS = 20_000;
const bounded = <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${LIMIT_MS} ms`)), LIMIT_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
const pdf = () => syntheticPdf({ pages: 12, charsPerPage: 100 });
const here = (path: string) => new URL(`../${path}`, import.meta.url);

/** The package, in a directory of its own, with something changed in the thread's file. */
async function faulty(change: (source: string) => string): Promise<typeof createPdfPool> {
  const dir = mkdtempSync(join(tmpdir(), "recto-pool-faults-"));
  for (const name of ["dist", "wasm", "package.json"]) cpSync(here(name), join(dir, name), { recursive: true });
  const file = join(dir, "dist/pool-worker.js");
  writeFileSync(file, change(readFileSync(file, "utf8")));
  return ((await import(pathToFileURL(join(dir, "dist/index.js")).href)) as { createPdfPool: typeof createPdfPool }).createPdfPool;
}
/** At the top of a call's handling on the thread. */
const onCall = (code: string) => (source: string) => {
  const anchor = "async function answer({ doc: id, open, method, args }) {";
  assert.ok(source.includes(anchor));
  return source.replace(anchor, `${anchor} ${code}`);
};
const assetDir = (...without: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "recto-pool-assets-"));
  cpSync(here("wasm"), dir, { recursive: true });
  for (const name of without) rmSync(join(dir, name));
  return dir;
};

for (const [label, fault] of [
  ["throws as it loads", (source: string) => `throw new Error("nope");\n${source}`],
  ["exits as it loads", (source: string) => `process.exit(1);\n${source}`],
] as const) {
  test(`a thread that ${label}: open fails with crash, and so does the next, and close still works`, async () => {
    using pool = await (await faulty(fault))({ threads: 2 });
    await assert.rejects(bounded(pool.open(pdf())), { code: "crash" });
    await assert.rejects(bounded(pool.open(pdf())), { code: "crash" });
  });
}

test("recto.wasm missing: open fails with missing-asset, and works once it's back", async () => {
  const dir = assetDir("recto.wasm");
  using pool = await createPdfPool({ threads: 2, assetBase: dir });
  await assert.rejects(bounded(pool.open(pdf())), { code: "missing-asset" });
  cpSync(here("wasm/recto.wasm"), join(dir, "recto.wasm"));
  const doc = await bounded(pool.open(pdf()));
  assert.ok((await bounded(doc.text(0))).count > 0);
});

test("a thread that dies in a call fails that call with crash, and another thread takes over", async () => {
  using pool = await (await faulty(onCall(`if (method === "text" && args[0] === 5) process.exit(1);`)))({ threads: 2 });
  const doc = await bounded(pool.open(pdf()));
  await assert.rejects(bounded(doc.text(5)), { code: "crash" });
  assert.ok((await bounded(doc.text(0))).count > 0);
  await assert.rejects(bounded(doc.text(5)), { code: "crash" });
  const settled = await bounded(Promise.allSettled(Array.from({ length: 12 }, (_, i) => doc.text(i))));
  assert.equal(settled[0]!.status, "fulfilled");
  assert.equal(settled[5]!.status, "rejected");
});

test("a result that can't cross fails that call, and the thread goes on", async () => {
  using pool = await (await faulty(onCall(`if (method === "text" && args[0] === 6) return { f() {} };`)))({ threads: 1 });
  const doc = await bounded(pool.open(pdf()));
  await assert.rejects(bounded(doc.text(6)), { message: /could not be cloned/u });
  assert.ok((await bounded(doc.text(0))).count > 0);
});

test("an argument that can't cross fails that call, whether it would run now or wait", async () => {
  using pool = await createPdfPool({ threads: 1 });
  const doc = await bounded(pool.open(pdf()));
  const width = (() => 100) as unknown as number;
  await assert.rejects(bounded(doc.render(0, { width })), { name: "DataCloneError" });
  const results = await bounded(
    Promise.allSettled([doc.text(0), doc.render(0, { width }), doc.text(Symbol("x") as unknown as number), doc.text(1)])
  );
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "rejected", "fulfilled"]);
  assert.ok((await bounded(doc.text(2))).count > 0);
});

test("a signal is refused, saying why, and options nobody reads don't cross", async () => {
  using pool = await createPdfPool({ threads: 1 });
  const doc = await bounded(pool.open(pdf()));
  const signal = new AbortController().signal;
  await assert.rejects(bounded(doc.render(0, { width: 50, signal } as never)), { name: "TypeError", message: /no signal/u });
  const bitmap = await bounded(doc.render(0, { width: 50, onProgress() {} } as never));
  assert.equal(bitmap.width, 50);
});

test("a part that fails on one thread fails that call, and the document goes on there once it's back", async () => {
  const dir = assetDir("recto-render.wasm");
  using pool = await createPdfPool({ threads: 1, assetBase: dir });
  const doc = await bounded(pool.open(pdf()));
  await assert.rejects(bounded(doc.render(0, { width: 64 })), { code: "missing-asset" });
  assert.ok((await bounded(doc.text(0))).count > 0);
  cpSync(here("wasm/recto-render.wasm"), join(dir, "recto-render.wasm"));
  assert.equal((await bounded(doc.render(0, { width: 64 }))).width, 64);
});

test("a thread whose open of a document fails can open it at its next call", async () => {
  // Past pageCount, which the first thread opens it for, and failing once on the second.
  const once = `if (open && globalThis.calls === undefined && method !== "pageCount") { globalThis.calls = 1; throw new Error("opening failed"); }`;
  using pool = await (await faulty(onCall(once)))({ threads: 2 });
  const doc = await bounded(pool.open(pdf()));
  // Until the second thread's open has failed: a thread counts as soon as it starts, before it's
  // given a call, so waiting for two threads could leave that failure to the batch below.
  let failed = false;
  for (let round = 0; round < 50 && !failed; round++) {
    const batch = await bounded(Promise.allSettled(Array.from({ length: 12 }, (_, i) => doc.text(i))));
    failed = batch.some((page) => page.status === "rejected");
  }
  assert.ok(failed, "the second thread's open failed once");
  const pages = await bounded(Promise.allSettled(Array.from({ length: 12 }, (_, i) => doc.text(i))));
  assert.deepEqual(pages.filter((page) => page.status === "rejected"), [], "no call fails for ever after");
});

test("a limit on threads", async () => {
  await assert.rejects(createPdfPool({ threads: 65 }), RangeError);
  await assert.rejects(createPdfPool({ threads: 0 }), RangeError);
});

test("a thread that never reports counts as dead", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  using pool = await (await faulty((source) => source.replace(/parent\.on\("message"[^\n]*/u, "setInterval(() => {}, 1000);")))({ threads: 1 });
  const opening = pool.open(pdf());
  t.mock.timers.tick(90_001);
  t.mock.timers.reset();
  await assert.rejects(bounded(opening), { code: "crash", message: /hadn't started/u });
});
