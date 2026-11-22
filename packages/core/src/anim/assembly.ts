/**
 * Animation of the assembly layer (Track B, B-1; docs/design/assemblies.md §7, §9.4, §12): the
 * tracks of `RenderModel.assembly` as CSS keyframes (loop, interactive, reduced motion) and as
 * attribute overrides (frame and per-step outputs, where resvg has no CSS animation). Both read
 * the SAME prepared keys through the evaluators of `render/assembly/tracks`, so a frame equals
 * the CSS pose at the same time. Pose motion is CSS in both `smil` and `css` modes (D32): no
 * SMIL element is made here.
 *
 * Wrapper chain (one animated property per element, so CSS animations never fight):
 * `partHost`/`partMotion` carry `transform`, `partVisible` carries `visibility`, `partFade`,
 * label groups and static fades carry `opacity`. Identical tracks share one `@keyframes`.
 *
 * Speed. The model is built at speed 1; the camera's lead and closing transitions are
 * `min(0.8, 0.25 d / speed)` seconds of OUTPUT, i.e. `min(0.8 speed, 0.25 d)` loop seconds. The
 * keys are retimed by a piecewise-linear warp that keeps each step's start and end and moves its
 * motion window (`open`) and closing hold (`end`) to the camera's, so assembly motion meets the
 * camera at any `--speed`. At speed 1 the warp is the identity.
 */
import type {
  AssemblyRenderModel,
  Diagnostic,
  IdScheme,
  OpacityKey,
  RenderModel,
  TrackKey,
  VisibilityKey,
} from "../contracts/index.js";
import { parseCopyKey } from "../depth/copies.js";
import { placementAttr, placementAt, type PlacementKey } from "../render/assembly/groups.js";
import type { AssemblyRenderModelX } from "../render/assembly/types.js";
import { keyProgress, round2, stepEndTime } from "../render/assembly/tracks.js";
import { Keyframes, pct, t4 } from "./css.js";

type Attrs = Record<string, Record<string, string | number>>;

/** Keys per animated property above which linear sampled runs are thinned. */
export const MAX_KEYS = 1024;
/** Animated wrappers above which the rest stay at the rest pose (the model's budgets stop earlier). */
export const MAX_PROPS = 12000;

type Easing = TrackKey["easing"] | OpacityKey["easing"];

interface MoveProp {
  readonly kind: "transform";
  readonly id: string;
  readonly keys: readonly TrackKey[];
}
interface VisProp {
  readonly kind: "visibility";
  readonly id: string;
  readonly keys: readonly VisibilityKey[];
}
interface FadeProp {
  readonly kind: "opacity";
  readonly id: string;
  readonly keys: readonly OpacityKey[];
}
/** Placement of a level group: `matrix(s 0 0 s tx ty)`, linear between keys (B-3). */
type MatrixKey = PlacementKey & { readonly easing: "linear" };
interface MatrixProp {
  readonly kind: "matrix";
  readonly id: string;
  readonly keys: readonly MatrixKey[];
}
export type AssemblyProp = MoveProp | VisProp | FadeProp | MatrixProp;

export interface AssemblyAnim {
  /** Loop length at speed 1 (the keys' own clock). */
  readonly loop: number;
  /** Properties in a stable order, keys retimed for the speed. */
  readonly props: readonly AssemblyProp[];
  /** Baked time (speed-1 loop seconds) to the speed's loop seconds. */
  readonly warp: (t: number) => number;
  /** Per step (0-based): start and end-of-hold in the speed's loop seconds. */
  readonly starts: readonly number[];
  readonly ends: readonly number[];
  /** Tracks still above `MAX_KEYS` after thinning, and wrappers above `MAX_PROPS` (left at rest). */
  readonly overKeys: number;
  readonly overProps: number;
}

const r4 = (v: number): number => Math.round(v * 10000) / 10000 + 0;

// ---------------------------------------------------------------------------------------------
// Preparation: warp, bound, order
// ---------------------------------------------------------------------------------------------

/** The hold at the end of a step's motion window, in loop seconds (§7.3). */
const HOLD = 0.2;

