import { describe, expect, test } from "vitest";
import type { Box3, PartGeometry, PartShapeContext, PartShapeDef } from "@platformcosmo/core";
import { createProjection, partGeometryFaces } from "@platformcosmo/core";
import { hwPack, hwShapes, MAX_EXTENT_MM, paramSpecsOf, registry } from "../src/index.js";
import type { ParamSpec } from "../src/index.js";

const ORDER = [
  "board",
  "cpu",
  "heatsink",
  "dimm",
  "gpu-card",
  "nic-ocp3",
  "nvme-m2",
  "e1s",
  "psu",
  "fan",
  "riser",
  "pcie-card",
  "chassis-2u",
  "lid",
];
const proj = createProjection();
const EPS = 0.011;

const ctxFor = (s: PartShapeDef, over: Partial<PartShapeContext> = {}): PartShapeContext => ({
  size: s.defaultSize,
  units: "mm",
  axis: "z",
  tone: "base",
  state: "healthy",
  ...over,
});

function inside(inner: Box3, outer: Box3, eps = EPS): boolean {
  return (["x", "y", "z"] as const).every(
    (k) =>
      inner.origin[k] >= outer.origin[k] - eps &&
      inner.origin[k] + inner.size[k] <= outer.origin[k] + outer.size[k] + eps,
  );
}

/** Every parameter combination at its extremes (min, max, default) for each declared param. */
function variants(s: PartShapeDef): Record<string, number | boolean | string>[] {
  const specs = [...(paramSpecsOf(s.id) as ReadonlyMap<string, ParamSpec>)];
  const out: Record<string, number | boolean | string>[] = [{}];
  for (const [k, sp] of specs) {
    const vals: (number | boolean | string)[] =
      sp.kind === "int" ? [sp.min, sp.max] : sp.kind === "bool" ? [true, false] : [...sp.values];
    const next: Record<string, number | boolean | string>[] = [];
    for (const o of out) for (const v of vals) next.push({ ...o, [k]: v });
    out.push(...next);
  }
  return out;
}

function check(s: PartShapeDef, g: PartGeometry, size = s.defaultSize): void {
  const ids = g.primitives.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[a-z0-9_.-]+$/);
  const size3: Box3 = { origin: { x: 0, y: 0, z: 0 }, size };
  for (const p of g.primitives) {
    expect(inside(p.box, size3), `${s.id}/${p.id} inside size`).toBe(true);
    for (const k of ["x", "y", "z"] as const) expect(p.box.size[k]).toBeGreaterThan(0);
  }
  expect(inside(g.depthBox, g.bounds, 1e-9), `${s.id} depthBox within bounds`).toBe(true);
  // bounds is exactly the union of the primitives
  const lo = (k: "x" | "y" | "z") => Math.min(...g.primitives.map((p) => p.box.origin[k]));
  const hi = (k: "x" | "y" | "z") =>
    Math.max(...g.primitives.map((p) => p.box.origin[k] + p.box.size[k]));
  for (const k of ["x", "y", "z"] as const) {
    expect(g.bounds.origin[k]).toBeCloseTo(lo(k), 9);
    expect(g.bounds.origin[k] + g.bounds.size[k]).toBeCloseTo(hi(k), 1);
  }
  if (g.split) {
    const listed = [...g.split.back, ...g.split.front];
    expect([...listed].sort()).toEqual([...ids].sort());
    expect(g.solid).toBe(false);
  } else expect(g.solid).toBe(true);
  // A1-1 invariant: each face name at most once per primitive (and per half)
  for (const pf of partGeometryFaces(g, proj)) {
    const names = pf.faces.map((f) => `${f.half ?? ""}:${f.face}`);
    expect(new Set(names).size, `${s.id}/${pf.primitive.id} face names`).toBe(names.length);
  }
}

