/**
 * Template matching (ingestion §5): masked normalized cross-correlation (NCC) of luminance, the
 * sprite's alpha as the weight mask; multi-scale; coarse search at 1/4 scale (alpha-weighted
 * block averages), refine ±4 px at full scale.
 *
 * Order of results: score (rounded to 1e-6, so scores that differ by float noise are one
 * "bucket"), then y, then x, then scale. It is NOT reading order: a lower-scoring instance that
 * sits higher on the page comes after a better-scoring one. Peaks are suppressed when the placed
 * sprite masks overlap with IoU > 0.5, so overlapping stacked twins survive while duplicates of
 * one instance (neighbouring positions, adjacent scales) collapse.
 *
 * Limits (ingestion §14): sizes and the multiply-add estimate are checked from the dimensions
 * before any scaled buffer is built (`asset/too-expensive`, `asset/too-large`); scales are
 * processed one at a time with typed arrays; no buffer exceeds 16 MP (64 MiB as Float32).
 * Small sprites (shorter side under 16 px) skip the coarse stage and are searched at full
 * resolution, which is exact but costs more on big images (use `region`).
 */
import type { Diagnostic } from "@platformcosmo/core";
import { bilinear, boxResample } from "./resample.js";
import {
  MAX_MULTIPLY_ADDS,
  MAX_PIXELS,
  badOption,
  bboxOf,
  checkRaster,
  err,
  luminance,
  luminanceOverWhite,
  warning,
  type OpResult,
  type Raster,
  type Rect,
} from "./raster.js";

export interface LocateOptions {
  /** The sprite must lie entirely inside this rectangle of the image; default the whole image. */
  readonly region?: Rect;
  /** Matches to return (default 3, at most 64). */
  readonly top?: number;
  /** Sprite scale factors tried (default 0.8, 0.9, 1, 1.1, 1.25; each in 0.25..4). */
  readonly scales?: readonly number[];
  /** Matches below this NCC are dropped (default 0.5; -1..1). */
  readonly minScore?: number;
  /** Multiply-add cap (default `MAX_MULTIPLY_ADDS`). */
  readonly maxMultiplyAdds?: number;
}

export interface Match {
  /** Top-left of the (scaled) sprite in the image. */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  /** Size of the sprite at this scale. */
  readonly width: number;
  readonly height: number;
  /** NCC in -1..1, rounded to 1e-6. */
  readonly score: number;
}

/** A sprite as `locate` matched it at one scale: the scaled raster and its mask (the alpha plane, 0..255). */
export interface ScaledSprite {
  readonly scale: number;
  readonly sprite: Raster;
  readonly mask: Uint8Array;
}

export interface LocateResult {
  readonly matches: readonly Match[];
  /** The scaled sprite and mask of every scale that appears in `matches`, ascending scale. */
  readonly sprites: readonly ScaledSprite[];
  /** Multiply-adds spent (coarse + refine; 3 per mask pixel and position). */
  readonly multiplyAdds: number;
  /** Of which refinement. */
  readonly refineMultiplyAdds: number;
  /** The up-front estimate the cap was checked against (an upper bound of `multiplyAdds`). */
  readonly estimate: number;
}

export const DEFAULT_SCALES: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25];
const REFINE = 4;
const COARSE = 4;
const MIN_COARSE_SIDE = 16;
const MACS_PER_PIXEL = 3;
const MASK_MIN_ALPHA = 3;
const IOU_LIMIT = 0.5;
const SHAPE_SAMPLES = 4096;
const MAX_SIDE = 65535;

const sizeAt = (sprite: Raster, k: number): [number, number] => [
  Math.max(1, Math.round(sprite.width * k)),
  Math.max(1, Math.round(sprite.height * k)),
];

