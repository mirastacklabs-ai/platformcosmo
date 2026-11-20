import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Box3, PartGeometry, PartShapeContext, PartShapeDef, Vec3 } from "@platformcosmo/core";
import { createProjection, partGeometryFaces } from "@platformcosmo/core";
import { MAX_PARAM_DIAGNOSTICS } from "../src/define.js";
import { autoPack, autoShapes, MAX_EXTENT_MM, paramSpecsOf, registry } from "../src/index.js";
import type { ParamSpec } from "../src/index.js";

const ORDER = [
  "block-i4",
  "head",
  "valve-cover",
  "crankshaft",
  "camshaft",
  "piston",
  "rod",
  "valve",
  "oil-pan",
  "intake",
  "exhaust",
  "timing-belt",
];
const AXES = ["x", "y", "z"] as const;
const EPS = 0.011;
const proj = createProjection();
type Params = Record<string, number | boolean | string>;

const shape = (id: string): PartShapeDef => registry.get(`auto:${id}`) as PartShapeDef;
const ctx = (size: Vec3): PartShapeContext => ({
  size,
  units: "mm",
  axis: "z",
  tone: "base",
  state: "healthy",
});
const specsOf = (s: PartShapeDef): [string, ParamSpec][] => [
  ...(paramSpecsOf(s.id) as ReadonlyMap<string, ParamSpec>),
];
const r2 = (n: number): number => Math.round(n * 100) / 100;
const vol = (b: Box3): number => b.size.x * b.size.y * b.size.z;

/** Defaults, every single value of each param, and all min/max/bool/enum combinations. */
function paramSets(s: PartShapeDef): Params[] {
  const out: Params[] = [{}];
  const values = (sp: ParamSpec, edges: boolean): (number | boolean | string)[] =>
    sp.kind === "int"
      ? edges
        ? [sp.min, sp.max]
        : Array.from({ length: sp.max - sp.min + 1 }, (_, i) => sp.min + i)
      : sp.kind === "bool"
        ? [true, false]
        : [...sp.values];
  for (const [k, sp] of specsOf(s)) for (const v of values(sp, false)) out.push({ [k]: v });
  let combos: Params[] = [{}];
  for (const [k, sp] of specsOf(s)) {
    combos = combos.flatMap((o) => values(sp, true).map((v) => ({ ...o, [k]: v })));
  }
  return [...out, ...combos];
}

function overlaps(a: Box3, b: Box3): boolean {
  return AXES.every(
    (k) =>
      Math.min(a.origin[k] + a.size[k], b.origin[k] + b.size[k]) -
        Math.max(a.origin[k], b.origin[k]) >
      1e-6,
  );
}

function expectNoIntersections(g: PartGeometry, label: string): void {
  const ps = g.primitives;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      expect(overlaps(ps[i]!.box, ps[j]!.box), `${label}: ${ps[i]!.id} x ${ps[j]!.id}`).toBe(false);
    }
  }
}

function inside(inner: Box3, outer: Box3, eps = EPS): boolean {
  return AXES.every(
    (k) =>
      inner.origin[k] >= outer.origin[k] - eps &&
      inner.origin[k] + inner.size[k] <= outer.origin[k] + outer.size[k] + eps,
  );
}

function check(s: PartShapeDef, g: PartGeometry, size: Vec3): void {
  const ids = g.primitives.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeLessThanOrEqual(64);
  for (const id of ids) expect(id).toMatch(/^[a-z0-9_.-]+$/);
  for (const p of g.primitives) {
    expect(inside(p.box, { origin: { x: 0, y: 0, z: 0 }, size }), `${s.id}/${p.id}`).toBe(true);
    for (const k of AXES) expect(p.box.size[k]).toBeGreaterThan(0);
  }
  expect(inside(g.depthBox, g.bounds, 1e-9), `${s.id} depthBox within bounds`).toBe(true);
  expect(vol(g.depthBox)).toBeGreaterThan(0);
  for (const k of AXES) {
    expect(g.bounds.origin[k]).toBeCloseTo(
      Math.min(...g.primitives.map((p) => p.box.origin[k])),
      9,
    );
    expect(g.bounds.origin[k] + g.bounds.size[k]).toBeCloseTo(
      Math.max(...g.primitives.map((p) => p.box.origin[k] + p.box.size[k])),
      1,
    );
  }
  expect(g.solid).toBe(true);
  expect(g.split).toBeUndefined();
  // A1-1 invariant: each face name at most once per primitive
  for (const pf of partGeometryFaces(g, proj)) {
    const names = pf.faces.map((f) => `${f.half ?? ""}:${f.face}`);
    expect(new Set(names).size, `${s.id}/${pf.primitive.id} face names`).toBe(names.length);
  }
}

