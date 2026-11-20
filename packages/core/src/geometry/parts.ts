import type {
  Axis,
  Box3,
  PartGeometry,
  PartImagePlacement,
  PartPrimitive,
  PartPrimitiveKind,
  PartTone,
  ProjectedFace,
  Projection,
  QuarterTurn,
  Vec2,
  Vec3,
} from "../contracts/index.js";
import type { SpecColor } from "../schema/types.gen.js";
import { convexHull, pointsToPath, primitiveFaces, primitiveSilhouette } from "./primitives.js";
import type { Silhouette } from "./primitives.js";
import { boxCorners } from "./projection.js";

/**
 * Part primitives (assemblies §5, §9.6). Geometry of the leaf-part solids, projected to screen
 * space with the same rounding as `primitiveFaces`.
 *
 * Inputs are WORLD-space boxes: callers (A2 resolve, E-3 `build`) apply the `AssemblyFrame`
 * scale and quarter turn first, so `size` is the post-rotation extent (a wedge's `rotate` only
 * turns its slope inside that box). Callers also validate sizes first: every function here
 * throws `RangeError` on a non-finite or degenerate input, and the caller turns that into a
 * diagnostic.
 *
 * Conventions (shared with `primitiveFaces`):
 * - Faces come in painter's order (back to front) and polygons are clockwise on screen.
 * - A face is visible when its outward normal `n` satisfies `n · d > 0`, where
 *   `d = (1, 1, tileWidth / (2 * zScale))` is the direction toward the viewer.
 * - Names follow the dominant normal: `+x` is `right`, `+y` is `left`, up is `top`. A wedge's
 *   slope is always `top`. Within one primitive (and, for splits, one half) each face name
 *   appears at most once, so `ids.face(id, face, part)` stays unique.
 * - Circular primitives along `x`/`y` and rings are drawn by this module; boxes, plates, cards,
 *   prisms and `z` cylinders delegate to `primitiveFaces` (which stays untouched).
 *
 * Splits (§9.6). `tray` is emitted by `partGeometry` as five real `box` primitives
 * (`<id>.floor`, `.wall-nx`, `.wall-ny` in `split.back`; `.wall-px`, `.wall-py` in
 * `split.front`), so A1-2a certifies each half as ordinary boxes and contents sort between
 * them. `ring` is emitted as two primitives `<id>.back` / `<id>.front` of kind `ring`. A half
 * of a ring is not an axis-aligned box, so there is no box to certify: A1-2a orders a ring's
 * halves with forced edges (`back` before contents before `front`). It finds the half of a
 * primitive with `halfOf(geometry, primitiveId)` and draws it with
 * `partPrimitiveFaces(prim, projection, half)` (or `partGeometryFaces`, which does both).
 */

const EPS = 1e-9;
const ARC_STEP = Math.PI / 24; // 48 segments per revolution, as the existing cylinder

/** Ring bore radius as a fraction of the outer radius (the contract has no field for it). */
export const RING_INNER_RATIO = 0.6;
/** Tray wall (and floor) thickness as a fraction of the smaller footprint side. */
export const TRAY_WALL_RATIO = 0.12;

export type Half = "back" | "front";

/** A projected part face. `half` is set for faces of a split primitive's depth items. */
export interface PartFace extends ProjectedFace {
  readonly half?: Half;
}

/** Kinds that are circular along an axis. */
export const CIRCULAR_KINDS: ReadonlySet<PartPrimitiveKind> = new Set([
  "cylinder",
  "shaft",
  "stud",
  "ring",
]);

