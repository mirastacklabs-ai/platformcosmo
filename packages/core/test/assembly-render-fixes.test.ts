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
import { depthEpochs, moveOffsetAt } from "../src/depth/epochs.js";
import { serialize } from "../src/emit/xml.js";
import { buildModelWithDiagnostics } from "../src/render/model.js";
import { createProjection, partGeometry, studGrid } from "../src/geometry/index.js";
import { fillOf, partGroup, type DomContext } from "../src/render/assembly/dom.js";
import type { AssemblyRenderModelX } from "../src/render/assembly/types.js";
import {
  MoveIndex,
  evalOffset,
  offsetTrack,
  plain,
  screenOf,
  type BezierMove,
} from "../src/render/assembly/tracks.js";
import { normalizeSplit, type WorldLeaf } from "../src/render/assembly/world.js";
import { bezierProgress } from "../src/render/boards/timeline.js";
import { fixtureTheme } from "./fixtures/theme.js";
import { realPng, resolverOf } from "./figure-fixtures.js";

// A1-3 review round: rest frame in the DOM, full-state frames, track accuracy, labels, studs.

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
const EMPTY: AnimationLayer = { css: "", defs: [], layers: {}, duration: 0 };
const bare = (m: RenderModel): string => emit(m, EMPTY, { font: "system" });
function layerOf(f: AssemblyFrameState): AnimationLayer {
  const attrs: Record<string, Record<string, string | number>> = {};
  for (const [id, t] of Object.entries(f.transforms)) (attrs[id] ??= {}).transform = t;
  for (const id of f.hidden) (attrs[id] ??= {}).visibility = "hidden";
  for (const id of f.visible) (attrs[id] ??= {}).visibility = "visible";
  for (const [id, o] of Object.entries(f.opacity)) (attrs[id] ??= {}).opacity = o;
  return { css: "", defs: [], layers: {}, duration: 0, attrs };
}
const isEl = (n: SvgNode): n is SvgElement => typeof n === "object" && "tag" in n;
function attrsById(
  nodes: readonly SvgNode[],
  out = new Map<string, Record<string, string | number>>(),
) {
  for (const n of nodes) {
    if (!isEl(n)) continue;
    if (typeof n.attrs?.id === "string")
      out.set(n.attrs.id, n.attrs as Record<string, string | number>);
    attrsById(n.children ?? [], out);
  }
  return out;
}
const allNodes = (m: RenderModel): SvgNode[] => [...m.layers.objects, ...m.layers.labels];

const REST_SPEC = (): PlatformCosmoSpec =>
  ({
    meta: { version: "1" },
    assemblies: [
      {
        id: "a",
        units: "tile",
        pose: "exploded",
        labels: "always",
        parts: [
          { id: "body", at: [0, 0, 0], size: [4, 4, 2], label: "Body" },
          { id: "inner", at: [1, 1, 0.5], size: [1, 1, 1] },
          { id: "lid", at: [0, 0, 2], size: [4, 4, 0.5], label: "Lid" },
        ],
        programs: [
          { id: "p", stages: [{ parts: ["lid"], direction: "up", distance: 2, labels: "show" }] },
        ],
      },
    ],
    steps: [
      { assembly: [{ implode: "a" }], duration: 3 },
      { assembly: [{ explode: "a" }], duration: 3 },
    ],
  }) as unknown as PlatformCosmoSpec;

