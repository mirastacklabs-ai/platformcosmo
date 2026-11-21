import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildModel,
  buildScene,
  createAnimator,
  emit,
  type AssemblyFrameState,
  validate,
  type Diagnostic,
  type PlatformCosmoSpec,
  type RenderModel,
  type SceneAssembly,
  type SceneGraph,
} from "../src/index.js";
import type { AssemblyRenderModel, ResolvedBuildProgram } from "../src/contracts/index.js";
import { assemblyAnim } from "../src/anim/assembly.js";
import { appearance, buildSegment } from "../src/scene/assembly/build.js";
import { MoveIndex, keyProgress } from "../src/render/assembly/tracks.js";
import type { AssemblyRenderModelX } from "../src/render/assembly/types.js";
import { BUILD_FADE } from "../src/render/assembly/builds.js";
import { unsupportedDiagnostics } from "../src/schema/unsupported.js";
import { fixtureTheme } from "./fixtures/theme.js";
import { builtCopySpec } from "./copies-fixtures.js";

// A2-7: callout flights and sub-builds (docs/design/assemblies.md §6.5, §7.6, §18, §19.5).

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const spec = (o: Obj): PlatformCosmoSpec =>
  ({ meta: { version: "1" }, ...o }) as unknown as PlatformCosmoSpec;
const box = (id: string, at: number[], size: number[], extra: Obj = {}): Obj => ({
  id,
  at,
  size,
  ...extra,
});
const scene = (s: PlatformCosmoSpec): SceneGraph => buildScene(s, {});
const asmOf = (g: SceneGraph, id: string): SceneAssembly =>
  g.assemblies!.assemblies.find((x) => x.id === id) as SceneAssembly;
const prog = (a: SceneAssembly, id: string, owner = a.id): ResolvedBuildProgram =>
  a.programs.find((p) => p.id === id && p.owner === owner) as ResolvedBuildProgram;
const codes = (d: readonly Diagnostic[], code: string): Diagnostic[] =>
  d.filter((x) => x.code === code);

function build(s: PlatformCosmoSpec): RenderModel {
  return buildModel({
    scene: scene(s),
    theme: fixtureTheme(),
    font: "system",
    prefix: "pc-t",
    spec: s,
  });
}
const X = (m: RenderModel): AssemblyRenderModelX => m.assembly as AssemblyRenderModelX;
const animate = (m: RenderModel, o: Parameters<ReturnType<typeof createAnimator>["animate"]>[1]) =>
  createAnimator().animate(m, o);
const frameOf = (m: RenderModel, t: number, speed = 1) =>
  animate(m, { speed, mode: "frame", time: t }).attrs ?? {};
const loopCss = (m: RenderModel, speed = 1): string =>
  animate(m, { speed, mode: "loop", motion: "css" }).css;
function expectedAttrs(f: AssemblyFrameState): Record<string, Record<string, string | number>> {
  const out: Record<string, Record<string, string | number>> = {};
  for (const [id, t] of Object.entries(f.transforms)) (out[id] ??= {}).transform = t;
  for (const id of f.hidden) (out[id] ??= {}).visibility = "hidden";
  for (const id of f.visible) (out[id] ??= {}).visibility = "visible";
  for (const [id, o] of Object.entries(f.opacity)) (out[id] ??= {}).opacity = o;
  return out;
}
const objectId = (am: AssemblyRenderModel, path: string): string =>
  (am.ids as unknown as { object(p: string): string }).object(path);
interface Box3Like {
  readonly origin: { readonly x: number; readonly y: number; readonly z: number };
  readonly size: { readonly x: number; readonly y: number; readonly z: number };
}
interface SceneAssemblyNodeLike {
  readonly path: string;
  readonly world: Box3Like;
  readonly children: readonly SceneAssemblyNodeLike[];
}
const near = (a: number, b: number, tol = 0.011): void => expect(Math.abs(a - b)).toBeLessThan(tol);
const xy = (v: unknown): [number, number] => {
  const m = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(String(v));
  return [Number(m?.[1]), Number(m?.[2])];
};

// ---------------------------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------------------------

/** A base, then a and b flying in from the callout; built, taken off again, built again. */
const flyer = (): PlatformCosmoSpec =>
  spec({
    assemblies: [
      {
        id: "k",
        units: "tile",
        parts: [
          box("base", [0, 0, 0], [4, 4, 1]),
          box("a", [0, 0, 1], [1, 1, 1]),
          box("b", [2, 2, 1], [1, 1, 2]),
        ],
        programs: [
          {
            id: "bd",
            kind: "build",
            steps: [{ add: ["base"] }, { add: ["a", "b"], from: "callout" }],
          },
        ],
      },
    ],
    steps: [
      { caption: "base", duration: 4, assembly: [{ build: "k", program: "bd", to: 1 }] },
      { caption: "fly in", duration: 5, assembly: [{ build: "k", program: "bd" }] },
      { caption: "fly out", duration: 5, assembly: [{ unbuild: "k", program: "bd", to: 1 }] },
      { caption: "again", duration: 5, assembly: [{ build: "k", program: "bd" }] },
    ],
  });

/** A tower whose `deck` sub-assembly is built beside the model, then docked. */
const subSpec = (
  wide = false,
  inner: Obj[] = [{ add: ["pillar"] }, { add: ["slab"] }],
  step: Obj = {},
): PlatformCosmoSpec =>
  spec({
    assemblies: [
      {
        id: "t",
        units: "tile",
        parts: [
          box("base", [0, 0, 0], [4, 4, 1]),
          {
            id: "deck",
            parts: [
              box("pillar", [1, 1, 1], [1, 1, 2]),
              box("slab", wide ? [0, 0, 3] : [1, 1, 3], wide ? [4, 4, 1] : [2, 2, 1]),
            ],
            programs: [{ id: "deck-build", kind: "build", steps: inner }],
          },
        ],
        programs: [
          {
            id: "bd",
            kind: "build",
            steps: [{ add: ["base"] }, { add: ["deck"], subBuild: "deck", ...step }],
          },
        ],
      },
    ],
    steps: [
      { caption: "base", duration: 4, assembly: [{ build: "t", program: "bd", to: 1 }] },
      { caption: "deck", duration: 8, assembly: [{ build: "t", program: "bd" }] },
      { caption: "off", duration: 8, assembly: [{ unbuild: "t", program: "bd", to: 1 }] },
    ],
  });

