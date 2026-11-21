/**
 * Geometry helpers of leader-label anchoring (docs/design/assemblies.md §6.6): surface samples
 * of a node, the view-ray occlusion test, projected hulls and rect/polygon overlap. Pure.
 */
import type { Box3, Rect, Vec2, Vec3 } from "../../contracts/index.js";
import { boxCorners } from "../../geometry/index.js";

const NEAR = 1e-6;

/** A point on a viewer-facing face of a primitive, in the rest pose, in an `n × n` face grid. */
export interface Sample {
  readonly world: Vec3;
  /** Index of the node's leaf it lies on. */
  readonly leaf: number;
  /** Index (in the sample list) of the first sample of its face, the grid size and its cell. */
  readonly base: number;
  readonly n: number;
  readonly cell: number;
}

/** `n × n` points on each of the three faces of `b` that face the viewer (+x, +y, +z). */
export function faceSamples(b: Box3, leaf: number, n: number, out: Sample[]): void {
  const { origin: o, size: s } = b;
  const steps = Array.from({ length: n }, (_, k) => (k + 0.5) / n);
  for (let face = 0; face < 3; face++) {
    const base = out.length;
    for (const u of steps) {
      for (const v of steps) {
        const world =
          face === 0
            ? { x: o.x + s.x, y: o.y + u * s.y, z: o.z + v * s.z }
            : face === 1
              ? { x: o.x + u * s.x, y: o.y + s.y, z: o.z + v * s.z }
              : { x: o.x + u * s.x, y: o.y + v * s.y, z: o.z + s.z };
        out.push({ world, leaf, base, n, cell: out.length - base });
      }
    }
  }
}

/** Indexes of the samples next to `s` in its face grid (8-neighbourhood). */
export function neighbours(s: Sample): number[] {
  const i = Math.floor(s.cell / s.n);
  const j = s.cell % s.n;
  const out: number[] = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const a = i + di;
      const b = j + dj;
      if ((di !== 0 || dj !== 0) && a >= 0 && a < s.n && b >= 0 && b < s.n)
        out.push(s.base + a * s.n + b);
    }
  }
  return out;
}

/** Whether the ray `p + s·dir` (s > 0) passes through the interior of `box`. */
export function rayHits(p: Vec3, dir: Vec3, box: Box3): boolean {
  let lo = 0;
  let hi = Infinity;
  for (const a of ["x", "y", "z"] as const) {
    const a0 = box.origin[a] + NEAR;
    const a1 = box.origin[a] + box.size[a] - NEAR;
    if (a1 <= a0) return false;
    const t0 = (a0 - p[a]) / dir[a];
    const t1 = (a1 - p[a]) / dir[a];
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
    if (hi - lo <= NEAR) return false;
  }
  return hi > NEAR;
}

export const containsPoint = (r: Rect, p: Vec2): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

export const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export const inflate = (r: Rect, d: number): Rect => ({
  x: r.x - d,
  y: r.y - d,
  width: r.width + 2 * d,
  height: r.height + 2 * d,
});

/** Convex hull (monotone chain, counter-clockwise on screen) of the projected corners of boxes. */
export function hullOfBoxes(
  boxes: readonly Box3[],
  project: (p: Vec3) => Vec2,
  shift: Vec3,
): Vec2[] {
  const pts = boxes
    .flatMap((b) =>
      boxCorners({
        origin: { x: b.origin.x + shift.x, y: b.origin.y + shift.y, z: b.origin.z + shift.z },
        size: b.size,
      }),
    )
    .map(project)
    .sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: Vec2, p: Vec2, q: Vec2): number =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const half = (list: readonly Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of list) {
      while (
        out.length >= 2 &&
        cross(out[out.length - 2] as Vec2, out[out.length - 1] as Vec2, p) <= 0
      )
        out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

export function boundsOf(pts: readonly Vec2[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return pts.length === 0
    ? { x: 0, y: 0, width: 0, height: 0 }
    : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Whether the convex polygon `outer` contains every point of `inner` (within `slack`). */
export function hullContains(outer: readonly Vec2[], inner: readonly Vec2[], slack = 0.5): boolean {
  if (outer.length < 3) return false;
  return inner.every((p) =>
    outer.every((a, i) => {
      const b = outer[(i + 1) % outer.length] as Vec2;
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len >= -slack;
    }),
  );
}

/** Area of the intersection of a convex polygon with a rect (Sutherland-Hodgman). */
export function clipArea(poly: readonly Vec2[], r: Rect): number {
  let pts: Vec2[] = [...poly];
  const edges: ((p: Vec2) => number)[] = [
    (p) => p.x - r.x,
    (p) => r.x + r.width - p.x,
    (p) => p.y - r.y,
    (p) => r.y + r.height - p.y,
  ];
  for (const inside of edges) {
    const next: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i] as Vec2;
      const b = pts[(i + 1) % pts.length] as Vec2;
      const da = inside(a);
      const db = inside(b);
      if (da >= 0) next.push(a);
      if (da >= 0 !== db >= 0) {
        const u = da / (da - db);
        next.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
      }
    }
    pts = next;
    if (pts.length < 3) return 0;
  }
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as Vec2;
    const b = pts[(i + 1) % pts.length] as Vec2;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/** Overlap area of two rects. */
export function rectArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