/**
 * Piecewise-linear retiming of the speed-1 clock onto the speed's camera windows (§7.3). Per
 * step, with the camera's lead and closing transition `min(0.8 speed, 0.25 d)` loop seconds:
 * `open -> open'`; the end of the motion `open + L -> open' + min(L, room')` (moves play at spec
 * speed and are compressed only when they overflow the window `room'` at this speed);
 * `holdEnd -> holdEnd'`. Poses are unchanged, only their times move.
 */
function warpFor(am: AssemblyRenderModel, speed: number): (t: number) => number {
  if (speed === 1) return (t) => t;
  const pts: [number, number][] = [[0, 0]];
  const push = (a: number, b: number): void => {
    const last = pts[pts.length - 1] as [number, number];
    if (a > last[0] + 1e-9 && b > last[1] + 1e-9) pts.push([a, b]);
  };
  const camera = (baked: number, d: number): number =>
    baked > 0 ? r4(Math.min(0.8 * speed, 0.25 * d)) : 0;
  am.clock.forEach((c, i) => {
    const end = c.start + c.duration;
    // camera lead and loop-start hold are separate (§7.3): the hold is `max(lead_out, 0.4)`
    // output seconds, so in loop seconds `max(camera lead, 0.4 · speed)`
    const baked = c.lead ?? (c.hold === undefined ? r4(c.open - c.start) : 0);
    const cam = camera(baked, c.duration);
    const lead = c.hold === undefined ? cam : Math.max(cam, r4(c.hold * speed));
    const tr = camera(r4(end - c.end), c.duration);
    const open2 = c.start + lead;
    const end2 = end - tr;
    push(c.start, c.start);
    push(c.open, open2);
    const settled = am.settled[i];
    if (settled !== undefined && settled > c.open && settled < c.end) {
      const room2 = Math.max(0, end2 - HOLD - open2);
      push(settled, open2 + Math.min(settled - c.open, room2));
    }
    push(c.end, end2);
    push(end, end);
  });
  return (t) => {
    const first = pts[0] as [number, number];
    if (!(t > first[0])) return t;
    for (let i = 1; i < pts.length; i++) {
      const [a1, b1] = pts[i] as [number, number];
      if (t <= a1) {
        const [a0, b0] = pts[i - 1] as [number, number];
        return r4(b0 + ((t - a0) / (a1 - a0)) * (b1 - b0));
      }
    }
    const [aL, bL] = pts[pts.length - 1] as [number, number];
    return r4(bL + (t - aL));
  };
}

/**
 * The model and the models of its other views and close-up levels (B-3): each has its own
 * tracks, ids scoped to it, on the SAME loop clock. Deterministic order: main, views by turn,
 * levels by path; a model shared by two entries (view 0 is the main model) counts once.
 */
function modelsOf(am: AssemblyRenderModel): AssemblyRenderModel[] {
  const out: AssemblyRenderModel[] = [am];
  const seen = new Set<unknown>([am.tracks]);
  const take = (m: AssemblyRenderModel | undefined): void => {
    if (m === undefined || seen.has(m.tracks)) return;
    seen.add(m.tracks);
    out.push(m);
    for (const l of m.levels ?? []) take(l.model);
  };
  for (const v of am.views ?? []) take(v.model);
  for (const l of am.levels ?? []) take(l.model);
  return out;
}

