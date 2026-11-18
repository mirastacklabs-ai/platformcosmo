import { describe, expect, it } from "vitest";
import type {
  Box3,
  DcSceneFragment,
  PlatformCosmoSpec,
  SceneEdge,
  Vec3,
} from "@platformcosmo/core";
import schema from "../../../schema/v1.json" with { type: "json" };
import { DC_DEFAULTS } from "../src/defaults.js";
import { dcPack } from "../src/index.js";
import { compareBoxes, createProjection, depthOrder } from "@platformcosmo/core";
import { specFlowCost } from "../src/scene.js";

const EPS = 1e-3;

const unionOf = (bs: Box3[]): Box3 => {
  const lo = (k: "x" | "y" | "z"): number => Math.min(...bs.map((b) => b.origin[k]));
  const hi = (k: "x" | "y" | "z"): number => Math.max(...bs.map((b) => b.origin[k] + b.size[k]));
  const r = (n: number): number => Math.round(n * 10000) / 10000;
  return {
    origin: { x: r(lo("x")), y: r(lo("y")), z: r(lo("z")) },
    size: { x: r(hi("x") - lo("x")), y: r(hi("y") - lo("y")), z: r(hi("z") - lo("z")) },
  };
};

function spec(extra: Record<string, unknown>): PlatformCosmoSpec {
  return { meta: { version: "1" }, ...extra } as unknown as PlatformCosmoSpec;
}

const server = (at: number, id?: string): Record<string, unknown> => ({
  ...(id ? { id } : {}),
  at,
  type: "server-1u",
});

/** Two facing rows around a cold aisle, a hot aisle behind row b, plus floor equipment. */
const hall = (): PlatformCosmoSpec =>
  spec({
    racks: [
      { id: "a1", slots: [{ at: 1, type: "switch-tor", id: "tor" }, server(2), server(3, "s3")] },
      { id: "a2", u: 45, pdu: "dual", slots: [server(1), { at: 5, type: "storage-flash" }] },
      {
        id: "b1",
        u: 48,
        rearDoorHeatExchanger: true,
        slots: [server(1), { at: 10, type: "gpu-node" }],
      },
      { id: "b2", slots: [{ at: 1, type: "switch-spine" }] },
    ],
    equipment: [
      { id: "ups1", type: "ups" },
      { id: "pdu1", type: "pdu-floor" },
      { id: "crah1", type: "crah" },
    ],
    rows: [
      { id: "row-a", label: "Row A", members: ["a1", "a2"] },
      { id: "row-b", members: ["b1", "b2"] },
    ],
    aisles: [
      { id: "cold-1", kind: "cold", rows: ["row-a", "row-b"], contained: true },
      { id: "hot-1", kind: "hot", rows: ["row-b"] },
    ],
    cables: [
      { from: "a1/tor", to: "b2/u1", kind: "fiber" },
      { from: "a1/u2", to: "a1/tor", kind: "network", label: "uplink" },
      { from: "ups1", to: "pdu1", kind: "power", id: "feed" },
      { from: "pdu1", to: "a1", kind: "power" },
      { from: "a1/u2", to: "a1/tor", kind: "management" },
    ],
    facility: { raisedFloor: true, perforatedTiles: true, cableTrays: "overhead" },
  });

const build = (s: PlatformCosmoSpec): DcSceneFragment => dcPack.buildScene(s);
const codes = (f: DcSceneFragment): string[] => f.diagnostics.map((d) => d.code);

const inside = (inner: Box3, outer: Box3, eps = EPS): boolean =>
  (["x", "y", "z"] as const).every(
    (k) =>
      inner.origin[k] >= outer.origin[k] - eps &&
      inner.origin[k] + inner.size[k] <= outer.origin[k] + outer.size[k] + eps,
  );

describe("buildScene: basics", () => {
  it("returns an empty fragment when the spec has no DC content", () => {
    const f = build(spec({ nodes: [{ id: "n", type: "server" }] }));
    expect(f.objects).toEqual([]);
    expect(f.groups).toEqual([]);
    expect(f.edges).toEqual([]);
    expect(f.flows).toEqual([]);
    expect(f.focusTargets).toEqual({});
    expect(f.diagnostics).toEqual([]);
  });

  it("is deterministic (byte-identical JSON)", () => {
    expect(JSON.stringify(build(hall()))).toBe(JSON.stringify(build(hall())));
  });

  it("starts at the world origin with no negative coordinates", () => {
    const f = build(hall());
    expect(f.bounds.origin).toEqual({ x: 0, y: 0, z: 0 });
    for (const o of f.objects) {
      expect(o.box.origin.x).toBeGreaterThanOrEqual(-EPS);
      expect(o.box.origin.y).toBeGreaterThanOrEqual(-EPS);
      expect(o.box.origin.z).toBeGreaterThanOrEqual(-EPS);
      expect(inside(o.box, f.bounds)).toBe(true);
    }
    for (const g of f.groups) expect(inside(g.box, f.bounds)).toBe(true);
  });

  it("places on the 600 mm grid: rack footprints are whole tiles", () => {
    const f = build(hall());
    for (const id of ["a1", "a2", "b1", "b2"]) {
      const o = f.objects.find((x) => x.id === id)!;
      expect(o.box.size.x).toBeCloseTo(1, 3);
      expect(o.box.size.y).toBeCloseTo(2, 3);
      expect(o.box.origin.x % 1).toBeCloseTo(0, 3);
      expect(o.box.origin.y % 1).toBeCloseTo(0, 3);
    }
  });
});

