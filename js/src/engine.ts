// The per-thread engine: owns one WebAssembly instance and replaces it when it trapped or
// its memory grew past the recycle mark (WebAssembly memory never shrinks). Past the mark, the
// instance goes once nothing has been open on it for a moment, and a document still open on an
// instance keeps it.

import { PINS } from "../wasm/pins.mjs";
import { createGlue, PART_TABLE } from "../wasm/recto.gen.mjs";
import {
  type AssetName,
  assetBaseUrl,
  canReadSync,
  STANDARD_FONTS,
  type WasmName,
  compileWasm,
  loadAssetSync,
  preloadAssets,
  readCheckedSync,
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
  type PdfRangedRead,
  startedRead,
  startRangeLoader,
} from "./ranged.ts";

export type PdfEngineOptions = {
  /**
   * The directory holding the package's wasm/ files, for setups that move the package
   * without them (a bundler that does not rewrite `new URL`, a CDN). A URL in a browser; a
   * path or file: URL in Node. Defaults to the package's own wasm/ directory.
   */
  assetBase?: string | URL;
  /**
   * Past this much linear memory, the instance is dropped when its last document closes, or replaced
   * at the next open if one is still open. By default it's dropped a second after the last close, once
   * anything has used it, and an open before then reuses it; past 512 MiB, at the close; and past 64 MiB
   * with a document still open, the next open gets a new one.
   */
  recycleAboveBytes?: number;
  /**
   * The most bytes one stream may decode to, and one image hold at a byte a component. Past it, that
   * stream or image is left out and the page's results say `truncated`, so a few bytes that inflate to
   * gigabytes can't take the instance's memory. Default 768 MiB (a 600 dpi gray scan of an A0 page is
   * 558 MB); `Infinity` for none.
   */
  maxDecodedBytes?: number;
  /**
   * Files to fetch and verify while the engine is created, so that a missing one fails here and no later
   * call waits for it. `recto-render.wasm` saves the first `render` that wait; all three parts check the
   * whole engine at startup. The default is none, except where a thread can't read a file when it's needed
   * (a page's main thread, a service worker): there it's all of them, about 9.6 MB. Name fewer to fetch less, and
   * a call that needs a font or CMaps you left out fails with `missing-asset`. The parts are fetched there
   * whatever you name, so it can always draw.
   */
  preloadAssets?: (AssetName | "cmaps.brotli" | "fonts.bin")[];
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
  openRanged(source: PdfRangeSource | PdfRangedRead, options?: PdfRangedOpenOptions): Promise<PdfRangedDocument>;
  /**
   * Fetches and verifies assets (fonts, CMaps, wasm parts) ahead of the call that needs them, all at
   * once: a thread that reads each when it's needed waits a round trip for each, one after another.
   */
  preload(names: AssetName[]): Promise<void>;
  stats(): PdfEngineStats;
}

const CJK_FONT_ASSET = 14;
const CMAPS_ASSET = 15;
const PARTS = ["recto-render.wasm", "recto-more.wasm", "recto-rare.wasm"] as const;
type Part = (typeof PARTS)[number];
const ALL_ASSETS = [...STANDARD_FONTS, "cmaps.deflate", "cjk-fallback.ttf"] as const;
/**
 * Past this, an open with another document still open gets a new instance. Chosen from
 * bench/results/recycle.json: retiring at each close made a repeated large file slow.
 */
const IDLE_RECYCLE_ABOVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_RECYCLE_ABOVE_BYTES = 512 * 1024 * 1024;
const IDLE_MS = 1000;

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

/** recto.wasm for a pool to post its threads, which adopt it. */
export async function engineModule(base: string | undefined): Promise<WebAssembly.Module> {
  return await compile("recto.wasm", assetBaseUrl(base));
}

export function adoptEngineModule(base: string | undefined, module: WebAssembly.Module): void {
  const key = moduleKey("recto.wasm", assetBaseUrl(base));
  compiled.set(key, module);
  compiling.set(key, Promise.resolve(module));
}

/** A part, from inside a synchronous call. Hashed before it's compiled; this is the only way in but `compile`. */
function partModule(name: Part, base: URL | null, hash: SyncHash): WebAssembly.Module {
  const key = moduleKey(name, base);
  let module = compiled.get(key);
  if (!module) {
    module = new WebAssembly.Module(readCheckedSync(name, base, hash) as Uint8Array<ArrayBuffer>);
    compiled.set(key, module);
  }
  return module;
}

