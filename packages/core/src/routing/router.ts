/**
 * Obstacle-avoiding orthogonal router (Track A2). A* over the Hanan-style grid of obstacle edges,
 * cost = length + bend penalty, deterministic tie-breaking. Everything is on the ground plane
 * (z = 0, PLAN D6); DC ports above the floor get a vertical stub down to z = 0.
 */
import type { Box3, Vec3 } from "../contracts/index.js";
import { simplify } from "./index.js";

export interface RouteEndpoint {
  readonly box: Box3;
  /** World-space attachment points (DC ports); when absent the four side midpoints are used. */
  readonly ports?: readonly Vec3[];
}

export interface RouteResult {
  readonly path: Vec3[];
  /** True when no obstacle-free route exists and a straight fallback was used. */
  readonly blocked: boolean;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Registry of routed segments, so later edges avoid sharing lanes (fan-out stays readable). */
export class RouteLanes {
  private readonly h = new Map<number, { a: number; b: number; src: string }[]>();
  private readonly v = new Map<number, { a: number; b: number; src: string }[]>();
  private readonly points = new Set<string>();

  add(path: readonly Vec3[], src: string): void {
    for (let i = 0; i + 1 < path.length; i++) {
      const p = path[i]!;
      const q = path[i + 1]!;
      if (p.z !== 0 || q.z !== 0) continue;
      if (p.y === q.y && p.x !== q.x) this.put(this.h, p.y, p.x, q.x, src);
      else if (p.x === q.x && p.y !== q.y) this.put(this.v, p.x, p.y, q.y, src);
    }
    const first = path[0];
    if (first) this.points.add(`${first.x},${first.y}`);
  }

  private put(
    m: Map<number, { a: number; b: number; src: string }[]>,
    c: number,
    a: number,
    b: number,
    src: string,
  ): void {
    const list = m.get(c) ?? [];
    list.push({ a: Math.min(a, b), b: Math.max(a, b), src });
    m.set(c, list);
  }

  usedPoint(x: number, y: number): boolean {
    return this.points.has(`${x},${y}`);
  }

  /** Penalty for travelling along `c` between `a` and `b` over an already used lane. */
  overlapCost(horizontal: boolean, c: number, a: number, b: number, src: string): number {
    const list = (horizontal ? this.h : this.v).get(c);
    if (!list) return 0;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    let cost = 0;
    for (const e of list) {
      const ov = Math.min(hi, e.b) - Math.max(lo, e.a);
      if (ov > 1e-9) cost += ov * (e.src === src ? 4 : 1.5);
    }
    return cost;
  }

  /** Coordinates of used lanes (extra grid lines are offered 0.5 beside them, so near-parallel edges separate). */
  lines(win: Rect): { h: number[]; v: number[] } {
    // Only lanes inside the search window, nearest to its centre first, at most 80 per axis.
    const mid = (a: number, b: number): number => (Number.isFinite(a + b) ? (a + b) / 2 : 0);
    const cx = mid(win.x0, win.x1);
    const cy = mid(win.y0, win.y1);
    const pick = (
      m: Map<number, { src: string }[]>,
      lo: number,
      hi: number,
      mid: number,
    ): number[] =>
      [...m.keys()]
        .filter((c) => c >= lo && c <= hi)
        .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b)
        .slice(0, 80);
    return {
      h: pick(this.h, win.y0, win.y1, cy),
      v: pick(this.v, win.x0, win.x1, cx),
    };
  }
}

export interface RouteContext {
  readonly lanes?: RouteLanes;
  /** Source object id (same-source edges must not share segments). */
  readonly source?: string;
  /**
   * Extra pre-inflated obstacle rects (occlusion shadows, label keep-outs), or a provider that
   * returns those intersecting the current search window.
   */
  readonly extra?: readonly Rect[] | ((window: Rect) => readonly Rect[]);
}

interface Terminal {
  /** Extra start/arrival cost (lane offsets, reused points). */
  pen: number;
  /** 0 = stub runs along x, 1 = along y. */
  axis: number;
  /** Point on the box boundary (with its own z). */
  at: Vec3;
  /** Outward unit direction on the ground plane. */
  dx: number;
  dy: number;
  stub: { x: number; y: number };
}

