import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type {
  Diagnostic,
  PartMove,
  ResolvedExplodeProgram,
  SceneAssembly,
  SceneAssemblyNode,
  SceneGraph,
} from "../src/index.js";
import { buildScene } from "../src/index.js";
import { assemblyDiagnostics, isAssemblyPath } from "../src/schema/assembly-semantic.js";
import { AssemblyModel, parseSelector, selects } from "../src/schema/assembly-tree.js";
import type { TNode } from "../src/schema/assembly-tree.js";
import type { PlatformCosmoSpec } from "../src/schema/types.gen.js";
import { buildAssemblies, assemblyNodes } from "../src/scene/assembly/tree.js";
import { BEZIER, REVERSED_EASING, fitDuration, mirrorBezier } from "../src/scene/boards.js";
import { OwnerSelectors, indexOwner, makeWork } from "../src/scene/assembly/selectors.js";
import { programSegment } from "../src/scene/assembly/timing.js";
import { AssemblyPrograms } from "../src/scene/assembly/plan.js";
import { assemblyPlanDiagnostics } from "../src/scene/assembly/plan-scene.js";
import { transitionSeconds } from "../src/anim/timeline.js";

// A2-3: explode programs and the step plan (docs/design/assemblies.md §6, §7, §8.3, §10).

type Obj = Record<string, unknown>;
const spec = (o: Obj): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...o }) as unknown as PlatformCosmoSpec;
const specOf = new WeakMap<SceneGraph, PlatformCosmoSpec>();
const scene = (s: PlatformCosmoSpec): SceneGraph => {
  const g = buildScene(s, {});
  specOf.set(g, s);
  return g;
};
const asmOf = (g: SceneGraph, id = "a"): SceneAssembly => {
  const a = g.assemblies?.assemblies.find((x) => x.id === id);
  expect(a, `assembly ${id}`).toBeDefined();
  return a as SceneAssembly;
};
const nodeOf = (a: SceneAssembly, path: string): SceneAssemblyNode =>
  assemblyNodes(a).find((n) => n.path === path) as SceneAssemblyNode;
const prog = (a: SceneAssembly, id: string, owner = a.id): ResolvedExplodeProgram =>
  a.programs.find((p) => p.id === id && p.owner === owner) as ResolvedExplodeProgram;
const moveOf = (p: ResolvedExplodeProgram, path: string): PartMove =>
  p.stages.flatMap((s) => s.moves).find((m) => m.path === path) as PartMove;
const vec = (m: PartMove): number[] => [m.offset.x, m.offset.y, m.offset.z];
const near = (got: number[], want: number[]): void => {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => expect(g).toBeCloseTo(want[i] as number, 6));
};
const codes = (d: readonly Diagnostic[], code: string): Diagnostic[] =>
  d.filter((x) => x.code === code);
const box = (id: string, at: number[], size: number[], extra: Obj = {}): Obj => ({
  id,
  at,
  size,
  ...extra,
});
/** One tile-unit assembly `a` (world scale 1, so offsets read as authored). */
const tile = (parts: unknown[], programs: unknown[], extra: Obj = {}): Obj => ({
  id: "a",
  units: "tile",
  parts,
  programs,
  ...extra,
});
const one = (parts: unknown[], stage: Obj, extra: Obj = {}): SceneAssembly =>
  asmOf(scene(spec({ assemblies: [tile(parts, [{ id: "p", stages: [stage] }], extra)] })));

const examples = (file: string): Obj[] => {
  const md = readFileSync(new URL(`../../../docs/design/${file}`, import.meta.url), "utf8");
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .filter((s) => typeof s.meta === "object");
};
const engine = (): Obj =>
  structuredClone(
    examples("assemblies.md").find((s) =>
      (s.meta as { title: string }).title.startsWith("Inline-4"),
    ) as Obj,
  );

// ------------------------------------------------------------------------------------ selectors

const SEL_PARTS = [
  box("frame", [0, 0, 0], [1, 1, 1], {
    role: "shell",
    parts: [
      box("door", [0, 0, 0], [1, 1, 1], { role: "cover" }),
      box("panel", [1, 0, 0], [1, 1, 1], { role: "cover", tags: ["skin"] }),
      box("rail", [2, 0, 0], [1, 1, 1]),
    ],
  }),
  { id: "cyl", count: 3, pitch: [2, 0, 0], at: [0, 3, 0], size: [1, 1, 1], type: "cyl" },
  box("head", [0, 6, 0], [1, 1, 1], {
    parts: [
      { id: "valve", count: 2, pitch: [2, 0, 0], at: [0, 0, 1], size: [1, 1, 1], type: "valve" },
      box("casting", [0, 0, 0], [1, 1, 1]),
    ],
  }),
  box("deep", [0, 9, 0], [1, 1, 1], {
    parts: [box("inner", [0, 0, 0], [1, 1, 1], { parts: [box("leaf-1", [0, 0, 0], [1, 1, 1])] })],
  }),
];
const SEL_SPEC = spec({ assemblies: [tile(SEL_PARTS, [])] });
const ALL = [
  "frame",
  "frame/door",
  "frame/panel",
  "frame/rail",
  "cyl-1",
  "cyl-2",
  "cyl-3",
  "head",
  "head/valve-1",
  "head/valve-2",
  "head/casting",
  "deep",
  "deep/inner",
  "deep/inner/leaf-1",
];
const SELECTOR_TABLE: [string, string[]][] = [
  ["cyl-*", ["cyl-1", "cyl-2", "cyl-3"]],
  ["cyl-?", ["cyl-1", "cyl-2", "cyl-3"]],
  ["cyl-4", []],
  ["valve-*", []], // bare terms match direct children only
  ["head/valve-*", ["head/valve-1", "head/valve-2"]],
  ["**/valve-*", ["head/valve-1", "head/valve-2"]],
  ["type:cyl", ["cyl-1", "cyl-2", "cyl-3"]],
  ["type:valve", []],
  ["**/type:valve", ["head/valve-1", "head/valve-2"]],
  ["head/type:valve", ["head/valve-1", "head/valve-2"]],
  ["role:cover", []],
  ["frame/role:cover", ["frame/door", "frame/panel"]],
  ["**/role:cover", ["frame/door", "frame/panel"]],
  ["role:shell", ["frame"]],
  ["tag:skin", []],
  ["**/tag:skin", ["frame/panel"]],
  ["**", ALL],
  ["frame/*", ["frame/door", "frame/panel", "frame/rail"]],
  ["*/*", ALL.filter((p) => p.split("/").length === 2)],
  ["**/leaf-?", ["deep/inner/leaf-1"]],
  ["deep/**", ["deep/inner", "deep/inner/leaf-1"]],
  ["**/inner/*", ["deep/inner/leaf-1"]],
  ["?ead", ["head"]],
  ["**/**/leaf-1", ["deep/inner/leaf-1"]],
  ["fr*e", ["frame"]],
  ["x/**", []],
];

