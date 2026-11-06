import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { degrees, PDFDocument } from "pdf-lib";

import { createPdfEngine, PdfError } from "../src/index.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";
import { startRangeServer } from "./range-server.ts";

const fixture = (name: string) =>
  readFile(new URL(`fixtures/${name}`, import.meta.url));

const engine = await createPdfEngine();

/**
 * A multi-megabyte, non-linearized PDF whose bulk (an incompressible
 * attachment) sits between the head and the cross-reference table, with
 * rotated and odd-sized pages. Saved both with an xref stream and a
 * classic xref table.
 */
async function bulkyPdf(useObjectStreams: boolean): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 40; i++) {
    const page = pdf.addPage([300 + i, 500 - i]);
    page.setRotation(degrees((i % 4) * 90));
    page.drawText(`page ${i + 1}`, { x: 20, y: 40 });
  }
  await pdf.attach(randomBytes(4 * 1024 * 1024), "bulk.bin", {
    mimeType: "application/octet-stream",
  });
  return await pdf.save({ useObjectStreams });
}

/** Every page's info, read the ordinary way, from the whole file. */
async function wholeFile(bytes: Uint8Array) {
  const doc = await engine.open(bytes);
  try {
    return {
      pageCount: doc.pageCount,
      pages: Array.from({ length: doc.pageCount }, (_, i) => doc.pageInfo(i)),
    };
  } finally {
    doc.close();
  }
}

test("ranged count and every page's size and rotation equal a whole-file open", async () => {
  const docs = {
    "xref stream": await bulkyPdf(true),
    "xref table": await bulkyPdf(false),
    linearized: await fixture("linearized.pdf"),
    small: syntheticPdf({ pages: 2 }),
    "many pages": syntheticPdf({ pages: 300, charsPerPage: 1500, vary: true }),
  };
  for (const [label, bytes] of Object.entries(docs)) {
    const expected = await wholeFile(bytes);
    // Small chunks force many misses, reopens, and read-ahead growth.
    for (const chunkBytes of [1024, 64 * 1024]) {
      const ranged = await engine.openRanged(bytes, {
        chunkBytes,
      });
      try {
        assert.equal(ranged.pageCount, expected.pageCount, label);
        const pages = [];
        for (let i = 0; i < ranged.pageCount; i++) {
          pages.push(ranged.pageInfo(i));
        }
        assert.deepEqual(pages, expected.pages, `${label} @ ${chunkBytes}`);
      } finally {
        ranged.close();
      }
    }
  }
});

test("reads of content streams over ranges equal the whole file's", async () => {
  // Stream bodies are read in one large block, fetched on demand.
  const bytes = syntheticPdf({ pages: 60, charsPerPage: 2000, vary: true });
  const whole = await engine.open(bytes);
  const ranged = await engine.openRanged(bytes, {
    chunkBytes: 1024,
  });
  try {
    for (const index of [0, 5, whole.pageCount - 1]) {
      const text = ranged.text(index).text;
      assert.equal(text, whole.text(index).text, `page ${index + 1}`);
    }
    assert.ok(ranged.stats().bytesFetched < bytes.byteLength);
  } finally {
    ranged.close();
    whole.close();
  }
});

test("the page count fetches a small part of a large file", async () => {
  for (const useObjectStreams of [true, false]) {
    const bytes = await bulkyPdf(useObjectStreams);
    const ranged = await engine.openRanged(bytes);
    try {
      assert.equal(ranged.pageCount, 40);
      const stats = ranged.stats();
      assert.equal(stats.fileBytes, bytes.byteLength);
      assert.ok(
        stats.bytesFetched < bytes.byteLength / 8,
        `fetched ${stats.bytesFetched} of ${bytes.byteLength}`
      );
    } finally {
      ranged.close();
    }
  }
});

test("a file the first read covers takes one request", async () => {
  const bytes = syntheticPdf({ pages: 2 });
  const ranged = await engine.openRanged(bytes);
  assert.equal(ranged.stats().requests, 1);
  ranged.close();
});

test("ranged open errors match the whole-file open's", async () => {
  const encrypted = await fixture("user-password-secret.pdf");
  const valid = syntheticPdf({ pages: 3 });
  const open = async (bytes: Uint8Array, password?: string) =>
    await engine.openRanged(bytes, {
      chunkBytes: 1024,
      ...(password === undefined ? {} : { password }),
    });
  await assert.rejects(open(encrypted), { code: "password-required" });
  await assert.rejects(open(encrypted, "wrong"), { code: "wrong-password" });
  const unlocked = await open(encrypted, "secret");
  assert.equal(unlocked.pageCount, 1);
  unlocked.close();
  for (const bytes of [
    new TextEncoder().encode("%PDF-1.7\nnot really a pdf at all"),
    new Uint8Array(0),
    valid.subarray(1024),
    randomBytes(300 * 1024),
  ]) {
    await assert.rejects(open(bytes), { code: "invalid-file" });
  }
  // The engine still opens files afterwards.
  const after = await open(valid);
  assert.equal(after.pageCount, 3);
  after.close();
});

test("the byte budget, abort and timeout stop a ranged read", async () => {
  const bytes = await bulkyPdf(false);
  await assert.rejects(
    engine.openRanged(bytes, {
      chunkBytes: 1024,
      maxBytes: 4096,
    }),
    { code: "too-large", message: /would pass 4096 bytes/u }
  );
  // A budget hit after the open fails that call with the budget's error.
  const later = await engine.openRanged(
    syntheticPdf({ pages: 40, padBytes: 64 * 1024 }),
    { maxBytes: 512 * 1024 }
  );
  assert.throws(
    () => {
      for (let i = 0; i < later.pageCount; i++) {
        later.text(i);
      }
    },
    { code: "too-large", message: /would pass/u }
  );
  later.close();
  const controller = new AbortController();
  controller.abort(new Error("caller went away"));
  await assert.rejects(
    engine.openRanged(bytes, { signal: controller.signal }),
    (error: PdfError) => {
      assert.equal(error.code, "aborted");
      assert.equal((error.cause as Error).message, "caller went away");
      return true;
    }
  );
  const slow = await startRangeServer(bytes, { latencyMs: 2000 });
  try {
    const started = performance.now();
    await assert.rejects(
      engine.openRanged(slow.url, { timeoutMs: 50 }),
      { code: "timeout" }
    );
    assert.ok(performance.now() - started < 1000);
  } finally {
    await slow.close();
  }
});

test("an HTTP source reads by Range; errors never carry the URL", async () => {
  const bytes = await bulkyPdf(true);
  const server = await startRangeServer(bytes);
  try {
    const ranged = await engine.openRanged(server.url);
    assert.equal(ranged.pageCount, 40);
    for (let i = 0; i < ranged.pageCount; i++) {
      ranged.pageInfo(i);
    }
    assert.equal(ranged.stats().bytesFetched, server.served().bytes);
    assert.equal(ranged.stats().requests, server.served().requests);
    ranged.close();
    server.setMode("forbidden");
    const forbidden = await engine.openRanged(server.url).then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(forbidden instanceof PdfError);
    assert.equal(forbidden.code, "fetch-failed");
    // The presigned query is a credential; errors never carry the URL.
    assert.doesNotMatch(forbidden.message, /topsecret|127\.0\.0\.1/u);
  } finally {
    await server.close();
  }
});
