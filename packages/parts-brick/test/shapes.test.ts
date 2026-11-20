import { describe, expect, test } from "vitest";
import type {
  Box3,
  PartGeometry,
  PartPrimitive,
  PartShapeContext,
  PartShapeDef,
  Vec2,
  Vec3,
} from "@platformcosmo/core";
import {
  createProjection,
  partGeometryFaces,
  partPrimitiveSilhouette,
  STUD_DIAMETER,
  STUD_HEIGHT,
} from "@platformcosmo/core";
import {
  brickPack,
  brickShapes,
  MAX_EXTENT,
  MAX_STUDS,
  paletteNames,
  paramSpecsOf,
  registry,
} from "../src/index.js";
import type { ParamSpec } from "../src/index.js";

type Params = Record<string, boolean | string>;
const AXES = ["x", "y", "z"] as const;
const proj = createProjection();
const shape = (id: string): PartShapeDef => registry.get(`brick:${id}`) as PartShapeDef;
const ctx = (size: Vec3, over: Partial<PartShapeContext> = {}): PartShapeContext => ({
  size,
  units: "stud",
  axis: "z",
  tone: "base",
  state: "healthy",
  ...over,
});
const sz = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const build = (id: string, p: Params, size: Vec3, over: Partial<PartShapeContext> = {}) => {
  const s = shape(id);
  return s.build(s.readParams(p).params, ctx(size, over));
};
const studsOf = (g: PartGeometry): PartPrimitive[] => g.primitives.filter((p) => p.kind === "stud");
const bodyOf = (g: PartGeometry): PartPrimitive[] => g.primitives.filter((p) => p.kind !== "stud");

/** Every param alone at every value, plus the min/max/bool combinations. */
function paramSets(s: PartShapeDef): Params[] {
  const specs = [...(paramSpecsOf(s.id) as ReadonlyMap<string, ParamSpec>)];
  const vals = (sp: ParamSpec): (boolean | string)[] =>
    sp.kind === "bool" ? [true, false] : [...sp.values];
  const out: Params[] = [{}];
  for (const [k, sp] of specs) for (const v of vals(sp)) out.push({ [k]: v });
  let combos: Params[] = [{}];
  for (const [k, sp] of specs) {
    const pick =
      sp.kind === "bool" ? [true, false] : [sp.values[0] as string, sp.values.at(-1) as string];
    combos = combos.flatMap((o) => pick.map((v) => ({ ...o, [k]: v })));
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
      const a = ps[i] as PartPrimitive;
      const b = ps[j] as PartPrimitive;
      expect(overlaps(a.box, b.box), `${label}: ${a.id} intersects ${b.id}`).toBe(false);
    }
  }
}

function inside(inner: Box3, outer: Box3, eps = 1e-9): boolean {
  return AXES.every(
    (k) =>
      inner.origin[k] >= outer.origin[k] - eps &&
      inner.origin[k] + inner.size[k] <= outer.origin[k] + outer.size[k] + eps,
  );
}

function unionOf(prims: readonly PartPrimitive[]): Box3 {
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of prims) {
    for (const k of AXES) {
      lo[k] = Math.min(lo[k], p.box.origin[k]);
      hi[k] = Math.max(hi[k], p.box.origin[k] + p.box.size[k]);
    }
  }
  return { origin: lo, size: { x: hi.x - lo.x, y: hi.y - lo.y, z: hi.z - lo.z } };
}

const near = (a: number, b: number, eps = 0.011): void => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Invariants every built geometry must satisfy. */
function check(label: string, g: PartGeometry): void {
  const ids = g.primitives.map((p) => p.id);
  expect(new Set(ids).size, `${label} unique primitive ids`).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[a-z0-9_.-]+$/);
  for (const p of g.primitives) {
    for (const k of AXES) expect(p.box.size[k], `${label}/${p.id} ${k}`).toBeGreaterThan(0);
    expect(inside(p.box, g.bounds), `${label}/${p.id} inside bounds`).toBe(true);
  }
  expect(inside(g.depthBox, g.bounds), `${label} depthBox within bounds`).toBe(true);
  // bounds is exactly the union of everything drawn; depthBox exactly the union of the body
  const all = unionOf(g.primitives);
  const body = unionOf(bodyOf(g));
  for (const k of AXES) {
    near(g.bounds.origin[k], all.origin[k], 1e-9);
    near(g.bounds.size[k], all.size[k], 1e-6);
    near(g.depthBox.origin[k], body.origin[k], 1e-9);
    near(g.depthBox.size[k], body.size[k], 1e-6);
  }
  expect(g.solid).toBe(true);
  expect(g.split).toBeUndefined();
  // A1-1 invariant: each face name at most once per primitive
  for (const pf of partGeometryFaces(g, proj)) {
    const names = pf.faces.map((f) => `${f.half ?? ""}:${f.face}`);
    expect(new Set(names).size, `${label}/${pf.primitive.id} face names`).toBe(names.length);
  }
}

