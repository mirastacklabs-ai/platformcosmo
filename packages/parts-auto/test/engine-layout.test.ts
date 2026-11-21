import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Box3, PartShapeDef } from "@platformcosmo/core";
import { render } from "@platformcosmo/core";
import { themeRegistry } from "@platformcosmo/themes";
import { engineLayout, registry } from "../src/index.js";
import { engineSpec } from "./engine-spec.js";

type V3 = readonly [number, number, number];
interface Placed {
  part: string;
  prim: string;
  box: Box3;
}

/** Every drawn primitive of the default engine at its documented anchors, in the block's frame. */
function placed(n: number): Placed[] {
  const L = engineLayout(n);
  const out: Placed[] = [];
  const put = (part: string, ref: string, at: V3, size?: V3): void => {
    const def = registry.get(ref) as PartShapeDef;
    const d = def.defaultSize;
    const sz: V3 = size ?? [d.x, d.y, d.z];
    const g = def.build(
      { cylinders: n },
      {
        size: { x: sz[0], y: sz[1], z: sz[2] },
        units: "mm",
        axis: "z",
        tone: "base",
        state: "healthy",
      },
    );
    for (const p of g.primitives) {
      out.push({
        part,
        prim: p.id,
        box: {
          origin: {
            x: at[0] + p.box.origin.x,
            y: at[1] + p.box.origin.y,
            z: at[2] + p.box.origin.z,
          },
          size: p.box.size,
        },
      });
    }
  };
  put("block", "auto:block-i4", L.at.block);
  put("crankshaft", "auto:crankshaft", L.at.crankshaft);
  put("oil-pan", "auto:oil-pan", L.at["oil-pan"]);
  put("head", "auto:head", L.at.head);
  put("valve-cover", "auto:valve-cover", L.at["valve-cover"]);
  put("intake", "auto:intake", L.at.intake);
  put("exhaust", "auto:exhaust", L.at.exhaust);
  put("cam-intake", "auto:camshaft", L.at["cam-intake"]);
  put("cam-exhaust", "auto:camshaft", L.at["cam-exhaust"]);
  // The head gasket is a plain plate (not an auto: shape).
  const [gx, gy, gz] = L.at["head-gasket"];
  const [gw, gd, gh] = L.size["head-gasket"];
  out.push({
    part: "head-gasket",
    prim: "plate",
    box: { origin: { x: gx, y: gy, z: gz }, size: { x: gw, y: gd, z: gh } },
  });
  for (let i = 0; i < n; i++) {
    put(`rod-${i}`, "auto:rod", L.at.rod[i]!, L.size.rod);
    put(`piston-${i}`, "auto:piston", L.at.piston[i]!, L.size.piston);
  }
  return out;
}

const AX = ["x", "y", "z"] as const;
const overlap = (a: Box3, b: Box3): boolean =>
  AX.every(
    (k) =>
      Math.min(a.origin[k] + a.size[k], b.origin[k] + b.size[k]) -
        Math.max(a.origin[k], b.origin[k]) >
      1e-6,
  );

const INTERNAL = /^(crankshaft|rod-\d+|piston-\d+|cam-intake|cam-exhaust)$/;

/** The declared contacts: internals sit inside their housing; a rod wraps its pin and its piston. */
function declared(a: Placed, b: Placed): boolean {
  const pair = (x: Placed, y: Placed): boolean => {
    if (x.part === "block" && x.prim === "body") return INTERNAL.test(y.part);
    // The bore plug is the deck's top millimetre; the piston in that bore reaches it.
    if (x.part === "block" && /^bore-\d+$/.test(x.prim)) {
      return y.part === `piston-${x.prim.slice(5)}`;
    }
    if (x.part === "head" && x.prim === "casting") return /^cam-/.test(y.part);
    const rod = /^rod-(\d+)$/.exec(x.part);
    if (rod === null) return false;
    if (y.part === `piston-${rod[1]}`) return true;
    return y.part === "crankshaft" && x.prim === "big-end" && y.prim === `pin-${rod[1]}`;
  };
  return pair(a, b) || pair(b, a);
}

