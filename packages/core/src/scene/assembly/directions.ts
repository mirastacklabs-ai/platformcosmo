/**
 * Direction presets (Track A2, A2-3; design docs/design/assemblies.md §6.2).
 *
 * Everything here runs in the owner's LOCAL frame (all nodes of one assembly share it, so
 * `c` = part centre - owner centre is a plain difference); `toWorld` rotates and scales the
 * result into the world once, at the end. Ties always prefer the visible directions first:
 * `+z, +y, +x, -x, -y, -z`.
 *
 * Interpretation of `away` (the doc says "outward normal of the largest contact face"): the part
 * leaves in the direction pointing from the mate's contact face toward the part, i.e. away from
 * the mate (a cover on a head goes up, an oil pan under a block goes down).
 */
import type {
  AssemblyFrame,
  Box3,
  FrontSide,
  SceneAssemblyNode,
  Vec3,
} from "../../contracts/index.js";
import type { SpecDirection } from "../../schema/types.gen.js";
import { rnd } from "./frame.js";
import { EPS, INFER_CAP, inside, type LBox } from "./roles.js";
import type { Item } from "./selectors.js";

export type Dir = readonly [number, number, number];

export const UP: Dir = [0, 0, 1];

/** Axis-aligned directions in tie order: visible ones first. */
export const PRIORITY: readonly Dir[] = [
  [0, 0, 1],
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
];

export const toLBox = (b: Box3): LBox => ({
  x0: b.origin.x,
  y0: b.origin.y,
  z0: b.origin.z,
  x1: b.origin.x + b.size.x,
  y1: b.origin.y + b.size.y,
  z1: b.origin.z + b.size.z,
});

export const lo = (b: LBox): [number, number, number] => [b.x0, b.y0, b.z0];
export const hi = (b: LBox): [number, number, number] => [b.x1, b.y1, b.z1];
export const centre = (b: LBox): [number, number, number] => [
  (b.x0 + b.x1) / 2,
  (b.y0 + b.y1) / 2,
  (b.z0 + b.z1) / 2,
];

/** The axis (0, 1, 2) and sign of an axis-aligned unit direction; undefined for any other. */
export function axisOf(d: Dir): { axis: 0 | 1 | 2; sign: 1 | -1 } | undefined {
  let axis = -1;
  for (let i = 0; i < 3; i++) {
    const v = d[i] as number;
    if (Math.abs(v) <= EPS) continue;
    if (axis >= 0 || Math.abs(Math.abs(v) - 1) > EPS) return undefined;
    axis = i;
  }
  return axis < 0 ? undefined : { axis: axis as 0 | 1 | 2, sign: (d[axis] as number) > 0 ? 1 : -1 };
}

const SIDES: readonly FrontSide[] = ["+x", "+y", "-x", "-y"];
const SIDE_DIR: Readonly<Record<FrontSide, Dir>> = {
  "+x": [1, 0, 0],
  "+y": [0, 1, 0],
  "-x": [-1, 0, 0],
  "-y": [0, -1, 0],
};

/** The front side in the LOCAL frame (`frame.front` is in world axes, after `rotate`). */
export function localFront(frame: AssemblyFrame): Dir {
  const i = SIDES.indexOf(frame.front);
  return SIDE_DIR[SIDES[(((i - frame.rotate / 90) % 4) + 4) % 4] as FrontSide];
}

/**
 * Local displacement to world displacement: scale per axis, then the assembly's quarter turn
 * (counter-clockwise about +z, as `frameMap`).
 */
export function toWorld(frame: AssemblyFrame, v: Dir): Vec3 {
  const x = v[0] * frame.scale.x;
  const y = v[1] * frame.scale.y;
  const z = v[2] * frame.scale.z;
  switch (frame.rotate) {
    case 90:
      return { x: rnd(-y), y: rnd(x), z: rnd(z) };
    case 180:
      return { x: rnd(-x), y: rnd(-y), z: rnd(z) };
    case 270:
      return { x: rnd(y), y: rnd(-x), z: rnd(z) };
    default:
      return { x: rnd(x), y: rnd(y), z: rnd(z) };
  }
}

