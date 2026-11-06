// What goes wrong when a package like this is plugged in carelessly, one guard each. The
// browser's half (a page's main thread, a real Web Worker) runs in smoke/.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { createPdfEngine, openPdf, PdfError, type PdfErrorCode } from "../src/index.ts";
import { startRangeServer } from "./range-server.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";
import { PINS } from "../wasm/pins.mjs";

const ASSETS = ["recto.wasm", "fonts.bin", "cjk-fallback.ttf", "cmaps.brotli"] as const;
const packaged = (name: string) => new URL(`../wasm/${name}`, import.meta.url);

/** A copy of the package's assets, to break. */
function assetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recto-assets-"));
  for (const name of ASSETS) {
    copyFileSync(packaged(name), join(dir, name));
  }
  return dir;
}

const pdf = () => syntheticPdf({ pages: 3, charsPerPage: 200 });
const hasCode = (code: PdfErrorCode) => (error: unknown) => {
  assert.ok(error instanceof PdfError, String(error));
  assert.equal(error.code, code, error.message);
  return true;
};

// 1. Assets

test("openPdf needs no setup, and the text it reads is not blank", async () => {
  await using doc = await openPdf(pdf());
  assert.equal(doc.pageCount, 3);
  assert.ok(doc.text(0).text.length > 100);
  const { width, rgba } = doc.render(0, { width: 256 });
  assert.equal(width, 256);
  assert.ok(rgba.some((value) => value < 128), "something was drawn");
});

test("the pins are the shipped files' hashes", () => {
  for (const name of ASSETS) {
    const actual = createHash("sha256").update(readFileSync(packaged(name))).digest("hex");
    assert.equal(actual, PINS[name], name);
  }
});

test("a missing or wrong wasm fails the engine's creation; the refusal is not cached", async () => {
  const dir = assetDir();
  rmSync(join(dir, "recto.wasm"));
  await assert.rejects(createPdfEngine({ assetBase: dir }), (error: PdfError) => {
    hasCode("missing-asset")(error);
    assert.match(error.message, /recto\.wasm/u);
    assert.match(error.message, /assetBase/u);
    return true;
  });
  const wrong = readFileSync(packaged("recto.wasm"));
  wrong[wrong.length - 1] = (wrong.at(-1) ?? 0) ^ 1;
  writeFileSync(join(dir, "recto.wasm"), wrong);
  await assert.rejects(createPdfEngine({ assetBase: dir }), hasCode("missing-asset"));
  copyFileSync(packaged("recto.wasm"), join(dir, "recto.wasm"));
  const engine = await createPdfEngine({ assetBase: pathToFileURL(dir) });
  (await engine.open(pdf())).close();
});

for (const [label, damage] of [
  ["missing", (file: string) => rmSync(file)],
  ["truncated", (file: string) => writeFileSync(file, readFileSync(file).subarray(0, 100))],
  ["HTML from a server's fallback", (file: string) => writeFileSync(file, "<!doctype html>")],
] as const) {
  test(`a font bundle that is ${label} throws at the read that needs it, never blank text`, async () => {
    const dir = assetDir();
    damage(join(dir, "fonts.bin"));
    const engine = await createPdfEngine({ assetBase: dir });
    const doc = await engine.open(pdf());
    assert.throws(() => doc.text(0), (error: PdfError) => {
      hasCode("missing-asset")(error);
      assert.match(error.message, /fonts\.bin/u);
      return true;
    });
    assert.throws(() => doc.render(0, { width: 64 }), hasCode("missing-asset"));
    doc.close();
    // Repaired, the next open reads on a fresh instance.
    copyFileSync(packaged("fonts.bin"), join(dir, "fonts.bin"));
    await using after = await engine.open(pdf());
    assert.ok(after.text(0).text.length > 100);
    assert.equal(engine.stats().generation, 1);
  });
}

test("in Node, assetBase cannot name something synchronous reads could not reach", async () => {
  await assert.rejects(createPdfEngine({ assetBase: "https://cdn.example/recto/" }), TypeError);
});

// 2. The wrong thread (a real browser main thread runs in smoke/run.mjs)

test("somewhere without synchronous reads, creating an engine says what to do", async () => {
  const { getBuiltinModule } = process;
  // @ts-expect-error As in a browser: no Node builtins, and a document.
  process.getBuiltinModule = undefined;
  // @ts-expect-error
  globalThis.document = {};
  try {
    await assert.rejects(createPdfEngine(), (error: PdfError) => {
      hasCode("wrong-thread")(error);
      assert.match(error.message, /Web Worker/u);
      return true;
    });
  } finally {
    process.getBuiltinModule = getBuiltinModule;
    // @ts-expect-error
    delete globalThis.document;
  }
});

