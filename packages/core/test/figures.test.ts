import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Diagnostic } from "../src/index.js";
import { buildScene, validate } from "../src/index.js";
import { transitionSeconds } from "../src/anim/timeline.js";
import {
  BEZIER,
  FIGURE_PROGRAM,
  buildFigureScene,
  figureSegment,
  matchFigureSelector,
  mirrorBezier,
  fitDuration,
  planFigureSteps,
  resolveFigure,
  stepViews,
  stepWindows,
  transitionOf,
} from "../src/scene/boards.js";
import type { ResolvedFigure } from "../src/scene/boards.js";
import { figureDiagnostics } from "../src/schema/assembly-semantic.js";
import type { GuardGroup } from "../src/schema/unsupported.js";
import type { PlatformCosmoSpec, SpecFigure } from "../src/schema/types.gen.js";

// A2-F: figures in validate and scene (docs/design/assemblies.md §7, §11.6, §15).

const IMAGES = [
  { id: "base", src: "a.png" },
  { id: "spr", src: "b.png" },
];
const PARTS = [
  { id: "p1", image: "spr", seat: [0, 100] },
  { id: "p2", image: "spr", seat: [50, 300] },
  { id: "p3", image: "spr", seat: [90, 200] },
];
const mk = (
  fig: Record<string, unknown> = {},
  steps?: unknown[],
  extra: Record<string, unknown> = {},
): PlatformCosmoSpec =>
  ({
    meta: { version: "1" },
    images: IMAGES,
    figures: [{ id: "f", base: "base", parts: PARTS, ...fig }],
    ...(steps ? { steps } : {}),
    ...extra,
  }) as unknown as PlatformCosmoSpec;

/** Two stages: p1+p2 staggered after a delay, then p3 (see the timing tables below). */
const TWO_STAGES = [
  { parts: ["p1", "p2"], stagger: 0.5, duration: 1, delay: 0.25 },
  { parts: ["p3"], delay: 0.5, duration: 0.6, easing: "ease" },
];

const diags = (spec: PlatformCosmoSpec, groups?: Partial<Record<GuardGroup, boolean>>) =>
  figureDiagnostics(spec, {
    phase1a: true,
    phase1b: true,
    phase2: true,
    phase3: true,
    ...groups,
  });
const codes = (d: readonly Diagnostic[]) => d.map((x) => `${x.code}@${x.path}`);
const only = (d: readonly Diagnostic[], code: string) => d.filter((x) => x.code === code);
const fig = (spec: PlatformCosmoSpec): ResolvedFigure =>
  resolveFigure((spec.figures as SpecFigure[])[0] as SpecFigure, 0).figure;

describe("image ids and figure references", () => {
  test("unknown base and sprite images: path and did-you-mean", () => {
    const spec = mk({
      base: "bse",
      parts: [{ id: "p1", image: "sprite", seat: [0, 0] }],
    });
    const d = only(diags(spec), "image/unknown");
    expect(d.map((x) => [x.path, x.suggestion])).toEqual([
      ["/figures/0/base", 'Did you mean "base"?'],
      ["/figures/0/parts/0/image", 'Did you mean "spr"?'],
    ]);
    expect(d.every((x) => x.severity === "error")).toBe(true);
  });

  test("with no images declared the suggestion says where to declare them", () => {
    const spec = { ...mk(), images: undefined } as unknown as PlatformCosmoSpec;
    const d = only(diags(spec), "image/unknown");
    expect(d.length).toBe(4);
    expect(d[0]?.suggestion).toMatch(/Declare it in "images"/);
  });

  test("duplicate image ids", () => {
    const spec = mk({}, undefined, { images: [...IMAGES, { id: "spr", src: "c.png" }] });
    expect(codes(diags(spec))).toEqual(["semantic/duplicate-id@/images/2/id"]);
  });

  test("duplicate part ids in a figure", () => {
    const spec = mk({ parts: [...PARTS, { id: "p1", image: "spr", seat: [1, 1] }] });
    const d = only(diags(spec), "assembly/duplicate-part");
    expect(d.map((x) => x.path)).toEqual(["/figures/0/parts/3/id"]);
    expect(d[0]?.suggestion).toBe("Rename one part");
  });

  test("figure ids share the id namespace with nodes", () => {
    const spec = mk({}, undefined, { nodes: [{ id: "f", type: "server" }] });
    const d = only(validate(spec).diagnostics, "semantic/duplicate-id");
    expect(d.map((x) => x.path)).toEqual(["/figures/0/id"]);
  });

  test("a valid figure has no figure diagnostics", () => {
    expect(diags(mk({ stages: TWO_STAGES }))).toEqual([]);
    expect(diags({ meta: { version: "1" }, nodes: [{ id: "a", type: "server" }] })).toEqual([]);
  });
});

