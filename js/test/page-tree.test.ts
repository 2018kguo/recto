// Pages are built on demand, and which page is which only ever comes from walking the tree in
// order. A tree that lies gives what walking it gives: its real pages. Repeats count, as they do in
// other readers; only a node that's its own ancestor is skipped.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { createPdfEngine } from "../src/index.ts";
import { threadCpuMs } from "./cpu-time.ts";

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
  ["a repeated kid", fileOf("<</Type/Pages/Count 3/Kids[4 0 R 4 0 R 6 0 R]>>", pages), ["P1", "P1", "P2"]],
  [
    "one page repeated five times",
    fileOf("<</Type/Pages/Count 5/Kids[4 0 R 4 0 R 4 0 R 4 0 R 4 0 R]>>", pages),
    ["P1", "P1", "P1", "P1", "P1"],
  ],
  [
    "a diamond: two nodes sharing a node",
    fileOf("<</Type/Pages/Count 4/Kids[10 0 R 11 0 R]>>", [
      ...pages,
      "<</Type/Pages/Count 2/Kids[12 0 R]>>",
      "<</Type/Pages/Count 2/Kids[12 0 R]>>",
      "<</Type/Pages/Count 2/Kids[4 0 R 6 0 R]>>",
    ]),
    ["P1", "P2", "P1", "P2"],
  ],
  [
    "kids of two pages and one, and an empty node, adding up by coincidence",
    fileOf("<</Type/Pages/Count 3/Kids[10 0 R 11 0 R 12 0 R]>>", [
      ...pages,
      "<</Type/Pages/Count 2/Kids[4 0 R 6 0 R]>>",
      "<</Type/Pages/Count 1/Kids[8 0 R]>>",
      "<</Type/Pages/Count 0/Kids[]>>",
    ]),
    ["P1", "P2", "P3"],
  ],
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

