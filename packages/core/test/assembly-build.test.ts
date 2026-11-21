import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Diagnostic, ResolvedBuildProgram, SceneAssembly, SceneGraph } from "../src/index.js";
import { buildScene } from "../src/index.js";
import { assemblyDiagnostics } from "../src/schema/assembly-semantic.js";
import type { PlatformCosmoSpec } from "../src/schema/types.gen.js";
import {
  MAX_BUILD_STEPS,
  appearance,
  buildSegment,
  loopStartFades,
  presenceDiff,
  presentAt,
  resolveBuild,
  viewAt,
} from "../src/scene/assembly/build.js";
import { AssemblyPrograms, assemblyPlanDiagnostics } from "../src/scene/assembly/plan.js";
import { OwnerSelectors, indexOwner, makeWork } from "../src/scene/assembly/selectors.js";
import { AssemblyModel } from "../src/schema/assembly-tree.js";
import type { TNode } from "../src/schema/assembly-tree.js";
import { BEZIER, fitDuration, stepWindows } from "../src/scene/boards.js";

// A2-6: build programs (docs/design/assemblies.md §6.5, §7.2, §7.4, §7.7, §18).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const spec = (o: Obj): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...o }) as unknown as PlatformCosmoSpec;
const scene = (s: PlatformCosmoSpec): SceneGraph => buildScene(s, {});
const asmOf = (g: SceneGraph, id = "a"): SceneAssembly =>
  g.assemblies!.assemblies.find((x) => x.id === id) as SceneAssembly;
const bprog = (a: SceneAssembly, id = "b", owner = a.id): ResolvedBuildProgram =>
  a.programs.find((p) => p.id === id && p.owner === owner) as ResolvedBuildProgram;
const codes = (d: readonly Diagnostic[], code: string): Diagnostic[] =>
  d.filter((x) => x.code === code);
const box = (id: string, at: number[], size: number[], extra: Obj = {}): Obj => ({
  id,
  at,
  size,
  ...extra,
});
const build = (steps: Obj[], id = "b"): Obj => ({ id, kind: "build", steps });
/** One tile-unit assembly `a` (world scale 1: offsets read as authored). */
const tile = (parts: unknown[], programs: unknown[], extra: Obj = {}): Obj => ({
  id: "a",
  units: "tile",
  parts,
  programs,
  ...extra,
});
const OPEN = { phase1a: false, phase1b: false, phase2: false, phase3: false };
const vec = (m: { offset: { x: number; y: number; z: number } }): number[] => [
  m.offset.x,
  m.offset.y,
  m.offset.z,
];
const near = (got: number[], want: number[]): void => {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => expect(g).toBeCloseTo(want[i] as number, 6));
};

/** Seeded PRNG (mulberry32): the randomized tests are reproducible. */
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Cubic-bezier easing value at progress x (own bisection: independent of the engine). */
function ease(b: readonly number[], x: number): number {
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
}

// ---------------------------------------------------------------------------------------------
// The brick rover of §19.5, with boxes for bricks (core has no brick pack)
// ---------------------------------------------------------------------------------------------

const stripShapes = (o: unknown): void => {
  if (Array.isArray(o)) o.forEach(stripShapes);
  else if (o !== null && typeof o === "object") {
    delete (o as Obj).shape;
    for (const v of Object.values(o)) stripShapes(v);
  }
};
const rover = (steps?: Obj[]): PlatformCosmoSpec => {
  const md = readFileSync(new URL("../../../docs/design/assemblies.md", import.meta.url), "utf8");
  const s = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .find((x) => x.meta?.title === "Brick rover") as Obj;
  stripShapes(s.assemblies);
  if (steps !== undefined) s.steps = steps;
  return s as unknown as PlatformCosmoSpec;
};

