// Which page to paint next. The engine draws one page at a time per worker, so starting every page
// in the prefetch band together finishes none of them sooner: the page the reader is looking at
// shares the time with all of them and stays blank. Two at once keeps the worker busy while the main
// thread puts the last one on screen.

const MAX_CONCURRENT_PAINTS = 2;
/** A page that failed this many times in a row waits until it leaves the band and comes back. */
const MAX_FAILURES = 3;

export type PaintQueueRecord = {
  canvasRendered: boolean;
  outputScale: number;
  pageNumber: number;
  renderTask: { cancel(): void } | null;
  textRendered: boolean;
  textTask: Promise<void> | null;
  failures: number;
};

type PaintKind = "canvas" | "text";

/**
 * Paints the pages inside the prefetch band, a few at a time: canvases before any text layer, nearest
 * the screen first. A text layer draws nothing the reader sees, so it waits until every page in the
 * band has a canvas, and only one runs at a time so a page scrolled into view never waits behind two.
 */
export function createPaintQueue<Record extends PaintQueueRecord>(params: {
  isStopped: () => boolean;
  /** Each paint reports its own failure; it resolves false when it failed. */
  paintCanvas: (record: Record) => Promise<boolean>;
  paintText: (record: Record) => Promise<boolean>;
}) {
  const nearRecords = new Set<Record>();
  const visibleRecords = new Set<Record>();
  const painting = new Map<Record, PaintKind>();

  // Pages stack in page order, so how far a page is from the screen is how many pages lie between
  // it and the nearest one on screen: no layout read.
  const distanceFromScreen = (record: Record): number => {
    if (visibleRecords.size === 0) {
      return record.pageNumber;
    }
    let distance = Number.POSITIVE_INFINITY;
    for (const visible of visibleRecords) {
      distance = Math.min(distance, Math.abs(visible.pageNumber - record.pageNumber));
    }
    return distance;
  };

  const nextJob = (): { kind: PaintKind; record: Record } | null => {
    const textPainting = [...painting.values()].includes("text");
    let canvasJob: Record | null = null;
    let canvasDistance = Number.POSITIVE_INFINITY;
    let textJob: Record | null = null;
    let textDistance = Number.POSITIVE_INFINITY;
    for (const record of nearRecords) {
      if (painting.has(record) || record.failures >= MAX_FAILURES) {
        continue;
      }
      const needsCanvas = !record.canvasRendered;
      const needsText = !textPainting && record.outputScale > 0 && !record.textRendered && !record.textTask;
      if (!(needsCanvas || needsText)) {
        continue;
      }
      const distance = distanceFromScreen(record);
      if (needsCanvas && distance < canvasDistance) {
        canvasJob = record;
        canvasDistance = distance;
      } else if (!needsCanvas && needsText && distance < textDistance) {
        textJob = record;
        textDistance = distance;
      }
    }
    if (canvasJob) {
      return { kind: "canvas", record: canvasJob };
    }
    return textJob ? { kind: "text", record: textJob } : null;
  };

  const pump = () => {
    while (!params.isStopped() && painting.size < MAX_CONCURRENT_PAINTS) {
      const job = nextJob();
      if (!job) {
        return;
      }
      const { kind, record } = job;
      painting.set(record, kind);
      const work = kind === "canvas" ? params.paintCanvas(record) : params.paintText(record);
      work
        .then(
          (ok) => {
            record.failures = ok ? 0 : record.failures + 1;
          },
          () => {
            record.failures += 1;
          }
        )
        .finally(() => {
          painting.delete(record);
          pump();
        });
    }
  };

  return {
    /** Records whether `record` is inside the prefetch band. Call `pump` after. */
    setNearViewport(record: Record, near: boolean) {
      if (near) {
        if (!nearRecords.has(record)) {
          // Back in the band: a page that kept failing gets another try.
          record.failures = 0;
        }
        nearRecords.add(record);
        return;
      }
      nearRecords.delete(record);
      if (painting.get(record) === "canvas") {
        // A fling passes dozens of pages through the band. Finishing a page the reader already left
        // only delays the one they stop on.
        record.renderTask?.cancel();
      }
    },
    /** Records whether `record` is on screen. Call `pump` after. */
    setOnScreen(record: Record, onScreen: boolean) {
      if (onScreen) {
        visibleRecords.add(record);
      } else {
        visibleRecords.delete(record);
      }
    },
    pump,
    painting: () => painting.size,
  };
}
