import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Box3, PartGeometry, PartShapeContext, PartShapeDef, Vec3 } from "@platformcosmo/core";
import { MAX_PARAM_DIAGNOSTICS } from "../src/define.js";
import { hwShapes, paramSpecsOf, registry } from "../src/index.js";
import type { ParamSpec } from "../src/index.js";

type Params = Record<string, number | boolean | string>;
const AXES = ["x", "y", "z"] as const;
const shape = (id: string): PartShapeDef => registry.get(`hw:${id}`) as PartShapeDef;
const ctx = (size: Vec3): PartShapeContext => ({
  size,
  units: "mm",
  axis: "z",
  tone: "base",
  state: "healthy",
});
const r2 = (n: number): number => Math.round(n * 100) / 100;
const scaled = (d: Vec3, f: readonly [number, number, number]): Vec3 => ({
  x: r2(d.x * f[0]),
  y: r2(d.y * f[1]),
  z: r2(d.z * f[2]),
});
const specsOf = (s: PartShapeDef): [string, ParamSpec][] => [
  ...(paramSpecsOf(s.id) as ReadonlyMap<string, ParamSpec>),
];

/** Defaults, each param alone at EVERY allowed value, and the min/max/bool combinations. */
function paramSets(s: PartShapeDef): Params[] {
  const out: Params[] = [{}];
  for (const [k, sp] of specsOf(s)) {
    const vals: (number | boolean | string)[] =
      sp.kind === "int"
        ? Array.from({ length: sp.max - sp.min + 1 }, (_, i) => sp.min + i)
        : sp.kind === "bool"
          ? [true, false]
          : [...sp.values];
    for (const v of vals) out.push({ [k]: v });
  }
  const combos: Params[] = [{}];
  for (const [k, sp] of specsOf(s)) {
    const vals =
      sp.kind === "int" ? [sp.min, sp.max] : sp.kind === "bool" ? [true, false] : sp.values;
    const next: Params[] = [];
    for (const o of combos) for (const v of vals) next.push({ ...o, [k]: v });
    combos.length = 0;
    combos.push(...next);
  }
  return [...out, ...combos];
}

function defaultSizeFor(s: PartShapeDef, p: Params): Vec3 {
  const d = s.defaultSize;
  return p["orientation"] === "upright" ? { x: d.z, y: d.y, z: d.x } : d;
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
      const a = ps[i]!;
      const b = ps[j]!;
      expect(overlaps(a.box, b.box), `${label}: ${a.id} intersects ${b.id}`).toBe(false);
    }
  }
}

const ODD = [
  [1, 1, 1],
  [0.5, 0.73, 1.37],
  [1.9, 1.01, 0.61],
  [0.97, 1.13, 1.77],
  [1.03, 0.51, 0.99],
] as const;

describe("no two primitives intersect with positive volume", () => {
  test.each(hwShapes.map((s) => [s.id, s] as const))("hw:%s", (_id, s) => {
    for (const p of paramSets(s)) {
      const base = defaultSizeFor(s, p);
      for (const f of ODD) {
        const size = scaled(base, f);
        const g = s.build(s.readParams(p).params, ctx(f === ODD[0] ? s.defaultSize : size));
        expectNoIntersections(g, `${s.id} ${JSON.stringify(p)} @${JSON.stringify(size)}`);
      }
    }
  });

  test("dimm at y = 2.02 (touching faces stay touching under rounding)", () => {
    const d = shape("dimm");
    for (const p of paramSets(d)) {
      const g = d.build(d.readParams(p).params, ctx({ x: 133.35, y: 2.02, z: 31.25 }));
      expectNoIntersections(g, `dimm ${JSON.stringify(p)}`);
    }
  });

  test("fan: every blade count 3..10 keeps blade boxes apart; 11 is rejected", () => {
    const f = shape("fan");
    for (let n = 3; n <= 10; n++) {
      expectNoIntersections(
        f.build({ ...f.defaults, blades: n }, ctx(f.defaultSize)),
        `blades ${n}`,
      );
    }
    expect(f.readParams({ blades: 11 }).diagnostics[0]?.code).toBe("assembly/shape-params");
    expect(f.readParams({ blades: 2 }).diagnostics).toHaveLength(1);
  });
});