describe("selectors: scoped to the program owner (§6.1)", () => {
  const a = asmOf(scene(SEL_SPEC));
  const sel = (owner: SceneAssemblyNode = a.root): OwnerSelectors =>
    new OwnerSelectors(indexOwner(owner, makeWork()), makeWork());
  const rels = (items: readonly { rel: string }[] | undefined): string[] | undefined =>
    items?.map((i) => i.rel);

  test.each(SELECTOR_TABLE)("%s", (s, want) => {
    expect(rels(sel().match(s))).toEqual(want);
  });

  test("validation and scene agree on every selector of the table", () => {
    const model = new AssemblyModel(SEL_SPEC);
    const tree = model.tree(0) as TNode;
    const flat = model.flat(tree);
    const typeOf = (n: TNode): string | undefined => n.type;
    for (const [s] of SELECTOR_TABLE) {
      const p = parseSelector(s);
      const validator = flat.filter((f) => selects(p, f, typeOf)).map((f) => f.path);
      expect(rels(sel().match(s)), s).toEqual(validator);
    }
  });

  test("scoped to a sub-assembly owner: bare terms are its direct children", () => {
    const head = nodeOf(a, "a/head");
    const s = sel(head);
    expect(rels(s.match("valve-*"))).toEqual(["valve-1", "valve-2"]);
    expect(rels(s.match("**"))).toEqual(["valve-1", "valve-2", "casting"]);
    expect(rels(s.match("head/*"))).toEqual([]);
  });

  test("stage: union, except, and a selected sub-assembly moves as one unit", () => {
    const s = sel();
    const names = (r: ReturnType<OwnerSelectors["stage"]>): string[] | undefined =>
      r?.movers.map((m) => m.rel);
    expect(names(s.stage(["head", "**/valve-*"], undefined))).toEqual(["head"]);
    expect(names(s.stage(["head/*"], ["head/valve-1"]))).toEqual(["head/valve-2", "head/casting"]);
    expect(names(s.stage(["cyl-*", "type:cyl"], ["cyl-2"]))).toEqual(["cyl-1", "cyl-3"]);
    // the unpruned selection is what "moved twice" is judged on
    expect(s.stage(["head", "**/valve-*"], undefined)?.selected.length).toBe(3);
  });

  test("spent budget: match returns undefined instead of scanning", () => {
    const idx = indexOwner(a.root, makeWork());
    const s = new OwnerSelectors(idx, makeWork(3));
    expect(s.match("**")).toBeUndefined();
    expect(indexOwner(a.root, makeWork(2)).complete).toBe(false);
  });

  test("adversarial globs are linear: no catastrophic backtracking", () => {
    const parts = [{ id: `${"a".repeat(40)}`, at: [0, 0, 0], size: [1, 1, 1] }];
    const g = asmOf(scene(spec({ assemblies: [tile(parts, [])] })));
    const s = sel(g.root);
    const t0 = Date.now();
    const hit = s.match("*a*a*a*a*a*a*a*a*a*a*a*b");
    s.match(`${"**/".repeat(6)}*a*a*a*a*a*b`);
    expect(hit).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------------- directions

describe("directions (§6.2)", () => {
  const BASE = box("base", [0, 0, 0], [10, 10, 1]);
  const dir = (parts: unknown[], id: string, direction: unknown, extra: Obj = {}): number[] =>
    vec(moveOf(prog(one(parts, { parts: [id], direction, distance: 2 }, extra), "p"), `a/${id}`));

  test("axis presets and aliases", () => {
    const parts = [BASE, box("p", [4, 4, 1], [1, 1, 1])];
    const t: [unknown, number[]][] = [
      ["up", [0, 0, 2]],
      ["+z", [0, 0, 2]],
      ["down", [0, 0, -2]],
      ["-z", [0, 0, -2]],
      ["+x", [2, 0, 0]],
      ["-x", [-2, 0, 0]],
      ["+y", [0, 2, 0]],
      ["-y", [0, -2, 0]],
      ["lift", [0, 0, 2]],
      [
        [3, 4, 0],
        [1.2, 1.6, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 2],
      ],
      ["sideways", undefined as unknown as number[]], // unknown name: behaves as away
    ];
    for (const [d, want] of t) {
      if (want === undefined) expect(dir(parts, "p", d).length).toBe(3);
      else near(dir(parts, "p", d), want);
    }
  });

  test("out: larger horizontal |c|, signed; ties +y then +x; c = 0 is up", () => {
    const parts = [
      BASE, // owner centre (5, 5)
      box("px", [8, 4, 1], [1, 1, 1]), // c = (3.5, -0.5): +x
      box("py", [4, 8, 1], [1, 1, 1]), // c = (-0.5, 3.5): +y
      box("tie", [8, 8, 1], [1, 1, 1]), // |cx| = |cy|: prefers y
      box("tie2", [1, 1, 1], [1, 1, 1]), // c = (-3.5, -3.5): the visible-first order picks -x
      box("mx", [0.5, 4, 1], [1, 1, 1]), // c = (-4, -0.5): -x
      box("mid", [4.5, 4.5, 1], [1, 1, 1]), // c = 0: up
    ];
    near(dir(parts, "px", "out"), [2, 0, 0]);
    near(dir(parts, "py", "out"), [0, 2, 0]);
    near(dir(parts, "tie", "out"), [0, 2, 0]);
    near(dir(parts, "tie2", "out"), [-2, 0, 0]);
    near(dir(parts, "mx", "out"), [-2, 0, 0]);
    near(dir(parts, "mid", "out"), [0, 0, 2]);
  });

  test("radial: not snapped; axis: the part's own axis signed by c", () => {
    const parts = [
      BASE,
      box("tie", [8, 8, 1], [1, 1, 1]),
      box("mid", [4.5, 4.5, 1], [1, 1, 1]),
      box("cx", [8, 4, 1], [2, 1, 1], { shape: "cylinder", axis: "x" }),
      box("cm", [0, 4, 1], [2, 1, 1], { shape: "cylinder", axis: "x" }),
      box("cz", [4, 4, 1], [1, 1, 2], { shape: "cylinder" }),
    ];
    const r = Math.SQRT1_2 * 2;
    near(dir(parts, "tie", "radial"), [r, r, 0]);
    near(dir(parts, "mid", "radial"), [0, 0, 2]);
    near(dir(parts, "cx", "axis"), [2, 0, 0]);
    near(dir(parts, "cm", "axis"), [-2, 0, 0]);
    near(dir(parts, "cz", "axis"), [0, 0, 2]); // c.z > 0 or tie: +
  });

  test("drawer: the assembly front, through the quarter turn", () => {
    const parts = [BASE, box("p", [4, 4, 1], [1, 1, 1])];
    near(dir(parts, "p", "drawer"), [0, 2, 0]); // front +y
    near(dir(parts, "p", "drawer", { front: "+x" }), [2, 0, 0]);
    near(dir(parts, "p", "drawer", { front: "-y" }), [0, -2, 0]);
    // rotate 90: local +y turns to world -x, and `frame.front` says so
    const a = one(parts, { parts: ["p"], direction: "drawer", distance: 2 }, { rotate: 90 });
    expect(a.frame.front).toBe("-x");
    near(vec(moveOf(prog(a, "p"), "a/p")), [-2, 0, 0]);
    // axis presets are axes of the assembly frame: +x turns with it
    near(dir(parts, "p", "+x", { rotate: 90 }), [0, 2, 0]);
    near(dir(parts, "p", "+x", { rotate: 180 }), [-2, 0, 0]);
    near(dir(parts, "p", "+x", { rotate: 270 }), [0, -2, 0]);
  });

  test("away: leaves its mate through the largest contact face", () => {
    const on = [box("under", [0, 0, 0], [3, 3, 1]), box("p", [0, 0, 1], [1, 1, 1])];
    near(dir(on, "p", "away"), [0, 0, 2]); // sits on its neighbour
    near(dir(on, "p", undefined), [0, 0, 2]); // away is the default
    const below = [box("top", [0, 0, 1], [3, 3, 1]), box("p", [0, 0, 0], [1, 1, 1])];
    near(dir(below, "p", "away"), [0, 0, -2]);
    const side = [box("wall", [0, 0, 0], [1, 3, 3]), box("p", [1, 0, 0], [1, 1, 1])];
    near(dir(side, "p", "away"), [2, 0, 0]);
    // a larger contact face wins over a smaller one
    const wide = [
      box("floor", [0, 0, 0], [4, 4, 1]),
      box("wall", [0, 0, 1], [1, 4, 4], { role: "body" }),
      box("p", [1, 0, 1], [1, 1, 3]), // floor contact 1, wall contact 3
    ];
    near(dir(wide, "p", "away"), [2, 0, 0]);
  });

  test("away: ties prefer +z, +y, +x, -x, -y, -z", () => {
    // `mates` names a part that does not touch, so the touching siblings decide
    const far = box("far", [8, 8, 8], [1, 1, 1]);
    // p touches w1 on its -x face (away +x) and w2 on its -y face (away +y): equal areas
    const parts = [
      box("w1", [0, 1, 0], [1, 1, 1]),
      box("w2", [1, 0, 0], [1, 1, 1]),
      box("p", [1, 1, 0], [1, 1, 1], { mates: "far" }),
      far,
    ];
    near(dir(parts, "p", "away"), [0, 2, 0]);
    // -x face (away +x) before +x face (away -x)
    const xy = [
      box("w1", [0, 1, 0], [1, 1, 1]),
      box("p", [1, 1, 0], [1, 1, 1], { mates: "far" }),
      box("w3", [2, 1, 0], [1, 1, 1]),
      far,
    ];
    near(dir(xy, "p", "away"), [2, 0, 0]);
    // below beats beside
    const zx = [
      box("under", [0, 0, 0], [1, 1, 1]),
      box("p", [0, 0, 1], [1, 1, 1], { mates: "far" }),
      box("side", [1, 0, 1], [1, 1, 1]),
      far,
    ];
    near(dir(zx, "p", "away"), [0, 0, 2]);
  });

  test("away: an explicit mate decides; enclosed parts take the shortest exit", () => {
    const parts = (mate: string): unknown[] => [
      box("a1", [0, 0, 0], [1, 1, 1]), // under p: away +z
      box("a2", [1, 0, 1], [1, 1, 1]), // beside p: away -x
      box("p", [0, 0, 1], [1, 1, 1], { mates: mate }),
    ];
    near(dir(parts("a1"), "p", "away"), [0, 0, 2]);
    near(dir(parts("a2"), "p", "away"), [-2, 0, 0]);
    const block = [box("blk", [0, 0, 0], [10, 10, 10]), box("p", [4, 4, 7], [1, 1, 1])];
    near(dir(block, "p", "away"), [0, 0, 2]); // up: 3 away; every other exit is farther
    const side = [box("blk", [0, 0, 0], [10, 10, 10]), box("p", [1, 4, 4], [1, 1, 1])];
    near(dir(side, "p", "away"), [-2, 0, 0]);
    const tied = [box("blk", [0, 0, 0], [10, 10, 10]), box("p", [4, 7, 7], [1, 1, 1])];
    near(dir(tied, "p", "away"), [0, 0, 2]); // +y and +z are 3 away: +z first
  });

  test("away: no contact at all falls back to out; interpenetration to the least depth", () => {
    const far = [box("base", [0, 0, 0], [1, 1, 1]), box("p", [5, 0, 0], [1, 1, 1])];
    near(dir(far, "p", "away"), [2, 0, 0]);
    const over = [box("base", [0, 0, 0], [1, 1, 1]), box("p", [0, 0, 0.9], [1, 1, 1])];
    near(dir(over, "p", "away"), [0, 0, 2]);
  });

  test("overrides replace the stage direction and distance for one part", () => {
    const a = one([BASE, box("p", [1, 1, 1], [1, 1, 1]), box("q", [3, 3, 1], [1, 1, 1])], {
      parts: ["p", "q"],
      direction: "up",
      distance: 2,
      overrides: { q: { direction: "+x", distance: 5 } },
    });
    near(vec(moveOf(prog(a, "p"), "a/p")), [0, 0, 2]);
    near(vec(moveOf(prog(a, "p"), "a/q")), [5, 0, 0]);
  });
});

// ------------------------------------------------------------------------- distances, stacking

describe("distance and program-level stacking (§6.3)", () => {
  const final = (a: SceneAssembly, p: ResolvedExplodeProgram, path: string): [number, number] => {
    const n = nodeOf(a, path);
    const off = p.stages.flatMap((s) => s.moves).find((m) => m.path === path)?.offset.z ?? 0;
    return [n.world.origin.z + off, n.world.origin.z + n.world.size.z + off];
  };

  test("the engine stacks cover > cams > head > pistons, with the program gap between them", () => {
    const a = asmOf(
      scene(spec({ assemblies: (engine().assemblies as unknown[]).slice(0, 1) })),
      "engine",
    );
    const p = prog(a, "teardown", "engine");
    const lo = (id: string): number => final(a, p, `engine/${id}`)[0];
    const hi = (id: string): number => final(a, p, `engine/${id}`)[1];
    expect(lo("valve-cover")).toBeGreaterThan(lo("cam-intake"));
    expect(lo("cam-intake")).toBeGreaterThan(lo("head"));
    expect(lo("head")).toBeGreaterThan(lo("pr-1"));
    // footprint-overlapping movers: the outer one ends at least `gap` beyond the inner one
    const gap = 0.1 * 520 * a.frame.scale.z; // 10% of the largest extent (520 mm), in world units
    expect(lo("valve-cover")).toBeGreaterThanOrEqual(hi("cam-intake") + gap - 1e-6);
    expect(lo("cam-intake")).toBeGreaterThanOrEqual(hi("head") + gap - 1e-6);
    expect(lo("head")).toBeGreaterThanOrEqual(hi("pr-1") + gap - 1e-6);
    // equal rest min_z share a lift layer: both cams and all four pistons end level
    expect(moveOf(p, "engine/cam-exhaust").offset.z).toBeCloseTo(
      moveOf(p, "engine/cam-intake").offset.z,
      9,
    );
    for (const k of [2, 3, 4]) {
      expect(moveOf(p, `engine/pr-${k}`).offset.z).toBeCloseTo(
        moveOf(p, "engine/pr-1").offset.z,
        9,
      );
    }
  });

  test("the engine moves: pistons clear the block deck, the pan drops, belts leave sideways", () => {
    const a = asmOf(
      scene(spec({ assemblies: (engine().assemblies as unknown[]).slice(0, 1) })),
      "engine",
    );
    const p = prog(a, "teardown", "engine");
    const block = nodeOf(a, "engine/block").world;
    const deck = block.origin.z + block.size.z;
    expect(final(a, p, "engine/pr-1")[0]).toBeGreaterThanOrEqual(deck);
    expect(moveOf(p, "engine/oil-pan").offset.z).toBeLessThan(0);
    expect(moveOf(p, "engine/crankshaft").offset.z).toBeLessThan(0);
    expect(moveOf(p, "engine/timing-belt").offset.x).toBeLessThan(0);
    expect(moveOf(p, "engine/valve-cover").offset.z).toBeGreaterThan(0);
    expect(moveOf(p, "engine/intake").offset.y).toBeGreaterThan(0);
    expect(moveOf(p, "engine/exhaust").offset.y).toBeLessThan(0);
  });

  test("numbers, multiples, gap and static obstruction", () => {
    const parts = [
      box("slab", [0, 0, 0], [4, 4, 2]), // static, in the way
      box("p", [1, 1, 1], [1, 1, 1]), // starts inside the slab
      box("q", [6, 1, 0], [1, 1, 1]), // free
    ];
    const at = (stage: Obj, extra: Obj = {}): SceneAssembly =>
      one(parts, { direction: "up", ...stage }, extra);
    // p must clear the slab top (z = 2): travel 2 - 1 + gap; default gap 10% of 7 = 0.7
    const auto = prog(at({ parts: ["p"] }), "p");
    expect(moveOf(auto, "a/p").offset.z).toBeCloseTo(2 - 1 + 0.7, 6);
    const times = prog(at({ parts: ["p"], distance: "2x" }), "p");
    expect(moveOf(times, "a/p").offset.z).toBeCloseTo(2 * (2 - 1 + 0.7), 6);
    const gapProg = asmOf(
      scene(
        spec({
          assemblies: [
            tile(parts, [{ id: "p", gap: 1, stages: [{ parts: ["p"], direction: "up" }] }]),
          ],
        }),
      ),
    );
    expect(moveOf(prog(gapProg, "p"), "a/p").offset.z).toBeCloseTo(2 - 1 + 1, 6);
    // a free part only needs its own extent plus the gap
    expect(moveOf(prog(at({ parts: ["q"] }), "p"), "a/q").offset.z).toBeCloseTo(1 + 0.7, 6);
    // numbers are used as they are
    expect(moveOf(prog(at({ parts: ["p"], distance: 9 }), "p"), "a/p").offset.z).toBeCloseTo(9, 9);
  });

  test("non-axis directions have no stacking: k * (extent along u + gap)", () => {
    const parts = [box("a1", [0, 0, 0], [1, 1, 1]), box("a2", [0, 0, 1], [1, 1, 1])];
    const a = one(parts, { parts: ["a1", "a2"], direction: [1, 0, 1] });
    const e = 2 * Math.SQRT1_2; // extent of a unit cube along (1,0,1)/sqrt2
    const d = e + 0.1 * 2; // gap: 10% of the largest extent (2)
    for (const id of ["a1", "a2"]) {
      const m = moveOf(prog(a, "p"), `a/${id}`);
      expect(Math.hypot(...vec(m))).toBeCloseTo(d, 6);
    }
  });

  test("drawer parts leave the unit completely", () => {
    const parts = [box("shell", [0, 0, 0], [4, 4, 4]), box("srv", [1, 0, 1], [2, 2, 1])];
    const a = one(parts, { parts: ["srv"], direction: "drawer" });
    // owner front face is y = 4; srv.min_y = 0: 4 - 0 + gap (0.4)
    near(vec(moveOf(prog(a, "p"), "a/srv")), [0, 4.4, 0]);
  });

  test("randomized: every mover clears its seat, stacked movers keep the gap (seeded)", () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let iter = 0; iter < 60; iter++) {
      const cols = [
        [0, 0],
        [1, 0],
        [0, 1.5],
        [4, 4],
      ];
      const parts: Obj[] = [box("slab", [-1, -1, 0], [1.2, 1.2, 1 + Math.floor(rnd() * 3)])];
      const n = 3 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) {
        const [cx, cy] = cols[Math.floor(rnd() * cols.length)] as number[];
        const z = 3 + Math.floor(rnd() * 20);
        parts.push(
          box(`m-${i}`, [cx as number, cy as number, z], [1.5, 1.5, 1 + Math.floor(rnd() * 3)]),
        );
      }
      const a = one(parts, { parts: ["m-*"], direction: "up" });
      const p = prog(a, "p");
      const gap =
        0.1 * Math.max(...[a.root.world.size.x, a.root.world.size.y, a.root.world.size.z]);
      const movers = parts.slice(1).map((m) => `a/${m.id as string}`);
      const fin = new Map(movers.map((m) => [m, final(a, p, m)]));
      const fp = (path: string) => {
        const w = nodeOf(a, path).world;
        return [w.origin.x, w.origin.x + w.size.x, w.origin.y, w.origin.y + w.size.y];
      };
      const overlap = (x: number[], y: number[]): boolean =>
        Math.min(x[1] as number, y[1] as number) - Math.max(x[0] as number, y[0] as number) >
          1e-9 &&
        Math.min(x[3] as number, y[3] as number) - Math.max(x[2] as number, y[2] as number) > 1e-9;
      for (const m of movers) {
        expect(moveOf(p, m).offset.z).toBeGreaterThan(0);
        const w = nodeOf(a, m).world;
        const slab = nodeOf(a, "a/slab").world;
        if (overlap(fp(m), fp("a/slab")) && slab.origin.z + slab.size.z > w.origin.z) {
          expect(fin.get(m)?.[0] as number).toBeGreaterThanOrEqual(
            slab.origin.z + slab.size.z + gap - 1e-6,
          );
        }
      }
      // outer (later in (max, min, path) order) vs inner, when footprints overlap
      const order = [...movers].sort((x, y) => {
        const [xl, xh] = [
          nodeOf(a, x).world.origin.z,
          nodeOf(a, x).world.origin.z + nodeOf(a, x).world.size.z,
        ];
        const [yl, yh] = [
          nodeOf(a, y).world.origin.z,
          nodeOf(a, y).world.origin.z + nodeOf(a, y).world.size.z,
        ];
        return xh - yh || xl - yl || (x < y ? -1 : 1);
      });
      order.forEach((outer, i) => {
        for (const inner of order.slice(0, i)) {
          if (!overlap(fp(outer), fp(inner))) continue;
          expect(fin.get(outer)?.[0] as number).toBeGreaterThanOrEqual(
            (fin.get(inner)?.[1] as number) + gap - 1e-6,
          );
        }
      });
    }
  });
});

// --------------------------------------------------------------------- order, stagger, overrides

describe("order, stagger, overrides and stage time (§6.4, §7.1)", () => {
  // four parts: heights, radii and depth keys all differ
  const P = [
    box("c", [0, 0, 0], [1, 1, 1]), // centre-ish, low, near the origin
    box("hi", [2, 2, 5], [1, 1, 1]), // high, far, nearest the viewer
    box("lo", [6, 0, 0], [1, 1, 1]), // low, far along x
    box("mid", [0, 6, 2], [1, 1, 1]),
  ];
  const starts = (order: string, stage: Obj = {}): string[] => {
    const a = one(P, { parts: ["*"], direction: "up", order, stagger: 1, ...stage });
    return prog(a, "p")
      .stages[0]!.moves.map((m) => `${m.path.slice(2)}@${m.start}`)
      .sort((x, y) => Number(x.split("@")[1]) - Number(y.split("@")[1]));
  };

  test("every order kind ranks the movers differently (ties by path)", () => {
    expect(starts("spec")).toEqual(["c@0", "hi@1", "lo@2", "mid@3"]);
    expect(starts("top-down")).toEqual(["hi@0", "mid@1", "c@2", "lo@3"]);
    expect(starts("bottom-up")).toEqual(["c@0", "lo@1", "mid@2", "hi@3"]);
    expect(starts("front-first")).toEqual(["hi@0", "mid@1", "lo@2", "c@3"]);
    expect(starts("back-first")).toEqual(["c@0", "lo@1", "mid@2", "hi@3"]);
    // c and lo are equally far from the owner's centre: ties by path
    expect(starts("outside-in")).toEqual(["c@0", "lo@1", "mid@2", "hi@3"]);
    expect(starts("inside-out")).toEqual(["hi@0", "mid@1", "c@2", "lo@3"]);
  });

  test("overrides: order ranks first, delay adds to the start", () => {
    const o = starts("spec", { overrides: { mid: { order: 0 }, lo: { delay: 0.5 } } });
    // mid ranked first, then the rest in stage order: mid@0, c@1, hi@2, lo@3 + 0.5
    expect(o).toEqual(["mid@0", "c@1", "hi@2", "lo@3.5"]);
  });

  test("stage start: after the previous end or with its start, plus delay", () => {
    const stages = [
      { parts: ["c"], direction: "up", distance: 1, duration: 2, delay: 0.5 },
      { parts: ["hi"], direction: "up", distance: 1, duration: 1 }, // after: starts at 2.5
      { parts: ["lo"], direction: "up", distance: 1, duration: 1, with: "previous", delay: 0.25 },
      { parts: ["mid"], direction: "up", distance: 1, duration: 4, delay: 1 },
    ];
    const a = asmOf(scene(spec({ assemblies: [tile(P, [{ id: "p", stages }])] })));
    const s = prog(a, "p").stages;
    expect(s.map((x) => [x.start, x.end])).toEqual([
      [0.5, 2.5],
      [2.5, 3.5],
      [2.75, 3.75], // with previous: start of stage 2 + 0.25
      [4.75, 8.75], // after stage 3 ended (3.75) + 1
    ]);
  });

  test("labels, leaders, details and fade flags are carried per stage", () => {
    const a = asmOf(
      scene(
        spec({
          assemblies: [
            tile(P, [
              {
                id: "p",
                stages: [
                  { parts: ["c"] },
                  { parts: ["hi"], labels: "hide", leaders: false, details: true, fade: "others" },
                ],
              },
            ]),
          ],
        }),
      ),
    );
    const [s1, s2] = prog(a, "p").stages;
    expect([s1!.labels, s1!.leaders, s1!.details, s1!.fade]).toEqual(["show", true, false, "none"]);
    expect([s2!.labels, s2!.leaders, s2!.details, s2!.fade]).toEqual([
      "hide",
      false,
      true,
      "others",
    ]);
  });

  test("a part moves in one stage per program; a later stage cannot move it again", () => {
    const a = asmOf(
      scene(
        spec({
          assemblies: [
            tile(P, [{ id: "p", stages: [{ parts: ["c", "hi"] }, { parts: ["hi", "lo"] }] }]),
          ],
        }),
      ),
    );
    const s = prog(a, "p").stages;
    expect(s[0]!.moves.map((m) => m.path)).toEqual(["a/c", "a/hi"]);
    expect(s[1]!.moves.map((m) => m.path)).toEqual(["a/lo"]);
  });
});

// ------------------------------------------------------------------------------ segments, implode

const bez = (b: readonly number[], x: number): number => {
  // cubic-bezier(x1, y1, x2, y2) evaluated by bisection on x (independent of the engine)
  const [x1, y1, x2, y2] = b as [number, number, number, number];
  const at = (t: number, a: number, c: number): number =>
    3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * c + t * t * t;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid, x1, x2) < x) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2, y1, y2);
};
const progress = (st: number, dur: number, t: number, b: readonly number[]): number =>
  t <= st ? 0 : t >= st + dur ? 1 : bez(b, (t - st) / dur);

