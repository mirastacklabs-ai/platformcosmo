/** Timeline math: step windows, zoom (camera) geometry, per-step caption/metric/state lookups. */
import type { ObjectState, Rect, RenderModel, SceneStep } from "../contracts/index.js";
import { r2, t4 } from "./css.js";

export interface Windows {
  /** Start second of each step (speed applied). */
  readonly starts: readonly number[];
  /** Duration of each step (speed applied). */
  readonly durations: readonly number[];
  readonly total: number;
}

export function windows(timeline: readonly SceneStep[], speed: number): Windows {
  const starts: number[] = [];
  const durations: number[] = [];
  let t = 0;
  for (const s of timeline) {
    starts.push(t);
    const d = s.duration / speed;
    durations.push(d);
    t += d;
  }
  return { starts, durations, total: t };
}

/** 0-based index of the step playing at `time` (wraps around the loop). */
export function stepIndexAt(w: Windows, time: number): number {
  if (w.total <= 0 || w.starts.length === 0) return 0;
  const t = ((time % w.total) + w.total) % w.total;
  let k = 0;
  for (let i = 0; i < w.starts.length; i++) if (t >= (w.starts[i] ?? 0)) k = i;
  return k;
}

export interface Zoom {
  /** Zoomed `viewBox`, same aspect as the model's. */
  readonly viewBox: Rect;
  readonly scale: number;
  /** Camera transform: `p -> scale * p + (tx, ty)`. */
  readonly tx: number;
  readonly ty: number;
}

const MAX_ZOOM = 3;

/** Zoom onto the step's focus rect; undefined for the full view (no focus, unknown target, tiny zoom). */
export function zoomFor(model: RenderModel, step: SceneStep | undefined): Zoom | undefined {
  if (!step?.focus) return undefined;
  const r = model.focusRects[step.focus];
  const v = model.viewBox;
  if (!r || !(v.width > 0) || !(v.height > 0)) return undefined;
  const pad = Math.max(24, 0.25 * Math.max(r.width, r.height));
  const w = r.width + 2 * pad;
  const h = r.height + 2 * pad;
  const scale = Math.min(MAX_ZOOM, Math.min(v.width / w, v.height / h));
  if (scale <= 1.01) return undefined;
  const zw = v.width / scale;
  const zh = v.height / scale;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const x = Math.min(Math.max(cx - zw / 2, v.x), v.x + v.width - zw);
  const y = Math.min(Math.max(cy - zh / 2, v.y), v.y + v.height - zh);
  return {
    viewBox: { x: r2(x), y: r2(y), width: r2(zw), height: r2(zh) },
    scale,
    tx: v.x - scale * x,
    ty: v.y - scale * y,
  };
}

const IDENTITY = "translate(0px,0px) scale(1)";

/** Camera transform value; every value shares one function list so keyframes interpolate. */
export function cameraTransform(z: Zoom | undefined): string {
  return z ? `translate(${t4(z.tx)}px,${t4(z.ty)}px) scale(${t4(z.scale)})` : IDENTITY;
}

/** Inverse of the camera transform, for elements that must stay put on screen (controls). */
export function inverseCameraTransform(z: Zoom | undefined): string {
  return z
    ? `translate(${t4(-z.tx / z.scale)}px,${t4(-z.ty / z.scale)}px) scale(${t4(1 / z.scale)})`
    : IDENTITY;
}

export const IDENTITY_TRANSFORM = IDENTITY;

/** State of an object during step `i` (0-based): the step's cumulative state, else its initial one. */
export function stateAt(
  step: SceneStep | undefined,
  id: string,
  initial: ObjectState,
): ObjectState {
  return step?.states[id] ?? initial;
}

/**
 * Metric text ids: `n = 0` is the base value, `n = j` a step that changes it. `shown[i]` is the `n`
 * displayed during step i (0-based): the latest change at or before that step.
 */
