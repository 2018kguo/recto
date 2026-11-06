// Ranged open: the engine parses a buffer of the file's whole length, and asks for each
// chunk the first time the parser reads it. The engine's calls are synchronous, so a fetch
// has to finish before it returns: in Node it runs on a small fetcher thread while this
// thread waits on a SharedArrayBuffer (Atomics.wait), and in a Web Worker it is a synchronous
// XMLHttpRequest. The engine therefore parses the document once and sees exactly the bytes
// a whole-file open sees: no reopen, no retry, no zero-filled reads on the success path.
//
// The thread that reads a ranged document blocks while a fetch is in flight (bounded by
// `timeoutMs`), so run it on a worker thread of its own, never on a server's main loop.
//
// Fetched bytes are kept as fixed-size chunks indexed by chunk number, so a read costs
// O(chunks it spans), whatever the number of fetches so far. The first fetch reads the head
// (and learns the size); a file it does not cover gets its tail next, since an ordinary
// file's cross-reference table is at its end. A miss that continues the previous fetch (a
// long xref table or page run read front to back) doubles the read-ahead, so a sequential
// scan of n chunks costs O(log n) round trips.

import type { MessagePort } from "node:worker_threads";

import { PdfError } from "./errors.ts";
import type { PdfDocument } from "./document.ts";

/**
 * Where a ranged document's bytes come from: an HTTP(S) URL, or bytes in memory (copied, so
 * the caller may reuse the buffer).
 */
export type PdfRangeSource = string | URL | Uint8Array;

export type PdfRangedOpenOptions = {
  password?: string;
  /** Smallest fetch and the cache's unit, above 0. Default 64 KiB. */
  chunkBytes?: number;
  /** Fail (code "too-large") rather than fetch more than this in total. Default 64 MiB. */
  maxBytes?: number;
  /**
   * Checked before the open and before every fetch. The thread is blocked during a fetch, so
   * an abort cannot interrupt one; `timeoutMs` bounds that.
   */
  signal?: AbortSignal;
  /** How long one fetch round may block the thread (code "timeout"). Default 30 s. */
  timeoutMs?: number;
};

export type PdfRangedStats = {
  /** Bytes received from the source, across every request. */
  bytesFetched: number;
  requests: number;
  /** Fetch rounds (round trips); a round's requests run in parallel. */
  rounds: number;
  /** The engine's reads, and the bytes they asked for: the parse work. */
  reads: number;
  readBytes: number;
  /** The file's full size, from the first response. */
  fileBytes: number;
};

/** A document opened over byte ranges. Use and close it like any other. */
export type PdfRangedDocument = PdfDocument & {
  stats(): PdfRangedStats;
};

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_READ_AHEAD_BYTES = 8 * 1024 * 1024;
/**
 * The first read. It covers a small file whole in one request, and a linearized file's
 * first-page cross-reference section.
 */
const HEAD_CHUNKS = 4;
/**
 * A ranged open reserves the file's length of linear memory: fresh pages, committed only where
 * fetched, so memory use follows the bytes fetched and not the length (measured in
 * docs/how-it-works.md). wasm32 has 4 GiB of addresses, and this leaves 512 MiB for everything else.
 * The parser's zero-copy objects are slices of that one buffer, and its offsets are 32-bit there.
 */
const MAX_FILE_BYTES = 3584 * 1024 * 1024;

type Range = { start: number; end: number };
type Answer = { start: number; bytes: Uint8Array; length: number; etag: string | null };
/** Fetches `ranges`; `limit` is how many bytes may still arrive. */
type Fetch = (ranges: Range[], timeoutMs: number, limit: number) => Answer[];

/** Fetched chunks of one file and the policy for fetching more. */
class RangeLoader {
  length = 0;
  readonly chunkBytes: number;
  /** Fetched chunks by chunk number (a flat array, sized once the length is known). */
  #chunks: (Uint8Array | undefined)[] = [];
  /** Set once a fetch failed; every later read fails and every call throws it. */
  failure: PdfError | null = null;
  #bytesFetched = 0;
  #requests = 0;
  #rounds = 0;
  #reads = 0;
  #readBytes = 0;
  #lastFetchEnd = -1;
  #readAhead: number;
  #etag: string | null = null;
  readonly #fetch: Fetch;
  readonly #maxBytes: number;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;

