/**
 * Template matching (ingestion §5): masked normalized cross-correlation of luminance (over
 * white), the sprite's alpha as a weight mask; multi-scale; coarse search at 1/4 scale, refine
 * ±4 px at full scale; results ordered score desc (to 1e-6), then y, then x, then scale, so twin
 * instances come out in a fixed order. `align` is the same matcher on a patch of one drawing.
 */
import type { Diagnostic } from "@platformcosmo/core";
import { boxResample, crop } from "./ops.js";
import {
  MAX_MULTIPLY_ADDS,
  checkRaster,
  err,
  luminanceOverWhite,
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
  /** Matches below this NCC are dropped (default 0.5). */
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

export interface LocateResult {
  readonly matches: readonly Match[];
  /** Multiply-adds actually spent (the cap's unit: 3 per mask pixel and position). */
  readonly multiplyAdds: number;
}

export const DEFAULT_SCALES: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25];
const REFINE = 4;
const COARSE = 4;
const MACS_PER_PIXEL = 3;

interface Template {
  readonly w: number;
  readonly h: number;
  /** Masked pixels: offsets, weights (alpha/255) and mean-removed luminance. */
  readonly dx: Int32Array;
  readonly dy: Int32Array;
  readonly wt: Float64Array;
  readonly tp: Float64Array;
  readonly sumW: number;
  readonly denT: number;
}

function buildTemplate(
  lum: ArrayLike<number>,
  alpha: ArrayLike<number>,
  w: number,
  h: number,
): Template | undefined {
  const dx: number[] = [];
  const dy: number[] = [];
  const wt: number[] = [];
  const t: number[] = [];
  let sumW = 0;
  let sumWT = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = alpha[y * w + x]! / 255;
      if (a <= 0.01) continue;
      dx.push(x);
      dy.push(y);
      wt.push(a);
      t.push(lum[y * w + x]!);
      sumW += a;
      sumWT += a * lum[y * w + x]!;
    }
  }
  if (sumW <= 0) return undefined;
  const mt = sumWT / sumW;
  const tp = Float64Array.from(t, (v) => v - mt);
  let denT = 0;
  for (let i = 0; i < tp.length; i++) denT += wt[i]! * tp[i]! * tp[i]!;
  if (denT < 1e-6 * sumW) return undefined;
  return {
    w,
    h,
    dx: Int32Array.from(dx),
    dy: Int32Array.from(dy),
    wt: Float64Array.from(wt),
    tp,
    sumW,
    denT,
  };
}

/** NCC of the template placed at (px, py) of a luminance plane. */
function score(L: Float32Array, stride: number, tpl: Template, px: number, py: number): number {
  let ss = 0;
  let sss = 0;
  let sts = 0;
  const n = tpl.wt.length;
  for (let i = 0; i < n; i++) {
    const s = L[(py + tpl.dy[i]!) * stride + px + tpl.dx[i]!]!;
    const w = tpl.wt[i]!;
    ss += w * s;
    sss += w * s * s;
    sts += w * tpl.tp[i]! * s;
  }
  const varS = sss - (ss * ss) / tpl.sumW;
  if (varS <= 1e-6 * tpl.sumW) return 0;
  return sts / Math.sqrt(tpl.denT * varS);
}

