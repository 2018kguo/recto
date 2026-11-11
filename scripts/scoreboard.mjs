#!/usr/bin/env node
// One rerunnable scoreboard of what a release must not regress: speed (WASM in Node and native), load,
// memory, growth with input size, fidelity and simplicity. docs/benchmarks.md#the-scoreboard says how
// to read it.
//
//   npm run scoreboard -- [--base <git-ref>] [--quick] [--rounds 8] [--name label] [--corpus dir] [--no-fidelity]
//
// Builds the working tree, and with --base that ref in a cache directory of its own (kept, so the next
// run against it starts measuring at once). The harness is this file's for both: the ref gets this
// tree's crates/recto/examples/scoreboard.rs and scorecard scripts, and only its engine is its own.
// Timed work runs one process at a time, base and new alternating round by round in fresh processes.
// Writes bench/scoreboard/<name>.json; PDFs and their names never go in it, only hashes.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import zlib from "node:zlib";

const PAGES = 100; // "all pages" stops here in a file, so a 9,000-page file doesn't outweigh the rest
const WIDTHS = [1024, 1600];
const FIRST = 2;
const COLD = 3; // fresh processes per tree per round for the cold start
const FLAG_EXPONENT = 1.15;
const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const pct = (v, p) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.round((s.length - 1) * p)];
};
const pdfsIn = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".pdf")).sort().map((n) => path.join(dir, n))
    : [];

// ---- Workers: each runs in a fresh process and prints one line of JSON.

if (process.argv[2] === "--worker") {
  const [, , , kind, dist, ...rest] = process.argv;
  const started = performance.now();
  const { createPdfEngine } = await import(path.join(dist, "index.js"));
  const engine = await createPdfEngine();
  let peak = 0;
  const heap = () => (peak = Math.max(peak, engine.stats().heapBytes));
  if (kind === "cold") {
    const doc = await engine.open(fs.readFileSync(rest[0]));
    doc.text(0);
    const text = performance.now() - started;
    doc.render(0, { width: 1024 });
    console.log(JSON.stringify({ text, render: performance.now() - started }));
  } else if (kind === "speed") {
    const files = [];
    for (const file of rest) {
      const bytes = fs.readFileSync(file);
      let t = performance.now();
      let doc;
      try {
        doc = await engine.open(bytes);
      } catch {
        files.push(null);
        continue;
      }
      const open = performance.now() - t;
      const n = Math.min(doc.pageCount, PAGES);
      const timed = (f) => {
        t = performance.now();
        try {
          f();
        } catch {}
        heap();
        return performance.now() - t;
      };
      const text = Array.from({ length: n }, (_, i) => timed(() => doc.text(i)));
      const render = WIDTHS.map((width) => Array.from({ length: n }, (_, i) => timed(() => doc.render(i, { width }))));
      doc.close();
      files.push({ open, text, render });
    }
    console.log(JSON.stringify({ files, peakWasmBytes: peak }));
  } else if (kind === "text") {
    const hashes = {};
    for (const file of rest) {
      const bytes = fs.readFileSync(file);
      const id = sha1(bytes).slice(0, 12);
      try {
        const doc = await engine.open(bytes);
        const hash = createHash("sha1");
        for (let i = 0; i < doc.pageCount; i++) {
          try {
            hash.update(doc.text(i).text).update("\f");
          } catch (error) {
            hash.update(`error ${error.code}\f`);
          }
          heap();
        }
        hashes[id] = hash.digest("hex").slice(0, 16);
        doc.close();
      } catch (error) {
        hashes[id] = `open failed: ${error.code}`;
      }
    }
    console.log(JSON.stringify({ hashes, peakWasmBytes: peak }));
  }
  process.exit(0);
}