  constructor(
    fetch: Fetch,
    options: {
      chunkBytes: number;
      maxBytes: number;
      timeoutMs: number;
      signal: AbortSignal | undefined;
    }
  ) {
    this.#fetch = fetch;
    this.chunkBytes = options.chunkBytes;
    this.#readAhead = options.chunkBytes;
    this.#maxBytes = options.maxBytes;
    this.#timeoutMs = options.timeoutMs;
    this.#signal = options.signal;
  }

  stats(): PdfRangedStats {
    return {
      bytesFetched: this.#bytesFetched,
      requests: this.#requests,
      rounds: this.#rounds,
      reads: this.#reads,
      readBytes: this.#readBytes,
      fileBytes: this.length,
    };
  }

  /** Fetches chunks `firstChunk..endChunk`, keeping only those not held yet. */
  fetchChunks(firstChunk: number, endChunk: number): void {
    const runs: Range[] = [];
    let wanted = 0;
    for (let chunk = firstChunk; chunk < endChunk; chunk++) {
      if (this.#chunks[chunk]) {
        continue;
      }
      const start = chunk * this.chunkBytes;
      const end =
        this.length > 0
          ? Math.min(this.length, start + this.chunkBytes)
          : start + this.chunkBytes;
      const last = runs.at(-1);
      if (last && last.end === start) {
        last.end = end;
      } else {
        runs.push({ start, end });
      }
      wanted += end - start;
    }
    if (runs.length === 0) {
      return;
    }
    if (this.#signal?.aborted) {
      throw new PdfError("aborted", "the signal was aborted", this.#signal.reason);
    }
    // Before the length is known the head's size is a guess, and the file may be far smaller;
    // the fetch itself stops at the budget.
    if (this.length > 0 && this.#bytesFetched + wanted > this.#maxBytes) {
      throw tooLarge(this.#maxBytes);
    }
    this.#rounds += 1;
    const answers = this.#fetch(runs, this.#timeoutMs, this.#maxBytes - this.#bytesFetched);
    for (const answer of answers) {
      this.#requests += 1;
      this.#bytesFetched += answer.bytes.byteLength;
      if (this.length > 0 && answer.length !== this.length) {
        throw new PdfError(
          "fetch-failed",
          `the file changed size during the ranged read (${this.length} bytes, now ${answer.length})`
        );
      }
      // Before anything is sized from it: the total is whatever the server said.
      if (answer.length > MAX_FILE_BYTES) {
        throw new PdfError(
          "too-large",
          `a ranged read holds files up to ${MAX_FILE_BYTES} bytes (this one is ${answer.length}); use open() or a smaller file`
        );
      }
      if (this.#etag && answer.etag && answer.etag !== this.#etag) {
        throw new PdfError("fetch-failed", "the file was replaced during the ranged read (its ETag changed)");
      }
      this.#etag ??= answer.etag;
      this.length = answer.length;
      this.#store(answer);
    }
  }

  #store(answer: Answer): void {
    // Answers start on a chunk boundary (we asked for one). Views, not copies.
    const { bytes } = answer;
    if (this.#chunks.length === 0) {
      this.#chunks = Array.from<Uint8Array | undefined>({
        length: Math.ceil(answer.length / this.chunkBytes),
      });
    }
    for (let at = 0; at < bytes.byteLength; at += this.chunkBytes) {
      const chunk = (answer.start + at) / this.chunkBytes;
      this.#chunks[chunk] ??= bytes.subarray(
        at,
        Math.min(bytes.byteLength, at + this.chunkBytes)
      );
    }
  }

  /**
   * The `startxref` offset in the fetched last chunk, if it names one. Null for a linearized
   * file, whose trailer points at the first-page section near the head.
   */
  startxref(): number | null {
    const first = this.#chunks[0];
    const last = this.#chunks.at(-1);
    if (
      !first ||
      !last ||
      new TextDecoder("latin1").decode(first.subarray(0, 1024)).includes("/Linearized")
    ) {
      return null;
    }
    const tail = new TextDecoder("latin1").decode(last.subarray(-1024));
    const match = /startxref\s+(\d+)\s+%%EOF\s*$/u.exec(tail);
    const offset = match ? Number(match[1]) : Number.NaN;
    return offset >= 0 && offset < this.length ? offset : null;
  }

  /** The chunk window to fetch for a miss at `chunk`, with read-ahead. */
  #window(chunk: number, lastNeeded: number): [number, number] {
    const start = chunk * this.chunkBytes;
    const sequential =
      this.#lastFetchEnd >= 0 &&
      start >= this.#lastFetchEnd - this.chunkBytes &&
      start <= this.#lastFetchEnd + this.chunkBytes;
    this.#readAhead = sequential
      ? Math.min(MAX_READ_AHEAD_BYTES, this.#readAhead * 2)
      : this.chunkBytes;
    const totalChunks = Math.ceil(this.length / this.chunkBytes);
    const end = Math.min(
      totalChunks,
      Math.max(lastNeeded + 1, chunk + this.#readAhead / this.chunkBytes)
    );
    this.#lastFetchEnd = end * this.chunkBytes;
    return [chunk, end];
  }

  /**
   * Copies [offset, offset + out.length) into `out`, fetching what is missing first. On a
   * failed fetch it records the failure and fails the read; the call that made it then
   * throws the failure.
   */
  read(offset: number, out: Uint8Array): boolean {
    this.#reads += 1;
    this.#readBytes += out.byteLength;
    const end = offset + out.byteLength;
    if (this.failure || end > this.length || offset < 0) {
      return false;
    }
    if (out.byteLength === 0) {
      return true;
    }
    const first = Math.floor(offset / this.chunkBytes);
    const last = Math.floor((end - 1) / this.chunkBytes);
    for (let chunk = first; chunk <= last; chunk++) {
      if (!this.#chunks[chunk]) {
        try {
          this.fetchChunks(...this.#window(chunk, last));
        } catch (error) {
          this.failure =
            error instanceof PdfError
              ? error
              : new PdfError("fetch-failed", String(error), error);
          return false;
        }
        break;
      }
    }
    let at = offset;
    for (let chunk = first; chunk <= last; chunk++) {
      const bytes = this.#chunks[chunk];
      if (!bytes) {
        return false;
      }
      const from = at - chunk * this.chunkBytes;
      const take = Math.min(bytes.byteLength - from, end - at);
      out.set(bytes.subarray(from, from + take), at - offset);
      at += take;
    }
    return true;
  }
}

/**
 * Starts a ranged read of `source`: the head, then (for a larger file) the tail and its last
 * cross-reference section. Blocks while it fetches.
 */
export function startRangeLoader(
  source: string | Uint8Array,
  options: PdfRangedOpenOptions = {}
): RangeLoader {
  const positive = (name: string, value: number | undefined) => {
    if (value !== undefined && !(value > 0)) {
      throw new RangeError(`${name} must be above 0 (got ${value})`);
    }
  };
  positive("chunkBytes", options.chunkBytes);
  positive("maxBytes", options.maxBytes);
  positive("timeoutMs", options.timeoutMs);
  if (options.chunkBytes !== undefined && !Number.isSafeInteger(options.chunkBytes)) {
    throw new RangeError(`chunkBytes must be a whole number (got ${options.chunkBytes})`);
  }
  if (options.signal?.aborted) {
    throw new PdfError("aborted", "the signal was aborted", options.signal.reason);
  }
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const loader = new RangeLoader(fetcherFor(source), {
    chunkBytes,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  });
  loader.fetchChunks(0, HEAD_CHUNKS);
  if (loader.length <= 0) {
    throw new PdfError("invalid-file", "the file is empty");
  }
  // A file the head covered is read whole; any other one gets its tail.
  const totalChunks = Math.ceil(loader.length / chunkBytes);
  if (totalChunks > HEAD_CHUNKS) {
    loader.fetchChunks(Math.max(HEAD_CHUNKS, totalChunks - 1), totalChunks);
    // The tail names the last cross-reference section (`startxref`). Fetch all of it in one
    // round, rather than letting the parser discover it a chunk at a time.
    const xrefAt = loader.startxref();
    if (xrefAt !== null && loader.length - xrefAt <= MAX_READ_AHEAD_BYTES) {
      loader.fetchChunks(Math.floor(xrefAt / chunkBytes), totalChunks);
    }
  }
  return loader;
}

/**
 * The caller's source in a form that stays valid across an await: bytes copied, a URL as an
 * absolute http(s) string. Runs before anything asynchronous.
 */
export function ownedSource(source: PdfRangeSource): string | Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  if (typeof source !== "string" && !(source instanceof URL)) {
    throw new TypeError("expected an http(s) URL or the PDF's bytes as a Uint8Array");
  }
  const base = globalThis.location?.href;
  const url = URL.parse(source, base);
  if (url?.protocol !== "http:" && url?.protocol !== "https:") {
    // Not the URL itself: it may hold a credential.
    throw new TypeError("expected an absolute http(s) URL; use open() for a file on disk");
  }
  return url.href;
}

