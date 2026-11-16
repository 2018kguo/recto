// Where the benchmarks keep what is slow to make and the same next time: generated PDFs, keyed by the hash
// of bench/generate.mjs and what was asked, and the scorecard's renders. `RECTO_BENCH_CACHE` moves it; deleting
// it is always safe.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function cacheDir(...parts) {
  const dir = path.join(process.env.RECTO_BENCH_CACHE ?? path.join(os.homedir(), ".cache/recto-bench"), ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const generator = createHash("sha256")
  .update(fs.readFileSync(path.join(import.meta.dirname, "generate.mjs")))
  .digest("hex")
  .slice(0, 16);

/** The path of a generated PDF, made by `make()` only when this generator and `label` haven't made it before. */
export function generatedPdf(label, make) {
  const file = path.join(cacheDir("generated"), `${generator}-${label}.pdf`);
  if (!fs.existsSync(file)) {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, make());
    fs.renameSync(temp, file);
  }
  return file;
}