// ---- Options and the trees

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    quick: { type: "boolean", default: false },
    rounds: { type: "string" },
    name: { type: "string" },
    corpus: { type: "string", default: path.join(os.homedir(), ".cache/recto-corpus") },
    "no-fidelity": { type: "boolean", default: false },
  },
});
const ROUNDS = Number(values.rounds ?? (values.quick ? 2 : 8));
const root = path.resolve(import.meta.dirname, "..");
const cache = path.join(os.homedir(), ".cache/recto-scoreboard");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const log = (...args) => console.error(`[scoreboard] ${args.join(" ")}`);
const run = (cmd, args, cwd, logFile) => {
  const out = fs.openSync(logFile, "w");
  const result = spawnSync(cmd, args, { cwd, stdio: ["ignore", out, out], env: { ...process.env, FORCE_COLOR: "0" } });
  fs.closeSync(out);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}; see ${logFile}`);
};
fs.mkdirSync(cache, { recursive: true });

function build(dir, label) {
  const logFile = path.join(cache, `build-${label}.log`);
  log(`building ${label} (${logFile})`);
  run("npm", ["run", "build"], dir, logFile);
  run("cargo", ["build", "--release", "-p", "recto", "--example", "scoreboard"], dir, `${logFile}.native`);
}

const dirty = git("status", "--porcelain", "--", "crates", "vendor", "js/src", "scripts", "Cargo.lock", "Cargo.toml", ":!scripts/scoreboard.mjs", ":!crates/recto/examples/scoreboard.rs") !== "";
const head = git("rev-parse", "--short", "HEAD");
const newTree = { label: values.name ?? `${head}${dirty ? "-dirty" : ""}`, dir: root, commit: head, dirty };
build(root, "new");
const trees = [newTree];
if (values.base) {
  const commit = git("rev-parse", "--short", `${values.base}^{commit}`);
  const dir = path.join(cache, "trees", commit);
  if (!fs.existsSync(path.join(dir, ".built"))) {
    const tmp = `${dir}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync("sh", ["-c", `git archive ${commit} | tar -x -C "${tmp}"`], { cwd: root });
    // This tree's harness; the ref's engine.
    for (const file of ["crates/recto/examples/scoreboard.rs", "bench/scorecard.mjs", "bench/scorecard-worker.mjs", "bench/engines.mjs", "bench/generate.mjs"]) {
      fs.copyFileSync(path.join(root, file), path.join(tmp, file));
    }
    for (const modules of ["node_modules", "bench/node_modules"]) fs.symlinkSync(path.join(root, modules), path.join(tmp, modules));
    build(tmp, commit);
    fs.writeFileSync(path.join(tmp, ".built"), "");
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
      fs.renameSync(tmp, dir);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another run built it first
    }
  }
  trees.unshift({ label: values.base, dir, commit, dirty: false });
}

const corpus = values.corpus;
const sets = { pub: path.join(corpus, "pub"), pdfjs: path.join(corpus, "suites/pdfjs"), pdfium: path.join(corpus, "suites/pdfium"), hayro: path.join(corpus, "suites/hayro") };
const speedFiles = pdfsIn(sets.pub);
const allFiles = Object.values(sets).flatMap(pdfsIn);
if (speedFiles.length === 0) throw new Error(`no PDFs in ${sets.pub}`);

// ---- Synthetic files for growth with size: 3 sizes a dimension, 4× apart.

const { assemble, flate, heavyPagePdf, reportPdf } = await import(path.join(root, "bench/generate.mjs"));
const onePage = (content, resources = "") =>
  assemble(
    [
      "<</Type /Catalog /Pages 2 0 R>>",
      "<</Type /Pages /Count 1 /Kids [3 0 R]>>",
      `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <<${resources}>>>>`,
      flate(content),
      "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>",
    ],
    1,
  );
