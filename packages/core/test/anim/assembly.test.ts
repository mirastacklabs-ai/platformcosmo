import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildModel,
  buildScene,
  createAnimator,
  emit,
  type AnimationLayer,
  type AssemblyFrameState,
  type PlatformCosmoSpec,
  type RenderModel,
} from "../../src/index.js";
import type { AssemblyRenderModel } from "../../src/contracts/index.js";
import {
  MAX_KEYS,
  MAX_PROPS,
  assemblyAnim,
  assemblyDiagnostics,
  assemblyFrame,
  assemblyLoop,
} from "../../src/anim/assembly.js";
import { evalOffset as evalOffsetOrig, translateFull } from "../../src/render/assembly/tracks.js";
import { Keyframes } from "../../src/anim/css.js";
import { fixtureTheme } from "../fixtures/theme.js";
import { realPng, resolverOf } from "../figure-fixtures.js";
import { buildFixture } from "./fixtures/render-model.js";

// B-1: the assembly animator (docs/design/assemblies.md §7.5, §9.4, §12; tracks doc B-1).

type Obj = Record<string, unknown>;
const examples = (): Obj[] => {
  const md = readFileSync(
    new URL("../../../../docs/design/assemblies.md", import.meta.url),
    "utf8",
  );
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .filter((s) => typeof s.meta === "object");
};
const example = (prefix: string): PlatformCosmoSpec =>
  structuredClone(
    examples().find((s) => (s.meta as { title: string }).title.startsWith(prefix)),
  ) as unknown as PlatformCosmoSpec;

function build(spec: PlatformCosmoSpec): RenderModel {
  const imgs = resolverOf({ "gpu-photo": realPng(640, 240, (x, y) => [x % 256, y, 120, 255]) });
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
const A = (m: RenderModel): AssemblyRenderModel => m.assembly as AssemblyRenderModel;
const animate = (m: RenderModel, o: Parameters<ReturnType<typeof createAnimator>["animate"]>[1]) =>
  createAnimator().animate(m, o);
const svgOf = (m: RenderModel, l: AnimationLayer, raster = false): string =>
  emit(m, l, { font: "system", ...(raster ? { target: "raster" as const } : {}) });
const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

const engine = (): PlatformCosmoSpec => example("Inline-4");
const gpu = (): PlatformCosmoSpec => example("2U GPU");
/** The engine without its closing implode: it ends exploded, so the loop closure plays. */
const engineClosing = (): PlatformCosmoSpec => {
  const s = engine() as unknown as { steps: unknown[] };
  s.steps.pop();
  return s as unknown as PlatformCosmoSpec;
};
/** Assemblies but no assembly actions anywhere. */
const noActions = (): PlatformCosmoSpec => {
  const s = engine() as unknown as { steps: Obj[] };
  for (const st of s.steps) delete st.assembly;
  return s as unknown as PlatformCosmoSpec;
};

// ---------------------------------------------------------------------------------------------
// An independent CSS animation evaluator: reads only the emitted text.
// ---------------------------------------------------------------------------------------------

type Stop = { p: number; decl: string; tf: string };
const kfCache = new Map<string, Map<string, Stop[]>>();
function parseKeyframes(css: string): Map<string, Stop[]> {
  const hit = kfCache.get(css);
  if (hit) return hit;
  const out = new Map<string, Stop[]>();
  for (const m of css.matchAll(/@keyframes (\S+?)\{((?:[\d.]+%\{[^}]*\})+)\}/g)) {
    const stops = [...(m[2] as string).matchAll(/([\d.]+)%\{([^}]*)\}/g)].map((s) => {
      const decl = (s[2] as string)
        .split(";")
        .filter((d) => !d.startsWith("animation-timing-function"));
      const tf = /animation-timing-function:([^;]*)/.exec(s[2] as string)?.[1] ?? "";
      return { p: Number(s[1]) / 100, decl: decl.join(";"), tf };
    });
    out.set(m[1] as string, stops);
  }
  kfCache.set(css, out);
  return out;
}
interface Anim {
  name: string;
  dur: number;
  tf: string;
}
/** Ids of assembly wrappers (host, motion, visible, fade, label), not captions. */
const isWrapper = (id: string): boolean => /^pc-t-p[hmvfl]_/.test(id);
/** id -> its animations, from `sel,sel{animation:a 9s linear infinite,b 9s step-end infinite}`. */
function parseRules(css: string): Map<string, Anim[]> {
  const out = new Map<string, Anim[]>();
  for (const m of css.matchAll(/^([^{}@\n]+)\{animation:([^};]+)\}$/gm)) {
    const anims = (m[2] as string).split(",").map((one): Anim => {
      const [name, dur, tf] = one.split(" ") as [string, string, string];
      return { name, dur: Number(dur.replace("s", "")), tf };
    });
    for (const sel of (m[1] as string).split(",")) {
      if (!sel.startsWith("#")) continue;
      const id = sel.slice(1).replace(/\\(.)/g, "$1");
      if (!isWrapper(id)) continue;
      out.set(id, [...(out.get(id) ?? []), ...anims]);
    }
  }
  return out;
}
function bezier(tf: string, x: number): number {
  if (tf === "linear" || tf === "") return x;
  if (tf === "step-end") return x < 1 ? 0 : 1;
  const named: Record<string, string> = {
    ease: "0.25,0.1,0.25,1",
    "ease-in": "0.42,0,1,1",
    "ease-out": "0,0,0.58,1",
    "ease-in-out": "0.42,0,0.58,1",
  };
  const args = named[tf] ?? /cubic-bezier\(([^)]*)\)/.exec(tf)![1]!;
  const [x1, y1, x2, y2] = args.split(",").map(Number) as [number, number, number, number];
  const f = (a: number, b: number, u: number) =>
    3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  return f(y1, y2, (lo + hi) / 2);
}
type Value = { transform?: [number, number]; opacity?: number; visibility?: string };
/** The properties an element has at output time `t`, as a browser would compute them. */
function cssPose(css: string, rules: Map<string, Anim[]>, id: string, t: number): Value {
  const kfs = parseKeyframes(css);
  const out: Value = {};
  for (const anim of rules.get(id) ?? []) {
    const stops = kfs.get(anim.name) as Stop[];
    const u = (((t % anim.dur) + anim.dur) % anim.dur) / anim.dur;
    let i = 0;
    while (i < stops.length - 1 && u >= (stops[i + 1] as Stop).p) i++;
    const a = stops[i] as Stop;
    const b = stops[i + 1];
    const nums = (s: Stop) => (s.decl.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (a.decl.startsWith("visibility:")) {
      out.visibility = a.decl.slice("visibility:".length);
      continue;
    }
    const va = nums(a);
    const v =
      b === undefined
        ? va
        : va.map(
            (x, k) =>
              x + ((nums(b)[k] as number) - x) * bezier(a.tf || anim.tf, (u - a.p) / (b.p - a.p)),
          );
    if (a.decl.startsWith("transform:")) out.transform = [v[0] as number, v[1] as number];
    else out.opacity = v[0] as number;
  }
  return out;
}
const transformOf = (attr: string | number | undefined): [number, number] => {
  const m = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(String(attr));
  return [Number(m?.[1]), Number(m?.[2])];
};
/** Splits the layer's CSS: the `@media (prefers-reduced-motion)` body, and the rest. */
function splitReduced(css: string): { live: string; reduced: string } {
  const m = /@media \(prefers-reduced-motion:reduce\)\{\n([\s\S]*?)\n\}/.exec(css);
  return { live: m ? css.replace(m[0], "") : css, reduced: m ? (m[1] as string) : "" };
}
/** Attribute `name` of the element with `id` in an SVG string. */
function attrOf(svg: string, id: string, name: string): string | undefined {
  const tag = new RegExp(`<g id="${id.replace(/[.\\]/g, "\\$&")}"[^>]*>`).exec(svg)?.[0];
  return tag === undefined ? undefined : new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1];
}
const stripStyle = (svg: string): string => svg.replace(/<style>[\s\S]*?<\/style>/g, "");