describe("pack", () => {
  test("lists the five brick: shapes in stud units", () => {
    expect(brickPack.id).toBe("brick");
    expect(brickShapes.map((s) => s.id)).toEqual(["brick", "plate", "tile", "round", "slope"]);
    expect(registry.list()).toEqual(
      ["brick", "plate", "round", "slope", "tile"].map((i) => `brick:${i}`),
    );
    expect(registry.get("brick:slope")?.id).toBe("slope");
    expect(registry.get("brick:nope")).toBeUndefined();
    expect(registry.get("slope")).toBeUndefined();
    for (const s of brickShapes) expect(s.defaultUnits).toBe("stud");
    expect(shape("brick").defaultSize).toEqual(sz(2, 4, 3));
    expect(shape("plate").defaultSize).toEqual(sz(2, 4, 1));
  });
});

describe.each(brickShapes.map((s) => [s.id, s] as const))("brick:%s", (id, s) => {
  test("every param combination builds valid geometry at the default size", () => {
    for (const p of paramSets(s)) {
      const r = s.readParams(p);
      expect(r.diagnostics).toEqual([]);
      check(`${id} ${JSON.stringify(p)}`, s.build(r.params, ctx(s.defaultSize)));
    }
  });

  test("fills its size exactly (body) and stays inside it", () => {
    const size = sz(3, 5, 2);
    const g = s.build(s.defaults, ctx(size));
    check(`${id} 3x5x2`, g);
    for (const k of AXES) {
      near(g.depthBox.origin[k], 0, 1e-9);
      near(g.depthBox.size[k], size[k], 1e-9);
    }
  });

  test("no two primitives intersect, at defaults and at odd sizes", () => {
    const odd = [
      [1, 1, 1],
      [1.5, 2.25, 1.5],
      [0.5, 0.73, 1.37],
      [3, 3, 3],
      [2.01, 4.99, 3.01],
      [7, 1, 6],
      [1.03, 0.51, 0.99],
    ] as const;
    for (const p of paramSets(s)) {
      expectNoIntersections(s.build(s.readParams(p).params, ctx(s.defaultSize)), `${id} default`);
      for (const [x, y, z] of odd) {
        const g = s.build(s.readParams(p).params, ctx(sz(x, y, z)));
        check(`${id} ${JSON.stringify(p)} @${x}x${y}x${z}`, g);
        expectNoIntersections(g, `${id} ${JSON.stringify(p)} @${x}x${y}x${z}`);
      }
    }
  });

  test("deterministic: same inputs, identical output", () => {
    for (const p of paramSets(s)) {
      const a = JSON.stringify(s.build(s.readParams(p).params, ctx(sz(3, 4, 2))));
      const b = JSON.stringify(s.build(s.readParams({ ...p }).params, ctx(sz(3, 4, 2))));
      expect(a).toBe(b);
    }
  });

  test("never throws: bad size and bad params fall back to defaults", () => {
    const base = JSON.stringify(s.build(s.defaults, ctx(s.defaultSize)));
    const bad = [
      { x: NaN, y: -1, z: 0 },
      { x: Infinity, y: undefined, z: "9" },
    ] as unknown as Vec3[];
    for (const size of bad) {
      expect(JSON.stringify(s.build(s.defaults, ctx(size)))).toBe(base);
    }
    const junk = Object.fromEntries(
      [...(paramSpecsOf(s.id) as ReadonlyMap<string, ParamSpec>).keys()].map((k) => [k, 1e9]),
    );
    expect(JSON.stringify(s.build(junk as never, ctx(s.defaultSize)))).toBe(base);
    expect(() => s.build(null as never, undefined as never)).not.toThrow();
  });

  test("huge sizes are clamped and draw no studs (cap before allocation)", () => {
    const t = performance.now();
    const g = s.build({ ...s.defaults, studs: true }, ctx(sz(1e30, 1e30, 1e30)));
    expect(performance.now() - t).toBeLessThan(2000);
    expect(g.bounds.size.x).toBeLessThanOrEqual(MAX_EXTENT);
    expect(studsOf(g)).toHaveLength(0);
    expect(g.primitives.length).toBeLessThanOrEqual(MAX_STUDS + 20);
  });

  test("spec color paints every primitive; the paint param applies only without one", () => {
    const g = s.build(s.defaults, ctx(sz(2, 2, 3), { color: "#112233" }));
    expect(g.primitives.every((p) => p.color === "#112233")).toBe(true);
    const painted = s.build({ ...s.defaults, paint: "red" }, ctx(sz(2, 2, 3)));
    expect(painted.primitives.every((p) => p.color === "#c8352f")).toBe(true);
    const both = s.build(
      { ...s.defaults, paint: "red" },
      ctx(sz(2, 2, 3), { color: "palette:blue" }),
    );
    expect(both.primitives.every((p) => p.color === "palette:blue")).toBe(true);
    expect(
      s.build(s.defaults, ctx(sz(2, 2, 3))).primitives.every((p) => p.color === undefined),
    ).toBe(true);
  });

  test("tone passes through to every primitive", () => {
    const g = s.build(s.defaults, ctx(sz(2, 2, 3), { tone: "glass" }));
    expect(g.primitives.every((p) => p.tone === "glass")).toBe(true);
  });
});