const FONT = "/Font <</F 5 0 R>>";
const GROWTH = {
  pages: { sizes: [8, 32, 128], make: (n) => reportPdf({ pages: n, imageEvery: 1e9, imageSize: 64 }) },
  charsPerPage: {
    sizes: [4_000, 16_000, 64_000],
    make: (n) => {
      let content = "BT /F 3 Tf 3.2 TL 20 780 Td\n";
      for (let i = 0; i < n; i += 100) content += `(${"Lorem ipsum dolor sit amet ".repeat(4).slice(0, 100)}) ' \n`;
      return onePage(`${content}ET`, FONT);
    },
  },
  pathsPerPage: { sizes: [2_000, 8_000, 32_000], make: (paths) => heavyPagePdf({ paths }) },
  clipDepth: {
    sizes: [256, 1024, 4096],
    make: (n) => {
      let content = "";
      for (let i = 0; i < n; i++) content += `q ${(i * 0.2).toFixed(1)} ${(i * 0.3).toFixed(1)} ${(600 - i * 0.4).toFixed(1)} ${(780 - i * 0.6).toFixed(1)} re W n\n`;
      return onePage(`${content}0.2 0.4 0.8 rg 0 0 612 792 re f\n${"Q\n".repeat(n)}`);
    },
  },
  fileBytes: {
    sizes: [1, 4, 16].map((mb) => mb * 1e6),
    make: (bytes) => {
      const objects = [
        "<</Type /Catalog /Pages 2 0 R>>",
        "<</Type /Pages /Count 1 /Kids [3 0 R]>>",
        `<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <<${FONT}>>>>`,
        flate("BT /F 12 Tf 72 720 Td (One page in a large file) Tj ET"),
        "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>",
      ];
      // Objects nothing points at, as an edited file collects: what opening it must still walk past.
      const filler = Buffer.alloc(1000, "0123456789 ").toString("latin1");
      for (let i = 0; i < bytes / 1040; i++) objects.push(`<</Filler (${filler})>>`);
      return assemble(objects, 1);
    },
  },
};
const growthDir = fs.mkdtempSync(path.join(os.tmpdir(), "recto-scoreboard-"));
const growthFiles = [];
for (const [dimension, { sizes, make }] of Object.entries(GROWTH)) {
  for (const size of sizes) {
    const file = path.join(growthDir, `${dimension}-${size}.pdf`);
    fs.writeFileSync(file, make(size));
    growthFiles.push({ dimension, size, file });
  }
}

// ---- Measuring

