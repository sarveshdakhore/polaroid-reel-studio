import { SeededRNG } from "./prng";

export const VIDEO_W = 1080;
export const VIDEO_H = 1920;
export const VIDEO_FPS = 30;

export const STEP = 2.4; // seconds between photos
export const LIFE = 2.85; // each hero's active timeline
export const FLY = 0.42; // fly-in duration
export const SETTLE = 0.5; // toss onto pile duration
export const INTRO = 0.8;
export const OUTRO = 4.2;

export const EFFECTS = [
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

export type PolaroidEffect = (typeof EFFECTS)[number];

const SHADOW_PAD = 60;
const PAPER_RGB = [243 / 255, 240 / 255, 232 / 255] as const;
const INK_RGB = [0.16, 0.17, 0.3] as const;

export interface PolaroidCardAsset {
  W: number;
  H: number;
  paddedW: number;
  paddedH: number;
  box: [number, number, number, number]; // [side, top, iw, ih]
  wide: boolean;
  frameShadowCanvas: HTMLCanvasElement; // Padded RGBA canvas with drop shadow + paper + caption
  baseCanvas: HTMLCanvasElement; // Undeveloped milky blue-grey stage (iw x ih)
  ghostCanvas: HTMLCanvasElement; // Half-developed cyan-tinted ghost stage (iw x ih)
  finalCanvas: HTMLCanvasElement; // Fully graded instant-film photo (iw x ih)
  workCanvas: HTMLCanvasElement; // Reusable padded canvas for compose()
  lastKey: string;
}

export interface PhotoPlan {
  index: number;
  pol: PolaroidCardAsset;
  start: number;
  rot: number;
  rot0: number;
  from_xy: [number, number];
  pile_xy: [number, number];
  pile_rot: number;
  pile_scale: number;
  fx: PolaroidEffect;
}

function clamp(v: number, lo = 0, hi = 1): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function easeOut(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Separable 1D Gaussian / box blur on a single-channel Float32Array (w x h)
 */
function blurFloatChannel(
  src: Float32Array,
  w: number,
  h: number,
  radius: number
): Float32Array {
  if (radius <= 0.2) return new Float32Array(src);
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);

  // Build 1D Gaussian kernel
  const sigma = Math.max(0.5, radius);
  const kSize = r * 2 + 1;
  const kernel = new Float32Array(kSize);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const wgt = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + r] = wgt;
    sum += wgt;
  }
  for (let i = 0; i < kSize; i++) kernel[i] /= sum;

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.max(0, Math.min(w - 1, x + k));
        acc += src[row + xx] * kernel[k + r];
      }
      tmp[row + x] = acc;
    }
  }

  // Vertical pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.max(0, Math.min(h - 1, y + k));
        acc += tmp[yy * w + x] * kernel[k + r];
      }
      dst[y * w + x] = acc;
    }
  }

  return dst;
}

/**
 * Maps user graininess slider (0..100) to exact polaroid.py / render.py parameters:
 * - At 25% ("Less Grain"): printGrain = 0.008, bgFine = 0.03, filmGrain = 3.0
 * - At 75% ("High Grain"): printGrain = 0.022, bgFine = 0.08, filmGrain = 9.0
 */
export function getGrainParams(grainSlider: number) {
  const g = clamp(grainSlider, 0, 100);
  if (g === 0) {
    return { printGrain: 0, bgFine: 0, filmGrain: 0 };
  }
  // Piecewise linear interpolation anchored at 0%, 25% (LO), 75% (HI), 100%
  let printGrain: number;
  let bgFine: number;
  let filmGrain: number;

  if (g <= 25) {
    const t = g / 25;
    printGrain = 0.008 * t;
    bgFine = 0.03 * t;
    filmGrain = 3.0 * t;
  } else if (g <= 75) {
    const t = (g - 25) / 50;
    printGrain = 0.008 + (0.022 - 0.008) * t;
    bgFine = 0.03 + (0.08 - 0.03) * t;
    filmGrain = 3.0 + (9.0 - 3.0) * t;
  } else {
    const t = (g - 75) / 25;
    printGrain = 0.022 + (0.034 - 0.022) * t;
    bgFine = 0.08 + (0.12 - 0.08) * t;
    filmGrain = 9.0 + (14.5 - 9.0) * t;
  }

  return { printGrain, bgFine, filmGrain };
}

const shadowCache = new Map<string, HTMLCanvasElement>();

function getDropShadowCanvas(W: number, H: number): HTMLCanvasElement {
  const key = `${W}x${H}`;
  const cached = shadowCache.get(key);
  if (cached) return cached;

  const pw = W + 2 * SHADOW_PAD;
  const ph = H + 2 * SHADOW_PAD;
  const c = document.createElement("canvas");
  c.width = pw;
  c.height = ph;
  const ctx = c.getContext("2d")!;

  ctx.save();
  ctx.filter = "blur(22px)";
  ctx.fillStyle = `rgba(0, 0, 0, ${150 / 255})`;
  ctx.fillRect(SHADOW_PAD + 8, SHADOW_PAD + 18, W, H);
  ctx.restore();

  shadowCache.set(key, c);
  return c;
}

/**
 * Exact port of polaroid.py: build(idx, seed)
 * Grades the photo, builds the textured paper frame, writes the marker caption,
 * and pre-computes the undeveloped (base), ghost, and final stages.
 */