describe("explode segments and implode as the exact reverse (§7.2)", () => {
  test("explode to stage k starts at 0; its own delay has no effect", () => {
    const a = asmOf(
      scene(
        spec({
          assemblies: [
            tile(
              [
                box("x", [0, 0, 0], [1, 1, 1]),
                box("y", [2, 0, 0], [1, 1, 1]),
                box("z", [4, 0, 0], [1, 1, 1]),
              ],
              [
                {
                  id: "p",
                  stages: [
                    { parts: ["x"], duration: 1, delay: 3 },
                    { parts: ["y"], duration: 2, delay: 1 },
                    { parts: ["z"], duration: 1, with: "previous" },
                  ],
                },
              ],
            ),
          ],
        }),
      ),
    );
    const p = prog(a, "p");
    const seg = programSegment(p, 1, 3);
    expect(seg.length).toBe(2); // stage 2 (1 delay after stage 1) shifted to 0, ends at its 2 s
    expect(seg.moves.map((m) => [m.path, m.start])).toEqual([
      ["a/y", 0],
      ["a/z", 0],
    ]);
    // the first stage's delay of 3 s is part of the program but not of the segment
    expect(programSegment(p, 0, 1).length).toBe(1);
  });

  test("implode is the mirrored explode: positions agree at every sampled time (property)", () => {
    let seed = 99;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const EASINGS = Object.keys(BEZIER) as (keyof typeof BEZIER)[];
    for (let iter = 0; iter < 25; iter++) {
      const n = 5 + Math.floor(rnd() * 3);
      const parts = Array.from({ length: n }, (_, i) => box(`q-${i}`, [i * 2, 0, 0], [1, 1, 1]));
      const stages = Array.from({ length: Math.min(n, 4) }, (_, i) => ({
        parts: i === 0 ? ["q-0", "q-1"] : [`q-${i + 1}`],
        direction: ["up", "+x", "down", "+y"][Math.floor(rnd() * 4)],
        distance: 1 + Math.floor(rnd() * 3),
        stagger: Math.round(rnd() * 5) / 10,
        duration: 0.3 + Math.round(rnd() * 8) / 10,
        delay: Math.round(rnd() * 4) / 10,
        with: rnd() < 0.3 ? "previous" : "after",
        easing: EASINGS[Math.floor(rnd() * EASINGS.length)],
      }));
      const a = asmOf(scene(spec({ assemblies: [tile(parts, [{ id: "p", stages }])] })));
      const p = prog(a, "p");
      for (let lo = 0; lo < stages.length; lo++) {
        for (let hi = lo + 1; hi <= stages.length; hi++) {
          const ex = programSegment(p, lo, hi);
          const im = programSegment(p, hi, lo);
          expect(im.length).toBe(ex.length);
          expect(im.moves.length).toBe(ex.moves.length);
          for (let k = 0; k <= 20; k++) {
            const t = (ex.length * k) / 20;
            for (const e of ex.moves) {
              const r = im.moves.find((m) => m.path === e.path) as (typeof im.moves)[number];
              const posE = vec(e).map((v) => v * progress(e.start, e.duration, t, e.bezier));
              // the implode starts at the exploded pose and moves by -offset on the mirrored curve
              const posI = vec(e).map(
                (v, i) =>
                  v +
                  (vec(r)[i] as number) * progress(r.start, r.duration, ex.length - t, r.bezier),
              );
              posE.forEach((x, i) => expect(posI[i]).toBeCloseTo(x, 6));
            }
          }
        }
      }
    }
  });

  test("reversed moves carry the mirrored keyword and curve", () => {
    for (const e of Object.keys(BEZIER) as (keyof typeof BEZIER)[]) {
      const a = asmOf(
        scene(
          spec({
            assemblies: [
              tile(
                [box("x", [0, 0, 0], [1, 1, 1])],
                [{ id: "p", stages: [{ parts: ["x"], easing: e }] }],
              ),
            ],
          }),
        ),
      );
      const im = programSegment(prog(a, "p"), 1, 0).moves[0]!;
      expect(im.reversed).toBe(true);
      expect(im.easing).toBe(REVERSED_EASING[e]);
      expect(im.bezier).toEqual(mirrorBezier(BEZIER[e]));
      expect(im.offset.z).toBeLessThanOrEqual(0);
    }
  });
});

