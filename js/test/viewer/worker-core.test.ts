// The viewer's worker, driven in this thread with the real engine: what each message answers.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { ViewerRequest, ViewerResponse, ViewerResult } from "../../src/viewer/protocol.ts";
import { createWorkerHandler, findInText, searchText } from "../../src/viewer/worker-core.ts";
import { createPdfEngine } from "../../src/index.ts";
import { type RangeServer, startRangeServer } from "../range-server.ts";
import { textPdf } from "./fixtures.ts";

const small = textPdf({ pages: 3, links: true });
// 8 MiB, past a 64 KiB threshold, so it opens by range.
const large = textPdf({ pages: 128, padBytes: 64 * 1024 });
let smallServer: RangeServer;
let largeServer: RangeServer;

before(async () => {
  smallServer = await startRangeServer(small);
  largeServer = await startRangeServer(large);
});
after(async () => {
  await smallServer.close();
  await largeServer.close();
});

/** A handler and a way to call it as the client does: one id per call, its answer as a promise. */
function worker(options: { wholeFileMaxBytes?: number } = {}) {
  const waiting = new Map<number, (response: ViewerResponse) => void>();
  const handle = createWorkerHandler({ ...options, reply: (response) => waiting.get(response.id)?.(response) });
  let nextId = 1;
  const call = <Op extends keyof ViewerResult>(request: Omit<Extract<ViewerRequest, { op: Op }>, "id">) => {
    const id = nextId++;
    const answered = new Promise<ViewerResponse>((resolve) => waiting.set(id, resolve));
    void handle({ ...request, id } as ViewerRequest);
    return answered.then((response) => {
      if (!response.ok) {
        throw Object.assign(new Error(response.error.message), { code: response.error.code });
      }
      return response.value as ViewerResult[Op];
    });
  };
  return { call, handle, next: () => nextId++, waiting };
}

test("open, page size, text runs, links and a bitmap of the asked width", async () => {
  const { call } = worker();
  const opened = await call<"open">({ docId: 1, op: "open", source: { kind: "bytes", bytes: small.slice().buffer } });
  assert.equal(opened.pageCount, 3);
  assert.deepEqual(opened.firstPage, { height: 792, rotation: 0, width: 612 });
  assert.equal(opened.ranged, false);
  assert.equal(opened.timing.bytes, small.byteLength);
  assert.deepEqual(await call<"pageInfo">({ docId: 1, op: "pageInfo", page: 2 }), { height: 792, rotation: 0, width: 612 });
  const { runs, links } = await call<"text">({ docId: 1, op: "text", page: 1 });
  assert.deepEqual(
    runs.map((run) => run.str),
    ["Page 1 line 0", "Page 1 line 1", "Page 1 line 2"].flatMap((line) => line)
  );
  assert.equal(runs[0]?.family, "sans-serif");
  assert.equal(runs[1]?.breakBefore, "line");
  // Every URI is passed on (the text layer decides which are safe); the page link is 1-based.
  assert.deepEqual(
    links.map(({ target }) => target),
    [
      { kind: "uri", uri: "https://example.com/a?b=1" },
      { kind: "uri", uri: "javascript:alert(1)" },
      { kind: "uri", uri: "mailto:someone@example.com" },
      { kind: "page", page: 2, x: 36, y: 392 },
    ]
  );
  const bitmap = await call<"render">({ docId: 1, op: "render", page: 1, width: 306 });
  assert.equal(bitmap.width, 306);
  assert.equal(bitmap.height, 396);
  assert.equal(bitmap.rgba.byteLength, 306 * 396 * 4);
  assert.ok(bitmap.rgba.some((value) => value < 128), "the text is drawn");
  const region = await call<"render">({ docId: 1, op: "render", page: 1, width: 612, region: { x: 0, y: 0, width: 306, height: 100 } });
  assert.equal(region.width, 306);
  assert.deepEqual(region.region, { pageHeight: 792, pageWidth: 612, x: 0, y: 0 });
});

test("the outline, nested, with pages from 1", async () => {
  const { call } = worker();
  const pdf = textPdf({ outline: [{ page: 1, title: "Start" }, { children: [{ page: 3, title: "Deeper" }], page: 2, title: "Middle" }], pages: 3 });
  await call<"open">({ docId: 1, op: "open", source: { kind: "bytes", bytes: pdf.slice().buffer } });
  assert.deepEqual(await call<"outline">({ docId: 1, op: "outline" }), [
    { children: [], page: 1, title: "Start", url: null },
    { children: [{ children: [], page: 3, title: "Deeper", url: null }], page: 2, title: "Middle", url: null },
  ]);
  await call<"open">({ docId: 2, op: "open", source: { kind: "bytes", bytes: small.slice().buffer } });
  assert.deepEqual(await call<"outline">({ docId: 2, op: "outline" }), []);
});