// 3. Lifetime

test("using closes; double close is a no-op; every method after close throws `closed`", async () => {
  const engine = await createPdfEngine();
  let held;
  {
    using doc = await engine.open(pdf());
    held = doc;
    assert.equal(engine.stats().openDocuments, 1);
  }
  assert.equal(engine.stats().openDocuments, 0);
  held.close();
  held.close();
  held[Symbol.dispose]();
  (held as unknown as Record<symbol, () => void>)[Symbol.for("Symbol.dispose")]?.();
  assert.equal(engine.stats().openDocuments, 0);
  for (const use of [
    () => held.pageInfo(0),
    () => held.text(0),
    () => held.objects(0),
    () => held.annotations(0),
    () => held.scan(0),
    () => held.textAndAnnotations(0),
    () => held.render(0, { width: 64 }),
    () => held.text(99),
    () => held.render(0, { width: 0 }),
  ]) {
    assert.throws(use, hasCode("closed"));
  }
});

test("a failed open leaves nothing open; failing calls do not grow memory", async () => {
  const engine = await createPdfEngine();
  await assert.rejects(engine.open(new TextEncoder().encode("%PDF-1.7\nno")), hasCode("invalid-file"));
  assert.equal(engine.stats().openDocuments, 0);
  // A MediaBox past f32 range has no usable area: this fails in the engine, past the
  // argument checks.
  const huge = "9".repeat(45);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${huge} ${huge}] >>`,
  ];
  let file = "%PDF-1.7\n";
  const offsets = objects.map((body, i) => {
    const at = file.length;
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = file.length;
  file += `xref\n0 4\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  file += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const doc = await engine.open(new TextEncoder().encode(file));
  const failing = () =>
    assert.throws(() => doc.render(0, { width: 64 }), hasCode("failed"));
  failing();
  const before = engine.stats().heapBytes;
  for (let i = 0; i < 20_000; i++) {
    failing();
  }
  assert.equal(engine.stats().heapBytes, before);
  doc.close();
  assert.equal(engine.stats().openDocuments, 0);
});

// 4. The caller's bytes

test("the caller may reuse its buffer as soon as open returns", async () => {
  const bytes = pdf();
  const expected = await (async () => {
    await using doc = await openPdf(bytes);
    return { text: doc.text(2).text, rgba: doc.render(2, { width: 64 }).rgba };
  })();
  // A view into a larger buffer, as a pooled Node Buffer is: byteOffset must count.
  const pool = Buffer.alloc(bytes.byteLength + 1024, 0xee);
  const view = pool.subarray(512, 512 + bytes.byteLength);
  view.set(bytes);
  await using doc = await openPdf(view);
  pool.fill(0);
  assert.equal(doc.text(2).text, expected.text);
  assert.deepEqual(doc.render(2, { width: 64 }).rgba, expected.rgba);
});

test("the buffer is the caller's again before the promise settles", async () => {
  const engine = await createPdfEngine();
  for (const open of [
    (b: Uint8Array) => openPdf(b),
    (b: Uint8Array) => engine.open(b),
    (b: Uint8Array) => engine.openRanged(b),
  ]) {
    const bytes = pdf();
    const pending = open(bytes);
    bytes.fill(0);
    const doc = await pending;
    assert.ok(doc.text(0).text.length > 100);
    doc.close();
  }
});

test("a pooled Buffer holds a small file too", async () => {
  const small = Buffer.from(syntheticPdf({ pages: 1 }));
  assert.ok(small.byteLength < Buffer.poolSize / 2 && small.buffer.byteLength === Buffer.poolSize);
  await using doc = await openPdf(small);
  Buffer.from("x".repeat(small.byteLength)).copy(small);
  assert.equal(doc.pageCount, 1);
  assert.ok(doc.text(0).text.length > 0);
});

test("an ArrayBuffer opens; the buffer can be transferred away after the open", async () => {
  const buffer = pdf().slice().buffer;
  await using doc = await openPdf(buffer);
  structuredClone(buffer, { transfer: [buffer] });
  assert.equal(buffer.byteLength, 0);
  assert.ok(doc.text(0).text.length > 100);
});

