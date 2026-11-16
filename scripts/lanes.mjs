// What the engine checks each file by (crates/recto/src/sha256_lanes.rs): SHA-256 over the SHA-256
// digests of eight lanes, each a whole number of 64-byte blocks, the last ones shorter or empty.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest();

export function sha256Lanes(bytes) {
  const lane = Math.ceil(Math.ceil(bytes.length / 8) / 64) * 64;
  const lanes = Array.from({ length: 8 }, (_, i) =>
    digest(bytes.subarray(Math.min(i * lane, bytes.length), Math.min((i + 1) * lane, bytes.length))),
  );
  return digest(Buffer.concat(lanes)).toString("hex");
}

/**
 * A copy of the package whose wasm files changed: its pins, which the bundle carries inline, made the
 * new files' own. `dir` holds dist/ and wasm/; `names` are the files that changed.
 */
export function repin(dir, names, { LANE_PINS }) {
  const wasm = (name) => path.join(dir, "wasm", name);
  const pins = Object.fromEntries(names.map((name) => [name, sha256Lanes(fs.readFileSync(wasm(name)))]));
  for (const name of fs.readdirSync(path.join(dir, "dist")).filter((file) => file.endsWith(".js"))) {
    const file = path.join(dir, "dist", name);
    let source = fs.readFileSync(file, "utf8");
    for (const changed of names) source = source.replaceAll(LANE_PINS[changed], pins[changed]);
    fs.writeFileSync(file, source);
  }
}
