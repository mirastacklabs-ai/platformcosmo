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
import { convexHull, pointsToPath, primitiveFaces } from "./primitives.js";
import type { Silhouette } from "./primitives.js";
import { boxCorners } from "./projection.js";

/**
 * Part primitives (assemblies §5, §9.6). Geometry of the leaf-part solids in the part's local
 * frame, projected to screen space with the same rounding as `primitiveFaces`.
 *
 * Conventions (shared with `primitiveFaces`):
 * - Faces come in painter's order (back to front) and polygons are clockwise on screen.
 * - A face is visible when its outward normal `n` satisfies `n · d > 0`, where
 *   `d = (1, 1, tileWidth / (2 * zScale))` is the direction toward the viewer.
 * - Names follow the dominant normal: `+x` is `right`, `+y` is `left`, up is `top`. A wedge's
 *   slope is always `top`.
 * - Circular primitives along `x`/`y`, rings and trays are drawn by this module; boxes, plates,
 *   cards, prisms and `z` cylinders delegate to `primitiveFaces` (which stays untouched).
 * - `ring` and `tray` are two depth items. `partGeometry` emits them as two `PartPrimitive`s
 *   with ids `<id>.back` and `<id>.front` (the contract's `split` lists primitive ids);
 *   `partPrimitiveFaces` selects the half from that suffix, and draws both (back first) for a
 *   primitive without a suffix.
 */

const EPS = 1e-9;
const ARC_STEP = Math.PI / 24; // 48 segments per revolution, as the existing cylinder

/** Ring bore radius as a fraction of the outer radius (the contract has no field for it). */
export const RING_INNER_RATIO = 0.6;
/** Tray wall (and floor) thickness as a fraction of the smaller footprint side. */
export const TRAY_WALL_RATIO = 0.12;