function validate(prim: PartPrimitive): void {
  const { origin: o, size: s } = prim.box;
  for (const n of [o.x, o.y, o.z, s.x, s.y, s.z]) {
    if (!Number.isFinite(n)) throw new RangeError("box has a non-finite component");
  }
  if (s.x < 0 || s.y < 0 || s.z < 0) throw new RangeError("box size must be >= 0");
  if (prim.kind === "wedge") {
    const r = prim.rotate ?? 0;
    if (r !== 0 && r !== 90 && r !== 180 && r !== 270) {
      throw new RangeError(`wedge rotate must be 0, 90, 180 or 270 (got ${String(r)})`);
    }
  }
  if (prim.kind === "sprite") {
    if (s.x + s.y <= 0) throw new RangeError("sprite box needs a positive footprint");
    return;
  }
  // Circular kinds need a cross-section (the two axes other than `axis`); others need x and y.
  const axis = CIRCULAR_KINDS.has(prim.kind) ? (prim.axis ?? "z") : "z";
  for (const k of ["x", "y", "z"] as const) {
    if (k !== axis && s[k] <= 0) {
      throw new RangeError(`box size must be > 0 in ${k}`);
    }
  }
  if (prim.kind === "tray" && s.z <= 0) throw new RangeError("tray needs a height > 0");
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

/** Clockwise (positive shoelace area, y down); drops consecutive duplicates after rounding. */
function clockwise(points: Vec2[]): Vec2[] {
  const pts = points.filter((p, i) => {
    const q = points[(i + points.length - 1) % points.length] as Vec2;
    return i === 0 ? true : p.x !== q.x || p.y !== q.y;
  });
  return area(pts) < 0 ? pts.reverse() : pts;
}

function makeFace(
  face: ProjectedFace["face"],
  points: Vec3[],
  projection: Projection,
  half?: Half,
): PartFace | undefined {
  const pts = clockwise(points.map((p) => projection.project(p)));
  if (pts.length < 3 || Math.abs(area(pts)) < EPS) return undefined;
  return half ? { face, points: pts, half } : { face, points: pts };
}

function viewDir(projection: Projection): Vec3 {
  return { x: 1, y: 1, z: projection.tileWidth / 2 / projection.zScale };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Tone name of a face by its dominant outward normal. */
function faceOf(n: Vec3): ProjectedFace["face"] {
  if (n.z >= Math.max(n.x, n.y) - EPS) return "top";
  return n.x >= n.y ? "right" : "left";
}

// ---------------------------------------------------------------------------------------------
// Boxes, prisms
// ---------------------------------------------------------------------------------------------

function boxLikeFaces(prim: PartPrimitive, projection: Projection): PartFace[] {
  const kind = prim.kind === "prism" ? "hex-prism" : prim.kind === "plate" ? "slab" : "cube";
  return primitiveFaces(kind, prim.box, projection);
}

// ---------------------------------------------------------------------------------------------
// Wedge
// ---------------------------------------------------------------------------------------------

const ROTATIONS: Readonly<Record<QuarterTurn, { u: Vec3; v: Vec3 }>> = {
  // `u` runs from the high side to the low side, `v` across the slope.
  0: { u: { x: 1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
  90: { u: { x: 0, y: 1, z: 0 }, v: { x: 1, y: 0, z: 0 } },
  180: { u: { x: -1, y: 0, z: 0 }, v: { x: 0, y: 1, z: 0 } },
  270: { u: { x: 0, y: -1, z: 0 }, v: { x: 1, y: 0, z: 0 } },
};

function wedgeFaces(prim: PartPrimitive, projection: Projection): PartFace[] {
  const { origin: o, size: s } = prim.box;
  const rot = ROTATIONS[prim.rotate ?? 0];
  const z0 = o.z;
  const z1 = o.z + s.z;
  const pt = (u: number, v: number, z: number): Vec3 => {
    const fx = (a: number, dir: number): number => (dir >= 0 ? a : 1 - a);
    // Map (u, v) in [0,1]^2 to the box footprint along the rotation axes.
    const uAlongX = rot.u.x !== 0;
    const x = uAlongX ? o.x + fx(u, rot.u.x) * s.x : o.x + v * s.x;
    const y = uAlongX ? o.y + v * s.y : o.y + fx(u, rot.u.y) * s.y;
    return { x, y, z };
  };
  const d = viewDir(projection);
  const out: PartFace[] = [];
  const consider = (name: ProjectedFace["face"] | undefined, n: Vec3, pts: Vec3[]): void => {
    if (dot(n, d) <= EPS) return;
    const f = makeFace(name ?? faceOf(n), pts, projection);
    if (f) out.push(f);
  };
  const neg = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z });
  // High wall (u = 0), outward normal -u.
  consider(undefined, neg(rot.u), [pt(0, 0, z0), pt(0, 1, z0), pt(0, 1, z1), pt(0, 0, z1)]);
  // Triangular ends (v = 0 outward -v, v = 1 outward +v).
  consider(undefined, neg(rot.v), [pt(0, 0, z0), pt(1, 0, z0), pt(0, 0, z1)]);
  consider(undefined, rot.v, [pt(0, 1, z0), pt(1, 1, z0), pt(0, 1, z1)]);
  // Slope: named `top`; its normal tilts toward the low side, so a steep slope facing away
  // from the viewer is hidden.
  const run = rot.u.x !== 0 ? s.x : s.y;
  const slopeN: Vec3 = { x: rot.u.x * s.z, y: rot.u.y * s.z, z: run };
  consider("top", slopeN, [pt(0, 0, z1), pt(0, 1, z1), pt(1, 1, z0), pt(1, 0, z0)]);
  return orderLeftRightTop(out);
}

function orderLeftRightTop(faces: PartFace[]): PartFace[] {
  const rank = { left: 0, right: 1, top: 2 } as const;
  return [...faces].sort((a, b) => rank[a.face] - rank[b.face]);
}

// ---------------------------------------------------------------------------------------------
// Circular primitives along x / y (and rings along any axis)
// ---------------------------------------------------------------------------------------------

interface Circ {
  /** World axes of the cross-section (a, b) and of the extrusion. */
  readonly axis: Axis;
  readonly ca: number;
  readonly cb: number;
  readonly ra: number;
  readonly rb: number;
  readonly lo: number;
  readonly hi: number;
  /** Cross-section axis unit vectors. */
  readonly ea: Vec3;
  readonly eb: Vec3;
  readonly ez: Vec3;
}

function circOf(box: Box3, axis: Axis): Circ {
  const { origin: o, size: s } = box;
  if (axis === "x") {
    return {
      axis,
      ca: o.y + s.y / 2,
      cb: o.z + s.z / 2,
      ra: s.y / 2,
      rb: s.z / 2,
      lo: o.x,
      hi: o.x + s.x,
      ea: { x: 0, y: 1, z: 0 },
      eb: { x: 0, y: 0, z: 1 },
      ez: { x: 1, y: 0, z: 0 },
    };
  }
  if (axis === "y") {
    return {
      axis,
      ca: o.x + s.x / 2,
      cb: o.z + s.z / 2,
      ra: s.x / 2,
      rb: s.z / 2,
      lo: o.y,
      hi: o.y + s.y,
      ea: { x: 1, y: 0, z: 0 },
      eb: { x: 0, y: 0, z: 1 },
      ez: { x: 0, y: 1, z: 0 },
    };
  }
  return {
    axis,
    ca: o.x + s.x / 2,
    cb: o.y + s.y / 2,
    ra: s.x / 2,
    rb: s.y / 2,
    lo: o.z,
    hi: o.z + s.z,
    ea: { x: 1, y: 0, z: 0 },
    eb: { x: 0, y: 1, z: 0 },
    ez: { x: 0, y: 0, z: 1 },
  };
}

/** World point on the cross-section at parameter angle `t`, radius scale `k`, axis position `h`. */
function circPoint(c: Circ, t: number, k: number, h: number): Vec3 {
  const a = c.ca + k * c.ra * Math.cos(t);
  const b = c.cb + k * c.rb * Math.sin(t);
  return {
    x: c.ea.x * a + c.eb.x * b + c.ez.x * h,
    y: c.ea.y * a + c.eb.y * b + c.ez.y * h,
    z: c.ea.z * a + c.eb.z * b + c.ez.z * h,
  };
}

/** Outward normal of the lateral surface at angle `t`. */
function circNormal(c: Circ, t: number): Vec3 {
  const na = Math.cos(t) / c.ra;
  const nb = Math.sin(t) / c.rb;
  const l = Math.hypot(na, nb);
  const [pa, pb] = [na / l, nb / l];
  return {
    x: c.ea.x * pa + c.eb.x * pb,
    y: c.ea.y * pa + c.eb.y * pb,
    z: c.ea.z * pa + c.eb.z * pb,
  };
}

function arc(c: Circ, t0: number, t1: number, k: number, h: number): Vec3[] {
  const n = Math.max(1, Math.ceil(Math.abs(t1 - t0) / ARC_STEP - 1e-9));
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) pts.push(circPoint(c, t0 + ((t1 - t0) * i) / n, k, h));
  return pts;
}

/** Angle at the centre of the half of the lateral surface that faces the viewer. */
function visibleCentre(c: Circ, projection: Projection): number {
  const d = viewDir(projection);
  return Math.atan2(dot(d, c.eb) / c.rb, dot(d, c.ea) / c.ra);
}

function capName(axis: Axis): ProjectedFace["face"] {
  return axis === "x" ? "right" : axis === "y" ? "left" : "top";
}

/**
 * Lateral surface over `[t0, t1]` as two bands split at the middle; `inner` draws the bore
 * (normals flipped, radius scaled by `k`). Bands that resolve to the same face name (elliptical
 * sections) merge into one, so a name never repeats within a primitive.
 */
function lateralBands(
  c: Circ,
  t0: number,
  t1: number,
  k: number,
  inner: boolean,
  projection: Projection,
  half?: Half,
): PartFace[] {
  const mid = (t0 + t1) / 2;
  const nameOf = (t: number): ProjectedFace["face"] => {
    const m = circNormal(c, t);
    return faceOf(inner ? { x: -m.x, y: -m.y, z: -m.z } : m);
  };
  const spans: [number, number][] =
    nameOf((t0 + mid) / 2) === nameOf((mid + t1) / 2)
      ? [[t0, t1]]
      : [
          [t0, mid],
          [mid, t1],
        ];
  const out: PartFace[] = [];
  for (const [a, b] of spans) {
    const pts = [...arc(c, a, b, k, c.lo), ...arc(c, b, a, k, c.hi)];
    const f = makeFace(nameOf((a + b) / 2), pts, projection, half);
    if (f) out.push(f);
  }
  return out;
}

function solidCircular(prim: PartPrimitive, projection: Projection): PartFace[] {
  const c = circOf(prim.box, prim.axis ?? "z");
  const phi = visibleCentre(c, projection);
  const out = lateralBands(c, phi - Math.PI / 2, phi + Math.PI / 2, 1, false, projection);
  const cap = makeFace(capName(c.axis), arc(c, 0, 2 * Math.PI - ARC_STEP, 1, c.hi), projection);
  if (cap) out.push(cap);
  return out;
}

function ringFaces(prim: PartPrimitive, projection: Projection, half?: Half): PartFace[] {
  const c = circOf(prim.box, prim.axis ?? "z");
  const phi = visibleCentre(c, projection);
  const h = Math.PI / 2;
  const out: PartFace[] = [];
  const cap = (t0: number, t1: number, which: Half): void => {
    const f = makeFace(
      capName(c.axis),
      [...arc(c, t0, t1, 1, c.hi), ...arc(c, t1, t0, RING_INNER_RATIO, c.hi)],
      projection,
      which,
    );
    if (f) out.push(f);
  };
  if (half !== "front") {
    // Back item: the bore's far half, seen through the hole, then the back half of the rim.
    out.push(...lateralBands(c, phi + h, phi + 3 * h, RING_INNER_RATIO, true, projection, "back"));
    cap(phi + h, phi + 3 * h, "back");
  }
  if (half !== "back") {
    out.push(...lateralBands(c, phi - h, phi + h, 1, false, projection, "front"));
    cap(phi - h, phi + h, "front");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------------------------

export interface TrayPart {
  /** `floor`, `wall-nx`, `wall-ny`, `wall-px` or `wall-py`. */
  readonly id: string;
  readonly box: Box3;
  readonly half: Half;
}

/**
 * Floor plus four walls as boxes, back to front. The x walls span the full depth, the y walls
 * sit between them (no overlap). Back: floor, -x wall, -y wall. Front: +y wall, +x wall.
 */
export function trayParts(box: Box3): TrayPart[] {
  const { origin: o, size: s } = box;
  const wall = Math.min(TRAY_WALL_RATIO * Math.min(s.x, s.y), s.z / 2);
  const b = (x: number, y: number, z: number, sx: number, sy: number, sz: number): Box3 => ({
    origin: { x, y, z },
    size: { x: sx, y: sy, z: sz },
  });
  const zw = o.z + wall;
  const hw = s.z - wall;
  const inner = s.x - 2 * wall;
  return [
    { id: "floor", box: b(o.x, o.y, o.z, s.x, s.y, wall), half: "back" },
    { id: "wall-nx", box: b(o.x, o.y, zw, wall, s.y, hw), half: "back" },
    { id: "wall-ny", box: b(o.x + wall, o.y, zw, inner, wall, hw), half: "back" },
    { id: "wall-py", box: b(o.x + wall, o.y + s.y - wall, zw, inner, wall, hw), half: "front" },
    { id: "wall-px", box: b(o.x + s.x - wall, o.y, zw, wall, s.y, hw), half: "front" },
  ];
}

/**
 * Reassigns the `box` primitives of a split geometry (a `tray` built by a pack shape, or turned
 * by a quarter turn) to the `back` and `front` depth items from their CURRENT boxes: the floor
 * (lowest, spanning the part) and every wall on the -x or -y side go to `back`, the +x and +y
 * walls to `front` (as `trayParts`). Primitives of other kinds (ring halves) keep their
 * assignment. Returns `geometry` unchanged without a split. Pure; never throws.
 */
export function reassignSplit(geometry: PartGeometry): PartGeometry {
  const split = geometry.split;
  if (split === undefined) return geometry;
  const ids = new Set([...split.back, ...split.front]);
  const b = geometry.bounds;
  const cx = b.origin.x + b.size.x / 2;
  const cy = b.origin.y + b.size.y / 2;
  const tol = 1e-9;
  const back: string[] = [];
  const front: string[] = [];
  const known = new Set<string>();
  for (const p of geometry.primitives) {
    if (!ids.has(p.id)) continue;
    known.add(p.id);
    const keep = p.kind !== "box";
    let half: Half;
    if (keep) half = halfOf(geometry, p.id) ?? "back";
    else {
      const px = p.box.origin.x + p.box.size.x / 2;
      const py = p.box.origin.y + p.box.size.y / 2;
      half = px > cx + tol || py > cy + tol ? "front" : "back";
    }
    (half === "back" ? back : front).push(p.id);
  }
  // ids not backed by a primitive keep their listing
  for (const id of split.back) if (!known.has(id)) back.push(id);
  for (const id of split.front) if (!known.has(id)) front.push(id);
  return { ...geometry, split: { back, front } };
}

// ---------------------------------------------------------------------------------------------
// Public per-primitive API
// ---------------------------------------------------------------------------------------------

/**
 * Visible faces of one part primitive in painter's order. `half` selects a depth item of a
 * `ring` or `tray` (default: both, back first; ignored by other kinds). A `tray` passed here
 * directly yields the faces of its five boxes (see `trayParts`) with `half` set. `sprite` has no
 * faces (see `partPrimitiveSilhouette`). Throws `RangeError` for a non-finite or degenerate box
 * or an invalid wedge `rotate`.
 */
export function partPrimitiveFaces(
  prim: PartPrimitive,
  projection: Projection,
  half?: Half,
): PartFace[] {
  validate(prim);
  switch (prim.kind) {
    case "box":
    case "plate":
    case "card":
    case "prism":
      return boxLikeFaces(prim, projection);
    case "wedge":
      return wedgeFaces(prim, projection);
    case "cylinder":
    case "shaft":
    case "stud":
      return (prim.axis ?? "z") === "z"
        ? primitiveFaces("cylinder", prim.box, projection)
        : solidCircular(prim, projection);
    case "ring":
      return ringFaces(prim, projection, half);
    case "tray":
      return trayParts(prim.box)
        .filter((p) => half === undefined || p.half === half)
        .flatMap((p) =>
          primitiveFaces("cube", p.box, projection).map((f) => ({ ...f, half: p.half })),
        );
    case "sprite":
      return [];
  }
}

/** Screen outline of the whole primitive (sprite: the box's projected hexagon). */
export function partPrimitiveSilhouette(prim: PartPrimitive, projection: Projection): Silhouette {
  validate(prim);
  if (
    (prim.kind === "cylinder" || prim.kind === "shaft" || prim.kind === "stud") &&
    (prim.axis ?? "z") === "z"
  ) {
    return primitiveSilhouette("cylinder", prim.box, projection);
  }
  const faces = partPrimitiveFaces(prim, projection);
  const pts =
    faces.length > 0
      ? faces.flatMap((f) => f.points)
      : boxCorners(prim.box).map((p) => projection.project(p));
  const hull = convexHull(pts);
  return { points: hull, d: pointsToPath(hull) };
}

/** The depth item (`back` or `front`) a primitive belongs to, from `geometry.split`. */
export function halfOf(geometry: PartGeometry, primitiveId: string): Half | undefined {
  if (geometry.split?.back.includes(primitiveId)) return "back";
  if (geometry.split?.front.includes(primitiveId)) return "front";
  return undefined;
}

export interface PartPrimitiveFaces {
  readonly primitive: PartPrimitive;
  readonly half?: Half;
  readonly faces: PartFace[];
}

/** Faces of every primitive of a geometry, in `primitives` order, with the half resolved. */
export function partGeometryFaces(
  geometry: PartGeometry,
  projection: Projection,
): PartPrimitiveFaces[] {
  return geometry.primitives.map((primitive) => {
    const half = halfOf(geometry, primitive.id);
    const faces = partPrimitiveFaces(primitive, projection, half);
    return half ? { primitive, half, faces } : { primitive, faces };
  });
}

// ---------------------------------------------------------------------------------------------
// Studs
// ---------------------------------------------------------------------------------------------

/** §5.1 defaults, in stud units (x, y: 8 mm studs; z: 3.2 mm plates). */
export const STUD_DIAMETER = 4.8 / 8;
export const STUD_HEIGHT = 1.7 / 3.2;

export interface StudGridOptions {
  /** Host box; studs stand on its top face. */
  readonly host: Box3;
  readonly cols: number;
  readonly rows: number;
  /** Centre distance in x and y, default 1 (one stud, 8 mm). */
  readonly pitch?: number;
  /** Default `STUD_DIAMETER * pitch` (4.8 mm of an 8 mm pitch); must be < pitch. */
  readonly diameter?: number;
  /** Stud height as a z value in the host's z units; default `STUD_HEIGHT` (1.7 mm in plates). */
  readonly height?: number;
  /** Keep only cells for which this returns true (round and prism hosts); zero-based. */
  readonly cell?: (col: number, row: number) => boolean;
  readonly tone: PartTone;
  readonly color?: SpecColor;
  /** Id prefix, default `stud`; ids are `<prefix>-<col>-<row>` (one-based). */
  readonly idPrefix?: string;
}

const finite = (n: number): boolean => Number.isFinite(n);

/**
 * A cols x rows grid of studs centred on the host's top face, ordered back to front
 * (ascending `col + row`, then `col`), so painter's order holds for studs that overlap on
 * screen. Throws `RangeError` when any input is non-finite or non-positive, or the grid does
 * not fit.
 */
export function studGrid(opts: StudGridOptions): PartPrimitive[] {
  const pitch = opts.pitch ?? 1;
  const d = opts.diameter ?? STUD_DIAMETER * pitch;
  const h = opts.height ?? STUD_HEIGHT;
  const { cols, rows, host } = opts;
  const { origin: o, size: s } = host;
  if (![o.x, o.y, o.z, s.x, s.y, s.z].every(finite) || s.x <= 0 || s.y <= 0 || s.z < 0) {
    throw new RangeError("stud host box must be finite with size x, y > 0");
  }
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new RangeError("stud grid needs integer cols and rows >= 1");
  }
  if (![pitch, d, h].every(finite) || !(pitch > 0) || !(d > 0) || !(h > 0) || d >= pitch) {
    throw new RangeError(
      "stud pitch, diameter and height must be finite and > 0, with diameter < pitch",
    );
  }
  const w = cols * pitch;
  const l = rows * pitch;
  if (w > s.x + EPS || l > s.y + EPS) {
    throw new RangeError("stud grid does not fit on the host top face");
  }
  const x0 = o.x + (s.x - w) / 2;
  const y0 = o.y + (s.y - l) / 2;
  const z = o.z + s.z;
  const prefix = opts.idPrefix ?? "stud";
  const cells: [number, number][] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) if (!opts.cell || opts.cell(i, j)) cells.push([i, j]);
  }
  cells.sort((p, q) => p[0] + p[1] - (q[0] + q[1]) || p[0] - q[0]);
  return cells.map(([i, j]) => ({
    id: `${prefix}-${i + 1}-${j + 1}`,
    kind: "stud" as const,
    box: {
      origin: { x: x0 + (i + 0.5) * pitch - d / 2, y: y0 + (j + 0.5) * pitch - d / 2, z },
      size: { x: d, y: d, z: h },
    },
    axis: "z" as const,
    tone: opts.tone,
    ...(opts.color !== undefined ? { color: opts.color } : {}),
  }));
}

