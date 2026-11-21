import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type {
  Box3,
  Diagnostic,
  PartMove,
  QuarterTurn,
  ResolvedExplodeProgram,
  SceneAssembly,
} from "../src/index.js";
import { buildScene } from "../src/index.js";
import type { PlatformCosmoSpec } from "../src/schema/types.gen.js";
import { frameMap } from "../src/scene/assembly/frame.js";
import { AssemblyPrograms } from "../src/scene/assembly/plan.js";
import {
  assemblyFocusTargets,
  assemblyNodes,
  buildAssemblies,
} from "../src/scene/assembly/tree.js";
import { buildCloseups, type CloseupHost } from "../src/scene/assembly/closeup.js";
import {
  ELEMENT_WARN,
  MAX_LEVELS,
  MAX_LEVEL_DEPTH,
  assemblyElements,
  levelFocusTargets,
  levelOf,
  sceneElements,
} from "../src/scene/assembly/levels.js";
import { rotateScene, usedViews, viewScenes } from "../src/scene/assembly/views.js";

// A2-5: close-ups, size reconciliation and quarter-turn views (docs/design/assemblies.md §7.7,
// §8.4, §8.5, §13). Phase 2 is gated in `buildScene`, so everything is called directly.

type Obj = Record<string, unknown>;
const spec = (o: Obj): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...o }) as unknown as PlatformCosmoSpec;
const codes = (d: readonly Diagnostic[], code: string): Diagnostic[] =>
  d.filter((x) => x.code === code);

/** Placed assemblies with programs attached, as the scene builds them. */
function main(s: PlatformCosmoSpec): { programs: AssemblyPrograms; base: SceneAssembly[] } {
  const programs = new AssemblyPrograms(s);
  const built = programs.attach(buildAssemblies(s, { reach: programs.reach }));
  return { programs, base: [...built.assemblies] };
}
function levels(s: PlatformCosmoSpec, hosts?: readonly CloseupHost[]) {
  const { programs, base } = main(s);
  const out = buildCloseups(s, base, { programs, ...(hosts === undefined ? {} : { hosts }) });
  return { programs, base, ...out };
}
const box = (id: string, at: number[], size: number[], extra: Obj = {}): Obj => ({
  id,
  at,
  size,
  ...extra,
});

// ---- §19.4 shaped story: hall -> server -> internals -> CPU -> heat sink -----------------------

const story = (srvSize = [418, 320, 60], extra: Obj[] = []): PlatformCosmoSpec =>
  spec({
    figures: [{ id: "fan-fig", parts: [], stages: [] }],
    assemblies: [
      {
        id: "heatsink",
        template: true,
        units: "mm",
        parts: [box("base", [0, 0, 0], [90, 90, 10]), box("fins", [0, 0, 10], [90, 90, 40])],
        programs: [{ id: "lift", stages: [{ parts: ["fins"], direction: "up", distance: 30 }] }],
      },
      {
        id: "srv-internals",
        template: true,
        units: "mm",
        parts: [
          box("board", [10, 260, 0], [418, 200, 3]),
          box("cpu", [70, 430, 3], [90, 90, 50], {
            count: 2,
            pitch: [200, 0, 0],
            type: "cpu",
            closeup: "heatsink",
          }),
          box("fan", [20, 200, 0], [62, 40, 60], { closeup: "fan-fig" }),
        ],
        programs: [
          { id: "internals", stages: [{ parts: ["type:cpu"], direction: "up", distance: 80 }] },
        ],
      },
      {
        id: "hall",
        units: "mm",
        parts: [box("srv", [0, 0, 0], srvSize, { closeup: "srv-internals" })],
      },
      ...extra,
    ],
  });

