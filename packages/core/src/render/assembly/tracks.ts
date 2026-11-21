/**
 * Tracks of the assembly layer (docs/design/assemblies.md §9.4, §12): screen-space translation
 * keys per motion group, visibility keys from the depth epochs, opacity keys for stage fades,
 * and their exact evaluation (`frameAt`). Pure and deterministic; every number is rounded here
 * (times 4 decimals, coordinates and opacities 2), so the CSS keyframes B writes and the frame
 * attributes agree.
 *
 * Motion. A leaf's displacement is the sum of the moves of itself and its ancestors; the screen
 * is linear in it, so its track is the projected sum. Between two consecutive boundaries (every
 * move start and end, and every extra time such as an epoch start) the sum is EXACT when all
 * active moves share one window and curve (each term is `from + (to - from) * e(u)` with the same
 * `e`): that segment keeps the move's easing. Otherwise the segment is split recursively at its
 * midpoint until the chord is within `TOLERANCE_PX` of the true path (at most 2^7 pieces), the
 * key values being exact evaluations.
 */
import type {
  OpacityKey,
  Projection,
  TrackKey,
  Vec2,
  Vec3,
  VisibilityKey,
} from "../../contracts/index.js";
import { easeProgress, moveOffsetAt, movesPath, type LoopMove } from "../../depth/epochs.js";
import type { SpecEasing } from "../../schema/types.gen.js";
import { bezierProgress } from "../boards/timeline.js";
import { r4 } from "./loop.js";

const EPS = 1e-9;
/** Largest chord error (user units) of a sampled concurrent-curve segment. */
export const TOLERANCE_PX = 0.25;
const MAX_SPLIT = 7;

/** A loop move that plays a CSS cubic-bezier (the camera curve of the closure); depth sees `easing`. */
export type BezierMove = LoopMove;

type KeyEasing = TrackKey["easing"];

/** Progress of a key's easing at linear time `x` (clamped to 0..1). */
export function keyProgress(easing: KeyEasing, x: number): number {
  if (typeof easing !== "string") {
    return bezierProgress(easing as unknown as [number, number, number, number], x);
  }
  if (easing === "linear" || easing === "step") return Math.min(1, Math.max(0, x));
  return easeProgress(easing as SpecEasing, x);
}

/** Contribution of one move at `t`: depth's own function, bezier moves included. */
export const moveOffset = (m: BezierMove, t: number): Vec3 => moveOffsetAt(m, t);

const sameCurve = (a: BezierMove, b: BezierMove): boolean =>
  a.easing === b.easing &&
  (a.bezier === undefined
    ? b.bezier === undefined
    : b.bezier !== undefined && a.bezier.every((v, i) => v === (b.bezier as readonly number[])[i]));

/**
 * A step is `[start, next start)`: its end pose is the LEFT limit at its end time, so a move or
 * hide key that begins exactly there (a part lifting at the next step's first instant, its
 * top-face label hiding) has not happened yet. Invariant: `EPS` (1e-9) < STEP_END_LEFT < half
 * the 1e-4 grid of key times (`r4`), so the instant never crosses a key.
 */
export const STEP_END_LEFT = 1e-6;

/** Time at which the end pose of a step whose closing hold ends at `end` is read. */
export const stepEndTime = (end: number): number => Math.max(0, end - STEP_END_LEFT);

export const round2 = (v: number): number => Math.round(v * 100) / 100 + 0;

export interface SignedMove {
  readonly m: BezierMove;
  readonly sign: 1 | -1;
}

/** Moves by node path, for chain lookups (the node and its ancestors). */
export class MoveIndex {
  private readonly byPath = new Map<string, BezierMove[]>();
  constructor(readonly moves: readonly BezierMove[]) {
    for (const m of moves) {
      const l = this.byPath.get(m.path);
      if (l === undefined) this.byPath.set(m.path, [m]);
      else l.push(m);
    }
  }

  /** Moves of `path` and of its ancestors, ancestors first. */
  chain(path: string): BezierMove[] {
    const out: BezierMove[] = [];
    let at = -1;
    for (;;) {
      at = path.indexOf("/", at + 1);
      const prefix = at < 0 ? path : path.slice(0, at);
      const l = this.byPath.get(prefix);
      if (l !== undefined) out.push(...l);
      if (at < 0) break;
    }
    return out;
  }

  displacement(path: string, t: number): Vec3 {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const m of this.chain(path)) {
      const o = moveOffset(m, t);
      x += o.x;
      y += o.y;
      z += o.z;
    }
    return { x, y, z };
  }
}