test("bytes behind a ranged open are copied too", async () => {
  const engine = await createPdfEngine();
  const bytes = pdf();
  const expected = (await openPdf(bytes)).text(1).text;
  await using doc = await engine.openRanged(bytes, { chunkBytes: 1024 });
  bytes.fill(0);
  assert.equal(doc.text(1).text, expected);
});

test("what is not bytes is a TypeError, not a trap", async () => {
  const engine = await createPdfEngine();
  for (const notBytes of ["%PDF-1.7", undefined, null, 7, {}]) {
    // @ts-expect-error
    await assert.rejects(engine.open(notBytes), TypeError);
  }
  assert.equal(engine.stats().generation, 0);
});

// 5. Ranged reads

test("a server that ignores Range: the whole file is used, within the budget", async () => {
  const engine = await createPdfEngine();
  const bytes = syntheticPdf({ pages: 40, padBytes: 32 * 1024 });
  const server = await startRangeServer(bytes);
  server.setMode("ignore");
  try {
    await using doc = await engine.openRanged(server.url);
    assert.equal(doc.pageCount, 40);
    assert.ok(doc.text(39).text.length > 0);
    assert.equal(doc.stats().requests, 1);
    assert.equal(doc.stats().bytesFetched, bytes.byteLength);
    await assert.rejects(
      engine.openRanged(server.url, { maxBytes: 128 * 1024 }),
      (error: PdfError) => {
        hasCode("too-large")(error);
        assert.match(error.message, /maxBytes/u);
        return true;
      }
    );
  } finally {
    await server.close();
  }
});

test("a server's wrong answers fail clearly, without the URL", async () => {
  const engine = await createPdfEngine();
  const server = await startRangeServer(syntheticPdf({ pages: 40, padBytes: 32 * 1024 }));
  try {
    for (const [mode, pattern] of [
      ["short", /different range/u],
      ["unknown-total", /Content-Range/u],
      ["forbidden", /HTTP 403/u],
      ["changed", /changed size|different range/u],
      ["replaced", /was replaced/u],
    ] as const) {
      server.setMode(mode);
      await assert.rejects(engine.openRanged(server.url), (error: PdfError) => {
        hasCode("fetch-failed")(error);
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /topsecret|127\.0\.0\.1/u);
        return true;
      });
    }
  } finally {
    await server.close();
  }
});

test("a total no file could have is refused before anything is sized from it", async () => {
  const engine = await createPdfEngine();
  const server = await startRangeServer(syntheticPdf({ pages: 2, padBytes: 300 * 1024 }));
  server.setMode("absurd-total");
  try {
    await assert.rejects(engine.openRanged(server.url), hasCode("too-large"));
  } finally {
    await server.close();
  }
});

test("maxBytes is about the file: a small one fits a budget under the first read's size", async () => {
  const engine = await createPdfEngine();
  const small = syntheticPdf({ pages: 1 });
  const server = await startRangeServer(small);
  try {
    for (const source of [small, server.url]) {
      await using doc = await engine.openRanged(source, { maxBytes: 128 * 1024 });
      assert.equal(doc.pageCount, 1);
    }
  } finally {
    await server.close();
  }
});

test("errors never carry a URL's credentials", async () => {
  const engine = await createPdfEngine();
  await assert.rejects(
    engine.openRanged("https://user:hunter2@127.0.0.1:1/a.pdf"),
    (error: PdfError) => {
      hasCode("fetch-failed")(error);
      assert.doesNotMatch(error.message, /hunter2/u);
      return true;
    }
  );
  await assert.rejects(engine.openRanged("nope:?X-Amz-Signature=topsecret"), (error: Error) => {
    assert.ok(error instanceof TypeError);
    assert.doesNotMatch(error.message, /topsecret/u);
    return true;
  });
});

test("bad ranged arguments are TypeErrors and RangeErrors, not hangs", async () => {
  const engine = await createPdfEngine();
  for (const source of [undefined, 7, {}, "./report.pdf"]) {
    // @ts-expect-error
    await assert.rejects(engine.openRanged(source), TypeError);
  }
  for (const options of [
    { chunkBytes: -1 },
    { chunkBytes: 0.5 },
    { chunkBytes: Number.NaN },
    { timeoutMs: Number.NaN },
    { timeoutMs: 0 },
    { maxBytes: Number.NaN },
  ]) {
    await assert.rejects(engine.openRanged(pdf(), options), RangeError, JSON.stringify(options));
  }
});

