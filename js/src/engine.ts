// The per-thread engine: owns one WebAssembly instance and replaces it when it trapped or
// its memory grew past the recycle mark (WebAssembly memory never shrinks). Past the mark, the
// instance goes as soon as its last document closes; documents still open on an instance keep it.

import { createGlue } from "../wasm/recto.gen.mjs";
import {
  type AssetName,
  assetBaseUrl,
  canReadSync,
  fontFromBundle,
  compileWasm,
  loadAssetSync,
  preloadAssets,
} from "./assets.ts";
import {
  engineFailure,
  type Instance,
  type PdfDocument,
  RectoDocument,
} from "./document.ts";
import { PdfError } from "./errors.ts";
import {
  type PdfRangedDocument,
  type PdfRangedOpenOptions,
  ownedSource,
  type PdfRangeSource,
  startRangeLoader,
} from "./ranged.ts";

export type PdfEngineOptions = {
  /**
   * The directory holding the package's wasm/ files, for setups that move the package
   * without them (a bundler that does not rewrite `new URL`, a CDN). A URL in a browser; a
   * path or file: URL in Node. Defaults to the package's own wasm/ directory.
   */
  assetBase?: string | URL;
  /** Past this much linear memory, the instance is dropped when its last document closes, or
   * replaced at the next open if one is still open. Default 512 MiB. */
  recycleAboveBytes?: number;
  /**
   * Where a thread can't read a file synchronously (a page's main thread, a service worker), the
   * assets are fetched while the engine is created: by default all of them, 5.6 MB. Name fewer to
   * fetch less, and a document that needs one you left out fails with `missing-asset`. Ignored
   * where assets can be read when needed.
   */
  preloadAssets?: Exclude<AssetName, "recto.wasm">[];
};

export type PdfOpenOptions = {
  password?: string;
  /** Checked before the open. */
  signal?: AbortSignal;
};

export type PdfEngineStats = {
  heapBytes: number;
  /** Increments every time the instance is replaced. heapBytes is 0 while there is none. */
  generation: number;
  openDocuments: number;
};

/** One instance per thread is enough; several documents can be open on it. */
export interface PdfEngine {
  /**
   * Opens a PDF held in memory. The bytes are copied before this returns its promise, so the
   * caller may reuse, change or transfer its buffer straight away, without waiting for it.
   */
  open(bytes: Uint8Array | ArrayBuffer, options?: PdfOpenOptions): Promise<PdfDocument>;
  /**
   * Opens a PDF read by byte range, fetching only what the engine parses. Every read of it
   * can block this thread for a network round trip; see `timeoutMs`.
   */
  openRanged(source: PdfRangeSource, options?: PdfRangedOpenOptions): Promise<PdfRangedDocument>;
  stats(): PdfEngineStats;
}

const CJK_FONT_ASSET = 14;
const CMAPS_ASSET = 15;
const DEFAULT_RECYCLE_ABOVE_BYTES = 512 * 1024 * 1024;

/** The wasm, verified and compiled once per thread, per location. */
const compiled = new Map<string, Promise<WebAssembly.Module>>();

function compile(base: URL | null): Promise<WebAssembly.Module> {
  const key = base?.href ?? "";
  let module = compiled.get(key);
  if (!module) {
    module = compileWasm(base);
    module.catch(() => compiled.delete(key));
    compiled.set(key, module);
  }
  return module;
}

async function instantiate(generation: number, base: URL | null): Promise<Instance> {
  const module = await compile(base);
  // Each instance gets its own glue closure (scripts/package-wasm.mjs), so a retired
  // instance and its memory are collected with it.
  const glue = createGlue();
  const exports = glue.initSync({ module });
  const instance: Instance = {
    glue,
    memory: exports.memory,
    generation,
    openDocuments: 0,
    dead: false,
    failure: undefined,
  };
  // The engine asks for a built-in font (0..13), the CJK fallback or its predefined CMaps
  // the first time a document needs one. It reads a throw as a missing asset, which would
  // be blank text, so keep the error for the call in progress to rethrow, and retire the
  // instance so the next open tries again.
  glue.setAssetLoader((index) => {
    try {
      if (index === CMAPS_ASSET) {
        return loadAssetSync("cmaps.brotli", base);
      }
      if (index === CJK_FONT_ASSET) {
        return loadAssetSync("cjk-fallback.ttf", base);
      }
      return fontFromBundle(loadAssetSync("fonts.bin", base), index);
    } catch (error) {
      instance.dead = true;
      instance.failure = error as PdfError;
      return;
    }
  });
  return instance;
}

/**
 * A copy of the caller's bytes, taken before anything asynchronous, so the buffer is theirs
 * again the moment the call returns its promise. (The engine then copies them into WebAssembly
 * memory, so the file is held twice for the length of the open.)
 */
function ownedBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
  }
  // Not instanceof: an ArrayBuffer from another realm (a test runner's sandbox) is just as good.
  if (Object.prototype.toString.call(input) === "[object ArrayBuffer]") {
    return new Uint8Array(input).slice();
  }
  throw new TypeError("expected the PDF's bytes as a Uint8Array, Buffer or ArrayBuffer");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new PdfError("aborted", "the signal was aborted", signal.reason);
  }
}

