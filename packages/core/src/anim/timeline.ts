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
  timeline.forEach((s, i) => {
    const raw = s.metrics[id];
    const v = raw === undefined ? prev : String(raw);
    if (v !== prev) {
      current = i + 1;
      ns.push(current);
      prev = v;
    }
    shown.push(current);
  });
  return { ns, shown };
}
