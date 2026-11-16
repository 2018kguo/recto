// What one stretch of work cost: `wall`, elapsed time; `thread`, the calling thread's CPU time; `cpu`,
// the process's, every thread. Times in milliseconds.
//
// The timed rows that measure an engine's own work on the calling thread report `thread`. On a busy
// machine wall time grows with the queue for a core, and differently from one round to the next; the
// calling thread's CPU time doesn't, and with a core to spare the two are the same, since none of these
// engines waits for I/O or another thread while it reads or draws. `cpu` is kept to compare: it also
// counts V8's helper threads (compiling, collecting) that a quiet machine runs beside the work, which
// charges pdf.js twice what it does recto. Instructions and cycles from the kernel were tried too: they
// are steady, but per process, with the same fault. docs/benchmarks.md#how-it-was-measured has the data.
const ms = ({ user, system }) => (user + system) / 1000;
const threadCpu = () => (process.threadCpuUsage ? process.threadCpuUsage() : null);

/** Starts a meter; the function it returns stops it and gives `{ wall, thread, cpu }`. */
export function meter() {
  const cpu = process.cpuUsage();
  const thread = threadCpu();
  const wall = performance.now();
  return () => ({
    wall: performance.now() - wall,
    thread: thread ? ms(process.threadCpuUsage(thread)) : null,
    cpu: ms(process.cpuUsage(cpu)),
  });
}

/** The same, from the process starting: for a cold start, where the clock starts with the process. */
export function sinceStart() {
  const thread = threadCpu();
  return { wall: performance.now(), thread: thread ? ms(thread) : null, cpu: ms(process.cpuUsage()) };
}
