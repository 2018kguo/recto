// Scaling guards: each engine operation grows linearly in its input. A
// regression to super-linear growth fails here, whatever the machine load.
//
// - The ranged loader is checked by counting work, not timing it: the bytes
//   the engine reads (its parse work), fetch rounds (round
//   trips) and requests, at doubling page counts. These are deterministic.
// - Whole-file operations are timed in thread CPU, not wall clock, as paired
//   ratios: time(8n) / time(n), each the fastest of several alternating
//   samples, and measured again if over the bound (cpu-time.ts).
//   Linear is 8, quadratic 64; the bound sits between them, x2.75 clear of
//   linear. T(n) = an + bn^2 fails once bn > a/3. The doubling ratio this
//   replaced (linear 2, quadratic 4, bound 3) had x1.5 of room for noise and
//   needed bn > a to fail: this is both sturdier and stricter.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createPdfEngine,
  type PdfDocument,
  type PdfRangedStats,
  textItems,
} from "../src/index.ts";
import { syntheticPdf, type SyntheticPdfOptions } from "./synthetic-pdf.ts";
import { cpuMsPerCallWithin } from "./cpu-time.ts";

const engine = await createPdfEngine();

/** Sizes compare n to this many n. */
const GROWTH = 8;
/** time(8n) / time(n) must stay under this. */
const LINEAR_RATIO = 22;

/** CPU time of `op` on documents of size n and 8n: time(8n) / time(n). */
async function growthRatio(
  shape: (n: number) => SyntheticPdfOptions,
  n: number,
  op: (doc: PdfDocument) => void,
  open: (bytes: Uint8Array) => Promise<PdfDocument> = (bytes) =>
    engine.open(bytes)
): Promise<number> {
  const small = await open(syntheticPdf(shape(n)));
  const large = await open(syntheticPdf(shape(GROWTH * n)));
  try {
    const [largeMs, smallMs] = cpuMsPerCallWithin(
      LINEAR_RATIO,
      () => op(large),
      () => op(small)
    );
    return largeMs / smallMs;
  } finally {
    small.close();
    large.close();
  }
}

function assertLinear(ratio: number, what: string): void {
  assert.ok(
    ratio < LINEAR_RATIO,
    `${what}: time(8n)/time(n) = ${ratio.toFixed(2)} (linear is 8, quadratic 64)`
  );
}

/** A ranged open of `bytes`, then `work`; the loader's counters after. */
async function rangedStats(
  bytes: Uint8Array,
  work: (doc: PdfDocument) => void
): Promise<PdfRangedStats> {
  const doc = await engine.openRanged(bytes, {
    maxBytes: 1024 * 1024 * 1024,
  });
  try {
    work(doc);
    return doc.stats();
  } finally {
    doc.close();
  }
}

const allPageSizes = (doc: PdfDocument) => {
  for (let i = 0; i < doc.pageCount; i++) {
    doc.pageInfo(i);
  }
};

/** Pages spread across the file, so a ranged reader misses once per page. */
const spread = (pages: number) =>
  syntheticPdf({ pages, padBytes: 16 * 1024, charsPerPage: 200 });

test("ranged page count: parse work linear, a constant 3 round trips", async () => {
  let previous: PdfRangedStats | null = null;
  for (const pages of [512, 1024, 2048, 4096]) {
    const stats = await rangedStats(spread(pages), () => {});
    assert.ok(stats.rounds <= 3, `${pages} pages: ${stats.rounds} rounds`);
    if (previous) {
      const growth = stats.readBytes / previous.readBytes;
      assert.ok(growth < 2.5, `${pages} pages: parse work x${growth}`);
    }
    previous = stats;
  }
});

test("ranged reads of every page: parse work linear in misses, rounds logarithmic", async () => {
  let previous: PdfRangedStats | null = null;
  for (const pages of [256, 512, 1024, 2048]) {
    const stats = await rangedStats(spread(pages), allPageSizes);
    if (previous) {
      const growth = stats.readBytes / previous.readBytes;
      assert.ok(growth < 2.5, `${pages} pages: parse work x${growth}`);
      // A sequential scan doubles its read-ahead: O(log n) rounds.
      assert.ok(
        stats.rounds - previous.rounds <= 3,
        `${pages} pages: ${previous.rounds} -> ${stats.rounds} rounds`
      );
    }
    previous = stats;
  }
});

test("ranged reads in any order: parse work linear, never a reparse", async () => {
  // A deep page tree and a strided order.
  let previous: PdfRangedStats | null = null;
  for (const pages of [128, 256, 512]) {
    const bytes = syntheticPdf({
      pages,
      padBytes: 16 * 1024,
      charsPerPage: 200,
      fanout: 8,
    });
    const stats = await rangedStats(bytes, (doc) => {
      for (let k = 0; k < doc.pageCount; k++) {
        doc.text((k * 97) % doc.pageCount);
      }
    });
    if (previous) {
      const growth = stats.readBytes / previous.readBytes;
      assert.ok(growth < 2.5, `${pages} pages: parse work x${growth}`);
      assert.ok(
        stats.requests / previous.requests < 2.5,
        `${pages} pages: requests ${previous.requests} -> ${stats.requests}`
      );
    }
    previous = stats;
  }
});

