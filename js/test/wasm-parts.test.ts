// The wasm comes in parts, and a call loads what it needs. None of that may show, except in what's
// loaded: not in a result, not after a failure to load, and no part runs unchecked.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { createPdfEngine, type PdfBitmap, type PdfDocument, PdfError } from "../src/index.ts";
import { bilevel, jpxPdf, meshPdf, postScriptPdf, tensorPdf } from "./rare-pdfs.ts";
import { startRangeServer } from "./range-server.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";
import { PINS } from "../wasm/pins.mjs";

const packaged = (name: string) => new URL(`../wasm/${name}`, import.meta.url);
const PARTS = ["recto-render.wasm", "recto-more.wasm", "recto-rare.wasm"];
const ASSETS = Object.keys(PINS);
const FONTS = ASSETS.filter((name) => name.endsWith(".pfb"));
function assetDir(...without: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "recto-parts-"));
  for (const name of ASSETS) {
    if (!without.includes(name)) {
      copyFileSync(packaged(name), join(dir, name));
    }
  }
  return dir;
}
const restore = (dir: string, name: string) => copyFileSync(packaged(name), join(dir, name));
const pdf = () => syntheticPdf({ pages: 2, charsPerPage: 200 });
const missing = (name: string) => (error: PdfError) => {
  assert.equal(error.code, "missing-asset");
  assert.match(error.message, new RegExp(name.replace(".", "\\."), "u"));
  return true;
};
const pixel = ({ rgba, width }: PdfBitmap, x: number, y: number) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];

test("text needs no part and no font file; a part failing before a render changes nothing", async () => {
  const dir = assetDir(...PARTS, ...FONTS);
  const engine = await createPdfEngine({ assetBase: dir });
  using doc = await engine.open(pdf());
  assert.ok(doc.text(0).text.length > 100);
  assert.ok(doc.outline());
  assert.ok(doc.annotations(0));
  assert.throws(() => doc.render(0, { width: 100 }), missing("recto-render.wasm"));
  assert.throws(() => doc.objects(0), missing("recto-render.wasm"));
  assert.equal(engine.stats().generation, 0, "nothing was abandoned: the failure came before the call");
  assert.ok(doc.text(0).text.length > 100);
  for (const name of [...PARTS, ...FONTS]) restore(dir, name);
  assert.ok(doc.render(0, { width: 100 }).rgba.some((v) => v !== 255));
});

test("one instance from first text to pixels, the same as one that never read text", async () => {
  const bytes = pdf();
  const engine = await createPdfEngine();
  using doc = await engine.open(bytes);
  const before = doc.text(0);
  const first = doc.render(0, { width: 300 });
  assert.deepEqual({ ...doc.text(0) }, { ...before });
  assert.equal(engine.stats().generation, 0);
  using direct = await (await createPdfEngine()).open(bytes);
  assert.deepEqual(direct.render(0, { width: 300 }).rgba, first.rgba);
});

test("a part that isn't this build's is refused before anything compiles it", async () => {
  const compiled: number[] = [];
  const RealModule = WebAssembly.Module;
  WebAssembly.Module = new Proxy(RealModule, {
    construct(target, [bytes]: [Uint8Array]) {
      compiled.push(bytes.byteLength);
      return new target(bytes as Uint8Array<ArrayBuffer>);
    },
  });
  try {
    const dir = assetDir();
    const engine = await createPdfEngine({ assetBase: dir });
    using doc = await engine.open(pdf());
    // A real wasm, from the wrong place in the set: what a stale or mixed directory holds.
    writeFileSync(join(dir, "recto-render.wasm"), readFileSync(packaged("recto-rare.wasm")));
    assert.throws(() => doc.render(0, { width: 100 }), missing("recto-render.wasm"));
    const flipped = readFileSync(packaged("recto-render.wasm"));
    flipped[flipped.length - 1]! ^= 1;
    writeFileSync(join(dir, "recto-render.wasm"), flipped);
    assert.throws(() => doc.render(0, { width: 100 }), missing("recto-render.wasm"));
    assert.deepEqual(compiled, [], "no bytes got as far as a compile");
    restore(dir, "recto-render.wasm");
    assert.equal(doc.render(0, { width: 100 }).width, 100);
    assert.equal(compiled.length, 1);
  } finally {
    WebAssembly.Module = RealModule;
  }
});