// ---------------------------------------------------------------------------------------------
// partGeometry
// ---------------------------------------------------------------------------------------------

export interface PartGeometrySpec {
  /** Primitive id, `^[a-z0-9_.-]+$`, default `main`. */
  readonly id?: string;
  readonly kind: PartPrimitiveKind;
  /** World-space extent (post-rotation); the box origin is `(0, 0, 0)`. */
  readonly size: Vec3;
  /** Default `z` (circular kinds only). */
  readonly axis?: Axis;
  readonly rotate?: QuarterTurn;
  readonly tone: PartTone;
  readonly color?: SpecColor;
  /** Optional stud grid on the top face of the body (outside `depthBox`). */
  readonly studs?: Pick<
    StudGridOptions,
    "cols" | "rows" | "pitch" | "diameter" | "height" | "cell"
  >;
  readonly images?: readonly PartImagePlacement[];
}

function unionBox(boxes: readonly Box3[]): Box3 {
  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const b of boxes) {
    min = {
      x: Math.min(min.x, b.origin.x),
      y: Math.min(min.y, b.origin.y),
      z: Math.min(min.z, b.origin.z),
    };
    max = {
      x: Math.max(max.x, b.origin.x + b.size.x),
      y: Math.max(max.y, b.origin.y + b.size.y),
      z: Math.max(max.z, b.origin.z + b.size.z),
    };
  }
  return {
    origin: min,
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
  };
}