describe("buildScene: objects", () => {
  const f = build(hall());

  it("emits racks, equipment and one object per occupied slot, sorted by id", () => {
    const ids = f.objects.map((o) => o.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "a1",
      "a1/tor",
      "a1/u2",
      "a1/s3",
      "a2/u1",
      "a2/u5",
      "b1/u10",
      "ups1",
      "crah1",
      "pdu1",
    ]) {
      expect(ids).toContain(id);
    }
    const rack = f.objects.find((o) => o.id === "a1")!;
    expect(rack).toMatchObject({
      source: "dc",
      type: "rack",
      category: "dc",
      state: "healthy",
      group: "row-a",
    });
    const slot = f.objects.find((o) => o.id === "a1/s3")!;
    expect(slot).toMatchObject({ source: "dc", type: "server-1u", group: "row-a" });
  });

  it("uses default slot id u<at>", () => {
    expect(f.objects.some((o) => o.id === "a1/u2")).toBe(true);
  });

  it("rack heights follow 42/45/48U", () => {
    const h = (id: string): number => f.objects.find((o) => o.id === id)!.box.size.z;
    expect(h("a2")).toBeGreaterThan(h("a1"));
    expect(h("b1")).toBeGreaterThan(h("a2"));
  });

  it("parts and ports are world space and inside the object box; part ids unique", () => {
    for (const o of f.objects) {
      const ids = (o.parts ?? []).map((p) => p.id);
      expect(new Set(ids).size, o.id).toBe(ids.length);
      for (const p of o.parts ?? []) expect(inside(p.box, o.box), `${o.id}/${p.id}`).toBe(true);
      for (const [name, v] of Object.entries(o.ports ?? {})) {
        expect(v.x).toBeGreaterThanOrEqual(o.box.origin.x - EPS);
        expect(v.x).toBeLessThanOrEqual(o.box.origin.x + o.box.size.x + EPS);
        expect(v.y).toBeGreaterThanOrEqual(o.box.origin.y - EPS);
        expect(v.y).toBeLessThanOrEqual(o.box.origin.y + o.box.size.y + EPS);
        expect(Number.isFinite(v.z), `${o.id}.${name}`).toBe(true);
      }
    }
  });

  it("slot devices sit inside their rack", () => {
    for (const o of f.objects.filter((x) => x.id.includes("/"))) {
      const rack = f.objects.find((r) => r.id === o.id.split("/")[0])!;
      expect(inside(o.box, rack.box), o.id).toBe(true);
    }
  });

  it("slot devices keep their U order and spacing", () => {
    const z = (id: string): number => f.objects.find((o) => o.id === id)!.box.origin.z;
    expect(z("a1/u2")).toBeGreaterThan(z("a1/tor"));
    expect(z("a1/s3")).toBeGreaterThan(z("a1/u2"));
    expect(z("a1/u2") - z("a1/tor")).toBeCloseTo(44.45 / 600, 3);
  });

  it("slot size overrides the component height", () => {
    const g = build(
      spec({
        racks: [
          {
            id: "r",
            slots: [
              { at: 1, size: 3, type: "server-1u" },
              { at: 4, type: "server-1u" },
            ],
          },
        ],
      }),
    );
    const a = g.objects.find((o) => o.id === "r/u1")!;
    const b = g.objects.find((o) => o.id === "r/u4")!;
    expect(a.box.size.z).toBeGreaterThan(b.box.size.z * 2.5);
    expect(g.diagnostics).toEqual([]);
  });
});

describe("buildScene: hall, rows, aisles", () => {
  const f = build(hall());
  const g = (id: string) => f.groups.find((x) => x.id === id)!;

  it("emits the hall, rows and aisles with the right kinds and order", () => {
    expect(g("dc_hall")).toMatchObject({ kind: "hall", level: 0 });
    expect(g("row-a")).toMatchObject({ kind: "row", parent: "dc_hall", label: "Row A", level: 1 });
    expect(g("cold-1")).toMatchObject({ kind: "cold-aisle", contained: true });
    expect(g("hot-1")).toMatchObject({ kind: "hot-aisle", contained: false });
    const keys = f.groups.map((x) => `${x.level}:${x.id}`);
    expect(keys).toEqual([...keys].sort((a, b) => (a < b ? -1 : 1)));
  });

  it("hall contains rows and aisles", () => {
    const h = g("dc_hall").box;
    for (const id of ["row-a", "row-b", "cold-1", "hot-1"]) {
      const b = g(id).box;
      expect(b.origin.x).toBeGreaterThanOrEqual(h.origin.x);
      expect(b.origin.y).toBeGreaterThanOrEqual(h.origin.y);
      expect(b.origin.x + b.size.x).toBeLessThanOrEqual(h.origin.x + h.size.x + EPS);
      expect(b.origin.y + b.size.y).toBeLessThanOrEqual(h.origin.y + h.size.y + EPS);
    }
  });

  it("the cold aisle lies between the two rows and rows face it", () => {
    const a = g("row-a").box;
    const b = g("row-b").box;
    const c = g("cold-1").box;
    expect(c.origin.y).toBeCloseTo(a.origin.y + a.size.y, 3);
    expect(c.origin.y + c.size.y).toBeCloseTo(b.origin.y, 3);
    expect(c.size.y).toBeCloseTo(2, 3);
    // Row A faces +y (cold aisle): device centres lie toward +y within the rack; row B toward -y.
    const cy = (id: string): number => {
      const o = f.objects.find((x) => x.id === id)!;
      return o.box.origin.y + o.box.size.y / 2;
    };
    expect(cy("a1/u2")).toBeGreaterThan(cy("a1"));
    expect(cy("b2/u1")).toBeLessThan(cy("b2"));
  });

  it("the hot aisle sits behind row B", () => {
    const b = g("row-b").box;
    const h = g("hot-1").box;
    expect(h.origin.y).toBeCloseTo(b.origin.y + b.size.y, 3); // backs of the mirrored row face +y
    expect(h.size.y).toBeCloseTo(2, 3);
  });

  it("explicit facing wins over the aisle default", () => {
    const s = spec({
      racks: [
        { id: "x", slots: [server(1)] },
        { id: "y", slots: [server(1)] },
      ],
      rows: [
        { id: "r1", members: ["x"], facing: "back" },
        { id: "r2", members: ["y"] },
      ],
      aisles: [{ id: "c", kind: "cold", rows: ["r1", "r2"] }],
    });
    const o = build(s).objects;
    const cy = (id: string): number => {
      const q = o.find((x) => x.id === id)!;
      return q.box.origin.y + q.box.size.y / 2;
    };
    expect(cy("x/u1")).toBeLessThan(cy("x")); // r1 kept facing back
    expect(cy("y/u1")).toBeLessThan(cy("y")); // r2 derived: lower row of a cold aisle faces -y
  });

  it("raised floor raises the slab and everything sits on it", () => {
    expect(g("dc_hall").box.size.z).toBeCloseTo(0.3, 3);
    for (const o of f.objects.filter((x) => x.type === "rack"))
      expect(o.box.origin.z).toBeCloseTo(0.3, 3);
    const flat = build(spec({ racks: [{ id: "r" }], facility: { raisedFloor: false } }));
    expect(flat.groups[0]!.box.size.z).toBeLessThan(0.1);
  });

  it("perforated tiles fill the cold aisle with vent slits; containment adds a roof", () => {
    const floor = f.objects.filter((o) => o.type === "perforated-tiles");
    expect(floor.map((o) => o.id)).toEqual(["dc_tiles_cold-1"]);
    const c = g("cold-1").box;
    const tiles = floor[0]!.parts!.filter((p) => p.id.startsWith("tile-"));
    const vents = floor[0]!.parts!.filter((p) => p.id.startsWith("vent-"));
    expect(tiles.length).toBe(Math.round(c.size.x) * Math.round(c.size.y));
    expect(vents.length).toBe(tiles.length * 3);
    for (const t of tiles) expect(t.tone).toBe("perforated");
    for (const v of vents) expect(v.tone).toBe("base");
    const roof = f.objects.find((o) => o.id === "dc_roof_cold-1")!;
    expect(roof.type).toBe("containment");
    expect(roof.box.origin.z).toBeGreaterThan(1);
  });

  it("overhead trays share one height above the racks (never on equipment tops)", () => {
    const trays = f.objects.filter((o) => o.type === "cable-tray");
    // only over rows and on the way to cabled equipment (ups1, pdu1); never a loop over the floor
    expect(trays.map((t) => t.id).sort()).toEqual([
      "dc_tray_pdu1",
      "dc_tray_row-a",
      "dc_tray_row-b",
      "dc_tray_spine",
      "dc_tray_ups1",
    ]);
    const racks = f.objects.filter((o) => o.type === "rack");
    const rackTop = Math.max(...racks.map((o) => o.box.origin.z + o.box.size.z));
    for (const t of trays) {
      expect(t.box.origin.z).toBeGreaterThan(rackTop);
      expect(t.box.origin.z).toBeCloseTo(trays[0]!.box.origin.z, 3);
    }
  });

  it("loose items form a strip behind the first row (on the far -y side)", () => {
    const ups = f.objects.find((o) => o.id === "ups1")!;
    const rowsMinY = Math.min(g("row-a").box.origin.y, g("row-b").box.origin.y);
    expect(ups.box.origin.y + ups.box.size.y).toBeLessThanOrEqual(rowsMinY - 3 + EPS);
    expect(ups.group).toBe("dc_hall");
  });

  it("racks with no rows go in one implicit row without row groups", () => {
    const s = build(spec({ racks: [{ id: "p" }, { id: "q" }, { id: "r" }] }));
    expect(s.groups.map((x) => x.id)).toEqual(["dc_hall"]);
    const xs = s.objects.filter((o) => o.type === "rack").map((o) => o.box.origin.x);
    expect(xs[1]! - xs[0]!).toBeCloseTo(1, 3);
    expect(xs[2]! - xs[1]!).toBeCloseTo(1, 3);
  });

  it("honours manual pos and warns about overlaps", () => {
    const s = build(
      spec({
        racks: [
          { id: "m1", pos: { x: 5, y: 4 } },
          { id: "m2", pos: { x: 5, y: 5 } },
        ],
      }),
    );
    const m1 = s.objects.find((o) => o.id === "m1")!;
    const m2 = s.objects.find((o) => o.id === "m2")!;
    expect(m2.box.origin.x - m1.box.origin.x).toBeCloseTo(0, 3);
    expect(m2.box.origin.y - m1.box.origin.y).toBeCloseTo(1, 3);
    expect(codes(s)).toContain("dc/footprint-overlap");
  });
});