export function buildPolaroidCard(
  img: HTMLImageElement,
  caption: string,
  cropY: number,
  seed: number,
  grainSlider: number
): PolaroidCardAsset {
  const rng = new SeededRNG(seed);
  const { printGrain } = getGrainParams(grainSlider);

  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const wide = srcW > srcH;

  let W: number, side: number, top: number, bottom: number, iw: number, ih: number;
  if (wide) {
    W = 1000;
    side = 42;
    top = 46;
    bottom = 150;
    iw = W - 2 * side;
    ih = Math.floor(iw / 1.6);
  } else {
    W = 860;
    side = 44;
    top = 52;
    bottom = 215;
    iw = W - 2 * side;
    ih = iw;
  }
  const H = top + ih + bottom;

  // 1. Crop & resize image to (iw, ih)
  const ratio = iw / ih;
  let sx = 0,
    sy = 0,
    sw = srcW,
    sh = srcH;
  if (srcW / srcH > ratio) {
    sw = Math.floor(srcH * ratio);
    sx = Math.floor((srcW - sw) / 2);
  } else {
    sh = Math.floor(srcW / ratio);
    sy = Math.floor((srcH - sh) * clamp(cropY, 0, 1));
  }

  // Draw slightly softened image (1.2px instant film softness)
  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = iw;
  rawCanvas.height = ih;
  const rawCtx = rawCanvas.getContext("2d")!;
  rawCtx.filter = "blur(1.1px)";
  rawCtx.drawImage(img, sx, sy, sw, sh, 0, 0, iw, ih);
  rawCtx.filter = "none";

  const imgData = rawCtx.getImageData(0, 0, iw, ih);
  const px = imgData.data;

  // Compute highlight halation at 1/4 resolution for speed, blurred with equivalent radius
  const hw = Math.max(1, Math.floor(iw / 4));
  const hh = Math.max(1, Math.floor(ih / 4));
  const brightSmall = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    const sy0 = Math.min(ih - 1, y * 4);
    for (let x = 0; x < hw; x++) {
      const sx0 = Math.min(iw - 1, x * 4);
      const idx4 = (sy0 * iw + sx0) * 4;
      const mean = (px[idx4] + px[idx4 + 1] + px[idx4 + 2]) / (3 * 255);
      brightSmall[y * hw + x] = Math.max(0, mean - 0.65);
    }
  }
  const halSmall = blurFloatChannel(brightSmall, hw, hh, 3.5); // 3.5 * 4 = 14px

  // Edge chemistry coarse noise grid (ih/8 + 1) x (iw/8 + 1)
  const cw = Math.floor(iw / 8) + 1;
  const ch = Math.floor(ih / 8) + 1;
  const chemRaw = new Float32Array(cw * ch);
  for (let i = 0; i < chemRaw.length; i++) {
    chemRaw[i] = rng.standardNormal();
  }
  const chemGrid = blurFloatChannel(chemRaw, cw, ch, 3);

  // Optional corner light leak (45% chance)
  const hasCornerLeak = rng.next() < 0.45;
  let leakCx = 0,
    leakCy = 0,
    leakAmp = 0;
  if (hasCornerLeak) {
    leakCx = rng.next() < 0.5 ? 0 : iw;
    leakCy = rng.uniform(0, ih);
    leakAmp = rng.uniform(0.25, 0.45);
  }

  // Undeveloped base low-frequency cloud mottling (at 1/8 resolution)
  const bw = Math.floor(iw / 8) + 1;
  const bh = Math.floor(ih / 8) + 1;
  const baseNoiseRaw = new Float32Array(bw * bh);
  for (let i = 0; i < baseNoiseRaw.length; i++) {
    baseNoiseRaw[i] = rng.standardNormal();
  }
  const baseMottle = blurFloatChannel(baseNoiseRaw, bw, bh, 2.5);

  const finalData = new ImageData(iw, ih);
  const ghostData = new ImageData(iw, ih);
  const baseData = new ImageData(iw, ih);
  const fPx = finalData.data;
  const gPx = ghostData.data;
  const bPx = baseData.data;

  const invW = 1 / iw;
  const invH = 1 / ih;
  const leakScale = 1 / (iw * 0.7);

  for (let y = 0; y < ih; y++) {
    const dy = (y * invH - 0.5) * 2;
    const dy2 = dy * dy * 0.8;
    const absDy = Math.abs(dy);
    const hy = Math.min(hh - 1, y >> 2);
    const cyIdx = Math.min(ch - 1, y >> 3);
    const byIdx = Math.min(bh - 1, y >> 3);

    for (let x = 0; x < iw; x++) {
      const i4 = (y * iw + x) * 4;
      const dx = (x * invW - 0.5) * 2;
      const absDx = Math.abs(dx);

      let r = px[i4] / 255;
      let g = px[i4 + 1] / 255;
      let b = px[i4 + 2] / 255;

      // Highlight halation
      const hal = halSmall[hy * hw + Math.min(hw - 1, x >> 2)];
      if (hal > 0) {
        r += hal * 0.35;
        g += hal * 0.28;
        b += hal * 0.18;
      }

      // Soft S-curve + milky lifted blacks & rolled-off highlights
      r = clamp(0.5 + (r - 0.5) * 1.05, 0, 1);
      g = clamp(0.5 + (g - 0.5) * 1.05, 0, 1);
      b = clamp(0.5 + (b - 0.5) * 1.05, 0, 1);

      r = 0.1 + 0.82 * Math.pow(r, 0.92);
      g = 0.1 + 0.82 * Math.pow(g, 0.92);
      b = 0.1 + 0.82 * Math.pow(b, 0.92);

      // Muted saturation (0.76)
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum + (r - lum) * 0.76;
      g = lum + (g - lum) * 0.76;
      b = lum + (b - lum) * 0.76;

      // Split tone: teal-blue shadows, warm creamy highlights + overall warm cast
      const sh = clamp(1 - lum * 2, 0, 1);
      const hi = clamp(lum * 2 - 1, 0, 1);
      r = (r - 0.02 * sh + 0.06 * hi) * 1.03;
      g = (g + 0.025 * sh + 0.03 * hi) * 1.0;
      b = (b + 0.045 * sh - 0.045 * hi) * 0.93;

      // Vignette + uneven edge chemistry
      const rad = Math.sqrt(dx * dx * 0.8 + dy2);
      const vig = 1 - 0.38 * Math.pow(clamp(rad - 0.3, 0, 1), 1.6);
      r *= vig;
      g *= vig;
      b *= vig;

      const maxEdge = Math.max(absDx, absDy);
      if (maxEdge > 0.85) {
        const edge = clamp((maxEdge - 0.85) / 0.15, 0, 1);
        const chem = chemGrid[cyIdx * cw + Math.min(cw - 1, x >> 3)];
        const dChem = edge * chem * 0.09;
        r += dChem;
        g += dChem;
        b += dChem;
      }

      // Optional corner light leak
      if (hasCornerLeak) {
        const d =
          Math.hypot(x - leakCx, y - leakCy) * leakScale;
        if (d < 1) {
          const leak = Math.pow(1 - d, 2.2) * leakAmp;
          r = 1 - (1 - r) * (1 - leak * 1.0);
          g = 1 - (1 - g) * (1 - leak * 0.45);
          b = 1 - (1 - b) * (1 - leak * 0.15);
        }
      }

      // Print grain
      if (printGrain > 0) {
        const gn = rng.standardNormal() * printGrain;
        r += gn;
        g += gn;
        b += gn;
      }

      r = clamp(r, 0, 1);
      g = clamp(g, 0, 1);
      b = clamp(b, 0, 1);

      fPx[i4] = Math.round(r * 255);
      fPx[i4 + 1] = Math.round(g * 255);
      fPx[i4 + 2] = Math.round(b * 255);
      fPx[i4 + 3] = 255;

      // Ghost stage: 0.25 + finalLum * 0.55 * [0.85, 0.95, 1.05]
      const finalLum = 0.299 * r + 0.587 * g + 0.114 * b;
      const gR = clamp(0.25 + finalLum * 0.55 * 0.85, 0, 1);
      const gG = clamp(0.25 + finalLum * 0.55 * 0.95, 0, 1);
      const gB = clamp(0.25 + finalLum * 0.55 * 1.05, 0, 1);
      gPx[i4] = Math.round(gR * 255);
      gPx[i4 + 1] = Math.round(gG * 255);
      gPx[i4 + 2] = Math.round(gB * 255);
      gPx[i4 + 3] = 255;

      // Undeveloped base stage: [0.33, 0.38, 0.40] + mottled cloud noise
      const m = baseMottle[byIdx * bw + Math.min(bw - 1, x >> 3)] * 0.12;
      bPx[i4] = Math.round(clamp(0.33 + m, 0, 1) * 255);
      bPx[i4 + 1] = Math.round(clamp(0.38 + m, 0, 1) * 255);
      bPx[i4 + 2] = Math.round(clamp(0.4 + m, 0, 1) * 255);
      bPx[i4 + 3] = 255;
    }
  }

  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = iw;
  finalCanvas.height = ih;
  finalCanvas.getContext("2d")!.putImageData(finalData, 0, 0);

  const ghostCanvas = document.createElement("canvas");
  ghostCanvas.width = iw;
  ghostCanvas.height = ih;
  ghostCanvas.getContext("2d")!.putImageData(ghostData, 0, 0);

  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = iw;
  baseCanvas.height = ih;
  baseCanvas.getContext("2d")!.putImageData(baseData, 0, 0);

  // 2. Build Paper Frame + Smudges + Recessed Border + Handwritten Caption
  const paperData = new ImageData(W, H);
  const pPx = paperData.data;

  const numSmudges = rng.integers(0, 3);
  const smudges: { cx: number; cy: number; invR2: number }[] = [];
  for (let s = 0; s < numSmudges; s++) {
    const rad = rng.uniform(20, 60);
    smudges.push({
      cx: rng.uniform(0, W),
      cy: rng.uniform(H * 0.8, H),
      invR2: 1 / (rad * rad),
    });
  }

  for (let y = 0; y < H; y++) {
    const vGrad = 1 - 0.035 * (y / H);
    const inRecessY = y >= top - 2 && y < top + ih + 2;

    for (let x = 0; x < W; x++) {
      // Skip inner photo area (will be covered by base/ghost/final canvas)
      if (y >= top && y < top + ih && x >= side && x < side + iw) {
        const i4 = (y * W + x) * 4;
        pPx[i4 + 3] = 255;
        continue;
      }

      const n = rng.standardNormal() * 0.009;
      let r = PAPER_RGB[0] * vGrad + n;
      let g = PAPER_RGB[1] * vGrad + n;
      let b = PAPER_RGB[2] * vGrad + n;

      if (y >= H * 0.7) {
        for (let s = 0; s < smudges.length; s++) {
          const sm = smudges[s];
          const d2 = ((x - sm.cx) ** 2 + (y - sm.cy) ** 2) * sm.invR2;
          if (d2 < 4) {
            const drop = Math.exp(-d2) * 0.03;
            r -= drop;
            g -= drop;
            b -= drop;
          }
        }
      }

      // Recessed image edge: thin 2px darker line around photo window
      if (inRecessY && x >= side - 2 && x < side + iw + 2) {
        r *= 0.8;
        g *= 0.8;
        b *= 0.8;
      }

      const i4 = (y * W + x) * 4;
      pPx[i4] = Math.round(clamp(r, 0, 1) * 255);
      pPx[i4 + 1] = Math.round(clamp(g, 0, 1) * 255);
      pPx[i4 + 2] = Math.round(clamp(b, 0, 1) * 255);
      pPx[i4 + 3] = 255;
    }
  }

  const paperCanvas = document.createElement("canvas");
  paperCanvas.width = W;
  paperCanvas.height = H;
  const paperCtx = paperCanvas.getContext("2d")!;
  paperCtx.putImageData(paperData, 0, 0);

  // Handwritten marker caption in the bottom strip
  if (caption && caption.trim()) {
    const cleanText = caption.trim();
    const band = bottom;
    const y0 = top + ih;
    let fontSize = Math.max(Math.floor(band * 0.3), 54);
    const fontStack = `"Bradley Hand", "Caveat", "Patrick Hand", "Marker Felt", cursive`;

    paperCtx.save();
    paperCtx.font = `bold ${fontSize}px ${fontStack}`;
    while (paperCtx.measureText(cleanText).width > W * 0.8 && fontSize > 22) {
      fontSize -= 2;
      paperCtx.font = `bold ${fontSize}px ${fontStack}`;
    }

    const tx = W / 2 + rng.uniform(-20, 20);
    const ty = y0 + band * 0.5 + rng.uniform(-6, 6);
    const angleRad = (rng.uniform(-2.5, 2.5) * Math.PI) / 180;

    paperCtx.translate(tx, ty);
    paperCtx.rotate(angleRad);
    paperCtx.filter = "blur(0.5px)";
    paperCtx.textAlign = "center";
    paperCtx.textBaseline = "middle";
    const inkR = Math.round(INK_RGB[0] * 255);
    const inkG = Math.round(INK_RGB[1] * 255);
    const inkB = Math.round(INK_RGB[2] * 255);
    paperCtx.fillStyle = `rgba(${inkR}, ${inkG}, ${inkB}, ${225 / 255})`;
    paperCtx.fillText(cleanText, 0, 0);
    paperCtx.restore();
  }

  // Combine drop shadow + paper frame onto padded canvas
  const paddedW = W + 2 * SHADOW_PAD;
  const paddedH = H + 2 * SHADOW_PAD;
  const frameShadowCanvas = document.createElement("canvas");
  frameShadowCanvas.width = paddedW;
  frameShadowCanvas.height = paddedH;
  const fsCtx = frameShadowCanvas.getContext("2d")!;
  fsCtx.drawImage(getDropShadowCanvas(W, H), 0, 0);
  fsCtx.drawImage(paperCanvas, SHADOW_PAD, SHADOW_PAD);

  const workCanvas = document.createElement("canvas");
  workCanvas.width = paddedW;
  workCanvas.height = paddedH;

  return {
    W,
    H,
    paddedW,
    paddedH,
    box: [side, top, iw, ih],
    wide,
    frameShadowCanvas,
    baseCanvas,
    ghostCanvas,
    finalCanvas,
    workCanvas,
    lastKey: "",
  };
}

