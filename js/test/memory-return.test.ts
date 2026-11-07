// WebAssembly memory only comes back when nothing holds the instance. Collected, not just dropped.
import assert from "node:assert/strict";
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
  memories.push(new WeakRef(instance.exports["memory"] as WebAssembly.Memory));
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

test("a document that moved lets go of the text instance while it stays open", async () => {
  const first = memories.length;
  const engine = await createPdfEngine({ preloadAssets: [] });
  const file = bigFile(20);
  const doc = await (async () => {
    const opened = await engine.open(file);
    opened.text(0);
    opened.render(0, { width: 100 });
    return opened;
  })();
  assert.ok(await collected(memories[first]!), "the text instance's memory is still reachable");
  assert.ok(doc.text(0).text.length > 50);
  doc.close();
});