describe("buildScene: cables", () => {
  const f = build(hall());
  const cables = f.edges.filter((e) => e.kind === "cable");

  it("emits one visible cable per valid spec cable, colored by kind, before hidden edges", () => {
    expect(cables.map((c) => c.cableKind)).toEqual([
      "fiber",
      "network",
      "power",
      "power",
      "management",
    ]);
    expect(cables.every((c) => !c.hidden && c.kind === "cable")).toBe(true);
    const firstHidden = f.edges.findIndex((e) => e.hidden);
    expect(f.edges.slice(0, firstHidden).every((e) => e.kind === "cable")).toBe(true);
    expect(cables.find((c) => c.cableKind === "power")!.id).toBe("feed");
    expect(cables[1]!.label).toBe("uplink");
  });

  const orth = (path: readonly Vec3[]): boolean =>
    path.every((p, i) => {
      if (i === 0) return true;
      const q = path[i - 1]!;
      const diff = Number(p.x !== q.x) + Number(p.y !== q.y) + Number(p.z !== q.z);
      return diff === 1;
    });

  it("routes orthogonally with no duplicate points", () => {
    for (const e of f.edges) {
      expect(e.path.length, e.id).toBeGreaterThanOrEqual(2);
      expect(orth(e.path), e.id).toBe(true);
    }
  });

  it("starts and ends on the endpoint ports (world space)", () => {
    const tor = f.objects.find((o) => o.id === "a1/tor")!;
    const fiber = cables[0] as SceneEdge;
    const start = fiber.path[0]!;
    expect(
      Object.values(tor.ports ?? {}).some(
        (p) => p.x === start.x && p.y === start.y && p.z === start.z,
      ),
    ).toBe(true);
  });

  it("reports unknown endpoints and skips self loops", () => {
    const s = build(
      spec({
        racks: [{ id: "r", slots: [server(1)] }],
        cables: [
          { from: "r/u1", to: "nope" },
          { from: "r/u1", to: "r/u1" },
        ],
      }),
    );
    expect(codes(s)).toEqual(["dc/unknown-cable-endpoint", "dc/cable-self-loop"]);
    expect(s.edges.filter((e) => e.kind === "cable")).toEqual([]);
    expect(s.diagnostics.find((d) => d.code === "dc/unknown-cable-endpoint")!.path).toBe(
      "/cables/0/to",
    );
  });

  it("default cable ids are dc_cable_<n>", () => {
    const s = build(
      spec({
        racks: [{ id: "r1" }, { id: "r2" }],
        cables: [{ from: "r1", to: "r2", kind: "network" }],
      }),
    );
    expect(s.edges[0]!.id).toBe("dc_cable_1");
  });
});

