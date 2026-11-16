// Spreads a script's files over processes of its own, for the runs that count and compare rather than
// time (text-compare, box-compare): each process takes every nth file and hands back what it tallied,
// and the calling process adds the tallies up. The same files give the same totals at any --jobs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** How many processes `--jobs 0` means: one for each core but one. */
export const defaultJobs = () => Math.max(1, os.availableParallelism() - 1);

/**
 * In the calling process with `jobs` over 1, runs the script once per shard and resolves to
 * `{ states }`, one tally per shard, in shard order. In a shard, resolves to `{ files, done(state) }`:
 * the files it takes, and the call that hands its tally back and ends it. With one job, `{ files }`.
 */
export async function shards(files, jobs) {
  const env = process.env.RECTO_SHARD;
  if (env) {
    const [index, count] = env.split("/").map(Number);
    return {
      files: files.filter((_, i) => i % count === index),
      done(state) {
        fs.writeFileSync(process.env.RECTO_SHARD_OUT, JSON.stringify(state));
        process.exit(0);
      },
    };
  }
  const count = Math.min(jobs, files.length);
  if (count <= 1) return { files };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recto-shards-"));
  const outs = Array.from({ length: count }, (_, i) => path.join(dir, `${i}.json`));
  await Promise.all(
    outs.map(
      (out, i) =>
        new Promise((resolve, reject) => {
          const proc = spawn(process.execPath, process.argv.slice(1), {
            env: { ...process.env, RECTO_SHARD: `${i}/${count}`, RECTO_SHARD_OUT: out },
            stdio: ["ignore", "ignore", "inherit"],
          });
          proc.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`shard ${i}/${count} exited ${code}`))));
        }),
    ),
  );
  const states = outs.map((out) => JSON.parse(fs.readFileSync(out, "utf8")));
  fs.rmSync(dir, { recursive: true, force: true });
  return { states };
}
