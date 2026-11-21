/**
 * Local binary masks for the figure pipeline: a mask covers only its bounding box (global image
 * coordinates), so per-part work and memory are sized by the part, not by the image. All loops
 * are iterative with explicit stacks; nothing recurses.
 */

/** A binary mask over the rectangle (x, y, w, h) of an image; `data[j * w + i]` is pixel (x + i, y + j). */
export interface Mask {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const EMPTY: Mask = { x: 0, y: 0, w: 0, h: 0, data: new Uint8Array(0) };

export function blank(x: number, y: number, w: number, h: number): Mask {
  if (w <= 0 || h <= 0) return EMPTY;
  return { x, y, w, h, data: new Uint8Array(w * h) };
}

export const has = (m: Mask, gx: number, gy: number): boolean => {
  const i = gx - m.x;
  const j = gy - m.y;
  return i >= 0 && j >= 0 && i < m.w && j < m.h && m.data[j * m.w + i] !== 0;
};

export function count(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) n++;
  return n;
}

export function isEmpty(m: Mask): boolean {
  for (let i = 0; i < m.data.length; i++) if (m.data[i]) return false;
  return true;
}

/** Tight bounding box of the set pixels, or undefined when empty. */
export function bounds(m: Mask): Box | undefined {
  let x0 = m.w;
  let y0 = m.h;
  let x1 = -1;
  let y1 = -1;
  for (let j = 0; j < m.h; j++) {
    for (let i = 0; i < m.w; i++) {
      if (m.data[j * m.w + i]) {
        if (i < x0) x0 = i;
        if (i > x1) x1 = i;
        if (j < y0) y0 = j;
        y1 = j;
      }
    }
  }
  return x1 < 0 ? undefined : { x: x0 + m.x, y: y0 + m.y, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** The same mask cropped to its tight bounding box. */
export function tight(m: Mask): Mask {
  const b = bounds(m);
  if (!b) return EMPTY;
  if (b.x === m.x && b.y === m.y && b.w === m.w && b.h === m.h) return m;
  return within(m, b);
}

/** Copy of `m` over the box `b` (pixels outside m are 0). */
export function within(m: Mask, b: Box): Mask {
  const out = blank(b.x, b.y, b.w, b.h);
  if (out === EMPTY) return out;
  const x0 = Math.max(b.x, m.x);
  const x1 = Math.min(b.x + b.w, m.x + m.w);
  const y0 = Math.max(b.y, m.y);
  const y1 = Math.min(b.y + b.h, m.y + m.h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++)
      out.data[(y - b.y) * b.w + x - b.x] = m.data[(y - m.y) * m.w + x - m.x]!;
  }
  return out;
}

export function unionBox(a: Box, b: Box): Box {
  if (a.w <= 0 || a.h <= 0) return b;
  if (b.w <= 0 || b.h <= 0) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function clipBox(b: Box, W: number, H: number): Box {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  return {
    x,
    y,
    w: Math.max(0, Math.min(W, b.x + b.w) - x),
    h: Math.max(0, Math.min(H, b.y + b.h) - y),
  };
}

export function union(...ms: readonly Mask[]): Mask {
  let box: Box = { x: 0, y: 0, w: 0, h: 0 };
  for (const m of ms) if (m.w > 0 && m.h > 0) box = unionBox(box, m);
  const out = blank(box.x, box.y, box.w, box.h);
  if (out === EMPTY) return out;
  for (const m of ms) {
    for (let j = 0; j < m.h; j++) {
      const o = (j + m.y - box.y) * box.w + m.x - box.x;
      for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) out.data[o + i] = 1;
    }
  }
  return out;
}

/** Pixels of `a` that are not in `b`. */
export function minus(a: Mask, b: Mask): Mask {
  const data = new Uint8Array(a.data);
  for (let j = 0; j < a.h; j++) {
    for (let i = 0; i < a.w; i++)
      if (data[j * a.w + i] && has(b, i + a.x, j + a.y)) data[j * a.w + i] = 0;
  }
  return { ...a, data };
}

export function intersect(a: Mask, b: Mask): Mask {
  const box = {
    x: Math.max(a.x, b.x),
    y: Math.max(a.y, b.y),
    w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
  };
  const out = blank(box.x, box.y, box.w, box.h);
  if (out === EMPTY) return out;
  for (let j = 0; j < box.h; j++) {
    for (let i = 0; i < box.w; i++) {
      if (has(a, i + box.x, j + box.y) && has(b, i + box.x, j + box.y)) out.data[j * box.w + i] = 1;
    }
  }
  return out;
}

/** Pixels of `m` for which `keep(gx, gy)` holds. */
export function filter(m: Mask, keep: (gx: number, gy: number) => boolean): Mask {
  const data = new Uint8Array(m.data);
  for (let j = 0; j < m.h; j++) {
    for (let i = 0; i < m.w; i++)
      if (data[j * m.w + i] && !keep(i + m.x, j + m.y)) data[j * m.w + i] = 0;
  }
  return { ...m, data };
}

export const shifted = (m: Mask, dx: number, dy: number): Mask => ({
  ...m,
  x: m.x + dx,
  y: m.y + dy,
});

export function overlaps(a: Mask, b: Mask): boolean {
  const x0 = Math.max(a.x, b.x);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y0 = Math.max(a.y, b.y);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++)
      if (a.data[(y - a.y) * a.w + x - a.x] && b.data[(y - b.y) * b.w + x - b.x]) return true;
  }
  return false;
}