describe("close-up instances (§8.4, §19.4)", () => {
  test("nested close-ups get the reserved path, parents, depth and kinds", () => {
    const { levels: ls, diagnostics } = levels(story());
    expect(ls.map((l) => l.path)).toEqual([
      "hall/srv/closeup",
      "hall/srv/closeup/cpu-1/closeup",
      "hall/srv/closeup/cpu-2/closeup",
      "hall/srv/closeup/fan/closeup",
    ]);
    const by = (p: string) => ls.find((l) => l.path === p)!;
    expect(by("hall/srv/closeup")).toMatchObject({
      host: "hall/srv",
      ref: "srv-internals",
      kind: "assembly",
      depth: 1,
    });
    expect(by("hall/srv/closeup").parent).toBeUndefined();
    expect(by("hall/srv/closeup/cpu-1/closeup")).toMatchObject({
      host: "hall/srv/closeup/cpu-1",
      kind: "assembly",
      depth: 2,
      parent: "hall/srv/closeup",
    });
    expect(by("hall/srv/closeup/fan/closeup")).toMatchObject({
      kind: "figure",
      ref: "fan-fig",
      depth: 2,
      parent: "hall/srv/closeup",
    });
    expect(by("hall/srv/closeup/fan/closeup").assembly).toBeUndefined();
    expect(diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  test("an instance is rooted at its path; every node path lives under it", () => {
    const { levels: ls } = levels(story());
    const srv = ls.find((l) => l.path === "hall/srv/closeup")!.assembly!;
    expect(srv.id).toBe("hall/srv/closeup");
    expect(srv.root.path).toBe("hall/srv/closeup");
    expect(srv.root.id).toBe("closeup");
    expect([...srv.leaves].sort()).toEqual([
      "hall/srv/closeup/board",
      "hall/srv/closeup/cpu-1",
      "hall/srv/closeup/cpu-2",
      "hall/srv/closeup/fan",
    ]);
    for (const n of assemblyNodes(srv)) expect(n.path.startsWith("hall/srv/closeup")).toBe(true);
    // the close-up reference stays on the node, so the next level hangs off it
    expect(assemblyNodes(srv).find((n) => n.path.endsWith("cpu-1"))?.closeup).toBe("heatsink");
    // the main scene has no close-up paths; the instances live only in levels
    const { base } = main(story());
    expect(assemblyNodes(base[0]!).some((n) => n.path.includes("/closeup"))).toBe(false);
  });

  test("two parts using one template are two independent instances", () => {
    const { levels: ls } = levels(story());
    const a = ls.find((l) => l.path.endsWith("cpu-1/closeup"))!.assembly!;
    const b = ls.find((l) => l.path.endsWith("cpu-2/closeup"))!.assembly!;
    expect(a).not.toBe(b);
    expect(a.root.path).not.toBe(b.root.path);
    expect(a.leaves).toEqual([
      "hall/srv/closeup/cpu-1/closeup/base",
      "hall/srv/closeup/cpu-1/closeup/fins",
    ]);
    expect(b.leaves).toEqual([
      "hall/srv/closeup/cpu-2/closeup/base",
      "hall/srv/closeup/cpu-2/closeup/fins",
    ]);
  });

  test("true scale: a matched template needs no fit and keeps physical sizes", () => {
    const { levels: ls } = levels(story());
    const l = ls.find((x) => x.path === "hall/srv/closeup")!;
    expect(l.fit).toBe(1);
    expect(l.turn).toBe(0);
    // 418 x 200 + the fan and cpus: the instance's frame scale is mm / 600
    expect(l.assembly!.frame.scale.x).toBeCloseTo(1 / 600, 9);
    const hs = ls.find((x) => x.path.endsWith("cpu-1/closeup"))!;
    expect(hs.assembly!.restBounds.size.x).toBeCloseTo(90 / 600, 6);
  });

  test("programs of an instance plan: actions on closeup paths, poses keyed by the path", () => {
    const s = story();
    s.steps = [
      { caption: "internals", duration: 4, assembly: [{ explode: "hall/srv/closeup" }] },
      {
        caption: "heat sink",
        duration: 4,
        assembly: [{ explode: "hall/srv/closeup/cpu-1/closeup" }],
      },
      {
        caption: "back",
        duration: 4,
        assembly: [{ implode: "hall/srv/closeup/cpu-1/closeup" }],
      },
    ] as never;
    const { programs, base, levels: ls } = levels(s);
    const all = [...base, ...ls.flatMap((l) => (l.assembly === undefined ? [] : [l.assembly]))];
    const { plan } = programs.plan(all, new Map(), [undefined, undefined, undefined]);
    expect(plan[0]!.poses["hall/srv/closeup"]).toEqual([{ program: "internals", level: 1 }]);
    expect(plan[1]!.poses["hall/srv/closeup/cpu-1/closeup"]).toEqual([
      { program: "lift", level: 1 },
    ]);
    // the action belongs to the deepest registered instance only
    expect(plan[1]!.poses["hall/srv/closeup"]).toEqual([{ program: "internals", level: 1 }]);
    expect(plan[1]!.poses["hall/srv/closeup/cpu-2/closeup"]).toEqual([
      { program: "lift", level: 0 },
    ]);
    expect(plan[2]!.poses["hall/srv/closeup/cpu-1/closeup"]).toEqual([
      { program: "lift", level: 0 },
    ]);
    const a = plan[1]!.actions[0]!;
    expect(a).toMatchObject({ target: "hall/srv/closeup/cpu-1/closeup", kind: "explode", to: 1 });
    expect(a.length).toBeGreaterThan(0);
    // the instance carries its resolved program, moves rooted at its own paths
    const inst = ls.find((l) => l.path.endsWith("cpu-1/closeup"))!.assembly!;
    const lift = inst.programs[0] as ResolvedExplodeProgram;
    expect(lift.owner).toBe("hall/srv/closeup/cpu-1/closeup");
    const mv = lift.stages[0]!.moves[0] as PartMove;
    expect(mv.path).toBe("hall/srv/closeup/cpu-1/closeup/fins");
    expect(mv.offset.z).toBeCloseTo(30 / 600, 6);
    // the main assembly never claims an instance's action
    expect(plan[1]!.poses["hall"]).toBeDefined();
  });

  test("rack slot hosts (DC): a 450 mm template fits the 450 mm interior of the 540 mm box", () => {
    const tpl = (x: number): PlatformCosmoSpec =>
      spec({
        assemblies: [
          {
            id: "srv-2u",
            template: true,
            units: "mm",
            parts: [box("chassis", [0, 0, 0], [x, 700, 85])],
          },
        ],
      });
    const host: CloseupHost = {
      path: "r2/srv",
      closeup: "srv-2u",
      // the DC device box is 540 mm wide; the template is matched to the 450 mm interior
      box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 0.9, y: 1.1, z: 0.14 } },
      interiorMm: { x: 450, y: 700, z: 88.9 },
      pointer: "/racks/1/slots/0/closeup",
    };
    const ok = levels(tpl(450), [host]);
    expect(ok.levels.map((l) => l.path)).toEqual(["r2/srv/closeup"]);
    expect(ok.diagnostics).toEqual([]);
    expect(ok.levels[0]).toMatchObject({ fit: 1, turn: 0 });
    // 12% wider than the interior: warns at the slot's pointer and shrinks
    const big = levels(tpl(504), [host]);
    const w = codes(big.diagnostics, "assembly/size-mismatch");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: "warning", path: "/racks/1/slots/0/closeup" });
    expect(big.levels[0]!.fit).toBeCloseTo(450 / 504, 9);
    expect(big.levels[0]!.assembly!.restBounds.size.x).toBeCloseTo(450 / 600, 6);
  });
});