describe("stages and selectors", () => {
  test("selector matching: globs, tag:, type:, any-depth scope, role", () => {
    const parts = [
      { id: "hs-1", tags: ["clip", "metal"], type: "heatsink" },
      { id: "hs-2", tags: ["clip"], type: "heatsink" },
      { id: "fan-1", tags: [], type: "fan" },
    ];
    const m = (s: string) => matchFigureSelector(s, parts);
    expect(m("hs-*")).toEqual(["hs-1", "hs-2"]);
    expect(m("*-1")).toEqual(["hs-1", "fan-1"]);
    expect(m("hs-?")).toEqual(["hs-1", "hs-2"]);
    expect(m("tag:metal")).toEqual(["hs-1"]);
    expect(m("tag:c*")).toEqual(["hs-1", "hs-2"]);
    expect(m("type:fan")).toEqual(["fan-1"]);
    expect(m("**")).toEqual(["hs-1", "hs-2", "fan-1"]);
    expect(m("**/type:fan")).toEqual(["fan-1"]);
    expect(m("hs-1.x")).toEqual([]);
    expect(m("role:cover")).toEqual([]);
    expect(m("a/hs-*")).toEqual([]);
  });

  test("empty selector: warning with did-you-mean (id, tag, type)", () => {
    const spec = mk({
      parts: [
        { id: "p1", image: "spr", seat: [0, 0], tags: ["retention"], type: "sink" },
        { id: "p2", image: "spr", seat: [0, 0] },
      ],
      stages: [{ parts: ["p-1", "tag:retentoin", "type:snk", "zzzzzz"] }, { parts: ["p2"] }],
    });
    const d = only(diags(spec), "assembly/selector-empty");
    expect(d.map((x) => [x.path, x.suggestion])).toEqual([
      ["/figures/0/stages/0/parts/0", 'Did you mean "p1"?'],
      ["/figures/0/stages/0/parts/1", 'Did you mean "tag:retention"?'],
      ["/figures/0/stages/0/parts/2", 'Did you mean "type:sink"?'],
      ["/figures/0/stages/0/parts/3", "Parts: p1, p2"],
    ]);
    expect(d.every((x) => x.severity === "warning")).toBe(true);
  });

  test("a scoped selector says why it matches nothing", () => {
    const d = only(
      diags(mk({ stages: [{ parts: ["head/p1"] }, { parts: ["p*"] }] })),
      "assembly/selector-empty",
    );
    expect(d.map((x) => x.path)).toEqual(["/figures/0/stages/0/parts/0"]);
    expect(d[0]?.message).toMatch(/flat list/);
  });

  test("a part moved by two stages is an error at the later selector", () => {
    const d = diags(mk({ stages: [{ parts: ["p1", "p2"] }, { parts: ["p*"] }] }));
    expect(codes(d)).toEqual([
      "assembly/moved-twice@/figures/0/stages/1/parts/0",
      "assembly/moved-twice@/figures/0/stages/1/parts/0",
    ]);
    expect(d.map((x) => x.message)).toEqual([
      'Part "p1" is moved by stage 1 and again by stage 2',
      'Part "p2" is moved by stage 1 and again by stage 2',
    ]);
    expect(d[0]?.suggestion).toMatch(/single stage/);
  });

  test("overlapping selectors inside one stage are a union, not an error", () => {
    expect(diags(mk({ stages: [{ parts: ["p1", "p*", "tag:x"] }] })).map((x) => x.code)).toEqual([
      "assembly/selector-empty",
    ]);
  });

  test("parts no stage moves get a warning (not with the default stage)", () => {
    expect(codes(diags(mk({ stages: [{ parts: ["p1", "p2"] }] })))).toEqual([
      "assembly/part-not-staged@/figures/0/parts/2",
    ]);
    expect(diags(mk())).toEqual([]);
  });

  test("the default stage moves every part in spec order", () => {
    const f = fig(mk());
    expect(f.stages).toHaveLength(1);
    expect(f.stages[0]?.moves.map((m) => m.part)).toEqual(["p1", "p2", "p3"]);
    expect(f.stages[0]?.moves.map((m) => m.start)).toEqual([0, 0.08, 0.16]);
    expect(f.stages[0]?.end).toBe(0.96);
  });
});

