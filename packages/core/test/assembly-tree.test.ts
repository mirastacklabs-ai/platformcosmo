import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type {
  Box3,
  PartShapeDef,
  PartShapeRegistry,
  SceneAssembly,
  SceneAssemblyNode,
} from "../src/index.js";
import { buildScene } from "../src/index.js";
import { STUD_DIAMETER, STUD_HEIGHT, studGrid } from "../src/geometry/parts.js";
import {
  ASSEMBLY_GAP,
  assemblyFocusTargets,
  assemblyNodes,
  buildAssemblies,
  mergeSceneAssemblies,
} from "../src/scene/assembly/tree.js";
import {
  belowGroundLift,
  frameMap,
  makeFrame,
  resolveScale,
  trueScale,
  turnFront,
} from "../src/scene/assembly/frame.js";
import { classifySiblings, type LBox, type RoleItem } from "../src/scene/assembly/roles.js";
import { AssemblyModel } from "../src/schema/assembly-tree.js";
import type { PlatformCosmoSpec } from "../src/schema/types.gen.js";

// A2-2: assembly tree and frames (docs/design/assemblies.md §4, §5, §9.5, §10, §13).

type Obj = Record<string, unknown>;
type Opts = Parameters<typeof buildAssemblies>[1];
const META = { version: "1" };
const spec = (o: Obj): PlatformCosmoSpec => ({ meta: META, ...o }) as unknown as PlatformCosmoSpec;
const asms = (assemblies: unknown[], opts: Opts = {}) =>
  buildAssemblies(spec({ assemblies }), opts);
const one = (parts: unknown[], extra: Obj = {}, opts: Opts = {}) => {
  const r = asms([{ id: "a", units: "tile", parts, ...extra }], opts);
  expect(r.assemblies).toHaveLength(1);
  return r.assemblies[0] as SceneAssembly;
};
const node = (a: SceneAssembly, path: string): SceneAssemblyNode => {
  const n = assemblyNodes(a).find((x) => x.path === path);
  expect(
    n,
    `node ${path} in ${assemblyNodes(a)
      .map((x) => x.path)
      .join(",")}`,
  ).toBeDefined();
  return n as SceneAssemblyNode;
};
const o3 = (b: Box3): number[] => [b.origin.x, b.origin.y, b.origin.z];
const s3 = (b: Box3): number[] => [b.size.x, b.size.y, b.size.z];

const examples = (file: string): Obj[] => {
  const md = readFileSync(new URL(`../../../docs/design/${file}`, import.meta.url), "utf8");
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .filter((s) => typeof s.meta === "object");
};
const engineSpec = (): Obj =>
  examples("assemblies.md").find((s) =>
    (s.meta as { title: string }).title.startsWith("Inline-4"),
  ) as Obj;
const engineAssembly = (): Obj => structuredClone((engineSpec().assemblies as Obj[])[0] as Obj);

// ------------------------------------------------------------------------------------ expansion

