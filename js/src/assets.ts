// The files in ../wasm: where they are, how to read them, and the check that they are the
// ones this build was made with.
//
// The engine asks for a font or CMap from inside a synchronous call, the first time a
// document needs one, so reading must be synchronous too: fs in Node, a synchronous
// XMLHttpRequest in a Web Worker. A page's main thread may not fetch bytes synchronously, and a
// service worker has no XMLHttpRequest, so there they are fetched up front instead. The URLs
// are written out as `new URL("literal", import.meta.url)` because that is the form
// bundlers recognise and rewrite, emitting the file.
//
// Each file is pinned by SHA-256: the engine reads its tables as trusted, and a dev server's
// HTML fallback page must not read as a font. pins.mjs is written by the build.

import { PINS } from "../wasm/pins.mjs";
import { PdfError } from "./errors.ts";
import { sha256Hex } from "./sha256.ts";

export type AssetName = keyof typeof PINS;
export type WasmName = "recto.wasm" | "recto-text.wasm";

function packagedUrl(name: AssetName): URL {
  switch (name) {
    case "recto.wasm":
      return new URL("../wasm/recto.wasm", import.meta.url);
    case "recto-text.wasm":
      return new URL("../wasm/recto-text.wasm", import.meta.url);
    case "fonts.bin":
      return new URL("../wasm/fonts.bin", import.meta.url);
    case "cjk-fallback.ttf":
      return new URL("../wasm/cjk-fallback.ttf", import.meta.url);
    case "cmaps.deflate":
      return new URL("../wasm/cmaps.deflate", import.meta.url);
  }
}

/** A stalled server must not block the thread for ever; the largest asset is 5 MB. */
const ASSET_TIMEOUT_MS = 60_000;

/** Node's fs when there is one. `getBuiltinModule` keeps bundlers from following it. */
function nodeFs() {
  return globalThis.process?.getBuiltinModule?.("node:fs");
}

/** Whether an asset can be read at the moment the engine asks for it. */
export function canReadSync(): boolean {
  if (nodeFs()) {
    return true;
  }
  return typeof document === "undefined" && typeof XMLHttpRequest !== "undefined";
}

/** `assetBase` as a directory URL, or null for the package's own files. */
export function assetBaseUrl(base: string | URL | undefined): URL | null {
  if (base === undefined) {
    return null;
  }
  let url: URL;
  if (base instanceof URL) {
    url = new URL(base);
  } else if (/^[a-z][a-z0-9+.-]+:/iu.test(base)) {
    url = new URL(base);
  } else if (nodeFs()) {
    url = globalThis.process.getBuiltinModule("node:url").pathToFileURL(base);
  } else {
    url = new URL(base, location.href);
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  if (nodeFs() && url.protocol !== "file:") {
    throw new TypeError(
      "In Node, assetBase must be a directory path or a file: URL: the engine reads fonts synchronously."
    );
  }
  return url;
}

function assetUrl(name: AssetName, base: URL | null): URL {
  return base ? new URL(name, base) : packagedUrl(name);
}

function loadFailure(name: AssetName, url: URL | null, reason: string, cause?: unknown): PdfError {
  return new PdfError(
    "missing-asset",
    `recto could not load ${name}${url ? ` from ${url.href}` : ""}: ${reason}. It ships in the package's wasm/ ` +
      "directory. If a bundler or dev server moved the package without its files, copy them " +
      "somewhere it serves and pass that directory as `assetBase` (with Vite's dev server, add " +
      'optimizeDeps: { exclude: ["@2018kguo/recto"] } instead).',
    cause
  );
}

let wasmHash: ((bytes: Uint8Array) => string | null) | null = null;

/** A live instance's hash, for assets too large for this file's: that takes 60 ms over the wasm in a cold browser. */
export function useWasmHash(hash: (bytes: Uint8Array) => string | null): void {
  wasmHash = hash;
}

function sha256(bytes: Uint8Array): string {
  const crypto = globalThis.process?.getBuiltinModule?.("node:crypto");
  if (crypto) {
    return crypto.createHash("sha256").update(bytes).digest("hex");
  }
  return wasmHash?.(bytes) ?? sha256Hex(bytes);
}

function checked(name: AssetName, url: URL, bytes: Uint8Array): Uint8Array {
  if (sha256(bytes) !== PINS[name]) {
    throw loadFailure(
      name,
      url,
      `the ${bytes.byteLength} bytes there are not this build's file (a server's fallback page, or a different version of the package)`
    );
  }
  return bytes;
}

function readFromDisk(url: URL): Uint8Array {
  return nodeFs()!.readFileSync(url);
}

function readSync(url: URL): Uint8Array {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url.href, false);
  xhr.responseType = "arraybuffer";
  xhr.timeout = ASSET_TIMEOUT_MS;
  xhr.send();
  if (xhr.status !== 200) {
    throw new Error(`HTTP ${xhr.status}`);
  }
  return new Uint8Array(xhr.response as ArrayBuffer);
}

