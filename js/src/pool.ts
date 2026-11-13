// Pages read and drawn across worker threads, from one call per page. Each thread has its own
// engine and, the first time it's given a page of a document, its own copy of the file; a thread
// starts only when there's work and none is free, so calls made one at a time stay on one thread.
// No special headers: SharedArrayBuffer only saves a copy, where it's allowed.
//
// No call waits for ever on a thread that's gone: a thread reports a failed start, its death fails its
// call, and one that has said nothing by START_TIMEOUT_MS counts as dead. A call that's running can't be
// stopped, only the page budgets end it, or `close()`.

import type {
  PdfAnnotation,
  PdfBitmap,
  PdfBox,
  PdfDestination,
  PdfLink,
  PdfLinkTarget,
  PdfOutlineItem,
  PdfPageInfo,
  PdfPageObjects,
  PdfPageText,
  PdfRegionBitmap,
  PdfRenderOptions,
  PdfTextOptions,
} from "./document.ts";
import { engineModule } from "./engine.ts";
import { PdfError, type PdfErrorCode } from "./errors.ts";
import type { PoolRequest, PoolStart } from "./pool-worker.ts";

export type PdfPoolOptions = {
  /** At most this many threads, up to 64. Default: one less than the machine's cores, up to 8. */
  threads?: number;
  /** As for `createPdfEngine`. A string: it crosses to the threads. */
  assetBase?: string;
  /** As for `createPdfEngine`, on every thread. */
  maxDecodedBytes?: number;
};

export type PdfPoolOpenOptions = { password?: string };

/** A `PdfDocument` whose calls run on the pool's threads, each a promise. */
export interface PdfPoolDocument {
  readonly pageCount: number;
  pageInfo(index: number): Promise<PdfPageInfo>;
  text(index: number, options?: PdfTextOptions): Promise<PdfPageText>;
  objects(index: number): Promise<PdfPageObjects>;
  annotations(index: number): Promise<PdfAnnotation[]>;
  links(index: number): Promise<PdfLink[]>;
  outline(): Promise<PdfOutlineItem[]>;
  openAction(): Promise<PdfLinkTarget>;
  destination(target: string | PdfDestination): Promise<PdfDestination>;
  /** Takes no `signal`: a call that's running can't be stopped. */
  render(index: number, options: PdfRenderOptions & { region: PdfBox }): Promise<PdfRegionBitmap>;
  render(index: number, options: PdfRenderOptions): Promise<PdfBitmap>;
  /** Frees it on every thread, and fails its calls still waiting with `closed`. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface PdfPool {
  open(bytes: Uint8Array | ArrayBuffer, options?: PdfPoolOpenOptions): Promise<PdfPoolDocument>;
  /** Threads started so far, and calls waiting for one. */
  stats(): { threads: number; queued: number };
  /** Stops every thread now: anything unfinished fails with `closed`. */
  close(): void;
  [Symbol.dispose](): void;
}

type Task = {
  request: Omit<PoolRequest, "id" | "open">;
  file: OpenFile;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
};

/**
 * The pool's copy of a file. Shared memory where it's allowed (Node, or a page with COOP and COEP), so that
 * telling each thread about the file doesn't copy it again before the thread copies it into its wasm.
 */
function privateCopy(view: Uint8Array): Uint8Array {
  if (typeof SharedArrayBuffer !== "function") {
    return view.slice();
  }
  const copy = new Uint8Array(new SharedArrayBuffer(view.byteLength));
  copy.set(view);
  return copy as unknown as Uint8Array;
}

type OpenFile = { id: number; bytes: Uint8Array; password: string | undefined; closed: boolean; on: Set<Thread> };

type Thread = {
  worker: { postMessage(message: unknown): void; terminate(): unknown; ref?(): void; unref?(): void };
  running: Task | null;
};