test("a server that goes bad later fails the call that needed the bytes", async () => {
  const engine = await createPdfEngine();
  const server = await startRangeServer(syntheticPdf({ pages: 40, padBytes: 64 * 1024 }));
  try {
    const doc = await engine.openRanged(server.url);
    server.setMode("forbidden");
    assert.throws(() => {
      for (let i = 0; i < doc.pageCount; i++) {
        doc.text(i);
      }
    }, hasCode("fetch-failed"));
    doc.close();
  } finally {
    await server.close();
  }
});

test("a server on the blocked thread itself cannot answer: a timeout that says why", async () => {
  const { createServer } = await import("node:http");
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const engine = await createPdfEngine();
  try {
    await assert.rejects(
      engine.openRanged(`http://127.0.0.1:${port}/a.pdf`, { timeoutMs: 100 }),
      (error: PdfError) => {
        hasCode("timeout")(error);
        assert.match(error.message, /worker thread/u);
        return true;
      }
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("timeoutMs bounds a fetch, not how long a document stays open", async () => {
  const engine = await createPdfEngine();
  const server = await startRangeServer(syntheticPdf({ pages: 40, padBytes: 64 * 1024 }));
  try {
    await using doc = await engine.openRanged(server.url, { timeoutMs: 1000 });
    await sleep(1100);
    assert.ok(doc.text(20).text.length > 0);
  } finally {
    await server.close();
  }
});

// 6. Typed errors

test("each failure has a code to branch on", async () => {
  const engine = await createPdfEngine();
  const encrypted = readFileSync(new URL("fixtures/user-password-secret.pdf", import.meta.url));
  await assert.rejects(engine.open(new Uint8Array(0)), hasCode("invalid-file"));
  await assert.rejects(engine.open(encrypted), hasCode("password-required"));
  await assert.rejects(engine.open(encrypted, { password: "" }), hasCode("password-required"));
  await assert.rejects(engine.open(encrypted, { password: "wrong" }), hasCode("wrong-password"));
  const controller = new AbortController();
  const reason = new Error("caller went away");
  controller.abort(reason);
  await assert.rejects(
    engine.open(pdf(), { signal: controller.signal }),
    (error: PdfError) => hasCode("aborted")(error) && error.cause === reason
  );
  await assert.rejects(engine.openRanged(pdf(), { signal: controller.signal }), hasCode("aborted"));
  assert.ok(new PdfError("failed", "x") instanceof Error);
});

test("a real trap retires the instance: open documents say so, the next open recovers", async () => {
  // Three ranged files of 1.9 GiB reserve more than wasm32's 4 GiB of address space, and the
  // allocation failure aborts: a real trap, for fresh pages that are never touched.
  const engine = await createPdfEngine({ recycleAboveBytes: Number.POSITIVE_INFINITY });
  const doc = await engine.open(pdf());
  const server = await startRangeServer(new Uint8Array(1));
  server.setMode("huge");
  let crash: unknown;
  try {
    for (let attempt = 0; attempt < 5 && !crash; attempt++) {
      await engine.openRanged(server.url, { maxBytes: 1024 * 1024 }).catch((error: PdfError) => {
        if (error.code === "crash") {
          crash = error;
        }
      });
    }
  } finally {
    await server.close();
  }
  assert.ok(crash instanceof PdfError, "the instance trapped");
  assert.ok(crash.cause instanceof WebAssembly.RuntimeError);
  assert.throws(() => doc.text(0), hasCode("crash"));
  assert.throws(() => doc.pageInfo(0), hasCode("crash"));
  doc.close();
  doc.close();
  await using reopened = await engine.open(pdf());
  assert.equal(engine.stats().generation, 1);
  assert.ok(reopened.text(0).text.length > 100);
});

// 7. The worker_threads pattern the README shows

test("a worker thread keeps this thread's event loop turning", async () => {
  const worker = new Worker(new URL("worker-entry.ts", import.meta.url));
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 5);
  try {
    const started = performance.now();
    const reply = await new Promise<{ pageCount: number }>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (message: { ready?: true; pageCount: number }) => {
        if (message.ready) {
          worker.postMessage({ bytes: syntheticPdf({ pages: 400, charsPerPage: 2000 }) });
        } else {
          resolve(message);
        }
      });
    });
    assert.equal(reply.pageCount, 400);
    assert.ok(ticks >= (performance.now() - started) / 5 / 8, `${ticks} ticks`);
  } finally {
    clearInterval(ticker);
    await worker.terminate();
  }
});