describe("bounds and depthBox", () => {
  test("studs extend bounds by one stud height but not depthBox", () => {
    for (const [id, size] of [
      ["brick", sz(2, 4, 3)],
      ["plate", sz(6, 6, 1)],
      ["round", sz(2, 2, 3)],
      ["slope", sz(2, 4, 3)],
      ["slope", sz(1.5, 2, 3)],
    ] as const) {
      const g = build(id, { studs: true }, size);
      if (id === "slope" && size.x < 2) {
        // no flat run, no studs
        expect(g.bounds).toEqual(g.depthBox);
        continue;
      }
      expect(g.depthBox, `${id} depthBox`).toEqual({ origin: sz(0, 0, 0), size });
      near(g.bounds.size.z, size.z + STUD_HEIGHT);
      expect(g.bounds.size.x).toBe(size.x);
      expect(g.bounds.size.y).toBe(size.y);
      expect(studsOf(g).length).toBeGreaterThan(0);
      for (const st of studsOf(g)) {
        near(st.box.origin.z, size.z, 1e-9); // stands on the top face
        near(st.box.size.z, STUD_HEIGHT);
      }
    }
  });

  test("without studs bounds equal depthBox", () => {
    for (const id of ["brick", "plate", "tile", "round", "slope"]) {
      const g = build(id, { studs: false }, shape(id).defaultSize);
      expect(g.bounds).toEqual(g.depthBox);
      expect(studsOf(g)).toHaveLength(0);
    }
  });

  test("a brick stacked on another is not enclosed by the lower brick's depthBox", () => {
    const lower = build("brick", {}, sz(2, 4, 3));
    const upper = build("brick", {}, sz(2, 2, 3));
    // upper seated at z = 3 over the lower brick
    const seated: Box3 = {
      origin: { x: 0, y: 0, z: 3 + upper.depthBox.origin.z },
      size: upper.depthBox.size,
    };
    expect(inside(seated, lower.depthBox)).toBe(false);
    // The lower bounds (with studs) WOULD have swallowed the base of the upper brick's studs.
    expect(inside({ origin: { x: 0, y: 0, z: 3 }, size: sz(2, 2, 0.5) }, lower.bounds)).toBe(true);
    expect(lower.depthBox.origin.z + lower.depthBox.size.z).toBe(seated.origin.z);
  });

  test("studs come after the body they stand on in painter's order", () => {
    const g = build("plate", {}, sz(4, 4, 1));
    const body = g.primitives.findIndex((p) => p.id === "body");
    g.primitives.forEach((p, i) => {
      if (p.kind === "stud") expect(i).toBeGreaterThan(body);
    });
  });
});

