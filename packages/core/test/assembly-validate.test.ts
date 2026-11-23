import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Diagnostic, PartShapeRegistry } from "../src/index.js";
import { buildScene, validate } from "../src/index.js";
import { matchFigureSelector } from "../src/scene/boards.js";
import { globMatch } from "../src/schema/glob.js";
import { assemblyDiagnostics, hasAssemblyContent } from "../src/schema/assembly-semantic.js";
import { AssemblyModel } from "../src/schema/assembly-tree.js";
import type { GuardGroup } from "../src/schema/unsupported.js";
import { UNRENDERED } from "../src/schema/unsupported.js";
import type { PlatformCosmoSpec } from "../src/schema/types.gen.js";

// A2-1: assembly validation (docs/design/assemblies.md §3, §5, §6.1, §7.2, §8.3-§8.4, §13, §18).
// Checks are called directly with the guard lifted (as A2-F's tests do); `validate` tests use
// the default wiring, where the guard still rejects the 1.2.0 fields.

const LIFT: Record<GuardGroup, boolean> = {
  phase1a: false,
  phase1b: false,
  phase2: false,
  storyboards: false,
  phase3: false,
};
const META = { version: "1" };
type Obj = Record<string, unknown>;
const spec = (o: Obj): PlatformCosmoSpec => ({ meta: META, ...o }) as unknown as PlatformCosmoSpec;
const run = (o: Obj, groups: Partial<Record<GuardGroup, boolean>> = {}): Diagnostic[] =>
  assemblyDiagnostics(spec(o), { ...LIFT, ...groups });
const code = (ds: readonly Diagnostic[], c: string): Diagnostic[] => ds.filter((d) => d.code === c);
const one = (ds: readonly Diagnostic[], c: string): Diagnostic => {
  const found = code(ds, c);
  expect(
    found.map((d) => d.path),
    `${c} in ${JSON.stringify(ds)}`,
  ).toHaveLength(1);
  return found[0] as Diagnostic;
};
const none = (ds: readonly Diagnostic[], c: string): void => expect(code(ds, c)).toEqual([]);
const val = (o: Obj): Diagnostic[] => [...validate(spec(o)).diagnostics];

/** An engine-like assembly: a head holding valves, counted cylinders, a cover. */
const ENGINE_PARTS = [
  { id: "block", size: [10, 10, 10] },
  {
    id: "head",
    at: [0, 0, 10],
    parts: [
      { id: "casting", size: [10, 10, 2] },
      { id: "valve", type: "valve", count: 2, at: [1, 1, 12], pitch: [2, 0, 0], size: [1, 1, 3] },
    ],
  },
  { id: "cyl", type: "liner", count: 3, size: [2, 2, 8], pitch: [3, 0, 0] },
  { id: "cover", role: "cover", at: [0, 0, 15], size: [10, 10, 1] },
];
const engine = (extra: Obj = {}, programs?: unknown[]): Obj => ({
  assemblies: [
    {
      id: "engine",
      parts: ENGINE_PARTS,
      programs: programs ?? [
        {
          id: "teardown",
          stages: [{ parts: ["cover"] }, { parts: ["head"] }, { parts: ["cyl-*"] }],
        },
        {
          id: "build",
          kind: "build",
          steps: [{ add: ["block"] }, { add: ["head"] }, { add: ["cover", "cyl-*"] }],
        },
      ],
      ...extra,
    },
  ],
});
const withSteps = (steps: unknown[], extra: Obj = {}): Obj => ({
  ...engine(),
  steps,
  ...extra,
});

// ----------------------------------------------------------------------------- design examples

const examples = (file: string): Obj[] => {
  const md = readFileSync(new URL(`../../../docs/design/${file}`, import.meta.url), "utf8");
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .filter((s) => typeof s.meta === "object");
};

describe("design examples are fixtures", () => {
  const cases = [...examples("assemblies.md"), ...examples("document-ingestion.md")].map(
    (s) => [(s.meta as { title: string }).title, s] as const,
  );
  test("every example is picked up", () => {
    expect(cases.map(([t]) => t)).toEqual([
      "Two-part box",
      "Loaded rack: service view",
      "2U GPU server internals",
      "Inline-4 engine teardown",
      "Rack to server to internals",
      "Brick rover",
      "Generic 2OU server from a spec document",
      "Heat-sink installation figure",
      "From the hall to the heat sink",
      "Booklet storyboard",
    ]);
  });
  test.each(cases)("%s: schema-valid, no assembly diagnostic of any severity", (_t, s) => {
    expect(validate(s).diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual([]);
    // phases lifted: every action, program and reference check runs and finds nothing to report
    expect(assemblyDiagnostics(s as unknown as PlatformCosmoSpec, LIFT)).toEqual([]);
    // default wiring (phase1a lifted by R-1): the guard rejects it, and the only other report is
    // A2-F's post-lift rule: `assembly/unknown-target` on an action whose target is not a
    // figure and whose phase is still gated (tracks §0), once per path.
    const all = validate(s).diagnostics;
    const unknown = all.filter((d) => d.code === "assembly/unknown-target");
    const figureIds = new Set(((s.figures ?? []) as { id: string }[]).map((f) => f.id));
    for (const d of unknown) {
      expect(d.path).toMatch(/^\/steps\/\d+\/assembly\/\d+\/(explode|implode|build|unbuild)$/);
      const m = /^\/steps\/(\d+)\/assembly\/(\d+)\//.exec(d.path)!;
      const act = (s.steps as { assembly: Obj[] }[])[Number(m[1])]!.assembly[Number(m[2])] as Obj;
      const target = String(Object.values(act)[0]);
      expect(figureIds.has(target.split("/")[0] as string), d.path).toBe(false);
    }
    expect(new Set(unknown.map((d) => d.path)).size).toBe(unknown.length);
    // A2-3 compression info goes live with the phase 1b lift (plan wiring in semantic.ts): it is
    // reported at most once per step (never again by the scene), and it is only an info.
    const compressed = all.filter((d) => d.code === "assembly/compressed");
    expect(new Set(compressed.map((d) => d.path)).size).toBe(compressed.length);
    expect(compressed.every((d) => d.severity === "info" || d.severity === "warning")).toBe(true);
    const rest = all.filter(
      (d) =>
        d.code !== "assembly/unsupported" &&
        d.code !== "assembly/unknown-target" &&
        d.code !== "assembly/compressed",
    );
    expect(rest).toEqual([]);
  });
  test("a typo in each example's first action target is caught with a did-you-mean", () => {
    let checked = 0;
    for (const [, s] of cases) {
      const copy = JSON.parse(JSON.stringify(s)) as Obj;
      const steps = (copy.steps ?? []) as Obj[];
      const step = steps.find((x) => Array.isArray(x.assembly));
      if (step === undefined) continue;
      const a = (step.assembly as Obj[])[0] as Obj;
      const key = ["explode", "implode", "build", "unbuild"].find((k) => k in a) as string;
      const target = a[key] as string;
      const root = target.split("/")[0] as string;
      if ((copy.figures as Obj[] | undefined)?.some((f) => f.id === root)) continue; // A2-F's
      a[key] = target.replace(root, `${root}x`);
      const d = one(
        assemblyDiagnostics(copy as unknown as PlatformCosmoSpec, LIFT),
        "assembly/unknown-target",
      );
      expect(d.suggestion).toBe(`Did you mean "${root}"?`);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});

// ----------------------------------------------------------------------------- namespace

describe("namespace", () => {
  test("sibling ids collide after count expansion", () => {
    const d = run({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "cyl", count: 3 },
            { id: "cyl-2" },
            { id: "x", parts: [{ id: "p" }, { id: "p" }] },
          ],
        },
      ],
    });
    const dups = code(d, "assembly/duplicate-part");
    expect(dups.map((x) => x.path)).toEqual([
      "/assemblies/0/parts/1/id",
      "/assemblies/0/parts/2/parts/1/id",
    ]);
    expect(dups[0]?.message).toBe(
      'Duplicate part id "cyl-2" among siblings (first at /assemblies/0/parts/0/id; ids repeat after count expansion)',
    );
    expect(dups[0]?.params).toEqual({ id: "cyl-2", first: "/assemblies/0/parts/0/id" });
  });
  test("a count of 1 and no count give the plain id; count n gives <id>-1 ... <id>-n", () => {
    const m = new AssemblyModel(
      spec({
        assemblies: [
          {
            id: "a",
            parts: [
              { id: "p", count: 1 },
              { id: "q", count: 2 },
            ],
          },
        ],
      }),
    );
    expect(m.tree(0)?.children.map((c) => c.id)).toEqual(["p", "q-1", "q-2"]);
  });
  test("same part ids in different parents do not collide", () => {
    none(
      run({
        assemblies: [
          {
            id: "a",
            parts: [
              { id: "x", parts: [{ id: "p" }] },
              { id: "y", parts: [{ id: "p" }] },
            ],
          },
        ],
      }),
      "assembly/duplicate-part",
    );
  });
  test("assemblies and storyboards join the global id namespace (validate)", () => {
    const d = val({
      nodes: [{ id: "engine", type: "server" }],
      assemblies: [{ id: "engine", parts: [{ id: "p" }] }],
      images: [{ id: "im", src: "a.png" }],
      storyboards: [{ id: "engine", frames: [{ model: "im" }] }],
    });
    const dup = code(d, "semantic/duplicate-id");
    expect(dup.map((x) => x.path)).toEqual(["/assemblies/0/id", "/storyboards/0/id"]);
    expect(dup[0]?.message).toBe('Duplicate id "engine" (already used by a node at /nodes/0/id)');
    expect(dup[0]?.suggestion).toBe(
      "Ids are shared by nodes, groups, racks, equipment, rows, aisles, cables, assemblies and storyboards; rename one",
    );
  });
  test("1.1 specs keep the exact duplicate-id suggestion", () => {
    const d = val({
      nodes: [
        { id: "a", type: "server" },
        { id: "a", type: "server" },
      ],
    });
    expect(one(d, "semantic/duplicate-id").suggestion).toBe(
      "Ids are shared by nodes, groups, racks, equipment, rows, aisles and cables; rename one",
    );
  });
  test("reserved id closeup is an error for parts, at any depth", () => {
    const d = run({
      assemblies: [
        { id: "a", parts: [{ id: "x", parts: [{ id: "closeup" }] }, { id: "closeup" }] },
      ],
    });
    expect(code(d, "assembly/reserved-id").map((x) => x.path)).toEqual([
      "/assemblies/0/parts/0/parts/0/id",
      "/assemblies/0/parts/1/id",
    ]);
  });
  test("a 1.1 id closeup keeps the guard's warning, also next to 1.2.0 content", () => {
    const d = val({
      nodes: [{ id: "closeup", type: "server" }],
      assemblies: [{ id: "a", parts: [{ id: "p" }] }],
    });
    expect(one(d, "semantic/reserved-id").severity).toBe("warning");
    none(d, "assembly/reserved-id");
    // an assembly may be called closeup: reserved only after the first segment
    none(run({ assemblies: [{ id: "closeup", parts: [{ id: "p" }] }] }), "assembly/reserved-id");
  });
  test("slot id frame is reserved only for a rack in assembly mode", () => {
    const rack = (extra: Obj) => ({
      racks: [{ id: "r1", slots: [{ id: "frame", at: 1, type: "server-1u" }], ...extra }],
    });
    // plain 1.1 rack: allowed
    none(run(rack({})), "assembly/reserved-id");
    // programs alone do not make an assembly (§8.1, targeted only; #84 Q09)
    const programs = [{ id: "p", stages: [{ parts: ["frame"] }] }];
    none(run(rack({ programs })), "assembly/reserved-id");
    // nor does an action on one of its slot's close-up instances
    const viaCloseup = { steps: [{ assembly: [{ explode: "r1/frame/closeup" }] }] };
    none(run({ ...rack({}), ...viaCloseup }), "assembly/reserved-id");
    // targeted by an action
    const targeted = run({ ...rack({}), steps: [{ assembly: [{ explode: "r1" }] }] });
    expect(one(targeted, "assembly/reserved-id").path).toBe("/racks/0/slots/0/id");
  });
  test("paths longer than 8 segments are too deep; exactly 8 passes", () => {
    const chain = (n: number): Obj => {
      let part: Obj = { id: "leaf" };
      for (let i = n - 1; i >= 1; i--) part = { id: `p${i}`, parts: [part] };
      return part;
    };
    // a/p1/.../leaf: parts nested n levels => n + 1 segments
    none(run({ assemblies: [{ id: "a", parts: [chain(7)] }] }), "assembly/too-deep");
    const d = run({ assemblies: [{ id: "a", parts: [chain(8)] }] });
    expect(one(d, "assembly/too-deep").path).toBe(
      "/assemblies/0/parts/0/parts/0/parts/0/parts/0/parts/0/parts/0/parts/0/parts/0",
    );
    expect(one(d, "assembly/too-deep").params).toEqual({ depth: 9, limit: 8 });
  });
  test("a template used too deep is reported at the use", () => {
    const deep: Obj = {
      id: "t",
      template: true,
      parts: [{ id: "a", parts: [{ id: "b", parts: [{ id: "c" }] }] }],
    };
    const nest = (n: number): Obj => {
      let part: Obj = { id: "u", use: "t" };
      for (let i = n; i >= 1; i--) part = { id: `p${i}`, parts: [part] };
      return part;
    };
    // a/p1/p2/p3/u/a/b/c is 8 segments; one more level is 9
    none(run({ assemblies: [deep, { id: "a", parts: [nest(3)] }] }), "assembly/too-deep");
    const d = run({ assemblies: [deep, { id: "a", parts: [nest(4)] }] });
    expect(one(d, "assembly/too-deep").path).toBe(
      "/assemblies/1/parts/0/parts/0/parts/0/parts/0/parts/0/use",
    );
  });
  test("edge, flow and cable endpoints may not name a part (validate)", () => {
    const base = {
      nodes: [{ id: "n", type: "server" }],
      assemblies: [{ id: "engine", parts: [{ id: "head", size: [1, 1, 1] }] }],
    };
    const d = val({
      ...base,
      edges: [
        { from: "n", to: "engine/head" },
        { from: "n", to: "engine" },
      ],
      flows: [{ from: "engine/head", to: "n" }],
    });
    expect(code(d, "assembly/edge-to-part").map((x) => [x.path, x.suggestion])).toEqual([
      ["/edges/0/to", 'Use "engine"'],
      ["/flows/0/from", 'Use "engine"'],
    ]);
    expect(code(d, "assembly/edge-to-part")[0]?.message).toBe(
      'Node "engine/head" is a part path; endpoints name a whole assembly',
    );
    // a whole assembly is a valid endpoint
    expect(d.filter((x) => x.path === "/edges/1/to")).toEqual([]);
    const cables = val({
      racks: [{ id: "r1" }],
      assemblies: base.assemblies,
      cables: [{ from: "r1", to: "engine/head" }],
    });
    expect(one(cables, "assembly/edge-to-part").path).toBe("/cables/0/to");
  });
});

