import type { Box3 } from "../contracts/index.js";

/**
 * Box predicates for depth epochs (assemblies §9.5): closed containment, union of touching
 * solids, crossings, and the certificates used by `epochs.ts`.
 *
 * Every predicate works on `Bounds` (`[minX, minY, minZ, maxX, maxY, maxZ]`, world units) and is
 * CLOSED with the tolerance `EPS = 1e-6` world units: a value within `EPS` of a bound counts as on
 * it, so flush faces are inside (a camshaft flush with a cover's ends is enclosed by it), touching
 * faces separate, and two boxes interpenetrate only when they overlap by more than `EPS` on every
 * axis. The same `EPS` is used everywhere, so a pair is never "separated" by one test and
 * "interpenetrating" by another.
 *
 * Certificates take the RELATIVE displacement interval of `p` with respect to `s` over a time
 * interval: `lo`/`hi` per axis, such that `p(t) = p + r(t)` in `s`'s frame with
 * `lo ≤ r(t) ≤ hi` for every t of the interval. A certificate that holds for the whole interval
 * box holds at every time of the interval (each condition is monotone in `r`, so checking the
 * worst corner of the interval suffices). With `lo = hi = r` they are exact pose tests.
 *
 * Viewer: looks along `-(1, 1, k)`, `k > 0`, so for every axis a larger coordinate is nearer.
 */

export const EPS = 1e-6;

/** `[minX, minY, minZ, maxX, maxY, maxZ]`. */
export type Bounds = readonly [number, number, number, number, number, number];
export type Vec = readonly [number, number, number];

export const ZERO: Vec = [0, 0, 0];

export function toBounds(box: Box3): Bounds {
  const o = box.origin;
  const s = box.size;
  return [o.x, o.y, o.z, o.x + s.x, o.y + s.y, o.z + s.z];
}

export function fromBounds(b: Bounds): Box3 {
  return {
    origin: { x: b[0], y: b[1], z: b[2] },
    size: { x: b[3] - b[0], y: b[4] - b[1], z: b[5] - b[2] },
  };
}

export function shift(b: Bounds, d: Vec): Bounds {
  return [b[0] + d[0], b[1] + d[1], b[2] + d[2], b[3] + d[0], b[4] + d[1], b[5] + d[2]];
}

/** `b ⊕ [lo, hi]` (Minkowski sum with an axis-aligned interval box). */
export function sweep(b: Bounds, lo: Vec, hi: Vec): Bounds {
  return [b[0] + lo[0], b[1] + lo[1], b[2] + lo[2], b[3] + hi[0], b[4] + hi[1], b[5] + hi[2]];
}

export function unionBounds(list: readonly Bounds[]): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const b of list) {
    if (b[0] < x0) x0 = b[0];
    if (b[1] < y0) y0 = b[1];
    if (b[2] < z0) z0 = b[2];
    if (b[3] > x1) x1 = b[3];
    if (b[4] > y1) y1 = b[4];
    if (b[5] > z1) z1 = b[5];
  }
  return [x0, y0, z0, x1, y1, z1];
}

/** Closed containment `inner ⊆ outer`. */
export function containsClosed(outer: Bounds, inner: Bounds): boolean {
  for (let k = 0; k < 3; k++) {
    if (inner[k]! < outer[k]! - EPS || inner[k + 3]! > outer[k + 3]! + EPS) return false;
  }
  return true;
}

/** Interiors overlap: more than `EPS` on every axis. */
export function interpenetrates(a: Bounds, b: Bounds): boolean {
  for (let k = 0; k < 3; k++) {
    if (Math.min(a[k + 3]!, b[k + 3]!) - Math.max(a[k]!, b[k]!) <= EPS) return false;
  }
  return true;
}

/**
 * Two solids form one block when their boxes interpenetrate or share a face (flush on one axis
 * within `EPS`, overlapping by more than `EPS` on the other two). Edges or corners only do not.
 */
export function touches(a: Bounds, b: Bounds): boolean {
  let flush = 0;
  for (let k = 0; k < 3; k++) {
    const ov = Math.min(a[k + 3]!, b[k + 3]!) - Math.max(a[k]!, b[k]!);
    if (ov > EPS) continue;
    if (ov < -EPS) return false;
    flush++;
  }
  return flush <= 1;
}

/** Largest number of boxes `insideUnion` accepts (cells grow as (2k + 1)^3). */
export const MAX_UNION_BOXES = 8;

/**
 * Closed containment of `inner` in the union of `boxes` (§9.5 "union of touching solids"), by
 * coordinate compression: `inner` is cut at every box face inside it and each cell's centre must
 * lie in some box. Exact for axis-aligned boxes. Returns `false` beyond `MAX_UNION_BOXES` (the
 * caller then only uses single-solid enclosure) and for an empty union.
 */
