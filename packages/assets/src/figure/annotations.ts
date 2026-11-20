/**
 * Annotation geometry (ingestion §6.5 rule 3): measured band of each arrow and leader polyline,
 * arrowhead detection, contact allowances, and the annotation masks that are erased from the
 * base and excluded from the gate's comparisons.
 */
import type { Annotation, FigureState } from "./manifest.js";
import { blank, capsules, dilate, rectMask, union, type Box, type Mask } from "./mask.js";

/** Samples every 2 px along a polyline. */
const STEP = 2;
/** Longest perpendicular walk on each side of a sample. */
const MAX_WALK = 32;

export interface Sample {
  readonly x: number;
  readonly y: number;
  /** Unit normal. */
  readonly nx: number;
  readonly ny: number;
  readonly ux: number;
  readonly uy: number;
  /** Arc length from the polyline's first point. */
  readonly s: number;
  /** Contiguous ink run through the sample along the normal (0 = not on ink). */
  readonly run: number;
  /** Offsets along the normal of the run's ends (inclusive). */
  readonly lo: number;
  readonly hi: number;
}

export interface AnnotationGeometry {
  readonly index: number;
  readonly kind: Annotation["kind"];
  readonly state: FigureState;
  /** Points in the state image's pixels. */
  readonly points: readonly (readonly [number, number])[];
  readonly rect?: Box;
  readonly samples: readonly Sample[];
  readonly medianRun: number;
  readonly onInk: number;
  /** Measured band half-width, (median run + 2) / 2. */
  readonly halfWidth: number;
  /** End index (0 = first point, 1 = last) of the detected arrowhead. */
  readonly head?: 0 | 1;
  /** The measured band (polylines) or the rectangle (text). */
  readonly band: Mask;
  /** The annotation mask: band (or rect) dilated by 2 px. */
  readonly mask: Mask;
  /** Contact allowance squares (at most 2: the polyline's ends). */
  readonly allowances: readonly Box[];
  /** Geometry-level problems (each becomes an `asset/annotation-invalid`). */
  readonly problems: string[];
}

export function polylineLength(pts: readonly (readonly [number, number])[]): number {
  let L = 0;
  for (let k = 1; k < pts.length; k++)
    L += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
  return L;
}

function samplePolyline(
  pts: readonly (readonly [number, number])[],
): { x: number; y: number; ux: number; uy: number; s: number }[] {
  const out: { x: number; y: number; ux: number; uy: number; s: number }[] = [];
  let s0 = 0;
  let next = 0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1]!;
    const [bx, by] = pts[k]!;
    const L = Math.hypot(bx - ax, by - ay);
    if (L === 0) continue;
    const ux = (bx - ax) / L;
    const uy = (by - ay) / L;
    while (next <= s0 + L + 1e-9) {
      const t = next - s0;
      out.push({ x: ax + ux * t, y: ay + uy * t, ux, uy, s: next });
      next += STEP;
    }
    s0 += L;
  }
  const last = out[out.length - 1];
  if (pts.length >= 2 && (!last || s0 - last.s > 1e-6)) {
    const [ax, ay] = pts[pts.length - 2]!;
    const [bx, by] = pts[pts.length - 1]!;
    const L = Math.hypot(bx - ax, by - ay) || 1;
    out.push({ x: bx, y: by, ux: (bx - ax) / L, uy: (by - ay) / L, s: s0 });
  }
  return out;
}

function measure(
  ink: Uint8Array,
  W: number,
  H: number,
  p: { x: number; y: number; ux: number; uy: number; s: number },
): Sample {
  const nx = -p.uy;
  const ny = p.ux;
  const at = (k: number): boolean => {
    const x = Math.round(p.x + k * nx);
    const y = Math.round(p.y + k * ny);
    return x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x] !== 0;
  };
  let k0: number | undefined;
  for (const k of [0, 1, -1, 2, -2]) {
    if (at(k)) {
      k0 = k;
      break;
    }
  }
  if (k0 === undefined) return { ...p, nx, ny, run: 0, lo: 0, hi: 0 };
  let hi = k0;
  while (hi - k0 < MAX_WALK && at(hi + 1)) hi++;
  let lo = k0;
  while (k0 - lo < MAX_WALK && at(lo - 1)) lo--;
  return { ...p, nx, ny, run: hi - lo + 1, lo, hi };
}

function median(v: readonly number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1]!;
}

/**
 * Arrowhead at one end: within the last 3w px the run widens to at least 2x the median run and
 * narrows again toward the tip (a filled wedge; an open wedge closes into one under the radius-1
 * closing when its arms are at most 2 px apart near the tip, and otherwise is measured by its
 * span: the outermost ink along the normal within 3w).
 */
function hasHead(
  samples: readonly Sample[],
  end: 0 | 1,
  med: number,
  w: number,
  span: (s: Sample, lim: number) => number,
): boolean {
  if (med <= 0) return false;
  const total = samples[samples.length - 1]?.s ?? 0;
  const win = samples
    .filter((s) => (end === 0 ? s.s : total - s.s) <= 3 * w + 1e-9)
    .sort((a, b) => (end === 0 ? a.s - b.s : b.s - a.s));
  for (const profile of [(s: Sample) => s.run, (s: Sample) => span(s, Math.ceil(3 * w))]) {
    const p = win.map(profile);
    let imax = -1;
    for (let i = 0; i < p.length; i++) if (imax < 0 || p[i]! > p[imax]!) imax = i;
    if (imax <= 0 || p[imax]! < 2 * med) continue;
    const narrow = Math.max(med, p[imax]! / 2);
    for (let j = 0; j < imax; j++) if (p[j]! <= narrow) return true;
  }
  return false;
}