/** Signed moves of `a` relative to `b`: moves both share (common ancestors) cancel. */
export function relativeMoves(a: readonly BezierMove[], b: readonly BezierMove[]): SignedMove[] {
  const inB = new Set(b);
  const inA = new Set(a);
  return [
    ...a.filter((m) => !inB.has(m)).map((m): SignedMove => ({ m, sign: 1 })),
    ...b.filter((m) => !inA.has(m)).map((m): SignedMove => ({ m, sign: -1 })),
  ];
}

export const plain = (moves: readonly BezierMove[]): SignedMove[] =>
  moves.map((m): SignedMove => ({ m, sign: 1 }));

export function valueAt(sm: readonly SignedMove[], t: number): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const { m, sign } of sm) {
    const o = moveOffset(m, t);
    x += sign * o.x;
    y += sign * o.y;
    z += sign * o.z;
  }
  return { x, y, z };
}

/** Screen translation of a world displacement (the projection is linear). */
export function screenOf(projection: Projection, v: Vec3): Vec2 {
  const o = projection.project({ x: 0, y: 0, z: 0 });
  const p = projection.project(v);
  return { x: p.x - o.x, y: p.y - o.y };
}

/** Boundary times of a set of moves (plus `extra`) inside [0, loop], sorted, unique, with 0 and loop. */
export function boundaries(
  sm: readonly SignedMove[],
  loop: number,
  extra: readonly number[] = [],
): number[] {
  const set = new Set<number>([0, r4(loop)]);
  for (const t of extra) if (t > EPS && t < loop - EPS) set.add(r4(t));
  for (const { m } of sm) {
    for (const t of [m.t0, m.t1]) if (t > EPS && t < loop - EPS) set.add(r4(t));
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Translation keys of a signed move set; empty when the group never leaves the origin. First key
 * at t = 0, last at `loop` (one key at 0 when `loop` is 0 and the group is displaced). `extra`
 * adds boundaries (epoch starts: a key at every instant the DOM swaps).
 */
export function offsetTrack(
  sm: readonly SignedMove[],
  loop: number,
  projection: Projection,
  extra: readonly number[] = [],
): TrackKey[] {
  if (sm.length === 0) return [];
  const times = boundaries(sm, loop, extra);
  const raw = (t: number): Vec2 => screenOf(projection, valueAt(sm, t));
  const at = (t: number): Vec2 => {
    const s = raw(t);
    return { x: round2(s.x), y: round2(s.y) };
  };
  const keys: TrackKey[] = [];
  const push = (k: TrackKey): void => {
    const last = keys[keys.length - 1];
    if (last !== undefined && Math.abs(last.t - k.t) < EPS) return;
    keys.push(k);
  };
  for (let i = 0; i + 1 < times.length; i++) {
    const a = times[i] as number;
    const b = times[i + 1] as number;
    const active = sm.filter(({ m }) => m.t1 - m.t0 > EPS && m.t0 <= a + 1e-6 && m.t1 >= b - 1e-6);
    const first = active[0]?.m;
    const exact =
      first !== undefined &&
      Math.abs(first.t0 - a) < 1e-6 &&
      Math.abs(first.t1 - b) < 1e-6 &&
      active.every(
        ({ m }) =>
          Math.abs(m.t0 - first.t0) < 1e-6 &&
          Math.abs(m.t1 - first.t1) < 1e-6 &&
          sameCurve(m, first),
      );
    if (active.length === 0) push({ t: a, offset: at(a), easing: "linear" });
    else if (exact) push({ t: a, offset: at(a), easing: first.bezier ?? first.easing });
    else {
      const cuts: number[] = [a];
      const split = (x0: number, x1: number, depth: number): void => {
        const mid = (x0 + x1) / 2;
        const p0 = raw(x0);
        const p1 = raw(x1);
        // an S-curve can cross its chord at the midpoint: test the quarter points too
        let err = 0;
        for (const f of [0.25, 0.5, 0.75]) {
          const pm = raw(x0 + (x1 - x0) * f);
          err = Math.max(
            err,
            Math.hypot(pm.x - (p0.x + (p1.x - p0.x) * f), pm.y - (p0.y + (p1.y - p0.y) * f)),
          );
        }
        if (depth < MAX_SPLIT && err > TOLERANCE_PX && x1 - x0 > 2e-4) {
          split(x0, mid, depth + 1);
          cuts.push(mid);
          split(mid, x1, depth + 1);
        }
      };
      split(a, b, 0);
      for (const ta of cuts) push({ t: r4(ta), offset: at(ta), easing: "linear" });
    }
  }
  const end = times[times.length - 1] as number;
  push({ t: end, offset: at(end), easing: "linear" });
  if (keys.every((k) => k.offset.x === 0 && k.offset.y === 0)) return [];
  return keys;
}

/** Value of a translation track at `t` (the CSS keyframes' value). */
export function evalOffset(keys: readonly TrackKey[], t: number): Vec2 {
  const first = keys[0];
  if (first === undefined) return { x: 0, y: 0 };
  if (t <= first.t + EPS) return first.offset;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i] as TrackKey;
    const b = keys[i + 1] as TrackKey;
    if (t < b.t - EPS) {
      if (a.easing === "step") return a.offset;
      const u = keyProgress(a.easing, (t - a.t) / (b.t - a.t));
      return {
        x: a.offset.x + (b.offset.x - a.offset.x) * u,
        y: a.offset.y + (b.offset.y - a.offset.y) * u,
      };
    }
  }
  return (keys[keys.length - 1] as TrackKey).offset;
}