/** The scene's rule (A1-3): a solid fills its depthBox iff ANY one box/plate/card equals it. */
function bodyBox(g: PartGeometry): PartGeometry["primitives"][number] | undefined {
  return g.primitives.find(
    (p) =>
      ["box", "plate", "card"].includes(p.kind) &&
      AXES.every(
        (k) =>
          Math.abs(p.box.origin[k] - g.depthBox.origin[k]) < 1e-9 &&
          Math.abs(p.box.size[k] - g.depthBox.size[k]) < 1e-9,
      ),
  );
}
const fills = (g: PartGeometry): boolean => g.solid && bodyBox(g) !== undefined;
const HOUSINGS = ["block-i4", "head", "valve-cover", "oil-pan"];

const ODD = [
  [1, 1, 1],
  [0.5, 0.73, 1.37],
  [1.9, 1.01, 0.61],
  [0.97, 1.13, 1.77],
  [1.03, 0.51, 0.99],
  [0.37, 2.1, 0.5],
] as const;
const scaled = (d: Vec3, f: readonly number[]): Vec3 => ({
  x: r2(d.x * f[0]!),
  y: r2(d.y * f[1]!),
  z: r2(d.z * f[2]!),
});

describe("pack", () => {
  test("auto pack lists the 12 shapes of assemblies section 5, in order", () => {
    expect(autoPack.id).toBe("auto");
    expect(autoShapes.map((s) => s.id)).toEqual(ORDER);
    expect(registry.list()).toEqual(ORDER.map((i) => `auto:${i}`).sort());
    expect(registry.get("auto:piston")?.id).toBe("piston");
    expect(registry.get("auto:nope")).toBeUndefined();
    expect(registry.get("piston")).toBeUndefined();
    expect(registry.get("hw:piston")).toBeUndefined();
  });

  test("true-scale defaults in millimetres", () => {
    const size = (id: string) => shape(id).defaultSize;
    expect(size("block-i4")).toEqual({ x: 420, y: 230, z: 260 });
    expect(size("piston")).toEqual({ x: 82, y: 82, z: 66 });
    expect(size("rod")).toEqual({ x: 24, y: 50, z: 150 });
    expect(size("timing-belt")).toEqual({ x: 20, y: 200, z: 300 });
    for (const s of autoShapes) expect(s.defaultUnits).toBe("mm");
  });
});

