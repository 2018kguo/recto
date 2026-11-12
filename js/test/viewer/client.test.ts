// The page's side of the viewer's workers: a worker per document, reopening after a failed read or a
// crash with backoff, stopping a stuck render's worker, and the cache of open documents.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createViewerEngine, isAbort, type WorkerPort } from "../../src/viewer/client.ts";
import type { ViewerRequest, ViewerResponse } from "../../src/viewer/protocol.ts";
import { createWorkerHandler } from "../../src/viewer/worker-core.ts";
import { type RangeServer, startRangeServer } from "../range-server.ts";
import { inProcessWorkers, textPdf } from "./fixtures.ts";

let long: RangeServer;
let other: RangeServer;

before(async () => {
  // 2000 pages read by range past a 64 KiB threshold; 3 pages read whole.
  long = await startRangeServer(textPdf({ pages: 2000, lines: 1, padBytes: 256 }));
  other = await startRangeServer(textPdf({ pages: 3 }));
});
after(async () => {
  await long.close();
  await other.close();
});

const textOf = async (doc: { text(page: number): Promise<{ runs: { str: string }[] }> }, page: number) =>
  (await doc.text(page)).runs.map((run) => run.str).join(" ");

// The engine ends a document at its first failed read. Without reopening, one 403 failed every later
// page of that file for good, even after the server recovered.
test("one failed range read does not end the document: the next call reopens it", async () => {
  const workers = inProcessWorkers({ wholeFileMaxBytes: 64 * 1024 });
  const engine = createViewerEngine({ createWorker: workers.createWorker, reopenBackoffMs: 1 });
  const lease = engine.open({ kind: "url", url: long.url });
  const doc = await lease.promise;
  assert.equal(doc.ranged, true);
  try {
    long.setMode("forbidden");
    await assert.rejects(textOf(doc, 1800), (cause: Error) => {
      // A failure to report, not a stop to ignore.
      assert.equal(cause.name, "PdfError");
      assert.equal((cause as Error & { code: string }).code, "fetch-failed");
      return true;
    });
    long.setMode("range");
    // The server is back: the same handle serves pages again.
    assert.match(await textOf(doc, 1800), /Page 1800 line 0/u);
    assert.match(await textOf(doc, 5), /Page 5 line 0/u);
    // On a fresh worker: the old one held nothing else, and stopping it ends any read stuck on it.
    assert.equal(workers.ports.length, 2);
    assert.ok(workers.ports[0]?.terminated);
  } finally {
    long.setMode("range");
    lease.release();
    engine.close();
  }
});

test("each document gets its own worker up to the cap, and closing stops it", async () => {
  const workers = inProcessWorkers();
  const engine = createViewerEngine({ createWorker: workers.createWorker, maxWorkers: 2 });
  const leases = [engine.open({ kind: "url", url: long.url }), engine.open({ kind: "bytes", bytes: textPdf({ pages: 2 }).buffer })];
  await Promise.all(leases.map((lease) => lease.promise));
  leases.push(engine.open({ kind: "bytes", bytes: textPdf({ pages: 4 }).buffer }));
  await leases[2]!.promise;
  // A slow file blocks only its own worker; past the cap, a file read whole joins a worker that
  // holds only files read whole.
  assert.equal(workers.ports.length, 2);
  assert.equal(engine.liveWorkers(), 2);
  for (const lease of leases) {
    lease.release();
  }
  // Read from bytes, two are closed at once; the one by URL stays cached, its worker with it.
  assert.equal(engine.liveWorkers(), 1);
  engine.close();
  assert.equal(engine.liveWorkers(), 0);
  assert.ok(workers.ports.every((port) => port.terminated));
});

test("a worker that dies fails its calls, and the document reopens on a new one", async () => {
  const workers = inProcessWorkers();
  const engine = createViewerEngine({ createWorker: workers.createWorker });
  const lease = engine.open({ kind: "url", url: long.url });
  const doc = await lease.promise;
  try {
    const waiting = doc.pageInfo(1500);
    workers.ports[0]?.die();
    await assert.rejects(waiting, (cause: Error) => {
      assert.equal(cause.name, "PdfError");
      return true;
    });
    assert.deepEqual(await doc.pageInfo(1500), { height: 792, rotation: 0, width: 612 });
    assert.equal(workers.ports.length, 2);
  } finally {
    engine.close();
  }
  assert.equal(engine.liveWorkers(), 0);
  assert.ok(workers.ports.every((port) => port.terminated));
});