export function metricTexts(
  base: string | number,
  timeline: readonly SceneStep[],
  id: string,
): { readonly ns: readonly number[]; readonly shown: readonly number[] } {
  const ns = [0];
  const shown: number[] = [];
  let prev = String(base);
  let current = 0;
  timeline.forEach((s) => {
    const raw = s.metrics[id];
    const v = raw === undefined ? prev : String(raw);
    if (v !== prev) {
      current = s.index;
      ns.push(current);
      prev = v;
    }
    shown.push(current);
  });
  return { ns, shown };
}

/** Length of the camera transition at the end of a step (it leads into the next step's view). */
export function transitionSeconds(stepDuration: number): number {
  return Math.min(0.8, 0.25 * stepDuration);
}

interface Cam {
  readonly s: number;
  readonly tx: number;
  readonly ty: number;
}

const camOf = (z: Zoom | undefined): Cam =>
  z ? { s: z.scale, tx: z.tx, ty: z.ty } : { s: 1, tx: 0, ty: 0 };

/** CSS `cubic-bezier(.4,0,.2,1)`: progress for linear time `x` in 0..1 (bisection, deterministic). */
export function ease(x: number): number {
  const bez = (a: number, b: number, u: number) =>
    3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bez(0.4, 0.2, mid) < x) lo = mid;
    else hi = mid;
  }
  return bez(0, 1, (lo + hi) / 2);
}

/**
 * Camera keyframes of the loop (D27): the loop rests on the overview (`undefined`), eases into
 * step 1's view over the first transition, and every later transition fills the END of the
 * previous step so each step starts at its own view; the last transition eases back to the
 * overview at the loop end. Hold intervals reuse the same `Zoom` object.
 */
export function cameraStops(
  zooms: readonly (Zoom | undefined)[],
  w: Windows,
): { readonly t: number; readonly z: Zoom | undefined }[] {
  const n = zooms.length;
  const trs = w.durations.map(transitionSeconds);
  const stops: { t: number; z: Zoom | undefined }[] = [{ t: 0, z: undefined }];
  stops.push({ t: trs[0] ?? 0, z: zooms[0] });
  for (let i = 1; i < n; i++) {
    const start = w.starts[i] ?? 0;
    stops.push({ t: start - (trs[i - 1] ?? 0), z: zooms[i - 1] });
    stops.push({ t: start, z: zooms[i] });
  }
  stops.push({ t: w.total - (trs[n - 1] ?? 0), z: zooms[n - 1] });
  stops.push({ t: w.total, z: undefined });
  return stops;
}

/**
 * View box of a frame at `time`, on the same curve as the loop's CSS camera keyframes, so GIF and
 * MP4 frames ease. Time 0 and the loop end are the overview (`undefined`).
 */
export function frameViewBox(
  model: RenderModel,
  w: Windows,
  zooms: readonly (Zoom | undefined)[],
  time: number,
): Rect | undefined {
  if (zooms.length === 0 || w.total <= 0 || !zooms.some((z) => z !== undefined)) return undefined;
  const stops = cameraStops(zooms, w);
  const t = ((time % w.total) + w.total) % w.total;
  let i = 0;
  while (i < stops.length - 2 && t >= (stops[i + 1]?.t ?? 0)) i++;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  if (a.z === b.z || b.t <= a.t) return a.z?.viewBox;
  const f = ease((t - a.t) / (b.t - a.t));
  if (f <= 0) return a.z?.viewBox;
  if (f >= 1) return b.z?.viewBox;
  const ca = camOf(a.z);
  const cb = camOf(b.z);
  const s = ca.s + (cb.s - ca.s) * f;
  const tx = ca.tx + (cb.tx - ca.tx) * f;
  const ty = ca.ty + (cb.ty - ca.ty) * f;
  if (s <= 1.0001) return undefined;
  const v = model.viewBox;
  return {
    x: r2((v.x - tx) / s),
    y: r2((v.y - ty) / s),
    width: r2(v.width / s),
    height: r2(v.height / s),
  };
}
