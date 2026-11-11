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
// Each file is pinned by SHA-256 and hashed here, every byte, before it's used: the engine reads
// its tables as trusted, and a dev server's HTML fallback page must not read as a font. Nothing is
// left to `fetch`'s `integrity`, which a wrapper around `fetch` can drop, and which buffers the
// body anyway. pins.mjs is written by the build.

import { PINS } from "../wasm/pins.mjs";
import { PdfError } from "./errors.ts";
import { sha256Hex } from "./sha256.ts";

export type AssetName = keyof typeof PINS;
export type WasmName = "recto.wasm" | "recto-render.wasm" | "recto-more.wasm" | "recto-rare.wasm";

/** The standard fonts, in the order the wasm asks for them (`font_index` in crates/recto/src/assets.rs). */
export const STANDARD_FONTS = [
  "FoxitFixed.pfb",
  "FoxitFixedBold.pfb",
  "FoxitFixedBoldItalic.pfb",
  "FoxitFixedItalic.pfb",
  "FoxitSans.pfb",
  "FoxitSansBold.pfb",
  "FoxitSansBoldItalic.pfb",
  "FoxitSansItalic.pfb",
  "FoxitSerif.pfb",
  "FoxitSerifBold.pfb",
  "FoxitSerifBoldItalic.pfb",
  "FoxitSerifItalic.pfb",
  "FoxitSymbol.pfb",
  "FoxitDingbats.pfb",
] as const;

function packagedUrl(name: AssetName): URL {
  switch (name) {
    case "recto.wasm":
      return new URL("../wasm/recto.wasm", import.meta.url);
    case "recto-render.wasm":
      return new URL("../wasm/recto-render.wasm", import.meta.url);
    case "recto-more.wasm":
      return new URL("../wasm/recto-more.wasm", import.meta.url);
    case "recto-rare.wasm":
      return new URL("../wasm/recto-rare.wasm", import.meta.url);
    case "FoxitFixed.pfb":
      return new URL("../wasm/FoxitFixed.pfb", import.meta.url);
    case "FoxitFixedBold.pfb":
      return new URL("../wasm/FoxitFixedBold.pfb", import.meta.url);
    case "FoxitFixedBoldItalic.pfb":
      return new URL("../wasm/FoxitFixedBoldItalic.pfb", import.meta.url);
    case "FoxitFixedItalic.pfb":
      return new URL("../wasm/FoxitFixedItalic.pfb", import.meta.url);
    case "FoxitSans.pfb":
      return new URL("../wasm/FoxitSans.pfb", import.meta.url);
    case "FoxitSansBold.pfb":
      return new URL("../wasm/FoxitSansBold.pfb", import.meta.url);
    case "FoxitSansBoldItalic.pfb":
      return new URL("../wasm/FoxitSansBoldItalic.pfb", import.meta.url);
    case "FoxitSansItalic.pfb":
      return new URL("../wasm/FoxitSansItalic.pfb", import.meta.url);
    case "FoxitSerif.pfb":
      return new URL("../wasm/FoxitSerif.pfb", import.meta.url);
    case "FoxitSerifBold.pfb":
      return new URL("../wasm/FoxitSerifBold.pfb", import.meta.url);
    case "FoxitSerifBoldItalic.pfb":
      return new URL("../wasm/FoxitSerifBoldItalic.pfb", import.meta.url);
    case "FoxitSerifItalic.pfb":
      return new URL("../wasm/FoxitSerifItalic.pfb", import.meta.url);
    case "FoxitSymbol.pfb":
      return new URL("../wasm/FoxitSymbol.pfb", import.meta.url);
    case "FoxitDingbats.pfb":
      return new URL("../wasm/FoxitDingbats.pfb", import.meta.url);
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
      'optimizeDeps: { exclude: ["@2018kguo/recto"] } instead; a server bundle should keep the package external).',
    cause
  );
}

/**
 * `read` of an asset's URL, sync or async, with any failure but a PdfError reported as that asset's
 * `missing-asset`. Resolving the URL is inside it: under a blob: worker `import.meta.url` is no base.
 */
function located<T>(name: AssetName, base: URL | null, read: (url: URL) => T): T {
  let url: URL | null = null;
  const failure = (error: unknown) =>
    error instanceof PdfError ? error : loadFailure(name, url, error instanceof Error ? error.message : String(error), error);
  try {
    url = assetUrl(name, base);
    const result = read(url);
    return (result instanceof Promise ? result.catch((error: unknown) => Promise.reject(failure(error))) : result) as T;
  } catch (error) {
    throw failure(error);
  }
}

/** A hash to use where there is no native one to call synchronously. A live instance's is quicker than this file's. */
export type SyncHash = (bytes: Uint8Array) => string | null;

function notThisBuild(name: AssetName, url: URL, bytes: Uint8Array): PdfError {
  return loadFailure(
    name,
    url,
    `the ${bytes.byteLength} bytes there are not this build's file (a server's fallback page, or a different version of the package)`
  );
}

function checked(name: AssetName, url: URL, bytes: Uint8Array, hash?: SyncHash): Uint8Array {
  const crypto = globalThis.process?.getBuiltinModule?.("node:crypto");
  const hex = crypto ? crypto.createHash("sha256").update(bytes).digest("hex") : (hash?.(bytes) ?? sha256Hex(bytes));
  if (hex !== PINS[name]) {
    throw notThisBuild(name, url, bytes);
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

/** `crypto.subtle` is only there in a secure context; a plain-http page hashes here. */
async function hashOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return sha256Hex(bytes);
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The only way bytes get here from a network without blocking: whole, and hashed before they're used. */
async function fetchBytes(name: AssetName, url: URL): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await hashOf(bytes)) !== PINS[name]) {
    throw notThisBuild(name, url, bytes);
  }
  return bytes;
}

/** The wasm, verified and then compiled. */
export async function compileWasm(name: WasmName, base: URL | null): Promise<WebAssembly.Module> {
  const bytes = await located(name, base, async (url) => (nodeFs() ? checked(name, url, readFromDisk(url)) : await fetchBytes(name, url)));
  return await compiling(name, WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>));
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

/** Fetches and verifies assets ahead of time; a thread that can't read them when needed has to. */
export async function preloadAssets(base: URL | null, names: AssetName[]): Promise<void> {
  await Promise.all(
    names.map((name) =>
      located(name, base, async (url) => {
        if (!loaded.has(url.href)) {
          loaded.set(url.href, nodeFs() ? checked(name, url, readFromDisk(url)) : await fetchBytes(name, url));
        }
      })
    )
  );
}

/** An asset, read synchronously. Throws a PdfError rather than returning nothing. */
export function loadAssetSync(name: AssetName, base: URL | null, hash?: SyncHash): Uint8Array {
  return located(name, base, (url) => {
    let bytes = loaded.get(url.href);
    if (!bytes) {
      bytes = readCheckedSync(name, base, hash);
      loaded.set(url.href, bytes);
    }
    return bytes;
  });
}

/** A file, read now and hashed before it's returned, and not kept: a part is compiled once. */
export function readCheckedSync(name: AssetName, base: URL | null, hash?: SyncHash): Uint8Array {
  const [url, bytes] = located(name, base, (url) => {
    if (!canReadSync()) {
      throw new Error("this thread can only use assets fetched up front, and it was left out of preloadAssets");
    }
    return [url, nodeFs() ? readFromDisk(url) : readSync(url)] as const;
  });
  // Outside: a trap in the instance's hash is a crash, not a missing file.
  return checked(name, url, bytes, hash);
}
