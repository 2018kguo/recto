#!/usr/bin/env node
// Real-world files: a deterministic sample of the SafeDocs CC-MAIN-2021-31-PDF-UNTRUNCATED corpus
// (PDFs from Common Crawl's July/August 2021 crawl, refetched untruncated), opened by recto, pdf.js,
// pdfium and MuPDF, each file and engine in a fresh process with a time and a memory limit. Each run:
// the page count, the text of up to 5 pages, and the first 2 pages drawn at 1024 px.
//
// `fetch` downloads whole zips, chosen by a seed: zip n is the first 4 bytes of
// sha256("recto-wild-n") modulo the 7,933 zips. Files in a zip are numbered by their SHA-256, so a
// zip is itself a random sample. Nothing here is committed: the results name files by hash.
//
//   node bench/wild.mjs fetch [--zips 7] [--dir ~/.cache/recto-corpus/wild]
//   npm run build
//   node bench/wild.mjs run [--dir ...] [--results bench/results/wild.json] [--timeout 20] [--max-rss 2048]
//        [--jobs 8] [--engines recto,pdf.js,pdfium,mupdf] [--limit n] [--cache file.jsonl] [--only file-of-hashes]
//
// The cache holds one line per file and engine; recto's lines are keyed by its wasm's hash, so after a
// fix a rerun reruns recto alone.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { mupdfEngine, pdfiumEngine, pdfjsEngine, rectoEngine } from "./engines.mjs";

const here = import.meta.dirname;
const self = fileURLToPath(import.meta.url);
const TEXT_PAGES = 5;
const RENDER_PAGES = 2;
const WIDTH = 1024;
const ZIPS_IN_CORPUS = 7933;
const BASE = "https://digitalcorpora.s3.amazonaws.com/corpora/files/CC-MAIN-2021-31-PDF-UNTRUNCATED/zipfiles";

// ---- The child: one engine, one file. A line of JSON per step, so a hang or a death says how far it got.