// ----------------------------------------------------------------------------- references

describe("references", () => {
  test("action targets resolve over the expanded tree with did-you-mean", () => {
    const d = run(
      withSteps([
        {
          assembly: [
            { explode: "enigne" },
            { explode: "engine/hed" },
            { explode: "engine/valve-1" },
            { explode: "engine/head/valve-9" },
            { explode: "engine/cyl" },
            { explode: "engine/zzz" },
            { explode: "engine/head/valve-1" },
          ],
        },
      ]),
    );
    const unknown = code(d, "assembly/unknown-target");
    expect(unknown.map((x) => [x.path, x.suggestion])).toEqual([
      ["/steps/0/assembly/0/explode", 'Did you mean "engine"?'],
      ["/steps/0/assembly/1/explode", 'Did you mean "engine/head"?'],
      ["/steps/0/assembly/2/explode", 'Did you mean "engine/head/valve-1"?'],
      ["/steps/0/assembly/3/explode", 'Did you mean "engine/head/valve-1"?'],
      ["/steps/0/assembly/4/explode", 'Did you mean "engine/cyl-1"?'],
      ["/steps/0/assembly/5/explode", '"engine" has: block, head, cyl-1, cyl-2, cyl-3, cover'],
    ]);
    expect(unknown[1]?.message).toBe(
      'Unknown explode target "engine/hed": "engine" has no part "hed"',
    );
    // leaves have no program
    expect(code(d, "assembly/unknown-program").map((x) => x.path)).toEqual([
      "/steps/0/assembly/6/explode",
    ]);
  });
  test("focus and set paths (validate): assembly roots resolve, typos get a did-you-mean", () => {
    const d = val({
      ...engine(),
      steps: [
        { focus: "engine", set: { "engine/head": "highlighted" } },
        { focus: "engine/hed", set: { "engine/head/valve-3": "down" } },
      ],
    });
    expect(code(d, "semantic/unknown-node")).toEqual([]);
    const unknown = code(d, "assembly/unknown-target");
    expect(unknown.map((x) => [x.path, x.suggestion])).toEqual([
      ["/steps/1/focus", 'Did you mean "engine/head"?'],
      ["/steps/1/set/engine~1head~1valve-3", 'Did you mean "engine/head/valve-1"?'],
    ]);
    // 1.1 behaviour is unchanged: an unknown id is still a semantic/unknown-node
    expect(
      one(
        val({ nodes: [{ id: "a", type: "server" }], steps: [{ focus: "b" }] }),
        "semantic/unknown-node",
      ).path,
    ).toBe("/steps/0/focus");
  });
  test("a template is not a target; a leaf can be focused", () => {
    const d = val({
      assemblies: [
        { id: "t", template: true, parts: [{ id: "p" }] },
        { id: "a", parts: [{ id: "x", use: "t" }] },
      ],
      steps: [{ focus: "t" }, { focus: "a/x/p" }],
    });
    const u = code(d, "assembly/unknown-target");
    expect(u.map((x) => x.path)).toEqual(["/steps/0/focus"]);
    expect(u[0]?.message).toBe('Focus target "t" is a template, which is not drawn by itself');
  });
  test("selectors: empty matches, with deeper **/ suggestions", () => {
    const d = run(
      engine({}, [
        {
          id: "p",
          stages: [
            {
              parts: [
                "valve-*",
                "type:valve",
                "covr",
                "type:valv",
                "hed/valve-1",
                "head/valve-*",
                "zz",
              ],
            },
            { parts: ["block"], except: ["nothing-here"] },
          ],
        },
      ]),
    );
    const empty = code(d, "assembly/selector-empty");
    expect(empty.map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/0/programs/0/stages/0/parts/0", 'Did you mean "**/valve-*"?'],
      ["/assemblies/0/programs/0/stages/0/parts/1", 'Did you mean "**/type:valve"?'],
      ["/assemblies/0/programs/0/stages/0/parts/2", 'Did you mean "cover"?'],
      ["/assemblies/0/programs/0/stages/0/parts/3", 'Did you mean "type:valve"?'],
      ["/assemblies/0/programs/0/stages/0/parts/4", 'Did you mean "head/valve-1"?'],
      [
        "/assemblies/0/programs/0/stages/0/parts/6",
        "Parts: block, head, cyl-1, cyl-2, cyl-3, cover",
      ],
      [
        "/assemblies/0/programs/0/stages/1/except/0",
        "Parts: block, head, cyl-1, cyl-2, cyl-3, cover",
      ],
    ]);
    expect(empty[0]?.severity).toBe("warning");
    expect(empty[0]?.message).toBe('Selector "valve-*" matches no part of "engine"');
  });
  test("selector grammar: scopes, ** and kinds match as in 6.1", () => {
    const d = run(
      engine({}, [
        {
          id: "p",
          stages: [
            { parts: ["head/valve-*"] },
            { parts: ["**/type:valve"], except: ["head/valve-1"] },
            { parts: ["**/valve-2"] },
            { parts: ["head/**"] },
            { parts: ["role:cover"] },
            { parts: ["tag:none"] },
          ],
        },
      ]),
    );
    // stage 2 moves valve-2 (valve-1 excepted) and stage 3 moves valve-2 again; stage 4 moves
    // everything in head (valves too: moved earlier, but only identical nodes are errors)
    expect(code(d, "assembly/selector-empty").map((x) => x.path)).toEqual([
      "/assemblies/0/programs/0/stages/5/parts/0",
    ]);
    expect(code(d, "assembly/moved-twice").map((x) => x.path)).toEqual([
      "/assemblies/0/programs/0/stages/1/parts", // valve-2 again (stage 1 moved head/valve-*)
      "/assemblies/0/programs/0/stages/2/parts",
      "/assemblies/0/programs/0/stages/3/parts",
    ]);
  });
  test("an opaque rack frame and role terms are not reported (parts unknown here)", () => {
    const d = run({
      racks: [
        {
          id: "r1",
          slots: [{ id: "srv", at: 1, type: "server-2u" }],
          programs: [
            { id: "p", stages: [{ parts: ["frame/role:cover", "frame/doors", "srv/anything"] }] },
          ],
        },
      ],
    });
    expect(d).toEqual([]);
    // an unknown role name is still a typo
    const roles = run(engine({}, [{ id: "p", stages: [{ parts: ["role:covr"] }] }]));
    expect(one(roles, "assembly/selector-empty").suggestion).toBe('Did you mean "role:cover"?');
  });
  test("overrides keys are relative to the program owner", () => {
    const programs = [
      {
        id: "p",
        stages: [
          {
            parts: ["head"],
            overrides: { "head/valve-1": { delay: 1 }, "head/valv-1": { delay: 1 }, casting: {} },
          },
        ],
      },
    ];
    const d = run(engine({}, programs));
    const u = code(d, "assembly/unknown-target");
    expect(u.map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/0/programs/0/stages/0/overrides/head~1valv-1", 'Did you mean "head/valve-1"?'],
      ["/assemblies/0/programs/0/stages/0/overrides/casting", 'Did you mean "head/casting"?'],
    ]);
  });
  test("sub-assembly programs select among their own children", () => {
    const d = run({
      assemblies: [
        {
          id: "a",
          parts: [
            {
              id: "head",
              parts: [{ id: "v-1" }, { id: "v-2" }],
              programs: [{ id: "p", stages: [{ parts: ["v-*"] }, { parts: ["v-9"] }] }],
            },
          ],
        },
      ],
    });
    expect(code(d, "assembly/selector-empty").map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/0/parts/0/programs/0/stages/1/parts/0", 'Did you mean "v-1"?'],
    ]);
  });
  test("mates and inserts name siblings (after count expansion)", () => {
    const d = run({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "cpu", count: 2 },
            { id: "hs", mates: "cpu", inserts: "block" },
            { id: "hs2", mates: "cpu-1" },
            {
              id: "box",
              parts: [{ id: "a1" }, { id: "a2", mates: "a1" }, { id: "a3", mates: "a9" }],
            },
          ],
        },
      ],
    });
    const u = code(d, "assembly/unknown-target");
    expect(u.map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/0/parts/1/mates", 'Did you mean "cpu-1"?'],
      ["/assemblies/0/parts/1/inserts", '"a" has: cpu-1, cpu-2, hs, hs2, box'],
      ["/assemblies/0/parts/3/parts/2/mates", 'Did you mean "a1"?'],
    ]);
    expect(u[0]?.message).toBe('Unknown "mates" part "cpu": "a" has no part "cpu"');
  });
  test("use, slot assembly and closeup references", () => {
    const d = run({
      images: [{ id: "im", src: "a.png" }],
      nodes: [{ id: "motor", type: "server" }],
      assemblies: [
        { id: "tmpl", template: true, parts: [{ id: "p" }] },
        {
          id: "a",
          closeup: "tmpll",
          parts: [
            { id: "x", use: "tmp" },
            { id: "y", closeup: "motor" },
            { id: "z", use: "tmpl", closeup: "tmpl" },
          ],
        },
      ],
      racks: [
        {
          id: "r1",
          slots: [{ id: "s", at: 1, type: "server-1u", assembly: "tmpl2", closeup: "zz" }],
        },
      ],
    });
    expect(code(d, "assembly/unknown-target").map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/1/closeup", 'Did you mean "tmpl"?'],
      ["/assemblies/1/parts/0/use", 'Did you mean "tmpl"?'],
      ["/assemblies/1/parts/1/closeup", "Available: a, tmpl"],
      ["/racks/0/slots/0/assembly", 'Did you mean "tmpl"?'],
      ["/racks/0/slots/0/closeup", "Available: a, tmpl"],
    ]);
    expect(code(d, "assembly/unknown-target")[2]?.message).toBe(
      'Close-up "motor" is not an assembly, figure or storyboard',
    );
  });
  test("image ids on parts, with did-you-mean; storyboard frames too", () => {
    const d = run({
      images: [{ id: "board", src: "a.png" }],
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "p1", image: "bord" },
            { id: "p2", image: { ref: "bord", face: "top" } },
            { id: "p3", image: "board" },
          ],
        },
      ],
      storyboards: [
        {
          id: "sb",
          frames: [
            {
              model: "bard",
              parts: [{ image: "board" }, { image: "xx" }],
              sub: [{ image: "bord" }],
            },
          ],
        },
      ],
    });
    expect(code(d, "image/unknown").map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/0/parts/0/image", 'Did you mean "board"?'],
      ["/assemblies/0/parts/1/image/ref", 'Did you mean "board"?'],
      ["/storyboards/0/frames/0/model", 'Did you mean "board"?'],
      ["/storyboards/0/frames/0/parts/1/image", "Images: board"],
      ["/storyboards/0/frames/0/sub/0/image", 'Did you mean "board"?'],
    ]);
    const noImages = run({ assemblies: [{ id: "a", parts: [{ id: "p", image: "x" }] }] });
    expect(one(noImages, "image/unknown").suggestion).toBe('Declare it in "images" first');
  });
  test("template cycles are reported once, at the closing reference", () => {
    const d = run({
      assemblies: [
        { id: "a", template: true, parts: [{ id: "p", use: "b" }] },
        { id: "b", template: true, parts: [{ id: "q", use: "a" }] },
        { id: "self", template: true, parts: [{ id: "s", use: "self" }] },
        { id: "c", template: true, closeup: "d", parts: [{ id: "p" }] },
        { id: "d", template: true, parts: [{ id: "p", closeup: "c" }] },
      ],
    });
    const cyc = code(d, "assembly/template-cycle");
    expect(cyc.map((x) => [x.path, x.params])).toEqual([
      ["/assemblies/1/parts/0/use", { cycle: ["a", "b"] }],
      ["/assemblies/2/parts/0/use", { cycle: ["self"] }],
      ["/assemblies/4/parts/0/closeup", { cycle: ["c", "d"] }],
    ]);
    expect(cyc[0]?.message).toBe("Assemblies reference each other in a cycle: a -> b -> a");
  });
});

