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

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Terminal {
  /** Point on the box boundary (with its own z). */
  at: Vec3;
  /** Outward unit direction on the ground plane. */
  dx: number;
  dy: number;
  stub: { x: number; y: number };
}

const CLEAR = 0.5;
const STUB = 0.5;
const BEND = 2;
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

function terminalsOf(ep: RouteEndpoint): Terminal[] {
  const r = rectOf(ep.box);
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const sides: { at: Vec3; dx: number; dy: number }[] = [
    { at: { x: r.x1, y: cy, z: 0 }, dx: 1, dy: 0 },
    { at: { x: r.x0, y: cy, z: 0 }, dx: -1, dy: 0 },
    { at: { x: cx, y: r.y1, z: 0 }, dx: 0, dy: 1 },
    { at: { x: cx, y: r.y0, z: 0 }, dx: 0, dy: -1 },
  ];
  const list =
    ep.ports && ep.ports.length > 0
      ? ep.ports.map((p) => {
          // Outward side = nearest box side to the port.
          const dists = [
            { d: Math.abs(p.x - r.x1), dx: 1, dy: 0 },
            { d: Math.abs(p.x - r.x0), dx: -1, dy: 0 },
            { d: Math.abs(p.y - r.y1), dx: 0, dy: 1 },
            { d: Math.abs(p.y - r.y0), dx: 0, dy: -1 },
          ];
          let best = dists[0]!;
          for (const d of dists) if (d.d < best.d - 1e-9) best = d;
          return { at: p, dx: best.dx, dy: best.dy };
        })
      : sides;
  return list.map((t) => ({
    ...t,
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
): { pts: { x: number; y: number }[]; src: number; dst: number } | undefined {
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
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;
  const idx = (ix: number, iy: number): number => ix * ny + iy;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));

  const nodeBlocked = (ix: number, iy: number): boolean => {
    const x = xs[ix]!;
    const y = ys[iy]!;
    for (const r of own) if (strictHit(x, y, x, y, r, true)) return true;
    for (const r of obstacles) if (strictHit(x, y, x, y, r, false)) return true;
    return false;
  };
  const segBlocked = (ax: number, ay: number, bx: number, by: number): boolean => {
    for (const r of own) if (strictHit(ax, ay, bx, by, r, true)) return true;
    for (const r of obstacles) if (strictHit(ax, ay, bx, by, r, false)) return true;
    return false;
  };

  const srcNodes: { id: number; t: number }[] = [];
  from.forEach((t, k) => {
    const ix = xi.get(t.stub.x)!;
    const iy = yi.get(t.stub.y)!;
    if (!nodeBlocked(ix, iy)) srcNodes.push({ id: idx(ix, iy), t: k });
  });
  const dstNodes = new Map<number, number>();
  to.forEach((t, k) => {
    const ix = xi.get(t.stub.x)!;
    const iy = yi.get(t.stub.y)!;
    if (!nodeBlocked(ix, iy) && !dstNodes.has(idx(ix, iy))) dstNodes.set(idx(ix, iy), k);
  });
  if (srcNodes.length === 0 || dstNodes.size === 0) return undefined;

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
    const st = s.id * 3 + 2;
    if (g[st]! > 0) {
      g[st] = 0;
      srcOf[s.id] = s.t;
      heap.push(h(s.id), seq++, st);
    }
  }
  while (heap.size > 0) {
    const { id: st } = heap.pop();
    const node = Math.floor(st / 3);
    const dir = st % 3;
    const ix = Math.floor(node / ny);
    const iy = node % ny;
    const cur = g[st]!;
    if (dstNodes.has(node)) {
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
      const ng = cur + len + bend;
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
): RouteResult {
  const fromT = terminalsOf(from);
  const toT = terminalsOf(to);
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
    const local = all.filter((r) => strictHit(win.x0, win.y0, win.x1, win.y1, r, false));
    const found = search(fromT, toT, own, local);
    if (!found) continue;
    const a = fromT[found.src]!;
    const b = toT[found.dst]!;
    const pts: Vec3[] = [];
    pts.push(a.at);
    if (Math.abs(a.at.z) > 0.01) pts.push({ x: a.at.x, y: a.at.y, z: 0 });
    for (const p of found.pts) pts.push({ x: p.x, y: p.y, z: 0 });
    if (Math.abs(b.at.z) > 0.01) pts.push({ x: b.at.x, y: b.at.y, z: 0 });
    pts.push(b.at);
    return { path: simplify(pts), blocked: false };
  }
  // Fallback: direct L through the facing sides (ignores obstacles).
  const a = fromT[0]!.at;
  const b = toT[0]!.at;
  return {
    path: simplify([a, { x: b.x, y: a.y, z: 0 }, b]),
    blocked: true,
  };
}
