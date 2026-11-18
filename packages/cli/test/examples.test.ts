import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSpec } from "@platformcosmo/core";
import { describe, expect, test } from "vitest";
import { examples, templates } from "../src/examples.gen.js";

const root = fileURLToPath(new URL("../../../examples/", import.meta.url));
const files = (dir: string) =>
  readdirSync(root + dir)
    .filter((f) => f.endsWith(".cosmo.json"))
    .sort();

describe("gallery specs", () => {
  test("launch, DC and provider examples are all present", () => {
    expect(files("").map((f) => f.replace(".cosmo.json", ""))).toEqual(
      expect.arrayContaining([
        "load-balancing",
        "rag-pipeline",
        "kubernetes-deployment",
        "cdn-cache",
        "gpu-inference-cluster",
        "dc-hall",
        "aws-three-tier",
        "azure-web-app",
        "gcp-data-pipeline",
      ]),
    );
  });

  test.each(files(""))("examples/%s validates against schema/v1.json", (f) => {
    const r = validateSpec(JSON.parse(readFileSync(root + f, "utf8")));
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  });

  test.each(files("templates"))("templates/%s validates against schema/v1.json", (f) => {
    const r = validateSpec(JSON.parse(readFileSync(`${root}templates/${f}`, "utf8")));
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
  });

  test.each(files("templates").filter((f) => f.startsWith("lesson-")))(
    "lesson %s has at least 2 steps with captions",
    (f) => {
      const spec = JSON.parse(readFileSync(`${root}templates/${f}`, "utf8")) as {
        steps?: { caption?: string }[];
      };
      expect(spec.steps?.length ?? 0).toBeGreaterThanOrEqual(2);
      for (const s of spec.steps ?? []) expect(s.caption?.length ?? 0).toBeGreaterThan(0);
    },
  );

  test("src/examples.gen.ts is up to date (run: scripts/pc run gen:examples)", () => {
    const names = (list: readonly { name: string }[]) => list.map((e) => e.name);
    expect(names(examples)).toEqual(files("").map((f) => f.replace(".cosmo.json", "")));
    expect(names(templates)).toEqual(files("templates").map((f) => f.replace(".cosmo.json", "")));
    for (const e of examples)
      expect(e.json).toBe(readFileSync(`${root}${e.name}.cosmo.json`, "utf8"));
    for (const t of templates)
      expect(t.json).toBe(readFileSync(`${root}templates/${t.name}.cosmo.json`, "utf8"));
  });
});
