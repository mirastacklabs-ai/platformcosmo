import { describe, expect, test } from "vitest";
import {
  buildModel,
  buildScene,
  createAnimator,
  type AssemblyFrameState,
  type PlatformCosmoSpec,
  type RenderModel,
} from "../../src/index.js";
import type { AssemblyRenderModel, LoopFade, SceneAssembly } from "../../src/contracts/index.js";
import { assemblyAnim, assemblyFrame, assemblyLoop } from "../../src/anim/assembly.js";
import { Keyframes } from "../../src/anim/css.js";
import { zoomFor } from "../../src/anim/timeline.js";
import { applyAffine } from "../../src/render/assembly/levels.js";
import { VIEW_FADE } from "../../src/render/assembly/views.js";
import type { AssemblyRenderModelX } from "../../src/render/assembly/types.js";
import { fixtureTheme } from "../fixtures/theme.js";
import { realPng, resolverOf } from "../figure-fixtures.js";

// B-3: levels, views and builds in the animator (docs/design/assemblies.md §6.5, §7.4, §7.7,
// §8.4, §12; tracks doc B-3). Phase 2 is not gated in buildScene/buildModel, so scenes come from
// specs.

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

function build(s: PlatformCosmoSpec): RenderModel {
  const imgs = images();
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
const A = (m: RenderModel): AssemblyRenderModel => m.assembly as AssemblyRenderModel;
const animate = (m: RenderModel, o: Parameters<ReturnType<typeof createAnimator>["animate"]>[1]) =>
  createAnimator().animate(m, o);

// ---------------------------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------------------------

/** Hall -> server -> CPU -> heat sink (rack -> server -> board chain of §19.4). */
const chain = (): PlatformCosmoSpec =>
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
    steps: [
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
      { caption: "back", duration: 3 },
    ],
  });

/** An L of three bricks built in three steps, each switching the quarter-turn view. */
const rig = (steps?: Obj[]): PlatformCosmoSpec =>
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
            id: "b",
            kind: "build",
            steps: [
              { add: ["base"], view: 90 },
              { add: ["tower"], view: 180 },
              { add: ["side"], view: 270 },
            ],
          },
        ],
      },
    ],
    steps: steps ?? [
      { caption: "base", duration: 4, assembly: [{ build: "l", program: "b", to: 1 }] },
      { caption: "tower", duration: 4, assembly: [{ build: "l", program: "b", to: 2 }] },
      { caption: "side", duration: 4, assembly: [{ build: "l", program: "b" }] },
      { caption: "take off", duration: 4, assembly: [{ unbuild: "l", program: "b", to: 1 }] },
      { caption: "put back", duration: 4, assembly: [{ build: "l", program: "b", to: 2 }] },
    ],
  });

/** The tower alone: built from step 1 on with the base present (no view changes). */
const plainBuild = (): PlatformCosmoSpec =>
  spec({
    assemblies: [
      {
        id: "p",
        units: "tile",
        pose: "empty",
        parts: [box("base", [0, 0, 0], [3, 2, 1]), box("tower", [0, 0, 1], [1, 1, 2])],
        programs: [{ id: "b", kind: "build", steps: [{ add: ["base"] }, { add: ["tower"] }] }],
      },
    ],
    steps: [
      { caption: "build", duration: 5, assembly: [{ build: "p", program: "b", to: 2 }] },
      { caption: "hold", duration: 3 },
    ],
  });

// ---------------------------------------------------------------------------------------------
// An independent evaluator of the emitted CSS for group ids (opacity and matrix keyframes)
// ---------------------------------------------------------------------------------------------