// ------------------------------------------------------------------------------------ the plan

const STEP_ASM = (steps: unknown[], programs?: unknown[], extra: Obj = {}): PlatformCosmoSpec =>
  spec({
    assemblies: [
      tile(
        [
          box("x", [0, 0, 0], [1, 1, 1]),
          box("y", [2, 0, 0], [1, 1, 1]),
          box("z", [4, 0, 0], [1, 1, 1]),
        ],
        programs ?? [
          {
            id: "p",
            stages: [
              { parts: ["x"], duration: 0.5, stagger: 0 },
              { parts: ["y", "z"], duration: 0.5, stagger: 0.46 },
            ],
          },
        ],
        extra,
      ),
    ],
    steps,
  });
// the two stages play 0.5 + (0.5 + 0.46) = 1.46 s end to end

describe("the step plan: levels, defaults, cursor (§7.2)", () => {
  test("levels are cumulative; implode reverses the program that exploded it; to ranges", () => {
    const g = scene(
      STEP_ASM([
        { assembly: [{ explode: "a", to: 1 }] },
        { assembly: [{ explode: "a" }] },
        { assembly: [{ implode: "a", to: 1 }] },
        { assembly: [{ implode: "a" }] },
      ]),
    );
    const plan = g.assemblies!.plan;
    expect(plan.map((s) => s.poses.a?.[0]?.level)).toEqual([1, 2, 1, 0]);
    expect(plan.map((s) => s.actions.map((x) => [x.kind, x.from, x.to]))).toEqual([
      [["explode", 0, 1]],
      [["explode", 1, 2]],
      [["implode", 2, 1]],
      [["implode", 1, 0]],
    ]);
    expect(plan.map((s) => s.actions[0]!.program)).toEqual(["p", "p", "p", "p"]);
  });

  test("invalid actions are left out (validation reports them); no throw", () => {
    const g = scene(
      STEP_ASM([
        { assembly: [{ explode: "a", to: 9 }, { explode: "nope" }, { implode: "a", to: 1 }] },
        { assembly: [{ explode: "a", to: 1 }, { explode: "a", to: 0 }, { build: "a" }] },
      ]),
    );
    const plan = g.assemblies!.plan;
    expect(plan[0]!.actions).toEqual([]); // out of range, unknown, implode forwards from 0
    expect(plan[1]!.actions.map((x) => [x.kind, x.to])).toEqual([["explode", 1]]); // backwards dropped
  });

  test("pose: exploded starts at the last stage; the default program rule follows A2-1", () => {
    const g = scene(STEP_ASM([{ assembly: [{ implode: "a" }] }], undefined, { pose: "exploded" }));
    const a = asmOf(g);
    expect(a.basePose).toEqual([{ program: "p", level: 2 }]);
    expect(g.assemblies!.plan[0]!.actions[0]).toMatchObject({ from: 2, to: 0, kind: "implode" });
    // `program` of another kind is ignored in favour of the first of the action's kind
    const two = STEP_ASM(
      [{ assembly: [{ explode: "a" }] }],
      [
        { id: "b", kind: "build", steps: [{ add: ["x"] }] },
        { id: "first", stages: [{ parts: ["x"] }] },
        { id: "second", stages: [{ parts: ["y"] }, { parts: ["z"] }] },
      ],
      { program: "b" },
    );
    expect(scene(two).assemblies!.plan[0]!.actions[0]!.program).toBe("first");
    const named = STEP_ASM(
      [{ assembly: [{ explode: "a" }] }],
      [
        { id: "first", stages: [{ parts: ["x"] }] },
        { id: "second", stages: [{ parts: ["y"] }, { parts: ["z"] }] },
      ],
      { program: "second" },
    );
    expect(scene(named).assemblies!.plan[0]!.actions[0]).toMatchObject({
      program: "second",
      to: 2,
    });
  });

  test("actions play in array order, each after the previous, unless `start` places them", () => {
    const g = scene(
      spec({
        assemblies: [
          tile([box("x", [0, 0, 0], [1, 1, 1]), box("y", [2, 0, 0], [1, 1, 1])], [], {}),
          {
            ...tile(
              [box("u", [0, 0, 0], [1, 1, 1])],
              [{ id: "q", stages: [{ parts: ["u"], duration: 1 }] }],
            ),
            id: "b",
          },
          {
            ...tile(
              [box("w", [0, 0, 0], [1, 1, 1])],
              [{ id: "r", stages: [{ parts: ["w"], duration: 2 }] }],
            ),
            id: "c",
          },
        ],
        steps: [
          { duration: 10, assembly: [{ explode: "b" }, { explode: "c" }] },
          { duration: 10, assembly: [{ implode: "b" }, { implode: "c", start: 5 }] },
        ],
      }),
    );
    const [s1, s2] = g.assemblies!.plan;
    expect(s1!.actions.map((x) => [x.target, x.start, x.length])).toEqual([
      ["b", 0, 1],
      ["c", 1, 2],
    ]);
    expect(s2!.actions.map((x) => [x.target, x.start, x.length])).toEqual([
      ["b", 0, 1],
      ["c", 5, 2],
    ]);
  });

  test("no actions, no steps: an empty plan", () => {
    expect(scene(STEP_ASM([])).assemblies!.plan).toEqual([]);
    expect(scene(STEP_ASM([{ duration: 2 }])).assemblies!.plan[0]).toMatchObject({
      actions: [],
      view: 0,
    });
  });
});