const CLEAR = 0.4;
const STUB = 0.5;
const BEND = 2;
/** Hard caps so a pathological scene falls back instead of stalling. */
const MAX_GRID = 60000;
const MAX_EXPANSIONS = 150000;

/** Work counters (deterministic, unlike wall-clock time) so tests can bound router cost. */
export interface RouterStats {
  /** A* node expansions across all searches since the last reset. */
  expansions: number;
  /** Searches abandoned because the grid or expansion cap was hit. */
  capHits: number;
}
const stats: RouterStats = { expansions: 0, capHits: 0 };
export function resetRouterStats(): void {
  stats.expansions = 0;
  stats.capHits = 0;
}
export function getRouterStats(): Readonly<RouterStats> {
  return { ...stats };
}
const BUCKET = 4;
const r2 = (v: number): number => Math.round(v * 100) / 100;

const rectOf = (b: Box3): Rect => ({
  x0: b.origin.x,
  y0: b.origin.y,
  x1: b.origin.x + b.size.x,
  y1: b.origin.y + b.size.y,
});
const inflate = (r: Rect, m: number): Rect => ({
  x0: r.x0 - m,
  y0: r.y0 - m,
  x1: r.x1 + m,
  y1: r.y1 + m,
});

function terminalsOf(
  ep: RouteEndpoint,
  lanes?: RouteLanes,
  toward?: { x: number; y: number },
): Terminal[] {
  const r = rectOf(ep.box);
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const list: { at: Vec3; dx: number; dy: number; pen: number }[] = [];
  if (ep.ports && ep.ports.length > 0) {
    for (const p of ep.ports) {
      // Outward side = nearest box side to the port.
      const dists = [
        { d: Math.abs(p.x - r.x1), dx: 1, dy: 0 },
        { d: Math.abs(p.x - r.x0), dx: -1, dy: 0 },
        { d: Math.abs(p.y - r.y1), dx: 0, dy: 1 },
        { d: Math.abs(p.y - r.y0), dx: 0, dy: -1 },
      ];
      let best = dists[0]!;
      for (const d of dists) if (d.d < best.d - 1e-9) best = d;
      list.push({ at: p, dx: best.dx, dy: best.dy, pen: 0 });
    }
  } else {
    // Side midpoints first; offset lanes (0.5 apart) let sibling edges leave side by side.
    const lane = (len: number): number[] => {
      const out = [0];
      // Only sources (routes registered in `lanes`) may leave off-center; arrivals stay on the midpoint.
      for (let o = 0.5; lanes && o <= len / 2 - 0.25 + 1e-9; o += 0.5) out.push(o, -o);
      return out;
    };
    for (const o of lane(r.y1 - r.y0)) {
      list.push({ at: { x: r.x1, y: r2(cy + o), z: 0 }, dx: 1, dy: 0, pen: Math.abs(o) * 2 });
      list.push({ at: { x: r.x0, y: r2(cy + o), z: 0 }, dx: -1, dy: 0, pen: Math.abs(o) * 2 });
    }
    for (const o of lane(r.x1 - r.x0)) {
      list.push({ at: { x: r2(cx + o), y: r.y1, z: 0 }, dx: 0, dy: 1, pen: Math.abs(o) * 2 });
      list.push({ at: { x: r2(cx + o), y: r.y0, z: 0 }, dx: 0, dy: -1, pen: Math.abs(o) * 2 });
    }
  }
  // Prefer the side facing the other endpoint along the dominant axis (flow reads left to right).
  const dxw = toward ? toward.x - cx : 0;
  const dyw = toward ? toward.y - cy : 0;
  const facing = (dx: number, dy: number): number => {
    if (!toward || (dxw === 0 && dyw === 0)) return 0;
    const xDominant = Math.abs(dxw) >= Math.abs(dyw);
    const want = xDominant ? Math.sign(dxw) : Math.sign(dyw);
    const got = xDominant ? dx : dy;
    return got === want ? 0 : 3;
  };
  return list.map((t) => ({
    at: t.at,
    dx: t.dx,
    dy: t.dy,
    axis: t.dx !== 0 ? 0 : 1,
    pen:
      t.pen +
      (lanes?.usedPoint(t.at.x, t.at.y) ? 3 : 0) +
      (ep.ports && ep.ports.length > 0 ? 0 : facing(t.dx, t.dy)),
    stub: { x: r2(t.at.x + t.dx * STUB), y: r2(t.at.y + t.dy * STUB) },
  }));
}