/** A projected part face. `half` is set for the two depth items of a split primitive. */
export interface PartFace extends ProjectedFace {
  readonly half?: "back" | "front";
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
  half?: "back" | "front",
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

function stripHalf(id: string): { base: string; half?: "back" | "front" } {
  if (id.endsWith(".back")) return { base: id.slice(0, -5), half: "back" };
  if (id.endsWith(".front")) return { base: id.slice(0, -6), half: "front" };
  return { base: id };
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

/** Lateral band `[t0, t1]`; `inner` draws the bore (normals flipped, radius scaled). */
function lateralBand(
  c: Circ,
  t0: number,
  t1: number,
  k: number,
  inner: boolean,
  projection: Projection,
  half?: "back" | "front",
): PartFace | undefined {
  const mid = circNormal(c, (t0 + t1) / 2);
  const n = inner ? { x: -mid.x, y: -mid.y, z: -mid.z } : mid;
  const pts = [...arc(c, t0, t1, k, c.lo), ...arc(c, t1, t0, k, c.hi)];
  return makeFace(faceOf(n), pts, projection, half);
}

function solidCircular(prim: PartPrimitive, projection: Projection): PartFace[] {
  const c = circOf(prim.box, prim.axis ?? "z");
  const phi = visibleCentre(c, projection);
  const out: PartFace[] = [];
  for (const [a, b] of [
    [phi - Math.PI / 2, phi],
    [phi, phi + Math.PI / 2],
  ] as const) {
    const f = lateralBand(c, a, b, 1, false, projection);
    if (f) out.push(f);
  }
  const cap = makeFace(capName(c.axis), arc(c, 0, 2 * Math.PI - ARC_STEP, 1, c.hi), projection);
  if (cap) out.push(cap);
  return out;
}

function ringFaces(
  prim: PartPrimitive,
  projection: Projection,
  half?: "back" | "front",
): PartFace[] {
  const c = circOf(prim.box, prim.axis ?? "z");
  const phi = visibleCentre(c, projection);
  const h = Math.PI / 2;
  const out: PartFace[] = [];
  const push = (f: PartFace | undefined): void => {
    if (f) out.push(f);
  };
  const cap = (t0: number, t1: number, which: "back" | "front"): PartFace | undefined =>
    makeFace(
      capName(c.axis),
      [...arc(c, t0, t1, 1, c.hi), ...arc(c, t1, t0, RING_INNER_RATIO, c.hi)],
      projection,
      which,
    );
  if (half !== "front") {
    // Back item: the bore's far half, seen through the hole, then the back half of the rim.
    push(lateralBand(c, phi + h, phi + 2 * h, RING_INNER_RATIO, true, projection, "back"));
    push(lateralBand(c, phi + 2 * h, phi + 3 * h, RING_INNER_RATIO, true, projection, "back"));
    push(cap(phi + h, phi + 3 * h, "back"));
  }
  if (half !== "back") {
    push(lateralBand(c, phi - h, phi, 1, false, projection, "front"));
    push(lateralBand(c, phi, phi + h, 1, false, projection, "front"));
    push(cap(phi - h, phi + h, "front"));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------------------------

interface TrayBoxes {
  readonly floor: Box3;
  readonly wallNX: Box3;
  readonly wallNY: Box3;
  readonly wallPX: Box3;
  readonly wallPY: Box3;
}

/** Floor plus four walls: the x walls span the full depth, the y walls sit between them. */
export function trayBoxes(box: Box3): TrayBoxes {
  const { origin: o, size: s } = box;
  const wall = Math.min(TRAY_WALL_RATIO * Math.min(s.x, s.y), s.z / 2);
  const floor = Math.min(wall, s.z / 2);
  const b = (x: number, y: number, z: number, sx: number, sy: number, sz: number): Box3 => ({
    origin: { x, y, z },
    size: { x: sx, y: sy, z: sz },
  });
  const zw = o.z + floor;
  const hw = s.z - floor;
  const inner = s.x - 2 * wall;
  return {
    floor: b(o.x, o.y, o.z, s.x, s.y, floor),
    wallNX: b(o.x, o.y, zw, wall, s.y, hw),
    wallNY: b(o.x + wall, o.y, zw, inner, wall, hw),
    wallPX: b(o.x + s.x - wall, o.y, zw, wall, s.y, hw),
    wallPY: b(o.x + wall, o.y + s.y - wall, zw, inner, wall, hw),
  };
}

function trayFaces(
  prim: PartPrimitive,
  projection: Projection,
  half?: "back" | "front",
): PartFace[] {
  const t = trayBoxes(prim.box);
  const out: PartFace[] = [];
  const add = (
    box: Box3,
    names: readonly ProjectedFace["face"][],
    which: "back" | "front",
  ): void => {
    for (const f of primitiveFaces("cube", box, projection)) {
      if (names.includes(f.face)) out.push({ ...f, half: which });
    }
  };
  if (half !== "front") {
    add(t.floor, ["left", "right", "top"], "back");
    add(t.wallNX, ["left", "right", "top"], "back"); // inner face (+x), end face (+y), rim
    add(t.wallNY, ["left", "top"], "back"); // inner face (+y), rim
  }
  if (half !== "back") {
    add(t.wallPY, ["left", "top"], "front"); // outer face (+y), rim
    add(t.wallPX, ["left", "right", "top"], "front"); // outer face (+x), end face (+y), rim
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public per-primitive API
// ---------------------------------------------------------------------------------------------

/**
 * Visible faces of one part primitive in painter's order. `sprite` has no faces (see
 * `partPrimitiveSilhouette`). Throws `RangeError` for a non-finite or degenerate box.
 */
export function partPrimitiveFaces(prim: PartPrimitive, projection: Projection): PartFace[] {
  validate(prim);
  const { half } = stripHalf(prim.id);
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
      return trayFaces(prim, projection, half);
    case "sprite":
      return [];
  }
}

/** Screen outline of the whole primitive (sprite: the box's projected hexagon). */
export function partPrimitiveSilhouette(prim: PartPrimitive, projection: Projection): Silhouette {
  validate(prim);
  const faces = partPrimitiveFaces(prim, projection);
  const pts =
    faces.length > 0
      ? faces.flatMap((f) => f.points)
      : boxCorners(prim.box).map((p) => projection.project(p));
  const hull = convexHull(pts);
  return { points: hull, d: pointsToPath(hull) };
}

// ---------------------------------------------------------------------------------------------
// Studs
// ---------------------------------------------------------------------------------------------

export interface StudGridOptions {
  /** Host box; studs stand on its top face. */
  readonly host: Box3;
  readonly cols: number;
  readonly rows: number;
  /** Centre distance, default 1. */
  readonly pitch?: number;
  /** Default `0.6 * pitch`; must be < pitch so studs never touch. */
  readonly diameter?: number;
  /** Default `0.25 * pitch`. */
  readonly height?: number;
  readonly tone: PartTone;
  readonly color?: SpecColor;
  /** Id prefix, default `stud`; ids are `<prefix>-<col>-<row>`. */
  readonly idPrefix?: string;
}

/**
 * A cols x rows grid of studs centred on the host's top face, ordered back to front
 * (ascending `col + row`, then `col`), so painter's order holds for studs that overlap on
 * screen. Throws when the grid or the stud does not fit.
 */
export function studGrid(opts: StudGridOptions): PartPrimitive[] {
  const pitch = opts.pitch ?? 1;
  const d = opts.diameter ?? 0.6 * pitch;
  const h = opts.height ?? 0.25 * pitch;
  const { cols, rows, host } = opts;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new RangeError("stud grid needs integer cols and rows >= 1");
  }
  if (!(pitch > 0) || !(d > 0) || !(h > 0) || d >= pitch) {
    throw new RangeError("stud pitch, diameter and height must be > 0 with diameter < pitch");
  }
  const w = cols * pitch;
  const l = rows * pitch;
  if (w > host.size.x + EPS || l > host.size.y + EPS) {
    throw new RangeError("stud grid does not fit on the host top face");
  }
  const x0 = host.origin.x + (host.size.x - w) / 2;
  const y0 = host.origin.y + (host.size.y - l) / 2;
  const z = host.origin.z + host.size.z;
  const prefix = opts.idPrefix ?? "stud";
  const cells: [number, number][] = [];
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) cells.push([i, j]);
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
  /** Primitive id (`^[a-z0-9_.-]+$`), default `main`. */
  readonly id?: string;
  readonly kind: PartPrimitiveKind;
  /** Extent in the part's local units; the box origin is `(0, 0, 0)`. */
  readonly size: Vec3;
  /** Default `z` (circular kinds only). */
  readonly axis?: Axis;
  readonly rotate?: QuarterTurn;
  readonly tone: PartTone;
  readonly color?: SpecColor;
  /** Optional stud grid on the top face of the body (outside `depthBox`). */
  readonly studs?: Pick<StudGridOptions, "cols" | "rows" | "pitch" | "diameter" | "height">;
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

/**
 * Geometry of a single-primitive leaf part in its own frame. `ring` and `tray` become two
 * primitives (`<id>.back`, `<id>.front`) and fill `split`; they and `sprite` are not `solid`.
 * Studs extend `bounds` but not `depthBox`.
 */
export function partGeometry(spec: PartGeometrySpec): PartGeometry {
  const id = spec.id ?? "main";
  const box: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: spec.size };
  const base = {
    box,
    ...(CIRCULAR_KINDS.has(spec.kind) ? { axis: spec.axis ?? "z" } : {}),
    ...(spec.kind === "wedge" ? { rotate: spec.rotate ?? 0 } : {}),
    tone: spec.tone,
    ...(spec.color !== undefined ? { color: spec.color } : {}),
  };
  const mk = (pid: string): PartPrimitive => ({ id: pid, kind: spec.kind, ...base });
  validate(mk(id));
  const split = spec.kind === "ring" || spec.kind === "tray";
  const body = split ? [mk(`${id}.back`), mk(`${id}.front`)] : [mk(id)];
  if (spec.studs && (split || spec.kind === "sprite" || spec.kind === "wedge")) {
    throw new RangeError(`studs are not supported on ${spec.kind}`);
  }
  const studs = spec.studs
    ? studGrid({
        ...spec.studs,
        host: box,
        tone: spec.tone,
        ...(spec.color !== undefined ? { color: spec.color } : {}),
      })
    : [];
  const bounds = unionBox([box, ...studs.map((s) => s.box)]);
  return {
    primitives: [...body, ...studs],
    bounds,
    depthBox: box,
    solid: !(split || spec.kind === "sprite"),
    ...(split ? { split: { back: [`${id}.back`], front: [`${id}.front`] } } : {}),
    ...(spec.images ? { images: spec.images } : {}),
  };
}