/** An instance's own SHA-256, for an asset it needs: faster than JavaScript's in a cold browser. */
export function hashOn(instance: Pick<Instance, "dead" | "glue">): SyncHash {
  return (bytes) => {
    // A function the hash itself runs may be in a part, and that part's check can't use this hash.
    if (instance.dead || hashing.has(instance)) {
      return null;
    }
    hashing.add(instance);
    try {
      return Array.from(instance.glue.sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } finally {
      hashing.delete(instance);
    }
  };
}
const hashing = new WeakSet<object>();

function instantiate(
  generation: number,
  base: URL | null,
  module: WebAssembly.Module,
  maxDecodedBytes: number | undefined,
  documents: { open: number } = { open: 0 }
): Instance {
  const parts = new Set<Part>();
  // A function of a part that isn't loaded yet: load it, then make the call this was meant to be. A
  // failure unwinds the engine's frames with its state half-done, so no call can follow on this
  // instance. What was open on it reopens on another, at its next call.
  const placeholders = (name: Part) =>
    new Proxy(
      {},
      {
        get: (_, slot) =>
          (...args: unknown[]) => {
            try {
              instance.loadPart(name);
            } catch (error) {
              instance.abandoned = true;
              throw error;
            }
            const table = exports[PART_TABLE as keyof typeof exports] as unknown as WebAssembly.Table;
            return (table.get(Number(slot)) as (...args: unknown[]) => unknown)(...args);
          },
      }
    );
  // Each instance gets its own glue closure (scripts/package-wasm.mjs), so a retired
  // instance and its memory are collected with it.
  const glue = createGlue(
    {
      "part.recto-render": placeholders("recto-render.wasm"),
      "part.recto-more": placeholders("recto-more.wasm"),
      "part.recto-rare": placeholders("recto-rare.wasm"),
    },
    // Something never closed, freed by the collector. Nothing can run on an abandoned instance, which goes
    // whole; and a free that needs a part it can't get has nobody to tell, and mustn't be an uncaught error.
    (free) => {
      if (instance.abandoned || instance.dead) {
        return;
      }
      try {
        free();
      } catch {
        instance.abandoned = true;
      }
    }
  );
  const exports = glue.initSync({ module });
  const instance: Instance = {
    glue,
    loadPart(name) {
      if (!parts.has(name)) {
        // Its table entries replace its placeholders.
        new WebAssembly.Instance(partModule(name, base, hashOn(instance)), { primary: exports as unknown as WebAssembly.ModuleImports });
        parts.add(name);
      }
    },
    memory: exports.memory,
    startBytes: exports.memory.buffer.byteLength,
    generation,
    openDocuments: 0,
    documents,
    dead: false,
    abandoned: false,
    failure: undefined,
  };
  // The engine asks for a built-in font (0..13), the CJK fallback or its predefined CMaps
  // the first time a document needs one. It reads a throw as a missing asset, which would
  // be blank text, so keep the error for the call in progress to rethrow, and leave the instance
  // so the next call tries again.
  glue.setAssetLoader((index) => {
    try {
      if (index === CMAPS_ASSET) {
        return loadAssetSync("cmaps.deflate", base, hashOn(instance));
      }
      if (index === CJK_FONT_ASSET) {
        return loadAssetSync("cjk-fallback.ttf", base, hashOn(instance));
      }
      return loadAssetSync(STANDARD_FONTS[index]!, base, hashOn(instance));
    } catch (error) {
      instance.abandoned = true;
      instance.failure = error as PdfError;
      return;
    }
  });
  if (maxDecodedBytes !== undefined) {
    glue.setMaxDecodedBytes(maxDecodedBytes);
  }
  if (!warmed.has(module)) {
    warmed.add(module);
    warmUp(glue);
    instance.startBytes = exports.memory.buffer.byteLength;
  }
  return instance;
}

/**
 * V8 compiles a wasm function on its first call, so the first open in a process paid for compiling
 * the open's code: 1.5–2 ms of a large file's first open. A module's first instance opens a one-page
 * file of its own as it starts, so that's paid here instead, before a caller's file arrives. The code
 * is the module's, shared by its later instances and the threads it's posted to.
 */
const warmed = new WeakSet<WebAssembly.Module>();

function warmUp(glue: ReturnType<typeof createGlue>): void {
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Count 1 /Kids [3 0 R]>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <<>>>>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = objects.map((object, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  try {
    const doc = new glue.Document(new TextEncoder().encode(pdf), null);
    doc.filePointer();
    doc.fileLength();
    doc.pageCount;
    doc.free();
  } catch {
    // Only time is at stake: an instance this left abandoned is replaced at the next open.
  }
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
  readonly #base: URL | null;
  readonly #recycleAboveBytes: number;
  readonly #maxDecodedBytes: number | undefined;
  /** Past this, an instance with a document open takes no other. */
  readonly #idleAboveBytes: number;
  /** Whether an instance that grew goes once nothing has been open on it for IDLE_MS: the default. */
  readonly #dropWhenIdle: boolean;
  #idle: ReturnType<typeof setTimeout> | undefined;
  /** Across every instance: a document that moved, or stayed on an old one, still counts. */
  readonly #documents: { open: number };

  constructor(instance: Instance, base: URL | null, recycleAboveBytes: number | undefined, maxDecodedBytes: number | undefined) {
    this.#maxDecodedBytes = maxDecodedBytes;
    this.#instance = instance;
    this.#generation = instance.generation;
    this.#base = base;
    this.#recycleAboveBytes = recycleAboveBytes ?? DEFAULT_RECYCLE_ABOVE_BYTES;
    this.#idleAboveBytes = recycleAboveBytes ?? IDLE_RECYCLE_ABOVE_BYTES;
    this.#dropWhenIdle = recycleAboveBytes === undefined;
    this.#documents = instance.documents;
    this.#watch(instance);
  }

  /** Memory only comes back with the instance, so don't keep one past the mark with nothing on it. */
  #watch(instance: Instance): void {
    instance.onClose = () => {
      if (this.#instance !== instance || instance.openDocuments > 0) {
        return;
      }
      const bytes = instance.memory.buffer.byteLength;
      if (bytes > this.#recycleAboveBytes) {
        this.#instance = null;
      } else if (this.#dropWhenIdle ? bytes > instance.startBytes : bytes > this.#idleAboveBytes) {
        clearTimeout(this.#idle);
        this.#idle = setTimeout(() => {
          // Node's fired timer keeps its callback, and with it the instance.
          this.#idle = undefined;
          if (this.#instance === instance && instance.openDocuments === 0) {
            this.#instance = null;
          }
        }, IDLE_MS);
        // Not a reason for Node to stay running.
        (this.#idle as { unref?: () => void }).unref?.();
      }
    };
  }

  /** Whether a new document can go on this instance. */
  #usable(instance: Instance | null): instance is Instance {
    if (!instance || instance.dead || instance.abandoned) {
      return false;
    }
    const bytes = instance.memory.buffer.byteLength;
    return bytes <= this.#idleAboveBytes || (bytes <= this.#recycleAboveBytes && instance.openDocuments === 0);
  }

  #ready(): Instance | null {
    return this.#usable(this.#instance) ? this.#instance : null;
  }

  async #live(): Promise<Instance> {
    const current = this.#instance;
    if (this.#usable(current)) {
      return current;
    }
    this.#starting ??= compile("recto.wasm", this.#base)
      .then((module) => instantiate(this.#generation + 1, this.#base, module, this.#maxDecodedBytes, this.#documents))
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

  /** An instance for a document to reopen on, its own having been abandoned. Synchronous: every call is. */
  #another(): Instance {
    const current = this.#instance;
    if (this.#usable(current)) {
      return current;
    }
    // Compiled already: it's what the abandoned instance ran.
    const instance = instantiate(
      this.#generation + 1,
      this.#base,
      compiled.get(moduleKey("recto.wasm", this.#base))!,
      this.#maxDecodedBytes,
      this.#documents
    );
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
      // Where the file is, read now: an abandoned instance may run nothing.
      let opened = new instance.glue.Document(bytes, password);
      let pointer = opened.filePointer();
      const length = opened.fileLength();
      doc = new RectoDocument(instance, opened, (_, oldInstance) => {
        const next = this.#another();
        // The file goes straight from the old heap to the new one.
        opened = new next.glue.Document(new Uint8Array(oldInstance.memory.buffer, pointer, length), password);
        pointer = opened.filePointer();
        return { instance: next, doc: opened };
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
    source: PdfRangeSource | PdfRangedRead,
    options: PdfRangedOpenOptions = {}
  ): Promise<PdfRangedDocument> {
    if (!canReadSync()) {
      throw new PdfError(
        "wrong-thread",
        "a ranged read blocks its thread on the network, which this thread can't do. Open it in a " +
          'dedicated Web Worker: new Worker(new URL("./pdf-worker.js", import.meta.url), { type: "module" }).'
      );
    }
    const started = startedRead(source);
    const owned = started ? started.source : ownedSource(source as PdfRangeSource);
    const instance = await this.#live();
    const loader = await (started ? started.loader : startRangeLoader(owned, options));
    const read = (offset: number, length: number, ahead: number) => {
      const out = new Uint8Array(length);
      return loader.read(offset, out, ahead) ? out : undefined;
    };
    const password = options.password ?? null;
    let doc: RectoDocument;
    try {
      doc = new RectoDocument(
        instance,
        instance.glue.Document.openRanged(loader.length, loader.chunkBytes, read, password),
        () => {
          // The new instance reads the file again: what the loader still holds costs nothing, and what
          // it handed the old instance (and dropped) is fetched again.
          const next = this.#another();
          return {
            instance: next,
            doc: next.glue.Document.openRanged(loader.length, loader.chunkBytes, read, password),
          };
        },
        () => loader.failure
      );
    } catch (error) {
      throw loader.explain(loader.failure && !(error instanceof WebAssembly.RuntimeError) ? loader.failure : engineFailure(instance, error));
    }
    if (loader.failure) {
      doc.close();
      throw loader.explain(loader.failure);
    }
    return Object.assign(doc, {
      stats: () => loader.stats(),
      fetchRest: (rest: { signal?: AbortSignal; stallMs?: number } = {}) => loader.fetchRest(owned, rest),
    });
  }

  async preload(names: AssetName[]): Promise<void> {
    await preloadAssets(this.#base, names);
  }

  stats(): PdfEngineStats {
    return {
      heapBytes: this.#instance?.memory.buffer.byteLength ?? 0,
      generation: this.#generation,
      openDocuments: this.#documents.open,
    };
  }
}

export async function createPdfEngine(options: PdfEngineOptions = {}): Promise<PdfEngine> {
  return await createEngine(options);
}

async function createEngine(options: PdfEngineOptions): Promise<RectoEngine> {
  const base = assetBaseUrl(options.assetBase);
  const canRead = canReadSync();
  for (const asset of options.preloadAssets ?? []) {
    if (asset !== "cmaps.brotli" && asset !== "fonts.bin" && !Object.hasOwn(PINS, asset)) {
      const accepted = [...Object.keys(PINS), "cmaps.brotli", "fonts.bin"].join(", ");
      throw new TypeError(`preloadAssets does not know ${JSON.stringify(asset)}. It takes: ${accepted}`);
    }
  }
  // cmaps.brotli is the old name of cmaps.deflate, and fonts.bin of all the fonts together.
  const names = (options.preloadAssets ?? (canRead ? [] : ALL_ASSETS)).flatMap((asset) =>
    asset === "cmaps.brotli" ? ("cmaps.deflate" as const) : asset === "fonts.bin" ? STANDARD_FONTS : asset
  );
  const isPart = (name: AssetName): name is Part => (PARTS as readonly string[]).includes(name);
  const files = names.filter((name) => name !== "recto.wasm" && !isPart(name));
  // With no way to read a part from inside a call, all of them now, always: nothing listed can take
  // away the ability to draw.
  const [module] = await Promise.all([
    compile("recto.wasm", base),
    ...(canRead ? names.filter(isPart) : PARTS).map((part) => compile(part, base)),
    preloadAssets(base, files),
  ]);
  const maxDecodedBytes = options.maxDecodedBytes;
  if (maxDecodedBytes !== undefined && !(typeof maxDecodedBytes === "number" && maxDecodedBytes >= 0)) {
    throw new RangeError("maxDecodedBytes must be a number of bytes, 0 or more");
  }
  return new RectoEngine(instantiate(0, base, module, maxDecodedBytes), base, options.recycleAboveBytes, maxDecodedBytes);
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
