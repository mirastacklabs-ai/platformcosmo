/**
 * Annotation geometry (ingestion §6.5 rule 3): measured band of each arrow and leader polyline,
 * arrowhead detection, and the annotation masks that are erased from the base and excluded from
 * the gate's comparisons. Contact allowances are placed by the analysis (they need the parts).
 */
import type { Annotation, FigureState } from "./manifest.js";
import { EMPTY, blank, capsules, dilate, rectMask, union, type Box, type Mask } from "./mask.js";

/** Samples every 2 px along a polyline. */
export const STEP = 2;
/** Longest perpendicular walk on each side of a sample. */
const MAX_WALK = 32;

export interface Sample {
  readonly x: number;
  readonly y: number;
  /** Unit normal and tangent. */
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
  /** Measured band half-width, (stroke run + 2) / 2 (the stroke run: lower quartile of the runs). */
  readonly halfWidth: number;
  /** Measured band width w = median run + 2 (the side of a contact allowance). */
  readonly width: number;
  /** End index (0 = first point, 1 = last) of the detected arrowhead. */
  head?: 0 | 1;
  /** The measured band (polylines; around a head, the wedge's own ink) or the rectangle (text). */
  band: Mask;
  /** The annotation mask: band (or rect) dilated by 2 px. */
  mask: Mask;
  /** Contact allowances: w x w squares where an end or crossing meets a part (at most 2). */
  allowances: Box[];
  /** The detected arrowhead's own ink (the wedge, before its 1 px stamp), or EMPTY. */
  headInk: Mask;
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
  closed?: Uint8Array,
): Sample {
  const nx = -p.uy;
  const ny = p.ux;
  const at = (k: number, m: Uint8Array = ink): boolean => {
    const x = Math.round(p.x + k * nx);
    const y = Math.round(p.y + k * ny);
    return x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] !== 0;
  };
  let k0: number | undefined;
  for (const k of [0, 1, -1, 2, -2]) {
    if (at(k)) {
      k0 = k;
      break;
    }
  }
  if (k0 === undefined) {
    // On ink only after the closing (a light anti-aliased pixel): on the stroke, 1 px.
    if (closed) {
      for (const k of [0, 1, -1]) if (at(k, closed)) return { ...p, nx, ny, run: 1, lo: k, hi: k };
    }
    return { ...p, nx, ny, run: 0, lo: 0, hi: 0 };
  }
  let hi = k0;
  while (hi - k0 < MAX_WALK && at(hi + 1)) hi++;
  let lo = k0;
  while (k0 - lo < MAX_WALK && at(lo - 1)) lo--;
  return { ...p, nx, ny, run: hi - lo + 1, lo, hi };
}

/**
 * The stroke's own width: the lower quartile of the runs. A leader that crosses busy drawing
 * meets wide runs at every crossing; at least a quarter of its samples lie on its own stroke.
 */
function strokeRun(v: readonly number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[(s.length - 1) >> 2]!;
}

/**
 * The polyline's ends moved onto the stroke as drawn (§6.4): from each end, outward along the end
 * segment, the stroke is followed 1 px at a time while its run across the polyline stays on the
 * previous run (±1 px) and does not widen beyond it (a stroke's jitter of 1 px is allowed up to
 * the stroke run + 1). Where the ink ends within 2w + 2 px (a tip drawn past the declared end) or
 * meets a wider stroke there (the part outline or board line the arrow touches: the declared end
 * stopped short of it), the end moves to the last pixel of the continuation. A continuation that
 * runs on beyond that reach is another stroke and nothing moves. Deterministic: the same pixels,
 * walked in the same order, give the same ends.
 */
