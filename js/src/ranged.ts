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
// O(chunks it spans), whatever the number of fetches so far. The first round asks for the head
// and the tail at once (the tail as a suffix range, `bytes=-n`, since the size isn't known
// yet): an ordinary file's cross-reference table is at its end, and a small file's head is
// all of it. That round, and the one for a cross-reference section the tail didn't hold, run
// before the engine's synchronous parse, so in a browser they're `fetch` calls in parallel
// rather than synchronous requests one after another. A miss that continues the previous
// fetch (a long xref table or page run read front to back) doubles the read-ahead, so a
// sequential scan of n chunks costs O(log n) round trips.

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
  /**
   * Wall time for the whole read, from the first fetch on, in place of counting rounds (code "timeout").
   * A fetch in flight is cut when it runs out, and none starts after; that bounds the network waits, not
   * the parsing between them. What's already fetched reads until a read fails, after which every call
   * on the document throws that failure: reopen to go on. In WebKit a response that keeps trickling is
   * not cut. Default: no limit.
   */
  totalTimeoutMs?: number;
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
 * The tail asked for alongside the head: the last chunk, which ends the file, and the one
 * before, where a file's last objects and a short xref section usually are.
 */
const TAIL_CHUNKS = 2;
/**
 * A ranged open reserves the file's length of linear memory: fresh pages, committed only where
 * fetched, so memory use follows the bytes fetched and not the length (measured in
 * docs/how-it-works.md). wasm32 has 4 GiB of addresses, and this leaves 512 MiB for everything else.
 * The parser's zero-copy objects are slices of that one buffer, and its offsets are 32-bit there.
 */
const MAX_FILE_BYTES = 3584 * 1024 * 1024;

type Range = { start: number; end: number };
/** The file's last `suffix` bytes (`bytes=-n`), asked for before its size is known. */
type Suffix = { suffix: number };
type Request = Range | Suffix;
type Answer = { start: number; bytes: Uint8Array; length: number; etag: string | null; status: number };
/**
 * Fetches `requests` in parallel; `limit` is how many bytes may still arrive. A range that
 * fails throws. A suffix that isn't answered as one (a server that ignores or refuses it)
 * gives null, and isn't counted: the caller asks for the tail by its offset instead.
 */