/** Times at which a pose must stay exact: every key there is kept by `thin`. */
function protectedTimes(am: AssemblyRenderModel): Set<number> {
  const set = new Set<number>();
  const add = (t: number | undefined): void => {
    if (t !== undefined && Number.isFinite(t)) set.add(r4(t));
  };
  for (const m of modelsOf(am)) {
    for (const e of m.epochs) {
      add(e.t0);
      add(e.t1);
    }
    for (const x of m.approximate) {
      add(x.t0);
      add(x.t1);
    }
    for (const c of m.clock) {
      add(c.start);
      add(c.open);
      add(c.end);
      add(c.start + c.duration);
    }
    for (const s of m.settled) add(s);
    add(m.closure?.t0);
    add(m.closure?.t1);
    for (const t of m.tracks) for (const k of t.visibility) add(k.t);
    // the swap of a callout flight: the overlay copy and the world copy meet exactly there
    for (const f of (m as AssemblyRenderModelX).flights ?? []) {
      for (const k of f.visibility) add(k.t);
      for (const k of f.motion) add(k.t);
      for (const k of f.opacity) add(k.t);
    }
    // move boundaries (the render-side model keeps its moves)
    const moves = (m as unknown as { moves?: readonly { t0: number; t1: number }[] }).moves;
    for (const mv of moves ?? []) {
      add(mv.t0);
      add(mv.t1);
    }
  }
  // group and presence keys: the cross-fades and appearances keep their ends
  for (const g of (am as AssemblyRenderModelX).groups ?? []) {
    for (const k of g.opacity) add(k.t);
    for (const k of g.placement ?? []) add(k.t);
  }
  for (const m of modelsOf(am)) {
    for (const t of m.tracks) for (const k of t.opacity) add(k.t);
  }
  return set;
}

/** Largest chord error (user units; opacity x 100) `thin` may introduce. */
const MAX_ERR = 0.5;
const linear = (e: Easing): boolean => e === "linear";

/**
 * Keeps a track within `MAX_KEYS` by dropping keys inside runs of LINEAR sampled keys whose
 * chord error stays under `MAX_ERR` (growing tolerance, one pass per step). Never dropped: the
 * ends, keys at protected times (move and epoch boundaries, visibility times), keys with a
 * non-linear easing and the key after one (the end of an eased segment). `ok` is false when the
 * budget could not be met this way (the track is then left as thinned, never cut blindly).
 */
function thin<K extends { readonly t: number; readonly easing: Easing }>(
  keys: readonly K[],
  protect: ReadonlySet<number>,
  error: (a: K, mid: K, b: K) => number,
): { keys: K[]; ok: boolean } {
  let cur = [...keys];
  for (let eps = 0.01; eps <= MAX_ERR && cur.length > MAX_KEYS; eps *= 2) {
    const out: K[] = [cur[0] as K];
    let removedPrev = false;
    for (let i = 1; i < cur.length - 1; i++) {
      const k = cur[i] as K;
      const prev = cur[i - 1] as K;
      const keep: boolean =
        removedPrev ||
        protect.has(r4(k.t)) ||
        !linear(k.easing) ||
        !linear(prev.easing) ||
        error(out[out.length - 1] as K, k, cur[i + 1] as K) > eps;
      if (keep) out.push(k);
      removedPrev = !keep;
    }
    out.push(cur[cur.length - 1] as K);
    cur = out;
  }
  return { keys: cur, ok: cur.length <= MAX_KEYS };
}

const lerpAt = (a: number, b: number, f: number): number => a + (b - a) * f;
const moveError = (a: TrackKey, k: TrackKey, b: TrackKey): number => {
  const f = (k.t - a.t) / (b.t - a.t);
  return Math.hypot(
    k.offset.x - lerpAt(a.offset.x, b.offset.x, f),
    k.offset.y - lerpAt(a.offset.y, b.offset.y, f),
  );
};
const fadeError = (a: OpacityKey, k: OpacityKey, b: OpacityKey): number =>
  Math.abs(k.opacity - lerpAt(a.opacity, b.opacity, (k.t - a.t) / (b.t - a.t))) * 100;

/** Retimed keys with strictly increasing times (a collision keeps the later key). */
function retime<K extends { readonly t: number }>(
  keys: readonly K[],
  warp: (t: number) => number,
): K[] {
  const out: K[] = [];
  for (const k of keys) {
    const t = warp(k.t);
    const last = out[out.length - 1];
    if (last !== undefined && t <= last.t) out[out.length - 1] = { ...k, t: last.t };
    else out.push({ ...k, t });
  }
  return out;
}

