/**
 * Distances and automatic stacking (Track A2, A2-3; design docs/design/assemblies.md §6.3).
 *
 * Auto distances are computed PER PROGRAM, before timing, so the final positions of every stage
 * nest. Movers are grouped by their (axis-aligned) direction `u` and stacked inner first, sorted
 * by `(max_u, min_u, path)`: a part clears its seat (`extent + gap`, and every static part it
 * would collide with on the way out), and rides above every earlier mover over its footprint:
 *
 *   D(p) = max( k * clear(p),  max over earlier q overlapping p: q.max_u + D(q) + gap - p.min_u )
 *
 * Everything is in the owner's LOCAL units (boxes and distances share one frame). `lift` movers
 * stack as layers: every earlier mover counts as overlapping, and lift movers whose rest `min_z`
 * is equal share one layer (one unit, one distance). Non-axis directions have no stacking:
 * `D = k * (extent along u + gap)`; a numeric distance is used as given.
 *
 * Bounded: the static-obstruction scan is movers x leaves and the stacking scan units^2; both
 * are charged to the shared `Work` budget first, and a spent budget degrades to the plain
 * `extent + gap` clearance (reported by the caller). Nothing allocates beyond the movers.
 */
import type { SpecDistance } from "../../schema/types.gen.js";
import { axisOf, hi, lo, type Dir } from "./directions.js";
import { EPS, type LBox } from "./roles.js";
import { spend, type Item, type Work } from "./selectors.js";

export interface Mover {
  /** Path relative to the owner; the identity of the mover. */
  readonly rel: string;
  readonly item: Item;
  readonly box: LBox;
  readonly u: Dir;
  readonly lift: boolean;
  /** `drawer`: the part must leave the owner completely. */
  readonly drawer: boolean;
  /** Multiple of the auto distance (`"1.5x"`); 1 for `"auto"`. */
  readonly k: number;
  /** Explicit distance in owner units, when the spec gave a number. */
  readonly fixed?: number;
}

/** A leaf of the owner, with the movers above it (itself and ancestors) for the static test. */
export interface LeafBox {
  readonly item: Item;
  readonly box: LBox;
  /** `rel` of every mover that is this leaf or one of its ancestors. */
  readonly chain: readonly string[];
}

export function parseDistance(d: SpecDistance | undefined): { k: number; fixed?: number } {
  if (typeof d === "number") return Number.isFinite(d) && d >= 0 ? { k: 1, fixed: d } : { k: 1 };
  if (typeof d === "string" && d.endsWith("x")) {
    const k = Number(d.slice(0, -1));
    if (Number.isFinite(k) && k > 0) return { k };
  }
  return { k: 1 };
}

/** Extent of a box along a unit direction. */
export function extentAlong(b: LBox, u: Dir): number {
  return (
    Math.abs(u[0]) * (b.x1 - b.x0) + Math.abs(u[1]) * (b.y1 - b.y0) + Math.abs(u[2]) * (b.z1 - b.z0)
  );
}

interface Unit {
  readonly members: Mover[];
  /** min and max along u. */
  readonly lo: number;
  readonly hi: number;
  /** Footprint (the two axes perpendicular to u) as [a0, a1, b0, b1]. */
  readonly fp: readonly [number, number, number, number];
  readonly lift: boolean;
  readonly path: string;
  d: number;
}

const perp = (axis: 0 | 1 | 2): [0 | 1 | 2, 0 | 1 | 2] =>
  axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];

/** Coordinates of a box along `u` (positive direction): [min_u, max_u]. */
function span(b: LBox, axis: 0 | 1 | 2, sign: 1 | -1): [number, number] {
  const l = lo(b)[axis];
  const h = hi(b)[axis];
  return sign > 0 ? [l, h] : [-h, -l];
}

function footprint(b: LBox, axis: 0 | 1 | 2): [number, number, number, number] {
  const [a, c] = perp(axis);
  return [lo(b)[a], hi(b)[a], lo(b)[c], hi(b)[c]];
}

const fpOverlap = (
  p: readonly [number, number, number, number],
  q: readonly [number, number, number, number],
): boolean =>
  Math.min(p[1], q[1]) - Math.max(p[0], q[0]) > EPS &&
  Math.min(p[3], q[3]) - Math.max(p[2], q[2]) > EPS;

/** `a/b/c` -> `a`, `a/b`, `a/b/c`. */
const prefixes = (rel: string): string[] => {
  const segs = rel.split("/");
  return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
};

export interface DistanceInput {
  readonly movers: readonly Mover[];
  readonly leaves: readonly LeafBox[];
  readonly gap: number;
  /** Owner box (the `drawer` exit). */
  readonly owner: LBox;
}

export interface DistanceResult {
  /** Distance in owner units per mover `rel`. */
  readonly distance: ReadonlyMap<string, number>;
  /** The work budget ran out: obstruction or stacking were skipped for some movers. */
  readonly capped: boolean;
}

