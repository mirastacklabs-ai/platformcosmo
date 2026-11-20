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
  IdScheme,
  OpacityKey,
  RenderModel,
  TrackKey,
  VisibilityKey,
} from "../contracts/index.js";
import { evalOffset, evalOpacity, evalVisible, round2 } from "../render/assembly/tracks.js";
import { Keyframes, pct, t4 } from "./css.js";

type Attrs = Record<string, Record<string, string | number>>;

/** Keys per animated property above which the middle ones are thinned (first and last kept). */
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
export type AssemblyProp = MoveProp | VisProp | FadeProp;

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
}

const r4 = (v: number): number => Math.round(v * 10000) / 10000 + 0;

// ---------------------------------------------------------------------------------------------
// Preparation: warp, bound, order
// ---------------------------------------------------------------------------------------------

/** Piecewise-linear retiming of the speed-1 clock onto the speed's camera windows. */
function warpFor(am: AssemblyRenderModel, speed: number): (t: number) => number {
  if (speed === 1) return (t) => t;
  const pts: [number, number][] = [[0, 0]];
  const push = (a: number, b: number): void => {
    const last = pts[pts.length - 1] as [number, number];
    if (a > last[0] + 1e-9 && b > last[1] + 1e-9) pts.push([a, b]);
  };
  const camera = (baked: number, d: number): number =>
    baked > 0 ? r4(Math.min(0.8 * speed, 0.25 * d)) : 0;
  for (const c of am.clock) {
    const end = c.start + c.duration;
    const lead = camera(r4(c.open - c.start), c.duration);
    const tr = camera(r4(end - c.end), c.duration);
    push(c.start, c.start);
    push(c.open, c.start + lead);
    push(c.end, end - tr);
    push(end, end);
  }
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

/** At most `MAX_KEYS` keys: thinned by a fixed stride, first and last kept. */
function bound<K>(keys: readonly K[]): K[] {
  if (keys.length <= MAX_KEYS) return [...keys];
  const out: K[] = [];
  const step = (keys.length - 1) / (MAX_KEYS - 1);
  for (let i = 0; i < MAX_KEYS; i++) out.push(keys[Math.round(i * step)] as K);
  return out;
}

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

const cache = new WeakMap<AssemblyRenderModel, Map<number, AssemblyAnim>>();

/** Everything the assembly layer animates, for an output `speed`. */
export function assemblyAnim(am: AssemblyRenderModel, speed: number): AssemblyAnim {
  const s = speed > 0 && Number.isFinite(speed) ? speed : 1;
  const bySpeed = cache.get(am) ?? new Map<number, AssemblyAnim>();
  cache.set(am, bySpeed);
  const hit = bySpeed.get(s);
  if (hit !== undefined) return hit;
  const warp = warpFor(am, s);
  const props: AssemblyProp[] = [];
  const move = (id: string, keys: readonly TrackKey[]): void => {
    if (keys.length > 0) {
      props.push({ kind: "transform", id, keys: prune(retime(bound(keys), warp), sameOffset) });
    }
  };
  const fade = (id: string, keys: readonly OpacityKey[]): void => {
    if (keys.length > 0) {
      props.push({ kind: "opacity", id, keys: prune(retime(bound(keys), warp), sameOpacity) });
    }
  };
  for (const t of am.tracks) {
    // the wrappers exist exactly for the tracks that have keys (A1-3 `Registered`)
    move(am.ids.partHost(t.copy), t.host);
    move(am.ids.partMotion(t.copy), t.motion);
    if (t.visibility.length > 0) {
      props.push({
        kind: "visibility",
        id: am.ids.partVisible(t.copy),
        keys: retime(t.visibility, warp),
      });
    }
    fade(am.ids.partFade(t.copy), t.opacity);
  }
  for (const f of am.staticFades) fade(f.id, f.opacity);
  for (const l of am.labelTracks) {
    move(l.id, l.motion);
    fade(l.id, l.opacity);
  }
  const anim: AssemblyAnim = {
    loop: am.loop,
    props: props.slice(0, MAX_PROPS),
    warp,
    starts: am.clock.map((c) => c.start),
    ends: am.clock.map((c) => warp(Math.min(c.end, am.loop))),
  };
  bySpeed.set(s, anim);
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
  if (p.kind === "opacity") return p.keys.every((k) => k.opacity === (first as OpacityKey).opacity);
  return p.keys.every((k) => k.visible === (first as VisibilityKey).visible);
}

/** Whether the assembly layer has any motion on the loop (a spec with assembly actions). */
export const hasAssemblyMotion = (am: AssemblyRenderModel | undefined): am is AssemblyRenderModel =>
  am !== undefined && am.loop > 0 && assemblyAnim(am, 1).props.some((p) => !isConstant(p));

// ---------------------------------------------------------------------------------------------
// Attribute overrides (frame, step, static)
// ---------------------------------------------------------------------------------------------

const translateAttr = (x: number, y: number): string => `translate(${round2(x)} ${round2(y)})`;

/** The FULL state of every animated wrapper at loop time `t` (this speed's loop seconds). */
function attrsAtLoop(a: AssemblyAnim, t: number): Attrs {
  const out: Attrs = {};
  const at = (id: string): Record<string, string | number> => (out[id] ??= {});
  for (const p of a.props) {
    if (p.kind === "transform") {
      const v = evalOffset(p.keys, t);
      at(p.id).transform = translateAttr(v.x, v.y);
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
  return attrsAtLoop(a, a.ends[step - 1] ?? 0);
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
  if (!(a.loop > 0) || !(total > 0) || moving.length === 0) return { rules: [], reduced: [] };
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
      const d = decl(a.ends[i] as number);
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
  return { rules: emit(perId), reduced: emit(reducedPerId) };
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
