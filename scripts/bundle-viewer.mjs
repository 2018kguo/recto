#!/usr/bin/env node
// Bundles the viewer after tsc, in place: its page side into dist/viewer/index.js and its worker,
// with the engine, into dist/viewer/worker.js, one file each. Unbundled, a browser discovers the 25
// modules between the viewer's import and the engine's wasm one import at a time, about ten round
// trips before the PDF is even asked for; bundled, it's two.
//
// The engine finds its files as `new URL("../wasm/…", import.meta.url)` from dist/assets.js. In the
// worker's bundle, a directory deeper, that's "../../wasm/…": rewritten here, still in the literal form
// bundlers follow. The other dist/viewer/*.js modules stay, unused by these two.
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