/** What frame mode must show for a full frame state, per id and attribute. */
function expectedAttrs(f: AssemblyFrameState): Record<string, Record<string, string | number>> {
  const out: Record<string, Record<string, string | number>> = {};
  for (const [id, t] of Object.entries(f.transforms)) (out[id] ??= {}).transform = t;
  for (const id of f.hidden) (out[id] ??= {}).visibility = "hidden";
  for (const id of f.visible) (out[id] ??= {}).visibility = "visible";
  for (const [id, o] of Object.entries(f.opacity)) (out[id] ??= {}).opacity = o;
  return out;
}

const specs: [string, () => PlatformCosmoSpec][] = [
  ["Inline-4 engine (19.3)", engine],
  ["2U GPU server (19.2)", gpu],
];

// ---------------------------------------------------------------------------------------------

describe("keyframes per wrapper property (snapshots)", () => {
  test.each(specs)("%s", (_n, make) => {
    const model = build(make());
    const am = A(model);
    const css = animate(model, { speed: 1, mode: "loop", motion: "css" }).css;
    const kfs = parseKeyframes(css);
    const rules = parseRules(css.replace(/@media[\s\S]*$/, ""));
    // one @keyframes per distinct track body: equal tracks share
    expect(kfs.size).toBeLessThan([...rules.values()].flat().length);
    const bodyOf = (id: string): string[] =>
      (rules.get(id) ?? []).map(
        (a) =>
          `${a.dur}s ${a.tf} ` +
          (kfs.get(a.name) as Stop[])
            .map((s) => `${s.p}:${s.decl}${s.tf ? `/${s.tf}` : ""}`)
            .join(" "),
      );
    // a moving part, a copy wrapper, a label: their exact keyframes
    const pick = [
      am.tracks.find((t) => t.motion.length > 0 && t.visibility.length === 0),
      am.tracks.find((t) => t.visibility.length > 0),
      am.tracks.find((t) => t.opacity.length > 0),
    ];
    const ids = [
      ...pick.flatMap((t) =>
        t === undefined
          ? []
          : [
              [t.copy, "motion", am.ids.partMotion(t.copy)],
              [t.copy, "visible", am.ids.partVisible(t.copy)],
              [t.copy, "fade", am.ids.partFade(t.copy)],
            ].filter(([, , id]) => rules.has(id as string)),
      ),
      ...am.labelTracks.slice(0, 1).map((l) => [l.id, "label", l.id]),
    ];
    expect({
      loopSeconds: am.loop,
      keyframes: kfs.size,
      animatedIds: rules.size,
      sha: sha(css),
      samples: ids.map(([copy, kind, id]) => ({ copy, kind, kf: bodyOf(id as string) })),
    }).toMatchSnapshot();
  });
});

describe("no SMIL from the assembly layer", () => {
  test.each(specs)("%s: zero SMIL in css mode, and none in smil mode either (D32)", (_n, make) => {
    const model = build(make());
    for (const motion of ["css", "smil"] as const) {
      for (const mode of ["loop", "interactive"] as const) {
        const svg = svgOf(model, animate(model, { speed: 1, mode, motion }));
        expect(svg, `${mode}/${motion}`).not.toMatch(
          /<(animate|animateTransform|animateMotion|set)\b/,
        );
      }
    }
    const css = animate(model, { speed: 1, mode: "loop", motion: "smil" }).css;
    expect(css).toContain("@keyframes");
    expect(css).toContain("translate(");
  });
});