// ----------------------------------------------------------------------------- budgets

const leaves = (n: number): Obj[] => {
  const out: Obj[] = [];
  for (let i = 0; n > 0; i++, n -= 64) out.push({ id: `p${i}`, count: Math.min(64, n) });
  return out;
};
describe("budgets and bounded work", () => {
  test("500 leaves pass, 501 warn, 2000 warn, 2001 error", () => {
    const at = (n: number) => run({ assemblies: [{ id: "a", parts: leaves(n) }] });
    expect(at(500)).toEqual([]);
    expect(one(at(501), "budget/assembly-parts").severity).toBe("warning");
    expect(one(at(2000), "budget/assembly-parts").severity).toBe("warning");
    const e = one(at(2001), "budget/assembly-parts");
    expect(e.severity).toBe("error");
    expect(e.path).toBe("/assemblies");
    expect(e.params).toEqual({ leaves: 2001, limit: 2000, warn: 500 });
  });
  test("leaves count after use and slot templates, templates themselves do not count", () => {
    const d = run({
      assemblies: [
        { id: "t", template: true, parts: leaves(300) },
        { id: "a", parts: [{ id: "x", use: "t", count: 2 }] },
      ],
    });
    expect(one(d, "budget/assembly-parts").params).toMatchObject({ leaves: 600 });
    const racks = run({
      assemblies: [{ id: "t", template: true, parts: leaves(200) }],
      racks: [
        {
          id: "r",
          slots: [0, 1, 2].map((i) => ({
            id: `s${i}`,
            at: 1 + i * 2,
            type: "server-2u",
            assembly: "t",
          })),
        },
      ],
    });
    expect(one(racks, "budget/assembly-parts").params).toMatchObject({ leaves: 600 });
  });
  test("count 64 nested is capped before it is expanded", () => {
    const s = spec({
      assemblies: [
        {
          id: "a",
          parts: [
            {
              id: "x",
              count: 64,
              parts: [
                {
                  id: "y",
                  count: 64,
                  parts: [{ id: "z", count: 64, parts: [{ id: "w", count: 64 }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    const m = new AssemblyModel(s);
    expect(m.metrics(0).leaves).toBe(64 ** 4);
    expect(m.tree(0)).toBeUndefined(); // never expanded
    expect(one(assemblyDiagnostics(s, LIFT), "budget/assembly-parts").severity).toBe("error");
  });
  test("a chain of templates each used 64 times saturates instead of expanding", () => {
    const assemblies: Obj[] = [{ id: "t0", template: true, parts: [{ id: "p" }] }];
    for (let i = 1; i < 50; i++) {
      assemblies.push({
        id: `t${i}`,
        template: true,
        parts: [{ id: "x", use: `t${i - 1}`, count: 64 }],
      });
    }
    assemblies.push({ id: "top", parts: [{ id: "x", use: "t49", count: 64 }] });
    const d = run({ assemblies });
    expect(one(d, "budget/assembly-parts").severity).toBe("error");
    expect(code(d, "assembly/too-deep").length).toBeGreaterThan(0);
  });
  test("use cycles do not loop or expand", () => {
    const d = run({
      assemblies: [
        {
          id: "a",
          template: true,
          parts: [
            { id: "x", use: "b", count: 64 },
            { id: "y", use: "a", count: 64 },
          ],
        },
        { id: "b", template: true, parts: [{ id: "x", use: "a", count: 64 }] },
        { id: "top", parts: [{ id: "u", use: "a", count: 64 }] },
      ],
      steps: [{ assembly: [{ explode: "top/u/x/x/y" }] }],
    });
    expect(code(d, "assembly/template-cycle").length).toBe(2);
  });
  test("a thousand selectors on a large assembly stay bounded and deterministic", () => {
    const stages = Array.from({ length: 32 }, (_, k) => ({
      parts: Array.from({ length: 64 }, (_, i) => `zz-${k * 64 + i}-*`),
    }));
    const programs = Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, stages }));
    const s = spec({ assemblies: [{ id: "a", parts: leaves(1500), programs }] });
    const first = assemblyDiagnostics(s, LIFT);
    // warnings stop at 50 per program (one summary each); the work cap kicks in once
    expect(code(first, "assembly/diagnostics-capped").length).toBeGreaterThan(0);
    expect(code(first, "budget/time")).toHaveLength(1);
    expect(code(first, "budget/time")[0]?.path).toBe("/assemblies");
    expect(assemblyDiagnostics(s, LIFT)).toEqual(first);
  });
});

// ----------------------------------------------------------------------------- program checks

describe("program checks", () => {
  test("moved-twice: a node in two stages of one program (not descendants, not except)", () => {
    const d = run(
      engine({}, [
        {
          id: "p",
          stages: [
            { parts: ["head", "head"] },
            { parts: ["head/casting", "head/valve-*"] }, // descendants compose: fine
            { parts: ["head", "cover"] }, // head again: error
            { parts: ["*"], except: ["head", "cover", "block"] },
          ],
        },
      ]),
    );
    const e = one(d, "assembly/moved-twice");
    expect(e.path).toBe("/assemblies/0/programs/0/stages/2/parts");
    expect(e.message).toBe(
      'Stage 3 moves "head" that stage 1 already moves; a part moves in one stage per program',
    );
    expect(e.suggestion).toBe('Add "head" to the "except" of stage 3, or remove it from stage 1');
    expect(e.params).toEqual({ paths: ["head"], stage: 3, first: 1 });
  });
  test("moved-twice: a part added by two build steps", () => {
    const d = run(
      engine({}, [
        { id: "b", kind: "build", steps: [{ add: ["block", "head"] }, { add: ["head"] }] },
      ]),
    );
    const e = one(d, "assembly/moved-twice");
    expect(e.path).toBe("/assemblies/0/programs/0/steps/1/add");
    expect(e.message).toContain('Step 2 adds "head" that step 1 already adds');
  });
  test("build steps: subBuild and its program", () => {
    const d = run({
      assemblies: [
        {
          id: "a",
          parts: [
            {
              id: "cab",
              parts: [{ id: "w" }],
              programs: [{ id: "cab-build", kind: "build", steps: [{ add: ["w"] }] }],
            },
            { id: "leaf" },
          ],
          programs: [
            {
              id: "b",
              kind: "build",
              steps: [
                { add: ["cab"], subBuild: "cab", program: "cab-build" },
                { add: ["leaf"], subBuild: "cab", program: "cab-buld" },
                { add: ["cab"], subBuild: "cabb" },
                { add: ["leaf"], subBuild: "leaf" },
              ],
            },
          ],
        },
      ],
    });
    expect(code(d, "assembly/unknown-program").map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/0/programs/0/steps/1/program", 'Did you mean "cab-build"?'],
    ]);
    expect(code(d, "assembly/unknown-target").map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/0/programs/0/steps/2/subBuild", 'Did you mean "cab"?'],
      [
        "/assemblies/0/programs/0/steps/3/subBuild",
        "Name a part that has child parts or a template",
      ],
    ]);
    // cab is added by steps 0 and 2, leaf by steps 1 and 3
    expect(code(d, "assembly/moved-twice").map((x) => x.path)).toEqual([
      "/assemblies/0/programs/0/steps/2/add",
      "/assemblies/0/programs/0/steps/3/add",
    ]);
  });
  test("view needs an assembly-only spec", () => {
    const view = {
      assemblies: [
        {
          id: "a",
          parts: [{ id: "p" }],
          programs: [{ id: "b", kind: "build", steps: [{ add: ["p"], view: 90 }] }],
        },
      ],
    };
    none(run(view), "assembly/view-needs-assembly-only");
    for (const extra of [
      { nodes: [{ id: "n", type: "server" }] },
      { racks: [{ id: "r1" }] },
      { figures: [{ id: "f", base: "b", parts: [] }] },
      { storyboards: [{ id: "sb", frames: [] }] },
    ]) {
      const e = one(run({ ...view, ...extra }), "assembly/view-needs-assembly-only");
      expect(e.path).toBe("/assemblies/0/programs/0/steps/0/view");
    }
  });
  test("view cannot be combined with close-ups (levels draw the front only)", () => {
    const base = (extraPart: Record<string, unknown>, asm: Record<string, unknown> = {}) => ({
      assemblies: [
        { id: "t", template: true, parts: [{ id: "q" }] },
        {
          id: "a",
          parts: [{ id: "p", ...extraPart }],
          programs: [{ id: "b", kind: "build", steps: [{ add: ["p"], view: 90 }] }],
          ...asm,
        },
      ],
    });
    none(run(base({})), "assembly/view-needs-assembly-only");
    for (const spec of [base({ closeup: "t" }), base({}, { closeup: "t" })]) {
      const e = one(run(spec), "assembly/view-needs-assembly-only");
      expect(e.path).toBe("/assemblies/1/programs/0/steps/0/view");
      expect(e.message).toContain("close-ups");
    }
  });
  test("stage-out-of-range: explode/implode to, build to/advance, with the valid range", () => {
    const d = run(
      withSteps([
        {
          assembly: [
            { explode: "engine", to: 4 },
            { implode: "engine", to: 9 },
            { build: "engine", to: 4 },
            { build: "engine", advance: 3 },
            { build: "engine", program: "build" },
            { build: "engine", advance: 3 },
          ],
        },
      ]),
    );
    // build to 4 is rejected; advance 3 reaches 3; the bare build then needs step 4; advance 3 more: 6
    const r = code(d, "assembly/stage-out-of-range");
    expect(r.map((x) => [x.path, x.suggestion])).toEqual([
      ["/steps/0/assembly/0/to", "Use a value from 0 to 3"],
      ["/steps/0/assembly/1/to", "Use a value from 0 to 3"],
      ["/steps/0/assembly/2/to", "Use a value from 0 to 3"],
      ["/steps/0/assembly/4/build", "Use a value from 0 to 3"],
      ["/steps/0/assembly/5/advance", "Use a value from 0 to 3"],
    ]);
    expect(r[0]?.message).toBe('"engine" has 3 stages; "to": 4 is out of range');
    expect(r[2]?.message).toBe('"engine" has 3 steps; "to": 4 is out of range');
    expect(r[3]?.message).toBe('"engine" has 3 steps; building from 3 reaches 4 is out of range');
    expect(r[0]?.params).toEqual({ to: 4, count: 3, unit: "stage" });
  });
  test("rack programs, the built-in drawers program and slot internals have their own ranges", () => {
    const base = {
      assemblies: [
        {
          id: "t",
          template: true,
          parts: [{ id: "cpu", count: 2 }],
          programs: [{ id: "i", stages: [{ parts: ["cpu-*"] }, { parts: ["cpu-1"] }] }],
        },
      ],
    };
    const slots = [
      { id: "srv", at: 1, type: "server-2u", assembly: "t" },
      { id: "db", at: 5, type: "server-2u" },
    ];
    const withCustom = run({
      ...base,
      racks: [{ id: "r1", slots, programs: [{ id: "p", stages: [{ parts: ["srv"] }] }] }],
      steps: [
        {
          assembly: [
            { explode: "r1", to: 2 },
            { explode: "r1/srv", to: 4 },
            { explode: "r1/srv", to: 3 },
            { explode: "r1/db", to: 7 },
          ],
        },
      ],
    });
    expect(code(withCustom, "assembly/stage-out-of-range").map((x) => [x.path, x.message])).toEqual(
      [
        ["/steps/0/assembly/0/to", '"r1" has 1 stage; "to": 2 is out of range'],
        ["/steps/0/assembly/1/to", '"r1/srv" has 3 stages; "to": 4 is out of range'], // lid + 2 stages
      ],
    );
    const builtin = run({
      ...base,
      racks: [{ id: "r1", slots }],
      steps: [{ assembly: [{ explode: "r1", to: 3 }, { explode: "r1" }] }],
    });
    expect(code(builtin, "assembly/stage-out-of-range").map((x) => x.message)).toEqual([
      '"r1" has 2 stages; "to": 3 is out of range',
    ]);
    // the built-in `drawers` program is replaced by custom programs
    const named = run({
      ...base,
      racks: [{ id: "r1", slots, programs: [{ id: "p", stages: [{ parts: ["srv"] }] }] }],
      steps: [{ assembly: [{ explode: "r1", program: "drawers" }] }],
    });
    expect(one(named, "assembly/unknown-program").suggestion).toBe("Explode programs: p");
  });
  test("directions: explode-backwards, implode-forwards, build-backwards, unbuild-forwards", () => {
    const d = run(
      withSteps([
        {
          assembly: [
            { explode: "engine", to: 2 },
            { explode: "engine", to: 1 },
          ],
        },
        {
          assembly: [
            { implode: "engine", to: 0 },
            { implode: "engine", to: 2 },
          ],
        },
        {
          assembly: [
            { build: "engine", to: 2 },
            { build: "engine", to: 1 },
            { unbuild: "engine", to: 3 },
          ],
        },
      ]),
    );
    const at = (c: string) => code(d, c).map((x) => [x.path, x.message, x.suggestion]);
    expect(at("assembly/explode-backwards")).toEqual([
      [
        "/steps/0/assembly/1/to",
        '"engine" is at stage 2; explode to 1 would go backwards',
        'Use "implode" to reach stage 1',
      ],
    ]);
    expect(at("assembly/implode-forwards")).toEqual([
      [
        "/steps/1/assembly/1/to",
        '"engine" is at stage 0; implode to 2 would go forwards',
        'Use "explode" to reach stage 2',
      ],
    ]);
    expect(at("assembly/build-backwards")).toEqual([
      [
        "/steps/2/assembly/1/to",
        '"engine" is at step 2; build to 1 would go backwards',
        'Use "unbuild" to reach step 1',
      ],
    ]);
    expect(at("assembly/unbuild-forwards")).toEqual([
      [
        "/steps/2/assembly/2/to",
        '"engine" is at step 2; unbuild to 3 would go forwards',
        'Use "build" to reach step 3',
      ],
    ]);
  });
  test("a rejected action does not move the level", () => {
    const d = run(
      withSteps([
        {
          assembly: [
            { explode: "engine", to: 2 },
            { explode: "engine", to: 1 },
            { explode: "engine", to: 2 },
          ],
        },
      ]),
    );
    expect(code(d, "assembly/explode-backwards")).toHaveLength(1);
    expect(code(d, "assembly/no-op-action")).toHaveLength(1); // still at 2
  });
  test("no-op: implode at level 0, explode to the current stage (info, at the action)", () => {
    const d = run(
      withSteps([
        {
          assembly: [
            { implode: "engine" },
            { explode: "engine", to: 1 },
            { explode: "engine", to: 1 },
          ],
        },
      ]),
    );
    const n = code(d, "assembly/no-op-action");
    expect(n.map((x) => [x.path, x.severity])).toEqual([
      ["/steps/0/assembly/0", "info"],
      ["/steps/0/assembly/2", "info"],
    ]);
    expect(n[0]?.message).toBe('implode of "engine" does not change its stage (already at 0)');
  });
  test("levels are per program; implode reverses the program that exploded", () => {
    const d = run({
      assemblies: [
        {
          id: "a",
          parts: [{ id: "x" }, { id: "y" }],
          programs: [
            { id: "one", stages: [{ parts: ["x"] }] },
            { id: "two", stages: [{ parts: ["y"] }, { parts: ["x"] }] },
          ],
        },
      ],
      steps: [
        { assembly: [{ explode: "a", program: "two" }] },
        { assembly: [{ implode: "a" }] }, // reverses "two": level 2 -> 0, not a no-op on "one"
        { assembly: [{ explode: "a" }] }, // default program: the first, "one"
        { assembly: [{ implode: "a" }] },
      ],
    });
    expect(d).toEqual([]);
  });
  test("pose exploded starts the default explode program at its last stage; unbuild from the end", () => {
    const base = (pose: string) => ({
      assemblies: [
        {
          id: "a",
          pose,
          parts: [{ id: "x" }, { id: "y" }],
          programs: [
            { id: "e", stages: [{ parts: ["x"] }] },
            { id: "b", kind: "build", steps: [{ add: ["x"] }, { add: ["y"] }] },
          ],
        },
      ],
    });
    const steps = [
      { assembly: [{ explode: "a" }] },
      {
        assembly: [
          { unbuild: "a", to: 1 },
          { build: "a", advance: 1 },
          { build: "a", advance: 1 },
        ],
      },
    ];
    const ex = run({ ...base("exploded"), steps });
    expect(code(ex, "assembly/no-op-action").map((x) => x.path)).toEqual(["/steps/0/assembly/0"]);
    expect(code(ex, "assembly/stage-out-of-range").map((x) => x.path)).toEqual([
      "/steps/1/assembly/2/advance",
    ]);
    const plain = run({ ...base("assembled"), steps });
    expect(code(plain, "assembly/no-op-action")).toEqual([]);
    // a first build starts at level 0, so advancing twice is fine; unbuild starts at the last step
    expect(
      run({ ...base("assembled"), steps: [{ assembly: [{ build: "a", advance: 2 }] }] }),
    ).toEqual([]);
    expect(
      code(
        run({ ...base("empty"), steps: [{ assembly: [{ unbuild: "a" }] }] }),
        "assembly/no-op-action",
      ),
    ).toHaveLength(1);
  });
  test("program selection: unknown, wrong kind, none of the kind, rack builds", () => {
    const d = run(
      withSteps([
        {
          assembly: [
            { explode: "engine", program: "teardwn" },
            { explode: "engine", program: "build" },
            { build: "engine", program: "teardown" },
            { explode: "engine/head" },
          ],
        },
      ]),
    );
    expect(
      code(d, "assembly/unknown-program").map((x) => [x.path, x.message, x.suggestion]),
    ).toEqual([
      [
        "/steps/0/assembly/0/program",
        '"engine" has no program "teardwn"',
        'Did you mean "teardown"?',
      ],
      [
        "/steps/0/assembly/1/program",
        'Program "build" of "engine" is a build program, but explode needs an explode program',
        "Explode programs: teardown",
      ],
      [
        "/steps/0/assembly/2/program",
        'Program "teardown" of "engine" is an explode program, but build needs a build program',
        "Build programs: build",
      ],
      [
        "/steps/0/assembly/3/explode",
        'Cannot explode "engine/head": it has no explode program',
        'Add an explode program to "programs"',
      ],
    ]);
    const rack = run({
      racks: [{ id: "r1", slots: [{ id: "s", at: 1, type: "server-1u", assembly: "t" }] }],
      assemblies: [{ id: "t", template: true, parts: [{ id: "p" }] }],
      steps: [{ assembly: [{ build: "r1" }] }],
    });
    expect(one(rack, "assembly/unknown-program").suggestion).toBe(
      "Racks have explode programs only",
    );
  });
  test("assemblies[].program must exist", () => {
    const d = run(engine({ program: "teardwn" }));
    const e = one(d, "assembly/unknown-program");
    expect(e.path).toBe("/assemblies/0/program");
    expect(e.suggestion).toBe('Did you mean "teardown"?');
    none(run(engine({ program: "teardown" })), "assembly/unknown-program");
  });
  test("the assembly's default program is used, then the first of the kind", () => {
    const programs = [
      { id: "one", stages: [{ parts: ["block"] }] },
      { id: "two", stages: [{ parts: ["head"] }, { parts: ["cover"] }] },
    ];
    const steps = [{ assembly: [{ explode: "engine", to: 2 }] }];
    expect(
      code(run({ ...engine({}, programs), steps }), "assembly/stage-out-of-range"),
    ).toHaveLength(1);
    expect(
      code(run({ ...engine({ program: "two" }, programs), steps }), "assembly/stage-out-of-range"),
    ).toEqual([]);
  });
  test("storyboards play frames: no explode, build range, no programs", () => {
    const sb = {
      images: [{ id: "im", src: "a.png" }],
      storyboards: [{ id: "sb", frames: [{ model: "im" }, { model: "im" }, { model: "im" }] }],
    };
    const d = run({
      ...sb,
      steps: [
        {
          assembly: [
            { explode: "sb" },
            { implode: "sb" },
            { build: "sb", to: 2 },
            { build: "sb", to: 4 },
            { unbuild: "sb", to: 3 },
            { build: "sb", program: "x" },
            { build: "sb/x" },
            { unbuild: "sb", to: 0 },
          ],
        },
      ],
    });
    expect(code(d, "assembly/storyboard-no-explode").map((x) => [x.path, x.suggestion])).toEqual([
      ["/steps/0/assembly/0/explode", 'Use "build" instead'],
      ["/steps/0/assembly/1/implode", 'Use "unbuild" instead'],
    ]);
    expect(code(d, "assembly/stage-out-of-range").map((x) => x.message)).toEqual([
      '"sb" has 3 frames; "to": 4 is out of range',
    ]);
    expect(code(d, "assembly/unbuild-forwards").map((x) => x.path)).toEqual([
      "/steps/0/assembly/4/to",
    ]);
    expect(code(d, "assembly/unknown-program")).toHaveLength(1);
    expect(code(d, "assembly/unknown-target").map((x) => x.path)).toEqual([
      "/steps/0/assembly/6/build",
    ]);
  });
  test("unknown action roots name the targets that exist", () => {
    const d = run(withSteps([{ assembly: [{ explode: "motor" }] }]));
    expect(one(d, "assembly/unknown-target").suggestion).toBe("Targets: engine");
    const none_ = run({
      steps: [{ assembly: [{ explode: "x" }] }],
      images: [{ id: "i", src: "a.png" }],
    });
    expect(one(none_, "assembly/unknown-target").suggestion).toBe(
      'Declare an assembly in "assemblies" first',
    );
  });
});

// ----------------------------------------------------------------------------- shapes

describe("shapes and params", () => {
  const parts = (ps: Obj[]): Obj => ({ assemblies: [{ id: "a", parts: ps }] });
  const registry = (
    known: Record<string, (p: Record<string, unknown>) => Diagnostic[]>,
  ): PartShapeRegistry =>
    ({
      get: (ref: string) =>
        known[ref] === undefined
          ? undefined
          : ({
              id: ref,
              type: "dimm",
              readParams: (p: Record<string, unknown>) => ({
                params: p,
                diagnostics: known[ref]!(p),
              }),
            } as never),
      list: () => Object.keys(known).sort(),
    }) as PartShapeRegistry;
  test("primitives and a missing shape are fine; params on them are not", () => {
    expect(run(parts([{ id: "p" }, { id: "q", shape: "cylinder", axis: "x" }]))).toEqual([]);
    const e = one(
      run(parts([{ id: "p", shape: "cylinder", params: { a: 1 } }])),
      "assembly/shape-params",
    );
    expect(e.path).toBe("/assemblies/0/parts/0/params");
    expect(e.message).toBe('"params" only applies to pack shapes (pack:id), not to "cylinder"');
  });
  test("an unknown primitive name gets a did-you-mean; pack refs are unchecked without a registry", () => {
    const d = run(
      parts([
        { id: "p", shape: "cylindr" },
        { id: "q", shape: "hw:dimm", params: { x: 1 } },
        { id: "r", shape: "hw:" },
      ]),
    );
    expect(code(d, "assembly/unknown-shape").map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/0/parts/0/shape", 'Did you mean "cylinder"?'],
      ["/assemblies/0/parts/2/shape", expect.stringContaining("Use a primitive")],
    ]);
  });
  test("with a registry: unknown pack shapes and params are validated by the shape", () => {
    const reg = registry({
      "hw:dimm": (p) =>
        "bad" in p
          ? [
              {
                severity: "error",
                code: "x",
                path: "/bad",
                message: 'Unknown param "bad"',
                suggestion: 'Did you mean "bank"?',
              },
            ]
          : [],
      "hw:fan": () => [],
    });
    const s = spec(
      parts([
        { id: "a", shape: "hw:dimn" },
        { id: "b", shape: "hw:dimm", params: { bad: 1 } },
        { id: "c", shape: "hw:dimm", params: { bank: 1 } },
        { id: "d", shape: "brick:brick" },
      ]),
    );
    const d = assemblyDiagnostics(s, LIFT, { parts: reg });
    expect(code(d, "assembly/unknown-shape").map((x) => [x.path, x.message, x.suggestion])).toEqual(
      [
        [
          "/assemblies/0/parts/0/shape",
          'Shape "hw:dimn" is not installed',
          'Did you mean "hw:dimm"?',
        ],
        [
          "/assemblies/0/parts/3/shape",
          'Shape "brick:brick" is not installed',
          "Install the pack that provides it, or use a primitive",
        ],
      ],
    );
    expect(code(d, "assembly/shape-params")).toEqual([
      {
        severity: "error",
        code: "assembly/shape-params",
        path: "/assemblies/0/parts/1/params/bad",
        message: 'Unknown param "bad"',
        suggestion: 'Did you mean "bank"?',
        params: { shape: "hw:dimm" },
      },
    ]);
  });
  test("a registry shape's default type satisfies type: selectors; a throwing pack is reported", () => {
    const reg = registry({ "hw:dimm": () => [] });
    const s = spec({
      assemblies: [
        {
          id: "a",
          parts: [{ id: "m", shape: "hw:dimm" }],
          programs: [{ id: "p", stages: [{ parts: ["type:dimm"] }, { parts: ["type:cpu"] }] }],
        },
      ],
    });
    expect(assemblyDiagnostics(s, LIFT, { parts: reg }).map((x) => x.path)).toEqual([
      "/assemblies/0/programs/0/stages/1/parts/0",
    ]);
    // without a registry the default type is unknown, so an empty type: selector is not reported
    expect(assemblyDiagnostics(s, LIFT)).toEqual([]);
    const bad = {
      get: () => ({
        id: "x",
        type: "t",
        readParams: () => {
          throw new Error("boom");
        },
      }),
      list: () => ["hw:dimm"],
    } as unknown as PartShapeRegistry;
    const d = assemblyDiagnostics(
      spec(parts([{ id: "a", shape: "hw:dimm", params: { a: 1 } }])),
      LIFT,
      { parts: bad },
    );
    expect(one(d, "assembly/shape-params").message).toBe('Invalid params for shape "hw:dimm"');
  });
});

// ----------------------------------------------------------------------------- close-ups

describe("close-up paths", () => {
  const closeups: Obj = {
    images: [{ id: "im", src: "a.png" }],
    figures: [{ id: "sink", base: "im", parts: [{ id: "fin", image: "im", seat: [0, 0] }] }],
    assemblies: [
      {
        id: "board",
        template: true,
        parts: [{ id: "cpu", count: 2, closeup: "sink" }, { id: "dimm" }],
      },
      {
        id: "srv-2u",
        template: true,
        closeup: "board",
        parts: [{ id: "lid" }],
      },
    ],
    racks: [
      {
        id: "r1",
        slots: [{ id: "srv", at: 1, type: "server-2u", assembly: "srv-2u", closeup: "board" }],
      },
    ],
  };
  test("paths through the reserved closeup segment resolve instance by instance", () => {
    const steps = [
      { focus: "r1/srv/lid" },
      { focus: "r1/srv/closeup" },
      { focus: "r1/srv/closeup/cpu-1" },
      { focus: "r1/srv/closeup/cpu-1/closeup" },
      { focus: "r1/srv/closeup/cpu-9" },
      { focus: "r1/srv/closeup/dimm/closeup" },
      { focus: "r1/srv/closeup/cpu-1/closeup/fin" },
      { set: { "r1/srv/closeup/dimm": "down" } },
    ];
    const d = run({ ...closeups, steps });
    expect(
      code(d, "assembly/unknown-target").map((x) => [x.path, x.message, x.suggestion]),
    ).toEqual([
      [
        "/steps/4/focus",
        'Unknown focus target "r1/srv/closeup/cpu-9": "r1/srv/closeup" has no part "cpu-9"',
        'Did you mean "r1/srv/closeup/cpu-1"?',
      ],
      [
        "/steps/5/focus",
        'Unknown focus target "r1/srv/closeup/dimm/closeup": "r1/srv/closeup/dimm" has no close-up',
        'Set "closeup" on "r1/srv/closeup/dimm" first',
      ],
      [
        "/steps/6/focus",
        'Unknown focus target "r1/srv/closeup/cpu-1/closeup/fin": "r1/srv/closeup/cpu-1/closeup" has no part "fin"',
        '"r1/srv/closeup/cpu-1/closeup" has no child parts',
      ],
    ]);
  });
  test("actions through closeup paths are checked once phase 2 lifts, not before", () => {
    const steps = [
      { assembly: [{ explode: "r1/srv/closeup", to: 9 }, { explode: "r1/srv/closeup/cpu-1" }] },
    ];
    const lifted = run({ ...closeups, steps });
    expect(code(lifted, "assembly/stage-out-of-range").map((x) => x.path)).toEqual([]); // board has no programs
    expect(code(lifted, "assembly/unknown-program").map((x) => x.path)).toEqual([
      "/steps/0/assembly/0/explode",
      "/steps/0/assembly/1/explode",
    ]);
    const gated = run({ ...closeups, steps }, { phase2: true });
    expect(gated).toEqual([]);
  });
  test("closeup depth and the instance limit use the template's height", () => {
    const deep = (n: number): Obj => {
      let part: Obj = { id: "leaf" };
      for (let i = 1; i < n; i++) part = { id: `p${i}`, parts: [part] };
      return part;
    };
    const mk = (n: number) =>
      run({
        assemblies: [
          { id: "t", template: true, parts: [deep(n)] },
          { id: "a", closeup: "t", parts: [{ id: "x" }] },
        ],
      });
    none(mk(6), "assembly/too-deep"); // a/closeup + 6 levels = 8
    expect(one(mk(7), "assembly/too-deep").path).toBe("/assemblies/1/closeup");
  });

  // #89 Q04: the prefix accumulates along a chain of close-ups (each reference alone fits)
  const chain = (n: number, first: Obj = {}): Obj => ({
    assemblies: [
      { id: "a0", parts: [{ id: "p", closeup: "t1" }], ...first },
      ...Array.from({ length: n }, (_, i) => ({
        id: `t${i + 1}`,
        template: true,
        parts: [{ id: "p", ...(i + 1 < n ? { closeup: `t${i + 2}` } : {}) }],
      })),
    ],
  });
  test("a chain of close-ups is measured with the accumulated path prefix", () => {
    // a0/p/closeup/p/closeup/p/closeup/p = 8 segments: three levels fit
    none(run(chain(3)), "assembly/too-deep");
    // the fourth instance would hold a0/p/closeup/p/closeup/p/closeup/p/closeup/p: 10 segments
    const d = one(run(chain(4)), "assembly/too-deep");
    expect(d.path).toBe("/assemblies/3/parts/0/closeup");
    expect(d.params).toEqual({
      host: "a0/p/closeup/p/closeup/p/closeup/p",
      closeup: "t4",
      depth: 10,
      limit: 8,
    });
  });
  test("the scene skips the same close-up at the same pointer with the same params", () => {
    const scene = buildScene(spec(chain(4)), {});
    const d = code(scene.diagnostics, "assembly/too-deep");
    expect(d.map((x) => [x.path, x.params])).toEqual([
      [
        "/assemblies/3/parts/0/closeup",
        { host: "a0/p/closeup/p/closeup/p/closeup/p", closeup: "t4", depth: 10, limit: 8 },
      ],
    ]);
  });
  test("a chain is reported once, however many hosts reach it", () => {
    const twice = chain(4);
    const a0 = (twice["assemblies"] as Obj[])[0] as Obj;
    a0["parts"] = [
      { id: "p", closeup: "t1" },
      { id: "q", closeup: "t1" },
    ];
    expect(code(run(twice), "assembly/too-deep")).toHaveLength(1);
  });
  test("a rack slot's close-up chain starts at rack/slot/closeup", () => {
    const rack = (n: number): Obj => ({
      ...chain(n),
      racks: [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-2u", closeup: "t1" }] }],
    });
    // r1/srv/closeup/p/closeup/p/closeup/p = 8
    none(run(rack(3)), "assembly/too-deep");
    expect(code(run(rack(4)), "assembly/too-deep").map((x) => x.path)).toEqual([
      "/assemblies/3/parts/0/closeup",
    ]);
  });
  test("a cycle of close-ups stops (template-cycle reports it)", () => {
    const loop = chain(2);
    ((loop["assemblies"] as Obj[])[2] as Obj)["parts"] = [{ id: "p", closeup: "t1" }];
    const d = run(loop);
    none(d, "assembly/too-deep");
    expect(code(d, "assembly/template-cycle").length).toBeGreaterThan(0);
  });
});

// ----------------------------------------------------------------------------- gating

describe("per-target gating mirrors the merge guard", () => {
  const steps = [
    {
      assembly: [
        { explode: "engine", to: 9 },
        { build: "engine", to: 9 },
        { explode: "r1", to: 9 },
        { explode: "sb" },
        { explode: "ghost" },
      ],
    },
  ];
  const all = {
    ...engine(),
    racks: [{ id: "r1", slots: [{ id: "s", at: 1, type: "server-1u" }] }],
    images: [{ id: "im", src: "a.png" }],
    storyboards: [{ id: "sb", frames: [{ model: "im" }] }],
    steps,
  };
  const paths = (g: Partial<Record<GuardGroup, boolean>>) =>
    assemblyDiagnostics(spec(all), {
      phase1a: true,
      phase1b: true,
      phase2: true,
      storyboards: true,
      phase3: true,
      ...g,
    })
      .filter((d) => d.path.startsWith("/steps"))
      .map((d) => `${d.code}@${d.path.replace("/steps/0/assembly/", "")}`);
  test("with everything gated no action is checked (the guard reports them)", () => {
    expect(paths({})).toEqual([]);
  });
  test("lifting phase1a alone reports only unknown roots", () => {
    expect(paths({ phase1a: false })).toEqual(["assembly/unknown-target@4/explode"]);
  });
  test("lifting phase1b checks explode on assemblies; build also needs phase2", () => {
    expect(paths({ phase1a: false, phase1b: false })).toEqual([
      "assembly/stage-out-of-range@0/to",
      "assembly/unknown-target@4/explode",
    ]);
    expect(paths({ phase1a: false, phase1b: false, phase2: false })).toEqual([
      "assembly/stage-out-of-range@0/to",
      "assembly/stage-out-of-range@1/to",
      "assembly/stage-out-of-range@2/to",
      "assembly/unknown-target@4/explode",
    ]);
  });
  test("storyboard actions need the storyboards group (R-2)", () => {
    expect(paths({ phase1a: false, storyboards: false })).toEqual([
      "assembly/storyboard-no-explode@3/explode",
      "assembly/unknown-target@4/explode",
    ]);
  });
  test("structure checks do not wait for the guard", () => {
    const d = assemblyDiagnostics(
      spec({ assemblies: [{ id: "a", parts: [{ id: "p" }, { id: "p" }] }] }),
      UNRENDERED,
    );
    expect(code(d, "assembly/duplicate-part")).toHaveLength(1);
  });
  test("default wiring: validate reports structure, no guard, and de-duplicates figure targets", () => {
    const d = val({ ...engine(), steps: [{ assembly: [{ explode: "enigne" }] }] });
    // every phase is lifted (D-4a): the engine example's build program is not flagged, and the
    // unknown target is reported once
    expect(code(d, "assembly/unsupported")).toEqual([]);
    const unknown = code(d, "assembly/unknown-target");
    expect(unknown.map((x) => x.path)).toEqual(["/steps/0/assembly/0/explode"]);
    expect(unknown[0]?.suggestion).toBe('Did you mean "engine"?');
  });
});

// ----------------------------------------------------------------------------- discriminators

describe("oneOf discriminators for 1.2 value unions", () => {
  const stage = (s: Obj) => ({
    ...engine({}, [{ id: "p", stages: [{ parts: ["head"], ...s }] }]),
  });
  const first = (o: Obj): Diagnostic[] =>
    validate(spec(o)).diagnostics.filter((d) => d.code.startsWith("schema/"));
  test("direction: a misspelled preset reports the enum with a did-you-mean", () => {
    const d = first(stage({ direction: "uup" }));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      code: "schema/enum",
      path: "/assemblies/0/programs/0/stages/0/direction",
      suggestion: 'Did you mean "up"?',
    });
    expect(d[0]?.message).not.toContain("Not a valid");
  });
  test("direction: a vector of the wrong length reports the vector, not the union", () => {
    const d = first(stage({ direction: [1, 2] }));
    expect(d.map((x) => x.code)).toEqual(["schema/min-items"]);
    expect(d[0]?.path).toBe("/assemblies/0/programs/0/stages/0/direction");
  });
  test("distance: bad strings and big numbers report the matching branch", () => {
    expect(first(stage({ distance: "2.555x" })).map((x) => x.code)).toEqual(["schema/pattern"]);
    expect(first(stage({ distance: 1e9 })).map((x) => x.code)).toEqual(["schema/maximum"]);
    expect(first(stage({ distance: "1.5x" }))).toEqual([]);
    expect(first(stage({ direction: "lift", distance: "auto" }))).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- determinism and 1.1

describe("determinism and byte identity", () => {
  const big = (): PlatformCosmoSpec =>
    spec({
      ...withSteps([
        {
          assembly: [
            { explode: "engine", to: 2 },
            { explode: "engine", to: 1 },
            { explode: "enginee" },
          ],
        },
        { focus: "engine/hed" },
      ]),
      images: [{ id: "im", src: "a.png" }],
    });
  test("same input, same output, in a fixed order", () => {
    const a = assemblyDiagnostics(big(), LIFT);
    const b = assemblyDiagnostics(JSON.parse(JSON.stringify(big())) as PlatformCosmoSpec, LIFT);
    expect(a.length).toBeGreaterThan(2);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(validate(big()).diagnostics)).toBe(
      JSON.stringify(validate(big()).diagnostics),
    );
  });
  test("1.1 specs produce no assembly diagnostics and no content", () => {
    const root = new URL("../../../examples/", import.meta.url);
    const files = [
      ...readdirSync(root).filter((f) => f.endsWith(".cosmo.json")),
      ...readdirSync(new URL("templates/", root))
        .filter((f) => f.endsWith(".cosmo.json"))
        .map((f) => `templates/${f}`),
    ];
    expect(files.length).toBeGreaterThanOrEqual(15);
    // the 1.2.0 gallery stories (D-4a, D-4b) are the examples with assembly content
    const stories = ["hall-to-heatsink", "brick-rover", "rover-booklet"].map(
      (n) => `${n}.cosmo.json`,
    );
    const v11 = files.filter((f) => !stories.includes(f));
    expect(v11.length).toBe(files.length - stories.length);
    for (const f of v11) {
      const s = JSON.parse(readFileSync(new URL(f, root), "utf8")) as PlatformCosmoSpec;
      expect(hasAssemblyContent(s), f).toBe(false);
      expect(assemblyDiagnostics(s, LIFT), f).toEqual([]);
    }
  });
  test("a node id closeup and 1.1 rack paths are untouched (no assembly checks run)", () => {
    const s = {
      meta: META,
      nodes: [{ id: "closeup", type: "server" }],
      racks: [{ id: "r1", slots: [{ id: "closeup", at: 1, type: "server-1u" }] }],
      steps: [{ focus: "r1/closeup" }],
    };
    expect(assemblyDiagnostics(s as unknown as PlatformCosmoSpec, LIFT)).toEqual([]);
  });
});

// ----------------------------------------------------------------------------- review hardening

/** Wall time of `fn` in ms; used only as a hang detector with generous ceilings. */
const timed = <T>(fn: () => T): { ms: number; value: T } => {
  const t = performance.now();
  const value = fn();
  return { ms: performance.now() - t, value };
};

describe("linear glob matching (ReDoS)", () => {
  test("globMatch: * and ? semantics", () => {
    const m = (g: string, t: string) => globMatch(g, t);
    expect(m("*", "")).toBe(true);
    expect(m("*", "abc")).toBe(true);
    expect(m("cyl-*", "cyl-")).toBe(true);
    expect(m("cyl-*", "cyl")).toBe(false);
    expect(m("a?c", "abc")).toBe(true);
    expect(m("a?c", "ac")).toBe(false);
    expect(m("*b*", "abc")).toBe(true);
    expect(m("a*b*c", "axxbyyc")).toBe(true);
    expect(m("a*b*c", "axxbyy")).toBe(false);
    expect(m("**", "x")).toBe(true);
    expect(m("a", "a")).toBe(true);
    expect(m("a", "ab")).toBe(false);
    expect(m("", "")).toBe(true);
    expect(m("?*", "")).toBe(false);
  });
  const evil = `${"*a".repeat(15)}*b`;
  const id = "a".repeat(40);
  test("an adversarial glob finishes at once (hang detector)", () => {
    const r = timed(() => globMatch(evil, id));
    expect(r.value).toBe(false);
    expect(r.ms).toBeLessThan(50);
  });
  test("call site 1: assembly selectors (id, scope and type terms)", () => {
    const d = timed(() =>
      run({
        assemblies: [
          {
            id: "a",
            parts: [{ id, type: id, parts: [{ id }] }],
            programs: [
              {
                id: "p",
                stages: [{ parts: [evil, `${evil}/${id}`, `type:${evil}`, `**/${evil}`] }],
              },
            ],
          },
        ],
      }),
    );
    expect(d.ms).toBeLessThan(500);
    expect(code(d.value, "assembly/selector-empty")).toHaveLength(4);
  });
  test("call site 2: the figure selector matcher in scene/boards.ts", () => {
    const r = timed(() => matchFigureSelector(evil, [{ id }, { id: "b" }]));
    expect(r.value).toEqual([]);
    expect(r.ms).toBeLessThan(50);
    expect(matchFigureSelector("p-*", [{ id: "p-1" }, { id: "q-1" }])).toEqual(["p-1"]);
    expect(matchFigureSelector("**/type:d?mm", [{ id: "x", type: "dimm" }])).toEqual(["x"]);
  });
});

describe("selector matching is memoised over scope x segment", () => {
  /** A tree with the given branching per level; the first child of every group is called q. */
  const tree = (branching: number[], depth = 0): Obj[] =>
    Array.from({ length: branching[depth] ?? 1 }, (_, i) => {
      const id = i === 0 ? "q" : depth === branching.length - 1 ? `z${i}` : `g${i}`;
      return depth === branching.length - 1
        ? { id, size: [1, 1, 1] }
        : { id, parts: tree(branching, depth + 1) };
    });
  test("six ** scopes over a depth-7 tree and 1000 selectors finish in bounded time", () => {
    const sel = "**/**/**/**/**/**/q/*";
    const stages = Array.from({ length: 16 }, (_, k) => ({
      parts: Array.from({ length: 63 }, (_, i) => `${sel.slice(0, -1)}*${k * 63 + i}*`),
    }));
    const s = spec({
      assemblies: [
        { id: "a", parts: tree([3, 3, 2, 2, 2, 2, 12]), programs: [{ id: "p", stages }] },
      ],
    });
    const r = timed(() => assemblyDiagnostics(s, LIFT));
    expect(r.ms).toBeLessThan(4000);
    // the same program again: identical result
    expect(JSON.stringify(assemblyDiagnostics(s, LIFT))).toBe(JSON.stringify(r.value));
    expect(code(r.value, "budget/assembly-parts").map((x) => x.severity)).toEqual(["warning"]);
  });
  test("exact semantics survive the memoisation: ** consumes zero or more scopes", () => {
    const d = run({
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "x", parts: [{ id: "y", parts: [{ id: "q", type: "t" }] }] },
            { id: "q", type: "t" },
          ],
          programs: [
            {
              id: "p",
              stages: [
                { parts: ["**/**/**/q"] }, // q at depth 1 and 3
                { parts: ["x/**/q/**"], except: [] }, // nothing below q: empty
                { parts: ["x/**/**/y"] },
              ],
            },
          ],
        },
      ],
    });
    expect(code(d, "assembly/selector-empty").map((x) => x.path)).toEqual([
      "/assemblies/0/programs/0/stages/1/parts/0",
    ]);
    expect(code(d, "assembly/moved-twice").map((x) => x.path)).toEqual([]);
  });
});

describe("bounded work: many owners, long programs, spent budgets", () => {
  test("500-step build programs over many owners: warnings capped per program", () => {
    const steps = Array.from({ length: 500 }, (_, i) => ({ add: [`zz-${i % 9}-*`] }));
    const assemblies = Array.from({ length: 50 }, (_, i) => ({
      id: `a${i}`,
      parts: leaves(40),
      programs: [{ id: "b", kind: "build", steps }],
    }));
    const r = timed(() => run({ assemblies }));
    expect(r.ms).toBeLessThan(4000);
    expect(code(r.value, "assembly/selector-empty")).toHaveLength(50 * 50);
    expect(code(r.value, "assembly/diagnostics-capped")).toHaveLength(50);
    expect(code(r.value, "assembly/diagnostics-capped")[0]).toMatchObject({
      severity: "info",
      path: "/assemblies/0/programs/0",
      params: { dropped: 450, limit: 50 },
    });
  });
  test("the cap keeps errors: a moved-twice after 50 warnings is still reported", () => {
    const parts = [...Array.from({ length: 60 }, (_, i) => `nope-${i}`), "block"];
    const d = run(
      engine({}, [{ id: "p", stages: [{ parts: ["block"] }, { parts: parts.slice(0, 63) }] }]),
    );
    expect(code(d, "assembly/moved-twice")).toHaveLength(1);
    expect(code(d, "assembly/selector-empty")).toHaveLength(50);
    expect(code(d, "assembly/diagnostics-capped")).toHaveLength(1);
  });
  test("running out of node budget leaves no partial tree: no false empties", () => {
    // 50 assemblies x 1900 leaves = 95,000 nodes, past the 80,000-node budget of one run
    const assemblies = Array.from({ length: 50 }, (_, i) => ({
      id: `a${i}`,
      parts: leaves(1900),
      programs: [{ id: "p", stages: [{ parts: ["p29-*"] }, { parts: ["nowhere-*"] }] }],
    }));
    const r = timed(() => run({ assemblies, steps: [{ focus: "a49/p29-1" }] }));
    expect(r.ms).toBeLessThan(8000);
    const empties = code(r.value, "assembly/selector-empty");
    // only the genuine miss is reported, and only for assemblies that were fully expanded
    expect(empties.every((x) => x.path.endsWith("/stages/1/parts/0"))).toBe(true);
    expect(empties.length).toBeGreaterThan(0);
    expect(empties.length).toBeLessThan(50);
    const t = code(r.value, "budget/time");
    expect(t).toHaveLength(1);
    expect(t[0]?.path).toBe("/assemblies");
    expect(t[0]?.message).toContain("selector-empty, moved-twice");
  });
  test("thousands of bad set paths stay bounded (walks and hints are charged)", () => {
    const set = Object.fromEntries(
      Array.from({ length: 3000 }, (_, i) => [`engine/zz${i}/p`, "down"]),
    );
    const r = timed(() => run({ ...engine(), steps: [{ set }] }));
    expect(r.ms).toBeLessThan(4000);
    expect(code(r.value, "assembly/unknown-target").length).toBeGreaterThan(100);
  });
});

describe("review decisions", () => {
  test("endpoints: an assembly id is accepted; a figure or storyboard id stays an error (validate)", () => {
    const d = val({
      nodes: [{ id: "n", type: "server" }],
      images: [{ id: "im", src: "a.png" }],
      figures: [{ id: "fig", base: "im", parts: [{ id: "p", image: "im", seat: [0, 0] }] }],
      storyboards: [{ id: "sb", frames: [{ model: "im" }] }],
      assemblies: [{ id: "asm", parts: [{ id: "p" }] }],
      edges: [
        { from: "n", to: "asm" },
        { from: "n", to: "fig" },
        { from: "n", to: "sb" },
        { from: "n", to: "fig/p" },
      ],
    });
    const u = code(d, "semantic/unknown-node");
    expect(u.map((x) => [x.path, x.message])).toEqual([
      ["/edges/1/to", 'Node "fig" is a figure and is not allowed here'],
      ["/edges/2/to", 'Node "sb" is a storyboard and is not allowed here'],
      ["/edges/3/to", 'Node "fig/p": "fig" is not a rack'],
    ]);
    expect(code(d, "assembly/edge-to-part")).toEqual([]);
    expect(d.filter((x) => x.path === "/edges/0/to")).toEqual([]);
  });
  test("an id in two lists resolves as the guard does (assembly over node)", () => {
    const d = run({
      nodes: [{ id: "engine", type: "server" }],
      ...engine(),
      steps: [{ assembly: [{ explode: "engine/hed" }] }],
    });
    expect(one(d, "assembly/unknown-target").suggestion).toBe('Did you mean "engine/head"?');
  });
  test("default build program: the assembly's program when it is a build program, else the first", () => {
    const programs = [
      { id: "b1", kind: "build", steps: [{ add: ["block"] }] },
      { id: "b2", kind: "build", steps: [{ add: ["head"] }, { add: ["cover"] }] },
    ];
    const steps = [{ assembly: [{ build: "engine", to: 2 }] }];
    expect(
      code(run({ ...engine({}, programs), steps }), "assembly/stage-out-of-range"),
    ).toHaveLength(1);
    expect(
      code(run({ ...engine({ program: "b2" }, programs), steps }), "assembly/stage-out-of-range"),
    ).toEqual([]);
    // a default `program` of the wrong kind is skipped
    const mixed = [
      { id: "e", stages: [{ parts: ["head"] }] },
      { id: "b1", kind: "build", steps: [{ add: ["block"] }] },
    ];
    expect(
      code(
        run({
          ...engine({ program: "e" }, mixed),
          steps: [{ assembly: [{ build: "engine", to: 1 }] }],
        }),
        "assembly/unknown-program",
      ),
    ).toEqual([]);
  });
  test("a first build starts at level k - advance (to and advance together)", () => {
    const programs = [
      {
        id: "b",
        kind: "build",
        steps: [{ add: ["block"] }, { add: ["head"] }, { add: ["cover"] }, { add: ["cyl-*"] }],
      },
    ];
    const at = (actions: unknown[]) =>
      run({ ...engine({}, programs), steps: [{ assembly: actions }] });
    // starts at 3 - 2 = 1, reaches 3; a later build to 2 is backwards
    const d = at([
      { build: "engine", to: 3, advance: 2 },
      { build: "engine", to: 2 },
    ]);
    expect(code(d, "assembly/build-backwards").map((x) => x.path)).toEqual([
      "/steps/0/assembly/1/to",
    ]);
    // advance larger than to: the timeline would start below step 0
    const e = one(at([{ build: "engine", to: 1, advance: 2 }]), "assembly/stage-out-of-range");
    expect(e.path).toBe("/steps/0/assembly/0/advance");
    // advance alone starts at 0
    expect(
      at([
        { build: "engine", advance: 2 },
        { build: "engine", advance: 2 },
      ]),
    ).toEqual([]);
  });
  test("slot internals: 1 + the template's default program (stages, or steps for a build program)", () => {
    const racks = [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-2u", assembly: "t" }] }];
    const t = (extra: Obj) => ({ id: "t", template: true, parts: [{ id: "x" }], ...extra });
    const stages = [{ parts: ["x"] }];
    const range = (template: Obj, to: number) =>
      code(
        run({ assemblies: [template], racks, steps: [{ assembly: [{ explode: "r1/srv", to }] }] }),
        "assembly/stage-out-of-range",
      ).length;
    const build = {
      id: "b",
      kind: "build",
      steps: [{ add: ["x"] }, { add: ["x"] }, { add: ["x"] }],
    };
    // default explode program: 2 stages => internals 3
    expect(range(t({ programs: [{ id: "e", stages: [...stages, ...stages] }] }), 3)).toBe(0);
    expect(range(t({ programs: [{ id: "e", stages: [...stages, ...stages] }] }), 4)).toBe(1);
    // `program` naming a build program: 1 + 3 steps
    expect(range(t({ program: "b", programs: [{ id: "e", stages }, build] }), 4)).toBe(0);
    expect(range(t({ program: "b", programs: [{ id: "e", stages }, build] }), 5)).toBe(1);
  });
  test("use together with parts warns and still checks the reference", () => {
    const d = run({
      assemblies: [
        { id: "tmpl", template: true, parts: [{ id: "p" }] },
        {
          id: "a",
          parts: [
            { id: "x", parts: [{ id: "y" }], use: "tmpl" },
            { id: "z", parts: [{ id: "y" }], use: "tmp" },
          ],
        },
      ],
    });
    expect(code(d, "assembly/use-ignored").map((x) => [x.path, x.severity])).toEqual([
      ["/assemblies/1/parts/0/use", "warning"],
      ["/assemblies/1/parts/1/use", "warning"],
    ]);
    expect(code(d, "assembly/unknown-target").map((x) => [x.path, x.suggestion])).toEqual([
      ["/assemblies/1/parts/1/use", 'Did you mean "tmpl"?'],
    ]);
  });
  test("a template used only as a close-up counts toward the leaf budget", () => {
    const d = run({
      assemblies: [
        { id: "t", template: true, parts: leaves(501) },
        { id: "a", parts: [{ id: "x", closeup: "t" }] },
      ],
    });
    expect(one(d, "budget/assembly-parts").params).toMatchObject({ leaves: 502 });
    // referenced twice: counted once; a template nobody uses does not count
    const twice = run({
      assemblies: [
        { id: "t", template: true, parts: leaves(300) },
        { id: "u", template: true, parts: leaves(900) },
        { id: "a", closeup: "t", parts: [{ id: "x", closeup: "t" }] },
      ],
    });
    expect(code(twice, "budget/assembly-parts")).toEqual([]);
  });
  test("type: selectors skip only when the nodes they can reach have unknown pack types", () => {
    const parts = [
      { id: "a", parts: [{ id: "n" }] },
      { id: "b", parts: [{ id: "m", shape: "hw:fan" }] },
    ];
    const d = run({
      assemblies: [
        {
          id: "x",
          parts,
          programs: [{ id: "p", stages: [{ parts: ["a/type:zz", "b/type:zz", "**/type:zz"] }] }],
        },
      ],
    });
    // a/ reaches only a plain node (reported); b/ and **/ can reach the pack shape (skipped)
    expect(code(d, "assembly/selector-empty").map((x) => x.path)).toEqual([
      "/assemblies/0/programs/0/stages/0/parts/0",
    ]);
  });
});