const node = (args, timeout = 1_800_000) => {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 28, timeout });
  if (result.status !== 0) throw new Error(`node ${args.join(" ")}: ${result.stderr || result.signal}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
};
const native = (tree, args) => {
  const binary = path.join(tree.dir, "target/release/examples/scoreboard");
  const result = spawnSync(binary, args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 1_800_000 });
  if (result.status !== 0) throw new Error(`${binary}: ${result.stderr || result.signal}`);
  return JSON.parse(result.stdout);
};
const worker = (tree, kind, args) => node([import.meta.filename, "--worker", kind, path.join(tree.dir, "js/dist"), ...args]);

/** One speed run's files → named numbers. */
function speedMetrics(out, prefix) {
  const files = out.files.filter(Boolean);
  const m = {};
  m[`${prefix}.open.p50`] = median(files.map((f) => f.open));
  const text = files.flatMap((f) => f.text);
  m[`${prefix}.text.p50`] = pct(text, 0.5);
  m[`${prefix}.text.p90`] = pct(text, 0.9);
  WIDTHS.forEach((width, w) => {
    const all = files.flatMap((f) => f.render[w]);
    const first = files.flatMap((f) => f.render[w].slice(0, FIRST));
    m[`${prefix}.render${width}.first2.p50`] = pct(first, 0.5);
    m[`${prefix}.render${width}.first2.p90`] = pct(first, 0.9);
    m[`${prefix}.render${width}.all.p50`] = pct(all, 0.5);
    m[`${prefix}.render${width}.all.p90`] = pct(all, 0.9);
  });
  return m;
}

/** Least-squares slope of log time on log size. */
function exponent(points) {
  const xs = points.map((p) => Math.log(p.size));
  const ys = points.map((p) => Math.log(Math.max(p.ms, 1e-3)));
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * (ys[i] - my);
    den += (x - mx) ** 2;
  });
  return num / den;
}

function staticMetrics(tree) {
  const m = {};
  const wasm = (name) => path.join(tree.dir, "js/wasm", name);
  const brotli = (bytes) => zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }).length;
  for (const part of ["recto.wasm", "recto-render.wasm", "recto-more.wasm", "recto-rare.wasm"]) {
    if (!fs.existsSync(wasm(part))) continue;
    const bytes = fs.readFileSync(wasm(part));
    const key = part.replace(".wasm", "");
    m[`size.${key}.raw`] = bytes.length;
    m[`size.${key}.gzip`] = zlib.gzipSync(bytes, { level: 9 }).length;
    m[`size.${key}.brotli`] = brotli(bytes);
    if (key === "recto") m["simplicity.wasm.exportedFunctions"] = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).filter((e) => e.kind === "function").length;
  }
  const dist = fs.readdirSync(path.join(tree.dir, "js/dist")).filter((n) => n.endsWith(".js"));
  const glue = ["recto.gen.mjs", "pins.mjs"].map(wasm).filter((f) => fs.existsSync(f));
  const js = [...dist.map((n) => path.join(tree.dir, "js/dist", n)), ...glue].map((f) => fs.readFileSync(f));
  m["size.js.raw"] = js.reduce((s, b) => s + b.length, 0);
  m["size.js.brotli"] = js.reduce((s, b) => s + brotli(b), 0);
  // The ref's own budget check, whose first line is its two numbers.
  const budget = spawnSync(process.execPath, [path.join(tree.dir, "scripts/check-wasm-budget.mjs")], { encoding: "utf8" });
  const numbers = budget.stdout.match(/text (\d+) of (\d+) bytes, text and drawing (\d+) of (\d+)/u);
  if (numbers) {
    m["size.budget.text"] = Number(numbers[1]);
    m["size.budget.textLimit"] = Number(numbers[2]);
    m["size.budget.drawing"] = Number(numbers[3]);
    m["size.budget.drawingLimit"] = Number(numbers[4]);
  }
  m["size.budget.passes"] = budget.status === 0 ? 1 : 0;

  const files = (tree.dir === root ? git("ls-files") : git("ls-tree", "-r", "--name-only", tree.commit)).split("\n");
  const loc = (filter) =>
    files.filter(filter).reduce((sum, file) => {
      const full = path.join(tree.dir, file);
      if (!fs.existsSync(full)) return sum;
      const text = fs.readFileSync(full, "utf8");
      if (file.includes("/generated/") || /@generated|DO NOT EDIT|auto-?generated/iu.test(text.slice(0, 400))) return sum;
      return sum + text.split("\n").filter((line) => line.trim() !== "").length;
    }, 0);
  m["simplicity.loc.rust.crates"] = loc((f) => f.startsWith("crates/") && f.endsWith(".rs") && !f.endsWith("examples/scoreboard.rs"));
  m["simplicity.loc.rust.vendor"] = loc((f) => f.startsWith("vendor/") && f.endsWith(".rs"));
  m["simplicity.loc.js.src"] = loc((f) => f.startsWith("js/src/") && /\.(ts|mjs|js)$/u.test(f));
  m["simplicity.loc.js.test"] = loc((f) => f.startsWith("js/test/") && /\.(ts|mjs|js)$/u.test(f));
  m["simplicity.loc.js.scripts"] = loc((f) => /^(scripts|bench|smoke)\//u.test(f) && /\.(mjs|js|ts)$/u.test(f) && f !== "scripts/scoreboard.mjs");
  m["simplicity.deps.cargoLockCrates"] = (fs.readFileSync(path.join(tree.dir, "Cargo.lock"), "utf8").match(/^\[\[package\]\]/gmu) ?? []).length;
  const pkg = JSON.parse(fs.readFileSync(path.join(tree.dir, "js/package.json"), "utf8"));
  m["simplicity.deps.npm"] = Object.keys(pkg.dependencies ?? {}).length;
  m["simplicity.deps.npmDev"] = Object.keys(pkg.devDependencies ?? {}).length;
  m["simplicity.vendorPatches"] = (fs.readFileSync(path.join(tree.dir, "vendor/README.md"), "utf8").match(/^- \*\*/gmu) ?? []).length;
  const index = fs.readFileSync(path.join(tree.dir, "js/src/index.ts"), "utf8");
  const names = [...index.matchAll(/export (?:type )?\{([^}]*)\}/gu)].flatMap((block) => block[1].split(",").map((s) => s.trim()).filter(Boolean));
  m["simplicity.api.exports"] = names.length + (index.match(/^export (?:async )?(?:function|const|class)/gmu) ?? []).length;
  m["simplicity.api.runtimeExports"] = Object.keys(spawnAndImport(tree)).length;
  return m;
}
function spawnAndImport(tree) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(path.join(tree.dir, "js/dist/index.js"))}); console.log(JSON.stringify(Object.keys(m)))`], { encoding: "utf8" });
  return Object.fromEntries(JSON.parse(result.stdout).map((k) => [k, 1]));
}