export function overlapCount(a: Mask, b: Mask): number {
  let n = 0;
  const x0 = Math.max(a.x, b.x);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y0 = Math.max(a.y, b.y);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++)
      if (a.data[(y - a.y) * a.w + x - a.x] && b.data[(y - b.y) * b.w + x - b.x]) n++;
  }
  return n;
}

/**
 * Square (Chebyshev) dilation by `r`, separable (rows then columns), clamped to the image
 * W x H. Cost O(area * 2).
 */
export function dilate(m: Mask, r: number, W: number, H: number): Mask {
  if (r <= 0 || m.w === 0) return m;
  const box = clipBox({ x: m.x - r, y: m.y - r, w: m.w + 2 * r, h: m.h + 2 * r }, W, H);
  const src = within(m, box);
  if (src === EMPTY) return EMPTY;
  const { w, h } = box;
  const tmp = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    let last = -Infinity;
    for (let i = 0; i < w; i++) {
      if (src.data[j * w + i]) last = i;
      if (i - last <= r) tmp[j * w + i] = 1;
    }
    last = Infinity;
    for (let i = w - 1; i >= 0; i--) {
      if (src.data[j * w + i]) last = i;
      if (last - i <= r) tmp[j * w + i] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w; i++) {
    let last = -Infinity;
    for (let j = 0; j < h; j++) {
      if (tmp[j * w + i]) last = j;
      if (j - last <= r) out[j * w + i] = 1;
    }
    last = Infinity;
    for (let j = h - 1; j >= 0; j--) {
      if (tmp[j * w + i]) last = j;
      if (last - j <= r) out[j * w + i] = 1;
    }
  }
  return { ...box, data: out };
}

/** Square erosion by 1 inside the mask's own box (outside counts as unset). */
export function erode1(m: Mask): Mask {
  const out = new Uint8Array(m.w * m.h);
  for (let j = 1; j < m.h - 1; j++) {
    for (let i = 1; i < m.w - 1; i++) {
      let all = true;
      for (let dj = -1; dj <= 1 && all; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!m.data[(j + dj) * m.w + i + di]) {
            all = false;
            break;
          }
        }
      }
      if (all) out[j * m.w + i] = 1;
    }
  }
  return { ...m, data: out };
}

/**
 * Fills every unset region not 4-connected to the outside of the mask's box: the enclosed
 * whites become set. Explicit stack, one pass.
 */