describe("studs", () => {
  test("one per whole stud, ids stud-<col>-<row>, section 5.1 diameter and height", () => {
    const g = build("brick", {}, sz(2, 4, 3));
    const studs = studsOf(g);
    expect(studs).toHaveLength(8);
    expect(new Set(studs.map((s) => s.id))).toEqual(
      new Set(Array.from({ length: 8 }, (_, i) => `stud-${(i % 2) + 1}-${Math.floor(i / 2) + 1}`)),
    );
    for (const s of studs) {
      expect(s.axis).toBe("z");
      near(s.box.size.x, STUD_DIAMETER);
      near(s.box.size.y, STUD_DIAMETER);
    }
    expect(STUD_DIAMETER).toBeCloseTo(0.6, 9); // 4.8 mm of 8
    expect(STUD_HEIGHT).toBeCloseTo(1.7 / 3.2, 9);
  });

  test("tile has none; studs:true on a tile gives a plate-like top; non-integers floor", () => {
    expect(studsOf(build("tile", {}, sz(4, 4, 1)))).toHaveLength(0);
    expect(studsOf(build("tile", { studs: true }, sz(2, 2, 1)))).toHaveLength(4);
    expect(studsOf(build("brick", {}, sz(2.9, 1.5, 3)))).toHaveLength(2);
    expect(studsOf(build("brick", {}, sz(0.9, 4, 3)))).toHaveLength(0);
  });

  test("round: studs inside the footprint ellipse only, none on a side axis", () => {
    expect(studsOf(build("round", {}, sz(1, 1, 3)))).toHaveLength(1);
    expect(studsOf(build("round", {}, sz(2, 2, 3)))).toHaveLength(4);
    expect(studsOf(build("round", {}, sz(4, 4, 3)))).toHaveLength(12); // corners cut
    expect(studsOf(build("round", {}, sz(1, 2, 5), { axis: "x" }))).toHaveLength(0);
    const wheel = build("round", {}, sz(1, 2, 5), { axis: "x" });
    expect(wheel.primitives).toHaveLength(1);
    expect(wheel.primitives[0]?.axis).toBe("x");
    expect(wheel.bounds.size).toEqual(sz(1, 2, 5));
  });

  test("slope: studs only on the flat first stud of the run", () => {
    const g = build("slope", {}, sz(2, 4, 3));
    expect(studsOf(g)).toHaveLength(4);
    for (const s of studsOf(g)) expect(s.box.origin.x + s.box.size.x).toBeLessThanOrEqual(1);
    const ids = g.primitives.map((p) => p.id);
    expect(ids).toContain("high");
    expect(ids).toContain("slope");
    const wedge = g.primitives.find((p) => p.id === "slope") as PartPrimitive;
    expect(wedge.kind).toBe("wedge");
    expect(wedge.rotate).toBe(0); // high side at -x, against the studded block
    expect(wedge.box.origin.x).toBe(1);
    expect(studsOf(build("slope", {}, sz(1, 3, 3)))).toHaveLength(0);
  });

  test("inverted slope: flat studded top over a stepped underside", () => {
    const g = build("slope", { inverted: true }, sz(3, 2, 3));
    expect(studsOf(g)).toHaveLength(6);
    const steps = g.primitives.filter((p) => p.id.startsWith("step-"));
    expect(steps).toHaveLength(3);
    // every step reaches the flat top; the underside rises along +x
    for (const st of steps) near(st.box.origin.z + st.box.size.z, 3, 1e-9);
    const lifts = steps.map((st) => st.box.origin.z).sort((a, b) => a - b);
    expect(lifts[0]).toBe(0);
    expect(lifts[2]).toBeGreaterThan(lifts[1] as number);
    expect(g.depthBox.size).toEqual(sz(3, 2, 3));
    // very long slope: capped number of steps
    expect(
      build("slope", { inverted: true, studs: false }, sz(500, 2, 3)).primitives.length,
    ).toBeLessThanOrEqual(16);
  });

  test("stud count cap: 16 x 16 gets studs, 17 x 16 gets none", () => {
    expect(studsOf(build("plate", {}, sz(16, 16, 1)))).toHaveLength(MAX_STUDS);
    expect(studsOf(build("plate", {}, sz(17, 16, 1)))).toHaveLength(0);
    expect(MAX_STUDS).toBe(256);
  });
});

