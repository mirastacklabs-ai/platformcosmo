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
});
