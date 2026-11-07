#!/usr/bin/env node
// Damages PDFs from a directory, by a seed, and runs recto over each: bit flips, overwritten ranges,
// truncation, broken xrefs, startxrefs and stream lengths, dropped keywords. A page must end in pixels
// or a PdfError that isn't `crash`, inside a time limit and a memory limit. Anything else is a bug, and
// the file that showed it is written to --out. The same seed gives the same files.
//
// With --structures, the files are generated instead of damaged, by bench/fuzz-structures.mjs, and no
// directory is needed: repeats and chains in the trees the API walks, and drawing bombs.
//
// With --repair, the other engines try the same files, to show what they open that recto doesn't.
//
//   npm run build
//   node bench/fuzz.mjs [<directory of PDFs> | --structures] [--seed 1] [--count 2000] [--timeout 20] [--jobs 6] [--max-size 300000]
//        [--out directory] [--results file.json] [--repair]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { mutate, randomFrom } from "./fuzz-mutations.mjs";
import { structure } from "./fuzz-structures.mjs";

const here = import.meta.dirname;
const self = fileURLToPath(import.meta.url);

const PAGES = 3;
const RENDER_WIDTH = 300;

// ---- The child: runs one job after another and says how each went, so a hang costs one file.

async function child() {
  const { createPdfEngine, PdfError } = await import(path.join(here, "../js/dist/index.js"));
  const engine = await createPdfEngine();
  const say = (event) => fs.writeSync(1, `${JSON.stringify(event)}\n`);
  let buffered = "";
  for await (const chunk of process.stdin) {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf("\n")) >= 0) {
      const job = JSON.parse(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      say({ start: job.id });
      const outcome = { id: job.id, opened: false, pages: 0, drawn: 0, codes: [] };
      const note = (error) => {
        if (error instanceof PdfError) outcome.codes.push(error.code);
        else outcome.codes.push(`untyped:${error?.name}:${String(error?.message).slice(0, 80)}`);
      };
      try {
        const doc = await engine.open(new Uint8Array(fs.readFileSync(job.file)));
        outcome.opened = true;
        outcome.pages = doc.pageCount;
        for (let page = 0; page < Math.min(doc.pageCount, PAGES); page++) {
          try {
            await doc.renderAsync(page, { width: RENDER_WIDTH });
          } catch (error) {
            note(error);
          }
          for (const call of [() => doc.text(page), () => doc.objects(page), () => doc.annotations(page), () => doc.render(page, { width: RENDER_WIDTH })]) {
            try {
              call();
            } catch (error) {
              note(error);
            }
          }
          outcome.drawn++;
        }
        for (const call of [() => doc.outline(), () => doc.pageLabels()]) {
          try {
            call();
          } catch (error) {
            note(error);
          }
        }
        doc.close();
      } catch (error) {
        note(error);
      }
      outcome.rssMb = Math.round(process.memoryUsage().rss / 1e6);
      say({ done: outcome });
    }
  }
}