describe("stud screen non-overlap (section 5.1)", () => {
  /** True stud proportions: x, y in 8 mm studs, z in 3.2 mm plates, at 1 tile = 600 mm. */
  const MM = [8 / 600, 8 / 600, 3.2 / 600] as const;
  const toWorld = (p: PartPrimitive): PartPrimitive => ({
    ...p,
    box: {
      origin: {
        x: p.box.origin.x * MM[0],
        y: p.box.origin.y * MM[1],
        z: p.box.origin.z * MM[2],
      },
      size: { x: p.box.size.x * MM[0], y: p.box.size.y * MM[1], z: p.box.size.z * MM[2] },
    },
  });

  function separated(a: readonly Vec2[], b: readonly Vec2[]): boolean {
    for (const poly of [a, b]) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i] as Vec2;
        const q = poly[(i + 1) % poly.length] as Vec2;
        const nx = q.y - p.y;
        const ny = p.x - q.x;
        const proj = (pts: readonly Vec2[]): [number, number] => {
          const v = pts.map((t) => t.x * nx + t.y * ny);
          return [Math.min(...v), Math.max(...v)];
        };
        const [a0, a1] = proj(a);
        const [b0, b1] = proj(b);
        const len = Math.hypot(nx, ny);
        if (a1 - b0 <= 1e-6 * len || b1 - a0 <= 1e-6 * len) return true;
      }
    }
    return false;
  }

  test("no two studs of a part overlap on screen (6 x 6 plate, 4 x 4 round)", () => {
    for (const g of [build("plate", {}, sz(6, 6, 1)), build("round", {}, sz(4, 4, 3))]) {
      const hulls = studsOf(g).map((s) => partPrimitiveSilhouette(toWorld(s), proj).points);
      expect(hulls.length).toBeGreaterThan(10);
      for (let i = 0; i < hulls.length; i++) {
        for (let j = i + 1; j < hulls.length; j++) {
          expect(separated(hulls[i] as Vec2[], hulls[j] as Vec2[]), `studs ${i} and ${j}`).toBe(
            true,
          );
        }
      }
    }
  });

  test("the check can fail: a stud as wide as its pitch does overlap", () => {
    const fat = build("plate", {}, sz(2, 2, 1)).primitives.filter((p) => p.kind === "stud");
    const widen = (p: PartPrimitive): PartPrimitive => ({
      ...p,
      box: { origin: p.box.origin, size: { ...p.box.size, x: 1.4, y: 1.4 } },
    });
    const a = partPrimitiveSilhouette(toWorld(widen(fat[0] as PartPrimitive)), proj).points;
    const b = partPrimitiveSilhouette(toWorld(widen(fat[1] as PartPrimitive)), proj).points;
    expect(separated(a, b)).toBe(false);
  });
});

describe("readParams", () => {
  const slope = shape("slope");

  test("empty input yields the defaults and no diagnostics", () => {
    expect(slope.readParams({})).toEqual({ params: slope.defaults, diagnostics: [] });
    expect(slope.defaults).toEqual({ studs: true, inverted: false, paint: "default" });
    expect(shape("tile").defaults["studs"]).toBe(false);
  });

  test("unknown param: shape-params error with did-you-mean", () => {
    const r = slope.readParams({ invertd: true, studs: false });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "assembly/shape-params",
      path: "/params/invertd",
    });
    expect(r.diagnostics[0]?.suggestion).toContain("inverted");
    expect(r.params["studs"]).toBe(false);
    expect(r.params["inverted"]).toBe(false);
    expect(shape("brick").readParams({ stud: true }).diagnostics[0]?.suggestion).toContain("studs");
  });

  test("wrong type and bad enum are errors; the enum hint names the close colour", () => {
    const a = slope.readParams({ inverted: "yes" });
    expect(a.diagnostics[0]?.code).toBe("assembly/shape-params");
    expect(a.diagnostics[0]?.message).toContain("true or false");
    expect(a.params["inverted"]).toBe(false);
    const b = slope.readParams({ paint: "bleu" });
    expect(b.diagnostics[0]?.suggestion).toContain("blue");
    expect(b.params["paint"]).toBe("default");
    expect(slope.readParams({ paint: "red" }).diagnostics).toEqual([]);
  });

  test("non-object params, arrays and prototype-ish keys never throw", () => {
    for (const bad of [5, "x", [1], true]) {
      expect(slope.readParams(bad as never).diagnostics[0]?.code).toBe("assembly/shape-params");
    }
    expect(() => slope.readParams(Object.create(null) as never)).not.toThrow();
    const proto = JSON.parse('{"__proto__": 1, "constructor": 2}') as never;
    expect(slope.readParams(proto).diagnostics.length).toBe(2);
    expect(slope.readParams(null as never).diagnostics).toEqual([]);
  });

  test("diagnostics are capped", () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    const r = slope.readParams(many);
    expect(r.diagnostics.length).toBeLessThanOrEqual(21);
    expect(r.diagnostics.at(-1)?.message).toContain("more param problems omitted");
  });

  test("every palette name is accepted", () => {
    for (const n of paletteNames)
      expect(shape("brick").readParams({ paint: n }).diagnostics).toEqual([]);
  });
});
