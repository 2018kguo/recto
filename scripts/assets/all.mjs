#!/usr/bin/env node
// Everything under docs/ that's generated. `npm run build` first; the chart and the social image
// read bench/results, so run the benchmarks first if those should move. Needs ffmpeg.
import { execFileSync } from "node:child_process";
import path from "node:path";

for (const script of ["anatomy", "chart", "social", "film"]) {
  execFileSync(process.execPath, [path.join(import.meta.dirname, `${script}.mjs`)], { stdio: "inherit", timeout: 15 * 60_000 });
}