async function child(engineName, file) {
  const say = (event) => fs.writeSync(1, `${JSON.stringify(event)}\n`);
  const codeOf = (error) => {
    if (error?.name === "PdfError") return error.code;
    if (error instanceof WebAssembly.RuntimeError) return "trap";
    const pdfium = /could not open it: error (\d+)/.exec(String(error?.message));
    if (pdfium) return `pdfium-${pdfium[1]}`;
    return error?.name && error.name !== "Error" ? error.name : String(error?.message ?? error).slice(0, 60);
  };
  let engine;
  if (engineName === "recto") {
    const { createPdfEngine } = await import(path.join(here, "../js/dist/index.js"));
    engine = rectoEngine(await createPdfEngine());
  } else if (engineName === "pdf.js") {
    const pdfjs = await import(path.join(here, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
    const root = path.join(here, "node_modules/pdfjs-dist");
    engine = pdfjsEngine(pdfjs, { isEvalSupported: false, verbosity: 0, standardFontDataUrl: `${root}/standard_fonts/`, cMapUrl: `${root}/cmaps/`, cMapPacked: true, wasmUrl: `${root}/wasm/` });
  } else if (engineName === "mupdf") {
    engine = mupdfEngine(await import(path.join(here, "node_modules/mupdf/dist/mupdf.js")));
  } else {
    const { init } = await import(path.join(here, "node_modules/@embedpdf/pdfium/dist/index.js"));
    engine = pdfiumEngine(await init({ wasmBinary: fs.readFileSync(path.join(here, "node_modules/@embedpdf/pdfium/dist/pdfium.wasm")) }), { forms: true });
  }
  const bytes = new Uint8Array(fs.readFileSync(file));
  const started = performance.now();
  let doc;
  try {
    doc = await engine.open(bytes);
  } catch (error) {
    say({ openFailed: codeOf(error), message: String(error?.message).slice(0, 200) });
    return;
  }
  say({ open: doc.pageCount, ms: performance.now() - started });
  for (let page = 0; page < Math.min(doc.pageCount, TEXT_PAGES); page++) {
    say({ step: `text ${page}` });
    try {
      const text = await doc.text(page);
      say({ text: page, words: text.split(/\s+/u).filter(Boolean).length });
    } catch (error) {
      say({ text: page, failed: codeOf(error), message: String(error?.message).slice(0, 200) });
    }
  }
  for (let page = 0; page < Math.min(doc.pageCount, RENDER_PAGES); page++) {
    say({ step: `render ${page}` });
    try {
      const drawn = await doc.render(page, WIDTH);
      const rgba = drawn.rgba ?? drawn.context.getImageData(0, 0, drawn.width, drawn.height).data;
      say({ render: page, ink: inkOf(rgba), width: drawn.width, height: drawn.height });
    } catch (error) {
      say({ render: page, failed: codeOf(error), message: String(error?.message).slice(0, 200) });
    }
  }
  try {
    await doc.close();
  } catch {}
  say({ finished: true, ms: performance.now() - started, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
}

/** The share of pixels, every 4th, that the paper doesn't account for: under 225 on a channel over white. */
function inkOf(rgba) {
  let inked = 0;
  let seen = 0;
  for (let i = 0; i < rgba.length; i += 16) {
    const a = rgba[i + 3];
    const over = (c) => (c * a + 255 * (255 - a)) / 255;
    if (over(rgba[i]) < 225 || over(rgba[i + 1]) < 225 || over(rgba[i + 2]) < 225) inked++;
    seen++;
  }
  return seen ? Number((inked / seen).toFixed(5)) : 0;
}

// ---- Fetching

function zipNumbers(count) {
  return Array.from({ length: count }, (_, i) => createHash("sha256").update(`recto-wild-${i + 1}`).digest().readUInt32BE(0) % ZIPS_IN_CORPUS);
}

function fetchCorpus(dir, count) {
  fs.mkdirSync(dir, { recursive: true });
  for (const n of zipNumbers(count)) {
    const name = String(n).padStart(4, "0");
    const into = path.join(dir, name);
    if (fs.existsSync(path.join(into, ".done"))) continue;
    const low = Math.floor(n / 1000) * 1000;
    const url = `${BASE}/${String(low).padStart(4, "0")}-${String(low + 999).padStart(4, "0")}/${name}.zip`;
    const zip = path.join(dir, `${name}.zip`);
    console.error(`${url}`);
    execFileSync("curl", ["-sS", "--retry", "5", "-C", "-", "-o", zip, url], { stdio: "inherit" });
    fs.mkdirSync(into, { recursive: true });
    execFileSync("unzip", ["-q", "-o", "-j", zip, "-d", into], { stdio: "inherit" });
    fs.rmSync(zip);
    fs.writeFileSync(path.join(into, ".done"), "");
  }
  const lines = listFiles(dir).map((file) => `${sha256(file)}  ${path.relative(dir, file)}`);
  fs.writeFileSync(path.join(dir, "hashes.txt"), `${lines.join("\n")}\n`);
  console.error(`${lines.length} files, hashes in ${path.join(dir, "hashes.txt")}`);
}

const hashes = new Map();
const sha256 = (file) => hashes.get(file) ?? hashes.set(file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")).get(file);
const listFiles = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name) && fs.existsSync(path.join(dir, entry.name, ".done")))
    .flatMap((entry) => fs.readdirSync(path.join(dir, entry.name)).filter((name) => name.endsWith(".pdf")).sort().map((name) => path.join(dir, entry.name, name)))
    .sort();

// ---- Running

function runOne(engine, file, timeoutMs, maxRssMb, onPid) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [self, "--child", engine, file], { stdio: ["ignore", "pipe", "ignore"] });
    const result = { engine, outcome: null, pageCount: null, openMs: null, ms: null, maxRssMb: null, text: [], render: [], step: "open" };
    const started = performance.now();
    let killedFor = null;
    const timer = setTimeout(() => {
      killedFor = "timeout";
      proc.kill("SIGKILL");
    }, timeoutMs);
    onPid(proc.pid, (rss) => {
      result.maxRssMb = Math.max(result.maxRssMb ?? 0, rss);
      if (rss > maxRssMb && !killedFor) {
        killedFor = "memory";
        proc.kill("SIGKILL");
      }
    });
    let buffered = "";
    proc.stdout.on("data", (chunk) => {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const event = JSON.parse(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
        if (event.openFailed) {
          result.outcome = "open-error";
          result.code = event.openFailed;
          result.message = event.message;
        } else if (event.open !== undefined) {
          result.pageCount = event.open;
          result.openMs = Math.round(event.ms * 10) / 10;
        } else if (event.step) result.step = event.step;
        else if (event.text !== undefined) result.text.push(event.failed ? { page: event.text, failed: event.failed, message: event.message } : { page: event.text, words: event.words });
        else if (event.render !== undefined) result.render.push(event.failed ? { page: event.render, failed: event.failed, message: event.message } : { page: event.render, ink: event.ink });
        else if (event.finished) {
          result.ms = Math.round(event.ms);
          result.maxRssMb = Math.max(result.maxRssMb ?? 0, event.maxRssMb);
          // The work is done; a process slow to exit on a loaded machine isn't the engine's fault.
          clearTimeout(timer);
          setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
        }
      }
    });
    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      result.wall = Math.round(performance.now() - started);
      if (killedFor) result.outcome = killedFor;
      else if (result.outcome === "open-error") {
        if (result.code === "crash" || result.code === "trap") result.outcome = "crash";
      } else if (result.ms === null) {
        result.outcome = "crash";
        result.code = signal ?? `exit ${code}`;
      } else {
        const failed = [...result.text, ...result.render].filter((p) => p.failed);
        if (failed.some((p) => p.failed === "crash" || p.failed === "trap")) result.outcome = "crash";
        else if (failed.length) result.outcome = "page-error";
        else result.outcome = "ok";
        if (failed.length) result.code = failed[0].failed;
      }
      if (result.outcome === "ok" || result.outcome === "page-error") delete result.step;
      resolve(result);
    });
  });
}