/** A runtime can take the option and ignore it, and then nothing would be checked. */
function hasFetchIntegrity(integrity: string): boolean {
  try {
    return new Request("https://localhost/", { integrity }).integrity === integrity;
  } catch {
    return false;
  }
}

/**
 * The file, with its pin checked by the browser, so no hashing here. Null means ask again without
 * it: that way is slower, but it can say what's wrong, which a failed integrity fetch can't, and it
 * works where this doesn't.
 */
async function fetchPinned(name: AssetName, url: URL): Promise<Response | null> {
  const hex = PINS[name];
  const integrity = `sha256-${btoa(String.fromCharCode(...hex.match(/../gu)!.map((byte) => parseInt(byte, 16))))}`;
  if (!hasFetchIntegrity(integrity)) {
    return null;
  }
  try {
    const response = await fetch(url, { integrity });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

async function fetchBytes(name: AssetName, url: URL): Promise<Uint8Array> {
  const pinned = await fetchPinned(name, url);
  if (pinned) {
    return new Uint8Array(await pinned.arrayBuffer());
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return checked(name, url, new Uint8Array(await response.arrayBuffer()));
}

/** The wasm, verified and compiled. Streaming needs the right MIME type, which not every server sends. */
export async function compileWasm(name: WasmName, base: URL | null): Promise<WebAssembly.Module> {
  let url: URL | null = null;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    // Inside the try: under a blob: worker `import.meta.url` is no base for a URL.
    url = assetUrl(name, base);
    if (nodeFs()) {
      bytes = checked(name, url, readFromDisk(url)) as Uint8Array<ArrayBuffer>;
    } else {
      const pinned = await fetchPinned(name, url);
      if (pinned?.headers.get("content-type") === "application/wasm") {
        return await compiling(name, WebAssembly.compileStreaming(pinned));
      }
      bytes = (pinned ? new Uint8Array(await pinned.arrayBuffer()) : await fetchBytes(name, url)) as Uint8Array<ArrayBuffer>;
    }
  } catch (error) {
    if (error instanceof PdfError) {
      throw error;
    }
    throw loadFailure(name, url, error instanceof Error ? error.message : String(error), error);
  }
  return await compiling(name, WebAssembly.compile(bytes));
}

function compiling(name: WasmName, module: Promise<WebAssembly.Module>): Promise<WebAssembly.Module> {
  return module.catch((error: unknown) => {
    throw new PdfError(
      "missing-asset",
      `recto could not compile ${name}: ${String(error)}. A Content-Security-Policy must allow 'wasm-unsafe-eval'.`,
      error
    );
  });
}

/** Verified assets by URL: hash and read each once per thread. */
const loaded = new Map<string, Uint8Array>();

/** Fetches assets ahead of time, for a thread that can't read them when they're needed. */
export async function preloadAssets(base: URL | null, names: AssetName[]): Promise<void> {
  await Promise.all(
    names.map(async (name) => {
      let url: URL | null = null;
      let bytes: Uint8Array;
      try {
        url = assetUrl(name, base);
        if (loaded.has(url.href)) {
          return;
        }
        bytes = await fetchBytes(name, url);
      } catch (error) {
        if (error instanceof PdfError) {
          throw error;
        }
        throw loadFailure(name, url, error instanceof Error ? error.message : String(error), error);
      }
      loaded.set(url.href, bytes);
    })
  );
}

/** An asset, read synchronously. Throws a PdfError rather than returning nothing. */
export function loadAssetSync(name: AssetName, base: URL | null): Uint8Array {
  let url: URL | null = null;
  let bytes: Uint8Array;
  try {
    url = assetUrl(name, base);
    const cached = loaded.get(url.href);
    if (cached) {
      return cached;
    }
    if (!canReadSync()) {
      throw new Error("this thread can only use assets fetched up front, and it was left out of preloadAssets");
    }
    bytes = nodeFs() ? readFromDisk(url) : readSync(url);
  } catch (error) {
    throw loadFailure(name, url, error instanceof Error ? error.message : String(error), error);
  }
  loaded.set(url!.href, checked(name, url!, bytes));
  return bytes;
}

/** Entry `index` of fonts.bin: u32 count, u32 offsets[count + 1], bytes (little-endian). */
export function fontFromBundle(bundle: Uint8Array, index: number): Uint8Array {
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const base = 4 + (view.getUint32(0, true) + 1) * 4;
  return bundle.subarray(
    base + view.getUint32(4 + index * 4, true),
    base + view.getUint32(8 + index * 4, true)
  );
}