const normalize = (v: readonly [number, number, number]): Dir => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > EPS && Number.isFinite(n) ? [v[0] / n, v[1] / n, v[2] / n] : UP;
};

const overlapLen = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.min(a1, b1) - Math.max(a0, b0);

/**
 * Largest contact face between `p` and `m` and the direction away from `m` through it (ties:
 * the tie order). Undefined when the boxes do not touch with positive area.
 */
export function contactAway(p: LBox, m: LBox): { area: number; dir: Dir } | undefined {
  const pl = lo(p);
  const ph = hi(p);
  const ml = lo(m);
  const mh = hi(m);
  let best: { area: number; dir: Dir } | undefined;
  for (const d of PRIORITY) {
    const { axis, sign } = axisOf(d) as { axis: 0 | 1 | 2; sign: 1 | -1 };
    // +u: the part sits on the mate's + face; -u: on its - face
    const gap = sign > 0 ? pl[axis] - mh[axis] : ml[axis] - ph[axis];
    if (Math.abs(gap) > EPS) continue;
    let area = 1;
    for (let v = 0; v < 3 && area > 0; v++) {
      if (v === axis) continue;
      const o = overlapLen(pl[v] as number, ph[v] as number, ml[v] as number, mh[v] as number);
      area = o > EPS ? area * o : 0;
    }
    if (area > EPS && (best === undefined || area > best.area + EPS)) best = { area, dir: d };
  }
  return best;
}

/**
 * A part that interpenetrates a sibling (it is not in face contact and not enclosed): leaves
 * along the axis of least penetration, on the side its centre lies. Undefined when the boxes
 * do not overlap in volume.
 */
function pushOut(p: LBox, s: LBox): { volume: number; dir: Dir } | undefined {
  const pl = lo(p);
  const ph = hi(p);
  const sl = lo(s);
  const sh = hi(s);
  const pc = centre(p);
  const sc = centre(s);
  let vol = 1;
  let best: Dir | undefined;
  let depth = Infinity;
  for (const axis of [2, 1, 0] as const) {
    const o = overlapLen(pl[axis], ph[axis], sl[axis], sh[axis]);
    if (!(o > EPS)) return undefined;
    vol *= o;
    if (o < depth - EPS) {
      depth = o;
      const d: [number, number, number] = [0, 0, 0];
      d[axis] = pc[axis] >= sc[axis] ? 1 : -1;
      best = d;
    }
  }
  return best === undefined ? undefined : { volume: vol, dir: best };
}

const rank = (d: Dir): number =>
  PRIORITY.findIndex((p) => p[0] === d[0] && p[1] === d[1] && p[2] === d[2]);

/** Larger contact area wins; equal areas keep the more visible direction. */
const better = (
  a: { area: number; dir: Dir },
  b: { area: number; dir: Dir } | undefined,
): boolean =>
  b === undefined ||
  a.area > b.area + EPS ||
  (Math.abs(a.area - b.area) <= EPS && rank(a.dir) < rank(b.dir));

const volume = (b: LBox): number => (b.x1 - b.x0) * (b.y1 - b.y0) * (b.z1 - b.z0);