describe("expansion: count, pitch, use", () => {
  test("count expands to <id>-1..n offset by pitch; sub-assemblies repeat with their children", () => {
    const a = one([
      { id: "cyl", count: 3, pitch: [10, 0, 0], at: [1, 2, 3], size: [4, 4, 4] },
      {
        id: "pr",
        count: 2,
        pitch: [0, 20, 0],
        parts: [
          { id: "piston", at: [1, 1, 1], size: [2, 2, 2] },
          { id: "rod", at: [1, 1, 3], size: [1, 1, 5] },
        ],
      },
      { id: "solo", count: 1, at: [50, 0, 0], size: [1, 1, 1] },
    ]);
    expect(a.root.children.map((c) => c.id)).toEqual([
      "cyl-1",
      "cyl-2",
      "cyl-3",
      "pr-1",
      "pr-2",
      "solo",
    ]);
    expect(o3(node(a, "a/cyl-1").local)).toEqual([1, 2, 3]);
    expect(o3(node(a, "a/cyl-2").local)).toEqual([11, 2, 3]);
    expect(o3(node(a, "a/cyl-3").local)).toEqual([21, 2, 3]);
    expect(o3(node(a, "a/pr-1/piston").local)).toEqual([1, 1, 1]);
    expect(o3(node(a, "a/pr-2/piston").local)).toEqual([1, 21, 1]);
    expect(o3(node(a, "a/pr-2/rod").local)).toEqual([1, 21, 3]);
    expect(s3(node(a, "a/pr-2").local)).toEqual([2, 2, 7]);
    expect(a.leaves).toEqual([
      "a/cyl-1",
      "a/cyl-2",
      "a/cyl-3",
      "a/pr-1/piston",
      "a/pr-1/rod",
      "a/pr-2/piston",
      "a/pr-2/rod",
      "a/solo",
    ]);
  });

  test("ids that collide after expansion keep the first (validation reports the rest)", () => {
    const a = one([
      { id: "a", count: 2, pitch: [5, 0, 0], size: [1, 1, 1] },
      { id: "a-1", at: [0, 9, 0], size: [3, 3, 3] },
    ]);
    expect(a.root.children.map((c) => c.id)).toEqual(["a-1", "a-2"]);
    expect(s3(node(a, "a/a-1").local)).toEqual([1, 1, 1]);
  });

  test("use instances the template under the path; size scales it, at re-anchors it", () => {
    const r = asms([
      {
        id: "wheel",
        template: true,
        units: "tile",
        parts: [
          { id: "hub", at: [1, 1, 0], size: [2, 2, 2] },
          { id: "rim", at: [3, 1, 0], size: [2, 2, 2] },
        ],
      },
      {
        id: "car",
        units: "tile",
        parts: [
          { id: "w", use: "wheel", count: 2, pitch: [10, 0, 0], at: [5, 0, 0], size: [8, 4, 4] },
          { id: "plain", use: "wheel", at: [0, 20, 0] },
        ],
      },
    ]);
    expect(r.assemblies.map((x) => x.id)).toEqual(["car"]); // templates are not listed
    const car = r.assemblies[0] as SceneAssembly;
    expect(car.leaves).toEqual([
      "car/w-1/hub",
      "car/w-1/rim",
      "car/w-2/hub",
      "car/w-2/rim",
      "car/plain/hub",
      "car/plain/rim",
    ]);
    // template bounds [1,5]x[1,3]x[0,2] scaled to [8,4,4] at (5,0,0): f = (2,2,2)
    expect(o3(node(car, "car/w-1").local)).toEqual([5, 0, 0]);
    expect(s3(node(car, "car/w-1").local)).toEqual([8, 4, 4]);
    expect(o3(node(car, "car/w-1/hub").local)).toEqual([5, 0, 0]);
    expect(s3(node(car, "car/w-1/hub").local)).toEqual([4, 4, 4]);
    expect(o3(node(car, "car/w-2/rim").local)).toEqual([19, 0, 0]);
    // no size: template coordinates re-anchored at `at`
    expect(o3(node(car, "car/plain/hub").local)).toEqual([0, 20, 0]);
    expect(s3(node(car, "car/plain/hub").local)).toEqual([2, 2, 2]);
  });

  test("use converts between units (template in mm inside an assembly in cm)", () => {
    const r = asms([
      { id: "t", template: true, units: "mm", parts: [{ id: "p", size: [100, 50, 20] }] },
      { id: "h", units: "cm", parts: [{ id: "i", use: "t" }] },
    ]);
    const h = r.assemblies[0] as SceneAssembly;
    expect(s3(node(h, "h/i/p").local)).toEqual([10, 5, 2]);
  });

  test("a use cycle or an unknown template is an empty group, never a loop or a throw", () => {
    const r = asms([
      {
        id: "x",
        units: "tile",
        parts: [
          { id: "u", use: "y" },
          { id: "k", size: [1, 1, 1] },
        ],
      },
      { id: "y", units: "tile", parts: [{ id: "u", use: "x" }] },
      {
        id: "z",
        units: "tile",
        parts: [
          { id: "u", use: "nope", size: [2, 2, 2] },
          { id: "s", use: "z" },
        ],
      },
    ]);
    const x = r.assemblies.find((a) => a.id === "x") as SceneAssembly;
    expect(x.leaves).toEqual(["x/k"]);
    const z = r.assemblies.find((a) => a.id === "z") as SceneAssembly;
    expect(z.leaves).toEqual([]);
    expect(node(z, "z/u").kind).toBe("sub");
  });

  test("scene ids equal the validation tree's ids for every design example", () => {
    let checked = 0;
    for (const ex of examples("assemblies.md")) {
      const s = spec(ex);
      const model = new AssemblyModel(s);
      const built = buildAssemblies(s);
      for (const a of built.assemblies) {
        const root = model.root(a.id);
        expect(root, a.id).toBeDefined();
        const expected = model.flat(root!).map((f) => `${a.id}/${f.path}`);
        expect(
          assemblyNodes(a)
            .slice(1)
            .map((n) => n.path),
          a.id,
        ).toEqual(expected);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  test("every design-example assembly builds cleanly with finite boxes inside its bounds", () => {
    for (const ex of examples("assemblies.md")) {
      const built = buildAssemblies(spec(ex));
      expect(built.diagnostics).toEqual([]);
      for (const a of built.assemblies) {
        expect(a.leaves.length).toBeGreaterThan(0);
        for (const n of assemblyNodes(a)) {
          for (const v of [...o3(n.world), ...s3(n.world)]) expect(Number.isFinite(v)).toBe(true);
          if (n.kind === "leaf") {
            const r = a.restBounds;
            expect(n.world.origin.x).toBeGreaterThanOrEqual(r.origin.x - 1e-6);
            expect(n.world.origin.z).toBeGreaterThanOrEqual(0);
            expect(n.world.origin.x + n.world.size.x).toBeLessThanOrEqual(
              r.origin.x + r.size.x + 1e-6,
            );
          }
        }
      }
    }
  });
});

describe("budgets: nothing sized by input is built before the cap check", () => {
  test("count 64 nested seven deep returns at once with no assembly", () => {
    let parts: unknown = [{ id: "g", count: 64, size: [1, 1, 1] }];
    for (const id of ["f", "e", "d", "c", "b", "a"]) parts = [{ id, count: 64, parts }];
    const t0 = Date.now();
    const r = asms([{ id: "big", parts }]);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.assemblies).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  test("the spec-wide leaf budget skips what does not fit, in spec order", () => {
    const heavy = (id: string) => ({
      id,
      parts: [{ id: "p", count: 64, parts: [{ id: "q", count: 20, size: [1, 1, 1] }] }],
    }); // 1280 leaves
    const r = asms([
      heavy("a"),
      heavy("b"), // no budget left
      { id: "c", parts: [{ id: "p", count: 10, size: [1, 1, 1] }] },
    ]);
    expect(r.assemblies.map((a) => a.id)).toEqual(["a", "c"]);
    // a single assembly over 2000 leaves is never built
    const over = asms([
      {
        id: "o",
        parts: [{ id: "p", count: 64, parts: [{ id: "q", count: 40, size: [1, 1, 1] }] }],
      },
    ]);
    expect(over.assemblies).toEqual([]);
  });

  test("paths stay within the 8-segment limit like the validation tree", () => {
    let parts: unknown = [{ id: "leaf", size: [1, 1, 1] }];
    for (let k = 0; k < 9; k++) parts = [{ id: `l${k}`, parts }];
    const a = one(parts as unknown[]);
    const depth = Math.max(...assemblyNodes(a).map((n) => n.path.split("/").length));
    expect(depth).toBe(8);
    expect(a.leaves).toEqual([]); // the leaf lies below the limit and is cut
  });

  test("a sibling group over the inference cap skips inferred relations", () => {
    const parts = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({
      id: `r${k}`,
      count: 64,
      pitch: [1, 0, 0],
      at: [0, k, 0],
      size: [1, 1, 1],
    }));
    const t0 = Date.now();
    const a = one(parts);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(a.leaves).toHaveLength(512);
    expect(assemblyNodes(a).every((n) => n.mates === undefined && n.inserts === undefined)).toBe(
      true,
    );
    expect(node(a, "a/r0-2").role).toBe("internal");
  });
});

// ------------------------------------------------------------------------------------ rotations

describe("quarter-turn rotations", () => {
  test("a part turns about its own centre and keeps its min corner; 180 keeps the size", () => {
    const mk = (rotate: number) => one([{ id: "p", at: [10, 20, 5], size: [4, 2, 1], rotate }]);
    for (const [r, size] of [
      [0, [4, 2, 1]],
      [90, [2, 4, 1]],
      [180, [4, 2, 1]],
      [270, [2, 4, 1]],
    ] as const) {
      const p = node(mk(r), "a/p");
      expect(o3(p.local)).toEqual([10, 20, 5]);
      expect(s3(p.local)).toEqual(size);
      expect(s3(p.geometry!.depthBox)).toEqual(size);
    }
  });

  test("a sub-assembly rotates its children as one unit about its centre", () => {
    const a = one([
      {
        id: "s",
        rotate: 90,
        parts: [
          { id: "a", at: [0, 0, 0], size: [4, 2, 1] },
          { id: "b", at: [4, 0, 0], size: [2, 2, 1] },
        ],
      },
    ]);
    expect(o3(node(a, "a/s").local)).toEqual([0, 0, 0]);
    expect(s3(node(a, "a/s").local)).toEqual([2, 6, 1]);
    expect(o3(node(a, "a/s/a").local)).toEqual([0, 0, 0]);
    expect(s3(node(a, "a/s/a").local)).toEqual([2, 4, 1]);
    expect(o3(node(a, "a/s/b").local)).toEqual([0, 4, 0]);
    expect(s3(node(a, "a/s/b").local)).toEqual([2, 2, 1]);
  });

  test("180 and 270 on a sub-assembly, and four nested quarter turns are the identity", () => {
    const parts = [
      { id: "a", at: [0, 0, 0], size: [4, 2, 1] },
      { id: "b", at: [4, 0, 0], size: [2, 2, 1] },
    ];
    const r180 = one([{ id: "s", rotate: 180, parts }]);
    expect(o3(node(r180, "a/s/a").local)).toEqual([2, 0, 0]);
    expect(o3(node(r180, "a/s/b").local)).toEqual([0, 0, 0]);
    const r270 = one([{ id: "s", rotate: 270, parts }]);
    expect(s3(node(r270, "a/s").local)).toEqual([2, 6, 1]);
    expect(o3(node(r270, "a/s/a").local)).toEqual([0, 2, 0]);
    expect(o3(node(r270, "a/s/b").local)).toEqual([0, 0, 0]);
    const four = one([
      {
        id: "s1",
        rotate: 90,
        parts: [
          {
            id: "s2",
            rotate: 90,
            parts: [{ id: "s3", rotate: 90, parts: [{ id: "s4", rotate: 90, parts }] }],
          },
        ],
      },
    ]);
    expect(o3(node(four, "a/s1/s2/s3/s4/a").local)).toEqual([0, 0, 0]);
    expect(s3(node(four, "a/s1/s2/s3/s4/a").local)).toEqual([4, 2, 1]);
    expect(o3(node(four, "a/s1/s2/s3/s4/b").local)).toEqual([4, 0, 0]);
  });

  test("x and y circular axes swap on a quarter turn; wedge slopes turn with the part", () => {
    const a = one([
      { id: "shaft", shape: "shaft", axis: "x", size: [10, 2, 2], rotate: 90 },
      { id: "up", shape: "shaft", axis: "z", size: [2, 2, 5], at: [0, 20, 0], rotate: 90 },
      { id: "w", shape: "wedge", size: [4, 2, 2], at: [0, 40, 0], rotate: 90 },
      {
        id: "g",
        rotate: 90,
        at: [0, 60, 0],
        parts: [{ id: "w2", shape: "wedge", size: [4, 2, 2] }],
      },
    ]);
    const prim = (p: string) => node(a, p).geometry!.primitives[0]!;
    expect(prim("a/shaft").axis).toBe("y");
    expect(prim("a/up").axis).toBe("z");
    expect(prim("a/w").rotate).toBe(90);
    expect(prim("a/g/w2").rotate).toBe(90);
    expect(s3(node(a, "a/g/w2").local)).toEqual([2, 4, 2]);
  });

  test("tray halves follow the rotated box (geometry is built post-rotation)", () => {
    const a = one([{ id: "t", shape: "tray", size: [8, 4, 2], rotate: 90 }]);
    const g = node(a, "a/t").geometry!;
    expect(s3(g.bounds)).toEqual([4, 8, 2]);
    expect(g.solid).toBe(false);
    expect(g.split?.back).toHaveLength(3);
    expect(g.split?.front).toHaveLength(2);
  });

  test("the assembly rotate turns the unit; bounds re-anchor at the origin; front follows", () => {
    const parts = [
      { id: "a", at: [0, 0, 0], size: [4, 2, 1] },
      { id: "b", at: [4, 0, 0], size: [2, 1, 1] },
    ];
    const r0 = one(parts);
    const r90 = one(parts, { rotate: 90, front: "+y" });
    expect(s3(r0.restBounds)).toEqual([6, 2, 1]);
    expect(s3(r90.restBounds)).toEqual([2, 6, 1]);
    expect(o3(r90.restBounds)).toEqual([0, 0, 0]);
    expect(o3(node(r90, "a/a").world)).toEqual([0, 0, 0]);
    expect(s3(node(r90, "a/a").world)).toEqual([2, 4, 1]);
    expect(o3(node(r90, "a/b").world)).toEqual([1, 4, 0]);
    expect(s3(node(r90, "a/b").world)).toEqual([1, 2, 1]);
    expect(r90.frame.rotate).toBe(90);
    expect(r90.frame.front).toBe("-x");
    expect(turnFront("+x", 270)).toBe("-y");
    expect(turnFront("-y", 180)).toBe("+y");
    expect(turnFront("+y", 0)).toBe("+y");
  });

  test("frameMap maps points for every quarter turn", () => {
    const lb: Box3 = { origin: { x: 10, y: 20, z: 3 }, size: { x: 6, y: 2, z: 1 } };
    const mapped = ([0, 90, 180, 270] as const).map((rotate) => {
      const f = makeFrame({ units: "tile", rotate, localBounds: lb, origin: { x: 1, y: 2, z: 3 } });
      return frameMap(f, lb).point({ x: 10, y: 20, z: 3 });
    });
    expect(mapped).toEqual([
      { x: 1, y: 2, z: 3 },
      { x: 3, y: 2, z: 3 },
      { x: 7, y: 4, z: 3 },
      { x: 1, y: 8, z: 3 },
    ]);
  });
});

// ----------------------------------------------------------------------------- units, fit, scale

describe("frame: units, fit and true scale", () => {
  const parts = [
    { id: "a", at: [0, 0, 0], size: [1200, 600, 100] },
    { id: "b", at: [0, 0, 100], size: [600, 300, 50] },
  ];
  const mm = (extra: Obj = {}, opts: Opts = {}) => one(parts, { units: "mm", ...extra }, opts);

  test("fit scales the largest horizontal extent to fit tiles (default 6)", () => {
    const d = mm();
    expect(d.frame.scale.x).toBeCloseTo(6 / 1200, 12);
    expect(d.frame.scale.y).toBeCloseTo(d.frame.scale.x, 12);
    expect(d.frame.scale.z).toBeCloseTo(d.frame.scale.x, 12);
    expect(d.restBounds.size.x).toBeCloseTo(6, 6);
    expect(d.restBounds.size.y).toBeCloseTo(3, 6);
    const f3 = mm({ fit: 3 });
    expect(f3.restBounds.size.x).toBeCloseTo(3, 6);
    expect(f3.frame.scale.x).toBeCloseTo(3 / 1200, 12);
    const tall = one([{ id: "a", size: [100, 400, 10] }], { units: "mm", fit: 4 });
    expect(tall.restBounds.size.y).toBeCloseTo(4, 6);
  });

  test("tile units ignore fit", () => {
    const t = one([{ id: "a", size: [3, 2, 1] }], { fit: 40 });
    expect(t.frame.scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(s3(t.restBounds)).toEqual([3, 2, 1]);
  });

  test("true scale (DC slot context): 1 tile = 600 mm and fit is ignored", () => {
    const d = mm({ fit: 40 }, { trueScale: true });
    expect(d.frame.scale.x).toBeCloseTo(1 / 600, 12);
    expect(d.restBounds.size.x).toBeCloseTo(2, 6);
    expect(trueScale("cm").x).toBeCloseTo(10 / 600, 12);
    expect(resolveScale("mm", 6, { x: 1200, y: 1, z: 1 }, true).x).toBeCloseTo(1 / 600, 12);
  });

  test("true scale: a 2U device is 88.9 mm and a 19-inch rack 482.6 mm wide", () => {
    const r = one(
      [
        { id: "rack", at: [0, 0, 0], size: [19, 38, 3.5 * 21] }, // inches: 19 in wide, 21 U tall
        { id: "dev", at: [0, 0, 0], size: [17.5, 30, 3.5] }, // a 2U device (3.5 in)
      ],
      { units: "in", fit: 40 },
      { trueScale: true },
    );
    expect(node(r, "a/rack").world.size.x * 600).toBeCloseTo(482.6, 3);
    expect(node(r, "a/dev").world.size.z * 600).toBeCloseTo(88.9, 3);
    const m = one([{ id: "u2", size: [450, 700, 88.9] }], { units: "mm" }, { trueScale: true });
    expect(node(m, "a/u2").world.size.z * 600).toBeCloseTo(88.9, 4);
    expect(node(m, "a/u2").world.size.x * 600).toBeCloseTo(450, 4);
  });

  test("stud units are anisotropic (8 x 8 x 3.2 mm) and studs stay round", () => {
    const brick: PartShapeDef = {
      id: "brick",
      label: "Brick",
      type: "brick",
      defaultSize: { x: 2, y: 2, z: 3 },
      defaultUnits: "stud",
      defaults: {},
      readParams: () => ({ params: {}, diagnostics: [] }),
      build: (_p, ctx) => {
        const host: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: ctx.size };
        const studs = studGrid({ host, cols: ctx.size.x, rows: ctx.size.y, tone: ctx.tone });
        const body = { id: "body", kind: "box" as const, box: host, tone: ctx.tone };
        return {
          primitives: [body, ...studs],
          bounds: { origin: host.origin, size: { ...host.size, z: host.size.z + STUD_HEIGHT } },
          depthBox: host,
          solid: true,
        };
      },
    };
    const registry: PartShapeRegistry = {
      get: (ref) => (ref === "t:brick" ? brick : undefined),
      list: () => ["t:brick"],
    };
    const r = one(
      [{ id: "b", shape: "t:brick", size: [4, 2, 3] }],
      { units: "stud", fit: 6 },
      { parts: registry },
    );
    const f = r.frame;
    expect(f.scale.x).toBeCloseTo(6 / 4, 12); // 4 studs = 32 mm over 6 tiles
    expect(f.scale.y).toBeCloseTo(f.scale.x, 12);
    expect(f.scale.z / f.scale.x).toBeCloseTo(3.2 / 8, 12);
    const stud = node(r, "a/b").geometry!.primitives.find((p) => p.kind === "stud")!;
    const wx = stud.box.size.x * f.scale.x;
    const wy = stud.box.size.y * f.scale.y;
    const wz = stud.box.size.z * f.scale.z;
    expect(wx).toBeCloseTo(wy, 12); // round in the plane
    expect(wx).toBeCloseTo(STUD_DIAMETER * f.scale.x, 12);
    expect(wz / wx).toBeCloseTo(1.7 / 4.8, 9); // real proportions: 1.7 mm tall, 4.8 mm wide
    // body 4 x 2 x 3 plates = 32 x 16 x 9.6 mm
    const w = node(r, "a/b").world;
    expect(w.size.x / w.size.z).toBeCloseTo(32 / 9.6, 9);
    expect(w.size.y / w.size.z).toBeCloseTo(16 / 9.6, 9);
    // studs extend the rest bounds above the depth box
    expect(r.restBounds.size.z).toBeCloseTo(w.size.z + STUD_HEIGHT * f.scale.z, 6);
    // a pack shape's default size is converted between units: 2 x 2 x 3 studs/plates in mm
    const dflt = one([{ id: "b", shape: "t:brick" }], { units: "mm" }, { parts: registry });
    expect(s3(node(dflt, "a/b").local)).toEqual([16, 16, 9.6]);
  });

  test("degenerate extents fall back to true scale instead of dividing by zero", () => {
    expect(resolveScale("mm", 6, { x: 0, y: 0, z: 1 }, false)).toEqual(trueScale("mm"));
    expect(resolveScale("mm", 6, { x: NaN, y: 0, z: 1 }, false)).toEqual(trueScale("mm"));
  });
});

// --------------------------------------------------------------------------------------- roles

describe("roles, mates and inserts inference", () => {
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): LBox => ({
    x0,
    y0,
    z0,
    x1,
    y1,
    z1,
  });

  test("a lid on a tray: a cover mating the tray, which is a shell", () => {
    const a = one([
      { id: "tray", shape: "tray", at: [0, 0, 0], size: [100, 60, 20] },
      { id: "lid", type: "lid", at: [0, 0, 20], size: [100, 60, 2] },
    ]);
    expect(node(a, "a/lid").mates).toBe("a/tray");
    expect(node(a, "a/lid").role).toBe("cover");
    expect(node(a, "a/tray").role).toBe("shell");
    expect(node(a, "a/tray").mates).toBeUndefined(); // the larger partner does not mate back
    expect(node(a, "a/lid").inserts).toBeUndefined();
  });

  test("a pan under a block mates it (engine example without its explicit relations)", () => {
    const e = engineAssembly();
    for (const p of e.parts as Obj[]) {
      delete p.mates;
      delete p.role;
    }
    const a = buildAssemblies(spec({ assemblies: [e] })).assemblies[0] as SceneAssembly;
    expect(node(a, "engine/oil-pan").mates).toBe("engine/block");
    expect(node(a, "engine/block").role).toBe("body");
    expect(node(a, "engine/oil-pan").role).toBe("cover");
    expect(node(a, "engine/valve-cover").role).toBe("cover");
    expect(node(a, "engine/timing-belt").role).toBe("cover"); // thin, outer, touching the body
    expect(node(a, "engine/crankshaft").role).toBe("internal");
    expect(node(a, "engine/block").mates).toBeUndefined();
    // the example's explicit values give the same
    const explicit = buildAssemblies(spec({ assemblies: [engineAssembly()] })).assemblies[0]!;
    expect(node(explicit, "engine/oil-pan").mates).toBe("engine/block");
    expect(node(explicit, "engine/oil-pan").role).toBe("cover");
  });

  test("a valve through a head: inserted into the casting through its top face", () => {
    const e = engineAssembly();
    const head = (e.parts as Obj[]).find((p) => p.id === "head") as Obj;
    delete (head.parts as Obj[])[1]!.inserts;
    const a = buildAssemblies(spec({ assemblies: [e] })).assemblies[0] as SceneAssembly;
    for (let k = 1; k <= 8; k++) {
      expect(node(a, `engine/head/valve-${k}`).inserts, `valve-${k}`).toBe("engine/head/casting");
    }
    expect(node(a, "engine/head/casting").inserts).toBeUndefined();
    const explicit = buildAssemblies(spec({ assemblies: [engineAssembly()] })).assemblies[0]!;
    expect(node(explicit, "engine/head/valve-3").inserts).toBe("engine/head/casting");
  });

  const item = (path: string, b: LBox, solid = true): RoleItem => ({
    path,
    kind: "leaf",
    box: b,
    solid,
  });
  const inserted = (items: RoleItem[], path: string): string | undefined =>
    classifySiblings(items).get(path)?.inserts;

  test("inserts needs exactly one face plane of one solid with the footprint inside the face", () => {
    const block = item("b", box(0, 0, 0, 10, 10, 10));
    expect(inserted([block, item("p", box(4, 4, 8, 6, 6, 14))], "p")).toBe("b"); // top face
    expect(inserted([block, item("p", box(4, 4, 2, 6, 6, 8))], "p")).toBeUndefined(); // enclosed
    expect(inserted([block, item("p", box(4, 4, -2, 6, 6, 14))], "p")).toBeUndefined(); // two planes
    expect(inserted([block, item("p", box(8, 4, 8, 12, 6, 14))], "p")).toBeUndefined(); // off the face
    expect(inserted([block, item("p", box(8, 4, 4, 14, 6, 6))], "p")).toBe("b"); // side entry
    expect(
      inserted([{ ...block, solid: false }, item("p", box(4, 4, 8, 6, 6, 14))], "p"),
    ).toBeUndefined(); // an open tray is not a solid
  });

  test("a face covered by a touching solid is interior to the block, not an entry", () => {
    const casting = item("c", box(0, 0, 0, 10, 10, 10));
    const cover = item("v", box(0, 0, 10, 10, 10, 14));
    expect(inserted([casting, cover, item("p", box(4, 4, 8, 6, 6, 12))], "p")).toBeUndefined();
    // a solid beside the block touching only along an edge does not merge with it
    const diag = item("d", box(10, 10, 0, 14, 14, 10));
    expect(inserted([casting, diag, item("p", box(4, 4, 8, 6, 6, 14))], "p")).toBe("c");
  });

  test("explicit mates and inserts win and are scene paths; unknown targets are dropped", () => {
    const a = one([
      { id: "x", at: [0, 0, 0], size: [2, 2, 2] },
      { id: "y", at: [10, 0, 0], size: [2, 2, 2], mates: "x", inserts: "x" },
      { id: "z", at: [20, 0, 0], size: [2, 2, 2], mates: "nope", inserts: "y/deeper" },
      {
        id: "g",
        at: [0, 20, 0],
        parts: [
          { id: "i", size: [1, 1, 1] },
          { id: "j", at: [5, 0, 0], size: [1, 1, 1], mates: "i" },
        ],
      },
      { id: "k", at: [0, 40, 0], size: [1, 1, 1], mates: "g/i" },
    ]);
    expect(node(a, "a/y").mates).toBe("a/x");
    expect(node(a, "a/y").inserts).toBe("a/x");
    expect(node(a, "a/z").mates).toBeUndefined();
    expect(node(a, "a/z").inserts).toBeUndefined();
    expect(node(a, "a/g/j").mates).toBe("a/g/i");
    expect(node(a, "a/k").mates).toBe("a/g/i");
  });

  test("spec role and pack-shape role beat inference; fasteners and cables go by type", () => {
    const def: PartShapeDef = {
      id: "fan",
      label: "Fan",
      type: "fan",
      role: "internal",
      defaultSize: { x: 1, y: 1, z: 1 },
      defaultUnits: "tile",
      defaults: {},
      readParams: () => ({ params: {}, diagnostics: [] }),
      build: (_p, ctx) => ({
        primitives: [],
        bounds: { origin: { x: 0, y: 0, z: 0 }, size: ctx.size },
        depthBox: { origin: { x: 0, y: 0, z: 0 }, size: ctx.size },
        solid: true,
      }),
    };
    const a = one(
      [
        { id: "main", size: [10, 10, 10] },
        { id: "bolt-1", type: "bolt", at: [0, 0, 10], size: [1, 1, 1] },
        { id: "wire", type: "ribbon-cable", at: [20, 0, 0], size: [1, 1, 1] },
        { id: "fan", shape: "t:fan", at: [30, 0, 0] },
        { id: "cover", role: "shell", at: [40, 0, 0], size: [1, 1, 1] },
      ],
      {},
      { parts: { get: (r) => (r === "t:fan" ? def : undefined), list: () => ["t:fan"] } },
    );
    expect(node(a, "a/main").role).toBe("body");
    expect(node(a, "a/bolt-1").role).toBe("fastener");
    expect(node(a, "a/wire").role).toBe("cable");
    expect(node(a, "a/fan").role).toBe("internal");
    expect(node(a, "a/fan").type).toBe("fan");
    expect(node(a, "a/cover").role).toBe("shell");
  });

  test("a lone part is the body; the larger volume wins a tie", () => {
    expect(node(one([{ id: "only", size: [1, 1, 1] }]), "a/only").role).toBe("body");
    const a = one([
      { id: "small", size: [1, 1, 1] },
      { id: "large", at: [10, 0, 0], size: [3, 3, 3] },
    ]);
    expect(node(a, "a/large").role).toBe("body");
    expect(node(a, "a/small").role).toBe("internal");
  });
});

// ------------------------------------------------------------------------- below ground, bounds

describe("below-ground lift and bounds", () => {
  const dropPan = (asm: SceneAssembly): Box3 => {
    const pan = node(asm, "engine/oil-pan").world;
    return {
      origin: { x: pan.origin.x, y: pan.origin.y, z: pan.origin.z - 2 * pan.size.z },
      size: { x: pan.size.x, y: pan.size.y, z: pan.size.z * 3 },
    };
  };
  const engineOnly = (): PlatformCosmoSpec => spec({ assemblies: [engineAssembly()] });

  test("the engine example is lifted so its reach bounds start at z = 0", () => {
    const plain = buildAssemblies(engineOnly()).assemblies[0] as SceneAssembly;
    expect(plain.restBounds.origin.z).toBe(0);
    expect(plain.frame.origin.z).toBe(0);
    const panH = node(plain, "engine/oil-pan").world.size.z;
    expect(panH).toBeCloseTo(80 * plain.frame.scale.z, 5);

    const lifted = buildAssemblies(engineOnly(), { reach: dropPan }).assemblies[0] as SceneAssembly;
    expect(lifted.frame.origin.z).toBeCloseTo(2 * panH, 5);
    expect(lifted.reachBounds.origin.z).toBe(0);
    expect(lifted.restBounds.origin.z).toBeCloseTo(2 * panH, 5); // rest pose raised with the unit
    expect(node(lifted, "engine/oil-pan").world.origin.z).toBeCloseTo(2 * panH, 5);
    expect(node(lifted, "engine/block").world.origin.z).toBeCloseTo(3 * panH, 5);
    expect(o3(lifted.restBounds).slice(0, 2)).toEqual(o3(plain.restBounds).slice(0, 2));
    expect(s3(lifted.restBounds)).toEqual(s3(plain.restBounds));
    // not lifted when asked (DC racks stand on the floor)
    const flat = buildAssemblies(engineOnly(), { reach: dropPan, lift: false }).assemblies[0]!;
    expect(flat.frame.origin.z).toBe(0);
    expect(flat.reachBounds.origin.z).toBeLessThan(0);
  });

  test("reach never shrinks below the rest bounds; helper math", () => {
    const a = buildAssemblies(engineOnly(), {
      reach: () => ({ origin: { x: 0, y: 0, z: 1 }, size: { x: 1, y: 1, z: 1 } }),
    }).assemblies[0]!;
    expect(a.reachBounds).toEqual(a.restBounds);
    expect(belowGroundLift({ origin: { x: 0, y: 0, z: -0.5 }, size: { x: 1, y: 1, z: 1 } })).toBe(
      0.5,
    );
    expect(belowGroundLift({ origin: { x: 0, y: 0, z: 2 }, size: { x: 1, y: 1, z: 1 } })).toBe(0);
  });

  test("assemblies stand in a row by reach footprint; pos overrides", () => {
    const part = [{ id: "p", size: [4, 2, 1] }];
    const r = asms(
      [
        { id: "a", units: "tile", parts: part },
        { id: "b", units: "tile", parts: part },
        { id: "c", units: "tile", parts: part, pos: { x: -5, y: 7 } },
        { id: "d", units: "tile", parts: part },
      ],
      { origin: { x: 3, y: 1 } },
    );
    const at = (id: string) => (r.assemblies.find((x) => x.id === id) as SceneAssembly).restBounds;
    expect(o3(at("a"))).toEqual([3, 1, 0]);
    expect(o3(at("b"))).toEqual([3 + 4 + ASSEMBLY_GAP, 1, 0]);
    expect(o3(at("c"))).toEqual([-5, 7, 0]);
    expect(o3(at("d"))).toEqual([3 + 2 * (4 + ASSEMBLY_GAP), 1, 0]);
  });

  test("a reach that extends to -x pushes the footprint right; reach is carried with the unit", () => {
    const part = [{ id: "p", size: [4, 2, 1] }];
    const r = asms(
      [
        { id: "a", units: "tile", parts: part },
        { id: "b", units: "tile", parts: part },
      ],
      {
        origin: { x: 0, y: 0 },
        reach: (asm) => ({
          origin: { x: asm.restBounds.origin.x - 3, y: asm.restBounds.origin.y, z: 0 },
          size: { x: 10, y: 2, z: 1 },
        }),
      },
    );
    const [a, b] = r.assemblies as [SceneAssembly, SceneAssembly];
    expect(a.reachBounds.origin.x).toBe(0);
    expect(a.restBounds.origin.x).toBe(3);
    expect(b.reachBounds.origin.x).toBe(10 + ASSEMBLY_GAP);
    expect(b.restBounds.origin.x).toBe(10 + ASSEMBLY_GAP + 3);
  });
});

// ------------------------------------------------------------------------- robustness, outputs

describe("never throws; deterministic", () => {
  test("bad geometry or pack shapes give diagnostics, not exceptions", () => {
    const throwing: PartShapeDef = {
      id: "bad",
      label: "Bad",
      type: "bad",
      defaultSize: { x: 1, y: 1, z: 1 },
      defaultUnits: "tile",
      defaults: {},
      readParams: () => ({ params: {}, diagnostics: [] }),
      build: () => {
        throw new Error("boom");
      },
    };
    const r = asms(
      [
        {
          id: "a",
          units: "tile",
          parts: [
            { id: "zero", size: [0, 1, 1] },
            { id: "bad", shape: "t:bad" },
            { id: "unknown", shape: "nope:thing", size: [1, 1, 1] },
            { id: "ok", at: [5, 0, 0], size: [1, 1, 1] },
          ],
        },
      ],
      { parts: { get: (ref) => (ref === "t:bad" ? throwing : undefined), list: () => [] } },
    );
    const a = r.assemblies[0] as SceneAssembly;
    expect(r.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["assembly/shape-params", "/assemblies/0/parts/0"],
      ["assembly/shape-params", "/assemblies/0/parts/1"],
    ]);
    expect(node(a, "a/zero").geometry).toBeUndefined();
    expect(node(a, "a/unknown").geometry).toBeDefined(); // unregistered pack ref: a box
    expect(node(a, "a/ok").geometry).toBeDefined();
    expect(Number.isFinite(a.restBounds.size.x)).toBe(true);
  });

  test("same input, same bytes; output does not depend on object key order", () => {
    const s = engineSpec();
    const a = JSON.stringify(buildAssemblies(spec(s)));
    expect(JSON.stringify(buildAssemblies(spec(s)))).toBe(a);
    const reordered = JSON.parse(JSON.stringify(s), (_k, v: unknown) =>
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Obj).reverse())
        : v,
    ) as Obj;
    expect(JSON.stringify(buildAssemblies(spec(reordered)))).toBe(a);
  });

  test("an empty or template-only spec builds nothing", () => {
    expect(buildAssemblies(spec({ nodes: [{ id: "n", type: "server" }] })).assemblies).toEqual([]);
    expect(
      buildAssemblies(
        spec({ assemblies: [{ id: "t", template: true, parts: [{ id: "p", size: [1, 1, 1] }] }] }),
      ).assemblies,
    ).toEqual([]);
  });

  test("images: placement needs a crop or the asset's size; credits and image keys are collected", () => {
    const parts = [
      { id: "card", shape: "card", size: [2, 0.1, 3], image: "pic" },
      {
        id: "decal",
        size: [2, 2, 1],
        at: [5, 0, 0],
        image: { ref: "pic", face: "top", fit: "cover", crop: [1, 2, 3, 4] },
      },
    ];
    const images = [{ id: "pic", src: "p.png", source: { attribution: "A", license: "CC0" } }];
    const noAsset = buildAssemblies(
      spec({ images, assemblies: [{ id: "a", units: "tile", parts }] }),
    );
    const a = noAsset.assemblies[0] as SceneAssembly;
    expect(node(a, "a/card").geometry?.images).toBeUndefined();
    expect(node(a, "a/decal").geometry?.images).toEqual([
      { image: "pic", face: "top", crop: { x: 1, y: 2, width: 3, height: 4 }, fit: "cover" },
    ]);
    expect(noAsset.images).toEqual(["pic"]);
    expect(noAsset.credits).toEqual([{ attribution: "A", license: "CC0" }]);
    const withAsset = buildAssemblies(
      spec({ images, assemblies: [{ id: "a", units: "tile", parts }] }),
      { images: { get: () => ({ width: 640, height: 480 }) as never, keys: () => ["pic"] } },
    );
    expect(node(withAsset.assemblies[0]!, "a/card").geometry?.images).toEqual([
      {
        image: "pic",
        face: "billboard",
        crop: { x: 0, y: 0, width: 640, height: 480 },
        fit: "contain",
      },
    ]);
  });
});