/**
 * Exact port of polaroid.py: compose(p, dev, burn) + with_shadow
 * Uses GPU-accelerated Canvas 2D alpha blending (mathematically identical to linear interpolation).
 */
export function composePolaroidCard(
  pol: PolaroidCardAsset,
  dev = 1.0,
  burn = 0.0
): HTMLCanvasElement {
  const key = `${Math.round(dev * 100)}_${Math.round(burn * 100)}`;
  if (pol.lastKey === key) {
    return pol.workCanvas;
  }

  const ctx = pol.workCanvas.getContext("2d")!;
  ctx.clearRect(0, 0, pol.paddedW, pol.paddedH);
  ctx.drawImage(pol.frameShadowCanvas, 0, 0);

  const [side, top, iw, ih] = pol.box;
  const dx = SHADOW_PAD + side;
  const dy = SHADOW_PAD + top;

  if (dev >= 1) {
    ctx.globalAlpha = 1;
    ctx.drawImage(pol.finalCanvas, dx, dy);
  } else if (dev < 0.5) {
    let t = clamp(dev / 0.5, 0, 1);
    t = t * t * (3 - 2 * t);
    ctx.globalAlpha = 1;
    ctx.drawImage(pol.baseCanvas, dx, dy);
    if (t > 0.001) {
      ctx.globalAlpha = t;
      ctx.drawImage(pol.ghostCanvas, dx, dy);
    }
  } else {
    let t = clamp((dev - 0.5) / 0.5, 0, 1);
    t = t * t * (3 - 2 * t);
    ctx.globalAlpha = 1;
    ctx.drawImage(pol.ghostCanvas, dx, dy);
    if (t > 0.001) {
      ctx.globalAlpha = t;
      ctx.drawImage(pol.finalCanvas, dx, dy);
    }
  }

  if (burn > 0.001) {
    ctx.globalAlpha = clamp(burn, 0, 1);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(dx, dy, iw, ih);
  }

  ctx.globalAlpha = 1;
  pol.lastKey = key;
  return pol.workCanvas;
}