export function insideUnion(inner: Bounds, boxes: readonly Bounds[]): boolean {
  if (boxes.length === 0 || boxes.length > MAX_UNION_BOXES) return false;
  for (const b of boxes) if (containsClosed(b, inner)) return true;
  const cuts: number[][] = [[], [], []];
  for (let k = 0; k < 3; k++) {
    const lo = inner[k]!;
    const hi = inner[k + 3]!;
    const c = [lo];
    for (const b of boxes) {
      for (const v of [b[k]!, b[k + 3]!]) if (v > lo + EPS && v < hi - EPS) c.push(v);
    }
    c.push(hi);
    c.sort((p, q) => p - q);
    const dedup: number[] = [];
    for (const v of c) if (dedup.length === 0 || v - dedup[dedup.length - 1]! > EPS) dedup.push(v);
    if (dedup.length === 1) dedup.push(dedup[0]!); // zero thickness: one degenerate cell
    cuts[k] = dedup;
  }
  const [cx, cy, cz] = cuts as [number[], number[], number[]];
  for (let i = 0; i + 1 < cx.length; i++) {
    const x = (cx[i]! + cx[i + 1]!) / 2;
    for (let j = 0; j + 1 < cy.length; j++) {
      const y = (cy[j]! + cy[j + 1]!) / 2;
      for (let l = 0; l + 1 < cz.length; l++) {
        const z = (cz[l]! + cz[l + 1]!) / 2;
        let covered = false;
        for (const b of boxes) {
          if (
            x >= b[0] - EPS &&
            x <= b[3] + EPS &&
            y >= b[1] - EPS &&
            y <= b[4] + EPS &&
            z >= b[2] - EPS &&
            z <= b[5] + EPS
          ) {
            covered = true;
            break;
          }
        }
        if (!covered) return false;
      }
    }
  }
  return true;
}

/**
 * Points inside `p` at EVERY relative offset of `[lo, hi]` (`∩_r p + r`), or `undefined` when that
 * intersection is empty on some axis. If the core is not inside a region, `p` is never inside it.
 */
export function core(p: Bounds, lo: Vec, hi: Vec): Bounds | undefined {
  const c: Bounds = [
    p[0] + hi[0],
    p[1] + hi[1],
    p[2] + hi[2],
    p[3] + lo[0],
    p[4] + lo[1],
    p[5] + lo[2],
  ];
  for (let k = 0; k < 3; k++) if (c[k]! > c[k + 3]! + EPS) return undefined;
  return c;
}

// ---------------------------------------------------------------------------------------------
// Certificates over a relative displacement interval (p relative to s)
// ---------------------------------------------------------------------------------------------

/**
 * `p` is behind `s` on some axis at every offset (`p.max_k + hi_k ≤ s.min_k`): `p` before `s`.
 * Returns the axis (0..2) or -1. This is the separating test of §9.3 step 2.
 */
export function behindAxis(p: Bounds, s: Bounds, hi: Vec): number {
  for (let k = 0; k < 3; k++) if (p[k + 3]! + hi[k]! <= s[k]! + EPS) return k;
  return -1;
}

/** `s` is behind `p` on some axis at every offset (`s.max_k ≤ p.min_k + lo_k`): `s` before `p`. */
export function frontAxis(p: Bounds, s: Bounds, lo: Vec): number {
  for (let k = 0; k < 3; k++) if (s[k + 3]! <= p[k]! + lo[k]! + EPS) return k;
  return -1;
}

/**
 * Weak-behind (generalized hidden-face exit, §9.5): `p` never reaches past any VISIBLE face of the
 * solid box `s` (`p.max_k + hi_k ≤ s.max_k` on every axis). Then drawing `p` before `s` is
 * correct wherever they overlap on screen: a point of `p` is either inside `s` (covered by `s`'s
 * front surface) or below `s.min_k` on some axis, so the part of its view ray behind it has
 * smaller `k` and never meets `s`; whatever of `s` lies on that ray is in front of it. This covers
 * enclosure in one solid, crossing a hidden face (`-x`, `-y`, `-z`) and plain separation behind.
 */
export function weakBehind(p: Bounds, s: Bounds, hi: Vec): boolean {
  for (let k = 0; k < 3; k++) if (p[k + 3]! + hi[k]! > s[k + 3]! + EPS) return false;
  return true;
}

/** `p ⊆ s` at every offset. */
export function enclosedThroughout(p: Bounds, s: Bounds, lo: Vec, hi: Vec): boolean {
  for (let k = 0; k < 3; k++) {
    if (p[k]! + lo[k]! < s[k]! - EPS || p[k + 3]! + hi[k]! > s[k + 3]! + EPS) return false;
  }
  return true;
}

/** `p ⊄ s` at every offset (some axis where the offsets that would fit are all outside `[lo, hi]`). */
export function neverEnclosed(p: Bounds, s: Bounds, lo: Vec, hi: Vec): boolean {
  for (let k = 0; k < 3; k++) {
    // p fits along k iff r ∈ [s.min − p.min − EPS, s.max − p.max + EPS]
    const a = s[k]! - p[k]! - EPS;
    const b = s[k + 3]! - p[k + 3]! + EPS;
    if (a > b || hi[k]! < a || lo[k]! > b) return true;
  }
  return false;
}