export function fillHoles(m: Mask): Mask {
  const w = m.w + 2;
  const h = m.h + 2;
  if (m.w === 0) return m;
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const set = (i: number, j: number): boolean =>
    i > 0 && j > 0 && i <= m.w && j <= m.h && m.data[(j - 1) * m.w + i - 1] !== 0;
  outside[0] = 1;
  stack[sp++] = 0;
  while (sp > 0) {
    const p = stack[--sp]!;
    const i = p % w;
    const j = (p - i) / w;
    const nb = [
      [i - 1, j],
      [i + 1, j],
      [i, j - 1],
      [i, j + 1],
    ] as const;
    for (const [a, b] of nb) {
      if (a < 0 || b < 0 || a >= w || b >= h) continue;
      const q = b * w + a;
      if (outside[q] || set(a, b)) continue;
      outside[q] = 1;
      stack[sp++] = q;
    }
  }
  const data = new Uint8Array(m.w * m.h);
  for (let j = 0; j < m.h; j++)
    for (let i = 0; i < m.w; i++) data[j * m.w + i] = outside[(j + 1) * w + i + 1] ? 0 : 1;
  return { ...m, data };
}

/** Pixels of `m` inside enclosed holes only (fillHoles(m) minus m). */
export function holes(m: Mask): Mask {
  const f = fillHoles(m);
  const data = new Uint8Array(f.data);
  for (let i = 0; i < data.length; i++) if (m.data[i]) data[i] = 0;
  return { ...m, data };
}

export interface Component {
  readonly pixels: number;
  readonly box: Box;
}

/**
 * 8- (or 4-) connected components of the pixels where `fg` is set, inside the box `b`. When
 * `weight` is given, a component's `pixels` counts only the pixels where weight is set (the
 * excluded-but-connective rule of the gate), while connectivity runs over all of `fg`. `reach`
 * 2 (with 8-connectivity) joins pixels at Chebyshev distance up to 2: across exactly 1 px gaps.
 */
export function components(
  b: Box,
  fg: (gx: number, gy: number) => boolean,
  connectivity: 4 | 8 = 8,
  weight?: (gx: number, gy: number) => boolean,
  reach: 1 | 2 = 1,
): Component[] {
  const { x: bx, y: by, w, h } = b;
  if (w <= 0 || h <= 0) return [];
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out: Component[] = [];
  for (let p0 = 0; p0 < w * h; p0++) {
    if (seen[p0]) continue;
    const i0 = p0 % w;
    const j0 = (p0 - i0) / w;
    if (!fg(i0 + bx, j0 + by)) continue;
    let sp = 0;
    seen[p0] = 1;
    stack[sp++] = p0;
    let n = 0;
    let x0 = i0;
    let x1 = i0;
    let y0 = j0;
    let y1 = j0;
    let any = false;
    while (sp > 0) {
      const p = stack[--sp]!;
      const i = p % w;
      const j = (p - i) / w;
      if (!weight || weight(i + bx, j + by)) {
        n++;
        if (!any) {
          x0 = x1 = i;
          y0 = y1 = j;
          any = true;
        } else {
          if (i < x0) x0 = i;
          if (i > x1) x1 = i;
          if (j < y0) y0 = j;
          if (j > y1) y1 = j;
        }
      }
      for (let dj = -reach; dj <= reach; dj++) {
        for (let di = -reach; di <= reach; di++) {
          if ((di === 0 && dj === 0) || (connectivity === 4 && di !== 0 && dj !== 0)) continue;
          if (connectivity === 4 && (di < -1 || di > 1 || dj < -1 || dj > 1)) continue;
          const a = i + di;
          const c = j + dj;
          if (a < 0 || c < 0 || a >= w || c >= h) continue;
          const q = c * w + a;
          if (seen[q] || !fg(a + bx, c + by)) continue;
          seen[q] = 1;
          stack[sp++] = q;
        }
      }
    }
    if (n > 0)
      out.push({ pixels: n, box: { x: x0 + bx, y: y0 + by, w: x1 - x0 + 1, h: y1 - y0 + 1 } });
  }
  return out;
}

