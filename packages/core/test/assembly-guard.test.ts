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
  test("every phase is still unrendered in this build", () => {
    expect(Object.values(UNRENDERED).every(Boolean)).toBe(true);
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
    expect(at(everything)).toEqual([
      "/assemblies",
      "/figures",
      "/images",
      "/racks/0/programs",
      "/racks/0/slots/0/assembly",
      "/racks/0/slots/0/closeup",
      "/steps/1/assembly",
      "/storyboards",
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

  test("1.1 specs are untouched", () => {
    const spec = {
      meta: { version: "1" },
      nodes: [{ id: "a", type: "server" }],
      racks: [{ id: "r1", slots: [{ at: 1, type: "server-1u" }] }],
      steps: [{ focus: "a" }],
    };
    expect(at(spec)).toEqual([]);
  });

  test.each(["assemblies.md", "document-ingestion.md"])(
    "design examples in %s pass the schema and hit only the guard",
    (file) => {
      const specs = designExamples(file);
      expect(specs.length).toBeGreaterThan(3);
      for (const spec of specs) {
        const r = validate(spec);
        expect(r.diagnostics.filter((d) => d.code.startsWith("schema/"))).toEqual([]);
        expect(r.diagnostics.some((d) => d.code === "assembly/unsupported")).toBe(true);
        expect(r.valid).toBe(false);
      }
    },
  );
});
