import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { buildModelWithDiagnostics } from "../src/render/model.js";
import {
  buildScene,
  type PlatformCosmoSpec,
  type RenderModel,
  type SvgElement,
  type SvgNode,
  type Vec2,
} from "../src/index.js";
import { createProjection, boxCorners } from "../src/geometry/index.js";
import type { Box3 } from "../src/contracts/index.js";
import type { AssemblyRenderModelX, LabelTrack } from "../src/render/assembly/types.js";
import {
  MoveIndex,
  evalOffset,
  evalOpacity,
  round2,
  stepEndTime,
} from "../src/render/assembly/tracks.js";
import { segmentHitsRect } from "../src/render/assembly/anchors.js";
import { zoomFor } from "../src/anim/timeline.js";
import { worldLeaves } from "../src/render/assembly/world.js";
import { themeRegistry } from "../../themes/src/index.js";
import * as partsAuto from "../../parts-auto/src/index.js";
import * as partsBase from "../../parts-base/src/index.js";
import { combineRegistries } from "../../cli/src/parts.js";
import type { ThemeTokens } from "../src/contracts/index.js";
import { fixtureTheme } from "./fixtures/theme.js";
import { realPng, resolverOf } from "./figure-fixtures.js";

// A leader label's leader ends ON its part's visible geometry at every instant the label shows
// (assemblies §6.6); a requested label is drawn or reported (§18).