describe("buildScene: flows", () => {
  const f = build(hall());

  it("ids are dc_f_<n> in order and reference existing edges", () => {
    expect(f.flows.map((x) => x.id)).toEqual(f.flows.map((_, i) => `dc_f_${i + 1}`));
    const edgeIds = new Set(f.edges.map((e) => e.id));
    for (const fl of f.flows) expect(edgeIds.has(fl.edge)).toBe(true);
  });

  it("airflow runs cold aisle to hot aisle through each rack on hidden edges", () => {
    const air = f.edges.filter((e) => e.id.startsWith("dc_air_"));
    expect(air.map((e) => e.id)).toEqual(["dc_air_a1", "dc_air_a2", "dc_air_b1", "dc_air_b2"]);
    for (const e of air) {
      expect(e.hidden).toBe(true);
      expect(e.kind).toBe("edge");
    }
    expect(air[0]).toMatchObject({ from: "cold-1" });
    expect(air[2]).toMatchObject({ from: "cold-1", to: "hot-1" });
    // The path crosses the rack front to back.
    const a1 = f.objects.find((o) => o.id === "a1")!;
    const p = air[0]!.path;
    expect(p[0]!.y).toBeGreaterThan(a1.box.origin.y + a1.box.size.y);
    expect(p[p.length - 1]!.y).toBeLessThan(a1.box.origin.y);
    expect(f.flows.filter((x) => x.kind === "airflow")).toHaveLength(4);
  });

  it("power flows follow power cables; network flows follow network and fiber cables", () => {
    const power = f.flows.filter((x) => x.kind === "power");
    expect(power.map((x) => x.edge)).toEqual(["feed", "dc_cable_4"]);
    const normal = f.flows.filter((x) => x.kind === "normal");
    expect(normal.map((x) => x.edge)).toEqual(["dc_cable_1", "dc_cable_2"]);
    expect(f.flows.every((x) => !x.reverse)).toBe(true);
  });

  it("synthesizes UPS -> PDU -> rack -> server and server -> ToR -> spine when no cables are given", () => {
    const s = build({
      ...hall(),
      cables: undefined,
    } as PlatformCosmoSpec);
    const hidden = s.edges.filter((e) => e.hidden && !e.id.startsWith("dc_air_"));
    expect(hidden.length).toBeGreaterThan(0);
    expect(s.edges.every((e) => e.kind === "edge")).toBe(true);
    const pairs = hidden.map((e) => `${e.from}>${e.to}`);
    expect(pairs).toContain("ups1>pdu1");
    expect(pairs.some((p) => p.startsWith("pdu1>"))).toBe(true);
    expect(pairs.some((p) => p === "a1>a1/s3" || p === "a1>a1/u2")).toBe(true);
    expect(pairs).toContain("a1/u2>a1/tor");
    expect(s.flows.some((x) => x.kind === "power")).toBe(true);
    expect(s.flows.some((x) => x.kind === "normal")).toBe(true);
    // particle budget: ceil(rate * 2) stays small
    for (const fl of s.flows) expect(Math.ceil(fl.rate * 2)).toBeLessThanOrEqual(3);
  });
});

describe("buildScene: focus targets", () => {
  const f = build(hall());

  it("covers hall, rows, aisles, racks, slots and equipment", () => {
    for (const id of [
      "dc_hall",
      "row-a",
      "row-b",
      "cold-1",
      "hot-1",
      "a1",
      "b2",
      "a1/tor",
      "a1/s3",
      "ups1",
      "crah1",
    ]) {
      expect(f.focusTargets[id], id).toBeDefined();
    }
    const keys = Object.keys(f.focusTargets);
    expect(keys).toEqual([...keys].sort());
  });

  it("focus boxes equal the object/group boxes", () => {
    expect(f.focusTargets["a1"]).toEqual(f.objects.find((o) => o.id === "a1")!.box);
    const union = unionOf(["a1", "a2"].map((id) => f.objects.find((o) => o.id === id)!.box));
    expect(f.focusTargets["row-a"]).toEqual(union);
    expect(f.focusTargets["dc_hall"]).toEqual(f.bounds);
    // Aisle focus is its footprint extruded to the bounding rows' top.
    const cold = f.focusTargets["cold-1"]!;
    const colds = f.groups.find((g) => g.id === "cold-1")!.box;
    expect(cold.origin.x).toBeCloseTo(colds.origin.x, 3);
    expect(cold.size.y).toBeCloseTo(colds.size.y, 3);
    expect(cold.origin.z + cold.size.z).toBeCloseTo(
      Math.max(
        ...["a1", "a2", "b1", "b2"].map((id) => {
          const b = f.objects.find((o) => o.id === id)!.box;
          return b.origin.z + b.size.z;
        }),
      ),
      3,
    );
  });
});