describe("size reconciliation (§8.5)", () => {
  // host interior 100 x 100 x 50 mm; the template is x x 100 x 50
  const mk = (
    tpl: number[],
    host: number[] = [100, 100, 50],
    hostExtra: Obj = {},
    tplExtra: Obj = {},
    hostUnits = "mm",
    tplUnits = "mm",
  ): PlatformCosmoSpec =>
    spec({
      assemblies: [
        {
          id: "tpl",
          template: true,
          units: tplUnits,
          parts: [box("b", [0, 0, 0], tpl)],
          ...tplExtra,
        },
        {
          id: "host",
          units: hostUnits,
          parts: [box("p", [0, 0, 0], host, { closeup: "tpl" })],
          ...hostExtra,
        },
      ],
    });
  const withX = (x: number): PlatformCosmoSpec => mk([x, 100, 50]);

  test("up to 10% larger: no warning, true scale", () => {
    for (const x of [109, 110]) {
      const out = levels(withX(x));
      expect(codes(out.diagnostics, "assembly/size-mismatch")).toEqual([]);
      expect(out.levels[0]).toMatchObject({ fit: 1, turn: 0 });
    }
    expect(levels(withX(109)).levels[0]!.mismatch!.x).toBeCloseTo(0.09, 9);
  });

  test("9% smaller is fine too, and never enlarged", () => {
    const out = levels(withX(91));
    expect(out.diagnostics).toEqual([]);
    expect(out.levels[0]!.fit).toBe(1);
  });

  test("11% larger: warning, and the close-up is shrunk uniformly to fit the interior", () => {
    const out = levels(withX(111));
    const w = codes(out.diagnostics, "assembly/size-mismatch");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      severity: "warning",
      path: "/assemblies/1",
      params: { host: "host/p", closeup: "tpl", axis: "x", limit: 0.1 },
    });
    expect(w[0]!.params!.mismatch as number).toBeCloseTo(0.11, 9);
    const l = out.levels[0]!;
    expect(l.fit).toBeCloseTo(100 / 111, 9);
    expect(l.assembly!.restBounds.size.x).toBeCloseTo(100 / 600, 6);
    expect(l.assembly!.restBounds.size.y).toBeCloseTo((100 * 100) / 111 / 600, 6);
  });

  test("oversize in z warns too; a short z never does", () => {
    const tall = levels(mk([100, 100, 56]));
    expect(codes(tall.diagnostics, "assembly/size-mismatch")[0]!.params!.axis).toBe("z");
    expect(tall.levels[0]!.fit).toBeCloseTo(50 / 56, 9);
    const board = levels(mk([100, 100, 5])); // a flat board in a 50 mm tall interior
    expect(board.diagnostics).toEqual([]);
    expect(board.levels[0]!.fit).toBe(1);
  });

  test("much smaller in x or y: info only, never enlarged", () => {
    const out = levels(mk([40, 100, 50]));
    const d = codes(out.diagnostics, "assembly/size-mismatch");
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe("info");
    expect(out.levels[0]!.fit).toBe(1);
    expect(out.levels[0]!.assembly!.restBounds.size.x).toBeCloseTo(40 / 600, 6);
    // 60%: neither
    expect(levels(mk([60, 100, 50])).diagnostics).toEqual([]);
  });

  test("no automatic turn: a near-square board keeps its front", () => {
    const out = levels(mk([101, 99, 50]));
    expect(out.diagnostics).toEqual([]);
    expect(out.levels[0]).toMatchObject({ turn: 0, fit: 1 });
    expect(out.levels[0]!.assembly!.frame.rotate).toBe(0);
  });

  test("a footprint that fits better swapped is reported (info), not turned", () => {
    // template 120 x 100 in a 100 x 120 interior: swapped would match, aligned is 20% over in x
    const out = levels(mk([120, 100, 50], [100, 120, 50]));
    expect(codes(out.diagnostics, "assembly/closeup-turned")).toHaveLength(1);
    expect(codes(out.diagnostics, "assembly/closeup-turned")[0]!.severity).toBe("info");
    expect(out.levels[0]!.turn).toBe(0);
    expect(out.levels[0]!.assembly!.frame.rotate).toBe(0);
    expect(codes(out.diagnostics, "assembly/size-mismatch")[0]!.severity).toBe("warning");
  });

  test("the template front is aligned with the host front in world axes (host rotate: 90)", () => {
    // host interior 100 x 200 (local), assembly turned 90: 200 x 100 in the world, front -x
    const s = mk([100, 200, 50], [100, 200, 50], { rotate: 90 });
    const out = levels(s);
    const host = main(s).base.find((a) => a.id === "host")!;
    expect(host.frame.front).toBe("-x");
    expect(out.diagnostics).toEqual([]);
    expect(out.levels[0]!.turn).toBe(90);
    // the template front (+y) now faces -x, like the host's
    expect(out.levels[0]!.assembly!.frame.front).toBe("-x");
    expect(out.levels[0]!.assembly!.restBounds.size.x).toBeCloseTo(200 / 600, 6);
    expect(out.levels[0]!.assembly!.restBounds.size.y).toBeCloseTo(100 / 600, 6);
    // without the host turn nothing is turned
    expect(levels(mk([100, 200, 50], [100, 200, 50])).levels[0]!.turn).toBe(0);
  });

  test("a template with its own rotate keeps it and is still aligned", () => {
    // template authored 200 x 100 then rotated 90: 100 x 200 in the world, front -x; the host is
    // 200 x 100 (front +y): one more quarter turn aligns the fronts, and the sizes then match
    const s = mk([200, 100, 50], [200, 100, 50], {}, { rotate: 90 });
    const out = levels(s);
    expect(out.levels[0]!.assembly!.frame.front).toBe("+y");
    expect(out.diagnostics).toEqual([]);
  });

  test("units convert: a 4 in template against a 101.6 mm host matches", () => {
    const s = mk([4, 4, 2], [101.6, 101.6, 50.8], {}, {}, "mm", "in");
    expect(levels(s).diagnostics).toEqual([]);
  });

  test("non-physical units are not reconciled", () => {
    expect(levels(mk([300, 100, 50], [100, 100, 50], {}, {}, "tile", "mm")).diagnostics).toEqual(
      [],
    );
    expect(levels(mk([300, 100, 50], [100, 100, 50], {}, {}, "mm", "tile")).diagnostics).toEqual(
      [],
    );
    expect(levels(mk([300, 100, 50], [100, 100, 50], {}, {}, "mm", "stud")).diagnostics).toEqual(
      [],
    );
  });

  test("the fit is part of the instance, not a post-hoc scale of the pose", () => {
    const l = levels(withX(111)).levels[0]!.assembly!;
    const n = assemblyNodes(l).find((x) => x.path.endsWith("/b"))!;
    expect(n.world.size.x).toBeCloseTo(100 / 600, 6);
  });
});