function fidelity(tree) {
  const m = {};
  const extra = {};
  const text = worker(tree, "text", allFiles);
  m["memory.wasm.textPassPeak"] = text.peakWasmBytes;
  extra.textHashes = text.hashes;
  m["fidelity.text.corpusHash"] = sha1(JSON.stringify(Object.entries(text.hashes).sort())).slice(0, 16);
  if (!values["no-fidelity"]) {
    const out = path.join(cache, "sc");
    fs.mkdirSync(out, { recursive: true });
    // Reference renders are shared with bench/scorecard.mjs's own cache; recto's are keyed by its wasm.
    const shared = path.join(corpus, "sc/cache");
    if (fs.existsSync(shared) && !fs.existsSync(path.join(out, "cache"))) fs.symlinkSync(shared, path.join(out, "cache"));
    const labels = Object.keys(sets);
    run(process.execPath, [path.join(tree.dir, "bench/scorecard.mjs"), ...labels.map((l) => `${l}=${sets[l]}`), ...labels.flatMap((l) => ["--private", l]), "--out", out, "--crops", "0"], tree.dir, path.join(cache, `scorecard-${tree.commit}.log`));
    const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
    const recto = report.agreement.recto;
    m["fidelity.scorecard.percent"] = recto.percent;
    m["fidelity.scorecard.judged"] = recto.judged;
    m["fidelity.scorecard.agrees"] = recto.agrees;
    m["fidelity.scorecard.blank"] = recto.blankWhereOthersDraw;
    m["fidelity.scorecard.failed"] = recto.failedWhereOthersDraw;
    m["fidelity.scorecard.wrongShape"] = recto.wrongShape;
  }
  return { m, extra };
}

// ---- The run

