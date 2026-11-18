/**
 * Ground-plane keep-outs besides the object footprints (Track A2), as axis-aligned world rects:
 * - occlusion shadow: a tall object hides the ground behind it (toward -x,-y on screen-up), so a
 *   route there would visually run "through the top"; the footprint is swept along (-1,-1) by its height;
 * - label keep-out: the label sits centered under the object on screen; the screen rectangle is
 *   mapped back to the ground and approximated by 0.5 tile cells.
 */
import type { Box3 } from "../contracts/index.js";
import type { Rect } from "./router.js";

/** Matches the default projection (tileWidth 64, 2:1 dimetric). */
const HALF_TILE = 32;
const QUARTER_TILE = 16;
const CELL = 0.5;

const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Estimated label width in screen units (A1 clamps labels to 150). */
export function labelWidth(label: string): number {
  return Math.min(150, label.length * 6.6) + 8;
}

/** Occlusion shadow rects of an object (excludes the footprint itself). */
export function shadowRects(box: Box3, margin = 0.15): Rect[] {
  const out: Rect[] = [];
  const x0 = box.origin.x;
  const y0 = box.origin.y;
  const x1 = x0 + box.size.x;
  const y1 = y0 + box.size.y;
  const top = box.origin.z + box.size.z;
  for (let t = CELL; t <= top + 1e-9; t += CELL) {
    out.push({
      x0: r2(x0 - t - margin),
      y0: r2(y0 - t - margin),
      x1: r2(x1 - t + margin),
      y1: r2(y1 - t + margin),
    });
  }
  return out;
}

/** Ground cells covered by the label drawn under the object, merged into column runs. */
export function labelRects(label: string, box: Box3): Rect[] {
  const cx = box.origin.x + box.size.x / 2;
  const cy = box.origin.y + box.size.y / 2;
  const w = labelWidth(label);
  const sx = (cx - cy) * HALF_TILE;
  const yb = (box.origin.x + box.size.x + box.origin.y + box.size.y) * QUARTER_TILE;
  // Screen rect -> (u, v) = (x - y, x + y) ground coordinates.
  const u0 = (sx - w / 2) / HALF_TILE;
  const u1 = (sx + w / 2) / HALF_TILE;
  const v0 = (yb + 2) / QUARTER_TILE;
  const v1 = (yb + 22) / QUARTER_TILE;
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  const hu = (u1 - u0) / 2 + 0.5;
  const hv = (v1 - v0) / 2 + 0.35;
  const xa = Math.floor((u0 + v0) / 2 / CELL) * CELL;
  const xb = (u1 + v1) / 2;
  const ya = Math.floor((v0 - u1) / 2 / CELL) * CELL;
  const yb2 = (v1 - u0) / 2;
  const out: Rect[] = [];
  for (let x = xa; x <= xb; x += CELL) {
    let runStart: number | undefined;
    let runEnd = 0;
    for (let y = ya; y <= yb2 + 1e-9; y += CELL) {
      const mx = x + CELL / 2;
      const my = y + CELL / 2;
      const inside = Math.abs(mx - my - uc) <= hu && Math.abs(mx + my - vc) <= hv;
      if (inside) {
        if (runStart === undefined) runStart = y;
        runEnd = y + CELL;
      } else if (runStart !== undefined) {
        out.push({ x0: r2(x), y0: r2(runStart), x1: r2(x + CELL), y1: r2(runEnd) });
        runStart = undefined;
      }
    }
    if (runStart !== undefined) {
      out.push({ x0: r2(x), y0: r2(runStart), x1: r2(x + CELL), y1: r2(runEnd) });
    }
  }
  return out;
}
