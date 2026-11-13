// What drawing a page holds: drawn again and again it comes to a plateau, and a page of many groups
// that need their backdrop costs about what one does. WebAssembly memory never shrinks, so its size
// is the high-water mark of every render so far.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createPdfEngine } from "../src/index.ts";
import { pdfOf } from "./transparency-cases.mjs";

const WIDTH = 1000;
const PAGE_BYTES = WIDTH * WIDTH * 4;

/** Yellow, with `groups` small non-isolated groups that multiply inside, under a 50% grey mask. */
function pageOfGroups(groups: number): Uint8Array {
  let content = "1 1 0 rg 0 0 100 100 re f\n";
  for (let i = 0; i < groups; i++) {
    content += `q 1 0 0 1 ${2 + (i % 6) * 16} ${2 + Math.floor(i / 6) * 16} cm /Shadow gs /G Do Q\n`;
  }
  return pdfOf({
    content,
    resources: "/XObject <</G 5 0 R>> /ExtGState <</Shadow <</SMask <</Type /Mask /S /Luminosity /G 6 0 R>>>>>>",
    objects: [
      {
        dict: " /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Group <</S /Transparency>> /Resources <</ExtGState <</Mul <</BM /Multiply>>>>>>",
        data: "/Mul gs 0 1 1 rg 1 1 8 8 re f",
      },
      { dict: " /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Group <</S /Transparency /CS /DeviceRGB>>", data: "0.5 g 0 0 10 10 re f" },
    ],
  });
}

/** The instance's memory after each of `renders` renders of the page, each followed by its text. */
async function heapAfterEach(pdf: Uint8Array, renders: number): Promise<number[]> {
  const engine = await createPdfEngine();
  await using doc = await engine.open(pdf);
  const heap = [];
  for (let i = 0; i < renders; i++) {
    doc.render(0, { width: WIDTH });
    doc.scan(0);
    heap.push(engine.stats().heapBytes);
  }
  return heap;
}

test("a page drawn again and again: memory settles after the first renders, then stays flat", async () => {
  const SETTLE = 2;
  const FLAT = 6;
  const heap = await heapAfterEach(pageOfGroups(12), SETTLE + FLAT);
  const settled = heap[SETTLE - 1]!;
  for (const [i, bytes] of heap.slice(SETTLE).entries()) {
    assert.equal(bytes, settled, `render ${SETTLE + i + 1} grew the heap: ${heap.join(", ")}`);
  }
});

test("a page of many groups that need their backdrop: each costs well under a page-sized pixmap", async () => {
  const [few] = await heapAfterEach(pageOfGroups(3), 1);
  const [many] = await heapAfterEach(pageOfGroups(24), 1);
  // Before, each held a backdrop, a result and a drawing of every group before it, page-sized.
  const perGroup = (many! - few!) / 21;
  assert.ok(perGroup < PAGE_BYTES / 2, `${perGroup} bytes a group past the first (${few} for 3, ${many} for 24)`);
});