log(`trees: ${trees.map((t) => `${t.label} (${t.dir})`).join(", ")}; ${ROUNDS} rounds; corpus ${speedFiles.length} files timed, ${allFiles.length} for fidelity`);
const results = new Map(trees.map((t) => [t.label, { fixed: {}, rounds: [], extra: {} }]));
for (const tree of trees) {
  const r = results.get(tree.label);
  log(`static and fidelity: ${tree.label}`);
  Object.assign(r.fixed, staticMetrics(tree));
  const f = fidelity(tree);
  Object.assign(r.fixed, f.m);
  Object.assign(r.extra, f.extra);
}
const coldFile = path.join(growthDir, "cold.pdf");
fs.writeFileSync(coldFile, reportPdf({ pages: 40, imageEvery: 10, imageSize: 240 }));
for (let round = 0; round < ROUNDS; round++) {
  const order = round % 2 ? [...trees].reverse() : trees;
  for (const tree of order) {
    log(`round ${round + 1} of ${ROUNDS}: ${tree.label}`);
    const m = {};
    const wasm = worker(tree, "speed", speedFiles);
    Object.assign(m, speedMetrics(wasm, "wasm"));
    m["memory.wasm.peak"] = wasm.peakWasmBytes;
    const nat = native(tree, ["speed", "--pages", String(PAGES), "--widths", WIDTHS.join(","), ...speedFiles]);
    Object.assign(m, speedMetrics(nat, "native"));
    m["memory.native.peakHeap"] = nat.peakHeapBytes;
    const cold = Array.from({ length: COLD }, () => worker(tree, "cold", [coldFile]));
    m["load.cold.firstText"] = median(cold.map((c) => c.text));
    m["load.cold.firstRender"] = median(cold.map((c) => c.render));
    const growth = native(tree, ["whole", "--reps", "5", ...growthFiles.map((g) => g.file)]);
    for (const dimension of Object.keys(GROWTH)) {
      const points = growthFiles.map((g, i) => ({ ...g, ms: Number(growth.files[i]) })).filter((g) => g.dimension === dimension);
      m[`bigO.${dimension}.exponent`] = exponent(points);
      m[`bigO.${dimension}.largestMs`] = points.at(-1).ms;
    }
    results.get(tree.label).rounds.push(m);
  }
}
fs.rmSync(growthDir, { recursive: true, force: true });

// ---- Summarizing: medians over rounds, and as noise the 95% interval of that median, bootstrapped (the
// rounds resampled 2000 times, with a fixed seed). Half its width is the ± printed.

function interval(values) {
  if (values.length < 2) return [values[0], values[0]];
  let seed = 0x9e3779b9;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const medians = Array.from({ length: 2000 }, () => median(values.map(() => values[Math.floor(random() * values.length)])));
  return [pct(medians, 0.025), pct(medians, 0.975)];
}

const HIGHER_IS_BETTER = /^fidelity\.scorecard\.(percent|agrees|judged)$/u;
const summarize = (rounds) => {
  const out = {};
  for (const key of Object.keys(rounds[0] ?? {})) {
    const v = rounds.map((r) => r[key]).filter((x) => x !== null && x !== undefined);
    const med = median(v);
    const [lo, hi] = interval(v);
    out[key] = { median: med, noise: med ? (hi - lo) / 2 / Math.abs(med) : 0, rounds: v };
  }
  return out;
};
const report = {
  date: new Date().toISOString(),
  machine: { cpus: os.cpus().length, cpu: os.cpus()[0]?.model, platform: `${os.platform()} ${os.arch()}`, node: process.version, loadAverage: os.loadavg().map((x) => Math.round(x * 10) / 10) },
  settings: { rounds: ROUNDS, widths: WIDTHS, pagesPerFileCap: PAGES, firstPages: FIRST, coldProcessesPerRound: COLD, growthSizes: Object.fromEntries(Object.entries(GROWTH).map(([k, g]) => [k, g.sizes])) },
  corpus: { timedFiles: speedFiles.length, fidelityFiles: allFiles.length, sets: Object.fromEntries(Object.entries(sets).map(([k, d]) => [k, pdfsIn(d).length])) },
  trees: {},
};
for (const tree of trees) {
  const r = results.get(tree.label);
  report.trees[tree.label] = { commit: tree.commit, dirty: tree.dirty, metrics: { ...Object.fromEntries(Object.entries(r.fixed).map(([k, v]) => [k, { median: v, noise: 0 }])), ...summarize(r.rounds) }, textHashes: r.extra.textHashes };
}