describe.each(autoShapes.map((s) => [s.id, s] as const))("auto:%s", (_id, s) => {
  test("defaults fill the default size exactly", () => {
    const g = s.build(s.defaults, ctx(s.defaultSize));
    check(s, g, s.defaultSize);
    for (const k of AXES) {
      expect(g.bounds.origin[k]).toBe(0);
      expect(Math.abs(g.bounds.size[k] - s.defaultSize[k])).toBeLessThan(EPS);
    }
    expect(g.primitives.length).toBeGreaterThan(1);
  });

  test("every param value and combination builds valid geometry at odd sizes", () => {
    for (const p of paramSets(s)) {
      const r = s.readParams(p);
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      for (const f of ODD) {
        const size = f === ODD[0] ? s.defaultSize : scaled(s.defaultSize, f);
        const g = s.build(r.params, ctx(size));
        check(s, g, size);
        expectNoIntersections(g, `${s.id} ${JSON.stringify(p)} @${JSON.stringify(size)}`);
        if (f !== ODD[0] && p["kind"] !== "exhaust" && p["flange"] !== false) {
          // (an exhaust valve's head and a flange-less crankshaft are smaller than the default size)
          for (const k of AXES) expect(Math.abs(g.bounds.size[k] - size[k])).toBeLessThan(EPS);
        }
      }
    }
  });

  test("deterministic: same inputs, identical output", () => {
    for (const p of paramSets(s)) {
      const a = JSON.stringify(s.build(s.readParams(p).params, ctx(s.defaultSize)));
      const b = JSON.stringify(s.build(s.readParams({ ...p }).params, ctx(s.defaultSize)));
      expect(a).toBe(b);
    }
  });

  test("never throws: bad size and bad params fall back to defaults", () => {
    const base = JSON.stringify(s.build(s.defaults, ctx(s.defaultSize)));
    const badSize = [
      { x: NaN, y: -1, z: 0 },
      { x: Infinity, y: undefined, z: "9" },
    ] as unknown as Vec3[];
    for (const size of badSize) expect(JSON.stringify(s.build(s.defaults, ctx(size)))).toBe(base);
    const junk = Object.fromEntries(specsOf(s).map(([k]) => [k, 1e9]));
    expect(JSON.stringify(s.build(junk as never, ctx(s.defaultSize)))).toBe(base);
    for (const w of [null, undefined, 5, "x", true, [], Object.create(null), () => 1]) {
      expect(() => s.build(w as never, ctx(s.defaultSize))).not.toThrow();
      expect(() => s.readParams(w as never)).not.toThrow();
    }
    expect(() => s.build(null as never, ctx(undefined as never))).not.toThrow();
    for (const size of [
      { x: 0.001, y: 1e-9, z: 0.005 },
      { x: 0.01, y: 0.01, z: 0.01 },
    ]) {
      for (const q of s.build(s.defaults, ctx(size)).primitives) {
        for (const k of AXES) {
          expect(q.box.origin[k]).toBeGreaterThanOrEqual(0);
          expect(q.box.size[k]).toBeGreaterThanOrEqual(0.01);
        }
      }
    }
  });

  test("huge sizes are clamped; the maximum params stay within 40 primitives (cap 64)", () => {
    const huge = s.build(s.defaults, ctx({ x: 1e30, y: 1e30, z: 1e30 }));
    expect(huge.bounds.size.x).toBeLessThanOrEqual(MAX_EXTENT_MM);
    for (const p of paramSets(s)) {
      expect(
        s.build(s.readParams(p).params, ctx(s.defaultSize)).primitives.length,
      ).toBeLessThanOrEqual(40);
    }
  });

  test("spec color paints only the main body primitive(s)", () => {
    const g = s.build(s.defaults, { ...ctx(s.defaultSize), color: "#112233" });
    const painted = g.primitives.filter((p) => p.color === "#112233");
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.length).toBeLessThan(g.primitives.length);
  });

  test("a typo of the first param gets a did-you-mean", () => {
    const first = specsOf(s)[0]![0];
    const d = s.readParams({ [`${first}s`]: 1 }).diagnostics[0];
    expect(d?.code).toBe("assembly/shape-params");
    expect(d?.suggestion).toBe(`Did you mean "${first}"?`);
  });
});

