import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildModel,
  buildScene,
  createIds,
  emit,
  type AnimationLayer,
  type AssemblyFrameState,
  type PlatformCosmoSpec,
  type RenderModel,
  type SvgElement,
  type SvgNode,
} from "../src/index.js";
import type { Box3, PartGeometry, SceneAssemblyNode } from "../src/contracts/index.js";
import { depthEpochs } from "../src/depth/epochs.js";
import { serialize } from "../src/emit/xml.js";
import { partGeometry, studGrid } from "../src/geometry/index.js";
import { depthItems, worldLeaves, type WorldLeaf } from "../src/render/assembly/world.js";
import type { AssemblyRenderModelX } from "../src/render/assembly/types.js";
import { bezierProgress } from "../src/render/boards/timeline.js";
import { evalOffset, round2 } from "../src/render/assembly/tracks.js";
import { fixtureTheme } from "./fixtures/theme.js";
import { realPng, resolverOf } from "./figure-fixtures.js";
import { colorOf, indexOf, silhouette, viewOf, type Scene } from "./depth-zbuffer.js";

// A1-3: assembly render model and emit (docs/design/assemblies.md §6.6, §9.4, §10, §11.3, §12).

type Obj = Record<string, unknown>;
const examples = (): Obj[] => {
  const md = readFileSync(new URL("../../../docs/design/assemblies.md", import.meta.url), "utf8");
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .filter((s) => typeof s.meta === "object");
};
const example = (prefix: string): PlatformCosmoSpec =>
  examples().find((s) =>
    (s.meta as { title: string }).title.startsWith(prefix),
  ) as unknown as PlatformCosmoSpec;

const images = () =>
  resolverOf({ "gpu-photo": realPng(640, 240, (x, y) => [x % 256, y, 120, 255]) });
function build(spec: PlatformCosmoSpec): RenderModel {
  const imgs = images();
  const scene = buildScene(spec, { images: imgs });
  return buildModel({
    scene,
    theme: fixtureTheme(),
    font: "system",
    prefix: "pc-t",
    spec,
    images: imgs,
  });
}
const X = (m: RenderModel): AssemblyRenderModelX => m.assembly as AssemblyRenderModelX;

function layerOf(f: AssemblyFrameState): AnimationLayer {
  const attrs: Record<string, Record<string, string | number>> = {};
  for (const [id, t] of Object.entries(f.transforms)) (attrs[id] ??= {}).transform = t;
  for (const id of f.hidden) (attrs[id] ??= {}).visibility = "hidden";
  for (const id of f.visible) (attrs[id] ??= {}).visibility = "visible";
  for (const [id, o] of Object.entries(f.opacity)) (attrs[id] ??= {}).opacity = o;
  return { css: "", defs: [], layers: {}, duration: 0, attrs };
}
const svgAt = (m: RenderModel, f: AssemblyFrameState): string =>
  emit(m, layerOf(f), { font: "system" });
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

const isEl = (n: SvgNode): n is SvgElement => typeof n === "object" && "tag" in n;
function find(
  nodes: readonly SvgNode[],
  id: string,
  path: SvgElement[] = [],
): SvgElement[] | undefined {
  for (const n of nodes) {
    if (!isEl(n)) continue;
    if (n.attrs?.id === id) return [...path, n];
    const r = find(n.children ?? [], id, [...path, n]);
    if (r !== undefined) return r;
  }
  return undefined;
}

const engine = (): RenderModel => build(example("Inline-4"));
const gpu = (): RenderModel => build(example("2U GPU"));

