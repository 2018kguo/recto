// The page's side of a viewer's workers: open documents, page sizes, text, search and bitmaps as
// promises, with the workers' failures handled here so a viewer never has to.
//
// Workers: one per open document, up to `maxWorkers`. A ranged read blocks its worker for a network
// round trip, so a document on a slow or unanswering server must only ever block itself. Past the
// cap, a new document shares the least busy worker that holds only files read whole, and is itself
// only read whole there: a file too large for that gets a worker of its own, past the cap. Each
// worker holds its own engine instance plus each of its open files.
//
// Failures: the engine ends a document at its first failed read, and a crashed instance takes its
// documents with it. Each document here remembers that and reopens on the next call, so a viewer that
// saw one 403 or one worker crash recovers once the server or the worker does. Only a failure from the
// document's current copy counts: replacing a copy stops its worker, which fails the old copy's other
// calls, and counting those would reopen again in a loop. Reopens back off, so a server that stays
// down costs one request per backoff step, not one per paint.
//
// Documents opened by URL are kept in a small cache after their last reader lets go, so opening the
// same file again (close, open again; a thumbnail and a viewer) is free.

import type { PdfBox, PdfDestination } from "../document.ts";
import type {
  ViewerDestination,
  ViewerFailure,
  ViewerFindHit,
  ViewerOpenTiming,
  ViewerOutlineItem,
  ViewerPageInfo,
  ViewerRequest,
  ViewerResponse,
  ViewerResult,
  ViewerSource,
} from "./protocol.ts";

export const DEFAULT_MAX_WORKERS = 4;
/**
 * A cancelled render that has not stopped by then is blocked on a read (a cancel lands between render
 * slices, a few ms apart), so its worker is stopped and its documents reopen elsewhere.
 */
const STUCK_CANCEL_MS = 3000;
/** The wait before reopening after a failure, doubling per failure in a row. */
const REOPEN_BACKOFF_MS = 250;
const REOPEN_BACKOFF_MAX_MS = 10_000;
/** Documents opened by URL kept open with no reader, most recent first. */
const IDLE_DOCUMENTS = 3;

/** What the client needs from a worker; a test can hand it an in-process one. */
export type WorkerPort = {
  addEventListener(type: "error" | "message" | "messageerror", listener: (event: Event) => void): void;
  postMessage(message: ViewerRequest): void;
  terminate(): void;
};

/**
 * A failed call. `code` is the engine's (`fetch-failed`, `crash`, `invalid-file`, ...). A render that
 * was cancelled, or a call on a document its owner closed, is an `AbortError`: stopped, not failed.
 */
export type ViewerError = Error & { code: string };

export function viewerError(failure: ViewerFailure, stopped = failure.code === "aborted"): ViewerError {
  const error = new Error(failure.message);
  error.name = stopped ? "AbortError" : "PdfError";
  return Object.assign(error, { code: failure.code });
}

/** Whether a failure is a stop (a cancelled render, a closed document) rather than an error to report. */
export function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

// A failed read or a lost instance ends a document for good; these codes mean "open it again", not
// "this file is bad".
const REOPEN_CODES = new Set(["closed", "crash", "fetch-failed", "timeout"]);

function codeOf(cause: unknown): string | null {
  return typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : null;
}

export type ViewerBitmap = ViewerResult["render"];

export type RenderTask = { promise: Promise<ViewerBitmap>; cancel(): void };

/** An open document. Pages are numbered from 1. */
export interface ViewerDocument {
  readonly pageCount: number;
  /**
   * Whether it is only ever read by range: false for a file downloaded whole, even one whose first page
   * was read by range ahead of the rest.
   */
  readonly ranged: boolean;
  /** Where the open's time went. */
  readonly timing: ViewerOpenTiming;
  pageInfo(page: number): Promise<ViewerPageInfo>;
  /** The page drawn `width` pixels wide, or only `region` (points, y down) of it at that scale. */
  render(page: number, options: { width: number; region?: PdfBox }): RenderTask;
  text(page: number): Promise<ViewerResult["text"]>;
  find(page: number, query: string, options?: { caseSensitive?: boolean }): Promise<ViewerFindHit[]>;
  /** The document's bookmarks; empty if it has none. */
  outline(): Promise<ViewerOutlineItem[]>;
  /**
   * A named destination of this document, or another file's destination for a page of this one (a
   * `remote` target's), placed on its page; null if it goes nowhere here.
   */
  destination(target: string | PdfDestination): Promise<ViewerDestination | null>;
}

