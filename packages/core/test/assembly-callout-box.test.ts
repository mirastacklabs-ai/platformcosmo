import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  buildModel,
  buildScene,
  createAnimator,
  render,
  type PlatformCosmoSpec,
  type Rect,
  type RenderModel,
} from "../src/index.js";
import { diagnosticKey } from "../src/render/index.js";
import { plusRects, segmentHits } from "../src/render/assembly/callout.js";
import { zoomFor } from "../src/anim/timeline.js";
import { projectBoxBounds } from "../src/geometry/index.js";
import { worldLeaves } from "../src/render/assembly/world.js";
import type { AssemblyRenderModelX } from "../src/render/assembly/types.js";
import { UNRENDERED } from "../src/schema/unsupported.js";
import { fixtureTheme } from "./fixtures/theme.js";

// A2-6 follow-up: the parts callout box (docs/design/assemblies.md §6.5, §7.6) and the callout
// slot anchored to the step's focus rect.

vi.setConfig({ testTimeout: 180_000 });

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const guard = UNRENDERED as unknown as Record<string, boolean>;
const was = { ...guard };
beforeAll(() => {
  guard.phase2 = false;
});
afterAll(() => {
  Object.assign(guard, was);
});

/** A wall in front of the seats; step 2 flies `a` and `b` in from the callout. */
const wall = (focus?: string, extra: Obj = {}): Obj => ({
  meta: { version: "1" },
  ...extra,
  assemblies: [
    {
      id: "w",
      units: "tile",
      parts: [
        { id: "base", at: [0, 0, 0], size: [6, 6, 1] },
        { id: "wall", at: [2, 2, 1], size: [3, 3, 4] },
        { id: "a", at: [0, 0, 1], size: [1, 1, 1] },
        { id: "b", at: [0, 3, 1], size: [1, 1, 2] },
      ],
      programs: [
        {
          id: "bd",
          kind: "build",
          steps: [{ add: ["base", "wall"] }, { add: ["a", "b"], from: "callout" }],
        },
      ],
    },
  ],
  steps: [
    { duration: 4, assembly: [{ build: "w", program: "bd", to: 1 }] },
    {
      duration: 5,
      ...(focus === undefined ? {} : { focus }),
      assembly: [{ build: "w", program: "bd" }],
    },
  ],
});

/** The brick rover of 19.5, with boxes for bricks; `focus` sets the focus of timeline steps. */
const rover = (focus: Record<number, string> = {}): Obj => {
  const md = readFileSync(new URL("../../../docs/design/assemblies.md", import.meta.url), "utf8");
  const s = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .find((x) => x.meta?.title === "Brick rover") as Obj;
  const strip = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(strip);
    else if (o !== null && typeof o === "object") {
      delete (o as Obj).shape;
      for (const v of Object.values(o)) strip(v);
    }
  };
  strip(s.assemblies);
  for (const [k, f] of Object.entries(focus)) (s.steps as Obj[])[Number(k) - 1]!.focus = f;
  return s;
};

const modelOf = (o: Obj): RenderModel => {
  const s = o as unknown as PlatformCosmoSpec;
  return buildModel({
    scene: buildScene(s, {}),
    theme: fixtureTheme(),
    font: "system",
    prefix: "pc-t",
    spec: s,
  });
};
const staticSvg = async (o: Obj): Promise<string> => {
  const r = await render(o, { theme: fixtureTheme(), font: "system", outputs: ["static"] });
  return r.outputs.find((x) => x.kind === "static")!.data as string;
};
/** The callout box of a timeline step (rect in screen space, translate applied), from the SVG. */
const boxOf = (svg: string, tl: number): Rect | undefined => {
  const g = new RegExp(`<g id="[^"]*-co_[^"]*__s${tl}"[^>]*>\\s*<rect ([^>]*capbox[^>]*)/>`).exec(
    svg,
  );
  if (g === null) return undefined;
  const start = svg.lastIndexOf("<g ", svg.indexOf(g[0]) + 1);
  const tf = /transform="translate\((-?[\d.]+) (-?[\d.]+)\)(?:scale\(([\d.]+)\))?"/.exec(
    svg.slice(start, start + 400),
  );
  const at = (k: string): number => Number(new RegExp(`(?:^| )${k}="(-?[\\d.]+)"`).exec(g[1]!)![1]);
  const k = tf![3] === undefined ? 1 : Number(tf![3]);
  return {
    x: at("x") + Number(tf![1]),
    y: at("y") + Number(tf![2]),
    width: at("width") * k,
    height: at("height") * k,
  };
};
const leavesOf = (m: RenderModel) => worldLeaves(m.scene.assemblies!.assemblies);
const restRects = (m: RenderModel): Rect[] =>
  leavesOf(m).map((l) => projectBoxBounds(m.projection, l.geometry.bounds));