describe("default engine at its documented anchors (assemblies 5.2)", () => {
  test.each([2, 3, 4, 5, 6, 7, 8])(
    "%i cylinders: no two parts interpenetrate except the declared contacts",
    (n) => {
      const ps = placed(n);
      const bad: string[] = [];
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const [a, b] = [ps[i]!, ps[j]!];
          if (a.part === b.part || declared(a, b) || !overlap(a.box, b.box)) continue;
          bad.push(`${a.part}/${a.prim} x ${b.part}/${b.prim}`);
        }
      }
      expect(bad).toEqual([]);
    },
  );

  test("the contacts really exist: the checker can fail", () => {
    const ps = placed(4);
    const hits = (part: string, other: RegExp): number =>
      ps
        .filter((a) => a.part === part)
        .filter((a) => ps.some((b) => other.test(b.part) && overlap(a.box, b.box))).length;
    expect(hits("rod-0", /^crankshaft$/)).toBeGreaterThan(0); // big end around pin-0
    expect(hits("rod-0", /^piston-0$/)).toBeGreaterThan(0); // small end inside the piston
    expect(hits("piston-0", /^block$/)).toBeGreaterThan(0);
  });

  test("bores, pistons, rods and crank throws share one pitch and centre line", () => {
    const L = engineLayout(4);
    expect(L.borePitch).toBe(105);
    expect(L.boreX).toEqual([52.5, 157.5, 262.5, 367.5]);
    const ps = placed(4);
    const crown = (i: number): Box3 =>
      ps.find((p) => p.part === `piston-${i}` && p.prim === "crown")!.box;
    const pin = (i: number): Box3 =>
      ps.find((p) => p.part === "crankshaft" && p.prim === `pin-${i}`)!.box;
    const bore = (i: number): Box3 =>
      ps.find((p) => p.part === "block" && p.prim === `bore-${i}`)!.box;
    const centre = (b: Box3, k: "x" | "y" | "z"): number => b.origin[k] + b.size[k] / 2;
    for (let i = 0; i < 4; i++) {
      expect(centre(bore(i), "x")).toBeCloseTo(L.boreX[i]!, 2);
      expect(centre(crown(i), "x")).toBeCloseTo(L.boreX[i]!, 2);
      expect(centre(pin(i), "x")).toBeCloseTo(L.boreX[i]!, 2);
      expect(centre(crown(i), "y")).toBeCloseTo(115, 2);
      expect(centre(pin(i), "y")).toBeCloseTo(115, 2);
      expect(centre(pin(i), "z")).toBeCloseTo(L.pinZ[i]!, 2);
    }
    // Throws: down, up, up, down around the axis at z 74; the up pistons' crowns sit on the deck.
    expect(L.pinZ).toEqual([44, 104, 104, 44]);
    expect(crown(1).origin.z + crown(1).size.z).toBeCloseTo(260, 2);
  });

  test("head, gasket and valve cover cover the block deck", () => {
    const ps = placed(4);
    const box = (part: string, prim: string): Box3 =>
      ps.find((p) => p.part === part && p.prim === prim)!.box;
    const deck = box("block", "body");
    for (const [part, prim] of [
      ["head-gasket", "plate"],
      ["head", "casting"],
    ] as const) {
      const b = box(part, prim);
      expect([b.origin.x, b.origin.y, b.size.x, b.size.y]).toEqual([
        deck.origin.x,
        deck.origin.y,
        deck.size.x,
        deck.size.y,
      ]);
    }
    // Manifold runners line up with the head ports (one per bore).
    const L = engineLayout(4);
    for (let i = 0; i < 4; i++) {
      const runner = box("intake", `runner-${i}`);
      const port = box("head", `int-port-${i}-0`);
      expect(runner.origin.x + runner.size.x / 2).toBeCloseTo(L.boreX[i]!, 2);
      expect(port.origin.x + port.size.x / 2).toBeCloseTo(L.boreX[i]!, 2);
    }
  });
});

describe("default engine, three-stage explode (rendered)", () => {
  test.each([4, 6])(
    "%i cylinders: no errors, no warnings, no transit-collision",
    async (n) => {
      const r = await render(engineSpec(n), {
        parts: registry,
        theme: themeRegistry.get("light")!,
        font: "system",
        outputs: ["static"],
      });
      const bad = r.diagnostics.filter((d) => d.severity !== "info");
      expect(bad.map((d) => `${d.severity} ${d.code} ${d.message}`)).toEqual([]);
      expect(r.diagnostics.some((d) => d.code === "assembly/transit-collision")).toBe(false);
      expect(r.scene).toBeDefined();
    },
    120_000,
  );
});

describe("assemblies.md section 19.3 engine (rendered)", () => {
  test("the example renders with no warnings or errors, and no transit-collision", async () => {
    const md = readFileSync(
      fileURLToPath(new URL("../../../docs/design/assemblies.md", import.meta.url)),
      "utf8",
    );
    const at = md.indexOf("### 19.3");
    const json = /```json\n([\s\S]*?)```/.exec(md.slice(at, md.indexOf("### 19.4")))![1]!;
    const r = await render(JSON.parse(json), {
      parts: registry,
      theme: themeRegistry.get("light")!,
      font: "system",
      outputs: ["static", "steps"],
    });
    const bad = r.diagnostics.filter((d) => d.severity !== "info");
    expect(bad.map((d) => `${d.severity} ${d.code} ${d.message}`)).toEqual([]);
    expect(r.outputs.length).toBeGreaterThan(0);
  }, 120_000);
});