test("a cancelled render stuck in its worker stops that worker", async () => {
  const workers = inProcessWorkers();
  const engine = createViewerEngine({ createWorker: workers.createWorker, stuckCancelMs: 50 });
  const lease = engine.open({ kind: "url", url: other.url });
  const doc = await lease.promise;
  try {
    const port = workers.ports[0]!;
    port.hang = true;
    const render = doc.render(1, { width: 200 });
    // Let the render reach the worker, then cancel it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    render.cancel();
    await assert.rejects(render.promise);
    assert.ok(port.terminated);
    // The document carries on, on a new worker.
    port.hang = false;
    assert.equal((await doc.render(1, { width: 100 }).promise).width, 100);
    assert.equal(workers.ports.length, 2);
  } finally {
    engine.close();
  }
});

test("a cancelled render is a stop, and a call on a closed document is a stop, not a failure", async () => {
  const workers = inProcessWorkers();
  const engine = createViewerEngine({ createWorker: workers.createWorker });
  const lease = engine.open({ kind: "bytes", bytes: textPdf({ pages: 2 }).buffer });
  const doc = await lease.promise;
  const render = doc.render(1, { width: 400 });
  render.cancel();
  await assert.rejects(render.promise, (cause) => isAbort(cause));
  lease.release();
  await assert.rejects(doc.pageInfo(2), (cause) => isAbort(cause));
  engine.close();
});

test("pages are numbered from 1, and one out of range is a RangeError", async () => {
  const workers = inProcessWorkers();
  const engine = createViewerEngine({ createWorker: workers.createWorker });
  const lease = engine.open({ kind: "bytes", bytes: textPdf({ pages: 2 }).buffer });
  const doc = await lease.promise;
  try {
    assert.throws(() => doc.pageInfo(0), RangeError);
    assert.throws(() => doc.render(3, { width: 10 }), RangeError);
    assert.deepEqual(
      (await doc.find(2, "line 1")).map((hit) => hit.index),
      // "Page 2 line 0 Page 2 line 1 ..."
      [21]
    );
  } finally {
    engine.close();
  }
});

/**
 * A scripted worker: opens anything as a 10-page file of 100 x 100 pages, answers pageInfo, and fails
 * (or never answers) each worker's nth render as `failing` says, the way the engine fails or blocks on
 * a read from a server that is down or slow.
 */
function scriptedWorkers(failing: (worker: number, render: number) => boolean | "hang") {
  const counts = { closes: 0, created: 0, opens: 0, terminated: 0 };
  const opened: string[] = [];
  const closed: string[] = [];
  const urls = new Map<number, string>();
  const createWorker = (): WorkerPort => {
    counts.created += 1;
    const worker = counts.created;
    let renders = 0;
    const target = new EventTarget();
    let terminated = false;
    const send = (data: unknown) =>
      setTimeout(() => {
        if (!terminated) {
          target.dispatchEvent(new MessageEvent("message", { data }));
        }
      }, 1);
    return {
      addEventListener: (type, listener) => target.addEventListener(type, listener),
      postMessage(message: ViewerRequest) {
        const info = { height: 100, rotation: 0, width: 100 };
        if (message.op === "open") {
          counts.opens += 1;
          const url = message.source.kind === "url" ? message.source.url : "bytes";
          urls.set(message.docId, url);
          opened.push(url);
          send({ id: message.id, ok: true, value: { firstPage: info, pageCount: 10, ranged: true, timing: {} } });
        } else if (message.op === "close") {
          counts.closes += 1;
          closed.push(urls.get(message.docId) ?? "?");
        } else if (message.op === "pageInfo") {
          send({ id: message.id, ok: true, value: info });
        } else if (message.op === "render") {
          renders += 1;
          const outcome = failing(worker, renders);
          if (outcome === "hang") {
            return;
          }
          send(
            outcome
              ? { error: { code: "fetch-failed", message: "HTTP 503" }, id: message.id, ok: false }
              : { id: message.id, ok: true, value: { height: message.width, rgba: new Uint8ClampedArray(message.width ** 2 * 4), width: message.width } }
          );
        }
      },
      terminate() {
        terminated = true;
        counts.terminated += 1;
      },
    };
  };
  return { closed, counts, createWorker, opened };
}

// Two paints in flight when one read fails. Replacing the failed copy stops its worker, which fails
// the other paint; that stale failure used to count as a new one and reopen again, killing the fresh
// worker, synchronously and for ever (thousands of workers, a frozen tab). The viewer repaints on failure.
test("a failure from a replaced copy does not reopen the document again", async () => {
  // The first worker fails one paint's read while the other waits on it; every later worker answers.
  const workers = scriptedWorkers((worker, render) => (worker === 1 ? (render === 1 ? true : "hang") : false));
  const engine = createViewerEngine({ createWorker: workers.createWorker, reopenBackoffMs: 1 });
  const lease = engine.open({ kind: "url", url: "http://pdf.test/blip.pdf" });
  const doc = await lease.promise;
  try {
    let attempts = 0;
    const paint = async (page: number): Promise<void> => {
      try {
        await doc.render(page, { width: 10 }).promise;
      } catch {
        attempts += 1;
        assert.ok(attempts < 50, "repaints did not settle");
        return paint(page);
      }
    };
    await Promise.all([paint(1), paint(2)]);
    assert.ok(workers.counts.created <= 2, `${workers.counts.created} workers`);
    assert.equal(engine.liveWorkers(), 1);
  } finally {
    engine.close();
  }
});

