import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildModel,
  buildScene,
  type AssemblyViewRender,
  type PlatformCosmoSpec,
  type RenderModel,
  type SceneGraph,
  type SvgElement,
  type SvgNode,
} from "../src/index.js";
import type { AssemblyIdScheme, IdScheme, Rect, SceneAssembly } from "../src/contracts/index.js";
import { IMAGE_DEF_TAG } from "../src/emit/index.js";
import { serialize } from "../src/emit/xml.js";
import { buildAssemblyRender } from "../src/render/assembly/index.js";
import { depthItems, worldLeaves } from "../src/render/assembly/world.js";
import { buildModelWithDiagnostics } from "../src/render/model.js";
import type { AssemblyRenderModelX } from "../src/render/assembly/types.js";
import { ownerOf } from "../src/render/assembly/loop.js";
import { applyAffine } from "../src/render/assembly/levels.js";
import { fixtureTheme } from "./fixtures/theme.js";
import { realPng, resolverOf } from "./figure-fixtures.js";
import { colorOf, indexOf, silhouette, viewOf, type Scene } from "./depth-zbuffer.js";

// A1-4: level groups, cross-fade geometry and per-view render (docs/design/assemblies.md §7.7,
// §8.4, §9, §10, §13). Phase 2 is not gated in buildScene/buildModel, so scenes come from specs.

type Obj = Record<string, unknown>;
const spec = (o: Obj): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...o }) as unknown as PlatformCosmoSpec;
const box = (id: string, at: number[], size: number[], extra: Obj = {}): Obj => ({
  id,
  at,
  size,
  ...extra,
});
const images = () => resolverOf({ im: realPng(32, 32, (x, y) => [x * 8, y * 8, 99, 255]) });
const imgSpec = {
  id: "im",
  src: "im.png",
  crop: [0, 0, 32, 32],
  source: { document: "Spec sheet", license: "CC-BY-4.0", attribution: "Alice" },
};

/** Hall -> server -> CPU -> heat sink (+ a fan figure): the §19.4 chain at three depths. */
const story = (steps?: Obj[]): PlatformCosmoSpec =>
  spec({
    figures: [{ id: "fan-fig", parts: [], stages: [] }],
    assemblies: [
      {
        id: "heatsink",
        template: true,
        units: "mm",
        parts: [box("base", [0, 0, 0], [90, 90, 10]), box("fins", [0, 0, 10], [90, 90, 40])],
        programs: [{ id: "lift", stages: [{ parts: ["fins"], direction: "up", distance: 30 }] }],
      },
      {
        id: "srv-internals",
        template: true,
        units: "mm",
        parts: [
          box("board", [10, 260, 0], [418, 200, 3]),
          box("cpu", [70, 430, 3], [90, 90, 50], {
            count: 2,
            pitch: [200, 0, 0],
            type: "cpu",
            closeup: "heatsink",
          }),
          box("fan", [20, 200, 0], [62, 40, 60], { closeup: "fan-fig" }),
        ],
        programs: [
          { id: "internals", stages: [{ parts: ["type:cpu"], direction: "up", distance: 80 }] },
        ],
      },
      {
        id: "hall",
        units: "mm",
        label: "Hall",
        parts: [box("srv", [0, 0, 0], [418, 320, 60], { closeup: "srv-internals" })],
      },
    ],
    ...(steps === undefined ? {} : { steps }),
  });
const chainSteps = [
  { caption: "hall", duration: 3 },
  {
    caption: "server",
    duration: 4,
    focus: "hall/srv/closeup",
    assembly: [{ explode: "hall/srv/closeup" }],
  },
  {
    caption: "cpu",
    duration: 4,
    focus: "hall/srv/closeup/cpu-1/closeup/fins",
    assembly: [{ explode: "hall/srv/closeup/cpu-1/closeup" }],
  },
];

/** A tall L: base, a tower on it and a side block; the tower lifts and the side slides. */
const lShape = (extra: Obj = {}): PlatformCosmoSpec =>
  spec({
    assemblies: [
      {
        id: "l",
        units: "tile",
        parts: [
          box("base", [0, 0, 0], [3, 2, 1]),
          box("tower", [0, 0, 1], [1, 1, 2]),
          box("side", [3, 0, 0], [1, 2, 1]),
        ],
        programs: [
          {
            id: "p",
            stages: [
              { parts: ["tower"], direction: "up", distance: 2 },
              { parts: ["side"], direction: "+x", distance: 2 },
            ],
          },
          {
            id: "b",
            kind: "build",
            steps: [
              { add: ["base"], view: 90 },
              { add: ["tower"], view: 180 },
              { add: ["side"], view: 270 },
            ],
          },
        ],
        ...extra,
      },
    ],
    steps: [
      { caption: "up", duration: 4, assembly: [{ explode: "l", program: "p", to: 1 }] },
      { caption: "out", duration: 4, assembly: [{ explode: "l", program: "p" }] },
    ],
  });

