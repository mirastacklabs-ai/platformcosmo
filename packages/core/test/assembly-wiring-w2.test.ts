// W-2 (Phase 2 wiring follow-ups): close-up actions are planned in validate (planScene), a plain
// rack slot has no program of its own, collisions point at their assembly, and the level track
// helpers (docs/design/assemblies.md §7.3, §8.1, §8.3, §9.3).
import { describe, expect, test } from "vitest";
import type { DcPack } from "../src/contracts/index.js";
import type { Diagnostic, PlatformCosmoSpec } from "../src/index.js";
import { buildScene } from "../src/index.js";
import { assemblyPlanDiagnostics } from "../src/scene/assembly/plan-scene.js";
import { assemblyDiagnostics } from "../src/schema/assembly-semantic.js";
import { buildModelWithDiagnostics } from "../src/render/model.js";
import {
  complementWindows,
  evalOpacity,
  levelsTrack,
  windowsTrack,
} from "../src/render/assembly/tracks.js";
import { fixtureTheme } from "./fixtures/theme.js";

type Obj = Record<string, unknown>;
const spec = (o: Obj): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...o }) as unknown as PlatformCosmoSpec;
const codes = (ds: readonly Diagnostic[], c: string): Diagnostic[] =>
  ds.filter((d) => d.code === c);
const LIFT = { phase1a: false, phase1b: false, phase2: false, phase3: false };

describe("close-up actions are planned in validate (d, e)", () => {
  /** A close-up instance with a long explode program, exploded in a 1 s step. */
  const s = spec({
    assemblies: [
      {
        id: "tpl",
        template: true,
        units: "mm",
        parts: [
          { id: "a", size: [10, 10, 10] },
          { id: "b", at: [0, 0, 10], size: [10, 10, 10] },
        ],
        programs: [
          {
            id: "open",
            stages: [
              { parts: ["b"], direction: "up", duration: 2 },
              { parts: ["a"], direction: "+x", duration: 2 },
            ],
          },
        ],
      },
      { id: "host", units: "mm", parts: [{ id: "p", size: [10, 10, 20], closeup: "tpl" }] },
    ],
    steps: [{ duration: 1, assembly: [{ explode: "host/p/closeup" }] }],
  });

  test("assembly/compressed is reported for an action on a …/closeup path", () => {
    const d = codes(
      assemblyPlanDiagnostics(s, { isFocusTarget: () => true }),
      "assembly/compressed",
    );
    expect(d.map((x) => x.path)).toEqual(["/steps/0/assembly"]);
  });

  test("the scene plans the same action (and leaves the report to validate)", () => {
    const g = buildScene(s, {});
    expect(g.assemblies!.plan[0]!.actions.map((a) => [a.target, a.scale < 1])).toEqual([
      ["host/p/closeup", true],
    ]);
    expect(codes(g.diagnostics, "assembly/compressed")).toEqual([]);
  });
});

describe("a plain rack slot has no program of its own (c, §8.3)", () => {
  const rack = (target: string): Diagnostic[] =>
    assemblyDiagnostics(
      spec({
        racks: [
          {
            id: "r1",
            slots: [
              { id: "tor", at: 40, type: "switch-tor", closeup: "tpl" },
              { id: "srv", at: 1, type: "server-2u", assembly: "tpl" },
            ],
          },
        ],
        assemblies: [
          {
            id: "tpl",
            template: true,
            units: "mm",
            parts: [{ id: "x", size: [10, 10, 10] }],
            programs: [{ id: "p", stages: [{ parts: ["x"], direction: "up" }] }],
          },
        ],
        steps: [{ assembly: [{ explode: target }] }],
      }),
      LIFT,
    );

  test("explode of a slot without internals is an error, as is a path below it", () => {
    for (const t of ["r1/tor", "r1/tor/chassis", "r1/frame"]) {
      const d = codes(rack(t), "assembly/unknown-program");
      expect(
        d.map((x) => x.path),
        t,
      ).toEqual(["/steps/0/assembly/0/explode"]);
      expect(d[0]!.suggestion).toContain('"r1"');
    }
  });

  test("the rack, a slot with internals and a close-up path stay valid", () => {
    for (const t of ["r1", "r1/srv", "r1/tor/closeup"]) {
      expect(codes(rack(t), "assembly/unknown-program"), t).toEqual([]);
    }
  });
});

