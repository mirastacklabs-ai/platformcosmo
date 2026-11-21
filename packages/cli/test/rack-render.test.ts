// W-2: a rack in assembly mode drawn in its hall (assemblies 8.1, 9.1): it shares the depth order
// with the other objects and cable segments, cables (and their particles) hide while a slot they
// touch is displaced, the rack keeps its 1.1 label, and the rear-door heat exchanger slides out
// clear of the posts. Phase 2 is still gated: scenes come from `buildScene` directly and renders
// from `createRender` with the guard dropped from validate (as closeup-cli.test.ts does).
import { readFileSync } from "node:fs";
import * as core from "@platformcosmo/core";
import { dcPack } from "@platformcosmo/dc-pack";
import { themeRegistry } from "@platformcosmo/themes";
import { describe, expect, test } from "vitest";

type Obj = Record<string, unknown>;
const hall = JSON.parse(
  readFileSync(new URL("../../../examples/dc-hall.cosmo.json", import.meta.url), "utf8"),
) as Obj;
/** The hall with one rack exploded (its drawers) in step 1 and imploded in step 2. */
const targeting = (rack: string): core.PlatformCosmoSpec =>
  ({
    ...hall,
    steps: [
      { duration: 6, assembly: [{ explode: rack }] },
      { duration: 4, assembly: [{ implode: rack }] },
    ],
  }) as unknown as core.PlatformCosmoSpec;

const modelOf = (spec: core.PlatformCosmoSpec): core.RenderModel =>
  core.buildModel({
    scene: core.buildScene(spec, { dc: dcPack }),
    theme: themeRegistry.get("light")!,
    font: "system",
    prefix: "pc-t",
    spec,
  });

/** Element ids of a layer in document order. */
const idsOf = (nodes: readonly core.SvgNode[], out: string[] = []): string[] => {
  for (const n of nodes) {
    if (typeof n !== "object" || n === null || !("tag" in n)) continue;
    const id = n.attrs?.["id"];
    if (typeof id === "string") out.push(id);
    idsOf(n.children ?? [], out);
  }
  return out;
};

const lifted: typeof core.validate = (s, c) => {
  const r = core.validate(s, c);
  const diagnostics = r.diagnostics.filter(
    (d) =>
      d.code !== "assembly/unsupported" &&
      !(
        d.code === "assembly/unknown-target" &&
        /^\/steps\/\d+\/assembly\/\d+\/(explode|implode)$/.test(d.path)
      ),
  );
  return { valid: !diagnostics.some((d) => d.severity === "error"), spec: s as never, diagnostics };
};
const render = core.createRender({
  validate: lifted,
  buildScene: core.buildScene,
  createAnimator: core.createAnimator,
  exportOutputs: core.exportOutputs,
  rasterize: core.rasterize,
  emit: core.emit,
  optimize: core.optimize,
});

describe("one depth order for the hall and the rack in assembly mode (9.1)", () => {
  test("a targeted rack behind its neighbour is drawn behind it, from t = 0", () => {
    // A1 stands behind A2 in row A: A1's base plate overlaps A2's flash array on screen
    const order = idsOf(modelOf(targeting("rack-a1")).layers.objects);
    const a1Base = order.indexOf("pc-t-o_rack-a1.frame.base");
    const a2Array = order.indexOf("pc-t-o_rack-a2.array");
    expect(a1Base).toBeGreaterThanOrEqual(0);
    expect(a2Array).toBeGreaterThanOrEqual(0);
    expect(a1Base).toBeLessThan(a2Array);
  });

  test("a targeted rack in front of its neighbour is drawn in front of it", () => {
    const order = idsOf(modelOf(targeting("rack-a2")).layers.objects);
    // the flash array's chassis overlaps A1 on screen (the pair of the case above)
    const a1 = order.indexOf("pc-t-o_rack-a1");
    const chassis = order.indexOf("pc-t-o_rack-a2.array.chassis");
    expect(a1).toBeGreaterThanOrEqual(0);
    expect(chassis).toBeGreaterThan(a1);
  });

  test("an untargeted rack keeps its forced order: rack, slot devices, front shell", () => {
    const order = idsOf(modelOf(targeting("rack-a1")).layers.objects);
    const rack = order.indexOf("pc-t-o_rack-a2");
    const slot = order.indexOf("pc-t-o_rack-a2.array");
    const front = order.indexOf("pc-t-o_rack-a2_5ffront");
    expect(rack).toBeLessThan(slot);
    expect(slot).toBeLessThan(front);
  });

  test("the rack keeps its 1.1 label", () => {
    const labels = JSON.stringify(modelOf(targeting("rack-a1")).layers.labels);
    expect(labels).toContain('"A1"');
  });
});

describe("cables at a displaced slot hide meanwhile (8.1)", () => {
  test("uplink-a's segments and particles fade out while rack-a1/tor is out, and come back", () => {
    const m = modelOf(targeting("rack-a1"));
    const fades = m.assembly!.staticFades;
    const cable = fades.filter((f) => f.key.startsWith("cable_uplink-a_"));
    expect(cable.length).toBeGreaterThan(0);
    // a cable that touches no displaced slot keeps no fade
    expect(fades.some((f) => f.key.startsWith("cable_uplink-b_"))).toBe(false);
    const at = (t: number): number[] => cable.map((f) => m.assembly!.frameAt(t).opacity[f.id]!);
    expect(new Set(at(0))).toEqual(new Set([1]));
    expect(new Set(at(3))).toEqual(new Set([0])); // drawers out
    expect(new Set(at(m.assembly!.loop - 0.01))).toEqual(new Set([1])); // imploded again
    // particles on that cable ride in a wrapper with the same fade
    const flow = fades.filter((f) => f.key.startsWith("flow_"));
    expect(flow.length).toBeGreaterThan(0);
    expect(m.assembly!.frameAt(3).opacity[flow[0]!.id]).toBe(0);
  });

  test("the animated render wraps those particles in the fade and animates it", async () => {
    const r = await render(targeting("rack-a1"), {
      dc: dcPack,
      themes: themeRegistry,
      font: "system",
      outputs: ["animated"],
      optimize: false,
    });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const svg = String(r.outputs.find((o) => o.kind === "animated")!.data);
    const wrap = /<g id="([^"]*-fw_flow_5f[^"]*)"><g id="[^"]*-fl_/.exec(svg);
    expect(wrap).not.toBeNull();
    expect(svg).toContain(`#${wrap![1]}{`);
  }, 120000);
});

describe("the rear-door heat exchanger (rack-b1)", () => {
  test("slides out between the rear posts: no transit collision", async () => {
    const r = await render(targeting("rack-b1"), {
      dc: dcPack,
      themes: themeRegistry,
      font: "system",
      outputs: ["static"],
    });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.diagnostics.filter((d) => d.code.endsWith("collision"))).toEqual([]);
  }, 120000);
});
