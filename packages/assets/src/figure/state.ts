/**
 * Per-state image analysis (ingestion §6.2 steps 1-2): luminance, Otsu ink threshold clamped to
 * [96, 200], radius-1 closing, paper regions (4-connected non-ink components, raster-scan labels)
 * and the typical stroke width.
 */
import { label, type Labels } from "../cc.js";
import { luminanceOverWhite, type Raster } from "../raster.js";
import type { FigureState } from "./manifest.js";

export interface StateImage {
  readonly name: FigureState;
  readonly image: Raster;
  readonly W: number;
  readonly H: number;
  /** Luminance over white, 0..255. */
  readonly lum: Uint8Array;
  /** Ink threshold: ink is luminance below it. */
  readonly threshold: number;
  /** Raw ink (before closing). */
  readonly rawInk: Uint8Array;
  /** Ink after the radius-1 closing. */
  readonly ink: Uint8Array;
  /** Paper regions of the closed ink (4-connectivity). */
  readonly regions: Labels;
  /** Typical stroke width (median short ink run), 1..6. */
  readonly stroke: number;
  /** Background colour (border median, or the manifest's colour). */
  readonly background: readonly [number, number, number];
  readonly backgroundLum: number;
  /** Offset of this state's image inside its source file (manifest regions). */
  readonly origin: readonly [number, number];
}

/** Otsu threshold over a 256-bin histogram, clamped to [96, 200]; ink is `lum < threshold`. */
export function otsu(lum: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) hist[lum[i]!]!++;
  const total = lum.length;
  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * hist[v]!;
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let bestT = 128;
  for (let t = 0; t < 255; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t + 1;
    }
  }
  return Math.min(200, Math.max(96, bestT));
}

/** Radius-1 closing (3x3 dilation, then 3x3 erosion with the outside counted as ink, so closed ⊇ ink). */
export function close1(ink: Uint8Array, W: number, H: number): Uint8Array {
  const dil = new Uint8Array(W * H);
  const tmp = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      tmp[i] = ink[i]! | (x > 0 ? ink[i - 1]! : 0) | (x < W - 1 ? ink[i + 1]! : 0);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      dil[i] = tmp[i]! | (y > 0 ? tmp[i - W]! : 0) | (y < H - 1 ? tmp[i + W]! : 0);
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      tmp[i] = dil[i]! & (x > 0 ? dil[i - 1]! : 1) & (x < W - 1 ? dil[i + 1]! : 1);
    }
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      out[i] = (tmp[i]! & (y > 0 ? tmp[i - W]! : 1) & (y < H - 1 ? tmp[i + W]! : 1)) | ink[i]!;
    }
  }
  return out;
}

/** Median length of horizontal and vertical ink runs of at most 12 px (strokes, not fills), 1..6. */
export function strokeWidth(ink: Uint8Array, W: number, H: number): number {
  const hist = new Uint32Array(13);
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && ink[y * W + x]) run++;
      else {
        if (run > 0 && run <= 12) hist[run]!++;
        run = 0;
      }
    }
  }
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = 0; y <= H; y++) {
      if (y < H && ink[y * W + x]) run++;
      else {
        if (run > 0 && run <= 12) hist[run]!++;
        run = 0;
      }
    }
  }
  let n = 0;
  for (let v = 1; v <= 12; v++) n += hist[v]!;
  if (n === 0) return 2;
  let acc = 0;
  for (let v = 1; v <= 12; v++) {
    acc += hist[v]!;
    if (acc * 2 >= n) return Math.min(6, Math.max(1, v));
  }
  return 2;
}

/** Border median colour (per channel). */
export function borderMedian(r: Raster): [number, number, number] {
  const { width: w, height: h, data } = r;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  const add = (p: number): void => {
    n++;
    for (let c = 0; c < 3; c++) hist[c]![data[p * 4 + c]!]!++;
  };
  for (let x = 0; x < w; x++) {
    add(x);
    if (h > 1) add((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    add(y * w);
    if (w > 1) add(y * w + w - 1);
  }
  const med = (c: number): number => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[c]![v]!;
      if (acc * 2 >= n) return v;
    }
    return 255;
  };
  return [med(0), med(1), med(2)];
}

export const lumOf = (c: readonly [number, number, number]): number =>
  Math.round(0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);

export function analyzeState(
  name: FigureState,
  image: Raster,
  origin: readonly [number, number],
  background: readonly [number, number, number] | undefined,
): StateImage {
  const W = image.width;
  const H = image.height;
  const lum = luminanceOverWhite(image);
  const threshold = otsu(lum);
  const rawInk = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) rawInk[i] = lum[i]! < threshold ? 1 : 0;
  const ink = close1(rawInk, W, H);
  const regions = label(W, H, (i) => ink[i] === 0, 4);
  const bg = background ?? borderMedian(image);
  return {
    name,
    image,
    W,
    H,
    lum,
    threshold,
    rawInk,
    ink,
    regions,
    stroke: strokeWidth(ink, W, H),
    background: bg,
    backgroundLum: lumOf(bg),
    origin,
  };
}
