// A whole file: which page is which comes from walking the tree in order, so a tree that lies gives
// its real pages. Repeats count, as they do in other readers; only a node that's its own ancestor is
// skipped. A ranged file finds a page by /Count, which agrees with that walk if the counts are true,
// and otherwise holds to less: see the tests at the end of the differential below.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { createPdfEngine } from "../src/index.ts";
import { threadCpuMs } from "./cpu-time.ts";

/** Objects 1 and 2 are the catalog and the root node. */
function fileOf(root: string, rest: string[], catalog = "<</Type/Catalog/Pages 2 0 R>>"): Uint8Array {
  const objects = [catalog, root, "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>", ...rest];
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

test("page tree: a bookmark to a page the tree repeats goes to where it first appears", async () => {
  const file = fileOf(
    "<</Type/Pages/Count 3/Kids[4 0 R 6 0 R 4 0 R]>>",
    [...pages, "<</First 11 0 R/Last 11 0 R>>", "<</Title(First)/Parent 10 0 R/Dest[4 0 R/Fit]>>"],
    "<</Type/Catalog/Pages 2 0 R/Outlines 10 0 R>>"
  );
  const engine = await createPdfEngine();
  using doc = await engine.open(file);
  assert.equal(doc.outline()[0]?.page, 0);
});

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

/** A tree whose every /Count is what its node holds, with repeats, diamonds and mixed leaves. */
function truthfulTree(seed: number): { file: Uint8Array; expected: number[]; shape: string } {
  let state = (seed * 2_654_435_761) >>> 0;
  const random = (below: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state >>> 8) % below;
  };
  for (;;) {
    const pageCount = 1 + random(8);
    const nodeCount = random(8);
    const firstPage = 4;
    const firstNode = firstPage + 2 * pageCount;
    // Node n's kids are pages or later nodes, so there are no cycles and every count is known.
    const held: number[][] = [];
    const kidsOf: number[][] = [];
    const nodeId = (n: number) => (n === 0 ? 2 : firstNode + n - 1);
    for (let n = nodeCount; n >= 0; n--) {
      const kids: number[] = [];
      const pages: number[] = [];
      const length = random(6) + (n === 0 ? 1 : 0);
      for (let k = 0; k < length; k++) {
        const later = n + 1 + random(Math.max(1, nodeCount - n));
        if (later <= nodeCount && random(2) === 0) {
          kids.push(nodeId(later));
          pages.push(...held[later]!);
        } else {
          const page = random(pageCount);
          kids.push(firstPage + 2 * page);
          pages.push(page);
        }
      }
      held[n] = pages;
      kidsOf[n] = kids;
    }
    const total = held[0]!.length;
    if (total === 0 || total > 2000) {
      continue;
    }
    const nodeText = (n: number) => `<</Type/Pages/Count ${held[n]!.length}/Kids[${kidsOf[n]!.map((kid) => `${kid} 0 R`).join(" ")}]>>`;
    const rest = [
      ...pagesFrom(firstPage, Array.from({ length: pageCount }, (_, i) => i)),
      ...Array.from({ length: nodeCount }, (_, i) => nodeText(i + 1)),
    ];
    return {
      file: fileOf(nodeText(0), rest),
      expected: held[0]!,
      shape: Array.from({ length: nodeCount + 1 }, (_, n) => `${nodeId(n)}:${nodeText(n)}`).join(" "),
    };
  }
}

test("page tree: where every /Count is true, a ranged file gives the walk's pages, in any order", async () => {
  const engines = [await createPdfEngine(), await createPdfEngine({ preloadAssets: [] })];
  for (let seed = 1; seed <= 600; seed++) {
    const { file, expected, shape } = truthfulTree(seed);
    const want = expected.map((page) => `P${page}`);
    const whole = await engines[seed % 2]!.open(file);
    const ranged = await engines[seed % 2]!.openRanged(file);
    assert.equal(ranged.pageCount, want.length, `seed ${seed}: ${shape}`);
    const order = want.map((_, i) => i);
    if (seed % 2 === 0) {
      order.reverse(); // last first: nothing read before it
    }
    for (const i of order) {
      assert.equal(readPage(ranged, i), want[i], `seed ${seed} page ${i}: ${shape}`);
      assert.equal(readPage(whole, i), want[i], `seed ${seed} whole page ${i}: ${shape}`);
    }
    whole.close();
    ranged.close();
  }
});

