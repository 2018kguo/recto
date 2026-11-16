// The arithmetic behind every timed ratio: rounds are paired, one measurement of each engine per round taken
// back to back, so what the machine was doing that minute falls on both sides of the ratio.
//
// A row's ratio is another engine's value over recto's. Each round gives one paired ratio; the estimate is the
// Hodges-Lehmann one on their logarithms (the median of every pairwise mean) and the interval is the exact
// Wilcoxon signed-rank interval around it. Both are distribution-free and need no resampling, so the same rounds
// always give the same interval. A 95% interval needs at least 6 rounds.

/** P(T+ <= t) for the signed-rank statistic with n ranks, as an array over t. */
function signedRankCdf(n) {
  const max = (n * (n + 1)) / 2;
  let counts = new Float64Array(max + 1);
  counts[0] = 1;
  for (let rank = 1; rank <= n; rank++) {
    const next = new Float64Array(max + 1);
    for (let s = 0; s <= max; s++) {
      if (!counts[s]) continue;
      next[s] += counts[s];
      if (s + rank <= max) next[s + rank] += counts[s];
    }
    counts = next;
  }
  const total = 2 ** n;
  const cdf = new Float64Array(max + 1);
  let running = 0;
  for (let s = 0; s <= max; s++) cdf[s] = running += counts[s] / total;
  return cdf;
}

/**
 * How many Walsh averages to cut from each end for a two-sided interval of at least `level`, and the
 * level that cut actually gives; null below the rounds that can reach it (6 for 95%).
 */
export function signedRankCut(n, level = 0.95) {
  if (n < 1) return null;
  const cdf = signedRankCdf(n);
  const tail = (1 - level) / 2;
  let k = 0;
  while (k < cdf.length && cdf[k] <= tail) k++;
  // k Walsh averages are below the interval's lower end: P(T+ <= k - 1) <= tail.
  if (k === 0) return null;
  return { cut: k - 1, level: 1 - 2 * cdf[k - 1] };
}

const sorted = (values) => Float64Array.from(values).sort();
export const median = (values) => {
  const s = sorted(values);
  if (s.length === 0) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Every pairwise mean of `values`, itself included: the n(n+1)/2 Walsh averages, sorted. */
function walsh(values) {
  const out = [];
  for (let i = 0; i < values.length; i++) for (let j = i; j < values.length; j++) out.push((values[i] + values[j]) / 2);
  return sorted(out);
}

/**
 * The paired ratio of `other` over `base`, round by round (same index, same round). Returns the
 * Hodges-Lehmann estimate and its signed-rank interval, both as ratios, or null when a value isn't
 * positive (a ratio of it means nothing).
 */
export function pairedRatio(other, base, level = 0.95) {
  if (other.length !== base.length) throw new Error("paired samples differ in length");
  const n = other.length;
  if (n === 0 || other.some((v) => !(v > 0)) || base.some((v) => !(v > 0))) return null;
  const logs = other.map((v, i) => Math.log(v / base[i]));
  const averages = walsh(logs);
  const ratio = Math.exp(median(averages));
  const cut = signedRankCut(n, level);
  if (!cut) return { ratio, interval: null, level: null, rounds: n };
  return {
    ratio,
    interval: [Math.exp(averages[cut.cut]), Math.exp(averages[averages.length - 1 - cut.cut])],
    level: cut.level,
    rounds: n,
  };
}

/**
 * Whether a row needs no more rounds: its interval leaves out 1 (the engines differ, and which is ahead is
 * settled), or it is within `tolerance` of its estimate on both sides (whatever the answer, more rounds
 * wouldn't move it far).
 */
export function decided(paired, tolerance = 0.05) {
  if (!paired?.interval) return false;
  const [lo, hi] = paired.interval;
  if (lo > 1 || hi < 1) return true;
  return hi / paired.ratio <= 1 + tolerance && paired.ratio / lo <= 1 + tolerance;
}

/** What a row says: "ahead" (the other engine is slower or larger), "behind", or "level". */
export function verdict(paired) {
  if (!paired?.interval) return null;
  const [lo, hi] = paired.interval;
  return lo > 1 ? "ahead" : hi < 1 ? "behind" : "level";
}

/** xorshift32, so a shuffle or a resample is the same on a rerun. */
export function seeded(seed = 1) {
  let s = seed | 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

/**
 * The old method, kept to compare against: the ratio of medians of unpaired samples, with a 95% interval
 * bootstrapped by resampling each side on its own.
 */
export function unpairedRatio(other, base, { draws = 2000, random = seeded(7) } = {}) {
  if (other.length === 0 || base.length === 0) return null;
  if (!(median(base) > 0)) return null;
  const pick = (values) => median(Array.from(values, () => values[Math.floor(random() * values.length)]));
  const ratios = sorted(Array.from({ length: draws }, () => pick(other) / pick(base)));
  return {
    ratio: median(other) / median(base),
    interval: [ratios[Math.floor(draws * 0.025)], ratios[Math.floor(draws * 0.975)]],
    level: 0.95,
    rounds: Math.min(other.length, base.length),
  };
}

/** A fair order for the engines in one round: shuffled, so no engine always follows another. */
export function shuffled(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * One row for one engine against recto, as the results files keep it: the paired ratio and its interval,
 * and the old unpaired ratio and interval beside them, for comparison.
 */
export function compareRow(mine, recto) {
  const paired = pairedRatio(mine, recto);
  const unpaired = unpairedRatio(mine, recto);
  return {
    ratio: paired ? round2(paired.ratio) : unpaired ? round2(unpaired.ratio) : null,
    interval: paired?.interval?.map(round2) ?? null,
    level: paired?.level ? round2(paired.level) : null,
    verdict: verdict(paired),
    unpaired: unpaired ? { ratio: round2(unpaired.ratio), interval: unpaired.interval.map(round2) } : null,
  };
}