function snapEnds(
  pts: readonly (readonly [number, number])[],
  med: number,
  ink: Uint8Array,
  W: number,
  H: number,
): (readonly [number, number])[] {
  const out = pts.map((p) => [p[0], p[1]] as const);
  if (med <= 0 || med > 12 || pts.length < 2) return out;
  const reach = 2 * (med + 2) + 2;
  const on = (x: number, y: number): boolean => {
    const a = Math.round(x);
    const b = Math.round(y);
    return a >= 0 && b >= 0 && a < W && b < H && ink[b * W + a] !== 0;
  };
  for (const e of [0, pts.length - 1]) {
    const [ex, ey] = pts[e]!;
    const [nx0, ny0] = pts[e === 0 ? 1 : e - 1]!;
    const L = Math.hypot(ex - nx0, ey - ny0);
    if (L === 0) continue;
    const ux = (ex - nx0) / L;
    const uy = (ey - ny0) / L;
    const nx = -uy;
    const ny = ux;
    // The run across the polyline at a point through the ink pixel at an offset in [a, b]
    // nearest the middle of that range (the lower offset first on a tie).
    const runAt = (cx: number, cy: number, a: number, b: number): [number, number] | undefined => {
      let k0: number | undefined;
      const mid = Math.floor((a + b) / 2);
      for (let d = 0; d <= b - a && k0 === undefined; d++)
        for (const k of [mid - d, mid + d])
          if (k >= a && k <= b && on(cx + k * nx, cy + k * ny)) {
            k0 = k;
            break;
          }
      if (k0 === undefined) return undefined;
      let lo = k0;
      while (k0 - lo < MAX_WALK && on(cx + (lo - 1) * nx, cy + (lo - 1) * ny)) lo--;
      let hi = k0;
      while (hi - k0 < MAX_WALK && on(cx + (hi + 1) * nx, cy + (hi + 1) * ny)) hi++;
      return [lo, hi];
    };
    const start = runAt(ex, ey, -2, 2);
    if (!start || start[1] - start[0] + 1 > med + 1) continue;
    let [plo, phi] = start;
    let last = 0;
    let ended = false;
    for (let t = 1; t <= reach; t++) {
      const r = runAt(ex + t * ux, ey + t * uy, plo - 1, phi + 1);
      if (!r) {
        ended = true;
        break;
      }
      const [lo, hi] = r;
      const run = hi - lo + 1;
      const prev = phi - plo + 1;
      const widens = run > prev && (run > prev + 1 || run > med + 1);
      if (widens || lo < plo - 1 || hi > phi + 1) {
        ended = true;
        break;
      }
      last = t;
      plo = lo;
      phi = hi;
    }
    if (!ended || last === 0) continue;
    out[e] = [Math.round(ex + last * ux), Math.round(ey + last * uy)] as const;
  }
  return out;
}

export interface AnnotationInput {
  readonly index: number;
  readonly annotation: Annotation;
  /** Points or rect already translated into the state image. */
  readonly points?: readonly (readonly [number, number])[];
  readonly rect?: Box;
}

/**
 * First pass: samples, measured band and mask (no head, no allowances yet). Runs are measured on
 * the raw ink `ink` (the closing would merge a stroke with an outline 2 px away); `closed` decides
 * only whether a sample is on ink at all.
 */
export function measureAnnotation(
  input: AnnotationInput,
  ink: Uint8Array,
  W: number,
  H: number,
  closed?: Uint8Array,
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
      width: 0,
      band,
      mask: dilate(band, 2, W, H),
      allowances: [],
      headInk: EMPTY,
      problems,
    };
  }
  // The stroke run of the polyline as declared, then its ends moved onto the stroke as drawn
  // (an end declared short of the tip or of the part it touches) and the whole measured again.
  const declared = input.points!;
  const runsOf = (q: readonly Sample[]): number[] => q.filter((s) => s.run > 0).map((s) => s.run);
  const first = samplePolyline(declared).map((p) => measure(ink, W, H, p, closed));
  const pts = snapEnds(declared, strokeRun(runsOf(first)), ink, W, H);
  const moved = pts.some((p, k) => p[0] !== declared[k]![0] || p[1] !== declared[k]![1]);
  const samples = moved ? samplePolyline(pts).map((p) => measure(ink, W, H, p, closed)) : first;
  const runs = runsOf(samples);
  const med = strokeRun(runs);
  const onInk = samples.length > 0 ? runs.length / samples.length : 0;
  const hw = (med + 2) / 2;
  if (onInk < 0.8)
    problems.push(
      `the polyline is not on ink (${Math.round(onInk * 100)}% of samples, 80% needed)`,
    );
  if (med > 12)
    problems.push(`the measured stroke is ${med} px wide (at most 12: strokes, not shapes)`);
  if (a.width !== undefined && med > 0 && (a.width > 2 * med || 2 * a.width < med)) {
    problems.push(`the declared width ${a.width} is not within 2x of the measured ${med} px`);
  }
  // The band follows the stroke as drawn: the capsule around the declared line plus the
  // measured runs (within hw + 2 of it, and only where the run is the stroke's, not a crossing).
  const runs2: [number, number][] = [];
  for (const smp of samples) {
    if (smp.run === 0 || smp.run > med + 1) continue;
    const lim = hw + 2;
    for (let k = Math.max(smp.lo, -lim); k <= Math.min(smp.hi, lim); k++) {
      for (let t = -1; t <= 1; t++) {
        runs2.push([
          Math.round(smp.x + k * smp.nx + t * smp.ux),
          Math.round(smp.y + k * smp.ny + t * smp.uy),
        ]);
      }
    }
  }
  let band = capsules(pts, hw, W, H);
  if (runs2.length > 0) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of runs2) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(W - 1, x1);
    y1 = Math.min(H - 1, y1);
    if (x1 >= x0 && y1 >= y0) {
      const m = blank(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
      for (const [x, y] of runs2)
        if (x >= x0 && y >= y0 && x <= x1 && y <= y1) m.data[(y - y0) * m.w + x - x0] = 1;
      band = union(band, m);
    }
  }
  return {
    index: input.index,
    kind: a.kind,
    state: a.state,
    points: pts,
    samples,
    medianRun: med,
    onInk,
    halfWidth: hw,
    width: Math.ceil(2 * hw),
    band,
    mask: union(capsules(pts, hw + 2, W, H), dilate(band, 2, W, H)),
    allowances: [],
    headInk: EMPTY,
    problems,
  };
}