interface Stop {
  p: number;
  opacity?: number;
  matrix?: [number, number, number];
}
function keyframes(css: string): Map<string, Stop[]> {
  const out = new Map<string, Stop[]>();
  for (const m of css.matchAll(/@keyframes (\S+?)\{((?:[\d.]+%\{[^}]*\})+)\}/g)) {
    const stops = [...(m[2] as string).matchAll(/([\d.]+)%\{([^}]*)\}/g)].map((s): Stop => {
      const body = s[2] as string;
      const o = /(?:^|;)opacity:([-\d.]+)/.exec(body);
      const mx = /matrix\(([-\d.]+),0,0,[-\d.]+,([-\d.]+),([-\d.]+)\)/.exec(body);
      return {
        p: Number(s[1]) / 100,
        ...(o ? { opacity: Number(o[1]) } : {}),
        ...(mx ? { matrix: [Number(mx[1]), Number(mx[2]), Number(mx[3])] as Stop["matrix"] } : {}),
      };
    });
    out.set(m[1] as string, stops);
  }
  return out;
}
/** id -> animation names (`#id{animation:a 9s linear infinite,b 9s ...}`) and the loop seconds. */
function ruleNames(css: string, id: string): { names: string[]; dur: number; tfs: string[] } {
  const esc = id.replace(/\./g, "\\\\\\.");
  const re = new RegExp(`(?:^|,)#${esc}(?:,[^{]*)?\\{animation:([^}]*)\\}`, "m");
  const body = re.exec(css)?.[1];
  if (body === undefined) return { names: [], dur: 0, tfs: [] };
  const parts = body.split(",").map((a) => a.split(" "));
  return {
    tfs: parts.map((p) => p[2] as string),
    names: parts.map((p) => p[0] as string),
    dur: Number((parts[0] as string[])[1]!.replace("s", "")),
  };
}
/** Pose of a group id at output time `t` from the CSS: linear between stops. */
function cssGroup(
  css: string,
  id: string,
  t: number,
  kfCss = css,
): { opacity?: number; matrix?: [number, number, number] } {
  const kfs = keyframes(kfCss);
  const { names, dur, tfs } = ruleNames(css, id);
  const out: { opacity?: number; matrix?: [number, number, number] } = {};
  for (const [ni, n] of names.entries()) {
    const stops = kfs.get(n) as Stop[];
    const u = (((t % dur) + dur) % dur) / dur;
    let i = 0;
    while (i < stops.length - 1 && u >= (stops[i + 1] as Stop).p) i++;
    const a = stops[i] as Stop;
    const b = stops[i + 1];
    const f = b === undefined || tfs[ni] === "step-end" ? 0 : (u - a.p) / (b.p - a.p);
    if (a.opacity !== undefined) {
      out.opacity = a.opacity + (((b?.opacity ?? a.opacity) as number) - a.opacity) * f;
    }
    if (a.matrix !== undefined) {
      const bm = b?.matrix ?? a.matrix;
      out.matrix = a.matrix.map((v, k) => v + ((bm[k] as number) - v) * f) as [
        number,
        number,
        number,
      ];
    }
  }
  return out;
}
const matrixOf = (attr: string | number | undefined): [number, number, number] => {
  const m = /matrix\(([-\d.]+) 0 0 [-\d.]+ ([-\d.]+) ([-\d.]+)\)/.exec(String(attr));
  return [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])];
};
function splitReduced(css: string): { live: string; reduced: string } {
  const m = /@media \(prefers-reduced-motion:reduce\)\{\n([\s\S]*?)\n\}/.exec(css);
  return { live: m ? css.replace(m[0], "") : css, reduced: m ? (m[1] as string) : "" };
}
function expectedAttrs(f: AssemblyFrameState): Record<string, Record<string, string | number>> {
  const out: Record<string, Record<string, string | number>> = {};
  for (const [id, t] of Object.entries(f.transforms)) (out[id] ??= {}).transform = t;
  for (const id of f.hidden) (out[id] ??= {}).visibility = "hidden";
  for (const id of f.visible) (out[id] ??= {}).visibility = "visible";
  for (const [id, o] of Object.entries(f.opacity)) (out[id] ??= {}).opacity = o;
  return out;
}
const loopCss = (m: RenderModel, speed = 1): string =>
  animate(m, { speed, mode: "loop", motion: "css" }).css;
const frameOf = (m: RenderModel, t: number, speed = 1) =>
  animate(m, { speed, mode: "frame", time: t }).attrs ?? {};

// ---------------------------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------------------------

