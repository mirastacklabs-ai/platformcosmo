/**
 * Tracks of the view and level groups (Track B, B-3; docs/design/assemblies.md §7.7, §8.4):
 * the opacity of every view group, and the opacity and placement of every level group, as keys on
 * the loop clock. `frameAt` / `stepEnd` EVALUATE these keys and the animator writes them as CSS,
 * so a frame equals the CSS pose at the same time by construction.
 *
 * Views. The switches come from the build/unbuild actions (`ResolvedAction.views`, in the
 * action's own time: `open + start + at * scale`), never recomputed from the programs. The view
 * of a switch cross-fades in over `VIEW_FADE` seconds. Levels. The group in effect at a step
 * cross-fades in over the transition into it (§8.4) and eases from `fromHost(hostAt(k - 1))` to
 * its overview. Pure and deterministic.
 */
import type {
  AssemblyAffine,
  AssemblyLevelRender,
  AssemblyStepClock,
  AssemblyStepPlan,
  OpacityKey,
  QuarterTurn,
} from "../../contracts/index.js";
import { matrixAttr } from "./levels.js";
import { VIEW_FADE } from "./views.js";

const r4 = (v: number): number => Math.round(v * 10000) / 10000 + 0;
const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const EPS = 1e-9;
/** Gap before a breakpoint at which the left limit of a jump is keyed. */
const LEFT = 1e-4;

/** Placement key of a level group: `p' = scale * p + (tx, ty)`, linear between keys. */
export interface PlacementKey extends AssemblyAffine {
  readonly t: number;
}

/** Opacity (views, levels) and placement (levels) of one group. Sorted by id in the model. */
export interface GroupTrack {
  readonly id: string;
  readonly opacity: readonly OpacityKey[];
  readonly placement?: readonly PlacementKey[];
}

/** One view switch of the loop: from `t` on the view in effect is `view`. */
export interface ViewSwitch {
  readonly t: number;
  readonly view: QuarterTurn;
}

/**
 * The view switches of every step's actions, in loop seconds, sorted by time (stable). A step
 * whose view in effect at its end (`AssemblyStepPlan.view`) differs from what its actions
 * switch to (scenes that set the plan's view directly) switches at the step's start.
 */
export function viewSwitches(
  plan: readonly AssemblyStepPlan[],
  clock: readonly AssemblyStepClock[],
  /** Loop length: with it, a loop that ends in a turned view cross-fades back to view 0 (§7.3). */
  total?: number,
): ViewSwitch[] {
  const out: ViewSwitch[] = [];
  let view: QuarterTurn = 0;
  plan.forEach((sp, i) => {
    const c = clock[i];
    if (c === undefined) return;
    const own: ViewSwitch[] = [];
    for (const a of sp.actions) {
      for (const v of a.views ?? []) {
        own.push({ t: r4(c.open + a.start + v.at * a.scale), view: v.view });
      }
    }
    own.sort((x, y) => x.t - y.t);
    const last = own[own.length - 1]?.view ?? view;
    if (sp.view !== undefined && sp.view !== last) out.push({ t: r4(c.start), view: sp.view });
    out.push(...own);
    view = sp.view ?? last;
  });
  // loop closure: the view returns to 0 in the closing window so the restart never snaps
  const lastEnd = clock[clock.length - 1]?.end;
  if (total !== undefined && lastEnd !== undefined && total > lastEnd + EPS) {
    const at = Math.max(...out.map((s) => s.t), Math.min(lastEnd, total - VIEW_FADE));
    if (view !== 0) out.push({ t: r4(at), view: 0 });
  }
  return out
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.t - b.s.t || a.i - b.i)
    .map((x) => x.s)
    .filter((s, i, l) => s.view !== (i === 0 ? 0 : (l[i - 1] as ViewSwitch).view));
}