describe("levels budget (§13)", () => {
  // closeups on the assembly roots: a0/closeup, a0/closeup/closeup, ... (n templates)
  const chain = (n: number, via: "root" | "part"): PlatformCosmoSpec => {
    const host = (next: string | undefined): Obj =>
      via === "root"
        ? { closeup: next, parts: [box("p", [0, 0, 0], [10, 10, 10])] }
        : {
            parts: [box("p", [0, 0, 0], [10, 10, 10], next === undefined ? {} : { closeup: next })],
          };
    return spec({
      assemblies: [
        { id: "a0", units: "mm", ...host("t1") },
        ...Array.from({ length: n }, (_, i) => ({
          id: `t${i + 1}`,
          template: true,
          units: "mm",
          ...host(i + 1 < n ? `t${i + 2}` : undefined),
        })),
      ],
    });
  };

  test("four deep builds; the fifth level is refused before it is expanded", () => {
    const ok = levels(chain(4, "root"));
    expect(ok.levels.map((l) => l.depth)).toEqual([1, 2, 3, 4]);
    expect(ok.levels.map((l) => l.path)).toEqual([
      "a0/closeup",
      "a0/closeup/closeup",
      "a0/closeup/closeup/closeup",
      "a0/closeup/closeup/closeup/closeup",
    ]);
    expect(ok.levels[3]!.parent).toBe("a0/closeup/closeup/closeup");
    expect(codes(ok.diagnostics, "budget/levels")).toEqual([]);
    expect(MAX_LEVEL_DEPTH).toBe(4);
    const over = levels(chain(6, "root"));
    expect(over.levels).toHaveLength(4);
    const d = codes(over.diagnostics, "budget/levels");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", params: { depth: 5, maxDepth: 4 } });
  });

  test("through parts the 8-segment path limit stops first (validation reports it)", () => {
    const out = levels(chain(6, "part"));
    expect(out.levels.map((l) => l.path)).toEqual([
      "a0/p/closeup",
      "a0/p/closeup/p/closeup",
      "a0/p/closeup/p/closeup/p/closeup",
    ]);
    expect(out.levels.every((l) => l.path.split("/").length <= 8)).toBe(true);
    expect(codes(out.diagnostics, "budget/levels")).toEqual([]);
    // validation walks each edge on its own and passes this chain; the scene reports the cut
    const deep = codes(out.diagnostics, "assembly/too-deep");
    expect(deep).toHaveLength(1);
    expect(deep[0]).toMatchObject({
      severity: "error",
      path: "/assemblies/3",
      params: { host: "a0/p/closeup/p/closeup/p/closeup/p", depth: 10, limit: 8 },
    });
  });

  test("a template taller than the room left below the host is reported, not truncated", () => {
    const tall = spec({
      assemblies: [
        {
          id: "t",
          template: true,
          units: "mm",
          parts: [{ id: "s", parts: [box("q", [0, 0, 0], [5, 5, 5])] }], // height 2
        },
        { id: "flat", template: true, units: "mm", parts: [box("q", [0, 0, 0], [5, 5, 5])] },
      ],
    });
    const at = (ref: string): CloseupHost => ({
      path: "a/b/c/d/e/f", // + closeup = 7 segments
      closeup: ref,
      box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      pointer: "/host",
    });
    const t = levels(tall, [at("t")]);
    expect(t.levels).toEqual([]);
    expect(codes(t.diagnostics, "assembly/too-deep")[0]).toMatchObject({
      path: "/host",
      params: { depth: 9, limit: 8 },
    });
    const f = levels(tall, [at("flat")]); // 7 + 1 = 8: fits exactly
    expect(f.levels.map((l) => l.path)).toEqual(["a/b/c/d/e/f/closeup"]);
    expect(codes(f.diagnostics, "assembly/too-deep")).toEqual([]);
  });

  test("budget/levels names the host's pointer", () => {
    const over = levels(chain(6, "root"));
    expect(codes(over.diagnostics, "budget/levels")[0]!.path).toBe("/assemblies/4");
  });

  test("eight instances build; the ninth is refused and nothing past it is looked at", () => {
    const wide = (n: number): PlatformCosmoSpec =>
      spec({
        assemblies: [
          { id: "t", template: true, units: "mm", parts: [box("q", [0, 0, 0], [5, 5, 5])] },
          {
            id: "a",
            units: "mm",
            parts: [
              box("p", [0, 0, 0], [10, 10, 10], { count: n, pitch: [20, 0, 0], closeup: "t" }),
            ],
          },
        ],
      });
    const eight = levels(wide(8));
    expect(eight.levels).toHaveLength(MAX_LEVELS);
    expect(codes(eight.diagnostics, "budget/levels")).toEqual([]);
    const nine = levels(wide(9));
    expect(nine.levels).toHaveLength(MAX_LEVELS);
    expect(codes(nine.diagnostics, "budget/levels")).toHaveLength(1);
    // the first eight by path, deterministically
    expect(nine.levels.map((l) => l.host)).toEqual(
      Array.from({ length: 8 }, (_, i) => `a/p-${i + 1}`).sort(),
    );
    // 500 hosts: still eight levels and ONE diagnostic
    const many = levels(wide(500));
    expect(many.levels).toHaveLength(MAX_LEVELS);
    expect(codes(many.diagnostics, "budget/levels")).toHaveLength(1);
  });

  test("nested instances count against the same eight", () => {
    // 2 cpus x (1 + 2 nested) closeups each from a three-part template
    const ls = levels(story()).levels;
    expect(ls).toHaveLength(4);
    const s = story();
    const deep = (s.assemblies as unknown as { id: string; parts: Obj[] }[]).find(
      (a) => a.id === "srv-internals",
    )!;
    deep.parts = [
      ...deep.parts,
      box("ram", [300, 200, 3], [10, 10, 10], { count: 6, pitch: [12, 0, 0], closeup: "heatsink" }),
    ];
    const out = levels(s);
    expect(out.levels).toHaveLength(MAX_LEVELS);
    expect(codes(out.diagnostics, "budget/levels")).toHaveLength(1);
  });

  test("a cycle through closeup stops the chain (validation reports the cycle)", () => {
    const self = spec({
      assemblies: [
        {
          id: "t",
          template: true,
          units: "mm",
          parts: [box("p", [0, 0, 0], [5, 5, 5], { closeup: "t" })],
        },
        { id: "a", units: "mm", parts: [box("q", [0, 0, 0], [5, 5, 5], { closeup: "t" })] },
      ],
    });
    expect(levels(self).levels.map((l) => l.path)).toEqual(["a/q/closeup"]);
    const mutual = spec({
      assemblies: [
        { id: "x", units: "mm", parts: [box("p", [0, 0, 0], [5, 5, 5], { closeup: "y" })] },
        {
          id: "y",
          template: true,
          units: "mm",
          parts: [box("q", [0, 0, 0], [5, 5, 5], { closeup: "x" })],
        },
      ],
    });
    const out = levels(mutual);
    expect(out.levels.map((l) => l.path)).toEqual(["x/p/closeup"]);
    const own = spec({
      assemblies: [{ id: "x", units: "mm", closeup: "x", parts: [box("p", [0, 0, 0], [5, 5, 5])] }],
    });
    expect(levels(own).levels).toEqual([]);
  });

  test("template leaves are charged to the 2000-part budget", () => {
    const s = spec({
      assemblies: [
        {
          id: "big",
          template: true,
          units: "mm",
          parts: [box("b", [0, 0, 0], [1, 1, 1], { count: 900, pitch: [2, 0, 0] })],
        },
        {
          id: "a",
          units: "mm",
          parts: [
            box("p", [0, 0, 0], [10, 10, 10], { count: 3, pitch: [20, 0, 0], closeup: "big" }),
          ],
        },
      ],
    });
    const out = levels(s);
    expect(out.levels).toHaveLength(2); // 900 + 900 + 3 leaves
    const d = codes(out.diagnostics, "budget/assembly-parts");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "error", params: { host: "a/p-3" } });
  });

  test("an unknown reference or an over-long path is skipped, not thrown", () => {
    const s = spec({
      assemblies: [
        { id: "a", units: "mm", parts: [box("p", [0, 0, 0], [5, 5, 5], { closeup: "nope" })] },
      ],
    });
    expect(levels(s)).toMatchObject({ levels: [], diagnostics: [] });
    const bad = levels(story(), [
      {
        path: "a",
        closeup: "heatsink",
        box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      },
      {
        path: "a/b/c/d/e/f/g/h",
        closeup: "heatsink",
        box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      },
    ]);
    expect(bad.levels.map((l) => l.path)).not.toContain("a/b/c/d/e/f/g/h/closeup");
    expect(codes(bad.diagnostics, "assembly/too-deep")).toHaveLength(1);
  });

  test("elements count every level", () => {
    const { base, levels: ls } = levels(story());
    const per = (a: SceneAssembly): number => assemblyElements(a);
    const levelSum = ls.reduce((n, l) => n + (l.assembly === undefined ? 0 : per(l.assembly)), 0);
    expect(levelSum).toBeGreaterThan(0);
    expect(sceneElements(base, ls)).toBe(per(base[0]!) + levelSum);
    expect(sceneElements(base, [])).toBe(per(base[0]!));
    // figures add nothing here: the render fits their sprites
    expect(
      sceneElements(
        base,
        ls.filter((l) => l.kind === "figure"),
      ),
    ).toBe(per(base[0]!));
  });
});

