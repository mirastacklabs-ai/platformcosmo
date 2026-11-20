/**
 * Assembly frames (Track A2, A2-2; design docs/design/assemblies.md §4, §10).
 *
 * `world = origin + R(rotate) · (scale ⊙ local)`, rotation about the rest bounds' centre, the
 * rotated bounds' minimum corner at `origin` (`AssemblyFrame`). `scale` is per axis because
 * `stud` units are anisotropic (x, y: 8 mm studs; z: 3.2 mm plates). Pure and total: nothing
 * here throws, degenerate input falls back to true scale.
 *
 * Quarter turns are counter-clockwise about +z seen from above (x → y → -x → -y), the same sense
 * for part, sub-assembly and assembly `rotate`, and for `front`.
 */
import type {
  AssemblyFrame,
  AssemblyUnits,
  Box3,
  FrontSide,
  QuarterTurn,
  Vec3,
} from "../../contracts/index.js";

/** Millimetres per world grid tile in the DC pack (true scale, §4, §8.5). */
export const TILE_MM = 600;
/** Default `fit`: largest horizontal extent of a top-level physical assembly, in tiles. */
export const DEFAULT_FIT = 6;

/** Rounding of every scene number derived from a frame (9 decimals: removes float noise, far below ε = 1e-6). */
export const rnd = (v: number): number => Math.round(v * 1e9) / 1e9 + 0;

/** Millimetres per local unit, per axis. */
export function unitMm(units: AssemblyUnits): Vec3 {
  switch (units) {
    case "mm":
      return { x: 1, y: 1, z: 1 };
    case "cm":
      return { x: 10, y: 10, z: 10 };
    case "in":
      return { x: 25.4, y: 25.4, z: 25.4 };
    case "tile":
      return { x: TILE_MM, y: TILE_MM, z: TILE_MM };
    case "stud":
      return { x: 8, y: 8, z: 3.2 };
  }
}

/** World tiles per local unit at true scale (1 tile = 600 mm). */
export function trueScale(units: AssemblyUnits): Vec3 {
  const m = unitMm(units);
  return { x: m.x / TILE_MM, y: m.y / TILE_MM, z: m.z / TILE_MM };
}

/**
 * Scale of a top-level assembly: physical units are scaled uniformly so the largest horizontal
 * extent of `localSize` is `fit` tiles; `tile` units and `trueScale` (DC slot or close-up
 * context) ignore `fit`. A degenerate extent falls back to true scale.
 */
export function resolveScale(
  units: AssemblyUnits,
  fit: number | undefined,
  localSize: Vec3,
  isTrueScale: boolean,
): Vec3 {
  if (isTrueScale || units === "tile") return trueScale(units);
  const m = unitMm(units);
  const extent = Math.max(localSize.x * m.x, localSize.y * m.y);
  const f = fit ?? DEFAULT_FIT;
  if (!(extent > 0) || !Number.isFinite(extent) || !(f > 0)) return trueScale(units);
  const k = f / extent;
  return { x: m.x * k, y: m.y * k, z: m.z * k };
}

const SIDES: readonly FrontSide[] = ["+x", "+y", "-x", "-y"];

/** Front side in world axes after turning the unit by `rotate`. */
export function turnFront(front: FrontSide, rotate: QuarterTurn): FrontSide {
  const i = SIDES.indexOf(front);
  return SIDES[(i + rotate / 90) % 4] as FrontSide;
}

export interface FrameInput {
  readonly units: AssemblyUnits;
  readonly fit?: number;
  readonly front?: FrontSide;
  readonly rotate?: QuarterTurn;
  /** Rest bounds in local units (before the assembly's own rotation). */
  readonly localBounds: Box3;
  /** True scale: inside a DC rack slot or a close-up of a physical part (`fit` ignored). */
  readonly trueScale?: boolean;
  /** World position of the rotated bounds' minimum corner (z includes any below-ground lift). */
  readonly origin: Vec3;
}