export interface AnnotationInput {
  readonly index: number;
  readonly annotation: Annotation;
  /** Points or rect already translated into the state image. */
  readonly points?: readonly (readonly [number, number])[];
  readonly rect?: Box;
}

/** Geometry of one annotation in its declared state (`ink` = that state's closed ink). */
export function annotationGeometry(
  input: AnnotationInput,
  ink: Uint8Array,
  W: number,
  H: number,
): AnnotationGeometry {
  const a = input.annotation;
  const problems: string[] = [];
  if (a.kind === "text") {
    const r = input.rect!;
    const band = rectMask(r.x, r.y, r.w, r.h, W, H);
    return {
      index: input.index,
      kind: a.kind,
      state: a.state,
      points: [],
      rect: r,
      samples: [],
      medianRun: 0,
      onInk: 0,
      halfWidth: 0,
      band,
      mask: dilate(band, 2, W, H),
      allowances: [],
      problems,
    };
  }
  const pts = input.points!;
  const raw = samplePolyline(pts);
  const samples = raw.map((p) => measure(ink, W, H, p));
  const runs = samples.filter((s) => s.run > 0).map((s) => s.run);
  const med = median(runs);
  const onInk = samples.length > 0 ? runs.length / samples.length : 0;
  const hw = (med + 2) / 2;
  const w = 2 * hw;
  if (onInk < 0.8)
    problems.push(
      `the polyline is not on ink (${Math.round(onInk * 100)}% of samples, 80% needed)`,
    );
  if (med > 12)
    problems.push(`the measured stroke is ${med} px wide (at most 12: strokes, not shapes)`);
  if (a.width !== undefined && med > 0 && (a.width > 2 * med || 2 * a.width < med)) {
    problems.push(`the declared width ${a.width} is not within 2x of the measured ${med} px`);
  }
  const span = (s: Sample, lim: number): number => {
    let mn = Infinity;
    let mx = -Infinity;
    for (let k = -lim; k <= lim; k++) {
      const x = Math.round(s.x + k * s.nx);
      const y = Math.round(s.y + k * s.ny);
      if (x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x]) {
        if (k < mn) mn = k;
        if (k > mx) mx = k;
      }
    }
    return mx >= mn ? mx - mn + 1 : 0;
  };
  let head: 0 | 1 | undefined;
  if (a.kind === "arrow") {
    if (hasHead(samples, 1, med, w, span)) head = 1;
    else if (hasHead(samples, 0, med, w, span)) head = 0;
    else problems.push("no arrowhead was detected at either end");
  }
  let band = capsules(pts, hw, W, H);
  let headStamp: Mask | undefined;
  // A head on a stroke wider than 12 px is already invalid; it is not stamped (bounded work).
  if (head !== undefined && med <= 12) {
    // The band follows the measured wedge: each head sample's run (or span), thickened by 1 px.
    const total = samples[samples.length - 1]?.s ?? 0;
    const win = samples.filter((s) => (head === 0 ? s.s : total - s.s) <= 3 * w + 1e-9);
    const stampPts: [number, number][] = [];
    for (const s of win) {
      const lim = Math.ceil(3 * w);
      let lo = s.lo;
      let hi = s.hi;
      if (s.run < 2 * med) {
        // Open wedge: use the span.
        let mn = Infinity;
        let mx = -Infinity;
        for (let k = -lim; k <= lim; k++) {
          const x = Math.round(s.x + k * s.nx);
          const y = Math.round(s.y + k * s.ny);
          if (x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x]) {
            mn = Math.min(mn, k);
            mx = Math.max(mx, k);
          }
        }
        if (mx >= mn && mx - mn + 1 >= 2 * med) {
          lo = mn;
          hi = mx;
        }
      }
      for (let k = lo - 1; k <= hi + 1; k++) {
        for (let t = -1; t <= 1; t++) {
          stampPts.push([
            Math.round(s.x + k * s.nx + t * s.ux),
            Math.round(s.y + k * s.ny + t * s.uy),
          ]);
        }
      }
    }
    if (stampPts.length > 0) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of stampPts) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      x0 = Math.max(0, x0);
      y0 = Math.max(0, y0);
      x1 = Math.min(W - 1, x1);
      y1 = Math.min(H - 1, y1);
      if (x1 >= x0 && y1 >= y0) {
        const m = blank(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
        for (const [x, y] of stampPts) {
          if (x >= x0 && y >= y0 && x <= x1 && y <= y1) m.data[(y - y0) * m.w + x - x0] = 1;
        }
        headStamp = m;
        band = union(band, m);
      }
    }
  }
  const mask = headStamp
    ? union(capsules(pts, hw + 2, W, H), dilate(headStamp, 2, W, H))
    : capsules(pts, hw + 2, W, H);
  // A w x w square around each end, plus a 2 px margin: rasterized ends and the closing's
  // bridges between a polyline and the outline it meets stay inside it.
  const half = Math.ceil(hw) + 2;
  const ends = [pts[0]!, pts[pts.length - 1]!];
  const allowances: Box[] = ends.map(([x, y]) => ({
    x: Math.round(x) - half,
    y: Math.round(y) - half,
    w: 2 * half + 1,
    h: 2 * half + 1,
  }));
  return {
    index: input.index,
    kind: a.kind,
    state: a.state,
    points: pts,
    samples,
    medianRun: med,
    onInk,
    halfWidth: hw,
    ...(head !== undefined ? { head } : {}),
    band,
    mask,
    allowances,
    problems,
  };
}

/** Chebyshev distance from a point to a box (0 inside). */
export function boxDistance(px: number, py: number, b: Box): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w - 1));
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h - 1));
  return Math.max(dx, dy);
}

export const inBox = (b: Box, x: number, y: number): boolean =>
  x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h;
