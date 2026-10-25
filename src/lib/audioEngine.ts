import { SeededRNG } from "./prng";

export const AUDIO_SR = 44100;

const STEP = 2.4;
const LIFE = 2.85;
const FLY = 0.42;
const INTRO = 0.8;
const OUTRO = 4.2;
const EFFECTS = [
  "develop",
  "punch",
  "leak",
  "develop",
  "strobe",
  "burn",
  "punch",
  "develop",
  "leak",
  "strobe",
] as const;

/**
 * In-place Radix-2 Cooley-Tukey FFT / IFFT
 */
function fftRadix2(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function nextPow2(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

/**
 * Exact port of bandnoise(n, lo, hi) from render.py
 */
function bandnoise(rng: SeededRNG, n: number, lo: number, hi: number): Float32Array {
  const N = nextPow2(n);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < n; i++) {
    re[i] = rng.standardNormal();
  }
  fftRadix2(re, im, false);

  const df = AUDIO_SR / N;
  const half = N >> 1;
  for (let k = 0; k <= half; k++) {
    const freq = k * df;
    if (freq < lo || freq > hi) {
      re[k] = 0;
      im[k] = 0;
      if (k > 0 && k < half) {
        re[N - k] = 0;
        im[N - k] = 0;
      }
    }
  }

  fftRadix2(re, im, true);

  const out = new Float32Array(n);
  let maxAbs = 1e-9;
  for (let i = 0; i < n; i++) {
    const v = re[i];
    out[i] = v;
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  for (let i = 0; i < n; i++) {
    out[i] /= maxAbs;
  }
  return out;
}

function makeClick(rng: SeededRNG): Float32Array {
  const n = Math.floor(0.16 * AUDIO_SR);
  const out = new Float32Array(n);
  const pulses: [number, number][] = [
    [0, 1.0],
    [Math.floor(0.055 * AUDIO_SR), 0.7],
  ];
  const m = Math.floor(0.03 * AUDIO_SR);

  for (const [off, amp] of pulses) {
    const bn = bandnoise(rng, m, 1500, 9000);
    for (let k = 0; k < m && off + k < n; k++) {
      const e = Math.exp(-k / (0.004 * AUDIO_SR));
      const body =
        Math.sin((2 * Math.PI * 180 * k) / AUDIO_SR) *
        Math.exp(-k / (0.006 * AUDIO_SR)) *
        0.4 *
        amp;
      out[off + k] += bn[k] * e * amp + body;
    }
  }
  for (let i = 0; i < n; i++) {
    out[i] *= 0.55;
  }
  return out;
}

function makeWhoosh(rng: SeededRNG): Float32Array {
  const n = Math.floor(0.45 * AUDIO_SR);
  const bn = bandnoise(rng, n, 300, 3500);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tt = i / n;
    const env = Math.pow(Math.sin(Math.PI * Math.pow(tt, 0.7)), 2);
    out[i] = bn[i] * env * 0.22;
  }
  return out;
}

function makeEject(rng: SeededRNG): Float32Array {
  const n = Math.floor(0.55 * AUDIO_SR);
  const bn = bandnoise(rng, n, 800, 4000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tt = i / AUDIO_SR;
    const s95 = Math.sin(2 * Math.PI * 95 * tt);
    const tone =
      (s95 >= 0 ? 1 : -1) * 0.25 + Math.sin(2 * Math.PI * 190 * tt) * 0.3;
    const env =
      Math.max(0, Math.min(1, tt / 0.05)) *
      Math.max(0, Math.min(1, (0.55 - tt) / 0.08));
    out[i] = (tone + bn[i] * 0.35) * env * 0.12;
  }
  return out;
}

/**
 * Synthesizes the complete mono PCM soundtrack matching render.py
 */
export function synthesizeReelAudio(numPhotos: number): {
  pcm: Float32Array;
  duration: number;
  sampleRate: number;
} {
  const N = Math.max(1, numPhotos);
  const END = INTRO + (N - 1) * STEP + LIFE;
  const TOTAL = END + OUTRO;
  const totalSamples = Math.floor(TOTAL * AUDIO_SR);
  const audio = new Float32Array(totalSamples + AUDIO_SR);
  const ar = new SeededRNG(3);

  type CueKind = "click" | "whoosh" | "eject";
  const cues: [number, CueKind][] = [];

  for (let i = 0; i < N; i++) {
    const start = INTRO + i * STEP;
    const fx = i === 0 ? "develop" : EFFECTS[i % EFFECTS.length];
    cues.push([start + 0.02, "whoosh"]);
    cues.push([start + FLY, "click"]);
    if (fx === "strobe") {
      cues.push([start + FLY + 0.13, "click"]);
      cues.push([start + FLY + 0.26, "click"]);
    }
    if (fx === "develop") {
      cues.push([start + FLY + 0.15, "eject"]);
    }
  }

  cues.push([0.1, "click"], [0.35, "click"]);
  for (let k = 0; k < 4; k++) {
    cues.push([END + 2.6 + k * 0.12, "click"]);
  }

  for (const [tc, kind] of cues) {
    let s: Float32Array;
    if (kind === "click") s = makeClick(ar);
    else if (kind === "whoosh") s = makeWhoosh(ar);
    else s = makeEject(ar);

    const i0 = Math.floor(tc * AUDIO_SR);
    if (i0 < 0 || i0 >= audio.length) continue;
    const limit = Math.min(s.length, audio.length - i0);
    for (let k = 0; k < limit; k++) {
      audio[i0 + k] += s[k];
    }
  }

  const out = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const v = Math.max(-1, Math.min(1, audio[i])) * 0.9;
    out[i] = v;
  }

  return {
    pcm: out,
    duration: TOTAL,
    sampleRate: AUDIO_SR,
  };
}