/** Largest component first; ties by box y, then x (total order). */
export const byPixels = (a: Component, b: Component): number =>
  b.pixels - a.pixels ||
  a.box.y - b.box.y ||
  a.box.x - b.box.x ||
  a.box.w - b.box.w ||
  a.box.h - b.box.h;

/**
 * Convex hull (monotone chain) of the set pixels' centres, rasterized back as a mask (pixel
 * centres inside or on the hull). Uses the leftmost and rightmost pixel of each row, so the
 * work is O(h log h + area).
 */
export function convexHull(m: Mask): Mask {
  const pts: [number, number][] = [];
  for (let j = 0; j < m.h; j++) {
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < m.w; i++) {
      if (m.data[j * m.w + i]) {
        if (lo < 0) lo = i;
        hi = i;
      }
    }
    if (lo >= 0) {
      pts.push([lo + m.x, j + m.y]);
      if (hi !== lo) pts.push([hi + m.x, j + m.y]);
    }
  }
  return hullOfPoints(pts);
}

export function hullOfPoints(input: readonly (readonly [number, number])[]): Mask {
  if (input.length === 0) return EMPTY;
  const pts = [...input].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]): number =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lower: (readonly [number, number])[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: (readonly [number, number])[] = [];
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = pts[k]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  const poly = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (poly.length === 0) poly.push(pts[0]!);
  return rasterPolygon(poly);
}

/** Pixels whose centre lies inside or on a convex polygon (vertices in pixel-centre coordinates). */
export function rasterPolygon(poly: readonly (readonly [number, number])[]): Mask {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const out = blank(x0, y0, Math.max(...xs) - x0 + 1, Math.max(...ys) - y0 + 1);
  for (let y = y0; y < y0 + out.h; y++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]!;
      const b = poly[(k + 1) % poly.length]!;
      if ((a[1] - y) * (b[1] - y) > 0) continue;
      if (a[1] === b[1]) {
        lo = Math.min(lo, a[0], b[0]);
        hi = Math.max(hi, a[0], b[0]);
      } else {
        const x = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
    if (poly.length === 1) {
      lo = hi = poly[0]![0];
    }
    for (let x = Math.ceil(lo - 1e-9); x <= Math.floor(hi + 1e-9); x++)
      out.data[(y - y0) * out.w + x - x0] = 1;
  }
  return out;
}

/** Mask of a rectangle clamped to the image. */
export function rectMask(x: number, y: number, w: number, h: number, W: number, H: number): Mask {
  const b = clipBox({ x, y, w, h }, W, H);
  const out = blank(b.x, b.y, b.w, b.h);
  out.data.fill(1);
  return out;
}

/**
 * Pixels whose centre lies within distance `r` of the polyline (a union of capsules), clamped
 * to the image. Each segment is rasterized row by row as an interval (a capsule is convex), so
 * the work is about the band's area plus its rows.
 */