/** Opacity of view `turn` at loop time `t` for the switches (a cross-fade over `VIEW_FADE`). */
export function viewOpacityAt(
  switches: readonly ViewSwitch[],
  turn: QuarterTurn,
  t: number,
): number {
  let j = -1;
  for (let i = 0; i < switches.length; i++) if ((switches[i] as ViewSwitch).t <= t + EPS) j = i;
  const cur = j < 0 ? 0 : (switches[j] as ViewSwitch).view;
  const prev = j < 1 ? 0 : (switches[j - 1] as ViewSwitch).view;
  const f = j < 0 ? 1 : clamp01((t - (switches[j] as ViewSwitch).t) / VIEW_FADE);
  return r2(turn === cur ? (turn === prev ? 1 : f) : turn === prev ? 1 - f : 0);
}

/**
 * Keys of a piecewise-linear function that is linear between the breakpoints `bps` (plus `0` and
 * `total`): a key at each breakpoint, and one just before it where the function jumps.
 */
function sampled<V, K extends { readonly t: number }>(
  bps: readonly number[],
  total: number,
  at: (t: number) => V,
  differs: (a: V, b: V) => boolean,
  key: (t: number, v: V) => K,
): K[] {
  const times = [...new Set([0, r4(total), ...bps.map(r4)])]
    .filter((t) => t >= 0 && t <= total + EPS)
    .sort((a, b) => a - b);
  const keys: K[] = [];
  for (const b of times) {
    const last = keys[keys.length - 1];
    const v = at(b);
    if (last !== undefined) {
      const left = r4(b - LEFT);
      if (left > last.t + EPS) {
        const lv = at(left);
        if (differs(lv, v)) keys.push(key(left, lv));
      }
    }
    keys.push(key(b, v));
  }
  return keys;
}

const opacityKey = (t: number, opacity: number): OpacityKey => ({ t, opacity, easing: "linear" });
const opacityDiffers = (a: number, b: number): boolean => Math.abs(a - b) > 0.011;

export interface GroupInput {
  readonly total: number;
  readonly clock: readonly AssemblyStepClock[];
  readonly plan: readonly AssemblyStepPlan[];
  /** Views with their group ids (view 0 first), when the scene has quarter-turn views. */
  readonly views: readonly { readonly turn: QuarterTurn; readonly group: string }[];
  readonly levels: readonly AssemblyLevelRender[];
  /** Path of the level a step (0-based) focuses, if any. */
  readonly levelAtStep: (k: number) => string | undefined;
  /** Ids of the main world's layer groups, faded against the levels (only with levels). */
  readonly mainLayers: readonly string[];
}