/** Shortest way out of an enclosing box (ties: the tie order). */
function shortestExit(p: LBox, e: LBox): Dir {
  let best: Dir = UP;
  let bestD = Infinity;
  for (const d of PRIORITY) {
    const { axis, sign } = axisOf(d) as { axis: 0 | 1 | 2; sign: 1 | -1 };
    const dist = sign > 0 ? hi(e)[axis] - lo(p)[axis] : hi(p)[axis] - lo(e)[axis];
    if (dist < bestD - EPS) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

export interface DirectionContext {
  readonly frame: AssemblyFrame;
  /** The program owner (its centre anchors `out`, `radial`, `axis`). */
  readonly owner: SceneAssemblyNode;
  /** Per-program memo of path-indexed children (optional; built on demand). */
  readonly cache?: Map<SceneAssemblyNode, Map<string, SceneAssemblyNode>>;
  /** Counts parts whose full sibling scan was skipped (groups over `INFER_CAP`). */
  readonly degraded?: { count: number };
  /** A rack in assembly mode: a cover given `drawer` leaves along its own outward normal (8.1). */
  readonly dc?: boolean;
}

/** `out` (§6.2): the horizontal axis with the larger |c|, signed; ties +y, then +x; c = 0: up. */
function outward(c: readonly [number, number, number]): Dir {
  const ax = Math.abs(c[0]);
  const ay = Math.abs(c[1]);
  if (ax <= EPS && ay <= EPS) return UP;
  const dx: Dir = [c[0] > 0 ? 1 : -1, 0, 0];
  const dy: Dir = [0, c[1] >= 0 ? 1 : -1, 0];
  if (ax > ay + EPS) return dx;
  if (ay > ax + EPS) return dy;
  // a tie: the visible-first order decides, in every quadrant (+y, +x, -x, -y)
  return rank(dx) < rank(dy) ? dx : dy;
}

const SIMPLE: Readonly<Record<string, Dir>> = {
  up: [0, 0, 1],
  "+z": [0, 0, 1],
  down: [0, 0, -1],
  "-z": [0, 0, -1],
  "+x": [1, 0, 0],
  "-x": [-1, 0, 0],
  "+y": [0, 1, 0],
  "-y": [0, -1, 0],
  lift: [0, 0, 1],
};

/** The part's own cylinder or shaft axis (z when it has none). */
function ownAxis(n: SceneAssemblyNode): 0 | 1 | 2 {
  const a = n.geometry?.primitives.find((p) => p.axis !== undefined)?.axis;
  return a === "x" ? 0 : a === "y" ? 1 : 2;
}

/**
 * A cover of a rack (rear door, lid) leaves along its own outward normal: toward the front when
 * it lies on the front side of the owner's centre (`c` = part centre - owner centre), else toward
 * the rear (assemblies.md 8.1).
 */
function coverNormal(front: Dir, c: readonly [number, number, number]): Dir {
  const side = c[0] * front[0] + c[1] * front[1];
  return side < 0 ? [-front[0], -front[1], 0] : front;
}

/** The unit direction (local frame) of `dir` for one part. Never throws; unknown names mean `away`. */
export function resolveDirection(
  dir: SpecDirection | undefined,
  item: Item,
  ctx: DirectionContext,
  ownerBox: LBox,
): Dir {
  if (Array.isArray(dir)) {
    const v = dir as readonly unknown[];
    const n = [0, 1, 2].map((i) =>
      typeof v[i] === "number" && Number.isFinite(v[i]) ? (v[i] as number) : 0,
    );
    return normalize(n as [number, number, number]);
  }
  const name = typeof dir === "string" ? dir : "away";
  const simple = SIMPLE[name];
  if (simple !== undefined) return simple;
  const box = toLBox(item.node.local);
  const oc = centre(ownerBox);
  const pc = centre(box);
  const c: [number, number, number] = [pc[0] - oc[0], pc[1] - oc[1], pc[2] - oc[2]];
  switch (name) {
    case "out":
      return outward(c);
    case "radial":
      return Math.abs(c[0]) <= EPS && Math.abs(c[1]) <= EPS ? UP : normalize([c[0], c[1], 0]);
    case "axis": {
      const a = ownAxis(item.node);
      const d: [number, number, number] = [0, 0, 0];
      d[a] = (c[a] as number) >= -EPS ? 1 : -1;
      return d;
    }
    case "drawer":
      return ctx.dc === true && item.node.role === "cover"
        ? coverNormal(localFront(ctx.frame), c)
        : localFront(ctx.frame);
    default:
      return away(item, ctx, box);
  }
}

/**
 * The outward normal of the face of `s` that `p` crosses (a part inserted into a solid leaves
 * the way it entered), or undefined when it crosses none. Ties: the tie order.
 */
function entryNormal(p: LBox, s: LBox): Dir | undefined {
  let first: Dir | undefined;
  for (const d of PRIORITY) {
    const { axis, sign } = axisOf(d) as { axis: 0 | 1 | 2; sign: 1 | -1 };
    const plane = sign > 0 ? hi(s)[axis] : lo(s)[axis];
    if (!(lo(p)[axis] < plane - EPS && hi(p)[axis] > plane + EPS)) continue;
    // the face it enters: the part's footprint lies inside the face
    const inFace = [0, 1, 2].every(
      (v) => v === axis || (lo(p)[v]! >= lo(s)[v]! - EPS && hi(p)[v]! <= hi(s)[v]! + EPS),
    );
    if (inFace) return d;
    first ??= d;
  }
  return first;
}

/** Path-indexed children of a parent, built once per parent per program. */
function childrenByPath(
  ctx: DirectionContext,
  parent: SceneAssemblyNode,
): Map<string, SceneAssemblyNode> {
  const cache = ctx.cache;
  let m = cache?.get(parent);
  if (m === undefined) {
    m = new Map(parent.children.map((c) => [c.path, c]));
    cache?.set(parent, m);
  }
  return m;
}

/**
 * `away` (§6.2): a part with `inserts` leaves through the entry face it crossed; else it leaves
 * its mate (explicit or inferred `mates`); else the largest touching sibling, else the
 * enclosure, else (interpenetration, an interpretation: the doc says `out`) the axis of least
 * penetration of the sibling it overlaps most, else `out`. The mate and `inserts` checks are
 * always made; only the full sibling scan is skipped in groups over `INFER_CAP` siblings
 * (`ctx.degraded` counts them).
 */
function away(item: Item, ctx: DirectionContext, box: LBox): Dir {
  const owner = ctx.owner;
  const parent = item.parent?.node ?? owner;
  const byPath = childrenByPath(ctx, parent);
  const ins = item.node.inserts === undefined ? undefined : byPath.get(item.node.inserts);
  if (ins !== undefined) {
    const n = entryNormal(box, toLBox(ins.local));
    if (n !== undefined) return n;
  }
  const mate = item.node.mates === undefined ? undefined : byPath.get(item.node.mates);
  if (mate !== undefined && mate !== item.node) {
    const hit = contactAway(box, toLBox(mate.local));
    if (hit !== undefined) return hit.dir;
  }
  if (parent.children.length - 1 <= INFER_CAP) {
    let best: { area: number; dir: Dir } | undefined;
    let enclosing: LBox | undefined;
    let pushed: { volume: number; dir: Dir } | undefined;
    for (const s of parent.children) {
      if (s === item.node) continue;
      const sb = toLBox(s.local);
      const push = pushOut(box, sb);
      if (push !== undefined && (pushed === undefined || push.volume > pushed.volume + EPS)) {
        pushed = push;
      }
      const hit = contactAway(box, sb);
      if (hit !== undefined && better(hit, best)) best = hit;
      if (inside(box, sb) && (enclosing === undefined || volume(sb) < volume(enclosing))) {
        enclosing = sb;
      }
    }
    if (best !== undefined) return best.dir;
    if (enclosing !== undefined) return shortestExit(box, enclosing);
    if (pushed !== undefined) return pushed.dir;
  } else if (ctx.degraded !== undefined) ctx.degraded.count++;
  const pc = centre(box);
  const oc = centre(toLBox(owner.local));
  return outward([pc[0] - oc[0], pc[1] - oc[1], pc[2] - oc[2]]);
}
