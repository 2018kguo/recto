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
// Fetched bytes are kept as fixed-size chunks indexed by chunk number, until the engine has read
// them into its own memory (then they're dropped here, so the file is held once), so a read costs
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
  /**
   * Bytes held here and not yet read by the engine. What it has read is in its own memory, and dropped
   * here, so a file is held once however it was fetched.
   */
  heldBytes: number;
};

/** A document opened over byte ranges. Use and close it like any other. */
export type PdfRangedDocument = PdfDocument & {
  stats(): PdfRangedStats;
  /**
   * Downloads the rest of the file in the background, in one request from the first byte not held yet,
   * so that reads after it never block on the network. Counts toward `maxBytes` (fails `too-large`
   * up front past it). A failure fails no read: they fetch by range as before.
   */
  fetchRest(options?: { signal?: AbortSignal; stallMs?: number }): Promise<void>;
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

/**
 * Bytes `start..end`. With `yieldTail`, read no further than that many bytes before the file's
 * end, where a suffix asked for beside it starts, so no byte comes twice.
 */
type Range = { start: number; end: number; yieldTail?: number };
/** The file's last `suffix` bytes (`bytes=-n`), asked for before its size is known. */
type Suffix = { suffix: number };
type Request = Range | Suffix;
/** `received`: the bytes read off the response, `bytes` and any read past it. */
type Answer = { start: number; bytes: Uint8Array; length: number; etag: string | null; status: number; received: number };
/** Part of a chunk: what a range that doesn't start or end on a boundary brought of it. */
type Piece = { start: number; bytes: Uint8Array };
/**
 * Fetches `requests` in parallel; `limit` is how many bytes may still arrive. A range that
 * fails throws. A suffix that isn't answered as one (a server that ignores or refuses it)
 * gives null, and isn't counted: the caller asks for the tail by its offset instead.
 */
type Answers = (Answer | null)[];
type Fetch = (requests: Request[], timeoutMs: number, limit: number) => Answers;
type FetchAsync = (requests: Request[], timeoutMs: number, limit: number) => Promise<Answers>;

/** Fetched chunks of one file and the policy for fetching more. */
class RangeLoader {
  length = 0;
  readonly chunkBytes: number;
  /** Fetched chunks by chunk number (a flat array, sized once the length is known). */
  #chunks: (Uint8Array | undefined)[] = [];
  /** Chunks the reader (the engine) has copied in and dropped here. */
  #delivered = new Set<number>();
  /** A chunk's start or end, by chunk number, until the rest of it arrives. */
  #pieces = new Map<number, Piece[]>();
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
      heldBytes:
        this.#chunks.reduce((sum, chunk) => sum + (chunk?.byteLength ?? 0), 0) +
        [...this.#pieces.values()].flat().reduce((sum, piece) => sum + piece.bytes.byteLength, 0),
    };
  }

  /**
   * Downloads every chunk not held yet, from the first one missing to the file's end, in one
   * streamed request, keeping each chunk as it completes: reads after it need no round trip. A
   * chunk a read fetched meanwhile is skipped. A failure here fails no read: they fetch as before.
   */
  async fetchRest(source: string | Uint8Array, options: { signal?: AbortSignal; stallMs?: number } = {}): Promise<void> {
    if (this.failure || this.length <= 0) {
      return;
    }
    const missing = (chunk: number) => !this.#has(chunk);
    const first = this.#chunks.findIndex((_, chunk) => missing(chunk));
    if (first < 0) {
      return;
    }
    if (this.#bytesFetched + (this.length - first * this.chunkBytes) > this.#maxBytes) {
      throw tooLarge(this.#maxBytes);
    }
    if (typeof source !== "string") {
      const start = first * this.chunkBytes;
      this.#absorb([{ start, bytes: source.subarray(start), length: source.byteLength, etag: null, status: 206, received: source.byteLength - start }]);
      return;
    }
    // A response that stops sending is given up after `stallMs` without a byte, as a blocking read would be.
    const stalled = new AbortController();
    const stallMs = options.stallMs ?? this.#timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(new PdfError("timeout", `the rest of the file sent nothing for ${stallMs} ms`)), stallMs);
    };
    // One request, to the last chunk missing: the tail, held since the open, isn't asked for again. (Not
    // one that gives way to a read that misses: an abort can't reach the network while the thread is
    // blocked on that read's request, so stopping and resuming only cost a round trip each time.)
    let last = this.#chunks.length - 1;
    while (!missing(last)) {
      last -= 1;
    }
    alive();
    try {
      await this.#streamRest(source, first, last, options.signal ? AbortSignal.any([options.signal, stalled.signal]) : stalled.signal, alive);
    } finally {
      clearTimeout(timer);
    }
  }

  async #streamRest(source: string, first: number, last: number, signal: AbortSignal, alive: () => void): Promise<void> {
    const start = first * this.chunkBytes;
    const end = Math.min(this.length, (last + 1) * this.chunkBytes);
    const response = await fetch(source, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
    alive();
    const contentRange = response.headers.get("Content-Range");
    const etag = response.headers.get("ETag");
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange?.trim() ?? "");
    if (
      response.status !== 206 ||
      !match ||
      Number(match[1]) !== start ||
      Number(match[2]) !== end - 1 ||
      Number(match[3]) !== this.length ||
      (this.#etag && etag && etag !== this.#etag)
    ) {
      await response.body?.cancel().catch(() => {});
      throw response.ok ? new PdfError("fetch-failed", "the server answered a different range than asked", undefined, response.status) : httpFailure(response.status);
    }
    this.#requests += 1;
    this.#rounds += 1;
    const reader = response.body!.getReader();
    // The chunk being filled, and how much of it has arrived.
    let at = start;
    let chunk = new Uint8Array(Math.min(this.chunkBytes, end - at));
    let filled = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        alive();
        this.#bytesFetched += value.byteLength;
        for (let from = 0; from < value.byteLength; ) {
          const take = Math.min(chunk.byteLength - filled, value.byteLength - from);
          chunk.set(value.subarray(from, from + take), filled);
          filled += take;
          from += take;
          if (filled === chunk.byteLength) {
            if (!this.#has(first)) {
              this.#chunks[first] = chunk;
              this.#pieces.delete(first);
            }
            first += 1;
            at += chunk.byteLength;
            if (at >= end) {
              return;
            }
            chunk = new Uint8Array(Math.min(this.chunkBytes, end - at));
            filled = 0;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (at < end) {
      throw new PdfError("fetch-failed", `the answer ended early, at ${at + filled} of ${end} bytes`, undefined, response.status);
    }
  }

  /** Fetches chunks `firstChunk..endChunk`, keeping only those not held yet: a read's miss, so it blocks. */
  #fetchChunks(firstChunk: number, endChunk: number): void {
    const runs = this.#missing(firstChunk, endChunk);
    if (runs.length > 0) {
      this.#absorb(this.#round(runs, (limit, timeoutMs) => this.#fetch(runs, timeoutMs, limit)));
    }
  }

  /** A round before the parse: through `fetchAsync` when there is one, so a browser need not block. */
  async #fetchAhead(requests: Request[], fetchAsync: FetchAsync | null): Promise<void> {
    if (requests.length > 0) {
      this.#absorb(
        await this.#round(requests, (limit, timeoutMs) =>
          fetchAsync ? fetchAsync(requests, timeoutMs, limit) : this.#fetch(requests, timeoutMs, limit)
        )
      );
    }
  }

  /**
   * The first round: the head and, in parallel, the tail as a suffix, then the last
   * cross-reference section if the tail didn't hold it. A file the head covers needs no more;
   * a server that doesn't answer the suffix gets the tail by offset in a round of its own.
   */
  async begin(fetchAsync: FetchAsync | null): Promise<void> {
    const tail = TAIL_CHUNKS * this.chunkBytes;
    // The head stops where the suffix starts, in a file shorter than the two.
    const head: Range = { start: 0, end: HEAD_CHUNKS * this.chunkBytes, yieldTail: tail };
    await this.#fetchAhead([head, { suffix: tail }], fetchAsync);
    if (this.length <= 0) {
      throw new PdfError("invalid-file", "the file is empty");
    }
    if (this.#bytesFetched > this.#maxBytes) {
      throw tooLarge(this.#maxBytes);
    }
    // Without the suffix's answer, the head and the last chunk by their offsets, as one round.
    const totalChunks = Math.ceil(this.length / this.chunkBytes);
    await this.#fetchAhead(
      [...this.#missing(0, Math.min(HEAD_CHUNKS, totalChunks)), ...this.#missing(Math.max(HEAD_CHUNKS, totalChunks - 1), totalChunks)],
      fetchAsync
    );
    if (totalChunks > HEAD_CHUNKS) {
      // The tail names the last cross-reference section (`startxref`). Fetch all of it in one
      // round, rather than letting the parser discover it a chunk at a time.
      const xrefAt = this.startxref();
      if (xrefAt !== null && this.length - xrefAt <= MAX_READ_AHEAD_BYTES) {
        await this.#fetchAhead(this.#missing(Math.floor(xrefAt / this.chunkBytes), totalChunks), fetchAsync);
      }
    }
  }

  /**
   * The runs of bytes in chunks `firstChunk..endChunk` not held yet. A chunk a range brought
   * the start or end of needs only the rest.
   */
  #missing(firstChunk: number, endChunk: number): Range[] {
    const runs: Range[] = [];
    for (let chunk = firstChunk; chunk < endChunk; chunk++) {
      if (this.#has(chunk)) {
        continue;
      }
      let start = chunk * this.chunkBytes;
      let end =
        this.length > 0
          ? Math.min(this.length, start + this.chunkBytes)
          : start + this.chunkBytes;
      for (const piece of this.#pieces.get(chunk) ?? []) {
        const pieceEnd = piece.start + piece.bytes.byteLength;
        if (piece.start <= start) {
          start = Math.max(start, pieceEnd);
        } else {
          end = Math.min(end, piece.start);
        }
      }
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
   * `fetch` with what's left of each. A timeout that's the deadline's says so.
   */
  #round<T extends Answers | Promise<Answers>>(requests: Request[], fetch: (limit: number, timeoutMs: number) => T): T {
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
    const said = (error: unknown) =>
      passesTotal && (error as PdfError).code === "timeout" ? new PdfError("timeout", this.#passedTotal(), error) : error;
    try {
      const answers = fetch(this.#maxBytes - this.#bytesFetched, passesTotal ? Math.ceil(left) : this.#timeoutMs);
      return (answers instanceof Promise ? answers.catch((error: unknown) => Promise.reject(said(error))) : answers) as T;
    } catch (error) {
      throw said(error);
    }
  }

  #passedTotal(): string {
    return `the ranged read passed its ${this.#totalTimeoutMs} ms (totalTimeoutMs)`;
  }

  /** Checks and keeps a round's answers; a suffix nobody answered is skipped. */
  #absorb(answers: Answers): void {
    for (const answer of answers) {
      if (!answer) {
        continue;
      }
      this.#requests += 1;
      this.#bytesFetched += answer.received;
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
    // Whole chunks are kept as views, not copies; a chunk the answer has only part of is kept
    // as a piece until the rest arrives.
    const { bytes, start } = answer;
    if (this.#chunks.length === 0) {
      this.#chunks = Array.from<Uint8Array | undefined>({
        length: Math.ceil(answer.length / this.chunkBytes),
      });
    }
    const end = start + bytes.byteLength;
    for (let chunk = Math.floor(start / this.chunkBytes); chunk * this.chunkBytes < end; chunk++) {
      if (this.#has(chunk)) {
        continue;
      }
      const from = chunk * this.chunkBytes;
      const to = Math.min(from + this.chunkBytes, answer.length);
      const part = bytes.subarray(Math.max(from, start) - start, Math.min(to, end) - start);
      if (from >= start && to <= end) {
        this.#chunks[chunk] = part;
        continue;
      }
      const pieces = this.#pieces.get(chunk) ?? [];
      pieces.push({ start: Math.max(from, start), bytes: part });
      pieces.sort((a, b) => a.start - b.start);
      // Whole once its pieces meet end to end.
      let at = from;
      for (const piece of pieces) {
        if (piece.start > at) {
          break;
        }
        at = Math.max(at, piece.start + piece.bytes.byteLength);
      }
      if (at >= to) {
        const whole = new Uint8Array(to - from);
        for (const piece of pieces) {
          whole.set(piece.bytes.subarray(0, Math.min(piece.bytes.byteLength, to - piece.start)), piece.start - from);
        }
        this.#chunks[chunk] = whole;
        this.#pieces.delete(chunk);
      } else {
        this.#pieces.set(chunk, pieces);
      }
    }
  }

  /**
   * `failure`, or when what's held shows the file isn't a PDF (see `notPdfBytes`), that it isn't: an
   * error or sign-in page fails to parse, or runs into `maxBytes`, and neither says why. Only when
   * enough of the first KiB is held to tell.
   */
  explain(failure: unknown): unknown {
    if (!(failure instanceof PdfError && (failure.code === "invalid-file" || overBudget.has(failure)))) {
      return failure;
    }
    // The chunks held from the start on, at least the first KiB's worth when chunks are smaller.
    const parts: Uint8Array[] = [];
    let held = 0;
    for (let chunk = 0; held < Math.max(HEADER_BYTES, this.chunkBytes) && this.#chunks[chunk]; chunk++) {
      parts.push(this.#chunks[chunk]!);
      held += this.#chunks[chunk]!.byteLength;
    }
    const head = parts.length > 0 ? concat(...parts) : this.#pieces.get(0)?.find((piece) => piece.start === 0)?.bytes;
    return head && head.byteLength >= Math.min(HEADER_BYTES, this.length) && notPdfBytes(head, this.#chunks.at(-1))
      ? notPdf(failure)
      : failure;
  }

  /**
   * The `startxref` offset in the fetched last chunk, if it names one. Null for a linearized
   * file, whose trailer points at the first-page section near the head.
   */
  startxref(): number | null {
    const first = this.#chunks[0];
    const last = this.#chunks.at(-1);
    if (!first || !last || latin1(first.subarray(0, HEADER_BYTES)).includes("/Linearized")) {
      return null;
    }
    const tail = latin1(last.subarray(-1024));
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
      // Asked for, so the reader doesn't hold it (a document reopened on a fresh instance reads all again).
      this.#delivered.delete(chunk);
    }
    for (let chunk = first; chunk <= last; chunk++) {
      if (!this.#chunks[chunk]) {
        try {
          this.#fetchChunks(...this.#window(chunk, last, lastAhead));
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
    // The engine copies what it reads into its own buffer and never asks for it again, so a whole
    // chunk it has is dropped here: the file is held once, as a whole-file open holds it. It's
    // fetched again only if the document has to be reopened on a fresh instance. The first KiB and the
    // last chunk stay: they're what tells a file that isn't a PDF (`explain`).
    const keptHead = Math.ceil(HEADER_BYTES / this.chunkBytes);
    for (let chunk = Math.max(first, keptHead); chunk <= Math.min(last, this.#chunks.length - 2); chunk++) {
      if (chunk * this.chunkBytes >= offset && Math.min((chunk + 1) * this.chunkBytes, this.length) <= end) {
        this.#chunks[chunk] = undefined;
        this.#delivered.add(chunk);
      }
    }
    return true;
  }

  /** Whether chunk `chunk` is held here or by the reader. */
  #has(chunk: number): boolean {
    return this.#chunks[chunk] !== undefined || this.#delivered.has(chunk);
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
  try {
    await loader.begin(asyncFetcherFor(source));
  } catch (error) {
    throw loader.explain(error);
  }
  return loader;
}

/**
 * A ranged read already under way (`startRangedRead`), which `openRanged` takes in place of a URL.
 * Opaque: it only stands for the read.
 */
export type PdfRangedRead = { readonly kind: "ranged-read" };

const startedReads = new WeakMap<PdfRangedRead, { source: string | Uint8Array; loader: Promise<RangeLoader> }>();

/**
 * Starts reading `source` by range now, before there is an engine to open it with: its first round
 * (the head and the tail) goes out at once, so it overlaps the engine's own download. Open it with
 * `engine.openRanged(read)`; these options are the read's, and only `password` is taken at the open.
 */
export function startRangedRead(source: PdfRangeSource, options: PdfRangedOpenOptions = {}): PdfRangedRead {
  const owned = ownedSource(source);
  const loader = startRangeLoader(owned, options);
  // The open reports a failure; a read nobody opens must not be an unhandled rejection.
  loader.catch(() => {});
  const read: PdfRangedRead = Object.freeze({ kind: "ranged-read" });
  startedReads.set(read, { source: owned, loader });
  return read;
}

/** The read `startRangedRead` started, or null for any other source. */
export function startedRead(source: unknown): { source: string | Uint8Array; loader: Promise<RangeLoader> } | null {
  return typeof source === "object" && source !== null ? (startedReads.get(source as PdfRangedRead) ?? null) : null;
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
        const { start, end } = asked(request, bytes.byteLength);
        return { start, bytes: bytes.subarray(start, end), length: bytes.byteLength, etag: null, status: 206, received: end - start };
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

/** The bytes `request` asks for of a file of `length`, or of a range with `yieldTail`, those it reads. */
function asked(request: Request, length: number): Range {
  if ("suffix" in request) {
    return { start: Math.max(0, length - request.suffix), end: length };
  }
  const end = Math.min(request.end, length);
  return { start: request.start, end: request.yieldTail === undefined ? end : Math.min(end, Math.max(request.start, length - request.yieldTail)) };
}

/** How much of a 206 answer to `request` to read, from its total; past it is the suffix's. */
function readsOf(request: Request, contentRange: string | null): { most: number; exact: boolean } {
  const size = "suffix" in request ? request.suffix : request.end - request.start;
  const total = Number(/\/(\d+)$/u.exec(contentRange?.trim() ?? "")?.[1] ?? Number.NaN);
  if ("suffix" in request || request.yieldTail === undefined || !(total >= 0)) {
    return { most: size, exact: false };
  }
  const most = Math.max(0, Math.min(size, asked(request, total).end - request.start));
  return { most, exact: most < size };
}

function rangeHeader(request: Request): string {
  return "suffix" in request ? `bytes=-${request.suffix}` : `bytes=${request.start}-${request.end - 1}`;
}

/** The budget's failures, which bytes that aren't a PDF explain better; not the address space's. */
const overBudget = new WeakSet<PdfError>();

function tooLarge(maxBytes: number): PdfError {
  const error = new PdfError("too-large", `the ranged read would pass ${maxBytes} bytes (maxBytes); raise it or fetch the file whole`);
  overBudget.add(error);
  return error;
}

/** How far into a file a reader looks for its `%PDF` header. */
const HEADER_BYTES = 1024;

function latin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

/**
 * Whether a file's first and last bytes show it isn't a PDF: no `%PDF` where a reader looks for it,
 * and no `endobj` or `startxref` either, which a damaged PDF that lost its header still has.
 */
function notPdfBytes(head: Uint8Array, tail: Uint8Array | undefined): boolean {
  const syntax = (bytes: Uint8Array) => /endobj|startxref/u.test(latin1(bytes));
  return !latin1(head.subarray(0, HEADER_BYTES)).includes("%PDF") && !syntax(head) && !(tail && syntax(tail));
}

function notPdf(cause?: unknown): PdfError {
  return new PdfError("invalid-file", `not a PDF: no %PDF header in its first ${HEADER_BYTES} bytes (an error or sign-in page?)`, cause);
}

/** A non-2xx answer: its status says more than anything read from its body would. */
function httpFailure(status: number): PdfError {
  return new PdfError("fetch-failed", `the server answered HTTP ${status}, not the file`, undefined, status);
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
  limit: number,
  received = bytes.byteLength
): Answer {
  if (status === 200 && !("suffix" in range)) {
    // The server ignored Range and sent the whole file: use it, while the budget allows.
    if (bytes.byteLength > limit) {
      if (notPdfBytes(bytes.subarray(0, 1 << 16), bytes.subarray(-(1 << 16)))) {
        throw notPdf();
      }
      throw new PdfError(
        "too-large",
        `the server does not answer Range requests, and the whole file is past the ${limit} bytes left of maxBytes`
      );
    }
    return { start: 0, bytes, length: bytes.byteLength, etag, status, received };
  }
  if (status !== 206) {
    throw httpFailure(status);
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
  const want = asked(range, length);
  // A range that would stop where the suffix starts runs on to its end when the suffix failed.
  const whole = "suffix" in range ? want : asked({ start: range.start, end: range.end }, length);
  if (start !== want.start || (bytes.byteLength !== want.end - want.start && bytes.byteLength !== whole.end - whole.start)) {
    throw new PdfError(
      "fetch-failed",
      `the server answered a different range than asked (asked ${want.start}-${want.end - 1}, got ${bytes.byteLength} bytes from ${start})`,
      undefined,
      status
    );
  }
  return { start, bytes, length, etag, status, received };
}

/** A suffix's answer, or null if it isn't one: the tail is then asked for by its offset. */
function suffixAnswerOf(
  suffix: Suffix,
  status: number,
  contentRange: string | null,
  etag: string | null,
  bytes: Uint8Array,
  received = bytes.byteLength
): Answer | null {
  if (status !== 206) {
    return null;
  }
  try {
    return answerOf(suffix, status, contentRange, etag, bytes, Number.POSITIVE_INFINITY, received);
  } catch {
    return null;
  }
}

const NO_ANSWER = "the ranged read failed: the network, or a cross-origin server that does not allow it";

/** A read's miss in a browser worker. The rounds with a suffix go through `fetch`, before the parse. */
function fetchOverXhr(url: string, ranges: Request[], timeoutMs: number, limit: number): Answers {
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
 * parallel. Used before the parse starts, when this thread may await. A suffix still out when the
 * ranges are in gets as long again as they took, then counts as unanswered.
 */
async function fetchOverFetch(url: string, requests: Request[], timeoutMs: number, limit: number): Promise<(Answer | null)[]> {
  const started = performance.now();
  const controllers = requests.map(() => new AbortController());
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    for (const controller of controllers) {
      controller.abort();
    }
  }, timeoutMs);
  const failure = (error: unknown) =>
    timedOut
      ? new PdfError("timeout", `the ranged read timed out after ${timeoutMs} ms`, error)
      : new PdfError("fetch-failed", NO_ANSWER, error);
  // What the suffix came to, for a head that stopped where it starts: kept short only if it's good.
  let suffixDone!: (answer: Answer | null) => void;
  const suffixAnswer = new Promise<Answer | null>((resolve) => (suffixDone = resolve));
  const suffixAt = requests.findIndex((request) => "suffix" in request);
  const one = async (request: Request, signal: AbortSignal): Promise<Answer | null> => {
    const suffix = "suffix" in request;
    try {
      const response = await fetch(url, { headers: { Range: rangeHeader(request) }, signal });
      const contentRange = response.headers.get("Content-Range");
      const etag = response.headers.get("ETag");
      if (suffix && response.status !== 206) {
        // Not a suffix: a whole file, or a refusal. Read none of it.
        await response.body?.cancel();
        suffixDone(null);
        return null;
      }
      if (!response.ok) {
        // An error page: its status is the answer, and its body isn't worth downloading.
        await response.body?.cancel();
        throw httpFailure(response.status);
      }
      const reader = byteReader(response.body);
      try {
        if (response.status !== 206) {
          // A whole file, used if it fits the budget: read no further than one byte past it.
          const bytes = await reader.read(limit + 1);
          return answerOf(request, response.status, contentRange, etag, bytes, limit, reader.received);
        }
        const { most, exact } = readsOf(request, contentRange);
        let bytes = await reader.read(exact ? most : most + 1);
        if (suffix) {
          const answer = suffixAnswerOf(request, response.status, contentRange, etag, bytes, reader.received);
          suffixDone(answer);
          return answer;
        }
        if (exact && !("suffix" in request)) {
          // Stopped where the suffix starts: the rest too, unless the suffix brings it.
          const total = Number(contentRange?.trim().split("/").pop());
          const answer = await Promise.race([suffixAnswer, delay(suffixGrace(performance.now() - started), null)]);
          if (answer?.length !== total) {
            controllers[suffixAt]?.abort();
            const rest = await reader.read(request.end - request.start - most + 1);
            bytes = concat(bytes, rest);
          }
        }
        return answerOf(request, response.status, contentRange, etag, bytes, limit, reader.received);
      } finally {
        await reader.cancel();
      }
    } catch (error) {
      // A suffix never fails the round: the tail is then asked for by its offset.
      if (suffix) {
        suffixDone(null);
        return null;
      }
      throw error instanceof PdfError ? error : failure(error);
    }
  };
  try {
    const ranges = Promise.all(requests.map((request, i) => ("suffix" in request ? null : one(request, controllers[i]!.signal))));
    const suffixes = requests.map((request, i) => {
      if (!("suffix" in request)) {
        return null;
      }
      return one(request, controllers[i]!.signal);
    });
    const answers = await ranges;
    const grace = suffixGrace(performance.now() - started);
    return await Promise.all(
      requests.map(async (request, i) => {
        const pending = suffixes[i];
        if (!pending) {
          return answers[i]!;
        }
        let late: ReturnType<typeof setTimeout> | undefined;
        const giveUp = new Promise<null>((resolve) => {
          late = setTimeout(() => {
            controllers[i]!.abort();
            resolve(null);
          }, grace);
        });
        try {
          return await Promise.race([pending, giveUp]);
        } finally {
          clearTimeout(late);
        }
      })
    );
  } finally {
    clearTimeout(timer);
    // A round that failed leaves nothing downloading.
    for (const controller of controllers) {
      controller.abort();
    }
  }
}

/**
 * How long a suffix may still take once the round's ranges are in, `took` after they went out:
 * as long again, and at least a quarter second, since both went out together. Past it the tail
 * is asked for by its offset, a round later, as a server that refuses suffixes gets it.
 */
function suffixGrace(took: number): number {
  return Math.max(took, 250);
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * A body read a given number of bytes at a time: exactly, by a reader that fills a buffer where the
 * stream has one, or by parts, keeping what a part held past the count for the next read.
 * `received` counts every byte taken off the stream.
 */
function byteReader(body: ReadableStream<Uint8Array> | null) {
  let byob: ReadableStreamBYOBReader | null = null;
  try {
    byob = body?.getReader({ mode: "byob" }) ?? null;
  } catch {
    // Not a byte stream: read by parts.
  }
  const plain = byob || !body ? null : body.getReader();
  let spare: Uint8Array = new Uint8Array(0);
  let done = !body;
  let received = 0;
  return {
    get received() {
      return received;
    },
    async read(n: number): Promise<Uint8Array> {
      // In parts of at most 1 MiB, so a large `n` (a budget) allocates only what arrives.
      const parts: Uint8Array[] = [spare.subarray(0, n)];
      let got = parts[0]!.byteLength;
      spare = spare.subarray(got);
      while (got < n && !done) {
        if (byob) {
          const { value, done: end } = await byob.read(new Uint8Array(Math.min(n - got, 1 << 20)));
          if (value) {
            parts.push(value);
            got += value.byteLength;
            received += value.byteLength;
          }
          done = end;
        } else {
          const { value, done: end } = await plain!.read();
          if (end) {
            done = true;
            break;
          }
          received += value.byteLength;
          const take = Math.min(n - got, value.byteLength);
          parts.push(value.subarray(0, take));
          got += take;
          spare = value.subarray(take);
        }
      }
      return parts.length === 1 ? parts[0]! : concat(...parts);
    },
    async cancel(): Promise<void> {
      await (byob ?? plain)?.cancel().catch(() => undefined);
    },
  };
}

// The fetcher thread: plain JS (eval), so it needs no loader or bundler entry. It answers
// each request on the port, then bumps `flag` so the waiting thread wakes. The body is read
// up to `limit`, for a server that answers a small range with a huge whole file.
const FETCHER_SOURCE = `
const { workerData } = require("node:worker_threads");
const { port, flag } = workerData;
const controllers = new Map();
const suffixes = new Map();
// What a group's suffix came to: its file's total if it's a good suffix, null otherwise.
function outcome(group) {
  let entry = suffixes.get(group);
  if (!entry) {
    let resolve;
    entry = { promise: new Promise((r) => (resolve = r)) };
    entry.resolve = resolve;
    suffixes.set(group, entry);
  }
  return entry;
}
async function get(m, signal) {
  const started = performance.now();
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
    if (m.suffix) outcome(m.group).resolve(null);
    return { ...reply, bytes: new ArrayBuffer(0), received: 0 };
  }
  const reader = response.body ? response.body.getReader({ mode: "byob" }) : null;
  let received = 0;
  let done = !reader;
  const read = async (n) => {
    const parts = [];
    let got = 0;
    while (got < n && !done) {
      const { value, done: end } = await reader.read(new Uint8Array(Math.min(n - got, 1 << 20)));
      if (value) { parts.push(value); got += value.byteLength; received += value.byteLength; }
      done = end;
    }
    return Buffer.concat(parts, got);
  };
  try {
    // A 206 is read as far as the range runs (see readsOf), and a byte past to catch a longer one;
    // a whole file, to a byte past the limit (answerOf says which).
    if (response.status !== 206) {
      const bytes = await read(m.limit + 1);
      return { ...reply, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), received };
    }
    const total = Number((reply.contentRange || "").trim().split("/").pop());
    let most = m.size;
    let exact = false;
    if (m.yieldTail !== undefined && total >= 0) {
      most = Math.max(0, Math.min(m.size, Math.min(m.end, Math.max(m.start, total - m.yieldTail)) - m.start));
      exact = most < m.size;
    }
    let bytes = await read(exact ? most : most + 1);
    if (m.suffix) {
      const [from, , length] = (reply.contentRange || "").trim().replace("bytes ", "").split(/[-/]/).map(Number);
      const good = from === Math.max(0, length - m.size) && bytes.byteLength === length - from;
      outcome(m.group).resolve(good ? length : null);
    } else if (exact) {
      // Stopped where the suffix starts: the rest too, unless the suffix brings it.
      const grace = Math.max(performance.now() - started, 250);
      const late = new Promise((r) => setTimeout(() => r(null), grace));
      if ((await Promise.race([outcome(m.group).promise, late])) !== total) {
        const suffix = controllers.get(m.suffixId);
        if (suffix) suffix.abort();
        bytes = Buffer.concat([bytes, await read(m.size - most + 1)]);
      }
    }
    return { ...reply, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), received };
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    if (m.suffix) outcome(m.group).resolve(null);
    if (!m.suffix) suffixes.delete(m.group);
  }
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
  received: number;
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
  const started = performance.now();
  const deadline = started + timeoutMs;
  let suffixDeadline = Number.POSITIVE_INFINITY;
  let expired = false;
  const pending = new Map<number, Request>();
  const order = new Map<Request, number>();
  // A round's ranges and its suffix are one group: a range that stops where the suffix starts
  // waits on what the suffix came to (see FETCHER_SOURCE).
  const group = current.nextId;
  const suffixId = current.nextId + ranges.findIndex((range) => "suffix" in range);
  for (const range of ranges) {
    const id = current.nextId++;
    pending.set(id, range);
    order.set(range, order.size);
    // A suffix's answer is read no further than the suffix: past it, it isn't one.
    const suffix = "suffix" in range;
    current.port.postMessage({
      id,
      url,
      range: rangeHeader(range),
      suffix,
      limit: suffix ? Math.min(range.suffix, limit) : limit,
      size: suffix ? Math.min(range.suffix, limit) : range.end - range.start,
      start: suffix ? 0 : range.start,
      end: suffix ? 0 : range.end,
      yieldTail: suffix ? undefined : range.yieldTail,
      group,
      suffixId,
    });
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
          reply.failed === undefined
            ? suffixAnswerOf(range, reply.status, reply.contentRange, reply.etag, new Uint8Array(reply.bytes), reply.received)
            : null;
        continue;
      }
      try {
        if (reply.failed !== undefined) {
          throw new PdfError("fetch-failed", `the ranged read failed: ${reply.failed}`);
        }
        answers[order.get(range)!] = answerOf(range, reply.status, reply.contentRange, reply.etag, new Uint8Array(reply.bytes), limit, reply.received);
      } catch (error) {
        failure ??= error as PdfError;
      }
    }
    if (pending.size === 0) {
      break;
    }
    // Only suffixes left: they get a grace, then count as unanswered (suffixGrace).
    const now = performance.now();
    if (suffixDeadline === Number.POSITIVE_INFINITY && [...pending.values()].every((request) => "suffix" in request)) {
      suffixDeadline = now + suffixGrace(now - started);
    }
    const until = Math.min(suffixDeadline, deadline);
    if (now < until && Atomics.wait(current.flag, 0, seen, until - now) !== "timed-out") {
      seen = Atomics.load(current.flag, 0);
      continue;
    }
    if (expired) {
      for (const id of pending.keys()) {
        current.port.postMessage({ id, abort: true });
      }
      if ([...pending.values()].every((request) => "suffix" in request)) {
        break; // the suffixes stay unanswered
      }
      throw new PdfError(
        "timeout",
        `the ranged read timed out after ${timeoutMs} ms. This thread is blocked while it waits, so a server running on the same thread can never answer; run the read on a worker thread.`
      );
    }
    // Once more through what arrived, then give up.
    expired = true;
    seen = Atomics.load(current.flag, 0);
  }
  if (failure) {
    throw failure;
  }
  return answers;
}