describe("timing tables", () => {
  test("stage times: S_s = E_{s-1} + delay, rank start = S + r*stagger", () => {
    const f = fig(mk({ stages: TWO_STAGES }));
    expect(f.stages.map((s) => [s.index, s.start, s.end])).toEqual([
      [1, 0.25, 1.75],
      [2, 2.25, 2.85],
    ]);
    expect(
      f.stages.flatMap((s) => s.moves.map((m) => [m.part, m.start, m.duration, m.easing])),
    ).toEqual([
      ["p1", 0.25, 1, "ease-in-out"],
      ["p2", 0.75, 1, "ease-in-out"],
      ["p3", 2.25, 0.6, "ease"],
    ]);
    expect(f.parts.map((p) => p.stage)).toEqual([1, 1, 2]);
  });

  test("stagger order: spec, top-down and bottom-up by seat y", () => {
    const order = (o: string) =>
      fig(
        mk({ stages: [{ parts: ["**"], order: o, stagger: 1, duration: 1 }] }),
      ).stages[0]?.moves.map((m) => m.part);
    expect(order("spec")).toEqual(["p1", "p2", "p3"]);
    expect(order("top-down")).toEqual(["p1", "p3", "p2"]); // seat y 100, 200, 300
    expect(order("bottom-up")).toEqual(["p2", "p3", "p1"]);
  });

  test("a stage that moves nothing still takes its delay", () => {
    const f = fig(
      mk({
        stages: [
          { parts: ["nope"], delay: 2 },
          { parts: ["p*"], delay: 1 },
        ],
      }),
    );
    expect(f.stages.map((s) => [s.start, s.end])).toEqual([
      [2, 2],
      [3, 3.96],
    ]);
  });

  test("explode segments shift the first stage to 0", () => {
    const f = fig(mk({ stages: TWO_STAGES }));
    const full = figureSegment(f, 0, 2);
    expect([full.kind, full.length]).toEqual(["explode", 2.6]);
    expect(full.moves.map((m) => [m.part, m.start])).toEqual([
      ["p1", 0],
      ["p2", 0.5],
      ["p3", 2],
    ]);
    expect(figureSegment(f, 0, 1).length).toBe(1.5);
    const second = figureSegment(f, 1, 2);
    expect([second.length, second.moves.map((m) => [m.part, m.start])]).toEqual([0.6, [["p3", 0]]]);
  });

  test("implode is the exact time reverse with mirrored easing", () => {
    const f = fig(mk({ stages: TWO_STAGES }));
    const fwd = figureSegment(f, 0, 2);
    const back = figureSegment(f, 2, 0);
    expect([back.kind, back.length, back.from, back.to]).toEqual(["implode", 2.6, 2, 0]);
    expect(back.moves.map((m) => [m.part, m.start, m.duration])).toEqual([
      ["p3", 0, 0.6],
      ["p2", 1.1, 1],
      ["p1", 1.6, 1],
    ]);
    // [st, en] -> [L - en, L - st] for every move
    for (const m of fwd.moves) {
      const r = back.moves.find((x) => x.part === m.part)!;
      expect(r.start).toBeCloseTo(fwd.length - (m.start + m.duration), 10);
      expect(r.reversed).toBe(true);
    }
    const ease = back.moves.find((m) => m.part === "p3")!;
    expect(ease.easing).toBe("ease");
    expect(ease.bezier).toEqual([0.75, 0, 0.75, 0.9]);
    // ease-in-out is its own mirror; ease-in and ease-out swap keywords with the curves
    expect(back.moves.find((m) => m.part === "p1")).toMatchObject({
      easing: "ease-in-out",
      bezier: [0.42, 0, 0.58, 1],
    });
    const swapped = fig(
      mk({
        stages: [
          { parts: ["p1"], easing: "ease-in" },
          { parts: ["p2"], easing: "ease-out" },
          { parts: ["p3"], easing: "linear" },
        ],
      }),
    );
    const rev = figureSegment(swapped, 3, 0).moves;
    expect(rev.map((m) => [m.part, m.easing, m.bezier])).toEqual([
      ["p3", "linear", [0, 0, 1, 1]],
      ["p2", "ease-in", [0.42, 0, 1, 1]],
      ["p1", "ease-out", [0, 0, 0.58, 1]],
    ]);
    // each reversed keyword's curve is the keyword table's curve
    for (const m of rev) expect(m.bezier).toEqual(BEZIER[m.easing]);
    // partial implode: the reverse of stage 2 only
    const part = figureSegment(f, 2, 1);
    expect([part.length, part.moves.map((m) => m.part)]).toEqual([0.6, ["p3"]]);
  });

  test("mirrored easings", () => {
    expect(mirrorBezier(BEZIER.linear)).toEqual([0, 0, 1, 1]);
    expect(mirrorBezier(BEZIER["ease-in"])).toEqual(BEZIER["ease-out"]);
    expect(mirrorBezier(BEZIER["ease-out"])).toEqual(BEZIER["ease-in"]);
    expect(mirrorBezier(BEZIER["ease-in-out"])).toEqual(BEZIER["ease-in-out"]);
    expect(mirrorBezier(mirrorBezier(BEZIER.ease))).toEqual(BEZIER.ease);
  });

  test("step windows: lead, closing transition, hold", () => {
    expect(
      stepWindows([3, 4, 2], [undefined, "x", "x"]).map((w) => [w.lead, w.tr, w.window]),
    ).toEqual([
      [0, 0.75, 2.05],
      [0, 0, 3.8],
      [0, 0.5, 1.3],
    ]);
    expect(stepWindows([4], ["x"]).map((w) => [w.lead, w.tr, w.window])).toEqual([[0.8, 0.8, 2.2]]);
    expect(stepWindows([3], [undefined]).map((w) => [w.lead, w.tr, w.window])).toEqual([
      [0, 0, 2.8],
    ]);
    expect(stepWindows([0.1], [undefined])[0]?.window).toBe(0.05); // floored
  });

  test("the local transition formula equals the camera's", () => {
    for (const d of [0.1, 1, 3, 3.2, 10, 600]) expect(transitionOf(d)).toBe(transitionSeconds(d));
  });
});

