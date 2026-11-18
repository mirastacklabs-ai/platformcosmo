/**
 * Ground-plane keep-outs besides the object footprints (Track A2), as axis-aligned world rects:
 * - occlusion shadow: a tall object hides the ground behind it (toward -x,-y on screen-up), so a
 *   route there would visually run "through the top"; the footprint is swept along (-1,-1) by its height;
 * - label keep-out: the label sits centered under the object on screen; the screen rectangle is
 *   mapped back to the ground and approximated by 0.5 tile cells.
 */
import type { Box3, SceneObject } from "../contracts/index.js";
import { DEFAULT_TILE_WIDTH } from "../geometry/projection.js";
import type { Rect } from "./router.js";

/** Screen units per world unit on the ground plane (2:1 dimetric projection). */
const HALF_TILE = DEFAULT_TILE_WIDTH / 2;
const QUARTER_TILE = DEFAULT_TILE_WIDTH / 4;
const CELL = 0.5;
const BUCKET = 4;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const down = (v: number): number => Math.floor(v / CELL + 1e-9) * CELL;
const up = (v: number): number => Math.ceil(v / CELL - 1e-9) * CELL;

/**
 * Estimated label width in screen units, counted by code points. A2 has no text metrics.
 * TODO: take the clamp (150) and the per-glyph advance from A1's text/label constants once they
 * are exported, so the keep-out tracks the emitted label exactly.
 */
export function labelWidth(label: string): number {
  return Math.min(150, [...label].length * 6.6) + 8;
}

/** DC facility objects that lie on the floor and are never routing obstacles (matched by `type`). */
const FURNITURE_TYPES: ReadonlySet<string> = new Set([
  "cable-tray",
  "perforated-tiles",
  "floor-grid",
]);

/** Cable trays, perforated tiles and the floor grid, plus a rack's `rack-front` shell. */
export function isRoutingFurniture(o: Pick<SceneObject, "type">): boolean {
  return FURNITURE_TYPES.has(o.type) || o.type === "rack-front";
}

/** Occlusion shadow rects of an object (excludes the footprint), snapped outward to a 0.5 lattice. */
export function shadowRects(box: Box3): Rect[] {
  const out: Rect[] = [];
  const x0 = box.origin.x;
  const y0 = box.origin.y;
  const x1 = x0 + box.size.x;
  const y1 = y0 + box.size.y;
  const top = box.origin.z + box.size.z;
  for (let t = CELL; t <= top + 1e-9; t += CELL) {
    out.push({ x0: down(x0 - t), y0: down(y0 - t), x1: up(x1 - t), y1: up(y1 - t) });
  }
  return out;
}

export type KeepoutKind = "shadow" | "label";

/**
 * Keep-out rects of a whole scene, built once and queried per route window. Shadows can be
 * skipped per owner (a route's own endpoints); labels always apply.
 */
export class KeepoutIndex {
  private readonly rects: { r: Rect; owner: string; kind: KeepoutKind }[] = [];
  private readonly buckets = new Map<number, number[]>();

  add(owner: string, kind: KeepoutKind, list: readonly Rect[]): void {
    for (const r of list) {
      const i = this.rects.length;
      this.rects.push({ r, owner, kind });
      for (let cx = Math.floor(r.x0 / BUCKET); cx <= Math.floor(r.x1 / BUCKET); cx++) {
        for (let cy = Math.floor(r.y0 / BUCKET); cy <= Math.floor(r.y1 / BUCKET); cy++) {
          const k = (cx + 32768) * 65536 + (cy + 32768);
          const l = this.buckets.get(k);
          if (l) l.push(i);
          else this.buckets.set(k, [i]);
        }
      }
    }
  }

  /** Rects intersecting `win`, without the shadows of `skipShadows` owners. */
  query(win: Rect, skipShadows: ReadonlySet<string>): Rect[] {
    const seen = new Set<number>();
    const out: Rect[] = [];
    const cx0 = Math.floor(Math.max(win.x0, -30000) / BUCKET);
    const cx1 = Math.floor(Math.min(win.x1, 30000) / BUCKET);
    const cy0 = Math.floor(Math.max(win.y0, -30000) / BUCKET);
    const cy1 = Math.floor(Math.min(win.y1, 30000) / BUCKET);
    const span = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    const visit = (i: number): void => {
      if (seen.has(i)) return;
      seen.add(i);
      const e = this.rects[i]!;
      if (e.kind === "shadow" && skipShadows.has(e.owner)) return;
      out.push(e.r);
    };
    if (span > this.buckets.size) {
      // Huge window: cheaper to walk every bucket than every cell.
      for (const list of this.buckets.values()) for (const i of list) visit(i);
    } else {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          for (const i of this.buckets.get((cx + 32768) * 65536 + (cy + 32768)) ?? []) visit(i);
        }
      }
    }
    return out;
  }
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
