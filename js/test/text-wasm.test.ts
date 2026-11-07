// A document starts on the text-only wasm and moves to the full one the first time it's asked for
// something that needs it. None of that may show, except in what's loaded.
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createPdfEngine } from "../src/index.ts";
import { startRangeServer } from "./range-server.ts";
import { syntheticPdf } from "./synthetic-pdf.ts";

const packaged = (name: string) => new URL(`../wasm/${name}`, import.meta.url);
const ASSETS = ["recto.wasm", "recto-text.wasm", "fonts.bin", "cjk-fallback.ttf", "cmaps.deflate"];
function assetDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recto-text-wasm-"));
  for (const name of ASSETS) {
    copyFileSync(packaged(name), join(dir, name));
  }
  return dir;
}
const pdf = () => syntheticPdf({ pages: 2, charsPerPage: 200 });

test("text needs neither the full wasm nor a font file; render loads it, and a failure there isn't final", async () => {
  const dir = assetDir();
  rmSync(join(dir, "recto.wasm"));
  rmSync(join(dir, "fonts.bin"));
  const bytes = pdf();
  const engine = await createPdfEngine({ assetBase: dir, preloadAssets: [] });
  using doc = await engine.open(bytes);
  assert.ok(doc.text(0).text.length > 100);
  assert.ok(doc.outline());
  assert.ok(doc.annotations(0));
  assert.throws(() => doc.render(0, { width: 100 }), { code: "missing-asset", message: /recto\.wasm/u });
  assert.throws(() => doc.objects(0), { code: "missing-asset" });
  assert.ok(doc.text(0).text.length > 100, "a failed move leaves the document where it was");
  copyFileSync(packaged("recto.wasm"), join(dir, "recto.wasm"));
  copyFileSync(packaged("fonts.bin"), join(dir, "fonts.bin"));
  assert.ok(doc.render(0, { width: 100 }).rgba.some((v) => v !== 255));
});

test("a document reads the same before and after it moves, and draws the same as one that never read text", async () => {
  const bytes = pdf();
  const engine = await createPdfEngine({ preloadAssets: [] });
  using doc = await engine.open(bytes);
  const before = doc.text(0);
  const first = doc.render(0, { width: 300 });
  assert.deepEqual({ ...doc.text(0) }, { ...before });
  assert.equal(engine.stats().openDocuments, 1);
  const other = await createPdfEngine({ preloadAssets: [] });
  using direct = await other.open(bytes);
  assert.deepEqual(direct.render(0, { width: 300 }).rgba, first.rgba);
  assert.ok(doc.objects(0));
});

test("documents open on the text wasm move one at a time, and later ones start on the full one", async () => {
  const bytes = pdf();
  const engine = await createPdfEngine({ preloadAssets: [] });
  const a = await engine.open(bytes);
  const b = await engine.open(bytes);
  a.render(0, { width: 100 });
  assert.ok(b.text(0).text.length > 100, "the other document is still on the text wasm");
  b.render(0, { width: 100 });
  const c = await engine.open(bytes);
  assert.equal(engine.stats().generation, 1, "no third instance");
  a.close();
  b.close();
  c.close();
  assert.equal(engine.stats().openDocuments, 0);
});

test("a password survives the move", async () => {
  const bytes = readFileSync(new URL("./fixtures/user-password-secret.pdf", import.meta.url));
  const engine = await createPdfEngine({ preloadAssets: [] });
  using doc = await engine.open(bytes, { password: "secret" });
  assert.ok(doc.render(0, { width: 100 }).width === 100);
});

test("a ranged document moves without fetching what it already read", async () => {
  const bytes = pdf();
  const server = await startRangeServer(bytes);
  try {
    const engine = await createPdfEngine({ preloadAssets: [] });
    using doc = await engine.openRanged(server.url);
    const text = doc.text(0).text;
    const fetched = doc.stats().bytesFetched;
    assert.ok(doc.render(0, { width: 100 }).width === 100);
    assert.equal(doc.text(0).text, text);
    assert.equal(doc.stats().bytesFetched, fetched);
  } finally {
    await server.close();
  }
});

test("in Node, with no download to save, an engine starts on the full wasm and render doesn't move", async () => {
  const engine = await createPdfEngine();
  using doc = await engine.open(pdf());
  doc.render(0, { width: 100 });
  assert.equal(engine.stats().generation, 0);
});
