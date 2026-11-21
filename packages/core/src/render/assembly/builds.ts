/**
 * Appearance of built parts (Track B, B-3; docs/design/assemblies.md §6.5, §6.6, §7.4): which
 * leaves exist when, as visibility and opacity tracks. A built leaf appears when its move
 * starts (hidden before) and fades in over `BUILD_FADE`; an unbuilt leaf fades out before it
 * vanishes at the end of its reversed move (the exact mirror). The loop start fades come from the
 * contract (`SceneAssembly.loopStart`: one `LoopFade` per leaf), never recomputed; the loop
 * closure fades parts present at rest but not at the end in (and the others out) over the last
 * step's closing window. Pure and deterministic.
 */
import type { LoopFade, OpacityKey, VisibilityKey } from "../../contracts/index.js";
import { r4 } from "./loop.js";
import { evalVisible, round2 } from "./tracks.js";

/** Length of a build fade-in or unbuild fade-out, seconds (speed 1; the warp retimes it). */
export const BUILD_FADE = 0.2;
const EPS = 1e-9;
/** Shortest fade-out of the loop start: the rest frame at time 0 is the base pose. */
const CUT = 1e-4;

/** A leaf appears or vanishes at `t` (loop seconds); `floor` is where its action started. */
export interface PresenceEvent {
  readonly t: number;
  readonly visible: boolean;
  readonly floor: number;
}

/** Presence of one leaf of a build program on the loop. */
export interface LeafPresence {
  /** Present when the timeline starts (the first action's level). */
  readonly start: boolean;
  /** Sorted by time. */
  readonly events: PresenceEvent[];
}

export interface PresenceTracks {
  readonly visibility: VisibilityKey[];
  readonly opacity: OpacityKey[];
}

interface Ramp {
  readonly t0: number;
  readonly t1: number;
  readonly from: number;
  readonly to: number;
}

/** Whether the leaf is present at rest (the base pose): the loop start fade says it. */
export const baseOf = (p: LeafPresence, fade: LoopFade | undefined): boolean =>
  fade === undefined ? p.start : fade.from === 1;

/** Whether the leaf is present at the end of the loop, before the closure. */
export const finalOf = (p: LeafPresence): boolean =>
  p.events.length === 0 ? p.start : (p.events[p.events.length - 1] as PresenceEvent).visible;

/**
 * Where the loop start fade-out of a leaf ends (the fade of the contract, cut short when the
 * leaf's own build starts first, and never shorter than `CUT` so the rest frame, time 0, still
 * shows the base pose). Fades in end where the contract says.
 */
export function fadeEnd(fade: LoopFade, p: LeafPresence): number {
  if (fade.to === 1) return r4(fade.t1);
  const first = p.events.find((e) => e.visible);
  return r4(Math.max(Math.min(fade.t1, first?.t ?? Infinity), CUT));
}

/**
 * Visibility and opacity keys of a leaf: the loop start fade (`fade`), its appearance events and
 * the closure fade over `closure` (when the end differs from rest). Empty tracks when the leaf
 * is present and opaque all the time.
 */
