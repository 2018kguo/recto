// Holds a timed run until the machine is quiet enough to measure: the 1-minute load average under
// `maxLoad`, or the CPUs at least `minIdle` idle over a one-second look. Either will do, since a
// background indexer can hold the load average up while leaving most cores idle.
import os from "node:os";

function idleOverASecond() {
  const sum = () => os.cpus().reduce((t, cpu) => ({ idle: t.idle + cpu.times.idle, all: t.all + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, all: 0 });
  const before = sum();
  return new Promise((resolve) =>
    setTimeout(() => {
      const after = sum();
      resolve((after.idle - before.idle) / Math.max(1, after.all - before.all));
    }, 1000),
  );
}

/** `{ maxLoad, minIdle }`, minIdle a fraction; both unset means no wait. Resolves to what it saw. */
export function quietGate({ maxLoad = Infinity, minIdle = Infinity } = {}) {
  const seen = [];
  const wait = async () => {
    for (let waited = 0; ; waited += 5) {
      const load = os.loadavg()[0];
      const idle = await idleOverASecond();
      if (load < maxLoad || idle >= minIdle) {
        seen.push({ load, idle });
        return { load, idle };
      }
      if (waited % 300 === 0) console.error(`load ${load.toFixed(1)}, ${Math.round(idle * 100)}% idle: waiting`);
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  };
  const median = (list) => list.toSorted((a, b) => a - b)[Math.floor(list.length / 2)];
  const summary = () => ({
    maxLoad: Number.isFinite(maxLoad) ? maxLoad : null,
    minIdle: Number.isFinite(minIdle) ? minIdle : null,
    load: { median: Math.round(median(seen.map((s) => s.load)) * 10) / 10, max: Math.round(Math.max(...seen.map((s) => s.load)) * 10) / 10 },
    idle: { median: Math.round(median(seen.map((s) => s.idle)) * 100) / 100, min: Math.round(Math.min(...seen.map((s) => s.idle)) * 100) / 100 },
    starts: seen.length,
  });
  return { wait, summary };
}