export function capsules(
  pts: readonly (readonly [number, number])[],
  r: number,
  W: number,
  H: number,
): Mask {
  if (pts.length === 0) return EMPTY;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const rr = Math.ceil(r);
  const box = clipBox(
    {
      x: Math.floor(Math.min(...xs)) - rr,
      y: Math.floor(Math.min(...ys)) - rr,
      w: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)) + 2 * rr + 1,
      h: Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys)) + 2 * rr + 1,
    },
    W,
    H,
  );
  const out = blank(box.x, box.y, box.w, box.h);
  if (out === EMPTY) return out;
  const segs =
    pts.length === 1
      ? [[pts[0]!, pts[0]!] as const]
      : pts.slice(1).map((p, k) => [pts[k]!, p] as const);
  for (const [A, B] of segs) {
    const [ax, ay] = A;
    const [bx, by] = B;
    const L = Math.hypot(bx - ax, by - ay);
    const ux = L > 0 ? (bx - ax) / L : 0;
    const uy = L > 0 ? (by - ay) / L : 0;
    const nx = -uy;
    const ny = ux;
    const yLo = Math.max(box.y, Math.floor(Math.min(ay, by) - r));
    const yHi = Math.min(box.y + box.h - 1, Math.ceil(Math.max(ay, by) + r));
    for (let y = yLo; y <= yHi; y++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const [cx, cy] of [A, B]) {
        const dy = y - cy;
        if (Math.abs(dy) <= r) {
          const half = Math.sqrt(r * r - dy * dy);
          lo = Math.min(lo, cx - half);
          hi = Math.max(hi, cx + half);
        }
      }
      if (L > 0) {
        // |(x - ax) nx + (y - ay) ny| <= r  and  0 <= (x - ax) ux + (y - ay) uy <= L
        let a = -Infinity;
        let b = Infinity;
        const cons: [number, number, number][] = [
          [nx, (y - ay) * ny, r],
          [ux, (y - ay) * uy - L / 2, L / 2],
        ];
        let ok = true;
        for (const [k, c, lim] of cons) {
          // |k (x - ax) + c| <= lim
          if (Math.abs(k) < 1e-12) {
            if (Math.abs(c) > lim) ok = false;
            continue;
          }
          const p = (-lim - c) / k + ax;
          const q = (lim - c) / k + ax;
          a = Math.max(a, Math.min(p, q));
          b = Math.min(b, Math.max(p, q));
        }
        if (ok && a <= b) {
          lo = Math.min(lo, a);
          hi = Math.max(hi, b);
        }
      }
      if (lo > hi) continue;
      const xa = Math.max(box.x, Math.ceil(lo - 1e-9));
      const xb = Math.min(box.x + box.w - 1, Math.floor(hi + 1e-9));
      for (let x = xa; x <= xb; x++) out.data[(y - box.y) * box.w + x - box.x] = 1;
    }
  }
  return out;
}

/** Square erosion by `r` (outside the mask's box counts as unset). */
export function erode(m: Mask, r: number): Mask {
  if (r <= 0 || m.w === 0) return m;
  const pad = blank(m.x - r - 1, m.y - r - 1, m.w + 2 * r + 2, m.h + 2 * r + 2);
  for (let j = 0; j < pad.h; j++)
    for (let i = 0; i < pad.w; i++) pad.data[j * pad.w + i] = has(m, i + pad.x, j + pad.y) ? 0 : 1;
  // Dilate the complement inside the padded box (local coordinates, so image edges don't clip).
  const local = dilate({ ...pad, x: 0, y: 0 }, r, pad.w, pad.h);
  const comp = { ...local, x: local.x + pad.x, y: local.y + pad.y };
  const data = new Uint8Array(m.w * m.h);
  for (let j = 0; j < m.h; j++)
    for (let i = 0; i < m.w; i++)
      if (m.data[j * m.w + i] && !has(comp, i + m.x, j + m.y)) data[j * m.w + i] = 1;
  return { ...m, data };
}

/** 8-connected labels of a local mask (1..count, raster order of first pixel). */
export function labelMask(m: Mask): { labels: Int32Array; count: number } {
  const labels = new Int32Array(m.w * m.h);
  let n = 0;
  const stack: number[] = [];
  for (let p0 = 0; p0 < m.w * m.h; p0++) {
    if (!m.data[p0] || labels[p0]) continue;
    n++;
    labels[p0] = n;
    stack.push(p0);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const i = p % m.w;
      const j = (p - i) / m.w;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const a = i + di;
          const b = j + dj;
          if (a < 0 || b < 0 || a >= m.w || b >= m.h) continue;
          const q = b * m.w + a;
          if (!m.data[q] || labels[q]) continue;
          labels[q] = n;
          stack.push(q);
        }
      }
    }
  }
  return { labels, count: n };
}