class Heap {
  private a: { f: number; seq: number; id: number }[] = [];
  get size(): number {
    return this.a.length;
  }
  private less(i: number, j: number): boolean {
    const x = this.a[i]!;
    const y = this.a[j]!;
    return x.f < y.f || (x.f === y.f && x.seq < y.seq);
  }
  push(f: number, seq: number, id: number): void {
    this.a.push({ f, seq, id });
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      [this.a[i], this.a[p]] = [this.a[p]!, this.a[i]!];
      i = p;
    }
  }
  pop(): { f: number; seq: number; id: number } {
    const top = this.a[0]!;
    const last = this.a.pop()!;
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const rr = l + 1;
        let m = i;
        if (l < this.a.length && this.less(l, m)) m = l;
        if (rr < this.a.length && this.less(rr, m)) m = rr;
        if (m === i) break;
        [this.a[i], this.a[m]] = [this.a[m]!, this.a[i]!];
        i = m;
      }
    }
    return top;
  }
}

const strictHit = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: Rect,
  closed: boolean,
): boolean => {
  const ax = Math.min(x0, x1);
  const bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1);
  const by = Math.max(y0, y1);
  return closed
    ? bx >= r.x0 && ax <= r.x1 && by >= r.y0 && ay <= r.y1
    : bx > r.x0 && ax < r.x1 && by > r.y0 && ay < r.y1;
};

