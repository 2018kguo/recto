// The files in ../wasm: where they are, how to read them, and the check that they are the
// ones this build was made with.
//
// The engine asks for a font or CMap from inside a synchronous call, the first time a
// document needs one, so reading must be synchronous too: fs in Node, a synchronous
// XMLHttpRequest in a Web Worker. A page's main thread may not fetch bytes synchronously
// (and would freeze the page), which is why the engine refuses to start there. The URLs
// are written out as `new URL("literal", import.meta.url)` because that is the form
// bundlers recognise and rewrite, emitting the file.
//
// Each file is pinned by SHA-256: the engine reads its tables as trusted, and a dev server's
// HTML fallback page must not read as a font. pins.mjs is written by the build.

import { PINS } from "../wasm/pins.mjs";
import { PdfError } from "./errors.ts";
import { sha256Hex } from "./sha256.ts";

export type AssetName = keyof typeof PINS;

function packagedUrl(name: AssetName): URL {
  switch (name) {
    case "recto.wasm":
      return new URL("../wasm/recto.wasm", import.meta.url);
    case "fonts.bin":
      return new URL("../wasm/fonts.bin", import.meta.url);
    case "cjk-fallback.ttf":
      return new URL("../wasm/cjk-fallback.ttf", import.meta.url);
    case "cmaps.brotli":
      return new URL("../wasm/cmaps.brotli", import.meta.url);
  }
}

/** A stalled server must not block the thread for ever; the largest asset is 5 MB. */
const ASSET_TIMEOUT_MS = 60_000;

/** Node's fs when there is one. `getBuiltinModule` keeps bundlers from following it. */
function nodeFs() {
  return globalThis.process?.getBuiltinModule?.("node:fs");
}

/** Throws unless this thread can run the engine. */
export function assertUsableThread(): void {
  if (nodeFs()) {
    return;
  }
  if (typeof document !== "undefined" || typeof XMLHttpRequest === "undefined") {
    throw new PdfError(
      "wrong-thread",
      "recto blocks its thread and reads fonts synchronously, so in a browser it runs in a " +
        "dedicated Web Worker, not on a page's main thread or in a service worker. Move this " +
        'call into a worker: new Worker(new URL("./pdf-worker.js", import.meta.url), { type: "module" }).'
    );
  }
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

function checked(name: AssetName, url: URL, bytes: Uint8Array): Uint8Array {
  if (sha256Hex(bytes) !== PINS[name]) {
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

/** The wasm's bytes, for compiling. Asynchronous where it can be. */
export async function loadWasm(base: URL | null): Promise<Uint8Array<ArrayBuffer>> {
  let url: URL | null = null;
  let bytes: Uint8Array;
  try {
    // Inside the try: under a blob: worker `import.meta.url` is no base for a URL.
    url = assetUrl("recto.wasm", base);
    if (nodeFs()) {
      bytes = readFromDisk(url);
    } else {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    }
  } catch (error) {
    throw loadFailure("recto.wasm", url, error instanceof Error ? error.message : String(error), error);
  }
  return checked("recto.wasm", url!, bytes) as Uint8Array<ArrayBuffer>;
}

/** Verified assets by URL: hash and read each once per thread. */
const loaded = new Map<string, Uint8Array>();

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
