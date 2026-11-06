// A worker thread that runs the engine: one engine, one job at a time, pixels transferred
// back rather than copied.

import { parentPort } from "node:worker_threads";

import { createPdfEngine } from "../src/index.ts";

if (!parentPort) {
  throw new Error("worker-entry.ts must run in a worker thread");
}
const port = parentPort;
const engine = await createPdfEngine();

port.on("message", async (message: { bytes: Uint8Array } | { url: string }) => {
  if ("url" in message) {
    // A ranged open blocks this thread while its fetcher thread fetches.
    const ranged = await engine.openRanged(message.url);
    try {
      const sizes = Array.from({ length: ranged.pageCount }, (_, i) =>
        ranged.pageInfo(i)
      );
      port.postMessage({ pageCount: ranged.pageCount, sizes });
    } finally {
      ranged.close();
    }
    return;
  }
  const doc = await engine.open(message.bytes);
  try {
    const sizes = Array.from({ length: doc.pageCount }, (_, i) =>
      doc.pageInfo(i)
    );
    const text = doc.text(0).text;
    const bitmap = doc.render(0, { width: 512 });
    port.postMessage({ pageCount: doc.pageCount, sizes, text, bitmap }, [
      bitmap.rgba.buffer,
    ]);
  } finally {
    doc.close();
  }
});
port.postMessage({ ready: true });