/** Drops an interior key whose value equals both neighbours': the segments around it are flat. */
function prune<K>(keys: readonly K[], same: (a: K, b: K) => boolean): K[] {
  if (keys.length < 3) return [...keys];
  const out: K[] = [keys[0] as K];
  for (let i = 1; i < keys.length - 1; i++) {
    const prev = out[out.length - 1] as K;
    if (same(prev, keys[i] as K) && same(keys[i] as K, keys[i + 1] as K)) continue;
    out.push(keys[i] as K);
  }
  out.push(keys[keys.length - 1] as K);
  return out;
}

const sameOffset = (a: TrackKey, b: TrackKey): boolean =>
  a.offset.x === b.offset.x && a.offset.y === b.offset.y;
const sameOpacity = (a: OpacityKey, b: OpacityKey): boolean => a.opacity === b.opacity;
const sameMatrix = (a: MatrixKey, b: MatrixKey): boolean =>
  a.scale === b.scale && a.tx === b.tx && a.ty === b.ty;
const matrixError = (a: MatrixKey, k: MatrixKey, b: MatrixKey): number => {
  const f = (k.t - a.t) / (b.t - a.t);
  return Math.hypot(
    k.tx - lerpAt(a.tx, b.tx, f),
    k.ty - lerpAt(a.ty, b.ty, f),
    (k.scale - lerpAt(a.scale, b.scale, f)) * 100,
  );
};

const cache = new WeakMap<AssemblyRenderModel, Map<number, AssemblyAnim>>();

/**
 * The first `max` props, whole groups only (in first-appearance order, stopping at the first group
 * that does not fit): the wrappers of all copies of one item form one group (§9.4), so a cut never
 * animates one copy and leaves a sibling at the rest pose.
 */
export function cutProps<P>(props: readonly P[], groups: readonly string[], max: number): P[] {
  if (props.length <= max) return [...props];
  const count = new Map<string, number>();
  for (const g of groups) count.set(g, (count.get(g) ?? 0) + 1);
  const keep = new Set<string>();
  let n = 0;
  for (const [g, c] of count) {
    if (n + c > max) break;
    keep.add(g);
    n += c;
  }
  return props.filter((_, i) => keep.has(groups[i] as string));
}

/**
 * Everything the assembly layer animates, for an output `speed`. `maxProps` (default `MAX_PROPS`)
 * exists for tests; only the default is cached.
 */