describe("step windows, compression and loop closure (§7.3, §7.4)", () => {
  // validation reports compression (through the same plan); the scene never repeats it
  const compressedOf = (g: SceneGraph): Diagnostic[] => {
    expect(codes(g.diagnostics, "assembly/compressed")).toEqual([]);
    const sp = specOf.get(g) as PlatformCosmoSpec;
    return assemblyPlanDiagnostics(sp, { isFocusTarget: (id) => isAssemblyPath(sp, id) });
  };

  test("compression is uniform and never overruns the window (floor)", () => {
    // need 1.46 s; a 1 s step has a 0.8 s window (hold 0.2): scale floor(0.8/1.46)
    const g = scene(STEP_ASM([{ duration: 1, assembly: [{ explode: "a" }, { implode: "a" }] }]));
    const [x1, x2] = g.assemblies!.plan[0]!.actions;
    const need = 1.46 * 2;
    // ends at base after the implode: no closing window, only the 0.2 s hold
    const window = 1 - 0.2;
    const scale = Math.floor((window / need) * 10000) / 10000;
    expect(x1!.scale).toBe(scale);
    expect(x2!.scale).toBe(scale);
    const end = x2!.start + x2!.length;
    expect(end).toBeLessThanOrEqual(window + 1e-9);
    expect(x2!.start).toBeCloseTo(Math.floor(1.46 * scale * 10000) / 10000, 4);
  });

  test("the suggested duration removes the compression, and one second less does not", () => {
    const want = (d: number, extra: Obj = {}): SceneGraph =>
      scene(STEP_ASM([{ duration: d, assembly: [{ explode: "a" }], ...extra }]));
    for (const extra of [{}, { focus: "a" }]) {
      const g = want(1, extra);
      const d = compressedOf(g)[0];
      expect(d, "compressed").toBeDefined();
      const suggested = (d!.params as { duration: number }).duration;
      expect(d!.suggestion).toBe(`Set "duration": ${suggested} on this step`);
      // the plan at the suggested duration needs no compression ...
      const ok = want(suggested, extra);
      expect(compressedOf(ok)).toEqual([]);
      expect(ok.assemblies!.plan[0]!.actions[0]!.scale).toBe(1);
      // ... and it is the smallest whole number of seconds that does
      if (suggested > 1) expect(compressedOf(want(suggested - 1, extra)).length).toBe(1);
    }
  });

  test("the suggestion is the shared fitDuration rule", () => {
    const g = scene(STEP_ASM([{ duration: 1, focus: "a", assembly: [{ explode: "a" }] }]));
    const d = compressedOf(g)[0]!;
    // focus: lead and closing transition both apply (the last step also closes back to overview)
    expect((d.params as { duration: number }).duration).toBe(fitDuration(1.46, true, true));
    const plain = compressedOf(
      scene(STEP_ASM([{ duration: 1, assembly: [{ explode: "a" }] }])),
    )[0]!;
    // no camera: the explode leaves the model away from base, so the last step still closes
    expect((plain.params as { duration: number }).duration).toBe(fitDuration(1.46, false, true));
  });

  test("info above 0.5 scale, warning below", () => {
    const light = compressedOf(scene(STEP_ASM([{ duration: 2, assembly: [{ explode: "a" }] }])));
    // window 2 - 0.5 - 0.2 = 1.3 < 1.46: scale 0.89 -> info
    expect(light[0]!.severity).toBe("info");
    const big = compressedOf(
      scene(
        STEP_ASM([
          { duration: 1, assembly: [{ explode: "a" }, { implode: "a" }, { explode: "a" }] },
        ]),
      ),
    );
    expect(big[0]!.severity).toBe("warning");
  });

  test("the last step reserves the closing window when it ends away from base (§7.4)", () => {
    // 1.46 s of motion: fits 3 s - 0.2 = 2.8 s, but not 3 - 0.75 - 0.2 = 2.05 s? it fits both:
    // use 2.2 s of motion (two explodes of 1.46 at 0.75 scale are not needed): use duration 2
    const away = scene(STEP_ASM([{ duration: 2, assembly: [{ explode: "a" }] }]));
    const home = scene(
      STEP_ASM([
        { duration: 2, assembly: [{ explode: "a" }] },
        { duration: 2, assembly: [{ implode: "a" }] },
      ]),
    );
    // step 1 of `home` does not close (its next step has the same overview): window 1.8 holds 1.46
    expect(home.assemblies!.plan[0]!.actions[0]!.scale).toBe(1);
    // the same step as the LAST step must close: window 2 - 0.5 - 0.2 = 1.3 < 1.46
    expect(away.assemblies!.plan[0]!.actions[0]!.scale).toBeLessThan(1);
    expect(away.assemblies!.plan[0]!.actions[0]!.scale).toBe(
      Math.floor((1.3 / 1.46) * 10000) / 10000,
    );
    // ending with the implode needs no closing window
    expect(home.assemblies!.plan[1]!.actions[0]!.scale).toBe(1);
    expect(transitionSeconds(2)).toBe(0.5);
  });

  test("figures and assemblies share one cursor, window and compression", () => {
    const imgs = [
      { id: "base", src: "a.png" },
      { id: "spr", src: "b.png" },
    ];
    const g = scene(
      spec({
        images: imgs,
        figures: [
          {
            id: "f",
            base: "base",
            parts: [{ id: "p1", image: "spr", seat: [0, 0] }],
            stages: [{ parts: ["p1"], duration: 1, stagger: 0 }],
          },
        ],
        assemblies: [
          tile(
            [box("x", [0, 0, 0], [1, 1, 1])],
            [{ id: "p", stages: [{ parts: ["x"], duration: 1 }] }],
          ),
        ],
        steps: [
          { duration: 3, assembly: [{ explode: "f" }, { explode: "a" }] },
          // ends with the assembly still exploded and the figure home: the closing window applies
          { duration: 2, assembly: [{ implode: "f" }] },
        ],
      }),
    );
    const [s1, s2] = g.assemblies!.plan;
    // one cursor: the assembly starts when the figure's action ends; 2 s of motion in a 2.8 s window
    expect(s1!.actions.map((x) => [x.target, x.start, x.length, x.scale])).toEqual([
      ["f", 0, 1, 1],
      ["a", 1, 1, 1],
    ]);
    // step 2 is last and the assembly (not the figure) is away from base: closing window
    // 2 - 0.5 - 0.2 = 1.3 holds the 1 s implode; poses of both kinds are in one record
    expect(s2!.actions[0]!.scale).toBe(1);
    expect(Object.keys(s2!.poses)).toEqual(["a", "f"]);
    expect(s2!.poses.a).toEqual([{ program: "p", level: 1 }]);
    expect(s2!.poses.f).toEqual([{ program: "stages", level: 0 }]);
    // shrink the last step so that only the closing window (not the plain one) is short: the
    // figure ends at base, the assembly does not, so the assembly alone closes the loop
    const tight = scene(
      spec({
        images: imgs,
        figures: [
          {
            id: "f",
            base: "base",
            parts: [{ id: "p1", image: "spr", seat: [0, 0] }],
            stages: [{ parts: ["p1"], duration: 1.9, stagger: 0 }],
          },
        ],
        assemblies: [
          tile([box("x", [0, 0, 0], [1, 1, 1])], [{ id: "p", stages: [{ parts: ["x"] }] }]),
        ],
        steps: [
          { duration: 6, assembly: [{ explode: "f" }, { explode: "a" }] },
          { duration: 2.2, assembly: [{ implode: "f" }] },
        ],
      }),
    );
    // window with closing 2.2 - 0.55 - 0.2 = 1.45 < 1.9, although 2.0 would hold it
    const act = tight.assemblies!.plan[1]!.actions[0]!;
    expect(act.target).toBe("f");
    expect(act.scale).toBe(Math.floor((1.45 / 1.9) * 10000) / 10000);
  });
});