describe("the DOM is the rest frame (P1 ruling)", () => {
  test("pose exploded + enclosed part + labels: bare emit shows the t=0 pose", () => {
    const m = build(REST_SPEC());
    const a = X(m);
    const dom = attrsById(allNodes(m));
    const lid = dom.get(a.ids.partMotion("a/lid"));
    expect(lid?.transform).toBe("translate(0 -64)"); // exploded 2 tiles up at t = 0
    const inner = dom.get(a.ids.partVisible("a/inner"));
    expect(inner?.visibility).toBe("hidden"); // enclosed by the body
    const leader = a.labelTracks.find((t) => !t.id.endsWith("__top"))!;
    expect(dom.get(leader.id)?.opacity).toBe(0); // leader labels start hidden
    expect(bare(m)).toContain('visibility="hidden"');
  });

  test("static, step and frame outputs write the FULL state (CSS stripped)", () => {
    const m = build(REST_SPEC());
    const a = X(m);
    const read = (layer: AnimationLayer, id: string) =>
      attrsById(
        // re-run through emit to apply the overrides, then read the serialized attribute
        [],
      ).get(id) ?? layer.attrs?.[id];
    void read;
    const motion = a.ids.partMotion("a/lid");
    const vis = a.ids.partVisible("a/inner");
    const grab = (svg: string, id: string, attr: string): string | undefined =>
      new RegExp(`<g id="${id}"[^>]*? ${attr}="([^"]*)"`).exec(svg)?.[1];
    // step 1 ends assembled: the baked exploded transform must be overwritten with translate(0 0)
    const s1 = emit(m, layerOf(a.stepEnd(1)), { font: "system" });
    expect(grab(s1, motion, "transform")).toBe("translate(0 0)");
    expect(grab(s1, vis, "visibility")).toBe("hidden");
    // step 2 ends exploded again; label shown
    const s2 = emit(m, layerOf(a.stepEnd(2)), { font: "system" });
    expect(grab(s2, motion, "transform")).toBe("translate(0 -64)");
    const leader = a.labelTracks.find((t) => !t.id.endsWith("__top"))!;
    expect(grab(s2, leader.id, "opacity")).toBe("1");
    // frame mode at t = 0 equals the DOM: same attributes as the bare emit
    expect(grab(emit(m, layerOf(a.frameAt(0)), { font: "system" }), motion, "transform")).toBe(
      grab(bare(m), motion, "transform"),
    );
  });

  test.each([["Inline-4"], ["2U GPU"]])("%s: DOM attributes equal frameAt(0)", (title) => {
    const m = build(example(title));
    const a = X(m);
    const dom = attrsById(allNodes(m));
    const f = a.frameAt(0);
    for (const [id, tf] of Object.entries(f.transforms)) {
      const got = dom.get(id)?.transform;
      expect(got ?? "translate(0 0)").toBe(tf);
    }
    for (const id of f.hidden) expect(dom.get(id)?.visibility).toBe("hidden");
    for (const id of f.visible) expect(dom.get(id)?.visibility).toBeUndefined();
    for (const [id, o] of Object.entries(f.opacity)) expect(dom.get(id)?.opacity ?? 1).toBe(o);
  });
});

describe("track accuracy", () => {
  test.each([
    ["Inline-4", false],
    ["2U GPU", false],
    ["Inline-4", true],
  ])(
    "%s (closure=%s): evalOffset stays within 0.35 px of the true displacement",
    (title, truncate) => {
      const spec = structuredClone(example(title)) as unknown as { steps: unknown[] };
      if (truncate) spec.steps = spec.steps.slice(0, -1);
      const m = build(spec as unknown as PlatformCosmoSpec);
      const a = X(m);
      const idx = new MoveIndex(a.moves);
      let worst = 0;
      let where = "";
      for (const tr of a.tracks) {
        if (tr.host.length > 0 || tr.motion.length === 0) continue;
        const path = tr.copy.replace(/__(back|front)$/, "");
        for (let k = 0; k <= 400; k++) {
          const t = (a.loop * k) / 400;
          const want = screenOf(m.projection, idx.displacement(path, t));
          const got = evalOffset(tr.motion, t);
          const err = Math.hypot(want.x - got.x, want.y - got.y);
          if (err > worst) {
            worst = err;
            where = `${tr.copy} t=${t} keys=${tr.motion.length}`;
          }
        }
      }
      expect(worst, where).toBeLessThan(0.35);
    },
  );

  test("epoch starts are track boundaries (a key where the DOM swaps)", () => {
    const m = build(example("Inline-4"));
    const a = X(m);
    const moving = a.tracks.filter((t) => t.motion.length > 0 && t.host.length === 0);
    for (const e of a.epochs.slice(1)) {
      for (const tr of moving) {
        if (!tr.motion.some((k) => k.t > e.t0 + 1e-6)) continue;
        expect(tr.motion.some((k) => Math.abs(k.t - e.t0) < 1e-3)).toBe(true);
      }
    }
  });

  test("a bezier move keeps its curve exactly when its window is one segment", () => {
    const move: BezierMove = {
      path: "p",
      t0: 1,
      t1: 2,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 0, y: 0, z: 3 },
      easing: "ease-in-out",
      bezier: [0.4, 0, 0.2, 1],
    };
    const proj = createProjection({});
    const keys = offsetTrack(plain([move]), 3, proj);
    expect(keys.find((k) => k.t === 1)?.easing).toEqual([0.4, 0, 0.2, 1]);
    const mid = evalOffset(keys, 1.5);
    const want = screenOf(proj, { x: 0, y: 0, z: 3 * bezierProgress([0.4, 0, 0.2, 1], 0.5) });
    expect(mid.y).toBeCloseTo(want.y, 1);
  });

  test("concurrent moves on different curves are sampled within the tolerance", () => {
    const mk = (easing: BezierMove["easing"], z: number): BezierMove => ({
      path: "p",
      t0: 0,
      t1: 2,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 0, y: 0, z },
      easing,
    });
    const moves = [mk("ease-in", 3), { ...mk("ease-out", -3), t0: 0.5, t1: 1.5 }];
    const proj = createProjection({});
    const keys = offsetTrack(plain(moves), 2, proj);
    const idx = new MoveIndex(moves);
    for (let k = 0; k <= 200; k++) {
      const t = (2 * k) / 200;
      const want = screenOf(proj, idx.displacement("p", t));
      const got = evalOffset(keys, t);
      expect(Math.hypot(want.x - got.x, want.y - got.y)).toBeLessThan(0.35);
    }
  });
});