/** Longer than a thread's slowest fetch of its wasm (ASSET_TIMEOUT_MS), and its compile. */
const START_TIMEOUT_MS = 90_000;
const MAX_THREADS = 64;

function defaultThreads(): number {
  const cores = globalThis.process?.getBuiltinModule?.("node:os")?.availableParallelism() ?? navigator.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(8, cores - 1));
}

function failureOf(failure: { name?: string; code?: string; message: string }): Error {
  if (failure.code) {
    return new PdfError(failure.code as PdfErrorCode, failure.message);
  }
  // A bad argument stays what it is on a single thread.
  const type = failure.name === "RangeError" ? RangeError : failure.name === "TypeError" ? TypeError : Error;
  return new type(failure.message);
}

const closedError = () => new PdfError("closed", "this document or pool is closed");

class Pool implements PdfPool {
  #limit: number;
  readonly #ceiling: number;
  readonly #assetBase: string | undefined;
  readonly #maxDecodedBytes: number | undefined;
  readonly #threads: Thread[] = [];
  /** Started and not yet ready. */
  readonly #startingThreads = new Set<Thread>();
  #queue: Task[] = [];
  #nextFile = 0;
  #nextId = 0;
  #closed = false;
  #module: Promise<WebAssembly.Module | undefined> | undefined;

  constructor(limit: number, assetBase: string | undefined, maxDecodedBytes: number | undefined) {
    this.#limit = limit;
    this.#ceiling = limit;
    this.#assetBase = assetBase;
    this.#maxDecodedBytes = maxDecodedBytes;
  }

