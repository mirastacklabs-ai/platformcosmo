import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { DcPack, DcSceneFragment, SceneGraph, SceneObject, Vec3 } from "../src/index.js";
import { buildScene, validate } from "../src/index.js";
import { isRoutingFurniture, labelRects, shadowRects } from "../src/routing/obstacles.js";

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

const blockedEdges = (g: SceneGraph): number =>
  g.diagnostics.filter((d) => d.code === "routing/blocked").length;

const hiddenSide = (g: SceneGraph): number =>
  g.diagnostics.filter((d) => d.code === "routing/hidden-side").length;

/** Every non-blocked route avoids non-endpoint footprints, their shadows and every label keep-out. */
function violations(g: SceneGraph): string[] {
  const out: string[] = [];
  const blocked = new Set(
    g.diagnostics.filter((d) => d.code === "routing/blocked").map((d) => d.path),
  );
  g.edges.forEach((e, i) => {
    if (e.kind !== "edge" || e.path.length < 2) return;
    if (blocked.has(`/edges/${i}`)) return;
    const skip = new Set<string>([e.from, e.to]);
    for (const end of [e.from, e.to]) {
      const slash = end.indexOf("/");
      if (slash > 0) skip.add(end.slice(0, slash));
    }
    for (const id of [...skip]) skip.add(`${id}_front`);
    for (const o of g.objects) {
      if (o.id.includes("/") || (o.source === "dc" && isRoutingFurniture(o))) continue;
      const own = skip.has(o.id);
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
        for (const r of shadowRects(o.box)) rects.push({ what: "shadow", r });
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
  const dir = fileURLToPath(new URL("../../../examples/", import.meta.url));
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".cosmo.json"))) {
    test(f, () => {
      const raw = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as Record<string, unknown>;
      if (raw.racks || raw.equipment) return; // DC examples need the DC pack
      const r = validate(raw);
      if (!r.spec) return;
      const g = buildScene(r.spec, {});
      expect(blockedEdges(g)).toBe(0);
      expect(hiddenSide(g)).toBe(0);
      expect(violations(g)).toEqual([]);
    });
  }

  test("property: random layered graphs have no blocked routes and no violations", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const n = 3 + Math.floor(rand() * 12);
      const nodes = Array.from({ length: n }, (_, i) => ({
        id: `n${i}`,
        type: "server",
        label: `Node number ${i}`,
        size: (["md", "md", "lg"] as const)[Math.floor(rand() * 3)],
      }));
      const edges: { from: string; to: string }[] = [];
      for (let i = 1; i < n; i++) {
        edges.push({ from: `n${Math.floor(rand() * i)}`, to: `n${i}` });
        if (rand() < 0.4) edges.push({ from: `n${Math.floor(rand() * i)}`, to: `n${i}` });
      }
      const r = validate({ meta: { version: "1" }, nodes, edges });
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const g = buildScene(r.spec!, {});
      expect(blockedEdges(g), `seed ${seed}`).toBe(0);
      expect(hiddenSide(g), `seed ${seed}`).toBe(0);
      expect(violations(g), `seed ${seed}`).toEqual([]);
    }
  });

  test("stress: 90 nodes with skip edges stay fast, mostly unblocked and violation-free", () => {
    const rand = rng(7);
    const n = 90;
    const nodes = Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      type: "server",
      label: `Service ${i}`,
    }));
    const edges: { from: string; to: string }[] = [];
    for (let i = 1; i < n; i++) {
      edges.push({ from: `n${Math.max(0, i - 1 - Math.floor(rand() * 3))}`, to: `n${i}` });
      if (i > 4 && rand() < 0.5)
        edges.push({ from: `n${i - 2 - Math.floor(rand() * 3)}`, to: `n${i}` });
    }
    const r = validate({ meta: { version: "1" }, nodes, edges });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const t0 = Date.now();
    const g = buildScene(r.spec!, {});
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(blockedEdges(g)).toBeLessThanOrEqual(Math.ceil(edges.length * 0.1));
    expect(violations(g)).toEqual([]);
  });
});

describe("DC-shaped fixture: furniture is not an obstacle", () => {
  const box = (x: number, y: number, z: number, w: number, d: number, h: number) => ({
    origin: { x, y, z },
    size: { x: w, y: d, z: h },
  });
  const dcObj = (
    id: string,
    type: string,
    b: SceneObject["box"],
    extra: Partial<SceneObject> = {},
  ): SceneObject => ({
    id,
    source: "dc",
    type,
    category: "dc",
    primitive: type === "rack" ? "cube" : "slab",
    box: b,
    state: "healthy",
    ...extra,
  });
  const rackBox = box(0, 0, 0, 1, 2, 3);
  const frag: DcSceneFragment = {
    objects: [
      dcObj("r1", "rack", rackBox, { label: "Rack 1", ports: { "net-0": { x: 1, y: 1, z: 1.5 } } }),
      dcObj("r1_front", "rack-front", rackBox),
      dcObj("r1/srv", "server-1u", box(0, 0, 1, 1, 2, 0.1)),
      dcObj("dc_tray_row", "cable-tray", box(-1, -1, 3.2, 4, 0.5, 0.2)),
      dcObj("dc_tiles_cold", "perforated-tiles", box(1, 0, 0, 2, 2, 0.01)),
      dcObj("dc_floor_grid", "floor-grid", box(-1, -1, -0.1, 6, 6, 0.1)),
    ],
    groups: [],
    edges: [],
    flows: [],
    focusTargets: {},
    bounds: box(-1, -1, -0.1, 6, 6, 3.4),
    diagnostics: [],
  };
  const dc: DcPack = {
    registry: { get: () => undefined, list: () => [] },
    buildScene: () => frag,
  };

  test("node to rack and node to slot edges route without blocked or violations", () => {
    const r = validate({
      meta: { version: "1" },
      nodes: [
        { id: "n1", type: "server", label: "Node 1" },
        { id: "n2", type: "server", label: "Node 2" },
      ],
      racks: [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-1u" }] }],
      edges: [
        { from: "n1", to: "r1" },
        { from: "n2", to: "r1/srv" },
        { from: "n1", to: "n2" },
      ],
    });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const g = buildScene(r.spec!, { dc });
    expect(blockedEdges(g)).toBe(0);
    expect(violations(g)).toEqual([]);
    expect(g.diagnostics.filter((d) => d.code === "layout/overlap")).toEqual([]);
  });
});
