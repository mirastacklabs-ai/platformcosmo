import { describe, expect, test } from "vitest";
import { createIconResolver, sanitizeSvg } from "../../core/src/icons/index.js";
import { pack } from "../src/index.js";

// Mirrors the SpecNodeType enum in the schema (41 semantic types).
// prettier-ignore
const NODE_TYPES = [
  "server", "vm", "container", "pod", "function", "lb", "gateway", "cdn", "dns", "firewall", "vpc",
  "sql", "nosql", "cache", "object-store", "warehouse", "queue", "stream", "users", "client", "mobile",
  "metrics", "logs", "traces", "repo", "pipeline", "registry", "iam", "secrets", "waf", "llm",
  "embedding", "vector-db", "gpu", "inference-server", "agent", "tool", "rag", "guardrail",
  "feature-store", "training-job",
] as const;

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