describe("depthBox is the solid core (section 9.6), separate from bounds", () => {
  const def = (id: string, p: Params = {}): PartGeometry =>
    shape(id).build(shape(id).readParams(p).params, ctx(shape(id).defaultSize));
  const near = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(EPS);

  test.each(ORDER.filter((id) => !["piston", "rod", "valve"].includes(id)))(
    "auto:%s depthBox is strictly smaller than bounds",
    (id) => {
      const g = def(id);
      expect(vol(g.depthBox)).toBeLessThan(vol(g.bounds) - 1e-6);
    },
  );

  test("protrusions are excluded: lugs, ports, throws, lobes, flanges, pulleys", () => {
    const block = def("block-i4").depthBox;
    near(block.origin.y, 12);
    near(block.size.y, 206);
    const headBox = def("head").depthBox;
    near(headBox.origin.y, 12);
    near(headBox.size.y, 206);
    const crank = def("crankshaft").depthBox;
    near(crank.size.y, 50); // journals only: not the throws, webs or the 120 mm flange
    near(crank.size.z, 50);
    const cam = def("camshaft").depthBox;
    near(cam.size.y, 24);
    near(cam.size.z, 24);
    const cover = def("valve-cover").depthBox;
    near(cover.size.z, 60); // plug tubes and the filler cap stand above it
    const intake = def("intake").depthBox;
    near(intake.origin.y, 8); // mounting flange outside
    near(intake.origin.x, 24); // throttle stub outside
    const intakeNoThrottle = def("intake", { throttle: false }).depthBox;
    expect(vol(intakeNoThrottle)).toBeGreaterThan(vol(intake));
    const exh = def("exhaust").depthBox;
    near(exh.origin.y + exh.size.y, 82);
    const belt = def("timing-belt").depthBox;
    near(belt.origin.x, 2);
    near(belt.size.x, 16); // sprockets and tensioner outside
  });

  test("a head on the deck (z = 260) and an oil pan below are not enclosed by the block core", () => {
    const b = def("block-i4");
    const head = def("head");
    const pan = def("oil-pan");
    const at = (g: PartGeometry, x: number, y: number, z: number): Box3 => ({
      origin: {
        x: x + g.depthBox.origin.x,
        y: y + g.depthBox.origin.y,
        z: z + g.depthBox.origin.z,
      },
      size: g.depthBox.size,
    });
    const onDeck = at(head, 0, 0, 260);
    const below = at(pan, 0, 0, -90);
    for (const [name, box] of [
      ["head", onDeck],
      ["pan", below],
    ] as const) {
      expect(inside(box, b.depthBox), `${name} vs block core`).toBe(false);
      for (const q of b.primitives) expect(overlaps(box, q.box), `${name} x ${q.id}`).toBe(false);
    }
    // Control: a part really inside the core IS enclosed, so the check can fail.
    expect(inside(at(head, 0, 0, 100), b.depthBox)).toBe(true);
    // The core stops 1 mm under the deck (the bore plugs are the top millimetre).
    expect(b.depthBox.origin.z + b.depthBox.size.z).toBeCloseTo(259, 2);
    expect(b.bounds.origin.z + b.bounds.size.z).toBeCloseTo(260, 2);
  });

  test.each(["piston", "rod", "valve"])("%s: nothing protrudes, depthBox equals bounds", (id) => {
    const g = def(id);
    expect(g.depthBox).toEqual(g.bounds);
  });
});

describe("fills (A1-3): a housing occludes through one body box equal to its depthBox", () => {
  test.each(HOUSINGS)(
    "auto:%s has a single body box equal to depthBox, detailed or plain",
    (id) => {
      for (const detail of [true, false]) {
        const g = shape(id).build({ detail }, ctx(shape(id).defaultSize));
        const bodies = g.primitives.filter((p) => bodyBox(g) === p);
        expect(bodies, `${id} detail=${detail}`).toHaveLength(1);
        expect(bodies[0]?.kind).toBe("box");
        expect(fills(g)).toBe(true);
        if (detail) expect(g.primitives.length).toBeGreaterThan(1);
      }
    },
  );

  test("the body box equals depthBox at odd sizes too", () => {
    for (const id of HOUSINGS) {
      for (const f of ODD) {
        const s = shape(id);
        const g = s.build(s.defaults, ctx(scaled(s.defaultSize, f)));
        expect(bodyBox(g), `${id} @${f}`).toBeDefined();
      }
    }
  });

  test("every other shape never fills", () => {
    for (const s of autoShapes.filter((x) => !HOUSINGS.includes(x.id))) {
      for (const p of paramSets(s)) {
        const g = s.build(s.readParams(p).params, ctx(s.defaultSize));
        expect(fills(g), `${s.id} ${JSON.stringify(p)}`).toBe(false);
      }
    }
  });

  test("at most 40 primitives anywhere, reached by crankshaft and camshaft at 8 cylinders", () => {
    let max = 0;
    for (const s of autoShapes) {
      for (const p of paramSets(s)) {
        max = Math.max(max, s.build(s.readParams(p).params, ctx(s.defaultSize)).primitives.length);
      }
    }
    expect(max).toBe(40);
  });

  test("roles: housing body, covers, internals; bolt-on manifolds and the head have none", () => {
    expect(shape("block-i4").role).toBe("body");
    for (const id of ["oil-pan", "valve-cover", "timing-belt"])
      expect(shape(id).role).toBe("cover");
    for (const id of ["crankshaft", "camshaft", "piston", "rod", "valve"]) {
      expect(shape(id).role).toBe("internal");
    }
    for (const id of ["head", "intake", "exhaust"]) expect(shape(id).role).toBeUndefined();
  });
});

