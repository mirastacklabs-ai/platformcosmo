import type {
  Box3,
  FaceName,
  PrimitiveKind,
  ProjectedFace,
  Projection,
  Vec2,
} from "../contracts/index.js";
import { fmt, round2 } from "./num.js";

/**
 * Primitive solids (PLAN §6) built from visible top/left/right faces.
 *
 * - `cube`, `slab`, `platform`: rectangular boxes (they differ only in the proportions the scene
 *   builder gives them; slab = thin, platform = wide and low).
 * - `hex-prism`: regular hexagon inscribed in the box footprint (ellipse if the footprint is not square).
 * - `cylinder`: ellipse inscribed in the footprint; a circular footprint uses SVG arcs in `d`.
 *
 * Face order is drawing order: `left`, `right`, `top`. Each face name appears at most once, so
 * `IdScheme.face(id, face, part)` stays unique. Curved or multi-sided silhouettes merge the
 * adjacent visible sides into one `left` strip and one `right` strip. Polygons are clockwise
 * in screen space. Faces with zero area (zero-height solids) are omitted.
 */

const CYLINDER_SEGMENTS = 48;
const HEX_SIDES = 6;
const EPS = 1e-9;

interface W2 {
  readonly x: number;
  readonly y: number;
}

function validateBox(box: Box3): void {
  const { origin: o, size: s } = box;
  for (const n of [o.x, o.y, o.z, s.x, s.y, s.z]) {
    if (!Number.isFinite(n)) throw new RangeError("box has a non-finite component");
  }
  if (s.x <= 0 || s.y <= 0 || s.z < 0) {
    throw new RangeError("box size must be > 0 in x and y and >= 0 in z");
  }
}

/** World-space footprint polygon, ordered so the screen polygon runs clockwise. */
function footprint(kind: PrimitiveKind, box: Box3): W2[] {
  const { origin: o, size: s } = box;
  if (kind === "cube" || kind === "slab" || kind === "platform") {
    return [
      { x: o.x, y: o.y },
      { x: o.x + s.x, y: o.y },
      { x: o.x + s.x, y: o.y + s.y },
      { x: o.x, y: o.y + s.y },
    ];
  }
  const n = kind === "hex-prism" ? HEX_SIDES : CYLINDER_SEGMENTS;
  const cx = o.x + s.x / 2;
  const cy = o.y + s.y / 2;
  const pts: W2[] = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push({ x: cx + (s.x / 2) * Math.cos(t), y: cy + (s.y / 2) * Math.sin(t) });
  }
  return pts;
}