/** Scales a sprite exactly as `locate` does (box filter below 1, bilinear above) and returns it with its mask. */
export function scaleSprite(sprite: Raster, k: number): OpResult<ScaledSprite> {
  const bad = checkRaster(sprite, "sprite");
  if (bad) return { diagnostics: [bad] };
  if (!(k >= 0.25 && k <= 4)) {
    return { diagnostics: [badOption("scale", "scale must be from 0.25 to 4")] };
  }
  const [nw, nh] = sizeAt(sprite, k);
  if (nw * nh > MAX_PIXELS) {
    return {
      diagnostics: [err("asset/too-large", `the sprite at scale ${k} would be ${nw}x${nh}`)],
    };
  }
  const sp = k === 1 ? sprite : k < 1 ? boxResample(sprite, nw, nh) : bilinear(sprite, nw, nh);
  const mask = new Uint8Array(nw * nh);
  for (let i = 0; i < mask.length; i++) mask[i] = sp.data[i * 4 + 3]!;
  return { value: { scale: k, sprite: sp, mask }, diagnostics: [] };
}

interface Template {
  readonly w: number;
  readonly h: number;
  /** Number of masked pixels. */
  readonly n: number;
  readonly dx: Uint16Array;
  readonly dy: Uint16Array;
  readonly wt: Float32Array;
  /** Mean-removed luminance of the masked pixels. */
  readonly tp: Float32Array;
  readonly sumW: number;
  readonly denT: number;
}

/** Weighted template from a luminance plane and a 0..255 weight plane; `undefined` when flat. */
function buildTemplate(
  lum: ArrayLike<number>,
  alpha: ArrayLike<number>,
  w: number,
  h: number,
): Template | undefined {
  let n = 0;
  for (let i = 0; i < w * h; i++) if (alpha[i]! >= MASK_MIN_ALPHA) n++;
  if (n === 0) return undefined;
  const dx = new Uint16Array(n);
  const dy = new Uint16Array(n);
  const wt = new Float32Array(n);
  const tp = new Float32Array(n);
  let sumW = 0;
  let sumWT = 0;
  let k = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = alpha[y * w + x]!;
      if (a < MASK_MIN_ALPHA) continue;
      const wv = a / 255;
      dx[k] = x;
      dy[k] = y;
      wt[k] = wv;
      tp[k] = lum[y * w + x]!;
      sumW += wv;
      sumWT += wv * lum[y * w + x]!;
      k++;
    }
  }
  const mt = sumWT / sumW;
  let denT = 0;
  for (let i = 0; i < n; i++) {
    tp[i] = tp[i]! - mt;
    denT += wt[i]! * tp[i]! * tp[i]!;
  }
  if (denT < 1e-6 * sumW) return undefined;
  return { w, h, n, dx, dy, wt, tp, sumW, denT };
}

/** NCC of the template placed at (px, py) of a luminance plane. */
function score(L: Float32Array, stride: number, t: Template, px: number, py: number): number {
  let ss = 0;
  let sss = 0;
  let sts = 0;
  for (let i = 0; i < t.n; i++) {
    const s = L[(py + t.dy[i]!) * stride + px + t.dx[i]!]!;
    const w = t.wt[i]!;
    ss += w * s;
    sss += w * s * s;
    sts += w * t.tp[i]! * s;
  }
  const varS = sss - (ss * ss) / t.sumW;
  if (varS <= 1e-6 * t.sumW) return 0;
  return sts / Math.sqrt(t.denT * varS);
}

/**
 * Masked NCC of `sprite` placed with its top-left at (x, y) of `image` (luminance over white for
 * the image, straight luminance for the sprite). `mask` (0..255 weights, `width * height`)
 * defaults to the sprite's alpha. `undefined` when the placement is outside the image or the
 * arguments are malformed; 0 when either side is flat under the mask.
 */
