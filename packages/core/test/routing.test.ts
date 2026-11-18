import { describe, expect, test } from "vitest";
import type { Box3, Vec3 } from "../src/index.js";
import { routeEdge } from "../src/routing/router.js";

const box = (x: number, y: number, w = 2, d = 2, h = 1): Box3 => ({
  origin: { x, y, z: 0 },
  size: { x: w, y: d, z: h },
});

function crosses(path: readonly Vec3[], b: Box3): boolean {
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i]!;
    const q = path[i + 1]!;
    const x0 = Math.min(p.x, q.x);
    const x1 = Math.max(p.x, q.x);
    const y0 = Math.min(p.y, q.y);
    const y1 = Math.max(p.y, q.y);
    if (
      x1 > b.origin.x &&
      x0 < b.origin.x + b.size.x &&
      y1 > b.origin.y &&
      y0 < b.origin.y + b.size.y
    )
      return true;
  }
  return false;
}

function orthogonal(path: readonly Vec3[]): boolean {
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i]!;
    const q = path[i + 1]!;
    const changed = [p.x !== q.x, p.y !== q.y, p.z !== q.z].filter(Boolean).length;
    if (changed !== 1) return false;
  }
  return true;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("routeEdge", () => {
  test("aligned boxes get a straight line", () => {
    const r = routeEdge({ box: box(0, 0) }, { box: box(6, 0) }, []);
    expect(r.blocked).toBe(false);
    expect(r.path).toEqual([
      { x: 2, y: 1, z: 0 },
      { x: 6, y: 1, z: 0 },
    ]);
  });

  test("goes around an obstacle in between", () => {
    const obstacle = box(3, -1, 2, 4);
    const r = routeEdge({ box: box(0, 0) }, { box: box(8, 0) }, [obstacle]);
    expect(r.blocked).toBe(false);
    expect(orthogonal(r.path)).toBe(true);
    expect(crosses(r.path, obstacle)).toBe(false);
    const on = (p: Vec3, b: Box3): boolean =>
      p.x >= b.origin.x &&
      p.x <= b.origin.x + b.size.x &&
      p.y >= b.origin.y &&
      p.y <= b.origin.y + b.size.y;
    expect(on(r.path[0]!, box(0, 0))).toBe(true);
    expect(on(r.path[r.path.length - 1]!, box(8, 0))).toBe(true);
  });

  test("never passes through its own boxes", () => {
    const a = box(0, 0);
    const b = box(0, 6);
    const r = routeEdge({ box: a }, { box: b }, []);
    expect(crosses(r.path, a)).toBe(false);
    expect(crosses(r.path, b)).toBe(false);
  });

  test("walled-in target falls back and reports blocked", () => {
    const target = box(10, 10);
    const walls = [
      box(9.1, 9.1, 0.5, 3.8),
      box(12.4, 9.1, 0.5, 3.8),
      box(9.1, 9.1, 3.8, 0.5),
      box(9.1, 12.4, 3.8, 0.5),
    ];
    const r = routeEdge({ box: box(0, 0) }, { box: target }, walls);
    expect(r.blocked).toBe(true);
    expect(r.path.length).toBeGreaterThanOrEqual(2);
  });

  test("DC ports above the floor get a vertical stub down to z = 0", () => {
    const rack = box(0, 0, 1, 1, 3);
    const r = routeEdge({ box: rack, ports: [{ x: 1, y: 0.5, z: 1.5 }] }, { box: box(6, 0) }, []);
    expect(r.path[0]).toEqual({ x: 1, y: 0.5, z: 1.5 });
    expect(r.path[1]).toEqual({ x: 1, y: 0.5, z: 0 });
    expect(orthogonal(r.path)).toBe(true);
  });

  test("blocked fallback stays axis-aligned, also for raised ports", () => {
    const target = box(10, 10);
    const walls = [
      box(9.1, 9.1, 0.5, 3.8),
      box(12.4, 9.1, 0.5, 3.8),
      box(9.1, 9.1, 3.8, 0.5),
      box(9.1, 12.4, 3.8, 0.5),
    ];
    const r = routeEdge(
      { box: box(0, 0, 1, 1, 3), ports: [{ x: 1, y: 0.5, z: 1.5 }] },
      { box: target },
      walls,
    );
    expect(r.blocked).toBe(true);
    expect(orthogonal(r.path)).toBe(true);
  });

  test("many obstacles stay fast and orthogonal (caps and bucket index)", () => {
    const obstacles: Box3[] = [];
    for (let i = 0; i < 400; i++)
      obstacles.push(box(3 + (i % 20) * 4, -40 + Math.floor(i / 20) * 4, 2, 2));
    const t0 = Date.now();
    const r = routeEdge({ box: box(0, 0) }, { box: box(90, 5) }, obstacles);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(orthogonal(r.path)).toBe(true);
  });

  test("deterministic", () => {
    const o = [box(3, -1, 2, 4), box(3, 5, 2, 2)];
    const a = JSON.stringify(routeEdge({ box: box(0, 0) }, { box: box(8, 3) }, o));
    expect(a).toBe(JSON.stringify(routeEdge({ box: box(0, 0) }, { box: box(8, 3) }, o)));
  });

  test("property: random obstacle fields give orthogonal, obstacle-free paths", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const obstacles: Box3[] = [];
      for (let i = 0; i < 8; i++) {
        obstacles.push(box(3 + Math.floor(rand() * 12), -4 + Math.floor(rand() * 12), 2, 2));
      }
      const a = box(0, 0);
      const b = box(18, Math.floor(rand() * 4));
      const free = obstacles.filter(
        (o) => !(o.origin.x < 2.6 && o.origin.y < 2.6) && !(o.origin.x + 2 > 17.4),
      );
      const r = routeEdge({ box: a }, { box: b }, free);
      expect(orthogonal(r.path)).toBe(true);
      if (!r.blocked) for (const o of free) expect(crosses(r.path, o)).toBe(false);
    }
  });
});
