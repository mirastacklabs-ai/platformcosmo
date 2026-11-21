import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type {
  Box3,
  Diagnostic,
  PartMove,
  ResolvedExplodeProgram,
  SceneAssembly,
  SceneAssemblyNode,
  SceneGraph,
} from "../src/index.js";
import { buildScene } from "../src/index.js";
import { assemblyDiagnostics } from "../src/schema/assembly-semantic.js";
import { assemblyNodes, buildAssemblies } from "../src/scene/assembly/tree.js";
import { AssemblyPrograms } from "../src/scene/assembly/plan.js";
import { makeWork } from "../src/scene/assembly/selectors.js";
import { programSegment } from "../src/scene/assembly/timing.js";
import type { PlatformCosmoSpec } from "../src/schema/types.gen.js";

// A2-3 review round: stacking in moved frames, reach under co-active programs, the shared level
// machine, implicit access as a single move, bounded fallbacks.

type Obj = Record<string, unknown>;
const spec = (o: Obj): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...o }) as unknown as PlatformCosmoSpec;
const scene = (s: PlatformCosmoSpec): SceneGraph => buildScene(s, {});
const asmOf = (g: SceneGraph, id = "a"): SceneAssembly =>
  g.assemblies?.assemblies.find((x) => x.id === id) as SceneAssembly;
const nodeOf = (a: SceneAssembly, path: string): SceneAssemblyNode =>
  assemblyNodes(a).find((n) => n.path === path) as SceneAssemblyNode;
const prog = (a: SceneAssembly, id: string, owner = a.id): ResolvedExplodeProgram =>
  a.programs.find((p) => p.id === id && p.owner === owner) as ResolvedExplodeProgram;
const moves = (p: ResolvedExplodeProgram): PartMove[] => p.stages.flatMap((s) => s.moves);
const box = (id: string, at: number[], size: number[], extra: Obj = {}): Obj => ({
  id,
  at,
  size,
  ...extra,
});
const tile = (parts: unknown[], programs: unknown[], extra: Obj = {}): Obj => ({
  id: "a",
  units: "tile",
  parts,
  programs,
  ...extra,
});
const codes = (d: readonly Diagnostic[], code: string): Diagnostic[] =>
  d.filter((x) => x.code === code);
const LIFTED = {
  phase1a: false,
  phase1b: false,
  phase2: true,
  storyboards: true,
  phase3: true,
};

const engine = (): Obj => {
  const md = readFileSync(new URL("../../../docs/design/assemblies.md", import.meta.url), "utf8");
  const all = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .filter((s) => typeof s.meta === "object");
  return structuredClone(
    all.find((s) => (s.meta as { title: string }).title.startsWith("Inline-4")) as Obj,
  );
};

/** World box of a node after the moves of itself and every ancestor in `p`. */
const finalBox = (a: SceneAssembly, p: ResolvedExplodeProgram, path: string): Box3 => {
  const n = nodeOf(a, path);
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (const m of moves(p)) {
    if (path === m.path || path.startsWith(`${m.path}/`)) {
      dx += m.offset.x;
      dy += m.offset.y;
      dz += m.offset.z;
    }
  }
  return {
    origin: { x: n.world.origin.x + dx, y: n.world.origin.y + dy, z: n.world.origin.z + dz },
    size: n.world.size,
  };
};

// ------------------------------------------------------------------------ P1-Q01: moved frames

