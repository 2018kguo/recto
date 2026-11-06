#!/usr/bin/env node
// Bytes and round trips to read a document's page count and last page's text, against a local range
// server: recto and pdf.js.
//
//   npm run build
//   node bench/ranged-compare.mjs <a large PDF> [--out bench/results/ranged.json]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const here = import.meta.dirname;

if (!isMainThread) {
  // On a thread of its own: recto's read blocks the caller.
  const http = await import("node:http");
  const { file, counters } = workerData;
  const bytes = fs.readFileSync(file);
  const server = http.createServer((request, response) => {
    Atomics.add(counters, 1, 1);
    const match = /bytes=(\d+)-(\d*)/u.exec(request.headers.range ?? "");
    if (request.method === "HEAD") {
      response.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": bytes.length });
      response.end();
      return;
    }
    if (!match) {
      response.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": bytes.length });
      response.on("close", () => {});
      let at = 0;
      const pump = () => {
        while (at < bytes.length && !response.destroyed) {
          const piece = bytes.subarray(at, at + 65536);
          at += piece.length;
          Atomics.add(counters, 0, piece.length);
          if (!response.write(piece)) return void response.once("drain", pump);
        }
        if (!response.destroyed) response.end();
      };
      return void pump();
    }
    const start = Number(match[1]);
    const end = Math.min(match[2] ? Number(match[2]) : bytes.length - 1, bytes.length - 1);
    Atomics.add(counters, 0, end - start + 1);
    response.writeHead(206, { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": end - start + 1 });
    response.end(bytes.subarray(start, end + 1));
  });
  server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
} else {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string", default: path.join(here, "results/ranged.json") } },
  });
  const file = positionals[0];
  if (!file) {
    console.error("usage: ranged-compare.mjs <a large PDF> [--out file.json]");
    process.exit(2);
  }
  const counters = new Int32Array(new SharedArrayBuffer(8));
  const server = new Worker(import.meta.filename, { workerData: { file, counters } });
  const port = await new Promise((resolve) => server.once("message", resolve));
  const url = `http://127.0.0.1:${port}/doc.pdf`;
  const measure = async (run) => {
    Atomics.store(counters, 0, 0);
    Atomics.store(counters, 1, 0);
    const out = await run();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { ...out, bytes: Atomics.load(counters, 0), requests: Atomics.load(counters, 1) };
  };
  const results = { fileBytes: fs.statSync(file).size };

  const { createPdfEngine } = await import(path.join(here, "../js/dist/index.js"));
  const engine = await createPdfEngine();
  results.recto = await measure(async () => {
    const doc = await engine.openRanged(url, { maxBytes: 2 ** 31 });
    const pages = doc.pageCount;
    const chars = doc.text(pages - 1).text.length;
    const rounds = doc.stats().rounds;
    doc.close();
    return { pages, chars, rounds };
  });

  const pdfjs = await import(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
  const root = path.join(here, "node_modules/pdfjs-dist");
  results.pdfjs = await measure(async () => {
    const task = pdfjs.getDocument({ url, verbosity: 0, disableAutoFetch: true, disableStream: true, standardFontDataUrl: `${root}/standard_fonts/`, cMapUrl: `${root}/cmaps/`, cMapPacked: true, wasmUrl: `${root}/wasm/` });
    const doc = await task.promise;
    const pages = doc.numPages;
    const page = await doc.getPage(pages);
    const { items } = await page.getTextContent();
    const chars = items.reduce((sum, item) => sum + item.str.length, 0);
    await task.destroy();
    return { pages, chars };
  });
  results.pdfjsDefaults = await measure(async () => {
    const task = pdfjs.getDocument({ url, verbosity: 0, standardFontDataUrl: `${root}/standard_fonts/`, cMapUrl: `${root}/cmaps/`, cMapPacked: true, wasmUrl: `${root}/wasm/` });
    const doc = await task.promise;
    const pages = doc.numPages;
    const page = await doc.getPage(pages);
    const { items } = await page.getTextContent();
    const chars = items.reduce((sum, item) => sum + item.str.length, 0);
    await task.destroy();
    return { pages, chars };
  });

  await server.terminate();
  fs.writeFileSync(values.out, `${JSON.stringify(results, null, 1)}\n`);
  console.log(JSON.stringify(results, null, 1));
  process.exit(0);
}
