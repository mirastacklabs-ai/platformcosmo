import { describe, expect, it } from "vitest";
import { buildScene } from "@platformcosmo/core";
import type { Box3, PartShapeContext, PartShapeDef, PlatformCosmoSpec } from "@platformcosmo/core";
import { dcPack, slotTypes } from "../src/index.js";
import { dcShapePack } from "../src/shapes.js";

const shapes = dcPack.shapes!.shapes;

const ctx = (def: PartShapeDef, over: Partial<PartShapeContext> = {}): PartShapeContext => ({
  size: def.defaultSize,
  units: def.defaultUnits,
  axis: "z",
  tone: "base",
  state: "healthy",
  ...over,
});

const within = (inner: Box3, outer: Box3, eps = 1e-6): boolean =>
  (["x", "y", "z"] as const).every(
    (k) =>
      inner.origin[k] >= outer.origin[k] - eps &&
      inner.origin[k] + inner.size[k] <= outer.origin[k] + outer.size[k] + eps,
  );

describe("dc: part shapes", () => {
  it("the pack is `dc`, Apache-2.0, one shape per rack device in schema order", () => {
    expect(dcPack.shapes).toBe(dcShapePack);
    expect(dcShapePack.id).toBe("dc");
    expect(dcShapePack.license).toBe("Apache-2.0");
    expect(shapes.map((s) => s.id)).toEqual([...slotTypes]);
    for (const s of shapes) {
      expect(s.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.type).toBe(s.id);
      expect(s.defaultUnits).toBe("mm");
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it("default sizes are true scale: 19-inch rack devices at 44.45 mm per U", () => {
    const by = (id: string): PartShapeDef => shapes.find((s) => s.id === id)!;
    expect(by("server-1u").defaultSize.x).toBeCloseTo(540, 2);
    expect(by("server-1u").defaultSize.z).toBeCloseTo(44.45 - 1.5, 1);
    expect(by("server-2u").defaultSize.z).toBeCloseTo(88.9 - 1.5, 1);
    expect(by("server-4u").defaultSize.z).toBeCloseTo(4 * 44.45 - 1.5, 1);
    expect(by("blade-chassis").defaultSize.z).toBeCloseTo(10 * 44.45 - 1.5, 1);
    expect(by("server-2u").defaultSize.y).toBeCloseTo(780, 2);
  });

  for (const def of shapes) {
    describe(def.id, () => {
      const g = def.build(def.readParams({}).params, ctx(def));

      it("builds solid geometry in its own frame, at its default size", () => {
        expect(g.solid).toBe(true);
        expect(g.primitives.length).toBeGreaterThan(2);
        const ids = g.primitives.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z0-9_.-]+$/);
        expect(g.bounds.origin).toEqual({ x: 0, y: 0, z: 0 });
        expect(g.bounds.size.x).toBeCloseTo(def.defaultSize.x, 2);
        expect(g.bounds.size.y).toBeCloseTo(def.defaultSize.y, 2);
        expect(g.bounds.size.z).toBeCloseTo(def.defaultSize.z, 2);
      });

      it("depthBox is inside bounds and every primitive is inside bounds", () => {
        expect(within(g.depthBox, g.bounds)).toBe(true);
        for (const p of g.primitives) expect(within(p.box, g.bounds, 1e-4)).toBe(true);
      });

      it("is deterministic", () => {
        const again = def.build(def.readParams({}).params, ctx(def));
        expect(JSON.stringify(again)).toBe(JSON.stringify(g));
      });
    });
  }

  it("the front is at +y (details sit at the maximum y)", () => {
    for (const def of shapes.filter((s) => s.id.startsWith("server"))) {
      const g = def.build({}, ctx(def));
      const front = g.primitives.find((p) => p.id === "front")!;
      expect(front.box.origin.y + front.box.size.y).toBeCloseTo(g.bounds.size.y, 3);
      const rear = g.primitives.find((p) => p.id === "rear")!;
      expect(rear.box.origin.y).toBeCloseTo(0, 6);
    }
  });

  it("`size` scales the device per axis", () => {
    const def = shapes.find((s) => s.id === "server-2u")!;
    const g = def.build({}, ctx(def, { size: { x: 270, y: 780 * 2, z: def.defaultSize.z } }));
    expect(g.bounds.size.x).toBeCloseTo(270, 2);
    expect(g.bounds.size.y).toBeCloseTo(1560, 2);
    expect(g.bounds.size.z).toBeCloseTo(def.defaultSize.z, 2);
    const chassis = g.primitives.find((p) => p.id === "chassis")!;
    expect(chassis.box.size.x).toBeCloseTo(270, 2);
  });

  it("geometry is returned in the context units (cm, in)", () => {
    const def = shapes.find((s) => s.id === "server-1u")!;
    const cm = def.build({}, ctx(def, { units: "cm", size: { x: 54, y: 75, z: 4.295 } }));
    expect(cm.bounds.size.x).toBeCloseTo(54, 3);
    expect(cm.bounds.size.y).toBeCloseTo(75, 3);
    const inch = def.build(
      {},
      ctx(def, { units: "in", size: { x: 540 / 25.4, y: 750 / 25.4, z: 42.95 / 25.4 } }),
    );
    expect(inch.bounds.size.x).toBeCloseTo(540 / 25.4, 3);
  });

  it("a bad size (NaN, 0, negative, huge) falls back to the default or is clamped", () => {
    const def = shapes.find((s) => s.id === "switch-tor")!;
    const g = def.build({}, ctx(def, { size: { x: Number.NaN, y: -5, z: 0 } }));
    expect(g.bounds.size.x).toBeCloseTo(def.defaultSize.x, 2);
    expect(g.bounds.size.y).toBeCloseTo(def.defaultSize.y, 2);
    expect(g.bounds.size.z).toBeCloseTo(def.defaultSize.z, 2);
    const huge = def.build({}, ctx(def, { size: { x: 1e12, y: 1, z: 1 } }));
    expect(huge.bounds.size.x).toBeLessThanOrEqual(100_000 + 1);
  });

  it("params: none are accepted, each unknown key is a shape-params error (capped)", () => {
    const def = shapes[0]!;
    expect(def.readParams({})).toEqual({ params: {}, diagnostics: [] });
    const r = def.readParams({ heightU: 4 });
    expect(r.diagnostics).toMatchObject([
      { severity: "error", code: "assembly/shape-params", path: "/params/heightU" },
    ]);
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const m = def.readParams(many);
    expect(m.diagnostics).toHaveLength(21);
    expect(m.diagnostics[20]!.message).toContain("30 more");
    const slash = def.readParams({ "a/b~c": 1 });
    expect(slash.diagnostics[0]!.path).toBe("/params/a~1b~0c");
  });

  it("works inside any assembly: a server part next to a plate, drawn at true scale", () => {
    const s = {
      meta: { version: "1" },
      assemblies: [
        {
          id: "bench",
          units: "mm",
          parts: [
            { id: "table", shape: "plate", at: [0, 0, 0], size: [1000, 1000, 20] },
            { id: "srv", shape: "dc:server-2u", at: [100, 100, 20], label: "Server" },
            { id: "tor", shape: "dc:switch-tor", at: [100, 100, 120], size: [270, 225, 22] },
          ],
        },
      ],
    } as unknown as PlatformCosmoSpec;
    const g = buildScene(s, { dc: dcPack });
    expect(g.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const a = g.assemblies!.assemblies[0]!;
    const srv = a.root.children.find((c) => c.id === "srv")!;
    expect(srv.type).toBe("server-2u");
    expect(srv.role).toBe("body");
    expect(srv.geometry!.primitives.length).toBeGreaterThan(5);
    expect(srv.local.size.x).toBeCloseTo(540, 2);
    expect(srv.local.size.y).toBeCloseTo(780, 2);
    const tor = a.root.children.find((c) => c.id === "tor")!;
    expect(tor.local.size.x).toBeCloseTo(270, 2);
    expect(tor.geometry!.bounds.size.x).toBeCloseTo(270, 2);
  });
});