export type DocumentLease = {
  promise: Promise<ViewerDocument>;
  /** Lets go of the document: closed now if read from bytes, else kept in the cache a while. */
  release(): void;
};

export type ViewerEngineOptions = {
  /** Starts a worker. Default: the package's own worker script. */
  createWorker?: () => WorkerPort;
  /** Where the engine's wasm lives, if not beside the package's script (as `createPdfEngine`'s). */
  assetBase?: string;
  /** At most this many workers, except for a file read by range past it. Default 4. */
  maxWorkers?: number;
  /**
   * Files up to this size are downloaded whole, the rest of the file in the background after the first page
   * is drawn; larger ones only by range. Default 8 MiB.
   */
  wholeFileMaxBytes?: number;
  now?: () => number;
  reopenBackoffMs?: number;
  stuckCancelMs?: number;
};

export interface ViewerEngine {
  /** Opens a document, or takes one from the cache. */
  open(source: ViewerSource): DocumentLease;
  /** Opens a document and reads its first page's size, ahead of a viewer that will want it. Never fails. */
  prefetch(url: string): Promise<void>;
  /** Workers running now. */
  liveWorkers(): number;
  /** Closes every document and stops every worker. */
  close(): void;
}

type Pending = { reject: (cause: unknown) => void; resolve: (value: unknown) => void };

type WorkerHost = {
  dead: boolean;
  docs: Set<number>;
  lastUsed: number;
  pending: Map<number, Pending>;
  port: WorkerPort;
  // Holds only files read whole, so another document can join without waiting behind a blocking
  // read. Unknown (false) until its first open answers.
  shareable: boolean;
  /** Settles when its first document's open does: until then, whether it can be shared is unknown. */
  firstOpen: Promise<unknown> | null;
  settleFirstOpen: () => void;
};