// A server that stays down: every paint fails and is repainted at once. Reopens wait out a doubling
// backoff instead of costing a new open and a GET per paint.
test("reopens after repeated failures back off, and a success resets it", async () => {
  let down = true;
  const workers = scriptedWorkers(() => down);
  const engine = createViewerEngine({ createWorker: workers.createWorker, reopenBackoffMs: 20 });
  const lease = engine.open({ kind: "url", url: "http://pdf.test/down.pdf" });
  const doc = await lease.promise;
  const until = Date.now() + 500;
  let paints = 0;
  const paint = () => doc.render(1, { width: 10 }).promise;
  try {
    while (Date.now() < until) {
      paints += 1;
      await paint().catch(() => {});
    }
    // 20 + 40 + 80 + 160 ms of backoff fit in 500 ms: about 5 opens.
    assert.ok(workers.counts.opens <= 7, `${workers.counts.opens} opens`);
    assert.ok(paints <= 10, `${paints} paints`);
    // Back up: one paint succeeds after the current backoff step.
    down = false;
    await paint();
    // Down again: the next reopen waits the first step, not the longest.
    down = true;
    await paint().catch(() => {});
    const started = Date.now();
    await paint().catch(() => {});
    assert.ok(Date.now() - started < 150, `${Date.now() - started} ms`);
  } finally {
    engine.close();
  }
});

// Past the cap documents share a worker, and a ranged read blocks its worker for a round trip: a
// ranged file on a shared worker would stall the files read whole beside it.
test("past the cap a ranged file gets its own worker, and only whole files share", async () => {
  const workers = inProcessWorkers({ wholeFileMaxBytes: 64 * 1024 });
  const engine = createViewerEngine({ createWorker: workers.createWorker, maxWorkers: 1 });
  const small = engine.open({ kind: "url", url: other.url });
  await small.promise;
  const ranged = engine.open({ kind: "url", url: long.url });
  const smallAgain = engine.open({ kind: "bytes", bytes: textPdf({ pages: 1 }).buffer });
  try {
    const rangedDoc = await ranged.promise;
    await smallAgain.promise;
    // The ranged file was refused by the shared worker and opened on its own.
    assert.equal(workers.ports.length, 2);
    assert.equal((await rangedDoc.pageInfo(1800)).width, 612);
    // Later small files join the first one's worker, never the ranged one's.
    const another = engine.open({ kind: "bytes", bytes: textPdf({ pages: 1 }).buffer });
    await another.promise;
    assert.equal(workers.ports.length, 2);
    assert.equal(workers.ports[1]?.opens, 1);
    another.release();
  } finally {
    small.release();
    ranged.release();
    smallAgain.release();
    engine.close();
  }
  assert.equal(engine.liveWorkers(), 0);
});

test("readers keep their documents under cache pressure, and idle ones stay bounded", async () => {
  const workers = scriptedWorkers(() => false);
  const engine = createViewerEngine({ createWorker: workers.createWorker });
  const url = (i: number) => `http://pdf.test/pressure-${i}.pdf`;
  const leases = Array.from({ length: 5 }, (_, i) => engine.open({ kind: "url", url: url(i) }));
  for (const lease of leases) {
    assert.equal((await lease.promise).pageCount, 10);
  }
  assert.deepEqual(workers.closed, []);
  for (const lease of leases) {
    lease.release();
  }
  assert.deepEqual(workers.closed.toSorted(), [url(0), url(1)]);
  for (const lease of leases) {
    lease.release();
  }
  assert.equal(workers.closed.length, 2, "release is idempotent");
  const reopened = engine.open({ kind: "url", url: url(4) });
  await reopened.promise;
  assert.equal(workers.counts.opens, 5, "a recent idle document is reused");
  reopened.release();
  engine.close();
});