/** Set pixels with a 4-neighbour outside the mask (the boundary length in pixels). */
export function perimeter(m: Mask): number {
  let n = 0;
  for (let j = 0; j < m.h; j++) {
    for (let i = 0; i < m.w; i++) {
      if (!m.data[j * m.w + i]) continue;
      if (
        i === 0 ||
        j === 0 ||
        i === m.w - 1 ||
        j === m.h - 1 ||
        !m.data[j * m.w + i - 1] ||
        !m.data[j * m.w + i + 1] ||
        !m.data[(j - 1) * m.w + i] ||
        !m.data[(j + 1) * m.w + i]
      )
        n++;
    }
  }
  return n;
}

/**
 * Nearest set pixel of `m` to (x, y) within Chebyshev radius `r` (window scan; ties by raster
 * order), or undefined.
 */
export function nearest(
  m: Mask,
  x: number,
  y: number,
  r: number,
): { x: number; y: number; d2: number } | undefined {
  let best: { x: number; y: number; d2: number } | undefined;
  const x0 = Math.max(m.x, x - r);
  const x1 = Math.min(m.x + m.w - 1, x + r);
  const y0 = Math.max(m.y, y - r);
  const y1 = Math.min(m.y + m.h - 1, y + r);
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      if (!m.data[(yy - m.y) * m.w + xx - m.x]) continue;
      const d2 = (xx - x) * (xx - x) + (yy - y) * (yy - y);
      if (!best || d2 < best.d2) best = { x: xx, y: yy, d2 };
    }
  }
  return best;
}

/**
 * Removes every pixel of `m` reachable from outside its box through pixels that are not
 * (in `m` and `keep`): the unbounded peel of closing-only ink and the paper behind it (comb fin
 * gaps open to the exterior), while seeded faces and raw ink (`keep`) stay. Explicit stack.
 */
export function peelExterior(m: Mask, keep: (gx: number, gy: number) => boolean): Mask {
  if (m.w === 0) return m;
  const w = m.w + 2;
  const h = m.h + 2;
  const solid = (i: number, j: number): boolean =>
    i > 0 &&
    j > 0 &&
    i <= m.w &&
    j <= m.h &&
    m.data[(j - 1) * m.w + i - 1] !== 0 &&
    keep(i - 1 + m.x, j - 1 + m.y);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [0];
  seen[0] = 1;
  while (stack.length > 0) {
    const p = stack.pop()!;
    const i = p % w;
    const j = (p - i) / w;
    for (const [a, b] of [
      [i - 1, j],
      [i + 1, j],
      [i, j - 1],
      [i, j + 1],
    ] as const) {
      if (a < 0 || b < 0 || a >= w || b >= h) continue;
      const q = b * w + a;
      if (seen[q] || solid(a, b)) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  const data = new Uint8Array(m.data);
  for (let j = 0; j < m.h; j++)
    for (let i = 0; i < m.w; i++) if (seen[(j + 1) * w + i + 1]) data[j * m.w + i] = 0;
  return { ...m, data };
}

/** The components of `ink` (inside `hull`) with no raw-ink neighbour outside the hull. */
export function endingInk(ink: Mask, hull: Mask, raw: Uint8Array, W: number, H: number): Mask {
  if (ink.w === 0) return ink;
  const lab = labelMask(ink);
  const runsOn = new Uint8Array(lab.count + 1);
  for (let j = 0; j < ink.h; j++) {
    for (let i = 0; i < ink.w; i++) {
      const l = lab.labels[j * ink.w + i]!;
      if (!l || runsOn[l]) continue;
      for (let dy = -1; dy <= 1 && !runsOn[l]; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = i + ink.x + dx;
          const y = j + ink.y + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          if (raw[y * W + x] && !has(hull, x, y)) {
            runsOn[l] = 1;
            break;
          }
        }
    }
  }
  return filter(ink, (x, y) => {
    const l = lab.labels[(y - ink.y) * ink.w + x - ink.x]!;
    return l > 0 && runsOn[l] === 0;
  });
}