describe("close-up chain: level cross-fades", () => {
  const m = build(chain());
  const am = A(m);
  const levels = am.levels!;
  const clk = am.clock;
  const lv = (p: string) => levels.find((l) => l.path === p)!;
  const server = lv("hall/srv/closeup");
  const sink = lv("hall/srv/closeup/cpu-1/closeup");

  test("the chain has levels, and the model exposes their tracks", () => {
    expect(levels.length).toBeGreaterThanOrEqual(3);
    const groups = (am as AssemblyRenderModelX).groups!;
    expect(groups.map((g) => g.id)).toEqual([...groups.map((g) => g.id)].sort());
    for (const l of levels) {
      const g = groups.find((x) => x.id === l.group)!;
      expect(g.opacity[0]!.t).toBe(0);
      expect(g.opacity[g.opacity.length - 1]!.t).toBe(am.loop);
      expect(g.placement!.length).toBeGreaterThan(1);
    }
  });

  test("keyframes of the level groups (snapshot)", () => {
    const css = loopCss(m);
    const kfs = keyframes(css);
    const snap = [server, sink].map((l) => {
      const { names, dur } = ruleNames(css, l.group);
      return {
        path: l.path,
        dur,
        keyframes: names.map((n) => kfs.get(n)),
      };
    });
    expect(snap).toMatchSnapshot();
  });

  test("a cross-fade starts at the outgoing pose and ends at the settled incoming pose", () => {
    // step 2 focuses the server level: it cross-fades in over [end of step 1, start of step 2]
    const t0 = clk[0]!.end;
    const t1 = clk[1]!.start;
    expect(t1).toBeGreaterThan(t0);
    const before = frameOf(m, t0 - 0.01);
    const first = frameOf(m, t0);
    const last = frameOf(m, t1);
    const after = frameOf(m, t1 + 0.5);
    const g = server.group;
    expect(before[g]!.opacity).toBe(0);
    expect(first[g]!.opacity).toBe(0);
    expect(last[g]!.opacity).toBe(1);
    expect(after[g]!.opacity).toBe(1);
    // placement: the start is `fromHost(hostAt(0))` (no jump from the host), the end the overview
    const e = server.fromHost(server.hostAt(0));
    expect(matrixOf(first[g]!.transform)).toEqual([e.scale, e.tx, e.ty]);
    const ov = server.overview;
    expect(matrixOf(last[g]!.transform)).toEqual([ov.scale, ov.tx, ov.ty]);
    expect(matrixOf(after[g]!.transform)).toEqual([ov.scale, ov.tx, ov.ty]);
    // halfway it is between the two
    const mid = matrixOf(frameOf(m, (t0 + t1) / 2)[g]!.transform);
    expect(mid[0]).toBeGreaterThan(Math.min(e.scale, ov.scale) - 1e-6);
    expect(mid[0]).toBeLessThan(Math.max(e.scale, ov.scale) + 1e-6);
  });

  test("a nested close-up hands over: the outer level leaves while the inner one enters", () => {
    // step 3 focuses the heat-sink figure inside the server level
    const t0 = clk[1]!.end;
    const t1 = clk[2]!.start;
    const g = server.group;
    expect(frameOf(m, t0)[g]!.opacity).toBe(1);
    expect(frameOf(m, t0)[sink.group]!.opacity).toBe(0);
    expect(frameOf(m, t1)[g]!.opacity).toBe(0);
    expect(frameOf(m, t1)[sink.group]!.opacity).toBe(1);
    const ov = sink.overview;
    expect(matrixOf(frameOf(m, t1)[sink.group]!.transform)).toEqual([ov.scale, ov.tx, ov.ty]);
    // mid-transition both are partly visible (they sum to one: a cross-fade, never a gap)
    const mid = frameOf(m, (t0 + t1) / 2);
    expect((mid[g]!.opacity as number) + (mid[sink.group]!.opacity as number)).toBeCloseTo(1, 1);
    // the last step leaves the level: it fades out over the transition back
    const end = clk[3]!.start;
    expect(frameOf(m, end)[sink.group]!.opacity).toBe(0);
    expect(frameOf(m, clk[2]!.end)[sink.group]!.opacity).toBe(1);
  });

  test("frame mode equals frameAt of the model on a time grid", () => {
    for (let k = 0; k < 40; k++) {
      const t = (am.loop * k) / 40 + 0.013;
      expect(frameOf(m, t), `t=${t}`).toEqual(expectedAttrs(am.frameAt(t)));
    }
    expect(frameOf(m, 0)).toEqual(expectedAttrs(am.frameAt(0)));
    expect(frameOf(m, am.loop)).toEqual(expectedAttrs(am.frameAt(0)));
  });

  test.each([1, 0.5, 2])("%s x: frame mode is the CSS pose at the same time", (speed) => {
    const css = loopCss(m, speed);
    const { live } = splitReduced(css);
    const dur = am.loop / speed;
    let compared = 0;
    for (let k = 0; k < 40; k++) {
      const t = dur * (0.0071 + ((k * 0.0253) % 1));
      const f = frameOf(m, t, speed);
      for (const l of levels) {
        const c = cssGroup(live, l.group, t);
        // a group that never changes has no animation: the DOM carries its rest state
        c.opacity ??= 0;
        expect(
          Math.abs((f[l.group]!.opacity as number) - c.opacity!),
          `${l.path} o @${t}`,
        ).toBeLessThan(0.02);
        const [fs, fx, fy] = matrixOf(f[l.group]!.transform);
        // a placement that never changes has no animation: the DOM carries the overview
        const want = c.matrix ?? [l.overview.scale, l.overview.tx, l.overview.ty];
        expect(Math.abs(fs - want[0]), `${l.path} s @${t}`).toBeLessThan(0.002);
        expect(Math.abs(fx - want[1]), `${l.path} x @${t}`).toBeLessThan(0.1);
        expect(Math.abs(fy - want[2]), `${l.path} y @${t}`).toBeLessThan(0.1);
        compared++;
      }
    }
    expect(compared).toBe(40 * levels.length);
  });

  test("the level's own parts move on the same loop (their wrappers are animated)", () => {
    const css = loopCss(m);
    const model = server.model!;
    const moving = model.tracks.filter((t) => t.motion.length > 0);
    expect(moving.length).toBeGreaterThan(0);
    for (const t of moving)
      expect(css).toContain(model.ids.partMotion(t.copy).replace(/\./g, "\\."));
    // and the frame writes them too
    const f = frameOf(m, clk[1]!.end);
    for (const t of moving) expect(f[model.ids.partMotion(t.copy)]).toBeDefined();
  });

  test("reduced motion snaps levels to the step's end pose", () => {
    const css = loopCss(m);
    const { reduced } = splitReduced(css);
    const kfs = keyframes(css);
    const starts = new Set(clk.map((c) => Number((c.start / am.loop).toFixed(6))));
    for (const l of levels) {
      const { names } = ruleNames(reduced, l.group);
      if (names.length === 0) {
        // never shown: no animation, and the model agrees
        for (const c of clk) expect(am.stepEnd(c.step).opacity[l.group]).toBe(0);
        continue;
      }
      for (const n of names)
        for (const s of kfs.get(n)!) expect(starts.has(Number(s.p.toFixed(6)))).toBe(true);
      for (const c of clk) {
        const want = am.stepEnd(c.step);
        for (const frac of [0.05, 0.5, 0.95]) {
          const got = cssGroup(reduced, l.group, c.start + c.duration * frac, css);
          expect(got.opacity, `${l.path} step ${c.step}`).toBeCloseTo(want.opacity[l.group]!, 1);
          const [s] = matrixOf(want.transforms[l.group]);
          expect(got.matrix?.[0] ?? l.overview.scale, `${l.path} step ${c.step}`).toBeCloseTo(s, 2);
        }
      }
    }
  });

  test("interactive: the settled target of a close-up step shows its level", () => {
    const layer = animate(m, { speed: 1, mode: "interactive", motion: "css" });
    const g = JSON.parse(/G=(\[[^\]]*\])/.exec(layer.script ?? "")![1] as string) as number[];
    const { live } = splitReduced(layer.css);
    expect(am.settled[1]).toBeDefined();
    const at = g[1] as number;
    expect(cssGroup(live, server.group, at).opacity).toBeCloseTo(1, 2);
    expect(cssGroup(live, sink.group, at).opacity).toBeCloseTo(0, 2);
    const at3 = g[2] as number;
    expect(cssGroup(live, sink.group, at3).opacity).toBeCloseTo(1, 2);
    expect(cssGroup(live, server.group, at3).opacity).toBeCloseTo(0, 2);
  });

  test("the main world cross-fades against the level", () => {
    const main = ["objects", "labels", "flows"].map((l) => `pc-t-ly_${l}`);
    for (const id of main) {
      const t0 = clk[0]!.end;
      const t1 = clk[1]!.start;
      expect(frameOf(m, t0)[id]!.opacity, id).toBe(1);
      expect(frameOf(m, t1)[id]!.opacity, id).toBe(0);
      const mid = frameOf(m, (t0 + t1) / 2);
      expect((mid[id]!.opacity as number) + (mid[server.group]!.opacity as number), id).toBeCloseTo(
        1,
        1,
      );
      // between two levels the world stays out; leaving the last one brings it back
      expect(frameOf(m, clk[2]!.start)[id]!.opacity, id).toBe(0);
      expect(frameOf(m, clk[3]!.start)[id]!.opacity, id).toBe(1);
    }
    expect(am.frameAt(clk[0]!.end).opacity["pc-t-ly_objects"]).toBe(1);
  });

  test.each([1, 0.5, 2])("%s x: the main world's frame equals its CSS pose", (speed) => {
    const live = splitReduced(loopCss(m, speed)).live;
    const dur = am.loop / speed;
    for (let k = 0; k < 30; k++) {
      const t = dur * (0.0087 + ((k * 0.0293) % 1));
      const f = frameOf(m, t, speed)["pc-t-ly_objects"]!.opacity as number;
      expect(Math.abs(f - cssGroup(live, "pc-t-ly_objects", t).opacity!), `@${t}`).toBeLessThan(
        0.02,
      );
    }
  });

  test("leaving a level reverses the entry: it shrinks into the host's drawn rect", () => {
    // step 4 (index 3) leaves the heat-sink level
    const t0 = clk[2]!.end;
    const t1 = clk[3]!.start;
    const g = sink.group;
    const at = (t: number) => matrixOf(frameOf(m, t)[g]!.transform);
    const ov = sink.overview;
    expect(at(t0)).toEqual([ov.scale, ov.tx, ov.ty]);
    const host = sink.fromHost(sink.hostAt(3));
    expect(at(t1)).toEqual([host.scale, host.tx, host.ty]);
    expect(frameOf(m, t1)[g]!.opacity).toBe(0);
    const mid = at((t0 + t1) / 2)[0];
    expect(mid).toBeLessThan(ov.scale);
    expect(mid).toBeGreaterThan(host.scale);
    // at the end the level's content sits inside the host's rect
    const r = applyAffine({ scale: at(t1)[0], tx: at(t1)[1], ty: at(t1)[2] }, sink.rest);
    const h = sink.hostAt(3);
    expect(r.x).toBeGreaterThanOrEqual(h.x - 0.05);
    expect(r.y).toBeGreaterThanOrEqual(h.y - 0.05);
    expect(r.x + r.width).toBeLessThanOrEqual(h.x + h.width + 0.05);
    expect(r.y + r.height).toBeLessThanOrEqual(h.y + h.height + 0.05);
  });

  test("deterministic: the same model gives the same CSS", () => {
    expect(loopCss(build(chain()))).toBe(loopCss(m));
  });
});