function build(s: PlatformCosmoSpec, imgs = images()): RenderModel {
  const scene = buildScene(s, { images: imgs });
  return buildModel({
    scene,
    theme: fixtureTheme(),
    font: "system",
    prefix: "pc-t",
    spec: s,
    images: imgs,
  });
}
type Ids = IdScheme & AssemblyIdScheme;
const idsOf = (m: RenderModel): Ids => m.ids as Ids;
const X = (m: RenderModel): AssemblyRenderModelX => m.assembly as AssemblyRenderModelX;

const isEl = (n: SvgNode): n is SvgElement => typeof n === "object" && "tag" in n;
function find(nodes: readonly SvgNode[], id: string): SvgElement | undefined {
  for (const n of nodes) {
    if (!isEl(n)) continue;
    if (n.attrs?.id === id) return n;
    const r = find(n.children ?? [], id);
    if (r !== undefined) return r;
  }
  return undefined;
}
function walk(nodes: readonly SvgNode[], fn: (e: SvgElement) => void): void {
  for (const n of nodes) {
    if (!isEl(n)) continue;
    fn(n);
    walk(n.children ?? [], fn);
  }
}
const count = (nodes: readonly SvgNode[]): number => {
  let n = 0;
  walk(nodes, () => n++);
  return n;
};
const near = (a: number, b: number, eps = 0.02): void => expect(Math.abs(a - b)).toBeLessThan(eps);
const inside = (r: Rect, outer: Rect, eps = 0.02): boolean =>
  r.x >= outer.x - eps &&
  r.y >= outer.y - eps &&
  r.x + r.width <= outer.x + outer.width + eps &&
  r.y + r.height <= outer.y + outer.height + eps;

// ---- §19.4 chain: level groups, cameras, cross-fade rects ----------------------------------------