export function presenceTracks(
  p: LeafPresence,
  fade: LoopFade | undefined,
  loop: number,
  closure: { readonly t0: number; readonly t1: number } | undefined,
): PresenceTracks {
  const vis: { t: number; visible: boolean }[] = [];
  const ramps: Ramp[] = [];
  const setVis = (t: number, visible: boolean): void => {
    const last = vis[vis.length - 1];
    if (last !== undefined && last.t >= t - EPS) vis[vis.length - 1] = { t: last.t, visible };
    else if (last === undefined || last.visible !== visible) vis.push({ t, visible });
  };
  const out = fade === undefined ? 0 : fadeEnd(fade, p);
  if (fade !== undefined) {
    setVis(0, true);
    ramps.push({ t0: r4(fade.t0), t1: out, from: fade.from, to: fade.to });
    setVis(out, fade.to === 1);
  } else {
    setVis(0, p.start);
  }
  p.events.forEach((e, i) => {
    const prev = p.events[i - 1]?.t ?? 0;
    const next = p.events[i + 1]?.t ?? loop;
    if (e.visible) {
      const t = Math.max(e.t, out);
      setVis(t, true);
      ramps.push({ t0: t, t1: Math.min(r4(t + BUILD_FADE), next), from: 0, to: 1 });
    } else {
      ramps.push({ t0: Math.max(r4(e.t - BUILD_FADE), prev, e.floor), t1: e.t, from: 1, to: 0 });
      setVis(e.t, false);
    }
  });
  if (closure !== undefined && finalOf(p) !== baseOf(p, fade)) {
    if (baseOf(p, fade)) {
      setVis(closure.t0, true);
      ramps.push({ t0: closure.t0, t1: closure.t1, from: 0, to: 1 });
    } else {
      ramps.push({ t0: closure.t0, t1: closure.t1, from: 1, to: 0 });
    }
  }

  const visibility: VisibilityKey[] = [];
  if (vis.some((v) => !v.visible)) {
    for (const v of vis) visibility.push({ t: v.t, visible: v.visible });
    const last = visibility[visibility.length - 1] as VisibilityKey;
    if (loop > 0 && last.t < loop - EPS) visibility.push({ t: r4(loop), visible: last.visible });
  }

  const opacity: OpacityKey[] = [];
  const push = (t: number, v: number, easing: OpacityKey["easing"]): void => {
    const last = opacity[opacity.length - 1];
    const k = { t: r4(t), opacity: round2(v), easing };
    if (last !== undefined && k.t <= last.t + EPS)
      opacity[opacity.length - 1] = { ...k, t: last.t };
    else opacity.push(k);
  };
  const sorted = [...ramps].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  for (const r of sorted) {
    if (opacity.length === 0 && r.t0 > EPS) push(0, r.from, "step");
    else if (opacity.length > 0 && (opacity[opacity.length - 1] as OpacityKey).t < r.t0 - EPS) {
      // hold the previous value until the next ramp starts
      const prev = opacity[opacity.length - 1] as OpacityKey;
      opacity[opacity.length - 1] = { ...prev, easing: "step" };
    }
    push(r.t0, r.from, "linear");
    push(r.t1, r.to, "linear");
  }
  const lastKey = opacity[opacity.length - 1];
  if (lastKey !== undefined && lastKey.t < loop - EPS) push(loop, lastKey.opacity, "linear");
  return { visibility, opacity };
}

/** AND of two visibility tracks (an empty track is visible all the time). */
export function andVisibility(
  a: readonly VisibilityKey[],
  b: readonly VisibilityKey[],
  loop: number,
): VisibilityKey[] {
  if (b.length === 0) return [...a];
  if (a.length === 0) return [...b];
  const times = [...new Set([...a.map((k) => k.t), ...b.map((k) => k.t)])].sort((x, y) => x - y);
  const out: VisibilityKey[] = [];
  for (const t of times) {
    const visible = evalVisible(a, t) && evalVisible(b, t);
    const last = out[out.length - 1];
    if (last === undefined || last.visible !== visible) out.push({ t, visible });
  }
  const last = out[out.length - 1] as VisibilityKey;
  if (loop > 0 && last.t < loop - EPS) out.push({ t: r4(loop), visible: last.visible });
  return out;
}

/** Windows `[t0, t1]` in which a leaf exists (visibility keys), for the depth order's `present`. */
export function presentWindows(
  keys: readonly VisibilityKey[],
  loop: number,
): [number, number][] | undefined {
  if (keys.length === 0) return undefined;
  const out: [number, number][] = [];
  keys.forEach((k, i) => {
    const t1 = i + 1 < keys.length ? (keys[i + 1] as VisibilityKey).t : loop;
    if (k.visible && t1 > k.t + EPS) out.push([k.t, t1]);
  });
  return out;
}
