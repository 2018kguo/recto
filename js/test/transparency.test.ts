import assert from "node:assert/strict";
import { test } from "node:test";

import { openPdf } from "../src/index.ts";
import { transparencyCases } from "./transparency-cases.mjs";

const SIZE = 200;

for (const { name, pdf, probes } of transparencyCases()) {
  test(`transparency: ${name}`, async () => {
    await using doc = await openPdf(pdf);
    const { rgba } = doc.render(0, { width: SIZE });
    for (const { at, want, note } of probes) {
      const x = Math.round((at[0] / 100) * SIZE);
      const y = Math.round((1 - at[1] / 100) * SIZE);
      const seen = [...rgba.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3)];
      const off = Math.max(...seen.map((v, i) => Math.abs(v - want[i])));
      assert.ok(off <= 3, `${note}: wanted ${want}, got ${seen}`);
    }
  });
}