describe("pack", () => {
  test("hw pack lists the 14 shapes of assemblies section 5, in order", () => {
    expect(hwPack.id).toBe("hw");
    expect(hwShapes.map((s) => s.id)).toEqual(ORDER);
    expect(registry.list()).toEqual(ORDER.map((i) => `hw:${i}`).sort());
    expect(registry.get("hw:dimm")?.id).toBe("dimm");
    expect(registry.get("hw:nope")).toBeUndefined();
    expect(registry.get("dimm")).toBeUndefined();
  });

  test("true-scale defaults in millimetres", () => {
    const size = (id: string) => registry.get(`hw:${id}`)?.defaultSize;
    expect(size("dimm")).toEqual({ x: 133.35, y: 4, z: 31.25 });
    expect(size("e1s")).toEqual({ x: 33.75, y: 118.75, z: 9.5 });
    expect(size("nvme-m2")).toEqual({ x: 80, y: 22, z: 3.8 });
    expect(size("chassis-2u")).toEqual({ x: 482.6, y: 740, z: 88.9 });
    for (const s of hwShapes) expect(s.defaultUnits).toBe("mm");
  });
});

describe.each(hwShapes.map((s) => [s.id, s] as const))("hw:%s", (_id, s) => {
  test("defaults: fills its default size exactly, depthBox within bounds, unique faces", () => {
    const g = s.build(s.defaults, ctxFor(s));
    check(s, g);
    for (const k of ["x", "y", "z"] as const) {
      expect(g.bounds.origin[k]).toBe(0);
      expect(Math.abs(g.bounds.size[k] - s.defaultSize[k])).toBeLessThan(EPS);
    }
    expect(g.primitives.length).toBeGreaterThan(1);
  });

  test("every min/max/boolean param combination builds valid geometry", () => {
    for (const v of variants(s)) {
      const r = s.readParams(v);
      expect(r.diagnostics).toEqual([]);
      check(s, s.build(r.params, ctxFor(s)));
    }
  });

  test("scales to a non-uniform spec size and stays inside it", () => {
    const size = {
      x: s.defaultSize.x * 1.37,
      y: s.defaultSize.y * 0.61,
      z: s.defaultSize.z * 2.05,
    };
    const r = {
      x: Math.round(size.x * 100) / 100,
      y: Math.round(size.y * 100) / 100,
      z: Math.round(size.z * 100) / 100,
    };
    const g = s.build(s.defaults, ctxFor(s, { size: r }));
    check(s, g, r);
    for (const k of ["x", "y", "z"] as const) {
      expect(Math.abs(g.bounds.size[k] - r[k])).toBeLessThan(EPS);
    }
  });

  test("deterministic: same inputs, identical output", () => {
    for (const v of variants(s)) {
      const a = JSON.stringify(s.build(s.readParams(v).params, ctxFor(s)));
      const b = JSON.stringify(s.build(s.readParams({ ...v }).params, ctxFor(s)));
      expect(a).toBe(b);
    }
  });

  test("never throws: bad size and bad params fall back to defaults", () => {
    const base = JSON.stringify(s.build(s.defaults, ctxFor(s)));
    const badSize = [
      { x: NaN, y: -1, z: 0 },
      { x: Infinity, y: undefined, z: "9" },
    ] as unknown as { x: number; y: number; z: number }[];
    for (const size of badSize) {
      expect(JSON.stringify(s.build(s.defaults, ctxFor(s, { size })))).toBe(base);
    }
    const junk = Object.fromEntries(
      [...(paramSpecsOf(s.id) as ReadonlyMap<string, ParamSpec>).keys()].map((k) => [k, 1e9]),
    );
    expect(JSON.stringify(s.build(junk as never, ctxFor(s)))).toBe(base);
    expect(() => s.build(null as never, ctxFor(s, { size: undefined as never }))).not.toThrow();
  });

  test("huge sizes are clamped, primitive count is capped by param ranges", () => {
    const huge = s.build(s.defaults, ctxFor(s, { size: { x: 1e30, y: 1e30, z: 1e30 } }));
    expect(huge.bounds.size.x).toBeLessThanOrEqual(MAX_EXTENT_MM);
    const maxed = Object.fromEntries(
      [...(paramSpecsOf(s.id) as ReadonlyMap<string, ParamSpec>)].map(([k, sp]) => [
        k,
        sp.kind === "int" ? sp.max : sp.kind === "bool" ? true : sp.values[0],
      ]),
    );
    expect(s.build(maxed as never, ctxFor(s)).primitives.length).toBeLessThanOrEqual(64);
  });

  test("spec color paints only the main body primitive(s)", () => {
    const g = s.build(s.defaults, ctxFor(s, { color: "#112233" }));
    const painted = g.primitives.filter((p) => p.color === "#112233");
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.length).toBeLessThan(g.primitives.length);
  });
});