const fixture = (name: string): PlatformCosmoSpec =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/assembly/label-anchors-${name}.cosmo.json`, import.meta.url),
      "utf8",
    ),
  ) as PlatformCosmoSpec;

function build(name: string) {
  return build2(fixture(name));
}
function build2(
  spec: PlatformCosmoSpec,
  font: "system" | "embed" = "system",
  theme: ThemeTokens = fixtureTheme(),
) {
  // the real hw: and auto: packs (core has no dependency on them; the CLI wires them): without
  // them the parts are stand-in boxes and the poses differ from the CLI's
  const scene = buildScene(spec, {
    parts: combineRegistries([partsBase.registry, partsAuto.registry]),
  });
  const r = buildModelWithDiagnostics({
    scene,
    theme,
    font,
    prefix: "pc-t",
    spec,
  });
  return { ...r, scene, a: r.model.assembly as AssemblyRenderModelX };
}

const projection = createProjection();
const tracksOf = (a: AssemblyRenderModelX): readonly LabelTrack[] =>
  a.labelTracks as unknown as readonly LabelTrack[];

/** Convex hull (monotone chain) of the projected corners of boxes. */
function hull(boxes: readonly Box3[], d: { x: number; y: number; z: number }): Vec2[] {
  const pts = boxes
    .flatMap((b) =>
      boxCorners({
        origin: { x: b.origin.x + d.x, y: b.origin.y + d.y, z: b.origin.z + d.z },
        size: b.size,
      }),
    )
    .map((c) => projection.project(c))
    .sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: Vec2, p: Vec2, q: Vec2): number =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const half = (list: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0)
        out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/** Distance-tolerant point-in-convex-polygon (inside or within `slack` of the outline). */
function inHull(poly: readonly Vec2[], p: Vec2, slack = 0.6): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    if (((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len < -slack) return false;
  }
  return true;
}

function anchored(name: string, partsOf?: (path: string) => boolean) {
  const { a, scene, model } = build(name) as ReturnType<typeof build> & { model: RenderModel };
  const index = new MoveIndex(a.moves);
  const leaves = worldLeaves(scene.assemblies!.assemblies);
  let checked = 0;
  const bad: string[] = [];
  for (const lt of tracksOf(a)) {
    if (lt.kind !== "leader" || lt.anchor === undefined) continue;
    if (partsOf !== undefined && !partsOf(lt.path)) continue;
    const own = leaves.filter((l) => l.path === lt.path || l.path.startsWith(`${lt.path}/`));
    for (let n = 1; n <= model.scene.timeline.length; n++) {
      const c = a.clock[n - 1]!;
      const t = stepEndTime(c.end);
      if (evalOpacity(lt.opacity, t) < 1) continue;
      const o = evalOffset(lt.motion, t);
      const p = { x: lt.anchor.x + o.x, y: lt.anchor.y + o.y };
      checked++;
      const on = own.some((l) =>
        inHull(
          hull(
            l.geometry.primitives.map((q) => q.box),
            index.displacement(l.path, t),
          ),
          p,
        ),
      );
      if (!on) bad.push(`${lt.path} step ${n}`);
    }
  }
  return { checked, bad, a, leaves, index, model };
}

describe("leader ends lie on the part's projected geometry at every step end", () => {
  for (const name of ["board", "engine", "gpu"]) {
    test(name, () => {
      const r = anchored(name);
      expect(r.checked).toBeGreaterThan(10);
      expect(r.bad).toEqual([]);
    });
  }
});

describe("leaders end on what shows, not on what covers it", () => {
  test("engine: the piston leaders end at least 3 px clear of the head and gasket outlines in the last explode step", () => {
    const { a, leaves, index, model } = anchored("engine");
    const steps = model.scene.timeline.length;
    const t = stepEndTime(a.clock[steps - 2]!.end); // "Crankshaft and oil pan"
    let seen = 0;
    for (const lt of tracksOf(a)) {
      if (!/pl_engine\.pr-\d$/.test(lt.id)) continue;
      const o = evalOffset(lt.motion, t);
      const p = { x: lt.anchor!.x + o.x, y: lt.anchor!.y + o.y };
      for (const cover of ["engine/head", "engine/head-gasket"]) {
        const l = leaves.find((q) => q.path === cover)!;
        expect(
          inHull(hull([l.geometry.bounds], index.displacement(cover, t)), p, 3),
          `${lt.id} under ${cover}`,
        ).toBe(false);
      }
      seen++;
    }
    expect(seen).toBe(4);
  });

  test("gpu: the lid leader ends on the lid, however far it slid", () => {
    const r = anchored("gpu", (p) => p === "srv/lid");
    expect(r.checked).toBeGreaterThan(0);
    expect(r.bad).toEqual([]);
  });
});

describe("a requested label is drawn or reported", () => {
  test("parts no stage moves are labelled too: chassis tray and cylinder block", () => {
    for (const [name, part] of [
      ["gpu", "srv/chassis"],
      ["engine", "engine/block"],
    ] as const) {
      const { a, model } = build(name);
      const lt = tracksOf(a).find((t) => t.path === part);
      expect(lt, part).toBeDefined();
      expect(lt!.motion).toEqual([]);
      // shown once the first stage has arrived, hidden again at the start
      expect(evalOpacity(lt!.opacity, 0)).toBe(0);
      const last = model.scene.timeline.length - 1; // the implode step
      expect(evalOpacity(lt!.opacity, stepEndTime(a.clock[last - 1]!.end))).toBe(1);
      expect(evalOpacity(lt!.opacity, a.loop)).toBe(0);
    }
  });

  test("a labelled part of an assembly with no labels: show stage is reported", () => {
    const spec = fixture("gpu") as unknown as {
      assemblies: { programs: { stages: { labels?: string }[] }[] }[];
    };
    for (const st of spec.assemblies[0]!.programs[0]!.stages) st.labels = "hide";
    const r = build2(spec as unknown as PlatformCosmoSpec);
    const d = r.diagnostics.find(
      (x) =>
        x.code === "assembly/label-omitted" &&
        (x.params as { part?: string }).part === "srv/chassis",
    );
    expect(d).toBeDefined();
  });

  test("every labelled node is shown or reported", () => {
    for (const name of ["board", "engine", "gpu"]) {
      const { diagnostics, a, scene } = build(name);
      const reported = new Set(
        diagnostics
          .filter((x) => x.code === "assembly/label-omitted")
          .map((x) => (x.params as { part: string }).part),
      );
      const shown = new Set(tracksOf(a).map((t) => t.path));
      const walk = (
        n: NonNullable<typeof scene.assemblies>["assemblies"][number]["root"],
      ): void => {
        if (
          n.label !== undefined &&
          n.label !== "" &&
          n.path !== scene.assemblies!.assemblies[0]!.id
        )
          expect(shown.has(n.path) || reported.has(n.path), `${name} ${n.path}`).toBe(true);
        n.children.forEach(walk);
      };
      scene.assemblies!.assemblies.forEach((x) => walk(x.root));
    }
  });
});

describe("labels do not cover each other, each other's leader ends, or cross each other's leaders", () => {
  // fixtureTheme with the system font, and the CLI's default: the light theme, embedded font
  const modes = [
    ["fixture theme, system font", "system", () => fixtureTheme()],
    ["fixture theme, embedded font", "embed", () => fixtureTheme()],
    ["light theme, embedded font", "embed", () => themeRegistry.get("light") as ThemeTokens],
  ] as const;
  for (const [label, font, theme] of modes) {
    for (const name of ["board", "engine", "gpu"]) {
      test(`${name} (${label})`, () => {
        const { a, model } = build2(fixture(name), font, theme());
        const groups = new Map<string, SvgElement>();
        const walk = (nodes: readonly SvgNode[]): void => {
          for (const n of nodes)
            if (typeof n === "object" && "tag" in n) {
              if (typeof n.attrs?.id === "string") groups.set(n.attrs.id, n);
              walk(n.children ?? []);
            }
        };
        walk(model.layers.labels);
        const child = (id: string, tag: string): SvgElement | undefined =>
          (groups.get(id)!.children ?? []).find(
            (c) => typeof c === "object" && "tag" in c && c.tag === tag,
          ) as SvgElement | undefined;
        let pairs = 0;
        for (let n = 1; n <= model.scene.timeline.length; n++) {
          const t = stepEndTime(a.clock[n - 1]!.end);
          // fading labels count too
          const up = tracksOf(a)
            .filter((lt) => lt.kind === "leader" && evalOpacity(lt.opacity, t) > 0)
            .map((lt) => {
              const o = evalOffset(lt.motion, t);
              const rect = child(lt.id, "rect")!;
              const at = (k: string): number => Number(rect.attrs![k]);
              const d = child(lt.id, "path");
              const nums =
                d === undefined
                  ? undefined
                  : String(d.attrs!.d)
                      .match(/-?\d+(\.\d+)?/g)!
                      .map(Number);
              return {
                id: lt.id,
                box: {
                  x: at("x") + o.x,
                  y: at("y") + o.y,
                  width: at("width"),
                  height: at("height"),
                },
                seg:
                  nums === undefined
                    ? undefined
                    : ([
                        { x: nums[0]! + o.x, y: nums[1]! + o.y },
                        { x: nums[2]! + o.x, y: nums[3]! + o.y },
                      ] as const),
              };
            });
          for (const p of up) {
            for (const q of up) {
              if (p === q) continue;
              if (p.id < q.id) {
                const w =
                  Math.min(p.box.x + p.box.width, q.box.x + q.box.width) -
                  Math.max(p.box.x, q.box.x);
                const hh =
                  Math.min(p.box.y + p.box.height, q.box.y + q.box.height) -
                  Math.max(p.box.y, q.box.y);
                expect(w > 0 && hh > 0 ? w * hh : 0, `${p.id} / ${q.id} step ${n}`).toBeLessThan(1);
                pairs++;
              }
              if (q.seg !== undefined) {
                const [e0, e1] = q.seg;
                expect(
                  segmentHitsRect(e0, e1, p.box),
                  `${q.id}'s leader crosses the label ${p.id} at step ${n}`,
                ).toBe(false);
              }
            }
          }
        }
        expect(pairs).toBeGreaterThan(10);
      });
    }
  }
});