describe("frame mode is the CSS pose at the same time", () => {
  const speeds = [1, 0.5, 2];
  test.each(speeds)(
    "%s x: every wrapper, sampled across the loop",
    (speed) => {
      for (const [name, make] of [
        ...specs,
        ["closing", engineClosing] as [string, () => PlatformCosmoSpec],
      ]) {
        const model = build(make());
        const loop = animate(model, { speed, mode: "loop", motion: "css" });
        const rules = parseRules(splitReduced(loop.css).live);
        const dur = A(model).loop / speed;
        let compared = 0;
        for (let k = 0; k < 24; k++) {
          const t = dur * (0.0123 + ((k * 0.0407 * 1.0) % 1));
          const attrs = animate(model, { speed, mode: "frame", time: t }).attrs ?? {};
          for (const [id, set] of Object.entries(attrs)) {
            if (!rules.has(id)) continue; // board ids (none here) or DOM-only
            const css = cssPose(loop.css, rules, id, t);
            if (set.transform !== undefined) {
              const [fx, fy] = transformOf(set.transform);
              const [cx, cy] = css.transform as [number, number];
              expect(Math.abs(fx - cx), `${name} ${id} x @${t}`).toBeLessThan(0.05);
              expect(Math.abs(fy - cy), `${name} ${id} y @${t}`).toBeLessThan(0.05);
            }
            if (set.opacity !== undefined) {
              expect(
                Math.abs((set.opacity as number) - (css.opacity as number)),
                `${name} ${id} o @${t}`,
              ).toBeLessThan(0.02);
            }
            if (set.visibility !== undefined) {
              expect(set.visibility, `${name} ${id} v @${t}`).toBe(css.visibility);
            }
            compared++;
          }
        }
        expect(compared, name).toBeGreaterThan(100);
      }
    },
    60000,
  );

  test("the frame writes every wrapper; those without a CSS rule never change", () => {
    const model = build(gpu());
    const am = A(model);
    const loop = animate(model, { speed: 1, mode: "loop", motion: "css" });
    const rules = parseRules(splitReduced(loop.css).live);
    const attrs = animate(model, { speed: 1, mode: "frame", time: 3.3 }).attrs ?? {};
    const registered = Object.keys(expectedAttrs(am.frameAt(0))).sort();
    expect(Object.keys(attrs).sort()).toEqual(registered);
    for (const id of rules.keys()) expect(attrs[id], id).toBeDefined();
    const still = registered.filter((id) => !rules.has(id));
    expect(still.length).toBeGreaterThan(0);
    for (const t of [0, 1.7, 5.2, 9.9, 14.4, 19.9]) {
      const f = animate(model, { speed: 1, mode: "frame", time: t }).attrs ?? {};
      for (const id of still) expect(f[id], `${id} @${t}`).toEqual(attrs[id]);
    }
  });

  test("at speed 1 a frame is exactly frameAt(t) of the model (full state)", () => {
    for (const make of [engine, gpu, engineClosing]) {
      const model = build(make());
      const am = A(model);
      for (const t of [0, 0.7, 2.3, 5.01, 9.9, am.loop - 0.31, am.loop + 1.1, am.loop * 2 + 4]) {
        expect(animate(model, { speed: 1, mode: "frame", time: t }).attrs, `t=${t}`).toEqual(
          expectedAttrs(am.frameAt(t)),
        );
      }
    }
  });

  test("the loop wraps on the output clock", () => {
    const model = build(engine());
    const am = A(model);
    for (const speed of [0.5, 1, 2]) {
      const dur = am.loop / speed;
      const f = (t: number) => animate(model, { speed, mode: "frame", time: t }).attrs;
      expect(f(dur)).toEqual(f(0));
      expect(f(dur * 3 + 1.7)).toEqual(f(1.7));
      expect(f(-dur + 2.2)).toEqual(f(2.2));
      expect(f(0)).toEqual(expectedAttrs(am.frameAt(0)));
    }
  });
});

describe("every output path writes the assembly state", () => {
  test.each(specs)("%s: static, steps, frames and GIF frames (CSS stripped)", (_n, make) => {
    const model = build(make());
    const am = A(model);
    const check = (
      layer: AnimationLayer,
      expected: AssemblyFrameState,
      raster: boolean,
      label: string,
    ) => {
      const svg = stripStyle(svgOf(model, layer, raster));
      const want = expectedAttrs(expected);
      let seen = 0;
      for (const [id, set] of Object.entries(want)) {
        for (const [name, value] of Object.entries(set)) {
          const got = attrOf(svg, id, name);
          // an attribute equal to the SVG default may be omitted by the emitter
          const dflt =
            name === "opacity" ? "1" : name === "visibility" ? "visible" : "translate(0 0)";
          expect(got ?? dflt, `${label} ${id} ${name}`).toBe(String(value));
          seen++;
        }
      }
      expect(seen, label).toBeGreaterThan(50);
    };
    // static / default PNG: the rest frame
    check(animate(model, { speed: 1, mode: "frame", time: 0 }), am.frameAt(0), false, "static");
    check(animate(model, { speed: 1, mode: "frame", time: 0 }), am.frameAt(0), true, "png");
    // --steps: the end pose of each step
    for (let k = 1; k <= am.clock.length; k++) {
      check(
        animate(model, { speed: 1, mode: "step", step: k, motion: "css" }),
        am.stepEnd(k),
        false,
        `step ${k}`,
      );
    }
    // frames (GIF/MP4): raster
    for (const t of [0.4, 2.7, 6.1, 11.3]) {
      check(animate(model, { speed: 1, mode: "frame", time: t }), am.frameAt(t), true, `gif ${t}`);
    }
    // the step poses differ (the test would pass on a constant otherwise)
    const poses = new Set(
      am.clock.map((_, i) =>
        JSON.stringify(animate(model, { speed: 1, mode: "step", step: i + 1 }).attrs),
      ),
    );
    expect(poses.size).toBeGreaterThan(2);
  });

  test("step mode without a timeline falls back to the rest frame", () => {
    const spec = engine() as unknown as { steps?: unknown };
    delete spec.steps;
    const model = build(spec as unknown as PlatformCosmoSpec);
    const layer = animate(model, { speed: 1, mode: "step", step: 1 });
    expect(layer.attrs ?? {}).toEqual(
      animate(model, { speed: 1, mode: "frame", time: 0 }).attrs ?? {},
    );
  });

  test("loop output sets no attributes (the DOM carries the rest frame)", () => {
    const model = build(engine());
    expect(animate(model, { speed: 1, mode: "loop", motion: "css" }).attrs).toBeUndefined();
  });
});

