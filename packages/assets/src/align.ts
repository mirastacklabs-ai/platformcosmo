/**
 * Align (ingestion §5): the translation between two drawings of the same object, by matching
 * several textured patches of the first drawing in the second (the matcher of `locate`, scale 1)
 * and taking the consensus.
 */
import type { Diagnostic } from "@platformcosmo/core";
import { locate } from "./locate.js";
import { crop } from "./ops.js";
import {
  MAX_MULTIPLY_ADDS,
  badOption,
  bboxOf,
  checkRaster,
  err,
  luminanceOverWhite,
  warning,
  type OpResult,
  type Raster,
  type Rect,
} from "./raster.js";

export interface AlignOptions {
  /** Align on exactly this patch of the first drawing (no consensus). */
  readonly patch?: Rect;
  /** Search window in the second drawing = patch ± maxShift px (default: the whole drawing). */
  readonly maxShift?: number;
  /** Pixels of the first drawing that must not be used (moving parts): a `width * height` mask (nonzero = excluded) or rectangles. */
  readonly exclude?: Uint8Array | readonly Rect[];
  /** Patches tried for the consensus (default 3, at most 8). */
  readonly patches?: number;
  /** NCC below this is no match (default 0.5). */
  readonly minScore?: number;
  readonly maxMultiplyAdds?: number;
}

export interface Alignment {
  /** Translation of the content from `a` to `b`: a point (x, y) of `a` is at (x + dx, y + dy) in `b`. */
  readonly dx: number;
  readonly dy: number;
  /** NCC of the winning patch. */
  readonly score: number;
  /** Best score minus the second-best distinct position in the search window (or `minScore` when there is none): small means ambiguous. */
  readonly margin: number;
  /** Patches that agree with (dx, dy) within 1 px, of `tried` patches that were found in the second drawing. */
  readonly support: number;
  readonly tried: number;
  /** The winning patch of `a`. */
  readonly patch: Rect;
}

const MIN_VARIANCE = 4;
const MARGIN_WARN = 0.05;

function exclusionMask(a: Raster, ex: AlignOptions["exclude"]): Uint8Array | undefined {
  if (!ex) return undefined;
  if (ex instanceof Uint8Array) return ex.length === a.width * a.height ? ex : undefined;
  const m = new Uint8Array(a.width * a.height);
  for (const r of ex) {
    if (![r.x, r.y, r.w, r.h].every(Number.isInteger) || r.w <= 0 || r.h <= 0) return undefined;
    for (let y = Math.max(0, r.y); y < Math.min(a.height, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(a.width, r.x + r.w); x++) m[y * a.width + x] = 1;
    }
  }
  return m;
}

/**
 * Candidate patches of `a`: a third of the shorter side (8..192 px) on a half-patch grid inset by a
 * quarter patch from the border, at most 10% excluded pixels, ranked by the variance of the
 * weakest quadrant (no flat part) times a centrality factor (1 at the centre, 0.5 at a corner), so
 * central, textured patches come first; non-overlapping (under 25% of the area shared).
 */
function candidatePatches(a: Raster, excluded: Uint8Array | undefined, count: number): Rect[] {
  const L = luminanceOverWhite(a);
  const ps = Math.max(8, Math.min(192, Math.floor(Math.min(a.width, a.height) / 3)));
  if (ps > a.width || ps > a.height) return [];
  const step = Math.max(1, Math.floor(ps / 2));
  const half = Math.floor(ps / 2);
  const m = Math.floor(ps / 4);
  const inset = a.width >= ps + 2 * m && a.height >= ps + 2 * m ? m : 0;
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
    return ss / (w * h) - (s / (w * h)) ** 2;
  };
  const cx = a.width / 2;
  const cy = a.height / 2;
  const maxD = Math.hypot(cx, cy);
  const scored: { r: Rect; rank: number }[] = [];
  for (let y = inset; y + ps + inset <= a.height; y += step) {
    for (let x = inset; x + ps + inset <= a.width; x += step) {
      if (excluded) {
        let e = 0;
        for (let yy = y; yy < y + ps; yy++)
          for (let xx = x; xx < x + ps; xx++) e += excluded[yy * a.width + xx] ? 1 : 0;
        if (e > 0.1 * ps * ps) continue;
      }
      const v = Math.min(
        variance(x, y, half, half),
        variance(x + half, y, ps - half, half),
        variance(x, y + half, half, ps - half),
        variance(x + half, y + half, ps - half, ps - half),
      );
      if (v < MIN_VARIANCE) continue;
      const d = Math.hypot(x + ps / 2 - cx, y + ps / 2 - cy) / maxD;
      scored.push({ r: { x, y, w: ps, h: ps }, rank: v * (1 - 0.5 * d) });
    }
  }
  scored.sort((p, q) => q.rank - p.rank || p.r.y - q.r.y || p.r.x - q.r.x);
  const out: Rect[] = [];
  for (const s of scored) {
    if (out.length >= count) break;
    const clash = out.some((o) => {
      const ox = Math.max(0, Math.min(o.x + o.w, s.r.x + s.r.w) - Math.max(o.x, s.r.x));
      const oy = Math.max(0, Math.min(o.y + o.h, s.r.y + s.r.h) - Math.max(o.y, s.r.y));
      return ox * oy > 0.25 * ps * ps;
    });
    if (!clash) out.push(s.r);
  }
  return out;
}

interface Hit {
  readonly dx: number;
  readonly dy: number;
  readonly score: number;
  readonly margin: number;
  readonly patch: Rect;
}

