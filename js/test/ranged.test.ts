import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { degrees, PDFDocument } from "pdf-lib";

import { createPdfEngine, PdfError } from "../src/index.ts";
import { syntheticPageText, syntheticPdf } from "./synthetic-pdf.ts";
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

test("a file the first read covers takes one round", async () => {
  const bytes = syntheticPdf({ pages: 2 });
  const ranged = await engine.openRanged(bytes);
  // The head and the tail, asked for together before the size is known: here the head is all of it.
  assert.deepEqual([ranged.stats().rounds, ranged.stats().requests], [1, 2]);
  assert.equal(ranged.text(1).text, syntheticPageText(1, 40).join("\n"));
  assert.equal(ranged.stats().rounds, 1);
  ranged.close();
});

/**
 * A page whose dictionary and font are in the head, and whose 300 KB content stream sits far from
 * both ends, between two stretches nothing reads; the xref table and trailer end the file.
 */
function farContentPdf(rects = 24_000): { bytes: Uint8Array; streamBytes: number } {
  const ops = "0 0 1 1 re f\n".repeat(rects);
  const pad = "%" + " ".repeat(600 * 1024) + "\n";
  const parts: string[] = ["%PDF-1.7\n"];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  const object = (id: number, body: string) => {
    offsets[id] = size;
    const text = `${id} 0 obj\n${body}\nendobj\n`;
    parts.push(text);
    size += text.length;
  };
  const filler = () => {
    parts.push(pad);
    size += pad.length;
  };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>");
  object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  filler();
  object(5, `<< /Length ${ops.length + 20} >>\nstream\nBT /F1 9 Tf (far) Tj ET\n${ops}\nendstream`);
  object(6, "<< /Unused true >>");
  filler();
  const xref = size;
  parts.push(`xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`);
  parts.push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return { bytes: new TextEncoder().encode(parts.join("")), streamBytes: ops.length };
}

test("a ranged open is one round, and an object far from both ends one more", async () => {
  const { bytes, streamBytes } = farContentPdf();
  assert.ok(bytes.byteLength > 1024 * 1024);
  for (const source of ["bytes", "http"] as const) {
    const server = source === "http" ? await startRangeServer(bytes) : null;
    try {
      const doc = await engine.openRanged(server ? server.url : bytes);
      // The head holds the header and the page; the tail, fetched beside it, the xref and trailer.
      assert.deepEqual([doc.stats().rounds, doc.stats().requests], [1, 2], source);
      assert.equal(doc.pageCount, 1);
      const before = doc.stats().bytesFetched;
      assert.equal(doc.text(0).text, "far");
      // The content stream doesn't parse in its first window, so it's asked for up to the next
      // object in one go, where growing it took a round for each fourfold step.
      assert.equal(doc.stats().rounds, 2, source);
      assert.ok(doc.stats().bytesFetched - before < streamBytes + 3 * 64 * 1024, `${doc.stats().bytesFetched - before}`);
      if (server) {
        assert.deepEqual([doc.stats().requests, doc.stats().bytesFetched], [server.served().requests, server.served().bytes]);
      }
      doc.close();
    } finally {
      await server?.close();
    }
  }
});

test("an object too far from its window to fetch ahead is asked for whole in one more round", async () => {
  // A content stream of 1.5 MB: past what the first window fetches ahead, so that window holds only
  // its start; the next ask runs to the next object, where growing it fourfold took five rounds.
  const { bytes, streamBytes } = farContentPdf(120_000);
  assert.ok(streamBytes > 1024 * 1024);
  await using doc = await engine.openRanged(bytes);
  assert.equal(doc.stats().rounds, 1);
  const before = doc.stats().bytesFetched;
  assert.equal(doc.text(0).text, "far");
  assert.equal(doc.stats().rounds, 3);
  assert.ok(doc.stats().bytesFetched - before < streamBytes + 3 * 64 * 1024, `${doc.stats().bytesFetched - before}`);
});

test("a budget of the file's size is always enough: no byte is fetched twice", async () => {
  // Sizes either side of the head, the tail and the two together, in 1 KB chunks: the head (4 KB)
  // and the suffix (2 KB) overlap in a file under 6 KB, and the suffix starts mid-chunk in most.
  const sizes = new Set<number>();
  for (const pages of [1, 2, 3, 4, 6, 9, 14, 20, 40]) {
    for (const charsPerPage of [50, 333, 900]) {
      const bytes = syntheticPdf({ pages, charsPerPage });
      sizes.add(bytes.byteLength);
      for (const source of ["bytes", "http"] as const) {
        const server = source === "http" ? await startRangeServer(bytes) : null;
        try {
          await using doc = await engine.openRanged(server ? server.url : bytes, { chunkBytes: 1024, maxBytes: bytes.byteLength });
          for (let i = 0; i < doc.pageCount; i++) {
            doc.text(i);
          }
          const label = `${source}, ${bytes.byteLength} bytes`;
          assert.ok(doc.stats().bytesFetched <= bytes.byteLength, `${label}: fetched ${doc.stats().bytesFetched}`);
          assert.equal(doc.stats().rounds >= 1 && doc.pageCount, pages, label);
        } finally {
          await server?.close();
        }
      }
    }
  }
  assert.ok([...sizes].some((n) => n < 2048) && [...sizes].some((n) => n > 2048 && n < 6144) && [...sizes].some((n) => n > 6144), [...sizes].join());
});

