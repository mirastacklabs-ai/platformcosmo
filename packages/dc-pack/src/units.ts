/** Unit helpers (PLAN §9): 1 world unit = one 600 mm floor tile; 1U = 44.45 mm. */
import type { Box3, Vec3 } from "@platformcosmo/core";

export const MM_PER_TILE = 600;
export const U_MM = 44.45;

/** Rounds to 4 decimals to keep world coordinates free of float noise. */
export const r4 = (n: number): number => Math.round(n * 10000) / 10000;

/** Millimetres to world units. */
export const mm = (n: number): number => r4(n / MM_PER_TILE);

/** Rack units to world units. */
export const uToWorld = (u: number): number => r4((u * U_MM) / MM_PER_TILE);

export const vec = (x: number, y: number, z: number): Vec3 => ({ x: r4(x), y: r4(y), z: r4(z) });

export const box = (
  ox: number,
  oy: number,
  oz: number,
  sx: number,
  sy: number,
  sz: number,
): Box3 => ({
  origin: vec(ox, oy, oz),
  size: vec(sx, sy, sz),
});

/** Smallest box containing both. */
export function unionBox(a: Box3, b: Box3): Box3 {
  const x0 = Math.min(a.origin.x, b.origin.x);
  const y0 = Math.min(a.origin.y, b.origin.y);
  const z0 = Math.min(a.origin.z, b.origin.z);
  const x1 = Math.max(a.origin.x + a.size.x, b.origin.x + b.size.x);
  const y1 = Math.max(a.origin.y + a.size.y, b.origin.y + b.size.y);
  const z1 = Math.max(a.origin.z + a.size.z, b.origin.z + b.size.z);
  return box(x0, y0, z0, x1 - x0, y1 - y0, z1 - z0);
}
