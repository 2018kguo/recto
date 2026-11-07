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

test("a file past the mark: after close and a collection, the memory is gone, with no open to follow", async () => {
  const engine = await createPdfEngine();
  await (async () => {
    const doc = await engine.open(bigFile(100));
    doc.text(0);
    doc.close();
  })();
  assert.equal(engine.stats().heapBytes, 0);
  assert.ok(await collected(memories.at(-1)!), "the closed instance's memory is still reachable");
});
