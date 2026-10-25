/**
 * Deterministic Seeded PRNG (matches numpy default_rng behavior in polaroid.py / render.py)
 */
export class SeededRNG {
  private state: number;
  private spareNormal: number | null = null;

  constructor(seed: number) {
    this.state = (seed >>> 0) || 1;
    // Warm up state
    for (let i = 0; i < 4; i++) {
      this.next();
    }
  }

  /** Returns a float in [0, 1) using Mulberry32 */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max) */
  uniform(min = 0, max = 1): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max) */
  integers(min: number, max: number): number {
    return Math.floor(this.uniform(min, max));
  }

  /** Standard normal N(0, 1) via Box-Muller transform */
  standardNormal(): number {
    if (this.spareNormal !== null) {
      const val = this.spareNormal;
      this.spareNormal = null;
      return val;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    this.spareNormal = mag * Math.sin(2.0 * Math.PI * v);
    return mag * Math.cos(2.0 * Math.PI * v);
  }

  /** Pick one element from array */
  choice<T>(arr: readonly T[]): T {
    return arr[this.integers(0, arr.length)];
  }

  /** Fisher-Yates permutation of 0..n-1 */
  permutation(n: number): number[] {
    const arr = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = this.integers(0, i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}