describe("nested close-up chain (§8.4, §19.4)", () => {
  const m = build(story(chainSteps as Obj[]));
  const A = m.assembly!;
  const lv = (p: string) => A.levels!.find((l) => l.path === p)!;
  const hostBox = (p: string) => m.scene.assemblies!.levels!.find((l) => l.path === p)!.hostBox;
  // independent: the screen bounds of a world box with the model's own projection
  const screenOf = (b: ReturnType<typeof hostBox>): Rect => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 8; i++) {
      const q = m.projection.project({
        x: b.origin.x + (i & 1 ? b.size.x : 0),
        y: b.origin.y + (i & 2 ? b.size.y : 0),
        z: b.origin.z + (i & 4 ? b.size.z : 0),
      });
      xs.push(q.x);
      ys.push(q.y);
    }
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  };

  test("one group per level, in path order, hidden at rest at their overview", () => {
    expect(A.levels!.map((l) => l.path)).toEqual([
      "hall/srv/closeup",
      "hall/srv/closeup/cpu-1/closeup",
      "hall/srv/closeup/cpu-2/closeup",
      "hall/srv/closeup/fan/closeup",
    ]);
    expect(A.levels!.map((l) => [l.kind, l.depth, l.parent])).toEqual([
      ["assembly", 1, undefined],
      ["assembly", 2, "hall/srv/closeup"],
      ["assembly", 2, "hall/srv/closeup"],
      ["figure", 2, "hall/srv/closeup"],
    ]);
    for (const l of A.levels!) {
      expect(l.group).toBe(idsOf(m).level(l.path));
      const g = find(m.layers.overlay, l.group)!;
      expect(g).toBeDefined();
      expect(g.attrs?.opacity).toBe(0);
      expect(g.attrs?.transform).toMatch(/^matrix\(/);
    }
    // assembly levels draw their parts into the group, a figure level is an empty frame
    expect(find(m.layers.overlay, idsOf(m).level("hall/srv/closeup"))!.children!.length).toBe(4);
    expect(
      find(m.layers.overlay, idsOf(m).level("hall/srv/closeup/fan/closeup"))!.children ?? [],
    ).toEqual([]);
    // level groups never reach the camera's object layers or the viewBox
    expect(find(m.layers.objects, idsOf(m).level("hall/srv/closeup"))).toBeUndefined();
  });

  test("the host box maps to the parent's screen rect; nested hosts go through the parent's overview", () => {
    const l1 = lv("hall/srv/closeup");
    const want1 = screenOf(hostBox(l1.path));
    near(l1.hostLocal.x, want1.x);
    near(l1.hostLocal.width, want1.width);
    near(l1.hostRect.y, want1.y);
    near(l1.hostRect.height, want1.height);
    const l2 = lv("hall/srv/closeup/cpu-1/closeup");
    const local = screenOf(hostBox(l2.path));
    near(l2.hostLocal.x, local.x);
    near(l2.hostLocal.height, local.height);
    // in the viewport the cpu is seen through the server level's overview
    near(l2.hostRect.x, l1.overview.scale * local.x + l1.overview.tx);
    near(l2.hostRect.y, l1.overview.scale * local.y + l1.overview.ty);
    near(l2.hostRect.width, l1.overview.scale * local.width);
  });

  test("cross-fade has no jump: the level's rest rect lands inside the host rect, centred, touching it", () => {
    for (const l of A.levels!) {
      const r = applyAffine(l.enter, l.rest);
      expect(inside(r, l.hostRect)).toBe(true);
      near(r.x + r.width / 2, l.hostRect.x + l.hostRect.width / 2);
      near(r.y + r.height / 2, l.hostRect.y + l.hostRect.height / 2);
      // contained: the limiting axis fills the host rect exactly
      const fillX = Math.abs(r.width - l.hostRect.width) < 0.05;
      const fillY = Math.abs(r.height - l.hostRect.height) < 0.05;
      expect(fillX || fillY).toBe(true);
      // the same data for any zoomed host rect; at zoom 3 the scale triples
      expect(l.fromHost(l.hostRect)).toEqual(l.enter);
      const z = {
        x: l.hostRect.x * 3 - 10,
        y: l.hostRect.y * 3 + 7,
        width: l.hostRect.width * 3,
        height: l.hostRect.height * 3,
      };
      near(l.fromHost(z).scale, l.enter.scale * 3, 0.01);
      const rz = applyAffine(l.fromHost(z), l.rest);
      near(rz.x + rz.width / 2, z.x + z.width / 2);
      near(rz.y + rz.height / 2, z.y + z.height / 2);
    }
  });

  test("camera: the overview contains the level's reach in the main overview and its focus rect says so", () => {
    for (const l of A.levels!) {
      const r = applyAffine(l.overview, l.reach);
      expect(r).toEqual(l.focus);
      expect(inside(r, m.viewBox)).toBe(true);
      expect(r.width).toBeGreaterThan(40);
      // the host camera adds the focus margins around the host
      expect(inside(l.hostRect, l.hostFocus)).toBe(true);
      expect(l.hostFocus.width).toBeGreaterThan(l.hostRect.width);
    }
    // a level zooms from its host rect to a much larger overview
    const l = lv("hall/srv/closeup");
    expect(l.overview.scale).toBeGreaterThan(l.enter.scale * 0.5);
    expect(l.model).toBeDefined();
    expect(lv("hall/srv/closeup/fan/closeup").model).toBeUndefined();
    near(
      lv("hall/srv/closeup/fan/closeup").rest.width,
      lv("hall/srv/closeup/fan/closeup").hostLocal.width,
    );
  });

  test("the host moves with its parent: hostAt follows the END pose of a step", () => {
    const l2 = lv("hall/srv/closeup/cpu-1/closeup");
    // step 1: nothing moved; step 2 lifts the cpus 80 mm: the host rect rises in the viewport
    near(l2.hostAt(1).y, l2.hostRect.y, 0.05);
    expect(l2.hostAt(2).y).toBeLessThan(l2.hostRect.y - 1);
    near(l2.hostAt(2).width, l2.hostRect.width, 0.05);
  });

  test("focus targets inside a level resolve in the level's own world through its overview", () => {
    const l2 = lv("hall/srv/closeup/cpu-1/closeup");
    const id = "hall/srv/closeup/cpu-1/closeup/fins";
    const r = A.focusRect(3, id)!;
    expect(r).toBeDefined();
    // independent: the fins' world box at the END of step 3 (the heat sink lifts them 30 mm),
    // projected in the level's own world and placed by the level's overview
    const inst = m.scene.assemblies!.levels!.find((l) => l.path === l2.path)!.assembly!;
    const fins = [...inst.root.children].find((c) => c.path === id)!;
    const lift = inst.programs[0] as unknown as {
      stages: { moves: { path: string; offset: { z: number } }[] }[];
    };
    const dz = lift.stages[0]!.moves.find((x) => x.path === id)!.offset.z;
    expect(dz).toBeGreaterThan(0);
    const w = fins.geometry === undefined ? fins.world : fins.world;
    const own = screenOf({ origin: { ...w.origin, z: w.origin.z + dz }, size: w.size });
    const placed = applyAffine(l2.overview, own);
    // the margins are viewport pixels around the placed rect
    const side = placed.x - r.x;
    expect(side).toBeGreaterThan(0);
    near(r.y, placed.y - side);
    near(r.width, placed.width + 2 * side);
    expect(r.height).toBeGreaterThanOrEqual(placed.height + 2 * side - 0.02);
    expect(inside(placed, l2.focus)).toBe(true);
    // not where the main scene would put an id of that name (it has none), nor the host's rect
    const host = A.focusRect(3, "hall/srv/closeup/cpu-1")!;
    expect(host).toBeDefined();
    expect(host).not.toEqual(r);
    expect(A.focusRect(3, "hall/srv")).toEqual(X(m).focusRect(3, "hall/srv"));
    // the instance root is the whole level; a figure level frames its fitted rect
    expect(A.focusRect(2, "hall/srv/closeup")).toBeDefined();
    expect(A.focusRect(1, "hall/srv/closeup/fan/closeup")).toEqual(
      lv("hall/srv/closeup/fan/closeup").focus,
    );
    expect(A.focusRect(1, "hall/srv/closeup/nope")).toBeUndefined();
  });

  test("close-up actions animate the instance's own group: its tracks, the merged frames and settled", () => {
    const l1 = lv("hall/srv/closeup");
    const lm = l1.model as AssemblyRenderModelX;
    // the main model never claims an instance's action
    expect(X(m).moves.every((mv) => !mv.path.includes("closeup"))).toBe(true);
    expect(lm.moves.length).toBeGreaterThan(0);
    expect(lm.moves.every((mv) => mv.path.startsWith("hall/srv/closeup/"))).toBe(true);
    const cpu = (l1.model!.ids as Ids).partMotion("hall/srv/closeup/cpu-1");
    const end2 = A.stepEnd(2);
    const rest = A.frameAt(0);
    expect(rest.transforms[cpu]).toBe("translate(0 0)");
    expect(end2.transforms[cpu]).not.toBe("translate(0 0)");
    // a sub-model's ids are listed in the composed frame state (overrides write the whole state)
    for (const id of Object.keys(lm.frameAt(0).transforms))
      expect(rest.transforms[id]).toBeDefined();
    expect(A.settled[1]).toBeDefined();
    expect(A.settled[1]).toBeGreaterThan(lm.clock[1]!.open);
    // instance targets resolve to the deepest owner
    const byId = new Map([
      ["hall", 1],
      ["hall/srv/closeup", 2],
    ]);
    expect(ownerOf(byId, "hall/srv/closeup/board")).toBe(2);
    expect(ownerOf(byId, "hall/srv")).toBe(1);
    expect(ownerOf(byId, "hall/srv/closeup/cpu-1", ["hall/srv/closeup/cpu-1/closeup"])).toBe(2);
    expect(
      ownerOf(byId, "hall/srv/closeup/cpu-1/closeup", ["hall/srv/closeup/cpu-1/closeup"]),
    ).toBeUndefined();
    expect(ownerOf(byId, "hall/srv/closeup/x", ["hall/srv/closeup"])).toBe(2); // a tie is the group's own
    expect(ownerOf(byId, "other/x")).toBeUndefined();
  });

  test("level ids are unique across the whole drawing", () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    const all = [
      ...m.layers.objects,
      ...m.layers.labels,
      ...m.layers.overlay,
      ...m.layers.background,
    ];
    walk(all, (e) => {
      const id = e.attrs?.id;
      if (typeof id !== "string") return;
      if (seen.has(id)) dup.push(id);
      seen.add(id);
    });
    expect(dup).toEqual([]);
  });

  test("a spec with no close-ups and no views keeps the plain model", () => {
    const plain = build(lShape({ programs: [] }));
    expect(plain.assembly!.levels).toBeUndefined();
    expect(plain.assembly!.views).toBeUndefined();
    expect(find(plain.layers.objects, idsOf(plain).view(0))).toBeUndefined();
  });
});