describe("buildScene: diagnostics", () => {
  it("flags slot overlaps, out-of-range U and duplicate slot ids, and skips them", () => {
    const s = build(
      spec({
        racks: [
          {
            id: "r",
            u: 42,
            slots: [
              { at: 1, size: 2, type: "server-2u", id: "a" },
              { at: 2, type: "server-1u", id: "b" },
              { at: 41, size: 3, type: "server-2u", id: "c" },
              { at: 0, type: "server-1u", id: "d" },
              { at: 10, type: "server-1u", id: "e" },
              { at: 11, type: "server-1u", id: "e" },
            ],
          },
        ],
      }),
    );
    expect(s.diagnostics.map((d) => [d.code, d.path])).toEqual(
      [
        ["dc/slot-out-of-range", "/racks/0/slots/3"],
        ["dc/slot-overlap", "/racks/0/slots/1"],
        ["dc/slot-out-of-range", "/racks/0/slots/2"],
        ["dc/duplicate-slot-id", "/racks/0/slots/5/id"],
      ].sort((a, b) => (a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : a[0]! < b[0]! ? -1 : 1)),
    );
    const ids = s.objects.filter((o) => o.id.startsWith("r/")).map((o) => o.id);
    expect(ids).toEqual(["r/a", "r/e"]);
    expect(s.diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  it("rack heights bound the U range (45U and 48U accept higher slots)", () => {
    const mk = (u: number) =>
      build(spec({ racks: [{ id: "r", u, slots: [{ at: 45, type: "server-1u" }] }] })).diagnostics;
    expect(codes({ diagnostics: mk(42) } as DcSceneFragment)).toEqual(["dc/slot-out-of-range"]);
    expect(mk(45)).toEqual([]);
    expect(mk(48)).toEqual([]);
  });

  it("flags unknown row members and aisle rows", () => {
    const s = build(
      spec({
        racks: [{ id: "r" }],
        rows: [{ id: "row", members: ["r", "ghost"] }],
        aisles: [{ id: "a", kind: "cold", rows: ["row", "nope"] }],
      }),
    );
    expect(s.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["dc/unknown-aisle-row", "/aisles/0/rows/1"],
      ["dc/unknown-row-member", "/rows/0/members/1"],
    ]);
  });

  it("warns when perforated tiles or underfloor trays lack a raised floor", () => {
    const s = build(
      spec({
        racks: [{ id: "r" }],
        facility: { raisedFloor: false, perforatedTiles: true, cableTrays: "underfloor" },
      }),
    );
    expect(s.diagnostics.map((d) => d.code).sort()).toEqual([
      "dc/perforated-without-raised-floor",
      "dc/underfloor-without-raised-floor",
    ]);
    expect(s.objects.every((o) => o.type !== "perforated-tiles" && o.type !== "cable-tray")).toBe(
      true,
    );
  });

  it("flags duplicate ids across racks and equipment and rack in two rows", () => {
    const s = build(
      spec({
        racks: [{ id: "r" }, { id: "x" }],
        equipment: [{ id: "x", type: "ups" }],
        rows: [
          { id: "r1", members: ["r"] },
          { id: "r2", members: ["r"] },
        ],
      }),
    );
    expect(codes(s)).toContain("dc/duplicate-id");
    expect(codes(s)).toContain("dc/member-in-multiple-rows");
  });

  it("diagnostics are sorted by (path, code)", () => {
    const s = build(hall());
    const keys = s.diagnostics.map((d) => `${d.path}|${d.code}`);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("defaults", () => {
  it("omitted facility/rack/aisle fields use the schema defaults", () => {
    const s = build(
      spec({
        racks: [{ id: "r", slots: [server(1)] }],
        rows: [{ id: "row", members: ["r"] }],
        aisles: [{ id: "c", kind: "cold", rows: ["row"] }],
      }),
    );
    expect(s.groups.find((g) => g.id === "dc_hall")!.box.size.z).toBeCloseTo(0.3, 3);
    expect(s.objects.some((o) => o.type === "perforated-tiles")).toBe(true);
    expect(s.objects.some((o) => o.type === "cable-tray")).toBe(true);
    expect(s.groups.find((g) => g.id === "c")!.contained).toBe(false);
    const rack = s.objects.find((o) => o.id === "r")!;
    expect(rack.parts!.some((p) => p.id === "pdu-b")).toBe(true);
    expect(rack.box.size.z).toBeCloseTo((50 + 42 * 44.45 + 50) / 600, 3);
  });

  it("fallback constants equal the schema/v1.json defaults", () => {
    type Defs = Record<string, { properties?: Record<string, { default?: unknown }> }>;
    const d = schema.$defs as unknown as Defs;
    const prop = (def: string, key: string): unknown => d[def]?.properties?.[key]?.default;
    const pairs: [unknown, unknown][] = [
      [prop("rack", "u"), DC_DEFAULTS.rack.u],
      [prop("rack", "pdu"), DC_DEFAULTS.rack.pdu],
      [prop("rack", "rearDoorHeatExchanger"), DC_DEFAULTS.rack.rearDoorHeatExchanger],
      [prop("rack", "state"), DC_DEFAULTS.state],
      [prop("aisle", "contained"), DC_DEFAULTS.aisleContained],
      [prop("cable", "kind"), DC_DEFAULTS.cableKind],
      [prop("facility", "raisedFloor"), DC_DEFAULTS.facility.raisedFloor],
      [prop("facility", "perforatedTiles"), DC_DEFAULTS.facility.perforatedTiles],
      [prop("facility", "cableTrays"), DC_DEFAULTS.facility.cableTrays],
    ];
    for (const [schemaDefault, ours] of pairs) {
      expect(schemaDefault).toBeDefined();
      expect(ours).toEqual(schemaDefault);
    }
  });
});

describe("flow particle budget", () => {
  it("keeps DC flows within 1000 particles: cables first, then airflow, then synthesized", () => {
    const racks = Array.from({ length: 500 }, (_, i) => ({
      id: `r${i}`,
      slots: [server(1), { at: 3, type: "switch-tor" }],
    }));
    const cables = Array.from({ length: 2000 }, (_, i) => ({
      from: `r${i % 500}/u1`,
      to: `r${(i + 1) % 500}/u3`,
      kind: i % 2 === 0 ? "network" : "power",
    }));
    const f = build(spec({ racks, cables }));
    const particles = f.flows.reduce((n, x) => n + Math.ceil(x.rate * 2), 0);
    expect(particles).toBeLessThanOrEqual(1000);
    expect(f.flows.map((x) => x.id)).toEqual(f.flows.map((_, i) => `dc_f_${i + 1}`));
    const warn = f.diagnostics.filter((d) => d.code === "dc/flow-budget");
    expect(warn).toHaveLength(1);
    expect(warn[0]!.severity).toBe("warning");
    // user cables take priority, so no airflow or synthesized flow survives here
    const cableIds = new Set(f.edges.filter((e) => e.kind === "cable").map((e) => e.id));
    expect(f.flows.every((x) => cableIds.has(x.edge))).toBe(true);
    // every flow references a surviving edge; dropped hidden edges are gone
    const edgeIds = new Set(f.edges.map((e) => e.id));
    expect(f.flows.every((x) => edgeIds.has(x.edge))).toBe(true);
    expect(f.edges.some((e) => e.hidden)).toBe(false);
    expect(JSON.stringify(f)).toBe(JSON.stringify(build(spec({ racks, cables }))));
  });

  it("DC cap is min(1000, 2000 - spec flow cost): cost 1800 leaves at most 200", () => {
    const racks = Array.from({ length: 150 }, (_, i) => ({ id: `r${i}`, slots: [server(1)] }));
    const base = {
      racks,
      // 100 base flows at 9 particles, plus 100 step flows at 9: cost 1800
      flows: Array.from({ length: 100 }, () => ({ from: "r0", to: "r1", rate: 4.5 })),
      steps: [{ flows: Array.from({ length: 100 }, () => ({ from: "r0", to: "r1", rate: 4.5 })) }],
    };
    const s = spec(base);
    expect(specFlowCost(s)).toBe(1800);
    const f = build(s);
    const used = f.flows.reduce((n, x) => n + Math.ceil(x.rate * 2), 0);
    expect(used).toBeLessThanOrEqual(200);
    expect(used).toBeGreaterThan(0);
    expect(f.flows.every((x) => x.id.startsWith("dc_f_"))).toBe(true);
    expect(f.diagnostics.filter((d) => d.code === "dc/flow-budget")).toHaveLength(1);
    // a spec that already uses the whole budget leaves nothing for the DC
    const full = build(spec({ ...base, flows: [...base.flows, ...base.flows] }));
    expect(full.flows).toEqual([]);
    // no spec flows: the flat 1000 cap applies
    const none = build(spec({ racks }));
    expect(none.flows.reduce((n, x) => n + Math.ceil(x.rate * 2), 0)).toBeLessThanOrEqual(1000);
  });

  it("small halls are not truncated", () => {
    const f = build(hall());
    expect(f.diagnostics.some((d) => d.code === "dc/flow-budget")).toBe(false);
  });
});

describe("review fixes", () => {
  it("bounds include cable path points and label anchors", () => {
    const f = build(hall());
    for (const e of f.edges) {
      for (const v of [...e.path, ...(e.labelAnchor ? [e.labelAnchor] : [])]) {
        expect(v.x).toBeGreaterThanOrEqual(f.bounds.origin.x - EPS);
        expect(v.y).toBeGreaterThanOrEqual(f.bounds.origin.y - EPS);
        expect(v.z).toBeGreaterThanOrEqual(f.bounds.origin.z - EPS);
        expect(v.x).toBeLessThanOrEqual(f.bounds.origin.x + f.bounds.size.x + EPS);
        expect(v.y).toBeLessThanOrEqual(f.bounds.origin.y + f.bounds.size.y + EPS);
        expect(v.z).toBeLessThanOrEqual(f.bounds.origin.z + f.bounds.size.z + EPS);
      }
    }
  });

  it("duplicate cable ids are reported and skipped", () => {
    const s = build(
      spec({
        racks: [{ id: "r1" }, { id: "r2" }, { id: "r3" }],
        cables: [
          { id: "c", from: "r1", to: "r2" },
          { id: "c", from: "r2", to: "r3" },
          { from: "r1", to: "r3", id: "dc_cable_4" },
          { from: "r1", to: "r3" },
        ],
      }),
    );
    expect(s.edges.filter((e) => e.kind === "cable").map((e) => e.id)).toEqual(["c", "dc_cable_4"]);
    expect(s.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["dc/duplicate-cable-id", "/cables/1/id"],
      ["dc/duplicate-cable-id", "/cables/3/id"],
    ]);
  });

  it("unknown slot types are reported", () => {
    const s = build(spec({ racks: [{ id: "r", slots: [{ at: 1, type: "toaster" }, server(2)] }] }));
    expect(s.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["dc/unknown-component", "/racks/0/slots/0/type"],
    ]);
    expect(s.objects.some((o) => o.id === "r/u1")).toBe(false);
    expect(s.objects.some((o) => o.id === "r/u2")).toBe(true);
  });

  it("the rack shell is a sibling object so it can draw after the slot devices", () => {
    const f = build(hall());
    const shell = f.objects.find((o) => o.id === "a1_front")!;
    expect(shell).toMatchObject({ type: "rack-front", group: "row-a" });
    expect(shell.parts!.map((p) => p.id).sort()).toEqual(["post-fl", "post-fr", "top"]);
    const rack = f.objects.find((o) => o.id === "a1")!;
    expect(rack.parts!.some((p) => p.id === "top")).toBe(false);
    // mirrored rows: the viewer-side shell is the rear
    const back = f.objects.find((o) => o.id === "b1_front")!;
    expect(back.parts!.map((p) => p.id)).toContain("post-bl");
    expect(back.parts!.map((p) => p.id)).toContain("rear-door");
  });

  it("slot state defaults to the rack state, and explicit slot state wins", () => {
    const s = build(
      spec({
        racks: [
          {
            id: "r",
            state: "degraded",
            slots: [server(1), { at: 2, type: "server-1u", state: "down" }],
          },
        ],
      }),
    );
    const st = (id: string) => s.objects.find((o) => o.id === id)!.state;
    expect(st("r")).toBe("degraded");
    expect(st("r/u1")).toBe("degraded");
    expect(st("r/u2")).toBe("down");
  });

  it("manual-pos rows derive their extent from members; aisles with no space are skipped", () => {
    const s = build(
      spec({
        racks: [
          { id: "x", pos: { x: 0, y: 0 } },
          { id: "y", pos: { x: 0, y: 1 } },
        ],
        rows: [
          { id: "r1", members: ["x"] },
          { id: "r2", members: ["y"] },
        ],
        aisles: [{ id: "a", kind: "cold", rows: ["r1", "r2"] }],
      }),
    );
    expect(s.diagnostics.map((d) => d.code)).toContain("dc/aisle-no-space");
    expect(s.groups.some((g) => g.id === "a")).toBe(false);
    expect(s.focusTargets["a"]).toBeUndefined();
  });

  it("warns about conflicting facing from different aisles and keeps the first", () => {
    const s = build(
      spec({
        racks: [{ id: "x" }, { id: "y" }, { id: "z" }],
        rows: [
          { id: "r1", members: ["x"] },
          { id: "r2", members: ["y"] },
          { id: "r3", members: ["z"] },
        ],
        aisles: [
          { id: "c1", kind: "cold", rows: ["r1", "r2"] },
          { id: "c2", kind: "cold", rows: ["r2", "r3"] },
        ],
      }),
    );
    expect(s.diagnostics.some((d) => d.code === "dc/facing-conflict")).toBe(true);
  });
});

describe("integration fixes", () => {
  const f = build(hall());
  const box = (id: string): Box3 => f.objects.find((o) => o.id === id)!.box;
  const gap = (a: Box3, b: Box3): number => {
    const dx = Math.max(
      0,
      a.origin.x - (b.origin.x + b.size.x),
      b.origin.x - (a.origin.x + a.size.x),
    );
    const dy = Math.max(
      0,
      a.origin.y - (b.origin.y + b.size.y),
      b.origin.y - (a.origin.y + a.size.y),
    );
    return Math.max(dx, dy);
  };

  it("CRAH stands at the far (-x) end of the cold aisle with >= 1 tile clearance", () => {
    const crah = box("crah1");
    const rackIds = ["a1", "a2", "b1", "b2"];
    for (const id of rackIds) expect(gap(crah, box(id)), id).toBeGreaterThanOrEqual(1 - EPS);
    const aisle = f.groups.find((g) => g.id === "cold-1")!.box;
    const minRackX = Math.min(...rackIds.map((id) => box(id).origin.x));
    expect(crah.origin.x + crah.size.x).toBeLessThanOrEqual(minRackX - 1 + EPS);
    expect(crah.origin.y).toBeGreaterThanOrEqual(aisle.origin.y - EPS);
  });

  it("UPS and PDU sit in a service strip 3 tiles behind the first row (-y), never flush", () => {
    const rowsMinY = Math.min(...["a1", "a2", "b1", "b2"].map((id) => box(id).origin.y));
    for (const id of ["ups1", "pdu1"]) {
      expect(box(id).origin.y + box(id).size.y).toBeLessThanOrEqual(rowsMinY - 3 + EPS);
      for (const r of ["a1", "a2", "b1", "b2"])
        expect(gap(box(id), box(r))).toBeGreaterThanOrEqual(1);
    }
  });

  it("row groups are a one-tile end cap on the viewer (+x) side, so labels sit in the aisle", () => {
    const row = f.groups.find((g) => g.id === "row-a")!.box;
    const maxRackX = Math.max(
      box("a1").origin.x + box("a1").size.x,
      box("a2").origin.x + box("a2").size.x,
    );
    expect(row.origin.x).toBeCloseTo(maxRackX + 0.5, 3); // clear of the rack labels
    expect(row.size.x).toBeCloseTo(1, 3);
    const focus = f.focusTargets["row-a"]!;
    expect(focus.origin.x + focus.size.x).toBeCloseTo(maxRackX, 3); // focus stays the members
    for (const e of f.objects.filter((o) => o.type !== "cable-tray" && !o.id.startsWith("dc_"))) {
      const inside =
        e.box.origin.x < row.origin.x + row.size.x - EPS &&
        row.origin.x < e.box.origin.x + e.box.size.x - EPS &&
        e.box.origin.y < row.origin.y + row.size.y - EPS &&
        row.origin.y < e.box.origin.y + e.box.size.y - EPS;
      expect(inside, e.id).toBe(false);
    }
  });

  it("power cables ride the overhead tray: up to tray height, orthogonal, drop into the rack top", () => {
    const trayZ = f.objects.find((o) => o.id === "dc_tray_row-a")!.box.origin.z + 0.05;
    const power = f.edges.find(
      (e) => e.id === "feed" || (e.cableKind === "power" && e.to === "a1"),
    )!;
    const cable = f.edges.find((e) => e.cableKind === "power" && e.to === "a1")!;
    expect(power).toBeDefined();
    const mids = cable.path.slice(1, -1);
    expect(Math.max(...cable.path.map((p) => p.z))).toBeGreaterThanOrEqual(trayZ - EPS);
    // every long horizontal run is at tray height (only short port stubs are low)
    for (let i = 1; i < cable.path.length; i++) {
      const p = cable.path[i - 1]!;
      const q = cable.path[i]!;
      if (p.z === q.z && Math.hypot(q.x - p.x, q.y - p.y) > 0.5) {
        expect(p.z).toBeGreaterThanOrEqual(trayZ - EPS);
      }
    }
    expect(mids.length).toBeGreaterThan(0);
    const a1 = box("a1");
    const end = cable.path[cable.path.length - 1]!;
    const before = cable.path[cable.path.length - 2]!;
    expect(end.z).toBeCloseTo(a1.origin.z + a1.size.z, 3); // rack-top feed
    expect(before.x).toBeCloseTo(end.x, 3);
    expect(before.y).toBeCloseTo(end.y, 3);
    expect(before.z).toBeGreaterThan(end.z);
  });

  it("airflow paths run just above the floor through the rack", () => {
    const air = f.edges.find((e) => e.id === "dc_air_a1")!;
    const floorZ = box("a1").origin.z;
    for (const p of air.path) expect(p.z).toBeLessThan(floorZ + 0.2);
  });

  it("a raised floor gets a one-object tile grid; huge halls skip it", () => {
    const grid = f.objects.find((o) => o.id === "dc_floor_grid")!;
    const hallBox = f.groups.find((g) => g.id === "dc_hall")!.box;
    expect(grid.parts!.length).toBe(Math.round(hallBox.size.x) * Math.round(hallBox.size.y));
    expect(
      build(spec({ racks: [{ id: "r" }], facility: { raisedFloor: false } })).objects.some(
        (o) => o.id === "dc_floor_grid",
      ),
    ).toBe(false);
    const wide = build(spec({ racks: Array.from({ length: 400 }, (_, i) => ({ id: `r${i}` })) }));
    expect(wide.objects.some((o) => o.id === "dc_floor_grid")).toBe(false);
    expect(wide.diagnostics.map((d) => d.code)).toContain("dc/floor-grid-skipped");
  });
});

describe("review round 2", () => {
  const f = build(hall());

  it("the floor grid sits strictly below every DC object it overlaps (depth -1)", () => {
    const grid = f.objects.find((o) => o.id === "dc_floor_grid")!;
    const floorZ = f.groups.find((g) => g.id === "dc_hall")!.box.size.z;
    expect(grid.box.origin.z + grid.box.size.z).toBeLessThanOrEqual(floorZ + 1e-9);
    for (const p of grid.parts!)
      expect(p.box.origin.z + p.box.size.z).toBeLessThanOrEqual(floorZ + 1e-9);
    const overlaps = (a: Box3, b: Box3): boolean =>
      a.origin.x < b.origin.x + b.size.x &&
      b.origin.x < a.origin.x + a.size.x &&
      a.origin.y < b.origin.y + b.size.y &&
      b.origin.y < a.origin.y + a.size.y;
    let n = 0;
    for (const o of f.objects.filter(
      (x) => x.id !== "dc_floor_grid" && overlaps(grid.box, x.box),
    )) {
      expect(compareBoxes(grid.box, o.box), o.id).toBe(-1);
      n++;
    }
    expect(n).toBeGreaterThan(5);
  });

  it("depth order is rack < its slots < rack_front", () => {
    const items = f.objects
      .filter((o) => o.id === "a1" || o.id.startsWith("a1/") || o.id === "a1_front")
      .map((o) => ({ id: o.id, box: o.box }));
    expect(items.length).toBeGreaterThan(3);
    const order = depthOrder(items, createProjection());
    const at = (id: string): number => order.indexOf(id);
    for (const o of items.filter((x) => x.id.includes("/"))) {
      expect(at("a1")).toBeLessThan(at(o.id));
      expect(at(o.id)).toBeLessThan(at("a1_front"));
    }
  });

  it("several CRAHs stack at the -x aisle end, each clear of the racks; only cabled ones get a tray", () => {
    const s = build(
      spec({
        racks: [
          { id: "r1", slots: [server(1)] },
          { id: "r2", slots: [server(1)] },
        ],
        equipment: [
          { id: "c1", type: "crah" },
          { id: "c2", type: "crah" },
        ],
        rows: [
          { id: "ra", members: ["r1"] },
          { id: "rb", members: ["r2"] },
        ],
        aisles: [{ id: "cold", kind: "cold", rows: ["ra", "rb"] }],
        cables: [{ from: "c1", to: "r1", kind: "power" }],
      }),
    );
    const b = (id: string): Box3 => s.objects.find((o) => o.id === id)!.box;
    expect(b("c2").origin.y).toBeGreaterThanOrEqual(b("c1").origin.y + b("c1").size.y - EPS);
    for (const c of ["c1", "c2"]) {
      expect(b(c).origin.x + b(c).size.x).toBeLessThanOrEqual(b("r1").origin.x - 1 + EPS);
    }
    expect(s.objects.some((o) => o.id === "dc_tray_c1")).toBe(true);
    expect(s.objects.some((o) => o.id === "dc_tray_c2")).toBe(false);
  });

  it("a single lane has no spine tray", () => {
    const s = build(
      spec({ racks: [{ id: "r1" }, { id: "r2" }], rows: [{ id: "ra", members: ["r1", "r2"] }] }),
    );
    expect(s.objects.filter((o) => o.type === "cable-tray").map((o) => o.id)).toEqual([
      "dc_tray_ra",
    ]);
  });

  it("manually placed strip items use their own centre as the lane", () => {
    const s = build(
      spec({
        racks: [{ id: "r1", slots: [server(1)] }],
        equipment: [{ id: "u", type: "ups", pos: { x: 8, y: 9 } }],
        rows: [{ id: "ra", members: ["r1"] }],
        cables: [{ from: "u", to: "r1", kind: "power" }],
      }),
    );
    const tray = s.objects.find((o) => o.id === "dc_tray_u")!;
    const ups = s.objects.find((o) => o.id === "u")!;
    expect(
      Math.abs(tray.box.origin.y + tray.box.size.y / 2 - (ups.box.origin.y + ups.box.size.y / 2)),
    ).toBeLessThan(0.25); // lane is the cell centre; the UPS is front-aligned in its cell
  });

  it("cableTrays none: no tray objects; cables stay orthogonal at the default overhead lane", () => {
    const base = hall();
    const s = build({
      ...base,
      facility: { raisedFloor: true, cableTrays: "none" },
    } as PlatformCosmoSpec);
    expect(s.objects.some((o) => o.type === "cable-tray")).toBe(false);
    for (const e of s.edges.filter((x) => x.kind === "cable")) {
      for (let i = 1; i < e.path.length; i++) {
        const p = e.path[i - 1]!;
        const q = e.path[i]!;
        expect(Number(p.x !== q.x) + Number(p.y !== q.y) + Number(p.z !== q.z)).toBe(1);
      }
    }
  });

  it("underfloor trays sit below the floor level and need a raised floor", () => {
    const s = build({
      ...hall(),
      facility: { raisedFloor: true, cableTrays: "underfloor" },
    } as PlatformCosmoSpec);
    const trays = s.objects.filter((o) => o.type === "cable-tray");
    expect(trays.length).toBeGreaterThan(0);
    const floor = s.groups.find((g) => g.id === "dc_hall")!.box.size.z;
    for (const t of trays) expect(t.box.origin.z).toBeLessThan(floor);
    for (const e of s.edges.filter((x) => x.kind === "cable")) {
      expect(Math.min(...e.path.map((p) => p.z))).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("round 2 follow-ups", () => {
  it("the hall grows by whole tiles (grid tiles equal the hall size)", () => {
    for (const s of [
      build(hall()),
      build(spec({ racks: [{ id: "r" }, { id: "q" }], rows: [{ id: "ra", members: ["r", "q"] }] })),
    ]) {
      const hall = s.groups.find((g) => g.id === "dc_hall")!.box;
      expect(Math.abs(hall.size.x - Math.round(hall.size.x))).toBeLessThan(1e-9);
      expect(Math.abs(hall.size.y - Math.round(hall.size.y))).toBeLessThan(1e-9);
      const grid = s.objects.find((o) => o.id === "dc_floor_grid")!;
      expect(grid.parts!.length).toBe(Math.round(hall.size.x) * Math.round(hall.size.y));
    }
  });

  it("vent slits are skipped on aisles above 100 tiles", () => {
    const racks = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}` }));
    const racksB = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}` }));
    const s = build(
      spec({
        racks: [...racks, ...racksB],
        rows: [
          { id: "ra", members: racks.map((r) => r.id) },
          { id: "rb", members: racksB.map((r) => r.id) },
        ],
        aisles: [{ id: "cold", kind: "cold", rows: ["ra", "rb"] }],
      }),
    );
    const floor = s.objects.find((o) => o.id === "dc_tiles_cold")!;
    expect(floor.parts!.length).toBe(120); // 60 x 2 tiles, no slits
    expect(floor.parts!.every((p) => p.id.startsWith("tile-"))).toBe(true);
  });

  it("only accepted cables, and UPS/PDUs on automatic power flows, get lane trays", () => {
    const base = {
      racks: [{ id: "r1", slots: [server(1)] }],
      equipment: [
        { id: "u", type: "ups" },
        { id: "p", type: "pdu-floor" },
      ],
      rows: [{ id: "ra", members: ["r1"] }],
    };
    // no cables: the automatic UPS -> PDU -> rack flows need lanes for both
    const auto = build(spec(base));
    expect(auto.objects.some((o) => o.id === "dc_tray_u")).toBe(true);
    expect(auto.objects.some((o) => o.id === "dc_tray_p")).toBe(true);
    // a rejected cable (unknown endpoint) does not create a tray; an accepted power cable does
    const s = build(
      spec({
        ...base,
        cables: [
          { from: "u", to: "ghost", kind: "power" },
          { from: "p", to: "r1", kind: "power" },
        ],
      }),
    );
    expect(s.objects.some((o) => o.id === "dc_tray_u")).toBe(false);
    expect(s.objects.some((o) => o.id === "dc_tray_p")).toBe(true);
  });
});
