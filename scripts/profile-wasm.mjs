#!/usr/bin/env node
// Writes scripts/wasm-parts: which functions read text and which draw, from running the unsplit
// wasm over the PDFs in the given directories and the test fixtures. It adds to what's there and
// drops what the build no longer has; --replace starts over. Needs `npm run build` first.
//
//   node scripts/profile-wasm.mjs [--replace] [directory of PDFs...]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { functionNames, readList, stableName, wasmSplit, writeList } from "./split-wasm.mjs";

const root = path.resolve(import.meta.dirname, "..");
const PARTS = ["recto-render.wasm", "recto-more.wasm", "recto-rare.wasm"];
const args = process.argv.slice(2);
const replace = args[0] === "--replace";
const dirs = [...args.slice(replace ? 1 : 0), path.join(root, "js/test/fixtures")];
const files = dirs.flatMap((dir) =>
  fs.readdirSync(dir).filter((name) => name.endsWith(".pdf")).map((name) => path.join(dir, name)),
);
const input = path.join(root, "target/wasm-bindgen/recto_bg.wasm");

// The package again, with the whole wasm instrumented as its first file and empty parts.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "recto-profile-"));
fs.cpSync(path.join(root, "js/dist"), path.join(work, "dist"), { recursive: true });
fs.cpSync(path.join(root, "js/wasm"), path.join(work, "wasm"), { recursive: true });
fs.writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
const wasm = (name) => path.join(work, "wasm", name);
wasmSplit(["--instrument", input, "-g", "-o", wasm("recto.wasm")]);
const empty = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
for (const name of PARTS) fs.writeFileSync(wasm(name), empty);
const { createHash } = await import("node:crypto");
const pins = await import(path.join(root, "js/wasm/pins.mjs"));
const repinned = { ...pins.PINS };
for (const name of ["recto.wasm", ...PARTS]) {
  repinned[name] = createHash("sha256").update(fs.readFileSync(wasm(name))).digest("hex");
}
fs.writeFileSync(wasm("pins.mjs"), `export const PINS = ${JSON.stringify(repinned)};\n`);

const Instance = WebAssembly.Instance;
let live;
WebAssembly.Instance = function (module, imports) {
  const instance = new Instance(module, imports);
  if (instance.exports.__write_profile) live = instance.exports;
  return instance;
};
const { createPdfEngine } = await import(path.join(work, "dist/index.js"));

/** Which functions ran in `pass`, over every file. */
async function profile(label, pass) {
  const dir = path.join(work, label);
  fs.mkdirSync(dir);
  let n = 0;
  for (const file of files) {
    const engine = await createPdfEngine({ recycleAboveBytes: 2 ** 32 });
    for (const password of [undefined, "secret"]) {
      try {
        const doc = await engine.open(fs.readFileSync(file), { password });
        await pass(doc);
        doc.close();
        break;
      } catch (error) {
        if (error.code !== "password-required" && error.code !== "wrong-password" && error.code !== "invalid-file") throw error;
      }
    }
    // Not reached from Node, which has its own hash, but a browser's asset check runs it.
    live.sha256(0, 0);
    const size = 1 << 20;
    const at = live.__wbindgen_malloc(size, 1);
    const length = live.__write_profile(at, size);
    fs.writeFileSync(path.join(dir, `${n++}.prof`), new Uint8Array(live.memory.buffer, at, length));
  }
  const merged = path.join(work, `${label}.prof`);
  wasmSplit(["--merge-profiles", ...fs.readdirSync(dir).map((name) => path.join(dir, name)), "-o", merged]);
  return new Set(
    wasmSplit(["--print-profile", merged, input])
      .split("\n")
      .filter((line) => line.startsWith("+ "))
      .map((line) => stableName(line.slice(2))),
  );
}

const text = await profile("text", async (doc) => {
  doc.outline();
  doc.pageLabels();
  doc.structureTruncated();
  for (let i = 0; i < Math.min(doc.pageCount, 40); i++) {
    doc.pageInfo(i);
    doc.text(i);
    doc.annotations(i);
    doc.textAndAnnotations(i);
  }
});
const drawn = await profile("render", async (doc) => {
  for (let i = 0; i < Math.min(doc.pageCount, 8); i++) {
    doc.render(i, { width: 800 });
    await doc.renderAsync(i, { width: 400 });
    // Thumbnails: images shrink by another path.
    for (const width of [32, 64, 100, 150, 200, 300]) {
      doc.render(i, { width });
    }
    doc.objects(i);
    doc.scan(i);
  }
});
const present = new Set(functionNames(fs.readFileSync(input)).map(stableName));
const merged = (part, found) =>
  [...(replace ? [] : readList(part)), ...found].filter((name) => present.has(name));
const textList = new Set(merged("text", text));
const renderList = new Set(merged("render", drawn).filter((name) => !textList.has(name)));
writeList("text", textList);
writeList("render", renderList);
fs.rmSync(work, { recursive: true });
console.log(`${files.length} PDFs: ${textList.size} functions read text, ${renderList.size} more draw, of ${present.size}`);