describe("reduced motion", () => {
  test("with actions: discrete per-step poses, the 1.1 rule is not used", () => {
    const model = build(engine());
    const am = A(model);
    const { live, reduced } = splitReduced(
      animate(model, { speed: 1, mode: "loop", motion: "css" }).css,
    );
    expect(reduced).not.toContain("animation:none!important");
    expect(reduced).toContain("step-end");
    const rules = parseRules(reduced);
    const all = parseRules(live);
    // the same elements as the live motion
    expect([...rules.keys()].filter((k) => all.has(k)).sort()).toEqual([...all.keys()].sort());
    const css = live + "\n" + reduced;
    for (const c of am.clock) {
      const want = expectedAttrs(am.stepEnd(c.step));
      for (const frac of [0.02, 0.5, 0.97]) {
        const t = c.start + c.duration * frac; // speed 1
        for (const [id, set] of Object.entries(want)) {
          if (!rules.has(id)) continue;
          // only the reduced animations: evaluate against the reduced block's keyframes
          const got = cssPose(css, rules, id, t);
          if (set.transform !== undefined) {
            const [wx, wy] = transformOf(set.transform);
            expect(got.transform?.[0], `${id} step ${c.step}`).toBeCloseTo(wx, 1);
            expect(got.transform?.[1], `${id} step ${c.step}`).toBeCloseTo(wy, 1);
          }
          if (set.opacity !== undefined)
            expect(got.opacity, `${id} o step ${c.step}`).toBeCloseTo(set.opacity as number, 1);
          if (set.visibility !== undefined)
            expect(got.visibility, `${id} v step ${c.step}`).toBe(set.visibility);
        }
      }
    }
    // constant within a step: no tween (every stop of a reduced keyframes sits on a step start)
    const starts = new Set(am.clock.map((c) => Number((c.start / am.loop).toFixed(6))));
    for (const stops of parseKeyframes(reduced).values()) {
      for (const s of stops) expect(starts.has(Number(s.p.toFixed(6))), `stop ${s.p}`).toBe(true);
    }
  });

  test("the camera stays on the overview and particles-style 1.1 behaviour is kept for the rest", () => {
    const model = build(engine());
    const { reduced } = splitReduced(animate(model, { speed: 1, mode: "loop", motion: "css" }).css);
    expect(reduced).toContain("transform:none");
  });

  test("without actions the output is byte-identical to the model without an assembly layer", () => {
    const model = build(noActions());
    expect(A(model)).toBeDefined();
    const bare: RenderModel = { ...model, assembly: undefined };
    for (const motion of ["css", "smil"] as const) {
      for (const mode of ["loop", "interactive"] as const) {
        const a = animate(model, { speed: 1, mode, motion });
        const b = animate(bare, { speed: 1, mode, motion });
        expect(a.css).toBe(b.css);
        expect(a.script).toBe(b.script);
        expect(a.duration).toBe(b.duration);
      }
    }
    // and its reduced rule is the 1.1 one
    const css = animate(model, { speed: 1, mode: "loop", motion: "css" }).css;
    expect(splitReduced(css).reduced).toContain("*{animation:none!important}");
  });

  test("a 1.1 model is untouched: no assembly rule, same bytes with or without the code path", () => {
    const model = buildFixture();
    expect(model.assembly).toBeUndefined();
    const css = animate(model, { speed: 1, mode: "loop", motion: "css" }).css;
    expect(css).not.toMatch(/-p[mhvfl]_/);
    expect(sha(css)).toBe(
      sha(
        animate({ ...model, assembly: undefined }, { speed: 1, mode: "loop", motion: "css" }).css,
      ),
    );
    expect(animate(model, { speed: 1, mode: "frame", time: 1 }).attrs).toBeUndefined();
    expect(animate(model, { speed: 1, mode: "step", step: 1 }).attrs).toBeUndefined();
  });
});

describe("interactive Step pauses at the settled pose", () => {
  const targets = (script: string | undefined): number[] =>
    JSON.parse(/G=(\[[^\]]*\])/.exec(script ?? "")![1] as string) as number[];

  test.each([1, 0.5, 2])(
    "%s x: the Step target of a step with actions is its settled time",
    (speed) => {
      const model = build(gpu());
      const am = A(model);
      const layer = animate(model, { speed, mode: "interactive", motion: "css" });
      const g = targets(layer.script);
      expect(g).toHaveLength(am.clock.length);
      const rules = parseRules(splitReduced(layer.css).live);
      let withActions = 0;
      am.settled.forEach((s, i) => {
        if (s === undefined) return;
        withActions++;
        // the settled time lies inside the step, after its start
        const c = am.clock[i]!;
        expect(g[i]).toBeGreaterThan(c.start / speed);
        expect(g[i]).toBeLessThanOrEqual((c.start + c.duration) / speed);
        // independent expectation (§7.3): the motion plays from its start at spec speed and is
        // compressed only if it overflows the window left by the camera's closing transition
        const trBaked = c.start + c.duration - c.end;
        const tr = trBaked > 0 ? Math.min(0.8 * speed, 0.25 * c.duration) : 0;
        const room = c.duration - tr - 0.2; // lead is 0 here: open === start
        expect(c.open).toBe(c.start);
        expect(g[i]).toBeCloseTo((c.start + Math.min(s - c.start, room)) / speed, 3);
        // and the pose there is the settled pose: everything the step moves has arrived
        const want = expectedAttrs(am.stepEnd(i + 1));
        for (const [id, set] of Object.entries(want)) {
          if (!rules.has(id) || set.transform === undefined) continue;
          const got = cssPose(layer.css, rules, id, g[i] as number);
          const [wx, wy] = transformOf(set.transform);
          expect(
            Math.abs((got.transform as [number, number])[0] - wx),
            `${id} x step ${i + 1}`,
          ).toBeLessThan(0.1);
          expect(
            Math.abs((got.transform as [number, number])[1] - wy),
            `${id} y step ${i + 1}`,
          ).toBeLessThan(0.1);
        }
      });
      expect(withActions).toBeGreaterThan(2);
      // steps without actions (step 1) keep the existing targets
      expect(am.settled[0]).toBeUndefined();
    },
  );

  test("the script pauses every CSS animation under the root, assembly ones included", () => {
    const model = build(engine());
    const { script } = animate(model, { speed: 1, mode: "interactive", motion: "css" });
    expect(script).toContain("getAnimations({subtree:true})");
    expect(script).toContain("a.pause()");
    // assembly wrappers animate inside the root, so the subtree walk sees them
    const css = animate(model, { speed: 1, mode: "interactive", motion: "css" }).css;
    expect(css).toContain("pc-t-pm_");
  });
});