const ID_RE = /^[a-z0-9_.-]+$/;

/**
 * Geometry of a single-primitive leaf part. `ring` becomes two primitives (`<id>.back`,
 * `<id>.front`) and `tray` five boxes (see the header); both fill `split` and, like `sprite`,
 * are not `solid`. Studs (z-axis bodies only) extend `bounds` but not `depthBox`. Throws
 * `RangeError` for an invalid id, size, rotate, or an id collision between body and studs.
 */
export function partGeometry(spec: PartGeometrySpec): PartGeometry {
  const id = spec.id ?? "main";
  if (!ID_RE.test(id)) throw new RangeError(`invalid primitive id "${id}" (^[a-z0-9_.-]+$)`);
  const box: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: spec.size };
  const base = {
    ...(CIRCULAR_KINDS.has(spec.kind) ? { axis: spec.axis ?? "z" } : {}),
    ...(spec.kind === "wedge" ? { rotate: spec.rotate ?? 0 } : {}),
    tone: spec.tone,
    ...(spec.color !== undefined ? { color: spec.color } : {}),
  };
  const mk = (pid: string): PartPrimitive => ({ id: pid, kind: spec.kind, box, ...base });
  validate(mk(id));
  let body: PartPrimitive[];
  let split: { back: string[]; front: string[] } | undefined;
  if (spec.kind === "ring") {
    body = [mk(`${id}.back`), mk(`${id}.front`)];
    split = { back: [`${id}.back`], front: [`${id}.front`] };
  } else if (spec.kind === "tray") {
    const parts = trayParts(box);
    body = parts.map((p) => ({
      id: `${id}.${p.id}`,
      kind: "box" as const,
      box: p.box,
      tone: spec.tone,
      ...(spec.color !== undefined ? { color: spec.color } : {}),
    }));
    split = {
      back: parts.filter((p) => p.half === "back").map((p) => `${id}.${p.id}`),
      front: parts.filter((p) => p.half === "front").map((p) => `${id}.${p.id}`),
    };
  } else {
    body = [mk(id)];
  }
  if (spec.studs) {
    const offAxis = CIRCULAR_KINDS.has(spec.kind) && (spec.axis ?? "z") !== "z";
    if (split || spec.kind === "sprite" || spec.kind === "wedge" || offAxis) {
      throw new RangeError(
        `studs are not supported on ${spec.kind}${offAxis ? ` along ${String(spec.axis)}` : ""}`,
      );
    }
  }
  const studs = spec.studs
    ? studGrid({
        ...spec.studs,
        host: box,
        tone: spec.tone,
        ...(spec.color !== undefined ? { color: spec.color } : {}),
      })
    : [];
  const taken = new Set(body.map((p) => p.id));
  for (const st of studs) {
    if (taken.has(st.id)) throw new RangeError(`stud id "${st.id}" collides with the body id`);
  }
  return {
    primitives: [...body, ...studs],
    bounds: unionBox([box, ...studs.map((st) => st.box)]),
    depthBox: box,
    solid: !(split || spec.kind === "sprite"),
    ...(split ? { split } : {}),
    ...(spec.images ? { images: spec.images } : {}),
  };
}