describe("implicit access under compression", () => {
  const NEST = (): PlatformCosmoSpec =>
    ({
      meta: { version: "1" },
      assemblies: [
        {
          id: "a",
          units: "tile",
          parts: [
            { id: "rack", at: [0, 0, 0], size: [4, 4, 1], role: "shell" },
            {
              id: "srv",
              at: [1, 0, 1],
              size: [2, 3, 1],
              parts: [
                { id: "tray", at: [0, 0, 0], size: [2, 3, 1] },
                { id: "lid", at: [0, 0, 1], size: [2, 3, 1] },
              ],
              programs: [
                { id: "internals", stages: [{ parts: ["lid"], duration: 1, stagger: 0 }] },
              ],
            },
          ],
          programs: [
            {
              id: "pull",
              stages: [{ parts: ["srv"], direction: "drawer", duration: 2, stagger: 0 }],
            },
          ],
        },
      ],
      steps: [{ duration: 2, assembly: [{ explode: "a/srv" }] }],
    }) as unknown as PlatformCosmoSpec;

  test("access is compressed like the action: own segment starts after access * scale", () => {
    const m = build(NEST());
    const act = m.scene.assemblies!.plan[0]!.actions[0]!;
    expect(act.scale).toBeLessThan(1);
    expect(act.accessLength).toBeLessThan(2); // compressed (natural 2 s)
    const a = X(m);
    const open = a.clock[0]!.open;
    const drawer = a.moves.find((mv) => mv.path === "a/srv")!;
    const lid = a.moves.find((mv) => mv.path === "a/srv/lid")!;
    expect(drawer.t0).toBeCloseTo(open + act.start, 3);
    expect(drawer.t1 - drawer.t0).toBeCloseTo(2 * act.scale, 3);
    expect(lid.t0).toBeGreaterThanOrEqual(drawer.t1 - 1e-3);
    expect(lid.t0).toBeCloseTo(open + act.start + act.accessLength!, 2);
    expect(lid.t1).toBeLessThanOrEqual(a.clock[0]!.end + 1e-6);
  });

  test("settled is undefined for steps without assembly actions", () => {
    const g = X(build(example("2U GPU")));
    expect(g.settled[0]).toBeUndefined();
    expect(g.settled[1]).toBeGreaterThan(0);
    expect(g.settled).toHaveLength(g.clock.length);
  });
});