export function assemblyAnim(
  am: AssemblyRenderModel,
  speed: number,
  maxProps: number = MAX_PROPS,
): AssemblyAnim {
  const s = speed > 0 && Number.isFinite(speed) ? speed : 1;
  const bySpeed = cache.get(am) ?? new Map<number, AssemblyAnim>();
  if (maxProps === MAX_PROPS) cache.set(am, bySpeed);
  const hit = maxProps === MAX_PROPS ? bySpeed.get(s) : undefined;
  if (hit !== undefined) return hit;
  const warp = warpFor(am, s);
  const protect = protectedTimes(am);
  const props: AssemblyProp[] = [];
  /** Per prop: its cut group (the item for every copy's wrappers, else the element id). */
  const groups: string[] = [];
  let group = "";
  let overKeys = 0;
  const move = (id: string, keys: readonly TrackKey[]): void => {
    if (keys.length === 0) return;
    const t = thin(prune([...keys], sameOffset), protect, moveError);
    if (!t.ok) overKeys++;
    props.push({ kind: "transform", id, keys: retime(t.keys, warp) });
    groups.push(group);
  };
  const fade = (id: string, keys: readonly OpacityKey[]): void => {
    if (keys.length === 0) return;
    const t = thin(prune([...keys], sameOpacity), protect, fadeError);
    if (!t.ok) overKeys++;
    props.push({ kind: "opacity", id, keys: retime(t.keys, warp) });
    groups.push(group);
  };
  // every model the layer draws: the main scene, each quarter-turn view and each close-up level
  // (B-3), each under its own ids; a model's copies are grouped per model and item for the cut
  modelsOf(am).forEach((m, mi) => {
    for (const t of m.tracks) {
      // one track per copy (`item` or `item__c<k>`, §9.4); the wrappers exist exactly for the
      // tracks that have keys (A1-3 `Registered`)
      const { item, copy } = parseCopyKey(t.copy);
      group = `i:${mi}:${item}`;
      move(m.ids.partHost(item, copy), t.host);
      move(m.ids.partMotion(item, copy), t.motion);
      if (t.visibility.length > 0) {
        props.push({
          kind: "visibility",
          id: m.ids.partVisible(item, copy),
          keys: retime(t.visibility, warp),
        });
        groups.push(group);
      }
      fade(m.ids.partFade(item, copy), t.opacity);
    }
    for (const f of m.staticFades) {
      group = `s:${f.id}`;
      fade(f.id, f.opacity);
    }
    for (const l of m.labelTracks) {
      // a top-face label rides inside its part: every copy has one (`copyIds`)
      group = `l:${l.id}`;
      for (const id of m.ids.copyIds(l.id)) {
        move(id, l.motion);
        fade(id, l.opacity);
      }
    }
    // overlay copies of callout flights (A2-7): one wrapper, three properties
    for (const f of (m as AssemblyRenderModelX).flights ?? []) {
      group = `f:${f.id}`;
      move(f.id, f.motion);
      props.push({ kind: "visibility", id: f.id, keys: retime(f.visibility, warp) });
      groups.push(group);
      fade(f.id, f.opacity);
    }
  });
  // view and level groups: cross-fades and the level placements (B-3)
  for (const g of (am as AssemblyRenderModelX).groups ?? []) {
    group = `g:${g.id}`;
    fade(g.id, g.opacity);
    if (g.placement !== undefined && g.placement.length > 0) {
      const keys = g.placement.map((k): MatrixKey => ({ ...k, easing: "linear" }));
      const t = thin(prune(keys, sameMatrix), protect, matrixError);
      if (!t.ok) overKeys++;
      props.push({ kind: "matrix", id: g.id, keys: retime(t.keys, warp) });
      groups.push(group);
    }
  }
  const kept = cutProps(props, groups, maxProps);
  const anim: AssemblyAnim = {
    loop: am.loop,
    props: kept,
    warp,
    starts: am.clock.map((c) => c.start),
    ends: am.clock.map((c) => warp(Math.min(c.end, am.loop))),
    overKeys,
    overProps: props.length - kept.length,
  };
  if (maxProps === MAX_PROPS) bySpeed.set(s, anim);
  return anim;
}

/**
 * A property that never changes value: the DOM already carries it (the rest frame), so the loop
 * needs no animation for it. Frames still write it, as the full state of the wrapper.
 */
export function isConstant(p: AssemblyProp): boolean {
  const first = p.keys[0];
  if (first === undefined) return true;
  if (p.kind === "transform") return p.keys.every((k) => sameOffset(k, first as TrackKey));
  if (p.kind === "matrix") return p.keys.every((k) => sameMatrix(k, first as MatrixKey));
  if (p.kind === "opacity") return p.keys.every((k) => k.opacity === (first as OpacityKey).opacity);
  return p.keys.every((k) => k.visible === (first as VisibilityKey).visible);
}

/** Whether the assembly layer has any motion on the loop (a spec with assembly actions). */
export const hasAssemblyMotion = (am: AssemblyRenderModel | undefined): am is AssemblyRenderModel =>
  am !== undefined && am.loop > 0 && assemblyAnim(am, 1).props.some((p) => !isConstant(p));

// ---------------------------------------------------------------------------------------------
// Attribute overrides (frame, step, static)
// ---------------------------------------------------------------------------------------------

const EPS = 1e-9;

/** Index of the first key with `t < key.t - EPS` (binary search), or `keys.length`. */
function segmentEnd(keys: readonly { readonly t: number }[], t: number): number {
  let lo = 1;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t < (keys[mid] as { t: number }).t - EPS) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Same values as `render/assembly/tracks` `evalOffset`, by binary search. */