test("page tree: whatever the counts say, a ranged read ends, with a page of the tree or a typed error", async () => {
  const engine = await createPdfEngine();
  for (let seed = 1; seed <= 600; seed++) {
    const { file, expected, shape } = randomTree(seed);
    const doc = await engine.openRanged(file);
    const order = Array.from({ length: doc.pageCount }, (_, i) => i);
    if (seed % 2 === 0) {
      order.reverse();
    }
    const inTree = new Set(expected.map((page) => `P${page}`));
    for (const i of order) {
      const got = readPage(doc, i);
      assert.ok(got === "error failed" || inTree.has(got), `seed ${seed} page ${i} gave ${got}: ${shape}`);
    }
    doc.close();
  }
});

/** A fan-out tree with pages deleted the way an editor does: counts fixed up, the nodes left empty. */
function deletedPagesTree(seed: number): { file: Uint8Array; expected: number[]; shape: string } {
  let state = (seed * 2_654_435_761) >>> 0;
  const random = (below: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state >>> 8) % below;
  };
  const fan = [3, 5, 10, 10, 16][random(5)]!;
  const pageTotal = 10 + random(120);
  const keep = 1 + random(Math.ceil(pageTotal / 2));
  const kept = new Set<number>();
  while (kept.size < keep) {
    kept.add(random(pageTotal));
  }
  const firstPage = 4;
  const firstNode = firstPage + 2 * pageTotal;
  const nodes: string[] = [];
  type Built = { id: number; pages: number[] };
  const addNode = (kids: Built[]): Built => {
    const pages = kids.flatMap((kid) => kid.pages);
    const live = kids.filter((kid) => kid.id < firstNode ? kid.pages.length > 0 : true);
    nodes.push(`<</Type/Pages/Count ${pages.length}/Kids[${live.map((kid) => `${kid.id} 0 R`).join(" ")}]>>`);
    return { id: firstNode + nodes.length - 1, pages };
  };
  let level: Built[] = Array.from({ length: pageTotal }, (_, i) => ({
    id: firstPage + 2 * i,
    pages: kept.has(i) ? [i] : [],
  }));
  while (level.length > fan) {
    const next: Built[] = [];
    for (let i = 0; i < level.length; i += fan) {
      next.push(addNode(level.slice(i, i + fan)));
    }
    level = next;
  }
  const pages = level.flatMap((kid) => kid.pages);
  const live = level.filter((kid) => kid.id < firstNode ? kid.pages.length > 0 : true);
  const root = `<</Type/Pages/Count ${pages.length}/Kids[${live.map((kid) => `${kid.id} 0 R`).join(" ")}]>>`;
  return {
    file: fileOf(root, [...pagesFrom(firstPage, Array.from({ length: pageTotal }, (_, i) => i)), ...nodes]),
    expected: pages,
    shape: `seed ${seed}, fan ${fan}, ${pageTotal} pages cut to ${keep}: ${root} ${nodes.join(" ")}`,
  };
}

test("page tree: a tree with pages deleted, empty nodes left behind: a ranged jump gives the page a whole file does", async () => {
  const engine = await createPdfEngine();
  for (let seed = 1; seed <= 300; seed++) {
    const { file, expected, shape } = deletedPagesTree(seed);
    const want = expected.map((page) => `P${page}`);
    const whole = await engine.open(file);
    assert.deepEqual(want.map((_, i) => readPage(whole, i)), want, shape);
    whole.close();
    // Every page, each on a fresh open, so each is a jump with nothing read before it.
    for (let i = 0; i < want.length; i++) {
      const ranged = await engine.openRanged(file);
      assert.equal(ranged.pageCount, want.length, shape);
      assert.equal(readPage(ranged, (i * 7 + seed) % want.length), want[(i * 7 + seed) % want.length], shape);
      ranged.close();
    }
  }
});

