#!/usr/bin/env node
// The whole benchmark refresh in one command: builds recto if its sources changed, runs every benchmark
// docs/benchmarks.md quotes, writes each one's results to bench/results/, and with --docs rewrites the
// tables there from them (scripts/bench-docs.mjs).
//
//   npm run bench:refresh -- [--corpus ~/.cache/recto-corpus] [--only node,browser,...] [--skip node,...] [--docs]
//
// The steps, in order: the counting ones first, each with every core (text, boxes, scorecard, wild), then
// the timed ones, one process at a time (node, browser, browser-full-speed). Timed rounds are paired and
// stop when settled (bench.mjs), behind a soft gate that waits up to a minute for a core to spare, so a
// busy machine makes a refresh slower and its intervals a little wider, not hours late. Generated PDFs
// and the build are cached between runs; the scorecard and wild runs cache by recto's wasm. Each step's
// command and wall time go in bench/results/refresh.json.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { cacheDir } from "./cache.mjs";

const here = import.meta.dirname;
const root = path.join(here, "..");
const { values } = parseArgs({
  options: {
    corpus: { type: "string", default: path.join(os.homedir(), ".cache/recto-corpus") },
    results: { type: "string", default: path.join(here, "results") },
    only: { type: "string" },
    skip: { type: "string", default: "" },
    docs: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    jobs: { type: "string", default: String(Math.max(1, os.availableParallelism() - 1)) },
    "min-idle": { type: "string", default: "10" },
    "max-wait": { type: "string", default: "60" },
  },
});
const corpus = values.corpus;
const out = (name) => path.join(values.results, name);
const pub = path.join(corpus, "pub");
const suites = ["pdfjs", "pdfium", "hayro"].map((name) => path.join(corpus, "suites", name));
const jobs = values.jobs;
const gate = ["--min-idle", values["min-idle"], "--max-wait", values["max-wait"]];
const node = (script, ...args) => [process.execPath, path.join(here, script), ...args];

/** Every step: what it runs, and whether it times anything (those run alone, after the rest). */
const STEPS = {
  text: { timed: false, run: node("text-compare.mjs", pub, ...suites, "--docs", "1000", "--jobs", jobs, "--out", out("text.json")) },
  "text-public": { timed: false, run: node("text-compare.mjs", pub, "--jobs", jobs, "--out", out("text-public.json")) },
  boxes: { timed: false, run: node("box-compare.mjs", pub, ...suites, "--tight", "--jobs", jobs, "--out", out("boxes.json")) },
  scorecard: {
    timed: false,
    run: node(
      "scorecard.mjs",
      `public=${pub}`,
      ...suites.map((dir) => `${path.basename(dir)}=${dir}`),
      "--private",
      "public",
      "--engines",
      "recto,pdfium,pdf.js,poppler,mupdf",
      "--jobs",
      jobs,
      "--out",
      cacheDir("scorecard"),
      "--results",
      out("scorecard.json"),
    ),
  },
  wild: { timed: false, run: node("wild.mjs", "run", "--dir", path.join(corpus, "wild"), "--jobs", jobs, "--results", out("wild.json")) },
  node: { timed: true, run: node("bench.mjs", pub, ...gate, "--out", out("node.json")) },
  browser: { timed: true, run: node("browser.mjs", pub, ...gate, "--out", out("browser.json")) },
  "browser-full-speed": { timed: true, run: node("browser.mjs", pub, ...gate, "--slowdown", "1", "--out", out("browser-full-speed.json")) },
};

const wanted = (values.only ? values.only.split(",") : Object.keys(STEPS)).filter((name) => !values.skip.split(",").includes(name));
for (const name of wanted) if (!STEPS[name]) throw new Error(`no step ${name}: ${Object.keys(STEPS).join(", ")}`);

/**
 * A hash of everything `npm run build` reads: the tracked sources as committed, what has changed in them
 * since, and any untracked files among them. Equal to the last build's, the build is skipped.
 */
function sourceHash() {
  const paths = ["crates", "vendor", "js/src", "js/package.json", "js/tsconfig.json", "scripts", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml"];
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { maxBuffer: 2 ** 30 });
  const hash = createHash("sha256");
  hash.update(git("ls-files", "-s", "--", ...paths));
  hash.update(git("diff", "HEAD", "--binary", "--", ...paths));
  for (const file of git("ls-files", "-o", "--exclude-standard", "--", ...paths).toString().split("\n").filter(Boolean)) {
    hash.update(file).update(fs.readFileSync(path.join(root, file)));
  }
  return hash.digest("hex");
}

function run(command, label) {
  console.error(`\n== ${label}: ${command.map((part) => (part.includes(" ") ? JSON.stringify(part) : part)).join(" ")}`);
  if (values["dry-run"]) return Promise.resolve(0);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
    proc.once("exit", (code) => {
      const seconds = Math.round((Date.now() - started) / 1000);
      console.error(`== ${label}: ${code === 0 ? "done" : `exited ${code}`} in ${seconds} s`);
      if (code === 0) resolve(seconds);
      else reject(new Error(`${label} exited ${code}`));
    });
  });
}

/** A path as the log shows it: from the repository, or from ~, so no one's home directory is in it. */
const shown = (part) => (!path.isAbsolute(part) ? part : part.startsWith(root) ? path.relative(root, part) : part.replace(os.homedir(), "~"));

const begun = Date.now();
const log = { date: new Date().toISOString(), machine: `${os.cpus()[0].model}, ${os.cpus().length} cores`, loadAtStart: os.loadavg()[0], steps: {} };

const stamp = path.join(root, "js/dist/.source-hash");
const hash = sourceHash();
if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === hash) {
  console.error("recto is built from these sources already; not rebuilding");
  log.steps.build = { seconds: 0, cached: true };
} else {
  log.steps.build = { seconds: await run(["npm", "run", "build"], "build") };
  if (!values["dry-run"]) fs.writeFileSync(stamp, hash);
}
log.steps.install = { seconds: await run(["npm", "install", "--prefix", "bench", "--no-audit", "--no-fund"], "bench dependencies") };

for (const timed of [false, true]) {
  for (const name of wanted.filter((step) => STEPS[step].timed === timed)) {
    log.steps[name] = { command: STEPS[name].run.slice(1).map(shown).join(" "), seconds: await run(STEPS[name].run, name) };
  }
}
if (values.docs) log.steps.docs = { seconds: await run([process.execPath, path.join(root, "scripts/bench-docs.mjs")], "docs") };
log.seconds = Math.round((Date.now() - begun) / 1000);
log.loadAtEnd = os.loadavg()[0];
if (!values["dry-run"]) fs.writeFileSync(out("refresh.json"), `${JSON.stringify(log, null, 1)}\n`);
console.error(`\nrefresh done in ${Math.round(log.seconds / 60)} min`);