test("a server that refuses a suffix longer than the file still opens a small one in one round", async () => {
  // Express's range-parser answers bytes=-131072 on a smaller file with a 416. The head, which
  // stopped where the suffix would start, reads on to its end instead of asking again.
  for (const pages of [1, 40, 120]) {
    const bytes = syntheticPdf({ pages, charsPerPage: 900 });
    assert.ok(bytes.byteLength < 256 * 1024);
    const server = await startRangeServer(bytes);
    server.setMode("suffix-416");
    try {
      await using doc = await engine.openRanged(server.url, { maxBytes: bytes.byteLength });
      assert.deepEqual([doc.stats().rounds, doc.stats().bytesFetched], [1, bytes.byteLength], `${bytes.byteLength} bytes`);
      assert.equal(doc.pageCount, pages);
      doc.text(pages - 1);
      assert.equal(doc.stats().rounds, 1);
    } finally {
      await server.close();
    }
  }
});

test("a suffix that never answers: the open goes on, with the tail by its offset", { timeout: 10_000 }, async () => {
  const bytes = syntheticPdf({ pages: 8000 });
  const server = await startRangeServer(bytes);
  server.setMode("suffix-stall");
  try {
    await using doc = await engine.openRanged(server.url, { maxBytes: 2 ** 30, timeoutMs: 20_000 });
    // The head with the suffix, given up on; then the tail by its offset; then the xref table.
    assert.equal(doc.stats().rounds, 3);
    assert.equal(doc.pageCount, 8000);
  } finally {
    await server.close();
  }
});

test("a server that won't answer a suffix range gets the tail by its offset, a round later", async () => {
  // An xref table longer than the tail, so the open needs the tail's `startxref` to fetch it whole.
  const bytes = syntheticPdf({ pages: 8000 });
  const server = await startRangeServer(bytes);
  server.setMode("no-suffix");
  try {
    await using doc = await engine.openRanged(server.url, { maxBytes: 2 ** 30 });
    // The head, then the tail by its offset, then the cross-reference table in one round.
    assert.equal(doc.stats().rounds, 3);
    assert.equal(doc.pageCount, 8000);
    // Its whole-file answer to the suffix was dropped unread.
    assert.ok(doc.stats().bytesFetched < bytes.byteLength / 2, `${doc.stats().bytesFetched}`);
  } finally {
    await server.close();
  }
});

test("a cross-reference table longer than the tail takes the open a second round", async () => {
  const bytes = syntheticPdf({ pages: 8000 });
  const whole = await engine.open(bytes);
  const ranged = await engine.openRanged(bytes, { maxBytes: 2 ** 30 });
  try {
    assert.equal(ranged.stats().rounds, 2);
    assert.equal(ranged.pageCount, whole.pageCount);
    assert.equal(ranged.text(7999).text, whole.text(7999).text);
  } finally {
    ranged.close();
    whole.close();
  }
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

test("a URL that redirects to an error page fails with its status, or as not a PDF, never as maxBytes", async () => {
  const server = await startRangeServer(syntheticPdf({ pages: 2 }));
  // Bytes in memory, a PDF's size, with no %PDF where a reader looks: past the first 1 KiB.
  const late = new Uint8Array(4096);
  late.set(new TextEncoder().encode("%PDF-1.7\n"), 2048);
  const page = new TextEncoder().encode("<!DOCTYPE html><html><body>" + "<p>sign in</p>".repeat(30_000) + "</body></html>");
  const big = await startRangeServer(page);
  try {
    server.setMode("redirect-404");
    for (const options of [{}, { maxBytes: 256 }]) {
      await assert.rejects(engine.openRanged(server.url, options), (error: PdfError) => {
        assert.equal(error.code, "fetch-failed");
        assert.equal(error.status, 404);
        assert.match(error.message, /HTTP 404/u);
        return true;
      });
    }
    // A 419-byte page served with a 200: within the budget it fails to parse, past it it ran into
    // maxBytes ("would pass 256 bytes"). Either way it says what it is.
    server.setMode("redirect-page");
    for (const options of [{}, { maxBytes: 256 }]) {
      await assert.rejects(engine.openRanged(server.url, options), { code: "invalid-file", message: /^not a PDF: no %PDF header/u });
    }
    // A large page answered by range, which the repair reads into maxBytes.
    await assert.rejects(engine.openRanged(big.url, { maxBytes: 128 * 1024 }), { code: "invalid-file", message: /^not a PDF/u });
    await assert.rejects(engine.openRanged(late), { code: "invalid-file", message: /^not a PDF/u });
    // A file too large for the budget that is a PDF still says so.
    server.setMode("ignore");
    await assert.rejects(engine.openRanged(server.url, { maxBytes: 256 }), { code: "too-large" });
  } finally {
    await server.close();
    await big.close();
  }
});
