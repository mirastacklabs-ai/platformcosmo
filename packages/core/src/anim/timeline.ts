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
  // an assembly node is framed at the end pose of this step (§7.4), labels included; a node
  // inside a close-up level where that level's overview puts it (the level group is in the
  // camera). A level's own root does not zoom: the level is shown at its overview (§8.4).
  const asm = model.assembly;
  if (asm?.levels?.some((l) => l.path === step.focus) === true) return undefined;
  const own = asm?.focusRect(step.index, step.focus);
  const world = own ?? model.focusRects[step.focus];
  const inLevel = world === undefined ? asm?.levelFocusRect?.(step.index, step.focus) : undefined;
  const r = world ?? inLevel;
  if (r === undefined) return undefined;
  let z = zoomOnto(model.viewBox, r);
  if (z === undefined || (own === undefined && inLevel === undefined)) return z;
  // an assembly step: a label of the focused subtree or of a part the step moves that the
  // window cuts, or that sits under a pinned overlay (caption, metric tiles), widens the window
  // ONCE to hold it; any other label the window cuts or covers is hidden over the step and
  // reported by the render (§7.4), so a focus zoom stays a focus zoom
  const focus = step.focus;
  const labels = (asm?.stepLabels?.(step.index) ?? []).filter(
    (q) =>
      q.moved === true ||
      (q.part !== undefined && (q.part === focus || q.part.startsWith(`${focus}/`))),
  );
  if (labels.length === 0) return z;
  const pinned = [
    ...(model.captionRect === undefined ? [] : [model.captionRect]),
    ...Object.values(model.metricRects ?? {}),
  ];
  {
    const s = z.scale;
    const zt = z;
    // a pinned rect seen through the zoom, in world units
    const keep = pinned.map((k) => ({
      x: (k.x - zt.tx) / s,
      y: (k.y - zt.ty) / s,
      width: k.width / s,
      height: k.height / s,
    }));
    const grow: Rect[] = [];
    for (const q of labels) {
      if (!overlaps(q, zt.viewBox)) continue;
      const under = keep.find((k) => overlaps(q, k));
      if (under !== undefined) {
        // room for the overlay on the side it is pinned to (below a caption, above the tiles)
        const below = under.y + under.height / 2 > q.y + q.height / 2;
        grow.push(
          below
            ? { ...q, height: q.height + under.height }
            : { ...q, y: q.y - under.height, height: q.height + under.height },
        );
      } else if (!inside(q, zt.viewBox)) grow.push(q);
    }
    if (grow.length === 0) return z;
    z = zoomOnto(model.viewBox, unionOf([r, ...grow]));
  }
  return z;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (a: Rect, b: Rect): boolean =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
const unionOf = (rs: readonly Rect[]): Rect => {
  const x0 = Math.min(...rs.map((q) => q.x));
  const y0 = Math.min(...rs.map((q) => q.y));
  const x1 = Math.max(...rs.map((q) => q.x + q.width));
  const y1 = Math.max(...rs.map((q) => q.y + q.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

/** The zoom that frames `r` in the view box `v` (padding, 3x cap); undefined for a tiny zoom. */
function zoomOnto(v: Rect, r: Rect): Zoom | undefined {
  if (!(v.width > 0) || !(v.height > 0)) return undefined;
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
  /** Per transition (`cameraHalves`): the half the camera moves in; absent: the whole window. */
  halves: readonly ("first" | "second" | undefined)[] = [],
): { readonly t: number; readonly z: Zoom | undefined }[] {
  const n = zooms.length;
  const trs = w.durations.map(transitionSeconds);
  const stops: { t: number; z: Zoom | undefined }[] = [{ t: 0, z: undefined }];
  /** The move from `a` (at `t0`) to `b` (at `t1`), in the half `halves[k]` when set. */
  const move = (k: number, t0: number, t1: number, a: Zoom | undefined, b: Zoom | undefined) => {
    const h = halves[k];
    const m = t0 + (t1 - t0) / 2;
    if (h === "first") stops.push({ t: t0, z: a }, { t: m, z: b }, { t: t1, z: b });
    else if (h === "second") stops.push({ t: t0, z: a }, { t: m, z: a }, { t: t1, z: b });
    else stops.push({ t: t0, z: a }, { t: t1, z: b });
  };
  if (halves[0] === undefined) stops.push({ t: trs[0] ?? 0, z: zooms[0] });
  else {
    stops.pop();
    move(0, 0, trs[0] ?? 0, undefined, zooms[0]);
  }
  for (let i = 1; i < n; i++) {
    const start = w.starts[i] ?? 0;
    move(i, start - (trs[i - 1] ?? 0), start, zooms[i - 1], zooms[i]);
  }
  move(n, w.total - (trs[n - 1] ?? 0), w.total, zooms[n - 1], undefined);
  return stops;
}

/** Depth and path of the close-up level a focus id shows (0: the main scene). */
function levelOfFocus(
  model: RenderModel,
  focus: string | undefined,
): { readonly path: string | undefined; readonly depth: number } {
  let best: { path: string; depth: number } | undefined;
  if (focus !== undefined) {
    for (const l of model.assembly?.levels ?? []) {
      if (focus !== l.path && !focus.startsWith(`${l.path}/`)) continue;
      if (best === undefined || l.path.length > best.path.length) best = l;
    }
  }
  return { path: best?.path, depth: best?.depth ?? 0 };
}

const sameView = (a: Rect | undefined, b: Rect | undefined): boolean =>
  a === undefined
    ? b === undefined
    : b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * Where the camera moves in a transition that also changes the close-up level in effect (§8.4):
 * going deeper (or across) it moves in the FIRST half and the level grows in the second; coming
 * out the level shrinks first and the camera moves in the SECOND half. So the camera never zooms
 * one way while a level grows the other. Undefined: the level or the view does not change.
 */
export function cameraHalf(
  from: { readonly level: string | undefined; readonly depth: number; readonly view?: Rect },
  to: { readonly level: string | undefined; readonly depth: number; readonly view?: Rect },
): "first" | "second" | undefined {
  if (from.level === to.level || sameView(from.view, to.view)) return undefined;
  return to.depth >= from.depth ? "first" : "second";
}

/** `cameraHalf` of every transition of the loop: into step i (0..n-1), then the closing one (n). */
export function cameraHalves(
  model: RenderModel,
  zooms: readonly (Zoom | undefined)[],
): ("first" | "second" | undefined)[] {
  const tl = model.scene.timeline;
  if ((model.assembly?.levels?.length ?? 0) === 0) return [];
  const at = (i: number) => {
    if (i < 0 || i >= tl.length) return { level: undefined, depth: 0, view: undefined };
    const l = levelOfFocus(model, tl[i]?.focus);
    return { level: l.path, depth: l.depth, view: zooms[i]?.viewBox };
  };
  return Array.from({ length: tl.length + 1 }, (_, i) => cameraHalf(at(i - 1), at(i)));
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
  const stops = cameraStops(zooms, w, cameraHalves(model, zooms));
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