describe("the brick rover (§19.5), without sub-builds", () => {
  const g = scene(rover());
  const a = asmOf(g, "rover");
  const main = bprog(a, "build", "rover");

  test("levels: build 2 + 2 + 2 + 2, then explode and implode", () => {
    const plan = g.assemblies!.plan;
    expect(plan.map((p) => p.actions.map((x) => [x.kind, x.program, x.from, x.to]))).toEqual([
      [["build", "build", 0, 2]],
      [["build", "build", 2, 4]],
      [["build", "build", 4, 6]],
      [["build", "build", 6, 8]],
      [["explode", "explode", 0, 3]],
      [["implode", "explode", 3, 0]],
    ]);
    expect(plan[2]!.poses.rover).toEqual([
      { program: "build", level: 6 },
      { program: "cab/cab-build", level: 3 },
      { program: "explode", level: 0 },
    ]);
    // the finished rover is the base pose of the build programs
    expect(a.basePose).toEqual([
      { program: "build", level: 8 },
      { program: "cab/cab-build", level: 3 },
      { program: "explode", level: 0 },
    ]);
    expect(codes(g.diagnostics, "assembly/build-path-blocked")).toEqual([]);
  });

  test("steps: numbers, captions, leaves added once, empty base", () => {
    expect(main.steps.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(main.steps.map((s) => s.caption)).toEqual([
      "Base plate",
      "Sides and rear wall",
      "Wheels",
      "Floor tiles and lamps",
      "Nose",
      "Cab (sub-build)",
      "Cargo and rails",
      "Lids and antenna",
    ]);
    expect(main.steps.map((s) => s.adds.length)).toEqual([1, 3, 4, 5, 1, 10, 4, 5]);
    expect(main.base).toEqual([]);
    const all = main.steps.flatMap((s) => s.adds);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...a.leaves].sort());
    // step windows follow each other; stagger 0.1, duration 0.6 (schema defaults)
    expect(main.steps.map((s) => [s.start, s.end])).toEqual([
      [0, 0.6],
      [0.6, 1.4],
      [1.4, 2.3],
      [2.3, 3.3],
      [3.3, 3.9],
      [3.9, 4.5],
      [4.5, 5.4],
      [5.4, 6.4],
    ]);
  });

  test("entry moves: above for the plate, outside for the wheels; offset = seat - origin", () => {
    const sz = a.root.local.size;
    const gap = 0.1 * Math.max(sz.x, sz.y, sz.z);
    const plate = main.steps[0]!.moves[0]!;
    expect(plate.path).toBe("rover/plate");
    // plate is 1 plate tall: it starts (extent + gap) studs above its seat
    near(vec(plate), [0, 0, -(1 + gap) * a.frame.scale.z]);
    const wheels = main.steps[2]!.moves;
    expect(wheels.map((m) => m.path)).toEqual([
      "rover/wheel-l-1",
      "rover/wheel-l-2",
      "rover/wheel-r-1",
      "rover/wheel-r-2",
    ]);
    // wheels leave sideways: left ones to -x (so they travel +x), right ones to +x; never vertical
    for (const m of wheels) {
      expect(m.offset.y).toBe(0);
      expect(m.offset.z).toBe(0);
    }
    expect(wheels[0]!.offset.x).toBeGreaterThan(0);
    expect(wheels[2]!.offset.x).toBeLessThan(0);
    // bottom-up stagger inside a step
    expect(main.steps[1]!.moves.map((m) => m.start)).toEqual([0.6, 0.7, 0.8]);
  });

  test("views: set by steps 5 and 6, and the plan carries the view in effect", () => {
    expect(main.steps.map((s) => s.view)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      90,
      0,
      undefined,
      undefined,
    ]);
    expect(viewAt(main, 4)).toBe(0);
    expect(viewAt(main, 5)).toBe(90);
    expect(viewAt(main, 6)).toBe(0);
    expect(viewAt(bprog(a, "cab-build", "rover/cab"), 3)).toBeUndefined();
    const v = scene(
      rover([
        { duration: 4, assembly: [{ build: "rover", program: "build", to: 5 }] },
        { duration: 4, assembly: [{ explode: "rover", program: "explode" }] },
        { duration: 4, assembly: [{ build: "rover", program: "build", to: 6 }] },
        { duration: 4, assembly: [{ unbuild: "rover", program: "build", to: 5 }] },
        { duration: 4, assembly: [{ unbuild: "rover", program: "build", to: 4 }] },
      ]),
    );
    expect(v.assemblies!.plan.map((p) => p.view)).toEqual([90, 90, 0, 90, 0]);
    expect(v.assemblies!.views!.map((x) => x.turn)).toEqual([0, 90]);
  });

  test("callouts group the leaves of a step by shape, size, colour and image", () => {
    expect(main.steps[1]!.callout).toEqual([
      { count: 2, sample: "rover/side-1" },
      { count: 1, sample: "rover/rear-wall" },
    ]);
    expect(main.steps[3]!.callout).toEqual([
      { count: 3, sample: "rover/tile-1" },
      { count: 2, sample: "rover/lamp-1" },
    ]);
    // the cab step adds one unit of 10 leaves; wall-1/2 share size and colour
    const cab = main.steps[5]!.callout;
    expect(cab.reduce((n, c) => n + c.count, 0)).toBe(10);
    expect(cab.find((c) => c.sample === "rover/cab/wall-1")!.count).toBe(2);
    // sub-build and callout flights are Phase 3 (A2-7): hooks only, nothing is staged
    expect(main.steps[5]!.subBuild).toBeUndefined();
    expect(main.steps[6]!.moves.every((m) => m.overlayDuration === undefined)).toBe(true);
    expect(main.steps[5]!.moves.map((m) => m.path)).toEqual(["rover/cab"]);
  });

  test("the sub-assembly's own program resolves in its owner", () => {
    const cab = bprog(a, "cab-build", "rover/cab");
    expect(cab.steps.map((s) => s.adds.length)).toEqual([1, 4, 5]);
    expect(cab.base).toEqual([]);
    expect(cab.steps[2]!.adds).toContain("rover/cab/roof-b-2");
  });
});

// ---------------------------------------------------------------------------------------------
// Origins and distances (hand-computed, tile units: scale 1)
// ---------------------------------------------------------------------------------------------