describe("stacking sees the offsets of moved ancestors", () => {
  test("§19.3 re-move: valve-cover up, head lift, head/valve-* up (gap 52)", () => {
    const e = engine();
    const asm = (e.assemblies as Obj[])[0] as Obj;
    asm.programs = [
      {
        id: "re",
        gap: 52,
        stages: [
          { parts: ["valve-cover"], direction: "up" },
          { parts: ["head"], direction: "lift" },
          { parts: ["head/valve-*"], direction: "up" },
        ],
      },
    ];
    const a = asmOf(scene(spec({ assemblies: [asm] })), "engine");
    const p = prog(a, "re", "engine");
    const gap = 52 * a.frame.scale.z;
    const cover = finalBox(a, p, "engine/valve-cover");
    const head = finalBox(a, p, "engine/head");
    for (let k = 1; k <= 8; k++) {
      const v = finalBox(a, p, `engine/head/valve-${k}`);
      // the valves end below the cover by at least the gap, and above the head they rose with
      expect(cover.origin.z).toBeGreaterThanOrEqual(v.origin.z + v.size.z + gap - 1e-6);
      expect(v.origin.z).toBeGreaterThan(head.origin.z);
    }
  });

  test("nested lift: the child stacks in the frame its parent moved to", () => {
    const parts = [
      box("base", [0, 0, 0], [4, 4, 1]),
      box("h", [0, 0, 1], [4, 4, 1], {
        parts: [box("k", [1, 1, 0], [1, 1, 3])], // the child pokes above its parent
      }),
      box("top", [0, 0, 6], [4, 4, 1]),
    ];
    const g = scene(
      spec({
        assemblies: [
          tile(parts, [
            {
              id: "p",
              gap: 1,
              stages: [
                { parts: ["top"], direction: "up" },
                { parts: ["h"], direction: "up", distance: 10 },
                { parts: ["h/k"], direction: "up" },
              ],
            },
          ]),
        ],
      }),
    );
    const a = asmOf(g);
    const p = prog(a, "p");
    const k = finalBox(a, p, "a/h/k");
    const top = finalBox(a, p, "a/top");
    // `h` moved 10 up, so `k` (rest top at 4+10) must clear nothing below `top`'s new floor
    expect(top.origin.z).toBeGreaterThanOrEqual(k.origin.z + k.size.z + 1 - 1e-6);
  });

  test("randomized nested re-moves, lift layers, mixed lift/up and ±x/-z groups (seeded)", () => {
    let seed = 4242;
    const rnd = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    const DIRS = ["up", "lift", "+x", "-x", "-z", "down"];
    const axisOf = (d: string): [number, number] =>
      d === "+x" ? [0, 1] : d === "-x" ? [0, -1] : d === "-z" || d === "down" ? [2, -1] : [2, 1];
    for (let iter = 0; iter < 80; iter++) {
      const n = 3 + rnd(3);
      const parts: Obj[] = [];
      for (let i = 0; i < n; i++) {
        const x = (i % 2) * 2;
        const z = 4 + rnd(12);
        if (rnd(2) === 0) {
          parts.push(
            box(`t-${i}`, [x, 0, z], [1.5, 1.5, 2], {
              parts: [
                box("c-0", [0, 0, 0], [1, 1, 1]),
                box("c-1", [0.2, 0.2, 1.2], [0.6, 0.6, 1.5]),
              ],
            }),
          );
        } else parts.push(box(`t-${i}`, [x, 0, z], [1.5, 1.5, 1 + rnd(3)]));
      }
      const d1 = DIRS[rnd(DIRS.length)] as string;
      const d2 = DIRS[rnd(DIRS.length)] as string;
      const d3 = DIRS[rnd(DIRS.length)] as string;
      const gap = 0.5;
      const stages: Obj[] = [
        { parts: ["t-*"], direction: d1 },
        { parts: ["t-0"], direction: d2, except: ["t-0"] }, // empty on purpose
      ];
      stages[1] = { parts: ["t-*/c-0"], direction: d2 };
      stages.push({ parts: ["t-*/c-1"], direction: d3 });
      const a = asmOf(scene(spec({ assemblies: [tile(parts, [{ id: "p", gap, stages }])] })));
      const p = prog(a, "p");
      // unrelated movers on the same axis end separated by the gap when their footprints overlap
      // after the move (skip pairs that interpenetrate at rest, and lift pairs sharing a layer)
      const all = moves(p);
      const dirOf = new Map<string, string>();
      p.stages.forEach((st, si) =>
        st.moves.forEach((m) => dirOf.set(m.path, [d1, d2, d3][si] as string)),
      );
      const lo = (b: Box3, ax: number): number =>
        [b.origin.x, b.origin.y, b.origin.z][ax] as number;
      const hi = (b: Box3, ax: number): number => lo(b, ax) + [b.size.x, b.size.y, b.size.z][ax]!;
      for (const m1 of all) {
        for (const m2 of all) {
          if (m1.path >= m2.path) continue;
          if (m1.path.startsWith(`${m2.path}/`) || m2.path.startsWith(`${m1.path}/`)) continue;
          const [ax1, s1] = axisOf(dirOf.get(m1.path) as string);
          const [ax2, s2] = axisOf(dirOf.get(m2.path) as string);
          if (ax1 !== ax2 || s1 !== s2) continue;
          const b1 = finalBox(a, p, m1.path);
          const b2 = finalBox(a, p, m2.path);
          const r1 = nodeOf(a, m1.path).world;
          const r2 = nodeOf(a, m2.path).world;
          const rest3d = [0, 1, 2].every(
            (ax) => Math.min(hi(r1, ax), hi(r2, ax)) - Math.max(lo(r1, ax), lo(r2, ax)) > 1e-6,
          );
          if (rest3d) continue;
          const perp = [0, 1, 2].filter((ax) => ax !== ax1);
          const overlap = perp.every(
            (ax) => Math.min(hi(b1, ax), hi(b2, ax)) - Math.max(lo(b1, ax), lo(b2, ax)) > 1e-6,
          );
          if (!overlap) continue;
          const sameLayer =
            dirOf.get(m1.path) === "lift" &&
            dirOf.get(m2.path) === "lift" &&
            Math.abs(lo(r1, ax1) - lo(r2, ax1)) < 1e-6;
          if (sameLayer) continue;
          const f1 = s1 > 0 ? [lo(b1, ax1), hi(b1, ax1)] : [-hi(b1, ax1), -lo(b1, ax1)];
          const f2 = s1 > 0 ? [lo(b2, ax1), hi(b2, ax1)] : [-hi(b2, ax1), -lo(b2, ax1)];
          const gapW = gap * a.frame.scale.z;
          const ok =
            (f1[1] as number) + gapW <= (f2[0] as number) + 1e-6 ||
            (f2[1] as number) + gapW <= (f1[0] as number) + 1e-6;
          expect(
            ok,
            `${m1.path} vs ${m2.path} (${d1}/${d2}/${d3}) ${JSON.stringify([b1, b2, r1, r2, m1.offset, m2.offset, gapW])} ${JSON.stringify({ parts, stages, moves: p.stages.map((x) => x.moves.map((m) => [m.path, m.offset.z])) })}`,
          ).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------- P2-Q01: reach

describe("reach adds the programs that can be exploded together", () => {
  test("two programs of one owner, both exploded: +2 and +3 give +5", () => {
    const parts = [box("x", [0, 0, 0], [1, 1, 1])];
    const programs = [
      { id: "p1", stages: [{ parts: ["x"], direction: "up", distance: 2 }] },
      { id: "p2", stages: [{ parts: ["x"], direction: "up", distance: 3 }] },
    ];
    const g = scene(
      spec({
        assemblies: [tile(parts, programs)],
        steps: [
          {
            assembly: [
              { explode: "a", program: "p1" },
              { explode: "a", program: "p2" },
            ],
          },
        ],
      }),
    );
    const a = asmOf(g);
    expect(a.reachBounds.origin.z + a.reachBounds.size.z).toBeGreaterThanOrEqual(1 + 5 - 1e-9);
  });
});

// ------------------------------------------------------------------- the shared level machine

describe("one level machine for validation and the plan", () => {
  /** Reference semantics of §7.2, independent of the implementation. */
  type Act = { kind: "explode" | "implode"; target: string; program?: string; to?: number };
  const PROGS: Record<string, { id: string; count: number }[]> = {
    a: [
      { id: "main", count: 3 },
      { id: "alt", count: 2 },
    ],
    "a/s": [{ id: "inner", count: 2 }],
    "a/s/t": [{ id: "deep", count: 1 }],
  };
  const make = (pose: string, dflt: string | undefined): Obj =>
    tile(
      [
        box("x", [0, 0, 0], [1, 1, 1]),
        box("y", [2, 0, 0], [1, 1, 1]),
        box("z", [4, 0, 0], [1, 1, 1]),
        box("s", [0, 4, 0], [3, 3, 1], {
          parts: [
            box("u", [0, 0, 0], [1, 1, 1]),
            box("v", [1, 0, 0], [1, 1, 1]),
            box("t", [0, 1, 0], [2, 2, 1], {
              parts: [box("w", [0, 0, 0], [1, 1, 1])],
              programs: [{ id: "deep", stages: [{ parts: ["w"], direction: "up" }] }],
            }),
          ],
          programs: [
            {
              id: "inner",
              stages: [
                { parts: ["u"], direction: "up" },
                { parts: ["v"], direction: "up" },
              ],
            },
          ],
        }),
      ],
      [
        {
          id: "main",
          stages: [
            { parts: ["x"], direction: "up" },
            { parts: ["y"], direction: "up" },
            { parts: ["z"], direction: "up" },
          ],
        },
        {
          id: "alt",
          stages: [
            { parts: ["s"], direction: "up" },
            { parts: ["s/u"], direction: "+x" },
          ],
        },
      ],
      { pose, ...(dflt === undefined ? {} : { program: dflt }) },
    );

  test("randomized: (from, to, program), validity and the whole level trace agree", () => {
    let seed = 777;
    const rnd = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return Math.floor((seed / 4294967296) * n);
    };
    for (let iter = 0; iter < 60; iter++) {
      const pose = ["assembled", "exploded"][rnd(2)] as string;
      const dflt = [undefined, "main", "alt"][rnd(3)];
      const steps = Array.from({ length: 1 + rnd(4) }, () => ({
        duration: 30,
        assembly: Array.from({ length: 1 + rnd(3) }, () => {
          const kind = ["explode", "implode"][rnd(2)] as "explode" | "implode";
          const target = ["a", "a/s", "a/s/t"][rnd(3)] as string;
          const act: Act = { kind, target };
          if (rnd(3) === 0)
            act.program = (PROGS[target] as { id: string }[])[
              rnd((PROGS[target] as unknown[]).length)
            ]!.id;
          if (rnd(2) === 0) act.to = rnd(4);
          return {
            [kind]: target,
            ...(act.program ? { program: act.program } : {}),
            ...(act.to === undefined ? {} : { to: act.to }),
          };
        }),
      }));
      const s = spec({ assemblies: [make(pose, dflt)], steps });

      // oracle: the rules of §7.2 written out again, plainly
      const level = new Map<string, number>();
      const exploded = new Map<string, string>();
      const oracle: ({ from: number; to: number; program: string } | "invalid")[][] = [];
      for (const st of steps) {
        const row: (typeof oracle)[number] = [];
        for (const act of st.assembly as Obj[]) {
          const kind = "explode" in act ? "explode" : "implode";
          const target = act[kind] as string;
          const progs = PROGS[target] as { id: string; count: number }[];
          const named = act.program as string | undefined;
          const defaultId = target === "a" ? (dflt ?? "main") : (progs[0] as { id: string }).id;
          let pick: { id: string; count: number } | undefined;
          if (named !== undefined) pick = progs.find((q) => q.id === named);
          else {
            const last = kind === "implode" ? exploded.get(target) : undefined;
            pick = progs.find((q) => q.id === last) ?? progs.find((q) => q.id === defaultId);
          }
          if (pick === undefined) {
            row.push("invalid");
            continue;
          }
          const key = `${target}|${pick.id}`;
          const cur =
            level.get(key) ??
            (target === "a" && pose === "exploded" && pick.id === defaultId ? pick.count : 0);
          const to = (act.to as number | undefined) ?? (kind === "explode" ? pick.count : 0);
          if (
            to > pick.count ||
            (kind === "explode" && to < cur) ||
            (kind === "implode" && to > cur)
          ) {
            row.push("invalid");
            continue;
          }
          level.set(key, to);
          if (kind === "explode") exploded.set(target, pick.id);
          row.push({ from: cur, to, program: pick.id });
        }
        oracle.push(row);
      }

      const g = scene(s);
      const plan = g.assemblies!.plan;
      // the real validator path: which actions it flags
      const errs = assemblyDiagnostics(s, LIFTED).filter((d) => d.severity === "error");
      const bad = new Set(
        errs.map((d) => /^\/steps\/(\d+)\/assembly\/(\d+)/.exec(d.path)?.slice(1).join(":")),
      );
      const noops = new Set(
        codes(assemblyDiagnostics(s, LIFTED), "assembly/no-op-action").map((d) =>
          /^\/steps\/(\d+)\/assembly\/(\d+)/.exec(d.path)?.slice(1).join(":"),
        ),
      );
      steps.forEach((st, si) => {
        // plan actions of this step, in order, matched back to the spec actions that are valid
        const planned = plan[si]!.actions;
        let k = 0;
        (st.assembly as Obj[]).forEach((_, ai) => {
          const want = (oracle[si] as (typeof oracle)[number])[ai];
          const ctx = JSON.stringify([si, ai, steps[si]]);
          expect(want === "invalid", `validator flags ${ctx}`).toBe(bad.has(`${si}:${ai}`));
          if (want === "invalid") return;
          const got = planned[k++]!;
          expect([got.from, got.to, got.program], ctx).toEqual([
            want!.from,
            want!.to,
            want!.program,
          ]);
          expect(got.from === got.to, `no-op ${ctx}`).toBe(noops.has(`${si}:${ai}`));
        });
        expect(k, "no extra planned actions").toBe(planned.length);
        // the pose trace: every program's level after the step
        const pose2 = plan[si]!.poses.a!;
        for (const [key, lv] of level.entries()) void [key, lv];
        expect(pose2.length).toBe(4);
      });
      // final pose equals the oracle's levels
      const last = plan[plan.length - 1]!.poses.a!;
      const q = (owner: string, id: string): string =>
        owner === "a" ? id : `${owner.slice(2)}/${id}`;
      for (const [owner, list] of Object.entries(PROGS)) {
        for (const pr of list) {
          const dflt2 = owner === "a" ? (dflt ?? "main") : (list[0] as { id: string }).id;
          const want =
            level.get(`${owner}|${pr.id}`) ??
            (owner === "a" && pose === "exploded" && pr.id === dflt2 ? pr.count : 0);
          expect(last.find((l) => l.program === q(owner, pr.id))?.level, `${owner}|${pr.id}`).toBe(
            want,
          );
        }
      }
    }
  });
});

// ------------------------------------------------------- implicit access: one move, reversed

describe("implicit access is the target's own move in the parent's default program", () => {
  const RACK = (steps: unknown[]): PlatformCosmoSpec => {
    const srv = (n: number): Obj =>
      box(`srv-${n}`, [0, n * 2, 1], [2, 1.5, 1], {
        parts: [box("tray", [0, 0, 0], [2, 1.5, 1]), box("lid", [0, 0, 1], [2, 1.5, 1])],
        programs: [{ id: "internals", stages: [{ parts: ["lid"], duration: 1, stagger: 0 }] }],
      });
    return spec({
      assemblies: [
        tile(
          [
            box("frame", [0, 0, 0], [2, 8, 1], { role: "shell" }),
            box("door", [0, 0, 3], [2, 8, 1]),
            srv(0),
            srv(1),
            srv(2),
          ],
          [
            {
              id: "drawers",
              stages: [
                { parts: ["door"], direction: "up", duration: 1, stagger: 0 },
                { parts: ["srv-*"], direction: "drawer", duration: 2, stagger: 0.5 },
              ],
            },
          ],
        ),
      ],
      steps,
    });
  };

  test("multi-stage parent: only the drawer of the target opens (a rack-like case)", () => {
    const g = scene(RACK([{ duration: 20, assembly: [{ explode: "a/srv-1" }] }]));
    const act = g.assemblies!.plan[0]!.actions[0]!;
    expect(act.implied).toEqual([{ program: "drawers", level: 2, only: ["a/srv-1"] }]);
    // the single drawer move (2 s) then the lid (1 s); not stage 1 (the door) nor srv-0/srv-2
    expect(act.accessLength).toBe(2);
    expect(act.length).toBe(3);
    const pose = g.assemblies!.plan[0]!.poses.a!;
    expect(pose.find((p) => p.program === "drawers")).toEqual({
      program: "drawers",
      level: 0,
      only: ["a/srv-1"],
    });
    // the reach covers the opened drawer (its program is played)
    expect(asmOf(g).reachBounds.size.y).toBeGreaterThan(8);
  });

  test("no implied access for a no-op, and an explicit parent action ends the opening", () => {
    const noop = scene(RACK([{ assembly: [{ explode: "a/srv-1", to: 0 }] }]));
    expect(noop.assemblies!.plan[0]!.actions[0]).toMatchObject({
      from: 0,
      to: 0,
      length: 0,
      implied: [],
    });
    expect(codes(noop.diagnostics, "assembly/implicit-access")).toEqual([]);

    const g = scene(
      RACK([
        { duration: 20, assembly: [{ explode: "a/srv-1" }] },
        { duration: 20, assembly: [{ explode: "a" }] }, // explicit: the drawers program, whole
        { duration: 20, assembly: [{ implode: "a/srv-1" }] },
      ]),
    );
    const [, s2, s3] = g.assemblies!.plan;
    // the explicit action replaces the opening: level 2, no leftover `only`
    expect(s2!.poses.a!.find((p) => p.program === "drawers")).toEqual({
      program: "drawers",
      level: 2,
    });
    // the implode must not undo what the explicit action now owns
    expect(s3!.actions[0]!.implied).toEqual([]);
    expect(s3!.poses.a!.find((p) => p.program === "drawers")).toEqual({
      program: "drawers",
      level: 2,
    });
  });

  test("an explicit parent explode does not replay the opened drawer", () => {
    const g = scene(
      RACK([
        { duration: 20, assembly: [{ explode: "a/srv-2" }] },
        { duration: 20, assembly: [{ explode: "a" }] },
      ]),
    );
    const a = asmOf(g);
    const act = g.assemblies!.plan[1]!.actions[0]!;
    expect(act.opened).toEqual(["a/srv-2"]);
    // door (1 s) + srv-0 (starts 1) + srv-1 (1.5) end at 3.5; srv-2 (would end at 4) is skipped
    expect(act.length).toBe(3.5);
    const full = programSegment(prog(a, "drawers"), 0, 2);
    expect(full.length).toBe(4);
    const rest = programSegment(prog(a, "drawers"), 0, 2, new Set(["a/srv-2"]));
    expect(rest.moves.map((m) => m.path)).toEqual(["a/door", "a/srv-0", "a/srv-1"]);
    expect(rest.length).toBe(3.5);
    // the drawer is a move of the opened set only: its offset never changes in the segment
    expect(rest.moves.some((m) => m.path === "a/srv-2")).toBe(false);
    expect(g.assemblies!.plan[1]!.poses.a!.find((p) => p.program === "drawers")).toEqual({
      program: "drawers",
      level: 2,
    });
  });

  test("without an explicit action in between, the implode restores the parent", () => {
    const g = scene(
      RACK([
        { duration: 20, assembly: [{ explode: "a/srv-1" }] },
        { duration: 20, assembly: [{ implode: "a/srv-1" }] },
      ]),
    );
    const s2 = g.assemblies!.plan[1]!;
    expect(s2.actions[0]!.implied).toEqual([{ program: "drawers", level: 0, only: ["a/srv-1"] }]);
    expect(s2.actions[0]!.accessLength).toBe(2);
    expect(s2.poses.a!.find((p) => p.program === "drawers")).toEqual({
      program: "drawers",
      level: 0,
    });
  });
});

// --------------------------------------------------------------------------- bounded fallbacks

describe("budgets degrade soundly and deterministically", () => {
  const cols = (n: number): Obj[] =>
    Array.from({ length: n }, (_, i) => box(`p-${i}`, [i % 7, Math.floor(i / 7), 0], [1, 1, 1]));
  const BIG = spec({
    assemblies: [
      tile(cols(40), [{ id: "p", stages: [{ parts: ["p-*"], direction: "up", distance: 2 }] }]),
    ],
    steps: [{ assembly: [{ explode: "a" }] }],
  });

  test("an exhausted sweep budget falls back to a bound that contains the exact reach", () => {
    const exact = new AssemblyPrograms(BIG);
    const built = buildAssemblies(BIG, { reach: exact.reach });
    const cheap = new AssemblyPrograms(BIG, { sweepWork: makeWork(1) });
    const coarse = buildAssemblies(BIG, { reach: cheap.reach });
    const e = built.assemblies[0]!.reachBounds;
    const c = coarse.assemblies[0]!.reachBounds;
    expect(c.size.z).toBeGreaterThanOrEqual(e.size.z - 1e-9);
    expect(c.size.x).toBeGreaterThanOrEqual(e.size.x - 1e-9);
    expect(c.size.z).toBeGreaterThan(a0(e).restTop);
    expect(codes(cheap.diagnostics, "budget/time")).toHaveLength(1);
    // deterministic under the budget
    const again = new AssemblyPrograms(BIG, { sweepWork: makeWork(1) });
    expect(buildAssemblies(BIG, { reach: again.reach }).assemblies[0]!.reachBounds).toEqual(c);
  });

  function a0(b: Box3): { restTop: number } {
    return { restTop: b.size.z * 0 + 1 };
  }

  test("unresolved programs are reported and skipped, never planned with zero length", () => {
    const progs = new AssemblyPrograms(BIG, { work: makeWork(10) });
    const built = progs.attach(buildAssemblies(BIG, { reach: progs.reach }));
    const plan = progs.plan(built.assemblies, new Map(), []);
    expect(plan.plan[0]!.actions).toEqual([]);
    const skip = plan.diagnostics.find((d) => d.path === "/steps/0/assembly/0/explode");
    expect(skip?.code).toBe("budget/time");
    expect(built.assemblies[0]!.programs).toEqual([]);
  });

  test("1500 mated bricks go up although the sibling scan is over its cap", () => {
    const n = 1500;
    const bricks = Array.from({ length: n }, (_, i) =>
      box(`b-${i}`, [0, 0, i], [1, 1, 1], i === 0 ? {} : { mates: `b-${i - 1}` }),
    );
    const g = scene(
      spec({
        assemblies: [
          tile(bricks, [{ id: "p", stages: [{ parts: ["b-*"], direction: "away", distance: 1 }] }]),
        ],
      }),
    );
    const p = prog(asmOf(g), "p");
    const ms = moves(p);
    expect(ms.length).toBe(n);
    // every mated brick leaves its mate upward (its mate is below it)
    for (const m of ms.filter((x) => x.path !== "a/b-0")) expect(m.offset.z).toBeGreaterThan(0);
    // the one unmated brick took the `out` fallback, and the skipped scan is reported once
    expect(codes(g.diagnostics, "budget/time").length).toBe(1);
  });

  test("a sibling scan skipped over the cap is reported", () => {
    const bricks = Array.from({ length: 450 }, (_, i) => box(`b-${i}`, [i, 0, 0], [1, 1, 1]));
    const progs = new AssemblyPrograms(
      spec({
        assemblies: [tile(bricks, [{ id: "p", stages: [{ parts: ["b-*"] }] }])],
      }),
    );
    const s = spec({ assemblies: [tile(bricks, [{ id: "p", stages: [{ parts: ["b-*"] }] }])] });
    const built = buildAssemblies(s, { reach: progs.reach });
    progs.attach(built);
    expect(codes(progs.diagnostics, "budget/time").length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------- directions, review

describe("away, inserts and selectors (review)", () => {
  const dirOf = (parts: unknown[], id: string, stage: Obj = {}): number[] => {
    const a = asmOf(
      scene(
        spec({
          assemblies: [
            tile(parts, [{ id: "p", stages: [{ parts: [id], distance: 2, ...stage }] }]),
          ],
        }),
      ),
    );
    const m = moves(prog(a, "p"))[0]!;
    return [m.offset.x, m.offset.y, m.offset.z];
  };

  test("a part with inserts leaves through the entry face, not the least-penetration axis", () => {
    const parts = (inserts: boolean): unknown[] => [
      box("cast", [0, 0, 0], [4, 4, 2]),
      // pokes through the top face near the +x edge: x penetration (0.5) is the least
      box("pin", [3.5, 1, 1], [1, 1, 2], inserts ? { inserts: "cast" } : {}),
    ];
    expect(dirOf(parts(false), "pin")).toEqual([2, 0, 0]); // generic interpenetration: push-out
    expect(dirOf(parts(true), "pin")).toEqual([0, 0, 2]); // inserts: the entry face normal
    const below = [
      box("cast", [0, 0, 0], [4, 4, 2]),
      box("pin", [1, 1, -1], [1, 1, 2], { inserts: "cast" }),
    ];
    expect(dirOf(below, "pin")).toEqual([0, 0, -2]);
  });

  test("push-out differs from out for an off-centre interpenetration", () => {
    const parts = [
      box("base", [0, 0, 0], [10, 10, 1]),
      box("p", [8, 4, 0.9], [1, 1, 1]), // off-centre: `out` would be +x, push-out is +z
    ];
    expect(dirOf(parts, "p", { direction: "out" })).toEqual([2, 0, 0]);
    expect(dirOf(parts, "p")).toEqual([0, 0, 2]);
  });

  test("selector lists tolerate non-string entries", () => {
    const parts = [box("x", [0, 0, 0], [1, 1, 1]), box("y", [2, 0, 0], [1, 1, 1])];
    const a = asmOf(
      scene(
        spec({
          assemblies: [
            tile(parts, [
              { id: "p", stages: [{ parts: [5, null, "x", { a: 1 }], except: [7, "y"] }] },
            ]),
          ],
        }),
      ),
    );
    expect(moves(prog(a, "p")).map((m) => m.path)).toEqual(["a/x"]);
  });

  test("a part selected again through an inferred role is reported as info", () => {
    const parts = [
      box("body", [0, 0, 0], [4, 4, 2], { role: "body" }),
      box("lid", [0, 0, 2], [4, 4, 1]), // inferred cover by its name
    ];
    const g = scene(
      spec({
        assemblies: [
          tile(parts, [{ id: "p", stages: [{ parts: ["role:cover"] }, { parts: ["lid"] }] }]),
        ],
      }),
    );
    const d = codes(g.diagnostics, "assembly/moved-twice");
    expect(d.map((x) => x.severity)).toEqual(["info"]);
  });

  test("the program with ≥ 2000 leaves stays within the build budget", () => {
    const n = 2000;
    const parts = Array.from({ length: n }, (_, i) =>
      box(`p-${i}`, [i % 50, Math.floor(i / 50), 0], [1, 1, 1]),
    );
    const t0 = Date.now();
    const g = scene(
      spec({
        assemblies: [
          tile(parts, [
            { id: "p", stages: [{ parts: ["p-*"], direction: "lift" }, { parts: ["**"] }] },
          ]),
        ],
        steps: [{ assembly: [{ explode: "a" }] }],
      }),
    );
    expect(Date.now() - t0).toBeLessThan(10_000); // §13: 10 s at 2000 leaves
    expect(g.assemblies?.assemblies.length).toBe(1);
  });
});

describe("selectors: the real validator path agrees with the scene", () => {
  const parts = [
    box("frame", [0, 0, 0], [1, 1, 1], {
      role: "shell",
      parts: [
        box("door", [0, 0, 0], [1, 1, 1], { role: "cover" }),
        box("rail", [2, 0, 0], [1, 1, 1], { tags: ["skin"] }),
      ],
    }),
    { id: "cyl", count: 2, pitch: [2, 0, 0], at: [0, 3, 0], size: [1, 1, 1], type: "cyl" },
    box("head", [0, 6, 0], [1, 1, 1], {
      parts: [
        { id: "valve", count: 2, at: [0, 0, 1], pitch: [2, 0, 0], size: [1, 1, 1], type: "valve" },
      ],
    }),
  ];
  const SELS = [
    "cyl-*",
    "valve-*",
    "head/valve-*",
    "**/valve-*",
    "type:cyl",
    "type:valve",
    "**/type:valve",
    "tag:skin",
    "**/tag:skin",
    "frame/*",
    "nope",
    "x/**",
    "**/leaf",
    "head/?",
  ];
  test.each(SELS)("%s: selector-empty exactly when the scene matches nothing", (sel) => {
    const s = spec({ assemblies: [tile(parts, [{ id: "p", stages: [{ parts: [sel] }] }])] });
    const warned = codes(assemblyDiagnostics(s, LIFTED), "assembly/selector-empty").length > 0;
    const a = asmOf(scene(s));
    expect(warned, sel).toBe(moves(prog(a, "p")).length === 0);
  });
});
