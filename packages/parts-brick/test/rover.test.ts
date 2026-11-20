import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PartGeometry, PartTone, PlatformCosmoSpec } from "@platformcosmo/core";
import { buildScene, STUD_HEIGHT } from "@platformcosmo/core";
import { checkBrickPlacement, registry } from "../src/index.js";

// assemblies.md section 19.5: the generic brick rover must build from these shapes.
const md = readFileSync(
  fileURLToPath(new URL("../../../docs/design/assemblies.md", import.meta.url)),
  "utf8",
);

interface Leaf {
  path: string;
  shape: string;
  at?: number[];
  pitch?: number[];
  count?: number;
  size: [number, number, number];
  axis?: "x" | "y" | "z";
  params?: Record<string, unknown>;
  color?: string;
  tone?: PartTone;
  units: string;
}

type Json = Record<string, unknown>;

function leaves(node: unknown, units: string, path: string, out: Leaf[]): void {
  if (Array.isArray(node)) node.forEach((n, i) => leaves(n, units, `${path}/${i}`, out));
  else if (node && typeof node === "object") {
    const o = node as Json;
    if (typeof o["shape"] === "string" && (o["shape"] as string).startsWith("brick:")) {
      out.push({ ...(o as unknown as Leaf), path, units });
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === "parts") leaves(v, units, `${path}/parts`, out);
    }
  }
}

function rover(): { spec: PlatformCosmoSpec; leaves: Leaf[] } {
  const block = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => m[1] as string)
    .find((b) => b.includes("Brick rover"));
  const spec = JSON.parse(block as string) as PlatformCosmoSpec;
  const out: Leaf[] = [];
  (spec.assemblies ?? []).forEach((a, i) =>
    leaves((a as unknown as Json)["parts"], a.units ?? "mm", `/assemblies/${i}/parts`, out),
  );
  return { spec, leaves: out };
}

const R = rover();

describe("section 19.5 generic brick rover", () => {
  test("uses every brick: shape except none missing, and 33 leaves after count", () => {
    const shapes = new Set(R.leaves.map((l) => l.shape));
    expect([...shapes].sort()).toEqual(
      ["brick:brick", "brick:plate", "brick:round", "brick:slope", "brick:tile"].sort(),
    );
    expect(R.leaves.reduce((n, l) => n + (l.count ?? 1), 0)).toBe(33);
  });

  test.each(R.leaves.map((l) => [l.path, l] as const))(
    "%s builds at its exact size and params",
    (_path, l) => {
      const def = registry.get(l.shape);
      expect(def, l.shape).toBeDefined();
      const r = def!.readParams(l.params ?? {});
      expect(r.diagnostics).toEqual([]);
      const g: PartGeometry = def!.build(r.params, {
        size: { x: l.size[0], y: l.size[1], z: l.size[2] },
        units: "stud",
        axis: l.axis ?? "z",
        tone: l.tone ?? "base",
        state: "healthy",
        ...(l.color !== undefined ? { color: l.color as never } : {}),
      });
      // The body fills the spec size exactly; studs add one stud height on top.
      expect(g.depthBox).toEqual({
        origin: { x: 0, y: 0, z: 0 },
        size: { x: l.size[0], y: l.size[1], z: l.size[2] },
      });
      const studs = g.primitives.filter((p) => p.kind === "stud");
      expect(g.bounds.size.x).toBe(l.size[0]);
      expect(g.bounds.size.y).toBe(l.size[1]);
      expect(
        Math.abs(g.bounds.size.z - (l.size[2] + (studs.length > 0 ? STUD_HEIGHT : 0))),
      ).toBeLessThan(0.011);
      // tiles and side-axis rounds carry no studs; bricks, plates and top rounds do
      const flat =
        l.shape === "brick:tile" || (l.shape === "brick:round" && (l.axis ?? "z") !== "z");
      expect(studs.length > 0).toBe(!flat);
      // never a diagnostic from the placement checker
      expect(
        checkBrickPlacement({
          path: l.path,
          shape: l.shape,
          units: l.units,
          ...(l.at ? { at: l.at } : {}),
          ...(l.pitch ? { pitch: l.pitch } : {}),
          ...(l.count ? { count: l.count } : {}),
          size: l.size,
          ...(l.axis ? { axis: l.axis } : {}),
          params: l.params,
        }),
      ).toEqual([]);
    },
  );

  test("the whole spec builds a scene through the registry without diagnostics", () => {
    const scene = buildScene(R.spec, { parts: registry });
    const problems = scene.diagnostics.filter(
      (d) => d.severity === "error" || d.severity === "warning",
    );
    expect(problems).toEqual([]);
    expect(scene.assemblies?.assemblies.length).toBe(1);
  });
});
