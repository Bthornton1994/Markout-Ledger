/**
 * Seeded pseudo-random number generator (mulberry32).
 * Deterministic across platforms: uses only 32-bit integer arithmetic via Math.imul.
 * Used ONLY by the synthetic fixture generator. The engine itself is deterministic and RNG-free.
 */
export interface Rng {
  /** Uniform 32-bit unsigned integer. */
  nextU32(): number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number;
  /** Bernoulli trial with probability p. */
  chance(p: number): boolean;
  /** Approximately standard-normal variate (Irwin-Hall with 6 uniforms; bounded in [-3, 3]). */
  gauss(): number;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const nextU32 = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const next = (): number => nextU32() / 4294967296;
  return {
    nextU32,
    next,
    int: (lo, hi) => {
      if (hi < lo) throw new RangeError('int(lo, hi) requires hi >= lo');
      return lo + (nextU32() % (hi - lo + 1));
    },
    chance: (p) => next() < p,
    gauss: () => {
      let s = 0;
      for (let i = 0; i < 6; i++) s += next();
      return (s - 3) * 1.4142135623730951; // variance of sum of 6 U(0,1) is 0.5
    },
  };
}