const fmt = (key, v) => {
  if (v === null || v === undefined) return "-";
  if (key.startsWith("bigO") && key.endsWith("exponent")) return v.toFixed(2);
  if (/^size\.|memory\./u.test(key) && !key.endsWith("passes")) return v >= 1e6 ? `${(v / 1e6).toFixed(2)} MB` : `${(v / 1e3).toFixed(1)} kB`;
  if (/^(wasm|native|load)\.|largestMs/u.test(key)) return `${v.toFixed(v < 10 ? 2 : 1)} ms`;
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  return String(v);
};
const [base, next] = trees.length === 2 ? trees : [null, trees[0]];
const rows = [];
const nextMetrics = report.trees[next.label].metrics;
for (const key of Object.keys(nextMetrics)) {
  const n = nextMetrics[key];
  const row = { metric: key, [next.label]: fmt(key, n.median), noise: !n.noise ? "" : key.endsWith("exponent") ? `±${(n.noise * n.median).toFixed(2)}` : `±${(n.noise * 100).toFixed(1)}%` };
  if (key.startsWith("bigO") && key.endsWith("exponent") && n.median > FLAG_EXPONENT) row.flag = "superlinear";
  if (base) {
    const b = report.trees[base.label].metrics[key];
    row[base.label] = fmt(key, b?.median);
    if (b && typeof n.median === "number" && typeof b.median === "number") {
      if (key.startsWith("bigO") && key.endsWith("exponent")) {
        // Exponents compare by their difference within each round, and a difference under 0.1 is "=":
        // the small sizes take a few milliseconds, and a slope through 3 points moves that much.
        const diffs = n.rounds.map((v, i) => v - b.rounds[i]);
        const diff = median(diffs);
        const [lo, hi] = interval(diffs);
        row.change = (lo <= 0 && hi >= 0) || Math.abs(diff) < 0.1 ? "=" : `${diff > 0 ? "+" : ""}${diff.toFixed(2)}`;
        row.noise = `±${((hi - lo) / 2).toFixed(2)}`;
      } else if (n.rounds && b.rounds) {
        // Timed metrics: new ÷ base within each round (rounds alternate which goes first), the median of
        // those ratios, and "=" when its interval holds 1 or it's within 0.5% (a peak heap moves by bytes).
        const ratios = n.rounds.map((v, i) => v / b.rounds[i]).filter(Number.isFinite);
        const ratio = median(ratios);
        const [lo, hi] = interval(ratios);
        row.noise = `±${(((hi - lo) / 2) * 100).toFixed(1)}%`;
        row.change = (lo <= 1 && hi >= 1) || Math.abs(ratio - 1) < 0.005 ? "=" : `${ratio > 1 ? "+" : ""}${((ratio - 1) * 100).toFixed(1)}%`;
        nextMetrics[key].ratioToBase = { median: ratio, interval: [lo, hi] };
      } else {
        row.change = n.median === b.median ? "=" : b.median ?`${n.median > b.median ? "+" : ""}${(((n.median - b.median) / Math.abs(b.median)) * 100).toFixed(2)}%` : "changed";
      }
      if (row.change !== "=" && !key.startsWith("bigO")) row.better = (n.median > b.median) === HIGHER_IS_BETTER.test(key) ? "better" : "worse";
    } else if (b) {
      row.change = n.median === b.median ? "=" : "changed";
    }
  }
  rows.push(row);
}
if (base) {
  const a = report.trees[base.label].textHashes;
  const b = report.trees[next.label].textHashes;
  const differ = Object.keys({ ...a, ...b }).filter((id) => a[id] !== b[id]);
  report.textFilesDiffering = differ.length;
  rows.push({ metric: "fidelity.text.filesDiffering", [next.label]: String(differ.length), change: differ.length ? `${differ.length} files` : "=" });
}

const columns = ["metric", ...(base ? [base.label] : []), next.label, ...(base ? ["change"] : []), "noise", "flag", ...(base ? ["better"] : [])];
const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
console.log(columns.map((c, i) => c.padEnd(widths[i])).join("  "));
for (const row of rows) console.log(columns.map((c, i) => String(row[c] ?? "").padEnd(widths[i])).join("  "));

const outFile = path.join(root, "bench/scoreboard", `${next.label.replace(/[^\w.-]/gu, "_")}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 1)}\n`);
log(`wrote ${path.relative(root, outFile)}`);