// ---- quarter-turn views ----------------------------------------------------------------------------

describe("quarter-turn views (§7.7, §9)", () => {
  const m = build(lShape());
  const A = m.assembly!;
  const views = A.views!;
  const vr = (turn: number): AssemblyViewRender => views.find((v) => v.turn === turn)!;

  test("one group per view; ids are scoped per view; view 0 is the unscoped scene", () => {
    expect(views.map((v) => v.turn)).toEqual([0, 90, 180, 270]);
    for (const v of views) {
      const g = find(m.layers.objects, v.group)!;
      expect(g, `view ${v.turn}`).toBeDefined();
      expect(g.attrs?.opacity).toBe(v.turn === 0 ? undefined : 0);
      expect(v.group).toBe(idsOf(m).view(v.turn as 0));
    }
    expect(m.layers.labels).toEqual([]);
    expect((vr(0).model.ids as Ids).object("l/base")).toBe(idsOf(m).object("l/base"));
    expect((vr(90).model.ids as Ids).object("l/base")).toBe(`${idsOf(m).object("l/base")}__v90`);
    expect((vr(90).model.ids as Ids).partMotion("l/tower")).toBe(
      `${idsOf(m).partMotion("l/tower")}__v90`,
    );
    // images keep one definition
    expect((vr(90).model.ids as Ids).image("h")).toBe(idsOf(m).image("h"));
    const seen = new Set<string>();
    const dup: string[] = [];
    walk([...m.layers.objects, ...m.layers.background], (e) => {
      const id = e.attrs?.id;
      if (typeof id !== "string") return;
      if (seen.has(id)) dup.push(id);
      seen.add(id);
    });
    expect(dup).toEqual([]);
  });

  // known assembly (tile units): base x0-3 y0-2, tower x0-1 y0-1 z1-3, side x3-4 y0-2.
  // Turned about the centre of the rest bounds, the part that is behind (smaller x, y or z on a
  // separating axis) draws first. Hand-derived for each quarter turn.
  const orders: Record<number, string[]> = {
    0: ["l/base", "l/side", "l/tower"].sort(),
  };
  void orders;
  const behind = (turn: number): [string, string][] => {
    // [a, b]: a must be drawn before b
    switch (turn) {
      case 0:
        return [
          ["l/base", "l/tower"], // z
          ["l/base", "l/side"], // x
        ];
      case 90:
        // (x, y) -> (y, -x): the long x axis becomes -y; the side block is now the nearest to -y
        return [
          ["l/side", "l/base"],
          ["l/base", "l/tower"],
        ];
      case 180:
        return [
          ["l/side", "l/base"],
          ["l/base", "l/tower"],
        ];
      default:
        return [
          ["l/base", "l/side"],
          ["l/base", "l/tower"],
        ];
    }
  };

  test("each view has its own depth order (hand-derived)", () => {
    for (const v of views) {
      for (const e of v.model.epochs) {
        const o = e.order.filter((k) => k.startsWith("l/"));
        expect(o).toHaveLength(3);
        for (const [a, b] of behind(v.turn)) {
          expect(o.indexOf(a), `view ${v.turn}: ${a} before ${b} at ${e.t0}`).toBeLessThan(
            o.indexOf(b),
          );
        }
      }
    }
    // the views really differ: the side block moves from the front (0) to the back (180)
    const side = (turn: number): number => vr(turn).model.epochs[0]!.order.indexOf("l/side");
    const base = (turn: number): number => vr(turn).model.epochs[0]!.order.indexOf("l/base");
    expect(side(0)).toBeGreaterThan(base(0));
    expect(side(180)).toBeLessThan(base(180));
  });

  test("each view has its own viewBox from the rotated reachBounds; the root box covers all", () => {
    for (const v of views) expect(inside(v.viewBox, m.viewBox)).toBe(true);
    const turned = m.scene.assemblies!.views!;
    for (const v of views) {
      const asm = turned.find((x) => x.turn === v.turn)!.assemblies[0]!;
      const reach = asm.reachBounds;
      // a corner of the rotated reach box projects inside the view's box
      const p = m.projection.project({ x: reach.origin.x, y: reach.origin.y, z: reach.origin.z });
      expect(inside({ x: p.x, y: p.y, width: 0, height: 0 }, v.viewBox)).toBe(true);
    }
    // quarter turns of a 3 x 2 footprint have different screen extents
    expect(vr(90).viewBox).not.toEqual(vr(0).viewBox);
    expect(vr(180).viewBox.width).toBeCloseTo(vr(0).viewBox.width, 0);
    expect(X(m).reach!.width).toBeGreaterThanOrEqual(vr(0).viewBox.width - 0.5);
  });

  // z-buffer spot check per view with A1-2a's harness: paint the emitted DOM of one view with
  // silhouettes and compare to a ray-cast of the same view's world boxes.
  const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;
  async function zCheck(
    v: AssemblyViewRender,
    t: number,
    reverse = false,
  ): Promise<{ fraction: number; covered: number }> {
    const { painterIds, zbufferIds, compare } = await import("./depth-zbuffer.js");
    const asm: readonly SceneAssembly[] = m.scene.assemblies!.views!.find(
      (x) => x.turn === v.turn,
    )!.assemblies;
    const items = depthItems(worldLeaves(asm));
    const moves = (v.model as AssemblyRenderModelX).moves;
    const scene: Scene = { items, moves, loop: v.model.loop };
    const view = viewOf(scene, [t]);
    const frame = A.frameAt(t);
    const byObject = new Map(items.map((i) => [(v.model.ids as Ids).object(i.path ?? i.key), i]));
    const paint = (n: SvgNode): SvgNode => {
      if (!isEl(n)) return n;
      const id = n.attrs?.id;
      const item = typeof id === "string" ? byObject.get(id) : undefined;
      const attrs = { ...(n.attrs ?? {}) } as Record<string, string | number>;
      if (typeof id === "string") {
        if (frame.transforms[id]) attrs.transform = frame.transforms[id]!;
        if (frame.hidden.includes(id)) attrs.visibility = "hidden";
        if (frame.visible.includes(id)) attrs.visibility = "visible";
        if (id === v.group) delete attrs.opacity;
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
    const group = find(m.layers.objects, v.group)!;
    const kids = (group.children ?? []).map(paint);
    const body = reverse ? [...kids].reverse() : kids;
    const defs = m.layers.background.filter((n) => isEl(n) && n.tag === "clipPath");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${view.w}" height="${view.h}" viewBox="${view.x} ${view.y} ${view.w} ${view.h}" shape-rendering="crispEdges">` +
      `<defs>${defs.map((d) => serialize(d)).join("")}</defs>${body.map((n) => serialize(n)).join("")}</svg>`;
    const got = await painterIds(scene, svg, view);
    const r = compare(zbufferIds(scene, t, view), got, view);
    return { fraction: r.fraction, covered: r.covered };
  }

  test("z-buffer spot check: every view, rest and mid-move", async () => {
    for (const v of views) {
      for (const t of [0, (v.model.clock[0]!.open + v.model.clock[0]!.end) / 2, 6]) {
        const r = await zCheck(v, t);
        expect(r.covered, `view ${v.turn} t=${t}`).toBeGreaterThan(500);
        expect(r.fraction, `view ${v.turn} t=${t}`).toBeLessThan(0.02);
      }
    }
  });

  test("the spot check fails on a wrong order (negative control)", async () => {
    let bad = 0;
    for (const v of views) {
      const r = await zCheck(v, 0, true);
      if (r.fraction > 0.02) bad++;
    }
    expect(bad).toBeGreaterThanOrEqual(2);
  });

  test("moves are turned with the view: world offsets differ per view, tracks follow", () => {
    const ox = (turn: number): number => {
      const mv = (vr(turn).model as AssemblyRenderModelX).moves.find((x) => x.path === "l/side")!;
      return Math.round(mv.to.x * 100) / 100;
    };
    const oy = (turn: number): number => {
      const mv = (vr(turn).model as AssemblyRenderModelX).moves.find((x) => x.path === "l/side")!;
      return Math.round(mv.to.y * 100) / 100;
    };
    // +x in the scene, turned by -v
    expect([ox(0), oy(0)]).toEqual([2, 0]);
    expect([ox(90), oy(90)]).toEqual([0, -2]);
    expect([ox(180), oy(180)]).toEqual([-2, 0]);
    expect([ox(270), oy(270)]).toEqual([0, 2]);
    // merged frames hold every view's wrappers; the end of step 2 moved the side block in each
    const end = A.stepEnd(2);
    for (const v of views) {
      const id = (v.model.ids as Ids).partMotion("l/side");
      expect(end.transforms[id], `view ${v.turn}`).toBeDefined();
      expect(end.transforms[id]).not.toBe("translate(0 0)");
    }
    expect(end.transforms[(vr(90).model.ids as Ids).partMotion("l/side")]).not.toBe(
      end.transforms[(vr(0).model.ids as Ids).partMotion("l/side")],
    );
  });
});

// ---- decal faces through frame.rotate -------------------------------------------------------------

describe("decal faces per view (§7.7)", () => {
  const decals = (): PlatformCosmoSpec => {
    const s = lShape({
      parts: [
        box("pr", [0, 0, 0], [2, 1, 1], { image: { ref: "im", face: "right" } }),
        box("pl", [0, 3, 0], [2, 1, 1], { image: { ref: "im", face: "left" } }),
        box("pt", [0, 6, 0], [2, 1, 1], { image: { ref: "im", face: "top" } }),
      ],
      programs: [
        { id: "p", stages: [{ parts: ["pr"], direction: "+x", distance: 1 }] },
        {
          id: "b",
          kind: "build",
          steps: [
            { add: ["pr"], view: 90 },
            { add: ["pl"], view: 180 },
            { add: ["pt"], view: 270 },
          ],
        },
      ],
    });
    (s as unknown as Obj).images = [imgSpec];
    return s;
  };
  const m = build(decals());
  const A = m.assembly!;
  const uses = (turn: number, part: string): number => {
    const v = A.views!.find((x) => x.turn === turn)!;
    const obj = find(m.layers.objects, (v.model.ids as Ids).object(`l/${part}`))!;
    let n = 0;
    walk([obj], (e) => {
      if (e.tag === "use" && String(e.attrs?.href).startsWith("#")) n++;
    });
    return n;
  };

  test("a decal is drawn only on a face that turns toward the viewer", () => {
    // local `right` (+x): visible as right at 0, turned away at 90 and 180, visible as left at 270;
    // local `left` (+y): visible as left at 0, as right at 90, away at 180 and 270; `top` always.
    expect([0, 90, 180, 270].map((t) => uses(t, "pr"))).toEqual([1, 0, 0, 1]);
    expect([0, 90, 180, 270].map((t) => uses(t, "pl"))).toEqual([1, 1, 0, 0]);
    expect([0, 90, 180, 270].map((t) => uses(t, "pt"))).toEqual([1, 1, 1, 1]);
  });

  test("the scene keeps the decal data in every view (the face is assembly-local)", () => {
    for (const v of m.scene.assemblies!.views!) {
      const asm = v.assemblies[0]!;
      const pr = asm.root.children.find((c) => c.path === "l/pr")!;
      expect(pr.geometry!.images?.map((i) => i.face)).toEqual(["right"]);
      expect(asm.frame.rotate).toBe(((360 - v.turn) % 360) % 360);
    }
  });

  test("the image is defined once for all views", () => {
    const defs: string[] = [];
    walk(m.layers.background, (e) => {
      if (e.tag === IMAGE_DEF_TAG) defs.push(String(e.attrs?.hash));
    });
    expect(defs).toHaveLength(1);
  });
});

// ---- budgets, caps ----------------------------------------------------------------------------------

describe("budgets (§13)", () => {
  const heavy = (n: number, views: boolean): PlatformCosmoSpec =>
    spec({
      assemblies: [
        {
          id: "w",
          units: "tile",
          parts: [box("p", [0, 0, 0], [1, 1, 1], { count: n, pitch: [1, 0, 0] })],
          programs: views
            ? [
                {
                  id: "b",
                  kind: "build",
                  steps: [
                    { add: ["p"], view: 90 },
                    { add: ["p"], view: 180 },
                  ],
                },
              ]
            : [],
        },
      ],
    });

  test("model.elements counts every element of every view and level drawn", () => {
    const m = build(lShape());
    const A = m.assembly!;
    const drawn = count(m.layers.objects) + count(m.layers.labels);
    expect(A.elements).toBe(drawn);
    expect(A.views!.reduce((n, v) => n + v.elements, 0)).toBe(A.elements);
    const s = build(story(chainSteps as Obj[]));
    const mainOnly = X(s).elements;
    expect(mainOnly).toBeGreaterThan(0);
    const levelNodes = s.assembly!.levels!.map((l) => find(s.layers.overlay, l.group)!);
    expect(s.assembly!.levels!.reduce((n, l) => n + l.elements, 0)).toBe(count(levelNodes));
    expect(s.assembly!.elements).toBe(
      count(s.layers.objects) + count(s.layers.labels) + count(levelNodes),
    );
  });

  test("budget/views uses the REAL count: a scene under the lower bound's threshold can still warn", () => {
    const n = 500;
    const scene = buildScene(heavy(n, true), {});
    const lower = scene.diagnostics.filter((d) => d.code === "budget/views");
    expect(lower).toEqual([]); // 3 views x 300 primitives = 900, far below 5000
    const built = buildModelWithDiagnostics({
      scene,
      theme: fixtureTheme(),
      font: "system",
      prefix: "pc-t",
    });
    const m = built.model;
    expect(m.assembly!.views).toHaveLength(3);
    expect(m.assembly!.elements).toBeGreaterThan(5000);
    const d = built.diagnostics.filter((x) => x.code === "budget/views");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "warning", params: { views: 3, limit: 5000 } });
    expect((d[0]!.params as { elements: number }).elements).toBe(
      m.assembly!.views!.reduce((a, v) => a + v.elements, 0),
    );
  });

  test("no warning under the threshold, none without views", () => {
    const inputs = (s: PlatformCosmoSpec) => ({
      scene: buildScene(s, {}),
      theme: fixtureTheme(),
      font: "system" as const,
      prefix: "pc-t",
    });
    const small = buildModelWithDiagnostics(inputs(lShape()));
    expect(small.diagnostics.filter((d) => d.code === "budget/views")).toEqual([]);
    const plain = buildModelWithDiagnostics(inputs(heavy(500, false)));
    expect(plain.model.assembly!.elements).toBeGreaterThan(1500);
    expect(plain.diagnostics.filter((d) => d.code === "budget/views")).toEqual([]);
  });

  /** A scene whose leaf lists are padded without building anything (the caps run first). */
  const padded = (
    g: SceneGraph,
    mutate: (a: NonNullable<SceneGraph["assemblies"]>) => object,
  ): SceneGraph =>
    ({ ...g, assemblies: { ...g.assemblies!, ...mutate(g.assemblies!) } }) as SceneGraph;
  const ctxOf = (scene: SceneGraph, m: RenderModel) => ({
    scene,
    projection: m.projection,
    ids: m.ids as never,
    prefix: "pc-t",
    labelSize: 12,
    fs: 1,
    text: (() => {
      throw new Error("no work expected");
    }) as never,
    fit: ((t: string) => t) as never,
    nudge: () => ({ dy: 0 }),
  });

  test("caps run before any work: too many leaves, views, levels and built leaves", () => {
    const base = build(lShape());
    const g = base.scene;
    const pad = (n: number): SceneAssembly => ({
      ...g.assemblies!.assemblies[0]!,
      leaves: Array.from({ length: n }, (_, i) => `x${i}`),
    });
    const tooMany = padded(g, () => ({ assemblies: [pad(2001)] }));
    const r1 = buildAssemblyRender(ctxOf(tooMany, base)) as { diagnostics: { code: string }[] };
    expect(r1.diagnostics.map((d) => d.code)).toEqual(["budget/assembly-parts"]);

    const views = g.assemblies!.views!;
    const manyViews = padded(g, () => ({
      views: [...views, ...views.map((v) => ({ ...v, turn: 45 as never }))],
    }));
    const r2 = buildAssemblyRender(ctxOf(manyViews, base)) as { diagnostics: { code: string }[] };
    expect(r2.diagnostics.map((d) => d.code)).toEqual(["budget/views"]);

    // 1500 leaves x 3 turned views: each view alone is fine, together over the built-leaf cap
    const fat = padded(g, (a) => ({
      assemblies: [pad(1500)],
      views: a.views!.map((v) => ({ ...v, assemblies: [pad(1500)] })),
    }));
    const r3 = buildAssemblyRender(ctxOf(fat, base)) as {
      diagnostics: { code: string; message: string }[];
    };
    expect(r3.diagnostics.map((d) => d.code)).toEqual(["budget/views"]);
    expect(r3.diagnostics[0]!.message).toContain("6000");

    const lg = build(story());
    const lvl = lg.scene.assemblies!.levels![0]!;
    const manyLevels = padded(lg.scene, () => ({ levels: Array.from({ length: 9 }, () => lvl) }));
    const r4 = buildAssemblyRender(ctxOf(manyLevels, lg)) as { diagnostics: { code: string }[] };
    expect(r4.diagnostics.map((d) => d.code)).toEqual(["budget/levels"]);
  });

  test("every diagnostic code this track emits is listed in §18", () => {
    const md = readFileSync(new URL("../../../docs/design/assemblies.md", import.meta.url), "utf8");
    const table = md.slice(md.indexOf("## 18. Diagnostics"), md.indexOf("## 19. Examples"));
    for (const code of ["budget/views", "budget/levels", "budget/assembly-parts"]) {
      expect(table).toContain(`\`${code}\``);
    }
  });
});

