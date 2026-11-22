/**
 * Motion of one figure sprite over the master loop (docs/design/assemblies.md §7): the plan's
 * actions become segments between the seated (0) and exploded (1) position, then pose keys,
 * label fades and arrow fades. Pure and deterministic.
 */
import type { AssemblyStepPlan, SceneGraph } from "../../contracts/index.js";
import {
  stepWindows,
  type Bezier,
  type FigureSegment,
  type StepWindow,
} from "../../scene/boards.js";
import { LOOP_START_MIN } from "../../scene/assembly/build.js";
import type { FadeKey, KeyEasing, PoseKey } from "./types.js";

export const LINEAR: Bezier = [0, 0, 1, 1];
/** The camera's curve (`anim/index.ts` EASE): the fast return of the loop closure uses it too. */
export const CLOSURE_EASE: Bezier = [0.4, 0, 0.2, 1];
/** Label fade-in after a part arrives: ends inside the 0.2 s hold of §7.3. */
export const FADE_IN = 0.2;
const FADE_OUT = 0.2;

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Position of a sprite between its seat (0) and exploded (1) place. */
export interface Seg {
  readonly t0: number;
  readonly t1: number;
  readonly from: number;
  readonly to: number;
  readonly easing: Bezier;
  /** True for the fast return of the loop closure (no arrow, no label of its own). */
  readonly closure: boolean;
}

export interface StepTime {
  readonly start: number;
  readonly duration: number;
  /** Motion window opens (`T + lead`). */
  readonly open: number;
  /** `T + d − tr`: the closing hold ends, the camera transition (if any) begins. */
  readonly end: number;
  readonly window: StepWindow;
}

/** Seconds the loop-start fades of the scene's assemblies last (0 without any, §7.4). */
export function loopStartHold(scene: SceneGraph): number {
  let hold = 0;
  for (const a of scene.assemblies?.assemblies ?? [])
    for (const f of a.loopStart?.fades ?? []) hold = Math.max(hold, f.t1);
  return hold;
}

/** Step windows on the master loop; views are the scene's own (`SceneStep.focus`). */
export function stepTimes(
  scene: SceneGraph,
  speed: number,
  closeLast: boolean,
): { times: StepTime[]; total: number } {
  const tl = scene.timeline;
  const wins = stepWindows(
    tl.map((s) => s.duration),
    tl.map((s) => s.focus),
    closeLast,
    loopStartHold(scene),
  );
  // The camera's transition is `min(0.8, 0.25 d / speed)` seconds on the OUTPUT clock; in loop
  // seconds that is `min(0.8 speed, 0.25 d)`, so a board's windows meet the camera's.
  const loopSeconds = (on: number, d: number): number =>
    on > 0 ? r4(Math.min(0.8 * speed, 0.25 * d)) : 0;
  let t = 0;
  const times = tl.map((s, i) => {
    const w = wins[i] as StepWindow;
    const window: StepWindow = {
      lead: loopSeconds(w.lead, s.duration),
      tr: loopSeconds(w.tr, s.duration),
      hold: w.hold,
      window: w.window,
    };
    // the hold is on the output clock (§7.3): `max(lead_out, 0.4)`, in loop seconds `· speed`
    const holdLoop = w.hold > 0 ? Math.max(window.lead / speed, LOOP_START_MIN) * speed : 0;
    const start = r4(t);
    t += s.duration;
    return {
      start,
      duration: s.duration,
      // the motion opens after the camera's lead and after the loop-start fades (§7.4)
      open: r4(start + Math.max(window.lead, holdLoop)),
      end: r4(start + s.duration - window.tr),
      window,
    };
  });
  return { times, total: r4(t) };
}

/** Eased progress of a cubic-bezier at linear time `x` in 0..1 (bisection on the x curve). */
export function bezierProgress(b: Bezier, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = b;
  const bez = (a: number, c: number, u: number): number =>
    3 * a * u * (1 - u) ** 2 + 3 * c * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return bez(y1, y2, (lo + hi) / 2);
}