describe("orientation", () => {
  test("engine length runs along x; intake +y, exhaust -y, crank pin throws alternate in z", () => {
    const e = (id: string) => shape(id).build({}, ctx(shape(id).defaultSize));
    expect(e("block-i4").bounds.size.x).toBe(420);
    const intake = e("intake").primitives.find((p) => p.id === "plenum")!;
    const exhaust = e("exhaust").primitives.find((p) => p.id === "collector")!;
    expect(intake.box.origin.y).toBeGreaterThan(50); // plenum far from the head face at y 0
    expect(exhaust.box.origin.y).toBe(0); // collector far from the head face at y max
    const pin = (i: number) => e("crankshaft").primitives.find((p) => p.id === `pin-${i}`)!;
    expect([0, 1, 2, 3].map((i) => pin(i).box.origin.z < 60)).toEqual([true, false, false, true]);
    // The block's bores follow the cylinder count.
    const bores = shape("block-i4").build({ cylinders: 6 }, ctx(shape("block-i4").defaultSize));
    expect(bores.primitives.filter((p) => p.id.startsWith("bore-"))).toHaveLength(6);
  });

  test("bore is true mm, clamped to the pitch, and stays round under anisotropic sizes", () => {
    const s = shape("block-i4");
    const bore = (p: Params, size: Vec3, i = 0) =>
      s.build(s.readParams(p).params, ctx(size)).primitives.find((q) => q.id === `bore-${i}`)!;
    const clamped = bore({ cylinders: 8, bore: 110 }, s.defaultSize);
    expect(clamped.box.size.x).toBeCloseTo(42, 1); // floor(0.8 * 52.5)
    expect(clamped.box.size.y).toBeCloseTo(42, 1);
    expect(bore({ cylinders: 4, bore: 80 }, s.defaultSize).box.size.x).toBeCloseTo(80, 1);
    for (const size of [
      { x: 840, y: 115, z: 260 },
      { x: 300, y: 460, z: 130 },
      { x: 420, y: 230, z: 260 },
    ]) {
      const q = bore({ cylinders: 4, bore: 58 }, size);
      expect(q.box.size.x, JSON.stringify(size)).toBeCloseTo(58, 0);
      expect(q.box.size.y, JSON.stringify(size)).toBeCloseTo(58, 0);
    }
    // The pitch follows the actual length: an 80 mm bore fits at 840 mm, is clamped at 210 mm.
    expect(bore({ cylinders: 8, bore: 80 }, { x: 840, y: 230, z: 260 }).box.size.x).toBeCloseTo(
      80,
      0,
    );
    expect(bore({ cylinders: 8, bore: 80 }, { x: 210, y: 230, z: 260 }).box.size.x).toBeCloseTo(
      21,
      0,
    );
    // Bores are centred in equal cells and never touch.
    const g = s.build({ cylinders: 5 }, ctx({ x: 500, y: 230, z: 260 }));
    const bs = g.primitives.filter((q) => q.id.startsWith("bore-"));
    bs.forEach((q, i) => expect(q.box.origin.x + q.box.size.x / 2).toBeCloseTo(50 + i * 100, 1));
    expectNoIntersections(g, "bores");
  });
});

