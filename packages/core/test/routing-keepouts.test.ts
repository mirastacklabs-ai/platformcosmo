import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { SceneGraph, Vec3 } from "../src/index.js";
import { buildScene, validate } from "../src/index.js";
import { labelRects, shadowRects } from "../src/routing/obstacles.js";

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

interface R {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const segHits = (path: readonly Vec3[], r: R): boolean => {
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i]!;
    const q = path[i + 1]!;
    if (p.z !== 0 || q.z !== 0) continue;
    if (
      Math.max(p.x, q.x) > r.x0 + 1e-6 &&
      Math.min(p.x, q.x) < r.x1 - 1e-6 &&
      Math.max(p.y, q.y) > r.y0 + 1e-6 &&
      Math.min(p.y, q.y) < r.y1 - 1e-6
    )
      return true;
  }
  return false;
};

/** Every non-blocked route avoids non-endpoint footprints, their shadows and every label keep-out. */
function violations(g: SceneGraph): string[] {
  const out: string[] = [];
  const blocked = new Set(
    g.diagnostics.filter((d) => d.code === "routing/blocked").map((d) => d.path),
  );
  g.edges.forEach((e, i) => {
    if (e.kind !== "edge" || e.path.length < 2) return;
    if (blocked.has(`/edges/${i}`)) return;
    for (const o of g.objects) {
      if (o.id.includes("/")) continue;
      const own = o.id === e.from || o.id === e.to;
      const rects: { what: string; r: R }[] = [];
      if (!own) {
        rects.push({
          what: "footprint",
          r: {
            x0: o.box.origin.x,
            y0: o.box.origin.y,
            x1: o.box.origin.x + o.box.size.x,
            y1: o.box.origin.y + o.box.size.y,
          },
        });
        for (const r of shadowRects(o.box, 0)) rects.push({ what: "shadow", r });
      }
      if (o.label) for (const r of labelRects(o.label, o.box)) rects.push({ what: "label", r });
      for (const { what, r } of rects) {
        if (segHits(e.path, r)) out.push(`${e.id} crosses ${what} of ${o.id}`);
      }
    }
  });
  return out;
}

describe("routes keep clear of objects, occlusion shadows and labels", () => {
  const dir = "examples";
  for (const f of readdirSync(dir).filter(
    (n) => n.endsWith(".cosmo.json") && !n.startsWith("zz-"),
  )) {
    test(f, () => {
      const raw = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as Record<string, unknown>;
      if (raw.racks || raw.equipment) return; // DC examples need the DC pack
      const r = validate(raw);
      if (!r.spec) return;
      const g = buildScene(r.spec, {});
      expect(g.diagnostics.filter((d) => d.code === "routing/blocked")).toEqual([]);
      expect(violations(g)).toEqual([]);
    });
  }

  test("property: random layered graphs", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const n = 3 + Math.floor(rand() * 12);
      const nodes = Array.from({ length: n }, (_, i) => ({
        id: `n${i}`,
        type: "server",
        label: `Node number ${i}`,
        size: (["sm", "md", "lg"] as const)[Math.floor(rand() * 3)],
      }));
      const edges: { from: string; to: string }[] = [];
      for (let i = 1; i < n; i++) {
        edges.push({ from: `n${Math.floor(rand() * i)}`, to: `n${i}` });
        if (rand() < 0.4) edges.push({ from: `n${Math.floor(rand() * i)}`, to: `n${i}` });
      }
      const r = validate({ meta: { version: "1" }, nodes, edges });
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const g = buildScene(r.spec!, {});
      const v = violations(g);
      expect(v, `seed ${seed}`).toEqual([]);
    }
  });
});