function evalOffset(keys: readonly TrackKey[], t: number): { x: number; y: number } {
  const first = keys[0];
  if (first === undefined) return { x: 0, y: 0 };
  if (t <= first.t + EPS) return first.offset;
  const j = segmentEnd(keys, t);
  if (j >= keys.length) return (keys[keys.length - 1] as TrackKey).offset;
  const a = keys[j - 1] as TrackKey;
  const b = keys[j] as TrackKey;
  if (a.easing === "step") return a.offset;
  const u = keyProgress(a.easing, (t - a.t) / (b.t - a.t));
  return {
    x: a.offset.x + (b.offset.x - a.offset.x) * u,
    y: a.offset.y + (b.offset.y - a.offset.y) * u,
  };
}

function evalOpacity(keys: readonly OpacityKey[], t: number): number {
  const first = keys[0];
  if (first === undefined) return 1;
  if (t <= first.t + EPS) return first.opacity;
  const j = segmentEnd(keys, t);
  if (j >= keys.length) return (keys[keys.length - 1] as OpacityKey).opacity;
  const a = keys[j - 1] as OpacityKey;
  const b = keys[j] as OpacityKey;
  if (a.easing === "step") return a.opacity;
  return a.opacity + (b.opacity - a.opacity) * keyProgress(a.easing, (t - a.t) / (b.t - a.t));
}

function evalVisible(keys: readonly VisibilityKey[], t: number): boolean {
  if (keys.length === 0) return true;
  let lo = 0;
  let hi = keys.length; // first key with k.t > t + EPS
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((keys[mid] as VisibilityKey).t <= t + EPS) lo = mid + 1;
    else hi = mid;
  }
  return (keys[Math.max(0, lo - 1)] as VisibilityKey).visible;
}

/** CSS `matrix()` of a placement (unitless numbers: user units, like the translate keyframes). */
const matrixCss = (a: { scale: number; tx: number; ty: number }): string =>
  `matrix(${t4(a.scale)},0,0,${t4(a.scale)},${t4(a.tx)},${t4(a.ty)})`;

const translateAttr = (x: number, y: number): string => `translate(${round2(x)} ${round2(y)})`;

/** The FULL state of every animated wrapper at loop time `t` (this speed's loop seconds). */
function attrsAtLoop(a: AssemblyAnim, t: number): Attrs {
  const out: Attrs = {};
  const at = (id: string): Record<string, string | number> => (out[id] ??= {});
  for (const p of a.props) {
    if (p.kind === "transform") {
      const v = evalOffset(p.keys, t);
      at(p.id).transform = translateAttr(v.x, v.y);
    } else if (p.kind === "matrix") {
      at(p.id).transform = placementAttr(p.keys, t);
    } else if (p.kind === "visibility") {
      at(p.id).visibility = evalVisible(p.keys, t) ? "visible" : "hidden";
    } else {
      at(p.id).opacity = Math.min(1, Math.max(0, round2(evalOpacity(p.keys, t))));
    }
  }
  return out;
}

/**
 * The pose of a frame at `seconds` of the OUTPUT clock (speed applied, the loop wraps); time 0
 * is the rest frame. Undefined when nothing animates.
 */
export function assemblyFrame(
  am: AssemblyRenderModel | undefined,
  speed: number,
  seconds: number,
): Attrs | undefined {
  if (am === undefined) return undefined;
  const a = assemblyAnim(am, speed);
  if (a.props.length === 0) return undefined;
  const s = speed > 0 && Number.isFinite(speed) ? speed : 1;
  const loop = a.loop;
  const t = loop > 0 ? (((seconds * s) % loop) + loop) % loop : 0;
  return attrsAtLoop(a, t);
}

/** End pose of step `step` (1-based): where its closing hold ends, before the closing return. */
export function assemblyStepEnd(
  am: AssemblyRenderModel | undefined,
  speed: number,
  step: number,
): Attrs | undefined {
  if (am === undefined) return undefined;
  const a = assemblyAnim(am, speed);
  if (a.props.length === 0) return undefined;
  return attrsAtLoop(a, stepEndTime(a.ends[step - 1] ?? 0));
}

// ---------------------------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------------------------

