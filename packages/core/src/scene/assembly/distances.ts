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
  lo: number;
  hi: number;
  /** Footprint (the two axes perpendicular to u) as [a0, a1, b0, b1]. */
  fp: readonly [number, number, number, number];
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

  const moverRels = new Set(movers.map((m) => m.rel));
  /** Movers that are proper ancestors of `rel`, outermost first. */
  const moverAncestors = (rel: string): string[] =>
    prefixes(rel)
      .slice(0, -1)
      .filter((p) => moverRels.has(p));

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

  // displacement (local units) of every mover once its distance is known; ancestors are solved
  // before their descendants, so a descendant is placed in the frame its ancestors moved to
  const off = new Map<string, [number, number, number]>();
  const settle = (m: Mover, d: number): void => {
    distance.set(m.rel, d);
    off.set(m.rel, [m.u[0] * d, m.u[1] * d, m.u[2] * d]);
  };
  const shiftOf = (rels: readonly string[]): [number, number, number] => {
    const v: [number, number, number] = [0, 0, 0];
    for (const r of rels) {
      const o = off.get(r);
      if (o !== undefined) {
        v[0] += o[0];
        v[1] += o[1];
        v[2] += o[2];
      }
    }
    return v;
  };
  const shifted = (b: LBox, v: readonly number[]): LBox => ({
    x0: b.x0 + (v[0] as number),
    x1: b.x1 + (v[0] as number),
    y0: b.y0 + (v[1] as number),
    y1: b.y1 + (v[1] as number),
    z0: b.z0 + (v[2] as number),
    z1: b.z1 + (v[2] as number),
  });

  const groups = new Map<string, Mover[]>();
  for (const m of movers) {
    const ax = axisOf(m.u);
    if (ax === undefined) continue;
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

  interface PUnit extends Unit {
    readonly key: string;
    readonly axis: 0 | 1 | 2;
    readonly sign: 1 | -1;
  }
  const pending: PUnit[] = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key) as Mover[];
    const { axis, sign } = axisOf(group[0]!.u) as { axis: 0 | 1 | 2; sign: 1 | -1 };
    // units: lift movers with equal rest min_u share one layer; every other mover is alone
    const sorted = [...group].sort((a, b) => {
      const [al, ah] = span(a.box, axis, sign);
      const [bl, bh] = span(b.box, axis, sign);
      return ah - bh || al - bl || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
    });
    // a layer never holds a mover together with its own ancestor or descendant
    const layerList: { base: number; members: Mover[] }[] = [];
    for (const m of sorted.filter((x) => x.lift && x.fixed === undefined)) {
      const base = span(m.box, axis, sign)[0];
      const layer = layerList.find(
        (l) =>
          Math.abs(l.base - base) <= EPS &&
          !l.members.some((o) => m.rel.startsWith(`${o.rel}/`) || o.rel.startsWith(`${m.rel}/`)),
      );
      if (layer === undefined) layerList.push({ base, members: [m] });
      else layer.members.push(m);
    }
    const mk = (members: Mover[], lift: boolean): PUnit => {
      let l = Infinity;
      let h = -Infinity;
      for (const m of members) {
        const [a, b] = span(m.box, axis, sign);
        l = Math.min(l, a);
        h = Math.max(h, b);
      }
      return {
        members,
        lo: l,
        hi: h,
        fp: [0, 0, 0, 0],
        lift,
        path: members[0]!.rel,
        d: 0,
        key,
        axis,
        sign,
      };
    };
    const units: PUnit[] = [];
    for (const m of sorted) if (!m.lift || m.fixed !== undefined) units.push(mk([m], false));
    for (const l of layerList) units.push(mk(l.members, true));
    units.sort(
      (a, b) => a.hi - b.hi || a.lo - b.lo || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
    pending.push(...units);
  }
  // non-axis and explicit-number-on-no-axis movers need no stacking: their offsets are known now
  // (ancestors first, so shifts below see them)
  for (const m of [...movers].sort((a, b) => a.rel.split("/").length - b.rel.split("/").length)) {
    if (axisOf(m.u) === undefined) settle(m, m.fixed ?? m.k * (extentAlong(m.box, m.u) + gap));
  }

  const stackOk = spend(work, (pending.length + movers.length) * pending.length);
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
  const done: PUnit[] = [];
  const doneRels = new Set<string>(off.keys());
  while (pending.length > 0) {
    // the earliest unit whose mover ancestors are all placed (ancestors are shallower: never stuck)
    let at = pending.findIndex((u) =>
      u.members.every((m) => moverAncestors(m.rel).every((r) => doneRels.has(r))),
    );
    if (at < 0) at = 0;
    const u = pending.splice(at, 1)[0] as PUnit;
    const { axis, sign } = u;

    const eff = u.members.map((m) => ({ m, box: shifted(m.box, shiftOf(moverAncestors(m.rel))) }));
    let lo = Infinity;
    let hi = -Infinity;
    let fp: [number, number, number, number] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const { box } of eff) {
      const [a, b] = span(box, axis, sign);
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
      const f = footprint(box, axis);
      fp = [
        Math.min(fp[0], f[0]),
        Math.max(fp[1], f[1]),
        Math.min(fp[2], f[2]),
        Math.max(fp[3], f[3]),
      ];
    }

    const clearOf = (m: Mover, mbox: LBox): number => {
      const [pMin, pMax] = span(mbox, axis, sign);
      let clear = pMax - pMin + gap;
      if (m.drawer) {
        const [, oMax] = span(owner, axis, sign);
        clear = Math.max(clear, oMax - pMin + gap);
      }
      if (scanObstacles) {
        const fp2 = footprint(mbox, axis);
        const mine = chainOf(m.rel);
        for (const e of leaves) {
          if (e.item === m.item || e.chain.some((r) => r === m.rel)) continue; // moves with p
          if (e.chain.some((r) => !mine.has(r))) continue; // moves relative to p
          const ebox = shifted(e.box, shiftOf(e.chain));
          if (!fpOverlap(fp2, footprint(ebox, axis))) continue;
          const [, eMax] = span(ebox, axis, sign);
          if (eMax > pMin + EPS) clear = Math.max(clear, eMax - pMin + gap);
        }
      }
      return clear;
    };

    const fixed = u.members[0]?.fixed;
    const single = fixed !== undefined && u.members.length === 1;
    let d = single
      ? (fixed as number)
      : Math.max(...eff.map(({ m, box }) => m.k * clearOf(m, box)));
    if (stackOk && !single) {
      const ua = ancestorsOf(u);
      for (const q of done) {
        if (q.key !== u.key) continue;
        const qa = ancestorsOf(q);
        if (u.members.some((a) => qa.has(a.rel)) || q.members.some((b) => ua.has(b.rel))) continue;
        if (!u.lift && !fpOverlap(fp, q.fp)) continue;
        d = Math.max(d, q.hi + q.d + gap - lo);
      }
    }
    u.d = d;
    u.fp = fp;
    u.hi = hi;
    u.lo = lo;
    for (const m of u.members) {
      settle(m, d);
      doneRels.add(m.rel);
    }
    done.push(u);
  }
  return { distance, capped };
}