describe("focus through close-up paths (§7.4, §8.4)", () => {
  test("levelOf finds the deepest level for a path or a path inside it", () => {
    const { levels: ls } = levels(story());
    expect(levelOf(ls, "hall/srv")).toBeUndefined();
    expect(levelOf(ls, "hall")).toBeUndefined();
    expect(levelOf(ls, "hall/srv/closeup")?.path).toBe("hall/srv/closeup");
    expect(levelOf(ls, "hall/srv/closeup/board")?.path).toBe("hall/srv/closeup");
    expect(levelOf(ls, "hall/srv/closeup/cpu-1")?.path).toBe("hall/srv/closeup");
    expect(levelOf(ls, "hall/srv/closeup/cpu-1/closeup")?.path).toBe(
      "hall/srv/closeup/cpu-1/closeup",
    );
    expect(levelOf(ls, "hall/srv/closeup/cpu-1/closeup/fins")?.path).toBe(
      "hall/srv/closeup/cpu-1/closeup",
    );
    // a longer sibling name is not a prefix match
    expect(levelOf(ls, "hall/srv/closeupx")).toBeUndefined();
  });

  test("focus targets: parts of each level in that level's world, figures by host box", () => {
    const { base, levels: ls } = levels(story());
    const main = assemblyFocusTargets(base);
    expect(main.has("hall/srv")).toBe(true);
    expect(main.has("hall/srv/closeup")).toBe(false);
    const t = levelFocusTargets(ls);
    expect([...t.keys()]).toEqual([...t.keys()].sort());
    for (const k of [
      "hall/srv/closeup",
      "hall/srv/closeup/board",
      "hall/srv/closeup/cpu-1",
      "hall/srv/closeup/cpu-1/closeup",
      "hall/srv/closeup/cpu-1/closeup/fins",
      "hall/srv/closeup/fan/closeup",
    ]) {
      expect(t.has(k), k).toBe(true);
    }
    // the instance box is the whole instance, in its own world at the origin
    const srv = ls.find((l) => l.path === "hall/srv/closeup")!.assembly!;
    expect(t.get("hall/srv/closeup")).toEqual(srv.root.world);
    expect(t.get("hall/srv/closeup")!.origin.x).toBeCloseTo(0, 6);
    // the figure level has no geometry: its focus box is the host node (fitted by the render)
    const fan = ls.find((l) => l.path.endsWith("fan/closeup"))!;
    expect(t.get(fan.path)).toEqual(fan.hostBox);
    expect(fan.hostBox).toEqual(
      assemblyNodes(srv).find((n) => n.path === "hall/srv/closeup/fan")!.world,
    );
  });
});