describe("actions: levels, plan and compression", () => {
  const plan = (spec: PlatformCosmoSpec, views?: (string | undefined)[]) => {
    const figs = new Map([["f", fig(spec)]]);
    return planFigureSteps(spec, figs, views ?? (spec.steps ?? []).map((s) => s.focus));
  };

  test("levels are cumulative; default targets; base pose sets the start level", () => {
    const spec = mk({ stages: TWO_STAGES }, [
      { duration: 10, assembly: [{ explode: "f", to: 1 }] },
      { duration: 10, assembly: [{ explode: "f" }] },
      { duration: 10, assembly: [{ implode: "f", to: 1 }] },
      { duration: 10, assembly: [{ implode: "f" }] },
    ]);
    const { plan: p, diagnostics } = plan(spec);
    expect(diagnostics).toEqual([]);
    expect(p.map((s) => s.actions.map((a) => [a.kind, a.from, a.to, a.length]))).toEqual([
      [["explode", 0, 1, 1.5]],
      [["explode", 1, 2, 0.6]],
      [["implode", 2, 1, 0.6]],
      [["implode", 1, 0, 1.5]],
    ]);
    expect(p.map((s) => s.poses.f)).toEqual([
      [{ program: FIGURE_PROGRAM, level: 1 }],
      [{ program: FIGURE_PROGRAM, level: 2 }],
      [{ program: FIGURE_PROGRAM, level: 1 }],
      [{ program: FIGURE_PROGRAM, level: 0 }],
    ]);
    expect(p.map((s) => s.step)).toEqual([1, 2, 3, 4]);

    const exploded = mk({ stages: TWO_STAGES, pose: "exploded" }, [
      { duration: 10 },
      { duration: 10, assembly: [{ implode: "f" }] },
    ]);
    const q = plan(exploded).plan;
    expect(q[0]?.poses.f).toEqual([{ program: FIGURE_PROGRAM, level: 2 }]);
    expect(q[1]?.actions[0]).toMatchObject({ kind: "implode", from: 2, to: 0, length: 2.6 });
  });

  test("actions play in array order; start places one", () => {
    const spec = mk({ stages: TWO_STAGES }, [
      {
        duration: 20,
        assembly: [{ explode: "f", to: 1 }, { explode: "f" }, { implode: "f", start: 10 }],
      },
    ]);
    const a = plan(spec).plan[0]!.actions;
    expect(a.map((x) => [x.start, x.length, x.scale])).toEqual([
      [0, 1.5, 1],
      [1.5, 0.6, 1],
      [10, 2.6, 1],
    ]);
  });

  test("compression: info at or above 50%, warning below, with the fitting duration", () => {
    const steps = (d: number) => [{ duration: d, assembly: [{ explode: "f" }] }];
    const info = plan(mk({ stages: TWO_STAGES }, steps(2)));
    expect(info.diagnostics).toHaveLength(1);
    expect(info.diagnostics[0]).toMatchObject({
      severity: "info",
      code: "assembly/compressed",
      path: "/steps/0/assembly",
      suggestion: 'Set "duration": 4 on this step',
    });
    // the step ends exploded (away from the base pose), so it reserves a closing window even
    // without a camera move (7.3): tr = 0.5, window = 2 - 0.5 - 0.2 = 1.3; scale = 1.3 / 2.6
    const a = info.plan[0]!.actions[0]!;
    expect(a.scale).toBe(0.5);
    expect(a.length).toBe(1.3); // never overruns the window
    expect(a.start).toBe(0);

    const warn = plan(mk({ stages: TWO_STAGES }, steps(1)));
    expect(warn.diagnostics[0]).toMatchObject({ severity: "warning", code: "assembly/compressed" });
    expect(warn.plan[0]!.actions[0]!.scale).toBe(0.2115);

    const exact = plan(mk({ stages: TWO_STAGES }, steps(4))); // 4 - 0.8 - 0.2 = 3.0 >= 2.6
    expect(exact.diagnostics).toEqual([]);
    expect(exact.plan[0]!.actions[0]!.scale).toBe(1);
  });

  test("compression counts the camera: lead and closing transition", () => {
    // 4 s step zoomed on f: lead 0.8, tr 0.8, hold 0.2 -> window 2.2; need 2.6
    const spec = mk({ stages: TWO_STAGES }, [
      { duration: 4, focus: "f", assembly: [{ explode: "f" }] },
    ]);
    const { diagnostics, plan: p } = plan(spec);
    expect(diagnostics[0]?.suggestion).toBe('Set "duration": 5 on this step'); // 2.6+.8+.8+.2=4.4
    expect(p[0]!.actions[0]!.scale).toBe(0.8461);
  });

  test("compression applies to every action of the step, starts included", () => {
    const spec = mk({ stages: TWO_STAGES }, [
      { duration: 2, assembly: [{ explode: "f", to: 1 }, { explode: "f" }] },
    ]);
    const a = plan(spec).plan[0]!.actions;
    // natural: [0, 1.5], [1.5, 0.6]: need 2.1 > 1.3 (closing window reserved) -> scale 0.6190
    expect(a.map((x) => [x.start, x.length])).toEqual([
      [0, 0.9285],
      [0.9285, 0.3714],
    ]);
  });

  test("no-op actions are kept with zero length (info)", () => {
    const spec = mk({ stages: TWO_STAGES }, [
      { assembly: [{ implode: "f" }, { explode: "f", to: 0 }] },
    ]);
    const { plan: p, diagnostics } = plan(spec);
    expect(codes(diagnostics)).toEqual([
      "assembly/no-op-action@/steps/0/assembly/0",
      "assembly/no-op-action@/steps/0/assembly/1",
    ]);
    expect(diagnostics.every((d) => d.severity === "info")).toBe(true);
    expect(p[0]!.actions.map((a) => [a.from, a.to, a.length])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  test("invalid actions are reported at their path and left out of the plan", () => {
    const spec = mk({ stages: TWO_STAGES }, [
      {
        assembly: [
          { explode: "f", to: 3 },
          { implode: "f", to: 1 }, // at 0: forwards
          { explode: "f", to: 1 },
          { explode: "f", to: 0 }, // at 1: backwards
          { build: "f" },
          { unbuild: "f" },
          { explode: "f", program: "main" },
          { explode: "f/p1" },
        ],
      },
    ]);
    const { plan: p, diagnostics } = plan(spec);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["assembly/stage-out-of-range", "/steps/0/assembly/0/to"],
      ["assembly/implode-forwards", "/steps/0/assembly/1/to"],
      ["assembly/explode-backwards", "/steps/0/assembly/3/to"],
      ["assembly/figure-no-build", "/steps/0/assembly/4/build"],
      ["assembly/figure-no-build", "/steps/0/assembly/5/unbuild"],
      ["assembly/unknown-program", "/steps/0/assembly/6/program"],
      ["assembly/unknown-target", "/steps/0/assembly/7/explode"],
    ]);
    expect(diagnostics.every((d) => d.severity === "error" && d.suggestion)).toBe(true);
    expect(p[0]!.actions.map((a) => [a.from, a.to])).toEqual([[0, 1]]);
    expect(p[0]!.poses.f).toEqual([{ program: FIGURE_PROGRAM, level: 1 }]);
  });
});

describe("step views, suggestions and the same-view rule", () => {
  test("a closing transition only exists when the next view differs", () => {
    const tr = (views: (string | undefined)[]) =>
      stepWindows([3, 3, 3], views).map((w) => [w.lead, w.tr]);
    expect(tr(["a", "a", "a"])).toEqual([
      [0.75, 0],
      [0, 0],
      [0, 0.75], // the last step returns to the overview
    ]);
    expect(tr([undefined, undefined, undefined])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(tr(["a", "b", undefined])).toEqual([
      [0.75, 0.75],
      [0, 0.75],
      [0, 0],
    ]);
  });

  test("stepViews drops focus ids that do not zoom, for validate and scene alike", () => {
    const spec = mk({}, [{ focus: "n" }, { focus: "ghost" }, {}, { focus: "n" }], {
      nodes: [{ id: "n", type: "server" }],
    });
    expect(stepViews(spec, (id) => id === "n")).toEqual(["n", undefined, undefined, "n"]);
    expect(stepViews(spec, () => true)).toEqual(["n", "ghost", undefined, "n"]);
    // validate (semantic.ts) and the scene agree on the windows of a step with an unknown focus
    const steps = [{ duration: 2, focus: "ghost", assembly: [{ explode: "f" }] }];
    const withGhost = mk({ stages: TWO_STAGES }, steps, { nodes: [{ id: "n", type: "server" }] });
    const a = validate(withGhost).diagnostics.filter((d) => d.code === "assembly/compressed");
    const b = buildScene(withGhost, {}).assemblies!.plan[0]!.actions[0]!;
    expect(a[0]?.params?.window).toBe(1.3); // no lead, no camera transition (ghost is no view), but the closing window of 7.3
    expect(b.scale).toBe(0.5);
  });

  test("suggested durations remove the compression (property loop)", () => {
    const cases = [[undefined], ["f"], ["f", "f"], ["f", undefined]] as const;
    for (const views of cases) {
      for (const L of [0.3, 0.96, 1.5, 2.6, 4.04, 7.5, 13.2]) {
        const stages = [{ parts: ["p1"], duration: L }];
        const steps = views.map((f, i) => ({
          duration: 0.1,
          ...(f === undefined ? {} : { focus: f }),
          ...(i === 0 ? { assembly: [{ explode: "f" }] } : {}),
        }));
        const spec = mk({ stages }, steps);
        const figs = new Map([["f", fig(spec)]]);
        const v = steps.map((st) => st.focus);
        const first = planFigureSteps(spec, figs, v);
        const sug = first.diagnostics.find((d) => d.code === "assembly/compressed");
        expect(sug).toBeDefined();
        const D = sug?.params?.duration as number;
        expect(Number.isInteger(D)).toBe(true);
        const again = planFigureSteps(
          mk(
            { stages },
            steps.map((st, i) => (i === 0 ? { ...st, duration: D } : st)),
          ),
          figs,
          v,
        );
        expect(again.diagnostics.filter((d) => d.code === "assembly/compressed")).toEqual([]);
        // smallest whole second: one less still compresses
        if (D > 1) {
          const less = planFigureSteps(
            mk(
              { stages },
              steps.map((st, i) => (i === 0 ? { ...st, duration: D - 1 } : st)),
            ),
            figs,
            v,
          );
          expect(less.diagnostics.some((d) => d.code === "assembly/compressed")).toBe(true);
        }
      }
    }
  });

  test("the reviewer's case: need 2.6, 1 s step with focus suggests 5", () => {
    const spec = mk({ stages: TWO_STAGES }, [
      { duration: 1, focus: "f", assembly: [{ explode: "f" }] },
    ]);
    const d = planFigureSteps(spec, new Map([["f", fig(spec)]]), ["f"]).diagnostics;
    expect(d[0]?.suggestion).toBe('Set "duration": 5 on this step');
    expect(fitDuration(2.6, true, true)).toBe(5);
    expect(fitDuration(2.6, false, false)).toBe(3);
  });

  test("scaled actions never overrun the motion window", () => {
    for (const d of [1, 1.3, 2, 2.2, 2.7]) {
      const spec = mk({ stages: TWO_STAGES }, [
        { duration: d, assembly: [{ explode: "f", to: 1 }, { explode: "f" }] },
      ]);
      const [w] = stepWindows([d], [undefined]);
      for (const a of planFigureSteps(spec, new Map([["f", fig(spec)]]), [undefined]).plan[0]!
        .actions) {
        expect(a.start + a.length).toBeLessThanOrEqual(w!.window);
      }
    }
  });

  test("an any-depth scope is stripped before the did-you-mean and re-added", () => {
    const d = only(
      diags(mk({ stages: [{ parts: ["**/p-1"] }, { parts: ["p2", "p3"] }] })),
      "assembly/selector-empty",
    );
    expect(d.map((x) => x.suggestion)).toEqual(['Did you mean "**/p1"?']);
  });

  test("part-not-staged is info", () => {
    const d = only(diags(mk({ stages: [{ parts: ["p1", "p2"] }] })), "assembly/part-not-staged");
    expect(d.map((x) => x.severity)).toEqual(["info"]);
  });

  test("duplicate-id suggestion names figures only in specs that have them", () => {
    const withFig = mk({}, undefined, { nodes: [{ id: "f", type: "server" }] });
    const d = validate(withFig).diagnostics.find((x) => x.code === "semantic/duplicate-id");
    expect(d?.suggestion).toBe(
      "Ids are shared by nodes, groups, racks, equipment, rows, aisles, cables and figures; rename one",
    );
    const plain = validate({
      meta: { version: "1" },
      nodes: [
        { id: "a", type: "server" },
        { id: "a", type: "server" },
      ],
    }).diagnostics.find((x) => x.code === "semantic/duplicate-id");
    expect(plain?.suggestion).toBe(
      "Ids are shared by nodes, groups, racks, equipment, rows, aisles and cables; rename one",
    );
  });
});

describe("action targets and the guard (tracks §0)", () => {
  test("any declared non-figure id says it is not a figure (groups, equipment, rows, aisles)", () => {
    const spec = {
      ...mk({}, [
        {
          assembly: [
            { explode: "grp" },
            { implode: "eq" },
            { explode: "rw" },
            { explode: "ais" },
            { explode: "cbl" },
          ],
        },
      ]),
      nodes: [{ id: "n", type: "server", group: "grp" }],
      groups: [{ id: "grp" }],
      equipment: [{ id: "eq", type: "pdu" }],
      rows: [{ id: "rw", members: ["eq"] }],
      aisles: [{ id: "ais", rows: ["rw"] }],
      cables: [{ id: "cbl", from: "eq", to: "eq", kind: "power" }],
    } as unknown as PlatformCosmoSpec;
    const d = only(diags(spec, { phase1a: false }), "assembly/unknown-target");
    expect(d.map((x) => x.message)).toEqual([
      'Cannot explode "grp": it is a group, not a figure',
      'Cannot implode "eq": it is equipment, not a figure',
      'Cannot explode "rw": it is a row, not a figure',
      'Cannot explode "ais": it is an aisle, not a figure',
      'Cannot explode "cbl": it is a cable, not a figure',
    ]);
    expect(d.every((x) => x.suggestion === "Figures: f")).toBe(true);
  });

  const spec = {
    meta: { version: "1" },
    images: IMAGES,
    figures: [{ id: "heat-sink", base: "base", parts: PARTS }],
    assemblies: [{ id: "box", parts: [{ id: "x", size: [1, 1, 1] }] }],
    storyboards: [{ id: "book", frames: [{ model: "base" }] }],
    racks: [{ id: "r1", slots: [{ id: "s", at: 1, type: "server-1u" }] }],
    nodes: [{ id: "web", type: "server" }],
    steps: [
      {
        assembly: [
          { explode: "heat-sink" },
          { explode: "box" },
          { implode: "r1/s" },
          { build: "book" },
          { explode: "web" },
          { explode: "heat-sinc" },
          { explode: "missing" },
        ],
      },
    ],
  } as unknown as PlatformCosmoSpec;

  test("while phase1a is gated only figure targets are checked (the guard owns the rest)", () => {
    expect(diags(spec)).toEqual([]);
  });

  test("once phase1a lifts, non-figure targets of gated phases are unknown targets", () => {
    const d = only(diags(spec, { phase1a: false }), "assembly/unknown-target");
    expect(d.map((x) => [x.path, x.suggestion])).toEqual([
      ["/steps/0/assembly/1/explode", "Figures: heat-sink"],
      ["/steps/0/assembly/2/implode", "Figures: heat-sink"],
      ["/steps/0/assembly/3/build", "Figures: heat-sink"],
      ["/steps/0/assembly/4/explode", "Figures: heat-sink"],
      ["/steps/0/assembly/5/explode", 'Did you mean "heat-sink"?'],
      ["/steps/0/assembly/6/explode", "Figures: heat-sink"],
    ]);
    expect(d[0]?.message).toBe('Cannot explode "box": it is an assembly, not a figure');
    expect(d[1]?.message).toMatch(/it is a rack, not a figure/);
    expect(d[2]?.message).toMatch(/it is a storyboard, not a figure/);
    expect(d[3]?.message).toMatch(/it is a node, not a figure/);
    expect(d[4]?.message).toBe('Unknown explode target "heat-sinc"');
    expect(d.every((x) => x.severity === "error")).toBe(true);
  });

  test("a lifted phase is left to its own track", () => {
    const d = only(diags(spec, { phase1a: false, phase1b: false }), "assembly/unknown-target");
    expect(d.map((x) => x.path)).not.toContain("/steps/0/assembly/1/explode");
    expect(d.map((x) => x.path)).toContain("/steps/0/assembly/2/implode");
  });

  test("validate (phase1a lifted) reports the figure checks, with no guard error for figures", () => {
    const r = validate({
      ...spec,
      steps: [{ assembly: [{ explode: "heat-sink", to: 9 }] }],
    });
    expect(r.valid).toBe(false);
    const errors = codes(r.diagnostics.filter((d) => d.severity === "error"));
    expect(errors).toContain("assembly/stage-out-of-range@/steps/0/assembly/0/to");
    for (const gone of ["/figures", "/images", "/steps/0/assembly/0"]) {
      expect(errors).not.toContain(`assembly/unsupported@${gone}`);
    }
  });

  test("validate with phases 1a and 1b lifted keeps the guard error and adds unknown-target for racks", () => {
    const r = validate({
      ...spec,
      steps: [{ assembly: [{ explode: "heat-sink" }, { implode: "r1/s" }] }],
    });
    const errors = codes(r.diagnostics.filter((d) => d.severity === "error"));
    expect(errors).toContain("assembly/unsupported@/steps/0/assembly/1");
    expect(errors).toContain("assembly/unknown-target@/steps/0/assembly/1/implode");
    expect(errors.filter((e) => e.includes("/steps/0/assembly/0"))).toEqual([]);
  });
});

describe("oneOf diagnostics pick the branch by discriminator", () => {
  const withActions = (assembly: unknown[]) => ({
    ...mk(),
    steps: [{ assembly }],
  });
  const errs = (spec: unknown) => validate(spec).diagnostics.filter((d) => d.severity === "error");
  const asm = (extra: Record<string, unknown>) => ({
    meta: { version: "1" },
    assemblies: [{ id: "a", parts: [{ id: "x", size: [1, 1, 1], ...extra }] }],
  });
  const prog = (p: Record<string, unknown>) => ({
    meta: { version: "1" },
    assemblies: [{ id: "a", parts: [{ id: "x", size: [1, 1, 1] }], programs: [p] }],
  });

  test("action key: that action's errors, never 'Not a valid SpecAssemblyAction'", () => {
    const d = errs(
      withActions([
        { explode: "f", bogus: 1 },
        { implode: "f", to: "x" },
      ]),
    );
    expect(d.map((x) => [x.code, x.path])).toEqual([
      ["schema/additional-property", "/steps/0/assembly/0/bogus"],
      ["schema/type", "/steps/0/assembly/1/to"],
    ]);
    expect(d.some((x) => /Not a valid/.test(x.message))).toBe(false);
    expect(errs(withActions([{ build: "f", advance: 0 }])).map((x) => x.path)).toEqual([
      "/steps/0/assembly/0/advance",
    ]);
    expect(errs(withActions([{ unbuild: "f", to: -1 }])).map((x) => x.path)).toEqual([
      "/steps/0/assembly/0/to",
    ]);
  });

  test("a mistyped action key gets a did-you-mean", () => {
    const d = errs(withActions([{ explod: "f" }, { implose: "f", to: 1 }]));
    expect(d.map((x) => [x.code, x.path, x.suggestion])).toEqual([
      ["schema/one-of", "/steps/0/assembly/0", 'Did you mean "explode"?'],
      ["schema/one-of", "/steps/0/assembly/1", 'Did you mean "implode"?'],
    ]);
    expect(d[0]?.message).toBe(
      'Unknown key "explod"; expected one of: explode, implode, build, unbuild',
    );
  });

  test("two action keys in one action", () => {
    const d = errs(withActions([{ explode: "f", implode: "f" }]));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ code: "schema/one-of", path: "/steps/0/assembly/0" });
    expect(d[0]?.message).toBe('Has more than one of "explode", "implode"; exactly one is allowed');
  });

  test("no action key at all keeps the generic message", () => {
    const d = errs(withActions([{ to: 1 }]));
    expect(d[0]).toMatchObject({ code: "schema/one-of", path: "/steps/0/assembly/0" });
    expect(d[0]?.message).toBe("Not a valid SpecAssemblyAction");
  });

  test("program kind: a wrong kind is a did-you-mean, a right kind reports its branch", () => {
    const wrong = errs(prog({ id: "p", kind: "buildd", steps: [{ add: ["x"] }] }));
    expect(wrong.map((x) => [x.code, x.path, x.suggestion])).toEqual([
      ["schema/enum", "/assemblies/0/programs/0/kind", 'Did you mean "build"?'],
    ]);
    const build = errs(prog({ id: "p", kind: "build", stages: [{ parts: ["x"] }] }));
    expect(build.map((x) => [x.code, x.path])).toEqual([
      ["schema/required", "/assemblies/0/programs/0"],
      ["schema/additional-property", "/assemblies/0/programs/0/stages"],
    ]);
    expect(build[0]?.message).toBe('Missing required field "steps"');
  });

  test("program without kind is an explode program (the default kind)", () => {
    const d = errs(prog({ id: "p", steps: [{ add: ["x"] }] }));
    expect(d.map((x) => [x.code, x.path])).toEqual([
      ["schema/required", "/assemblies/0/programs/0"],
      ["schema/additional-property", "/assemblies/0/programs/0/steps"],
    ]);
    expect(d[0]?.message).toBe('Missing required field "stages"');
    expect(d.some((x) => /Not a valid/.test(x.message))).toBe(false);
  });

  test("part image: string vs object", () => {
    const str = errs(asm({ image: "Bad Id" }));
    expect(str.map((x) => [x.code, x.path])).toEqual([
      ["schema/pattern", "/assemblies/0/parts/0/image"],
    ]);
    const obj = errs(asm({ image: { ref: "gpu", face: "righ" } }));
    expect(obj.map((x) => [x.code, x.path, x.suggestion])).toEqual([
      ["schema/enum", "/assemblies/0/parts/0/image/face", 'Did you mean "right"?'],
    ]);
    const missing = errs(asm({ image: { face: "top" } }));
    expect(missing.map((x) => [x.code, x.path])).toEqual([
      ["schema/required", "/assemblies/0/parts/0/image"],
    ]);
    const num = errs(asm({ image: 5 }));
    expect(num[0]?.path).toBe("/assemblies/0/parts/0/image");
  });
});