/** Outward normal (world x/y) of edge `i` (vertex i to i+1) for a footprint around `c`. */
function edgeNormal(poly: readonly W2[], i: number, c: W2): W2 {
  const a = poly[i] as W2;
  const b = poly[(i + 1) % poly.length] as W2;
  let nx = b.y - a.y;
  let ny = -(b.x - a.x);
  const mx = (a.x + b.x) / 2 - c.x;
  const my = (a.y + b.y) / 2 - c.y;
  if (nx * mx + ny * my < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

function area(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec2;
    const q = points[(i + 1) % points.length] as Vec2;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Path data for a closed polygon. */
export function pointsToPath(points: readonly Vec2[]): string {
  if (points.length === 0) return "";
  return `M${points.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join("L")}Z`;
}

function isCircle(kind: PrimitiveKind, box: Box3): boolean {
  return kind === "cylinder" && Math.abs(box.size.x - box.size.y) < EPS;
}

/** Screen-space ellipse of a circular cylinder's cross-section at the given height. */
function circleEllipse(
  box: Box3,
  projection: Projection,
  z: number,
): { cx: number; cy: number; rx: number; ry: number } {
  const r = box.size.x / 2;
  const c = projection.project({
    x: box.origin.x + r,
    y: box.origin.y + r,
    z,
  });
  const k = r * Math.SQRT2;
  return {
    cx: c.x,
    cy: c.y,
    rx: round2(k * (projection.tileWidth / 2)),
    ry: round2(k * (projection.tileWidth / 4)),
  };
}

function arcPaths(box: Box3, projection: Projection): { top: string; left: string; right: string } {
  const z0 = box.origin.z;
  const z1 = box.origin.z + box.size.z;
  const t = circleEllipse(box, projection, z1);
  const b = circleEllipse(box, projection, z0);
  const A = (rx: number, ry: number, sweep: 0 | 1, x: number, y: number) =>
    `A${fmt(rx)} ${fmt(ry)} 0 0 ${sweep} ${fmt(x)} ${fmt(y)}`;
  const top =
    `M${fmt(t.cx - t.rx)} ${fmt(t.cy)}` +
    A(t.rx, t.ry, 1, t.cx + t.rx, t.cy) +
    A(t.rx, t.ry, 1, t.cx - t.rx, t.cy) +
    "Z";
  const left =
    `M${fmt(t.cx - t.rx)} ${fmt(t.cy)}` +
    A(t.rx, t.ry, 0, t.cx, t.cy + t.ry) +
    `L${fmt(b.cx)} ${fmt(b.cy + b.ry)}` +
    A(b.rx, b.ry, 1, b.cx - b.rx, b.cy) +
    "Z";
  const right =
    `M${fmt(t.cx)} ${fmt(t.cy + t.ry)}` +
    A(t.rx, t.ry, 0, t.cx + t.rx, t.cy) +
    `L${fmt(b.cx + b.rx)} ${fmt(b.cy)}` +
    A(b.rx, b.ry, 1, b.cx, b.cy + b.ry) +
    "Z";
  return { top, left, right };
}

/**
 * Visible faces of a primitive, projected to screen space, in drawing order
 * (`left`, `right`, `top`).
 */
export function primitiveFaces(
  kind: PrimitiveKind,
  box: Box3,
  projection: Projection,
): ProjectedFace[] {
  validateBox(box);
  const poly = footprint(kind, box);
  const n = poly.length;
  const z0 = box.origin.z;
  const z1 = box.origin.z + box.size.z;
  const c: W2 = { x: box.origin.x + box.size.x / 2, y: box.origin.y + box.size.y / 2 };
  const proj = (p: W2, z: number): Vec2 => projection.project({ x: p.x, y: p.y, z });
  const topRing = poly.map((p) => proj(p, z1));
  const botRing = poly.map((p) => proj(p, z0));

  // Classify edges: visible when the outward normal faces the viewer (+x/+y);
  // left when it points to the lower-left of the screen, right otherwise.
  const kindOf: (FaceName | null)[] = [];
  for (let i = 0; i < n; i++) {
    const nrm = edgeNormal(poly, i, c);
    if (nrm.x + nrm.y <= EPS) kindOf.push(null);
    else kindOf.push(nrm.x - nrm.y < -EPS ? "left" : "right");
  }

  const strip = (which: "left" | "right"): Vec2[] | undefined => {
    // Edges of this kind in cyclic order; start at the one whose predecessor is not of this kind.
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (kindOf[i] === which) idx.push(i);
    if (idx.length === 0) return undefined;
    let first = idx[0] as number;
    for (const i of idx) {
      if (kindOf[(i + n - 1) % n] !== which) {
        first = i;
        break;
      }
    }
    const run: number[] = [];
    for (let j = 0; j < n && kindOf[(first + j) % n] === which; j++) run.push((first + j) % n);
    const a = run[0] as number;
    const bEnd = ((run[run.length - 1] as number) + 1) % n;
    const topPart: Vec2[] = [];
    const botPart: Vec2[] = [];
    for (let v = a; ; v = (v + 1) % n) {
      topPart.push(topRing[v] as Vec2);
      botPart.push(botRing[v] as Vec2);
      if (v === bEnd) break;
    }
    return [...topPart.reverse(), ...botPart];
  };

  const arcs = isCircle(kind, box) ? arcPaths(box, projection) : undefined;
  const faces: ProjectedFace[] = [];
  for (const which of ["left", "right"] as const) {
    const pts = strip(which);
    if (!pts || Math.abs(area(pts)) < EPS) continue;
    faces.push(arcs ? { face: which, points: pts, d: arcs[which] } : { face: which, points: pts });
  }
  faces.push(
    arcs ? { face: "top", points: topRing, d: arcs.top } : { face: "top", points: topRing },
  );
  return faces;
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Convex hull (monotone chain), clockwise in screen space, collinear points dropped. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  const uniq = pts.filter(
    (p, i) => i === 0 || p.x !== (pts[i - 1] as Vec2).x || p.y !== (pts[i - 1] as Vec2).y,
  );
  if (uniq.length < 3) return uniq;
  const build = (input: readonly Vec2[]): Vec2[] => {
    const h: Vec2[] = [];
    for (const p of input) {
      while (h.length >= 2 && cross(h[h.length - 2] as Vec2, h[h.length - 1] as Vec2, p) <= 0)
        h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  const lower = build(uniq);
  const upper = build([...uniq].reverse());
  const hull = [...lower, ...upper];
  // Monotone chain with `cross <= 0` pops yields counter-clockwise in a y-up frame, which is
  // clockwise on screen (y down): confirm and fix if not.
  return area(hull) < 0 ? hull.reverse() : hull;
}

export interface Silhouette {
  readonly points: readonly Vec2[];
  /** Path data (arcs for circular cylinders, polygon otherwise). */
  readonly d: string;
}

/** Outline of the whole solid: used for state overlays and hit areas. */
export function primitiveSilhouette(
  kind: PrimitiveKind,
  box: Box3,
  projection: Projection,
): Silhouette {
  const faces = primitiveFaces(kind, box, projection);
  const hull = convexHull(faces.flatMap((f) => f.points));
  if (isCircle(kind, box)) {
    const z0 = box.origin.z;
    const t = circleEllipse(box, projection, box.origin.z + box.size.z);
    const b = circleEllipse(box, projection, z0);
    const A = (rx: number, ry: number, x: number, y: number) =>
      `A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x)} ${fmt(y)}`;
    const d =
      `M${fmt(t.cx - t.rx)} ${fmt(t.cy)}` +
      A(t.rx, t.ry, t.cx + t.rx, t.cy) +
      `L${fmt(b.cx + b.rx)} ${fmt(b.cy)}` +
      A(b.rx, b.ry, b.cx - b.rx, b.cy) +
      "Z";
    return { points: hull, d };
  }
  return { points: hull, d: pointsToPath(hull) };
}

/** Face path data: `d` when present, else the polygon. */
export function faceToPath(face: ProjectedFace): string {
  return face.d ?? pointsToPath(face.points);
}