const rover = (): PlatformCosmoSpec => {
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
  return s as unknown as PlatformCosmoSpec;
};

// ---------------------------------------------------------------------------------------------
// Callout flights: scene
// ---------------------------------------------------------------------------------------------

describe("callout flights: the moves", () => {
  const g = scene(flyer());
  const bd = prog(asmOf(g, "k"), "bd");

  test("a callout move is the drop behind a flight as long as the drop", () => {
    const moves = bd.steps[1]!.moves;
    expect(moves.map((m) => [m.path, m.start, m.duration, m.overlayDuration])).toEqual([
      ["k/a", 0.6, 1.2, 0.6],
      ["k/b", 0.7, 1.2, 0.6],
    ]);
    // the step ends with its last move, flight included
    expect(bd.steps[1]!.end).toBe(1.9);
    // the world drop is the `above` one: seat - hover, upward
    expect(moves[0]!.offset.z).toBeLessThan(0);
    expect(bd.steps[0]!.moves[0]!.overlayDuration).toBeUndefined();
  });

  test("an unbuild plays the move as played: the overlay phase comes last", () => {
    const seg = buildSegment(bd, 2, 1);
    expect(seg.kind).toBe("unbuild-played");
    expect(seg.length).toBe(1.3);
    const a = seg.moves.find((m) => m.path === "k/a")!;
    const b = seg.moves.find((m) => m.path === "k/b")!;
    expect([a.start, a.duration, a.overlayDuration, a.reversed]).toEqual([0.1, 1.2, 0.6, true]);
    expect([b.start, b.duration, b.overlayDuration, b.reversed]).toEqual([0, 1.2, 0.6, true]);
    // the forward moves, unreversed, still start with the flight (toLoopMoves mirrors them)
    expect(seg.forward.find((m) => m.path === "k/a")!.start).toBe(0);
  });

  test("the world copy appears when the flight ends and leaves when the lift ends", () => {
    const up = appearance(bd, 1, 2);
    expect(up).toEqual([
      { path: "k/a", at: 0.6, visible: true, swap: true, from: 0 },
      { path: "k/b", at: 0.7, visible: true, swap: true, from: 0.1 },
    ]);
    // reversed: the world lift is the first 0.6 s of the 1.2 s move, the flight back the rest
    const down = appearance(bd, 2, 1);
    expect(down).toEqual([
      { path: "k/b", at: 0.6, visible: false, swap: true },
      { path: "k/a", at: 0.7, visible: false, swap: true },
    ]);
    // a plain build has no swap
    expect(appearance(bd, 0, 1)).toEqual([{ path: "k/base", at: 0, visible: true, from: 0 }]);
  });

  test("a callout step is not the reason for a blocked-path warning when clear", () => {
    expect(codes(scene(flyer()).diagnostics, "assembly/build-path-blocked")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Callout flights: render model and animator
// ---------------------------------------------------------------------------------------------

describe("callout flights: tracks", () => {
  const m = build(flyer());
  const am = X(m);
  const ids = am.ids;
  const a = am.flights!.find((f) => f.path === "k/a")!;

  test("only the leaves of callout moves have an overlay copy, sorted, one wrapper each", () => {
    expect(am.flights!.map((f) => f.path)).toEqual(["k/a", "k/b"]);
    expect(a.id).toBe(ids.flight("k/a"));
    const svg = emit(m, { layers: {}, css: "", defs: [], duration: 0 }, { font: "system" });
    expect(svg.match(new RegExp(`id="${a.id}"`, "g"))).toHaveLength(1);
    // not a depth item
    expect(am.items.map((i) => i.item).some((k) => k.includes("fy_"))).toBe(false);
  });

  test("keys: first at 0, last at the loop end, hidden but for the flights", () => {
    for (const f of am.flights!) {
      for (const keys of [f.motion, f.visibility, f.opacity]) {
        expect(keys[0]!.t).toBe(0);
        expect(keys[keys.length - 1]!.t).toBe(am.loop);
        keys.forEach((k, i) => i > 0 && expect(k.t).toBeGreaterThan(keys[i - 1]!.t));
      }
      expect(f.visibility[0]!.visible).toBe(false);
    }
    // flight windows of `a`: step 2 build (loop 4 .. 4.6), step 3 unbuild back (9.7 .. 10.3), and
    // again in step 4
    const on = a.visibility.filter((k) => k.visible).map((k) => k.t);
    expect(on).toHaveLength(3);
    expect(a.visibility.filter((k) => !k.visible).map((k) => k.t)).toEqual([
      0,
      4.6,
      10.3,
      ...[a.visibility[a.visibility.length - 2]!.t],
      am.loop,
    ]);
  });

  test("the copy flies from the callout slot (left of the model) to the hover point", () => {
    const [t0, ts] = [a.visibility[1]!.t, a.visibility[2]!.t];
    const f0 = a.motion.find((k) => k.t === t0)!;
    const f1 = a.motion.find((k) => k.t === ts)!;
    expect(f0.offset.x).toBeLessThan(-100); // slot: left of the rest bounds
    expect(f1.offset.x).toBe(0); // above its seat: straight up on the screen
    expect(f1.offset.y).toBeLessThan(0);
    // the flight uses the move's curve; between flights it holds (hidden)
    expect(f0.easing).toBe("ease-out");
    expect(f1.easing).toBe("step");
  });

  test("the view box holds the slot and the hover points", () => {
    const rest = frameOf(m, 0);
    expect(rest[a.id]!.visibility).toBe("hidden");
    const vb = m.viewBox;
    const slotX = a.motion.find((k) => k.t === a.visibility[1]!.t)!.offset.x;
    expect(vb.x).toBeLessThan(slotX);
  });

  test("a world copy is hidden while its flight runs, and the other way round", () => {
    const [t0, ts] = [a.visibility[1]!.t, a.visibility[2]!.t];
    const world = ids.partVisible("k/a");
    for (const t of [t0 + 0.01, (t0 + ts) / 2, ts - 0.01]) {
      const f = frameOf(m, t);
      expect(f[a.id]!.visibility, `flight @${t}`).toBe("visible");
      expect(f[world]!.visibility, `world @${t}`).toBe("hidden");
    }
    for (const t of [ts, ts + 0.01, ts + 1]) {
      const f = frameOf(m, t);
      expect(f[a.id]!.visibility, `flight @${t}`).toBe("hidden");
      expect(f[world]!.visibility, `world @${t}`).toBe("visible");
    }
    // the world copy needs no fade-in: it is opaque at the swap
    const f = frameOf(m, ts);
    expect(f[ids.partFade("k/a")]?.opacity ?? 1).toBe(1);
  });

  test.each([1, 0.5, 2])(
    "%s x: at the swap instant the copy and the world part have the same screen position",
    (speed) => {
      const warp = assemblyAnim(am, speed).warp;
      const v = a.visibility;
      const swaps = [
        // build (step 2), unbuild (step 3: the world lift ends and the flight back starts),
        // build again (step 4)
        v[2]!.t,
        v[3]!.t,
        v[6]!.t,
      ];
      for (const [i, ts] of swaps.entries()) {
        const at = warp(ts) / speed;
        const f = frameOf(m, at, speed);
        const world = f[ids.partMotion("k/a")]!.transform;
        // build: the copy is gone at ts, so read it just before; unbuild: it starts at ts
        const t = i === 1 ? at + 1e-4 : at - 1e-4;
        const fl = frameOf(m, t, speed)[a.id]!;
        expect(fl.visibility, `swap ${i}`).toBe("visible");
        const [wx, wy] = xy(world);
        const [fx, fy] = xy(fl.transform);
        near(fx, wx, 0.5);
        near(fy, wy, 0.5);
        // exactly: the key at the swap instant IS the world copy's pose
        const key = a.motion.find((k) => k.t === ts)!;
        expect(key).toBeDefined();
        expect(xy(`translate(${key.offset.x} ${key.offset.y})`)).toEqual(xy(world));
      }
    },
  );

  test("opacity: the copy fades in as it leaves the slot and out as it returns to it", () => {
    const [t0, ts] = [a.visibility[1]!.t, a.visibility[2]!.t];
    expect(frameOf(m, t0 + 1e-3)[a.id]!.opacity as number).toBeLessThan(0.1);
    near(frameOf(m, t0 + BUILD_FADE + 0.01)[a.id]!.opacity as number, 1, 0.02);
    expect(frameOf(m, ts - 0.01)[a.id]!.opacity).toBe(1);
    // unbuild: opaque at the swap, gone at the slot
    const [u0, u1] = [a.visibility[3]!.t, a.visibility[4]!.t];
    expect(frameOf(m, u0 + 0.01)[a.id]!.opacity).toBe(1);
    expect(frameOf(m, u1 - 1e-3)[a.id]!.opacity as number).toBeLessThan(0.1);
  });

  test("an unbuild flies back: the copy starts at the hover point and ends at the slot", () => {
    const [u0, u1] = [a.visibility[3]!.t, a.visibility[4]!.t];
    const start = a.motion.find((k) => k.t === u0)!;
    const end = a.motion.find((k) => k.t === u1)!;
    const slot = a.motion.find((k) => k.t === a.visibility[1]!.t)!;
    expect(end.offset).toEqual(slot.offset);
    expect(start.offset.x).toBe(0);
    // the world copy left at u0 and does not come back until the next build
    const world = ids.partVisible("k/a");
    expect(frameOf(m, u0 + 0.1)[world]!.visibility).toBe("hidden");
    expect(frameOf(m, u1 + 0.1)[world]!.visibility).toBe("hidden");
  });

  test("frame mode equals the model's frameAt on a time grid", () => {
    for (let k = 0; k < 80; k++) {
      const t = (am.loop * k) / 80 + 0.0137;
      expect(frameOf(m, t), `t=${t}`).toEqual(expectedAttrs(am.frameAt(t)));
    }
    expect(frameOf(m, 0)).toEqual(expectedAttrs(am.frameAt(0)));
  });

  test.each([1, 0.5, 2])("%s x: the CSS keyframes are the frame's pose", (speed) => {
    const css = loopCss(m, speed);
    const live = css.replace(/@media \(prefers-reduced-motion:reduce\)\{[\s\S]*$/, "");
    const dur = am.loop / speed;
    let compared = 0;
    for (let k = 0; k < 60; k++) {
      const t = dur * (0.0037 + ((k * 0.0173) % 1));
      const f = frameOf(m, t, speed)[a.id]!;
      const c = cssPose(live, a.id, t, dur);
      expect(c.visibility, `v @${t}`).toBe(f.visibility);
      const [cx, cy] = c.translate;
      const [fx, fy] = xy(f.transform);
      near(cx, fx, 0.06);
      near(cy, fy, 0.06);
      if (c.opacity !== undefined) near(c.opacity, f.opacity as number, 0.02);
      compared++;
    }
    expect(compared).toBe(60);
  });

  test("reduced motion snaps: no copy is ever shown, the world part is at its seat", () => {
    const css = loopCss(m);
    const reduced = /@media \(prefers-reduced-motion:reduce\)\{\n([\s\S]*?)\n\}/.exec(css)![1]!;
    const esc = a.id.replace(/\./g, "\\\\\\.");
    const rule = new RegExp(`#${esc}[^{]*\\{animation:([^}]*)\\}`).exec(reduced)![1]!;
    const names = rule.split(",").map((x) => x.split(" ")[0]!);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const body = new RegExp(`@keyframes ${n}\\{([^@]*?)\\}\\}`).exec(css)?.[1] ?? "";
      expect(body).not.toContain("visibility:visible");
    }
    for (const c of am.clock) {
      const s = am.stepEnd(c.step);
      expect(s.hidden, `step ${c.step}`).toContain(a.id);
      expect(s.visible, `step ${c.step}`).not.toContain(a.id);
    }
    // step 2 ends with its parts seated, step 3 with them off again
    expect(am.stepEnd(2).transforms[ids.partMotion("k/a")]).toBe("translate(0 0)");
  });

  test("deterministic: the same spec gives the same CSS and frames", () => {
    const again = build(flyer());
    expect(loopCss(again)).toBe(loopCss(m));
    expect(frameOf(again, 4.3)).toEqual(frameOf(m, 4.3));
  });
});

describe("callout flights: depth items and copies", () => {
  test("the copies are not depth items and are drawn after every one, in the objects layer", () => {
    const m = build(flyer());
    const layer = animate(m, { speed: 1, mode: "loop", motion: "css" });
    const svg = emit(m, layer, { font: "system" });
    const fly = [...svg.matchAll(/id="(pc-t-fy_[^"]+)"/g)].map((x) => x.index!);
    const part = [...svg.matchAll(/id="pc-t-pm_[^"]+"/g)].map((x) => x.index!);
    expect(fly).toHaveLength(2);
    expect(Math.min(...fly)).toBeGreaterThan(Math.max(...part));
    // every id inside the copy carries `__f`, so ids stay unique
    const all = [...svg.matchAll(/ id="([^"]+)"/g)].map((x) => x[1]!);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((id) => id.endsWith("__f")).length).toBeGreaterThan(2);
    // per-id rules reach the copy: copyIds lists it
    const am = X(m);
    const obj = objectId(am, "k/a");
    expect(am.ids.copyIds(obj)).toEqual([obj, `${obj}__f`]);
  });

  test("the presence of a flying leaf has no fade: it is opaque at the swap, not ramped in", () => {
    const m = build(flyer());
    const am = X(m);
    const t = am.tracks.find((x) => x.copy === "k/a")!;
    const ts = am.flights!.find((f) => f.path === "k/a")!.visibility[2]!.t;
    const at = (x: number) => frameOf(m, x)[am.ids.partFade("k/a")]!.opacity;
    // the loop-start fade left it at 0; it is 1 at the swap and was 0 a moment before
    expect(at(ts - 1e-3)).toBe(0);
    expect(at(ts)).toBe(1);
    // the key at the swap is a jump (the key before it holds)
    const k = t.opacity.findIndex((o) => o.t === ts);
    expect(t.opacity[k]!.opacity).toBe(1);
    expect(t.opacity[k - 1]!.easing).toBe("step");
  });
});

describe("the hover clears everything present (no pop at the swap)", () => {
  const wall = (extra: Obj = {}): PlatformCosmoSpec =>
    spec({
      assemblies: [
        {
          id: "w",
          units: "tile",
          parts: [
            box("base", [0, 0, 0], [6, 6, 1]),
            box("wall", [2, 2, 1], [3, 3, 4]),
            box("a", [0, 0, 1], [1, 1, 1]),
            box("b", [0, 3, 1], [1, 1, 2]),
          ],
          programs: [
            {
              id: "bd",
              kind: "build",
              steps: [{ add: ["base", "wall"] }, { add: ["a", "b"], from: "callout", ...extra }],
            },
          ],
        },
      ],
      steps: [
        { duration: 4, assembly: [{ build: "w", program: "bd", to: 1 }] },
        { duration: 5, assembly: [{ build: "w", program: "bd" }] },
      ],
    });
  const hover = (p: ResolvedBuildProgram, leaf: string, z0: number): number =>
    z0 - p.steps[1]!.moves.find((m) => m.path === leaf)!.offset.z;

  test("a callout part hovers with its bottom above the top of the wall and of its neighbours", () => {
    const g = scene(wall());
    const a = asmOf(g, "w");
    const p = prog(a, "bd");
    const gap = 0.1 * Math.max(a.root.local.size.x, a.root.local.size.y, a.root.local.size.z);
    // the wall's top is z = 5; b (the taller of the two flyers) lands at 3: its own top is no
    // reason to hover higher than the wall; a hovers above b's top too (z = 3) and the wall's
    expect(hover(p, "w/a", 1)).toBeGreaterThanOrEqual(5 + gap - 1e-9);
    expect(hover(p, "w/b", 1)).toBeGreaterThanOrEqual(5 + gap - 1e-9);
    // an `above` step only clears the part's own footprint: well below the wall's top
    const plain = prog(asmOf(scene(wall({ from: "above" })), "w"), "bd");
    expect(hover(plain, "w/a", 1)).toBeLessThan(5);
  });

  test("a fixed distance is the author's: it is not raised", () => {
    const p = prog(asmOf(scene(wall({ distance: 2 })), "w"), "bd");
    expect(hover(p, "w/a", 1)).toBe(3);
  });

  test("the loop's world copy at the swap is the highest thing in the model", () => {
    const m = build(wall());
    const am = X(m);
    const fl = am.flights!.find((f) => f.path === "w/a")!;
    const ts = fl.visibility.find((k, i) => i > 0 && !k.visible)!.t;
    const top = (path: string) =>
      // screen y of the wrapper at the swap: smaller is higher
      xy(am.frameAt(ts).transforms[am.ids.partMotion(path)])[1];
    // moved up on the screen by more than the wall's height (4 tiles of the iso unit, at least)
    expect(top("w/a")).toBeLessThan(-4 * 16);
  });
});

describe("callout flights with depth copies (#106)", () => {
  // the swap spec of A1-2b with the arm flying in from the callout: `blk` gets a depth copy
  // later, in the explode, and the arm's whole subtree flies as one unit
  const flying = (): PlatformCosmoSpec => {
    const s = builtCopySpec() as unknown as {
      assemblies: { programs: { id: string; steps?: Obj[] }[] }[];
    };
    s.assemblies[0]!.programs.find((p) => p.id === "b")!.steps![0] = {
      add: ["arm"],
      from: "callout",
    };
    return s as unknown as PlatformCosmoSpec;
  };
  const m = build(flying());
  const am = X(m);
  const blk = "kit/arm/blk";
  const fl = am.flights!.find((f) => f.path === blk)!;

  test("a leaf with copies has one overlay copy, listed with its copies", () => {
    expect(am.items.find((i) => i.item === blk)!.copies).toBeGreaterThan(1);
    expect(am.flights!.map((f) => f.path)).toEqual([blk]);
    const obj = objectId(am, blk);
    expect(am.ids.copyIds(obj)).toEqual([obj, `${obj}__c1`, `${obj}__f`]);
  });

  test("while it flies every world copy is hidden; at the swap the right copy shows", () => {
    const t0 = fl.visibility.find((k, i) => i > 0 && k.visible)!.t;
    const ts = fl.visibility.find((k, i) => i > 0 && k.t > t0 && !k.visible)!.t;
    const copies = am.tracks.filter((t) => t.copy === blk || t.copy.startsWith(`${blk}__c`));
    expect(copies.length).toBeGreaterThan(1);
    const f = (t: number) => frameOf(m, t);
    const vis = (t: number) =>
      copies.map((c) => {
        const id = am.ids.partVisible(blk, c.copy === blk ? 0 : Number(c.copy.split("__c")[1]));
        return f(t)[id]?.visibility ?? "visible";
      });
    const mid = (t0 + ts) / 2;
    expect(f(mid)[fl.id]!.visibility).toBe("visible");
    expect(vis(mid).every((v) => v === "hidden")).toBe(true);
    // after the swap exactly one copy shows (copy 0: the swap's second copy comes later)
    expect(f(ts + 0.01)[fl.id]!.visibility).toBe("hidden");
    expect(vis(ts + 0.01).filter((v) => v === "visible")).toHaveLength(1);
  });

  test("the depth order is the plain one: flights add no item and no epoch change", () => {
    const plain = X(build(builtCopySpec()));
    // the flight lengthens the build step, so times move; the orders and items do not
    expect(am.epochs.map((e) => e.order)).toEqual(plain.epochs.map((e) => e.order));
    expect(am.items.map((i) => [i.item, i.copies])).toEqual(
      plain.items.map((i) => [i.item, i.copies]),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Sub-builds
// ---------------------------------------------------------------------------------------------

describe("sub-builds: staging and docking", () => {
  const g = scene(subSpec());
  const a = asmOf(g, "t");
  const bd = prog(a, "bd");
  const deck = prog(a, "deck-build", "t/deck");
  const step = bd.steps[1]!;

  test("the sub-assembly's own program plays first, at a staging offset above the model", () => {
    expect(deck.steps.map((s) => [s.start, s.end])).toEqual([
      [0, 0.6],
      [0.6, 1.2],
    ]);
    expect(step.subBuild).toMatchObject({
      path: "t/deck",
      program: "deck-build",
      staging: { x: expect.any(Number), y: 0, z: expect.any(Number) },
    });
    // beside the model along +x: past its far edge by a gap (0.1 x the longest side), and lifted
    // until the deck's bottom clears the top of the base by a gap
    const gap = 0.1 * Math.max(a.root.local.size.x, a.root.local.size.y, a.root.local.size.z);
    const stage = step.subBuild!.staging;
    // the deck's own box starts at x = 1 and z = 1 (the base's top): shifted to base.x1 + gap
    expect(stage.x).toBeCloseTo((4 + gap - 1) * a.frame.scale.x, 6);
    expect(stage.z).toBeCloseTo(gap * a.frame.scale.z, 6);
    const inner = step.moves.filter((m) => m.path.startsWith("t/deck/"));
    expect(inner.map((m) => [m.path, m.start])).toEqual([
      ["t/deck/pillar", step.start],
      ["t/deck/slab", step.start + 0.6],
    ]);
  });

  test("then the unit docks in two moves: slide over to above the seat, then drop", () => {
    const [slide, drop] = step.moves.filter((m) => m.path === "t/deck");
    const stage = step.subBuild!.staging;
    expect(slide!.start).toBeCloseTo(step.start + 1.2, 9);
    expect(slide!.duration).toBe(0.6);
    expect(slide!.offset).toEqual({ x: -stage.x + 0, y: -stage.y + 0, z: 0 });
    expect(drop!.start).toBeCloseTo(step.start + 1.8, 9);
    expect(drop!.offset).toEqual({ x: 0, y: 0, z: -stage.z + 0 });
    expect(step.end).toBeCloseTo(step.start + 2.4, 9);
    // nothing else of the step is lost: the step adds the deck's leaves, once
    expect(step.adds).toEqual(["t/deck/pillar", "t/deck/slab"]);
  });

  test("the parts are at staging while the sub-build plays, above the seat after the slide, seated after the drop", () => {
    const moves = step.moves.map((m) => ({
      path: m.path,
      t0: m.start,
      t1: m.start + m.duration,
      from: { x: -m.offset.x, y: -m.offset.y, z: -m.offset.z },
      to: { x: 0, y: 0, z: 0 },
      easing: m.easing,
    }));
    const idx = new MoveIndex(moves);
    const at = (t: number) => idx.displacement("t/deck/pillar", t);
    const stage = step.subBuild!.staging;
    // pillar's own move is over at start + 0.6; the slide has not started: it sits at staging
    expect(at(step.start + 1.0)).toEqual({ x: stage.x, y: stage.y, z: stage.z });
    // slid over: above its seat
    expect(at(step.start + 1.8)).toEqual({ x: 0, y: 0, z: stage.z });
    // docked
    expect(at(step.end)).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("the leaves of the sub-assembly appear with their own steps; parts its program does not add appear at the step's start", () => {
    const s = scene(subSpec(false, [{ add: ["slab"] }]));
    const p = prog(asmOf(s, "t"), "bd");
    const st = p.steps[1]!;
    const ap = appearance(p, 1, 2);
    const at = (path: string) => ap.find((x) => x.path === path)!.at;
    // slab: its own inner move; pillar: not in the inner program, so present from the step's start
    expect(at("t/deck/pillar")).toBe(0);
    expect(at("t/deck/slab")).toBe(
      st.moves.find((m) => m.path === "t/deck/slab")!.start - st.start,
    );
    // the exact reverse: the pillar leaves at the end of the reversed step
    const down = appearance(p, 2, 1);
    expect(down.find((x) => x.path === "t/deck/pillar")!.at).toBe(buildSegment(p, 2, 1).length);
  });

  test("unbuild mirrors: the drop plays backwards first, then the slide, then the steps in reverse", () => {
    const seg = buildSegment(bd, 2, 1);
    expect(seg.kind).toBe("unbuild-played");
    const legs = seg.moves.filter((m) => m.path === "t/deck");
    const by = (p: string) => seg.moves.find((m) => m.path === p)!;
    expect(seg.length).toBeCloseTo(2.4, 9);
    const stage = step.subBuild!.staging;
    // reversed: up first (the drop's reverse), then back to staging
    expect(legs.map((m) => [m.start, m.offset.x, m.offset.z])).toEqual([
      [0, 0, stage.z],
      [0.6, stage.x, 0],
    ]);
    // the slab (last inner step) un-builds right after the slide, the pillar after it
    expect(by("t/deck/slab").start).toBeCloseTo(1.2, 6);
    expect(by("t/deck/pillar").start).toBeCloseTo(1.8, 6);
    const down = appearance(bd, 2, 1);
    expect(down.every((x) => !x.visible)).toBe(true);
  });

  test("the docking unit's swept box meets no placed part", () => {
    const sweptClear = (g: SceneGraph, id: string, progId: string, stepNo: number): void => {
      const asm = asmOf(g, id);
      const p = prog(asm, progId);
      const st = p.steps[stepNo]!;
      const sub = st.subBuild!;
      const nodes = new Map<string, SceneAssemblyNodeLike>();
      const walk = (n: SceneAssemblyNodeLike): void => {
        nodes.set(n.path, n);
        n.children.forEach(walk);
      };
      walk(asm.root as unknown as SceneAssemblyNodeLike);
      const unit = nodes.get(sub.path)!.world;
      // placed: the base and every earlier step's leaves
      const placed = [...p.base, ...p.steps.slice(0, stepNo).flatMap((s) => s.adds)].map(
        (l) => nodes.get(l)!.world,
      );
      const legs = st.moves.filter((m) => m.path === sub.path);
      expect(legs).toHaveLength(2);
      const drop = legs[1]!.offset;
      const S = sub.staging;
      const W = { x: 0, y: 0, z: -drop.z + 0 };
      const at = (b: Box3Like, d: { x: number; y: number; z: number }): Box3Like => ({
        origin: { x: b.origin.x + d.x, y: b.origin.y + d.y, z: b.origin.z + d.z },
        size: b.size,
      });
      const hull = (d0: typeof S, d1: typeof S): Box3Like => {
        const a0 = at(unit, d0);
        const a1 = at(unit, d1);
        const o = {
          x: Math.min(a0.origin.x, a1.origin.x),
          y: Math.min(a0.origin.y, a1.origin.y),
          z: Math.min(a0.origin.z, a1.origin.z),
        };
        return {
          origin: o,
          size: {
            x: Math.max(a0.origin.x, a1.origin.x) + unit.size.x - o.x,
            y: Math.max(a0.origin.y, a1.origin.y) + unit.size.y - o.y,
            z: Math.max(a0.origin.z, a1.origin.z) + unit.size.z - o.z,
          },
        };
      };
      const hit = (a: Box3Like, b: Box3Like): boolean =>
        (["x", "y", "z"] as const).every(
          (k) =>
            Math.min(a.origin[k] + a.size[k], b.origin[k] + b.size[k]) -
              Math.max(a.origin[k], b.origin[k]) >
            1e-9,
        );
      const zero = { x: 0, y: 0, z: 0 };
      // the unit's own leaves are the step's; `placed` holds none of them
      for (const [name, box] of [
        ["slide", hull(S, W)],
        ["drop", hull(W, zero)],
      ] as const) {
        // (what the straight line from staging to the seat would have met, for the record)
        if (id === "rover" && name === "slide") {
          expect(placed.some((b) => hit(hull(S, zero), b))).toBe(true);
        }
        const bad = placed.filter((b) => hit(box, b));
        expect(bad.length, `${id}: ${name} meets a placed part`).toBe(0);
      }
    };
    sweptClear(g, "t", "bd", 1);
    sweptClear(scene(subSpec(true)), "t", "bd", 1);
    sweptClear(scene(rover()), "rover", "build", 5);
  });

  test("when +x would carry it far from a long model it is staged along -y", () => {
    const s = scene(subSpec(true));
    const stage = prog(asmOf(s, "t"), "bd").steps[1]!.subBuild!.staging;
    expect(stage.x).toBe(0);
    expect(stage.y).toBeLessThan(0);
    // clear of the base: the deck's far y face stops a gap before the base's near one
    const a2 = asmOf(s, "t");
    const gap = 0.1 * Math.max(a2.root.local.size.x, a2.root.local.size.y, a2.root.local.size.z);
    expect(stage.y).toBeCloseTo((0 - gap - 4) * a2.frame.scale.y, 6);
  });

  test("a sub-assembly the step does not add is a plain part, with a diagnostic", () => {
    const s = spec({
      assemblies: [
        {
          id: "t",
          units: "tile",
          parts: [
            box("base", [0, 0, 0], [4, 4, 1]),
            {
              id: "deck",
              parts: [box("pillar", [1, 1, 1], [1, 1, 2])],
              programs: [{ id: "deck-build", kind: "build", steps: [{ add: ["pillar"] }] }],
            },
          ],
          programs: [
            {
              id: "bd",
              kind: "build",
              steps: [{ add: ["base"] }, { add: ["deck/pillar"], subBuild: "deck" }],
            },
          ],
        },
      ],
    });
    const gg = scene(s);
    const d = codes(gg.diagnostics, "assembly/subbuild-not-added");
    expect(d.map((x) => [x.severity, x.path])).toEqual([
      ["warning", "/assemblies/0/programs/0/steps/1/subBuild"],
    ]);
    const st = prog(asmOf(gg, "t"), "bd").steps[1]!;
    expect(st.subBuild).toBeUndefined();
    expect(st.moves.map((m) => m.path)).toEqual(["t/deck/pillar"]);
  });

  test("a sub-assembly without a resolvable program is a plain add (validation reports it)", () => {
    const s = subSpec(false, [{ add: ["pillar"] }, { add: ["slab"] }], { program: "nope" });
    const st = prog(asmOf(scene(s), "t"), "bd").steps[1]!;
    expect(st.subBuild).toBeUndefined();
    expect(st.moves.map((m) => m.path)).toEqual(["t/deck"]);
  });

  test("the sub program resolves once, whatever the owner order, and is still its own program", () => {
    const again = scene(subSpec());
    expect(prog(asmOf(again, "t"), "deck-build", "t/deck").steps).toHaveLength(2);
    expect(again.assemblies!.plan.length).toBe(3);
  });
});

describe("round-2 details", () => {
  test("the leaves a step adds of a partly added sub-assembly fly as one rigid unit", () => {
    const s = spec({
      assemblies: [
        {
          id: "t",
          units: "tile",
          parts: [
            box("base", [0, 0, 0], [6, 6, 1]),
            {
              id: "u",
              parts: [
                box("p1", [0, 0, 1], [1, 1, 1]),
                box("p2", [2, 0, 1], [1, 1, 1]),
                box("p3", [4, 0, 1], [1, 1, 1]),
              ],
            },
          ],
          programs: [
            {
              id: "bd",
              kind: "build",
              steps: [{ add: ["base", "u/p1"] }, { add: ["u"], from: "callout" }],
            },
          ],
        },
      ],
      steps: [
        { duration: 4, assembly: [{ build: "t", program: "bd", to: 1 }] },
        { duration: 5, assembly: [{ build: "t", program: "bd" }] },
      ],
    });
    const am = X(build(s));
    const p2 = am.flights!.find((f) => f.path === "t/u/p2")!;
    const p3 = am.flights!.find((f) => f.path === "t/u/p3")!;
    expect(am.flights!.map((f) => f.path)).toEqual(["t/u/p2", "t/u/p3"]);
    // one rigid unit: the same translation, centred on the slot, so they keep their distance
    const start = (f: typeof p2) => f.motion.find((k) => k.t === f.visibility[1]!.t)!.offset;
    expect(start(p2)).toEqual(start(p3));
  });

  test("a leaf of a nested sub-build that its program does not add appears at the step's start", () => {
    const s = spec({
      assemblies: [
        {
          id: "t",
          units: "tile",
          parts: [
            box("base", [0, 0, 0], [6, 6, 1]),
            {
              id: "deck",
              parts: [
                box("pillar", [1, 1, 1], [1, 1, 2]),
                {
                  id: "rail",
                  parts: [box("r1", [3, 1, 1], [1, 1, 1]), box("r2", [4, 1, 1], [1, 1, 1])],
                  programs: [{ id: "rail-build", kind: "build", steps: [{ add: ["r1"] }] }],
                },
              ],
              programs: [
                {
                  id: "deck-build",
                  kind: "build",
                  steps: [{ add: ["pillar"] }, { add: ["rail"], subBuild: "rail" }],
                },
              ],
            },
          ],
          programs: [
            {
              id: "bd",
              kind: "build",
              steps: [{ add: ["base"] }, { add: ["deck"], subBuild: "deck" }],
            },
          ],
        },
      ],
    });
    const g = scene(s);
    const a = asmOf(g, "t");
    const p = prog(a, "bd");
    const deck = prog(a, "deck-build", "t/deck");
    const ap = appearance(p, 1, 2);
    const at = (l: string) => ap.find((x) => x.path === l)!.at;
    // r2 is in no program: it is there when the deck's second step starts (not at its dock)
    expect(at("t/deck/rail/r2")).toBeCloseTo(deck.steps[1]!.start, 9);
    expect(at("t/deck/rail/r1")).toBeGreaterThanOrEqual(deck.steps[1]!.start);
    expect(at("t/deck/pillar")).toBe(0);
  });

  test("validate shows the build-program warnings the scene reports", () => {
    const s = spec({
      assemblies: [
        {
          id: "t",
          units: "tile",
          parts: [
            box("base", [0, 0, 0], [4, 4, 1]),
            {
              id: "deck",
              parts: [box("pillar", [1, 1, 1], [1, 1, 2])],
              programs: [{ id: "deck-build", kind: "build", steps: [{ add: ["pillar"] }] }],
            },
          ],
          programs: [
            {
              id: "bd",
              kind: "build",
              steps: [{ add: ["base"] }, { add: ["deck/pillar"], subBuild: "deck" }],
            },
          ],
        },
      ],
      steps: [{ duration: 4, assembly: [{ build: "t", program: "bd" }] }],
    });
    const codesOf = validate(s).diagnostics.map((d) => d.code);
    expect(codesOf).toContain("assembly/subbuild-not-added");
  });
});

describe("sub-builds: render", () => {
  const m = build(subSpec());
  const am = X(m);

  test("the deck's leaves exist from the sub-build, hidden before", () => {
    const pillar = am.tracks.find((t) => t.copy === "t/deck/pillar")!;
    const slab = am.tracks.find((t) => t.copy === "t/deck/slab")!;
    const first = (t: typeof pillar) => t.visibility.find((k, i) => i > 0 && k.visible)!.t;
    // the pillar's own step is first, the slab's after it, and neither exists before
    expect(first(pillar)).toBeLessThan(first(slab));
    const c = am.clock[1]!;
    expect(first(pillar)).toBeGreaterThanOrEqual(c.open - 1e-6);
  });

  test("frame equals frameAt, and the deck is seated at the end of its step", () => {
    for (let k = 0; k < 50; k++) {
      const t = (am.loop * k) / 50 + 0.0137;
      expect(frameOf(m, t), `t=${t}`).toEqual(expectedAttrs(am.frameAt(t)));
    }
    const end = am.stepEnd(2);
    for (const leaf of ["t/deck/pillar", "t/deck/slab"]) {
      expect(end.transforms[am.ids.partMotion(leaf)], leaf).toBe("translate(0 0)");
      expect(end.hidden).not.toContain(am.ids.partVisible(leaf));
    }
  });

  test("while the sub-build plays the deck sits beside the model, then slides home", () => {
    const c = am.clock[1]!;
    const pillar = am.ids.partMotion("t/deck/pillar");
    const t = (frac: number): [number, number] => xy(am.frameAt(c.open + frac).transforms[pillar]);
    // inner steps take 1.2 s of the action: at 1.0 s the pillar is at staging, away from home
    const staged = t(1.0);
    expect(Math.hypot(staged[0], staged[1])).toBeGreaterThan(20);
    // the slide plays 1.2 .. 1.8 s: it ends straight above the seat (no sideways offset left)
    const mid = t(1.5);
    expect(Math.hypot(mid[0], mid[1])).toBeLessThan(Math.hypot(staged[0], staged[1]));
    const over = t(1.8);
    expect(over[0]).toBe(0);
    expect(over[1]).toBeLessThan(0); // still lifted: up on the screen
    // the drop plays 1.8 .. 2.4 s
    expect(t(2.4)).toEqual([0, 0]);
  });

  test("no `assembly/unsupported` for the group A2-7 lifts", () => {
    const s = subSpec();
    const lifted = {
      phase1a: false,
      phase1b: false,
      phase2: false,
      storyboards: true,
      phase3: false,
    };
    expect(unsupportedDiagnostics(s, lifted)).toEqual([]);
    const callout = unsupportedDiagnostics(flyer(), { ...lifted, phase3: true });
    expect(callout.map((d) => d.path)).toEqual(["/assemblies/0/programs/0/steps/1/from"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The rover of §19.5 (cab sub-build, cargo flights)
// ---------------------------------------------------------------------------------------------

describe("the brick rover", () => {
  const g = scene(rover());
  const m = build(rover());
  const am = X(m);

  test("builds without diagnostics beyond infos", () => {
    expect(g.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  });

  test("cargo and rails fly in; the cab is staged beside the model and docks", () => {
    expect(am.flights!.map((f) => f.path)).toEqual([
      "rover/cargo-1",
      "rover/cargo-2",
      "rover/rail-1",
      "rover/rail-2",
    ]);
    const main = prog(asmOf(g, "rover"), "build");
    expect(main.steps[5]!.subBuild).toMatchObject({ path: "rover/cab", program: "cab-build" });
    expect(main.steps[5]!.subBuild!.staging.x).toBeGreaterThan(0);
    // the step runs the cab's three steps (2.5 s), then the slide and the drop (0.6 s each)
    expect(main.steps[5]!.end - main.steps[5]!.start).toBeCloseTo(3.7, 6);
  });

  test("frame equals frameAt on a time grid over the whole loop", () => {
    for (let k = 0; k < 60; k++) {
      const t = (am.loop * k) / 60 + 0.0211;
      expect(frameOf(m, t), `t=${t}`).toEqual(expectedAttrs(am.frameAt(t)));
    }
  });

  test.each([1, 0.5, 2])("%s x: every flight swaps at one position", (speed) => {
    const warp = assemblyAnim(am as AssemblyRenderModel, speed).warp;
    for (const f of am.flights!) {
      const ts = f.visibility.find((k, i) => i > 0 && k.visible === false && k.t > 0)!.t;
      const at = warp(ts) / speed;
      const world = frameOf(m, at, speed)[am.ids.partMotion(f.path)]!.transform;
      const before = frameOf(m, at - 1e-4, speed)[f.id]!;
      expect(before.visibility).toBe("visible");
      const [wx, wy] = xy(world);
      const [fx, fy] = xy(before.transform);
      near(fx, wx, 0.5);
      near(fy, wy, 0.5);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A minimal evaluator of the emitted CSS of one wrapper id (transform, visibility, opacity)
// ---------------------------------------------------------------------------------------------

interface Stop {
  p: number;
  translate?: [number, number];
  visibility?: string;
  opacity?: number;
  timing?: string;
}
function cssPose(
  css: string,
  id: string,
  t: number,
  dur: number,
): { translate: [number, number]; visibility: string; opacity?: number } {
  const esc = id.replace(/\./g, "\\\\\\.");
  const rule = new RegExp(`(?:^|,)#${esc}(?:,[^{]*)?\\{animation:([^}]*)\\}`, "m").exec(css)?.[1];
  const out: { translate: [number, number]; visibility: string; opacity?: number } = {
    translate: [0, 0],
    visibility: "visible",
  };
  if (rule === undefined) return out;
  const u = (((t % dur) + dur) % dur) / dur;
  for (const one of rule.split(",")) {
    const [name, , tf] = one.split(" ") as [string, string, string];
    const body = new RegExp(`@keyframes ${name}\\{((?:[\\d.]+%\\{[^}]*\\})+)\\}`).exec(css)?.[1];
    if (body === undefined) continue;
    const stops = [...body.matchAll(/([\d.]+)%\{([^}]*)\}/g)].map((s): Stop => {
      const b = s[2] as string;
      const tr = /translate\((-?[\d.]+)px,(-?[\d.]+)px\)/.exec(b);
      return {
        p: Number(s[1]) / 100,
        ...(tr ? { translate: [Number(tr[1]), Number(tr[2])] as [number, number] } : {}),
        ...(/visibility:(\w+)/.test(b) ? { visibility: /visibility:(\w+)/.exec(b)![1]! } : {}),
        ...(/(?:^|;)opacity:(-?[\d.]+)/.test(b)
          ? { opacity: Number(/(?:^|;)opacity:(-?[\d.]+)/.exec(b)![1]) }
          : {}),
        ...(/animation-timing-function:([^;]*)/.test(b)
          ? { timing: /animation-timing-function:([^;]*)/.exec(b)![1]! }
          : {}),
      };
    });
    let i = 0;
    while (i < stops.length - 1 && u >= (stops[i + 1] as Stop).p) i++;
    const a = stops[i] as Stop;
    const b = stops[i + 1];
    const x = b === undefined ? 0 : (u - a.p) / (b.p - a.p);
    const e = (a.timing ?? tf) === "step-end" ? "step" : (a.timing ?? tf);
    const f = b === undefined || tf === "step-end" ? 0 : keyProgress(e as never, x);
    if (a.translate !== undefined) {
      const bt = b?.translate ?? a.translate;
      out.translate = [
        a.translate[0] + (bt[0] - a.translate[0]) * f,
        a.translate[1] + (bt[1] - a.translate[1]) * f,
      ];
    }
    if (a.visibility !== undefined) out.visibility = a.visibility;
    if (a.opacity !== undefined) {
      out.opacity = a.opacity + (((b?.opacity ?? a.opacity) as number) - a.opacity) * f;
    }
  }
  return out;
}
