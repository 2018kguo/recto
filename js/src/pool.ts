// Pages read and drawn across worker threads, from one call per page. Each thread has its own
// engine and, the first time it's given a page of a document, its own copy of the file; a thread
// starts only when there's work and none is free, so calls made one at a time stay on one thread.
// No SharedArrayBuffer and so no special headers.

import type {
  PdfAnnotation,
  PdfBitmap,
  PdfOutlineItem,
  PdfPageInfo,
  PdfPageObjects,
  PdfPageText,
  PdfRenderOptions,
} from "./document.ts";
import { PdfError, type PdfErrorCode } from "./errors.ts";
import type { PoolRequest, PoolStart } from "./pool-worker.ts";

export type PdfPoolOptions = {
  /** At most this many threads. Default: one less than the machine's cores, up to 8. */
  threads?: number;
  /** As for `createPdfEngine`. A string: it crosses to the threads. */
  assetBase?: string;
};

export type PdfPoolOpenOptions = { password?: string };

/** A `PdfDocument` whose calls run on the pool's threads, each a promise. */
export interface PdfPoolDocument {
  readonly pageCount: number;
  pageInfo(index: number): Promise<PdfPageInfo>;
  text(index: number): Promise<PdfPageText>;
  objects(index: number): Promise<PdfPageObjects>;
  annotations(index: number): Promise<PdfAnnotation[]>;
  outline(): Promise<PdfOutlineItem[]>;
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
  readonly #assetBase: string | undefined;
  readonly #threads: Thread[] = [];
  #starting = 0;
  #queue: Task[] = [];
  #nextFile = 0;
  #nextId = 0;
  #closed = false;

  constructor(limit: number, assetBase: string | undefined) {
    this.#limit = limit;
    this.#assetBase = assetBase;
  }

  #spawn(): void {
    this.#starting += 1;
    const thread: Thread = { worker: null!, running: null };
    let ready = false;
    let dead = false;
    const onMessage = (message: { ready?: true; result?: unknown; failure?: { message: string } }) => {
      if (this.#closed) {
        void thread.worker.terminate();
        return;
      }
      if (message.ready) {
        ready = true;
        this.#starting -= 1;
        this.#threads.push(thread);
        // Idle, a thread doesn't keep a Node process alive; a call under way does.
        thread.worker.unref?.();
      } else {
        const task = thread.running!;
        thread.running = null;
        thread.worker.unref?.();
        if (message.failure) {
          task.reject(failureOf(message.failure));
        } else {
          task.resolve(message.result);
        }
      }
      this.#pump();
    };
    // In Node a failure is an `error` and then an `exit`.
    const onDeath = (reason: unknown) => {
      if (dead || this.#closed) {
        return;
      }
      dead = true;
      const failure = new PdfError("crash", `a pool thread stopped: ${String(reason)}`, reason);
      if (ready) {
        this.#threads.splice(this.#threads.indexOf(thread), 1);
      } else {
        // It couldn't start, so another wouldn't either: run on what's left, or fail what's waiting.
        this.#starting -= 1;
        this.#limit = this.#threads.length + this.#starting;
        if (this.#limit === 0) {
          this.#limit = 1;
          for (const task of this.#queue.splice(0)) {
            task.reject(failure);
          }
        }
      }
      thread.running?.file.on.delete(thread);
      thread.running?.reject(failure);
      thread.running = null;
      this.#pump();
    };
    const threads = globalThis.process?.getBuiltinModule?.("node:worker_threads");
    if (threads) {
      const worker = new threads.Worker(new URL("./pool-worker.js", import.meta.url), { execArgv: [] });
      worker.on("message", onMessage);
      worker.on("error", onDeath);
      worker.on("exit", onDeath);
      thread.worker = worker;
    } else {
      // Written out in full: this is the form bundlers recognise, and they emit the worker for it.
      const worker = new Worker(new URL("./pool-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => onMessage(data);
      worker.onerror = (event) => onDeath(event.message);
      thread.worker = worker;
    }
    const start: PoolStart = { assetBase: this.#assetBase };
    thread.worker.postMessage(start);
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
      const open = file.on.has(thread) ? {} : { open: { bytes: file.bytes, password: file.password } };
      file.on.add(thread);
      thread.worker.postMessage({ ...task.request, id: this.#nextId++, ...open });
    }
    const wanted = Math.min(this.#limit - this.#threads.length, this.#queue.length) - this.#starting;
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
      text: (index) => call("text", index) as Promise<PdfPageText>,
      objects: (index) => call("objects", index) as Promise<PdfPageObjects>,
      annotations: (index) => call("annotations", index) as Promise<PdfAnnotation[]>,
      outline: () => call("outline") as Promise<PdfOutlineItem[]>,
      render: (index, renderOptions) => call("render", index, renderOptions) as Promise<PdfBitmap>,
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
    for (const thread of this.#threads) {
      thread.running?.reject(closedError());
      void thread.worker.terminate();
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
  if (!(Number.isInteger(threads) && threads >= 1)) {
    throw new RangeError(`threads must be a whole number from 1, not ${threads}`);
  }
  if (!globalThis.process?.getBuiltinModule?.("node:worker_threads") && typeof Worker === "undefined") {
    throw new PdfError("wrong-thread", "a pool needs worker threads, which this thread can't start");
  }
  // A thread's location isn't this one's, so a relative URL has to be resolved here.
  const assetBase =
    options.assetBase !== undefined && typeof location !== "undefined"
      ? new URL(options.assetBase, location.href).href
      : options.assetBase;
  return new Pool(threads, assetBase);
}