/**
 * Exact port of render.py: manages the background table, pile state, camera motion,
 * light leaks, strobe/punch/burn/develop effects, and film grain.
 */
export class ReelRenderer {
  public readonly numPhotos: number;
  public readonly totalDuration: number;
  public readonly totalFrames: number;
  public readonly endPhotosTime: number;
  public readonly plans: PhotoPlan[] = [];

  private bgCanvas: HTMLCanvasElement;
  private vigCanvas: HTMLCanvasElement;
  private grainPosCanvases: HTMLCanvasElement[] = [];
  private grainNegCanvases: HTMLCanvasElement[] = [];
  private pileCanvas: HTMLCanvasElement;
  private stageCanvas: HTMLCanvasElement;
  private motionSubCanvas: HTMLCanvasElement;
  private settledIndices = new Set<number>();
  private lastRenderedTime = -1;

  constructor(cards: PolaroidCardAsset[], grainSlider: number) {
    this.numPhotos = cards.length;
    const N = Math.max(1, cards.length);
    this.endPhotosTime = INTRO + (N - 1) * STEP + LIFE;
    this.totalDuration = this.endPhotosTime + OUTRO;
    this.totalFrames = Math.floor(this.totalDuration * VIDEO_FPS);

    const rng = new SeededRNG(7);
    const { bgFine, filmGrain } = getGrainParams(grainSlider);

    // 1. Build static background table (make_bg in render.py)
    this.bgCanvas = this.createBackgroundCanvas(rng, bgFine);

    // 2. Build radial vignette overlay (VIG in render.py)
    this.vigCanvas = this.createVignetteCanvas();

    // 3. Build 8 film grain overlays (GRAIN in render.py)
    this.buildGrainCanvases(rng, filmGrain);

    // 4. Build pile slots & per-photo animation plans (render.py lines 66-93)
    const cols = 3;
    const rows = 5;
    const cells: [number, number][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push([c, r]);
      }
    }
    const rawSlots: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const [c, r] =
        i < cells.length ? cells[i % cells.length] : cells[rng.integers(0, cells.length)];
      const x = ((c + 0.5) / cols) * VIDEO_W + rng.uniform(-110, 110);
      const y = ((r + 0.5) / rows) * VIDEO_H + rng.uniform(-90, 90);
      rawSlots.push([x, y]);
    }
    const perm = rng.permutation(N);
    const pileSlots = perm.map((k) => rawSlots[k]);

    for (let i = 0; i < cards.length; i++) {
      const p = cards[i];
      const ang = rng.uniform(0, 2 * Math.PI);
      this.plans.push({
        index: i,
        pol: p,
        start: INTRO + i * STEP,
        rot: rng.uniform(-5, 5),
        rot0: rng.uniform(-35, 35),
        from_xy: [
          VIDEO_W / 2 + Math.cos(ang) * 1500,
          VIDEO_H / 2 + Math.sin(ang) * 1900,
        ],
        pile_xy: pileSlots[i],
        pile_rot: rng.uniform(-22, 22),
        pile_scale: p.wide ? 0.4 : 0.44,
        fx: i === 0 ? "develop" : EFFECTS[i % EFFECTS.length],
      });
    }

    this.pileCanvas = document.createElement("canvas");
    this.pileCanvas.width = VIDEO_W;
    this.pileCanvas.height = VIDEO_H;

    this.stageCanvas = document.createElement("canvas");
    this.stageCanvas.width = VIDEO_W;
    this.stageCanvas.height = VIDEO_H;

    this.motionSubCanvas = document.createElement("canvas");
    this.motionSubCanvas.width = VIDEO_W;
    this.motionSubCanvas.height = VIDEO_H;

    this.resetPile();
  }

  public resetPile(): void {
    const pCtx = this.pileCanvas.getContext("2d")!;
    pCtx.clearRect(0, 0, VIDEO_W, VIDEO_H);
    pCtx.drawImage(this.bgCanvas, 0, 0);
    this.settledIndices.clear();
    this.lastRenderedTime = -1;
  }

  private createBackgroundCanvas(rng: SeededRNG, bgFine: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = VIDEO_W;
    c.height = VIDEO_H;
    const ctx = c.getContext("2d")!;

    // Low-freq mottling at 1/8 resolution
    const lw = Math.floor(VIDEO_W / 8);
    const lh = Math.floor(VIDEO_H / 8);
    const loRaw = new Float32Array(lw * lh);
    for (let i = 0; i < loRaw.length; i++) {
      loRaw[i] = rng.standardNormal();
    }
    const loBlur = blurFloatChannel(loRaw, lw, lh, 9);

    const imgData = ctx.createImageData(VIDEO_W, VIDEO_H);
    const px = imgData.data;
    const baseR = 28 / 255;
    const baseG = 24 / 255;
    const baseB = 22 / 255;

    for (let y = 0; y < VIDEO_H; y++) {
      const ny = (y / VIDEO_H - 0.45) * 2;
      const ny2 = ny * ny * 0.6;
      const ly = Math.min(lh - 1, y >> 3);

      for (let x = 0; x < VIDEO_W; x++) {
        const nx = (x / VIDEO_W - 0.5) * 2;
        const r = Math.sqrt(nx * nx + ny2);
        const spot = 1.25 - 0.75 * Math.pow(clamp(r, 0, 1.2), 1.5);
        const lo = loBlur[ly * lw + Math.min(lw - 1, x >> 3)];
        const fine = bgFine > 0 ? rng.standardNormal() * bgFine * 0.65 : 0;
        const mod = (1 + lo * 1.1 + fine) * spot;

        const i4 = (y * VIDEO_W + x) * 4;
        px[i4] = Math.round(clamp(baseR * mod, 0, 1) * 255);
        px[i4 + 1] = Math.round(clamp(baseG * mod, 0, 1) * 255);
        px[i4 + 2] = Math.round(clamp(baseB * mod, 0, 1) * 255);
        px[i4 + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return c;
  }

  private createVignetteCanvas(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = VIDEO_W;
    c.height = VIDEO_H;
    const ctx = c.getContext("2d")!;
    const imgData = ctx.createImageData(VIDEO_W, VIDEO_H);
    const px = imgData.data;

    for (let y = 0; y < VIDEO_H; y++) {
      const dy = (y / VIDEO_H - 0.5) * 2;
      const dy2 = dy * dy * 0.5;
      for (let x = 0; x < VIDEO_W; x++) {
        const dx = (x / VIDEO_W - 0.5) * 2;
        const r = Math.sqrt(dx * dx * 0.7 + dy2);
        const darkAlpha = 0.45 * Math.pow(clamp(r - 0.3, 0, 1), 1.4);
        const i4 = (y * VIDEO_W + x) * 4;
        px[i4] = 0;
        px[i4 + 1] = 0;
        px[i4 + 2] = 0;
        px[i4 + 3] = Math.round(clamp(darkAlpha, 0, 1) * 255);
      }
    }
    ctx.putImageData(imgData, 0, 0);
    return c;
  }

  private buildGrainCanvases(rng: SeededRNG, filmGrain: number): void {
    this.grainPosCanvases = [];
    this.grainNegCanvases = [];
    if (filmGrain <= 0.05) return;

    const gw = VIDEO_W >> 1;
    const gh = VIDEO_H >> 1;

    for (let k = 0; k < 8; k++) {
      const posC = document.createElement("canvas");
      posC.width = gw;
      posC.height = gh;
      const posCtx = posC.getContext("2d")!;
      const posData = posCtx.createImageData(gw, gh);
      const posPx = posData.data;

      const negC = document.createElement("canvas");
      negC.width = gw;
      negC.height = gh;
      const negCtx = negC.getContext("2d")!;
      const negData = negCtx.createImageData(gw, gh);
      const negPx = negData.data;

      for (let i = 0; i < gw * gh; i++) {
        const val = rng.standardNormal() * filmGrain;
        const i4 = i * 4;
        if (val >= 0) {
          posPx[i4] = 255;
          posPx[i4 + 1] = 255;
          posPx[i4 + 2] = 255;
          posPx[i4 + 3] = Math.min(255, Math.round(val));
        } else {
          negPx[i4] = 0;
          negPx[i4 + 1] = 0;
          negPx[i4 + 2] = 0;
          negPx[i4 + 3] = Math.min(255, Math.round(-val * 1.4));
        }
      }

      posCtx.putImageData(posData, 0, 0);
      negCtx.putImageData(negData, 0, 0);
      this.grainPosCanvases.push(posC);
      this.grainNegCanvases.push(negC);
    }
  }

  private heroState(pl: PhotoPlan, lt: number) {
    const hx = VIDEO_W / 2;
    const hy = VIDEO_H * 0.47;
    let x: number, y: number, s: number, r: number;
    let dev = 1.0;
    let burn = 0.0;

    if (lt < FLY) {
      const t = clamp(lt / FLY, 0, 1);
      const e = easeOut(t);
      x = pl.from_xy[0] + (hx - pl.from_xy[0]) * e;
      y = pl.from_xy[1] + (hy - pl.from_xy[1]) * e;
      s = 1.35 - 0.35 * e;
      r = pl.rot0 + (pl.rot - pl.rot0) * e;
    } else if (lt < LIFE - SETTLE) {
      x = hx;
      y = hy;
      r = pl.rot;
      const k = lt - FLY;
      s = 1.0 + 0.05 * Math.exp(-k * 9) * Math.cos(k * 30); // landing wobble
      s += 0.035 * (k / (LIFE - SETTLE - FLY)); // slow push-in
      r += 0.8 * Math.sin(k * 1.3);
    } else {
      const t = easeInOut(clamp((lt - (LIFE - SETTLE)) / SETTLE, 0, 1));
      const s1 = 1.035;
      x = hx + (pl.pile_xy[0] - hx) * t;
      y = hy + (pl.pile_xy[1] - hy) * t;
      s = s1 + (pl.pile_scale - s1) * t;
      r = pl.rot + (pl.pile_rot - pl.rot) * t;
    }

    const k = lt - FLY;
    if (pl.fx === "develop") {
      dev = k < 0 ? 0.0 : Math.min(1.0, k / 1.3);
    } else if (pl.fx === "burn") {
      burn = k < 0 ? 1.0 : Math.pow(Math.max(0.0, 1 - k / 0.9), 1.5);
    } else {
      burn = k < 0 ? 0.0 : Math.max(0.0, 1 - k / 0.25) * 0.7;
    }

    return { x, y, s, r, dev, burn };
  }

  private placeCard(
    ctx: CanvasRenderingContext2D,
    cardCanvas: HTMLCanvasElement,
    x: number,
    y: number,
    s: number,
    rDeg: number,
    alpha = 1.0
  ) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    // PIL Image.rotate(r) rotates counter-clockwise for positive angles
    ctx.rotate((-rDeg * Math.PI) / 180);
    ctx.scale(s, s);
    ctx.drawImage(cardCanvas, -cardCanvas.width / 2, -cardCanvas.height / 2);
    ctx.restore();
  }

  /**
   * Renders frame `frameIndex` (at time `t = frameIndex / VIDEO_FPS`) onto `targetCanvas`.
   */
  public renderFrame(frameIndex: number, targetCanvas: HTMLCanvasElement): void {
    const t = frameIndex / VIDEO_FPS;

    // If scrubbing backwards in preview, rebuild pile up to current time
    if (t < this.lastRenderedTime) {
      this.resetPile();
    }
    this.lastRenderedTime = t;

    const pileCtx = this.pileCanvas.getContext("2d")!;
    for (let i = 0; i < this.plans.length; i++) {
      const pl = this.plans[i];
      if (!this.settledIndices.has(i) && t >= pl.start + LIFE) {
        const finalCard = composePolaroidCard(pl.pol, 1.0, 0.0);
        this.placeCard(
          pileCtx,
          finalCard,
          pl.pile_xy[0],
          pl.pile_xy[1],
          pl.pile_scale,
          pl.pile_rot
        );
        this.settledIndices.add(i);
      }
    }

    const active = this.plans.filter(
      (pl, i) => !this.settledIndices.has(i) && t >= pl.start
    );

    // Focus dimming of pile while a hero sits center-stage
    let dim = 0.0;
    for (const pl of active) {
      const lt = t - pl.start;
      const d =
        Math.min(1, lt / FLY) *
        (1 - easeInOut(clamp((lt - (LIFE - SETTLE)) / SETTLE, 0, 1)));
      if (d > dim) dim = d;
    }

    const stageCtx = this.stageCanvas.getContext("2d")!;
    stageCtx.clearRect(0, 0, VIDEO_W, VIDEO_H);
    stageCtx.drawImage(this.pileCanvas, 0, 0);
    if (dim > 0.01) {
      stageCtx.fillStyle = `rgba(0, 0, 0, ${0.5 * dim})`;
      stageCtx.fillRect(0, 0, VIDEO_W, VIDEO_H);
    }

    let flash = 0.0;
    let shake = 0.0;
    let punch = 0.0;
    let rgbSplit = 0.0;
    let leak: [number, number] | null = null;
    let strobeBlack = false;

    for (const pl of active) {
      const lt = t - pl.start;
      const { x, y, s, r, dev, burn } = this.heroState(pl, lt);
      const im = composePolaroidCard(pl.pol, dev, burn);

      if (lt < FLY * 0.9) {
        // Motion blur: blend 4 sub-frame positions
        for (let k = 3; k >= 0; k--) {
          const subState = this.heroState(pl, Math.max(0, lt - k * 0.012));
          this.placeCard(
            stageCtx,
            im,
            subState.x,
            subState.y,
            subState.s,
            subState.r,
            k === 0 ? 0.45 : 0.22
          );
        }
      } else {
        this.placeCard(stageCtx, im, x, y, s, r, 1.0);
      }

      const k = lt - FLY;
      if (k >= 0) {
        flash = Math.max(flash, Math.exp(-k * 9) * 0.85);
        shake = Math.max(shake, Math.exp(-k * 7) * 26);
        const fx = pl.fx;
        if (fx === "punch") {
          punch = Math.max(punch, Math.exp(-k * 6) * 0.13);
          rgbSplit = Math.max(rgbSplit, Math.exp(-k * 8) * 16);
        }
        if (fx === "strobe") {
          if (k > 0.1 && k < 0.36) {
            const ph = Math.floor((k - 0.1) / 0.065) % 2;
            if (ph === 0) {
              flash = Math.max(flash, 0.9);
            } else {
              strobeBlack = true;
            }
          }
          rgbSplit = Math.max(rgbSplit, Math.exp(-k * 6) * 10);
        }
        if (fx === "leak" && k < 1.2) {
          leak = [k / 1.2, pl.start];
        }
        if (fx === "burn") {
          shake = Math.max(shake, Math.exp(-k * 4) * 18);
        }
      }
    }

    // Intro: two flash pops on empty table
    if (t < INTRO) {
      for (const tp of [0.1, 0.35]) {
        if (t >= tp) {
          flash = Math.max(flash, Math.exp(-(t - tp) * 12) * 0.9);
        }
      }
    }

    // Outro: slow pull-back over the whole pile, flash burst, fade
    let zoom = 1.0 + 0.015 * Math.sin(t * 0.7);
    let rot = 0.6 * Math.sin(t * 0.45);
    let fade = 0.0;
    const END = this.endPhotosTime;

    if (t > END) {
      const o = t - END;
      zoom = 1.12 - 0.12 * easeInOut(Math.min(1, o / 2.4));
      rot = 0;
      for (let k = 0; k < 4; k++) {
        const tp = 2.6 + k * 0.12;
        if (o >= tp) {
          flash = Math.max(flash, Math.exp(-(o - tp) * 14) * 0.9);
        }
      }
      fade = clamp((o - 3.3) / 0.9, 0, 1);
    } else if (t > END - 1.2) {
      zoom += 0.12 * easeInOut((t - (END - 1.2)) / 1.2);
    }

    zoom += punch;
    const sx = shake * Math.sin(t * 91.0) + 1.2 * Math.sin(t * 13);
    const sy = shake * Math.cos(t * 77.0) + 1.2 * Math.cos(t * 11);
    const sr = rot + shake * 0.05 * Math.sin(t * 60);

    // Apply camera transform (zoom/rotate/shake around center) onto targetCanvas
    const outCtx = targetCanvas.getContext("2d")!;
    outCtx.save();
    outCtx.fillStyle = "#12100f";
    outCtx.fillRect(0, 0, VIDEO_W, VIDEO_H);

    outCtx.translate(VIDEO_W / 2 + sx, VIDEO_H / 2 + sy);
    outCtx.rotate((-sr * Math.PI) / 180);
    outCtx.scale(zoom, zoom);
    outCtx.translate(-VIDEO_W / 2, -VIDEO_H / 2);
    outCtx.drawImage(this.stageCanvas, 0, 0);
    outCtx.restore();

    // Chromatic aberration RGB split when punch/strobe triggers
    if (rgbSplit > 0.75) {
      const d = Math.round(rgbSplit);
      const subCtx = this.motionSubCanvas.getContext("2d")!;
      subCtx.clearRect(0, 0, VIDEO_W, VIDEO_H);
      subCtx.drawImage(targetCanvas, 0, 0);

      const imgData = subCtx.getImageData(0, 0, VIDEO_W, VIDEO_H);
      const src = new Uint8ClampedArray(imgData.data);
      const dst = imgData.data;
      for (let y = 0; y < VIDEO_H; y++) {
        const row = y * VIDEO_W;
        for (let x = 0; x < VIDEO_W; x++) {
          const rx = (x - d + VIDEO_W) % VIDEO_W;
          const bx = (x + d) % VIDEO_W;
          const idx = (row + x) * 4;
          dst[idx] = src[(row + rx) * 4]; // Red shifted +d
          dst[idx + 2] = src[(row + bx) * 4 + 2]; // Blue shifted -d
        }
      }
      outCtx.putImageData(imgData, 0, 0);
    }

    // Warm light-leak sweep (screen blend)
    if (leak !== null) {
      this.drawLightLeak(outCtx, leak[0], Math.floor(leak[1] * 10));
    }

    // Radial vignette
    outCtx.drawImage(this.vigCanvas, 0, 0);

    // Film grain overlay (controlled by grainSlider)
    if (this.grainPosCanvases.length > 0) {
      const gIdx = frameIndex % this.grainPosCanvases.length;
      outCtx.save();
      outCtx.globalCompositeOperation = "lighter";
      outCtx.drawImage(this.grainPosCanvases[gIdx], 0, 0, VIDEO_W, VIDEO_H);
      outCtx.globalCompositeOperation = "source-over";
      outCtx.drawImage(this.grainNegCanvases[gIdx], 0, 0, VIDEO_W, VIDEO_H);
      outCtx.restore();
    }

    // Camera flash pop
    if (flash > 0.002) {
      outCtx.fillStyle = `rgba(255, 255, 255, ${clamp(flash, 0, 1)})`;
      outCtx.fillRect(0, 0, VIDEO_W, VIDEO_H);
    }

    // Strobe black frame
    if (strobeBlack) {
      outCtx.fillStyle = "rgba(0, 0, 0, 0.92)";
      outCtx.fillRect(0, 0, VIDEO_W, VIDEO_H);
    }

    // Outro fade to black
    if (fade > 0.002) {
      outCtx.fillStyle = `rgba(0, 0, 0, ${clamp(fade, 0, 1)})`;
      outCtx.fillRect(0, 0, VIDEO_W, VIDEO_H);
    }
  }

  private drawLightLeak(
    ctx: CanvasRenderingContext2D,
    lt: number,
    seed: number
  ): void {
    const r = new SeededRNG(seed);
    const cx = (-0.3 + 1.6 * lt) * VIDEO_W;
    const cy = r.uniform(0.2, 0.8) * VIDEO_H;
    const sy = r.uniform(0.5, 1.0);
    const amp = Math.sin(Math.PI * clamp(lt, 0, 1)) * 0.85;
    if (amp <= 0.01) return;

    const col = seed % 2 !== 0 ? [255, 110, 40] : [255, 60, 70];
    const rx = VIDEO_W * 0.55;
    const ry = VIDEO_H * 0.45 * sy;

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.translate(cx, cy);
    ctx.scale(rx, ry);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${amp})`);
    grad.addColorStop(
      0.5,
      `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${amp * 0.35})`
    );
    grad.addColorStop(1, `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(-1.2, -1.2, 2.4, 2.4);
    ctx.restore();
  }
}