type Fetch = (requests: Request[], timeoutMs: number, limit: number) => (Answer | null)[];
type FetchAsync = (requests: Request[], timeoutMs: number, limit: number) => Promise<(Answer | null)[]>;

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
  readonly #totalTimeoutMs: number;
  readonly #deadline: number;
  readonly #signal: AbortSignal | undefined;

  constructor(
    fetch: Fetch,
    options: {
      chunkBytes: number;
      maxBytes: number;
      timeoutMs: number;
      totalTimeoutMs: number;
      signal: AbortSignal | undefined;
    }
  ) {
    this.#fetch = fetch;
    this.chunkBytes = options.chunkBytes;
    this.#readAhead = options.chunkBytes;
    this.#maxBytes = options.maxBytes;
    this.#timeoutMs = options.timeoutMs;
    this.#totalTimeoutMs = options.totalTimeoutMs;
    this.#deadline = performance.now() + options.totalTimeoutMs;
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
    const runs = this.#missing(firstChunk, endChunk);
    if (runs.length > 0) {
      this.#absorb(this.#round(runs, (limit, timeoutMs, passesTotal) => this.#timed(passesTotal, () => this.#fetch(runs, timeoutMs, limit))));
    }
  }

  /** The same, through `fetchAsync` when there is one: before the parse, a browser need not block. */
  async #fetchChunksAsync(firstChunk: number, endChunk: number, fetchAsync: FetchAsync | null): Promise<void> {
    if (!fetchAsync) {
      this.fetchChunks(firstChunk, endChunk);
      return;
    }
    const runs = this.#missing(firstChunk, endChunk);
    if (runs.length > 0) {
      this.#absorb(await this.#round(runs, (limit, timeoutMs, passesTotal) => this.#timedAsync(passesTotal, fetchAsync(runs, timeoutMs, limit))));
    }
  }

  /**
   * The first round: the head and, in parallel, the tail as a suffix, then the last
   * cross-reference section if the tail didn't hold it. A file the head covers needs no more;
   * a server that doesn't answer the suffix gets the tail by offset in a round of its own.
   */
  async begin(fetchAsync: FetchAsync | null): Promise<void> {
    const head: Range = { start: 0, end: HEAD_CHUNKS * this.chunkBytes };
    const requests: Request[] = [head, { suffix: TAIL_CHUNKS * this.chunkBytes }];
    const [first, tail] = await this.#round(requests, (limit, timeoutMs, passesTotal) =>
      fetchAsync
        ? this.#timedAsync(passesTotal, fetchAsync(requests, timeoutMs, limit))
        : this.#timed(passesTotal, () => this.#fetch(requests, timeoutMs, limit))
    );
    // A range is never null: it throws. The tail is counted even where the head held it all, but
    // not past maxBytes: then it's dropped, and asking for it by offset fails as it always did.
    this.#absorb([first ?? null]);
    if (tail && this.#bytesFetched + tail.bytes.byteLength <= this.#maxBytes) {
      this.#absorb([tail]);
    }
    if (this.length <= 0) {
      throw new PdfError("invalid-file", "the file is empty");
    }
    // A file the head covered is read whole; any other one gets its tail.
    const totalChunks = Math.ceil(this.length / this.chunkBytes);
    if (totalChunks > HEAD_CHUNKS) {
      await this.#fetchChunksAsync(Math.max(HEAD_CHUNKS, totalChunks - 1), totalChunks, fetchAsync);
      // The tail names the last cross-reference section (`startxref`). Fetch all of it in one
      // round, rather than letting the parser discover it a chunk at a time.
      const xrefAt = this.startxref();
      if (xrefAt !== null && this.length - xrefAt <= MAX_READ_AHEAD_BYTES) {
        await this.#fetchChunksAsync(Math.floor(xrefAt / this.chunkBytes), totalChunks, fetchAsync);
      }
    }
  }

  /** The runs of chunks in `firstChunk..endChunk` not held yet. */
  #missing(firstChunk: number, endChunk: number): Range[] {
    const runs: Range[] = [];
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
    }
    return runs;
  }

  /**
   * One round trip for `requests`: the signal, the budget and the deadline checked first, then
   * `fetch` with what's left of each.
   */
  #round<T>(requests: Request[], fetch: (limit: number, timeoutMs: number, passesTotal: boolean) => T): T {
    if (this.#signal?.aborted) {
      throw new PdfError("aborted", "the signal was aborted", this.#signal.reason);
    }
    // Before the length is known the head's size is a guess, and the file may be far smaller;
    // the fetch itself stops at the budget.
    const wanted = requests.reduce((sum, request) => sum + ("suffix" in request ? request.suffix : request.end - request.start), 0);
    if (this.length > 0 && this.#bytesFetched + wanted > this.#maxBytes) {
      throw tooLarge(this.#maxBytes);
    }
    const left = this.#deadline - performance.now();
    if (left <= 0) {
      throw new PdfError("timeout", this.#passedTotal());
    }
    this.#rounds += 1;
    const passesTotal = left < this.#timeoutMs;
    return fetch(this.#maxBytes - this.#bytesFetched, passesTotal ? Math.ceil(left) : this.#timeoutMs, passesTotal);
  }

  #passedTotal(): string {
    return `the ranged read passed its ${this.#totalTimeoutMs} ms (totalTimeoutMs)`;
  }

  /** A round's timeout, when it's the deadline's, says so. */
  #timed<T>(passesTotal: boolean, fetch: () => T): T {
    try {
      return fetch();
    } catch (error) {
      if (passesTotal && (error as PdfError).code === "timeout") {
        throw new PdfError("timeout", this.#passedTotal(), error);
      }
      throw error;
    }
  }

  async #timedAsync<T>(passesTotal: boolean, fetch: Promise<T>): Promise<T> {
    return await fetch.catch((error: unknown) => {
      throw passesTotal && (error as PdfError).code === "timeout" ? new PdfError("timeout", this.#passedTotal(), error) : error;
    });
  }

  /** Checks and keeps a round's answers; a suffix nobody answered is skipped. */
  #absorb(answers: (Answer | null)[]): void {
    for (const answer of answers) {
      if (!answer) {
        continue;
      }
      this.#requests += 1;
      this.#bytesFetched += answer.bytes.byteLength;
      if (this.length > 0 && answer.length !== this.length) {
        throw new PdfError(
          "fetch-failed",
          `the file changed size during the ranged read (${this.length} bytes, now ${answer.length})`,
          undefined,
          answer.status
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
        throw new PdfError("fetch-failed", "the file was replaced during the ranged read (its ETag changed)", undefined, answer.status);
      }
      this.#etag ??= answer.etag;
      this.length = answer.length;
      this.#store(answer);
    }
  }

  #store(answer: Answer): void {
    // A range starts on a chunk boundary (we asked for one); a suffix may not, and the part of
    // a chunk before its first boundary isn't kept. Views, not copies.
    const { bytes } = answer;
    if (this.#chunks.length === 0) {
      this.#chunks = Array.from<Uint8Array | undefined>({
        length: Math.ceil(answer.length / this.chunkBytes),
      });
    }
    const skip = (this.chunkBytes - (answer.start % this.chunkBytes)) % this.chunkBytes;
    for (let at = skip; at < bytes.byteLength; at += this.chunkBytes) {
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

  /**
   * The chunk window to fetch for a miss at `chunk`, with read-ahead, and at least to `lastAhead`:
   * what the engine said it's likely to read next.
   */
  #window(chunk: number, lastNeeded: number, lastAhead: number): [number, number] {
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
      Math.max(lastNeeded + 1, lastAhead + 1, chunk + this.#readAhead / this.chunkBytes)
    );
    this.#lastFetchEnd = end * this.chunkBytes;
    return [chunk, end];
  }

  /**
   * Copies [offset, offset + out.length) into `out`, fetching what is missing first, and if it
   * fetches, `ahead` bytes past it too, as far as the budget allows: the engine's guess at what
   * it reads next, which then costs no round trip of its own. On a failed fetch it records the
   * failure and fails the read; the call that made it then throws the failure.
   */
  read(offset: number, out: Uint8Array, ahead = 0): boolean {
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
    const spare = Math.max(0, this.#maxBytes - this.#bytesFetched - out.byteLength);
    const lastAhead = Math.floor((Math.min(this.length, end + Math.min(ahead, spare)) - 1) / this.chunkBytes);
    for (let chunk = first; chunk <= last; chunk++) {
      if (!this.#chunks[chunk]) {
        try {
          this.fetchChunks(...this.#window(chunk, last, lastAhead));
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
 * Starts a ranged read of `source`: the head and tail, then the last cross-reference section
 * if the tail didn't hold it. Blocks while it fetches, except in a browser, where these
 * rounds are `fetch` calls.
 */
export async function startRangeLoader(
  source: string | Uint8Array,
  options: PdfRangedOpenOptions = {}
): Promise<RangeLoader> {
  const positive = (name: string, value: number | undefined) => {
    if (value !== undefined && !(typeof value === "number" && value > 0)) {
      throw new RangeError(`${name} must be above 0 (got ${value})`);
    }
  };
  positive("chunkBytes", options.chunkBytes);
  positive("maxBytes", options.maxBytes);
  positive("timeoutMs", options.timeoutMs);
  positive("totalTimeoutMs", options.totalTimeoutMs);
  if (options.chunkBytes !== undefined && !Number.isSafeInteger(options.chunkBytes)) {
    throw new RangeError(`chunkBytes must be a whole number (got ${options.chunkBytes})`);
  }
  if (options.signal?.aborted) {
    throw new PdfError("aborted", "the signal was aborted", options.signal.reason);
  }
  const loader = new RangeLoader(fetcherFor(source), {
    chunkBytes: options.chunkBytes ?? DEFAULT_CHUNK_BYTES,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    totalTimeoutMs: options.totalTimeoutMs ?? Number.POSITIVE_INFINITY,
    signal: options.signal,
  });
  await loader.begin(asyncFetcherFor(source));
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
    return (requests) =>
      requests.map((request) => {
        const start = "suffix" in request ? Math.max(0, bytes.byteLength - request.suffix) : request.start;
        const end = "suffix" in request ? bytes.byteLength : Math.min(request.end, bytes.byteLength);
        return { start, bytes: bytes.subarray(start, end), length: bytes.byteLength, etag: null, status: 206 };
      });
  }
  const url = source;
  // Node's fetch cannot run under a blocked thread; in a browser worker a synchronous
  // XMLHttpRequest needs no second thread.
  return isNode()
    ? (requests, timeoutMs, limit) => fetchOverThread(url, requests, timeoutMs, limit)
    : (requests, timeoutMs, limit) => fetchOverXhr(url, requests, timeoutMs, limit);
}

/**
 * How the rounds before the parse fetch, if not as the parse's do: in a browser, `fetch`, so a
 * round's requests run in parallel, where synchronous requests run one after another. Node's
 * fetcher thread already runs them in parallel.
 */
function asyncFetcherFor(source: string | Uint8Array): FetchAsync | null {
  if (typeof source !== "string" || isNode()) {
    return null;
  }
  return (requests, timeoutMs, limit) => fetchOverFetch(source, requests, timeoutMs, limit);
}

function isNode(): boolean {
  return Boolean(globalThis.process?.getBuiltinModule?.("node:worker_threads"));
}

function rangeHeader(request: Request): string {
  return "suffix" in request ? `bytes=-${request.suffix}` : `bytes=${request.start}-${request.end - 1}`;
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
  range: Request,
  status: number,
  contentRange: string | null,
  etag: string | null,
  bytes: Uint8Array,
  limit: number
): Answer {
  if (status === 200 && !("suffix" in range)) {
    // The server ignored Range and sent the whole file: use it, while the budget allows.
    if (bytes.byteLength > limit) {
      throw new PdfError(
        "too-large",
        `the server does not answer Range requests, and the whole file is past the ${limit} bytes left of maxBytes`
      );
    }
    return { start: 0, bytes, length: bytes.byteLength, etag, status };
  }
  if (status !== 206) {
    throw new PdfError("fetch-failed", `the ranged read failed (HTTP ${status})`, undefined, status);
  }
  const match = /^bytes (\d+)-\d+\/(\d+)$/u.exec(contentRange?.trim() ?? "");
  if (!match) {
    throw new PdfError(
      "fetch-failed",
      "the server's 206 answer has no usable Content-Range (with a total length). " +
        "A cross-origin server must also send Access-Control-Expose-Headers: Content-Range.",
      undefined,
      status
    );
  }
  const start = Number(match[1]);
  const length = Number(match[2]);
  // A short or shifted answer (a proxy capping ranges) would store a partial chunk.
  const asked = "suffix" in range ? { start: Math.max(0, length - range.suffix), end: length } : range;
  if (start !== asked.start || bytes.byteLength !== Math.min(asked.end, length) - asked.start) {
    throw new PdfError(
      "fetch-failed",
      `the server answered a different range than asked (asked ${asked.start}-${asked.end - 1}, got ${bytes.byteLength} bytes from ${start})`,
      undefined,
      status
    );
  }
  return { start, bytes, length, etag, status };
}

/** A suffix's answer, or null if it isn't one: the tail is then asked for by its offset. */
function suffixAnswerOf(
  suffix: Suffix,
  status: number,
  contentRange: string | null,
  etag: string | null,
  bytes: Uint8Array
): Answer | null {
  if (status !== 206) {
    return null;
  }
  try {
    return answerOf(suffix, status, contentRange, etag, bytes, Number.POSITIVE_INFINITY);
  } catch {
    return null;
  }
}

const NO_ANSWER = "the ranged read failed: the network, or a cross-origin server that does not allow it";

function fetchOverXhr(url: string, ranges: Request[], timeoutMs: number, limit: number): (Answer | null)[] {
  const deadline = performance.now() + timeoutMs;
  return ranges.map((range) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, false);
    xhr.responseType = "arraybuffer";
    xhr.timeout = Math.max(1, deadline - performance.now());
    xhr.setRequestHeader("Range", rangeHeader(range));
    try {
      xhr.send();
    } catch (error) {
      const timedOut = (error as { name?: string }).name === "TimeoutError";
      throw new PdfError(
        timedOut ? "timeout" : "fetch-failed",
        timedOut
          ? `the ranged read timed out after ${timeoutMs} ms`
          : NO_ANSWER,
        error
      );
    }
    // Firefox reports a refused cross-origin read as status 0, not a throw.
    if (xhr.status === 0) {
      throw new PdfError("fetch-failed", NO_ANSWER);
    }
    if ("suffix" in range) {
      return suffixAnswerOf(range, xhr.status, xhr.getResponseHeader("Content-Range"), xhr.getResponseHeader("ETag"), new Uint8Array(xhr.response as ArrayBuffer));
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

/**
 * The XMLHttpRequest path's answers and failures, from `fetch`, with a round's requests in
 * parallel. Used before the parse starts, when this thread may await.
 */
async function fetchOverFetch(url: string, requests: Request[], timeoutMs: number, limit: number): Promise<(Answer | null)[]> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const failure = (error: unknown) =>
    timedOut
      ? new PdfError("timeout", `the ranged read timed out after ${timeoutMs} ms`, error)
      : new PdfError("fetch-failed", NO_ANSWER, error);
  try {
    return await Promise.all(
      requests.map(async (request): Promise<Answer | null> => {
        let response: Response;
        let bytes: Uint8Array;
        try {
          response = await fetch(url, { headers: { Range: rangeHeader(request) }, signal: controller.signal });
          if ("suffix" in request && response.status !== 206) {
            // Not a suffix: a whole file, or a refusal. Read none of it.
            await response.body?.cancel();
            return null;
          }
          bytes = "suffix" in request ? await upTo(response, request.suffix) : new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > ("suffix" in request ? request.suffix : Number.POSITIVE_INFINITY)) {
            // Longer than asked: not a suffix.
            return null;
          }
        } catch (error) {
          if ("suffix" in request && !timedOut) {
            return null;
          }
          throw failure(error);
        }
        const contentRange = response.headers.get("Content-Range");
        const etag = response.headers.get("ETag");
        return "suffix" in request
          ? suffixAnswerOf(request, response.status, contentRange, etag, bytes)
          : answerOf(request, response.status, contentRange, etag, bytes, limit);
      })
    );
  } finally {
    clearTimeout(timer);
    // A round that failed leaves nothing downloading.
    controller.abort();
  }
}

/** A body, read no further than one byte past `most`. */
async function upTo(response: Response, most: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parts.push(value);
    size += value.byteLength;
    if (size > most) {
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
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
    headers: { Range: m.range, "Accept-Encoding": "identity" },
    signal,
  });
  const reply = {
    status: response.status,
    contentRange: response.headers.get("content-range"),
    etag: response.headers.get("etag"),
  };
  // A suffix answered with anything else (a whole file) isn't read.
  if (!response.ok || (m.suffix && response.status !== 206)) {
    if (response.body) await response.body.cancel();
    return { ...reply, bytes: new ArrayBuffer(0) };
  }
  const parts = [];
  let size = 0;
  for await (const part of response.body ?? []) {
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
  ranges: Request[],
  timeoutMs: number,
  limit: number
): (Answer | null)[] {
  const current = (fetcher ??= startFetcher());
  const deadline = performance.now() + timeoutMs;
  const pending = new Map<number, Request>();
  const order = new Map<Request, number>();
  for (const range of ranges) {
    const id = current.nextId++;
    pending.set(id, range);
    order.set(range, order.size);
    // A suffix's answer is read no further than the suffix: past it, it isn't one.
    const suffix = "suffix" in range;
    current.port.postMessage({ id, url, range: rangeHeader(range), suffix, limit: suffix ? Math.min(range.suffix, limit) : limit });
  }
  const answers: (Answer | null)[] = ranges.map(() => null);
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
      if ("suffix" in range) {
        answers[order.get(range)!] =
          reply.failed === undefined && !reply.overLimit
            ? suffixAnswerOf(range, reply.status, reply.contentRange, reply.etag, new Uint8Array(reply.bytes))
            : null;
        continue;
      }
      try {
        if (reply.failed !== undefined) {
          throw new PdfError("fetch-failed", `the ranged read failed: ${reply.failed}`);
        }
        if (reply.overLimit) {
          throw tooLarge(limit);
        }
        answers[order.get(range)!] = answerOf(range, reply.status, reply.contentRange, reply.etag, new Uint8Array(reply.bytes), limit);
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
