// W-2: a rack in assembly mode drawn in its hall (assemblies 8.1, 9.1): it shares the depth order
// with the other objects and cable segments, cables (and their particles) hide while a slot they
// touch is displaced, the rack keeps its 1.1 label, and the rear-door heat exchanger slides out
// clear of the posts. Scenes come from `buildScene` directly, renders from `createRender`.
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

/** The shipped validate: phase 2 is lifted (D-4a). */
const lifted: typeof core.validate = core.validate;
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

/** The hall with two racks exploded together (their drawers meet in the aisle between rows). */
const both: core.PlatformCosmoSpec = {
  ...(hall as object),
  steps: [{ duration: 6, assembly: [{ explode: "rack-a1" }, { explode: "rack-b1" }] }],
} as unknown as core.PlatformCosmoSpec;

/** Every element of a layer, depth first. */
const elementsOf = (
  nodes: readonly core.SvgNode[],
  out: core.SvgElement[] = [],
): core.SvgElement[] => {
  for (const n of nodes) {
    if (typeof n !== "object" || n === null || !("tag" in n)) continue;
    out.push(n);
    elementsOf(n.children ?? [], out);
  }
  return out;
};

describe("particles of a hidden-while-displaced flow (8.1, D31)", () => {
  test("a DC flow's fade wrapper stays in the DC flow layer, above the objects", async () => {
    const r = await render(targeting("rack-a1"), {
      dc: dcPack,
      themes: themeRegistry,
      font: "system",
      outputs: ["animated"],
      optimize: false,
    });
    const svg = String(r.outputs.find((o) => o.kind === "animated")!.data);
    const wraps = [...svg.matchAll(/<g id="[^"]*-fw_flow_5fdc_5ff_5f\d+"/g)].map((m) => m.index!);
    expect(wraps.length).toBeGreaterThan(0);
    const objects = svg.indexOf('-ly_objects"');
    const dcflows = svg.indexOf('-ly_dcflows"');
    expect(objects).toBeGreaterThan(0);
    expect(dcflows).toBeGreaterThan(objects);
    for (const w of wraps) expect(w).toBeGreaterThan(dcflows);
  }, 120000);

  test("the rack's own flows (hidden edges) fade while their slot is out (19.4)", () => {
    const md = readFileSync(new URL("../../../docs/design/assemblies.md", import.meta.url), "utf8");
    const json = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => m[1] as string)
      .find((j) => j.includes('"title": "Rack to server to internals"'))!;
    const m = modelOf(JSON.parse(json) as core.PlatformCosmoSpec);
    // dc_p_2 / dc_n_4 run to the app server's slot (flows dc_f_3, dc_f_5), on hidden edges
    const keys = m.assembly!.staticFades.map((f) => f.key);
    for (const k of ["flow_dc_f_3", "flow_dc_f_5"]) expect(keys, k).toContain(k);
    const flows = m.assembly!.staticFades.filter((f) => /^flow_dc_f_[2-5]$/.test(f.key));
    const at = (t: number): number[] => flows.map((f) => m.assembly!.frameAt(t).opacity[f.id]!);
    expect(new Set(at(0))).toEqual(new Set([1]));
    expect(new Set(at(4))).toEqual(new Set([0])); // the drawers are out
    expect(new Set(at(m.assembly!.loop - 0.01))).toEqual(new Set([1])); // racked again
  });
});

describe("two racks targeted together", () => {
  test("depth diagnostics of a rack-only spec point at /racks/<i> (N2)", async () => {
    const r = await render(both, {
      dc: dcPack,
      themes: themeRegistry,
      font: "system",
      outputs: ["static"],
    });
    const depth = r.diagnostics.filter((d) => d.code === "assembly/transit-collision");
    expect(depth.length).toBeGreaterThan(0);
    for (const d of depth) expect(d.path, d.message).toMatch(/^\/racks\/\d+$/);
    // every depth diagnostic has a pointer, a cable-first pair at the cable (`/cables/<i>`)
    const all = r.diagnostics.filter((d) => /^assembly\/(depth-|clip-|transit-)/.test(d.code));
    for (const d of all) expect(d.path, `${d.code}: ${d.message}`).not.toBe("");
  }, 120000);
});

