// Holds a timed run until the machine is quiet enough to measure: the 1-minute load average under
// `maxLoad`, or the CPUs at least `minIdle` idle over a quarter second. Either will do, since a
// background indexer can hold the load average up while leaving most cores idle.
//
// With `maxWait` the gate is soft: past that many seconds it lets the run start anyway and counts it as
// forced. Paired rounds (stats.mjs) carry what a busy minute does to both engines of a pair, so the gate
// only has to keep a run off a machine with no core to spare, not wait for a quiet one.
import os from "node:os";

function cpuTimes() {
  return os.cpus().reduce((t, cpu) => ({ idle: t.idle + cpu.times.idle, all: t.all + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, all: 0 });
}

function idleOver(ms) {
  const before = cpuTimes();
  return new Promise((resolve) =>
    setTimeout(() => {
      const after = cpuTimes();
      resolve((after.idle - before.idle) / Math.max(1, after.all - before.all));
    }, ms),
  );
}

/** `{ maxLoad, minIdle, maxWait }`, minIdle a fraction, maxWait seconds; no thresholds means no wait. */
export function quietGate({ maxLoad = Infinity, minIdle = Infinity, maxWait = Infinity } = {}) {
  const seen = [];
  let waitedTotal = 0;
  const gated = Number.isFinite(maxLoad) || Number.isFinite(minIdle);
  const wait = async () => {
    const started = Date.now();
    for (let waited = 0; ; waited += 5) {
      const load = os.loadavg()[0];
      const idle = await idleOver(250);
      const forced = gated && (Date.now() - started) / 1000 >= maxWait;
      if (!gated || load < maxLoad || idle >= minIdle || forced) {
        waitedTotal += (Date.now() - started) / 1000;
        seen.push({ load, idle, forced });
        return { load, idle, forced };
      }
      if (waited % 300 === 0) console.error(`load ${load.toFixed(1)}, ${Math.round(idle * 100)}% idle: waiting`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
  const median = (list) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)];
  const round = (value, by) => Math.round(value * by) / by;
  const summary = () => ({
    maxLoad: Number.isFinite(maxLoad) ? maxLoad : null,
    minIdle: Number.isFinite(minIdle) ? minIdle : null,
    maxWait: Number.isFinite(maxWait) ? maxWait : null,
    load: { median: round(median(seen.map((s) => s.load)), 10), max: round(Math.max(...seen.map((s) => s.load)), 10) },
    idle: { median: round(median(seen.map((s) => s.idle)), 100), min: round(Math.min(...seen.map((s) => s.idle)), 100) },
    starts: seen.length,
    forced: seen.filter((s) => s.forced).length,
    waitedSeconds: Math.round(waitedTotal),
  });
  return { wait, summary };
}
