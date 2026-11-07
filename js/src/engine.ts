// The per-thread engine: owns one WebAssembly instance and replaces it when it trapped or
// its memory grew past the recycle mark (WebAssembly memory never shrinks). Past the mark, the
// instance goes as soon as its last document closes; documents still open on an instance keep it.

import { createGlue } from "../wasm/recto.gen.mjs";
import {
  type AssetName,
  assetBaseUrl,
  canReadSync,
  hasFiles,
  fontFromBundle,
  type WasmName,
  compileWasm,
  loadAssetSync,
  preloadAssets,
  type SyncHash,
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
   * replaced at the next open if one is still open. Default 64 MiB. */
  recycleAboveBytes?: number;
  /**
   * Where a thread can't read a file synchronously (a page's main thread, a service worker), the
   * assets are fetched while the engine is created: by default all of them, 9.7 MB. Name fewer to
   * fetch less, and a call that needs one you left out fails with `missing-asset`: leave out
   * `recto.wasm` and `render` and `objects` do. Where assets can be read when needed, only
   * `recto.wasm` means anything: named, the engine starts on it, which saves the first `render`
   * moving there; left out, it starts on the text engine. A browser worker leaves it out by
   * default, and Node names it, having no download to save.
   */
  preloadAssets?: Exclude<AssetName, "recto-text.wasm">[];
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
const ALL_ASSETS = ["recto.wasm", "fonts.bin", "cmaps.deflate", "cjk-fallback.ttf"] as const;
const DEFAULT_RECYCLE_ABOVE_BYTES = 64 * 1024 * 1024;

/** Each wasm, verified and compiled once per thread, per location. */
const compiling = new Map<string, Promise<WebAssembly.Module>>();
const compiled = new Map<string, WebAssembly.Module>();
const moduleKey = (name: WasmName, base: URL | null) => `${name} ${base?.href ?? ""}`;

function compile(name: WasmName, base: URL | null): Promise<WebAssembly.Module> {
  const key = moduleKey(name, base);
  let module = compiling.get(key);
  if (!module) {
    module = compileWasm(name, base);
    module.then(
      (done) => compiled.set(key, done),
      () => compiling.delete(key)
    );
    compiling.set(key, module);
  }
  return module;
}

/** The full engine, from inside a synchronous call: a worker or Node reads it now. */
function fullModuleSync(base: URL | null, hash?: SyncHash): WebAssembly.Module {
  const key = moduleKey("recto.wasm", base);
  let module = compiled.get(key);
  if (!module) {
    module = new WebAssembly.Module(loadAssetSync("recto.wasm", base, hash) as Uint8Array<ArrayBuffer>);
    compiled.set(key, module);
  }
  return module;
}

/** An instance's own SHA-256, for an asset it needs: faster than JavaScript's in a cold browser. */
const hashOn =
  (instance: Instance): SyncHash =>
  (bytes) =>
    instance.dead ? null : Array.from(instance.glue.sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

function instantiate(generation: number, base: URL | null, module: WebAssembly.Module, full: boolean): Instance {
  // Each instance gets its own glue closure (scripts/package-wasm.mjs), so a retired
  // instance and its memory are collected with it.
  const glue = createGlue();
  const exports = glue.initSync({ module });
  const instance: Instance = {
    glue,
    full,
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
        return loadAssetSync("cmaps.deflate", base, hashOn(instance));
      }
      if (index === CJK_FONT_ASSET) {
        return loadAssetSync("cjk-fallback.ttf", base, hashOn(instance));
      }
      return fontFromBundle(loadAssetSync("fonts.bin", base, hashOn(instance)), index);
    } catch (error) {
      instance.dead = true;
      instance.failure = error as PdfError;
      return;
    }
  });
  return instance;
}

