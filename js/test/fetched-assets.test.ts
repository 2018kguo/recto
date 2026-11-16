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

function serve(change: (bytes: Buffer, name: string) => Buffer = (bytes) => bytes, type = "application/wasm"): void {
  // Takes no options, as a wrapper around fetch might.
  globalThis.fetch = (async (input: string | URL) => {
    const name = new URL(String(input)).pathname.split("/").pop()!;
    return new Response(change(packaged(name), name), { headers: { "Content-Type": type } });
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

  test(`a changed wasm is never instantiated, whatever fetch did with the options (${label})`, async () => {
    setCrypto();
    // It may compile while it streams in, which runs none of its code; it must not get an instance.
    const RealInstance = WebAssembly.Instance;
    let instantiated = 0;
    WebAssembly.Instance = function Instance(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
      instantiated += 1;
      return new RealInstance(module, imports);
    } as unknown as typeof WebAssembly.Instance;
    try {
      serve(flipLastByte);
      for (const preloadAssets of [[], ["recto.wasm"]] as const) {
        await assert.rejects(createPdfEngine({ assetBase: location(), preloadAssets: [...preloadAssets] }), {
          code: "missing-asset",
          message: /not this build's file/u,
        });
      }
      assert.equal(instantiated, 0);
    } finally {
      WebAssembly.Instance = RealInstance;
    }
  });

  test(`the wasm compiles as it streams in, and from its bytes when the type isn't application/wasm (${label})`, async () => {
    setCrypto();
    const realStreaming = WebAssembly.compileStreaming;
    let streamed = 0;
    WebAssembly.compileStreaming = ((source) => {
      streamed += 1;
      return realStreaming(source);
    }) as typeof WebAssembly.compileStreaming;
    try {
      for (const type of ["application/wasm", "application/octet-stream"]) {
        streamed = 0;
        serve((bytes) => bytes, type);
        const engine = await createPdfEngine({ assetBase: location() });
        using doc = await engine.open(syntheticPdf({ pages: 1, charsPerPage: 100 }));
        assert.ok(doc.text(0).text.length > 50);
        // Here, with no way to read a file mid-call, that is recto.wasm and all three parts.
        assert.equal(streamed, type === "application/wasm" ? 4 : 0);
      }
    } finally {
      WebAssembly.compileStreaming = realStreaming;
    }
  });

  test(`a changed font file is refused, and the right files work (${label})`, async () => {
    setCrypto();
    serve((bytes, name) => (name === "FoxitSans.pfb" ? flipLastByte(bytes) : bytes));
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

test("listing other assets can't take away drawing, and the old CMaps name still works", async () => {
  Object.defineProperty(globalThis, "crypto", realCrypto);
  serve();
  const pdf = syntheticPdf({ pages: 1, charsPerPage: 100 });
  for (const preloadAssets of [["fonts.bin"], ["fonts.bin", "cmaps.brotli"]] as const) {
    const engine = await createPdfEngine({ assetBase: location(), preloadAssets: [...preloadAssets] });
    using doc = await engine.open(pdf);
    assert.equal(doc.render(0, { width: 100 }).width, 100, `with ${preloadAssets.join()} listed`);
    assert.equal((await doc.renderAsync(0, { width: 100 })).width, 100);
    assert.equal(engine.stats().generation, 0, "it started on the wasm that draws");
  }
  // With nothing listed, what a page lacks is its font, and the wasm is there.
  const engine = await createPdfEngine({ assetBase: location(), preloadAssets: [] });
  using doc = await engine.open(pdf);
  assert.ok(doc.objects(0));
  assert.throws(() => doc.render(0, { width: 100 }), { code: "missing-asset", message: /FoxitSans\.pfb/u });
});