describe("actions below a plain rack slot's close-up are validated as a spec host's (P1-gap)", () => {
  const tpl = {
    id: "tpl",
    template: true,
    units: "mm",
    parts: [{ id: "x", size: [10, 10, 10] }],
    programs: [{ id: "p", stages: [{ parts: ["x"], direction: "up" }] }],
  };
  const hostSpec = (action: Obj, target: string): Diagnostic[] =>
    assemblyDiagnostics(
      spec({
        assemblies: [
          tpl,
          { id: "host", units: "mm", parts: [{ id: "h", size: [10, 10, 10], closeup: "tpl" }] },
        ],
        steps: [{ assembly: [{ ...action, [Object.keys(action)[0]!]: target }] }],
      }),
      LIFT,
    );
  const slotSpec = (action: Obj, target: string, closeup = "tpl"): Diagnostic[] =>
    assemblyDiagnostics(
      spec({
        racks: [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-2u", closeup }] }],
        assemblies: [tpl],
        figures: [{ id: "fig", parts: [{ id: "a", image: "none" }] }],
        steps: [{ assembly: [{ ...action, [Object.keys(action)[0]!]: target }] }],
      }),
      LIFT,
    ).filter((d) => d.code.startsWith("assembly/"));
  const cases: [string, Obj, string][] = [
    ["to out of range", { explode: "", to: 5 }, "assembly/stage-out-of-range"],
    ["unknown program", { explode: "", program: "nope" }, "assembly/unknown-program"],
    ["unknown part path", { explode: "" }, "assembly/unknown-target"],
    ["build with an explode program", { build: "", program: "p" }, "assembly/unknown-program"],
  ];
  test.each(cases)("%s: the codes a spec host gives", (_n, action, code) => {
    const part = _n === "unknown part path" ? "/nope" : "";
    const host = hostSpec(action, `host/h/closeup${part}`);
    const slot = slotSpec(action, `r1/srv/closeup${part}`);
    expect(host.map((d) => d.code)).toContain(code);
    expect(slot.map((d) => d.code)).toEqual(host.map((d) => d.code));
    expect(slot[0]!.path).toBe(host[0]!.path);
  });

  const slots = (target: string): Diagnostic[] =>
    assemblyDiagnostics(
      spec({
        racks: [
          {
            id: "r1",
            slots: [
              { id: "tor", at: 40, type: "switch-tor" },
              { id: "srv", at: 1, type: "server-2u", closeup: "tpl" },
            ],
          },
        ],
        assemblies: [tpl],
        steps: [{ assembly: [{ explode: target }] }],
      }),
      LIFT,
    );

  test("an unknown slot and a slot without a close-up are unknown targets", () => {
    for (const t of ["r1/nope/closeup", "r1/tor/closeup"]) {
      const d = slots(t);
      expect(
        d.map((x) => [x.code, x.path]),
        t,
      ).toEqual([["assembly/unknown-target", "/steps/0/assembly/0/explode"]]);
    }
  });

  test("a typo of the reserved segment offers the close-up", () => {
    const d = slots("r1/srv/closup");
    expect(d.map((x) => x.code)).toEqual(["assembly/unknown-target"]);
    expect(d[0]!.suggestion).toContain("r1/srv/closeup");
  });

  test("a valid program, and a close-up that names a figure, report nothing", () => {
    expect(slotSpec({ explode: "" }, "r1/srv/closeup")).toEqual([]);
    expect(slotSpec({ explode: "" }, "r1/srv/closeup", "fig")).toEqual([]);
    expect(slotSpec({ explode: "", to: 9 }, "r1/srv/closeup/anything", "fig")).toEqual([]);
  });
});

describe("the figure stop rule on a spec host", () => {
  test("actions on a close-up that names a figure are not assembly actions", () => {
    for (const t of ["host/h/closeup", "host/h/closeup/zz"]) {
      const d = assemblyDiagnostics(
        spec({
          assemblies: [
            { id: "host", units: "mm", parts: [{ id: "h", size: [10, 10, 10], closeup: "fig" }] },
          ],
          figures: [{ id: "fig", parts: [] }],
          steps: [{ assembly: [{ implode: t }] }],
        }),
        LIFT,
      );
      expect(
        d.filter((x) => x.path.startsWith("/steps")),
        t,
      ).toEqual([]);
    }
  });
});

describe("assemblyPlanDiagnostics keeps planScene's errors", () => {
  test("a throwing DC pack is one render/internal-error", () => {
    const boom = () => {
      throw new Error("boom");
    };
    const dc = { buildScene: boom, buildAssembly: boom } as unknown as DcPack;
    const d = assemblyPlanDiagnostics(
      spec({
        racks: [{ id: "r1", slots: [{ id: "s", at: 1, type: "server-2u" }] }],
        steps: [{ assembly: [{ explode: "r1" }] }],
      }),
      { dc, isFocusTarget: () => true },
    );
    expect(d.map((x) => x.code)).toEqual(["render/internal-error"]);
  });
});

describe("depth diagnostics point at their assembly (N2)", () => {
  test("a part sliding through another: /assemblies/<i>, not an empty pointer", () => {
    // a slides +x straight through b
    const s = spec({
      assemblies: [
        { id: "other", parts: [{ id: "o", size: [1, 1, 1] }] },
        {
          id: "pair",
          parts: [
            // a bar wider than b in y, so it cannot be clipped as an insertion into b
            { id: "a", at: [0, -1, 0], size: [1, 3, 1] },
            { id: "b", at: [2, 0, 0], size: [1, 1, 1] },
          ],
          programs: [{ id: "p", stages: [{ parts: ["a"], direction: "+x", distance: 4 }] }],
        },
      ],
      steps: [{ duration: 4, assembly: [{ explode: "pair" }] }],
    });
    const { diagnostics } = buildModelWithDiagnostics({
      scene: buildScene(s, {}),
      theme: fixtureTheme(),
      font: "system",
      prefix: "pc-t",
      spec: s,
    });
    // the depth order's diagnostics (here a clip fallback and approximate epochs; transit
    // collisions alike) point at the moving parts' assembly, not ""
    const depth = diagnostics.filter((x) =>
      ["assembly/transit-collision", "assembly/clip-fallback", "assembly/depth-approx"].includes(
        x.code,
      ),
    );
    expect(depth.length).toBeGreaterThan(0);
    expect(new Set(depth.map((x) => x.path))).toEqual(new Set(["/assemblies/1"]));
  });
});

describe("level tracks (b)", () => {
  test("levelsTrack with one level equals windowsTrack", () => {
    const w = [
      { a: 1, b: 2 },
      { a: 4, b: 5 },
    ];
    expect(
      levelsTrack(
        w.map((x) => ({ ...x, value: 0.3 })),
        8,
      ),
    ).toEqual(windowsTrack(w, 0.3, 8));
  });

  test("overlapping levels take the lowest; 0 ramp switches at once", () => {
    const k = levelsTrack(
      [
        { a: 1, b: 5, value: 0.3 },
        { a: 2, b: 3, value: 0 },
      ],
      8,
      0,
    );
    expect(evalOpacity(k, 0.5)).toBe(1);
    expect(evalOpacity(k, 1.5)).toBe(0.3);
    expect(evalOpacity(k, 2.5)).toBe(0);
    expect(evalOpacity(k, 4)).toBe(0.3);
    expect(evalOpacity(k, 6)).toBe(1);
    expect(levelsTrack([], 8)).toEqual([]);
  });

  test("complementWindows", () => {
    expect(complementWindows([{ a: 1, b: 2 }], 4)).toEqual([
      [0, 1],
      [2, 4],
    ]);
    expect(complementWindows([{ a: 0, b: 4 }], 4)).toEqual([]);
  });
});