/**
 * Arrowhead at one end (rule 3): the ink 8-connected to the shaft's run within the last 3w px,
 * excluding `skip` pixels (part outlines and static drawing), measured across the polyline at
 * each sample. A head widens to at least 2x the median run and narrows (never widening again)
 * toward the tip; filled and open wedges alike, because the arms of an open wedge are connected
 * to the shaft. A component that runs out of the window sideways is a crossing stroke, not a
 * head. Returns the wedge's pixels, or undefined.
 */
function wedgeAt(
  g: AnnotationGeometry,
  end: 0 | 1,
  raw: Uint8Array,
  W: number,
  H: number,
  skip: (x: number, y: number) => boolean,
): Mask | undefined {
  const med = g.medianRun;
  if (med <= 0) return undefined;
  const w = g.width;
  const total = g.samples[g.samples.length - 1]?.s ?? 0;
  const win = g.samples
    .filter((s) => (end === 0 ? s.s : total - s.s) <= 3 * w + 1e-9)
    .sort((a, b) => (end === 0 ? a.s - b.s : b.s - a.s));
  if (win.length < 3) return undefined;
  const L = Math.ceil(3 * w);
  // The window: every pixel across each sample (and half a step along it), lateral |k| <= L.
  const inWin = new Map<number, number>();
  const lateral: { idx: number; k: number }[][] = win.map(() => []);
  win.forEach((s, i) => {
    for (let t = -1; t <= 1; t++) {
      for (let k = -L; k <= L; k++) {
        const x = Math.round(s.x + k * s.nx + t * s.ux);
        const y = Math.round(s.y + k * s.ny + t * s.uy);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const idx = y * W + x;
        const prev = inWin.get(idx);
        if (prev === undefined || Math.abs(k) < prev) inWin.set(idx, Math.abs(k));
        if (t === 0) lateral[i]!.push({ idx, k });
      }
    }
  });
  const ok = (idx: number): boolean =>
    inWin.has(idx) && raw[idx] !== 0 && !skip(idx % W, (idx - (idx % W)) / W);
  // Seed: the shaft run at the innermost window sample.
  const inner = win[win.length - 1]!;
  const comp = new Set<number>();
  const stack: number[] = [];
  for (let k = inner.lo; k <= inner.hi; k++) {
    const idx = Math.round(inner.y + k * inner.ny) * W + Math.round(inner.x + k * inner.nx);
    if (ok(idx) && !comp.has(idx)) {
      comp.add(idx);
      stack.push(idx);
    }
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % W;
    const y = (p - x) / W;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const a = x + dx;
        const b = y + dy;
        if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const q = b * W + a;
        if (comp.has(q) || !ok(q)) continue;
        comp.add(q);
        stack.push(q);
      }
    }
  }
  if (comp.size === 0) return undefined;
  for (const idx of comp) if ((inWin.get(idx) ?? 0) >= L - 1) return undefined;
  const widths = lateral.map((row) => {
    let mn = Infinity;
    let mx = -Infinity;
    for (const { idx, k } of row) {
      if (!comp.has(idx)) continue;
      if (k < mn) mn = k;
      if (k > mx) mx = k;
    }
    return mx >= mn ? mx - mn + 1 : 0;
  });
  let imax = 0;
  for (let i = 1; i < widths.length; i++) if (widths[i]! > widths[imax]!) imax = i;
  if (imax === 0 || widths[imax]! < 2 * med) return undefined;
  for (let j = 1; j <= imax; j++) if (widths[j - 1]! > widths[j]! + 1) return undefined;
  const narrow = Math.max(med, widths[imax]! / 2);
  if (!widths.slice(0, imax).some((v) => v <= narrow)) return undefined;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (const idx of comp) {
    const x = idx % W;
    const y = (idx - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const m = blank(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  for (const idx of comp) {
    const x = idx % W;
    const y = (idx - x) / W;
    m.data[(y - y0) * m.w + x - x0] = 1;
  }
  return m;
}

/**
 * Second pass for arrows: finds the arrowhead (either end; the spec's "free end" contradicts
 * "an arrow from the background to a part's edge passes", so the head may touch a part) and lets
 * the band and mask follow the wedge's own ink.
 */
export function detectHead(
  g: AnnotationGeometry,
  raw: Uint8Array,
  W: number,
  H: number,
  skip: (x: number, y: number) => boolean,
): void {
  if (g.kind !== "arrow" || g.medianRun > 12) {
    if (g.kind === "arrow" && g.medianRun > 12)
      g.problems.push("no arrowhead was detected at either end");
    return;
  }
  for (const end of [1, 0] as const) {
    const wedge = wedgeAt(g, end, raw, W, H, skip);
    if (!wedge) continue;
    g.head = end;
    g.headInk = wedge;
    const stamp = dilate(wedge, 1, W, H);
    g.band = union(g.band, stamp);
    g.mask = union(g.mask, dilate(stamp, 2, W, H));
    return;
  }
  g.problems.push("no arrowhead was detected at either end");
}

/** An annotation's own stroke as drawn, with the sample each pixel came from. */
export interface OwnInk {
  readonly mask: Mask;
  /** Per pixel of `mask` (same layout): the sample index, or -1 (a wedge or text pixel). */
  readonly sample: Int32Array;
}

/**
 * The annotation's own stroke as drawn (§6.4, one drawing). For a polyline: the centre line of
 * each segment fitted (least squares, one pass dropping samples more than 1.5 px off) to the run
 * centres of the samples where the run is the stroke's (at most the stroke run + 1; a crossing
 * widens it), every raw-ink pixel of the mask within the stroke run / 2 + 0.25 px of it, those
 * runs themselves and the arrowhead's wedge. For a text rectangle, its raw ink. The drawing's
 * other ink under the mask is not the annotation's.
 */
export function ownInk(g: AnnotationGeometry, ink: Uint8Array, W: number): OwnInk {
  const m = blank(g.mask.x, g.mask.y, g.mask.w, g.mask.h);
  const sample = new Int32Array(m.w * m.h).fill(-1);
  if (g.kind === "text") {
    const r = g.rect!;
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++)
        if (ink[y * W + x]) m.data[(y - m.y) * m.w + x - m.x] = 1;
    return { mask: m, sample };
  }
  const pts = g.points;
  const med = g.medianRun;
  const smp = g.samples;
  // Per segment: the start's arc length, the unit tangent and normal, and the fitted offset
  // c(s) = a + b (s - s0) of the drawn centre from the declared line.
  const segs: {
    ax: number;
    ay: number;
    ux: number;
    uy: number;
    L: number;
    s0: number;
    a: number;
    b: number;
  }[] = [];
  let s0 = 0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1]!;
    const [bx, by] = pts[k]!;
    const L = Math.hypot(bx - ax, by - ay);
    if (L === 0) continue;
    const ux = (bx - ax) / L;
    const uy = (by - ay) / L;
    const on = smp.filter(
      (q) => q.run > 0 && q.run <= med + 1 && q.s >= s0 - 1e-9 && q.s <= s0 + L + 1e-9,
    );
    const fit = (q: readonly Sample[]): [number, number] => {
      if (q.length === 0) return [0, 0];
      const ms = q.reduce((t, v) => t + v.s, 0) / q.length;
      const mc = q.reduce((t, v) => t + (v.lo + v.hi) / 2, 0) / q.length;
      let sxx = 0;
      let sxy = 0;
      for (const v of q) {
        sxx += (v.s - ms) ** 2;
        sxy += (v.s - ms) * ((v.lo + v.hi) / 2 - mc);
      }
      const b = sxx > 1e-9 ? sxy / sxx : 0;
      return [mc + b * (s0 - ms), b];
    };
    let [a, b] = fit(on);
    const kept = on.filter((v) => Math.abs((v.lo + v.hi) / 2 - (a + b * (v.s - s0))) <= 1.5);
    if (kept.length >= 2 && kept.length < on.length) [a, b] = fit(kept);
    segs.push({ ax, ay, ux, uy, L, s0, a, b });
    s0 += L;
  }
  const r = med / 2 + 0.25;
  const last = smp.length - 1;
  // Candidates walked along each fitted centre line in half-pixel steps (bounded work: the
  // polyline's length times its width), each scored by its exact distance to the line.
  const dist = new Float32Array(m.w * m.h).fill(Infinity);
  const R = Math.ceil(r) + 1;
  for (const sg of segs) {
    for (let q = 0; q <= 2 * Math.ceil(sg.L); q++) {
      const t0 = Math.min(sg.L, q / 2);
      for (let k = -2 * R; k <= 2 * R; k++) {
        const off = sg.a + sg.b * t0 + k / 2;
        const x = Math.round(sg.ax + t0 * sg.ux - off * sg.uy);
        const y = Math.round(sg.ay + t0 * sg.uy + off * sg.ux);
        if (x < m.x || y < m.y || x >= m.x + m.w || y >= m.y + m.h) continue;
        const i = (y - m.y) * m.w + x - m.x;
        if (!g.mask.data[i] || !ink[y * W + x]) continue;
        const t = Math.max(0, Math.min(sg.L, (x - sg.ax) * sg.ux + (y - sg.ay) * sg.uy));
        const c = sg.a + sg.b * t;
        const d = Math.hypot(
          x - (sg.ax + t * sg.ux - c * sg.uy),
          y - (sg.ay + t * sg.uy + c * sg.ux),
        );
        if (d > r + 1e-9 || d >= dist[i]!) continue;
        dist[i] = d;
        m.data[i] = 1;
        sample[i] = Math.max(0, Math.min(last, Math.round((sg.s0 + t) / STEP)));
      }
    }
  }
  // The runs measured on the stroke itself (a stroke drawn off the fitted line, a curve).
  for (let k = 0; k <= last; k++) {
    const v = smp[k]!;
    if (v.run === 0 || v.run > med + 1) continue;
    for (let q = v.lo; q <= v.hi; q++) {
      const x = Math.round(v.x + q * v.nx);
      const y = Math.round(v.y + q * v.ny);
      if (x < m.x || y < m.y || x >= m.x + m.w || y >= m.y + m.h) continue;
      const i = (y - m.y) * m.w + x - m.x;
      if (m.data[i] || !g.mask.data[i] || !ink[y * W + x]) continue;
      m.data[i] = 1;
      sample[i] = k;
    }
  }
  const head = g.headInk;
  const endSample = g.head === 0 ? 0 : last;
  for (let j = 0; j < head.h; j++)
    for (let i = 0; i < head.w; i++) {
      if (!head.data[j * head.w + i]) continue;
      const x = i + head.x;
      const y = j + head.y;
      if (!inBox(m, x, y)) continue;
      const q = (y - m.y) * m.w + x - m.x;
      if (!m.data[q]) {
        m.data[q] = 1;
        sample[q] = endSample;
      }
    }
  return { mask: m, sample };
}

/** Chebyshev distance from a point to a box (0 inside). */
export function boxDistance(px: number, py: number, b: Box): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w - 1));
  const dy = Math.max(b.y - py, 0, py - (b.y + b.h - 1));
  return Math.max(dx, dy);
}

export const inBox = (b: Box, x: number, y: number): boolean =>
  x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h;