describe("solid-core depthBox (section 9.6)", () => {
  const def = (id: string, p: Params = {}): PartGeometry => {
    const s = shape(id);
    return s.build(s.readParams(p).params, ctx(s.defaultSize));
  };
  const vol = (b: Box3): number => b.size.x * b.size.y * b.size.z;

  test.each(["board", "gpu-card", "pcie-card", "dimm", "psu", "chassis-2u", "riser"])(
    "hw:%s depthBox is strictly smaller than bounds",
    (id) => {
      const g = def(id);
      expect(vol(g.depthBox)).toBeLessThan(vol(g.bounds) - 1e-6);
    },
  );

  test("core boxes exclude fingers, pins, handles, ears and connectors", () => {
    const near = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(0.011);
    const board = def("board").depthBox;
    near(board.size.z, 1.6);
    near(board.size.x, 305);
    near(def("dimm").depthBox.origin.z, 3);
    near(def("gpu-card").depthBox.origin.z, 6);
    near(def("pcie-card").depthBox.origin.z, 6);
    near(def("psu").depthBox.size.y, 179);
    const ch = def("chassis-2u").depthBox;
    near(ch.origin.x, 17.5);
    near(ch.size.x, 447.6);
    const riser = def("riser").depthBox;
    near(riser.size.y, 1.6);
    near(riser.size.z, 100);
    near(def("e1s").depthBox.size.z, 7.5);
    near(def("lid").depthBox.size.z, 2.4);
  });

  test("a CPU or M.2 seated on the board is not enclosed by the board's depthBox", () => {
    const board = def("board");
    const inside = (b: Box3, o: Box3): boolean =>
      AXES.every(
        (k) =>
          b.origin[k] >= o.origin[k] - 1e-6 &&
          b.origin[k] + b.size[k] <= o.origin[k] + o.size[k] + 1e-6,
      );
    const seat = (g: PartGeometry, x: number, y: number): Box3 => ({
      origin: {
        x: x + g.depthBox.origin.x,
        y: y + g.depthBox.origin.y,
        z: 1.6 + g.depthBox.origin.z,
      },
      size: g.depthBox.size,
    });
    for (const [id, x, y] of [
      ["cpu", 60, 50],
      ["nvme-m2", 10, 10],
      ["heatsink", 40, 200],
    ] as const) {
      const part = seat(def(id), x, y);
      expect(inside(part, board.depthBox), `${id} vs depthBox`).toBe(false);
      // The full bounds (sockets, slots) WOULD have swallowed the CPU: the core is what saves it.
      if (id === "cpu") expect(inside(part, board.bounds)).toBe(true);
    }
  });
});