describe("origins and distances", () => {
  // owner 4 x 4 x 3 -> gap 0.4
  const base = box("base", [0, 0, 0], [4, 4, 1]);
  const one = (step: Obj, parts: Obj[] = []): ResolvedBuildProgram =>
    bprog(
      asmOf(
        scene(
          spec({
            assemblies: [
              tile(
                [base, box("p", [1, 1, 1], [1, 1, 1]), box("top", [0, 0, 2], [4, 4, 1]), ...parts],
                [build([{ add: ["base"] }, { add: ["p"], ...step }, { add: ["top"] }])],
              ),
            ],
          }),
        ),
      ),
    );
  const move = (p: ResolvedBuildProgram): ReturnType<typeof vec> => vec(p.steps[1]!.moves[0]!);

  test("above: extent + gap by default, scaled by `Nx`, or a fixed number", () => {
    near(move(one({})), [0, 0, -1.4]);
    near(move(one({ distance: "2x" })), [0, 0, -2.8]);
    near(move(one({ distance: 5 })), [0, 0, -5]);
  });

  test("axes and vectors: the origin lies in that direction; offset = seat - origin", () => {
    near(move(one({ from: "+x" })), [-1.4, 0, 0]);
    near(move(one({ from: "-y" })), [0, 1.4, 0]);
    near(move(one({ from: "-x", distance: 2 })), [2, 0, 0]);
    near(move(one({ from: [0, 3, 0], distance: 2 })), [0, -2, 0]);
  });

  test("outside: the shortest horizontal way out of the current bounds", () => {
    // `p` sits near the +x edge of a 4 x 4 base: 4 - 3 = 1 to leave through +x, the others 3+
    const p = bprog(
      asmOf(
        scene(
          spec({
            assemblies: [
              tile(
                [base, box("p", [3, 1, 1], [1, 1, 1])],
                [build([{ add: ["base"] }, { add: ["p"], from: "outside" }])],
              ),
            ],
          }),
        ),
      ),
    );
    // leaves through +x: d = extent 1 + gap (0.1 * 4) = 1.4 (clearing the plate is shorter)
    const m = p.steps[1]!.moves[0]!;
    expect(m.offset.x).toBeLessThan(0);
    expect(m.offset.y).toBe(0);
    expect(m.offset.z).toBe(0);
  });

  test("a part added with its siblings stacks above the earlier one instead of crossing it", () => {
    const p = bprog(
      asmOf(
        scene(
          spec({
            assemblies: [
              tile(
                [base, box("c1", [1, 1, 1], [1, 1, 1]), box("c2", [1, 1, 2], [1, 1, 1])],
                [build([{ add: ["base"] }, { add: ["c*"] }])],
              ),
            ],
          }),
        ),
      ),
    );
    const [m1, m2] = p.steps[1]!.moves;
    expect(m1!.path).toBe("a/c1");
    // c2 rides above c1's start: c1.max + d1 + gap - c2.min = (2 + 1.2) + 0.4 - 2
    expect(-m2!.offset.z).toBeGreaterThan(-m1!.offset.z);
    expect(m1!.start).toBeLessThan(m2!.start); // bottom-up
  });

  test("callout origin drops like above (the flight is A2-7)", () => {
    near(move(one({ from: "callout" })), [0, 0, -1.4]);
  });
});

// ---------------------------------------------------------------------------------------------
// Blocked paths
// ---------------------------------------------------------------------------------------------

describe("assembly/build-path-blocked", () => {
  const roofed = (step: Obj, order: "roof-first" | "wall-first" = "roof-first"): SceneGraph =>
    scene(
      spec({
        assemblies: [
          tile(
            [
              box("floor", [0, 0, 0], [4, 4, 1]),
              box("wall", [0, 0, 1], [1, 4, 2]),
              box("roof", [0, 0, 3], [4, 4, 1]),
            ],
            [
              build(
                order === "roof-first"
                  ? [{ add: ["floor"] }, { add: ["roof"] }, { add: ["wall"], ...step }]
                  : [{ add: ["floor"] }, { add: ["wall"], ...step }, { add: ["roof"] }],
              ),
            ],
          ),
        ],
      }),
    );

  test("a placed part over the seat warns and suggests a side origin", () => {
    const d = codes(roofed({}).diagnostics, "assembly/build-path-blocked");
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe("warning");
    expect(d[0]!.path).toBe("/assemblies/0/programs/0/steps/2/from");
    expect(d[0]!.params).toMatchObject({ step: 3, part: "a/wall", blockedBy: "a/roof" });
    expect(d[0]!.suggestion).toContain("outside");
  });

  test("no warning when the roof comes later, from a side, or from the callout hover only if clear", () => {
    expect(codes(roofed({}, "wall-first").diagnostics, "assembly/build-path-blocked")).toEqual([]);
    expect(codes(roofed({ from: "outside" }).diagnostics, "assembly/build-path-blocked")).toEqual(
      [],
    );
    expect(codes(roofed({ from: "+x" }).diagnostics, "assembly/build-path-blocked")).toEqual([]);
    // from the callout the part still drops from above: blocked as well
    expect(
      codes(roofed({ from: "callout" }).diagnostics, "assembly/build-path-blocked"),
    ).toHaveLength(1);
  });

  test("a part beside (not over) the seat does not block, nor one below it", () => {
    const g = scene(
      spec({
        assemblies: [
          tile(
            [
              box("floor", [0, 0, 0], [4, 4, 1]),
              box("beside", [3, 0, 1], [1, 4, 3]),
              box("p", [0, 0, 1], [2, 2, 1]),
            ],
            [build([{ add: ["floor", "beside"] }, { add: ["p"] }])],
          ),
        ],
      }),
    );
    expect(codes(g.diagnostics, "assembly/build-path-blocked")).toEqual([]);
    // a placed collar that overlaps the peg's own height (not over it) is no obstacle
    const peg = scene(
      spec({
        assemblies: [
          tile(
            [
              box("floor", [0, 0, 0], [4, 4, 1]),
              box("collar", [0, 0, 2], [2, 2, 1]),
              box("peg", [0, 0, 1], [1, 1, 2]),
            ],
            [build([{ add: ["floor", "collar"] }, { add: ["peg"] }])],
          ),
        ],
      }),
    );
    expect(codes(peg.diagnostics, "assembly/build-path-blocked")).toEqual([]);
  });

  test("reported per step and capped at 50 (diagnostics-capped, §18)", () => {
    const parts: Obj[] = [box("lid", [0, 0, 10], [80, 1, 1])];
    const steps: Obj[] = [{ add: ["lid"] }];
    for (let i = 0; i < 60; i++) {
      parts.push(box(`w${i}`, [i, 0, 1], [1, 1, 1]));
      steps.push({ add: [`w${i}`] });
    }
    const g = scene(spec({ assemblies: [tile(parts, [build(steps)])] }));
    expect(codes(g.diagnostics, "assembly/build-path-blocked")).toHaveLength(50);
    const cap = codes(g.diagnostics, "assembly/diagnostics-capped");
    expect(cap).toHaveLength(1);
    expect(cap[0]!.params).toMatchObject({ omitted: 10 });
  });
});