describe("unmoved parts under a labelled group are named by it", () => {
  const examples = (): PlatformCosmoSpec[] => {
    const md = readFileSync(new URL("../../../docs/design/assemblies.md", import.meta.url), "utf8");
    return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
      .map((m) => JSON.parse(m[1] as string) as { meta?: { title: string } })
      .filter((x) => typeof x.meta === "object") as unknown as PlatformCosmoSpec[];
  };
  const example = (prefix: string): PlatformCosmoSpec =>
    examples().find((x) => (x.meta as { title: string }).title.startsWith(prefix))!;
  const render = (spec: PlatformCosmoSpec) => {
    const imgs = resolverOf({ "gpu-photo": realPng(640, 240, (x, y) => [x % 256, y, 120, 255]) });
    const scene = buildScene(spec, {
      images: imgs,
      parts: combineRegistries([partsBase.registry, partsAuto.registry]),
    });
    const r = buildModelWithDiagnostics({
      scene,
      theme: fixtureTheme(),
      font: "system",
      prefix: "pc-t",
      spec,
      images: imgs,
    });
    return { ...r, a: r.model.assembly as AssemblyRenderModelX };
  };

  test("the engine example has 11 leader labels; its valves and piston parts are reported", () => {
    const { a, diagnostics } = render(example("Inline-4"));
    // instances of one counted part moved together share one label (D-4a): 14 before
    expect(tracksOf(a).filter((t) => t.kind === "leader")).toHaveLength(11);
    const omitted = diagnostics.filter((d) => d.code === "assembly/label-omitted");
    expect(omitted.length).toBeGreaterThanOrEqual(16);
    expect(omitted.map((d) => (d.params as { part: string }).part)).toContain(
      "engine/head/valve-1",
    );
    expect(omitted.some((d) => d.message.includes("whose label names it"))).toBe(true);
  });

  test("§19.2: a label a zoom would cut or put under the caption is hidden and reported (OCP NIC 3.0)", () => {
    const { model, diagnostics } = render(example("2U GPU"));
    const A = model.assembly!;
    const cap = model.captionRect!;
    let checked = 0;
    for (const st of model.scene.timeline) {
      const z = zoomFor(model, st);
      if (z === undefined) continue;
      const v = z.viewBox;
      const c = {
        x: (cap.x - z.tx) / z.scale,
        y: (cap.y - z.ty) / z.scale,
        w: cap.width / z.scale,
        h: cap.height / z.scale,
      };
      const opacity = A.frameAt(A.clock[st.index - 1]!.end - 0.01).opacity;
      for (const q of A.stepLabels!(st.index)) {
        const out =
          q.x + q.width <= v.x ||
          q.x >= v.x + v.width ||
          q.y + q.height <= v.y ||
          q.y >= v.y + v.height;
        if (out) continue;
        checked++;
        const inside =
          q.x >= v.x - 0.01 &&
          q.y >= v.y - 0.01 &&
          q.x + q.width <= v.x + v.width + 0.01 &&
          q.y + q.height <= v.y + v.height + 0.01;
        const under =
          q.x < c.x + c.w && c.x < q.x + q.width && q.y < c.y + c.h && c.y < q.y + q.height;
        if (inside && !under) continue;
        expect(opacity[A.ids.partLabel(q.part!)], `step ${st.index}: ${q.part}`).toBe(0);
        expect(
          diagnostics.some(
            (d) =>
              d.code === "assembly/label-omitted" &&
              (d.params as { part?: string; step?: number }).part === q.part &&
              (d.params as { step?: number }).step === st.index &&
              d.path !== "",
          ),
          `step ${st.index}: ${q.part} reported`,
        ).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("the GPU example has 13 leader labels: one per counted part moved together", () => {
    const { a, diagnostics } = render(example("2U GPU"));
    // 39 before D-4a: every DIMM, fan and drive had its own pill
    expect(tracksOf(a).filter((t) => t.kind === "leader")).toHaveLength(13);
    const carried = diagnostics.filter(
      (d) => d.code === "assembly/label-omitted" && d.message.includes("every instance"),
    );
    expect(carried.length).toBe(39 - 13);
  });
});

describe("the emitted leader starts at the recorded anchor", () => {
  test("M point of every leader path equals LabelTrack.anchor", () => {
    const { a, model } = build("engine");
    const groups = new Map<string, SvgElement>();
    const walk = (nodes: readonly SvgNode[]): void => {
      for (const n of nodes)
        if (typeof n === "object" && "tag" in n) {
          if (typeof n.attrs?.id === "string") groups.set(n.attrs.id, n);
          walk(n.children ?? []);
        }
    };
    walk(model.layers.labels);
    let seen = 0;
    for (const lt of tracksOf(a)) {
      if (lt.anchor === undefined) continue;
      const path = (groups.get(lt.id)!.children ?? []).find(
        (c) => typeof c === "object" && "tag" in c && c.tag === "path",
      ) as SvgElement;
      const [x, y] = String(path.attrs!.d)
        .match(/-?\d+(\.\d+)?/g)!
        .map(Number);
      expect([x, y]).toEqual([lt.anchor.x, lt.anchor.y]);
      seen++;
    }
    expect(seen).toBeGreaterThan(8);
  });
});

describe("frame and track agree", () => {
  test("label transforms and opacities at sampled times", () => {
    const { a } = build("gpu");
    for (let k = 0; k <= 40; k++) {
      const f = a.frameAt((a.loop * k) / 40);
      // frameAt wraps with this formula; the tracks are read at the same instant it reads them
      const t = ((((a.loop * k) / 40) % a.loop) + a.loop) % a.loop;
      for (const lt of tracksOf(a)) {
        expect(f.opacity[lt.id]).toBe(round2(evalOpacity(lt.opacity, t)));
        if (lt.motion.length > 0) {
          const v = evalOffset(lt.motion, t);
          expect(f.transforms[lt.id], `${lt.id} @${t}`).toBe(
            `translate(${round2(v.x)} ${round2(v.y)})`,
          );
        }
      }
    }
  });
});

describe("placement cost is bounded", () => {
  test("500 labelled parts in 30 stages cost a bounded multiple of the same build without labels", () => {
    const make = (labels: "show" | "hide"): PlatformCosmoSpec => {
      const parts = Array.from({ length: 500 }, (_, i) => ({
        id: `p${i}`,
        shape: "box",
        at: [(i % 25) * 12, Math.floor(i / 25) * 12, 0],
        size: [10, 10, 4 + (i % 3)],
        label: `Part ${i}`,
      }));
      const stages = Array.from({ length: 30 }, (_, k) => ({
        label: `Stage ${k}`,
        parts: parts.slice(k * 16, k * 16 + 16).map((p) => p.id),
        direction: "+z",
        distance: "auto",
        duration: 0.6,
        labels,
      }));
      return {
        meta: { version: "1" },
        assemblies: [
          { id: "big", units: "mm", parts, programs: [{ id: "p", stages }], program: "p" },
        ],
        steps: [{ caption: "Up", duration: 20, assembly: [{ explode: "big", program: "p" }] }],
      } as unknown as PlatformCosmoSpec;
    };
    const time = (spec: PlatformCosmoSpec) => {
      const t0 = performance.now();
      const r = build2(spec);
      return { ms: performance.now() - t0, r };
    };
    // measured: labels add about 1.7x the build without them; the unbounded occlusion pass
    // added 40-70x. A ratio is robust to a loaded machine.
    const base = time(make("hide"));
    const full = time(make("show"));
    expect(tracksOf(full.r.a).length).toBeGreaterThan(400);
    expect(full.ms).toBeLessThan(8 * base.ms + 2000);
  }, 180_000);
});