/** CSS timing function of a key's easing (mirrors the depth order's curves: CSS keywords). */
function timing(e: Easing): string {
  if (e === "step") return "step-end";
  if (typeof e !== "string") {
    return e[0] === 0 && e[1] === 0 && e[2] === 1 && e[3] === 1
      ? "linear"
      : `cubic-bezier(${e.map(t4).join(",")})`;
  }
  return e;
}

export interface AssemblyRules {
  /** Loop rules (one per distinct animation, selectors grouped). */
  readonly rules: readonly string[];
  /** Reduced-motion rules: discrete per-step poses, each step showing its end pose. */
  readonly reduced: readonly string[];
  /** `budget/elements` warnings: tracks or wrappers above the animator's bounds. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Budget warnings of a speed's preparation (empty when every track fits). */
export function assemblyDiagnostics(a: AssemblyAnim): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (a.overKeys > 0) {
    out.push({
      severity: "warning",
      code: "budget/elements",
      path: "",
      message: `${a.overKeys} assembly track(s) keep more than ${MAX_KEYS} keyframes after thinning their linear runs.`,
      suggestion: "Use fewer concurrent moves with different timing, or split the assembly.",
    });
  }
  if (a.overProps > 0) {
    out.push({
      severity: "warning",
      code: "budget/elements",
      path: "",
      message: `${a.overProps} animated assembly wrapper(s) beyond ${MAX_PROPS} stay at the rest pose.`,
      suggestion: "Group parts into sub-assemblies that move as one, or split the assembly.",
    });
  }
  return out;
}

/** Stops of one property with a decl per key; consecutive stops at one percentage keep the last. */
function stopsOf(
  a: AssemblyAnim,
  p: AssemblyProp,
  decl: (i: number) => string,
): [number, string][] {
  const stops: [number, string][] = [];
  const n = p.keys.length;
  p.keys.forEach((k, i) => {
    const f = k.t / a.loop;
    const last = stops[stops.length - 1];
    if (last !== undefined && pct(last[0]) === pct(f)) stops[stops.length - 1] = [last[0], decl(i)];
    else stops.push([f, decl(i)]);
  });
  const first = (p.keys[0] as { t: number }).t;
  if (first > 0) stops.unshift([0, decl(0).replace(/;animation-timing-function:[^;]*/, "")]);
  const lastKey = p.keys[n - 1] as { t: number };
  if (lastKey.t < a.loop - 1e-9) {
    stops.push([1, decl(n - 1).replace(/;animation-timing-function:[^;]*/, "")]);
  }
  return stops;
}

/**
 * CSS of the loop. `total` is the loop length in seconds at the chosen speed; keyframe
 * percentages are times over the loop (speed cancels). Identical tracks share one `@keyframes`
 * through `kf`.
 */