/** Distances of every mover of one program (§6.3). Pure; never throws. */
export function programDistances(input: DistanceInput, work: Work): DistanceResult {
  const { movers, leaves, gap, owner } = input;
  const distance = new Map<string, number>();
  let capped = false;

  if (!spend(work, movers.length * movers.length + 1)) {
    // no budget left: plain clearance, no obstruction or stacking
    for (const m of movers) {
      distance.set(m.rel, m.fixed ?? m.k * (extentAlong(m.box, m.u) + gap));
    }
    return { distance, capped: movers.length > 0 };
  }

  // chain membership per mover for the "static relative to p" test
  const chainSet = new Map<string, ReadonlySet<string>>();
  const chainOf = (rel: string): ReadonlySet<string> => {
    let s = chainSet.get(rel);
    if (s === undefined) {
      s = new Set(
        movers.filter((m) => rel === m.rel || rel.startsWith(`${m.rel}/`)).map((m) => m.rel),
      );
      chainSet.set(rel, s);
    }
    return s;
  };

  const groups = new Map<string, Mover[]>();
  for (const m of movers) {
    const ax = axisOf(m.u);
    if (ax === undefined) {
      distance.set(m.rel, m.fixed ?? m.k * (extentAlong(m.box, m.u) + gap));
      continue;
    }
    const key = `${ax.axis}${ax.sign}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [m]);
    else g.push(m);
  }

  // obstruction scan cost: every auto mover against every leaf
  const autoCount = [...groups.values()].reduce(
    (n, g) => n + g.filter((m) => m.fixed === undefined).length,
    0,
  );
  const scanObstacles = spend(work, autoCount * leaves.length);
  if (!scanObstacles && autoCount > 0) capped = true;

  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) as Mover[];
    const { axis, sign } = axisOf(group[0]!.u) as { axis: 0 | 1 | 2; sign: 1 | -1 };

    const clearOf = (m: Mover): number => {
      const [pMin, pMax] = span(m.box, axis, sign);
      let clear = pMax - pMin + gap;
      if (m.drawer) {
        const [, oMax] = span(owner, axis, sign);
        clear = Math.max(clear, oMax - pMin + gap);
      }
      if (scanObstacles) {
        const fp = footprint(m.box, axis);
        const mine = chainOf(m.rel);
        for (const e of leaves) {
          if (e.item === m.item || e.chain.some((r) => r === m.rel)) continue; // moves with p
          if (e.chain.some((r) => !mine.has(r))) continue; // moves relative to p
          if (!fpOverlap(fp, footprint(e.box, axis))) continue;
          const [, eMax] = span(e.box, axis, sign);
          if (eMax > pMin + EPS) clear = Math.max(clear, eMax - pMin + gap);
        }
      }
      return clear;
    };

    // units: lift movers with equal rest min_u share one layer; every other mover is alone
    const sorted = [...group].sort((a, b) => {
      const [al, ah] = span(a.box, axis, sign);
      const [bl, bh] = span(b.box, axis, sign);
      return ah - bh || al - bl || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
    });
    const units: Unit[] = [];
    const layers = new Map<number, Mover[]>();
    const lifts = sorted.filter((m) => m.lift && m.fixed === undefined);
    for (const m of lifts) {
      const base = span(m.box, axis, sign)[0];
      const k = [...layers.keys()].find((x) => Math.abs(x - base) <= EPS);
      if (k === undefined) layers.set(base, [m]);
      else (layers.get(k) as Mover[]).push(m);
    }
    const unitOf = (members: Mover[], lift: boolean): Unit => {
      let l = Infinity;
      let h = -Infinity;
      let f: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const m of members) {
        const [a, b] = span(m.box, axis, sign);
        l = Math.min(l, a);
        h = Math.max(h, b);
        const mf = footprint(m.box, axis);
        f = [
          Math.min(f[0], mf[0]),
          Math.max(f[1], mf[1]),
          Math.min(f[2], mf[2]),
          Math.max(f[3], mf[3]),
        ];
      }
      return { members, lo: l, hi: h, fp: f, lift, path: members[0]!.rel, d: 0 };
    };
    for (const m of sorted) {
      if (!m.lift || m.fixed !== undefined) units.push(unitOf([m], false));
    }
    for (const members of layers.values()) units.push(unitOf(members, true));
    units.sort(
      (a, b) => a.hi - b.hi || a.lo - b.lo || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );

    const stackOk = spend(work, (units.length + group.length) * units.length);
    if (!stackOk) capped = true;
    const ancestors = new Map<Unit, ReadonlySet<string>>();
    const ancestorsOf = (u: Unit): ReadonlySet<string> => {
      let s = ancestors.get(u);
      if (s === undefined) {
        s = new Set(u.members.flatMap((m) => prefixes(m.rel)));
        ancestors.set(u, s);
      }
      return s;
    };
    units.forEach((u, i) => {
      const fixed = u.members[0]?.fixed;
      let d =
        fixed !== undefined && u.members.length === 1
          ? fixed
          : Math.max(...u.members.map((m) => m.k * clearOf(m)));
      if (stackOk && !(fixed !== undefined && u.members.length === 1)) {
        for (let j = 0; j < i; j++) {
          const q = units[j] as Unit;
          const qa = ancestorsOf(q);
          const ua = ancestorsOf(u);
          if (u.members.some((a) => qa.has(a.rel)) || q.members.some((b) => ua.has(b.rel)))
            continue;
          if (!u.lift && !fpOverlap(u.fp, q.fp)) continue;
          d = Math.max(d, q.hi + q.d + gap - u.lo);
        }
      }
      u.d = d;
      for (const m of u.members) distance.set(m.rel, d);
    });
  }
  return { distance, capped };
}