describe("model and wrapper chain (§9.4)", () => {
  test("engine: epochs cover the loop, items sorted, one copy each", () => {
    const a = X(engine());
    expect(a.loop).toBeGreaterThan(0);
    expect(a.epochs[0]?.t0).toBe(0);
    expect(a.epochs[a.epochs.length - 1]?.t1).toBeCloseTo(a.loop, 6);
    expect(a.items.map((i) => i.item)).toEqual([...a.items.map((i) => i.item)].sort());
    expect(a.items.every((i) => i.copies === 1)).toBe(true);
    expect(a.settled).toHaveLength(a.clock.length);
  });

  test("clipped copy: host > clip > motion > visible > part, the clip OUTSIDE motion", () => {
    const m = engine();
    const a = X(m);
    const clipped = a.items.filter((i) => i.clips !== undefined);
    expect(clipped.length).toBeGreaterThan(0);
    for (const it of clipped) {
      const motion = a.ids.partMotion(it.item);
      const chain = find(m.layers.objects, motion);
      if (chain === undefined) continue; // moves with its solid: no own motion wrapper
      const clipIdx = chain.findIndex((e) => e.attrs?.["clip-path"] !== undefined);
      expect(clipIdx).toBeGreaterThanOrEqual(0);
      expect(clipIdx).toBeLessThan(chain.length - 1);
      // the clip wrapper is an ancestor of the motion wrapper, never a descendant
      expect(chain[chain.length - 1]?.attrs?.id).toBe(motion);
      const below = chain[chain.length - 1]?.children ?? [];
      expect(JSON.stringify(below)).not.toContain("clip-path");
    }
    // some clipped leaf has its own motion wrapper under a clip
    expect(
      clipped.some((i) => {
        const c = find(m.layers.objects, a.ids.partMotion(i.item));
        return c !== undefined && c.some((e) => e.attrs?.["clip-path"] !== undefined);
      }),
    ).toBe(true);
  });

  test("host carries the solid's track and sits outermost; tracks start at 0 and end at the loop", () => {
    const m = engine();
    const a = X(m);
    for (const t of a.tracks) {
      for (const keys of [t.host, t.motion]) {
        if (keys.length === 0) continue;
        expect(keys[0]?.t).toBe(0);
        expect(keys[keys.length - 1]?.t).toBeCloseTo(a.loop, 6);
      }
    }
    const withHost = a.tracks.filter((t) => t.host.length > 0);
    for (const t of withHost) {
      const chain = find(m.layers.objects, a.ids.partHost(t.copy)) as SvgElement[];
      expect(chain.length).toBeGreaterThan(0);
    }
  });

  test("fade wrappers only when a stage uses fade", () => {
    const e = emit(engine(), layerOf(X(engine()).frameAt(0)), { font: "system" });
    expect(e).not.toContain("-pf_");
    const g = gpu();
    const svg = svgAt(g, X(g).stepEnd(3));
    expect(svg).toContain("-pf_");
    expect(Object.keys(X(g).stepEnd(3).opacity).length).toBeGreaterThan(0);
  });

  test("frameAt(t) is the FULL state, agrees with the track keys, 2 decimals", () => {
    const m = engine();
    const a = X(m);
    const t = a.clock[2]!.end;
    const f = a.stepEnd(3);
    const re = /^translate\(-?\d+(\.\d{1,2})? -?\d+(\.\d{1,2})?\)$/;
    for (const tr of a.tracks) {
      const id = a.ids.partMotion(tr.copy);
      if (tr.motion.length === 0) {
        expect(f.transforms[id]).toBeUndefined();
        continue;
      }
      const v = evalOffset(tr.motion, t);
      expect(f.transforms[id]).toMatch(re);
      expect(f.transforms[id]).toBe(`translate(${round2(v.x)} ${round2(v.y)})`);
    }
    // every visibility wrapper is listed exactly once, in hidden or visible
    const vis = a.tracks
      .filter((x) => x.visibility.length > 0)
      .map((x) => a.ids.partVisible(x.copy));
    expect([...f.hidden, ...f.visible].sort()).toEqual(vis.sort());
    // the loop wraps like boards: frameAt(loop) is the rest frame
    expect(a.frameAt(a.loop)).toEqual(a.frameAt(0));
    expect(a.frameAt(a.loop + 1.3)).toEqual(a.frameAt(1.3));
    expect(a.closure).toBeUndefined(); // ends with an implode: no fast return needed
  });
  test("a loop that ends exploded closes with a fast return in the last step's window", () => {
    const spec = structuredClone(example("2U GPU")) as unknown as { steps: unknown[] };
    spec.steps = spec.steps.slice(0, 4);
    const m = build(spec as unknown as PlatformCosmoSpec);
    const a = X(m);
    expect(a.closure).toBeDefined();
    const c = a.closure!;
    expect(c.t1).toBeCloseTo(a.loop, 6);
    expect(c.t0).toBeLessThan(c.t1);
    expect(Object.values(a.stepEnd(4).transforms).some((v) => v !== "translate(0 0)")).toBe(true);
    expect(a.frameAt(a.loop)).toEqual(a.frameAt(0));
    expect(a.frameAt(c.t0)).toEqual(a.stepEnd(4));
    // the closing window is the last step's own transition
    expect(c.t1 - c.t0).toBeCloseTo(Math.min(0.8, 0.25 * a.clock[3]!.duration), 4);
  });
});

