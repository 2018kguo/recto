// The body of fuzz.test.ts, on a thread of its own so that a hang can be stopped from outside.
import { parentPort, workerData } from "node:worker_threads";

import { mutate } from "../../bench/fuzz-mutations.mjs";
import { createPdfEngine, PdfError } from "../src/index.ts";
import { seedCorpus } from "./fuzz-corpus.mjs";

const { seed, count, budgetMs } = workerData as { seed: number; count: number; budgetMs: number };
const corpus = seedCorpus();
const engine = await createPdfEngine();
const started = performance.now();
let done = 0;
for (let i = 0; i < count && performance.now() - started < budgetMs; i++) {
  const source = corpus[i % corpus.length];
  const { name, bytes } = mutate(source.pdf, (Math.imul(seed, 1000003) + i) >>> 0);
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
  done = i + 1;
}
parentPort?.postMessage({ finished: done });