describe("speed and the camera", () => {
  test("keyframe percentages do not depend on speed; the duration is the output loop", () => {
    const model = build(engine());
    const at = (speed: number) => animate(model, { speed, mode: "loop", motion: "css" });
    const a = at(1);
    const b = at(2);
    expect(a.duration).toBeCloseTo(18, 3);
    expect(b.duration).toBeCloseTo(9, 3);
    const durs = new Set(
      [...parseRules(splitReduced(b.css).live).values()].flat().map((x) => x.dur),
    );
    expect([...durs].filter((d) => d !== 9 && d !== 18)).toEqual([]);
    expect(durs.has(9)).toBe(true);
  });

  test.each([1, 0.5, 2])(
    "%s x: the loop closure ends where the camera's closing transition does",
    (speed) => {
      const model = build(engineClosing());
      const am = A(model);
      expect(am.closure).toBeDefined(); // the test would be vacuous without it
      const loop = animate(model, { speed, mode: "loop", motion: "css" });
      const rules = parseRules(splitReduced(loop.css).live);
      const last = am.clock[am.clock.length - 1]!;
      const total = am.loop / speed;
      // tr on the output clock, as the camera computes it
      const tr = Math.min(0.8, (0.25 * last.duration) / speed);
      const rest = expectedAttrs(am.frameAt(0));
      const hold = expectedAttrs(am.stepEnd(last.step));
      const moved = Object.keys(hold).filter((id) => {
        const h = hold[id]!.transform;
        return h !== undefined && h !== rest[id]?.transform && rules.has(id);
      });
      expect(moved.length).toBeGreaterThan(5);
      const dist = (t: number): number =>
        Math.max(
          ...moved.map((id) => {
            const got = cssPose(loop.css, rules, id, t).transform as [number, number];
            const [wx, wy] = transformOf(hold[id]!.transform);
            return Math.hypot(got[0] - wx, got[1] - wy);
          }),
        );
      const back = (t: number): number =>
        Math.max(
          ...moved.map((id) => {
            const got = cssPose(loop.css, rules, id, t).transform as [number, number];
            const [wx, wy] = transformOf(rest[id]!.transform);
            return Math.hypot(got[0] - wx, got[1] - wy);
          }),
        );
      // before the camera starts easing back, the exploded pose is held; after it, the rest pose
      expect(dist(total - tr - 0.05)).toBeLessThan(0.1);
      expect(dist(total - tr * 0.8)).toBeGreaterThan(2);
      expect(dist(total - tr * 0.5)).toBeGreaterThan(1);
      expect(back(total - 0.0005)).toBeLessThan(1.5);
      // the fast return plays the camera's curve
      expect(loop.css).toContain("cubic-bezier(0.4,0,0.2,1)");
    },
  );
});