// ---- determinism and safety -------------------------------------------------------------------------

describe("determinism and output safety", () => {
  const dump = (m: RenderModel): string => {
    const A = m.assembly!;
    return JSON.stringify({
      vb: m.viewBox,
      layers: [m.layers.objects, m.layers.labels, m.layers.overlay, m.layers.background].map((l) =>
        l.map((n) => serialize(n)),
      ),
      levels: A.levels?.map((l) => ({
        ...l,
        model: undefined,
        fromHost: l.fromHost(l.hostRect),
        at: l.hostAt(2),
      })),
      views: A.views?.map((v) => ({ turn: v.turn, vb: v.viewBox, e: v.elements })),
      frames: [0, 3, 6.5].map((t) => A.frameAt(t)),
      ends: [1, 2].map((s) => A.stepEnd(s)),
      el: A.elements,
      settled: A.settled,
    });
  };

  test("input order of levels and views does not matter (sorted by path and turn)", () => {
    const s = story(chainSteps as Obj[]);
    const m1 = build(s);
    const g = buildScene(s, {});
    const a = g.assemblies!;
    const shuffled = {
      ...g,
      assemblies: { ...a, levels: [...a.levels!].reverse() },
    } as SceneGraph;
    const m2 = buildModel({
      scene: shuffled,
      theme: fixtureTheme(),
      font: "system",
      prefix: "pc-t",
      spec: s,
    });
    expect(dump(m2)).toBe(dump(m1));

    const l = lShape();
    const n1 = build(l);
    const gl = buildScene(l, {});
    const rev = {
      ...gl,
      assemblies: { ...gl.assemblies!, views: [...gl.assemblies!.views!].reverse() },
    } as SceneGraph;
    const n2 = buildModel({
      scene: rev,
      theme: fixtureTheme(),
      font: "system",
      prefix: "pc-t",
      spec: l,
      images: images(),
    });
    expect(dump(n2)).toBe(dump(n1));
  });

  test("two independent builds from the same JSON are byte-identical", () => {
    const j = JSON.stringify(story(chainSteps as Obj[]));
    expect(dump(build(JSON.parse(j)))).toBe(dump(build(JSON.parse(j))));
  });

  test("spec strings in a close-up reach the DOM escaped", () => {
    const evil = `A<b onload="x">&'"`;
    const s = story(chainSteps as Obj[]);
    const tpl = (s.assemblies as unknown as { id: string; parts: Obj[] }[]).find(
      (a) => a.id === "srv-internals",
    )!;
    (tpl.parts[0] as Obj).label = evil;
    (tpl as Obj).labels = "always";
    const m = build(s);
    const level = find(m.layers.overlay, idsOf(m).level("hall/srv/closeup"))!;
    const text = serialize(level);
    expect(text).not.toContain("<b onload");
    expect(text).toContain("A&lt;b");
    // every id attribute of the groups is a plain token
    walk([level], (e) => {
      const id = e.attrs?.id;
      if (typeof id === "string") expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    });
  });

  test("1.1 output has no levels, views or view groups", () => {
    const plain = buildModel({
      scene: buildScene(spec({ nodes: [{ id: "a", type: "server" }] }), {}),
      theme: fixtureTheme(),
      font: "system",
      prefix: "pc-t",
    });
    expect(plain.assembly).toBeUndefined();
    const ser = [...plain.layers.objects, ...plain.layers.overlay]
      .map((n) => serialize(n))
      .join("");
    expect(ser).not.toMatch(/-vw_|-lv_/);
  });
});