// ---- The parent.

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      seed: { type: "string", default: "1" },
      count: { type: "string", default: "2000" },
      timeout: { type: "string", default: "20" },
      jobs: { type: "string", default: "6" },
      "max-size": { type: "string", default: "300000" },
      "max-rss": { type: "string", default: "1500" },
      out: { type: "string" },
      results: { type: "string" },
      repair: { type: "boolean", default: false },
      structures: { type: "boolean", default: false },
    },
  });
  if (positionals.length === 0 && !values.structures) {
    console.error("usage: fuzz.mjs <directory of PDFs> [more] [--seed 1] [--count 2000] [--timeout 20] [--jobs 6] [--out directory] [--results file.json] [--repair]");
    process.exit(2);
  }
  const SEED = Number(values.seed);
  const COUNT = Number(values.count);
  const TIMEOUT = Number(values.timeout) * 1000;
  const MAX_RSS = Number(values["max-rss"]);
  const out = path.resolve(values.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "recto-fuzz-")));
  fs.mkdirSync(out, { recursive: true });
  const sources = positionals
    .flatMap((directory) => fs.readdirSync(directory).map((name) => path.join(directory, name)))
    .filter((file) => file.toLowerCase().endsWith(".pdf") && fs.statSync(file).size <= Number(values["max-size"]))
    .sort();
  const work = path.join(out, "work");
  fs.mkdirSync(work, { recursive: true });
  const jobs = Array.from({ length: COUNT }, (_, i) => i);
  const failures = [];
  const tally = { files: 0, opened: 0, refused: {}, byMutation: {}, peakRssMb: 0, timeouts: 0, crashes: 0, untyped: 0, memory: 0, died: 0 };
  const openedById = new Map();
  const mutants = new Map();

  function makeMutant(i) {
    const seed = (SEED * 1000003 + i) >>> 0;
    const source = values.structures ? "generated" : sources[randomFrom(seed).int(sources.length)];
    const { name, bytes } = values.structures ? structure(seed) : mutate(new Uint8Array(fs.readFileSync(source)), seed);
    const file = path.join(work, `${i}.pdf`);
    fs.writeFileSync(file, bytes);
    mutants.set(i, { name, file, source });
    return file;
  }
  function keep(i, why, detail) {
    const { file, name, source } = mutants.get(i);
    const hash = createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
    const kept = path.join(out, `${why}-${hash}.pdf`);
    fs.copyFileSync(file, kept);
    failures.push({ why, detail, mutation: name, index: i, file: kept, source: path.basename(source) });
  }

  async function worker() {
    while (jobs.length > 0) {
      await new Promise((resolve) => {
        const proc = spawn(process.execPath, [self, "--child"], { stdio: ["pipe", "pipe", "ignore"] });
        let current = null;
        let timer;
        let buffered = "";
        let closing = false;
        const feed = () => {
          const i = jobs.shift();
          if (i === undefined) {
            closing = true;
            clearTimeout(timer);
            proc.stdin.end();
            return;
          }
          current = i;
          clearTimeout(timer);
          timer = setTimeout(() => {
            tally.timeouts++;
            keep(i, "timeout", `past ${TIMEOUT / 1000} s`);
            current = null;
            proc.kill("SIGKILL");
          }, TIMEOUT);
          proc.stdin.write(`${JSON.stringify({ id: i, file: makeMutant(i) })}\n`);
        };
        proc.stdout.on("data", (chunk) => {
          buffered += chunk;
          let at;
          while ((at = buffered.indexOf("\n")) >= 0) {
            const event = JSON.parse(buffered.slice(0, at));
            buffered = buffered.slice(at + 1);
            if (!event.done) continue;
            const o = event.done;
            const { name, file } = mutants.get(o.id);
            tally.files++;
            tally.byMutation[name] = (tally.byMutation[name] ?? 0) + 1;
            if (o.opened) tally.opened++;
            openedById.set(o.id, { opened: o.opened, pages: o.pages });
            for (const code of o.codes) {
              if (code === "crash") {
                tally.crashes++;
                keep(o.id, "crash", "wasm trap");
              } else if (code.startsWith("untyped:")) {
                tally.untyped++;
                keep(o.id, "untyped", code);
              } else tally.refused[code] = (tally.refused[code] ?? 0) + 1;
            }
            tally.peakRssMb = Math.max(tally.peakRssMb, o.rssMb);
            if (o.rssMb > MAX_RSS) {
              tally.memory++;
              keep(o.id, "memory", `${o.rssMb} MB`);
              current = null;
              clearTimeout(timer);
              proc.kill("SIGKILL");
              return;
            }
            if (!values.repair) fs.rmSync(file, { force: true });
            current = null;
            // A generated file's memory is its own: wasm memory never shrinks, so one process would add them up.
            if (values.structures) {
              closing = true;
              clearTimeout(timer);
              proc.stdin.end();
            } else {
              feed();
            }
          }
        });
        proc.on("close", () => {
          clearTimeout(timer);
          if (current !== null) {
            tally.died++;
            keep(current, "died", "the process ended");
          }
          resolve();
        });
        void closing;
        feed();
      });
    }
  }
  await Promise.all(Array.from({ length: Number(values.jobs) }, worker));

  const summary = { date: new Date().toISOString(), seed: SEED, sources: sources.length, ...tally, failures: failures.map(({ why, detail, mutation, index }) => ({ why, detail, mutation, index })) };

  if (values.repair) summary.repair = await compareRepair([...openedById.keys()], openedById, mutants, Number(values.jobs), TIMEOUT, out);
  fs.rmSync(work, { recursive: true, force: true });
  if (values.results) fs.writeFileSync(values.results, `${JSON.stringify(summary, null, 1)}\n`);
  console.log(JSON.stringify({ ...summary, failures: failures.length }, null, 1));
  for (const failure of failures.slice(0, 40)) console.log(`${failure.why} ${failure.mutation} ${failure.source} ${failure.detail} ${failure.file}`);
}

/** Whether each other engine opens what recto opened and refused, one short process per file. */
async function compareRepair(ids, recto, mutants, jobs, timeout, out) {
  const ENGINES = ["pdfium", "pdf.js", "poppler"];
  const opens = Object.fromEntries(ENGINES.map((engine) => [engine, 0]));
  const openedOnlyByOthers = [];
  let rectoOpens = 0;
  let rectoEmpty = 0;
  const queue = [...ids];
  const scratch = path.join(out, "repair");
  fs.mkdirSync(scratch, { recursive: true });
  const openWith = (engine, file) =>
    new Promise((resolve) => {
      const proc = spawn(process.execPath, [path.join(here, "scorecard-worker.mjs"), engine, file, scratch, "60", "0", "1"], { stdio: ["ignore", "pipe", "ignore"] });
      let text = "";
      const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
      proc.stdout.on("data", (chunk) => (text += chunk));
      proc.on("close", () => {
        clearTimeout(timer);
        const match = /"open":true,"pageCount":(\d+)/.exec(text);
        resolve(match ? Number(match[1]) : null);
      });
    });
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (queue.length > 0) {
        const id = queue.shift();
        const { file, name } = mutants.get(id);
        const mine = recto.get(id);
        if (mine.opened && mine.pages > 0) rectoOpens++;
        else if (mine.opened) rectoEmpty++;
        const theirs = {};
        for (const engine of ENGINES) {
          theirs[engine] = await openWith(engine, file);
          if (theirs[engine]) opens[engine]++;
        }
        const others = ENGINES.filter((engine) => theirs[engine]);
        if (!(mine.opened && mine.pages > 0) && others.length >= 2) {
          const kept = path.join(out, `repair-${id}.pdf`);
          fs.copyFileSync(file, kept);
          openedOnlyByOthers.push({ id, mutation: name, others, pages: theirs, kept });
        }
      }
    }),
  );
  fs.rmSync(scratch, { recursive: true, force: true });
  return { files: ids.length, rectoOpens, rectoOpenedWithNoPages: rectoEmpty, opens, openedByTwoOthersNotRecto: openedOnlyByOthers.length, mutations: openedOnlyByOthers.map((e) => e.mutation) };
}

if (process.argv[2] === "--child") await child();
else await main();