/** Pictures in a part that a document found out it needed in the middle of a call. */
for (const [label, damage] of [
  ["missing", (file: string) => rmSync(file)],
  [
    "changed",
    (file: string) => {
      const bytes = readFileSync(file);
      bytes[bytes.length - 1]! ^= 1;
      writeFileSync(file, bytes);
    },
  ],
] as const) {
  test(`a part ${label} mid-call: a retriable missing-asset, and every open document goes on`, async () => {
    const dir = assetDir();
    damage(join(dir, "recto-rare.wasm"));
    const engine = await createPdfEngine({ assetBase: dir });
    using doc = await engine.open(bilevel.jbig2());
    using other = await engine.open(pdf());
    const text = other.text(0);
    assert.throws(() => doc.render(0, { width: 64 }), missing("recto-rare.wasm"));
    // On a new instance now, with the file it had.
    assert.deepEqual({ ...other.text(0) }, { ...text });
    assert.equal(doc.pageCount, 1);
    assert.equal(doc.text(0).count, 0);
    assert.throws(() => doc.render(0, { width: 64 }), missing("recto-rare.wasm"), "it fails the same while the file stays bad");
    assert.deepEqual({ ...other.text(0) }, { ...text }, "and a second reopen still finds the file");
    restore(dir, "recto-rare.wasm");
    using expected = await (await createPdfEngine()).open(bilevel.raw());
    assert.deepEqual(doc.render(0, { width: 64 }).rgba, expected.render(0, { width: 64 }).rgba);
    assert.equal(engine.stats().openDocuments, 2);
  });
}

test("the same through renderAsync, and a paused render on the abandoned instance ends cleanly", async () => {
  const dir = assetDir("recto-rare.wasm");
  const engine = await createPdfEngine({ assetBase: dir });
  using doc = await engine.open(bilevel.jbig2());
  using other = await engine.open(pdf());
  other.render(0, { width: 64 });
  const paused = other.renderAsync(1, { width: 64, sliceMs: 0 });
  await assert.rejects(doc.renderAsync(0, { width: 64 }), missing("recto-rare.wasm"));
  await paused.catch((error: PdfError) => assert.equal(error.code, "missing-asset"));
  restore(dir, "recto-rare.wasm");
  assert.equal((await doc.renderAsync(0, { width: 64 })).width, 64);
  assert.equal((await other.renderAsync(1, { width: 64 })).width, 64);
});

test("a password and a ranged read survive being reopened, the ranged one with nothing fetched twice", async () => {
  const dir = assetDir("recto-rare.wasm");
  const engine = await createPdfEngine({ assetBase: dir });
  using trigger = await engine.open(bilevel.jbig2());
  using locked = await engine.open(readFileSync(new URL("./fixtures/user-password-secret.pdf", import.meta.url)), { password: "secret" });
  const server = await startRangeServer(pdf());
  try {
    using ranged = await engine.openRanged(server.url);
    const text = ranged.text(0).text;
    const fetched = ranged.stats().bytesFetched;
    const lockedText = locked.text(0).text;
    assert.throws(() => trigger.render(0, { width: 64 }), missing("recto-rare.wasm"));
    assert.equal(locked.text(0).text, lockedText);
    assert.equal(ranged.text(0).text, text);
    assert.equal(ranged.stats().bytesFetched, fetched);
  } finally {
    await server.close();
  }
});

test("a missing font fails its call, and the document goes on once the file is back", async () => {
  const dir = assetDir(...FONTS);
  const engine = await createPdfEngine({ assetBase: dir });
  using doc = await engine.open(pdf());
  assert.throws(() => doc.render(0, { width: 64 }), missing("FoxitSans.pfb"));
  assert.ok(doc.text(0).count > 0);
  // That one file is all this page takes: nothing makes it fetch the other thirteen.
  restore(dir, "FoxitSans.pfb");
  assert.ok(doc.render(0, { width: 64 }).rgba.some((v) => v !== 255));
});

// The whole wasm's output, for the rare paths, is compared with the build before the split by hand;
// each of these states what its picture has to be, and that it needed a part beyond drawing's.
const rendered = async (bytes: Uint8Array): Promise<PdfBitmap> => {
  using doc: PdfDocument = await (await createPdfEngine()).open(bytes);
  return doc.render(0, { width: 64 });
};