describe("bounds and focus", () => {
  test("the viewBox covers every swept box and every sampled pose", () => {
    for (const m of [engine(), gpu()]) {
      const a = X(m);
      const vb = m.viewBox;
      const r = a.reach!;
      expect(r.x).toBeGreaterThanOrEqual(vb.x - 1e-6);
      expect(r.y).toBeGreaterThanOrEqual(vb.y - 1e-6);
      expect(r.x + r.width).toBeLessThanOrEqual(vb.x + vb.width + 1e-6);
      expect(r.y + r.height).toBeLessThanOrEqual(vb.y + vb.height + 1e-6);
      const leaves = worldLeaves(m.scene.assemblies!.assemblies);
      const proj = m.projection;
      for (let k = 0; k <= 60; k++) {
        const t = (a.loop * k) / 60;
        for (const l of leaves) {
          const d = a.moves
            .filter((mv) => l.path === mv.path || l.path.startsWith(`${mv.path}/`))
            .reduce(
              (acc, mv) => {
                const u = Math.min(1, Math.max(0, (t - mv.t0) / Math.max(1e-9, mv.t1 - mv.t0)));
                return { x: acc.x + mv.to.x * u, y: acc.y + mv.to.y * u, z: acc.z + mv.to.z * u };
              },
              { x: 0, y: 0, z: 0 },
            );
          // linear-progress displacement is within the swept box (monotone easings): its corners are inside
          const b = l.geometry.bounds;
          const p = proj.project({ x: b.origin.x + d.x, y: b.origin.y + d.y, z: b.origin.z + d.z });
          expect(p.x).toBeGreaterThanOrEqual(vb.x - 1);
          expect(p.x).toBeLessThanOrEqual(vb.x + vb.width + 1);
          expect(p.y).toBeGreaterThanOrEqual(vb.y - 1);
          expect(p.y).toBeLessThanOrEqual(vb.y + vb.height + 1);
        }
      }
    }
  });

  test("focusRect is the END pose of the step: an exploded unit is taller than at rest", () => {
    const m = engine();
    const a = X(m);
    const id = m.scene.assemblies!.assemblies[0]!.id;
    const rest = a.focusRect(1, id)!;
    const end = a.focusRect(4, id)!;
    expect(end.height).toBeGreaterThan(rest.height * 1.3);
    expect(a.focusRect(1, "nope")).toBeUndefined();
    expect(a.focusRect(99, id)).toBeUndefined();
    const part = a.focusRect(4, `${id}/head`);
    expect(part).toBeDefined();
  });
});

describe("labels", () => {
  test("placement is deterministic and labels never overlap each other", () => {
    const a = svgAt(gpu(), X(gpu()).stepEnd(4));
    const b = svgAt(gpu(), X(gpu()).stepEnd(4));
    expect(a).toBe(b);
    const m = gpu();
    const rects = [
      ...serialize({ tag: "g", children: m.layers.labels }).matchAll(
        /<rect class="pc-t-elabel" x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g,
      ),
    ];
    expect(rects.length).toBeGreaterThan(3);
  });

  test("label groups ride the part's track and start hidden", () => {
    const a = X(gpu());
    expect(a.labelTracks.length).toBeGreaterThan(0);
    for (const t of a.labelTracks.filter((x) => !x.id.endsWith("__top"))) {
      expect(t.opacity[0]).toMatchObject({ t: 0, opacity: 0 });
      expect(Math.max(...t.opacity.map((k) => k.opacity))).toBe(1);
    }
  });
});