  #spawn(): void {
    const thread: Thread = { worker: null!, running: null };
    this.#startingThreads.add(thread);
    let dead = false;
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (message: {
      ready?: true;
      result?: unknown;
      failure?: { name?: string; code?: string; message: string };
      startFailed?: boolean;
      opened?: boolean;
    }) => {
      if (this.#closed) {
        void thread.worker.terminate();
        return;
      }
      if (message.startFailed) {
        onDeath(message.failure!.message, failureOf(message.failure!));
        return;
      }
      if (message.ready) {
        clearTimeout(waiting);
        this.#startingThreads.delete(thread);
        this.#threads.push(thread);
        // Idle, a thread doesn't keep a Node process alive; a call under way does.
        thread.worker.unref?.();
      } else {
        const task = thread.running!;
        thread.running = null;
        thread.worker.unref?.();
        // It'll need the file again: this was the call that was to open it.
        if (!message.opened) {
          task.file.on.delete(thread);
        }
        if (message.failure) {
          task.reject(failureOf(message.failure));
        } else {
          task.resolve(message.result);
        }
      }
      this.#pump();
    };
    // In Node a failure is an `error` and then an `exit`.
    const onDeath = (reason: unknown, typed?: Error) => {
      if (dead || this.#closed) {
        return;
      }
      dead = true;
      clearTimeout(waiting);
      void thread.worker?.terminate();
      const failure = typed ?? new PdfError("crash", `a pool thread stopped: ${String(reason)}`, reason);
      if (this.#startingThreads.delete(thread)) {
        // It couldn't start, so another wouldn't either: run on what's left, or fail what's waiting.
        this.#limit = this.#threads.length + this.#startingThreads.size;
        if (this.#limit === 0) {
          // The next call tries again: what stopped it, a missing file say, may be back by then.
          this.#limit = this.#ceiling;
          for (const task of this.#queue.splice(0)) {
            task.reject(failure);
          }
        }
      } else {
        this.#threads.splice(this.#threads.indexOf(thread), 1);
      }
      thread.running?.file.on.delete(thread);
      thread.running?.reject(failure);
      thread.running = null;
      this.#pump();
    };
    waiting = setTimeout(() => onDeath(`it hadn't started after ${START_TIMEOUT_MS} ms`), START_TIMEOUT_MS);
    (waiting as { unref?(): void }).unref?.();
    try {
      const threads = globalThis.process?.getBuiltinModule?.("node:worker_threads");
      if (threads) {
        const worker = new threads.Worker(new URL("./pool-worker.js", import.meta.url), { execArgv: [] });
        worker.on("message", onMessage);
        worker.on("messageerror", onDeath);
        worker.on("error", onDeath);
        worker.on("exit", onDeath);
        thread.worker = worker;
      } else {
        // Not `new URL("…", import.meta.url)`: a bundler would emit the file as it stands for that.
        const here = import.meta.url;
        const worker =
          new URL(here).origin === location.origin
            ? // Written out in full: this is the form bundlers recognise, and they emit the worker for it.
              new Worker(new URL("./pool-worker.js", import.meta.url), { type: "module" })
            : // A worker's script has to be of this page's origin, so from a CDN it's one line that imports the
              // real one, which the CDN has to allow with CORS, as it does the wasm.
              // ponytail: the blob's URL lives as long as the page; one per thread started.
              new Worker(
                URL.createObjectURL(new Blob([`import ${JSON.stringify(new URL("./pool-worker.js", here).href)};`], { type: "text/javascript" })),
                { type: "module" }
              );
        worker.onmessage = ({ data }) => onMessage(data);
        worker.onmessageerror = () => onDeath("a message from it could not be read");
        worker.onerror = (event) => {
          event.preventDefault();
          onDeath(event.message || "its script did not load");
        };
        thread.worker = worker;
      }
      // The wasm is read, hashed and compiled here once, while the thread starts, and the thread gets the module:
      // it would otherwise do all three again, loading node:crypto first in Node. If it can't be had here, the
      // thread tries on its own and reports what's wrong.
      this.#module ??= engineModule(this.#assetBase).catch(() => {
        this.#module = undefined;
        return undefined;
      });
      void this.#module.then((module) => {
        if (dead || this.#closed) {
          return;
        }
        const start: PoolStart = { assetBase: this.#assetBase, maxDecodedBytes: this.#maxDecodedBytes };
        try {
          thread.worker.postMessage(module ? { ...start, module } : start);
        } catch (error) {
          onDeath(error);
        }
      });
    } catch (error) {
      onDeath(error);
    }
  }

  /** Gives each free thread work, the oldest call on a document it has if there is one. */
  #pump(): void {
    for (const thread of this.#threads) {
      if (thread.running || this.#queue.length === 0) {
        continue;
      }
      let at = this.#queue.findIndex((task) => task.file.on.has(thread));
      if (at < 0) {
        // Not a copy of the file for a call that a thread already holding it will take next.
        const free = this.#threads.filter((other) => !other.running);
        at = this.#queue.findIndex((task) => !free.some((other) => task.file.on.has(other)));
      }
      if (at < 0) {
        continue;
      }
      const [task] = this.#queue.splice(at, 1) as [Task];
      thread.running = task;
      thread.worker.ref?.();
      const { file } = task;
      const had = file.on.has(thread);
      const open = had ? {} : { open: { bytes: file.bytes, password: file.password } };
      file.on.add(thread);
      try {
        thread.worker.postMessage({ ...task.request, id: this.#nextId++, ...open });
      } catch (error) {
        // An argument that can't cross. Nothing reached the thread.
        thread.running = null;
        thread.worker.unref?.();
        if (!had) {
          file.on.delete(thread);
        }
        task.reject(error);
        // Nothing will come back from the thread to take the next call.
        this.#pump();
        return;
      }
    }
    const wanted = Math.min(this.#limit - this.#threads.length, this.#queue.length) - this.#startingThreads.size;
    for (let i = 0; i < wanted; i++) {
      this.#spawn();
    }
  }

  #call(file: OpenFile, method: string, args: unknown[]): Promise<unknown> {
    if (file.closed || this.#closed) {
      return Promise.reject(closedError());
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ request: { doc: file.id, method, args }, file, resolve, reject });
      this.#pump();
    });
  }

  async open(input: Uint8Array | ArrayBuffer, options: PdfPoolOpenOptions = {}): Promise<PdfPoolDocument> {
    const view = ArrayBuffer.isView(input) ? input : new Uint8Array(input);
    const file: OpenFile = {
      id: this.#nextFile++,
      bytes: privateCopy(view),
      password: options.password,
      closed: false,
      on: new Set(),
    };
    const call = (method: string, ...args: unknown[]) => this.#call(file, method, args);
    const pageCount = (await call("pageCount")) as number;
    const close = async () => {
      if (file.closed) {
        return;
      }
      file.closed = true;
      this.#queue = this.#queue.filter((task) => {
        if (task.file === file) {
          task.reject(closedError());
        }
        return task.file !== file;
      });
      // Each thread frees it when it gets there, past any call of it under way, which still answers.
      for (const thread of file.on) {
        thread.worker.postMessage({ id: this.#nextId++, doc: file.id, method: "close", args: [] });
      }
      file.on.clear();
    };
    return {
      pageCount,
      pageInfo: (index) => call("pageInfo", index) as Promise<PdfPageInfo>,
      text: (index, textOptions) =>
        call("text", index, textOptions?.boxes === undefined ? undefined : { boxes: textOptions.boxes }) as Promise<PdfPageText>,
      objects: (index) => call("objects", index) as Promise<PdfPageObjects>,
      annotations: (index) => call("annotations", index) as Promise<PdfAnnotation[]>,
      links: (index) => call("links", index) as Promise<PdfLink[]>,
      outline: () => call("outline") as Promise<PdfOutlineItem[]>,
      openAction: () => call("openAction") as Promise<PdfLinkTarget>,
      destination: (target) => call("destination", target) as Promise<PdfDestination>,
      render: ((index: number, renderOptions: PdfRenderOptions) => {
        if ((renderOptions as { signal?: unknown } | undefined)?.signal) {
          return Promise.reject(
            new TypeError("a pool's render takes no signal: a call that's running can't be stopped. pool.close() ends all of them.")
          );
        }
        const { width, maxHeight, region } = renderOptions ?? {};
        return call("render", index, region === undefined ? { width, maxHeight } : { width, maxHeight, region }) as Promise<PdfBitmap>;
      }) as PdfPoolDocument["render"],
      close,
      [Symbol.asyncDispose]: close,
    };
  }

  stats() {
    return { threads: this.#threads.length, queued: this.#queue.length };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const thread of [...this.#threads, ...this.#startingThreads]) {
      thread.running?.reject(closedError());
      void thread.worker?.terminate();
    }
    for (const task of this.#queue.splice(0)) {
      task.reject(closedError());
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

export function startPool(options: PdfPoolOptions): PdfPool {
  const threads = options.threads ?? defaultThreads();
  if (!(Number.isInteger(threads) && threads >= 1 && threads <= MAX_THREADS)) {
    throw new RangeError(`threads must be a whole number from 1 to ${MAX_THREADS}, not ${threads}`);
  }
  if (!globalThis.process?.getBuiltinModule?.("node:worker_threads") && typeof Worker === "undefined") {
    throw new PdfError("wrong-thread", "a pool needs worker threads, which this thread can't start");
  }
  // A thread's location isn't this one's, so a relative URL has to be resolved here.
  const assetBase =
    options.assetBase !== undefined && typeof location !== "undefined"
      ? new URL(options.assetBase, location.href).href
      : options.assetBase;
  const maxDecodedBytes = options.maxDecodedBytes;
  if (maxDecodedBytes !== undefined && !(typeof maxDecodedBytes === "number" && maxDecodedBytes >= 0)) {
    throw new RangeError("maxDecodedBytes must be a number of bytes, 0 or more");
  }
  return new Pool(threads, assetBase, maxDecodedBytes);
}
