#!/usr/bin/env node
// Things pdf.js does in Node that took me a while to learn, shown rather than claimed. Each check
// says what happened. Nothing here is a benchmark.
//
//   node bench/pdfjs-footguns.mjs [--out bench/results/pdfjs-footguns.json]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { reportPdf } from "./generate.mjs";

const here = import.meta.dirname;
const { values } = parseArgs({ options: { out: { type: "string", default: path.join(here, "results/pdfjs-footguns.json") } } });
const legacy = path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs");
const results = {};

function inChild(source, env = {}) {
  const file = path.join(os.tmpdir(), `recto-footgun-${process.pid}.mjs`);
  fs.writeFileSync(file, source);
  try {
    return execFileSync(process.execPath, [file], { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  } catch (error) {
    return `exit ${error.status}: ${String(error.stderr).split("\n").filter(Boolean).slice(0, 3).join(" | ")}`;
  } finally {
    fs.rmSync(file);
  }
}

// 1. A page with a standard font, no standardFontDataUrl: does it fail, or draw no text?
const pdfPath = path.join(os.tmpdir(), `recto-footgun-${process.pid}.pdf`);
fs.writeFileSync(pdfPath, reportPdf({ pages: 1, imageSize: 64 }));
const inkSource = (options) => `
import fs from "node:fs";
const pdfjs = await import(${JSON.stringify(legacy)});
const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(${JSON.stringify(pdfPath)})), verbosity: 0, ${options} });
const doc = await task.promise;
const page = await doc.getPage(1);
const viewport = page.getViewport({ scale: 1 });
const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
await page.render({ canvas, canvasContext: context, viewport }).promise;
const { data } = context.getImageData(0, 0, canvas.width, 200);
let dark = 0;
for (let i = 0; i < data.length; i += 4) if (data[i] < 96 && data[i + 3] > 200) dark++;
console.log(JSON.stringify({ darkPixelsInTopOfPage: dark }));
await task.destroy();
process.exit(0);
`;
const fonts = path.join(here, "node_modules/pdfjs-dist/standard_fonts/");
results.withStandardFonts = JSON.parse(inChild(inkSource(`standardFontDataUrl: ${JSON.stringify(fonts)}`)));
results.withoutStandardFonts = JSON.parse(inChild(inkSource("")));

// 2. Without the optional canvas package: what a render does in Node.
{
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "recto-footgun-"));
  fs.mkdirSync(path.join(isolated, "node_modules"));
  fs.cpSync(path.join(here, "node_modules/pdfjs-dist"), path.join(isolated, "node_modules/pdfjs-dist"), { recursive: true });
  const file = path.join(isolated, "go.mjs");
  fs.writeFileSync(file, `
import fs from "node:fs";
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(${JSON.stringify(pdfPath)})), verbosity: 0 });
const doc = await task.promise;
const page = await doc.getPage(1);
const viewport = page.getViewport({ scale: 1 });
try {
  const { canvas, context } = doc.canvasFactory.create(100, 100);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  console.log("rendered");
} catch (error) { console.log("failed: " + error.message); }
process.exit(0);
`);
  try {
    results.renderWithoutCanvasPackage = execFileSync(process.execPath, [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").find((l) => /rendered|failed/.test(l));
  } catch (error) {
    results.renderWithoutCanvasPackage = `exit ${error.status}: ${String(error.stderr).split("\n").find((l) => /Error|Cannot find/.test(l))}`;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
}

// 3. The modern build in Node.
results.modernBuildInNode = inChild(`
const pdfjs = await import(${JSON.stringify(path.join(here, "node_modules/pdfjs-dist/build/pdf.mjs"))});
console.log("loaded, " + pdfjs.version);
process.exit(0);
`).trim().slice(0, 200);

// 4. Destroying a ranged load part way, with requests in flight and nothing awaited on them.
const bytes = reportPdf({ pages: 200, imageEvery: 5, imageSize: 240 });
const server = http.createServer((request, response) => {
  const match = /bytes=(\d+)-(\d+)/u.exec(request.headers.range ?? "");
  const answer = () => {
    if (response.destroyed) return;
    if (!match) {
      response.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": bytes.length });
      response.write(bytes.subarray(0, 1024));
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    response.writeHead(206, { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": end - start + 1 });
    response.end(bytes.subarray(start, end + 1));
  };
  setTimeout(answer, 50);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/a.pdf`;
const destroyScript = (after, guard) => `
const pdfjs = await import(${JSON.stringify(legacy)});
const seen = [];
${guard ? 'process.on("unhandledRejection", (error) => seen.push(error?.message ?? String(error)));' : ""}
const task = pdfjs.getDocument({ url: ${JSON.stringify(url)}, verbosity: 0, disableAutoFetch: true, disableStream: true });
${after}
await new Promise((resolve) => setTimeout(resolve, 1000));
console.log(JSON.stringify({ lived: true, unhandledRejections: seen }));
process.exit(0);
`;
const whilePending = "setTimeout(() => task.destroy(), 20); task.promise.catch(() => {});";
const whilePage = "task.promise.then((doc) => { doc.getPage(150).catch(() => {}); setTimeout(() => task.destroy(), 10); }).catch(() => {});";
results.destroyWhileOpening = inChild(destroyScript(whilePending, true)).trim();
results.destroyWhileReadingAPage = inChild(destroyScript(whilePage, true)).trim();
results.destroyWhileReadingAPageUnguarded = inChild(destroyScript(whilePage, false)).trim();
server.closeAllConnections();
server.close();
fs.rmSync(pdfPath);

fs.writeFileSync(values.out, `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify(results, null, 1));