const inside = (r: Rect, v: Rect): boolean =>
  r.x >= v.x - 1e-6 &&
  r.y >= v.y - 1e-6 &&
  r.x + r.width <= v.x + v.width + 1e-6 &&
  r.y + r.height <= v.y + v.height + 1e-6;
const overlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
/** Overlap with the silhouette of a projected part or node (not its bounding rect). */
const covers = (a: Rect, b: Rect): boolean => plusRects(b).some((p) => overlap(a, p));
/** Screen rect of each flight's copy at its first key (its slot), by leaf path. */
const flightStarts = (m: RenderModel): Map<string, Rect> => {
  const rest = new Map(
    leavesOf(m).map((l) => [l.path, projectBoxBounds(m.projection, l.geometry.bounds)] as const),
  );
  return new Map(
    ((m.assembly as AssemblyRenderModelX).flights ?? []).map((f) => {
      const r = rest.get(f.path)!;
      const o = f.motion[0]!.offset;
      return [f.path, { x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height }] as const;
    }),
  );
};
const tlStep = (m: RenderModel, k: number) => m.scene.timeline[k - 1]!;

describe("the parts callout box (§6.5, §6.6)", () => {
  test("shows a thumbnail and a <count>x per part kind, only for steps with flights", async () => {
    const svg = await staticSvg(wall());
    expect(boxOf(svg, 2)).toBeDefined();
    const group = new RegExp(`<g id="[^"]*-co_w__bd__2__s2"[\\s\\S]*?</g></g></g>`).exec(svg)![0];
    expect([...group.matchAll(/>(\d+)x</g)].map((x) => x[1])).toEqual(["1", "1"]);
    expect(group.match(/__t\d+x\d+/g)!.length).toBeGreaterThan(0);
    // step 1 (base and wall) has no callout flights: no box
    expect(boxOf(svg, 1)).toBeUndefined();
  });

  test("one callout scale per assembly: the relative sizes of the kinds are kept", async () => {
    const parts = Array.from({ length: 5 }, (_v, i) => ({
      id: `p${i}`,
      at: [i, 0, 1],
      size: [1, 1, 1 + 2 * i],
    }));
    const spec: Obj = {
      meta: { version: "1" },
      assemblies: [
        {
          id: "w",
          units: "tile",
          parts: [{ id: "base", at: [0, 0, 0], size: [6, 1, 1] }, ...parts],
          programs: [
            {
              id: "bd",
              kind: "build",
              steps: [{ add: ["base"] }, { add: parts.map((p) => p.id), from: "callout" }],
            },
          ],
        },
      ],
      steps: [{ duration: 6, assembly: [{ build: "w", program: "bd", to: 2 }] }],
    };
    const svg = await staticSvg(spec);
    const group = new RegExp(`<g id="[^"]*-co_w__bd__2__s1"[\\s\\S]*?</text></g>`).exec(svg)![0];
    const scales = [...group.matchAll(/transform="translate\([^)]*\)(?:scale\(([\d.]+)\))?"/g)]
      .map((x) => x[1])
      .slice(1); // the first is the box's own placement
    // every kind has the same scale (or none), so the taller parts draw taller
    expect(new Set(scales).size).toBe(1);
    expect(scales.length).toBe(5);
  });

  test("inside the camera window, clear of the model, deterministic", async () => {
    const spec = wall();
    const m = modelOf(spec);
    const svg = await staticSvg(spec);
    const box = boxOf(svg, 2)!;
    expect(inside(box, m.viewBox)).toBe(true);
    for (const r of restRects(m)) expect(covers(box, r)).toBe(false);
    for (const r of flightStarts(m).values()) expect(overlap(box, r)).toBe(false);
    expect(await staticSvg(spec)).toBe(svg);
  });

  test("hidden at rest, fully visible for at least 0.8 s, hidden after", () => {
    const m = modelOf(wall());
    const am = m.assembly as AssemblyRenderModelX;
    const fade = am.staticFades.find((f) => f.id.endsWith("__s2"))!;
    const at = (t: number): number =>
      (createAnimator().animate(m, { speed: 1, mode: "frame", time: t }).attrs ?? {})[fade.id]!
        .opacity as number;
    expect(at(0)).toBe(0);
    expect(at(3.9)).toBe(0);
    for (const t of [4.25, 4.5, 4.75, 4.95]) expect(at(t), `t=${t}`).toBe(1);
    expect(at(8.9)).toBe(0);
  });

  test("plays of a timeline step share one box (no blink between them)", () => {
    // the rover's steps advance two build steps each: one box per timeline step, never 1 -> 0 -> 1
    const m = modelOf(rover());
    const am = m.assembly as AssemblyRenderModelX;
    const boxes = am.staticFades.filter((f) => f.id.includes("-co_"));
    expect(boxes.length).toBeGreaterThan(0);
    expect(new Set(boxes.map((b) => b.id)).size).toBe(boxes.length);
    for (const b of boxes) {
      let drops = 0;
      for (let i = 1; i < b.opacity.length; i++) {
        if (b.opacity[i - 1]!.opacity === 1 && b.opacity[i]!.opacity < 1) drops++;
      }
      expect(drops, b.id).toBeLessThanOrEqual(1);
    }
  });

  test("more than 12 part kinds: the first 12 are drawn, one info says so", async () => {
    const parts = Array.from({ length: 14 }, (_v, i) => ({
      id: `p${i}`,
      at: [i, 0, 1],
      size: [1, 1, 1 + i],
    }));
    const spec: Obj = {
      meta: { version: "1" },
      assemblies: [
        {
          id: "w",
          units: "tile",
          parts: [{ id: "base", at: [0, 0, 0], size: [14, 1, 1] }, ...parts],
          programs: [
            {
              id: "bd",
              kind: "build",
              steps: [{ add: ["base"] }, { add: parts.map((p) => p.id), from: "callout" }],
            },
          ],
        },
      ],
      // built, unbuilt and built again: still one report
      steps: [
        { duration: 6, assembly: [{ build: "w", program: "bd", to: 2 }] },
        { duration: 6, assembly: [{ unbuild: "w", program: "bd", to: 1 }] },
        { duration: 6, assembly: [{ build: "w", program: "bd", to: 2 }] },
      ],
    };
    const r = await render(spec, { theme: fixtureTheme(), font: "system", outputs: ["static"] });
    const d = r.diagnostics.filter((x) => x.code === "layout/callout-truncated");
    expect(d.map((x) => x.path).sort()).toEqual(["/steps/0", "/steps/1", "/steps/2"]);
    expect(d[0]!.severity).toBe("info");
    const svg = r.outputs.find((x) => x.kind === "static")!.data as string;
    const g =
      new RegExp(`<g id="[^"]*-co_w__bd__2__s1"[\\s\\S]*?</text></g>\\s*<g id`).exec(svg)?.[0] ??
      "";
    expect((g.match(/>1x</g) ?? []).length).toBe(12);
  });
});