describe("the rack label is an obstacle for part labels (N1)", () => {
  test("A1's label stays clear of the part labels of A1 and B1 at t = 3", () => {
    const m = modelOf(both);
    const els = elementsOf([...m.layers.labels, ...m.layers.objects]);
    const text = (el: core.SvgElement): string =>
      (el.children ?? []).filter((c) => typeof c === "string").join("");
    const rack = els.find((e) => e.tag === "text" && text(e) === "A1")!;
    expect(rack).toBeDefined();
    const rx = Number(rack.attrs!["x"]);
    const ry = Number(rack.attrs!["y"]);
    // the rack label's box: centred on x, about 22 px wide, one text line high
    const a = { x0: rx - 11, x1: rx + 11, y0: ry - 12, y1: ry + 4 };
    const state = m.assembly!.frameAt(3);
    const pills = els.filter(
      (e) => e.tag === "g" && typeof e.attrs?.["id"] === "string" && /-pl_/.test(e.attrs["id"]),
    );
    expect(pills.length).toBeGreaterThan(0);
    for (const g of pills) {
      const rect = elementsOf(g.children ?? []).find((e) => e.attrs?.["class"] === "pc-t-elabel");
      if (rect === undefined) continue;
      const [dx, dy] = (
        /translate\(([-\d.]+)[ ,]([-\d.]+)\)/.exec(
          state.transforms[g.attrs!["id"] as string] ?? "",
        ) ?? [0, 0, 0]
      )
        .slice(1)
        .map(Number) as [number, number];
      const x = Number(rect.attrs!["x"]) + dx;
      const y = Number(rect.attrs!["y"]) + dy;
      const w = Number(rect.attrs!["width"]);
      const h = Number(rect.attrs!["height"]);
      const hit = x < a.x1 && a.x0 < x + w && y < a.y1 && a.y0 < y + h;
      expect(hit, String(g.attrs!["id"])).toBe(false);
    }
  });
});

describe("D-4a: a targeted rack keeps its 1.1 look at rest", () => {
  test("device fronts set into their carrier are leaves of their own: nothing falls back to hiding", async () => {
    // before: the GPU node's grille (gpu/front, set 3 mm into the chassis) and the ToR's ports and
    // LEDs (set into the face plate) interpenetrated their carrier and were hidden until clear
    const r = await render(targeting("rack-a1"), {
      dc: dcPack,
      themes: themeRegistry,
      font: "system",
      outputs: ["static"],
    });
    const hidden = r.diagnostics.filter((d) => d.code === "assembly/clip-fallback");
    // only the uplink cable that runs into the ToR's front stays (named, never silent)
    for (const d of hidden) expect(d.message, d.message).toMatch(/^"cable_uplink-a_\d+" crosses/);
    const m = modelOf(targeting("rack-a1"));
    const leaves = m.scene.assemblies!.assemblies.find((a) => a.id === "rack-a1")!;
    const find = (path: string): core.SceneAssemblyNode | undefined => {
      const walk = (n: core.SceneAssemblyNode): core.SceneAssemblyNode | undefined =>
        n.path === path ? n : n.children.map(walk).find((x) => x !== undefined);
      return walk(leaves.root);
    };
    const chassis = find("rack-a1/gpu/chassis")!;
    const front = find("rack-a1/gpu/front")!;
    // the chassis ends where the grille starts
    expect(chassis.local.origin.y + chassis.local.size.y).toBeCloseTo(front.local.origin.y, 6);
  }, 120000);
});

describe("D-4a: the camera never cuts a label its step brings in (§7.4)", () => {
  test("§19.4 step 2: every label that fades in lies inside the zoom window", () => {
    const md = readFileSync(new URL("../../../docs/design/assemblies.md", import.meta.url), "utf8");
    const json = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((x) => x[1] as string)
      .find((j) => j.includes('"title": "Rack to server to internals"'))!;
    const m = modelOf(JSON.parse(json) as core.PlatformCosmoSpec);
    const animator = core.createAnimator();
    for (const step of [2, 4]) {
      // the step output's view box is the step's camera window
      const v = animator.animate(m, { speed: 1, mode: "step", step }).viewBox!;
      expect(v).toBeDefined();
      const labels = m.assembly!.stepLabels!(step);
      expect(labels.length).toBeGreaterThan(0);
      for (const q of labels) {
        const out =
          q.x + q.width <= v.x ||
          q.x >= v.x + v.width ||
          q.y + q.height <= v.y ||
          q.y >= v.y + v.height;
        const inside =
          q.x >= v.x - 0.01 &&
          q.y >= v.y - 0.01 &&
          q.x + q.width <= v.x + v.width + 0.01 &&
          q.y + q.height <= v.y + v.height + 0.01;
        expect(out || inside, `step ${step}: ${JSON.stringify(q)} in ${JSON.stringify(v)}`).toBe(
          true,
        );
      }
    }
  });
});
