/**
 * Animation of figure boards (Track B, R-1; docs/design/assemblies.md §7.5, §12): the sprite and
 * fade tracks of `render/boards` as CSS keyframes (loop, interactive, reduced motion) and as
 * attribute overrides (frame and per-step outputs, where resvg has no CSS animation). Both read
 * the same keys through `poseAt` / `fadeAt`, so a frame equals the CSS pose at the same time.
 * Pose motion is CSS in both `smil` and `css` motion modes (D32): no SMIL element is made here.
 */
import type { IdScheme } from "../contracts/index.js";
import { bezierProgress } from "../render/boards/timeline.js";
import type { BoardsModel, FadeKey, KeyEasing, PoseKey } from "../render/boards/types.js";
import { Keyframes, r2, t4 } from "./css.js";

type Attrs = Record<string, Record<string, string | number>>;

/** Value of a keyed track at loop time `t` (speed 1): piecewise, eased per segment. */
function sample<K extends { readonly t: number; readonly easing: KeyEasing }>(
  keys: readonly K[],
  t: number,
  at: (k: K) => readonly number[],
): number[] {
  const first = keys[0] as K;
  if (t <= first.t) return [...at(first)];
  const last = keys[keys.length - 1] as K;
  if (t >= last.t) return [...at(last)];
  let i = 0;
  while (i < keys.length - 2 && t >= (keys[i + 1] as K).t) i++;
  const a = keys[i] as K;
  const b = keys[i + 1] as K;
  const va = at(a);
  if (a.easing === "step") return [...va];
  const f = bezierProgress(a.easing, (t - a.t) / (b.t - a.t));
  const vb = at(b);
  return va.map((v, j) => v + ((vb[j] as number) - v) * f);
}

export function poseAt(keys: readonly PoseKey[], t: number): { x: number; y: number } {
  const [x, y] = sample(keys, t, (k) => [k.x, k.y]) as [number, number];
  return { x, y };
}

export function fadeAt(keys: readonly FadeKey[], t: number): number {
  return (sample(keys, t, (k) => [k.v]) as [number])[0];
}

const timing = (e: KeyEasing): string =>
  e === "step"
    ? "step-end"
    : e[0] === 0 && e[1] === 0 && e[2] === 1 && e[3] === 1
      ? "linear"
      : `cubic-bezier(${e.map(t4).join(",")})`;

const translate = (x: number, y: number): string => `translate(${r2(x)} ${r2(y)})`;

/** Attribute overrides for every track at loop time `t` (speed 1, the loop's own clock). */
export function boardsAt(bm: BoardsModel, t: number): Attrs {
  const out: Attrs = {};
  for (const p of bm.poses) {
    const { x, y } = poseAt(p.keys, t);
    out[p.id] = { transform: translate(x, y) };
  }
  for (const f of bm.fades)
    out[f.id] = { opacity: Math.min(1, Math.max(0, r2(fadeAt(f.keys, t)))) };
  return out;
}

/** The pose of a frame at `seconds` of the output clock (speed applied); time 0 is the rest frame. */
export function boardsFrame(bm: BoardsModel, seconds: number, speed: number): Attrs | undefined {
  if (bm.poses.length === 0 && bm.fades.length === 0) return undefined;
  const loop = bm.loop;
  if (!(loop > 0)) return boardsAt(bm, 0);
  const t = (((seconds * speed) % loop) + loop) % loop;
  return boardsAt(bm, t);
}

/** End pose of step `step` (1-based): read where its closing hold ends, before the closing return. */
export function boardsStepEnd(bm: BoardsModel, step: number): Attrs | undefined {
  if (bm.poses.length === 0 && bm.fades.length === 0) return undefined;
  const end = bm.stepEnds[step - 1];
  return boardsAt(bm, end ?? 0);
}

export interface BoardRules {
  /** Loop rules (animation per track). */
  readonly rules: readonly string[];
  /** Reduced-motion rules: discrete per-step poses, each step showing its end pose. */
  readonly reduced: readonly string[];
}

/**
 * CSS of the loop. `total` is the loop length in seconds at the chosen speed; keyframe
 * percentages are times over the loop (speed cancels). Identical tracks share one `@keyframes`
 * through `kf`.
 */
export function boardsLoop(
  bm: BoardsModel,
  ids: IdScheme,
  kf: Keyframes,
  total: number,
): BoardRules {
  const rules: string[] = [];
  const reduced: string[] = [];
  if (!(bm.loop > 0) || total <= 0) return { rules, reduced };
  const loop = bm.loop;
  const dur = `${t4(total)}s`;
  const lastOf = <T>(a: readonly T[]): T => a[a.length - 1] as T;
  const rule = (id: string, name: string, tf: string): string =>
    `${ids.sel(id)}{animation:${name} ${dur} ${tf} infinite}`;

  for (const p of bm.poses) {
    const stops = p.keys.map((k, i): [number, string] => [
      k.t / loop,
      `transform:translate(${t4(k.x)}px,${t4(k.y)}px)${i < p.keys.length - 1 ? `;animation-timing-function:${timing(k.easing)}` : ""}`,
    ]);
    rules.push(rule(p.id, kf.add(stops), "linear"));
  }
  for (const f of bm.fades) {
    const stops = f.keys.map((k): [number, string] => [k.t / loop, `opacity:${t4(k.v)}`]);
    rules.push(rule(f.id, kf.add(stops), "linear"));
  }

  // Reduced motion: each step shows its end pose for the whole step, no tween.
  const starts = bm.stepStarts;
  const discrete = (decl: (t: number) => string): [number, string][] => {
    const stops: [number, string][] = [];
    starts.forEach((s, i) => {
      const d = decl(bm.stepEnds[i] as number);
      if (stops.length === 0 || lastOf(stops)[1] !== d) stops.push([s / loop, d]);
    });
    if (stops.length > 0 && stops[0]![0] !== 0) stops.unshift([0, stops[0]![1]]);
    return stops;
  };
  for (const p of bm.poses) {
    const stops = discrete((t) => {
      const { x, y } = poseAt(p.keys, t);
      return `transform:translate(${t4(x)}px,${t4(y)}px)`;
    });
    reduced.push(rule(p.id, kf.add(stops), "step-end"));
  }
  for (const f of bm.fades) {
    const stops = discrete((t) => `opacity:${t4(fadeAt(f.keys, t))}`);
    reduced.push(rule(f.id, kf.add(stops), "step-end"));
  }
  return { rules, reduced };
}

/** Whether the model has any motion at all (a track with more than one value). */
export const hasBoardMotion = (bm: BoardsModel | undefined): bm is BoardsModel =>
  bm !== undefined && bm.loop > 0 && (bm.poses.length > 0 || bm.fades.length > 0);