describe("scene wiring (schema 1.2.0 only)", () => {
  test("focus targets, initial states and bounds cover the engine's assembly, sub-assemblies and parts", () => {
    const g = buildScene(spec(engineSpec()), {});
    expect(g.diagnostics.filter((d) => d.code === "semantic/unknown-focus")).toEqual([]);
    const a = g.assemblies!.assemblies[0] as SceneAssembly;
    expect(a.id).toBe("engine");
    expect(Object.keys(g.assemblies!).sort()).toEqual([
      "assemblies",
      "boards",
      "credits",
      "images",
      "plan",
    ]);
    expect(g.focusTargets["engine"]).toEqual(a.root.world);
    expect(g.focusTargets["engine/pr-3/piston"]).toEqual(node(a, "engine/pr-3/piston").world);
    expect(g.focusTargets["engine/head"]).toEqual(node(a, "engine/head").world);
    expect(Object.keys(g.focusTargets)).toEqual([...Object.keys(g.focusTargets)].sort());
    // `set` on a part path takes effect from the step it is set in
    expect(g.timeline[2]!.states["engine/pr-3/piston"]).toBe("healthy");
    expect(g.timeline[3]!.states["engine/pr-3/piston"]).toBe("highlighted");
    const b = g.bounds;
    const r = a.reachBounds;
    expect(b.origin.x).toBeLessThanOrEqual(r.origin.x + 0.01);
    expect(b.origin.x + b.size.x).toBeGreaterThanOrEqual(r.origin.x + r.size.x - 0.01);
    expect(b.size.z).toBeGreaterThanOrEqual(r.size.z - 0.01);
    expect(assemblyFocusTargets(g.assemblies!.assemblies).size).toBe(assemblyNodes(a).length);
  });

  test("assemblies stand +x of nodes, with the DC gap", () => {
    const s = spec({
      nodes: [{ id: "n", type: "server" }],
      assemblies: [{ id: "a", units: "tile", parts: [{ id: "p", size: [1, 1, 1] }] }],
    });
    const g = buildScene(s, {});
    const n = g.objects.find((o) => o.id === "n")!;
    const a = g.assemblies!.assemblies[0] as SceneAssembly;
    expect(a.restBounds.origin.x).toBeCloseTo(n.box.origin.x + n.box.size.x + 2, 1);
  });

  test("1.1 specs get no assemblies and the same scene as with an empty list", () => {
    const root = new URL("../../../examples/", import.meta.url);
    let checked = 0;
    for (const f of readdirSync(root).filter((x) => x.endsWith(".cosmo.json"))) {
      const s = JSON.parse(readFileSync(new URL(f, root), "utf8")) as PlatformCosmoSpec;
      if (s.racks || s.equipment || s.rows || s.facility) continue; // need the DC pack
      const plain = buildScene(s, {});
      expect(plain.assemblies, f).toBeUndefined();
      const withEmpty = buildScene({ ...s, assemblies: [] } as unknown as PlatformCosmoSpec, {});
      expect(JSON.stringify(withEmpty), f).toBe(JSON.stringify(plain));
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });

  test("mergeSceneAssemblies keeps sorted ids, dedupes credits and prefers the other plan", () => {
    const a = buildAssemblies(
      spec({ assemblies: [{ id: "z", units: "tile", parts: [{ id: "p", size: [1, 1, 1] }] }] }),
    );
    const board = {
      id: "f",
      kind: "figure" as const,
      anchor: { x: 0, y: 0, z: 0 },
      width: 4,
      images: ["i"],
    };
    const m = mergeSceneAssemblies(
      { ...a, credits: [{ license: "x" }], images: ["b"] },
      {
        assemblies: [],
        boards: [board],
        plan: [],
        images: ["a", "b"],
        credits: [{ license: "x" }, { license: "y" }],
      },
    );
    expect(m.boards.map((b) => b.id)).toEqual(["f"]);
    expect(m.images).toEqual(["a", "b"]);
    expect(m.credits).toEqual([{ license: "x" }, { license: "y" }]);
    expect(m.assemblies.map((x) => x.id)).toEqual(["z"]);
    // without figures: the same content, and no `diagnostics` leaking into the scene
    const alone = mergeSceneAssemblies(a, undefined);
    expect(Object.keys(alone).sort()).toEqual([
      "assemblies",
      "boards",
      "credits",
      "images",
      "plan",
    ]);
    expect(alone.assemblies).toEqual(a.assemblies);
  });
});