describe("close-ups: last step in a level, and entry from a zoomed parent", () => {
  const floor = box("floor", [-600, -600, -10], [1700, 1700, 10]);
  const make = (steps: Obj[]): PlatformCosmoSpec => {
    const s = chain() as unknown as { assemblies: Obj[]; steps: Obj[] };
    const hall = s.assemblies.find((a) => a.id === "hall")!;
    (hall.parts as Obj[]).push(floor);
    s.steps = steps;
    return s as unknown as PlatformCosmoSpec;
  };

  test("a level shown in the last step leaves over the closing window (no pop at the restart)", () => {
    const m = build(
      make([
        { caption: "hall", duration: 3 },
        {
          caption: "server",
          duration: 4,
          focus: "hall/srv/closeup",
          assembly: [{ explode: "hall/srv/closeup" }],
        },
      ]),
    );
    const am = A(m);
    const l = am.levels!.find((x) => x.path === "hall/srv/closeup")!;
    const end = am.clock[1]!.end;
    expect(am.loop).toBeGreaterThan(end);
    const f = (t: number) => frameOf(m, t);
    expect(f(end)[l.group]!.opacity).toBe(1);
    expect(f(end)["pc-t-ly_objects"]!.opacity).toBe(0);
    const mid = f((end + am.loop) / 2);
    expect(mid[l.group]!.opacity as number).toBeCloseTo(0.5, 1);
    expect(mid["pc-t-ly_objects"]!.opacity as number).toBeCloseTo(0.5, 1);
    // by the loop end the level is gone and the world is back: the restart is seamless
    const last = f(am.loop - 1e-3);
    expect(last[l.group]!.opacity as number).toBeLessThan(0.02);
    expect(last["pc-t-ly_objects"]!.opacity as number).toBeGreaterThan(0.98);
    expect(f(0)[l.group]!.opacity).toBe(0);
    expect(f(0)["pc-t-ly_objects"]!.opacity).toBe(1);
    expect(frameOf(m, 0)).toEqual(expectedAttrs(am.frameAt(0)));
    // the CSS agrees at 3 speeds
    for (const speed of [1, 0.5, 2]) {
      const live = splitReduced(loopCss(m, speed)).live;
      const dur = am.loop / speed;
      for (const frac of [0.7, 0.8, 0.9, 0.97]) {
        const t = dur * frac;
        const got = cssGroup(live, l.group, t).opacity!;
        expect(Math.abs((frameOf(m, t, speed)[l.group]!.opacity as number) - got)).toBeLessThan(
          0.02,
        );
      }
    }
  });

  test("entering from a zoomed parent: the level starts on the host's rect", () => {
    const m = build(
      make([
        { caption: "rack", duration: 3, focus: "hall/srv" },
        {
          caption: "server",
          duration: 4,
          focus: "hall/srv/closeup",
          assembly: [{ explode: "hall/srv/closeup" }],
        },
      ]),
    );
    const am = A(m);
    expect(zoomFor(m, m.scene.timeline[0])?.scale ?? 1).toBeGreaterThan(1.01);
    const l = am.levels![0]!;
    const g = matrixOf(frameOf(m, am.clock[0]!.end)[l.group]!.transform);
    const r = applyAffine({ scale: g[0], tx: g[1], ty: g[2] }, l.rest);
    const h = l.hostRect;
    expect(r.x).toBeGreaterThanOrEqual(h.x - 0.1);
    expect(r.y).toBeGreaterThanOrEqual(h.y - 0.1);
    expect(r.x + r.width).toBeLessThanOrEqual(h.x + h.width + 0.1);
    expect(r.y + r.height).toBeLessThanOrEqual(h.y + h.height + 0.1);
    expect(r.x + r.width / 2).toBeCloseTo(h.x + h.width / 2, 0);
    expect(r.y + r.height / 2).toBeCloseTo(h.y + h.height / 2, 0);
    expect(frameOf(m, am.clock[0]!.end)[l.group]!.opacity).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

describe("quarter-turn views", () => {
  const m = build(rig());
  const am = A(m);
  const scene = m.scene.assemblies!;
  const views = am.views!;
  const group = (turn: number) => views.find((v) => v.turn === turn)!.group;
  const css = loopCss(m);

  /** The planned switch times: the action's own `views` (never recomputed from programs). */
  const switches = scene.plan.flatMap((p, i) =>
    p.actions.flatMap((a) =>
      (a.views ?? []).map((v) => ({
        t: Math.round((am.clock[i]!.open + a.start + v.at * a.scale) * 1e4) / 1e4,
        view: v.view,
      })),
    ),
  );

  test("the scene plans a switch at the start of each view-setting build step", () => {
    // build 1, 2, 3, then the unbuild reverses steps 3 and 2, then step 2 is built again
    expect(switches.map((s) => s.view)).toEqual([90, 180, 270, 180, 90, 180]);
    expect(switches.map((s) => s.t)).toEqual([...switches.map((s) => s.t)].sort((a, b) => a - b));
    expect(switches[0]!.t).toBe(0);
    expect(switches[1]!.t).toBe(4);
  });

  test("keyframes of the view groups (snapshot)", () => {
    const kfs = keyframes(css);
    const snap = views.map((v) => ({
      turn: v.turn,
      keyframes: ruleNames(css, v.group).names.map((n) => kfs.get(n)),
    }));
    expect(snap).toMatchSnapshot();
  });

  test("views swap exactly at the planned times, over VIEW_FADE", () => {
    const op = (t: number, turn: number) => frameOf(m, t)[group(turn)]!.opacity as number;
    for (const [i, s] of switches.entries()) {
      if (s.t === 0) continue;
      const prev = i === 0 ? 0 : switches[i - 1]!.view;
      expect(op(s.t - 0.01, s.view), `before ${s.t}`).toBe(0);
      expect(op(s.t - 0.01, prev), `before ${s.t}`).toBe(1);
      expect(op(s.t, s.view)).toBe(0);
      expect(op(s.t + VIEW_FADE / 2, s.view)).toBeCloseTo(0.5, 1);
      expect(op(s.t + VIEW_FADE, s.view)).toBe(1);
      expect(op(s.t + VIEW_FADE, prev)).toBe(0);
    }
    // time 0 is the rest frame: view 0 shown
    expect(frameOf(m, 0)[group(0)]!.opacity).toBe(1);
    expect(frameOf(m, 0)[group(90)]!.opacity).toBe(0);
  });

  test("exactly one view is fully shown between swaps; fades sum to one", () => {
    for (let k = 0; k < 60; k++) {
      const t = (am.loop * k) / 60 + 0.021;
      const f = frameOf(m, t);
      const sum = views.reduce((n, v) => n + (f[v.group]!.opacity as number), 0);
      expect(sum, `t=${t}`).toBeCloseTo(1, 1);
    }
  });

  test("frame mode equals frameAt on a time grid, and the CSS pose at three speeds", () => {
    for (let k = 0; k < 40; k++) {
      const t = (am.loop * k) / 40 + 0.017;
      expect(frameOf(m, t), `t=${t}`).toEqual(expectedAttrs(am.frameAt(t)));
    }
    for (const speed of [1, 0.5, 2]) {
      const c = splitReduced(loopCss(m, speed)).live;
      const dur = am.loop / speed;
      for (let k = 0; k < 30; k++) {
        const t = dur * (0.0093 + ((k * 0.0331) % 1));
        const f = frameOf(m, t, speed);
        for (const v of views) {
          const got = cssGroup(c, v.group, t).opacity!;
          expect(
            Math.abs((f[v.group]!.opacity as number) - got),
            `${v.turn} @${t} x${speed}`,
          ).toBeLessThan(0.02);
        }
      }
    }
  });

  test("each view's parts are animated under its own scoped ids", () => {
    for (const v of views.filter((x) => x.turn !== 0)) {
      const moving = v.model.tracks.filter((t) => t.motion.length > 0 || t.visibility.length > 0);
      expect(moving.length, `view ${v.turn}`).toBeGreaterThan(0);
      const f = frameOf(m, 6);
      for (const t of moving) {
        const id =
          t.motion.length > 0 ? v.model.ids.partMotion(t.copy) : v.model.ids.partVisible(t.copy);
        expect(f[id], id).toBeDefined();
        expect(css).toContain(id.replace(/\./g, "\\."));
      }
    }
  });

  test("reduced motion: views snap at step boundaries", () => {
    const { reduced } = splitReduced(css);
    const kfs = keyframes(css);
    const starts = new Set(am.clock.map((c) => Number((c.start / am.loop).toFixed(6))));
    for (const v of views) {
      const { names } = ruleNames(reduced, v.group);
      expect(names.length, `view ${v.turn}`).toBeGreaterThan(0);
      for (const n of names)
        for (const s of kfs.get(n)!) expect(starts.has(Number(s.p.toFixed(6)))).toBe(true);
      for (const c of am.clock) {
        const want = am.stepEnd(c.step).opacity[v.group]!;
        expect([0, 1]).toContain(want);
        for (const frac of [0.02, 0.5, 0.97]) {
          expect(cssGroup(reduced, v.group, c.start + c.duration * frac, css).opacity).toBeCloseTo(
            want,
            2,
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------------------------

describe("builds: appearance along the planned path", () => {
  const m = build(rig());
  const am = A(m);
  const track = (leaf: string) => am.tracks.find((t) => t.copy === `l/${leaf}`)!;
  const ids = am.ids;
  const f = (t: number) => frameOf(m, t);
  const opacityOf = (leaf: string, t: number) => f(t)[ids.partFade(`l/${leaf}`)]!.opacity as number;
  const hiddenOf = (leaf: string, t: number) =>
    f(t)[ids.partVisible(`l/${leaf}`)]?.visibility === "hidden";
  const dy = (leaf: string, t: number): number =>
    Number(
      /translate\(-?[\d.]+ (-?[\d.]+)\)/.exec(
        String(f(t)[ids.partMotion(`l/${leaf}`)]!.transform),
      )![1],
    );
  const fades = (m.scene.assemblies!.assemblies[0] as SceneAssembly).loopStart!.fades;

  test("the contract's loop start fades are consumed: base pose at time 0, absent after", () => {
    expect(fades.map((x) => x.path)).toEqual(["l/base", "l/side", "l/tower"]);
    // the rest frame is the base pose: everything built, seated, opaque
    for (const leaf of ["base", "tower", "side"]) {
      expect(hiddenOf(leaf, 0), leaf).toBe(false);
      expect(opacityOf(leaf, 0), leaf).toBe(1);
      expect(dy(leaf, 0), leaf).toBe(0);
    }
    // the fade windows end where the contract says: the parts are absent
    const side = fades.find((x) => x.path === "l/side") as LoopFade;
    expect(opacityOf("side", side.t0)).toBe(side.from);
    expect(opacityOf("side", side.t0 + side.t1 / 2)).toBeCloseTo(0.5, 1);
    expect(opacityOf("side", side.t1)).toBe(side.to);
    expect(hiddenOf("side", side.t1 + 0.01)).toBe(true);
    expect(hiddenOf("tower", side.t1 + 0.01)).toBe(true);
  });

  test("a part stays visible (and seated) while its loop-start fade runs", () => {
    const side = fades.find((x) => x.path === "l/side") as LoopFade;
    for (const frac of [0.1, 0.5, 0.9]) {
      const t = side.t0 + (side.t1 - side.t0) * frac;
      expect(hiddenOf("side", t), `side @${t}`).toBe(false);
      expect(dy("side", t)).toBe(0);
    }
  });

  test.todo(
    "(c) loop-start overlap: l/tower is hidden at 0.0011 s although its fade runs 0-0.4 s (the plan should open step 1's motion at max(lead_1, fade end))",
  );

  test("a built part appears when its move starts and moves to its seat", () => {
    // step 2 (4..8) builds the tower: hidden before, visible at its move start
    expect(hiddenOf("tower", 3.99)).toBe(true);
    expect(hiddenOf("tower", 4.01)).toBe(false);
    expect(opacityOf("tower", 4.01)).toBeLessThan(0.2);
    expect(opacityOf("tower", 4.25)).toBe(1);
    // it starts above its seat and arrives (screen y rises towards the seat)
    expect(dy("tower", 4.05)).toBeLessThan(dy("tower", 4.3));
    expect(dy("tower", 7)).toBe(0);
    // the motion track is shared by the model: frame = model.frameAt
    expect(track("tower").visibility.length).toBeGreaterThan(0);
  });

  test("unbuild is the mirror of build: fade, path and vanish time", () => {
    // the tower's moves as played: its build (step 2) and its reversed move (step 4)
    const mv = (am as AssemblyRenderModelX).moves.filter((x) => x.path === "l/tower");
    const built = mv.find((x) => x.t0 >= 4 && x.t0 < 8 && x.t1 > x.t0)!;
    const gone = mv.find((x) => x.t0 >= 12 && x.t0 < 16 && x.t1 > x.t0)!;
    const len = built.t1 - built.t0;
    expect(gone.t1 - gone.t0).toBeCloseTo(len, 3);
    // the part stays until the reversed move ends, then is hidden
    expect(hiddenOf("tower", gone.t1 - 0.05)).toBe(false);
    expect(hiddenOf("tower", gone.t1 + 0.05)).toBe(true);
    // positions mirror each other in time (the easing is mirrored)
    for (const x of [0.05, 0.15, 0.25, 0.35, 0.45, 0.55]) {
      expect(dy("tower", built.t0 + x), `x=${x}`).toBeCloseTo(dy("tower", gone.t1 - x), 1);
    }
    // the fade-out is the fade-in mirrored in time
    for (const x of [0.02, 0.05, 0.1, 0.15]) {
      expect(opacityOf("tower", built.t0 + x), `x=${x}`).toBeCloseTo(
        opacityOf("tower", gone.t1 - x),
        1,
      );
    }
  });

  test("a rebuilt part starts at its origin again", () => {
    // step 5 (16..20) puts the tower back
    expect(hiddenOf("tower", 15.9)).toBe(true);
    expect(hiddenOf("tower", 16.05)).toBe(false);
    expect(dy("tower", 16.05)).toBeLessThan(dy("tower", 16.4));
    expect(dy("tower", 16.3)).toBeCloseTo(dy("tower", 4.3), 1);
    expect(dy("tower", 19.5)).toBe(0);
  });

  test("the loop closure fades the parts back to the rest pose (seated, opaque)", () => {
    const cl = am.closure;
    expect(cl).toBeDefined();
    // the side was built in step 3 and stays; the base pose has it: present at the end too
    const end = am.loop - 1e-3;
    for (const leaf of ["base", "tower", "side"]) {
      expect(hiddenOf(leaf, end), leaf).toBe(false);
      expect(opacityOf(leaf, end), leaf).toBe(1);
      expect(dy(leaf, end), leaf).toBe(0);
    }
  });

  test("frame mode equals frameAt on a time grid (parts, views and builds together)", () => {
    for (let k = 0; k < 80; k++) {
      const t = (am.loop * k) / 80 + 0.0137;
      expect(frameOf(m, t), `t=${t}`).toEqual(expectedAttrs(am.frameAt(t)));
    }
  });

  test.each([1, 0.5, 2])(
    "%s x: the CSS keeps the part visibility and opacity of the frame",
    (speed) => {
      const css = splitReduced(loopCss(m, speed)).live;
      const dur = am.loop / speed;
      const id = ids.partFade("l/tower");
      for (let k = 0; k < 30; k++) {
        const t = dur * (0.0057 + ((k * 0.0341) % 1));
        const got = cssGroup(css, id, t).opacity;
        if (got === undefined) continue;
        expect(
          Math.abs((frameOf(m, t, speed)[id]!.opacity as number) - got),
          `@${t} x${speed}`,
        ).toBeLessThan(0.02);
      }
    },
  );

  test("reduced motion: builds show their step's end pose, no tween", () => {
    const css = loopCss(m);
    const { reduced } = splitReduced(css);
    expect(reduced).toContain("step-end");
    for (const leaf of ["tower"]) {
      const id = ids.partFade(`l/${leaf}`);
      for (const c of am.clock) {
        const want = am.stepEnd(c.step).opacity[id]!;
        for (const frac of [0.05, 0.5, 0.95]) {
          const rg = cssGroup(reduced, id, c.start + c.duration * frac, css).opacity;
          expect(rg, `${leaf} step ${c.step}: animated in reduced motion`).toBeDefined();
          expect(rg, `${leaf} step ${c.step}`).toBeCloseTo(want, 1);
        }
      }
    }
  });
});

describe("builds from an empty base: appear along the path, then hold", () => {
  const m = build(plainBuild());
  const am = A(m);
  const f = (t: number) => frameOf(m, t);

  test("rest frame shows the base pose (empty), the loop builds it up", () => {
    const fade = (name: string) => am.ids.partFade(`p/${name}`);
    const vis = (name: string, t: number) =>
      f(t)[am.ids.partVisible(`p/${name}`)]?.visibility === "hidden";
    // nothing is there at rest: hidden, or visible at opacity 0 (its build starts at time 0)
    const op = (name: string, t: number) => f(t)[am.ids.partFade(`p/${name}`)]?.opacity;
    expect(vis("base", 0) || op("base", 0) === 0).toBe(true);
    expect(vis("tower", 0)).toBe(true);
    // the base builds first (from time 0), the tower after it
    expect(f(0.1)[am.ids.partFade("p/base")]!.opacity as number).toBeGreaterThan(0);
    expect(vis("tower", 0.1)).toBe(true);
    // the end of step 1 has both; the closure fades them out over the closing window
    const s1 = am.stepEnd(1);
    expect(s1.hidden).not.toContain(am.ids.partVisible("p/base"));
    expect(s1.hidden).not.toContain(am.ids.partVisible("p/tower"));
    expect(s1.opacity[fade("tower")]).toBe(1);
    const cl = am.closure!;
    expect(cl).toBeDefined();
    expect(f(cl.t0)[fade("tower")]!.opacity).toBe(1);
    expect(f(cl.t0 + (cl.t1 - cl.t0) / 2)[fade("tower")]!.opacity as number).toBeCloseTo(0.5, 1);
    expect(f(cl.t1 - 1e-3)[fade("tower")]!.opacity as number).toBeLessThan(0.02);
    expect(f(cl.t1 - 1e-3)[fade("base")]!.opacity as number).toBeLessThan(0.02);
  });

  test("deterministic output", () => {
    expect(loopCss(build(plainBuild()))).toBe(loopCss(m));
  });
});

// ---------------------------------------------------------------------------------------------
// Gate: nothing changes without levels, views or builds
// ---------------------------------------------------------------------------------------------

describe("byte identity gate", () => {
  test("a spec with explode actions only has no group tracks and no matrix keyframes", () => {
    const s = spec({
      assemblies: [
        {
          id: "e",
          units: "tile",
          parts: [box("a", [0, 0, 0], [2, 2, 1]), box("b", [0, 0, 1], [1, 1, 1])],
          programs: [{ id: "x", stages: [{ parts: ["b"], direction: "up", distance: 2 }] }],
        },
      ],
      steps: [{ caption: "x", duration: 4, assembly: [{ explode: "e", program: "x" }] }],
    });
    const m = build(s);
    expect((A(m) as AssemblyRenderModelX).groups).toBeUndefined();
    const css = loopCss(m);
    expect(css).not.toContain("matrix(");
    expect(assemblyAnim(A(m), 1).props.every((p) => p.kind !== "matrix")).toBe(true);
    // no build presence either: every track is the explode one
    expect(A(m).levels).toBeUndefined();
    expect(A(m).views).toBeUndefined();
  });

  test("assemblyFrame and the Keyframes helper handle an assembly model without groups", () => {
    const m = build(plainBuild());
    expect(assemblyFrame(A(m), 1, 1)).toBeDefined();
    const kf = new Keyframes("pc-t");
    const out = assemblyLoop(A(m), 1, m.ids, kf, A(m).loop);
    expect(out.rules.length).toBeGreaterThan(0);
    expect(out.diagnostics).toEqual([]);
  });
});
