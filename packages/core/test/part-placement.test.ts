import { describe, expect, test } from "vitest";
import { validate } from "../src/index.js";
import type { Diagnostic, PartPlacement } from "../src/index.js";

const spec = (units?: string) => ({
  $schema: "https://platformcosmo.io/schema/v1.json",
  meta: { version: "1", title: "t" },
  assemblies: [
    {
      id: "a",
      ...(units ? { units } : {}),
      parts: [
        { id: "p", shape: "box", at: [0, 0, 0], size: [1, 1, 1] },
        { id: "g", parts: [{ id: "q", shape: "hw:dimm", at: [1, 2, 3], count: 2, axis: "x" }] },
      ],
    },
  ],
});
const registry = {
  get: (r: string) => (r === "hw:dimm" ? ({ id: "dimm" } as never) : undefined),
  list: () => ["hw:dimm"],
};
const warn = (n: number): Diagnostic => ({
  severity: "warning",
  code: "x/y",
  path: `/${n}`,
  message: "m",
});

describe("PartPlacement callback", () => {
  test("called once per pack-shape part with resolved units, axis and path; primitives skipped", () => {
    const calls: PartPlacement[] = [];
    validate(spec("stud"), { parts: registry, placement: (p) => (calls.push(p), []) });
    expect(calls).toEqual([
      {
        path: "/assemblies/0/parts/1/parts/0",
        shape: "hw:dimm",
        units: "stud",
        at: [1, 2, 3],
        count: 2,
        axis: "x",
      },
    ]);
    const d: PartPlacement[] = [];
    validate(spec(), { parts: registry, placement: (p) => (d.push(p), []) });
    expect(d[0]!.units).toBe("mm");
  });

  test("diagnostics are included and capped; a throwing callback is contained", () => {
    const r = validate(spec(), {
      parts: registry,
      placement: () => Array.from({ length: 50 }, (_, i) => warn(i)),
    });
    expect(r.diagnostics.filter((d) => d.code === "x/y")).toHaveLength(8);
    const boom = validate(spec(), {
      parts: registry,
      placement: () => {
        throw new Error("boom");
      },
    });
    expect(boom.diagnostics.some((d) => d.code === "x/y")).toBe(false);
  });

  test("not called without a registry", () => {
    let n = 0;
    validate(spec(), { placement: () => (n++, []) });
    expect(n).toBe(0);
  });

  test("groups with at/pitch are checked with kind group and the pack shapes below them", () => {
    const calls: PartPlacement[] = [];
    const brickRegistry = {
      get: (r: string) => (r === "brick:brick" ? ({ id: "brick" } as never) : undefined),
      list: () => ["brick:brick"],
    };
    const wing = {
      $schema: "https://platformcosmo.io/schema/v1.json",
      meta: { version: "1", title: "t" },
      assemblies: [
        {
          id: "a",
          units: "stud",
          parts: [
            {
              id: "wing",
              at: [0.5, 0, 0],
              parts: [{ id: "b", shape: "brick:brick", at: [0, 0, 0], size: [2, 2, 3] }],
            },
            { id: "plain", parts: [{ id: "c", shape: "box", size: [1, 1, 1] }] },
          ],
        },
      ],
    };
    validate(wing, { parts: brickRegistry, placement: (p) => (calls.push(p), []) });
    const group = calls.filter((c) => c.kind === "group");
    expect(group).toEqual([
      {
        path: "/assemblies/0/parts/0",
        kind: "group",
        shapes: ["brick:brick"],
        units: "stud",
        at: [0.5, 0, 0],
      },
    ]);
    // the leaf is still checked on its own, and a group without at/pitch is not called
    expect(calls.filter((c) => c.kind === undefined).map((c) => c.shape)).toEqual(["brick:brick"]);
  });

  test("a non-string suggestion is malformed; more than 8 diagnostics from one part report one info", () => {
    const bad = validate(spec(), {
      parts: registry,
      placement: () => [{ ...warn(1), code: "x/bad", suggestion: { a: 1 } }] as never,
    });
    expect(bad.diagnostics.filter((d) => d.code === "x/bad")).toHaveLength(0);

    const flood = validate(spec(), {
      parts: registry,
      placement: (req) => Array.from({ length: 12 }, (_, i) => ({ ...warn(i), path: req.path })),
    });
    const capped = flood.diagnostics.filter((d) => d.code === "assembly/diagnostics-capped");
    expect(capped.length).toBeGreaterThan(0);
    expect(flood.diagnostics.filter((d) => d.code === "x/y").length).toBe(capped.length * 8);
    expect(capped[0]).toMatchObject({ severity: "info", params: { limit: 8 } });
  });

  test("malformed pack diagnostics are dropped; hitting the call cap reports one info", () => {
    const r = validate(spec(), {
      parts: registry,
      placement: () =>
        [
          warn(1),
          { severity: "fatal", code: "x/y", path: "", message: "m" },
          { severity: "warning", code: 3, path: "", message: "m" },
          null,
          "text",
        ] as never,
    });
    expect(r.diagnostics.filter((d) => d.code === "x/y")).toHaveLength(1);

    const many = {
      ...spec(),
      assemblies: [
        {
          id: "a",
          parts: Array.from({ length: 120 }, (_, i) => ({
            id: `g${i}`,
            parts: Array.from({ length: 200 }, (_, j) => ({ id: `q${j}`, shape: "hw:dimm" })),
          })),
        },
      ],
    };
    let n = 0;
    const big = validate(many, { parts: registry, placement: () => (n++, []) });
    expect(n).toBe(20_000);
    expect(big.diagnostics.filter((d) => d.code === "assembly/diagnostics-capped")).toHaveLength(1);
  });
});
