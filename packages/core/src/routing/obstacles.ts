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
/** Extra slack around the estimated label region, in ground (u, v) units. */
const PAD = 0.3;
/** Adjacent column rects overlap by this much so a route cannot slip through the seam. */
const SLIT = 0.05;

const r2 = (v: number): number => Math.round(v * 100) / 100;

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

/**
 * Occlusion shadow rects of an object (excludes the footprint): the footprint swept along (-1,-1)
 * by its height, as 0.5-step squares widened by 0.25 so consecutive steps overlap and no sliver
 * of the true shadow is left uncovered. All coordinates stay on a 0.25 lattice.
 */
export function shadowRects(box: Box3): Rect[] {
  const out: Rect[] = [];
  const x0 = box.origin.x;
  const y0 = box.origin.y;
  const x1 = x0 + box.size.x;
  const y1 = y0 + box.size.y;
  const top = box.origin.z + box.size.z;
  for (let t = CELL; t < top + CELL / 2 - 1e-9; t += CELL) {
    out.push({
      x0: r2(x0 - t - CELL / 2),
      y0: r2(y0 - t - CELL / 2),
      x1: r2(x1 - t + CELL / 2),
      y1: r2(y1 - t + CELL / 2),
    });
  }
  return out;
}

export type KeepoutKind = "shadow" | "label";

