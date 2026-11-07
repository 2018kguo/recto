// WebAssembly memory only comes back when nothing holds the instance. Collected, not just dropped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { createPdfEngine } from "../src/index.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

// Every instance's memory, weakly, in the order they were made.
const memories: WeakRef<WebAssembly.Memory>[] = [];
const RealInstance = WebAssembly.Instance;
WebAssembly.Instance = function (module: WebAssembly.Module, imports?: WebAssembly.Imports) {
  const instance = new RealInstance(module, imports);
  // A part has no memory of its own: it takes the instance's.
  if (instance.exports["memory"]) {
    memories.push(new WeakRef(instance.exports["memory"] as WebAssembly.Memory));
  }
  return instance;
} as unknown as typeof WebAssembly.Instance;

const collected = async (memory: WeakRef<WebAssembly.Memory>) => {
  // deref keeps its target alive to the end of the task, so never collect in the same one.
  for (let i = 0; i < 20; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (memory.deref() === undefined) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return false;
};

function bigFile(mebibytes: number): Uint8Array {
  const bytes = syntheticPdf({ pages: 2, charsPerPage: 200 });
  const big = new Uint8Array(mebibytes * 2 ** 20);
  big.set(bytes);
  return big;
}

test("a file past the mark: at close with an explicit mark, its memory is gone, with no open to follow", async () => {
  const engine = await createPdfEngine({ recycleAboveBytes: 64 * 2 ** 20 });
  await (async () => {
    const doc = await engine.open(bigFile(100));
    doc.text(0);
    doc.close();
  })();
  assert.equal(engine.stats().heapBytes, 0);
  assert.ok(await collected(memories.at(-1)!), "the closed instance's memory is still reachable");
});

test("by default: an open within a second reuses the instance, and a second idle gives the memory back", async () => {
  const engine = await createPdfEngine();
  const file = bigFile(100);
  // In a function of its own: a suspended async function can hold its last `doc` in a register.
  const cycle = async () => {
    const doc = await engine.open(file);
    doc.text(0);
    doc.close();
  };
  for (let i = 0; i < 3; i++) {
    await cycle();
  }
  assert.equal(engine.stats().generation, 0, "reused");
  assert.ok(engine.stats().heapBytes > 100 * 2 ** 20);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(engine.stats().heapBytes, 0);
  assert.ok(await collected(memories.at(-1)!), "the idle instance's memory is still reachable");
});

test("by default: a small file's instance goes too, a second after the last close", async () => {
  const engine = await createPdfEngine();
  await (async () => {
    const doc = await engine.open(syntheticPdf({ pages: 2, charsPerPage: 200 }));
    doc.render(0, { width: 800 });
    doc.close();
  })();
  assert.ok(engine.stats().heapBytes < 64 * 2 ** 20, "nowhere near the mark the large files pass");
  assert.ok(engine.stats().heapBytes > 0, "and not at the close");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(engine.stats().heapBytes, 0);
  assert.ok(await collected(memories.at(-1)!), "the idle instance's memory is still reachable");
  // The next open makes a new one, and reads as well as the first did.
  using doc = await engine.open(syntheticPdf({ pages: 2, charsPerPage: 200 }));
  assert.ok(doc.text(0).text.length > 50);
  assert.equal(engine.stats().generation, 1);
});

test("with an explicit mark, below it the instance stays however long it's idle", async () => {
  const engine = await createPdfEngine({ recycleAboveBytes: 64 * 2 ** 20 });
  const doc = await engine.open(syntheticPdf({ pages: 2, charsPerPage: 200 }));
  doc.render(0, { width: 800 });
  doc.close();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(engine.stats().heapBytes > 0);
  assert.equal(engine.stats().generation, 0);
});

test("by default: past 512 MiB, the memory goes at the close", async () => {
  const engine = await createPdfEngine();
  const doc = await engine.open(bigFile(520));
  doc.close();
  assert.equal(engine.stats().heapBytes, 0);
});

test("an idle timer doesn't keep a process running, or an open document from being kept", async () => {
  const engine = await createPdfEngine();
  const file = bigFile(100);
  const first = await engine.open(file);
  first.close();
  const second = await engine.open(file);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(second.text(0).text.length > 50, "still open past the first close's second");
  assert.ok(engine.stats().heapBytes > 0);
  second.close();
});

/** A script in a process of its own, importing the engine as `createPdfEngine`; returns what it prints. */
function inProcess(body: string): string {
  const index = new URL("../src/index.ts", import.meta.url).href;
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const { createPdfEngine } = await import(${JSON.stringify(index)});\n${body}`],
    { timeout: 120_000, encoding: "utf8" }
  );
}

const padded = (mebibytes: number) => `
  const { syntheticPdf } = await import(${JSON.stringify(new URL("./synthetic-pdf.ts", import.meta.url).href)});
  const file = new Uint8Array(${mebibytes} * 2 ** 20);
  file.fill(1);
  file.set(syntheticPdf({ pages: 2, charsPerPage: 200 }));
`;

test("a retirement pending doesn't keep a process running", () => {
  const out = inProcess(`${padded(100)}
    const engine = await createPdfEngine();
    const doc = await engine.open(file);
    doc.close();
    const closed = performance.now();
    process.on("exit", () => console.log(performance.now() - closed));
  `);
  assert.ok(Number(out) < 700, `exited ${out} ms after the close; a retirement waits a second`);
});

test("past 64 MiB with a document still open, the next open gets a fresh instance", async () => {
  const engine = await createPdfEngine();
  const file = bigFile(100);
  const first = await engine.open(file);
  const second = await engine.open(file);
  assert.equal(engine.stats().generation, 1);
  assert.ok(first.text(0).text.length > 50);
  first.close();
  second.close();
});

test("a move holds the file in the two heaps and no third copy", () => {
  const MIB = 200;
  const out = inProcess(`${padded(MIB)}
    const before = process.memoryUsage().rss;
    const engine = await createPdfEngine({ preloadAssets: [] });
    const doc = await engine.open(file);
    doc.text(0);
    doc.render(0, { width: 100 });
    console.log((process.resourceUsage().maxRSS * 1024 - before) / 2 ** 20);
  `);
  // Two heaps of the file over the caller's copy, and room for the wasm and a little more.
  assert.ok(Number(out) < 2.6 * MIB, `the move grew the peak by ${out} MiB on a ${MIB} MiB file`);
});
