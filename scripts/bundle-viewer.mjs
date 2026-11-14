#!/usr/bin/env node
// Bundles the viewer after tsc, in place: its page side into dist/viewer/index.js and its worker,
// with the engine, into dist/viewer/worker.js, one file each. Unbundled, a browser discovers the 25
// modules between the viewer's import and the engine's wasm one import at a time, about ten round
// trips before the PDF is even asked for; bundled, it's two.
//
// The engine finds its files as `new URL("../wasm/…", import.meta.url)` from dist/assets.js. In the
// worker's bundle, a directory deeper, that's "../../wasm/…": rewritten here, still in the literal form
// bundlers follow. The other dist/viewer/*.js modules stay, unused by these two.
//
// Then the package's own entry, dist/index.js, the same way: unbundled it's a dozen modules four imports
// deep, as many round trips before recto.wasm is asked for. Bundled and minified, it's index.js and one
// shared chunk, which pool.js and pool-worker.js import too, so a pool's errors are the same PdfError
// class and its wasm the same compiled module. The modules bundled into them are removed; their .d.ts stay.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const dist = path.join(import.meta.dirname, "../js/dist");
const common = { bundle: true, format: "esm", target: "es2023", platform: "neutral", allowOverwrite: true, legalComments: "none", logLevel: "warning" };

await build({
  ...common,
  entryPoints: [path.join(dist, "viewer/index.js")],
  outfile: path.join(dist, "viewer/index.js"),
});

const assets = path.join(dist, "assets.js");
const deeper = {
  name: "wasm-one-level-up",
  setup(on) {
    on.onLoad({ filter: /[\\/]dist[\\/]assets\.js$/ }, () => {
      const source = fs.readFileSync(assets, "utf8");
      const moved = source.replaceAll('new URL("../wasm/', 'new URL("../../wasm/');
      assert.notEqual(moved, source, "assets.js names its files as new URL(\"../wasm/…\", import.meta.url)");
      return { contents: moved, loader: "js" };
    });
  },
};
await build({
  ...common,
  entryPoints: [path.join(dist, "viewer/worker.js")],
  outfile: path.join(dist, "viewer/worker.js"),
  plugins: [deeper],
});
const worker = fs.readFileSync(path.join(dist, "viewer/worker.js"), "utf8");
// Only the wasm/ files are named relative to the bundle, and none from where it no longer is.
assert.ok(!/new URL\("\.\.\/wasm\//u.test(worker) && !/import\(/u.test(worker), "the worker's bundle names a file by a path that moved");

const entries = ["index.js", "pool.js", "pool-worker.js"];
// tsc writes into dist/ without emptying it: a previous build's chunk would be left beside this one's.
for (const name of fs.readdirSync(dist).filter((name) => /^engine-.*\.js$/u.test(name))) fs.rmSync(path.join(dist, name));
const before = new Set(fs.readdirSync(dist).filter((name) => name.endsWith(".js")));
const { metafile } = await build({
  ...common,
  entryPoints: entries.map((name) => path.join(dist, name)),
  outdir: dist,
  splitting: true,
  minify: true,
  chunkNames: "engine-[hash]",
  external: ["node:*"],
  metafile: true,
});
const bundled = new Set(Object.values(metafile.outputs).flatMap((output) => Object.keys(output.inputs)).map((input) => path.resolve(input)));
for (const name of before) {
  if (!entries.includes(name) && bundled.has(path.join(dist, name))) {
    fs.rmSync(path.join(dist, name));
  }
}
const left = fs.readdirSync(dist).filter((name) => name.endsWith(".js"));
assert.ok(left.length === entries.length + 1, `dist/ holds the entries and one shared chunk, not ${left.join(", ")}`);
// The chunk is in dist/, as assets.js was, so its "../wasm/…" still names the package's files.
assert.ok(left.some((name) => /^engine-/u.test(name) && fs.readFileSync(path.join(dist, name), "utf8").includes('new URL("../wasm/recto.wasm",import.meta.url)')), "the shared chunk names the wasm as a bundler can follow");
