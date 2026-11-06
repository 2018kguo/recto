// Runs first in a worker or page: counts WebAssembly memory and watches how long the thread goes
// without taking a timer. Read over DevTools as `self.__bench`.
const memories = new Set();
const remember = (result) => {
  const instance = result?.instance ?? result;
  for (const value of Object.values(instance?.exports ?? {})) {
    if (value instanceof WebAssembly.Memory) memories.add(value);
  }
  return result;
};
for (const name of ["instantiate", "instantiateStreaming"]) {
  const original = WebAssembly[name];
  if (original) WebAssembly[name] = (...args) => original.apply(WebAssembly, args).then(remember);
}
const OriginalInstance = WebAssembly.Instance;
WebAssembly.Instance = function Instance(...args) {
  return remember(new OriginalInstance(...args));
};
WebAssembly.Instance.prototype = OriginalInstance.prototype;

const bench = {
  longestGap: 0,
  wasmBytes: () => [...memories].reduce((sum, memory) => sum + memory.buffer.byteLength, 0),
  reset() {
    bench.longestGap = 0;
    last = performance.now();
  },
};
let last = performance.now();
const beat = () => {
  const now = performance.now();
  bench.longestGap = Math.max(bench.longestGap, now - last);
  last = now;
  setTimeout(beat, 4);
};
beat();
self.__bench = bench;