// ------------------------------------------------------------------------------ implicit access

describe("implicit access for nested targets (§8.3)", () => {
  const NEST = (steps: unknown[]): PlatformCosmoSpec =>
    spec({
      assemblies: [
        tile(
          [
            box("rack", [0, 0, 0], [4, 4, 1], { role: "shell" }),
            box("srv", [1, 0, 1], [2, 3, 1], {
              parts: [box("tray", [0, 0, 0], [2, 3, 1]), box("lid", [0, 0, 1], [2, 3, 1])],
              programs: [
                { id: "internals", stages: [{ parts: ["lid"], duration: 1, stagger: 0 }] },
              ],
            }),
            box("other", [1, 0, 3], [2, 3, 1]),
          ],
          [
            {
              id: "pull",
              stages: [{ parts: ["srv"], direction: "drawer", duration: 2, stagger: 0 }],
            },
          ],
        ),
      ],
      steps,
    });

  test("the access move is prepended, listed, reported and reversed by the implode", () => {
    const g = scene(
      NEST([
        { duration: 10, assembly: [{ explode: "a/srv" }] },
        { duration: 10, assembly: [{ implode: "a/srv" }] },
      ]),
    );
    const [s1, s2] = g.assemblies!.plan;
    expect(s1!.actions[0]).toMatchObject({
      target: "a/srv",
      kind: "explode",
      program: "internals",
      from: 0,
      to: 1,
      implied: [{ program: "pull", level: 1, only: ["a/srv"] }],
      accessLength: 2,
    });
    // access (the drawer's own 2 s move) then the target's own program (1 s)
    expect(s1!.actions[0]!.length).toBe(3);
    // the parent's program stays at level 0: only the drawer is open
    expect(s1!.poses.a).toEqual([
      { program: "pull", level: 0, only: ["a/srv"] },
      { program: "srv/internals", level: 1 },
    ]);
    // reversal: the target returns, then the access move is undone
    expect(s2!.actions[0]).toMatchObject({
      kind: "implode",
      from: 1,
      to: 0,
      implied: [{ program: "pull", level: 0, only: ["a/srv"] }],
      accessLength: 2,
    });
    expect(s2!.actions[0]!.length).toBe(3);
    expect(s2!.poses.a).toEqual([
      { program: "pull", level: 0 },
      { program: "srv/internals", level: 0 },
    ]);
    const info = codes(g.diagnostics, "assembly/implicit-access");
    expect(info.map((d) => [d.severity, d.path])).toEqual([
      ["info", "/steps/0/assembly/0/explode"],
    ]);
  });

  test("no access move when the parent already displaced the target, or never moves it", () => {
    const done = scene(
      NEST([{ assembly: [{ explode: "a" }] }, { assembly: [{ explode: "a/srv" }] }]),
    );
    expect(done.assemblies!.plan[1]!.actions[0]!.implied).toEqual([]);
    expect(codes(done.diagnostics, "assembly/implicit-access")).toEqual([]);
    // `other` has no program, and the parent's program does not move it: nothing to open first
    const lone = scene(NEST([{ assembly: [{ explode: "a/other" }] }]));
    expect(lone.assemblies!.plan[0]!.actions).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------ reach

describe("reach bounds (§10)", () => {
  test("the reach box covers every pose of every level (and concurrent composed moves)", () => {
    const a = asmOf(
      scene(
        spec({
          assemblies: (engine().assemblies as unknown[]).slice(0, 1),
          steps: engine().steps as unknown[],
        }),
      ),
      "engine",
    );
    const p = prog(a, "teardown", "engine");
    const r = a.reachBounds;
    const inside = (b: {
      origin: { x: number; y: number; z: number };
      size: { x: number; y: number; z: number };
    }): void => {
      expect(b.origin.x).toBeGreaterThanOrEqual(r.origin.x - 1e-6);
      expect(b.origin.y).toBeGreaterThanOrEqual(r.origin.y - 1e-6);
      expect(b.origin.z).toBeGreaterThanOrEqual(r.origin.z - 1e-6);
      expect(b.origin.x + b.size.x).toBeLessThanOrEqual(r.origin.x + r.size.x + 1e-6);
      expect(b.origin.y + b.size.y).toBeLessThanOrEqual(r.origin.y + r.size.y + 1e-6);
      expect(b.origin.z + b.size.z).toBeLessThanOrEqual(r.origin.z + r.size.z + 1e-6);
    };
    const leaves = assemblyNodes(a).filter((n) => n.kind === "leaf");
    for (let level = 0; level <= p.stages.length; level++) {
      const moves = p.stages.slice(0, level).flatMap((s) => s.moves);
      for (const leaf of leaves) {
        // displacement = sum of the moves of the leaf and of every ancestor
        let dx = 0;
        let dy = 0;
        let dz = 0;
        for (const m of moves) {
          if (leaf.path === m.path || leaf.path.startsWith(`${m.path}/`)) {
            dx += m.offset.x;
            dy += m.offset.y;
            dz += m.offset.z;
          }
        }
        inside({
          origin: {
            x: leaf.world.origin.x + dx,
            y: leaf.world.origin.y + dy,
            z: leaf.world.origin.z + dz,
          },
          size: leaf.world.size,
        });
      }
    }
    // the unit is lifted so that no pose is below the ground (oil pan and crankshaft drop)
    expect(r.origin.z).toBeCloseTo(0, 6);
    expect(r.size.z).toBeGreaterThan(a.restBounds.size.z);
  });

  test("the endpoint hull would miss a concurrent sweep: intervals add along the owner chain", () => {
    // `head` rises then `valve` rises relative to it in a later stage; a +z then -z pair in
    // different programs of different owners adds as intervals, so reach exceeds either alone
    const parts = [
      box("base", [0, 0, 0], [2, 2, 1]),
      box("head", [0, 0, 1], [2, 2, 2], {
        parts: [box("cap", [0, 0, 0], [2, 2, 1]), box("valve", [0.5, 0.5, 1], [1, 1, 1])],
        programs: [{ id: "inner", stages: [{ parts: ["valve"], direction: "up", distance: 3 }] }],
      }),
    ];
    const g = scene(
      spec({
        assemblies: [
          tile(parts, [
            { id: "outer", stages: [{ parts: ["head"], direction: "up", distance: 4 }] },
          ]),
        ],
        steps: [{ assembly: [{ explode: "a" }, { explode: "a/head" }] }],
      }),
    );
    const a = asmOf(g);
    // valve top at rest: z = 3; moves 4 (head) + 3 (valve, relative to the head)
    expect(a.restBounds.origin.z + a.restBounds.size.z).toBe(3);
    expect(a.reachBounds.origin.z + a.reachBounds.size.z).toBeCloseTo(3 + 4 + 3, 6);
  });

  test("an unused program does not widen the reach; bounds-growth is reported", () => {
    const parts = [box("x", [0, 0, 0], [1, 1, 1]), box("y", [2, 0, 0], [1, 1, 1])];
    const programs = [
      { id: "used", stages: [{ parts: ["x"], direction: "up", distance: 1 }] },
      { id: "far", stages: [{ parts: ["y"], direction: "up", distance: 50 }] },
    ];
    const g = scene(
      spec({
        assemblies: [tile(parts, programs)],
        steps: [{ assembly: [{ explode: "a", program: "used" }] }],
      }),
    );
    expect(asmOf(g).reachBounds.size.z).toBeCloseTo(2, 6);
    expect(codes(g.diagnostics, "assembly/bounds-growth")).toEqual([]);
    const big = scene(
      spec({
        assemblies: [tile(parts, programs)],
        steps: [{ assembly: [{ explode: "a", program: "far" }] }],
      }),
    );
    expect(codes(big.diagnostics, "assembly/bounds-growth")).toHaveLength(1);
    expect(asmOf(big).reachBounds.size.z).toBeCloseTo(51, 6);
  });

  test("a static spec still reserves the room of an exploded base pose", () => {
    const parts = [box("x", [0, 0, 0], [1, 1, 1])];
    const g = scene(
      spec({
        assemblies: [
          tile(parts, [{ id: "p", stages: [{ parts: ["x"], direction: "up", distance: 5 }] }], {
            pose: "exploded",
          }),
        ],
      }),
    );
    expect(asmOf(g).reachBounds.size.z).toBeCloseTo(6, 6);
    const plain = scene(
      spec({
        assemblies: [
          tile(parts, [{ id: "p", stages: [{ parts: ["x"], direction: "up", distance: 5 }] }]),
        ],
      }),
    );
    expect(asmOf(plain).reachBounds.size.z).toBeCloseTo(1, 6); // nothing plays the program
  });
});

// ------------------------------------------------------------------------- determinism and fuzz

describe("determinism, bounds, 1.1 identity and agreement with validation", () => {
  test("the engine example: pinned numbers, identical on repeat", () => {
    const s = spec({ assemblies: engine().assemblies, steps: engine().steps });
    const a = scene(s);
    const b = scene(structuredClone(s));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const p = prog(asmOf(a, "engine"), "teardown", "engine");
    // stage times (uncompressed program time): three stages, staggered and delayed
    expect(p.stages.map((x) => [x.start, x.end])).toEqual([
      [0, 0.96],
      [0.96, 1.92],
      [1.92, 3.32],
    ]);
    expect(p.stages[2]!.moves.map((m) => m.path)).toEqual([
      "engine/intake",
      "engine/exhaust",
      "engine/crankshaft",
      "engine/pr-1",
      "engine/pr-2",
      "engine/pr-3",
      "engine/pr-4",
    ]);
    const plan = a.assemblies!.plan;
    expect(plan.map((x) => x.actions.map((y) => [y.kind, y.from, y.to, y.length]))).toEqual([
      [],
      [["explode", 0, 1, 0.96]],
      [["explode", 1, 2, 0.96]],
      [["explode", 2, 3, 1.4]],
      [["implode", 3, 0, 3.32]],
    ]);
  });

  test("1.1 specs gain nothing: no assemblies, no assembly diagnostics", () => {
    const dir = new URL("../../../examples/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith(".cosmo.json"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const g = scene(JSON.parse(readFileSync(new URL(f, dir), "utf8")) as PlatformCosmoSpec);
      expect(g.assemblies, f).toBeUndefined();
      expect(
        g.diagnostics.filter((d) => /^(assembly|budget\/time)/.test(d.code)),
        f,
      ).toEqual([]);
    }
    const plain = scene(spec({ nodes: [{ id: "n", type: "server" }], steps: [{ duration: 2 }] }));
    expect(plain.assemblies).toBeUndefined();
  });

  test("plan and validation agree on which actions are valid (randomized)", () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    for (let iter = 0; iter < 40; iter++) {
      const steps = Array.from({ length: 1 + rnd(4) }, () => ({
        duration: 5,
        assembly: Array.from({ length: 1 + rnd(3) }, () => {
          const kind = ["explode", "implode"][rnd(2)] as string;
          const to = rnd(4);
          return rnd(2) === 0 ? { [kind]: "engine" } : { [kind]: "engine", to };
        }),
      }));
      const s = spec({ assemblies: engine().assemblies, steps });
      const lifted = {
        phase1a: false,
        phase1b: false,
        phase2: true,
        storyboards: true,
        phase3: true,
      };
      const errors = assemblyDiagnostics(s, lifted).filter((d) => d.severity === "error");
      const invalid = new Set(
        errors.map((d) => /^\/steps\/(\d+)\/assembly\/(\d+)/.exec(d.path)?.slice(1).join(":")),
      );
      const plan = scene(s).assemblies!.plan;
      steps.forEach((st, si) => {
        const planned = plan[si]!.actions.length;
        const bad = st.assembly.filter((_, ai) => invalid.has(`${si}:${ai}`)).length;
        expect(planned, JSON.stringify(steps[si])).toBe(st.assembly.length - bad);
      });
    }
  });

  test("bounded work: many programs over a big flat assembly degrade and never throw", () => {
    const n = 1500;
    const parts = Array.from({ length: n }, (_, i) =>
      box(`p-${i}`, [i % 40, Math.floor(i / 40), 0], [1, 1, 1]),
    );
    const programs = Array.from({ length: 120 }, (_, i) => ({
      id: `g${i}`,
      stages: [{ parts: ["**"], direction: "lift" }],
    }));
    const t0 = Date.now();
    const g = scene(
      spec({ assemblies: [tile(parts, programs)], steps: [{ assembly: [{ explode: "a" }] }] }),
    );
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(codes(g.diagnostics, "budget/time").length).toBeGreaterThan(0);
    expect(asmOf(g).programs.length).toBeLessThan(120);
  });

  test("garbage in programs never throws", () => {
    const bad: unknown[] = [
      { id: "p", stages: [{ parts: ["x"], direction: [NaN, "a", null], distance: "abc" }] },
      { id: "q", stages: [{ parts: ["x"], distance: -5, duration: -1, stagger: -2, delay: "x" }] },
      {
        id: "r",
        stages: [
          { parts: ["nope/**/???"], except: ["**"], overrides: { zzz: {}, x: { order: "a" } } },
        ],
      },
      { id: "s", stages: [] },
      { id: "u", stages: [null, 7, { parts: "x" }, { parts: ["x"], except: 5 }] },
      { id: "t" },
      "junk",
    ];
    for (const prog_ of bad) {
      const s = spec({
        assemblies: [tile([box("x", [0, 0, 0], [1, 1, 1])], [prog_])],
        steps: [{ assembly: [{ explode: "a" }, { implode: "a", to: 9 }, { explode: "a/x/y" }] }],
      });
      expect(() => scene(s)).not.toThrow();
    }
  });

  test("direct API: AssemblyPrograms attaches programs to placed assemblies, origin independent", () => {
    const s = STEP_ASM([{ assembly: [{ explode: "a" }] }]);
    const progs = new AssemblyPrograms(s);
    const built = buildAssemblies(s, { reach: progs.reach });
    const attached = progs.attach(built);
    expect(attached.assemblies[0]!.programs).toHaveLength(1);
    expect(attached.assemblies[0]!.programs[0]).toMatchObject({
      kind: "explode",
      id: "p",
      owner: "a",
    });
    // placing the same unit at another position gives the same moves
    const moved = buildAssemblies(
      STEP_ASM([{ assembly: [{ explode: "a" }] }], undefined, { pos: { x: 40, y: 9 } }),
      {},
    );
    const p2 = new AssemblyPrograms(
      moved.assemblies.length > 0
        ? STEP_ASM([{ assembly: [{ explode: "a" }] }], undefined, { pos: { x: 40, y: 9 } })
        : s,
    );
    expect(p2.attach(moved).assemblies[0]!.programs).toEqual(attached.assemblies[0]!.programs);
  });

  test("credits: part sources reach the scene once, in first-use order", () => {
    const src = { document: "Manual", page: 3, license: "CC-BY-4.0" };
    const g = scene(
      spec({
        assemblies: [
          tile(
            [
              box("x", [0, 0, 0], [1, 1, 1], { source: src }),
              box("y", [2, 0, 0], [1, 1, 1], { source: src }),
            ],
            [{ id: "p", stages: [{ parts: ["x"] }] }],
          ),
        ],
      }),
    );
    expect(g.assemblies!.credits).toEqual([src]);
  });
});
