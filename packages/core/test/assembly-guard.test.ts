import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { PlatformCosmoSpec } from "../src/index.js";
import { validate } from "../src/index.js";
import { UNRENDERED, unsupportedDiagnostics } from "../src/schema/unsupported.js";

// Schema 1.2.0 merge guard (docs/design/assemblies-tracks.md §0): the schema accepts the new
// fields, but `validate` rejects them until each phase's renderer lands.

const at = (s: unknown) =>
  validate(s)
    .diagnostics.filter((d) => d.code === "assembly/unsupported")
    .map((d) => d.path);

const designExamples = (file: string): Record<string, unknown>[] => {
  const md = readFileSync(new URL(`../../../docs/design/${file}`, import.meta.url), "utf8");
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Record<string, unknown>)
    .filter((s) => typeof s.meta === "object");
};

const everything = {
  meta: { version: "1" },
  images: [{ id: "i", src: "a.png" }],
  figures: [{ id: "f", base: "i", parts: [{ id: "p", image: "i", seat: [0, 0] }] }],
  storyboards: [{ id: "b", frames: [{ model: "i" }] }],
  assemblies: [
    {
      id: "a",
      closeup: "f",
      parts: [{ id: "x", size: [1, 1, 1], closeup: "f" }],
      programs: [
        { id: "e", stages: [{ parts: ["x"] }] },
        { id: "b", kind: "build", steps: [{ add: ["x"], from: "callout", subBuild: "x" }] },
      ],
    },
  ],
  racks: [
    {
      id: "r1",
      programs: [{ id: "p", stages: [{ parts: ["*"] }] }],
      slots: [{ id: "s", at: 1, type: "server-1u", assembly: "t", closeup: "f" }],
    },
  ],
  steps: [{ caption: "x" }, { assembly: [{ explode: "f" }, { build: "a" }] }],
};
const paths = (groups: Record<string, boolean>) =>
  unsupportedDiagnostics(everything as unknown as PlatformCosmoSpec, {
    phase1a: false,
    phase1b: false,
    phase2: false,
    storyboards: false,
    phase3: false,
    ...groups,
  }).map((d) => d.path);

