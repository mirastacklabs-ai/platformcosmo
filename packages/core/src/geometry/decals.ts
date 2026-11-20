import type { Box3, FaceName, Projection, Rect, Vec2, Vec3 } from "../contracts/index.js";
import { projectBoxBounds } from "./projection.js";
import { round2 } from "./num.js";

/**
 * Image placement geometry (assemblies §11.3), pure and deterministic.
 *
 * - Decals: an affine matrix maps the crop rectangle (image pixels) onto the parallelogram of a
 *   box face. Image axes on the faces: `left` (+y face): u along +x, v down; `right` (+x face):
 *   u along -y, v down (both read left to right as seen on screen); `top`: the image origin is
 *   the diamond's top vertex, u along +x, v along +y.
 * - Billboards stay upright and unskewed in screen space.
 *
 * Inputs are world-space boxes (after the `AssemblyFrame` scale and quarter turn; `size` is the
 * post-rotation extent). Callers validate first; non-finite or degenerate input throws
 * `RangeError`, which the caller turns into a diagnostic.
 *
 * Emit path (§11.3): everything here follows the 2-decimal rule. Draw a decal as
 * `<g transform="matrix(unit)"><svg width="1" height="1" viewBox="<crop>"
 * preserveAspectRatio="none">…image…</svg></g>`: the nested svg maps the crop rectangle onto the
 * unit square (so the crop offset is applied once, by the viewBox) and `unit` maps that square
 * onto the face parallelogram. No pixel-space matrix is exposed on purpose.
 */

/** SVG `matrix(a b c d e f)`: `x' = a x + c y + e`, `y' = b x + d y + f`. */
export interface Matrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export type Fit = "contain" | "cover" | "stretch";

type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

export interface DecalPlacement {
  readonly face: FaceName;
  /** The face parallelogram: screen corners at (u, v) = (0,0), (1,0), (1,1), (0,1). */
  readonly faceCorners: Quad;
  /** Where the fitted image lands (= `faceCorners` for `stretch`, inside for `contain`, covering for `cover`). */
  readonly corners: Quad;
  /** Maps the unit square to `corners`. Exact (every number rounded to 2 decimals). */
  readonly unit: Matrix;
  /** Clip polygon (the face parallelogram) when the image overflows it (`cover`); else absent. */
  readonly clip?: readonly Vec2[];
}

function assertBox(box: Box3): void {
  const { origin: o, size: z } = box;
  if (![o.x, o.y, o.z, z.x, z.y, z.z].every(Number.isFinite) || z.x < 0 || z.y < 0 || z.z < 0) {
    throw new RangeError("box must be finite with non-negative size");
  }
}

function assertCrop(crop: Rect): void {
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)) {
    throw new RangeError("crop must be finite");
  }
  if (!(crop.width > 0) || !(crop.height > 0)) throw new RangeError("crop must be non-empty");
}

interface FaceFrame {
  readonly origin: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  /** World extent along u and v. */
  readonly w: number;
  readonly h: number;
}

function faceFrame(box: Box3, face: FaceName): FaceFrame {
  const { origin: o, size: s } = box;
  const z1 = o.z + s.z;
  if (face === "top") {
    return {
      origin: { x: o.x, y: o.y, z: z1 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 1, z: 0 },
      w: s.x,
      h: s.y,
    };
  }
  if (face === "left") {
    return {
      origin: { x: o.x, y: o.y + s.y, z: z1 },
      u: { x: 1, y: 0, z: 0 },
      v: { x: 0, y: 0, z: -1 },
      w: s.x,
      h: s.z,
    };
  }
  return {
    origin: { x: o.x + s.x, y: o.y + s.y, z: z1 },
    u: { x: 0, y: -1, z: 0 },
    v: { x: 0, y: 0, z: -1 },
    w: s.y,
    h: s.z,
  };
}