describe("the camera framing is the focused node's alone (A2-6)", () => {
  // scale of the camera on the focused step, as before the callout box existed
  const cases: [string, () => Obj, number, number][] = [
    ["wall w/b", () => wall("w/b"), 2, 2.41],
    ["wall w/wall", () => wall("w/wall"), 2, 1.25],
    ["rover cargo-1", () => rover({ 4: "rover/cargo-1" }), 4, 3.0],
    ["rover antenna-1", () => rover({ 4: "rover/antenna-1" }), 4, 3.0],
    ["rover cab", () => rover({ 3: "rover/cab" }), 3, 1.97],
    ["rover wheel-l-1", () => rover({ 2: "rover/wheel-l-1" }), 2, 2.95],
    ["rover plate", () => rover({ 1: "rover/plate" }), 1, 1.22],
  ];
  test.each(cases)(
    "%s: camera scale unchanged, box and flights inside the window",
    async (_n, make, k, scale) => {
      const spec = make();
      const m = modelOf(spec);
      const zoom = zoomFor(m, tlStep(m, k));
      expect(zoom, "zoomed").toBeDefined();
      expect(zoom!.scale).toBeCloseTo(scale, 1);
      const svg = await staticSvg(spec);
      const box = boxOf(svg, k);
      if (box !== undefined) expect(inside(box, zoom!.viewBox), "box in window").toBe(true);
      // flights of this step start inside the window
      const am = m.assembly as AssemblyRenderModelX;
      const c = am.clock[k - 1]!;
      for (const f of am.flights ?? []) {
        const t0 = f.visibility.find((v) => v.visible && v.t >= c.start - 1e-6 && v.t < c.end)?.t;
        if (t0 === undefined) continue;
        const o = f.motion.find((x) => x.t === t0)!.offset;
        const rest = restRects(m)[leavesOf(m).findIndex((l) => l.path === f.path)]!;
        expect(
          inside(
            { x: rest.x + o.x, y: rest.y + o.y, width: rest.width, height: rest.height },
            zoom!.viewBox,
          ),
          `${f.path} starts in the window`,
        ).toBe(true);
      }
    },
  );

  test("the rest view box is the one boxes never changed", () => {
    expect(modelOf(wall()).viewBox.width).toBeCloseTo(554.4, 1);
    expect(modelOf(rover()).viewBox.width).toBeCloseTo(512.8, 1);
  });

  test("a focus on a non-assembly node: the box is in its window and no flight crosses it", async () => {
    const spec = wall("srv", { nodes: [{ id: "srv", type: "server", label: "Server" }] });
    const m = modelOf(spec);
    const zoom = zoomFor(m, tlStep(m, 2))!;
    expect(zoom).toBeDefined();
    const svg = await staticSvg(spec);
    const box = boxOf(svg, 2)!;
    expect(inside(box, zoom.viewBox)).toBe(true);
    const srv = m.scene.objects.find((o) => o.id === "srv")!;
    const sr = projectBoxBounds(m.projection, srv.box);
    expect(covers(box, sr)).toBe(false);
    // every flight starts inside the window, and its straight path to the hover point does not
    // cross the node (the copy may touch its corner when the window is too tight to be clear)
    const am = m.assembly as AssemblyRenderModelX;
    const rest = new Map(
      leavesOf(m).map((l) => [l.path, projectBoxBounds(m.projection, l.geometry.bounds)] as const),
    );
    for (const f of am.flights!) {
      const r = rest.get(f.path)!;
      const c = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      const o0 = f.motion[0]!.offset;
      const t1 = f.visibility.find((v, i) => i > 0 && !v.visible)!.t;
      const o1 = f.motion.find((k) => k.t === t1)!.offset;
      expect(inside({ ...r, x: r.x + o0.x, y: r.y + o0.y }, zoom.viewBox), f.path).toBe(true);
      const hit = plusRects(sr).some((p) =>
        segmentHits({ x: c.x + o0.x, y: c.y + o0.y }, { x: c.x + o1.x, y: c.y + o1.y }, p),
      );
      expect(hit, `${f.path} crosses the node`).toBe(false);
    }
  });
});

describe("render()'s diagnostic dedupe key", () => {
  test("includes the severity", () => {
    const d = { code: "x/y", path: "/p", message: "m" };
    expect(diagnosticKey({ ...d, severity: "info" })).not.toBe(
      diagnosticKey({ ...d, severity: "warning" }),
    );
    expect(diagnosticKey({ ...d, severity: "info" })).toBe(
      diagnosticKey({ ...d, severity: "info" }),
    );
  });
});