export function assemblyLoop(
  am: AssemblyRenderModel,
  speed: number,
  ids: IdScheme,
  kf: Keyframes,
  total: number,
): AssemblyRules {
  const a = assemblyAnim(am, speed);
  const moving = a.props.filter((p) => !isConstant(p));
  const diagnostics = assemblyDiagnostics(a);
  if (!(a.loop > 0) || !(total > 0) || moving.length === 0) {
    return { rules: [], reduced: [], diagnostics };
  }
  const dur = `${t4(total)}s`;
  // An element can carry two properties (a label group moves and fades): one `animation` list.
  const perId = new Map<string, string[]>();
  const reducedPerId = new Map<string, string[]>();
  const put = (into: Map<string, string[]>, id: string, name: string, tf: string): void => {
    const one = `${name} ${dur} ${tf} infinite`;
    const l = into.get(id);
    if (l === undefined) into.set(id, [one]);
    else l.push(one);
  };

  const live = (p: AssemblyProp): { stops: [number, string][]; tf: string } => {
    if (p.kind === "transform") {
      const last = p.keys.length - 1;
      return {
        stops: stopsOf(
          a,
          p,
          (i) =>
            `transform:translate(${t4(p.keys[i]!.offset.x)}px,${t4(p.keys[i]!.offset.y)}px)${
              i < last ? `;animation-timing-function:${timing(p.keys[i]!.easing)}` : ""
            }`,
        ),
        tf: "linear",
      };
    }
    if (p.kind === "matrix") {
      return {
        stops: stopsOf(a, p, (i) => {
          const k = p.keys[i] as MatrixKey;
          return `transform:${matrixCss(k)}${i < p.keys.length - 1 ? ";animation-timing-function:linear" : ""}`;
        }),
        tf: "linear",
      };
    }
    if (p.kind === "opacity") {
      const last = p.keys.length - 1;
      return {
        stops: stopsOf(
          a,
          p,
          (i) =>
            `opacity:${t4(p.keys[i]!.opacity)}${
              i < last ? `;animation-timing-function:${timing(p.keys[i]!.easing)}` : ""
            }`,
        ),
        tf: "linear",
      };
    }
    const merged: [number, string][] = [];
    for (const k of p.keys) {
      const d = `visibility:${k.visible ? "visible" : "hidden"}`;
      const last = merged[merged.length - 1];
      if (last !== undefined && last[1] === d) continue;
      if (last !== undefined && pct(last[0]) === pct(k.t / a.loop))
        merged[merged.length - 1] = [last[0], d];
      else merged.push([k.t / a.loop, d]);
    }
    if (merged[0] !== undefined && merged[0][0] > 0) merged.unshift([0, merged[0][1]]);
    return { stops: merged, tf: "step-end" };
  };

  // Reduced motion: each step shows its end pose for the whole step, no tween.
  const discrete = (decl: (t: number) => string): [number, string][] => {
    const stops: [number, string][] = [];
    a.starts.forEach((s, i) => {
      const d = decl(stepEndTime(a.ends[i] as number));
      const last = stops[stops.length - 1];
      if (last === undefined || last[1] !== d) stops.push([s / a.loop, d]);
    });
    if (stops.length > 0 && (stops[0] as [number, string])[0] !== 0) {
      stops.unshift([0, (stops[0] as [number, string])[1]]);
    }
    return stops;
  };

  for (const p of moving) {
    const { stops, tf } = live(p);
    put(perId, p.id, kf.add(stops), tf);
    const rs =
      p.kind === "transform"
        ? discrete((t) => {
            const v = evalOffset(p.keys, t);
            return `transform:translate(${t4(round2(v.x))}px,${t4(round2(v.y))}px)`;
          })
        : p.kind === "matrix"
          ? discrete((t) => `transform:${matrixCss(placementAt(p.keys, t))}`)
          : p.kind === "opacity"
            ? discrete(
                (t) => `opacity:${t4(Math.min(1, Math.max(0, round2(evalOpacity(p.keys, t)))))}`,
              )
            : discrete((t) => `visibility:${evalVisible(p.keys, t) ? "visible" : "hidden"}`);
    put(reducedPerId, p.id, kf.add(rs), "step-end");
  }
  // Elements with the same animations share one rule (selectors grouped, in first-use order).
  const emit = (m: Map<string, string[]>): string[] => {
    const grouped = new Map<string, string[]>();
    for (const [id, anims] of m) {
      const decl = anims.join(",");
      const l = grouped.get(decl);
      if (l === undefined) grouped.set(decl, [ids.sel(id)]);
      else l.push(ids.sel(id));
    }
    return [...grouped].map(([decl, sels]) => `${sels.join(",")}{animation:${decl}}`);
  };
  return { rules: emit(perId), reduced: emit(reducedPerId), diagnostics };
}

/**
 * Settled time of step `i` on the output clock for the interactive Step button (§7.5): where the
 * assembly motion of the step has settled; undefined without actions.
 */
export function assemblySettled(
  am: AssemblyRenderModel | undefined,
  speed: number,
  i: number,
): number | undefined {
  const s = am?.settled[i];
  if (am === undefined || s === undefined) return undefined;
  const sp = speed > 0 && Number.isFinite(speed) ? speed : 1;
  return assemblyAnim(am, sp).warp(s) / sp;
}

/** Model accessor, as `boardsOf` for boards. */
export const assemblyOf = (model: RenderModel): AssemblyRenderModel | undefined => model.assembly;