describe("speed: the warp follows 7.3 (compress only on overflow)", () => {
  const fakeClock = (settled: number | undefined) =>
    ({
      ids: {},
      tracks: [],
      labelTracks: [],
      staticFades: [],
      epochs: [],
      approximate: [],
      loop: 4,
      // one 4 s step with a closing transition (0.8) and no lead
      clock: [{ step: 1, start: 0, duration: 4, open: 0, end: 3.2 }],
      settled: [settled],
    }) as unknown as AssemblyRenderModel;

  test("the end of the motion overflows at speed 2 and is compressed; not at speed 0.5", () => {
    // 2: transition min(1.6, 1) = 1, window 4 - 1 - 0.2 = 2.8 < L = 3
    const w2 = assemblyAnim(fakeClock(3), 2).warp;
    expect(w2(0)).toBe(0);
    expect(w2(3)).toBeCloseTo(2.8, 4);
    expect(w2(3.2)).toBeCloseTo(3, 4); // hold end meets the camera's transition
    expect(w2(4)).toBe(4);
    expect(w2(1.5)).toBeCloseTo(1.4, 4); // linear inside the motion
    // 0.5: transition min(0.4, 1) = 0.4, window 3.4 - 0.2 = 3.2 >= L = 3: plays at spec speed
    const w05 = assemblyAnim(fakeClock(3), 0.5).warp;
    expect(w05(3)).toBeCloseTo(3, 4);
    expect(w05(3.2)).toBeCloseTo(3.6, 4);
    // a motion that fits at 2 is not compressed
    expect(assemblyAnim(fakeClock(1), 2).warp(1)).toBeCloseTo(1, 4);
    // speed 1 is the identity
    expect(assemblyAnim(fakeClock(3), 1).warp(2.7)).toBe(2.7);
  });

  /** Baked times near which values change abruptly: not sampled. */
  function nearBreakpoint(am: AssemblyRenderModel, t: number): boolean {
    const special = [
      ...am.clock.flatMap((c) => [c.start, c.open, c.end, c.start + c.duration]),
      ...am.settled.filter((x): x is number => x !== undefined),
      ...am.epochs.flatMap((e) => [e.t0, e.t1]),
      ...am.tracks.flatMap((k) => k.visibility.map((v) => v.t)),
      ...am.labelTracks.flatMap((l) => l.opacity.map((o) => o.t)),
    ];
    return special.some((x) => Math.abs(x - t) < 0.06);
  }

  test.each([0.5, 2])(
    "%s x: frame(warp(t)/speed) is the model's pose at t (independent oracle)",
    (speed) => {
      const model = build(gpu());
      const am = A(model);
      let compared = 0;
      for (let t = 0.11; t < am.loop; t += 0.29) {
        if (nearBreakpoint(am, t)) continue;
        const tau = assemblyAnim(am, speed).warp(t) / speed;
        const got = animate(model, { speed, mode: "frame", time: tau }).attrs ?? {};
        const want = expectedAttrs(am.frameAt(t));
        for (const [id, set] of Object.entries(want)) {
          for (const [name, v] of Object.entries(set)) {
            const g = got[id]?.[name];
            if (name === "transform") {
              const [gx, gy] = transformOf(g);
              const [wx, wy] = transformOf(v);
              expect(Math.hypot(gx - wx, gy - wy), `${id} @${t} x${speed}`).toBeLessThan(0.1);
            } else if (name === "opacity") {
              expect(
                Math.abs((g as number) - (v as number)),
                `${id} o @${t} x${speed}`,
              ).toBeLessThan(0.03);
            } else {
              expect(g, `${id} v @${t} x${speed}`).toBe(v);
            }
            compared++;
          }
        }
      }
      expect(compared).toBeGreaterThan(2000);
    },
  );

  test.each([0.5, 2])(
    "%s x: every step's motion has finished before the camera's transition",
    (speed) => {
      const model = build(gpu());
      const am = A(model);
      let checked = 0;
      for (const c of am.clock) {
        if (am.settled[c.step - 1] === undefined || c.start + c.duration - c.end <= 0) continue;
        expect(c.duration).toBeGreaterThan(3.2); // the 0.8 s cap binds, so the warp matters
        const tr = Math.min(0.8, (0.25 * c.duration) / speed); // the camera's, in output seconds
        const tau = (c.start + c.duration) / speed - tr - 0.02;
        const got = animate(model, { speed, mode: "frame", time: tau }).attrs ?? {};
        const want = expectedAttrs(am.stepEnd(c.step));
        for (const [id, set] of Object.entries(want)) {
          if (set.transform === undefined) continue;
          const [gx, gy] = transformOf(got[id]?.transform);
          const [wx, wy] = transformOf(set.transform);
          expect(Math.hypot(gx - wx, gy - wy), `${id} step ${c.step} x${speed}`).toBeLessThan(0.1);
        }
        checked++;
      }
      expect(checked).toBeGreaterThanOrEqual(3);
    },
  );

  test.each([0.5, 2])("%s x: a figure and an assembly in one step move together", (speed) => {
    const spec = engine() as unknown as { steps: { assembly?: unknown[] }[] } & Obj;
    spec.images = [
      { id: "base", src: "base.png" },
      { id: "spr", src: "spr.png" },
    ];
    spec.figures = [
      {
        id: "f",
        base: "base",
        parts: [
          { id: "p1", image: "spr", seat: [100, 300], exploded: [100, 100], label: "Part one" },
          { id: "p2", image: "spr", seat: [300, 320] },
        ],
      },
    ];
    spec.steps[2]!.assembly!.push({ explode: "f" });
    const imgs = resolverOf({
      base: realPng(600, 480, (_x, y) => [230 - (y >> 3), 235, 240, 255]),
      spr: realPng(80, 60, (x, y) => [40 + x, 90, 160 - y, 255]),
    });
    const parsed = spec as unknown as PlatformCosmoSpec;
    const scene = buildScene(parsed, { images: imgs });
    const model = buildModel({
      scene,
      theme: fixtureTheme(),
      font: "system",
      prefix: "pc-t",
      spec: parsed,
      images: imgs,
    });
    const am = A(model);
    const asmIds = new Set(Object.keys(expectedAttrs(am.frameAt(0))));
    const c = am.clock[2]!;
    const at = (tau: number) => animate(model, { speed, mode: "frame", time: tau }).attrs ?? {};
    const step = (k: number) =>
      animate(model, { speed, mode: "step", step: k, motion: "css" }).attrs ?? {};
    const dist = (a: Obj2, b: Obj2, pick: (id: string) => boolean): number => {
      let worst = 0;
      for (const id of Object.keys(a)) {
        if (!pick(id) || a[id]!.transform === undefined || b[id]?.transform === undefined) continue;
        const [ax, ay] = transformOf(a[id]!.transform);
        const [bx, by] = transformOf(b[id]!.transform);
        worst = Math.max(worst, Math.hypot(ax - bx, ay - by));
      }
      return worst;
    };
    type Obj2 = Record<string, Record<string, string | number>>;
    const isAsm = (id: string) => asmIds.has(id);
    const isFig = (id: string) => !asmIds.has(id);
    const tr = Math.min(0.8, (0.25 * c.duration) / speed);
    const before = c.start / speed - 0.01;
    const done = (c.start + c.duration) / speed - tr - 0.02;
    // the figure part ids really are in the frame
    expect(Object.keys(at(0)).some(isFig)).toBe(true);
    for (const [name, pick] of [
      ["assembly", isAsm],
      ["figure", isFig],
    ] as const) {
      // still at the previous step's pose until the step starts
      expect(dist(at(before), step(2), pick), `${name} before`).toBeLessThan(0.1);
      // moving at some time inside the window (actions of one step play one after another)
      let moved = 0;
      for (let k = 1; k <= 24; k++) {
        const tau = before + 0.01 + ((done - before) * k) / 25;
        moved = Math.max(moved, dist(at(tau), step(2), pick));
      }
      expect(moved, `${name} moves`).toBeGreaterThan(0.5);
      // settled at the step's pose before the camera moves
      expect(dist(at(done), step(3), pick), `${name} done`).toBeLessThan(0.1);
    }
  });
});