test("page tree: nodes of up to 32 kids mixing leaves, empties and nodes read right in any order", async () => {
  const [p1, p2, p3, p4] = [4, 6, 8, 10];
  const mixed = fileOf(`<</Type/Pages/Count 4/Kids[12 0 R ${p1} 0 R ${p2} 0 R 13 0 R]>>`, [
    ...pagesFrom(4, [1, 2, 3, 4]),
    "<</Type/Pages/Count 0/Kids[]>>",
    `<</Type/Pages/Count 2/Kids[${p3} 0 R ${p4} 0 R]>>`,
  ]);
  for (const order of [[1, 0, 3, 2], [3, 2, 1, 0], [0, 1, 2, 3]]) {
    const engine = await createPdfEngine();
    const doc = await engine.openRanged(mixed);
    const got: string[] = [];
    for (const i of order) {
      got[i] = readPage(doc, i);
    }
    assert.deepEqual(got, ["P1", "P2", "P3", "P4"], String(order));
    doc.close();
  }
});

// What a ranged read gives where it can't see the problem. reference.md states this limit. These are
// pinned so a change to them is a decision: each list is the pages read in that order.
const AB = pagesFrom(4, [1, 2, 3]); // objects 4, 6, 8
// Objects 4.. hold pages P0 to P35, then an empty node and a node of the last two.
const wide = pagesFrom(4, Array.from({ length: 36 }, (_, i) => i));
const wideKids = Array.from({ length: 34 }, (_, i) => `${4 + 2 * i} 0 R`).join(" ");
const wideFile = fileOf(`<</Type/Pages/Count 36/Kids[76 0 R ${wideKids} 77 0 R]>>`, [
  ...wide,
  "<</Type/Pages/Count 0/Kids[]>>",
  `<</Type/Pages/Count 2/Kids[${4 + 2 * 34} 0 R ${4 + 2 * 35} 0 R]>>`,
]);
const lies: [string, Uint8Array, number[], string[]][] = [
  [
    "the one case with true counts: over 32 kids, as many as /Count, a node among those jumped over: P0 again for page 1",
    wideFile,
    [1, 0],
    ["P0", "P0"],
  ],
  ["the same tree first page first: the node is seen, and the walk takes over", wideFile, [0, 1], ["P0", "P1"]],
  [
    "a node before the page says 1 and holds 2, under a root whose counts add up: unseen",
    fileOf("<</Type/Pages/Count 2/Kids[10 0 R 8 0 R]>>", [...AB, "<</Type/Pages/Count 1/Kids[4 0 R 6 0 R]>>"]),
    [1, 0],
    ["P3", "P1"],
  ],
  [
    "a kid that isn't there: seen on the way, and the walk has no such page",
    fileOf("<</Type/Pages/Count 3/Kids[4 0 R 99 0 R 6 0 R]>>", AB),
    [2, 1, 0],
    ["error failed", "P2", "P1"],
  ],
  [
    "a node on the path that is its own kid: seen, and the walk finds nothing",
    fileOf("<</Type/Pages/Count 1/Kids[10 0 R]>>", [...AB, "<</Type/Pages/Count 1/Kids[10 0 R]>>"]),
    [0],
    ["error failed"],
  ],
];

for (const [name, file, order, want] of lies) {
  test(`page tree, ranged: ${name}`, async () => {
    const engine = await createPdfEngine();
    const doc = await engine.openRanged(file);
    assert.deepEqual(order.map((i) => readPage(doc, i)), want);
    doc.close();
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