/** `translate(x y)` value (2 decimals), always: full state, `translate(0 0)` included. */
export function translateFull(v: Vec2): string {
  return `translate(${round2(v.x)} ${round2(v.y)})`;
}

/** `translate(x y)` value (2 decimals), or undefined at the origin. */
export function translateOf(v: Vec2): string | undefined {
  const x = round2(v.x);
  const y = round2(v.y);
  return x === 0 && y === 0 ? undefined : `translate(${x} ${y})`;
}

// ---------------------------------------------------------------------------------------------
// Visibility and opacity
// ---------------------------------------------------------------------------------------------

/** Visibility keys from the epochs that contain the copy; empty when it is visible all the time. */
export function visibilityTrack(
  epochs: readonly { readonly t0: number; readonly visible: boolean }[],
  loop: number,
): VisibilityKey[] {
  const keys: VisibilityKey[] = [];
  for (const e of epochs) {
    const last = keys[keys.length - 1];
    if (last !== undefined && last.visible === e.visible) continue;
    keys.push({ t: r4(keys.length === 0 ? 0 : e.t0), visible: e.visible });
  }
  if (keys.every((k) => k.visible)) return [];
  const last = keys[keys.length - 1] as VisibilityKey;
  if (loop > 0 && last.t < loop - EPS) keys.push({ t: r4(loop), visible: last.visible });
  return keys;
}

export function evalVisible(keys: readonly VisibilityKey[], t: number): boolean {
  if (keys.length === 0) return true;
  let v = (keys[0] as VisibilityKey).visible;
  for (const k of keys) {
    if (k.t <= t + EPS) v = k.visible;
    else break;
  }
  return v;
}

/** Piecewise opacity from time windows `[a, b]` of value `value` and ramps of `ramp` seconds. */
export function windowsTrack(
  windows: readonly { readonly a: number; readonly b: number }[],
  value: number,
  loop: number,
  ramp = 0.2,
): OpacityKey[] {
  if (windows.length === 0 || loop <= 0) return [];
  const sorted = [...windows].sort((x, y) => x.a - y.a || x.b - y.b);
  const merged: { a: number; b: number }[] = [];
  for (const w of sorted) {
    const a = Math.max(0, Math.min(loop, w.a));
    const b = Math.max(a, Math.min(loop, w.b));
    const last = merged[merged.length - 1];
    if (last !== undefined && a <= last.b + EPS) last.b = Math.max(last.b, b);
    else merged.push({ a, b });
  }
  const keys: OpacityKey[] = [];
  const push = (t: number, opacity: number, easing: OpacityKey["easing"]): void => {
    const tt = r4(Math.max(0, Math.min(loop, t)));
    const last = keys[keys.length - 1];
    if (last !== undefined && tt <= last.t + EPS) {
      if (tt < last.t - EPS) return;
      keys[keys.length - 1] = { t: last.t, opacity: round2(opacity), easing };
      return;
    }
    keys.push({ t: tt, opacity: round2(opacity), easing });
  };
  if (merged[0] !== undefined && merged[0].a > EPS) push(0, 1, "linear");
  merged.forEach((w, i) => {
    const next = merged[i + 1];
    const rin = Math.max(1e-4, Math.min(ramp, (w.b - w.a) / 2));
    const room = (next === undefined ? loop : next.a) - w.b;
    const rout = Math.min(ramp, room / 2);
    push(w.a, 1, "ease-in-out");
    push(w.a + rin, value, "linear");
    if (w.b < loop - EPS) {
      push(w.b, value, "ease-in-out");
      push(w.b + Math.max(rout, 1e-4), 1, "linear");
    }
  });
  const last = keys[keys.length - 1] as OpacityKey;
  if (last.t < loop - EPS) push(loop, last.opacity, "linear");
  return keys;
}

