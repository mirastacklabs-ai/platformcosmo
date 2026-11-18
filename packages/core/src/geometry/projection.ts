import type { Box3, Projection, Rect, Vec2, Vec3 } from "../contracts/index.js";
import { round2 } from "./num.js";

export const DEFAULT_TILE_WIDTH = 64;

export interface ProjectionOptions {
  /** Screen width of one floor tile's diamond. Default 64. */
  readonly tileWidth?: number;
  /** Screen units per world unit of height. Default `tileWidth / 2`. */
  readonly zScale?: number;
}

/**
 * 2:1 dimetric projection (contracts/geometry.ts): `x` runs to the lower right,
 * `y` to the lower left, `z` up. A tile is a diamond `tileWidth` wide, `tileWidth / 2` tall.
 * Output is rounded to 2 decimals.
 */
export function createProjection(options: ProjectionOptions = {}): Projection {
  const tileWidth = options.tileWidth ?? DEFAULT_TILE_WIDTH;
  const zScale = options.zScale ?? tileWidth / 2;
  if (!(tileWidth > 0) || !Number.isFinite(tileWidth)) {
    throw new RangeError("tileWidth must be a positive finite number");
  }
  if (!(zScale > 0) || !Number.isFinite(zScale)) {
    throw new RangeError("zScale must be a positive finite number");
  }
  const hw = tileWidth / 2;
  const hh = tileWidth / 4;
  return {
    tileWidth,
    zScale,
    project(p: Vec3): Vec2 {
      return { x: round2((p.x - p.y) * hw), y: round2((p.x + p.y) * hh - p.z * zScale) };
    },
  };
}

/** The eight corners of a box, indexed by bit: bit0 = +x, bit1 = +y, bit2 = +z. */
export function boxCorners(box: Box3): Vec3[] {
  const { origin: o, size: s } = box;
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({
      x: o.x + (i & 1 ? s.x : 0),
      y: o.y + (i & 2 ? s.y : 0),
      z: o.z + (i & 4 ? s.z : 0),
    });
  }
  return out;
}

function rectFromExtent(minX: number, minY: number, maxX: number, maxY: number): Rect {
  return {
    x: round2(minX),
    y: round2(minY),
    width: round2(maxX - minX),
    height: round2(maxY - minY),
  };
}

/** Screen bounding rectangle of a set of points. Empty input gives a zero rect. */
export function boundsOfPoints(points: readonly Vec2[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return rectFromExtent(minX, minY, maxX, maxY);
}

/** Screen bounding rectangle of a world box. */
export function projectBoxBounds(projection: Projection, box: Box3): Rect {
  return boundsOfPoints(boxCorners(box).map((c) => projection.project(c)));
}

/** Union of rectangles (empty input gives a zero rect). */
export function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return rectFromExtent(minX, minY, maxX, maxY);
}
