/** Connected-component primitives for C-4: flood fill and raster-scan labelling (4 or 8 connectivity). */
import { MAX_PIXELS, type Rect } from "./raster.js";

export type Connectivity = 4 | 8;

/**
 * Core fill. Marks `seen`, calls `visit(index)` for each reached pixel. `pass(index)` decides
 * whether a not yet seen pixel may be entered. Iterative; the stack holds each pixel at most once.
 */
function fill(
  width: number,
  height: number,
  seeds: Iterable<number>,
  pass: (index: number) => boolean,
  connectivity: Connectivity,
  seen: Uint8Array,
  stack: Int32Array,
  visit?: (index: number, x: number, y: number) => void,
): void {
  let sp = 0;
  const push = (n: number): void => {
    if (seen[n] === 0 && pass(n)) {
      seen[n] = 1;
      stack[sp++] = n;
    }
  };
  for (const s of seeds) push(s);
  while (sp > 0) {
    const p = stack[--sp]!;
    const x = p % width;
    const y = (p - x) / width;
    visit?.(p, x, y);
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (y > 0) push(p - width);
    if (y < height - 1) push(p + width);
    if (connectivity === 8) {
      if (x > 0 && y > 0) push(p - width - 1);
      if (x < width - 1 && y > 0) push(p - width + 1);
      if (x > 0 && y < height - 1) push(p + width - 1);
      if (x < width - 1 && y < height - 1) push(p + width + 1);
    }
  }
}

/**
 * Flood fill: from every seed index (row-major `y * width + x`) that satisfies `pass`, spreads
 * through `pass` pixels. Returns a mask (1 = reached).
 */
export function floodFill(
  width: number,
  height: number,
  seeds: Iterable<number>,
  pass: (index: number) => boolean,
  connectivity: Connectivity = 4,
): Uint8Array {
  checkSize(width, height);
  const seen = new Uint8Array(width * height);
  fill(width, height, seeds, pass, connectivity, seen, new Int32Array(width * height));
  return seen;
}

export interface Labels {
  /** 0 = not in the foreground; components are 1..count in raster-scan order of their first pixel. */
  readonly labels: Int32Array;
  readonly count: number;
  /** Pixel count per component (index label - 1). */
  readonly areas: Int32Array;
  /** x, y, w, h per component (4 entries each, index (label - 1) * 4). */
  readonly bboxes: Int32Array;
}

/** The bbox of component `id` (1-based). */
export function labelBox(l: Labels, id: number): Rect {
  const o = (id - 1) * 4;
  return { x: l.bboxes[o]!, y: l.bboxes[o + 1]!, w: l.bboxes[o + 2]!, h: l.bboxes[o + 3]! };
}

function checkSize(width: number, height: number): void {
  if (!(width > 0 && height > 0 && Number.isInteger(width) && Number.isInteger(height))) {
    throw new RangeError("width and height must be positive integers");
  }
  if (width * height > MAX_PIXELS) {
    throw new RangeError(`${width}x${height} is above the ${MAX_PIXELS} pixel limit`);
  }
}

function grow(a: Int32Array, need: number): Int32Array {
  if (need <= a.length) return a;
  const b = new Int32Array(Math.max(need, a.length * 2));
  b.set(a);
  return b;
}

/** Connected-component labelling of the pixels where `foreground` is true (or a nonzero mask entry). */
export function label(
  width: number,
  height: number,
  foreground: ((index: number) => boolean) | ArrayLike<number>,
  connectivity: Connectivity = 4,
): Labels {
  const fg =
    typeof foreground === "function" ? foreground : (i: number): boolean => foreground[i] !== 0;
  checkSize(width, height);
  const labels = new Int32Array(width * height);
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let areas: Int32Array = new Int32Array(256);
  let bboxes: Int32Array = new Int32Array(1024);
  let count = 0;
  for (let p = 0; p < width * height; p++) {
    if (seen[p] !== 0 || !fg(p)) continue;
    const id = count + 1;
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    fill(width, height, [p], fg, connectivity, seen, stack, (i, x, y) => {
      labels[i] = id;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    areas = grow(areas, count + 1);
    bboxes = grow(bboxes, (count + 1) * 4);
    areas[count] = area;
    bboxes.set([minX, minY, maxX - minX + 1, maxY - minY + 1], count * 4);
    count++;
  }
  return { labels, count, areas: areas.slice(0, count), bboxes: bboxes.slice(0, count * 4) };
}