describe("output without assemblies is pinned (hashes produced on main, before B-1)", () => {
  const figureOnly = (): PlatformCosmoSpec =>
    ({
      meta: { version: "1", title: "fig" },
      images: [
        { id: "base", src: "base.png" },
        { id: "spr", src: "spr.png" },
      ],
      figures: [
        {
          id: "f",
          base: "base",
          stages: [
            { parts: ["p1"], duration: 1.2, easing: "ease-in-out" },
            { parts: ["p2"], duration: 1, easing: "ease", delay: 0.3 },
          ],
          parts: [
            {
              id: "p1",
              image: "spr",
              seat: [100, 300],
              exploded: [100, 100],
              label: "Part one",
              arrow: true,
            },
            { id: "p2", image: "spr", seat: [300, 320], label: "Part two", detail: ["a detail"] },
          ],
        },
      ],
      steps: [
        { caption: "a", duration: 2 },
        { caption: "b", duration: 5, assembly: [{ explode: "f" }] },
        { caption: "c", duration: 5, assembly: [{ implode: "f" }] },
      ],
    }) as unknown as PlatformCosmoSpec;
  const figureModel = (): RenderModel => {
    const imgs = resolverOf({
      base: realPng(600, 480, (_x, y) => [230 - (y >> 3), 235, 240, 255]),
      spr: realPng(80, 60, (x, y) => [40 + x, 90, 160 - y, 255]),
    });
    const spec = figureOnly();
    const scene = buildScene(spec, { images: imgs });
    return buildModel({
      scene,
      theme: fixtureTheme(),
      font: "system",
      prefix: "pc-t",
      spec,
      images: imgs,
    });
  };
  const digest = (model: RenderModel): string => {
    const parts: string[] = [];
    for (const speed of [1, 2]) {
      for (const motion of ["css", "smil"] as const) {
        for (const mode of ["loop", "interactive"] as const) {
          const l = animate(model, { speed, mode, motion });
          parts.push(l.css, l.script ?? "", String(l.duration));
        }
        parts.push(JSON.stringify(animate(model, { speed, mode: "step", step: 2, motion }).attrs));
      }
      for (const time of [0, 1.3, 3.1]) {
        parts.push(JSON.stringify(animate(model, { speed, mode: "frame", time }).attrs));
      }
    }
    return sha(parts.join("\n--\n"));
  };

  test("a figure-only spec", () => {
    const model = figureModel();
    expect(model.assembly).toBeUndefined();
    expect(digest(model)).toBe("5da00ce7b5050175");
  });

  test("a 1.1 diagram", () => {
    expect(digest(buildFixture())).toBe("cca3fcd6c1df479f");
  });
});