describe("determinism", () => {
  test("same input, same output; host order does not matter", () => {
    const s = story();
    const a = levels(s);
    const b = levels(structuredClone(s));
    expect(JSON.stringify(b.levels)).toBe(JSON.stringify(a.levels));
    expect(JSON.stringify(b.diagnostics)).toBe(JSON.stringify(a.diagnostics));
    const hosts = (...ps: string[]): CloseupHost[] =>
      ps.map((p) => ({
        path: p,
        closeup: "heatsink",
        box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      }));
    const x = levels(story(), hosts("r1/a", "r1/b", "r2/c"));
    const y = levels(story(), hosts("r2/c", "r1/b", "r1/a"));
    expect(JSON.stringify(y.levels)).toBe(JSON.stringify(x.levels));
  });
});

// ---- quarter-turn views (§7.7) -----------------------------------------------------------------

const row = (extra: Obj = {}): PlatformCosmoSpec =>
  spec({
    assemblies: [
      {
        id: "a",
        units: "tile",
        parts: [box("big", [0, 0, 0], [2, 1, 1]), box("small", [2, 0, 0], [1, 1, 1])],
        programs: [
          { id: "p", stages: [{ parts: ["small"], direction: "+x", distance: 2 }] },
          {
            id: "b",
            kind: "build",
            steps: [
              { add: ["small"], view: 90 },
              { add: ["big"], view: 270 },
            ],
          },
        ],
        ...extra,
      },
    ],
    steps: [{ caption: "x", duration: 4, assembly: [{ explode: "a", program: "p" }] }],
  });
const wbox = (b: Box3): number[] => [
  b.origin.x,
  b.origin.y,
  b.origin.z,
  b.size.x,
  b.size.y,
  b.size.z,
];
const near = (got: number[], want: number[]): void => {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => expect(g).toBeCloseTo(want[i] as number, 6));
};

