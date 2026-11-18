/** Orthogonal edge routing along the iso axes (Track A2). World space, ground plane (z = 0). */
import type { Box3, Vec3 } from "../contracts/index.js";

const r2 = (v: number): number => Math.round(v * 100) / 100;

export function center(b: Box3): Vec3 {
  return {
    x: b.origin.x + b.size.x / 2,
    y: b.origin.y + b.size.y / 2,
    z: b.origin.z + b.size.z / 2,
  };
}

/** Removes duplicate and collinear points; rounds to 2 decimals. */
export function simplify(points: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) {
    const q = { x: r2(p.x), y: r2(p.y), z: r2(p.z) };
    const last = out[out.length - 1];
    if (last && last.x === q.x && last.y === q.y && last.z === q.z) continue;
    out.push(q);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]!;
    const b = out[i]!;
    const c = out[i + 1]!;
    const same =
      (a.x === b.x && b.x === c.x && a.z === b.z && b.z === c.z) ||
      (a.y === b.y && b.y === c.y && a.z === b.z && b.z === c.z);
    if (same) out.splice(i, 1);
  }
  return out;
}

/** Simple Z/straight route between two boxes' facing sides; no obstacle avoidance. */
export function routeSimple(a: Box3, b: Box3): Vec3[] {
  const ac = center(a);
  const bc = center(b);
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx >= 0 ? a.origin.x + a.size.x : a.origin.x;
    const ex = dx >= 0 ? b.origin.x : b.origin.x + b.size.x;
    const mx = (sx + ex) / 2;
    return simplify([
      { x: sx, y: ac.y, z: 0 },
      { x: mx, y: ac.y, z: 0 },
      { x: mx, y: bc.y, z: 0 },
      { x: ex, y: bc.y, z: 0 },
    ]);
  }
  const sy = dy >= 0 ? a.origin.y + a.size.y : a.origin.y;
  const ey = dy >= 0 ? b.origin.y : b.origin.y + b.size.y;
  const my = (sy + ey) / 2;
  return simplify([
    { x: ac.x, y: sy, z: 0 },
    { x: ac.x, y: my, z: 0 },
    { x: bc.x, y: my, z: 0 },
    { x: bc.x, y: ey, z: 0 },
  ]);
}