describe("schema 1.2.0 guard", () => {
  test("every phase is lifted: 1a (R-1), 1b (B-1 + B-2), 2 (D-4a), storyboards (R-2), 3 (A2-7)", () => {
    expect(UNRENDERED).toEqual({
      phase1a: false,
      phase1b: false,
      phase2: false,
      storyboards: false,
      phase3: false,
    });
  });

  test("an assemblies-only spec is valid after the phase 1b lift", () => {
    const spec = {
      meta: { version: "1" },
      assemblies: [{ id: "box", parts: [{ id: "base", size: [1, 1, 1] }] }],
    };
    const r = validate(spec);
    expect(r.valid).toBe(true);
    expect(r.diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual([]);
    expect(at(spec)).toEqual([]);
  });

  test("the guard still refuses the whole assemblies array when phase1b is on (revert path)", () => {
    const spec = {
      meta: { version: "1" },
      assemblies: [{ id: "box", parts: [{ id: "base", size: [1, 1, 1] }] }],
    } as unknown as PlatformCosmoSpec;
    const d = unsupportedDiagnostics(spec, {
      phase1a: false,
      phase1b: true,
      phase2: true,
      storyboards: true,
      phase3: true,
    });
    expect(d.map((x) => x.path)).toEqual(["/assemblies"]);
    expect(d[0]?.suggestion).toMatch(/upgrade platformcosmo/);
  });

  test("with every group on, each field is flagged once at its outermost location", () => {
    expect(validate(everything).diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual(
      [],
    );
    const on = { phase1a: true, phase1b: true, phase2: true, storyboards: true, phase3: true };
    expect(
      unsupportedDiagnostics(everything as unknown as PlatformCosmoSpec, on)
        .map((d) => d.path)
        .sort(),
    ).toEqual([
      "/assemblies",
      "/figures",
      "/images",
      "/racks/0/programs",
      "/racks/0/slots/0/assembly",
      "/racks/0/slots/0/closeup",
      "/steps/1/assembly/0",
      "/steps/1/assembly/1",
      "/storyboards",
    ]);
  });

  test("with the shipped groups nothing is flagged; validate checks the phase 2 fields itself", () => {
    expect(at(everything)).toEqual([]);
    // the real checks: an unknown slot template, a leaf as a sub-build, an action on a figure
    // that is only a close-up (it is drawn only where a closeup shows it)
    const r = validate(everything);
    expect(
      r.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => [d.code, d.path])
        .sort(),
    ).toEqual([
      ["assembly/unknown-target", "/assemblies/0/programs/1/steps/0/subBuild"],
      ["assembly/unknown-target", "/racks/0/slots/0/assembly"],
      ["assembly/unknown-target", "/steps/1/assembly/0/explode"],
    ]);
  });

  test("actions are gated by their target: rack and slot actions stay gated, assemblies pass", () => {
    const spec = {
      ...everything,
      steps: [
        {
          assembly: [{ explode: "f" }, { explode: "r1" }, { implode: "r1/s" }, { explode: "a" }],
        },
      ],
    } as unknown as PlatformCosmoSpec;
    const lifted = {
      phase1a: false,
      phase1b: false,
      phase2: true,
      storyboards: true,
      phase3: true,
    };
    const steps = unsupportedDiagnostics(spec, lifted)
      .map((d) => d.path)
      .filter((p) => p.startsWith("/steps"));
    expect(steps).toEqual(["/steps/0/assembly/1", "/steps/0/assembly/2"]);
    // the explode on assembly "a" is lifted with phase1b; before the lift it was flagged too
    const before = { ...lifted, phase1b: true };
    expect(
      unsupportedDiagnostics(spec, before)
        .map((d) => d.path)
        .filter((p) => p.startsWith("/steps")),
    ).toEqual(["/steps/0/assembly/1", "/steps/0/assembly/2", "/steps/0/assembly/3"]);
  });

  test("part paths and close-up paths in an otherwise 1.1 spec are rejected (by validate)", () => {
    const spec = {
      meta: { version: "1" },
      racks: [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-1u" }] }],
      steps: [
        { focus: "r1/srv/x" },
        { focus: "r1/srv/closeup" },
        { set: { "r1/srv/closeup/board": "down", "r1/srv": "degraded" } },
      ],
    };
    const r = validate(spec);
    expect(r.valid).toBe(false);
    expect(at(spec)).toEqual([]);
    expect(
      r.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.path]),
    ).toEqual([
      ["semantic/unknown-node", "/steps/0/focus"],
      ["semantic/unknown-node", "/steps/1/focus"],
      ["semantic/unknown-node", "/steps/2/set/r1/srv/closeup/board"],
    ]);
  });

  test("lifting phases 1a and 1b leaves the phase 2 and 3 fields flagged", () => {
    expect(paths({ phase2: true, storyboards: true, phase3: true })).toEqual([
      "/assemblies/0/closeup",
      "/assemblies/0/programs/1",
      "/assemblies/0/parts/0/closeup",
      "/storyboards",
      "/steps/1/assembly/1",
      "/racks/0/programs",
      "/racks/0/slots/0/assembly",
      "/racks/0/slots/0/closeup",
    ]);
  });

  test("lifting phase 2 and storyboards leaves only the phase 3 build-step features", () => {
    expect(paths({ phase3: true })).toEqual([
      "/assemblies/0/programs/1/steps/0/from",
      "/assemblies/0/programs/1/steps/0/subBuild",
    ]);
    expect(paths({ storyboards: true })).toEqual(["/storyboards"]);
    expect(paths({})).toEqual([]);
  });

  test("a 1.1 id named closeup stays valid (warning only), also as a slot path", () => {
    const spec = {
      meta: { version: "1" },
      nodes: [{ id: "closeup", type: "server" }],
      racks: [{ id: "r1", slots: [{ id: "closeup", at: 1, type: "server-1u" }] }],
      steps: [{ focus: "closeup" }, { focus: "r1/closeup", set: { "r1/closeup": "down" } }],
    };
    const r = validate(spec);
    expect(r.valid).toBe(true);
    expect(at(spec)).toEqual([]);
    expect(
      r.diagnostics.filter((d) => d.code === "semantic/reserved-id").map((d) => d.path),
    ).toEqual(["/nodes/0/id", "/racks/0/slots/0/id"]);
    expect(r.diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });

  test("1.1 specs are untouched", () => {
    const spec = {
      meta: { version: "1" },
      nodes: [{ id: "a", type: "server" }],
      racks: [{ id: "r1", slots: [{ at: 1, type: "server-1u" }] }],
      steps: [{ focus: "a" }],
    };
    expect(at(spec)).toEqual([]);
  });

  // tracks §0: an example renders when all its 1.2 fields are phase 1a, 1b or storyboards (images,
  // figures, assemblies with explode programs, explode/implode on figures and assemblies,
  // storyboards and their build/unbuild); everything else (racks programs, slot assemblies,
  // build programs, close-ups, rack/slot actions) still hits the guard. The predicate does not
  // use the guard.
  const phase1Only = (spec: Record<string, unknown>): boolean => {
    const racks = (spec.racks ?? []) as { programs?: unknown; slots?: Record<string, unknown>[] }[];
    const ok = new Set(
      [
        ...((spec.figures ?? []) as { id: string }[]),
        ...((spec.assemblies ?? []) as { id: string }[]),
      ].map((f) => f.id),
    );
    const boards = new Set(((spec.storyboards ?? []) as { id: string }[]).map((b) => b.id));
    const actions = ((spec.steps ?? []) as { assembly?: Record<string, string>[] }[]).flatMap(
      (s) => s.assembly ?? [],
    );
    const text = JSON.stringify(spec);
    return (
      !racks.some(
        (r) => r.programs !== undefined || r.slots?.some((s) => s.assembly || s.closeup),
      ) &&
      actions.every((a) =>
        "build" in a || "unbuild" in a
          ? boards.has(String(Object.values(a)[0]))
          : ok.has(String(Object.values(a)[0]).split("/")[0] as string),
      ) &&
      !text.includes('"closeup"') &&
      !text.includes('"kind":"build"')
    );
  };

  test.each(["assemblies.md", "document-ingestion.md"])(
    "design examples in %s pass the schema and validate cleanly: every phase renders (D-4a)",
    (file) => {
      const specs = designExamples(file);
      expect(specs.length).toBeGreaterThan(3);
      for (const spec of specs) {
        const r = validate(spec);
        expect(r.diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual([]);
        expect(r.diagnostics.filter((d) => d.code === "assembly/unsupported")).toEqual([]);
        expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      }
    },
  );

  describe("what phase1a does not unlock (Q08)", () => {
    const base = {
      meta: { version: "1" },
      images: [
        { id: "b", src: "b.png" },
        { id: "s", src: "s.png" },
      ],
      figures: [{ id: "fig", base: "b", parts: [{ id: "a", image: "s", seat: [0, 0] }] }],
      nodes: [{ id: "n", type: "server" }],
    };
    const errors = (steps: unknown[]) =>
      validate({ ...base, steps }).diagnostics.filter((d) => d.severity === "error");

    test("explode on a node is an unknown target, not a pose change", () => {
      const e = errors([{ assembly: [{ explode: "n" }] }]);
      expect(e.map((d) => [d.code, d.path])).toEqual([
        ["assembly/unknown-target", "/steps/0/assembly/0/explode"],
      ]);
      expect(e[0]?.message).toBe('Cannot explode "n": it is a node, not a figure');
    });

    test("explode on an unknown root is an unknown target with a did-you-mean", () => {
      const e = errors([{ assembly: [{ explode: "fgi" }] }]);
      expect(e.map((d) => d.code)).toEqual(["assembly/unknown-target"]);
      expect(e[0]?.suggestion).toBe('Did you mean "fig"?');
    });

    test("a figure part path is not a target, and focus or set of fig/a/b is rejected", () => {
      const act = errors([{ assembly: [{ explode: "fig/a" }] }]);
      expect(act.map((d) => d.code)).toEqual(["assembly/unknown-target"]);
      // focus and set of a part path: the guard (phase1b) AND semantic validation reject them
      for (const step of [
        { focus: "fig/a/b" },
        { set: { "fig/a/b": "down" } },
        { focus: "fig/a" },
      ]) {
        const e = errors([step]);
        expect(
          e.some((d) => d.code.startsWith("semantic/")),
          JSON.stringify(step),
        ).toBe(true);
      }
      expect(errors([{ focus: "fig" }])).toEqual([]);
    });
  });

  test("the examples that render: the heat-sink figure, the booklet storyboard and the Phase 1b plans", () => {
    const title = (s: Record<string, unknown>) => (s.meta as { title: string }).title;
    expect(designExamples("document-ingestion.md").filter(phase1Only).map(title)).toEqual([
      "Heat-sink installation figure",
      "Booklet storyboard",
    ]);
    expect(designExamples("assemblies.md").filter(phase1Only).map(title)).toEqual([
      "Two-part box",
      "2U GPU server internals",
      "Inline-4 engine teardown",
    ]);
  });

  test("phase 2 targets are validate's after the lift: real codes, never assembly/unsupported", () => {
    const spec = {
      meta: { version: "1" },
      assemblies: [
        {
          id: "a",
          parts: [
            { id: "x", size: [1, 1, 1] },
            { id: "y", at: [2, 0, 0], size: [1, 1, 1] },
          ],
          programs: [{ id: "open", stages: [{ parts: ["y"], direction: "up" }] }],
        },
      ],
      racks: [{ id: "r1", slots: [{ id: "s", at: 1, type: "server-1u" }] }],
      steps: [
        {
          assembly: [
            { explode: "a" },
            { explode: "r1" },
            { implode: "r1/s" },
            { build: "a" },
            { unbuild: "a" },
          ],
        },
        { focus: "a/x/closeup" },
      ],
    };
    const r = validate(spec);
    expect(r.diagnostics.filter((d) => d.code === "assembly/unsupported")).toEqual([]);
    expect(
      r.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.path]),
    ).toEqual([
      ["assembly/unknown-program", "/steps/0/assembly/2/implode"],
      ["assembly/unknown-program", "/steps/0/assembly/3/build"],
      ["assembly/unknown-program", "/steps/0/assembly/4/unbuild"],
      ["assembly/unknown-target", "/steps/1/focus"],
    ]);
    // the rack explode resolves (its built-in drawers program) and the assembly explode too
    expect(r.diagnostics.filter((d) => d.path.startsWith("/steps/0/assembly/0"))).toEqual([]);
    expect(r.diagnostics.filter((d) => d.path.startsWith("/steps/0/assembly/1"))).toEqual([]);
  });

  test("a closeup that names a storyboard is refused at its field (not drawn yet)", () => {
    const spec = {
      meta: { version: "1" },
      images: [{ id: "i", src: "a.png" }],
      storyboards: [{ id: "sb", frames: [{ model: "i" }, { model: "i" }] }],
      assemblies: [
        { id: "a", closeup: "sb", parts: [{ id: "x", size: [1, 1, 1], closeup: "sb" }] },
      ],
      racks: [{ id: "r1", slots: [{ id: "s", at: 1, type: "server-1u", closeup: "sb" }] }],
      steps: [{ focus: "a/x/closeup" }],
    };
    const r = validate(spec);
    expect(r.valid).toBe(false);
    const d = r.diagnostics.filter((x) => x.code === "assembly/unsupported");
    expect(d.map((x) => x.path)).toEqual([
      "/assemblies/0/closeup",
      "/assemblies/0/parts/0/closeup",
      "/racks/0/slots/0/closeup",
    ]);
    expect(d[0]?.message).toMatch(/names a storyboard; storyboard close-ups are not drawn yet/);
    // a figure close-up is fine
    const fig = structuredClone(spec) as unknown as Record<string, unknown>;
    fig.figures = [{ id: "f", base: "i", parts: [{ id: "p", image: "i", seat: [0, 0] }] }];
    for (const a of fig.assemblies as Record<string, unknown>[]) {
      a.closeup = "f";
      (a.parts as Record<string, unknown>[])[0]!.closeup = "f";
    }
    (fig.racks as { slots: Record<string, unknown>[] }[])[0]!.slots[0]!.closeup = "f";
    expect(validate(fig).diagnostics.filter((x) => x.code === "assembly/unsupported")).toEqual([]);
  });

  test("R-2 Q06: an unknown storyboard id reads as its real diagnostic, not the guard's", () => {
    const spec = {
      meta: { version: "1" },
      images: [{ id: "i", src: "a.png" }],
      storyboards: [{ id: "book", frames: [{ model: "i" }, { model: "i" }] }],
      steps: [{ assembly: [{ build: "bok" }] }, { assembly: [{ unbuild: "nope/x" }] }],
    };
    const r = validate(spec);
    expect(r.diagnostics.filter((d) => d.code === "assembly/unsupported")).toEqual([]);
    const e = r.diagnostics.filter((d) => d.severity === "error");
    expect(e.map((d) => [d.code, d.path])).toEqual([
      ["assembly/unknown-target", "/steps/0/assembly/0/build"],
      ["assembly/unknown-target", "/steps/1/assembly/0/unbuild"],
    ]);
    expect(e[0]?.suggestion).toBe('Did you mean "book"?');
    // with the phase 2 group still on (the old wiring) the guard swallowed it
    expect(
      unsupportedDiagnostics(spec as unknown as PlatformCosmoSpec, {
        ...UNRENDERED,
        phase2: true,
      }).map((d) => d.path),
    ).toEqual(["/steps/0/assembly/0", "/steps/1/assembly/0"]);
  });

  test("assembly/compressed is reported by validate exactly once per window", () => {
    const eng = designExamples("assemblies.md").find((s) =>
      (s.meta as { title: string }).title.startsWith("Inline-4"),
    )!;
    const r = validate(eng);
    const paths = r.diagnostics.filter((d) => d.code === "assembly/compressed").map((d) => d.path);
    expect(new Set(paths).size).toBe(paths.length);
    const keys = r.diagnostics
      .filter((d) => d.code === "assembly/compressed")
      .map((d) => `${d.path}|${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
