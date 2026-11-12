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
  await assert.rejects(pool.open(pdf()), { code: "missing-asset" });
  // An assetBase a thread refuses fails as it would on one thread, not as a crash.
  using http = await createPdfPool({ threads: 1, assetBase: "http://example.test/wasm/" });
  await assert.rejects(http.open(pdf()), TypeError);
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
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: 20_000,
  });
  assert.match(out, /count true/u);
});

test("every thread is told about one copy of the file, which the caller can't then change", async () => {
  const { Worker } = await import("node:worker_threads");
  const post = Worker.prototype.postMessage;
  const sent: unknown[] = [];
  Worker.prototype.postMessage = function (this: InstanceType<typeof Worker>, message: { open?: { bytes: Uint8Array } }) {
    if (message.open) sent.push(message.open.bytes.buffer);
    return post.call(this, message);
  };
  try {
    using pool = await createPdfPool({ threads: 3 });
    const bytes = syntheticPdf({ pages: 30, charsPerPage: 50 });
    const expected = (await (await pool.open(bytes)).text(0)).text;
    const again = bytes.slice();
    const doc = await pool.open(again);
    again.fill(0);
    let pages: { text: string }[] = [];
    while (pool.stats().threads < 3) {
      pages = await Promise.all(Array.from({ length: 30 }, (_, i) => doc.text(i)));
    }
    pages = await Promise.all(Array.from({ length: 30 }, (_, i) => doc.text(i)));
    assert.equal(pages[0]!.text, expected);
    const last = sent.at(-1);
    assert.ok(last instanceof SharedArrayBuffer);
    assert.ok(sent.filter((buffer) => buffer === last).length >= 2, "at least two threads were told");
  } finally {
    Worker.prototype.postMessage = post;
  }
});

test("a pool's render takes a region, and its links come back", async () => {
  const bytes = syntheticPdf({ pages: 3 });
  using pool = await createPdfPool({ threads: 1 });
  await using pooled = await pool.open(bytes);
  const engine = await createPdfEngine();
  const doc = await engine.open(bytes);
  const region = { x: 10.5, y: 20.25, width: 200, height: 80 };
  const there = await pooled.render(1, { width: 640, region });
  const here = doc.render(1, { width: 640, region });
  assert.deepEqual([there.x, there.y, there.width, there.height, there.pageWidth], [here.x, here.y, here.width, here.height, here.pageWidth]);
  assert.ok(Buffer.from(there.rgba).equals(Buffer.from(here.rgba)));
  assert.notEqual(there.width, (await pooled.render(1, { width: 640 })).width);
  assert.deepEqual(await pooled.links(0), doc.links(0));
  doc.close();
});

test("a pool's text takes the same options as a thread's", async () => {
  const bytes = pdf();
  const engine = await createPdfEngine();
  using single = await engine.open(bytes);
  using pool = await createPdfPool({ threads: 1 });
  await using doc = await pool.open(bytes);
  const tight = await doc.text(0, { boxes: "tight" });
  assert.deepEqual(tight, single.text(0, { boxes: "tight" }));
  assert.notDeepEqual(tight.boxes, single.text(0).boxes);
});
