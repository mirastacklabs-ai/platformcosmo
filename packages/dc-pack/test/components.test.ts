import { describe, expect, it } from "vitest";
import type { DcBuildContext, DcComponentDef } from "@platformcosmo/core";
import schema from "../../../schema/v1.json" with { type: "json" };
import { dcPack } from "../src/index.js";
import { rackHeightMm } from "../src/components/rack.js";
import { MM_PER_TILE, U_MM } from "../src/units.js";

const reg = dcPack.registry;
const ctx: DcBuildContext = { id: "x", state: "healthy" };
const EPS = 1e-3;

describe("registry", () => {
  it("has the rack plus every schema slot and equipment type", () => {
    const want = ["rack", ...schema.$defs.dcSlotType.enum, ...schema.$defs.dcEquipmentType.enum];
    expect(reg.list().map((d) => d.type)).toEqual(want);
    for (const t of want) expect(reg.get(t)?.type).toBe(t);
    expect(reg.get("nope")).toBeUndefined();
    expect(reg.get("__proto__")).toBeUndefined();
  });

  it("describes rack-mounted gear in U and floor gear by footprint", () => {
    for (const d of reg.list()) {
      if (d.category === "rack" || schema.$defs.dcSlotType.enum.includes(d.type)) {
        expect(d.heightU, d.type).toBeGreaterThanOrEqual(1);
      } else {
        expect(d.footprintMm, d.type).toBeDefined();
      }
    }
  });
});

describe.each(reg.list().map((d) => [d.type, d] as const))(
  "component %s",
  (_t, d: DcComponentDef) => {
    const r = d.build(d.defaults, ctx);

    it("is deterministic", () => {
      expect(JSON.stringify(d.build(d.defaults, ctx))).toBe(JSON.stringify(r));
    });

    it("has unique valid part ids and at least one part", () => {
      expect(r.parts.length).toBeGreaterThan(0);
      const ids = r.parts.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9_.-]+$/);
    });

    it("keeps every part inside bounds, starting at the origin", () => {
      expect(r.bounds.origin).toEqual({ x: 0, y: 0, z: 0 });
      for (const p of r.parts) {
        expect(p.box.size.x).toBeGreaterThan(0);
        expect(p.box.size.y).toBeGreaterThan(0);
        expect(p.box.size.z).toBeGreaterThan(0);
        expect(p.box.origin.x).toBeGreaterThanOrEqual(-EPS);
        expect(p.box.origin.y).toBeGreaterThanOrEqual(-EPS);
        expect(p.box.origin.z).toBeGreaterThanOrEqual(-EPS);
        expect(p.box.origin.x + p.box.size.x).toBeLessThanOrEqual(r.bounds.size.x + EPS);
        expect(p.box.origin.y + p.box.size.y).toBeLessThanOrEqual(r.bounds.size.y + EPS);
        expect(p.box.origin.z + p.box.size.z).toBeLessThanOrEqual(r.bounds.size.z + EPS);
      }
    });

    it("has unique port ids with positions within bounds", () => {
      const ids = r.ports.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of r.ports) {
        expect(p.at.x).toBeGreaterThanOrEqual(-EPS);
        expect(p.at.x).toBeLessThanOrEqual(r.bounds.size.x + EPS);
        expect(p.at.y).toBeGreaterThanOrEqual(-EPS);
        expect(p.at.y).toBeLessThanOrEqual(r.bounds.size.y + EPS);
        expect(p.at.z).toBeGreaterThanOrEqual(-EPS);
        expect(p.at.z).toBeLessThanOrEqual(r.bounds.size.z + EPS);
      }
    });

    it("emits only finite numbers with at most 4 decimals", () => {
      const nums: number[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === "number") nums.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(r);
      for (const n of nums) {
        expect(Number.isFinite(n)).toBe(true);
        expect(Math.abs(n * 10000 - Math.round(n * 10000))).toBeLessThan(1e-6);
      }
    });

    it("carries no vendor-specific text in ids", () => {
      expect(JSON.stringify(r)).not.toMatch(
        /dell|hpe|cisco|nvidia|juniper|arista|apc|vertiv|schneider|netapp/i,
      );
    });
  },
);

