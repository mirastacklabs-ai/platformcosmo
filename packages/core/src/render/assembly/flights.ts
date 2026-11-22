/**
 * Callout flights (Track A2, A2-7; docs/design/assemblies.md §7.6, §10): the overlay copies of
 * leaves that fly in from their step's callout slot. A copy is a deep copy of the leaf's part
 * group (ids suffixed `__f`) in ONE wrapper `<g id=flight>` that carries `transform`,
 * `visibility` and `opacity`, drawn after every depth item of its group: it is not a depth item.
 *
 * The flight is a screen translation of the copy, which sits at the leaf's seat in the DOM:
 *   build:   slot centre -> hover point, then the world copy appears at the same instant;
 *   unbuild: the exact reverse (the world copy leaves at the hover point, the copy flies back).
 * The hover end is the world copy's own screen translation at the swap time (the same sum of
 * moves, the same projection, the same rounding), so the two coincide exactly. The slot is a point
 * of the group's screen space (left of the assemblies' rest bounds), so a flight follows the camera
 * like the world does; see `slotOf`. Pure and deterministic.
 */
import type {
  OpacityKey,
  Projection,
  Rect,
  TrackKey,
  Vec2,
  VisibilityKey,
} from "../../contracts/index.js";
import { projectBoxBounds, unionRects } from "../../geometry/index.js";
import { BUILD_FADE } from "./builds.js";
import { r4, type FlightRun } from "./loop.js";
import { round2, screenOf, type MoveIndex } from "./tracks.js";
import type { WorldLeaf } from "./world.js";

const EPS = 1e-9;

/** Tracks of the overlay copy of one leaf (all its flights over the loop). */
export interface FlightTrack {
  /** Leaf path. */
  readonly path: string;
  /** `ids.flight(path)`: the wrapper carrying all three tracks. */
  readonly id: string;
  /** Screen translation, `step` easing between flights (the copy is hidden then). */
  readonly motion: readonly TrackKey[];
  readonly visibility: readonly VisibilityKey[];
  readonly opacity: readonly OpacityKey[];
}

export interface Flights {
  /** Sorted by leaf path. */
  readonly tracks: readonly FlightTrack[];
  /** Screen rects the flights reach (the copy at the slot and at the hover point), for the view box. */
  readonly rects: readonly Rect[];
}

/**
 * The callout slot (§6.5): where a step's callout sits, in screen space, left of the rest bounds
 * of the assemblies and a quarter of their height down. A flight's copy is centred on it.
 */
export function slotOf(rest: Rect): Vec2 {
  return { x: rest.x - 36 - 0.1 * rest.width, y: rest.y + 0.25 * rest.height };
}

const center = (r: Rect): Vec2 => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

/** Keys strictly increasing in time: a key at the time of the previous one replaces it. */
function pushKey<K extends { readonly t: number }>(keys: K[], k: K): void {
  const last = keys[keys.length - 1];
  if (last !== undefined && k.t <= last.t + EPS) keys[keys.length - 1] = { ...k, t: last.t };
  else keys.push(k);
}

/**
 * Tracks of every leaf under a flying node. `index` gives the world displacement (loop moves),
 * `leaves` the rest geometry, `slot` the callout slot. Nodes that are not leaves fly as one rigid
 * unit: every leaf under them shares the node's centre.
 */