function fetcherFor(source: string | Uint8Array): Fetch {
  if (typeof source !== "string") {
    const bytes = source;
    return (ranges) =>
      ranges.map(({ start, end }) => ({
        start,
        bytes: bytes.subarray(start, Math.min(end, bytes.byteLength)),
        length: bytes.byteLength,
        etag: null,
      }));
  }
  const url = source;
  // Node's fetch cannot run under a blocked thread; in a browser worker a synchronous
  // XMLHttpRequest needs no second thread.
  return globalThis.process?.getBuiltinModule?.("node:worker_threads")
    ? (ranges, timeoutMs, limit) => fetchOverThread(url, ranges, timeoutMs, limit)
    : (ranges, timeoutMs, limit) => fetchOverXhr(url, ranges, timeoutMs, limit);
}

function tooLarge(maxBytes: number): PdfError {
  return new PdfError(
    "too-large",
    `the ranged read would pass ${maxBytes} bytes (maxBytes); raise it or fetch the file whole`
  );
}

/**
 * A server's answer as chunks to store, or a clear failure. Messages never carry the URL: a
 * presigned query is a credential.
 */
function answerOf(
  range: Range,
  status: number,
  contentRange: string | null,
  etag: string | null,
  bytes: Uint8Array,
  limit: number
): Answer {
  if (status === 200) {
    // The server ignored Range and sent the whole file: use it, while the budget allows.
    if (bytes.byteLength > limit) {
      throw new PdfError(
        "too-large",
        `the server does not answer Range requests, and the whole file is past the ${limit} bytes left of maxBytes`
      );
    }
    return { start: 0, bytes, length: bytes.byteLength, etag };
  }
  if (status !== 206) {
    throw new PdfError("fetch-failed", `the ranged read failed (HTTP ${status})`);
  }
  const match = /^bytes (\d+)-\d+\/(\d+)$/u.exec(contentRange?.trim() ?? "");
  if (!match) {
    throw new PdfError(
      "fetch-failed",
      "the server's 206 answer has no usable Content-Range (with a total length). " +
        "A cross-origin server must also send Access-Control-Expose-Headers: Content-Range."
    );
  }
  const start = Number(match[1]);
  const length = Number(match[2]);
  // A short or shifted answer (a proxy capping ranges) would store a partial chunk.
  if (start !== range.start || bytes.byteLength !== Math.min(range.end, length) - range.start) {
    throw new PdfError(
      "fetch-failed",
      `the server answered a different range than asked (asked ${range.start}-${range.end - 1}, got ${bytes.byteLength} bytes from ${start})`
    );
  }
  return { start, bytes, length, etag };
}

