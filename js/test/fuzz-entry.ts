// The body of fuzz.test.ts, on a thread of its own so that a hang can be stopped from outside.
import { parentPort, workerData } from "node:worker_threads";

import { mutate } from "../../bench/fuzz-mutations.mjs";
import { STRUCTURES, structure } from "../../bench/fuzz-structures.mjs";
import { createPdfEngine, PdfError } from "../src/index.ts";
import { seedCorpus } from "./fuzz-corpus.mjs";

const { seed, count, budgetMs, structures } = workerData as { seed: number; count: number; budgetMs: number; structures?: boolean };
// What one built-to-cost file may take, all its calls together.
const FILE_MS = 15_000;
const FILE_RSS = 1.5e9;
const corpus = seedCorpus();
const engine = await createPdfEngine();
const started = performance.now();
let done = 0;
const total = structures ? STRUCTURES.length : count;
for (let i = 0; i < total && performance.now() - started < budgetMs; i++) {
  const source = structures ? { name: "generated" } : corpus[i % corpus.length];
  const { name, bytes } = structures
    ? structure(Math.imul(seed, STRUCTURES.length) + i)
    : mutate(source.pdf, (Math.imul(seed, 1000003) + i) >>> 0);
  const began = performance.now();
  parentPort?.postMessage({ current: i, source: source.name, mutation: name });
  const check = (call: () => unknown) => {
    try {
      call();
    } catch (error) {
      if (!(error instanceof PdfError) || error.code === "crash") {
        parentPort?.postMessage({ failed: i, source: source.name, mutation: name, error: String(error) });
      }
    }
  };
  try {
    const doc = await engine.open(bytes);
    check(() => doc.pageLabels());
    check(() => doc.outline());
    for (let page = 0; page < Math.min(doc.pageCount, 2); page++) {
      check(() => doc.text(page));
      check(() => doc.objects(page));
      check(() => doc.annotations(page));
      check(() => doc.render(page, { width: 120 }));
    }
    doc.close();
  } catch (error) {
    if (!(error instanceof PdfError) || error.code === "crash") {
      parentPort?.postMessage({ failed: i, source: source.name, mutation: name, error: String(error) });
    }
  }
  const took = performance.now() - began;
  const rss = process.memoryUsage().rss;
  if (structures && (took > FILE_MS || rss > FILE_RSS)) {
    parentPort?.postMessage({ failed: i, mutation: name, took, rss });
  }
  done = i + 1;
}
parentPort?.postMessage({ finished: done });