describe("readParams", () => {
  const blk = shape("block-i4");

  test("empty input yields the defaults and no diagnostics", () => {
    expect(blk.readParams({})).toEqual({ params: blk.defaults, diagnostics: [] });
    expect(blk.defaults).toEqual({ cylinders: 4, bore: 82, detail: true });
  });

  test("unknown param: shape-params error with did-you-mean", () => {
    const r = blk.readParams({ cylinder: 6, bore: 80 });
    expect(r.params).toEqual({ cylinders: 4, bore: 80, detail: true });
    const d = r.diagnostics[0];
    expect(r.diagnostics).toHaveLength(1);
    expect(d?.code).toBe("assembly/shape-params");
    expect(d?.severity).toBe("error");
    expect(d?.path).toBe("/params/cylinder");
    expect(d?.suggestion).toBe('Did you mean "cylinders"?');
    expect(d?.message).toContain("auto:block-i4");
  });

  test.each([
    ["cylinders", 1],
    ["cylinders", 9],
    ["cylinders", 4.5],
    ["cylinders", "4"],
    ["cylinders", Number.NaN],
    ["bore", 49],
    ["bore", 111],
    ["bore", 1e9],
    ["detail", "yes"],
    ["detail", 1],
  ])("invalid value %s=%j is rejected and the default is kept", (key, value) => {
    const r = blk.readParams({ [key]: value });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.code).toBe("assembly/shape-params");
    expect(r.diagnostics[0]?.path).toBe(`/params/${key}`);
    expect(r.params).toEqual(blk.defaults);
  });

  test("bounds are inclusive and enums are checked", () => {
    expect(blk.readParams({ cylinders: 2, bore: 50 }).diagnostics).toEqual([]);
    expect(blk.readParams({ cylinders: 4, bore: 84 }).diagnostics).toEqual([]);
    expect(shape("valve").readParams({ kind: "exhaust" }).diagnostics).toEqual([]);
    const bad = shape("valve").readParams({ kind: "sideways" });
    expect(bad.diagnostics[0]?.code).toBe("assembly/shape-params");
    expect(bad.params["kind"]).toBe("intake");
    expect(shape("head").readParams({ valves: 5 }).diagnostics).toHaveLength(1);
    expect(shape("head").readParams({ valves: 1 }).diagnostics).toHaveLength(1);
  });

  test("a bore that exceeds the clamp warns with the effective bore; defaults never warn", () => {
    const d = blk.readParams({ cylinders: 8, bore: 110 }).diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0]?.severity).toBe("warning");
    expect(d[0]?.code).toBe("assembly/shape-params");
    expect(d[0]?.path).toBe("/params/bore");
    expect(d[0]?.message).toContain("effective bore is 42 mm");
    // The minimum bore does not fit eight cylinders either: warn, draw the clamp.
    expect(blk.readParams({ cylinders: 8, bore: 50 }).diagnostics[0]?.severity).toBe("warning");
    expect(blk.readParams({ cylinders: 6, bore: 50 }).diagnostics).toEqual([]); // 50 <= 56
    expect(blk.readParams({ cylinders: 8 }).diagnostics).toEqual([]); // default bore: silent clamp
    expect(blk.readParams({ cylinders: 5, bore: 67 }).diagnostics).toEqual([]);
    expect(blk.readParams({ cylinders: 5, bore: 68 }).diagnostics).toHaveLength(1);
    // An invalid bore is an error only, not also a warning.
    expect(blk.readParams({ bore: 500 }).diagnostics.map((x) => x.severity)).toEqual(["error"]);
  });

  test("hostile keys and values do not pollute, throw or leak", () => {
    const r = blk.readParams(JSON.parse('{"__proto__": 1, "a/b": 2, "constructor": 3}'));
    expect(r.diagnostics.map((d) => d.path)).toEqual([
      "/params/__proto__",
      "/params/a~1b",
      "/params/constructor",
    ]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    const hostile = {
      cylinders: Object.create(null),
      detail: {
        toString() {
          throw new Error("boom");
        },
      },
    };
    expect(blk.readParams(hostile as never).diagnostics).toHaveLength(2);
    expect(blk.readParams({ bore: Symbol("s") } as never).diagnostics).toHaveLength(1);
    expect(blk.readParams({ bore: 10n } as never).diagnostics).toHaveLength(1);
    for (const bad of [5, "x", true, []]) {
      const d = blk.readParams(bad as never).diagnostics;
      expect(d).toHaveLength(1);
      expect(d[0]?.path).toBe("/params");
    }
    expect(blk.readParams(null as never).diagnostics).toEqual([]);
  });

  test("diagnostics are capped and long keys truncated", () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`zz${i}`, i]));
    const r = blk.readParams(many);
    expect(r.diagnostics).toHaveLength(MAX_PARAM_DIAGNOSTICS + 1);
    expect(r.diagnostics.at(-1)?.message).toContain("80 more");
    const long = blk.readParams({ ["k".repeat(5000)]: 1 }).diagnostics[0];
    expect(long?.path.length).toBeLessThanOrEqual(80);
    expect(long?.message.length).toBeLessThan(300);
  });

  test("every diagnostic code is assembly/shape-params (section 18)", () => {
    for (const s of autoShapes) {
      for (const d of s.readParams({
        nope: 1,
        ...Object.fromEntries(specsOf(s).map(([k]) => [k, 1e9])),
      }).diagnostics) {
        expect(d.code).toBe("assembly/shape-params");
      }
    }
  });

  test("allocation does not scale with params: a hostile count builds the default", () => {
    const s = shape("crankshaft");
    const g = s.build({ cylinders: 2 ** 31, flange: true } as never, ctx(s.defaultSize));
    expect(g.primitives.length).toBe(s.build(s.defaults, ctx(s.defaultSize)).primitives.length);
  });
});