export function nccAt(
  image: Raster,
  sprite: Raster,
  x: number,
  y: number,
  mask?: Uint8Array,
): number | undefined {
  if (checkRaster(image) || checkRaster(sprite)) return undefined;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
  if (x < 0 || y < 0 || x + sprite.width > image.width || y + sprite.height > image.height) {
    return undefined;
  }
  if (sprite.width > MAX_SIDE || sprite.height > MAX_SIDE) return undefined;
  let weights: ArrayLike<number> | undefined = mask;
  if (weights && weights.length !== sprite.width * sprite.height) return undefined;
  if (!weights) {
    const a = new Uint8Array(sprite.width * sprite.height);
    for (let i = 0; i < a.length; i++) a[i] = sprite.data[i * 4 + 3]!;
    weights = a;
  }
  const t = buildTemplate(luminance(sprite), weights, sprite.width, sprite.height);
  if (!t) return 0;
  return q(score(Float32Array.from(luminanceOverWhite(image)), image.width, t, x, y));
}

/** Plain block average of a plane (integer factor, trailing partial blocks dropped). */
function blockAverage(src: ArrayLike<number>, w: number, h: number, f: number) {
  const cw = Math.floor(w / f);
  const ch = Math.floor(h / f);
  const data = new Float32Array(cw * ch);
  const inv = 1 / (f * f);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let s = 0;
      for (let y = 0; y < f; y++)
        for (let x = 0; x < f; x++) s += src[(cy * f + y) * w + cx * f + x]!;
      data[cy * cw + cx] = s * inv;
    }
  }
  return { data, w: cw, h: ch };
}

/** Alpha-weighted block average of sprite luminance, plus the mean alpha per block. */
function weightedBlocks(
  lum: ArrayLike<number>,
  alpha: ArrayLike<number>,
  w: number,
  h: number,
  f: number,
) {
  const cw = Math.floor(w / f);
  const ch = Math.floor(h / f);
  const cl = new Float32Array(cw * ch);
  const ca = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let sa = 0;
      let sl = 0;
      for (let y = 0; y < f; y++) {
        for (let x = 0; x < f; x++) {
          const i = (cy * f + y) * w + cx * f + x;
          sa += alpha[i]!;
          sl += alpha[i]! * lum[i]!;
        }
      }
      cl[cy * cw + cx] = sa > 0 ? sl / sa : 0;
      ca[cy * cw + cx] = sa / (f * f);
    }
  }
  return { cl, ca, w: cw, h: ch };
}

/** Mask footprint used to suppress overlapping placements (IoU of placed masks, sampled). */
interface Shape {
  readonly w: number;
  readonly h: number;
  readonly mask: Uint8Array;
  readonly n: number;
  readonly pts: Int32Array;
  readonly step: number;
}

function makeShape(alpha: ArrayLike<number>, w: number, h: number): Shape {
  const mask = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (alpha[i]! >= MASK_MIN_ALPHA) {
      mask[i] = 1;
      n++;
    }
  }
  const step = Math.max(1, Math.ceil(n / SHAPE_SAMPLES));
  const pts = new Int32Array(Math.ceil(n / step));
  let seen = 0;
  let k = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && seen++ % step === 0) pts[k++] = i;
  }
  return { w, h, mask, n, pts, step };
}

interface At {
  readonly x: number;
  readonly y: number;
}

/** Intersection-over-union of two placed shapes (intersection estimated from a fixed sample of `a`). */
function iou(a: Shape, pa: At, b: Shape, pb: At): number {
  if (pa.x >= pb.x + b.w || pb.x >= pa.x + a.w || pa.y >= pb.y + b.h || pb.y >= pa.y + a.h) {
    return 0;
  }
  let hit = 0;
  for (let i = 0; i < a.pts.length; i++) {
    const p = a.pts[i]!;
    const lx = (p % a.w) + pa.x - pb.x;
    const ly = Math.floor(p / a.w) + pa.y - pb.y;
    if (lx >= 0 && ly >= 0 && lx < b.w && ly < b.h && b.mask[ly * b.w + lx]) hit++;
  }
  const inter = Math.min(hit * a.step, a.n, b.n);
  const union = a.n + b.n - inter;
  return union > 0 ? inter / union : 0;
}