export function makeFrame(input: FrameInput): AssemblyFrame {
  const rotate = input.rotate ?? 0;
  return {
    units: input.units,
    scale: resolveScale(input.units, input.fit, input.localBounds.size, input.trueScale === true),
    origin: { x: rnd(input.origin.x), y: rnd(input.origin.y), z: rnd(input.origin.z) },
    rotate,
    front: turnFront(input.front ?? "+y", rotate),
  };
}

/** Local → world mapping of one frame, for the rest bounds it was made for. */
export interface FrameMap {
  point(p: Vec3): Vec3;
  /** The axis-aligned image of a local box (quarter turns keep boxes axis-aligned). */
  box(b: Box3): Box3;
}

/** Applies `frame` to local points and boxes: `origin + size'/2 + R · (scale ⊙ p − centre)`. */
export function frameMap(frame: AssemblyFrame, localBounds: Box3): FrameMap {
  const { scale, origin, rotate } = frame;
  const m = {
    x: scale.x * localBounds.origin.x,
    y: scale.y * localBounds.origin.y,
    z: scale.z * localBounds.origin.z,
  };
  const s = {
    x: scale.x * localBounds.size.x,
    y: scale.y * localBounds.size.y,
    z: scale.z * localBounds.size.z,
  };
  const c = { x: m.x + s.x / 2, y: m.y + s.y / 2 };
  const odd = rotate === 90 || rotate === 270;
  const hx = (odd ? s.y : s.x) / 2;
  const hy = (odd ? s.x : s.y) / 2;
  const point = (p: Vec3): Vec3 => {
    const qx = scale.x * p.x - c.x;
    const qy = scale.y * p.y - c.y;
    let rx = qx;
    let ry = qy;
    if (rotate === 90) {
      rx = -qy;
      ry = qx;
    } else if (rotate === 180) {
      rx = -qx;
      ry = -qy;
    } else if (rotate === 270) {
      rx = qy;
      ry = -qx;
    }
    return {
      x: rnd(origin.x + hx + rx),
      y: rnd(origin.y + hy + ry),
      z: rnd(origin.z + (scale.z * p.z - m.z)),
    };
  };
  const box = (b: Box3): Box3 => {
    const a = point(b.origin);
    const e = point({
      x: b.origin.x + b.size.x,
      y: b.origin.y + b.size.y,
      z: b.origin.z + b.size.z,
    });
    const origin2 = { x: Math.min(a.x, e.x), y: Math.min(a.y, e.y), z: Math.min(a.z, e.z) };
    return {
      origin: origin2,
      size: {
        x: rnd(Math.max(a.x, e.x) - origin2.x),
        y: rnd(Math.max(a.y, e.y) - origin2.y),
        z: rnd(Math.max(a.z, e.z) - origin2.z),
      },
    };
  };
  return { point, box };
}

/** Smallest box containing all of `boxes` (rounded to 9 decimals); undefined when empty. */
export function unionBoxes(boxes: readonly Box3[]): Box3 | undefined {
  if (boxes.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.origin.x);
    y0 = Math.min(y0, b.origin.y);
    z0 = Math.min(z0, b.origin.z);
    x1 = Math.max(x1, b.origin.x + b.size.x);
    y1 = Math.max(y1, b.origin.y + b.size.y);
    z1 = Math.max(z1, b.origin.z + b.size.z);
  }
  return {
    origin: { x: rnd(x0), y: rnd(y0), z: rnd(z0) },
    size: { x: rnd(x1 - x0), y: rnd(y1 - y0), z: rnd(z1 - z0) },
  };
}

/**
 * The extra height that makes reach bounds start at `z = 0`: spec assemblies are lifted as a
 * whole (rest pose included) so no reachable pose lies under the ground and group slabs (§6.3).
 * `reach` is in the unlifted world frame, where the rest bounds start at z = 0.
 */
export function belowGroundLift(reach: Box3): number {
  return reach.origin.z < 0 ? rnd(-reach.origin.z) : 0;
}
