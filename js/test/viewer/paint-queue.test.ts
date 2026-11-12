// The order pages are painted in: nearest the screen first, two at a time, canvases before text, a
// page the reader left stopped, and a page that keeps failing left alone until it comes back.

import assert from "node:assert/strict";
import { test } from "node:test";

import { createPaintQueue, type PaintQueueRecord } from "../../src/viewer/paint-queue.ts";

type Record = PaintQueueRecord & { cancelled: number };

function records(count: number): Record[] {
  return Array.from({ length: count }, (_, i) => ({
    canvasRendered: false,
    cancelled: 0,
    failures: 0,
    outputScale: 0,
    pageNumber: i + 1,
    renderTask: null,
    textRendered: false,
    textTask: null,
  }));
}

/** A queue whose paints wait to be finished by hand. */
function manualQueue(options: { fail?: (record: Record) => boolean } = {}) {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const queue = createPaintQueue<Record>({
    isStopped: () => false,
    paintCanvas: (record) => {
      started.push(`canvas ${record.pageNumber}`);
      record.renderTask = { cancel: () => (record.cancelled += 1) };
      return new Promise((resolve) =>
        finish.set(`canvas ${record.pageNumber}`, () => {
          const failed = options.fail?.(record) ?? false;
          record.canvasRendered = !failed;
          record.outputScale = failed ? 0 : 2;
          resolve(!failed);
        })
      );
    },
    paintText: (record) => {
      started.push(`text ${record.pageNumber}`);
      return new Promise((resolve) =>
        finish.set(`text ${record.pageNumber}`, () => {
          record.textRendered = true;
          resolve(true);
        })
      );
    },
  });
  const done = async (job: string) => {
    finish.get(job)!();
    // The queue pumps once the paint's promise settles.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };
  return { done, queue, started };
}

test("paints the page on screen first, then outward, two at a time", async () => {
  const pages = records(10);
  const { done, queue, started } = manualQueue();
  for (const page of pages.slice(2, 9)) {
    queue.setNearViewport(page, true);
  }
  queue.setOnScreen(pages[5]!, true);
  queue.pump();
  assert.deepEqual(started, ["canvas 6", "canvas 5"]);
  await done("canvas 6");
  assert.deepEqual(started.at(-1), "canvas 7");
  assert.equal(queue.painting(), 2);
});

test("text waits until every page in the band has a canvas, and runs one at a time", async () => {
  const pages = records(3);
  const { done, queue, started } = manualQueue();
  for (const page of pages) {
    queue.setNearViewport(page, true);
  }
  queue.setOnScreen(pages[0]!, true);
  queue.pump();
  await done("canvas 1");
  await done("canvas 2");
  assert.deepEqual(started, ["canvas 1", "canvas 2", "canvas 3", "text 1"]);
  await done("canvas 3");
  assert.deepEqual(started.slice(4), [], "one text layer at a time");
  await done("text 1");
  assert.deepEqual(started.slice(4), ["text 2"]);
});

test("a page the reader scrolled past has its paint stopped", () => {
  const pages = records(4);
  const { queue } = manualQueue();
  queue.setNearViewport(pages[0]!, true);
  queue.pump();
  queue.setNearViewport(pages[0]!, false);
  assert.equal(pages[0]!.cancelled, 1);
  // A page with nothing in flight has nothing to stop.
  queue.setNearViewport(pages[1]!, false);
  assert.equal(pages[1]!.cancelled, 0);
});

test("a page that keeps failing is left alone until it comes back into the band", async () => {
  const pages = records(1);
  const { done, queue, started } = manualQueue({ fail: () => true });
  queue.setNearViewport(pages[0]!, true);
  queue.pump();
  for (let attempt = 0; attempt < 3; attempt++) {
    await done("canvas 1");
  }
  assert.equal(started.length, 3, "three tries, then it stops: no busy loop on a broken page");
  queue.setNearViewport(pages[0]!, false);
  queue.setNearViewport(pages[0]!, true);
  queue.pump();
  assert.equal(started.length, 4);
});
