import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateManifest } from "@platformcosmo/assets";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { PRESET_NAMES, figure } from "../../../tests/fixtures/figures/gen.mjs";

const path = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const SHIPPED = path("../schema/figure-manifest.v1.json");
const TEST_COPY = path("../../assets/test/figure-manifest.v1.json");

describe("schema/figure-manifest.v1.json", () => {
  const schema = JSON.parse(readFileSync(SHIPPED, "utf8"));

  test("is byte-identical to the copy the assets tests validate against", () => {
    expect(readFileSync(SHIPPED, "utf8")).toBe(readFileSync(TEST_COPY, "utf8"));
  });

  test("compiles with Ajv 2020 in strict mode", () => {
    const ajv = new Ajv2020({
      strict: true,
      strictTypes: true,
      strictTuples: true,
      allErrors: true,
    });
    expect(() => ajv.compile(schema)).not.toThrow();
    expect(schema.$id).toBe("https://platformcosmo.io/schema/figure-manifest.v1.json");
  });

  test("agrees with the pipeline's validator on every generated trap manifest", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const check = ajv.compile(schema);
    expect(PRESET_NAMES.length).toBeGreaterThan(8);
    for (const name of PRESET_NAMES) {
      const m = figure(name).manifest;
      expect(check(m), `${name}: ${JSON.stringify(check.errors)}`).toBe(true);
      expect(validateManifest(m).diagnostics, name).toEqual([]);
    }
  });

  test("refuses traversal and absolute source names, extra keys and wrong types", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const check = ajv.compile(schema);
    const part = { id: "a", seeds: { exploded: [[1, 1]] } };
    const bad: unknown[] = [
      { sources: { exploded: "../x.png" }, parts: [part] },
      { sources: { exploded: "/etc/x.png" }, parts: [part] },
      { sources: { exploded: "a\\b.png" }, parts: [part] },
      { sources: { exploded: "x.svg" }, parts: [part] },
      { sources: { exploded: "x.png" }, parts: [part], extra: 1 },
      { sources: {}, parts: [part] },
      { sources: { exploded: "x.png" }, parts: [{ id: "A", seeds: { exploded: [[1, 1]] } }] },
      { sources: { exploded: "x.png" }, parts: [{ id: "a", seeds: { exploded: [[1.5, 1]] } }] },
    ];
    for (const m of bad) {
      expect(check(m), JSON.stringify(m)).toBe(false);
      expect(validateManifest(m).diagnostics.length, JSON.stringify(m)).toBeGreaterThan(0);
    }
  });

  test("is part of the published package", () => {
    expect(pkg.files).toContain("schema");
  });
});