/** Zones in front of the +x and +y face midpoints of a small node (own label cells there are exempt). */
export function stubZones(box: Box3, reach = 0.75): Rect[] {
  // Only 1-tile (sm) nodes need it: their label covers both visible-side stubs; larger ones
  // clear their own label without any exemption.
  if (box.size.x > 1.25 || box.size.y > 1.25) return [];
  const x1 = box.origin.x + box.size.x;
  const y1 = box.origin.y + box.size.y;
  const cx = box.origin.x + box.size.x / 2;
  const cy = box.origin.y + box.size.y / 2;
  return [
    { x0: x1, y0: cy - 0.25, x1: x1 + reach, y1: cy + 0.25 },
    { x0: cx - 0.25, y0: y1, x1: cx + 0.25, y1: y1 + reach },
  ];
}

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

  /**
   * Rects intersecting `win`, without the shadows of `skipShadows` owners. Label cells of
   * `own.owners` that touch one of `own.zones` (the stub zones in front of the route's own
   * visible faces) are exempt, so small labelled nodes keep visible-side arrivals.
   */
  query(
    win: Rect,
    skipShadows: ReadonlySet<string>,
    own?: { readonly owners: ReadonlySet<string>; readonly zones: readonly Rect[] },
  ): Rect[] {
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
      if (
        own &&
        e.kind === "label" &&
        own.owners.has(e.owner) &&
        own.zones.some((z) => e.r.x0 < z.x1 && z.x0 < e.r.x1 && e.r.y0 < z.y1 && z.y0 < e.r.y1)
      )
        return;
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

/**
 * Ground cells covered by a screen rectangle drawn at ground-plane (z = 0) coordinates, merged
 * into column runs. `u = x - y`, `v = x + y`; a cell is kept when the L1 distance from its
 * (u, v) centre to the rectangle is within the cell's diamond (plus slack), and neighbouring
 * column rects overlap so no seam is left.
 */
function screenRectCells(sx0: number, sx1: number, sy0: number, sy1: number): Rect[] {
  const u0 = sx0 / HALF_TILE;
  const u1 = sx1 / HALF_TILE;
  const v0 = sy0 / QUARTER_TILE;
  const v1 = sy1 / QUARTER_TILE;
  const xa = Math.floor((u0 + v0 - 2 * PAD) / 2 / CELL) * CELL - CELL;
  const xb = (u1 + v1 + 2 * PAD) / 2;
  const ya = Math.floor((v0 - u1 - 2 * PAD) / 2 / CELL) * CELL - CELL;
  const yb = (v1 - u0 + 2 * PAD) / 2;
  const out: Rect[] = [];
  for (let x = xa; x <= xb; x += CELL) {
    let runStart: number | undefined;
    let runEnd = 0;
    const flush = (): void => {
      if (runStart === undefined) return;
      out.push({ x0: r2(x - SLIT), y0: r2(runStart), x1: r2(x + CELL + SLIT), y1: r2(runEnd) });
      runStart = undefined;
    };
    for (let y = ya; y <= yb + 1e-9; y += CELL) {
      const cu = x - y;
      const cv = x + y + CELL;
      const du = Math.max(u0 - cu, 0, cu - u1);
      const dv = Math.max(v0 - cv, 0, cv - v1);
      if (du + dv <= CELL / 2 + PAD) {
        if (runStart === undefined) runStart = y;
        runEnd = y + CELL;
      } else flush();
    }
    flush();
  }
  return out;
}

/** Screen position of a world point (default 2:1 projection). */
const sxOf = (x: number, y: number): number => (x - y) * HALF_TILE;
const syOf = (x: number, y: number, z: number): number => (x + y) * QUARTER_TILE - z * HALF_TILE;

/** Ground cells covered by the label drawn under the object. */
export function labelRects(label: string, box: Box3): Rect[] {
  const cx = box.origin.x + box.size.x / 2;
  const cy = box.origin.y + box.size.y / 2;
  const w = labelWidth(label);
  const bottom = syOf(box.origin.x + box.size.x, box.origin.y + box.size.y, box.origin.z);
  const sx = sxOf(cx, cy);
  return screenRectCells(sx - w / 2, sx + w / 2, bottom + 1, bottom + 24);
}

/** A1 draws the icon plate floating above the top face when the front face is too short. */
function floatingPlate(box: Box3, iconSize: number): { s: number; topY: number } | undefined {
  const frontH = box.size.z * HALF_TILE;
  const std = Math.min(iconSize, (box.size.x + box.size.y) * HALF_TILE * 0.6);
  if (!(frontH - 8 < std * 0.75)) return undefined;
  const cx = box.origin.x + box.size.x / 2;
  const cy = box.origin.y + box.size.y / 2;
  const top = syOf(cx, cy, box.origin.z + box.size.z);
  return { s: std, topY: top };
}

/**
 * Ground cells hidden behind a floating icon plate (the plate rect lies above the top face centre
 * on screen, so it covers ground behind the object). Empty when the plate sits on the face.
 */
export function plateRects(box: Box3, iconSize: number): Rect[] {
  const f = floatingPlate(box, iconSize);
  if (!f) return [];
  const cx = box.origin.x + box.size.x / 2;
  const cy = box.origin.y + box.size.y / 2;
  const sx = sxOf(cx, cy);
  const half = f.s / 2 + 2;
  return screenRectCells(sx - half, sx + half, f.topY - f.s - 8, f.topY - 4);
}

/** Ground cells hidden behind the badge pill drawn above the object (or its floating plate). */
export function badgeRects(badge: string, box: Box3, iconSize?: number): Rect[] {
  const cx = box.origin.x + box.size.x / 2;
  const cy = box.origin.y + box.size.y / 2;
  const sx = sxOf(cx, cy);
  const top = box.origin.z + box.size.z;
  let aboveTop = syOf(box.origin.x, box.origin.y, top); // back corner of the top face
  const f = iconSize === undefined ? undefined : floatingPlate(box, iconSize);
  if (f) aboveTop = Math.min(aboveTop, f.topY - f.s - 8);
  const w = Math.min(60, [...badge].length * 7.2) + 10;
  const bh = 16; // theme badge font 10 + 6
  return screenRectCells(sx - w / 2, sx + w / 2, aboveTop - bh - 2, aboveTop - 2);
}

/** Ground cells under the group label pill drawn left of the slab's left corner. */
export function groupPillRects(label: string, box: Box3): Rect[] {
  const corner = {
    sx: sxOf(box.origin.x, box.origin.y + box.size.y),
    sy: syOf(box.origin.x, box.origin.y + box.size.y, box.origin.z + box.size.z),
  };
  const w = Math.min(160, [...label].length * 7.4) + 12;
  const ph = 20; // label font 12 + 8
  return screenRectCells(
    corner.sx - 10 - w,
    corner.sx - 10,
    corner.sy - ph / 2,
    corner.sy + ph / 2,
  );
}
