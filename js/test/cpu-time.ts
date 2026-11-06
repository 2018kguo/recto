// CPU time for the engine's performance tests.
//
// Wall clock measures the machine: a descheduled test reads as a slow engine,
// and on a shared runner a 2 ms sample can lose 10 ms to its neighbours. CPU
// time counts only what this thread ran, not GC helpers or V8's background
// compiler. It is sturdier, not clean: in a starved VM the vCPU's stolen time
// is charged to the thread, and the clock moved in steps of up to 60 ms (1 ms
// is usual). So nothing here trusts one sample, or one measurement.

/** CPU time this thread has used, in ms. */
export function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/** Long enough to span many clock steps, on an operation of any size. */
const MIN_SAMPLE_CPU_MS = 20;
const ROUNDS = 7;
const MEASUREMENTS = 3;

function cpuMsPerCall(run: () => void): number {
  // Uncounted: switching pages re-parses the page, and that cost differs by
  // page. Averaged in, it would flatter a comparison of what comes after.
  run();
  const started = threadCpuMs();
  let calls = 0;
  let elapsed = 0;
  do {
    run();
    calls += 1;
    elapsed = threadCpuMs() - started;
  } while (elapsed < MIN_SAMPLE_CPU_MS);
  return elapsed / calls;
}

/**
 * The CPU ms per call of `a` and of `b`, each its fastest sample, measured
 * until time(a) / time(b) is under `maxRatio`, at most 3 times. Check the
 * ratio of what comes back: over the bound means every measurement was.
 *
 * The samples alternate so a burst of contention hits both alike, and the
 * fastest is the closest to the code's own cost. A burst can still cover one
 * side, which is why a high ratio gets another look; a real regression is high
 * every time, and this costs nothing when the first measurement passes.
 */
export function cpuMsPerCallWithin(
  maxRatio: number,
  a: () => void,
  b: () => void
): readonly [number, number] {
  let best: readonly [number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  for (let measurement = 0; measurement < MEASUREMENTS; measurement++) {
    let aMs = Number.POSITIVE_INFINITY;
    let bMs = Number.POSITIVE_INFINITY;
    for (let round = 0; round < ROUNDS; round++) {
      aMs = Math.min(aMs, cpuMsPerCall(a));
      bMs = Math.min(bMs, cpuMsPerCall(b));
    }
    if (measurement === 0 || aMs / bMs < best[0] / best[1]) {
      best = [aMs, bMs];
    }
    if (aMs / bMs < maxRatio) {
      break;
    }
  }
  return best;
}