// A separate process with a limit: this hung once, in wasm, where no timer in this thread can fire.
test("page tree: a ranged tree that loops ends, on its own or through another node", () => {
  const loop = {
    self: fileOf("<</Type/Pages/Count 1/Kids[6 0 R]>>", [...pagesFrom(4, [1]), "<</Type/Pages/Count 1/Kids[6 0 R]>>"]),
    two: fileOf("<</Type/Pages/Count 1/Kids[6 0 R]>>", [
      ...pagesFrom(4, [1]),
      "<</Type/Pages/Count 1/Kids[7 0 R]>>",
      "<</Type/Pages/Count 1/Kids[6 0 R]>>",
    ]),
  };
  const index = new URL("../src/index.ts", import.meta.url).href;
  for (const [name, file] of Object.entries(loop)) {
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { createPdfEngine } = await import(${JSON.stringify(index)});
         const engine = await createPdfEngine();
         const doc = await engine.openRanged(Buffer.from(process.argv[1], "base64"));
         try { doc.text(0); console.log("read"); } catch (error) { console.log(error.code); }`,
        Buffer.from(file).toString("base64"),
      ],
      { timeout: 30_000, encoding: "utf8" }
    );
    assert.equal(out.trim(), "failed", name);
  }
});

test("page tree: nodes built to multiply stop at a limit, in about the same time however deep", async () => {
  const chain = (leaf: string, depth: number) => {
    const first = 6;
    const nodes = Array.from({ length: depth }, (_, i) => {
      const next = i === depth - 1 ? leaf : `${first + i + 1} 0 R`;
      return `<</Type/Pages/Count 1/Kids[${next} ${next}]>>`;
    });
    return fileOf(`<</Type/Pages/Count 1/Kids[${first} 0 R ${first} 0 R]>>`, [...pagesFrom(4, [1]), ...nodes]);
  };
  const engine = await createPdfEngine({ recycleAboveBytes: 1 });
  // 2^60 pages, and 2^60 nodes with no page at all.
  const pagesBomb = await engine.open(chain("4 0 R", 60));
  assert.ok(pagesBomb.pageCount > 0 && pagesBomb.pageCount <= 2 ** 19, String(pagesBomb.pageCount));
  assert.equal(pagesBomb.text(pagesBomb.pageCount - 1).text.trim(), "P1");
  pagesBomb.close();
  const emptyBomb = await engine.open(chain("99 0 R", 60));
  assert.equal(emptyBomb.pageCount, 0);
  emptyBomb.close();
});

// The walk, written out separately from the engine: this is what a page has to be.
type Kid = number | { direct: number } | "missing";
type TreeNode = { kids: Kid[]; count: number | null; hasKids: boolean; untyped?: boolean };

function modelWalk(nodes: Map<number, TreeNode>, pageOf: Map<number, number>, root: number, limit: number): number[] | null {
  const out: number[] = [];
  const path = new Set<number>();
  let steps = 0;
  const walk = (id: number): boolean => {
    path.add(id);
    for (const kid of nodes.get(id)!.kids) {
      if (++steps > limit) {
        return false;
      }
      if (kid === "missing") {
        continue;
      }
      if (typeof kid === "object") {
        out.push(kid.direct);
        continue;
      }
      const page = pageOf.get(kid);
      if (page !== undefined) {
        out.push(page);
      } else if (!path.has(kid) && nodes.get(kid)!.hasKids && !walk(kid)) {
        return false;
      }
    }
    path.delete(id);
    return true;
  };
  return walk(root) ? out : null;
}

/** A tree with zero-count nodes, wrong counts, cycles, repeats, deep chains, leaves mixed with nodes. */
function randomTree(seed: number): { file: Uint8Array; expected: number[]; shape: string } {
  let state = seed >>> 0;
  const random = (below: number) => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % below) >>> 0;
  };
  for (;;) {
    const pageCount = 1 + random(8);
    const nodeCount = 1 + random(8);
    const chain = random(4) === 0 ? 70 + random(40) : 0;
    // Objects: 1 catalog, 2 root, 3 font, then pages with their streams, then the other nodes.
    const firstPage = 4;
    const pageIds = Array.from({ length: pageCount }, (_, i) => firstPage + 2 * i);
    const firstNode = firstPage + 2 * pageCount;
    const nodeIds = [2, ...Array.from({ length: nodeCount + chain }, (_, i) => firstNode + i)];
    const pageOf = new Map(pageIds.map((id, i) => [id, i]));
    const nodes = new Map<number, TreeNode>();
    const flatStyle = random(3) === 0; // Kids as many as /Count, whatever they are.
    for (const [position, id] of nodeIds.slice(0, nodeCount + 1).entries()) {
      const kids: Kid[] = [];
      const length = random(6);
      for (let k = 0; k < length; k++) {
        const pick = random(16);
        if (pick < 7) {
          kids.push(pageIds[random(pageCount)]!);
        } else if (pick < 13) {
          kids.push(nodeIds[random(nodeCount + 1)]!); // forward, back, itself: anything goes
        } else if (pick === 13) {
          kids.push("missing");
        } else if (pick === 14 && kids.length > 0) {
          kids.push(kids[random(kids.length)]!);
        } else {
          kids.push({ direct: random(pageCount) });
        }
      }
      const countStyle = random(4);
      const count = flatStyle ? kids.length : countStyle === 0 ? null : countStyle === 1 ? random(9) : kids.length;
      nodes.set(id, { kids, count, hasKids: position === 0 || random(12) !== 0 });
    }
    // A deep chain hanging off the last node, ending at a page.
    for (let i = 0; i < chain; i++) {
      const id = nodeIds[nodeCount + 1 + i]!;
      const next = i === chain - 1 ? pageIds[0]! : nodeIds[nodeCount + 2 + i]!;
      nodes.set(id, { kids: [next], count: 1, hasKids: true });
    }
    if (chain > 0) {
      nodes.get(nodeIds[nodeCount]!)!.kids.push(nodeIds[nodeCount + 1]!);
    }
    const expected = modelWalk(nodes, pageOf, 2, 3000);
    if (!expected) {
      continue; // multiplied past what a test should read
    }
    const kidText = (kid: Kid) => {
      if (kid === "missing") {
        return "9999 0 R";
      }
      if (typeof kid === "object") {
        return `<</Type/Page/Contents ${firstPage + 2 * kid.direct + 1} 0 R/Resources<</Font<</F 3 0 R>>>>>>`;
      }
      return `${kid} 0 R`;
    };
    const nodeText = (node: TreeNode) =>
      `<</Type/Pages${node.count === null ? "" : `/Count ${node.count}`}${node.hasKids ? `/Kids[${node.kids.map(kidText).join(" ")}]` : ""}>>`;
    const rest = [
      ...pagesFrom(firstPage, pageIds.map((_, i) => i)),
      ...nodeIds.slice(1).map((id) => nodeText(nodes.get(id)!)),
    ];
    return {
      file: fileOf(nodeText(nodes.get(2)!), rest),
      expected,
      shape: [...nodes.entries()].slice(0, nodeCount + 1).map(([id, n]) => `${id}:${nodeText(n)}`).join(" "),
    };
  }
}

const readPage = (doc: { text(i: number): { text: string } }, index: number): string => {
  try {
    return doc.text(index).text.trim();
  } catch (error) {
    return `error ${(error as { code?: string }).code}`;
  }
};

test("page tree: a whole file gives exactly the walk's pages, whatever order they're read in, on both builds", async () => {
  const engines = [await createPdfEngine(), await createPdfEngine({ preloadAssets: [] })];
  for (let seed = 1; seed <= 600; seed++) {
    const { file, expected, shape } = randomTree(seed);
    const doc = await engines[seed % 2]!.open(file);
    const want = expected.map((page) => `P${page}`);
    assert.equal(doc.pageCount, want.length, `seed ${seed}: ${shape}`);
    const order = want.map((_, i) => i);
    if (seed % 3 === 0) {
      order.reverse();
    } else if (seed % 3 === 1) {
      order.sort((a, b) => ((a * 7 + seed) % 11) - ((b * 7 + seed) % 11));
    }
    for (const i of order) {
      assert.equal(readPage(doc, i), want[i], `seed ${seed} page ${i}: ${shape}`);
    }
    doc.close();
  }
});

test("page tree: a ranged file never gives a different page than the walk", async () => {
  const engines = [await createPdfEngine(), await createPdfEngine({ preloadAssets: [] })];
  for (let seed = 1; seed <= 600; seed++) {
    const { file, expected, shape } = randomTree(seed);
    const doc = await engines[seed % 2]!.openRanged(file);
    const want = expected.map((page) => `P${page}`);
    const order = Array.from({ length: doc.pageCount }, (_, i) => i);
    if (seed % 2 === 0) {
      order.reverse(); // last first: nothing read before it
    }
    for (const i of order) {
      // A /Count that passes unread can promise pages that aren't there. It can't change one that is.
      assert.equal(readPage(doc, i), want[i] ?? "error failed", `seed ${seed} page ${i}: ${shape}`);
    }
    doc.close();
  }
});

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

test("page tree: first reads are linear and take little memory beyond the open's", async () => {
  // A binary tree, the shape that once cost a kept node per inner node and a hash lookup per level.
  const LEVELS = 15;
  const objects: string[] = [];
  const build = (level: number): number => {
    const id = 4 + objects.length;
    const at = objects.length;
    objects.push("");
    if (level === 0) {
      objects[at] = "<</Type/Page>>";
    } else {
      const [a, b] = [build(level - 1), build(level - 1)];
      objects[at] = `<</Type/Pages/Count ${2 ** level}/Kids[${a} 0 R ${b} 0 R]>>`;
    }
    return id;
  };
  const top = build(LEVELS);
  const file = fileOf(`<</Type/Pages/Count ${2 ** LEVELS}/Kids[${top} 0 R]>>`, objects);
  const engine = await createPdfEngine();
  const started = threadCpuMs();
  const doc = await engine.open(file);
  const openMs = threadCpuMs() - started;
  const heapAtOpen = engine.stats().heapBytes;
  const reading = threadCpuMs();
  for (let i = 0; i < doc.pageCount; i++) {
    doc.pageInfo(i);
  }
  const readMs = threadCpuMs() - reading;
  assert.ok(readMs < openMs, `first read of every page ${readMs} ms, open ${openMs} ms`);
  assert.ok(engine.stats().heapBytes < heapAtOpen * 1.15, `heap ${heapAtOpen} to ${engine.stats().heapBytes}`);
  doc.close();
});