test("failures carry the engine's code", async () => {
  const { call } = worker();
  await assert.rejects(call<"open">({ docId: 1, op: "open", source: { kind: "bytes", bytes: new TextEncoder().encode("not a pdf").buffer } }), {
    code: "invalid-file",
  });
  // A document that never opened is closed.
  await assert.rejects(call<"text">({ docId: 1, op: "text", page: 1 }), { code: "closed" });
  smallServer.setMode("forbidden");
  try {
    await assert.rejects(call<"open">({ docId: 2, op: "open", source: { kind: "url", url: smallServer.url } }), { code: "fetch-failed" });
  } finally {
    smallServer.setMode("range");
  }
});

test("a render cancelled before its document finished opening stops", async () => {
  const { call, handle, next } = worker();
  const opening = call<"open">({ docId: 1, op: "open", source: { kind: "bytes", bytes: small.slice().buffer } });
  const rendering = call<"render">({ docId: 1, op: "render", page: 1, width: 400 });
  // The render's id is the one before the next.
  const id = next() - 1;
  await handle({ id, op: "cancel" });
  await opening;
  await assert.rejects(rendering, { code: "aborted" });
});

test("closing a document fails later calls on it as closed", async () => {
  const { call, handle } = worker();
  await call<"open">({ docId: 7, op: "open", source: { kind: "bytes", bytes: small.slice().buffer } });
  await handle({ docId: 7, op: "close" });
  await assert.rejects(call<"pageInfo">({ docId: 7, op: "pageInfo", page: 1 }), { code: "closed" });
});

test("a file under the whole-file threshold is read in one request", async () => {
  const before = smallServer.served().requests;
  const { call } = worker();
  const opened = await call<"open">({ docId: 1, op: "open", source: { kind: "url", url: smallServer.url } });
  assert.equal(opened.ranged, false);
  assert.equal(await call<"find">({ caseSensitive: false, docId: 1, op: "find", page: 3, query: "page 3 LINE 2" }).then((hits) => hits.length), 1);
  assert.equal(smallServer.served().requests - before, 1);
});

test("a file over the threshold is read by range, not downloaded whole", async () => {
  const start = largeServer.served();
  const { call } = worker({ wholeFileMaxBytes: 64 * 1024 });
  const opened = await call<"open">({ docId: 1, op: "open", source: { kind: "url", url: largeServer.url } });
  assert.equal(opened.ranged, true);
  assert.equal(opened.pageCount, 128);
  const hits = await call<"find">({ caseSensitive: true, docId: 1, op: "find", page: 99, query: "Page 99 line 1" });
  assert.equal(hits.length, 1);
  const served = largeServer.served();
  assert.ok(served.requests - start.requests > 1, "the first request learns the length; the rest are ranges");
  // The first answer is dropped at the threshold, past what the socket had buffered.
  assert.ok(served.bytes - start.bytes < large.byteLength / 2, `${served.bytes - start.bytes} of ${large.byteLength} bytes`);
});

// A gzip body's Content-Length is its compressed size: the decoded file can pass the cap. That reads
// by range, not fails at the cap.
test("a body that decodes past the cap opens by range", async () => {
  const lying: typeof fetch = async (input, init) => {
    const real = await fetch(input, init);
    return new Response(real.body, { headers: { "content-length": "1000" }, status: real.status });
  };
  const waiting = new Map<number, (response: ViewerResponse) => void>();
  const handle = createWorkerHandler({ fetch: lying, reply: (response) => waiting.get(response.id)?.(response), wholeFileMaxBytes: 64 * 1024 });
  const answered = new Promise<ViewerResponse>((resolve) => waiting.set(1, resolve));
  void handle({ docId: 1, id: 1, op: "open", source: { kind: "url", url: largeServer.url } });
  const response = await answered;
  assert.ok(response.ok && "ranged" in response.value && response.value.ranged);
});

test("a shared worker refuses a file it would have to read by range", async () => {
  const { call } = worker({ wholeFileMaxBytes: 64 * 1024 });
  await assert.rejects(call<"open">({ docId: 1, op: "open", source: { kind: "url", url: largeServer.url }, wholeOnly: true }), {
    code: "needs-own-worker",
  });
});

