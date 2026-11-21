/**
 * The manifest validator agrees with the strict JSON Schema of ingestion §6.1 (a copy of what D-2a
 * commits as packages/cli/schema/figure-manifest.v1.json, compiled here with Ajv 2020 strict), and
 * adds the semantic rules the pipeline needs.
 */
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/index.js";
import example from "./figure-manifest.example.json" with { type: "json" };
import schema from "./figure-manifest.v1.json" with { type: "json" };

const ajv = new Ajv2020({ strict: true, allErrors: true });
const compiled = ajv.compile(schema);

const min = () => ({
  sources: { exploded: "fig.png" },
  parts: [{ id: "a", seeds: { exploded: [[10, 20]] } }],
});
type M = ReturnType<typeof min> & Record<string, unknown>;
const withPart = (p: Record<string, unknown>): M => ({
  ...min(),
  parts: [{ id: "a", seeds: { exploded: [[10, 20]] }, ...p }],
});
const withAnn = (a: unknown): M => ({ ...min(), annotations: [a] });
const pt = (x: unknown, y: unknown = 2) => withPart({ seeds: { exploded: [[x, y]] } });

const VALID: [string, unknown][] = [
  ["the design example", example],
  ["a minimal manifest", min()],
  [
    "one image with a region per state",
    {
      sources: { exploded: "fig.png" },
      regions: { exploded: [0, 0, 100, 80], assembled: [0, 80, 100, 80] },
      parts: [{ id: "a", seeds: { exploded: [[1, 1]], assembled: [[1, 90]] } }],
    },
  ],
  [
    "every optional part field",
    withPart({
      group: "g",
      instanceOf: "k",
      polygon: {
        exploded: [
          [0, 0],
          [5, 5],
        ],
      },
      prior: "cylinder",
      nearest: { exploded: [3, 4] },
      holes: true,
      allowDisjoint: false,
      z: -1000,
    }),
  ],
  [
    "text, arrow and leader annotations",
    {
      ...min(),
      annotations: [
        { kind: "text", state: "exploded", rect: [1, 2, 3, 4] },
        {
          kind: "arrow",
          state: "exploded",
          polyline: [
            [0, 0],
            [9, 9],
          ],
          width: 32,
        },
        {
          kind: "leader",
          state: "exploded",
          polyline: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    },
  ],
  [
    "a colour background, base and erase",
    { ...min(), background: "#A0b0C0", base: "exploded", erase: "fill" },
  ],
  [
    "a nested relative path with spaces",
    { ...min(), sources: { exploded: "figs/page 3/fig-1.JPEG" } },
  ],
];

const INVALID: [string, unknown][] = [
  ["not an object", []],
  ["no sources", { parts: min().parts }],
  ["empty sources", { ...min(), sources: {} }],
  ["an unknown top-level property", { ...min(), extra: 1 }],
  ["an unknown source state", { ...min(), sources: { exploded: "a.png", side: "b.png" } }],
  ["an absolute path", { ...min(), sources: { exploded: "/etc/a.png" } }],
  ["a backslash path", { ...min(), sources: { exploded: "\\\\server\\a.png" } }],
  ["a parent segment", { ...min(), sources: { exploded: "a/../b.png" } }],
  ["a leading parent", { ...min(), sources: { exploded: "../b.png" } }],
  ["a gif", { ...min(), sources: { exploded: "a.gif" } }],
  ["a file name over 512", { ...min(), sources: { exploded: `${"a".repeat(510)}.png` } }],
  ["no parts", { sources: min().sources }],
  ["zero parts", { ...min(), parts: [] }],
  [
    "65 parts",
    {
      ...min(),
      parts: Array.from({ length: 65 }, (_, i) => ({ id: `p${i}`, seeds: { exploded: [[1, 1]] } })),
    },
  ],
  ["a part without seeds", { ...min(), parts: [{ id: "a" }] }],
  ["an uppercase id", withPart({ id: "A" })],
  ["an id of 65 characters", withPart({ id: "a".repeat(65) })],
  ["an unknown part property", withPart({ colour: "red" })],
  ["empty seeds", withPart({ seeds: {} })],
  ["an empty seed list", withPart({ seeds: { exploded: [] } })],
  ["33 seeds", withPart({ seeds: { exploded: Array.from({ length: 33 }, () => [1, 1]) } })],
  ["a one-number point", withPart({ seeds: { exploded: [[1]] } })],
  ["a negative coordinate", pt(-1)],
  ["a fractional coordinate", pt(1.5)],
  ["a coordinate over 16384", pt(16385)],
  ["a string coordinate", pt("1")],
  ["a one-point polygon", withPart({ polygon: { exploded: [[1, 1]] } })],
  ["an unknown prior", withPart({ prior: "sphere" })],
  ["z out of range", withPart({ z: 1001 })],
  ["a fractional z", withPart({ z: 1.5 })],
  ["a string boolean", withPart({ holes: "yes" })],
  ["a bad nearest", withPart({ nearest: { exploded: [1, 2, 3] } })],
  [
    "129 annotations",
    {
      ...min(),
      annotations: Array.from({ length: 129 }, () => ({
        kind: "text",
        state: "exploded",
        rect: [0, 0, 1, 1],
      })),
    },
  ],
  [
    "a text annotation with a polyline",
    withAnn({
      kind: "text",
      state: "exploded",
      polyline: [
        [0, 0],
        [1, 1],
      ],
    }),
  ],
  ["an arrow without polyline", withAnn({ kind: "arrow", state: "exploded" })],
  ["a one-point polyline", withAnn({ kind: "leader", state: "exploded", polyline: [[0, 0]] })],
  [
    "a width of 0",
    withAnn({
      kind: "arrow",
      state: "exploded",
      polyline: [
        [0, 0],
        [1, 1],
      ],
      width: 0,
    }),
  ],
  [
    "a width of 33",
    withAnn({
      kind: "arrow",
      state: "exploded",
      polyline: [
        [0, 0],
        [1, 1],
      ],
      width: 33,
    }),
  ],
  ["an unknown state", withAnn({ kind: "text", state: "middle", rect: [0, 0, 1, 1] })],
  ["an unknown kind", withAnn({ kind: "circle", state: "exploded", rect: [0, 0, 1, 1] })],
  ["a three-number rect", withAnn({ kind: "text", state: "exploded", rect: [0, 0, 1] })],
  ["a short colour", { ...min(), background: "#fff" }],
  ["a named colour", { ...min(), background: "red" }],
  ["an unknown base", { ...min(), base: "side" }],
  ["an unknown erase", { ...min(), erase: "smudge" }],
  ["empty regions", { ...min(), regions: {} }],
];

describe("figure manifest validation", () => {
  it.each(VALID)("accepts %s (and so does the schema)", (_name, m) => {
    expect(compiled(m), JSON.stringify(compiled.errors)).toBe(true);
    const r = validateManifest(m);
    expect(r.diagnostics).toEqual([]);
    expect(r.value).toBe(m);
  });

  it.each(INVALID)("rejects %s (and so does the schema)", (_name, m) => {
    expect(compiled(m)).toBe(false);
    const r = validateManifest(m);
    expect(r.value).toBeUndefined();
    expect(r.diagnostics.length).toBeGreaterThan(0);
    for (const d of r.diagnostics) {
      expect(d.severity).toBe("error");
      expect(["asset/bad-option", "asset/too-large"]).toContain(d.code);
    }
  });

  it("points to the offending value with a JSON pointer", () => {
    const r = validateManifest(
      withPart({
        seeds: {
          exploded: [
            [1, 2],
            [3, -4],
          ],
        },
      }),
    );
    expect(r.diagnostics.map((d) => [d.path, d.params?.option])).toEqual([
      ["/parts/0/seeds/exploded/1", "manifest"],
    ]);
    expect(
      validateManifest(INVALID.find((x) => x[0] === "65 parts")![1]).diagnostics[0]!.code,
    ).toBe("asset/too-large");
  });

  it.each([
    ["duplicate part ids", { ...min(), parts: [min().parts[0], min().parts[0]] }, "/parts/1/id"],
    [
      "seeds in a state that is not drawn",
      withPart({ seeds: { assembled: [[1, 1]] } }),
      "/parts/0/seeds/assembled",
    ],
    [
      "an annotation in a state that is not drawn",
      withAnn({ kind: "text", state: "assembled", rect: [0, 0, 1, 1] }),
      "/annotations/0/state",
    ],
    ["a base that is not drawn", { ...min(), base: "assembled" }, "/base"],
    [
      "a group mixing two instance classes",
      {
        ...min(),
        parts: [
          { id: "a", group: "g", instanceOf: "x", seeds: { exploded: [[1, 1]] } },
          { id: "b", group: "g", instanceOf: "y", seeds: { exploded: [[2, 2]] } },
        ],
      },
      "/parts/1/instanceOf",
    ],
    [
      "a group id that names a part of another group",
      {
        ...min(),
        parts: [
          { id: "a", group: "b", seeds: { exploded: [[1, 1]] } },
          { id: "b", group: "c", seeds: { exploded: [[2, 2]] } },
        ],
      },
      "/parts",
    ],
  ] as const)("rejects %s (semantic rule; the schema allows it)", (_name, m, path) => {
    expect(compiled(m)).toBe(true);
    const r = validateManifest(m);
    expect(r.value).toBeUndefined();
    expect(r.diagnostics.map((d) => d.path)).toContain(path);
  });

  it("bounds the report of a hostile manifest", () => {
    const parts = Array.from({ length: 64 }, () => ({
      id: "BAD",
      seeds: { exploded: Array.from({ length: 32 }, () => [-1, -1]) },
      x: 1,
      y: 2,
    }));
    const r = validateManifest({ sources: { exploded: "a.png" }, parts });
    expect(r.diagnostics.length).toBeLessThanOrEqual(50);
  });
});
