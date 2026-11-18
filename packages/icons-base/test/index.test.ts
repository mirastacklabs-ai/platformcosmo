import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createIconResolver, sanitizeSvg } from "../../core/src/icons/index.js";
import type { SpecNodeType } from "../../core/src/index.js";
import { pack } from "../src/index.js";
import { expectNoDrift } from "./drift.js";

// The semantic node types come from the schema itself (single source of truth).
function findNodeTypes(node: unknown): string[] | undefined {
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.title === "SpecNodeType" && Array.isArray(o.enum)) return o.enum as string[];
    for (const v of Object.values(o)) {
      const r = findNodeTypes(v);
      if (r) return r;
    }
  }
  return undefined;
}
const schema: unknown = JSON.parse(
  readFileSync(new URL("../../../schema/v1.json", import.meta.url), "utf8"),
);
const NODE_TYPES = (findNodeTypes(schema) ?? []) as SpecNodeType[];

describe("icons-base", () => {
  const resolver = createIconResolver([pack], sanitizeSvg);

  test("pack metadata", () => {
    expect(pack.manifest.pack).toMatchObject({
      id: "cosmo",
      license: "Apache-2.0",
      redistributable: true,
    });
    expect(NODE_TYPES).toHaveLength(41);
  });

  test("generated module matches icons.json and svg/ (run gen-pack.mjs after editing sources)", () => {
    expectNoDrift(pack, new URL("../", import.meta.url));
  });

  test("defines a default icon for all 41 node types, each resolvable", () => {
    for (const t of NODE_TYPES) {
      const ref = resolver.defaultFor(t);
      expect(ref, t).toBe(`cosmo:${t}`);
      expect(resolver.resolve(ref as string), t).toBeDefined();
    }
  });

  test("every manifest file exists, sanitizes cleanly and stays within the 8 KB budget", () => {
    for (const e of pack.manifest.icons) {
      const raw = pack.files[e.file];
      expect(raw, e.id).toBeTypeOf("string");
      const r = sanitizeSvg(raw as string, { monochrome: e.monochrome });
      expect(r.ok, e.id).toBe(true);
      if (r.ok) {
        expect(r.removed, e.id).toEqual([]);
        expect(r.svg.body.length, e.id).toBeLessThanOrEqual(8192);
        expect(r.svg.viewBox).toBe("0 0 24 24");
      }
    }
  });

  test("ids and aliases are unique, kebab-case; files are unique", () => {
    const seen = new Set<string>();
    for (const e of pack.manifest.icons) {
      expect(e.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      for (const k of [e.id, ...e.aliases]) {
        expect(seen.has(k), k).toBe(false);
        seen.add(k);
      }
    }
    expect(new Set(pack.manifest.icons.map((e) => e.file)).size).toBe(pack.manifest.icons.length);
  });

  test("aliases resolve to their icon", () => {
    expect(resolver.resolve("cosmo:lambda")?.ref).toBe("cosmo:function");
    expect(resolver.resolve("cosmo:load-balancer")?.ref).toBe("cosmo:lb");
  });
});