describe("design examples", () => {
  const examples = (file: string): Record<string, unknown>[] =>
    [
      ...readFileSync(new URL(`../../../docs/design/${file}`, import.meta.url), "utf8").matchAll(
        /```json\n([\s\S]*?)```/g,
      ),
    ]
      .map((m) => JSON.parse(m[1] as string) as Record<string, unknown>)
      .filter((s) => Array.isArray(s.figures));

  const [heatSink, hallToSink] = examples("document-ingestion.md") as [
    PlatformCosmoSpec,
    PlatformCosmoSpec,
  ];

  test("both figure examples are found", () => {
    expect(heatSink.meta.title).toBe("Heat-sink installation figure");
    expect(hallToSink.meta.title).toBe("From the hall to the heat sink");
  });

  test("the heat-sink figure has no figure diagnostics, even with phase1a lifted", () => {
    expect(diags(heatSink)).toEqual([]);
    expect(diags(heatSink, { phase1a: false })).toEqual([]);
    expect(diags(hallToSink)).toEqual([]);
    // 7.3 targets assemblies and racks; with phase1a lifted they must not resolve here
    const lifted = diags(hallToSink, { phase1a: false });
    expect(lifted.every((d) => d.code === "assembly/unknown-target")).toBe(true);
    expect(lifted.length).toBeGreaterThan(0);
  });

  test("the heat-sink example validates cleanly once phase1a is lifted (R-1)", () => {
    const r = validate(heatSink);
    expect(r.diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual([]);
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.valid).toBe(true);
    // the 7.3 story still needs assemblies and racks: guarded, and its targets unknown
    const story = validate(hallToSink);
    expect(story.valid).toBe(false);
    expect(story.diagnostics.some((d) => d.code === "assembly/unsupported")).toBe(true);
  });

  test("the heat-sink example resolves to the expected SceneFlatBoard, plan and credits", () => {
    const g = buildScene(heatSink, {});
    const a = g.assemblies!;
    const source = { document: "Synthetic manual", page: 3, figure: "Figure 2" };
    expect(a.assemblies).toEqual([]);
    expect(a.boards).toEqual([
      {
        id: "hs-install",
        kind: "figure",
        label: "Installing the heat sinks",
        anchor: { x: 0, y: 0, z: 0 },
        width: 8,
        images: ["hs-base", "hs-sprite"],
      },
    ]);
    expect(a.images).toEqual(["hs-base", "hs-sprite"]);
    expect(a.credits).toEqual([source]);
    expect(a.plan.map((s) => [s.step, s.actions, s.poses, s.view])).toEqual([
      [1, [], { "hs-install": [{ program: "stages", level: 1 }] }, 0],
      [
        2,
        [
          {
            target: "hs-install",
            kind: "implode",
            program: "stages",
            from: 1,
            to: 0,
            start: 0,
            length: 1.5,
            scale: 1,
            implied: [],
          },
        ],
        { "hs-install": [{ program: "stages", level: 0 }] },
        0,
      ],
      [
        3,
        [
          {
            target: "hs-install",
            kind: "explode",
            program: "stages",
            from: 0,
            to: 1,
            start: 0,
            length: 1.5,
            scale: 1,
            implied: [],
          },
        ],
        { "hs-install": [{ program: "stages", level: 1 }] },
        0,
      ],
    ]);
    const scene = buildFigureScene(heatSink)!;
    const f = scene.figures.get("hs-install")!;
    expect(f.pose).toBe("exploded");
    expect(f.baseLevel).toBe(1);
    expect(f.parts.map((p) => [p.id, p.seat, p.exploded, p.stage])).toEqual([
      ["hs-1", [180, 360], [180, 120], 1],
      ["hs-2", [370, 372], [370, 132], 1],
    ]);
    expect(f.parts[0]?.detail).toEqual(["with retention clip"]);
    expect(f.stages[0]).toMatchObject({ start: 0, end: 1.5, labels: "show" });
    // implode = exact reverse of the 0 -> 0.3 stagger: hs-2 leaves first
    expect(figureSegment(f, 1, 0).moves.map((m) => [m.part, m.start])).toEqual([
      ["hs-2", 0],
      ["hs-1", 0.3],
    ]);
  });

  test("the 7.3 story's figure becomes a board next to the rest of the scene", () => {
    const a = buildFigureScene(hallToSink)!.assemblies;
    expect(a.boards.map((b) => [b.id, b.kind, b.width, b.images])).toEqual([
      ["hs-install", "figure", 8, ["hs-base", "hs-sprite"]],
    ]);
    // only figure actions reach the figure plan
    expect(a.plan.every((s) => s.actions.every((x) => x.target === "hs-install"))).toBe(true);
  });
});

