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
    phase3: false,
    ...groups,
  }).map((d) => d.path);

describe("schema 1.2.0 guard", () => {
  test("phase 1a (figures) is lifted by R-1; every later phase is still unrendered", () => {
    expect(UNRENDERED).toEqual({ phase1a: false, phase1b: true, phase2: true, phase3: true });
  });

  test("assemblies-only spec is rejected at the field, not by the schema", () => {
    const spec = {
      meta: { version: "1" },
      assemblies: [{ id: "box", parts: [{ id: "base", size: [1, 1, 1] }] }],
    };
    const r = validate(spec);
    expect(r.valid).toBe(false);
    expect(r.diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual([]);
    expect(at(spec)).toEqual(["/assemblies"]);
    expect(r.diagnostics.find((d) => d.code === "assembly/unsupported")?.suggestion).toMatch(
      /upgrade platformcosmo/,
    );
  });

  test("with every group on, each field is flagged once at its outermost location", () => {
    expect(validate(everything).diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual(
      [],
    );
    const on = { phase1a: true, phase1b: true, phase2: true, phase3: true };
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

  test("with the shipped groups, figures and images pass and the later phases are flagged", () => {
    expect(at(everything)).toEqual([
      "/assemblies",
      "/racks/0/programs",
      "/racks/0/slots/0/assembly",
      "/racks/0/slots/0/closeup",
      "/steps/1/assembly/1",
      "/storyboards",
    ]);
  });

  test("with phase1a lifted, A2-F's post-lift rule is on: a non-figure target is unknown", () => {
    // `build: "a"` targets an assembly (phase1b, still gated): the guard error stays AND the
    // semantic check reports it, so a Phase 1a build never resolves it. The figure action passes.
    const r = validate(everything);
    const unknown = r.diagnostics.filter((d) => d.code === "assembly/unknown-target");
    expect(unknown.map((d) => d.path)).toEqual(["/steps/1/assembly/1/build"]);
    expect(unknown[0]?.message).toBe('Cannot build "a": it is an assembly, not a figure');
    expect(r.diagnostics.some((d) => d.path === "/steps/1/assembly/0/explode")).toBe(false);
  });

  test("actions are gated by their target: lifting 1a alone keeps rack and slot actions gated", () => {
    const spec = {
      ...everything,
      steps: [
        {
          assembly: [{ explode: "f" }, { explode: "r1" }, { implode: "r1/s" }, { explode: "a" }],
        },
      ],
    } as unknown as PlatformCosmoSpec;
    const lifted1a = { phase1a: false, phase1b: true, phase2: true, phase3: true };
    const steps = unsupportedDiagnostics(spec, lifted1a)
      .map((d) => d.path)
      .filter((p) => p.startsWith("/steps"));
    expect(steps).toEqual(["/steps/0/assembly/1", "/steps/0/assembly/2", "/steps/0/assembly/3"]);
  });

  test("part paths and close-up paths in an otherwise 1.1 spec are rejected", () => {
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
    expect(at(spec)).toEqual([
      "/steps/0/focus",
      "/steps/1/focus",
      "/steps/2/set/r1~1srv~1closeup~1board",
    ]);
  });

  test("lifting phases 1a and 1b leaves the phase 2 and 3 fields flagged", () => {
    expect(paths({ phase2: true, phase3: true })).toEqual([
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

  test("lifting phase 2 leaves only the phase 3 build-step features and storyboards", () => {
    expect(paths({ phase3: true })).toEqual([
      "/assemblies/0/programs/1/steps/0/from",
      "/assemblies/0/programs/1/steps/0/subBuild",
      "/storyboards",
    ]);
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

  // tracks §0: an example whose 1.2 fields are all phase 1a (images, figures, figure actions)
  // renders now; every other example still hits the guard. The predicate does not use the guard.
  const phase1aOnly = (spec: Record<string, unknown>): boolean => {
    const racks = (spec.racks ?? []) as { programs?: unknown; slots?: Record<string, unknown>[] }[];
    const figureIds = new Set(((spec.figures ?? []) as { id: string }[]).map((f) => f.id));
    const actions = ((spec.steps ?? []) as { assembly?: Record<string, string>[] }[]).flatMap(
      (s) => s.assembly ?? [],
    );
    return (
      spec.assemblies === undefined &&
      spec.storyboards === undefined &&
      !racks.some(
        (r) => r.programs !== undefined || r.slots?.some((s) => s.assembly || s.closeup),
      ) &&
      actions.every((a) => figureIds.has(String(Object.values(a)[0]).split("/")[0] as string)) &&
      !JSON.stringify(spec).includes('"closeup"')
    );
  };

  test.each(["assemblies.md", "document-ingestion.md"])(
    "design examples in %s pass the schema; phase 1a ones render, the others hit the guard",
    (file) => {
      const specs = designExamples(file);
      expect(specs.length).toBeGreaterThan(3);
      for (const spec of specs) {
        const r = validate(spec);
        expect(r.diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual([]);
        const guarded = r.diagnostics.some((d) => d.code === "assembly/unsupported");
        expect(guarded).toBe(!phase1aOnly(spec));
        if (!guarded) expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        else expect(r.valid).toBe(false);
      }
    },
  );

  test("the heat-sink figure example is the one example that renders", () => {
    const rendering = designExamples("document-ingestion.md").filter(phase1aOnly);
    expect(rendering.map((s) => (s.meta as { title: string }).title)).toEqual([
      "Heat-sink installation figure",
    ]);
    expect(designExamples("assemblies.md").filter(phase1aOnly)).toEqual([]);
    expect(validate(rendering[0]).valid).toBe(true);
  });
});