/** Tracks of every view and level group, sorted by id. */
export function groupTracks(input: GroupInput): GroupTrack[] {
  const { total, clock } = input;
  const out: GroupTrack[] = [];

  if (input.views.length > 0) {
    const sw = viewSwitches(input.plan, clock, total);
    const bps = sw.flatMap((s) => [s.t, s.t + VIEW_FADE]);
    for (const v of input.views) {
      out.push({
        id: v.group,
        opacity: sampled(
          bps,
          total,
          (t) => viewOpacityAt(sw, v.turn, t),
          opacityDiffers,
          opacityKey,
        ),
      });
    }
  }

  if (input.levels.length > 0) {
    // Segment k (0-based) is the transition INTO step k: [end of step k-1, start of step k]
    // (step 0: up to its motion window). Segment n is the closing window of the last step,
    // [its end, loop end], a transition into "no level" (the loop restarts on the overview).
    const n = clock.length;
    const closing = n > 0 && total > (clock[n - 1]?.end ?? 0) + EPS;
    const segs = closing ? n + 1 : n;
    const lvl = (k: number): string | undefined =>
      k < 0 || k >= n ? undefined : input.levelAtStep(k);
    const tStart = (k: number): number => (k <= 0 ? 0 : (clock[k - 1]?.end ?? 0));
    const tEnd = (k: number): number =>
      k >= n ? total : k <= 0 ? (clock[0]?.open ?? 0) : (clock[k]?.start ?? 0);
    const bps = Array.from({ length: segs }, (_, k) => [tStart(k), tEnd(k)]).flat();
    const stepAt = (t: number): number => {
      let k = 0;
      for (let i = 0; i < segs; i++) if (tStart(i) <= t + EPS) k = i;
      return k;
    };
    const fAt = (k: number, t: number): number => {
      const span = tEnd(k) - tStart(k);
      return span > EPS ? clamp01((t - tStart(k)) / span) : 1;
    };

    // the main world cross-fades against the levels (occluders, §8.4)
    if (input.mainLayers.length > 0) {
      const mainAt = (t: number): number => {
        const k = stepAt(t);
        const f = fAt(k, t);
        const cur = lvl(k) !== undefined;
        const prev = lvl(k - 1) !== undefined;
        return r2(cur ? (prev ? 0 : 1 - f) : prev ? f : 1);
      };
      for (const id of input.mainLayers) {
        out.push({ id, opacity: sampled(bps, total, mainAt, opacityDiffers, opacityKey) });
      }
    }

    for (const l of input.levels) {
      /** Step whose host rect starts the NEXT entry after segment `k`, if any. */
      const nextEntry = (k: number): number | undefined => {
        for (let j = k + 1; j < n; j++) if (lvl(j) === l.path && lvl(j - 1) !== l.path) return j;
        return undefined;
      };
      /** Step whose host rect ended the LAST exit at or before segment `k`, if any. */
      const lastExit = (k: number): number | undefined => {
        for (let j = k; j >= 1; j--) if (lvl(j - 1) === l.path && lvl(j) !== l.path) return j;
        return undefined;
      };
      const opacityAt = (t: number): number => {
        const k = stepAt(t);
        const f = fAt(k, t);
        const cur = lvl(k) === l.path;
        const prev = lvl(k - 1) === l.path;
        return r2(cur ? (prev ? 1 : f) : prev ? 1 - f : 0);
      };
      const placementAt = (t: number): AssemblyAffine => {
        const k = stepAt(t);
        const f = fAt(k, t);
        const cur = lvl(k) === l.path;
        const prev = lvl(k - 1) === l.path;
        const mix = (e: AssemblyAffine, g: number): AssemblyAffine => ({
          scale: e.scale + (l.overview.scale - e.scale) * g,
          tx: e.tx + (l.overview.tx - e.tx) * g,
          ty: e.ty + (l.overview.ty - e.ty) * g,
        });
        let a = l.overview;
        if (cur && !prev) {
          // entry: from the host's drawn rect to the overview
          a = mix(l.fromHost(l.hostAt(k)), f);
        } else if (prev && !cur) {
          // exit: the reverse, from the overview back into the host's rect
          a = mix(l.fromHost(l.hostAt(k)), 1 - f);
        } else if (!cur && !prev) {
          // invisible: wait at the next entry pose (else the last exit pose): no jump keys
          const j = nextEntry(k) ?? lastExit(k);
          if (j !== undefined) a = l.fromHost(l.hostAt(j));
        }
        return { scale: r4(a.scale), tx: r2(a.tx), ty: r2(a.ty) };
      };
      const differs = (a: AssemblyAffine, b: AssemblyAffine): boolean =>
        Math.abs(a.scale - b.scale) > 1e-3 ||
        Math.abs(a.tx - b.tx) > 0.02 ||
        Math.abs(a.ty - b.ty) > 0.02;
      out.push({
        id: l.group,
        opacity: sampled(bps, total, opacityAt, opacityDiffers, opacityKey),
        placement: sampled(bps, total, placementAt, differs, (t, a): PlacementKey => ({ t, ...a })),
      });
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Placement at `t` (linear between keys; first and last key held outside). */
export function placementAt(keys: readonly PlacementKey[], t: number): AssemblyAffine {
  const first = keys[0];
  if (first === undefined) return { scale: 1, tx: 0, ty: 0 };
  if (t <= first.t + EPS) return first;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i] as PlacementKey;
    const b = keys[i + 1] as PlacementKey;
    if (t < b.t - EPS) {
      const f = (t - a.t) / (b.t - a.t);
      return {
        scale: a.scale + (b.scale - a.scale) * f,
        tx: a.tx + (b.tx - a.tx) * f,
        ty: a.ty + (b.ty - a.ty) * f,
      };
    }
  }
  return keys[keys.length - 1] as PlacementKey;
}

/** The `transform` attribute of a placement at `t`, rounded as the model's frames write it. */
export function placementAttr(keys: readonly PlacementKey[], t: number): string {
  const a = placementAt(keys, t);
  return matrixAttr({ scale: r4(a.scale), tx: r2(a.tx), ty: r2(a.ty) });
}