export function flightTracks(input: {
  readonly id: (path: string) => string;
  readonly runs: readonly FlightRun[];
  readonly leaves: readonly WorldLeaf[];
  readonly index: MoveIndex;
  readonly projection: Projection;
  readonly slot: Vec2;
  readonly loop: number;
}): Flights {
  const { runs, leaves, index, projection, slot, loop } = input;
  const byLeaf = new Map<string, { run: FlightRun; from: Vec2; to: Vec2 }[]>();
  const rects: Rect[] = [];
  const rest = (l: WorldLeaf): Rect => projectBoxBounds(projection, l.geometry.bounds);
  const under = (run: FlightRun): WorldLeaf[] =>
    leaves.filter((l) => l.path === run.path || l.path.startsWith(`${run.path}/`));
  // the leaves that fly together: a node's own (one run), or the leaves a step adds of a partly
  // added sub-assembly (one run each, the same window): one rigid unit centred on the slot
  const unitOf = new Map<string, WorldLeaf[]>();
  for (const run of runs) {
    if (run.unit === undefined) continue;
    const k = `${run.unit}\0${run.kind}\0${run.t0}\0${run.t1}`;
    unitOf.set(k, [...(unitOf.get(k) ?? []), ...under(run)]);
  }
  for (const run of runs) {
    const mine = under(run);
    if (mine.length === 0) continue;
    const group =
      run.unit === undefined
        ? mine
        : (unitOf.get(`${run.unit}\0${run.kind}\0${run.t0}\0${run.t1}`) ?? mine);
    const c = center(unionRects(group.map(rest)));
    const start = { x: slot.x - c.x, y: slot.y - c.y };
    // the swap is the end of a build's flight and the start of an unbuild's
    const swapT = run.kind === "build" ? run.t1 : run.t0;
    for (const l of mine) {
      const hover = screenOf(projection, index.displacement(l.path, swapT));
      const end = { x: round2(hover.x), y: round2(hover.y) };
      const s = { x: round2(start.x), y: round2(start.y) };
      const [from, to] = run.kind === "build" ? [s, end] : [end, s];
      const list = byLeaf.get(l.path);
      const one = { run, from, to };
      if (list === undefined) byLeaf.set(l.path, [one]);
      else list.push(one);
      const r = rest(l);
      for (const o of [s, end])
        rects.push({ x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height });
    }
  }
  const tracks: FlightTrack[] = [];
  for (const path of [...byLeaf.keys()].sort()) {
    const list = (byLeaf.get(path) ?? []).sort((a, b) => a.run.t0 - b.run.t0);
    const first = list[0];
    if (first === undefined) continue;
    const motion: TrackKey[] = [{ t: 0, offset: first.from, easing: "step" }];
    const vis: VisibilityKey[] = [{ t: 0, visible: false }];
    const opacity: OpacityKey[] = [
      { t: 0, opacity: first.run.kind === "build" ? 0 : 1, easing: "step" },
    ];
    for (const { run, from, to } of list) {
      const t0 = r4(run.t0);
      const t1 = r4(run.t1);
      pushKey(motion, { t: t0, offset: from, easing: run.easing });
      pushKey(motion, { t: t1, offset: to, easing: "step" });
      pushKey(vis, { t: t0, visible: true });
      pushKey(vis, { t: t1, visible: false });
      // a copy fades in at the start of a build's flight and out at the end of an unbuild's
      const ramp = Math.max(1e-4, Math.min(BUILD_FADE, (t1 - t0) / 2));
      if (run.kind === "build") {
        pushKey(opacity, { t: t0, opacity: 0, easing: "linear" });
        pushKey(opacity, { t: r4(t0 + ramp), opacity: 1, easing: "step" });
      } else {
        pushKey(opacity, { t: t0, opacity: 1, easing: "linear" });
        pushKey(opacity, { t: r4(t1 - ramp), opacity: 1, easing: "linear" });
        pushKey(opacity, { t: t1, opacity: 0, easing: "step" });
      }
    }
    const end = r4(loop);
    const lastM = motion[motion.length - 1] as TrackKey;
    if (lastM.t < end - EPS) motion.push({ t: end, offset: lastM.offset, easing: "linear" });
    const lastV = vis[vis.length - 1] as VisibilityKey;
    if (lastV.t < end - EPS) vis.push({ t: end, visible: lastV.visible });
    const lastO = opacity[opacity.length - 1] as OpacityKey;
    if (lastO.t < end - EPS) opacity.push({ t: end, opacity: lastO.opacity, easing: "linear" });
    tracks.push({ path, id: input.id(path), motion, visibility: vis, opacity });
  }
  return { tracks, rects };
}