test("find normalizes Unicode: ligatures, full width, split accents and case fold, with boxes mapped back", () => {
  // One char per unit but for the ligature, which is one char shown as one box; each char 10 pt wide.
  const text = "ﬁnal Café ＲＥＰＯＲＴ STRASSE of­fice";
  const chars = Int32Array.from(text.split("").map((_, i) => i));
  const boxes = new Float32Array(text.length * 4);
  for (let i = 0; i < text.length; i++) {
    boxes.set([i * 10, 100, 10, 12], i * 4);
  }
  const search = { chars, text };
  const at = (query: string, caseSensitive = false) => findInText(search, boxes, query, caseSensitive);
  // The ligature is its letters, and a hit on part of it covers that part of its box.
  assert.equal(at("final").length, 1);
  assert.deepEqual(at("final")[0]!.boxes, [{ height: 12, width: 40, x: 0, y: 100 }]);
  assert.deepEqual(at("inal")[0]!.boxes, [{ height: 12, width: 35, x: 5, y: 100 }]);
  assert.equal(at("final")[0]!.index, 0);
  // A precomposed é matches e and a combining acute, and the hit covers both chars.
  const [cafe] = at("café");
  assert.ok(cafe, "café");
  assert.equal(cafe.index, text.indexOf("Cafe"));
  assert.deepEqual(cafe.boxes, [{ height: 12, width: 50, x: 50, y: 100 }]);
  // And the other way round.
  assert.equal(findInText({ chars: Int32Array.from([0, 1, 2, 3]), text: "café" }, boxes, "café", false).length, 1);
  assert.equal(at("CAFÉ", true).length, 0, "case-sensitive still tells case apart");
  assert.equal(at("Café", true).length, 1, "but not how an accent is written");
  // Full-width letters read as plain ones, ß folds to ss, a soft hyphen is invisible.
  assert.equal(at("report").length, 1);
  assert.equal(at("straße").length, 1);
  assert.equal(at("office").length, 1);
  assert.equal(at("cafe").length, 0, "an accent still counts");
});

test("find through the worker matches text a font maps to a ligature or a combining accent", async () => {
  const { call } = worker();
  const pdf = textPdf({ pages: 1, lines: 0, extra: ["\\001nal cafe\\002 done"], toUnicode: { 1: "ﬁ", 2: "́" } });
  await call<"open">({ docId: 1, op: "open", source: { kind: "bytes", bytes: pdf.slice().buffer } });
  const find = (query: string) => call<"find">({ caseSensitive: false, docId: 1, op: "find", page: 1, query });
  const [hit] = await find("FINAL CAFÉ");
  assert.ok(hit, "a precomposed query matches the decomposed text");
  assert.equal(hit.boxes.length, 1);
  assert.ok(hit.boxes[0]!.width > 40, JSON.stringify(hit.boxes));
  assert.equal((await find("café done")).length, 1);
});

test("find: case, whitespace across line breaks, line-end hyphenation, and one box per line", async () => {
  const engine = await createPdfEngine();
  const doc = await engine.open(textPdf({ pages: 1, lines: 2, extra: ["the anti-", "body was found"] }));
  try {
    const text = doc.text(0);
    const search = searchText(text, doc.pageInfo(0));
    // Lines join with one space; the hyphen ending a line is a break, not text.
    assert.equal(search.text, "Page 1 line 0 Page 1 line 1 the antibody was found");
    assert.equal(findInText(search, text.boxes, "antibody", false)[0]?.boxes.length, 2);
    const across = findInText(search, text.boxes, "line 0\n  page 1", false);
    assert.equal(across.length, 1);
    assert.equal(across[0]?.boxes.length, 2, "a hit across two lines has a box on each");
    const [first, second] = across[0]!.boxes;
    assert.ok(first && second && second.y > first.y + 10, "the second line's box is below the first");
    assert.equal(findInText(search, text.boxes, "PAGE 1", false).length, 2);
    assert.equal(findInText(search, text.boxes, "PAGE 1", true).length, 0);
    assert.equal(findInText(search, text.boxes, "   ", false).length, 0);
    const box = findInText(search, text.boxes, "line 1", true)[0]?.boxes[0];
    // 72 pt in, on the second line: 14 pt below the first, whose baseline is 72 pt from the top.
    assert.ok(box && box.x > 100 && box.x < 140 && box.y > 72 && box.y < 100, JSON.stringify(box));
  } finally {
    doc.close();
  }
});