function search(
  from: Terminal[],
  to: Terminal[],
  own: Rect[],
  obstacles: Rect[],
  ctx: RouteContext,
  win: Rect,
): { pts: { x: number; y: number }[]; src: number; dst: number } | "no-terminal" | undefined {
  const xsSet = new Set<number>();
  const ysSet = new Set<number>();
  const add = (x: number, y: number): void => {
    xsSet.add(r2(x));
    ysSet.add(r2(y));
  };
  for (const t of [...from, ...to]) add(t.stub.x, t.stub.y);
  for (const r of own) {
    add(r.x0 - CLEAR, r.y0 - CLEAR);
    add(r.x1 + CLEAR, r.y1 + CLEAR);
  }
  for (const r of obstacles) {
    add(r.x0, r.y0);
    add(r.x1, r.y1);
  }
  if (ctx.lanes && ctx.source !== undefined) {
    const ln = ctx.lanes.lines(win);
    for (const c of ln.v) {
      xsSet.add(r2(c - 0.5));
      xsSet.add(r2(c + 0.5));
    }
    for (const c of ln.h) {
      ysSet.add(r2(c - 0.5));
      ysSet.add(r2(c + 0.5));
    }
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;
  if (nx * ny > MAX_GRID) {
    stats.capHits++;
    return undefined;
  }
  // Bucket index over obstacles so each probe only tests nearby ones.
  const buckets = new Map<number, number[]>();
  const bkey = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);
  obstacles.forEach((r, i) => {
    for (let cx = Math.floor(r.x0 / BUCKET); cx <= Math.floor(r.x1 / BUCKET); cx++) {
      for (let cy = Math.floor(r.y0 / BUCKET); cy <= Math.floor(r.y1 / BUCKET); cy++) {
        const k = bkey(cx, cy);
        const list = buckets.get(k);
        if (list) list.push(i);
        else buckets.set(k, [i]);
      }
    }
  });
  const stamp = new Int32Array(obstacles.length);
  let tick = 0;
  const anyObstacleHit = (ax: number, ay: number, bx: number, by: number): boolean => {
    tick++;
    const x0 = Math.floor(Math.min(ax, bx) / BUCKET);
    const x1 = Math.floor(Math.max(ax, bx) / BUCKET);
    const y0 = Math.floor(Math.min(ay, by) / BUCKET);
    const y1 = Math.floor(Math.max(ay, by) / BUCKET);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (const i of buckets.get(bkey(cx, cy)) ?? []) {
          if (stamp[i] === tick) continue;
          stamp[i] = tick;
          if (strictHit(ax, ay, bx, by, obstacles[i]!, false)) return true;
        }
      }
    }
    return false;
  };
  const idx = (ix: number, iy: number): number => ix * ny + iy;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));

  const nodeBlocked = (ix: number, iy: number): boolean => {
    const x = xs[ix]!;
    const y = ys[iy]!;
    // Obstacles outside the search window were not loaded, so the window is a hard boundary.
    if (x < win.x0 || x > win.x1 || y < win.y0 || y > win.y1) return true;
    for (const r of own) if (strictHit(x, y, x, y, r, true)) return true;
    return anyObstacleHit(x, y, x, y);
  };
  const segBlocked = (ax: number, ay: number, bx: number, by: number): boolean => {
    for (const r of own) if (strictHit(ax, ay, bx, by, r, true)) return true;
    return anyObstacleHit(ax, ay, bx, by);
  };

  const srcNodes: { id: number; t: number; pen: number; axis: number }[] = [];
  from.forEach((t, k) => {
    const ix = xi.get(t.stub.x)!;
    const iy = yi.get(t.stub.y)!;
    if (!nodeBlocked(ix, iy) && !anyObstacleHit(t.at.x, t.at.y, t.stub.x, t.stub.y))
      srcNodes.push({ id: idx(ix, iy), t: k, pen: t.pen, axis: t.axis });
  });
  const dstNodes = new Map<number, number>();
  const dstInfo = new Map<number, { pen: number; axis: number }>();
  to.forEach((t, k) => {
    const ix = xi.get(t.stub.x)!;
    const iy = yi.get(t.stub.y)!;
    const dn = idx(ix, iy);
    if (!nodeBlocked(ix, iy) && !anyObstacleHit(t.at.x, t.at.y, t.stub.x, t.stub.y)) {
      const cur = dstInfo.get(dn);
      if (!cur || t.pen < cur.pen) {
        dstNodes.set(dn, k);
        dstInfo.set(dn, { pen: t.pen, axis: t.axis });
      }
    }
  });
  if (srcNodes.length === 0 || dstNodes.size === 0) return "no-terminal";

  // State = node * 3 + dir (0 = along x, 1 = along y, 2 = start).
  const total = nx * ny * 3;
  const g = new Float64Array(total).fill(Infinity);
  const prev = new Int32Array(total).fill(-1);
  const srcOf = new Int32Array(nx * ny).fill(-1);
  const heap = new Heap();
  let seq = 0;
  const targets = [...dstNodes.keys()].map((id) => ({
    x: xs[Math.floor(id / ny)]!,
    y: ys[id % ny]!,
  }));
  const h = (node: number): number => {
    const x = xs[Math.floor(node / ny)]!;
    const y = ys[node % ny]!;
    let m = Infinity;
    for (const t of targets) m = Math.min(m, Math.abs(t.x - x) + Math.abs(t.y - y));
    return m;
  };
  for (const s of srcNodes) {
    const st = s.id * 3 + s.axis;
    if (g[st]! > s.pen) {
      g[st] = s.pen;
      srcOf[s.id] = s.t;
      heap.push(s.pen + h(s.id), seq++, st);
    }
  }
  const finalized = new Set<number>();
  let expansions = 0;
  while (heap.size > 0) {
    stats.expansions++;
    if (++expansions > MAX_EXPANSIONS) {
      stats.capHits++;
      return undefined;
    }
    const popped = heap.pop().id;
    const isFinal = popped < 0;
    const st = isFinal ? -popped - 1 : popped;
    const node = Math.floor(st / 3);
    const dir = st % 3;
    const ix = Math.floor(node / ny);
    const iy = node % ny;
    const cur = g[st]!;
    if (dstNodes.has(node) && !isFinal) {
      // Arriving across the target's stub axis costs a bend; finish through a final heap entry.
      if (!finalized.has(st)) {
        finalized.add(st);
        const info = dstInfo.get(node)!;
        heap.push(cur + info.pen + (dir === info.axis ? 0 : BEND), seq++, -st - 1);
      }
    }
    if (isFinal) {
      // Reconstruct.
      const pts: { x: number; y: number }[] = [];
      let s = st;
      while (s !== -1) {
        const n = Math.floor(s / 3);
        pts.push({ x: xs[Math.floor(n / ny)]!, y: ys[n % ny]! });
        s = prev[s]!;
      }
      pts.reverse();
      // Source terminal: walk back to the root state's node.
      let root = st;
      while (prev[root]! !== -1) root = prev[root]!;
      return { pts, src: srcOf[Math.floor(root / 3)]!, dst: dstNodes.get(node)! };
    }
    const moves: [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 1],
      [0, -1, 1],
    ];
    for (const [mx, my, nd] of moves) {
      const jx = ix + mx;
      const jy = iy + my;
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      if (nodeBlocked(jx, jy)) continue;
      if (segBlocked(xs[ix]!, ys[iy]!, xs[jx]!, ys[jy]!)) continue;
      const len = Math.abs(xs[jx]! - xs[ix]!) + Math.abs(ys[jy]! - ys[iy]!);
      const bend = dir === 2 || dir === nd ? 0 : BEND;
      const nst = idx(jx, jy) * 3 + nd;
      const lane =
        ctx.lanes && ctx.source !== undefined
          ? nd === 0
            ? ctx.lanes.overlapCost(true, ys[iy]!, xs[ix]!, xs[jx]!, ctx.source)
            : ctx.lanes.overlapCost(false, xs[ix]!, ys[iy]!, ys[jy]!, ctx.source)
          : 0;
      const ng = cur + len + bend + lane;
      if (ng < g[nst]! - 1e-9) {
        g[nst] = ng;
        prev[nst] = st;
        heap.push(ng + h(idx(jx, jy)), seq++, nst);
      }
    }
  }
  return undefined;
}

