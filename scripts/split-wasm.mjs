// Splits the one built wasm by what a call runs, with binaryen's wasm-split:
//
//   recto.wasm         what reading text runs
//   recto-render.wasm  what drawing a page adds
//   recto-more.wasm    what no page in the profile ran, but a stranger file might to read one
//   recto-rare.wasm    the same for decoders and drawing: JBIG2, JPEG 2000, CCITT, mesh shadings
//
// A function that's elsewhere is a placeholder here, and calling it loads its part (src/engine.ts),
// so a list that's out of date costs a download and never a result. scripts/wasm-parts holds the
// lists, by name, and scripts/profile-wasm.mjs writes them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const WASM_PARTS = ["text", "render"];
/** Who a function not in the lists belongs with, by what its name says. */
const DRAWING = /hayro_jbig2|hayro_jpeg2000|hayro_ccitt|zune_|vello_|pic_scale|ab_glyph|\bhayro::|fearless_simd|peniko|skrifa::outline/u;
/** Asset checks run these while a part loads, so they can't be in one. */
const MUST_STAY = /sha256/u;
const listFile = (part) => path.join(import.meta.dirname, "wasm-parts", `${part}.txt`);

/** Without each crate's build hash, which moves when its dependencies do. */
export const stableName = (name) => name.replace(/\[[0-9a-f]{16}\]/gu, "");
export const readList = (part) => new Set(fs.readFileSync(listFile(part), "utf8").split("\n").filter(Boolean));
export const writeList = (part, names) => fs.writeFileSync(listFile(part), `${[...names].sort().join("\n")}\n`);

/** A module's function names, from its name section. */
export function functionNames(bytes) {
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
  const string = () => {
    const length = leb();
    at += length;
    return bytes.toString("utf8", at - length, at);
  };
  while (at < bytes.length) {
    const id = bytes[at++];
    const end = leb() + at;
    if (id === 0 && string() === "name") {
      while (at < end) {
        const kind = bytes[at++];
        const subsectionEnd = leb() + at;
        if (kind === 1) {
          const names = [];
          for (let count = leb(); count > 0; count--) {
            leb();
            names.push(string());
          }
          return names;
        }
        at = subsectionEnd;
      }
    }
    at = end;
  }
  throw new Error("the wasm has no function names");
}

const FEATURES = ["simd", "bulk-memory", "nontrapping-float-to-int", "sign-ext", "multivalue", "reference-types", "mutable-globals"].map((f) => `--enable-${f}`);

export function wasmSplit(args) {
  return execFileSync(process.env.WASM_SPLIT ?? "wasm-split", [...FEATURES, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    // It warns of each import it can't move, which is all of them. A failure still carries this.
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function splitWasm(input, outDir) {
  const bytes = fs.readFileSync(input);
  const [text, render] = WASM_PARTS.map(readList);
  const parts = { "recto-render": [], "recto-more": [], "recto-rare": [] };
  let kept = 0;
  let stay = 0;
  for (const name of functionNames(bytes)) {
    const stable = stableName(name);
    if (MUST_STAY.test(stable)) stay++;
    if (text.has(stable) || MUST_STAY.test(stable)) kept++;
    else if (render.has(stable)) parts["recto-render"].push(name);
    else parts[DRAWING.test(stable) ? "recto-rare" : "recto-more"].push(name);
  }
  if (stay === 0) throw new Error("the asset check's hash isn't in the wasm under the name it had");
  const manifest = path.join(outDir, "split-manifest.txt");
  fs.writeFileSync(manifest, Object.entries(parts).map(([part, names]) => `${part}\n${names.join("\n")}\n`).join("\n"));
  wasmSplit([
    "--multi-split", input,
    `--manifest=${manifest}`,
    `--out-prefix=${outDir}${path.sep}`,
    "--placeholder-namespace-prefix=part",
    "--import-namespace=primary",
    "--export-prefix=%",
    "--strip-debug",
    "-o", path.join(outDir, "recto.wasm"),
  ]);
  fs.rmSync(manifest);
  console.log(`split: ${kept} functions to read text, ${Object.entries(parts).map(([part, names]) => `${names.length} in ${part}`).join(", ")}`);
}