/**
 * `windowsTrack` with a level per window: the opacity is the lowest level of the windows that
 * hold `t` (1 outside every window), with the same eased ramps at each change (a change ramps over
 * `ramp`, at most half the span that follows it). Used where windows of different levels overlap
 * (a cable hidden while its slot is displaced inside a fade-others window).
 */
export function levelsTrack(
  windows: readonly { readonly a: number; readonly b: number; readonly value: number }[],
  loop: number,
  ramp = 0.2,
): OpacityKey[] {
  if (windows.length === 0 || loop <= 0) return [];
  const clamp = (t: number): number => Math.max(0, Math.min(loop, t));
  const cuts = [...new Set([0, loop, ...windows.flatMap((w) => [clamp(w.a), clamp(w.b)])])].sort(
    (x, y) => x - y,
  );
  // piecewise-constant level, adjacent equal spans merged
  const spans: { a: number; b: number; v: number }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    if (b - a <= EPS) continue;
    const mid = (a + b) / 2;
    let v = 1;
    for (const w of windows) if (w.a <= mid && mid <= w.b) v = Math.min(v, w.value);
    const last = spans[spans.length - 1];
    if (last !== undefined && last.v === v) last.b = b;
    else spans.push({ a, b, v });
  }
  if (spans.every((x) => x.v === 1)) return [];
  const keys: OpacityKey[] = [];
  const push = (t: number, opacity: number, easing: OpacityKey["easing"]): void => {
    const tt = r4(clamp(t));
    const last = keys[keys.length - 1];
    if (last !== undefined && tt <= last.t + EPS) {
      if (tt < last.t - EPS) return;
      keys[keys.length - 1] = { t: last.t, opacity: round2(opacity), easing };
      return;
    }
    keys.push({ t: tt, opacity: round2(opacity), easing });
  };
  let level = 1;
  if ((spans[0] as { v: number }).v === 1) push(0, 1, "linear");
  for (const sp of spans) {
    if (sp.v !== level) {
      const r = Math.max(1e-4, Math.min(ramp, (sp.b - sp.a) / 2));
      push(sp.a, level, "ease-in-out");
      push(sp.a + r, sp.v, "linear");
      level = sp.v;
    }
  }
  const last = keys[keys.length - 1] as OpacityKey;
  if (last.t < loop - EPS) push(loop, last.opacity, "linear");
  return keys;
}

/**
 * Loop windows in which any of `paths` is away from its rest pose (the displacement of the node,
 * its own moves and its ancestors', is not zero), merged; sorted. Exact between move breakpoints.
 */
export function displacedWindows(
  index: MoveIndex,
  paths: readonly string[],
  loop: number,
): { a: number; b: number }[] {
  const moves = paths.flatMap((p) => index.chain(p));
  if (moves.length === 0 || loop <= 0) return [];
  const cuts = [
    ...new Set([
      0,
      loop,
      ...moves.flatMap((m) => [m.t0, m.t1]).map((t) => Math.max(0, Math.min(loop, t))),
    ]),
  ].sort((x, y) => x - y);
  const out: { a: number; b: number }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    if (b - a <= EPS) continue;
    const mid = (a + b) / 2;
    const away = paths.some((p) => {
      const d = index.displacement(p, mid);
      return Math.abs(d.x) + Math.abs(d.y) + Math.abs(d.z) > 1e-9;
    });
    if (!away) continue;
    const last = out[out.length - 1];
    if (last !== undefined && a <= last.b + EPS) last.b = b;
    else out.push({ a, b });
  }
  return out;
}

/** The parts of `[0, loop]` outside the sorted, disjoint `windows`, as presence windows. */
export function complementWindows(
  windows: readonly { readonly a: number; readonly b: number }[],
  loop: number,
): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  for (const w of windows) {
    if (w.a > at + EPS) out.push([at, w.a]);
    at = Math.max(at, w.b);
  }
  if (loop > at + EPS) out.push([at, loop]);
  return out;
}

export function evalOpacity(keys: readonly OpacityKey[], t: number): number {
  const first = keys[0];
  if (first === undefined) return 1;
  if (t <= first.t + EPS) return first.opacity;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i] as OpacityKey;
    const b = keys[i + 1] as OpacityKey;
    if (t < b.t - EPS) {
      if (a.easing === "step") return a.opacity;
      const u = keyProgress(a.easing, (t - a.t) / (b.t - a.t));
      return a.opacity + (b.opacity - a.opacity) * u;
    }
  }
  return (keys[keys.length - 1] as OpacityKey).opacity;
}

export { movesPath };