describe("studs, splits, colors", () => {
  const proj = createProjection({});
  const dom = (): DomContext => ({
    projection: proj,
    ids: createIds("pc"),
    prefix: "pc",
    images: undefined,
    assets: new Map(),
    defs: [],
    diagnostics: [],
    count: () => {},
  });
  const leafOf = (geometry: PartGeometry, box: Box3, extra: Obj = {}): WorldLeaf => ({
    assembly: "a",
    path: "a/p",
    geometry,
    depthBox: box,
    node: {
      path: "a/p",
      id: "p",
      kind: "leaf",
      state: "healthy",
      ...extra,
    } as unknown as SceneAssemblyNode,
  });
  const B = (x: number, y: number, z: number, sx: number, sy: number, sz: number): Box3 => ({
    origin: { x, y, z },
    size: { x: sx, y: sy, z: sz },
  });

  test("stud runs flush at the first stud's position and ids are unique", () => {
    const plate = B(0, 0, 0, 4, 4, 1);
    const base = partGeometry({ kind: "box", size: plate.size, tone: "base" }).primitives[0]!;
    const studs = studGrid({ host: plate, cols: 4, rows: 4, tone: "base" });
    const tall = { ...base, id: "tall", box: B(0, 3, 1, 4, 1, 5) };
    const g: PartGeometry = {
      ...partGeometry({ kind: "box", size: plate.size, tone: "base" }),
      primitives: [{ ...base, id: "plate" }, ...studs, tall],
    };
    const svg = serialize(partGroup(dom(), leafOf(g, plate), undefined));
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((x) => x[1] as string);
    expect(new Set(ids).size).toBe(ids.length);
    const plateAt = svg.indexOf("__plate__");
    const studAt = svg.indexOf("__studs-base");
    const tallAt = svg.indexOf("__tall__");
    expect(plateAt).toBeGreaterThanOrEqual(0);
    expect(studAt).toBeGreaterThan(plateAt);
    expect(tallAt).toBeGreaterThan(studAt); // the tall front box paints over the studs
    // at most three compound paths hold all 16 studs
    const comp = [...svg.matchAll(/ id="[^"]*__studs-base[^"]*"[^>]*d="([^"]*)"/g)];
    expect(comp.length).toBeLessThanOrEqual(3);
    expect(comp.length).toBeGreaterThan(0);
    for (const c of comp) expect((c[1]!.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(16);
    expect(serialize(partGroup(dom(), leafOf(g, plate), undefined))).toBe(svg);
  });

  test("two stud runs split by a part keep their order and unique ids", () => {
    const plate = B(0, 0, 0, 2, 2, 1);
    const base = partGeometry({ kind: "box", size: plate.size, tone: "base" }).primitives[0]!;
    const s1 = studGrid({ host: plate, cols: 2, rows: 2, tone: "base", idPrefix: "a" });
    const s2 = studGrid({ host: plate, cols: 2, rows: 2, tone: "base", idPrefix: "b" });
    const g: PartGeometry = {
      ...partGeometry({ kind: "box", size: plate.size, tone: "base" }),
      primitives: [
        { ...base, id: "plate" },
        ...s1,
        { ...base, id: "mid", box: B(0, 0, 1, 2, 2, 1) },
        ...s2,
      ],
    };
    const svg = serialize(partGroup(dom(), leafOf(g, plate), undefined));
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((x) => x[1] as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(svg.indexOf("__studs-base-r1")).toBeGreaterThan(svg.indexOf("__mid__"));
  });

  test("copy k >= 1: every id in the subtree gets __c<k>", () => {
    const plate = B(0, 0, 0, 2, 2, 1);
    const g = partGeometry({ kind: "box", size: plate.size, tone: "base" });
    const svg = serialize(partGroup(dom(), leafOf(g, plate), undefined, { copy: 2 }));
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((x) => x[1] as string);
    expect(ids.length).toBeGreaterThan(2);
    for (const id of ids) expect(id.endsWith("__c2")).toBe(true);
  });

  test("a split lists every primitive: unlisted ones go to back", () => {
    const t = partGeometry({ kind: "tray", size: { x: 4, y: 4, z: 2 }, tone: "base" });
    const extra = { ...t.primitives[0]!, id: "extra" };
    const g = normalizeSplit({ ...t, primitives: [...t.primitives, extra] });
    const listed = new Set([...g.split!.back, ...g.split!.front]);
    for (const p of g.primitives) expect(listed.has(p.id)).toBe(true);
    expect(g.split!.back).toContain("extra");
    expect(g.split!.front.includes("extra")).toBe(false);
  });

  test("colors: palette and flow map to theme variables, hostile input is dropped", () => {
    expect(fillOf("palette:red")).toBe("var(--pc-palette-red)");
    expect(fillOf("flow:cache")).toBe("var(--pc-flows-cache)");
    expect(fillOf("#ABC")).toBe("#abc");
    for (const bad of [
      'red"><script>',
      "palette:red);}",
      "palette:red;stroke:url(http://x)",
      "flow:",
      "#12345",
      "url(http://evil)",
      "palette:RED\n",
      "",
    ]) {
      expect(fillOf(bad), bad).toBeUndefined();
    }
    const spec = {
      meta: { version: "1" },
      assemblies: [
        {
          id: "a",
          units: "tile",
          parts: [
            { id: "p", at: [0, 0, 0], size: [1, 1, 1], color: "red" },
            { id: "q", at: [2, 0, 0], size: [1, 1, 1], color: "#123abc" },
            { id: "l", at: [4, 0, 0], size: [1, 1, 1], tone: "led", color: "#445566" },
          ],
        },
      ],
    } as unknown as PlatformCosmoSpec;
    const m = build(spec);
    const svg = bare(m);
    expect(svg).toContain("fill:var(--pc-palette-red)");
    expect(svg).toContain("fill:#123abc");
    expect(svg).not.toContain("fill:#445566"); // led follows the state, not a spec color
  });
});

describe("structure next to the example snapshots", () => {
  test.each([["Inline-4"], ["2U GPU"]])("%s: wrappers, clips and ids match the tracks", (title) => {
    const m = build(example(title));
    const a = X(m);
    const svg = bare(m);
    const count = (re: RegExp): number => (svg.match(re) ?? []).length;
    expect(count(/<g id="pc-t-pm_/g)).toBe(a.tracks.filter((t) => t.motion.length > 0).length);
    expect(count(/<g id="pc-t-ph_/g)).toBe(a.tracks.filter((t) => t.host.length > 0).length);
    expect(count(/<g id="pc-t-pv_/g)).toBe(a.tracks.filter((t) => t.visibility.length > 0).length);
    expect(count(/<g id="pc-t-pf_/g)).toBe(a.tracks.filter((t) => t.opacity.length > 0).length);
    expect(count(/<g clip-path="url\(#pc-t-pc_(?:(?!__im)[^)])*\)"/g)).toBe(
      a.items.filter((i) => i.clips).length,
    );
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((x) => x[1] as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(a.items.length).toBe(a.tracks.length);
  });

  test("more than 2000 leaves: the budget diagnostic is returned, nothing is drawn", () => {
    const spec = {
      meta: { version: "1" },
      assemblies: [
        {
          id: "a",
          units: "tile",
          parts: [{ id: "p", at: [0, 0, 0], size: [1, 1, 1] }],
        },
      ],
    } as unknown as PlatformCosmoSpec;
    // the scene stage caps leaves itself; the renderer's own cap is the safety net
    const small = buildScene(spec, {});
    const first = small.assemblies!.assemblies[0]!;
    const scene = {
      ...small,
      assemblies: {
        ...small.assemblies!,
        assemblies: [{ ...first, leaves: Array.from({ length: 2001 }, () => "a/p") }],
      },
    };
    const built = buildModelWithDiagnostics({
      scene,
      theme: fixtureTheme(),
      font: "system",
      prefix: "pc-t",
      spec,
    });
    expect(built.model.assembly).toBeUndefined();
    expect(built.diagnostics.some((d) => d.code === "budget/assembly-parts")).toBe(true);
  });
});

describe("closure easing is one function for depth and drawing", () => {
  const mv = (bezier?: readonly [number, number, number, number]) => ({
    path: "p",
    t0: 0,
    t1: 1,
    from: { x: 0, y: 0, z: 0 },
    to: { x: 0, y: 0, z: 1 },
    easing: "ease-in-out" as const,
    ...(bezier === undefined ? {} : { bezier }),
  });
  test("depth evaluates the bezier, not the keyword", () => {
    const keyword = moveOffsetAt(mv(), 0.3).z;
    const camera = moveOffsetAt(mv([0.4, 0, 0.2, 1]), 0.3).z;
    expect(camera).toBeCloseTo(bezierProgress([0.4, 0, 0.2, 1], 0.3), 3);
    expect(Math.abs(camera - keyword)).toBeGreaterThan(0.02);
  });
  test("an invalid bezier is ignored with a diagnostic, not thrown", () => {
    const item = {
      key: "a",
      path: "a",
      box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
    };
    const r = depthEpochs([item], [mv([2, 0, 0, 1])], 1);
    expect(r.diagnostics.some((d) => d.code === "assembly/depth-input")).toBe(true);
  });
  test("the closure's moves carry the camera bezier into depth", () => {
    const spec = structuredClone(example("Inline-4")) as unknown as { steps: unknown[] };
    spec.steps = spec.steps.slice(0, -1);
    const a = X(build(spec as unknown as PlatformCosmoSpec));
    const closing = a.moves.filter((m) => m.bezier !== undefined);
    expect(closing.length).toBeGreaterThan(0);
    for (const m of closing) expect(m.bezier).toEqual([0.4, 0, 0.2, 1]);
  });
});

describe("labels", () => {
  test("label boxes over their visible window stay inside the viewBox", () => {
    const m = build(example("2U GPU"));
    const a = X(m);
    const vb = m.viewBox;
    const dom = attrsById(allNodes(m));
    void dom;
    const groups = new Map<string, SvgElement>();
    const walk = (nodes: readonly SvgNode[]): void => {
      for (const n of nodes)
        if (isEl(n)) {
          if (typeof n.attrs?.id === "string") groups.set(n.attrs.id, n);
          walk(n.children ?? []);
        }
    };
    walk(m.layers.labels);
    let checked = 0;
    for (const lt of a.labelTracks.filter((x) => !x.id.endsWith("__top"))) {
      const g = groups.get(lt.id)!;
      const rect = (g.children ?? []).find((c) => isEl(c) && c.tag === "rect") as SvgElement;
      const rx = Number(rect.attrs!.x);
      const ry = Number(rect.attrs!.y);
      const w = Number(rect.attrs!.width);
      const h = Number(rect.attrs!.height);
      for (const t of new Set([...lt.motion.map((k) => k.t), ...lt.opacity.map((k) => k.t)])) {
        if (!(lt.opacity.some((k) => k.t === t && k.opacity > 0) || t > 0)) continue;
        const o = evalOffset(lt.motion, t);
        expect(rx + o.x).toBeGreaterThanOrEqual(vb.x - 1);
        expect(ry + o.y).toBeGreaterThanOrEqual(vb.y - 1);
        expect(rx + o.x + w).toBeLessThanOrEqual(vb.x + vb.width + 1);
        expect(ry + o.y + h).toBeLessThanOrEqual(vb.y + vb.height + 1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("top-face labels sit INSIDE the part group, after its faces", () => {
    const m = build(REST_SPEC());
    const a = X(m);
    const top = a.labelTracks.find((t) => t.id.endsWith("__top"))!;
    expect(top).toBeDefined();
    // not in the labels layer
    expect(attrsById(m.layers.labels).has(top.id)).toBe(false);
    const obj = attrsById(m.layers.objects);
    expect(obj.has(top.id)).toBe(true);
    const find = (nodes: readonly SvgNode[], id: string): SvgElement | undefined => {
      for (const n of nodes) {
        if (!isEl(n)) continue;
        if (n.attrs?.id === id) return n;
        const r = find(n.children ?? [], id);
        if (r) return r;
      }
      return undefined;
    };
    const group = find(m.layers.objects, m.ids.object("a/body"))!;
    const kids = group.children ?? [];
    const at = kids.findIndex((k) => isEl(k) && k.attrs?.id === top.id);
    expect(at).toBeGreaterThan(0);
    // after the faces, before the overlay
    expect(
      isEl(kids[kids.length - 1]!) && String((kids[kids.length - 1] as SvgElement).attrs?.class),
    ).toContain("overlay");
    expect(at).toBe(kids.length - 2);
  });
});
