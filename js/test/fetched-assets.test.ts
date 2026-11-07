// The path a browser takes: no files to read, so assets come through `fetch`. Node's own means of
// reading and hashing are taken away for this file, which is alone in its process.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";

import { createPdfEngine } from "../src/index.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";

const packaged = (name: string) => readFileSync(new URL(`../wasm/${name}`, import.meta.url));

const realGet = process.getBuiltinModule;
const realFetch = globalThis.fetch;
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
process.getBuiltinModule = (() => undefined) as typeof process.getBuiltinModule;
after(() => {
  process.getBuiltinModule = realGet;
  globalThis.fetch = realFetch;
  Object.defineProperty(globalThis, "crypto", realCrypto);
});

let base = 0;
/** A fresh location, because the compiled wasm is cached per location. */
const location = () => new URL(`http://assets.test/${++base}/`);

function serve(change: (bytes: Buffer, name: string) => Buffer = (bytes) => bytes): void {
  // Takes no options, as a wrapper around fetch might.
  globalThis.fetch = (async (input: string | URL) => {
    const name = new URL(String(input)).pathname.split("/").pop()!;
    return new Response(change(packaged(name), name), { headers: { "Content-Type": "application/wasm" } });
  }) as typeof fetch;
}

const flipLastByte = (bytes: Buffer) => {
  const changed = Buffer.from(bytes);
  changed[changed.length - 1]! ^= 1;
  return changed;
};

for (const [label, secure] of [["crypto.subtle", true], ["the JavaScript hash, on a plain-http page", false]] as const) {
  const setCrypto = () =>
    Object.defineProperty(globalThis, "crypto", secure ? realCrypto : { value: undefined, configurable: true });

  test(`a changed wasm never compiles, whatever fetch did with the options (${label})`, async () => {
    setCrypto();
    const compile = WebAssembly.compile;
    let compiled = 0;
    WebAssembly.compile = ((bytes: BufferSource) => {
      compiled += 1;
      return compile(bytes);
    }) as typeof WebAssembly.compile;
    try {
      serve(flipLastByte);
      for (const preloadAssets of [[], ["recto.wasm"]] as const) {
        await assert.rejects(createPdfEngine({ assetBase: location(), preloadAssets: [...preloadAssets] }), {
          code: "missing-asset",
          message: /not this build's file/u,
        });
      }
      assert.equal(compiled, 0);
    } finally {
      WebAssembly.compile = compile;
    }
  });

  test(`a changed font file is refused, and the right files work (${label})`, async () => {
    setCrypto();
    serve((bytes, name) => (name === "fonts.bin" ? flipLastByte(bytes) : bytes));
    await assert.rejects(createPdfEngine({ assetBase: location() }), { code: "missing-asset" });
    serve();
    const engine = await createPdfEngine({ assetBase: location() });
    using doc = await engine.open(syntheticPdf({ pages: 1, charsPerPage: 100 }));
    assert.ok(doc.text(0).text.length > 50);
    assert.ok(doc.render(0, { width: 100 }).rgba.some((value) => value !== 255));
  });
}

test("an HTTP error says so", async () => {
  Object.defineProperty(globalThis, "crypto", realCrypto);
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  await assert.rejects(createPdfEngine({ assetBase: location() }), { code: "missing-asset", message: /HTTP 404/u });
});