/** One `ps` for every child, every 200 ms: the resident size each has now. */
function memoryWatch() {
  const watched = new Map();
  const timer = setInterval(() => {
    if (watched.size === 0) return;
    let out = "";
    try {
      out = execFileSync("ps", ["-o", "pid=,rss=", "-p", [...watched.keys()].join(",")], { encoding: "utf8" });
    } catch (error) {
      out = error.stdout ?? "";
    }
    for (const line of out.trim().split("\n")) {
      const [pid, rss] = line.trim().split(/\s+/).map(Number);
      watched.get(pid)?.(Math.round(rss / 1024));
    }
  }, 200);
  return {
    watch: (pid, onRss) => watched.set(pid, onRss),
    forget: (pid) => watched.delete(pid),
    stop: () => clearInterval(timer),
  };
}

async function run(values) {
  const dir = values.dir;
  let files = listFiles(dir);
  if (values.only) {
    const only = new Set(fs.readFileSync(values.only, "utf8").split(/\s+/).filter(Boolean));
    files = files.filter((file) => only.has(path.basename(file, ".pdf")) || only.has(sha256(file).slice(0, 16)));
  }
  if (values.limit) files = files.slice(0, Number(values.limit));
  const engines = values.engines.split(",");
  const wasmHash = (() => {
    const hash = createHash("sha1");
    const wasm = path.join(here, "../js/wasm");
    for (const name of fs.readdirSync(wasm).filter((n) => n.endsWith(".wasm")).sort()) hash.update(name).update(fs.readFileSync(path.join(wasm, name)));
    return hash.digest("hex").slice(0, 12);
  })();
  const keyOf = (engine, file) => `${engine === "recto" ? `recto@${wasmHash}` : engine}|${path.relative(dir, file)}`;
  const cacheFile = values.cache ?? path.join(dir, "results.jsonl");
  const cache = new Map();
  if (fs.existsSync(cacheFile)) {
    for (const line of fs.readFileSync(cacheFile, "utf8").split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line);
      cache.set(entry.key, entry);
    }
  }
  const queue = [];
  for (const file of files) for (const engine of engines) if (!cache.has(keyOf(engine, file))) queue.push({ engine, file });
  console.error(`${files.length} files, ${engines.join(", ")}; ${queue.length} runs to do (recto build ${wasmHash})`);
  const memory = memoryWatch();
  const append = fs.openSync(cacheFile, "a");
  let done = 0;
  await Promise.all(
    Array.from({ length: Number(values.jobs) }, async () => {
      while (queue.length > 0) {
        const { engine, file } = queue.shift();
        let pid;
        const result = await runOne(engine, file, Number(values.timeout) * 1000, Number(values["max-rss"]), (p, onRss) => memory.watch((pid = p), onRss));
        memory.forget(pid);
        const entry = { key: keyOf(engine, file), file: path.relative(dir, file), bytes: fs.statSync(file).size, ...result };
        cache.set(entry.key, entry);
        fs.writeSync(append, `${JSON.stringify(entry)}\n`);
        if (++done % 250 === 0) console.error(`${done} of ${queue.length + done}`);
      }
    }),
  );
  memory.stop();
  fs.closeSync(append);

  // ---- The summary
  const rows = files.map((file) => Object.fromEntries(engines.map((engine) => [engine, cache.get(keyOf(engine, file))])));
  const OUTCOMES = ["ok", "page-error", "open-error", "timeout", "memory", "crash"];
  const versions = Object.fromEntries(["pdfjs-dist", "@embedpdf/pdfium", "mupdf"].map((name) => [name, JSON.parse(fs.readFileSync(path.join(here, "node_modules", name, "package.json"))).version]));
  const machine = `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`;
  const summary = { date: new Date().toISOString(), node: process.version, machine, loadAverage: os.loadavg(), jobs: Number(values.jobs), versions, rectoBuild: wasmHash, files: files.length, bytes: files.reduce((n, f) => n + fs.statSync(f).size, 0), engines: {} };
  for (const engine of engines) {
    const mine = rows.map((row) => row[engine]);
    const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, mine.filter((r) => r.outcome === o).length]));
    const codes = {};
    for (const r of mine) if (r.code) codes[`${r.outcome} ${r.code}`] = (codes[`${r.outcome} ${r.code}`] ?? 0) + 1;
    const finished = mine.filter((r) => r.ms !== null).map((r) => r.ms).sort((a, b) => a - b);
    const rss = mine.filter((r) => r.maxRssMb).map((r) => r.maxRssMb).sort((a, b) => a - b);
    const at = (list, q) => list[Math.min(list.length - 1, Math.floor(q * list.length))];
    summary.engines[engine] = {
      outcomes,
      codes: Object.fromEntries(Object.entries(codes).sort((a, b) => b[1] - a[1])),
      ms: { p50: at(finished, 0.5), p90: at(finished, 0.9), p99: at(finished, 0.99), total: finished.reduce((a, b) => a + b, 0) },
      peakRssMb: { p50: at(rss, 0.5), p99: at(rss, 0.99), max: rss.at(-1) },
      blankWhereOthersDraw: 0,
      noTextWhereOthersHave: 0,
      softDisagreements: 0,
    };
  }
  // A launch reader's view: what recto (or any engine) gets wrong on a file another engine handles.
  const worse = [];
  const okText = (r, page) => r?.text?.find((p) => p.page === page && !p.failed);
  const okRender = (r, page) => r?.render?.find((p) => p.page === page && !p.failed);
  for (const [i, row] of rows.entries()) {
    for (const engine of engines) {
      const mine = row[engine];
      const others = engines.filter((e) => e !== engine).map((e) => row[e]);
      // A file opened with no pages hasn't been read: it doesn't count as another engine doing better.
      const whatOthersDid = others.filter((r) => (r.outcome === "ok" || r.outcome === "page-error") && r.pageCount > 0);
      if (whatOthersDid.length === 0) continue;
      const problems = [];
      const soft = [];
      if (!["ok", "page-error"].includes(mine.outcome)) problems.push(`${mine.outcome}${mine.code ? ` ${mine.code}` : ""}${mine.step && mine.outcome !== "open-error" ? ` at ${mine.step}` : ""}`);
      else {
        const counts = whatOthersDid.map((r) => r.pageCount);
        if (counts.length && !counts.includes(mine.pageCount)) problems.push(`page count ${mine.pageCount} where others say ${counts.join("/")}`);
        for (const p of mine.text.concat(mine.render).filter((p) => p.failed)) {
          const kind = "words" in p || mine.text.includes(p) ? "text" : "render";
          if (others.some((r) => (kind === "text" ? okText(r, p.page) : okRender(r, p.page)))) problems.push(`${kind} ${p.page} ${p.failed}`);
        }
        for (const p of mine.render.filter((p) => !p.failed && p.ink === 0)) {
          if (others.filter((r) => (okRender(r, p.page)?.ink ?? 0) > 0.002).length >= Math.min(2, others.length)) {
            problems.push(`render ${p.page} blank`);
            summary.engines[engine].blankWhereOthersDraw++;
          }
        }
        for (const p of mine.text.filter((p) => !p.failed && p.words === 0)) {
          if (others.filter((r) => (okText(r, p.page)?.words ?? 0) >= 20).length >= Math.min(2, others.length)) {
            problems.push(`text ${p.page} empty`);
            summary.engines[engine].noTextWhereOthersHave++;
          }
        }
        // Softer: under half the words, or the ink, of every other engine where they agree with each other.
        // Often not wrong (letter-spaced words, dot leaders, a font the others lack), so listed to look at.
        for (const p of mine.text.filter((p) => !p.failed && p.words > 0)) {
          const theirs = others.map((r) => okText(r, p.page)?.words);
          if (theirs.every((n) => n >= 30) && p.words < 0.5 * Math.min(...theirs)) soft.push(`text ${p.page} ${p.words} words against ${theirs.join("/")}`);
        }
        for (const p of mine.render.filter((p) => !p.failed && p.ink > 0)) {
          const theirs = others.map((r) => okRender(r, p.page)?.ink);
          if (theirs.every((n) => n >= 0.01) && Math.max(...theirs) < 2 * Math.min(...theirs) && p.ink < 0.5 * Math.min(...theirs)) soft.push(`render ${p.page} ink ${p.ink} against ${theirs.join("/")}`);
        }
      }
      summary.engines[engine].softDisagreements += soft.length ? 1 : 0;
      if (problems.length || soft.length) worse.push({ engine, file: sha256(files[i]).slice(0, 16), local: path.relative(dir, files[i]), problems, soft });
    }
  }
  for (const engine of engines) summary.engines[engine].worseThanAnother = worse.filter((w) => w.engine === engine && w.problems.length).length;
  summary.rectoWorse = worse.filter((w) => w.engine === "recto" && w.problems.length).map(({ local, ...w }) => w);
  if (values.results) fs.writeFileSync(values.results, `${JSON.stringify(summary, null, 1)}\n`);
  const local = path.join(dir, "worse.json");
  fs.writeFileSync(local, `${JSON.stringify(worse, null, 1)}\n`);
  console.log(JSON.stringify({ ...summary, rectoWorse: summary.rectoWorse.length }, null, 1));
  console.error(`each engine's files worse than another's: ${local}`);
}

if (process.argv[2] === "--child") {
  await child(process.argv[3], process.argv[4]);
  process.exit(0);
} else {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string", default: path.join(os.homedir(), ".cache/recto-corpus/wild") },
      zips: { type: "string", default: "7" },
      results: { type: "string" },
      cache: { type: "string" },
      timeout: { type: "string", default: "20" },
      "max-rss": { type: "string", default: "2048" },
      jobs: { type: "string", default: String(Math.max(1, Math.floor(os.availableParallelism() / 2))) },
      engines: { type: "string", default: "recto,pdf.js,pdfium,mupdf" },
      limit: { type: "string" },
      only: { type: "string" },
    },
  });
  if (positionals[0] === "fetch") fetchCorpus(values.dir, Number(values.zips));
  else if (positionals[0] === "run") await run(values);
  else {
    console.error("usage: wild.mjs fetch [--zips 7] [--dir d] | run [--dir d] [--results file.json] [--timeout 20] [--max-rss 2048] [--jobs n] [--engines recto,pdf.js,pdfium,mupdf]");
    process.exit(2);
  }
}