test("closing one viewer does not close another reading the same file", async () => {
  const workers = scriptedWorkers(() => false);
  const engine = createViewerEngine({ createWorker: workers.createWorker });
  const shared = "http://pdf.test/shared.pdf";
  const first = engine.open({ kind: "url", url: shared });
  const second = engine.open({ kind: "url", url: shared });
  first.release();
  first.release();
  for (let i = 0; i < 5; i++) {
    const passing = engine.open({ kind: "url", url: `http://pdf.test/passing-${i}.pdf` });
    await passing.promise;
    passing.release();
  }
  assert.equal((await (await second.promise).pageInfo(5)).width, 100);
  assert.ok(!workers.closed.includes(shared));
  assert.equal(workers.opened.filter((opened) => opened === shared).length, 1);
  second.release();
  engine.close();
});

test("a failed open leaves the cache, so the next open tries again", async () => {
  const workers = inProcessWorkers();
  const engine = createViewerEngine({ createWorker: workers.createWorker });
  other.setMode("forbidden");
  const failed = engine.open({ kind: "url", url: other.url });
  await assert.rejects(failed.promise, { code: "fetch-failed" });
  other.setMode("range");
  const retried = engine.open({ kind: "url", url: other.url });
  try {
    failed.release();
    failed.release();
    assert.equal((await retried.promise).pageCount, 3);
  } finally {
    retried.release();
    engine.close();
  }
});

// Every document the cache opens is closed exactly once, as soon as no reader holds it and it falls
// out of the idle budget, whatever order viewers open and close in.
test("every opened document is closed once after its last reader leaves the budget", async () => {
  const workers = scriptedWorkers(() => false);
  const engine = createViewerEngine({ createWorker: workers.createWorker });
  const held: { release(): void; url: string }[] = [];
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed % n;
  };
  for (let step = 0; step < 400; step++) {
    if (held.length > 0 && next(2) === 0) {
      const [lease] = held.splice(next(held.length), 1);
      lease?.release();
    } else {
      const url = `http://pdf.test/invariant-${next(9)}.pdf`;
      held.push({ ...engine.open({ kind: "url", url }), url });
    }
    // Opens reach the worker on a later turn; let them.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const live = new Map<string, number>();
    for (const url of workers.opened) {
      live.set(url, (live.get(url) ?? 0) + 1);
    }
    for (const url of workers.closed) {
      live.set(url, (live.get(url) ?? 0) - 1);
    }
    for (const lease of held) {
      assert.equal(live.get(lease.url), 1, `${lease.url} is open while read`);
    }
    assert.ok([...live.values()].every((count) => count === 0 || count === 1));
  }
  for (const lease of held) {
    lease.release();
  }
  for (let i = 0; i < 4; i++) {
    engine.open({ kind: "url", url: `http://pdf.test/filler-${i}.pdf` }).release();
  }
  const invariant = (url: string) => url.includes("invariant-");
  assert.equal(workers.opened.filter(invariant).length - workers.closed.filter(invariant).length, 0);
  engine.close();
});

// A page of thumbnails opens many files at once. Past the cap, each used to start a worker of its
// own, since no worker had yet said it could be shared.
test("a burst of opens past the cap shares workers instead of starting one each", async () => {
  const workers = inProcessWorkers();
  const engine = createViewerEngine({ createWorker: workers.createWorker, maxWorkers: 2 });
  const leases = Array.from({ length: 12 }, (_, i) => engine.open({ kind: "bytes", bytes: textPdf({ pages: 1 + (i % 3) }).buffer }));
  try {
    await Promise.all(leases.map((lease) => lease.promise));
    assert.equal(workers.ports.length, 2);
  } finally {
    engine.close();
  }
});

test("a render cancelled while its document is still opening is never sent", async () => {
  const workers = inProcessWorkers();
  const engine = createViewerEngine({ createWorker: workers.createWorker });
  const lease = engine.open({ kind: "bytes", bytes: textPdf({ pages: 2 }).buffer });
  const doc = await lease.promise;
  try {
    workers.ports[0]?.die();
    // The document reopens before this render can be sent; it's cancelled first.
    const render = doc.render(1, { width: 300 });
    render.cancel();
    await assert.rejects(render.promise, (cause) => isAbort(cause));
    await doc.pageInfo(2);
    assert.equal(workers.ports.flatMap((port) => port.sent).filter((message) => message.op === "render").length, 0);
  } finally {
    engine.close();
  }
});

test("a server that never answers fails the open as a timeout", async () => {
  const answers: ViewerResponse[] = [];
  const handle = createWorkerHandler({ reply: (response) => answers.push(response), timeoutMs: 200 });
  other.setMode("stalled");
  try {
    const started = Date.now();
    await handle({ docId: 1, id: 1, op: "open", source: { kind: "url", url: other.url } });
    assert.ok(Date.now() - started < 5000);
    const [answer] = answers;
    assert.ok(answer && !answer.ok && answer.error.code === "timeout", JSON.stringify(answer));
  } finally {
    other.setMode("range");
  }
});