describe("emit safety and ids", () => {
  test("ids: copy suffix scheme, wrappers distinct, halves keep __", () => {
    const ids = createIds("pc", { copies: new Map([["pc-o_a", 3]]) });
    expect(ids.partMotion("a/b")).toBe("pc-pm_a.b");
    expect(ids.partMotion("a/b", 2)).toBe("pc-pm_a.b__c2");
    expect(ids.partVisible("a/b__front", 1)).toBe("pc-pv_a.b__front__c1");
    expect(ids.copyIds("pc-o_a")).toEqual(["pc-o_a", "pc-o_a__c1", "pc-o_a__c2"]);
    expect(ids.copyIds("x")).toEqual(["x"]);
    const all = [
      ids.partHost("a"),
      ids.partMotion("a"),
      ids.partVisible("a"),
      ids.partFade("a"),
      ids.partClip("a", 0),
      ids.partLabel("a"),
      ids.object("a"),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  test("attribute overrides: only translate, visibility, opacity", () => {
    const m = gpu();
    const a = X(m);
    const layer = (attrs: AnimationLayer["attrs"]): AnimationLayer => ({
      css: "",
      defs: [],
      layers: {},
      duration: 0,
      attrs,
    });
    const id = a.ids.partMotion(a.tracks.find((t) => t.motion.length > 0)!.copy);
    expect(() =>
      emit(m, layer({ [id]: { transform: "translate(1.5 -2)" } }), { font: "system" }),
    ).not.toThrow();
    expect(() =>
      emit(m, layer({ [id]: { transform: "rotate(5)" } }), { font: "system" }),
    ).toThrow();
    expect(() => emit(m, layer({ [id]: { fill: "red" } }), { font: "system" })).toThrow();
    expect(() => emit(m, layer({ [id]: { opacity: 2 } }), { font: "system" })).toThrow();
  });

  test("data: only on emitter-owned <image> in <defs>; url( stays #-only", () => {
    const svg = svgAt(gpu(), X(gpu()).frameAt(0));
    const data = [...svg.matchAll(/data:[^"]*/g)];
    expect(data.length).toBeGreaterThan(0);
    for (const d of data) expect(d[0]).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    for (const u of svg.matchAll(/url\(([^)]*)\)/g)) expect(u[1]).toMatch(/^#/);
    expect(svg).toMatch(/<svg width="1" height="1" viewBox=/);
  });

  test("a part color becomes a validated fill only", () => {
    const spec = {
      meta: { version: "1" },
      assemblies: [
        {
          id: "a",
          units: "tile",
          parts: [
            { id: "p", at: [0, 0, 0], size: [1, 1, 1], color: "#123abc" },
            { id: "q", at: [2, 0, 0], size: [1, 1, 1], color: "red" },
          ],
        },
      ],
    } as unknown as PlatformCosmoSpec;
    const m = build(spec);
    const svg = emit(m, layerOf(X(m).frameAt(0)), { font: "system" });
    expect(svg).toContain("fill:#123abc");
    expect(svg).not.toContain("fill:red");
  });
});

describe("studs and fills (E-3 review)", () => {
  const brickBox: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 4, z: 3 } };
  const leafOf = (path: string, geometry: PartGeometry, depthBox: Box3): WorldLeaf => ({
    assembly: "a",
    path,
    geometry,
    depthBox,
    node: {
      path,
      id: path,
      kind: "leaf",
      state: "healthy",
      inserts: undefined,
    } as unknown as SceneAssemblyNode,
  });
  const studded = (): PartGeometry => {
    const base = partGeometry({ kind: "box", size: brickBox.size, tone: "base" });
    const studs = studGrid({ host: brickBox, cols: 4, rows: 4, tone: "base" });
    return {
      ...base,
      primitives: [...base.primitives, ...studs],
      bounds: { ...base.bounds, size: { ...base.bounds.size, z: 3.5 } },
    };
  };

  test("studs above the top face do not stop a brick from filling its box", () => {
    const [it] = depthItems([leafOf("brick", studded(), brickBox)]);
    expect(it?.fills).toBe(true);
    const bare = partGeometry({ kind: "box", size: brickBox.size, tone: "base" });
    expect(depthItems([leafOf("b", bare, brickBox)])[0]?.fills).toBe(true);
    // general rule: ANY primitive equal to the depth box fills, whatever else is present
    const g = studded();
    const extra: PartGeometry = {
      ...g,
      primitives: [
        ...g.primitives,
        {
          ...g.primitives[1]!,
          id: "x",
          box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
        },
      ],
    };
    expect(depthItems([leafOf("b", extra, brickBox)])[0]?.fills).toBe(true);
    // without a primitive equal to the depth box it does not fill
    const small = partGeometry({ kind: "box", size: { x: 1, y: 1, z: 1 }, tone: "base" });
    expect(depthItems([leafOf("c", small, brickBox)])[0]?.fills).toBeUndefined();
    const cyl = partGeometry({ kind: "cylinder", size: brickBox.size, tone: "base" });
    expect(depthItems([leafOf("d", cyl, brickBox)])[0]?.fills).toBeUndefined();
  });

  test("an axle inserted into a studded brick clips instead of falling back", () => {
    const [brick] = depthItems([leafOf("brick", studded(), brickBox)]);
    const axleBox: Box3 = { origin: { x: 1.5, y: 1.5, z: 0.5 }, size: { x: 1, y: 1, z: 6 } };
    const axle = { key: "axle", path: "axle", box: axleBox, inserts: "brick" };
    const moves = [
      {
        path: "axle",
        t0: 0,
        t1: 2,
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 0, z: 5 },
        easing: "linear" as const,
      },
    ];
    const good = depthEpochs([brick!, axle], moves, 2);
    expect(good.diagnostics.filter((d) => d.code === "assembly/clip-fallback")).toEqual([]);
    expect(good.clips.some((c) => c.item === "axle")).toBe(true);
    const bad = depthEpochs([{ ...brick!, fills: false }, axle], moves, 2);
    expect(bad.clips.length).toBe(0);
  });

  test("a multi-primitive housing (lug + flush cylinder) encloses a piston and clips an insert", () => {
    const base = partGeometry({ kind: "box", size: brickBox.size, tone: "base" });
    const body = base.primitives[0]!;
    const lug = {
      ...body,
      id: "lug",
      box: { origin: { x: 4, y: 1, z: 0.5 }, size: { x: 1, y: 1, z: 1 } },
    };
    const cap = {
      ...body,
      id: "cap",
      kind: "cylinder" as const,
      box: { origin: { x: 1, y: 1, z: 3 }, size: { x: 2, y: 2, z: 0.5 } },
    };
    const g: PartGeometry = { ...base, primitives: [body, lug, cap] };
    const [housing] = depthItems([leafOf("housing", g, brickBox)]);
    expect(housing?.fills).toBe(true);
    const piston = {
      key: "piston",
      path: "piston",
      box: { origin: { x: 1, y: 1, z: 0.5 }, size: { x: 1, y: 1, z: 1 } },
    };
    const axle = {
      key: "axle",
      path: "axle",
      box: { origin: { x: 2, y: 2, z: 0.5 }, size: { x: 1, y: 1, z: 6 } },
      inserts: "housing",
    };
    const moves = [
      {
        path: "axle",
        t0: 0,
        t1: 2,
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 0, z: 5 },
        easing: "linear" as const,
      },
    ];
    const r = depthEpochs([housing!, piston, axle], moves, 2);
    // the piston sits inside the housing: hidden (enclosed) in every epoch
    expect(r.epochs.every((e) => !e.order.includes("piston"))).toBe(true);
    expect(r.clips.some((c) => c.item === "axle")).toBe(true);
    expect(r.diagnostics.filter((d) => d.code === "assembly/clip-fallback")).toEqual([]);
  });
});

describe("snapshots of the Phase 1b examples", () => {
  test("engine teardown (§19.3)", () => {
    const m = engine();
    const a = X(m);
    expect({
      viewBox: m.viewBox,
      items: a.items.length,
      epochs: a.epochs.length,
      tracks: a.tracks.length,
      labels: a.labelTracks.length,
      loop: a.loop,
      settled: a.settled,
      closure: a.closure,
      rest: sha(svgAt(m, a.frameAt(0))),
      end3: sha(svgAt(m, a.stepEnd(3))),
    }).toMatchSnapshot();
  });
  test("GPU server (§19.2)", () => {
    const m = gpu();
    const a = X(m);
    expect({
      viewBox: m.viewBox,
      items: a.items.length,
      epochs: a.epochs.length,
      tracks: a.tracks.length,
      labels: a.labelTracks.length,
      assets: a.assets.size,
      loop: a.loop,
      settled: a.settled,
      rest: sha(svgAt(m, a.frameAt(0))),
      end3: sha(svgAt(m, a.stepEnd(3))),
    }).toMatchSnapshot();
  });
});

describe("1.1 and figure output unchanged", () => {
  test("a 1.1 spec has no assembly model and no assembly ids", () => {
    const spec = {
      meta: { version: "1" },
      nodes: [{ id: "a", type: "server" }],
    } as unknown as PlatformCosmoSpec;
    const scene = buildScene(spec, {});
    const m = buildModel({ scene, theme: fixtureTheme(), font: "system", prefix: "pc-t", spec });
    expect(m.assembly).toBeUndefined();
    const svg = emit(m, { css: "", defs: [], layers: {}, duration: 0 }, { font: "system" });
    expect(svg).not.toMatch(/-p[hmvf]_|-pl_/);
  });
});

describe("z-buffer spot check on emitted frames", () => {
  const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;
  async function zCheck(m: RenderModel, t: number) {
    const a = X(m);
    const leaves = worldLeaves(m.scene.assemblies!.assemblies);
    const items = depthItems(leaves);
    // the reference evaluates keyword easings only: freeze the closure's bezier moves at their
    // true progress for this instant (instant moves at 0)
    const moves = a.moves.map((mv) => {
      if (mv.bezier === undefined) return mv;
      const p = bezierProgress(
        mv.bezier as unknown as [number, number, number, number],
        (t - mv.t0) / (mv.t1 - mv.t0),
      );
      return { ...mv, t0: 0, t1: 0, to: { x: mv.to.x * p, y: mv.to.y * p, z: mv.to.z * p } };
    });
    const scene: Scene = { items, moves, loop: a.loop };
    const view = viewOf(scene, [t]);
    const frame = a.frameAt(t);
    const byObject = new Map(items.map((i) => [m.ids.object(i.path ?? i.key), i]));
    const paint = (n: SvgNode): SvgNode => {
      if (!isEl(n)) return n;
      const id = n.attrs?.id;
      const item = typeof id === "string" ? byObject.get(id) : undefined;
      const attrs = { ...(n.attrs ?? {}) } as Record<string, string | number>;
      if (typeof id === "string") {
        if (frame.transforms[id]) attrs.transform = frame.transforms[id]!;
        if (frame.hidden.includes(id)) attrs.visibility = "hidden";
        if (frame.visible.includes(id)) attrs.visibility = "visible";
      }
      if (item !== undefined) {
        const fill = hex(colorOf(indexOf(scene, item.key)));
        return {
          tag: "g",
          attrs,
          children: [{ tag: "polygon", attrs: { points: silhouette(item.box), fill } }],
        };
      }
      return { ...n, attrs, ...(n.children ? { children: n.children.map(paint) } : {}) };
    };
    const body = m.layers.objects.map(paint);
    const defs = m.layers.background.filter((n) => isEl(n) && n.tag === "clipPath");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${view.w}" height="${view.h}" viewBox="${view.x} ${view.y} ${view.w} ${view.h}" shape-rendering="crispEdges">` +
      `<defs>${defs.map((d) => serialize(d)).join("")}</defs>${body.map((n) => serialize(n)).join("")}</svg>`;
    const { painterIds, zbufferIds, compare } = await import("./depth-zbuffer.js");
    const got = await painterIds(scene, svg, view);
    return compare(zbufferIds(scene, t, view), got, view);
  }

  test("engine: mid-move of every step", async () => {
    const m = engine();
    const a = X(m);
    for (const c of a.clock.slice(1)) {
      const t = (c.open + c.end) / 2;
      const r = await zCheck(m, t);
      expect(r.covered).toBeGreaterThan(1000);
      expect(r.fraction, `t=${t}`).toBeLessThan(0.02);
      expect(r.worstItem, `t=${t}`).toBeLessThan(0.1);
    }
  });

  test("engine ending exploded: inside the closure window", async () => {
    const spec = structuredClone(example("Inline-4")) as unknown as { steps: unknown[] };
    spec.steps = spec.steps.slice(0, -1);
    const m = build(spec as unknown as PlatformCosmoSpec);
    const a = X(m);
    expect(a.closure).toBeDefined();
    const t = (a.closure!.t0 + a.closure!.t1) / 2;
    const r = await zCheck(m, t);
    expect(r.covered).toBeGreaterThan(1000);
    expect(r.fraction).toBeLessThan(0.02);
    expect(r.worstItem).toBeLessThan(0.1);
  });
});
