// The damage bench/fuzz.mjs and the JavaScript tests do to a PDF, from a seed. Runs anywhere.

/** mulberry32. */
export function randomFrom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n) };
}

const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);
const allOf = (text, pattern) => [...text.matchAll(pattern)];

/** Each takes the bytes and the generator, and returns damaged bytes. */
export const MUTATIONS = {
  bitFlips(bytes, random) {
    const out = Uint8Array.from(bytes);
    const flips = 1 + random.int(32);
    for (let i = 0; i < flips; i++) out[random.int(out.length)] ^= 1 << random.int(8);
    return out;
  },
  overwriteRange(bytes, random) {
    const out = Uint8Array.from(bytes);
    const length = 1 + random.int(Math.min(4096, out.length));
    const start = random.int(out.length - length + 1);
    const fill = random.int(3);
    for (let i = start; i < start + length; i++) out[i] = fill === 0 ? 0 : fill === 1 ? 255 : random.int(256);
    return out;
  },
  truncate(bytes, random) {
    return bytes.subarray(0, 1 + random.int(bytes.length - 1));
  },
  truncateTail(bytes, random) {
    return bytes.subarray(0, Math.max(1, bytes.length - 1 - random.int(Math.min(2048, bytes.length - 1))));
  },
  xrefOffsets(bytes, random) {
    const text = latin1(bytes);
    const entries = allOf(text, /\b\d{10} \d{5} [nf]\b/g);
    const out = Uint8Array.from(bytes);
    if (entries.length === 0) return MUTATIONS.bitFlips(bytes, random);
    const damaged = 1 + random.int(Math.min(entries.length, 8));
    for (let i = 0; i < damaged; i++) {
      const at = entries[random.int(entries.length)].index;
      const value = String(random.int(bytes.length * 2)).padStart(10, "0");
      for (let d = 0; d < 10; d++) out[at + d] = value.charCodeAt(d);
    }
    return out;
  },
  startxref(bytes, random) {
    const text = latin1(bytes);
    const found = allOf(text, /startxref\s+(\d+)/g).at(-1);
    if (!found) return MUTATIONS.bitFlips(bytes, random);
    const out = Uint8Array.from(bytes);
    const at = found.index + found[0].length - found[1].length;
    for (let d = 0; d < found[1].length; d++) out[at + d] = 48 + random.int(10);
    return out;
  },
  streamLengths(bytes, random) {
    const text = latin1(bytes);
    const lengths = allOf(text, /\/Length (\d+)(?! \d+ R)/g);
    const out = Uint8Array.from(bytes);
    if (lengths.length === 0) return MUTATIONS.bitFlips(bytes, random);
    const damaged = 1 + random.int(Math.min(lengths.length, 16));
    for (let i = 0; i < damaged; i++) {
      const found = lengths[random.int(lengths.length)];
      const at = found.index + found[0].length - found[1].length;
      for (let d = 0; d < found[1].length; d++) out[at + d] = 48 + random.int(10);
    }
    return out;
  },
  keywords(bytes, random) {
    const text = latin1(bytes);
    const found = allOf(text, /\b(endobj|endstream|stream|obj|xref|trailer|\/Kids|\/Pages|\/Root|\/Type|\/Parent|\/Count)\b/g);
    const out = Uint8Array.from(bytes);
    if (found.length === 0) return MUTATIONS.bitFlips(bytes, random);
    const damaged = 1 + random.int(Math.min(found.length, 16));
    for (let i = 0; i < damaged; i++) {
      const hit = found[random.int(found.length)];
      out[hit.index + random.int(hit[0].length)] = 32 + random.int(90);
    }
    return out;
  },
  numbers(bytes, random) {
    // Counts, sizes and references, where a parser is most likely to trust what it reads.
    const text = latin1(bytes);
    const found = allOf(text, /(?<![\d.])\d{1,6}(?![\d.])/g);
    const out = Uint8Array.from(bytes);
    if (found.length === 0) return MUTATIONS.bitFlips(bytes, random);
    const damaged = 1 + random.int(Math.min(found.length, 32));
    for (let i = 0; i < damaged; i++) {
      const hit = found[random.int(found.length)];
      const value = random.int(2) ? "9" : "0";
      for (let d = 0; d < hit[0].length; d++) out[hit.index + d] = value.charCodeAt(0);
    }
    return out;
  },
};

export function mutate(bytes, seed) {
  const random = randomFrom(seed);
  const names = Object.keys(MUTATIONS);
  const name = names[random.int(names.length)];
  let out = MUTATIONS[name](bytes, random);
  if (random.int(4) === 0) out = MUTATIONS[names[random.int(names.length)]](out, random);
  return { name, bytes: out };
}