type OpenDocument = {
  destroyed: boolean;
  docId: number;
  failures: number;
  host: WorkerHost | null;
  // Set after a failure that ended the document in its worker.
  needsReopen: boolean;
  retryAt: number;
  opening: Promise<ViewerResult["open"]> | null;
  /** Waiting for a worker to be free to share. */
  choosing: Promise<ViewerResult["open"]> | null;
  source: ViewerSource;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Call = DistributiveOmit<Exclude<ViewerRequest, { op: "cancel" | "close" }>, "id">;
type DocumentOp = "pageInfo" | "render" | "text" | "find" | "outline" | "destination";

function defaultWorker(): WorkerPort {
  if (typeof Worker === "undefined") {
    throw viewerError({ code: "wrong-thread", message: "a viewer needs Web Workers, which this thread can't start" });
  }
  const here = import.meta.url;
  return new URL(here).origin === location.origin
    ? // Written out in full: the form bundlers recognise, and emit the worker for. The worker and the
      // engine it runs are one file (scripts/bundle-viewer.mjs), fetched in one round trip.
      new Worker(new URL("./worker.js", import.meta.url), { name: "recto-viewer", type: "module" })
    : // A worker's script has to be of the page's origin, so from a CDN it's one line that imports the
      // real one, which the CDN has to allow with CORS, as it does the wasm.
      new Worker(
        URL.createObjectURL(new Blob([`import ${JSON.stringify(new URL("./worker.js", here).href)};`], { type: "text/javascript" })),
        { name: "recto-viewer", type: "module" }
      );
}

function cacheKey(source: ViewerSource): string | null {
  return source.kind === "url" ? `${source.credentials ?? ""} ${source.url}` : null;
}

export function createViewerEngine(options: ViewerEngineOptions = {}): ViewerEngine {
  const createWorker = options.createWorker ?? defaultWorker;
  const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
  const reopenBackoffMs = options.reopenBackoffMs ?? REOPEN_BACKOFF_MS;
  const stuckCancelMs = options.stuckCancelMs ?? STUCK_CANCEL_MS;
  const now = options.now ?? (() => performance.now());
  const hosts: WorkerHost[] = [];
  let nextId = 1;
  let nextDocId = 1;

  const stopHost = (host: WorkerHost, message: string) => {
    if (host.dead) {
      return;
    }
    host.dead = true;
    host.settleFirstOpen();
    host.port.terminate();
    hosts.splice(hosts.indexOf(host), 1);
    const failure = viewerError({ code: "crash", message });
    for (const waiter of host.pending.values()) {
      waiter.reject(failure);
    }
    host.pending.clear();
  };

  const startHost = (): WorkerHost => {
    const host: WorkerHost = { dead: false, docs: new Set(), lastUsed: now(), pending: new Map(), port: createWorker(), shareable: false, firstOpen: null, settleFirstOpen: () => {} };
    // Set now, not when its open is sent: opens in the same tick must see it.
    host.firstOpen = new Promise<void>((resolve) => {
      host.settleFirstOpen = () => {
        host.firstOpen = null;
        resolve();
      };
    });
    host.port.addEventListener("message", (event) => {
      const data = (event as MessageEvent<ViewerResponse>).data;
      const waiter = host.pending.get(data?.id);
      if (!waiter) {
        return;
      }
      host.pending.delete(data.id);
      if (data.ok) {
        waiter.resolve(data.value);
      } else {
        waiter.reject(viewerError(data.error));
      }
    });
    host.port.addEventListener("error", (event) => {
      event.preventDefault();
      const message = "message" in event && typeof event.message === "string" ? event.message : "";
      stopHost(host, message || "the PDF worker stopped");
    });
    host.port.addEventListener("messageerror", () => {
      stopHost(host, "the PDF worker sent a message that could not be read");
    });
    hosts.push(host);
    return host;
  };

  // A fresh worker per document while under the cap; past it, the shareable worker with the fewest
  // documents, least recently used first, for a file read whole only. While workers at the cap are
  // still opening their first file, wait to learn whether they can be shared: a burst of opens (a page
  // of thumbnails) would otherwise start a worker each. None shareable: a fresh one, past the cap.
  const hostForNewDocument = async (): Promise<{ host: WorkerHost; wholeOnly: boolean }> => {
    for (;;) {
      if (hosts.length < maxWorkers) {
        return { host: startHost(), wholeOnly: false };
      }
      const [quietest] = hosts.filter((host) => host.shareable).sort((a, b) => a.docs.size - b.docs.size || a.lastUsed - b.lastUsed);
      if (quietest) {
        return { host: quietest, wholeOnly: true };
      }
      const opening = hosts.flatMap((host) => (host.firstOpen ? [host.firstOpen] : []));
      if (opening.length === 0) {
        return { host: startHost(), wholeOnly: false };
      }
      await Promise.race(opening);
    }
  };

  const callHost = <Op extends keyof ViewerResult>(
    host: WorkerHost,
    request: Extract<Call, { op: Op }>,
    onId?: (id: number) => void
  ): Promise<ViewerResult[Op]> => {
    if (host.dead) {
      return Promise.reject(viewerError({ code: "crash", message: "the PDF worker stopped" }));
    }
    const id = nextId++;
    onId?.(id);
    host.lastUsed = now();
    return new Promise((resolve, reject) => {
      host.pending.set(id, { reject, resolve: resolve as (value: unknown) => void });
      host.port.postMessage({ ...request, id } as ViewerRequest);
    });
  };

  const detach = (doc: OpenDocument) => {
    const host = doc.host;
    doc.host = null;
    if (!host || host.dead) {
      return;
    }
    host.port.postMessage({ docId: doc.docId, op: "close" });
    host.docs.delete(doc.docId);
    // Nothing else lives there: stop it, which also ends a read stuck on a server that never answers.
    if (host.docs.size === 0) {
      stopHost(host, "closed");
    }
  };

  const markFailed = (doc: OpenDocument) => {
    doc.needsReopen = true;
    doc.failures += 1;
    doc.retryAt = now() + Math.min(REOPEN_BACKOFF_MAX_MS, reopenBackoffMs * 2 ** (doc.failures - 1));
  };

  const attach = (doc: OpenDocument, { host, wholeOnly }: { host: WorkerHost; wholeOnly: boolean }): Promise<ViewerResult["open"]> => {
    const docId = nextDocId++;
    doc.docId = docId;
    doc.host = host;
    doc.needsReopen = false;
    host.docs.add(docId);
    const opening = callHost(host, {
      docId,
      op: "open",
      // Bytes are copied, never moved: a reopen needs them again.
      source: doc.source,
      wholeOnly,
      ...(options.assetBase === undefined ? {} : { assetBase: options.assetBase }),
      ...(options.wholeFileMaxBytes === undefined ? {} : { wholeFileMaxBytes: options.wholeFileMaxBytes }),
    }).then(
      (opened) => {
        if (!wholeOnly) {
          host.shareable = !opened.ranged;
        }
        return opened;
      },
      (cause: unknown) => {
        const current = doc.host === host && doc.docId === docId;
        if (current && !doc.destroyed) {
          if (codeOf(cause) === "needs-own-worker") {
            detach(doc);
            return attach(doc, { host: startHost(), wholeOnly: false });
          }
          markFailed(doc);
        }
        throw cause;
      }
    );
    doc.opening = opening;
    if (!wholeOnly) {
      opening.then(host.settleFirstOpen, host.settleFirstOpen);
    }
    return opening;
  };

  const closedError = () => viewerError({ code: "closed", message: "the document was closed" }, true);

  const ensureOpen = (doc: OpenDocument): Promise<ViewerResult["open"]> => {
    if (doc.destroyed) {
      return Promise.reject(closedError());
    }
    if (doc.host && !doc.host.dead && doc.opening && !doc.needsReopen) {
      return doc.opening;
    }
    if (doc.choosing) {
      return doc.choosing;
    }
    detach(doc);
    const choosing = hostForNewDocument().then((pick) => {
      if (doc.destroyed) {
        throw closedError();
      }
      return attach(doc, pick);
    });
    doc.choosing = choosing;
    const clear = () => {
      if (doc.choosing === choosing) {
        doc.choosing = null;
      }
    };
    choosing.then(clear, clear);
    return choosing;
  };

  /**
   * A call on an open document. A failure from the document's current copy that ended it in its
   * worker (a failed read, a lost instance) fails this call and reopens the document on a later one,
   * after the backoff.
   */
  const callDocument = async <Op extends DocumentOp>(
    doc: OpenDocument,
    request: (docId: number) => Extract<Call, { op: Op }>,
    onId?: (id: number, host: WorkerHost) => void
  ): Promise<ViewerResult[Op]> => {
    if (doc.needsReopen && doc.retryAt > now()) {
      await new Promise((resolve) => setTimeout(resolve, doc.retryAt - now()));
    }
    let copy: { docId: number; host: WorkerHost } | null = null;
    try {
      await ensureOpen(doc);
      const { docId, host } = doc;
      if (!host) {
        throw closedError();
      }
      copy = { docId, host };
      const result = await callHost(host, request(docId), (id) => onId?.(id, host));
      // An open alone proves little (a ranged one reads only the head); a call that read the file does.
      doc.failures = 0;
      return result;
    } catch (cause) {
      const code = codeOf(cause);
      if (doc.destroyed) {
        throw closedError();
      }
      if (code !== null && REOPEN_CODES.has(code)) {
        if (copy && doc.host === copy.host && doc.docId === copy.docId && !doc.needsReopen) {
          markFailed(doc);
        }
        if (code === "closed") {
          // The worker lost a document its owner never closed: a failure.
          throw viewerError({ code: "crash", message: "the document was lost" });
        }
      }
      throw cause;
    }
  };

  const documentHandle = (doc: OpenDocument, opened: ViewerResult["open"]): ViewerDocument => {
    const infos = new Map<number, Promise<ViewerPageInfo>>([[1, Promise.resolve(opened.firstPage)]]);
    const checkPage = (page: number) => {
      if (!(Number.isInteger(page) && page >= 1 && page <= opened.pageCount)) {
        throw new RangeError(`page ${page} is not in 1..${opened.pageCount}`);
      }
    };
    let outline: Promise<ViewerOutlineItem[]> | null = null;
    return {
      pageCount: opened.pageCount,
      ranged: opened.ranged,
      timing: opened.timing,
      outline() {
        const asked = (outline ??= callDocument(doc, (docId) => ({ docId, op: "outline" })));
        asked.catch(() => {
          if (outline === asked) {
            outline = null;
          }
        });
        return asked;
      },
      destination(target) {
        return callDocument(doc, (docId) => ({ docId, op: "destination", target }));
      },
      pageInfo(page) {
        checkPage(page);
        let info = infos.get(page);
        if (!info) {
          info = callDocument(doc, (docId) => ({ docId, op: "pageInfo", page }));
          infos.set(page, info);
          info.catch(() => infos.delete(page));
        }
        return info;
      },
      text(page) {
        checkPage(page);
        return callDocument(doc, (docId) => ({ docId, op: "text", page }));
      },
      find(page, query, { caseSensitive = false } = {}) {
        checkPage(page);
        return callDocument(doc, (docId) => ({ caseSensitive, docId, op: "find", page, query }));
      },
      render(page, { width, region }) {
        checkPage(page);
        let started: { host: WorkerHost; id: number } | null = null;
        let cancelled = false;
        let settled = false;
        let stuckTimer: ReturnType<typeof setTimeout> | null = null;
        const stopped = () => viewerError({ code: "aborted", message: "the render was cancelled" });
        const promise = callDocument(
          doc,
          (docId) => {
            // Cancelled while the document was opening: never sent.
            if (cancelled) {
              throw stopped();
            }
            return { docId, op: "render", page, width, ...(region ? { region } : {}) };
          },
          (id, host) => {
            started = { host, id };
          }
        ).then(
          (bitmap) => {
            if (cancelled) {
              throw stopped();
            }
            return bitmap;
          },
          (cause: unknown) => {
            // However it ended (its worker stopped for being stuck, say), a cancelled render is a stop.
            throw cancelled ? stopped() : cause;
          }
        );
        promise
          .finally(() => {
            settled = true;
            if (stuckTimer) {
              clearTimeout(stuckTimer);
            }
          })
          .catch(() => {
            // The caller handles the render's own failure.
          });
        return {
          promise,
          cancel() {
            cancelled = true;
            const run: { host: WorkerHost; id: number } | null = started;
            // A settled render has nothing to stop, and the worker would keep its id waiting.
            if (!run || settled || run.host.dead) {
              return;
            }
            run.host.port.postMessage({ id: run.id, op: "cancel" });
            const { host } = run;
            stuckTimer = setTimeout(() => {
              if (!settled) {
                stopHost(host, "a cancelled render was stuck on a read");
              }
            }, stuckCancelMs);
          },
        };
      },
    };
  };

  type Entry = { doc: OpenDocument; promise: Promise<ViewerDocument>; readers: Set<symbol>; key: string | null };
  const cache = new Map<string, Entry>();

  const destroy = (entry: Entry) => {
    entry.doc.destroyed = true;
    detach(entry.doc);
  };

  const trim = () => {
    let idle = 0;
    for (const [key, entry] of [...cache].reverse()) {
      if (entry.readers.size > 0) {
        continue;
      }
      // A reader still holding a document never loses it; idle ones past the budget go, oldest first.
      idle += 1;
      if (idle > IDLE_DOCUMENTS) {
        cache.delete(key);
        destroy(entry);
      }
    }
  };

  const start = (source: ViewerSource, key: string | null): Entry => {
    const resolved: ViewerSource =
      source.kind === "url"
        ? // The worker resolves URLs against its own script: hand it an absolute one.
          { ...source, url: new URL(source.url, globalThis.location?.href).href }
        : { kind: "bytes", bytes: source.bytes.slice(0) };
    const doc: OpenDocument = {
      destroyed: false,
      docId: 0,
      failures: 0,
      host: null,
      needsReopen: false,
      opening: null,
      choosing: null,
      retryAt: 0,
      source: resolved,
    };
    const promise = ensureOpen(doc).then((opened) => documentHandle(doc, opened));
    const entry: Entry = { doc, promise, readers: new Set(), key };
    promise.catch(() => {
      if (key !== null && cache.get(key) === entry) {
        cache.delete(key);
      }
      destroy(entry);
    });
    return entry;
  };

  const engine: ViewerEngine = {
    open(source) {
      const key = cacheKey(source.kind === "url" ? { ...source, url: new URL(source.url, globalThis.location?.href).href } : source);
      let entry = key === null ? undefined : cache.get(key);
      if (!entry) {
        entry = start(source, key);
        if (key !== null) {
          cache.set(key, entry);
        }
      }
      const held = entry;
      const reader = Symbol("reader");
      held.readers.add(reader);
      if (key !== null) {
        // Most recently acquired last.
        cache.delete(key);
        cache.set(key, held);
        trim();
      }
      return {
        promise: held.promise,
        release() {
          if (!held.readers.delete(reader)) {
            return;
          }
          if (held.key === null) {
            destroy(held);
          } else {
            trim();
          }
        },
      };
    },
    async prefetch(url) {
      const lease = engine.open({ kind: "url", url });
      try {
        await (await lease.promise).pageInfo(1);
      } catch {
        // Speculative: a viewer that opens it reports and retries.
      } finally {
        lease.release();
      }
    },
    liveWorkers: () => hosts.length,
    close() {
      for (const entry of cache.values()) {
        destroy(entry);
      }
      cache.clear();
      for (const host of [...hosts]) {
        stopHost(host, "closed");
      }
    },
  };
  return engine;
}

let shared: ViewerEngine | null = null;

/** The engine viewers share unless given their own: its workers and its cache. */
export function sharedViewerEngine(): ViewerEngine {
  shared ??= createViewerEngine();
  return shared;
}
