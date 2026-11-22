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

/** A wall in front of the seats; step 2 flies two `a` cubes and one `b` in from the callout. */
const wall = (focus?: string): Obj => ({
  meta: { version: "1" },
  assemblies: [
    {
      id: "w",
      units: "tile",
      parts: [
        { id: "base", at: [0, 0, 0], size: [6, 6, 1] },
        { id: "wall", at: [2, 2, 1], size: [3, 3, 4] },
        { id: "a", at: [0, 0, 1], size: [1, 1, 1] },
        { id: "a2", at: [1, 0, 1], size: [1, 1, 1] },
        { id: "b", at: [0, 3, 1], size: [1, 1, 2] },
      ],
      programs: [
        {
          id: "bd",
          kind: "build",
          steps: [{ add: ["base", "wall"] }, { add: ["a", "a2", "b"], from: "callout" }],
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
/** Start tag of the callout group of a step and the `capbox` rect inside it, from the SVG. */
const boxOf = (svg: string, step: number): Rect | undefined => {
  const g = new RegExp(`<g id="[^"]*-co_w__bd__${step}"[^>]*>\\s*<rect ([^>]*capbox[^>]*)/>`).exec(
    svg,
  );
  if (g === null) return undefined;
  const at = (k: string): number => Number(new RegExp(`(?:^| )${k}="(-?[\\d.]+)"`).exec(g[1]!)![1]);
  return { x: at("x"), y: at("y"), width: at("width"), height: at("height") };
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

describe("the parts callout box (§6.5)", () => {
  test("shows a thumbnail and a <count>x per part kind of the step", async () => {
    const svg = await staticSvg(wall());
    const box = boxOf(svg, 2);
    expect(box).toBeDefined();
    // two kinds: the two `a` cubes (2x) and the tall `b` (1x); each thumbnail is a part copy
    const group = new RegExp(`<g id="[^"]*-co_w__bd__2"[\\s\\S]*?</g></g></g>`).exec(svg)![0];
    expect([...group.matchAll(/>(\d+)x</g)].map((x) => x[1])).toEqual(["2", "1"]);
    expect(group.match(/__t\d+x\d+/g)!.length).toBeGreaterThan(0);
    // step 1 adds the base and the wall: two kinds of one
    expect(boxOf(svg, 1)).toBeDefined();
  });

  test("clear of the model, inside the view box, and deterministic", async () => {
    const spec = wall();
    const m = modelOf(spec);
    const svg = await staticSvg(spec);
    for (const step of [1, 2]) {
      const box = boxOf(svg, step)!;
      expect(inside(box, m.viewBox), `step ${step} box in view box`).toBe(true);
      for (const r of restRects(m)) expect(overlap(box, r), `step ${step}`).toBe(false);
    }
    expect(await staticSvg(spec)).toBe(svg);
  });

  test("hidden at rest, shown during its step's window, hidden after", () => {
    const m = modelOf(wall());
    const am = m.assembly as AssemblyRenderModelX;
    const fade = am.staticFades.find((f) => f.id.endsWith("-co_w__bd__2"))!;
    const at = (t: number): number =>
      (createAnimator().animate(m, { speed: 1, mode: "frame", time: t }).attrs ?? {})[fade.id]!
        .opacity as number;
    expect(at(0)).toBe(0);
    expect(at(3.9)).toBe(0);
    expect(at(4.35)).toBe(1);
    expect(at(8.5)).toBe(0);
  });

  test("a step played again has a box of its own each time", async () => {
    const spec = wall();
    (spec.steps as Obj[]).push(
      { duration: 4, assembly: [{ unbuild: "w", program: "bd", to: 1 }] },
      { duration: 4, assembly: [{ build: "w", program: "bd" }] },
    );
    const svg = await staticSvg(spec);
    const ids = [...svg.matchAll(/<g id="([^"]*-co_w__bd__2[^"]*)"/g)].map((x) => x[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // the unbuild shows it too: the first window is the build, the second the way back
    const m = modelOf(spec);
    const fades = (m.assembly as AssemblyRenderModelX).staticFades.filter((f) =>
      f.id.includes("-co_w__bd__2"),
    );
    expect(fades).toHaveLength(3);
    for (const f of fades) expect(f.opacity.some((k) => k.opacity === 1)).toBe(true);
  });

  test("more than 12 part kinds: the first 12 are drawn and an info says so", async () => {
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
              steps: [{ add: ["base"] }, { add: parts.map((p) => p.id) }],
            },
          ],
        },
      ],
      steps: [{ duration: 6, assembly: [{ build: "w", program: "bd", to: 2 }] }],
    };
    const r = await render(spec, { theme: fixtureTheme(), font: "system", outputs: ["static"] });
    const d = r.diagnostics.filter((x) => x.code === "layout/callout-truncated");
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe("info");
    expect(d[0]!.params).toMatchObject({ program: "bd", step: 2, kinds: 14 });
    const svg = r.outputs.find((x) => x.kind === "static")!.data as string;
    const g =
      new RegExp(`<g id="[^"]*-co_w__bd__2"[\\s\\S]*?</g></g>\\s*<g id`).exec(svg)?.[0] ?? "";
    expect((g.match(/>1x</g) ?? []).length).toBe(12);
  });
});

describe("the callout slot follows the step's focus rect (A2-6)", () => {
  // The camera zooms onto the focused part of step 2. With the slot left of the rest bounds of
  // the whole model (the old rule), the zoomed view box did not hold it and the flights started
  // off screen; the slot, the box and the copies must be inside the camera's window.
  const spec = wall("w/b");
  const m = modelOf(spec);
  const step = m.scene.timeline[1]!;
  const zoom = zoomFor(m, step);

  test("the focused step zooms in", () => {
    expect(zoom).toBeDefined();
  });

  test("the box is inside the zoomed view box", async () => {
    expect(inside(boxOf(await staticSvg(spec), 2)!, zoom!.viewBox)).toBe(true);
  });

  test("every flight of the step starts inside the zoomed view box", () => {
    const am = m.assembly as AssemblyRenderModelX;
    const rest = new Map(
      leavesOf(m).map((l) => [l.path, projectBoxBounds(m.projection, l.geometry.bounds)] as const),
    );
    expect(am.flights!.length).toBe(3);
    for (const f of am.flights!) {
      const r = rest.get(f.path)!;
      const o = f.motion[0]!.offset;
      const start = { x: r.x + o.x, y: r.y + o.y, width: r.width, height: r.height };
      expect(inside(start, zoom!.viewBox), f.path).toBe(true);
    }
  });

  test("the focus rect holds the box", async () => {
    const box = boxOf(await staticSvg(spec), 2)!;
    expect(inside(box, m.assembly!.focusRect(2, "w/b")!)).toBe(true);
  });
});