describe("readParams", () => {
  const dimm = registry.get("hw:dimm") as PartShapeDef;

  test("empty input yields the defaults and no diagnostics", () => {
    expect(dimm.readParams({})).toEqual({ params: dimm.defaults, diagnostics: [] });
  });

  test("unknown param: shape-params error with did-you-mean", () => {
    const r = dimm.readParams({ chipz: 4, spreader: true });
    expect(r.params).toEqual({ chips: 8, spreader: true });
    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0];
    expect(d?.code).toBe("assembly/shape-params");
    expect(d?.severity).toBe("error");
    expect(d?.path).toBe("/params/chipz");
    expect(d?.suggestion).toBe('Did you mean "chips"?');
  });

  test("unrelated unknown param: error, no suggestion, lists known params", () => {
    const d = dimm.readParams({ wibble: 1 }).diagnostics[0];
    expect(d?.suggestion).toBeUndefined();
    expect(d?.message).toContain("chips, spreader");
  });

  test.each([
    ["chips", 10],
    ["chips", -1],
    ["chips", 2.5],
    ["chips", "8"],
    ["chips", Number.NaN],
    ["chips", 1e9],
    ["spreader", "yes"],
    ["spreader", 1],
  ])("invalid value %s=%j is rejected and the default is kept", (key, value) => {
    const r = dimm.readParams({ [key]: value });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.code).toBe("assembly/shape-params");
    expect(r.diagnostics[0]?.path).toBe(`/params/${key}`);
    expect(r.params).toEqual(dimm.defaults);
  });

  test("hostile keys do not pollute or throw, and are escaped in the path", () => {
    const r = dimm.readParams(JSON.parse('{"__proto__": 1, "a/b": 2, "constructor": 3}'));
    expect(r.diagnostics).toHaveLength(3);
    expect(r.diagnostics.map((d) => d.path)).toEqual([
      "/params/__proto__",
      "/params/a~1b",
      "/params/constructor",
    ]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(r.params).toEqual(dimm.defaults);
  });

  test("long keys are truncated in messages", () => {
    const d = dimm.readParams({ ["x".repeat(5000)]: 1 }).diagnostics[0];
    expect(d?.message.length).toBeLessThan(300);
  });

  test("params with no declared options report an empty known list correctly", () => {
    for (const s of hwShapes) {
      const first = [...(paramSpecsOf(s.id) as ReadonlyMap<string, ParamSpec>).keys()][0] as string;
      const typo = `${first}s`;
      const d = s.readParams({ [typo]: 1 }).diagnostics[0];
      expect(d?.code).toBe("assembly/shape-params");
      expect(d?.suggestion).toBe(`Did you mean "${first}"?`);
    }
  });
});

describe("deny-list", () => {
  const BRANDS = [
    "nvidia",
    "geforce",
    "rtx",
    "tesla",
    "amd",
    "epyc",
    "ryzen",
    "intel",
    "xeon",
    "dell",
    "poweredge",
    "hpe",
    "proliant",
    "supermicro",
    "lenovo",
    "gigabyte",
    "asus",
    "samsung",
    "micron",
    "kingston",
    "corsair",
    "seagate",
    "western",
    "cisco",
    "mellanox",
    "broadcom",
    "marvell",
    "dgx",
    "hgx",
  ];
  test("no shape id, label, type, pack text or param name carries a brand", () => {
    const text = [hwPack.id, hwPack.name]
      .concat(
        hwShapes.flatMap((s) => [
          s.id,
          s.label,
          s.type,
          ...(paramSpecsOf(s.id) as ReadonlyMap<string, ParamSpec>).keys(),
        ]),
      )
      .join(" ")
      .toLowerCase();
    for (const b of BRANDS) expect(text, b).not.toMatch(new RegExp(`\\b${b}`));
  });
});