describe("rack", () => {
  const rack = reg.get("rack")!;
  it.each([42, 45, 48])("%iU rack height and footprint", (u) => {
    const r = rack.build({ ...rack.defaults, u }, ctx);
    expect(r.bounds.size.x).toBeCloseTo(1, 4);
    expect(r.bounds.size.y).toBeCloseTo(2, 4);
    expect(r.bounds.size.z).toBeCloseTo(rackHeightMm(u) / MM_PER_TILE, 3);
  });

  it("falls back to 42U for an invalid height", () => {
    const a = rack.build({ ...rack.defaults, u: 7 }, ctx);
    const b = rack.build({ ...rack.defaults, u: 42 }, ctx);
    expect(a).toEqual(b);
  });

  it("pdu and rear door options change the parts", () => {
    const ids = (p: object): string[] =>
      rack.build({ ...rack.defaults, ...p }, ctx).parts.map((x) => x.id);
    expect(ids({ pdu: "none" })).not.toContain("pdu-a");
    expect(ids({ pdu: "single" })).toContain("pdu-a");
    expect(ids({ pdu: "single" })).not.toContain("pdu-b");
    expect(ids({ pdu: "dual" })).toContain("pdu-b");
    expect(ids({ rearDoorHeatExchanger: true })).toContain("rear-door");
    expect(ids({ rearDoorHeatExchanger: false })).toContain("rear-panel");
  });

  it("exposes power, network and airflow ports", () => {
    const kinds = new Set(
      rack.build({ ...rack.defaults, pdu: "dual" }, ctx).ports.map((p) => p.kind),
    );
    for (const k of ["power-a", "power-b", "network", "airflow-in", "airflow-out"]) {
      expect(kinds.has(k as never)).toBe(true);
    }
  });
});

describe("rack-mounted devices", () => {
  it("scale with heightU", () => {
    const d = reg.get("server-1u")!;
    const a = d.build({ heightU: 1 }, ctx);
    const b = d.build({ heightU: 4 }, ctx);
    expect(b.bounds.size.z).toBeGreaterThan(a.bounds.size.z * 3);
    expect(a.bounds.size.z).toBeCloseTo((U_MM - 1.5) / MM_PER_TILE, 3);
    // Devices are 19 inch wide.
    expect(a.bounds.size.x).toBeCloseTo(482 / MM_PER_TILE, 3);
  });

  it("servers have LEDs, network ports and both power feeds", () => {
    const r = reg.get("server-2u")!.build({ heightU: 2 }, ctx);
    expect(r.parts.some((p) => p.tone === "led")).toBe(true);
    const kinds = r.ports.map((p) => p.kind);
    expect(kinds).toContain("network");
    expect(kinds).toContain("power-a");
    expect(kinds).toContain("power-b");
  });

  it("ignores nonsense params", () => {
    const d = reg.get("server-1u")!;
    expect(d.build({ heightU: -3 }, ctx)).toEqual(d.build({ heightU: 1 }, ctx));
    expect(d.build({ heightU: "x" }, ctx)).toEqual(d.build({ heightU: 1 }, ctx));
  });
});

describe("equipment", () => {
  it("uses the declared footprint as bounds floor", () => {
    for (const t of schema.$defs.dcEquipmentType.enum) {
      const d = reg.get(t)!;
      const r = d.build(d.defaults, ctx);
      expect(r.bounds.size.x).toBeGreaterThanOrEqual(d.footprintMm!.width / MM_PER_TILE - EPS);
      expect(r.bounds.size.y).toBeGreaterThanOrEqual(d.footprintMm!.depth / MM_PER_TILE - EPS);
      expect(r.bounds.size.z).toBeGreaterThanOrEqual(d.footprintMm!.height / MM_PER_TILE - EPS);
    }
  });

  it("power equipment has power ports and cooling has airflow ports", () => {
    for (const d of reg.list().filter((x) => x.category === "power" && !x.heightU)) {
      expect(
        d.build(d.defaults, ctx).ports.some((p) => p.kind.startsWith("power")),
        d.type,
      ).toBe(true);
    }
    for (const d of reg.list().filter((x) => x.category === "cooling")) {
      expect(
        d.build(d.defaults, ctx).ports.some((p) => p.kind.startsWith("airflow")),
        d.type,
      ).toBe(true);
    }
  });
});