for (const [name, make] of [["JBIG2", bilevel.jbig2], ["CCITT", bilevel.ccitt]] as const) {
  test(`${name} draws what the same picture uncompressed does, and takes a part drawing doesn't`, async () => {
    assert.deepEqual((await rendered(make())).rgba, (await rendered(bilevel.raw())).rgba);
    const engine = await createPdfEngine({ assetBase: assetDir("recto-rare.wasm") });
    using doc = await engine.open(make());
    assert.throws(() => doc.render(0, { width: 64 }), missing("recto-rare.wasm"));
  });
}

test("JPEG 2000 draws its picture, and takes a part drawing doesn't", async () => {
  const bitmap = await rendered(jpxPdf());
  const [lr, , lb] = pixel(bitmap, 8, 32) as [number, number, number];
  const [rr, , rb] = pixel(bitmap, 56, 32) as [number, number, number];
  assert.ok(lr > 180 && lb < 80, `left ${pixel(bitmap, 8, 32)}`);
  assert.ok(rb > 180 && rr < 80, `right ${pixel(bitmap, 56, 32)}`);
  const engine = await createPdfEngine({ assetBase: assetDir("recto-rare.wasm") });
  using doc = await engine.open(jpxPdf());
  assert.throws(() => doc.render(0, { width: 64 }), missing("recto-rare.wasm"));
});

for (const [name, make, colour] of [
  ["a triangle mesh", meshPdf, [255, 0, 0]],
  ["a patch mesh", tensorPdf, [0, 0, 255]],
  ["a PostScript function", postScriptPdf, [0, 0, 255]],
] as const) {
  test(`${name} paints the page, and takes a part drawing doesn't`, async () => {
    assert.deepEqual(pixel(await rendered(make()), 32, 32), [...colour]);
    const engine = await createPdfEngine({ assetBase: assetDir("recto-more.wasm", "recto-rare.wasm") });
    using doc = await engine.open(make());
    assert.throws(() => doc.render(0, { width: 64 }), (error: PdfError) => error.code === "missing-asset");
  });
}

test("where nothing can be read from inside a call, every part comes up front and nothing fails later", async () => {
  const { getBuiltinModule } = process;
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  const dir = assetDir();
  globalThis.fetch = (async (input: URL) => {
    asked.push(input.href.split("/").pop() ?? "");
    return new Response(getBuiltinModule("node:fs").readFileSync(input));
  }) as typeof fetch;
  // @ts-expect-error As on a browser's main thread.
  process.getBuiltinModule = undefined;
  // @ts-expect-error
  globalThis.document = {};
  try {
    const engine = await createPdfEngine({ assetBase: pathToFileURL(`${dir}/`), preloadAssets: [] });
    for (const name of PARTS) assert.ok(asked.includes(name), `fetched ${asked}`);
    const before = asked.length;
    using doc = await engine.open(bilevel.jbig2());
    assert.equal(doc.render(0, { width: 64 }).width, 64);
    assert.equal(asked.length, before, "no fetch from inside a call");
    // A part that can't come up front fails the engine's creation, as the wasm always has.
    const without = assetDir("recto-rare.wasm");
    globalThis.fetch = (async (input: URL) => {
      const file = getBuiltinModule("node:fs");
      return file.existsSync(input) ? new Response(file.readFileSync(input)) : new Response("", { status: 404 });
    }) as typeof fetch;
    await assert.rejects(createPdfEngine({ assetBase: pathToFileURL(`${without}/`), preloadAssets: [] }), missing("recto-rare.wasm"));
  } finally {
    process.getBuiltinModule = getBuiltinModule;
    globalThis.fetch = realFetch;
    // @ts-expect-error
    delete globalThis.document;
  }
});

test("every test file reads its text with no part at all", async () => {
  const dir = assetDir(...PARTS, ...FONTS);
  const engine = await createPdfEngine({ assetBase: dir });
  for (const bytes of [pdf(), bilevel.jbig2(), jpxPdf(), meshPdf(), tensorPdf(), postScriptPdf()]) {
    using doc = await engine.open(bytes);
    doc.text(0);
  }
  assert.equal(engine.stats().generation, 0);
});
