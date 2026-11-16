// node --test bench/docs.test.mjs: scripts/bench-docs.mjs fills every table it marks in
// docs/benchmarks.md from the results committed, row for row, and a second pass changes nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
const script = path.join(root, "scripts/bench-docs.mjs");

const blocks = (text) =>
  Object.fromEntries([...text.matchAll(/<!-- bench:([\w-]+) -->\n([\s\S]*?)\n<!-- \/bench:\1 -->/g)].map(([, name, body]) => [name, body]));
const tableRows = (body) => body.split("\n").filter((line) => line.startsWith("|")).length;

test("every marked table is regenerated with the rows it had, and only once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-docs-"));
  const doc = path.join(dir, "benchmarks.md");
  const before = fs.readFileSync(path.join(root, "docs/benchmarks.md"), "utf8");
  fs.writeFileSync(doc, before);
  execFileSync(process.execPath, [script, "--doc", doc], { stdio: "pipe" });
  const after = fs.readFileSync(doc, "utf8");
  const old = blocks(before);
  const fresh = blocks(after);
  assert.deepEqual(Object.keys(fresh).sort(), Object.keys(old).sort());
  assert.ok(Object.keys(old).length >= 14);
  for (const name of Object.keys(old)) {
    // The public-set F1 row needs results/text-public.json, which a refresh writes.
    const allowance = name === "text-quality" || name === "glance" ? 1 : 0;
    assert.ok(Math.abs(tableRows(fresh[name]) - tableRows(old[name])) <= allowance, `${name}: ${tableRows(old[name])} rows, now ${tableRows(fresh[name])}`);
  }
  // Outside the markers nothing moves.
  const outside = (text) => text.replace(/<!-- bench:([\w-]+) -->[\s\S]*?<!-- \/bench:\1 -->/g, "");
  assert.equal(outside(after), outside(before));
  execFileSync(process.execPath, [script, "--doc", doc, "--check"], { stdio: "pipe" });
  fs.rmSync(dir, { recursive: true, force: true });
});