describe("determinism and bounds", () => {
  test("the same model gives the same bytes, in every mode", () => {
    const m1 = build(gpu());
    const m2 = build(gpu());
    for (const mode of ["loop", "interactive"] as const) {
      expect(animate(m1, { speed: 1, mode, motion: "css" }).css).toBe(
        animate(m2, { speed: 1, mode, motion: "css" }).css,
      );
    }
    expect(JSON.stringify(animate(m1, { speed: 2, mode: "frame", time: 4.4 }).attrs)).toBe(
      JSON.stringify(animate(m2, { speed: 2, mode: "frame", time: 4.4 }).attrs),
    );
  });

  test("equal tracks share one @keyframes", () => {
    const model = build(gpu());
    const css = animate(model, { speed: 1, mode: "loop", motion: "css" }).css;
    const rules = parseRules(splitReduced(css).live);
    const names = [...rules.values()].flat().map((a) => a.name);
    expect(new Set(names).size).toBeLessThan(names.length / 1.5);
    // ... and each @keyframes is defined once
    const defs = [...css.matchAll(/@keyframes (\S+?)\{/g)].map((m) => m[1]);
    expect(new Set(defs).size).toBe(defs.length);
  });

  /** A hand-made assembly model: tracks as given, frameAt from the ORIGINAL keys. */
  function fake(
    tracks: AssemblyRenderModel["tracks"],
    extra: Partial<AssemblyRenderModel> & { moves?: { t0: number; t1: number }[] } = {},
  ): AssemblyRenderModel {
    const ids = {
      partHost: (k: string) => `h_${k}`,
      partMotion: (k: string) => `m_${k}`,
      partVisible: (k: string) => `v_${k}`,
      partFade: (k: string) => `f_${k}`,
    };
    const am = {
      ids,
      tracks,
      labelTracks: [],
      staticFades: [],
      epochs: [],
      approximate: [],
      loop: 10,
      clock: [{ step: 1, start: 0, duration: 10, open: 0, end: 10 }],
      settled: [5],
      frameAt: (t: number) => ({
        transforms: Object.fromEntries(
          tracks.flatMap((k) =>
            k.motion.length === 0
              ? []
              : [[ids.partMotion(k.copy), translateFull(evalOffsetOrig(k.motion, t))]],
          ),
        ),
        hidden: [],
        visible: [],
        opacity: {},
      }),
      ...extra,
    };
    return am as unknown as AssemblyRenderModel;
  }
  const idsOf = { sel: (s: string) => `#${s}` } as unknown as Parameters<typeof assemblyLoop>[2];

  test("a track over the budget keeps its protected keys: poses at move and visibility times are exact", () => {
    const n = 4001;
    const T = (i: number) => Math.round(i * 25) / 10000;
    // a gentle curve sampled densely (thinnable), one eased segment, boundaries at 5, 6, 8
    const motion = Array.from({ length: n }, (_, i) => ({
      t: T(i),
      offset: { x: Math.round(Math.sin(T(i) * 0.3) * 4000) / 100, y: i / 100 },
      easing: (i === 1000 ? "ease-in-out" : "linear") as "linear" | "ease-in-out",
    }));
    const am = fake(
      [
        {
          copy: "a",
          host: [],
          motion,
          visibility: [
            { t: 0, visible: true },
            { t: 3.3, visible: false },
            { t: 7.1, visible: true },
            { t: 10, visible: true },
          ],
          opacity: [],
        },
      ],
      { moves: [{ t0: 5, t1: 6 }], epochs: [{ t0: 8, t1: 9, order: [], approximate: false }] },
    );
    const a = assemblyAnim(am, 1);
    const prop = a.props.find((p) => p.kind === "transform")!;
    expect(prop.keys.length).toBeLessThanOrEqual(MAX_KEYS);
    expect(prop.keys.length).toBeLessThan(n);
    // protected times and the eased segment's two ends are still keys
    const times = new Set(prop.keys.map((k) => k.t));
    for (const t of [0, 2.5, 2.5025, 3.3, 5, 6, 7.1, 8, 10])
      expect(times.has(t), `key @${t}`).toBe(true);
    // the pose there equals the model's frameAt
    for (const t of [0, 2.5, 2.5025, 3.3, 5, 6, 7.1, 8, 10 - 0.0001]) {
      const got = assemblyFrame(am, 1, t)!["m_a"]!.transform;
      expect(got, `pose @${t}`).toBe(am.frameAt(t).transforms["m_a"]);
    }
    expect(assemblyFrame(am, 1, 3.4)!["v_a"]!.visibility).toBe("hidden");
    expect(assemblyFrame(am, 1, 7.2)!["v_a"]!.visibility).toBe("visible");
    // between keys the thinned track stays within the tolerance of the original
    for (let t = 0.013; t < 10; t += 0.0371) {
      const [x, y] = transformOf(assemblyFrame(am, 1, t)!["m_a"]!.transform);
      const [ox, oy] = transformOf(am.frameAt(t).transforms["m_a"]);
      expect(Math.hypot(x - ox, y - oy), `@${t}`).toBeLessThan(0.6);
    }
    expect(assemblyDiagnostics(a)).toEqual([]);
  });

  test("a track that cannot be thinned is kept whole and reported (budget/elements), never cut", () => {
    const n = 3000;
    const motion = Array.from({ length: n }, (_, i) => ({
      t: (i / (n - 1)) * 10,
      offset: { x: i % 2 === 0 ? 0 : 50, y: 0 },
      easing: "linear" as const,
    }));
    const am = fake([{ copy: "z", host: [], motion, visibility: [], opacity: [] }]);
    const a = assemblyAnim(am, 1);
    expect(a.props[0]!.keys).toHaveLength(n);
    const diags = assemblyDiagnostics(a);
    expect(diags.map((d) => [d.severity, d.code])).toEqual([["warning", "budget/elements"]]);
    const r = assemblyLoop(am, 1, idsOf, new Keyframes("x"), 10);
    expect(r.diagnostics).toEqual(diags);
    // the pose at a key is the model's
    for (const i of [1, 1500, 2999]) {
      const t = motion[i]!.t;
      expect(assemblyFrame(am, 1, t - 1e-9)!["m_z"]!.transform).toBe(
        am.frameAt(t - 1e-9).transforms["m_z"],
      );
    }
  });

  test("more wrappers than MAX_PROPS: the rest stay at rest, reported; nothing throws", () => {
    const keys = (k: number) =>
      Array.from({ length: 3 }, (_, i) => ({
        t: i * 5,
        offset: { x: i === 1 ? k : 0, y: 0 },
        easing: "linear" as const,
      }));
    const tracks = Array.from({ length: MAX_PROPS + 500 }, (_, i) => ({
      copy: `p${String(i).padStart(6, "0")}`,
      host: [],
      motion: keys(i + 1),
      visibility: [],
      opacity: [],
    }));
    const am = fake(tracks);
    const a = assemblyAnim(am, 1);
    expect(a.props.length).toBe(MAX_PROPS);
    expect(a.overProps).toBe(500);
    const r = assemblyLoop(am, 1, idsOf, new Keyframes("x"), 10);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["budget/elements"]);
    expect(r.rules.length).toBeGreaterThan(0);
    expect(assemblyFrame(am, 1, 3)).toBeDefined();
    // degenerate inputs
    expect(assemblyLoop({ ...am, loop: 0 }, 1, idsOf, new Keyframes("x"), 10).rules).toEqual([]);
    expect(() => assemblyFrame(am, 0, Number.NaN)).not.toThrow();
    expect(assemblyFrame({ ...am, tracks: [] } as AssemblyRenderModel, 1, 1)).toBeUndefined();
  });

  test("binary-search evaluation agrees with the model's linear scans, at every key and between", () => {
    const model = build(gpu());
    const am = A(model);
    for (const t of am.tracks.slice(0, 40)) {
      for (const keys of [t.motion, t.host]) {
        for (let x = 0; x <= am.loop; x += 0.173) {
          const want = translateFull(evalOffsetOrig(keys, x));
          if (keys.length === 0) continue;
          const id = keys === t.motion ? am.ids.partMotion(t.copy) : am.ids.partHost(t.copy);
          const got = assemblyFrame(am, 1, x)?.[id]?.transform;
          if (got !== undefined && got !== want) {
            // pruned flat keys cannot change a value
            throw new Error(`${id} @${x}: ${got} vs ${want}`);
          }
        }
      }
    }
  });
});
