// A file longer than 2 GiB read by range, and what that costs: the length takes address space,
// and only what is fetched takes memory.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import { createPdfEngine } from "../src/index.ts";

const SERVER = `
const http = require("node:http");
const { parentPort, workerData: { total, pieces } } = require("node:worker_threads");
const server = http.createServer((req, res) => {
  const m = /bytes=(\\d*)-(\\d+)/.exec(req.headers.range ?? "");
  // A suffix (bytes=-n) is the last n bytes.
  const start = m ? (m[1] === "" ? total - +m[2] : +m[1]) : 0;
  const end = m ? (m[1] === "" ? total - 1 : Math.min(+m[2], total - 1)) : total - 1;
  const out = Buffer.alloc(end - start + 1);
  for (const [at, bytes] of pieces) {
    const b = Buffer.from(bytes);
    if (at + b.length > start && at <= end) {
      b.copy(out, Math.max(0, at - start), Math.max(0, start - at), Math.min(b.length, end - at + 1));
    }
  }
  res.writeHead(206, { "Content-Range": "bytes " + start + "-" + end + "/" + total, "Content-Length": out.length, "Accept-Ranges": "bytes" });
  res.end(out);
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
`;

test("a 2.5 GiB file: objects past 2 GiB are found, and memory follows the bytes fetched", async () => {
  const total = Math.floor(2.5 * 2 ** 30);
  const content = "BT /F1 24 Tf 72 700 Td (Far along the file) Tj ET";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Count 1/Kids[3 0 R]>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const encoder = new TextEncoder();
  const pieces: [number, Uint8Array][] = [[0, encoder.encode("%PDF-1.7\n")]];
  const step = Math.floor((total - 4096) / objects.length);
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(1024 + i * step);
    pieces.push([1024 + i * step, encoder.encode(`${i + 1} 0 obj\n${object}\nendobj\n`)]);
  });
  const xref = total - 1024;
  const table = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pieces.push([
    xref,
    encoder.encode(`xref\n0 6\n0000000000 65535 f \n${table}trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`),
  ]);
  const server = new Worker(SERVER, { eval: true, workerData: { total, pieces } });
  try {
    const port = await new Promise<number>((resolve) => server.once("message", resolve));
    const engine = await createPdfEngine();
    const before = process.memoryUsage().rss;
    await using doc = await engine.openRanged(`http://127.0.0.1:${port}/large.pdf`);
    assert.match(doc.text(0).text, /Far along the file/u);
    assert.ok(doc.stats().bytesFetched < 2 * 2 ** 20, `fetched ${doc.stats().bytesFetched}`);
    const grew = process.memoryUsage().rss - before;
    assert.ok(grew < 300 * 2 ** 20, `memory grew ${grew}`);
  } finally {
    await server.terminate();
  }
});
