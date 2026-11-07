// The pool's results are a single thread's, whichever thread runs them. Imports the built package:
// a worker thread starts from a file, and only dist has pool-worker.js.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { createPdfEngine, createPdfPool, PdfError } from "../dist/index.js";
import { syntheticPdf } from "./synthetic-pdf.ts";

const pages = 12;
const pdf = () => syntheticPdf({ pages, charsPerPage: 300 });
const each = <T>(fn: (index: number) => Promise<T>) => Array.from({ length: pages }, (_, i) => fn(i));
const all = <T>(fn: (index: number) => Promise<T>) => Promise.all(each(fn));

test("text and pixels equal one thread's, in the order asked, on several threads", async () => {
  const bytes = pdf();
  const engine = await createPdfEngine();
  using single = await engine.open(bytes);
  using pool = await createPdfPool({ threads: 3 });
  await using doc = await pool.open(bytes);
  assert.equal(doc.pageCount, single.pageCount);
  const texts = await all((i) => doc.text(i));
  const bitmaps = await all((i) => doc.render(i, { width: 200 }));
  // Starting takes longer than these pages do, so it may take a few rounds.
  while (pool.stats().threads < 3) await all((i) => doc.text(i));
  texts.forEach((text, i) => assert.deepEqual(text, single.text(i)));
  bitmaps.forEach((bitmap, i) => assert.deepEqual(bitmap, single.render(i, { width: 200 })));
  assert.deepEqual(await doc.annotations(0), single.annotations(0));
  assert.deepEqual(await doc.objects(0), single.objects(0));
  assert.deepEqual(await doc.outline(), single.outline());
  assert.deepEqual(await doc.pageInfo(0), single.pageInfo(0));
});

test("calls made one at a time stay on one thread, so the file isn't copied for nothing", async () => {
  using pool = await createPdfPool({ threads: 4 });
  await using doc = await pool.open(pdf());
  for (let i = 0; i < pages; i++) await doc.text(i);
  assert.equal(pool.stats().threads, 1);
});

test("the caller's buffer is free as soon as open returns its promise", async () => {
  const bytes = pdf();
  const expected = (await (await createPdfEngine()).open(bytes)).text(0);
  using pool = await createPdfPool({ threads: 2 });
  const opening = pool.open(bytes);
  bytes.fill(0);
  await using doc = await opening;
  assert.deepEqual(await doc.text(0), expected);
});

test("failures read as they do on one thread, and the pool goes on working", async () => {
  using pool = await createPdfPool({ threads: 2 });
  await assert.rejects(pool.open(new Uint8Array(100)), (error: PdfError) => error instanceof PdfError && error.code === "invalid-file");
  await using doc = await pool.open(pdf());
  await assert.rejects(doc.text(pages), RangeError);
  await assert.rejects(doc.render(0, { width: 0 }), RangeError);
  assert.ok((await doc.text(0)).count > 0);
});

test("closing a document fails what waits for it and leaves the others alone", async () => {
  using pool = await createPdfPool({ threads: 1 });
  const doc = await pool.open(pdf());
  const other = await pool.open(pdf());
  const outcome = Promise.allSettled(each((i) => doc.text(i)));
  await doc.close();
  const results = await outcome;
  assert.ok(results.some((r) => r.status === "rejected" && (r.reason as PdfError).code === "closed"));
  await assert.rejects(doc.text(0), { code: "closed" });
  assert.ok((await other.text(0)).count > 0);
  await other.close();
});

test("closing the pool stops its threads and fails what's unfinished", async () => {
  const pool = await createPdfPool({ threads: 2 });
  const doc = await pool.open(pdf());
  const outcome = Promise.allSettled(each((i) => doc.render(i, { width: 600 })));
  pool.close();
  assert.ok((await outcome).every((r) => r.status === "rejected" && (r.reason as PdfError).code === "closed"));
  await assert.rejects(doc.text(0), { code: "closed" });
  await assert.rejects(pool.open(pdf()), { code: "closed" });
});

test("a thread that can't start fails the call instead of leaving it waiting", async () => {
  using pool = await createPdfPool({ threads: 2, assetBase: "/nowhere" });
  await assert.rejects(pool.open(pdf()), { code: "crash" });
});

test("a bad thread count is a RangeError", async () => {
  await assert.rejects(createPdfPool({ threads: 0 }), RangeError);
});

test("an idle pool lets Node exit, and a call under way keeps it alive until it answers", () => {
  const script = `
    import { createPdfPool } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
    const pool = await createPdfPool({ threads: 2 });
    const bytes = new Uint8Array(Buffer.from(process.argv[1], "base64"));
    pool.open(bytes).then((doc) => doc.text(0)).then((text) => console.log("count", text.count > 0));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, Buffer.from(pdf()).toString("base64")], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.match(out, /count true/u);
});
