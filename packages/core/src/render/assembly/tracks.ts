/**
 * Tracks of the assembly layer (docs/design/assemblies.md §9.4, §12): screen-space translation
 * keys per motion group, visibility keys from the depth epochs, opacity keys for stage fades,
 * and their exact evaluation (`frameAt`). Pure and deterministic; every number is rounded here
 * (times 4 decimals, coordinates and opacities 2), so the CSS keyframes B writes and the frame
 * attributes agree.
 *
 * Motion. A leaf's displacement is the sum of the moves of itself and its ancestors; the screen
 * is linear in it, so its track is the projected sum. Between two consecutive boundaries (every
 * move start and end) the sum is EXACT when all active moves share one window and easing (each
 * term is `from + (to - from) * e(u)` with the same `e`): that segment keeps the move's easing.
 * Otherwise (a boundary of another move falls inside a window, or different easings overlap) the
 * segment is sampled in `SUBSTEPS` linear pieces evaluated exactly at their ends, so the key
 * values are on the true path and the error is bounded by the curve's bend within one piece.
 */
import type { OpacityKey, TrackKey, Vec2, Vec3, VisibilityKey } from "../../contracts/index.js";
import { easeProgress, moveOffsetAt, movesPath, type LoopMove } from "../../depth/epochs.js";
import type { Projection } from "../../contracts/index.js";
import { r4 } from "./loop.js";

const EPS = 1e-9;
/** Pieces of a segment whose active moves do not share one curve. */
export const SUBSTEPS = 8;

export const round2 = (v: number): number => Math.round(v * 100) / 100 + 0;

export interface SignedMove {
  readonly m: LoopMove;
  readonly sign: 1 | -1;
}

/** Moves by node path, for chain lookups (the node and its ancestors). */
export class MoveIndex {
  private readonly byPath = new Map<string, LoopMove[]>();
  constructor(readonly moves: readonly LoopMove[]) {
    for (const m of moves) {
      const l = this.byPath.get(m.path);
      if (l === undefined) this.byPath.set(m.path, [m]);
      else l.push(m);
    }
  }

  /** Moves of `path` and of its ancestors, ancestors first. */
  chain(path: string): LoopMove[] {
    const out: LoopMove[] = [];
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
      const o = moveOffsetAt(m, t);
      x += o.x;
      y += o.y;
      z += o.z;
    }
    return { x, y, z };
  }
}

/** Signed moves of `a` relative to `b`: moves both share (common ancestors) cancel. */
export function relativeMoves(a: readonly LoopMove[], b: readonly LoopMove[]): SignedMove[] {
  const inB = new Set(b);
  const inA = new Set(a);
  return [
    ...a.filter((m) => !inB.has(m)).map((m): SignedMove => ({ m, sign: 1 })),
    ...b.filter((m) => !inA.has(m)).map((m): SignedMove => ({ m, sign: -1 })),
  ];
}

export const plain = (moves: readonly LoopMove[]): SignedMove[] =>
  moves.map((m): SignedMove => ({ m, sign: 1 }));

function valueAt(sm: readonly SignedMove[], t: number): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const { m, sign } of sm) {
    const o = moveOffsetAt(m, t);
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

/** Boundary times of a set of moves inside [0, loop], sorted, unique, always with 0 and loop. */
export function boundaries(sm: readonly SignedMove[], loop: number): number[] {
  const set = new Set<number>([0, r4(loop)]);
  for (const { m } of sm) {
    for (const t of [m.t0, m.t1]) if (t > EPS && t < loop - EPS) set.add(r4(t));
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Translation keys of a signed move set; empty when the group never leaves the origin. First key
 * at t = 0, last at `loop` (one key at 0 when `loop` is 0 and the group is displaced).
 */
export function offsetTrack(
  sm: readonly SignedMove[],
  loop: number,
  projection: Projection,
): TrackKey[] {
  if (sm.length === 0) return [];
  const times = boundaries(sm, loop);
  const at = (t: number): Vec2 => {
    const s = screenOf(projection, valueAt(sm, t));
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
          m.easing === first.easing,
      );
    if (active.length === 0) push({ t: a, offset: at(a), easing: "linear" });
    else if (exact) push({ t: a, offset: at(a), easing: first.easing });
    else {
      for (let k = 0; k < SUBSTEPS; k++) {
        const ta = r4(a + ((b - a) * k) / SUBSTEPS);
        push({ t: ta, offset: at(ta), easing: "linear" });
      }
    }
  }
  push({
    t: times[times.length - 1] as number,
    offset: at(times[times.length - 1] as number),
    easing: "linear",
  });
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
      const u =
        a.easing === "linear"
          ? (t - a.t) / (b.t - a.t)
          : easeProgress(a.easing, (t - a.t) / (b.t - a.t));
      return {
        x: a.offset.x + (b.offset.x - a.offset.x) * u,
        y: a.offset.y + (b.offset.y - a.offset.y) * u,
      };
    }
  }
  return (keys[keys.length - 1] as TrackKey).offset;
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

export function evalOpacity(keys: readonly OpacityKey[], t: number): number {
  const first = keys[0];
  if (first === undefined) return 1;
  if (t <= first.t + EPS) return first.opacity;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i] as OpacityKey;
    const b = keys[i + 1] as OpacityKey;
    if (t < b.t - EPS) {
      if (a.easing === "step") return a.opacity;
      const u =
        a.easing === "linear"
          ? (t - a.t) / (b.t - a.t)
          : easeProgress(a.easing, (t - a.t) / (b.t - a.t));
      return a.opacity + (b.opacity - a.opacity) * u;
    }
  }
  return (keys[keys.length - 1] as OpacityKey).opacity;
}

export { movesPath };
