// The demo's server answers Range requests, so a large file opens by range from it rather than whole,
// as it would from any static file server.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createPdfEngine } from "../../src/index.ts";
import { textPdf } from "./fixtures.ts";

const SERVE = path.join(import.meta.dirname, "../../../bench/serve.mjs");

/**
 * The server on a process of its own: a ranged read blocks the thread it's made on, so the server
 * can't share this one. Resolves its origin once it's listening.
 */
async function startServer(file: string): Promise<{ origin: string; stop(): void }> {
  const source = `
    import fs from "node:fs";
    const { serve } = await import(${JSON.stringify(SERVE)});
    const server = await serve();
    server.docs.set("big.pdf", new Uint8Array(fs.readFileSync(${JSON.stringify(file)})));
    console.log(server.origin);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "inherit"] });
  const origin = await new Promise<string>((resolve, reject) => {
    child.stdout.once("data", (data: Buffer) => resolve(String(data).trim()));
    child.once("exit", (code) => reject(new Error(`the server exited (${code})`)));
  });
  return { origin, stop: () => child.kill() };
}

test("the demo server answers byte ranges, and a large file opens from it by range", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recto-demo-"));
  const file = path.join(dir, "big.pdf");
  const bytes = textPdf({ pages: 40, padBytes: 64 * 1024 });
  fs.writeFileSync(file, bytes);
  const server = await startServer(file);
  try {
    const url = `${server.origin}/doc/big.pdf`;
    const part = await fetch(url, { headers: { Range: "bytes=10-19" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 10-19/${bytes.byteLength}`);
    assert.deepEqual(new Uint8Array(await part.arrayBuffer()), bytes.subarray(10, 20));
    const tail = await fetch(url, { headers: { Range: "bytes=-5" } });
    assert.equal(tail.status, 206);
    assert.deepEqual(new Uint8Array(await tail.arrayBuffer()), bytes.subarray(bytes.byteLength - 5));
    const past = await fetch(url, { headers: { Range: `bytes=${bytes.byteLength}-` } });
    assert.equal(past.status, 416);
    await past.body?.cancel();
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    await whole.body?.cancel();

    const engine = await createPdfEngine();
    const doc = await engine.openRanged(url);
    try {
      assert.equal(doc.pageCount, 40);
      assert.match([...doc.text(31).codepoints.slice(0, 14)].map((code) => String.fromCodePoint(code)).join(""), /Page 32 line/u);
      const { bytesFetched } = doc.stats();
      assert.ok(bytesFetched < bytes.byteLength / 2, `${bytesFetched} of ${bytes.byteLength} bytes read`);
    } finally {
      doc.close();
    }
  } finally {
    server.stop();
    fs.rmSync(dir, { force: true, recursive: true });
  }
});