/** Routes `from` → `to` around `obstacles` (boxes other than the two endpoints). */
export function routeEdge(
  from: RouteEndpoint,
  to: RouteEndpoint,
  obstacles: readonly Box3[],
  ctx: RouteContext = {},
): RouteResult {
  const fc = {
    x: from.box.origin.x + from.box.size.x / 2,
    y: from.box.origin.y + from.box.size.y / 2,
  };
  const tc = { x: to.box.origin.x + to.box.size.x / 2, y: to.box.origin.y + to.box.size.y / 2 };
  const fromT = terminalsOf(from, ctx.lanes, tc);
  const toT = terminalsOf(to, undefined, fc);
  const own = [rectOf(from.box), rectOf(to.box)];
  const all = obstacles.map((b) => inflate(rectOf(b), CLEAR));
  const minX = Math.min(own[0]!.x0, own[1]!.x0);
  const maxX = Math.max(own[0]!.x1, own[1]!.x1);
  const minY = Math.min(own[0]!.y0, own[1]!.y0);
  const maxY = Math.max(own[0]!.y1, own[1]!.y1);
  for (const margin of [4, 12, Infinity]) {
    const win: Rect = {
      x0: minX - margin,
      y0: minY - margin,
      x1: maxX + margin,
      y1: maxY + margin,
    };
    const ex = typeof ctx.extra === "function" ? ctx.extra(win) : (ctx.extra ?? []);
    const local = [...all, ...ex].filter((r) =>
      strictHit(win.x0, win.y0, win.x1, win.y1, r, false),
    );
    const found = search(fromT, toT, own, local, ctx, win);
    if (found === "no-terminal") break; // wider windows only add obstacles
    if (!found) continue;
    const a = fromT[found.src]!;
    const b = toT[found.dst]!;
    const pts: Vec3[] = [];
    pts.push(a.at);
    if (Math.abs(a.at.z) > 0.01) pts.push({ x: a.at.x, y: a.at.y, z: 0 });
    for (const p of found.pts) pts.push({ x: p.x, y: p.y, z: 0 });
    if (Math.abs(b.at.z) > 0.01) pts.push({ x: b.at.x, y: b.at.y, z: 0 });
    pts.push(b.at);
    const path = simplify(pts);
    if (ctx.lanes && ctx.source !== undefined) ctx.lanes.add(path, ctx.source);
    return { path, blocked: false };
  }
  // Fallback: axis-aligned L through the first terminals (ignores obstacles). Raised ports drop
  // to the ground plane first so every segment stays on one axis.
  const a = fromT[0]!.at;
  const b = toT[0]!.at;
  return {
    path: simplify([
      a,
      { x: a.x, y: a.y, z: 0 },
      { x: b.x, y: a.y, z: 0 },
      { x: b.x, y: b.y, z: 0 },
      b,
    ]),
    blocked: true,
  };
}
