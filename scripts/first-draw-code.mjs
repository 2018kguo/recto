#!/usr/bin/env node
// Which functions a fresh engine's first draw of a page runs, and how many bytes of code they are:
// what V8 compiles lazily, on the thread that draws, before the first pixels. Needs `npm run build`.
//
//   node scripts/first-draw-code.mjs <file.pdf or directory...> [--width 800] [--pages 1] [--top 40] [--json out.json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { repin } from "./lanes.mjs";
import { functionNames, readList, stableName, wasmSplit, WASM_PARTS } from "./split-wasm.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { width: { type: "string", default: "800" }, pages: { type: "string", default: "1" }, top: { type: "string", default: "40" }, json: { type: "string" } },
});
const root = path.resolve(import.meta.dirname, "..");
const input = path.join(root, "target/wasm-bindgen/recto_bg.wasm");
const PARTS = ["recto-render.wasm", "recto-more.wasm", "recto-rare.wasm"];

/** Each function's body size in bytes, by index (imports excluded, as in the name section's numbering). */
function bodySizes(bytes) {
  let at = 8;
  const leb = () => {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[at++];
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  let imported = 0;
  while (at < bytes.length) {
    const id = bytes[at++];
    const end = leb() + at;
    if (id === 2) {
      for (let count = leb(); count > 0; count--) {
        for (let strings = 0; strings < 2; strings++) {
          const length = leb();
          at += length;
        }
        const kind = bytes[at++];
        if (kind === 0) {
          leb();
          imported++;
        } else if (kind === 1) {
          at++;
          const flags = leb();
          leb();
          if (flags & 1) leb();
        } else if (kind === 2) {
          const flags = leb();
          leb();
          if (flags & 1) leb();
        } else if (kind === 3) {
          at += 2;
        } else {
          throw new Error(`import kind ${kind}`);
        }
      }
    }
    if (id === 10) {
      const sizes = [];
      for (let count = leb(); count > 0; count--) {
        const size = leb();
        sizes.push(size);
        at += size;
      }
      return { imported, sizes };
    }
    at = end;
  }
  throw new Error("no code section");
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "recto-first-draw-"));
fs.cpSync(path.join(root, "js/dist"), path.join(work, "dist"), { recursive: true });
fs.cpSync(path.join(root, "js/wasm"), path.join(work, "wasm"), { recursive: true });
fs.writeFileSync(path.join(work, "package.json"), '{"type":"module"}');
const wasm = (name) => path.join(work, "wasm", name);
wasmSplit(["--instrument", input, "-g", "-o", wasm("recto.wasm")]);
const empty = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
for (const name of PARTS) fs.writeFileSync(wasm(name), empty);
// The bundle carries the pins inline.
repin(work, ["recto.wasm", ...PARTS], await import(path.join(root, "js/wasm/pins.mjs")));

const Instance = WebAssembly.Instance;
let live;
WebAssembly.Instance = function (module, imports) {
  const instance = new Instance(module, imports);
  if (instance.exports.__write_profile) live = instance.exports;
  return instance;
};
const { createPdfEngine } = await import(path.join(work, "dist/index.js"));

/** The functions run so far on the engine's instance, by name. */
function ran() {
  const size = 1 << 20;
  const at = live.__wbindgen_malloc(size, 1);
  const length = live.__write_profile(at, size);
  const file = path.join(work, "run.prof");
  fs.writeFileSync(file, new Uint8Array(live.memory.buffer, at, length));
  return new Set(
    wasmSplit(["--print-profile", file, input])
      .split("\n")
      .filter((line) => line.startsWith("+ "))
      .map((line) => line.slice(2)),
  );
}

const module = fs.readFileSync(input);
const names = functionNames(module);
const { imported, sizes } = bodySizes(module);
const size = new Map(names.map((name, i) => [name, sizes[i - imported] ?? 0]));
const files = positionals.flatMap((entry) =>
  fs.statSync(entry).isDirectory()
    ? fs.readdirSync(entry).filter((name) => name.endsWith(".pdf")).sort().map((name) => path.join(entry, name))
    : [entry],
);
const results = [];
const counts = new Map();
// What ran that no list names: it came from another part, which a first draw then downloads.
const listed = new Set(WASM_PARTS.flatMap((part) => [...readList(part)]));
const unlisted = new Map();
for (const file of files) {
  const bytes = fs.readFileSync(file);
  try {
    // A fresh instance each: its profile starts empty, as a fresh page's code does.
    const engine = await createPdfEngine();
    const doc = await engine.open(bytes);
    if (doc.pageCount === 0) continue;
    doc.plainText(0);
    const before = ran();
    for (let i = 0; i < Math.min(doc.pageCount, Number(values.pages)); i++) doc.render(i, { width: Number(values.width) });
    const after = ran();
    doc.close();
    const drawn = [...after].filter((name) => !before.has(name));
    for (const name of after) {
      if (!listed.has(stableName(name)) && !/sha256/u.test(name)) unlisted.set(name, (unlisted.get(name) ?? 0) + 1);
    }
    for (const name of drawn) counts.set(name, (counts.get(name) ?? 0) + 1);
    const total = drawn.reduce((sum, name) => sum + (size.get(name) ?? 0), 0);
    results.push({ file: path.basename(file), functions: drawn.length, bytes: total, drawn });
  } catch {
    // A file the engine refuses draws nothing.
  }
}
fs.rmSync(work, { recursive: true });
const sorted = results.map((r) => r.bytes).sort((a, b) => a - b);
const sum = sorted.reduce((a, b) => a + b, 0);
console.log(
  `${results.length} files: the first draw compiles a median ${sorted[Math.floor(sorted.length / 2)]} bytes, mean ${Math.round(sum / sorted.length)}, total ${sum}`,
);
if (results.length === 1) {
  const drawn = results[0].drawn.map((name) => [name, size.get(name) ?? 0]).sort((a, b) => b[1] - a[1]);
  console.log(`${drawn.length} functions`);
  for (const [name, n] of drawn.slice(0, Number(values.top))) console.log(`${String(n).padStart(7)}  ${name.slice(0, 160)}`);
} else {
  // Bytes compiled over every file's first draw, by function: what to make smaller first.
  const weighted = [...counts].map(([name, n]) => [name, n, n * (size.get(name) ?? 0)]).sort((a, b) => b[2] - a[2]);
  for (const [name, n, total] of weighted.slice(0, Number(values.top))) {
    console.log(`${String(total).padStart(9)} ${String(n).padStart(4)}x ${String(size.get(name)).padStart(6)}  ${name.slice(0, 150)}`);
  }
}
for (const [name, n] of unlisted) console.log(`not in a list (so in another part), ${n} files: ${name.slice(0, 200)}`);
if (values.json) fs.writeFileSync(values.json, JSON.stringify(results.map(({ drawn, ...rest }) => rest), null, 1));
