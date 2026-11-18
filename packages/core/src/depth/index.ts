import type { Box3, Projection, Rect, SceneGroup } from "../contracts/index.js";
import { projectBoxBounds } from "../geometry/index.js";

/**
 * Depth ordering (PLAN §6): back-to-front order of solids by box overlap comparison plus a
 * topological sort. The viewer looks from +x, +y, +z, so a box that lies entirely at smaller
 * x, y or z than another can never occlude it.
 *
 * Deterministic: every tie is broken by the center depth key, then by id (code-unit order).
 */

export interface DepthItem {
  readonly id: string;
  /** World-space box. */
  readonly box: Box3;
}

const EPS = 1e-9;

function max(box: Box3) {
  return {
    x: box.origin.x + box.size.x,
    y: box.origin.y + box.size.y,
    z: box.origin.z + box.size.z,
  };
}

/** Sum of the center coordinates: larger = nearer the viewer. */
export function depthKey(box: Box3): number {
  return (
    box.origin.x +
    box.size.x / 2 +
    (box.origin.y + box.size.y / 2) +
    (box.origin.z + box.size.z / 2)
  );
}

function behind(a: Box3, b: Box3): boolean {
  const am = max(a);
  return am.x <= b.origin.x + EPS || am.y <= b.origin.y + EPS || am.z <= b.origin.z + EPS;
}

function contains(outer: Box3, inner: Box3): boolean {
  const om = max(outer);
  const im = max(inner);
  return (
    outer.origin.x <= inner.origin.x + EPS &&
    outer.origin.y <= inner.origin.y + EPS &&
    outer.origin.z <= inner.origin.z + EPS &&
    om.x + EPS >= im.x &&
    om.y + EPS >= im.y &&
    om.z + EPS >= im.z
  );
}

/**
 * Relation of two boxes that overlap on screen: `-1` when `a` must be drawn before `b`,
 * `1` when after, `0` when the geometry does not decide (caller falls back to center depth).
 */
export function compareBoxes(a: Box3, b: Box3): -1 | 0 | 1 {
  const ab = behind(a, b);
  const ba = behind(b, a);
  if (ab && !ba) return -1;
  if (ba && !ab) return 1;
  if (!ab && !ba) {
    // Volumes intersect: a container is drawn first, its contents on top.
    const aCb = contains(a, b);
    const bCa = contains(b, a);
    if (aCb && !bCa) return -1;
    if (bCa && !aCb) return 1;
  }
  return 0;
}

function overlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width - EPS &&
    b.x < a.x + a.width - EPS &&
    a.y < b.y + b.height - EPS &&
    b.y < a.y + a.height - EPS
  );
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Back-to-front order of item ids. Items whose screen bounds do not overlap are not
 * constrained; overlapping pairs get an edge from compareBoxes; a deterministic Kahn sort
 * (lowest center depth, then id, first) emits the result, breaking cycles by the same key.
 * Throws on duplicate ids.
 */
export function depthOrder(items: readonly DepthItem[], projection: Projection): string[] {
  const n = items.length;
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id)) throw new Error(`duplicate depth item id: ${it.id}`);
    seen.add(it.id);
  }
  const keys = items.map((it) => depthKey(it.box));
  const rects = items.map((it) => projectBoxBounds(projection, it.box));
  const out: number[][] = items.map(() => []);
  const indeg = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!overlap(rects[i] as Rect, rects[j] as Rect)) continue;
      let rel = compareBoxes((items[i] as DepthItem).box, (items[j] as DepthItem).box);
      if (rel === 0) {
        const d = (keys[i] as number) - (keys[j] as number);
        if (Math.abs(d) <= EPS) continue; // same depth, no constraint: id tiebreak orders them
        rel = d < 0 ? -1 : 1;
      }
      if (rel < 0) {
        (out[i] as number[]).push(j);
        indeg[j] = (indeg[j] as number) + 1;
      } else {
        (out[j] as number[]).push(i);
        indeg[i] = (indeg[i] as number) + 1;
      }
    }
  }

  const better = (x: number, y: number): boolean => {
    const dk = (keys[x] as number) - (keys[y] as number);
    if (Math.abs(dk) > EPS) return dk < 0;
    return cmpStr((items[x] as DepthItem).id, (items[y] as DepthItem).id) < 0;
  };

  const done = new Array<boolean>(n).fill(false);
  const order: string[] = [];
  for (let emitted = 0; emitted < n; emitted++) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (done[i] || indeg[i] !== 0) continue;
      if (pick < 0 || better(i, pick)) pick = i;
    }
    if (pick < 0) {
      // Cycle: release the best remaining node.
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        if (pick < 0 || better(i, pick)) pick = i;
      }
    }
    done[pick] = true;
    order.push((items[pick] as DepthItem).id);
    for (const j of out[pick] as number[]) indeg[j] = (indeg[j] as number) - 1;
  }
  return order;
}

/**
 * Ground layer order (Layer contract): deeper-nested groups draw above shallower ones, and
 * within a level groups go back to front by center depth, then id.
 */
export function orderGroups(groups: readonly SceneGroup[]): SceneGroup[] {
  return [...groups].sort(
    (a, b) => a.level - b.level || depthKey(a.box) - depthKey(b.box) || cmpStr(a.id, b.id),
  );
}