describe("quarter-turn views (§7.7)", () => {
  const { base } = main(row());
  const node = (a: SceneAssembly, p: string) => assemblyNodes(a).find((n) => n.path === p)!;

  test("rest geometry of the known assembly", () => {
    near(wbox(node(base[0]!, "a/big").world), [0, 0, 0, 2, 1, 1]);
    near(wbox(node(base[0]!, "a/small").world), [2, 0, 0, 1, 1, 1]);
  });

  test("view 0 is the input scene itself", () => {
    expect(rotateScene(base, 0)).toBe(base);
    expect(viewScenes(base, [0]).views[0]!.assemblies).toBe(base);
  });

  test("90 turns the scene by -90 about the rest centre", () => {
    // centre (1.5, 0.5); (x, y) -> (y, -x) about it
    const [a] = rotateScene(base, 90);
    near(wbox(node(a!, "a/big").world), [1, 0, 0, 1, 2, 1]);
    near(wbox(node(a!, "a/small").world), [1, -1, 0, 1, 1, 1]);
    near(wbox(a!.restBounds), [1, -1, 0, 1, 3, 1]);
    expect(a!.frame.rotate).toBe(270);
    // the rotated frame maps the local box onto the rotated world box exactly
    const w = frameMap(a!.frame, a!.root.local).box(a!.root.local);
    near(wbox(w), [1, -1, 0, 1, 3, 1]);
    // local boxes are untouched
    near(wbox(node(a!, "a/big").local), wbox(node(base[0]!, "a/big").local));
  });

  test("180 and 270", () => {
    const [b] = rotateScene(base, 180);
    near(wbox(node(b!, "a/big").world), [1, 0, 0, 2, 1, 1]);
    near(wbox(node(b!, "a/small").world), [0, 0, 0, 1, 1, 1]);
    expect(b!.frame.rotate).toBe(180);
    const [c] = rotateScene(base, 270);
    near(wbox(node(c!, "a/big").world), [1, -1, 0, 1, 2, 1]);
    near(wbox(node(c!, "a/small").world), [1, 1, 0, 1, 1, 1]);
    expect(c!.frame.rotate).toBe(90);
  });

  test("four quarter turns compose to the identity", () => {
    let cur: readonly SceneAssembly[] = base;
    for (let i = 0; i < 4; i++) cur = rotateScene(cur, 90);
    expect(JSON.stringify(cur[0]!.root)).toBe(JSON.stringify(base[0]!.root));
    expect(JSON.stringify(cur[0]!.frame)).toBe(JSON.stringify(base[0]!.frame));
    expect(JSON.stringify(cur[0]!.programs)).toBe(JSON.stringify(base[0]!.programs));
  });

  test("move offsets are world vectors and turn with the scene", () => {
    const off = (a: SceneAssembly): number[] => {
      const p = a.programs.find((x) => x.kind === "explode") as ResolvedExplodeProgram;
      const m = p.stages[0]!.moves[0]!.offset;
      return [m.x, m.y, m.z];
    };
    near(off(base[0]!), [2, 0, 0]);
    near(off(rotateScene(base, 90)[0]!), [0, -2, 0]);
    near(off(rotateScene(base, 180)[0]!), [-2, 0, 0]);
    near(off(rotateScene(base, 270)[0]!), [0, 2, 0]);
    // the swept reach box turns with it
    near(wbox(base[0]!.reachBounds), [0, 0, 0, 5, 1, 1]);
    near(wbox(rotateScene(base, 90)[0]!.reachBounds), [1, -3, 0, 1, 5, 1]);
  });

  test("several assemblies turn rigidly about the centre of their union", () => {
    const two = spec({
      assemblies: [
        { id: "a", units: "tile", parts: [box("p", [0, 0, 0], [1, 1, 1])] },
        { id: "b", units: "tile", parts: [box("q", [0, 0, 0], [1, 1, 1])] },
      ],
    });
    const { base: pair } = main(two);
    const gap = pair[1]!.restBounds.origin.x - pair[0]!.restBounds.origin.x;
    const [a, b] = rotateScene(pair, 90);
    // the row along +x becomes a column along -y, with the same spacing
    expect(a!.restBounds.origin.x).toBeCloseTo(b!.restBounds.origin.x, 6);
    expect(a!.restBounds.origin.y - b!.restBounds.origin.y).toBeCloseTo(gap, 6);
  });

  test("decals stay in the data: faces are assembly-local, the renderer maps them", () => {
    const img = (face: string): Obj => ({ ref: "im", face, crop: [0, 0, 10, 10] });
    const s = spec({
      images: [{ id: "im", src: "x.png" }],
      assemblies: [
        {
          id: "a",
          units: "tile",
          parts: [
            box("r", [0, 0, 0], [1, 1, 1], { image: img("right") }),
            box("l", [1, 0, 0], [1, 1, 1], { image: img("left") }),
            box("t", [2, 0, 0], [1, 1, 1], { image: img("top") }),
          ],
        },
      ],
    });
    const { base: b } = main(s);
    const faces = (a: SceneAssembly): string[] =>
      ["a/r", "a/l", "a/t"].flatMap((p) => (node(a, p).geometry?.images ?? []).map((i) => i.face));
    expect(faces(b[0]!)).toEqual(["right", "left", "top"]);
    for (const t of [90, 180, 270] as const) {
      expect(faces(rotateScene(b, t)[0]!)).toEqual(["right", "left", "top"]);
      expect(node(rotateScene(b, t)[0]!, "a/r").geometry).toBe(node(b[0]!, "a/r").geometry);
    }
  });

  test("rotated world boxes all come from the new frame (one source)", () => {
    const big = rotateScene(base, 90)[0]!;
    const map = frameMap(big.frame, big.root.local);
    for (const n of assemblyNodes(big)) {
      if (n.kind !== "leaf") continue;
      const g = n.geometry!;
      const want = map.box({
        origin: {
          x: n.local.origin.x + g.depthBox.origin.x,
          y: n.local.origin.y + g.depthBox.origin.y,
          z: n.local.origin.z + g.depthBox.origin.z,
        },
        size: g.depthBox.size,
      });
      expect(n.world).toEqual(want);
    }
    expect(big.root.world).toEqual(map.box(big.root.local));
  });

  test("templates are not scene assemblies: their view steps are ignored", () => {
    const s = row();
    (s.assemblies![0] as unknown as Obj).template = true;
    expect(usedViews(s)).toEqual([]);
  });

  test("usedViews reads build steps, always with the rest view", () => {
    expect(usedViews(row())).toEqual([0, 90, 270]);
    expect(usedViews(spec({ assemblies: [{ id: "a", units: "tile", parts: [] }] }))).toEqual([]);
    const nested = spec({
      assemblies: [
        {
          id: "a",
          units: "tile",
          parts: [
            {
              id: "s",
              parts: [box("q", [0, 0, 0], [1, 1, 1])],
              programs: [{ id: "b", kind: "build", steps: [{ add: ["q"], view: 180 }] }],
            },
          ],
        },
      ],
    });
    expect(usedViews(nested)).toEqual([0, 180]);
  });

  test("viewScenes dedupes, sorts, ignores invalid turns", () => {
    const v = viewScenes(base, [270, 90, 90, 45, 0, 100]);
    expect(v.views.map((x) => x.turn)).toEqual([0, 90, 270] as QuarterTurn[]);
    expect(v.diagnostics).toEqual([]);
    expect(viewScenes(base, [])).toMatchObject({ views: [], elements: 0 });
  });

  test("determinism", () => {
    const a = viewScenes(base, [0, 90, 180, 270]);
    const b = viewScenes(main(row()).base, [270, 180, 90, 0]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("views budget (§7.7, §13)", () => {
  // 1300 boxes: one primitive each, so 1300 elements per view
  const heavy = (n: number): SceneAssembly[] =>
    main(
      spec({
        assemblies: [
          {
            id: "a",
            units: "mm",
            parts: [box("b", [0, 0, 0], [1, 1, 1], { count: n, pitch: [2, 0, 0] })],
          },
        ],
      }),
    ).base;

  test("warns above 5000 elements over all views, not at or below", () => {
    const base = heavy(1300);
    const per = assemblyElements(base[0]!);
    expect(per * 4).toBeGreaterThan(ELEMENT_WARN);
    expect(per * 3).toBeLessThanOrEqual(ELEMENT_WARN);
    const three = viewScenes(base, [0, 90, 180]);
    expect(three.elements).toBe(per * 3);
    expect(codes(three.diagnostics, "budget/views")).toEqual([]);
    const four = viewScenes(base, [0, 90, 180, 270]);
    expect(four.elements).toBe(per * 4);
    const d = codes(four.diagnostics, "budget/views");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      severity: "warning",
      params: { views: 4, perView: per, elements: per * 4, limit: 5000 },
    });
  });

  test("never more than four views whatever is asked", () => {
    const v = viewScenes(heavy(2), [0, 90, 180, 270, 0, 90, 180, 270, 360, -90]);
    expect(v.views).toHaveLength(4);
  });
});

// ---- wiring in buildScene ------------------------------------------------------------------------

describe("levels and views in the scene graph", () => {
  const img = {
    id: "im",
    src: "x.png",
    source: { document: "Spec sheet", license: "CC-BY-4.0", attribution: "Alice" },
  };
  const withImage = (): PlatformCosmoSpec => {
    const s = story();
    delete (s as { figures?: unknown }).figures;
    const srv = (s.assemblies as unknown as { id: string; parts: Obj[] }[]).find(
      (a) => a.id === "srv-internals",
    )!;
    delete srv.parts.find((p) => p.id === "fan")!.closeup;
    s.images = [img] as never;
    const t = (s.assemblies as unknown as { id: string; parts: Obj[] }[]).find(
      (a) => a.id === "heatsink",
    )!;
    t.parts = [
      box("base", [0, 0, 0], [90, 90, 10], {
        image: { ref: "im", face: "top", crop: [0, 0, 8, 8] },
      }),
      ...t.parts.slice(1),
    ];
    return s;
  };

  test("levels are in assemblies.levels, instances are not in assemblies", () => {
    const g = buildScene(story(), {});
    const a = g.assemblies!;
    expect(a.assemblies.map((x) => x.id)).toEqual(["hall"]);
    expect(a.levels!.map((l) => l.path)).toEqual([
      "hall/srv/closeup",
      "hall/srv/closeup/cpu-1/closeup",
      "hall/srv/closeup/cpu-2/closeup",
      "hall/srv/closeup/fan/closeup",
    ]);
    expect(a.views).toBeUndefined();
    // focus on a path inside a close-up resolves, and node states are addressable
    expect(g.focusTargets["hall/srv/closeup/cpu-1/closeup/fins"]).toBeDefined();
    expect(g.diagnostics.filter((d) => d.code === "semantic/unknown-focus")).toEqual([]);
  });

  test("a close-up part's image and credit reach images and credits (CC-BY)", () => {
    const a = buildScene(withImage(), {}).assemblies!;
    expect(a.images).toEqual(["im"]);
    expect(a.credits).toEqual([img.source]);
    // listed once even when two instances use the image
    expect(a.levels!.filter((l) => l.ref === "heatsink")).toHaveLength(2);
    // and nothing when no instance uses it
    const none = withImage();
    (none.assemblies as unknown as { id: string; parts: Obj[] }[])[1]!.parts = [
      box("board", [10, 260, 0], [418, 200, 3]),
    ];
    expect(buildScene(none, {}).assemblies!.images).toEqual([]);
  });

  test("plan poses cover close-up instances", () => {
    const s = story();
    s.steps = [
      { caption: "internals", duration: 4, assembly: [{ explode: "hall/srv/closeup" }] },
    ] as never;
    const g = buildScene(s, {});
    expect(g.assemblies!.plan[0]!.poses["hall/srv/closeup"]).toEqual([
      { program: "internals", level: 1 },
    ]);
  });

  test("views: sorted, include 0, turn 0 is the main assemblies; absent without view steps", () => {
    const g = buildScene(row(), {});
    const v = g.assemblies!.views!;
    expect(v.map((x) => x.turn)).toEqual([0, 90, 270]);
    expect(v[0]!.assemblies).toBe(g.assemblies!.assemblies);
    expect(g.assemblies!.levels).toBeUndefined();
    const plain = row();
    (plain.assemblies![0] as unknown as Obj).programs = [];
    expect(buildScene(plain, {}).assemblies!.views).toBeUndefined();
  });
});

// ---- byte identity -------------------------------------------------------------------------------

describe("existing output is unchanged", () => {
  const sha = (v: unknown): string =>
    createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
  const read = (rel: string): string =>
    readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");

  // SHA-256 (first 16 hex) of JSON.stringify(buildScene(spec, {})), recorded on the A2-3 branch
  // BEFORE A2-5 touched `tree.ts` and `plan.ts`: the 1.1 gallery, the assembly examples and the
  // figure examples build the very same scene. Any change to these hashes is a byte change.
  const GOLDEN: Record<string, string> = {
    "examples/aws-three-tier.cosmo.json": "f80f02c79e2e053b",
    "examples/azure-web-app.cosmo.json": "f0f5f76f7fa6c791",
    "examples/cdn-cache.cosmo.json": "5876b0f5dc77c886",
    "examples/dc-hall.cosmo.json": "d5ef43409c7398bc",
    "examples/gcp-data-pipeline.cosmo.json": "bdbf5ad98f9cfda6",
    "examples/gpu-inference-cluster.cosmo.json": "e26d95932609b0a7",
    "examples/kubernetes-deployment.cosmo.json": "c4eb536b02d84343",
    "examples/load-balancing.cosmo.json": "227d6d874b52ad36",
    "examples/rag-pipeline.cosmo.json": "f7557e938eadcf45",
  };
  const DOC_GOLDEN: Record<string, string> = {
    "assemblies.md Two-part box": "be7ad58b82ee947c",
    "assemblies.md Loaded rack: service view": "ac8fb18af1133528",
    "assemblies.md 2U GPU server internals": "6ec32493bc488708", // hw: shapes from main
    "assemblies.md Inline-4 engine teardown": "37582f18c42ebc76",
    "assemblies.md Rack to server to internals": "b6f4978ff28ce3db",
    // The two specs with build programs changed in A2-6 (build programs, plan views and the
    // build poses now exist); re-recorded there. Every other hash is the A2-3 record.
    "assemblies.md Brick rover": "66eb5eeacbcdee62",
    "document-ingestion.md Generic 2OU server from a spec document": "1f5f211ceae50a37",
    "document-ingestion.md Heat-sink installation figure": "0210858f1ee3bae2",
    "document-ingestion.md From the hall to the heat sink": "51d21be6488c12ce",
    "document-ingestion.md Booklet storyboard": "c1fbfa2da67efd3d",
  };

  test("1.1 gallery specs build byte-identical scenes", () => {
    for (const [file, want] of Object.entries(GOLDEN)) {
      expect(sha(buildScene(JSON.parse(read(file)) as PlatformCosmoSpec, {})), file).toBe(want);
    }
  });

  test("assembly and figure examples build byte-identical scenes", () => {
    const got: Record<string, string> = {};
    for (const f of ["assemblies.md", "document-ingestion.md"]) {
      for (const m of read(`docs/design/${f}`).matchAll(/```json\n([\s\S]*?)```/g)) {
        let s: PlatformCosmoSpec;
        try {
          s = JSON.parse(m[1] as string) as PlatformCosmoSpec;
        } catch {
          continue;
        }
        if (typeof s.meta !== "object") continue;
        const g = buildScene(s, {});
        const views = g.assemblies?.views;
        if (views !== undefined) {
          expect(views.map((v) => v.turn)[0]).toBe(0);
          delete (g.assemblies as { views?: unknown }).views; // the one addition
        }
        got[`${f} ${s.meta.title}`] = sha(g);
      }
    }
    expect(got).toEqual(DOC_GOLDEN);
  });

  test("a spec without close-ups or views has no levels and no views", () => {
    const eng = JSON.parse(
      read("docs/design/assemblies.md").match(/```json\n(\{[^`]*Inline-4[\s\S]*?)```/)![1]!,
    ) as PlatformCosmoSpec;
    const { base } = main(eng);
    const none = buildCloseups(eng, base);
    expect(none.levels).toEqual([]);
    expect(none.diagnostics).toEqual([]);
    expect(usedViews(eng)).toEqual([]);
  });

  test("a plain assembly keeps id === root.path === its id", () => {
    const { base } = main(row());
    expect(base[0]!.id).toBe("a");
    expect(base[0]!.root.id).toBe("a");
    expect(base[0]!.root.path).toBe("a");
  });
});
