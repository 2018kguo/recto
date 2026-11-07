// Pages are built on demand only when the tree's counts hold up. A tree that lies has to give what
// walking it gives: its real pages, in order.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createPdfEngine } from "../src/index.ts";

/** Objects 1 and 2 are the catalog and the root node. */
function fileOf(root: string, rest: string[]): Uint8Array {
  const objects = ["<</Type/Catalog/Pages 2 0 R>>", root, "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>", ...rest];
  let file = "%PDF-1.7\n";
  const offsets = objects.map((body, i) => {
    const at = file.length;
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = file.length;
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  file += offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
  file += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(file);
}

/** Pages as a stream each, object numbers from 4: page, content, page, content... */
function pagesFrom(first: number, names: number[], extra = ""): string[] {
  return names.flatMap((n, i) => {
    const content = `BT /F 12 Tf 10 10 Td (P${n}) Tj ET`;
    return [
      `<</Type/Page/Contents ${first + 2 * i + 1} 0 R/Resources<</Font<</F 3 0 R>>>>${extra}>>`,
      `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    ];
  });
}

async function pagesOf(file: Uint8Array): Promise<string[]> {
  const engine = await createPdfEngine();
  const doc = await engine.open(file);
  const texts: string[] = [];
  // Last first: a page found by descending mustn't depend on the ones before it being read.
  for (let i = doc.pageCount - 1; i >= 0; i--) {
    texts.unshift((await doc.text(i)).text.trim());
  }
  doc.close();
  return texts;
}

const pages = pagesFrom(4, [1, 2, 3]); // objects 4, 6, 8

const cases: [string, Uint8Array, string[]][] = [
  ["a right /Count", fileOf("<</Type/Pages/Count 3/Kids[4 0 R 6 0 R 8 0 R]>>", pages), ["P1", "P2", "P3"]],
  ["a /Count too high", fileOf("<</Type/Pages/Count 7/Kids[4 0 R 6 0 R 8 0 R]>>", pages), ["P1", "P2", "P3"]],
  ["a /Count too low", fileOf("<</Type/Pages/Count 1/Kids[4 0 R 6 0 R 8 0 R]>>", pages), ["P1", "P2", "P3"]],
  ["no /Count", fileOf("<</Type/Pages/Kids[4 0 R 6 0 R 8 0 R]>>", pages), ["P1", "P2", "P3"]],
  [
    "a /Count that matches the kids only because one is missing",
    fileOf("<</Type/Pages/Count 3/Kids[4 0 R 99 0 R 6 0 R]>>", pages),
    ["P1", "P2"],
  ],
  ["a repeated kid", fileOf("<</Type/Pages/Count 3/Kids[4 0 R 4 0 R 6 0 R]>>", pages), ["P1", "P2"]],
  [
    "a /Count that matches the kids though one is a node of two",
    fileOf("<</Type/Pages/Count 2/Kids[10 0 R 8 0 R]>>", [...pages, "<</Type/Pages/Count 2/Kids[4 0 R 6 0 R]>>"]),
    ["P1", "P2", "P3"],
  ],
  [
    "an inner node whose /Count is wrong, the root's right by coincidence",
    fileOf("<</Type/Pages/Count 4/Kids[10 0 R 8 0 R]>>", [...pages, "<</Type/Pages/Count 3/Kids[4 0 R 6 0 R]>>"]),
    ["P1", "P2", "P3"],
  ],
  [
    "a node that is its own kid",
    fileOf("<</Type/Pages/Count 2/Kids[10 0 R 4 0 R]>>", [...pages, "<</Type/Pages/Count 1/Kids[10 0 R]>>"]),
    ["P1"],
  ],
];

for (const [name, file, expected] of cases) {
  test(`page tree: ${name}`, async () => {
    assert.deepEqual(await pagesOf(file), expected);
  });
}

test("page tree: a node's inherited box and rotation reach a page found on demand", async () => {
  const file = fileOf("<</Type/Pages/Count 2/Kids[8 0 R 4 0 R]/Rotate 90/MediaBox[0 0 300 200]>>", [
    ...pagesFrom(4, [1, 2]),
    "<</Type/Pages/Count 1/Kids[6 0 R]/MediaBox[0 0 100 50]>>",
  ]);
  const engine = await createPdfEngine();
  for (const doc of [await engine.open(file), await engine.openRanged(file)]) {
    // Second page first: nothing about it comes from having read the first.
    const second = await doc.pageInfo(1);
    const first = await doc.pageInfo(0);
    assert.deepEqual([first.width, first.height, first.rotation], [50, 100, 90]);
    assert.deepEqual([second.width, second.height, second.rotation], [200, 300, 90]);
    doc.close();
  }
});

test("page tree: a chain of nodes far deeper than the check goes opens, and keeps its page", async () => {
  const DEPTH = 5000;
  const first = 6; // pagesFrom takes 4 and 5
  const chain = Array.from({ length: DEPTH }, (_, i) =>
    i === DEPTH - 1
      ? "<</Type/Pages/Count 1/Kids[4 0 R]>>"
      : `<</Type/Pages/Count 1/Kids[${first + i + 1} 0 R]>>`
  );
  const file = fileOf(`<</Type/Pages/Count 1/Kids[${first} 0 R]>>`, [...pagesFrom(4, [1]), ...chain]);
  assert.deepEqual(await pagesOf(file), ["P1"]);
});