/**
 * Segments of one part: its moves in every action of the plan, placed in the motion window of
 * the step. Moves are clamped to the step (and, in the last step, to the start of the closing
 * return). A move that starts before the previous one ended cuts it there: the previous move
 * then ends at the position it had reached, and the new one starts from it, so a pose never
 * jumps. The loop closure (§7.4) is appended: during the last step's closing transition the part
 * returns to its base pose; when that transition is 0 (the last step has no zoom) there is no
 * window to ease in, so the closure is the cut at the loop end (the animation restarts at the
 * base pose).
 */
export function partSegments(
  figureId: string,
  segment: (from: number, to: number) => FigureSegment,
  partId: string,
  plan: readonly AssemblyStepPlan[],
  times: readonly StepTime[],
  total: number,
  base: number,
): { segs: Seg[]; end: number } {
  const raw: { t0: number; t1: number; dir: 0 | 1; easing: Bezier }[] = [];
  times.forEach((st, i) => {
    const limit =
      i === times.length - 1 && st.window.tr > 0
        ? r4(total - st.window.tr)
        : r4(st.start + st.duration);
    for (const a of plan[i]?.actions ?? []) {
      if (a.target !== figureId || a.from === a.to) continue;
      const seg = segment(a.from, a.to);
      for (const mv of seg.moves) {
        if (mv.part !== partId) continue;
        const t0 = r4(st.open + a.start + mv.start * a.scale);
        if (t0 >= limit) continue;
        const t1 = Math.min(limit, r4(t0 + mv.duration * a.scale));
        raw.push({ t0, t1, dir: mv.reversed ? 0 : 1, easing: mv.bezier });
      }
    }
  });
  raw.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);

  const segs: Seg[] = [];
  let pos = base;
  for (const m of raw) {
    const prev = segs[segs.length - 1];
    if (prev !== undefined && m.t0 < prev.t1) {
      const u = prev.t1 === prev.t0 ? 1 : (m.t0 - prev.t0) / (prev.t1 - prev.t0);
      pos = prev.from + (prev.to - prev.from) * bezierProgress(prev.easing, u);
      segs[segs.length - 1] = { ...prev, t1: m.t0, to: pos };
    }
    segs.push({ t0: m.t0, t1: m.t1, from: pos, to: m.dir, easing: m.easing, closure: false });
    pos = m.dir;
  }
  const last = times[times.length - 1];
  if (last !== undefined && last.window.tr > 0 && pos !== base && total > 0) {
    segs.push({
      t0: r4(total - last.window.tr),
      t1: total,
      from: pos,
      to: base,
      easing: CLOSURE_EASE,
      closure: true,
    });
    pos = base;
  }
  return { segs, end: pos };
}

/** Pose keys (position fraction times the seat → exploded offset) of a part's segments. */
export function poseKeys(
  segs: readonly Seg[],
  base: number,
  offset: { readonly x: number; readonly y: number },
  total: number,
): PoseKey[] {
  const at = (p: number, t: number, easing: KeyEasing): PoseKey => ({
    t,
    x: round2(offset.x * p),
    y: round2(offset.y * p),
    easing,
  });
  const out: PoseKey[] = [];
  const push = (k: PoseKey): void => {
    const last = out[out.length - 1];
    if (last !== undefined && last.t === k.t) out[out.length - 1] = k;
    else out.push(k);
  };
  push(at(base, 0, LINEAR));
  let pos = base;
  for (const s of segs) {
    push(at(pos, s.t0, s.easing));
    push(at(s.to, s.t1, LINEAR));
    pos = s.to;
  }
  push(at(pos, total, LINEAR));
  // Drop keys that sit between two equal ones: nothing moves there.
  return out.filter(
    (k, i) =>
      i === 0 ||
      i === out.length - 1 ||
      !(same(k, out[i - 1] as PoseKey) && same(k, out[i + 1] as PoseKey)),
  );
}

const same = (a: PoseKey, b: PoseKey): boolean => a.x === b.x && a.y === b.y;
const round2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};