function blockAverage(
  src: ArrayLike<number>,
  w: number,
  h: number,
  f: number,
): { data: Float32Array; w: number; h: number } {
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

/** Bilinear upscale (used only for scales above 1). */
function bilinear(r: Raster, nw: number, nh: number): Raster {
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(r.height - 1, Math.max(0, ((y + 0.5) * r.height) / nh - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(r.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(r.width - 1, Math.max(0, ((x + 0.5) * r.width) / nw - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(r.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const v =
          r.data[(y0 * r.width + x0) * 4 + c]! * (1 - tx) * (1 - ty) +
          r.data[(y0 * r.width + x1) * 4 + c]! * tx * (1 - ty) +
          r.data[(y1 * r.width + x0) * 4 + c]! * (1 - tx) * ty +
          r.data[(y1 * r.width + x1) * 4 + c]! * tx * ty;
        out[(y * nw + x) * 4 + c] = Math.round(v);
      }
    }
  }
  return { width: nw, height: nh, data: out };
}

function scaled(sprite: Raster, k: number): Raster {
  if (k === 1) return sprite;
  const nw = Math.max(1, Math.round(sprite.width * k));
  const nh = Math.max(1, Math.round(sprite.height * k));
  return k < 1 ? boxResample(sprite, nw, nh) : bilinear(sprite, nw, nh);
}

const q = (v: number): number => Math.round(v * 1e6) / 1e6;
const byRank = (
  a: { score: number; x: number; y: number; scale?: number },
  b: { score: number; x: number; y: number; scale?: number },
): number => b.score - a.score || a.y - b.y || a.x - b.x || (a.scale ?? 1) - (b.scale ?? 1);

interface Plan {
  readonly scale: number;
  readonly sprite: Raster;
  readonly full: Template;
  readonly f: number;
  readonly coarse: Template;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly keep: number;
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
    return { diagnostics: [err("asset/bad-option", "top must be an integer from 1 to 64")] };
  }
  if (scales.length === 0 || scales.some((s) => !(s >= 0.25 && s <= 4))) {
    return {
      diagnostics: [err("asset/bad-option", "scales must be non-empty, each from 0.25 to 4")],
    };
  }
  const reg = options.region ?? { x: 0, y: 0, w: image.width, h: image.height };
  if (![reg.x, reg.y, reg.w, reg.h].every(Number.isInteger) || reg.w <= 0 || reg.h <= 0) {
    return {
      diagnostics: [err("asset/bad-rect", "the region must be integers with positive size")],
    };
  }
  const rx0 = Math.max(0, reg.x);
  const ry0 = Math.max(0, reg.y);
  const rx1 = Math.min(image.width, reg.x + reg.w);
  const ry1 = Math.min(image.height, reg.y + reg.h);

  const L = Float32Array.from(luminanceOverWhite(image));
  const keep = top * 3 + 2;
  const plans: Plan[] = [];
  const diagnostics: Diagnostic[] = [];
  let estimate = 0;
  for (const k of [...new Set(scales)].sort((a, b) => a - b)) {
    const sp = scaled(sprite, k);
    if (sp.width > rx1 - rx0 || sp.height > ry1 - ry0) continue;
    const lum = luminanceOverWhite(sp);
    const alpha = new Uint8Array(sp.width * sp.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = sp.data[i * 4 + 3]!;
    const full = buildTemplate(lum, alpha, sp.width, sp.height);
    if (!full) {
      diagnostics.push(
        err(
          "asset/locate-flat",
          "the sprite has no texture inside its mask, so it cannot be located",
        ),
      );
      return { diagnostics };
    }
    const f = Math.min(sp.width, sp.height) >= 4 * COARSE ? COARSE : 1;
    let coarse = full;
    if (f > 1) {
      const cl = blockAverage(lum, sp.width, sp.height, f);
      const ca = blockAverage(alpha, sp.width, sp.height, f);
      coarse = buildTemplate(cl.data, ca.data, cl.w, cl.h) ?? full;
    }
    const cf = coarse === full ? 1 : f;
    const x0 = Math.ceil(rx0 / cf);
    const y0 = Math.ceil(ry0 / cf);
    const x1 = Math.floor((rx1 - sp.width) / cf);
    const y1 = Math.floor((ry1 - sp.height) / cf);
    if (x1 < x0 || y1 < y0) continue;
    const positions = (x1 - x0 + 1) * (y1 - y0 + 1);
    estimate +=
      MACS_PER_PIXEL *
      (positions * coarse.wt.length + keep * (2 * REFINE + 1) * (2 * REFINE + 1) * full.wt.length);
    plans.push({ scale: k, sprite: sp, full, f: cf, coarse, x0, y0, x1, y1, keep });
  }
  if (plans.length === 0) {
    return {
      diagnostics: [
        err("asset/bad-rect", "the sprite does not fit inside the search region at any scale", {
          params: { sprite: [sprite.width, sprite.height], region: [rx1 - rx0, ry1 - ry0] },
        }),
      ],
    };
  }
  if (estimate > cap) {
    return {
      diagnostics: [
        err(
          "asset/too-expensive",
          `matching needs about ${Math.round(estimate).toLocaleString("en-US")} multiply-adds, above the ${cap.toLocaleString("en-US")} limit`,
          {
            suggestion: "search a smaller --region, use fewer scales, or shrink the images",
            params: { estimate: Math.round(estimate), limit: cap },
          },
        ),
      ],
    };
  }

  let spent = 0;
  const found: Match[] = [];
  for (const p of plans) {
    // Coarse plane (identity when f = 1).
    let C: Float32Array = L;
    let cw = image.width;
    if (p.f > 1) {
      const b = blockAverage(L, image.width, image.height, p.f);
      C = b.data;
      cw = b.w;
    }
    const cand: { x: number; y: number; score: number }[] = [];
    const floor = Math.max(-1, minScore - (p.f > 1 ? 0.25 : 0));
    for (let cy = p.y0; cy <= p.y1; cy++) {
      for (let cx = p.x0; cx <= p.x1; cx++) {
        const s = score(C, cw, p.coarse, cx, cy);
        if (s >= floor) cand.push({ x: cx, y: cy, score: q(s) });
      }
    }
    spent += MACS_PER_PIXEL * (p.x1 - p.x0 + 1) * (p.y1 - p.y0 + 1) * p.coarse.wt.length;
    cand.sort(byRank);
    const picked: typeof cand = [];
    const hx = Math.max(1, Math.floor(p.coarse.w / 2));
    const hy = Math.max(1, Math.floor(p.coarse.h / 2));
    for (const c of cand) {
      if (picked.length >= p.keep) break;
      if (picked.every((a) => Math.abs(a.x - c.x) >= hx || Math.abs(a.y - c.y) >= hy))
        picked.push(c);
    }
    for (const c of picked) {
      let best: { x: number; y: number; score: number } | undefined;
      const bx = c.x * p.f;
      const by = c.y * p.f;
      for (let y = Math.max(ry0, by - REFINE); y <= Math.min(ry1 - p.full.h, by + REFINE); y++) {
        for (let x = Math.max(rx0, bx - REFINE); x <= Math.min(rx1 - p.full.w, bx + REFINE); x++) {
          const s = q(score(L, image.width, p.full, x, y));
          if (
            !best ||
            s > best.score ||
            (s === best.score && (y < best.y || (y === best.y && x < best.x)))
          ) {
            best = { x, y, score: s };
          }
        }
      }
      spent += MACS_PER_PIXEL * (2 * REFINE + 1) * (2 * REFINE + 1) * p.full.wt.length;
      if (best && best.score >= minScore) {
        found.push({ ...best, scale: p.scale, width: p.full.w, height: p.full.h });
      }
    }
  }
  found.sort(byRank);
  const matches: Match[] = [];
  for (const m of found) {
    if (matches.length >= top) break;
    const clash = matches.some(
      (a) =>
        Math.abs(a.x - m.x) < Math.max(1, Math.floor(Math.min(a.width, m.width) / 2)) &&
        Math.abs(a.y - m.y) < Math.max(1, Math.floor(Math.min(a.height, m.height) / 2)),
    );
    if (!clash) matches.push(m);
  }
  return { value: { matches, multiplyAdds: spent }, diagnostics };
}

export interface AlignOptions {
  /** Patch of the first drawing to look for in the second; default: the best-textured patch. */
  readonly patch?: Rect;
  readonly minScore?: number;
  readonly maxMultiplyAdds?: number;
}

export interface Alignment {
  /** Translation of the content from `a` to `b` in pixels: a point (x, y) of `a` is at (x + dx, y + dy) in `b`. */
  readonly dx: number;
  readonly dy: number;
  readonly score: number;
  /** The patch of `a` that was matched. */
  readonly patch: Rect;
}

/**
 * Default patch: half the shorter side (8..192 px), on a half-patch grid inset by a quarter patch
 * from the border (so a shift of up to that much keeps it inside the second drawing), the position
 * whose weakest quadrant has the most luminance variance (so no part of the patch is flat); ties
 * go to the smaller y, then x.
 */
export function defaultPatch(a: Raster): Rect | undefined {
  const L = luminanceOverWhite(a);
  const ps = Math.max(8, Math.min(192, Math.floor(Math.min(a.width, a.height) / 2)));
  if (ps > a.width || ps > a.height) return undefined;
  const step = Math.max(1, Math.floor(ps / 2));
  const half = Math.floor(ps / 2);
  const variance = (x0: number, y0: number, w: number, h: number): number => {
    let s = 0;
    let ss = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const v = L[y * a.width + x]!;
        s += v;
        ss += v * v;
      }
    }
    const n = w * h;
    return ss / n - (s / n) ** 2;
  };
  let best: Rect | undefined;
  let bestV = -1;
  const m = Math.floor(ps / 4);
  const inset = a.width >= ps + 2 * m && a.height >= ps + 2 * m ? m : 0;
  for (let y = inset; y + ps + inset <= a.height; y += step) {
    for (let x = inset; x + ps + inset <= a.width; x += step) {
      const v = Math.min(
        variance(x, y, half, half),
        variance(x + half, y, ps - half, half),
        variance(x, y + half, half, ps - half),
        variance(x + half, y + half, ps - half, ps - half),
      );
      if (v > bestV) {
        bestV = v;
        best = { x, y, w: ps, h: ps };
      }
    }
  }
  return bestV >= 4 ? best : undefined;
}

/** Translation between two drawings of the same object by patch match (scale 1 only). */
export function align(a: Raster, b: Raster, options: AlignOptions = {}): OpResult<Alignment> {
  const bad = checkRaster(a, "first image") ?? checkRaster(b, "second image");
  if (bad) return { diagnostics: [bad] };
  const patch = options.patch ?? defaultPatch(a);
  if (!patch) {
    return {
      diagnostics: [
        err("asset/align-flat", "the first drawing has no textured patch to align on", {
          suggestion: "pass --patch",
        }),
      ],
    };
  }
  const cut = crop(a, patch);
  if (!cut.value) return { diagnostics: cut.diagnostics };
  const res = locate(b, cut.value, {
    scales: [1],
    top: 1,
    minScore: options.minScore ?? 0.3,
    ...(options.maxMultiplyAdds !== undefined ? { maxMultiplyAdds: options.maxMultiplyAdds } : {}),
  });
  if (!res.value) return { diagnostics: res.diagnostics };
  const m = res.value.matches[0];
  if (!m) {
    return {
      diagnostics: [
        ...res.diagnostics,
        err("asset/align-failed", "the patch was not found in the second drawing", {
          params: { patch: { ...patch } },
        }),
      ],
    };
  }
  const px = Math.max(0, patch.x);
  const py = Math.max(0, patch.y);
  return {
    value: {
      dx: m.x - px,
      dy: m.y - py,
      score: m.score,
      patch: { x: px, y: py, w: cut.value.width, h: cut.value.height },
    },
    diagnostics: [...res.diagnostics, ...cut.diagnostics],
  };
}