test("text is linear in chars per page", async () => {
  assertLinear(
    await growthRatio(
      (n) => ({ pages: 1, charsPerPage: n }),
      8000,
      (doc) => doc.text(0)
    ),
    "text"
  );
});

test("text items are linear in chars, upright and on a rotated page (reflow)", async () => {
  // Page 0 is upright (content order); page 1 has /Rotate 90 (the reflow
  // sorts an index column, n log n, which doubles well inside the bound).
  for (const index of [0, 1]) {
    assertLinear(
      await growthRatio(
        (n) => ({ pages: 2, charsPerPage: n, vary: true }),
        8000,
        (doc) => {
          textItems(doc.text(index), doc.pageInfo(index));
        }
      ),
      `text items, page ${index}`
    );
  }
});

test("a page scan is linear in chars and paths", async () => {
  assertLinear(
    await growthRatio(
      (n) => ({ pages: 1, charsPerPage: n, pathsPerPage: n / 2 }),
      4000,
      (doc) => doc.scan(0)
    ),
    "scan"
  );
});

test("page objects are linear in paths per page", async () => {
  assertLinear(
    await growthRatio(
      (n) => ({ pages: 1, charsPerPage: 0, pathsPerPage: n }),
      4000,
      (doc) => doc.objects(0)
    ),
    "objects"
  );
});

test("every page's size is linear in pages, flat or deep page tree, whole or ranged", async () => {
  const ranged = (bytes: Uint8Array) =>
    engine.openRanged(bytes, { maxBytes: 1024 ** 3 });
  for (const fanout of [0, 8]) {
    for (const [how, open] of [
      ["whole", undefined],
      ["ranged", ranged],
    ] as const) {
      assertLinear(
        await growthRatio(
          (n) => ({ pages: n, charsPerPage: 0, fanout }),
          2000,
          allPageSizes,
          open
        ),
        `pageInfo, fanout ${fanout}, ${how}`
      );
    }
  }
});

test("render is linear in pixels", async () => {
  const doc = await engine.open(
    syntheticPdf({ pages: 1, charsPerPage: 3000, pathsPerPage: 300 })
  );
  try {
    // 4x the width is 16x the pixels: linear is at most 16, quadratic 256.
    const bound = 16 * 4;
    const [largeMs, smallMs] = cpuMsPerCallWithin(
      bound,
      () => doc.render(0, { width: 3200, maxHeight: 16_384 }),
      () => doc.render(0, { width: 800, maxHeight: 16_384 })
    );
    const ratio = largeMs / smallMs;
    assert.ok(ratio < bound, `render: 16x pixels took x${ratio.toFixed(2)}`);
  } finally {
    doc.close();
  }
});

test("navigation reuses memory after visiting every large page", async () => {
  const isolated = await createPdfEngine();
  const doc = await isolated.open(
    syntheticPdf({
      pages: 32,
      charsPerPage: 1000,
      pathsPerPage: 2000,
      vary: true,
    })
  );
  const visit = () => {
    for (let index = 0; index < doc.pageCount; index++) {
      doc.scan(index);
      doc.render(index, { width: 64 });
    }
  };
  try {
    // Two visits settle the allocator (the engine's free lists grow
    // once after the first); a leak still grows on every later round.
    visit();
    visit();
    const highWater = isolated.stats().heapBytes;
    for (let round = 0; round < 3; round++) {
      visit();
      assert.equal(
        isolated.stats().heapBytes,
        highWater,
        "previous page allocations are reused rather than retained"
      );
    }
  } finally {
    doc.close();
  }
  assert.equal(isolated.stats().openDocuments, 0);
});

// Collapsing a run of spaces by deleting each duplicate in place would be O(n^2) in the run.
test("text is linear in a run of spaces", async () => {
  const page = (spaces: number) => {
    const bytes = syntheticPdf({ pages: 1, charsPerPage: 0 });
    const content = `BT /F1 9 Tf 20 700 Td (a${" ".repeat(spaces)}b) Tj ET`;
    return new TextEncoder().encode(
      new TextDecoder("latin1")
        .decode(bytes)
        .replace(
          "<<  /Length 0 >>\nstream\n\nendstream",
          `<<  /Length ${content.length} >>\nstream\n${content}\nendstream`
        )
    );
  };
  const small = await engine.open(page(4000));
  const large = await engine.open(page(GROWTH * 4000));
  try {
    const [largeMs, smallMs] = cpuMsPerCallWithin(
      LINEAR_RATIO,
      () => large.text(0),
      () => small.text(0)
    );
    assertLinear(largeMs / smallMs, "text, a run of spaces");
  } finally {
    small.close();
    large.close();
  }
});