function fetchOverXhr(url: string, ranges: Range[], timeoutMs: number, limit: number): Answer[] {
  const deadline = performance.now() + timeoutMs;
  return ranges.map((range) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.responseType = "arraybuffer";
    xhr.timeout = Math.max(1, deadline - performance.now());
    xhr.setRequestHeader("Range", `bytes=${range.start}-${range.end - 1}`);
    try {
      xhr.send();
    } catch (error) {
      const timedOut = (error as { name?: string }).name === "TimeoutError";
      throw new PdfError(
        timedOut ? "timeout" : "fetch-failed",
        timedOut
          ? `the ranged read timed out after ${timeoutMs} ms`
          : "the ranged read failed: the network, or a cross-origin server that does not allow it",
        error
      );
    }
    return answerOf(
      range,
      xhr.status,
      xhr.getResponseHeader("Content-Range"),
      xhr.getResponseHeader("ETag"),
      new Uint8Array(xhr.response as ArrayBuffer),
      limit
    );
  });
}

// The fetcher thread: plain JS (eval), so it needs no loader or bundler entry. It answers
// each request on the port, then bumps `flag` so the waiting thread wakes. The body is read
// up to `limit`, for a server that answers a small range with a huge whole file.
const FETCHER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { port, flag } = workerData;
const controllers = new Map();
async function get(m, signal) {
  const response = await fetch(m.url, {
    headers: { Range: "bytes=" + m.start + "-" + (m.end - 1), "Accept-Encoding": "identity" },
    signal,
  });
  const reply = {
    status: response.status,
    contentRange: response.headers.get("content-range"),
    etag: response.headers.get("etag"),
  };
  if (!response.ok) {
    if (response.body) await response.body.cancel();
    return { ...reply, bytes: new ArrayBuffer(0) };
  }
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.byteLength;
    if (size > m.limit) return { ...reply, overLimit: true, bytes: new ArrayBuffer(0) };
    parts.push(part);
  }
  const { buffer, byteOffset, byteLength } = Buffer.concat(parts);
  return { ...reply, bytes: buffer.slice(byteOffset, byteOffset + byteLength) };
}
port.on("message", async (m) => {
  if (m.abort) { const c = controllers.get(m.id); if (c) c.abort(); return; }
  const controller = new AbortController();
  controllers.set(m.id, controller);
  let reply;
  try {
    reply = await get(m, controller.signal);
    // Done reading, so a request cut short at the limit stops downloading too.
    controller.abort();
  } catch (error) {
    // A code, never the message: fetch quotes the URL in some of them.
    reply = { failed: (error && error.cause && error.cause.code) || (error && error.name) || "error" };
  }
  controllers.delete(m.id);
  reply.id = m.id;
  port.postMessage(reply, reply.bytes ? [reply.bytes] : []);
  Atomics.add(flag, 0, 1);
  Atomics.notify(flag, 0);
});
`;

type FetcherReply = {
  id: number;
  status: number;
  contentRange: string | null;
  etag: string | null;
  bytes: ArrayBuffer;
  overLimit?: true;
  failed?: string;
};

let fetcher: { port: MessagePort; flag: Int32Array; nextId: number } | null = null;

function workerThreads() {
  return globalThis.process.getBuiltinModule("node:worker_threads");
}

function startFetcher() {
  const { MessageChannel, Worker } = workerThreads();
  const flag = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(FETCHER_SOURCE, {
    eval: true,
    name: "recto-range-fetcher",
    workerData: { port: port2, flag },
    transferList: [port2],
  });
  worker.unref();
  port1.unref();
  worker.on("exit", () => {
    fetcher = null;
  });
  return { port: port1, flag, nextId: 0 };
}

/** Fetches `ranges` in parallel on the fetcher thread; blocks until all answer. */
function fetchOverThread(
  url: string,
  ranges: Range[],
  timeoutMs: number,
  limit: number
): Answer[] {
  const current = (fetcher ??= startFetcher());
  const deadline = performance.now() + timeoutMs;
  const pending = new Map<number, Range>();
  for (const range of ranges) {
    const id = current.nextId++;
    pending.set(id, range);
    current.port.postMessage({ id, url, start: range.start, end: range.end, limit });
  }
  const answers: Answer[] = [];
  let failure: PdfError | null = null;
  let seen = Atomics.load(current.flag, 0);
  while (pending.size > 0) {
    for (;;) {
      const received = workerThreads().receiveMessageOnPort(current.port);
      if (!received) {
        break;
      }
      const reply = received.message as FetcherReply;
      const range = pending.get(reply.id);
      if (!range) {
        continue; // a reply to a request that already timed out
      }
      pending.delete(reply.id);
      try {
        if (reply.failed !== undefined) {
          throw new PdfError("fetch-failed", `the ranged read failed: ${reply.failed}`);
        }
        if (reply.overLimit) {
          throw tooLarge(limit);
        }
        answers.push(
          answerOf(range, reply.status, reply.contentRange, reply.etag, new Uint8Array(reply.bytes), limit)
        );
      } catch (error) {
        failure ??= error as PdfError;
      }
    }
    if (pending.size === 0) {
      break;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0 || Atomics.wait(current.flag, 0, seen, remaining) === "timed-out") {
      for (const id of pending.keys()) {
        current.port.postMessage({ id, abort: true });
      }
      throw new PdfError(
        "timeout",
        `the ranged read timed out after ${timeoutMs} ms. This thread is blocked while it waits, so a server running on the same thread can never answer; run the read on a worker thread.`
      );
    }
    seen = Atomics.load(current.flag, 0);
  }
  if (failure) {
    throw failure;
  }
  return answers;
}