const q = (v: number): number => Math.round(v * 1e6) / 1e6;
interface Ranked {
  readonly score: number;
  readonly x: number;
  readonly y: number;
  readonly scale?: number;
}
const byRank = (a: Ranked, b: Ranked): number =>
  b.score - a.score || a.y - b.y || a.x - b.x || (a.scale ?? 1) - (b.scale ?? 1);

const tooExpensive = (estimate: number, cap: number, bbox: Rect): Diagnostic =>
  err(
    "asset/too-expensive",
    `matching needs about ${Math.round(estimate).toLocaleString("en-US")} multiply-adds, above the ${cap.toLocaleString("en-US")} limit`,
    {
      suggestion: "search a smaller --region, use fewer scales, or shrink the images",
      params: { estimate: Math.round(estimate), limit: cap, bbox: bboxOf(bbox) },
    },
  );

interface Peak {
  x: number;
  y: number;
  score: number;
}

export function locate(
  image: Raster,
  sprite: Raster,
  options: LocateOptions = {},
): OpResult<LocateResult> {
  const bad = checkRaster(image, "image") ?? checkRaster(sprite, "sprite");
  if (bad) return { diagnostics: [bad] };
  const top = options.top ?? 3;
  const minScore = options.minScore ?? 0.5;
  const cap = options.maxMultiplyAdds ?? MAX_MULTIPLY_ADDS;
  const scales = options.scales ?? DEFAULT_SCALES;
  if (!Number.isInteger(top) || top < 1 || top > 64) {
    return { diagnostics: [badOption("top", "top must be an integer from 1 to 64")] };
  }
  if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1) {
    return { diagnostics: [badOption("minScore", "minScore must be a number from -1 to 1")] };
  }
  if (!(cap > 0)) {
    return { diagnostics: [badOption("maxMultiplyAdds", "maxMultiplyAdds must be positive")] };
  }
  if (scales.length === 0 || scales.length > 16 || scales.some((s) => !(s >= 0.25 && s <= 4))) {
    return {
      diagnostics: [badOption("scales", "scales must be 1 to 16 numbers, each from 0.25 to 4")],
    };
  }
  const reg = options.region ?? { x: 0, y: 0, w: image.width, h: image.height };
  if (![reg.x, reg.y, reg.w, reg.h].every(Number.isInteger) || reg.w <= 0 || reg.h <= 0) {
    return {
      diagnostics: [badOption("region", "the region must be integers with positive size", reg)],
    };
  }
  if (sprite.width > MAX_SIDE || sprite.height > MAX_SIDE) {
    return { diagnostics: [err("asset/too-large", "the sprite is wider or taller than 65535 px")] };
  }
  const rx0 = Math.max(0, reg.x);
  const ry0 = Math.max(0, reg.y);
  const rx1 = Math.min(image.width, reg.x + reg.w);
  const ry1 = Math.min(image.height, reg.y + reg.h);
  const region: Rect = { x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 };
  const diagnostics: Diagnostic[] = [];
  if (rx1 <= rx0 || ry1 <= ry0) {
    return {
      diagnostics: [badOption("region", "the region lies outside the image", reg)],
    };
  }
  if (rx0 !== reg.x || ry0 !== reg.y || rx1 - rx0 !== reg.w || ry1 - ry0 !== reg.h) {
    diagnostics.push(
      warning("asset/rect-clamped", "the search region was clamped to the image", {
        bbox: bboxOf(region),
      }),
    );
  }

  // Plan from dimensions only: fit, then cost. Nothing scaled is allocated yet.
  const keep = top * 3 + 2;
  let nnz1 = 0;
  for (let i = 0; i < sprite.width * sprite.height; i++) {
    if (sprite.data[i * 4 + 3]! >= MASK_MIN_ALPHA) nnz1++;
  }
  interface Plan {
    readonly k: number;
    readonly w: number;
    readonly h: number;
    readonly f: number;
  }
  const plans: Plan[] = [];
  let estimate = 0;
  for (const k of [...new Set(scales)].sort((a, b) => a - b)) {
    const [w, h] = sizeAt(sprite, k);
    if (w > region.w || h > region.h || w > MAX_SIDE || h > MAX_SIDE) continue;
    if (w * h > MAX_PIXELS) continue;
    const f = Math.min(w, h) >= MIN_COARSE_SIDE ? COARSE : 1;
    const nnz = Math.min(w * h, 2 * Math.ceil(nnz1 * k * k) + 4 * (w + h));
    const nnzCoarse = f > 1 ? Math.min(nnz, Math.floor(w / f) * Math.floor(h / f)) : nnz;
    const positions =
      (Math.floor((rx1 - w) / f) - Math.ceil(rx0 / f) + 1) *
      (Math.floor((ry1 - h) / f) - Math.ceil(ry0 / f) + 1);
    if (positions <= 0) continue;
    estimate += MACS_PER_PIXEL * (positions * nnzCoarse + keep * (2 * REFINE + 1) ** 2 * nnz);
    plans.push({ k, w, h, f });
  }
  if (plans.length === 0) {
    return {
      diagnostics: [
        ...diagnostics,
        err("asset/not-found", "the sprite does not fit inside the search region at any scale", {
          params: { sprite: { w: sprite.width, h: sprite.height }, bbox: bboxOf(region) },
        }),
      ],
    };
  }
  if (estimate > cap) return { diagnostics: [...diagnostics, tooExpensive(estimate, cap, region)] };

  const L = Float32Array.from(luminanceOverWhite(image));
  let coarseL: { data: Float32Array; w: number } | undefined;
  let spent = 0;
  let refineSpent = 0;
  const found: Match[] = [];
  const shapes = new Map<number, Shape>();
  let searched = 0;
  let flats = 0;

  for (const p of plans) {
    const scaled = scaleSprite(sprite, p.k);
    if (!scaled.value) return { diagnostics: [...diagnostics, ...scaled.diagnostics] };
    const sp = scaled.value.sprite;
    const alpha = scaled.value.mask;
    const lum = luminance(sp);
    const full = buildTemplate(lum, alpha, sp.width, sp.height);
    if (!full) {
      flats++;
      diagnostics.push(
        warning("asset/flat", `the sprite has no texture under its mask at scale ${p.k}; skipped`, {
          scale: p.k,
        }),
      );
      continue;
    }
    let f = p.f;
    let coarse = full;
    let coarseAlpha: ArrayLike<number> = alpha;
    if (f > 1) {
      const wb = weightedBlocks(lum, alpha, sp.width, sp.height, f);
      const c = buildTemplate(wb.cl, wb.ca, wb.w, wb.h);
      if (c) {
        coarse = c;
        coarseAlpha = wb.ca;
      } else {
        f = 1;
      }
    }
    const x0 = Math.ceil(rx0 / f);
    const y0 = Math.ceil(ry0 / f);
    const x1 = Math.floor((rx1 - sp.width) / f);
    const y1 = Math.floor((ry1 - sp.height) / f);
    const mapW = x1 - x0 + 1;
    const mapH = y1 - y0 + 1;
    if (mapW <= 0 || mapH <= 0) continue;
    const coarseCost = MACS_PER_PIXEL * mapW * mapH * coarse.n;
    if (spent + coarseCost > cap) {
      return { diagnostics: [...diagnostics, tooExpensive(spent + coarseCost, cap, region)] };
    }
    searched++;
    let C: Float32Array = L;
    let cw = image.width;
    if (f > 1) {
      coarseL ??= (() => {
        const b = blockAverage(L, image.width, image.height, f);
        return { data: b.data, w: b.w };
      })();
      C = coarseL.data;
      cw = coarseL.w;
    }
    const map = new Float32Array(mapW * mapH);
    for (let cy = 0; cy < mapH; cy++) {
      for (let cx = 0; cx < mapW; cx++)
        map[cy * mapW + cx] = score(C, cw, coarse, x0 + cx, y0 + cy);
    }
    spent += coarseCost;

    // Local maxima, bounded top-K, then IoU suppression of the placed coarse masks.
    const floor = Math.max(-1, minScore - 0.5);
    const capK = Math.max(256, keep * 16);
    const cand: Peak[] = [];
    for (let cy = 0; cy < mapH; cy++) {
      for (let cx = 0; cx < mapW; cx++) {
        const s = map[cy * mapW + cx]!;
        if (s < floor) continue;
        if (cand.length >= capK && s <= cand[cand.length - 1]!.score) continue;
        let peak = true;
        for (let dy = -1; dy <= 1 && peak; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (
              (dx || dy) &&
              nx >= 0 &&
              ny >= 0 &&
              nx < mapW &&
              ny < mapH &&
              map[ny * mapW + nx]! > s
            ) {
              peak = false;
              break;
            }
          }
        }
        if (!peak) continue;
        const pk: Peak = { x: x0 + cx, y: y0 + cy, score: s };
        let lo = 0;
        let hi = cand.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (byRank(cand[mid]!, pk) <= 0) lo = mid + 1;
          else hi = mid;
        }
        cand.splice(lo, 0, pk);
        if (cand.length > capK) cand.pop();
      }
    }
    const cshape = makeShape(coarseAlpha, coarse.w, coarse.h);
    const picked: Peak[] = [];
    for (const c of cand) {
      if (picked.length >= keep) break;
      if (picked.every((a) => iou(cshape, c, cshape, a) <= IOU_LIMIT)) picked.push(c);
    }
    for (const c of picked) {
      let best: Peak | undefined;
      const bx = c.x * f;
      const by = c.y * f;
      for (let y = Math.max(ry0, by - REFINE); y <= Math.min(ry1 - full.h, by + REFINE); y++) {
        for (let x = Math.max(rx0, bx - REFINE); x <= Math.min(rx1 - full.w, bx + REFINE); x++) {
          const s = q(score(L, image.width, full, x, y));
          if (
            !best ||
            s > best.score ||
            (s === best.score && (y < best.y || (y === best.y && x < best.x)))
          ) {
            best = { x, y, score: s };
          }
        }
      }
      const rc = MACS_PER_PIXEL * (2 * REFINE + 1) ** 2 * full.n;
      spent += rc;
      refineSpent += rc;
      if (best && best.score >= minScore) {
        found.push({
          x: best.x,
          y: best.y,
          scale: p.k,
          width: full.w,
          height: full.h,
          score: best.score,
        });
      }
    }
    if (found.some((m) => m.scale === p.k)) shapes.set(p.k, makeShape(alpha, full.w, full.h));
  }

  if (searched === 0) {
    return {
      diagnostics: [
        ...diagnostics,
        ...(flats > 0
          ? [err("asset/flat", "the sprite has no texture under its mask, so it cannot be located")]
          : []),
      ],
    };
  }

  found.sort(byRank);
  const matches: Match[] = [];
  for (const m of found) {
    if (matches.length >= top) break;
    const sm = shapes.get(m.scale)!;
    if (matches.every((a) => iou(sm, m, shapes.get(a.scale)!, a) <= IOU_LIMIT)) matches.push(m);
  }
  const used: ScaledSprite[] = [];
  for (const k of [...new Set(matches.map((m) => m.scale))].sort((a, b) => a - b)) {
    const s = scaleSprite(sprite, k).value;
    if (s) used.push(s);
  }
  return {
    value: {
      matches,
      sprites: used,
      multiplyAdds: spent,
      refineMultiplyAdds: refineSpent,
      estimate,
    },
    diagnostics,
  };
}