/** Translation between two drawings: consensus of patch matches (scale 1 only). */
export function align(a: Raster, b: Raster, options: AlignOptions = {}): OpResult<Alignment> {
  const bad = checkRaster(a, "first image") ?? checkRaster(b, "second image");
  if (bad) return { diagnostics: [bad] };
  const minScore = options.minScore ?? 0.5;
  const count = options.patches ?? 3;
  const ms = options.maxShift;
  if (ms !== undefined && (!Number.isInteger(ms) || ms < 0)) {
    return { diagnostics: [badOption("maxShift", "maxShift must be a non-negative integer")] };
  }
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    return { diagnostics: [badOption("patches", "patches must be an integer from 1 to 8")] };
  }
  const excluded = exclusionMask(a, options.exclude);
  if (options.exclude && !excluded) {
    return {
      diagnostics: [
        badOption(
          "exclude",
          "exclude must be a width * height mask or rectangles of positive integers",
        ),
      ],
    };
  }
  const patches = options.patch ? [options.patch] : candidatePatches(a, excluded, count);
  if (patches.length === 0) {
    return {
      diagnostics: [
        err("asset/flat", "the first drawing has no textured patch to align on", {
          suggestion: "pass --patch",
        }),
      ],
    };
  }
  const diagnostics: Diagnostic[] = [];
  const hits: Hit[] = [];
  let failure: Diagnostic | undefined;
  const cap = options.maxMultiplyAdds ?? MAX_MULTIPLY_ADDS;
  let spent = 0;
  let budgetLeft = true;
  for (const p of patches) {
    const cut = crop(a, p);
    if (!cut.value) return { diagnostics: cut.diagnostics };
    const px = Math.max(0, p.x);
    const py = Math.max(0, p.y);
    let sprite: Raster = cut.value;
    if (excluded) {
      const data = new Uint8Array(sprite.data);
      for (let y = 0; y < sprite.height; y++) {
        for (let x = 0; x < sprite.width; x++) {
          if (excluded[(py + y) * a.width + px + x]) data[(y * sprite.width + x) * 4 + 3] = 0;
        }
      }
      sprite = { width: sprite.width, height: sprite.height, data };
    }
    const region: Rect | undefined =
      ms === undefined
        ? undefined
        : { x: px - ms, y: py - ms, w: sprite.width + 2 * ms, h: sprite.height + 2 * ms };
    // One align run shares one budget: each patch gets what the earlier ones left.
    const remaining = cap - spent;
    if (remaining <= 0) {
      budgetLeft = false;
      break;
    }
    // nmsIoU 1: only identical placements collapse, so the runner-up below is a real second peak.
    const res = locate(b, sprite, {
      scales: [1],
      top: 6,
      minScore,
      nmsIoU: 1,
      ...(region ? { region } : {}),
      maxMultiplyAdds: remaining,
    });
    const real = res.diagnostics.filter((d) => d.code !== "asset/rect-clamped");
    if (!res.value) {
      if (real.some((d) => d.code === "asset/too-expensive")) {
        budgetLeft = false;
        failure = real.find((d) => d.code === "asset/too-expensive");
        break;
      }
      failure = real[0];
      continue;
    }
    spent += res.value.multiplyAdds;
    const [m1] = res.value.matches;
    if (!m1) continue;
    // Runner-up: the best placement more than 1 px away from the winner.
    const m2 = res.value.matches.find(
      (m) => Math.max(Math.abs(m.x - m1.x), Math.abs(m.y - m1.y)) > 1,
    );
    hits.push({
      dx: m1.x - px,
      dy: m1.y - py,
      score: m1.score,
      margin: m1.score - (m2 ? m2.score : minScore),
      patch: { x: px, y: py, w: sprite.width, h: sprite.height },
    });
  }
  if (!budgetLeft && hits.length > 0) {
    diagnostics.push(
      warning("asset/too-expensive", "the matching budget ran out; fewer patches were tried", {
        tried: hits.length,
        limit: cap,
      }),
    );
  }
  if (hits.length === 0) {
    return {
      diagnostics: [
        failure ??
          err("asset/not-found", "no patch of the first drawing was found in the second", {
            params: { bbox: bboxOf(patches[0]!) },
          }),
      ],
    };
  }
  // Consensus: the most patches within 1 px of each other, then the highest summed score, then the first.
  let best = 0;
  let bestSupport = 0;
  let bestSum = -Infinity;
  hits.forEach((h, i) => {
    const group = hits.filter((o) => Math.abs(o.dx - h.dx) <= 1 && Math.abs(o.dy - h.dy) <= 1);
    const sum = group.reduce((s, o) => s + o.score, 0);
    if (group.length > bestSupport || (group.length === bestSupport && sum > bestSum + 1e-9)) {
      best = i;
      bestSupport = group.length;
      bestSum = sum;
    }
  });
  const win = hits[best]!;
  if (hits.length > 1 && bestSupport * 2 <= hits.length) {
    diagnostics.push(
      warning(
        "asset/ambiguous",
        `only ${bestSupport} of ${hits.length} patches agree on the shift (no majority)`,
        {
          bbox: bboxOf(win.patch),
        },
      ),
    );
  } else if (win.margin < MARGIN_WARN) {
    diagnostics.push(
      warning("asset/ambiguous", "the best position is barely better than another one", {
        margin: win.margin,
        bbox: bboxOf(win.patch),
      }),
    );
  }
  return {
    value: {
      dx: win.dx,
      dy: win.dy,
      score: win.score,
      margin: win.margin,
      support: bestSupport,
      tried: hits.length,
      patch: win.patch,
    },
    diagnostics,
  };
}