class RectoEngine implements PdfEngine {
  #instance: Instance | null;
  #generation: number;
  #starting: Promise<Instance> | null = null;
  readonly #base: URL | null;
  readonly #recycleAboveBytes: number;

  constructor(instance: Instance, base: URL | null, recycleAboveBytes: number) {
    this.#instance = instance;
    this.#generation = instance.generation;
    this.#base = base;
    this.#recycleAboveBytes = recycleAboveBytes;
    this.#watch(instance);
  }

  /** Memory only comes back with the instance, so don't keep one past the mark with nothing on it. */
  #watch(instance: Instance): void {
    instance.onClose = () => {
      if (
        this.#instance === instance &&
        instance.openDocuments === 0 &&
        instance.memory.buffer.byteLength > this.#recycleAboveBytes
      ) {
        this.#instance = null;
      }
    };
  }

  async #live(): Promise<Instance> {
    const current = this.#instance;
    if (current && !current.dead && current.memory.buffer.byteLength <= this.#recycleAboveBytes) {
      return current;
    }
    this.#starting ??= instantiate(this.#generation + 1, this.#base).finally(() => {
      this.#starting = null;
    });
    const started = await this.#starting;
    this.#generation = started.generation;
    this.#instance = started;
    this.#watch(started);
    return started;
  }

  // Async only so a bad argument rejects; everything up to the copy runs synchronously.
  async open(input: Uint8Array | ArrayBuffer, options: PdfOpenOptions = {}): Promise<PdfDocument> {
    return await this.openOwned(ownedBytes(input), options);
  }

  /** `bytes` is this call's own: getting an instance can take an await. */
  async openOwned(bytes: Uint8Array, options: PdfOpenOptions): Promise<PdfDocument> {
    throwIfAborted(options.signal);
    const instance = await this.#live();
    let doc: RectoDocument;
    try {
      doc = new RectoDocument(
        instance,
        new instance.glue.Document(bytes, options.password ?? null)
      );
    } catch (error) {
      throw engineFailure(instance, error);
    }
    if (instance.failure) {
      throw instance.failure;
    }
    return doc;
  }

  async openRanged(
    source: PdfRangeSource,
    options: PdfRangedOpenOptions = {}
  ): Promise<PdfRangedDocument> {
    if (!canReadSync()) {
      throw new PdfError(
        "wrong-thread",
        "a ranged read blocks its thread on the network, which this thread can't do. Open it in a " +
          'dedicated Web Worker: new Worker(new URL("./pdf-worker.js", import.meta.url), { type: "module" }).'
      );
    }
    const owned = ownedSource(source);
    const instance = await this.#live();
    const loader = startRangeLoader(owned, options);
    const read = (offset: number, length: number) => {
      const out = new Uint8Array(length);
      return loader.read(offset, out) ? out : undefined;
    };
    let doc: RectoDocument;
    try {
      doc = new RectoDocument(
        instance,
        instance.glue.Document.openRanged(
          loader.length,
          loader.chunkBytes,
          read,
          options.password ?? null
        ),
        () => loader.failure
      );
    } catch (error) {
      if (loader.failure && !(error instanceof WebAssembly.RuntimeError)) {
        throw loader.failure;
      }
      throw engineFailure(instance, error);
    }
    if (loader.failure) {
      doc.close();
      throw loader.failure;
    }
    return Object.assign(doc, { stats: () => loader.stats() });
  }

  stats(): PdfEngineStats {
    return {
      heapBytes: this.#instance?.memory.buffer.byteLength ?? 0,
      generation: this.#generation,
      openDocuments: this.#instance?.openDocuments ?? 0,
    };
  }
}

export async function createPdfEngine(options: PdfEngineOptions = {}): Promise<PdfEngine> {
  return await createEngine(options);
}

async function createEngine(options: PdfEngineOptions): Promise<RectoEngine> {
  const base = assetBaseUrl(options.assetBase);
  if (!canReadSync()) {
    await preloadAssets(base, options.preloadAssets ?? ["fonts.bin", "cmaps.brotli", "cjk-fallback.ttf"]);
  }
  return new RectoEngine(
    await instantiate(0, base),
    base,
    options.recycleAboveBytes ?? DEFAULT_RECYCLE_ABOVE_BYTES
  );
}

let shared: Promise<RectoEngine> | null = null;

/**
 * Opens a PDF on this thread's shared engine:
 *
 *   await using doc = await openPdf(bytes);
 *   doc.pageCount; doc.text(0); doc.render(0, { width: 1024 });
 */
export async function openPdf(
  bytes: Uint8Array | ArrayBuffer,
  options: PdfOpenOptions = {}
): Promise<PdfDocument> {
  const owned = ownedBytes(bytes);
  if (!shared) {
    const starting = createEngine({});
    shared = starting;
    // A failure is not kept: the next call tries again.
    starting.catch(() => {
      if (shared === starting) {
        shared = null;
      }
    });
  }
  return await (await shared).openOwned(owned, options);
}