/**
 * The "hide" configuration of §9.5 for a pair without a valid clip: `p` overlaps the inside of `s`
 * on every axis, reaches past no hidden face of `s`, and reaches past at most one visible face
 * (that face is crossed; zero faces = enclosed). Drawing `p` would show the part inside `s`, so
 * `p` is hidden (enclosure, or `assembly/clip-fallback` "hidden until clear").
 * `hideThroughout` certifies it for every offset; `neverHide` certifies the opposite.
 */
export function hideThroughout(p: Bounds, s: Bounds, lo: Vec, hi: Vec): boolean {
  let over = 0;
  for (let k = 0; k < 3; k++) {
    if (p[k]! + lo[k]! < s[k]! - EPS) return false; // may reach past a hidden face
    if (p[k]! + hi[k]! >= s[k + 3]! - EPS) return false; // may be clear of the inside
    if (p[k + 3]! + hi[k]! > s[k + 3]! + EPS) over++;
  }
  return over <= 1;
}

export function neverHide(p: Bounds, s: Bounds, lo: Vec, hi: Vec): boolean {
  let surely = 0;
  for (let k = 0; k < 3; k++) {
    if (p[k]! + hi[k]! < s[k]! - EPS) return true; // always reaches past a hidden face
    if (p[k]! + lo[k]! >= s[k + 3]! - EPS) return true; // always clear of the inside
    if (p[k + 3]! + lo[k]! > s[k + 3]! + EPS) surely++;
  }
  return surely >= 2; // always reaches past two visible faces: a collision, not a crossing
}

/** Interiors overlap at every offset (overlap per axis is concave in r: check both ends). */
export function interpenetratesThroughout(p: Bounds, s: Bounds, lo: Vec, hi: Vec): boolean {
  for (let k = 0; k < 3; k++) {
    for (const r of [lo[k]!, hi[k]!]) {
      if (Math.min(p[k + 3]! + r, s[k + 3]!) - Math.max(p[k]! + r, s[k]!) <= EPS) return false;
    }
  }
  return true;
}

/** Interiors may overlap at some offset (the relative swept box interpenetrates `s`). */
export function mayInterpenetrate(p: Bounds, s: Bounds, lo: Vec, hi: Vec): boolean {
  for (let k = 0; k < 3; k++) {
    if (p[k]! + lo[k]! >= s[k + 3]! - EPS || p[k + 3]! + hi[k]! <= s[k]! + EPS) return false;
  }
  return true;
}

/** `mayInterpenetrate(p, s, -hi, -lo)` without allocating (the interval given is s relative to p). */
export function mayInterpenetrateNeg(p: Bounds, s: Bounds, lo: Vec, hi: Vec): boolean {
  for (let k = 0; k < 3; k++) {
    if (p[k]! - hi[k]! >= s[k + 3]! - EPS || p[k + 3]! - lo[k]! <= s[k]! + EPS) return false;
  }
  return true;
}

/**
 * A sanctioned interpenetration at one pose (not a collision): one box inside the other, or a
 * one-face crossing (the footprint ⊥ some axis lies inside the other's face and the box reaches
 * past exactly one side along that axis).
 */
export function seatedOrEnclosed(a: Bounds, b: Bounds): boolean {
  return (
    containsClosed(a, b) || containsClosed(b, a) || oneFaceCrossing(a, b) || oneFaceCrossing(b, a)
  );
}

function oneFaceCrossing(p: Bounds, s: Bounds): boolean {
  for (let k = 0; k < 3; k++) {
    let inside = true;
    for (let j = 0; j < 3; j++) {
      if (j === k) continue;
      if (p[j]! < s[j]! - EPS || p[j + 3]! > s[j + 3]! + EPS) inside = false;
    }
    if (!inside) continue;
    const below = p[k]! < s[k]! - EPS;
    const above = p[k + 3]! > s[k + 3]! + EPS;
    if (below !== above) return true;
  }
  return false;
}

/** Footprint of `p` ⊥ axis `k` lies inside `s`'s face ⊥ `k` (closed). */
export function footprintInside(p: Bounds, s: Bounds, k: number): boolean {
  for (let j = 0; j < 3; j++) {
    if (j === k) continue;
    if (p[j]! < s[j]! - EPS || p[j + 3]! > s[j + 3]! + EPS) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Blocks: union of touching solids
// ---------------------------------------------------------------------------------------------

/**
 * Connected blocks of touching solids, as a block id per input index (the smallest member
 * index, so ids are deterministic). `pairs` lists the candidate pairs (i < j) to test; pairs the
 * caller knows are not rigidly connected must be left out.
 */
export function blocksOf(
  n: number,
  pairs: readonly (readonly [number, number])[],
  boxes: readonly Bounds[],
): Int32Array {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    let c = x;
    while (parent[c] !== r) {
      const next = parent[c]!;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  for (const [i, j] of pairs) {
    if (!touches(boxes[i]!, boxes[j]!)) continue;
    const a = find(i);
    const b = find(j);
    if (a !== b) {
      if (a < b) parent[b] = a;
      else parent[a] = b;
    }
  }
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = find(i);
  return out;
}