// ---------------------------------------------------------------------------------------------
// Unbuild is the exact reverse
// ---------------------------------------------------------------------------------------------

describe("unbuild reverses the build", () => {
  const EASINGS = Object.keys(BEZIER) as (keyof typeof BEZIER)[];
  const random = (seed: number): ResolvedBuildProgram => {
    const r = rng(seed);
    const n = 3 + Math.floor(r() * 4);
    const parts: Obj[] = [];
    const steps: Obj[] = [];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
        parts.push(box(`s${i}k${k}`, [k * 2, i * 2, 0], [1, 1, 1]));
      }
      steps.push({
        add: [`s${i}k*`],
        duration: 0.3 + Math.floor(r() * 10) / 10,
        stagger: Math.floor(r() * 4) / 10,
        easing: EASINGS[Math.floor(r() * EASINGS.length)],
        from: ["above", "+x", "-y", "outside"][Math.floor(r() * 4)],
      });
    }
    return bprog(asmOf(scene(spec({ assemblies: [tile(parts, [build(steps)])] }))));
  };

  /** Seat-relative displacement of every moved path at time t of a segment (own formula). */
  function trajectories(
    seg: ReturnType<typeof buildSegment>,
    t: number,
  ): Map<string, [number, number, number]> {
    const out = new Map<string, [number, number, number]>();
    for (const m of seg.moves) {
      const p = Math.min(1, Math.max(0, (t - m.start) / m.duration));
      const e = ease(m.bezier, p);
      // a build move runs from -offset to 0 (starts at its origin); the move's `offset` is the
      // displacement from its start pose, so the seat-relative pose is -offset + e * offset
      const sign = seg.kind === "build" ? -1 : 0; // unbuild moves start AT the seat
      const o = [m.offset.x, m.offset.y, m.offset.z];
      out.set(
        m.path,
        [0, 1, 2].map((i) => sign * (o[i] as number) + e * (o[i] as number)) as never,
      );
    }
    return out;
  }

  test("every sampled instant of the unbuild equals the build played backwards", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const p = random(seed);
      const n = p.steps.length;
      const r = rng(seed * 7);
      const b = Math.floor(r() * n);
      const a = b + 1 + Math.floor(r() * (n - b));
      const fwd = buildSegment(p, b, a);
      const rev = buildSegment(p, a, b);
      expect(rev.kind).toBe("unbuild");
      expect(rev.length).toBe(fwd.length);
      expect(rev.moves.length).toBe(fwd.moves.length);
      for (let k = 0; k <= 24; k++) {
        const t = (fwd.length * k) / 24;
        const f = trajectories(fwd, fwd.length - t);
        const u = trajectories(rev, t);
        for (const [path, v] of f) near(u.get(path) as number[], v as number[]);
      }
    }
  });

  test("leaves vanish in the reverse order and at the mirrored instants", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const p = random(seed + 100);
      const n = p.steps.length;
      const fwd = appearance(p, 0, n);
      const rev = appearance(p, n, 0);
      const L = buildSegment(p, 0, n).length;
      expect(fwd.every((x) => x.visible)).toBe(true);
      expect(rev.every((x) => !x.visible)).toBe(true);
      const startOf = new Map(fwd.map((x) => [x.path, x.at]));
      expect(rev.length).toBe(fwd.length);
      for (const x of rev) expect(x.at).toBeCloseTo(L - (startOf.get(x.path) as number), 3);
    }
  });

  test("the planned unbuild is as long as the build and ends at the same level", () => {
    const p = random(3);
    const n = p.steps.length;
    const s = spec({
      assemblies: [
        tile(
          p.steps.flatMap((st) => st.adds.map((l) => box(l.split("/")[1]!, [0, 0, 0], [1, 1, 1]))),
          [build(p.steps.map((st) => ({ add: st.adds.map((l) => l.split("/")[1]) })))],
        ),
      ],
      steps: [
        { duration: 30, assembly: [{ build: "a", to: n }] },
        { duration: 30, assembly: [{ unbuild: "a" }] },
      ],
    });
    const [s1, s2] = scene(s).assemblies!.plan;
    expect(s2!.actions[0]!.kind).toBe("unbuild");
    expect([s2!.actions[0]!.from, s2!.actions[0]!.to]).toEqual([n, 0]);
    expect(s2!.actions[0]!.length).toBe(s1!.actions[0]!.length);
  });

  test("presence: base + adds of the steps done", () => {
    const g = scene(
      spec({
        assemblies: [
          tile(
            [
              box("a1", [0, 0, 0], [1, 1, 1]),
              box("b1", [1, 0, 0], [1, 1, 1]),
              box("c1", [2, 0, 0], [1, 1, 1]),
            ],
            [build([{ add: ["b1"] }, { add: ["c1"] }])],
          ),
        ],
      }),
    );
    const p = bprog(asmOf(g));
    expect(p.base).toEqual(["a/a1"]);
    expect([...presentAt(p, 0)]).toEqual(["a/a1"]);
    expect([...presentAt(p, 1)].sort()).toEqual(["a/a1", "a/b1"]);
    expect([...presentAt(p, 99)].sort()).toEqual(["a/a1", "a/b1", "a/c1"]);
    expect(presenceDiff(p, 2, 0)).toEqual({ appear: [], vanish: ["a/b1", "a/c1"] });
    expect(presenceDiff(p, 1, 2)).toEqual({ appear: ["a/c1"], vanish: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// Agreement with validation (the shared level machine), randomized
// ---------------------------------------------------------------------------------------------

describe("levels agree with validation", () => {
  const N = 5;
  const asm = (pose?: string): Obj =>
    tile(
      Array.from({ length: N }, (_, i) => box(`p${i}`, [i, 0, 0], [1, 1, 1])),
      [build(Array.from({ length: N }, (_, i) => ({ add: [`p${i}`] })))],
      pose === undefined ? {} : { pose },
    );

  /** §7.2 written out from the doc, not from the code. */
  function oracle(
    actions: Obj[],
    pose: string | undefined,
  ): { ok: boolean; from?: number; to?: number; code?: string }[] {
    let level: number | undefined;
    return actions.map((a) => {
      const kind = "build" in a ? "build" : "unbuild";
      let cur = level;
      if (cur === undefined) {
        if (kind === "build")
          cur = a.to !== undefined && a.advance !== undefined ? a.to - a.advance : 0;
        else cur = pose === "empty" ? 0 : N;
      }
      if (cur < 0) return { ok: false, code: "assembly/stage-out-of-range" };
      let to: number;
      if (a.to !== undefined) to = a.to;
      else if (kind === "unbuild") to = 0;
      else to = a.advance !== undefined ? cur + a.advance : cur + 1;
      if (to > N) return { ok: false, code: "assembly/stage-out-of-range" };
      if (kind === "build" && to < cur) return { ok: false, code: "assembly/build-backwards" };
      if (kind === "unbuild" && to > cur) return { ok: false, code: "assembly/unbuild-forwards" };
      level = to;
      return { ok: true, from: cur, to };
    });
  }

  test("random to/advance sequences: plan = oracle, and validation reports exactly the rest", () => {
    const r = rng(2026);
    for (let round = 0; round < 150; round++) {
      const pose = r() < 0.2 ? "empty" : undefined;
      const len = 1 + Math.floor(r() * 5);
      const actions: Obj[] = [];
      for (let i = 0; i < len; i++) {
        const a: Obj = r() < 0.6 ? { build: "a" } : { unbuild: "a" };
        if (r() < 0.55) a.to = Math.floor(r() * (N + 2));
        if (a.build !== undefined && r() < 0.45) a.advance = 1 + Math.floor(r() * 4);
        actions.push(a);
      }
      const s = spec({
        assemblies: [asm(pose)],
        steps: actions.map((a) => ({ duration: 60, assembly: [a] })),
      });
      const want = oracle(actions, pose);
      const planned = scene(s).assemblies!.plan.flatMap((p) => p.actions);
      const ok = want.flatMap((w) => (w.ok ? [[w.from, w.to]] : []));
      expect(
        planned.map((x) => [x.from, x.to]),
        JSON.stringify(actions),
      ).toEqual(ok);
      const errs = assemblyDiagnostics(s, OPEN)
        .filter((d) => d.severity === "error")
        .map((d) => d.code);
      expect(errs, JSON.stringify(actions)).toEqual(want.flatMap((w) => (w.ok ? [] : [w.code])));
    }
  });

  test("the timeline starts at k - advance: earlier poses show that level, rest shows finished", () => {
    const s = spec({
      assemblies: [asm()],
      steps: [
        { duration: 3 },
        { duration: 3, assembly: [{ build: "a", to: 3, advance: 2 }] },
        { duration: 3, assembly: [{ build: "a", to: 5 }] },
      ],
    });
    const g = scene(s);
    const a = asmOf(g);
    expect(g.assemblies!.plan.map((p) => p.poses.a![0]!.level)).toEqual([1, 3, 5]);
    expect(a.basePose).toEqual([{ program: "b", level: N }]);
    const fades = loopStartFades(a, g.assemblies!.plan);
    expect(fades).toHaveLength(1);
    expect([fades[0]!.startLevel, fades[0]!.baseLevel]).toEqual([1, N]);
    expect(fades[0]!.leaves).toEqual(["a/p1", "a/p2", "a/p3", "a/p4"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Loop start fade (§7.4)
// ---------------------------------------------------------------------------------------------

describe("loop-start fade", () => {
  const two = (pose: string | undefined, steps: Obj[]): SceneGraph =>
    scene(
      spec({
        assemblies: [
          tile(
            Array.from({ length: 4 }, (_, i) => box(`p${i}`, [i, 0, 0], [1, 1, 1])),
            [build(Array.from({ length: 4 }, (_, i) => ({ add: [`p${i}`] })))],
            pose === undefined ? {} : { pose },
          ),
        ],
        steps,
      }),
    );

  test("a build from level 0 fades the parts a rest frame shows, during max(lead, 0.4)", () => {
    const g = two(undefined, [{ duration: 6, assembly: [{ build: "a", advance: 2 }] }]);
    const [f] = loopStartFades(asmOf(g), g.assemblies!.plan);
    expect(f).toMatchObject({ owner: "a", program: "b", startLevel: 0, baseLevel: 4, window: 0.4 });
    expect(f!.leaves).toEqual(["a/p0", "a/p1", "a/p2", "a/p3"]);
    // the opening camera transition (step 1 zoomed) is 0.25 * d capped at 0.8: it can exceed 0.4
    const lead = (d: number): number => stepWindows([d], ["a"], false)[0]!.lead;
    expect(lead(2)).toBe(0.5);
    expect(loopStartFades(asmOf(g), g.assemblies!.plan, lead(2))[0]!.window).toBe(0.5);
    expect(loopStartFades(asmOf(g), g.assemblies!.plan, lead(1))[0]!.window).toBe(0.4);
    expect(loopStartFades(asmOf(g), g.assemblies!.plan, lead(40))[0]!.window).toBe(0.8);
  });

  test("only the parts missing at the start level fade", () => {
    const g = two(undefined, [{ duration: 6, assembly: [{ build: "a", to: 3, advance: 1 }] }]);
    const [f] = loopStartFades(asmOf(g), g.assemblies!.plan);
    expect(f!.startLevel).toBe(2);
    expect(f!.leaves).toEqual(["a/p2", "a/p3"]);
  });

  test("none when the first action starts at the base pose, or no action plays the program", () => {
    // unbuild starts finished (= base)
    const u = two(undefined, [{ duration: 6, assembly: [{ unbuild: "a", to: 1 }] }]);
    expect(loopStartFades(asmOf(u), u.assemblies!.plan)).toEqual([]);
    // pose: empty: the base is level 0, a build from 0 starts at the base
    const e = two("empty", [{ duration: 6, assembly: [{ build: "a" }] }]);
    expect(asmOf(e).basePose).toEqual([{ program: "b", level: 0 }]);
    expect(loopStartFades(asmOf(e), e.assemblies!.plan)).toEqual([]);
    // an invalid action is not in the plan
    const bad = two(undefined, [{ duration: 6, assembly: [{ build: "a", to: 9 }] }]);
    expect(loopStartFades(asmOf(bad), bad.assemblies!.plan)).toEqual([]);
    expect(loopStartFades(asmOf(two(undefined, [])), [])).toEqual([]);
  });

  test("a build that ends away from its base reserves the closing window, one that ends at it does not", () => {
    const fl = (x: number): number => Math.floor(x * 10000) / 10000;
    // four 0.6 s steps of one part each: levels 1..3 need 0.6 s per step
    const away = two(undefined, [{ duration: 1, assembly: [{ build: "a", to: 3 }] }]);
    // ends at level 3 of 4: closing transition min(0.8, 0.25 * 1) = 0.25 and the 0.2 s hold
    expect(away.assemblies!.plan[0]!.actions[0]!.scale).toBe(fl((1 - 0.25 - 0.2) / 1.8));
    const home = two(undefined, [{ duration: 1, assembly: [{ build: "a", to: 4 }] }]);
    // ends finished = base: only the hold
    expect(home.assemblies!.plan[0]!.actions[0]!.scale).toBe(fl((1 - 0.2) / 2.4));
    // an unbuild back to 0 from finished ends away from the base too
    const down = two(undefined, [{ duration: 1, assembly: [{ unbuild: "a", to: 0 }] }]);
    expect(down.assemblies!.plan[0]!.actions[0]!.scale).toBe(fl((1 - 0.25 - 0.2) / 2.4));
  });
});

// ---------------------------------------------------------------------------------------------
// Compression is shared with figures and explode
// ---------------------------------------------------------------------------------------------

describe("compression", () => {
  const imgs = [
    { id: "base", src: "a.png" },
    { id: "spr", src: "b.png" },
  ];
  const mixedSpec = (duration: number, steps2?: Obj[]): PlatformCosmoSpec =>
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
          [box("x", [0, 0, 0], [1, 1, 1]), box("y", [1, 0, 0], [1, 1, 1])],
          [
            build([
              { add: ["x"], duration: 1 },
              { add: ["y"], duration: 1 },
            ]),
            { id: "e", stages: [{ parts: ["x"], duration: 1 }] },
          ],
        ),
      ],
      steps: [{ duration, assembly: [{ explode: "f" }, { build: "a", to: 2 }] }, ...(steps2 ?? [])],
    });
  const mixed = (duration: number, steps2?: Obj[]): SceneGraph =>
    scene(mixedSpec(duration, steps2));

  test("a build and a figure action in one step share the cursor, window and scale", () => {
    // the figure plays 1 s, then the build 2 s: 3 s of motion. The figure ends exploded, so the
    // last step reserves its closing transition: window = 3 - 0.75 - 0.2 = 2.05 s
    const g = mixed(3);
    const [f, b] = g.assemblies!.plan[0]!.actions;
    const scale = Math.floor((2.05 / 3) * 10000) / 10000;
    expect([f!.target, f!.start, f!.scale]).toEqual(["f", 0, scale]);
    expect(f!.length).toBe(Math.floor(1 * scale * 10000) / 10000);
    expect([b!.target, b!.kind, b!.scale]).toEqual(["a", "build", scale]);
    expect(b!.start).toBe(Math.floor(1 * scale * 10000) / 10000); // one cursor
    expect(b!.length).toBe(Math.floor(2 * scale * 10000) / 10000);
    // validation reports it once, with the duration that fits
    const d = codes(
      assemblyPlanDiagnostics(mixedSpec(3), { isFocusTarget: () => false }),
      "assembly/compressed",
    );
    expect(d).toHaveLength(1);
    expect(d[0]!.suggestion).toBe(`Set "duration": ${fitDuration(3, false, true)} on this step`);
    expect(codes(g.diagnostics, "assembly/compressed")).toEqual([]);
  });

  test("a build then an explode in later steps: each step has its own window", () => {
    const g = mixed(10, [{ duration: 1, assembly: [{ explode: "a", program: "e" }] }]);
    const s2 = g.assemblies!.plan[1]!.actions[0]!;
    expect(s2.kind).toBe("explode");
    // the explode needs 1 s; last step, ends away from base: 1 - 0.25 - 0.2 = 0.55 s
    expect(s2.scale).toBe(Math.floor((0.55 / 1) * 10000) / 10000);
  });
});

// ---------------------------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------------------------

describe("reach covers build moves", () => {
  test("reach bounds include the origin of every built part", () => {
    const g = scene(
      spec({
        assemblies: [
          tile(
            [box("base", [0, 0, 0], [2, 2, 1]), box("p", [0, 0, 1], [1, 1, 1])],
            [build([{ add: ["base"] }, { add: ["p"], distance: 6 }])],
          ),
        ],
        steps: [{ duration: 6, assembly: [{ build: "a" }] }],
      }),
    );
    const a = asmOf(g);
    // p starts 6 above its seat (z 1..2): the reach reaches z = 8
    expect(a.reachBounds.origin.z + a.reachBounds.size.z).toBeCloseTo(8, 6);
    expect(a.restBounds.origin.z + a.restBounds.size.z).toBeCloseTo(2, 6);
    // and sideways origins widen it the other way
    const side = scene(
      spec({
        assemblies: [
          tile(
            [box("base", [0, 0, 0], [2, 2, 1]), box("p", [0, 0, 1], [1, 1, 1])],
            [build([{ add: ["base"] }, { add: ["p"], from: "-x", distance: 6 }])],
          ),
        ],
        steps: [{ duration: 6, assembly: [{ build: "a" }] }],
      }),
    );
    const r = asmOf(side).reachBounds;
    expect(r.origin.x).toBeCloseTo(asmOf(side).restBounds.origin.x - 6, 6);
  });
});

// ---------------------------------------------------------------------------------------------
// Bounds, malformed input, determinism
// ---------------------------------------------------------------------------------------------

describe("bounded, total and deterministic", () => {
  const parts = (n: number): Obj[] =>
    Array.from({ length: n }, (_, i) => box(`p${i}`, [i, 0, 0], [1, 1, 1]));

  test("steps beyond 500 are ignored; 500 steps resolve", () => {
    const n = MAX_BUILD_STEPS + 40;
    const g = scene(
      spec({
        assemblies: [tile(parts(n), [build(parts(n).map((p) => ({ add: [p.id] })))])],
      }),
    );
    const p = bprog(asmOf(g));
    expect(p.steps).toHaveLength(MAX_BUILD_STEPS);
    // the 40 parts of the ignored steps are never added, so they are the base
    expect(p.base).toHaveLength(40);
  });

  test("a spent budget yields no program and a budget/time warning, never a throw", () => {
    for (const left of [0, 1, 5, 50, 500, 5000]) {
      const s = spec({
        assemblies: [
          tile(parts(30), [build(parts(30).map((p) => ({ add: [p.id], from: "outside" })))]),
        ],
        steps: [{ duration: 5, assembly: [{ build: "a", to: 3 }] }],
      });
      const programs = new AssemblyPrograms(s, { work: makeWork(left) });
      const g = scene(s);
      const asm = asmOf(g);
      let built: ReturnType<AssemblyPrograms["attach"]> | undefined;
      expect(() => {
        built = programs.attach({ ...g.assemblies!, assemblies: [{ ...asm, programs: [] }] });
        programs.plan(built.assemblies, new Map(), [undefined]);
      }).not.toThrow();
      const got = built!.assemblies[0]!.programs.length;
      if (got === 0) {
        expect(codes(programs.diagnostics, "budget/time").length).toBeGreaterThan(0);
      }
    }
  });

  test("resolveBuild with any smaller budget is undefined or exactly the full result", () => {
    const sp = spec({
      assemblies: [
        tile(parts(12), [build(parts(12).map((p) => ({ add: [p.id], from: "outside" })))]),
      ],
    });
    const asm = asmOf(scene(sp));
    const model = new AssemblyModel(sp);
    const tnode = model.tree(0) as TNode;
    const prog = (sp.assemblies![0] as unknown as Obj).programs[0];
    const run = (left: number) => {
      const work = makeWork(left);
      const index = indexOwner(asm.root, work);
      return resolveBuild({
        asm,
        owner: asm.root,
        tnode,
        prog,
        ptr: "/assemblies/0/programs/0",
        index,
        sel: new OwnerSelectors(index, work),
        work,
      });
    };
    const full = run(1e9)!;
    expect(full.program.steps).toHaveLength(12);
    let defined = 0;
    for (let left = 0; left < 4000; left += 7) {
      const r = run(left);
      if (r === undefined) continue;
      defined++;
      // a capped result may skip obstruction scans, but is always a whole program
      expect(r.program.steps).toHaveLength(12);
      expect(r.program.base).toEqual(full.program.base);
    }
    expect(defined).toBeGreaterThan(0);
    expect(run(0)).toBeUndefined();
  });

  test("malformed programs do not throw", () => {
    const bad: Obj[] = [
      { id: "b", kind: "build", steps: [null, 7, { add: "p0" }, { add: [3, null] }, {}] },
      { id: "c", kind: "build", steps: [{ add: ["p0"], from: [0, 0, 0], view: 45, duration: -1 }] },
      {
        id: "d",
        kind: "build",
        steps: [
          { add: ["p0", "p1"], from: "sideways", stagger: "x", easing: "wobble", distance: "nx" },
        ],
      },
    ];
    const s = spec({
      assemblies: [tile(parts(3), bad)],
      steps: [
        {
          duration: 5,
          assembly: [
            { build: "a", program: "b" },
            { build: "a", program: "c" },
            { build: "a", program: "d" },
          ],
        },
      ],
    });
    expect(() => scene(s)).not.toThrow();
    const g = scene(s);
    expect(bprog(asmOf(g), "c").steps[0]!.view).toBeUndefined();
    expect(bprog(asmOf(g), "c").steps[0]!.moves[0]!.offset.z).toBeLessThanOrEqual(0);
  });

  test("a part added by two steps is added once (the validator reports the rest)", () => {
    const g = scene(
      spec({
        assemblies: [tile(parts(3), [build([{ add: ["p0", "p1"] }, { add: ["p1", "p2"] }])])],
      }),
    );
    const p = bprog(asmOf(g));
    expect(p.steps.map((s) => s.adds)).toEqual([["a/p0", "a/p1"], ["a/p2"]]);
  });

  test("deterministic: the same spec twice, and with reordered keys, builds the same scene", () => {
    const make = (): PlatformCosmoSpec => rover();
    const a1 = JSON.stringify(scene(make()).assemblies);
    expect(JSON.stringify(scene(make()).assemblies)).toBe(a1);
    const s = make() as unknown as Obj;
    s.assemblies = (s.assemblies as Obj[]).map((x) =>
      Object.fromEntries(Object.entries(x).reverse()),
    );
    expect(JSON.stringify(scene(s as never).assemblies)).toBe(a1);
  });
});

// ---------------------------------------------------------------------------------------------
// Existing output
// ---------------------------------------------------------------------------------------------

describe("specs without build programs are untouched", () => {
  test("no build programs: plan views stay 0 and poses carry no build entries", () => {
    const g = scene(
      spec({
        assemblies: [
          tile(
            [box("x", [0, 0, 0], [1, 1, 1])],
            [{ id: "p", stages: [{ parts: ["x"], duration: 1 }] }],
          ),
        ],
        steps: [{ duration: 3, assembly: [{ explode: "a" }] }],
      }),
    );
    expect(g.assemblies!.plan.map((p) => p.view)).toEqual([0]);
    expect(g.assemblies!.plan[0]!.poses.a).toEqual([{ program: "p", level: 1 }]);
    expect(asmOf(g).programs.every((p) => p.kind === "explode")).toBe(true);
    expect(g.assemblies!.views).toBeUndefined();
  });
});