const at = (f: FaceFrame, u: number, v: number): Vec3 => ({
  x: f.origin.x + f.u.x * u * f.w + f.v.x * v * f.h,
  y: f.origin.y + f.u.y * u * f.w + f.v.y * v * f.h,
  z: f.origin.z + f.u.z * u * f.w + f.v.z * v * f.h,
});

/**
 * Decal of `crop` (image pixels) on `face` of `box` (the part's `bounds`). `contain` fits the
 * whole crop inside the face, centred; `cover` fills the face and overflows it (clip with
 * `clip`); `stretch` fills it exactly. Throws `RangeError` for a degenerate face or crop.
 */
export function decalPlacement(
  box: Box3,
  face: FaceName,
  crop: Rect,
  fit: Fit,
  projection: Projection,
): DecalPlacement {
  assertBox(box);
  const fr = faceFrame(box, face);
  if (!(fr.w > 0) || !(fr.h > 0)) throw new RangeError(`decal face "${face}" has zero area`);
  assertCrop(crop);
  // Fitted rectangle in face (u, v) fractions.
  let u0 = 0;
  let v0 = 0;
  let u1 = 1;
  let v1 = 1;
  if (fit !== "stretch") {
    const imageAspect = crop.width / crop.height;
    const faceAspect = fr.w / fr.h;
    const imageWider = imageAspect > faceAspect;
    // contain: width is the limiting side when the image is wider; cover: the reverse.
    const fitWidth = fit === "contain" ? imageWider : !imageWider;
    const fu = fitWidth ? 1 : imageAspect / faceAspect;
    const fv = fitWidth ? faceAspect / imageAspect : 1;
    u0 = (1 - fu) / 2;
    u1 = u0 + fu;
    v0 = (1 - fv) / 2;
    v1 = v0 + fv;
  }
  const P = (u: number, v: number): Vec2 => projection.project(at(fr, u, v));
  const corners: Quad = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
  const faceCorners: Quad = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
  const [p00, p10, , p01] = corners;
  const unit: Matrix = {
    a: round2(p10.x - p00.x),
    b: round2(p10.y - p00.y),
    c: round2(p01.x - p00.x),
    d: round2(p01.y - p00.y),
    e: p00.x,
    f: p00.y,
  };
  return {
    face,
    faceCorners,
    corners,
    unit,
    ...(fit === "cover" ? { clip: [...faceCorners] } : {}),
  };
}

/** Apply a matrix to a point (not rounded). */
export function applyMatrix(m: Matrix, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export interface BillboardPlacement {
  /** Where the crop is drawn (screen rect, upright). */
  readonly rect: Rect;
  /** Clip rect when the image overflows the silhouette box (`cover`); else absent. */
  readonly clip?: Rect;
}

/**
 * Upright billboard for `crop` inside the box's screen silhouette rectangle: `contain` scales
 * to fit, centred horizontally and bottom-aligned; `cover` fills it (overflow clipped,
 * bottom-aligned, centred horizontally); `stretch` fills it exactly.
 */
export function billboardRect(
  box: Box3,
  crop: Rect,
  fit: Fit,
  projection: Projection,
): BillboardPlacement {
  assertBox(box);
  const sil = projectBoxBounds(projection, box);
  if (!(sil.width > 0) || !(sil.height > 0)) {
    throw new RangeError("billboard box has no screen area");
  }
  assertCrop(crop);
  if (fit === "stretch") return { rect: sil };
  const sx = sil.width / crop.width;
  const sy = sil.height / crop.height;
  const s = fit === "contain" ? Math.min(sx, sy) : Math.max(sx, sy);
  const width = round2(crop.width * s);
  const height = round2(crop.height * s);
  const bottom = sil.y + sil.height;
  const rect: Rect = {
    x: round2(sil.x + (sil.width - width) / 2),
    y: round2(bottom - height),
    width,
    height,
  };
  return fit === "cover" ? { rect, clip: sil } : { rect };
}