describe("depth halves of the open-top chassis", () => {
  test("no back-half primitive is in front of a front-half primitive on any axis", () => {
    const s = shape("chassis-2u");
    for (const p of paramSets(s)) {
      for (const f of ODD) {
        const g = s.build(s.readParams(p).params, ctx(scaled(s.defaultSize, f)));
        const by = new Map(g.primitives.map((q) => [q.id, q.box]));
        expect(g.split).toBeDefined();
        for (const bid of g.split!.back) {
          for (const fid of g.split!.front) {
            const b = by.get(bid) as Box3;
            const fr = by.get(fid) as Box3;
            for (const k of AXES) {
              expect(
                b.origin[k] >= fr.origin[k] + fr.size[k] - 1e-6,
                `${bid} (back) in front of ${fid} (front) on ${k}`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });

  test("ear-l sorts with the back half, ear-r with the front half", () => {
    const g = shape("chassis-2u").build({ ears: true }, ctx(shape("chassis-2u").defaultSize));
    expect(g.split?.back).toContain("ear-l");
    expect(g.split?.front).toContain("ear-r");
    expect(g.split?.back).not.toContain("ear-r");
  });
});

describe("fronts face +y", () => {
  const top = (g: PartGeometry): number => g.bounds.origin.y + g.bounds.size.y;
  const reachesFront = (id: string, prim: string, p: Params = {}): void => {
    const s = shape(id);
    const g = s.build(s.readParams(p).params, ctx(s.defaultSize));
    const q = g.primitives.find((x) => x.id === prim);
    expect(q, `${id}/${prim}`).toBeDefined();
    expect(Math.abs(q!.box.origin.y + q!.box.size.y - top(g))).toBeLessThan(0.011);
  };
  test("psu handle, e1s bezel, nic cages, chassis ears, fan grille", () => {
    reachesFront("psu", "handle");
    reachesFront("e1s", "bezel");
    reachesFront("nic-ocp3", "cage-0");
    reachesFront("chassis-2u", "ear-l");
    reachesFront("chassis-2u", "ear-r");
    reachesFront("fan", "bar-h", { grille: true });
    reachesFront("fan", "bar-v-lo", { grille: true });
    const psu = shape("psu").build({ handle: true }, ctx(shape("psu").defaultSize));
    const grille = psu.primitives.find((x) => x.id === "grille");
    expect(grille?.box.origin.y).toBe(0); // fan grille at the rear
  });
});

describe("e1s orientation", () => {
  const e = shape("e1s");
  test("upright swaps width and thickness (x <-> z)", () => {
    const flat = e.build({}, ctx(e.defaultSize));
    const up = e.build({ orientation: "upright" }, ctx(e.defaultSize));
    expect(flat.bounds.size).toEqual({ x: 33.75, y: 118.75, z: 9.5 });
    expect(up.bounds.size).toEqual({ x: 9.5, y: 118.75, z: 33.75 });
    const body = up.primitives.find((p) => p.id === "body")!;
    expect(body.box.size.x).toBeCloseTo(7.5, 2);
    expect(body.box.size.z).toBeCloseTo(33.75, 2);
    expectNoIntersections(up, "upright");
  });
  test("upright at an explicit size", () => {
    const up = e.build({ orientation: "upright" }, ctx({ x: 10, y: 118, z: 34 }));
    expect(up.bounds.size).toEqual({ x: 10, y: 118, z: 34 });
  });
  test("bad orientation is a diagnostic", () => {
    const r = e.readParams({ orientation: "sideways" });
    expect(r.diagnostics[0]?.code).toBe("assembly/shape-params");
    expect(r.params["orientation"]).toBe("flat");
  });
});

describe("assemblies.md section 19 examples", () => {
  const md = readFileSync(
    fileURLToPath(new URL("../../../docs/design/assemblies.md", import.meta.url)),
    "utf8",
  );
  interface Found {
    shape: string;
    size: [number, number, number];
    params: Params;
  }
  function collect(node: unknown, out: Found[]): void {
    if (Array.isArray(node)) node.forEach((n) => collect(n, out));
    else if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (
        typeof o["shape"] === "string" &&
        o["shape"].startsWith("hw:") &&
        Array.isArray(o["size"])
      ) {
        out.push({
          shape: o["shape"],
          size: o["size"] as [number, number, number],
          params: (o["params"] ?? {}) as Params,
        });
      }
      Object.values(o).forEach((v) => collect(v, out));
    }
  }
  const found: Found[] = [];
  for (const m of md.matchAll(/```json\n([\s\S]*?)```/g)) {
    try {
      collect(JSON.parse(m[1] as string), found);
    } catch {
      /* fragments are not specs */
    }
  }

  test("the doc uses a good spread of hw: shapes", () => {
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(new Set(found.map((f) => f.shape)).size).toBeGreaterThanOrEqual(5);
  });

  test.each(found.map((f, i) => [`${f.shape} ${JSON.stringify(f.size)} #${i}`, f] as const))(
    "%s builds sensibly: long axis kept, no squashed PCB, no intersections",
    (_name, f) => {
      const s = registry.get(f.shape) as PartShapeDef;
      expect(s, f.shape).toBeDefined();
      const r = s.readParams(f.params);
      expect(r.diagnostics).toEqual([]);
      const size = { x: f.size[0], y: f.size[1], z: f.size[2] };
      const g = s.build(r.params, ctx(size));
      const nat = s.build(r.params, ctx(s.defaultSize)).bounds.size; // oriented default
      for (const k of AXES) {
        expect(Math.abs(g.bounds.size[k] - size[k])).toBeLessThan(0.011);
        const ratio = size[k] / nat[k];
        expect(ratio, `${f.shape} ${k} scale`).toBeGreaterThanOrEqual(0.5);
        expect(ratio, `${f.shape} ${k} scale`).toBeLessThanOrEqual(2);
      }
      const maxNat = Math.max(nat.x, nat.y, nat.z);
      const longest = AXES.filter((k) => nat[k] >= 0.95 * maxNat); // ties count together
      expect(Math.max(...longest.map((k) => size[k]))).toBeGreaterThanOrEqual(
        0.95 * Math.max(size.x, size.y, size.z),
      );
      for (const q of g.primitives) {
        if (q.id === "pcb" || q.id === "substrate") {
          expect(Math.min(q.box.size.x, q.box.size.y, q.box.size.z)).toBeGreaterThanOrEqual(0.8);
        }
      }
      expectNoIntersections(g, f.shape);
    },
  );
});

describe("never throws", () => {
  test.each(hwShapes.map((s) => [s.id, s] as const))("hw:%s", (_id, s) => {
    const tiny = [
      { x: 0.001, y: 1e-9, z: 0.005 },
      { x: 0.01, y: 0.01, z: 0.01 },
    ];
    for (const size of tiny) {
      const g = s.build(s.defaults, ctx(size));
      for (const q of g.primitives) {
        for (const k of AXES) {
          expect(q.box.origin[k]).toBeGreaterThanOrEqual(0);
          expect(q.box.size[k]).toBeGreaterThanOrEqual(0.01);
          expect(Number.isFinite(q.box.origin[k] + q.box.size[k])).toBe(true);
        }
      }
    }
    const weird = [null, undefined, 5, "x", true, [], [1, 2], Object.create(null), () => 1];
    for (const w of weird) {
      expect(() => s.build(w as never, ctx(s.defaultSize))).not.toThrow();
      expect(() => s.readParams(w as never)).not.toThrow();
    }
    expect(JSON.stringify(s.build(5 as never, ctx(s.defaultSize)))).toBe(
      JSON.stringify(s.build(s.defaults, ctx(s.defaultSize))),
    );
  });

  test("non-object params are a diagnostic, nullish are defaults", () => {
    const s = shape("dimm");
    for (const bad of [5, "x", true, []]) {
      const r = s.readParams(bad as never);
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0]?.path).toBe("/params");
    }
    expect(s.readParams(undefined as never).diagnostics).toEqual([]);
    expect(s.readParams(null as never).diagnostics).toEqual([]);
  });

  test("hostile values do not break diagnostics", () => {
    const s = shape("dimm");
    const bad = {
      chips: Object.create(null),
      spreader: {
        toString() {
          throw new Error("boom");
        },
      },
    };
    const r = s.readParams(bad as never);
    expect(r.diagnostics).toHaveLength(2);
    expect(s.readParams({ chips: Symbol("s") } as never).diagnostics).toHaveLength(1);
    expect(s.readParams({ chips: 10n } as never).diagnostics).toHaveLength(1);
    expect(s.readParams({ chips: () => 1 } as never).diagnostics).toHaveLength(1);
  });

  test("diagnostics are capped and keys truncated in the path", () => {
    const s = shape("dimm");
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`zz${i}`, i]));
    const r = s.readParams(many);
    expect(r.diagnostics).toHaveLength(MAX_PARAM_DIAGNOSTICS + 1);
    expect(r.diagnostics.at(-1)?.message).toContain("80 more");
    const long = s.readParams({ ["k".repeat(5000)]: 1 }).diagnostics[0];
    expect(long?.path.length).toBeLessThanOrEqual(80);
  });

  test("allocation does not scale with params: a hostile count builds the default", () => {
    const s = shape("heatsink");
    const g = s.build({ fins: 2 ** 31 } as never, ctx(s.defaultSize));
    expect(g.primitives.length).toBe(21);
  });
});