describe("assemblies.md section 19.3 engine", () => {
  // The example builds its engine from primitives (no `auto:` refs). Each part still has an
  // auto: counterpart: build it at the example's exact size and require a valid, sane result.
  const md = readFileSync(
    fileURLToPath(new URL("../../../docs/design/assemblies.md", import.meta.url)),
    "utf8",
  );
  interface Found {
    type: string;
    size: [number, number, number];
  }
  function collect(node: unknown, out: Found[], refs: string[]): void {
    if (Array.isArray(node)) node.forEach((n) => collect(n, out, refs));
    else if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o["shape"] === "string" && o["shape"].startsWith("auto:")) refs.push(o["shape"]);
      if (typeof o["type"] === "string" && Array.isArray(o["size"])) {
        out.push({ type: o["type"], size: o["size"] as [number, number, number] });
      }
      Object.values(o).forEach((v) => collect(v, out, refs));
    }
  }
  const idOf = (type: string): string => (type === "block" ? "block-i4" : type);
  const found: Found[] = [];
  const refs: string[] = [];
  const at = md.indexOf("### 19.3");
  const end = md.indexOf("### 19.4");
  for (const m of md.slice(at, end).matchAll(/```json\n([\s\S]*?)```/g)) {
    collect(JSON.parse(m[1] as string), found, refs);
  }

  test("any auto: ref in the example resolves; every part type has a shape", () => {
    for (const r of refs) expect(registry.get(r), r).toBeDefined();
    expect(found.length).toBeGreaterThanOrEqual(10);
    for (const f of found) {
      if (f.type === "casting") continue;
      expect(registry.get(`auto:${idOf(f.type)}`), f.type).toBeDefined();
    }
  });

  test.each(
    found
      .filter((f) => registry.get(`auto:${idOf(f.type)}`))
      .map((f, i) => [`${f.type} ${JSON.stringify(f.size)} #${i}`, f] as const),
  )("auto:%s builds at the exact size, no intersections", (_name, f) => {
    const s = registry.get(`auto:${idOf(f.type)}`) as PartShapeDef;
    const size = { x: f.size[0], y: f.size[1], z: f.size[2] };
    for (const p of paramSets(s)) {
      const g = s.build(s.readParams(p).params, ctx(size));
      check(s, g, size);
      if (p["kind"] !== "exhaust" && p["flange"] !== false)
        for (const k of AXES) expect(Math.abs(g.bounds.size[k] - size[k])).toBeLessThan(EPS);
      expectNoIntersections(g, `${f.type} ${JSON.stringify(p)}`);
    }
  });
});

describe("deny-list", () => {
  const BRANDS = [
    "toyota",
    "honda",
    "nissan",
    "ford",
    "chevrolet",
    "gm",
    "bmw",
    "mercedes",
    "audi",
    "volkswagen",
    "porsche",
    "ferrari",
    "mazda",
    "subaru",
    "hyundai",
    "kia",
    "cosworth",
    "bosch",
    "denso",
    "mahle",
    "garrett",
    "borgwarner",
    "ecoboost",
    "vtec",
    "hemi",
    "duratec",
    "skyactiv",
    "lego",
    "nvidia",
    "intel",
  ];
  test("no id, label, type, param, enum value or primitive id carries a brand", () => {
    const enums = autoShapes.flatMap((s) =>
      specsOf(s).flatMap(([, sp]) => (sp.kind === "enum" ? sp.values : [])),
    );
    const primIds = autoShapes.flatMap((s) =>
      paramSets(s).flatMap((p) =>
        s.build(s.readParams(p).params, ctx(s.defaultSize)).primitives.map((q) => q.id),
      ),
    );
    expect(enums.length).toBeGreaterThan(0);
    expect(primIds.length).toBeGreaterThan(100);
    const text = [autoPack.id, autoPack.name, ...enums, ...primIds]
      .concat(autoShapes.flatMap((s) => [s.id, s.label, s.type, ...specsOf(s).map(([k]) => k)]))
      .join(" ")
      .toLowerCase();
    for (const b of BRANDS) expect(text, b).not.toMatch(new RegExp(`\\b${b}\\b`));
  });
});