describe("boards, images and credits", () => {
  test("anchors: pos wins; the rest stand in a row from the origin; width default 8", () => {
    const spec = mk({}, undefined, {
      figures: [
        { id: "a", base: "base", parts: PARTS, width: 4 },
        { id: "b", base: "base", parts: PARTS, pos: { x: 3, y: -2 } },
        { id: "c", base: "base", parts: PARTS },
      ],
    });
    const { assemblies } = buildFigureScene(spec, { origin: { x: 10, y: 5, z: 0 } })!;
    expect(assemblies.boards.map((b) => [b.id, b.anchor, b.width])).toEqual([
      ["a", { x: 10, y: 5, z: 0 }, 4],
      ["b", { x: 3, y: -2, z: 0 }, 8],
      ["c", { x: 15, y: 5, z: 0 }, 8],
    ]);
  });

  test("image keys: first-use order per board, sorted overall, deduplicated", () => {
    const spec = mk({}, undefined, {
      images: [...IMAGES, { id: "aaa", src: "z.png" }],
      figures: [
        {
          id: "f",
          base: "base",
          parts: [
            { id: "p1", image: "spr", seat: [0, 0] },
            { id: "p2", image: "aaa", seat: [0, 0] },
            { id: "p3", image: "spr", seat: [0, 0] },
          ],
        },
      ],
    });
    const a = buildFigureScene(spec)!.assemblies;
    expect(a.boards[0]?.images).toEqual(["base", "spr", "aaa"]);
    expect(a.images).toEqual(["aaa", "base", "spr"]);
  });

  test("credits: figure, image and part sources in first-use order, deduplicated", () => {
    const s1 = { document: "Manual", page: 3, attribution: "ACME", license: "CC-BY-4.0" };
    const s2 = { document: "Other", url: "https://example.com/doc" };
    const spec = mk({}, undefined, {
      images: [
        { id: "base", src: "a.png", source: s1 },
        { id: "spr", src: "b.png", source: s1 },
        { id: "unused", src: "c.png", source: { document: "Never" } },
      ],
      figures: [
        {
          id: "f",
          base: "base",
          source: s2,
          parts: [{ id: "p1", image: "spr", seat: [0, 0], source: { attribution: "Part maker" } }],
        },
      ],
    });
    expect(buildFigureScene(spec)!.assemblies.credits).toEqual([
      s2,
      s1,
      { attribution: "Part maker" },
    ]);
    // key order is fixed whatever the spec's order
    const shuffled = mk({}, undefined, {
      images: [
        { id: "base", src: "a.png", source: { url: "u", page: 1, document: "d" } },
        IMAGES[1],
      ],
    });
    expect(Object.keys(buildFigureScene(shuffled)!.assemblies.credits[0]!)).toEqual([
      "document",
      "page",
      "url",
    ]);
  });

  test("specs without figures get no assemblies (pre-1.2 scenes are unchanged)", () => {
    const g = buildScene({ meta: { version: "1" }, nodes: [{ id: "a", type: "server" }] }, {});
    expect("assemblies" in g).toBe(false);
    expect(
      buildFigureScene({ meta: { version: "1" }, nodes: [] } as unknown as PlatformCosmoSpec),
    ).toBeUndefined();
  });

  test("boards sit +x of the other scene content", () => {
    const spec = mk({}, undefined, { nodes: [{ id: "a", type: "server" }] });
    const g = buildScene(spec, {});
    const board = g.assemblies!.boards[0]!;
    expect(board.anchor.x).toBe(g.bounds.origin.x + g.bounds.size.x + 2);
  });

  test("determinism: identical input gives identical scenes", () => {
    const spec = mk(
      { stages: TWO_STAGES },
      [
        { duration: 2, assembly: [{ explode: "f" }] },
        { duration: 3, assembly: [{ implode: "f", to: 1 }, { implode: "f" }] },
      ],
      { images: [{ id: "base", src: "a.png", source: { document: "d" } }, IMAGES[1]] },
    );
    const a = JSON.stringify(buildScene(spec, {}));
    const b = JSON.stringify(buildScene(structuredClone(spec), {}));
    expect(a).toBe(b);
    const da = JSON.stringify(diags(spec));
    expect(da).toBe(JSON.stringify(diags(structuredClone(spec))));
    const fa = JSON.stringify([...buildFigureScene(spec)!.figures]);
    expect(fa).toBe(JSON.stringify([...buildFigureScene(structuredClone(spec))!.figures]));
  });
});
