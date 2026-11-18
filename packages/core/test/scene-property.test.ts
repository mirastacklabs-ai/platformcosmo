import { describe, expect, test } from "vitest";
import { buildScene, validate } from "../src/index.js";
import type { SceneObject } from "../src/index.js";

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

const hitsBox = (path: SceneObject["box"]["origin"][], o: SceneObject): boolean => {
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i]!;
    const q = path[i + 1]!;
    if (
      Math.max(p.x, q.x) > o.box.origin.x &&
      Math.min(p.x, q.x) < o.box.origin.x + o.box.size.x &&
      Math.max(p.y, q.y) > o.box.origin.y &&
      Math.min(p.y, q.y) < o.box.origin.y + o.box.size.y
    )
      return true;
  }
  return false;
};

describe("buildScene property tests", () => {
  test("random graphs: no overlapping objects, orthogonal edges that avoid other objects", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed);
      const n = 2 + Math.floor(rand() * 14);
      const nodes = Array.from({ length: n }, (_, i) => ({
        id: `n${i}`,
        type: "server",
        size: (["sm", "md", "lg"] as const)[Math.floor(rand() * 3)],
        ...(i % 5 === 1 ? { group: "g0" } : {}),
      }));
      const edges = Array.from({ length: Math.floor(rand() * n * 1.5) }, () => ({
        from: `n${Math.floor(rand() * n)}`,
        to: `n${Math.floor(rand() * n)}`,
      })).filter((e) => e.from !== e.to);
      const r = validate({ meta: { version: "1" }, groups: [{ id: "g0" }], nodes, edges });
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const g = buildScene(r.spec!, {});
      expect(g.diagnostics.filter((d) => d.code === "layout/overlap")).toEqual([]);
      const blocked = new Set(
        g.diagnostics.filter((d) => d.code === "routing/blocked").map((d) => d.path),
      );
      g.edges.forEach((e, i) => {
        for (let k = 0; k + 1 < e.path.length; k++) {
          const p = e.path[k]!;
          const q = e.path[k + 1]!;
          expect([p.x !== q.x, p.y !== q.y, p.z !== q.z].filter(Boolean).length).toBe(1);
        }
        if (blocked.has(`/edges/${i}`)) return;
        for (const o of g.objects) {
          if (o.id === e.from || o.id === e.to) continue;
          expect(hitsBox(e.path, o), `${e.id} through ${o.id} (seed ${seed})`).toBe(false);
        }
      });
    }
  });
});