function bytesOf(input: Uint8Array | ArrayBuffer): Uint8Array {
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  // Not instanceof: an ArrayBuffer from another realm (a test runner's sandbox) is just as good.
  if (Object.prototype.toString.call(input) === "[object ArrayBuffer]") {
    return new Uint8Array(input);
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
  /** Once something asked for the full engine it's loaded anyway, so later documents start on it. */
  #full: boolean;
  readonly #base: URL | null;
  readonly #recycleAboveBytes: number;

  constructor(instance: Instance, base: URL | null, recycleAboveBytes: number) {
    this.#instance = instance;
    this.#full = instance.full;
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

  #ready(): Instance | null {
    const current = this.#instance;
    return current && !current.dead && current.memory.buffer.byteLength <= this.#recycleAboveBytes
      ? current
      : null;
  }

  async #live(): Promise<Instance> {
    const current = this.#instance;
    if (current && !current.dead && current.memory.buffer.byteLength <= this.#recycleAboveBytes) {
      return current;
    }
    const full = this.#full;
    this.#starting ??= compile(full ? "recto.wasm" : "recto-text.wasm", this.#base)
      .then((module) => instantiate(this.#generation + 1, this.#base, module, full))
      .finally(() => {
        this.#starting = null;
      });
    const started = await this.#starting;
    this.#adopt(started);
    return started;
  }

  #adopt(instance: Instance): void {
    this.#generation = instance.generation;
    this.#instance = instance;
    this.#watch(instance);
  }

  /** An instance that can draw, for a document moving onto it. Synchronous: `render` is. */
  #fullInstance(): Instance {
    const current = this.#instance;
    if (current?.full && !current.dead && current.memory.buffer.byteLength <= this.#recycleAboveBytes) {
      return current;
    }
    this.#full = true;
    const instance = instantiate(this.#generation + 1, this.#base, fullModuleSync(this.#base, current ? hashOn(current) : undefined), true);
    this.#adopt(instance);
    return instance;
  }

  // Async only so a bad argument rejects; everything up to the copy runs synchronously.
  async open(input: Uint8Array | ArrayBuffer, options: PdfOpenOptions = {}): Promise<PdfDocument> {
    // With an instance ready, the bytes go into its memory before the first await, and that's
    // the copy the promise needs: no second one of what may be a large file.
    const ready = this.#ready();
    const bytes = bytesOf(input);
    if (ready) {
      throwIfAborted(options.signal);
      return this.#openOn(ready, bytes, options);
    }
    return await this.openOwned(bytes.slice(), options);
  }

  /** `bytes` is this call's own: getting an instance can take an await. */
  async openOwned(bytes: Uint8Array, options: PdfOpenOptions): Promise<PdfDocument> {
    throwIfAborted(options.signal);
    return this.#openOn(await this.#live(), bytes, options);
  }

  #openOn(instance: Instance, bytes: Uint8Array, options: PdfOpenOptions): PdfDocument {
    const password = options.password ?? null;
    let doc: RectoDocument;
    try {
      doc = new RectoDocument(instance, new instance.glue.Document(bytes, password), (old) => {
        const full = this.#fullInstance();
        // The file goes straight from the old heap to the new one. The old stays whole until the new
        // has it, so a failure here leaves the document where it was.
        const file = new Uint8Array(instance.memory.buffer, old.filePointer(), old.fileLength());
        return { instance: full, doc: new full.glue.Document(file, password) };
      });
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
    const password = options.password ?? null;
    let doc: RectoDocument;
    try {
      doc = new RectoDocument(
        instance,
        instance.glue.Document.openRanged(loader.length, loader.chunkBytes, read, password),
        () => {
          // Nothing is fetched twice: the loader keeps what it read.
          const full = this.#fullInstance();
          return {
            instance: full,
            doc: full.glue.Document.openRanged(loader.length, loader.chunkBytes, read, password),
          };
        },
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
  // The text engine saves a download. Reading from disk there's none to save, and moving would
  // cost the first render, so the full engine. With no way to read it later, the same.
  const names = options.preloadAssets ?? (canReadSync() ? (hasFiles() ? ["recto.wasm" as const] : []) : ALL_ASSETS);
  if (!canReadSync()) {
    await preloadAssets(base, names.filter((asset) => asset !== "recto.wasm"));
  }
  const name: WasmName = names.includes("recto.wasm") ? "recto.wasm" : "recto-text.wasm";
  return new RectoEngine(
    instantiate(0, base, await compile(name, base), name === "recto.wasm"),
    base,
    options.recycleAboveBytes ?? DEFAULT_RECYCLE_ABOVE_BYTES
  );
}

let shared: Promise<RectoEngine> | null = null;
let sharedReady: RectoEngine | null = null;

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
  if (sharedReady) {
    return sharedReady.open(bytes, options);
  }
  // Getting the engine takes an await: the buffer has to be the caller's again before it.
  const owned = bytesOf(bytes).slice();
  if (!shared) {
    const starting = createEngine({});
    shared = starting;
    starting.then((engine) => {
      sharedReady = engine;
    }, () => {});
    // A failure is not kept: the next call tries again.
    starting.catch(() => {
      if (shared === starting) {
        shared = null;
      }
    });
  }
  return await (await shared).openOwned(owned, options);
}