/** One time the part stands still at a pose: when its label fades in and out. */
interface Rest {
  readonly pose: 0 | 1;
  readonly inStart: number;
  readonly inEnd: number;
  readonly outStart: number;
  readonly outEnd: number;
}

function rests(segs: readonly Seg[], base: number, total: number): Rest[] {
  const out: Rest[] = [];
  let pos = base;
  let prev: Seg | undefined;
  /** The part stands at `pos` from its arrival (after `prev`) until `until`, when `next` starts. */
  const rest = (until: number, next: Seg | undefined): void => {
    if (pos !== 0 && pos !== 1) return;
    // Visible at once at the loop start; after a move the label fades in (after the closure
    // return, during the second half of that move).
    const inStart =
      prev === undefined ? 0 : prev.closure ? r4(prev.t0 + (prev.t1 - prev.t0) / 2) : prev.t1;
    const inEnd =
      prev === undefined ? 0 : prev.closure ? prev.t1 : Math.min(total, r4(prev.t1 + FADE_IN));
    // A zero-length rest (the next move starts as soon as the last one ended) shows no label.
    if (until <= inStart && !(prev === undefined && (until > 0 || next === undefined))) return;
    const outEnd =
      next === undefined
        ? until
        : Math.min(r4(until + FADE_OUT), r4(until + (next.t1 - next.t0) / 2));
    out.push({ pose: pos, inStart, inEnd: Math.min(inEnd, until), outStart: until, outEnd });
  };
  for (const s of segs) {
    rest(s.t0, s);
    pos = s.to;
    prev = s;
  }
  rest(total, undefined);
  return out;
}

/** Opacity keys of the label of `pose`: fades in on arrival, out when the part leaves. */
export function labelKeys(
  segs: readonly Seg[],
  base: number,
  pose: 0 | 1,
  total: number,
): FadeKey[] {
  const mine = rests(segs, base, total).filter((r) => r.pose === pose);
  if (mine.length === 0) return [];
  const pts: [number, number][] = [];
  const add = (t: number, v: number): void => {
    const last = pts[pts.length - 1];
    if (last !== undefined && last[0] === t) pts[pts.length - 1] = [t, v];
    else pts.push([t, v]);
  };
  for (const r of mine) {
    if (r.inStart > 0 || r.inEnd > 0) {
      add(r.inStart, 0);
      add(r.inEnd, 1);
    } else add(0, 1);
    add(r.outStart, 1);
    if (r.outEnd > r.outStart) add(r.outEnd, 0);
  }
  if (pts[0]?.[0] !== 0) pts.unshift([0, 0]);
  if ((pts[pts.length - 1] as [number, number])[0] < total) {
    pts.push([total, (pts[pts.length - 1] as [number, number])[1]]);
  }
  return fadeKeys(pts);
}

/** Opacity keys of the motion arrow of one direction (fades in and out over a quarter of each move). */
export function arrowKeys(segs: readonly Seg[], forward: boolean, total: number): FadeKey[] {
  const mine = segs.filter((s) => !s.closure && s.t1 > s.t0 && s.to > s.from === forward);
  if (mine.length === 0) return [];
  const pts: [number, number][] = [[0, 0]];
  const add = (t: number, v: number): void => {
    const last = pts[pts.length - 1] as [number, number];
    if (last[0] === t) pts[pts.length - 1] = [t, Math.max(last[1], v)];
    else pts.push([t, v]);
  };
  for (const s of mine) {
    const q = r4((s.t1 - s.t0) / 4);
    add(s.t0, 0);
    add(r4(s.t0 + q), 1);
    add(r4(s.t1 - q), 1);
    add(s.t1, 0);
  }
  add(total, 0);
  return fadeKeys(pts);
}

function fadeKeys(pts: readonly [number, number][]): FadeKey[] {
  const keys: FadeKey[] = pts.map(([t, v]) => ({ t, v, easing: LINEAR }));
  return keys.filter(
    (k, i) =>
      i === 0 ||
      i === keys.length - 1 ||
      !(k.v === (keys[i - 1] as FadeKey).v && k.v === (keys[i + 1] as FadeKey).v),
  );
}
