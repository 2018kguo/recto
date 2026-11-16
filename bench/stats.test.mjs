// node --test bench/stats.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { decided, pairedRatio, seeded, signedRankCut, unpairedRatio, verdict } from "./stats.mjs";

test("the signed-rank cut matches the published critical values", () => {
  // Two-sided 5%: n=6 → 0, 7 → 2, 8 → 3, 10 → 8, 15 → 25, 20 → 52 (any Wilcoxon table).
  assert.equal(signedRankCut(5), null);
  for (const [n, cut] of [[6, 0], [7, 2], [8, 3], [10, 8], [15, 25], [20, 52]]) assert.equal(signedRankCut(n).cut, cut);
  for (const n of [6, 7, 8, 10, 15, 20, 40]) assert.ok(signedRankCut(n).level >= 0.95);
});

test("a paired ratio covers the true ratio at least as often as it says", () => {
  // Rounds share a slowdown (the machine's minute) and add noise of their own; the true ratio is 1.3.
  const random = seeded(3);
  let covered = 0;
  const trials = 400;
  for (let t = 0; t < trials; t++) {
    const base = [];
    const other = [];
    for (let r = 0; r < 8; r++) {
      const load = 1 + 2 * random() ** 3;
      base.push(100 * load * (1 + 0.05 * (random() - 0.5)));
      other.push(130 * load * (1 + 0.05 * (random() - 0.5)));
    }
    const { interval } = pairedRatio(other, base);
    if (interval[0] <= 1.3 && 1.3 <= interval[1]) covered++;
  }
  assert.ok(covered / trials >= 0.93, `covered ${covered} of ${trials}`);
});

test("pairing removes what a round shares, where independent medians can't", () => {
  const random = seeded(5);
  const base = [];
  const other = [];
  for (let r = 0; r < 8; r++) {
    const load = 1 + 2 * random();
    base.push(100 * load);
    other.push(116 * load * (1 + 0.02 * (random() - 0.5)));
  }
  const paired = pairedRatio(other, base);
  const unpaired = unpairedRatio(other, base);
  assert.equal(verdict(paired), "ahead");
  assert.ok(unpaired.interval[0] < 1, "the unpaired interval holds 1");
  assert.ok(paired.interval[1] / paired.interval[0] < 1.05);
});

test("a row is decided when its interval leaves out 1 or is narrow", () => {
  assert.equal(decided({ ratio: 1.2, interval: [1.05, 1.4] }), true);
  assert.equal(decided({ ratio: 1.0, interval: [0.97, 1.04] }), true);
  assert.equal(decided({ ratio: 1.0, interval: [0.9, 1.1] }), false);
  assert.equal(decided({ ratio: 1.0, interval: null }), false);
});

test("a value that isn't positive has no ratio", () => {
  assert.equal(pairedRatio([0, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1]), null);
});
