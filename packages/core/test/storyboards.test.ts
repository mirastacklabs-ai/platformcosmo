import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildModel,
  buildScene,
  createAnimator,
  emit,
  render,
  validate,
  type Diagnostic,
  type ImageAsset,
  type ImageAssetResolver,
  type PlatformCosmoSpec,
  type RenderModel,
  type VideoEncoder,
} from "../src/index.js";
import { DEFAULT_IMAGE_LIMITS } from "../src/assets/prepare.js";
import { boardsAt, poseAt, fadeAt } from "../src/anim/boards.js";
import type { BoardIdScheme } from "../src/emit/ids.js";
import { decodePng } from "../src/export/png.js";
import { checkSpecImages } from "../src/render/boards/images.js";
import { boardsOf } from "../src/render/boards/types.js";
import {
  CUT,
  frameTiming,
  resolveStoryboard,
  storyboardGeometry,
  storyboardRuns,
} from "../src/scene/storyboards.js";
import { realPng, resolverOf } from "./figure-fixtures.js";
import { fixtureTheme } from "./fixtures/theme.js";

// R-2: storyboards (tier A of document ingestion; docs/design/assemblies.md §14).

const THEME = fixtureTheme();
type Spec = Record<string, unknown>;

const designSpec = (): Spec => {
  const md = readFileSync(
    new URL("../../../docs/design/document-ingestion.md", import.meta.url),
    "utf8",
  );
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Spec)
    .find(
      (s) => (s.meta as { title?: string } | undefined)?.title === "Booklet storyboard",
    ) as Spec;
};

/** Models are 640 x 480 (a panel of 8 tiles: 256 x 192 model area), thumbnails 60 x 40. */
const IMAGES = (): ImageAssetResolver =>
  resolverOf({
    m1: realPng(640, 480, (_x, y) => [200 - (y >> 4), 210, 230, 255]),
    m2: realPng(640, 480, (x) => [180, 200, 160 + (x >> 5), 255]),
    m3: realPng(640, 480, (x, y) => [150 + (x >> 6), 120, 200 - (y >> 5), 255]),
    "t-2x4": realPng(60, 40, (x) => [40 + x, 90, 160, 255]),
    "t-slope": realPng(60, 40, (_x, y) => [160, 90 + y, 60, 255]),
    s1: realPng(50, 50, () => [90, 160, 90, 255]),
    s2: realPng(50, 50, () => [160, 90, 90, 255]),
  });
const IMAGE_LIST = ["m1", "m2", "m3", "t-2x4", "t-slope", "s1", "s2"].map((id) => ({
  id,
  src: `${id}.png`,
}));

const FRAMES = [
  {
    number: 1,
    caption: "Attach the base",
    model: "m1",
    parts: [{ image: "t-2x4", count: 2 }],
    attach: [50, 60],
  },
  {
    number: 2,
    caption: "Add the slope",
    model: "m2",
    parts: [{ image: "t-slope" }, { image: "t-2x4", count: 3 }],
    sub: [{ image: "s1" }, { image: "s2" }],
    attach: [40, 35],
  },
  { model: "m3" },
];

const board = (over: Spec = {}, steps?: unknown[], extra: Spec = {}): Spec => ({
  meta: { version: "1", title: "Booklet" },
  images: IMAGE_LIST,
  storyboards: [{ id: "book", label: "Brick toy", frames: FRAMES, ...over }],
  ...(steps ? { steps } : {}),
  ...extra,
});

const bids = (m: RenderModel) => m.ids as RenderModel["ids"] & BoardIdScheme;
const item = (m: RenderModel, key: string) => bids(m).boardItem("book", key);
const errors = (d: readonly Diagnostic[]) => d.filter((x) => x.severity === "error");

function pipeline(spec: Spec, images: ImageAssetResolver = IMAGES()) {
  const v = validate(spec);
  expect(errors(v.diagnostics)).toEqual([]);
  const parsed = v.spec as PlatformCosmoSpec;
  const scene = buildScene(parsed, { images });
  const model = buildModel({
    scene,
    theme: THEME,
    font: "system",
    prefix: "pc-t",
    spec: parsed,
    images,
  });
  return { model, scene, spec: parsed };
}
const animate = (
  model: RenderModel,
  o: Parameters<ReturnType<typeof createAnimator>["animate"]>[1],
) => createAnimator().animate(model, o);
const svgOf = (model: RenderModel, o: Parameters<typeof animate>[1]): string =>
  emit(model, animate(model, o), { font: "system" });

/** The `<g>` of the board `id`, balanced, from an emitted SVG. */
function boardDom(svg: string, m: RenderModel, id = "book"): string {
  const start = svg.indexOf(`<g id="${bids(m).board(id)}"`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (const t of svg.slice(start).matchAll(/<g\b|<\/g>/g)) {
    depth += t[0] === "<g" ? 1 : -1;
    if (depth === 0) return svg.slice(start, start + (t.index as number) + 4);
  }
  throw new Error("unbalanced board group");
}
const attrOf = (dom: string, id: string, attr: string): string | undefined =>
  new RegExp(`<g id="${id}"[^>]*?\\s${attr}="([^"]*)"`).exec(dom)?.[1];
const transformOf = (v: string | number | undefined): [number, number] => {
  const m = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(String(v));
  return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0)];
};

// ---------------------------------------------------------------------------------------------
// A tiny CSS animation evaluator (independent of the engine): reads the emitted keyframes.
// ---------------------------------------------------------------------------------------------

type Stop = { p: number; decl: string; tf: string };
function parseKeyframes(css: string): Map<string, Stop[]> {
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
  return out;
}
function parseRules(
  css: string,
  reduced = false,
): Map<string, { name: string; dur: number; tf: string }> {
  const media = /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const body = reduced ? media : css.replace(/@media[^{]*\{[\s\S]*?\n\}/g, "");
  const out = new Map<string, { name: string; dur: number; tf: string }>();
  for (const m of body.matchAll(/#([^{}\s,]+)\{animation:(\S+) ([\d.]+)s (\S+) infinite\}/g)) {
    out.set((m[1] as string).replace(/\\(.)/g, "$1"), {
      name: m[2] as string,
      dur: Number(m[3]),
      tf: m[4] as string,
    });
  }
  return out;
}
function bezier(tf: string, x: number): number {
  if (tf === "linear" || tf === "") return x;
  if (tf === "step-end") return x < 1 ? 0 : 1;
  const [x1, y1, x2, y2] = /cubic-bezier\(([^)]*)\)/.exec(tf)![1]!.split(",").map(Number) as [
    number,
    number,
    number,
    number,
  ];
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
function cssAt(stops: Stop[], tf: string, loop: number, t: number): number[] {
  const u = (((t % loop) + loop) % loop) / loop;
  const nums = (s: Stop) => (s.decl.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (u >= (stops[stops.length - 1] as Stop).p) return nums(stops[stops.length - 1] as Stop);
  let i = 0;
  while (i < stops.length - 2 && u >= (stops[i + 1] as Stop).p) i++;
  const a = stops[i] as Stop;
  const b = stops[i + 1] as Stop;
  const x = (u - a.p) / (b.p - a.p);
  const f = tf === "step-end" ? bezier(tf, x) : bezier(a.tf || tf, x);
  const na = nums(a);
  const nb = nums(b);
  return na.map((v, k) => v + ((nb[k] as number) - v) * f);
}

const STEPS = [
  { caption: "one", duration: 4, assembly: [{ build: "book", to: 1 }] },
  { caption: "two", duration: 6, assembly: [{ build: "book", to: 3 }] },
  { caption: "back", duration: 6, assembly: [{ unbuild: "book", to: 0 }] },
  { caption: "again", duration: 6, assembly: [{ build: "book", to: 3 }] },
];

// ---------------------------------------------------------------------------------------------
describe("resolution, frame timing and geometry", () => {
  const sb = resolveStoryboard(
    (board().storyboards as Parameters<typeof resolveStoryboard>[0][])[0] as never,
  );

  test("defaults: step number, count 1, centred attach, 8 tiles, fade", () => {
    expect(sb.width).toBe(8);
    expect(sb.transition).toBe("fade");
    expect(sb.frames.map((f) => f.number)).toEqual([1, 2, 3]);
    expect(sb.frames[1]!.parts.map((p) => p.count)).toEqual([1, 3]);
    expect(sb.frames[2]!.attach).toEqual([50, 50]);
    expect(sb.frames[2]!.parts).toEqual([]);
  });

  test("a frame is its callout, one beat per mini step, the flight and the change", () => {
    const t = sb.frames.map(frameTiming);
    expect(t.map((x) => x.length)).toEqual([1.4, 2.1, 0.5]);
    expect(t[1]).toMatchObject({
      callout: true,
      intro: 0.3,
      subAt: [0.3, 0.65],
      flightStart: 1,
      flightEnd: 1.6,
      changeStart: 1.6,
      changeEnd: 2.1,
    });
    expect(t[2]).toMatchObject({ callout: false, flightStart: 0, flightEnd: 0, changeStart: 0 });
  });

  test("an unbuild plays the same frames backward: the exact reverse order", () => {
    const up = storyboardRuns(sb, 0, 3);
    const down = storyboardRuns(sb, 3, 0);
    expect(up.runs.map((r) => [r.frame.index, r.offset, r.reversed])).toEqual([
      [1, 0, false],
      [2, 1.4, false],
      [3, 3.5, false],
    ]);
    expect(down.runs.map((r) => [r.frame.index, r.reversed])).toEqual([
      [3, true],
      [2, true],
      [1, true],
    ]);
    expect(down.length).toBe(up.length);
    expect(storyboardRuns(sb, 1, 2).runs.map((r) => r.frame.index)).toEqual([2]);
    expect(storyboardRuns(sb, 2, 2).runs).toEqual([]);
  });

  test("geometry: the model area follows the first model, under the callout, above the caption", () => {
    const g = storyboardGeometry(sb, { width: 640, height: 480 })!;
    expect(g).toEqual({ width: 256, height: 273.92, calloutH: 56.32, modelH: 192, captionH: 25.6 });
    // a strip image is clamped to 4:1 .. 1:2 so the panel never degenerates
    expect(storyboardGeometry(sb, { width: 1000, height: 10 })!.modelH).toBe(64);
    expect(storyboardGeometry(sb, { width: 10, height: 1000 })!.modelH).toBe(512);
    expect(storyboardGeometry(sb, { width: 0, height: 5 })).toBeUndefined();
    expect(storyboardGeometry(sb, undefined)).toBeUndefined();
    // no callout anywhere: no strip
    const bare = resolveStoryboard({ id: "b", frames: [{ model: "m1" }] });
    expect(storyboardGeometry(bare, { width: 640, height: 480 })!.calloutH).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("scene: boards, plan, validation", () => {
  test("a storyboard is a flat board with its images in first-use order and one program", () => {
    const { scene } = pipeline(board({ source: { document: "Toy booklet", page: 3 } }, STEPS));
    const a = scene.assemblies!;
    expect(a.boards).toHaveLength(1);
    expect(a.boards[0]).toMatchObject({
      id: "book",
      kind: "storyboard",
      label: "Brick toy",
      width: 8,
      images: ["m1", "t-2x4", "m2", "t-slope", "s1", "s2", "m3"],
    });
    expect(a.images).toEqual(["m1", "m2", "m3", "s1", "s2", "t-2x4", "t-slope"]);
    expect(a.credits).toHaveLength(1);
    expect(a.plan.map((p) => p.poses.book)).toEqual([
      [{ program: "frames", level: 1 }],
      [{ program: "frames", level: 3 }],
      [{ program: "frames", level: 0 }],
      [{ program: "frames", level: 3 }],
    ]);
    expect(a.plan[1]!.actions[0]).toMatchObject({
      target: "book",
      kind: "build",
      program: "frames",
      from: 1,
      to: 3,
      start: 0,
      scale: 1,
    });
    // frames 2 and 3: 2.1 s and 0.5 s
    expect(a.plan[1]!.actions[0]!.length).toBe(2.6);
    expect(a.plan[2]!.actions[0]).toMatchObject({ kind: "unbuild", from: 3, to: 0 });
    expect(a.plan[2]!.actions[0]!.length).toBe(4);
  });

  test("the timeline starts where the first action starts: build at 0, unbuild at the last frame", () => {
    const up = pipeline(board({}, [{ assembly: [{ build: "book", to: 2 }] }])).scene.assemblies!;
    expect(up.plan[0]!.actions[0]).toMatchObject({ from: 0, to: 2 });
    const down = pipeline(board({}, [{ assembly: [{ unbuild: "book", to: 1 }] }])).scene
      .assemblies!;
    expect(down.plan[0]!.actions[0]).toMatchObject({ kind: "unbuild", from: 3, to: 1 });
    // `advance` steps by frames
    const adv = pipeline(
      board({}, [
        { assembly: [{ build: "book", advance: 2 }] },
        { assembly: [{ build: "book", advance: 1 }] },
      ]),
    ).scene.assemblies!;
    expect(adv.plan.map((p) => p.actions[0]!.to)).toEqual([2, 3]);
  });

  test("invalid actions are validate's: no-explode, direction, range, program, path", () => {
    const codes = (steps: unknown[]) =>
      validate(
        board(
          {},
          steps.map((st) => ({ duration: 30, ...(st as object) })),
        ),
      ).diagnostics.map((d) => `${d.code}@${d.path}`);
    expect(codes([{ assembly: [{ explode: "book" }] }])).toEqual([
      "assembly/storyboard-no-explode@/steps/0/assembly/0/explode",
    ]);
    expect(codes([{ assembly: [{ implode: "book" }] }])).toEqual([
      "assembly/storyboard-no-explode@/steps/0/assembly/0/implode",
    ]);
    expect(
      codes([{ assembly: [{ build: "book", to: 2 }] }, { assembly: [{ build: "book", to: 1 }] }]),
    ).toEqual(["assembly/build-backwards@/steps/1/assembly/0/to"]);
    expect(codes([{ assembly: [{ build: "book", to: 4 }] }])).toEqual([
      "assembly/stage-out-of-range@/steps/0/assembly/0/to",
    ]);
    expect(codes([{ assembly: [{ build: "book", program: "x" }] }])).toEqual([
      "assembly/unknown-program@/steps/0/assembly/0/program",
    ]);
    expect(codes([{ assembly: [{ build: "book/frame1" }] }])).toEqual([
      "assembly/unknown-target@/steps/0/assembly/0/build",
    ]);
    // a repeated level is an info, and is not planned
    const r = validate(
      board({}, [
        { assembly: [{ build: "book", to: 1 }] },
        { assembly: [{ build: "book", to: 1 }] },
      ]),
    );
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["assembly/no-op-action", "info"],
    ]);
    // and none of the invalid ones is in the plan
    const bad = buildScene(
      board({}, [
        { assembly: [{ explode: "book" }, { build: "book", to: 2 }] },
      ]) as unknown as PlatformCosmoSpec,
      { images: IMAGES() },
    );
    expect(bad.assemblies!.plan[0]!.actions.map((x) => x.kind)).toEqual(["build"]);
  });

  test("the default guard lets storyboards through; callouts and sub-builds stay gated", () => {
    const r = validate(board({}, STEPS));
    expect(r.diagnostics.filter((d) => d.code === "assembly/unsupported")).toEqual([]);
    expect(r.valid).toBe(true);
    const gated = validate({
      meta: { version: "1" },
      assemblies: [
        {
          id: "a",
          parts: [{ id: "p", size: [1, 1, 1] }],
          programs: [
            { id: "b", kind: "build", steps: [{ add: ["p"], from: "callout", subBuild: "x" }] },
          ],
        },
      ],
    });
    expect(
      gated.diagnostics.filter((d) => d.code === "assembly/unsupported").map((d) => d.path),
    ).toContain("/assemblies/0/programs/0");
  });

  test("compression is reported once, with the duration that fits", () => {
    const d = validate(
      board({}, [{ duration: 1, assembly: [{ build: "book", to: 3 }] }]),
    ).diagnostics.filter((x) => x.code === "assembly/compressed");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ path: "/steps/0/assembly", severity: "warning" });
    expect(d[0]!.suggestion).toMatch(/"duration": \d+/);
    const fit = Number(/"duration": (\d+)/.exec(d[0]!.suggestion as string)![1]);
    expect(
      validate(
        board({}, [{ duration: fit, assembly: [{ build: "book", to: 3 }] }]),
      ).diagnostics.filter((x) => x.code === "assembly/compressed"),
    ).toEqual([]);
  });

  test("bounds, focus and a manual position", () => {
    const spec = board({}, undefined, { nodes: [{ id: "a", type: "server" }] });
    const parsed = validate(spec).spec!;
    const without = buildScene(parsed, {});
    const withImages = buildScene(parsed, { images: IMAGES() });
    expect(Object.keys(without.focusTargets)).toEqual(["a"]);
    expect(Object.keys(withImages.focusTargets)).toEqual(["a", "book"]);
    const box = withImages.focusTargets.book!;
    expect(box.size.x).toBe(8);
    expect(box.size.y).toBe(0);
    expect(box.size.z).toBe(8.56); // 273.92 px
    expect(box.origin).toEqual(withImages.assemblies!.boards[0]!.anchor);
    // `focus` on the storyboard is valid and zooms to it
    const focused = validate(board({}, [{ focus: "book" }, { caption: "next" }]));
    expect(errors(focused.diagnostics)).toEqual([]);
    expect(buildScene(focused.spec!, { images: IMAGES() }).timeline[0]!.focus).toBe("book");
    // overlapping a node at a manual position warns, on the storyboard's own path
    const over = validate(
      board({ pos: { x: 0, y: 0 } }, undefined, {
        nodes: [{ id: "a", type: "server", pos: { x: 0, y: 0 } }],
      }),
    );
    const warn = buildScene(over.spec!, { images: IMAGES() }).diagnostics.filter(
      (d) => d.code === "layout/overlap",
    );
    expect(warn.map((d) => [d.path, d.message])).toEqual([
      ["/storyboards/0/pos", 'Storyboard "book" overlaps "a" at its manual position'],
    ]);
  });

  test("storyboards and figures stand in one row; a storyboard and an assembly share the plan", () => {
    const spec = {
      meta: { version: "1" },
      images: IMAGE_LIST,
      storyboards: [{ id: "book", frames: FRAMES.slice(0, 1) }],
      assemblies: [
        {
          id: "box",
          parts: [
            { id: "base", size: [10, 10, 2] },
            { id: "lid", at: [0, 0, 2], size: [10, 10, 1] },
          ],
          programs: [{ id: "x", stages: [{ parts: ["lid"] }] }],
        },
      ],
      steps: [{ duration: 6, assembly: [{ explode: "box" }, { build: "book", to: 1 }] }],
    };
    const v = validate(spec);
    expect(errors(v.diagnostics)).toEqual([]);
    const g = buildScene(v.spec!, { images: IMAGES() });
    const actions = g.assemblies!.plan[0]!.actions;
    expect(actions.map((a) => [a.target, a.kind])).toEqual([
      ["box", "explode"],
      ["book", "build"],
    ]);
    // one cursor: the build starts after the explode ended
    expect(actions[1]!.start).toBe(actions[0]!.start + actions[0]!.length);
    expect(g.assemblies!.plan[0]!.poses.book).toEqual([{ program: "frames", level: 1 }]);
    expect(g.assemblies!.plan[0]!.poses.box).toBeDefined();
  });

  test("a duplicate id with a figure is the shared namespace's error", () => {
    const d = validate(
      board({}, undefined, {
        figures: [{ id: "book", base: "m1", parts: [{ id: "p", image: "s1", seat: [0, 0] }] }],
      }),
    ).diagnostics.filter((x) => x.code === "semantic/duplicate-id");
    expect(d.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("panels: callout, counts, caption, rest frame", () => {
  const { model } = pipeline(board({}, STEPS));
  const svg = svgOf(model, { speed: 1, mode: "loop" });
  const dom = boardDom(svg, model);

  test("one model image, callout and caption per frame, in frame order", () => {
    const at = (k: string) => dom.indexOf(`id="${item(model, k)}"`);
    for (const k of ["m.1", "m.2", "m.3", "co.1", "co.2", "cap.1", "cap.2", "cap.3"]) {
      expect(at(k), k).toBeGreaterThan(-1);
    }
    expect(at("co.3")).toBe(-1); // frame 3 has no parts and no sub-build: no callout
    expect(at("m.1")).toBeLessThan(at("m.2"));
    expect(at("m.2")).toBeLessThan(at("m.3"));
    expect(at("m.3")).toBeLessThan(at("co.1")); // models, then callouts, then captions
    expect(at("co.2")).toBeLessThan(at("cap.1"));
  });

  test("the callout shows the thumbnails with <count>x; the caption the step number", () => {
    const co1 = dom.slice(
      dom.indexOf(`id="${item(model, "co.1")}"`),
      dom.indexOf(`id="${item(model, "co.2")}"`),
    );
    expect(co1.match(/>\d+x</g)).toEqual([">2x<"]);
    const co2 = dom.slice(
      dom.indexOf(`id="${item(model, "co.2")}"`),
      dom.indexOf(`id="${item(model, "cap.1")}"`),
    );
    expect(co2.match(/>\d+x</g)).toEqual([">1x<", ">3x<"]);
    expect(dom).toContain("Attach the base");
    expect(dom).toContain("Add the slope");
    // a frame without a caption prints only its number (3: the default)
    const cap3 = dom.slice(dom.indexOf(`id="${item(model, "cap.3")}"`));
    expect(cap3).toMatch(/^[^>]*>(<text[^>]*>3<\/text>)<\/g>/);
  });

  test("the rest frame is the finished model: the last frame's image and caption, nothing in flight", () => {
    const rest = svgOf(model, { speed: 1, mode: "frame", time: 0 });
    const d = boardDom(rest, model);
    const op = (k: string) => attrOf(d, item(model, k), "opacity") ?? "1";
    expect([op("m.1"), op("m.2"), op("m.3")]).toEqual(["0", "0", "1"]);
    expect([op("cap.1"), op("cap.2"), op("cap.3")]).toEqual(["0", "0", "1"]);
    expect(op("co.1")).toBe("0"); // the next callout replaced it
    expect(op("co.2")).toBe("0"); // frame 3 has none: the callout shows only while its step is current
    expect(op("fl.1")).toBe("0");
    expect(op("fl.2")).toBe("0");
    expect(op("sd.2")).toBe("0");
    // a static output has no animation
    expect(rest).not.toContain("@keyframes");
  });

  test("a storyboard without actions is static: no tracks, no animation, the rest frame", () => {
    const { model: m } = pipeline(board({}, [{ caption: "a" }, { caption: "b" }]));
    expect(boardsOf(m)!.tracks(1).poses).toEqual([]);
    expect(boardsOf(m)!.tracks(1).fades).toEqual([]);
    expect(animate(m, { speed: 1, mode: "loop" }).css).toContain("animation:none!important");
  });

  test("the model images are embedded once per hash, as the image rule wants", () => {
    const embedded = [
      ...svg.matchAll(/<image\b[^>]*href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g),
    ];
    expect(embedded.length).toBe(7);
    expect(new Set(embedded.map((m) => m[1])).size).toBe(7);
    // the 2x4 thumbnail is used in two callouts and in their flights, one <image>
    expect((svg.match(/<use\b[^>]*href="#pc-t-im_/g) ?? []).length).toBeGreaterThan(7);
  });
});

// ---------------------------------------------------------------------------------------------
describe("transitions: a snapshot each (fade, wipe, cut)", () => {
  for (const transition of ["fade", "wipe", "cut"] as const) {
    test(transition, () => {
      const { model } = pipeline(board({ transition }, STEPS.slice(0, 2)));
      const svg = svgOf(model, { speed: 1, mode: "loop" });
      const t = boardsOf(model)!.tracks(1);
      expect({
        tracks: { poses: t.poses, fades: t.fades },
        dom: boardDom(svg, model),
      }).toMatchSnapshot();
    });
  }

  test("wipe: an animated clip window over a still image; fade and cut have no clip", () => {
    const wipe = pipeline(board({ transition: "wipe" }, STEPS.slice(0, 2))).model;
    const wsvg = svgOf(wipe, { speed: 1, mode: "loop" });
    expect(wsvg).toContain(`<clipPath id="${item(wipe, "cp")}">`);
    const t = boardsOf(wipe)!.tracks(1);
    const win = t.poses.find((p) => p.id === item(wipe, "mw.2"))!;
    const counter = t.poses.find((p) => p.id === item(wipe, "mc.2"))!;
    // window and image move opposite ways by the panel width, so the image itself stays put
    expect(win.keys.map((k) => k.x)).toEqual(counter.keys.map((k) => 0 - k.x));
    expect(Math.max(...win.keys.map((k) => Math.abs(k.x)))).toBe(256);
    for (const other of ["fade", "cut"] as const) {
      const m = pipeline(board({ transition: other }, STEPS.slice(0, 2))).model;
      expect(svgOf(m, { speed: 1, mode: "loop" })).not.toContain("<clipPath");
      expect(
        boardsOf(m)!
          .tracks(1)
          .poses.some((p) => /__mw\./.test(p.id)),
      ).toBe(false);
    }
  });

  test("cut: the image swaps in CUT seconds in the middle of the change; fade eases across it", () => {
    const cut = boardsOf(pipeline(board({ transition: "cut" }, STEPS.slice(0, 1))).model)!.tracks(
      1,
    );
    const f = cut.fades.find((x) => /__m\.1$/.test(x.id))!;
    const jump = f.keys.find((k, i) => i > 0 && k.v === 1)!;
    const prev = f.keys[f.keys.indexOf(jump) - 1]!;
    expect(jump.t - prev.t).toBeCloseTo(CUT, 4);
    const fade = boardsOf(pipeline(board({}, STEPS.slice(0, 1))).model)!.tracks(1);
    const g = fade.fades.find((x) => /__m\.1$/.test(x.id))!;
    const up = g.keys.filter((k) => k.v > 0 && k.v < 1);
    expect(up.length).toBe(0); // linear between two keys: the ramp is one segment ...
    const k1 = g.keys.find((k) => k.v === 1)!;
    const k0 = g.keys[g.keys.indexOf(k1) - 1]!;
    expect(k1.t - k0.t).toBeCloseTo(0.5, 4); // ... as long as the change
  });
});

// ---------------------------------------------------------------------------------------------
describe("motion: frame mode = CSS = tracks; reduced motion; unbuild; closure", () => {
  const { model, scene } = pipeline(board({}, STEPS));
  const loop = scene.timeline.reduce((s, x) => s + x.duration, 0);
  const layer = animate(model, { speed: 1, mode: "loop" });
  const rules = parseRules(layer.css);
  const ids = [...rules.keys()].filter((i) => /-bi_book__/.test(i));

  test("every animated element of the board has a rule; the loop is the steps' sum", () => {
    expect(layer.duration).toBe(loop);
    expect(ids.length).toBeGreaterThanOrEqual(12);
    const t = boardsOf(model)!;
    expect(ids.sort()).toEqual(
      [...t.tracks(1).poses, ...t.tracks(1).fades].map((x) => x.id).sort(),
    );
  });

  test("frame 0 is the rest frame, the finished model (as the DOM shows it)", () => {
    const f0 = animate(model, { speed: 1, mode: "frame", time: 0 }).attrs!;
    expect(f0[item(model, "m.3")]).toEqual({ opacity: 1 });
    expect(f0[item(model, "m.1")]).toEqual({ opacity: 0 });
    // the loop then opens on the empty panel (the first build starts at level 0)
    const f1 = animate(model, { speed: 1, mode: "frame", time: 0.5 }).attrs!;
    expect(f1[item(model, "m.3")]).toEqual({ opacity: 0 });
  });

  test("a flight: copies of the thumbnails travel (screen translate) to attach and fade on landing", () => {
    const t = boardsOf(model)!.tracks(1);
    const fp = t.poses.find((p) => p.id === item(model, "fp.2"))!;
    const end = fp.keys[fp.keys.length - 1]!;
    expect(Math.hypot(end.x, end.y)).toBeGreaterThan(10);
    const fl = t.fades.find((p) => p.id === item(model, "fl.2"))!;
    // step 2 (from 4 s) builds frames 2 and 3 from level 1: frame 2 plays first, its flight
    // is 1.0 .. 1.6 s into the frame
    const start = t.stepStarts[1]!;
    expect(fadeAt(fl.keys, start + 0.5)).toBe(0); // callout intro: the copies are still hidden
    expect(fadeAt(fl.keys, start + 1.3)).toBe(1); // in flight
    expect(fadeAt(fl.keys, start + 1.6)).toBe(0); // landed
    expect(poseAt(fp.keys, start + 0.5)).toEqual({ x: 0, y: 0 });
    expect(poseAt(fp.keys, start + 1.6).x).toBeCloseTo(end.x, 1);
  });

  test("the last mini step docks at attach before the model image changes", async () => {
    const r = await render(board({}, STEPS.slice(0, 2)), {
      theme: THEME,
      font: "system",
      outputs: ["steps"],
      images: IMAGES(),
      optimize: false,
    });
    expect(errors(r.diagnostics)).toEqual([]);
    const m2 = pipeline(board({}, STEPS.slice(0, 2)));
    const t = boardsOf(m2.model)!.tracks(1);
    const sp = t.poses.find((p) => p.id === item(m2.model, "sp.2"))!;
    const sd = t.fades.find((p) => p.id === item(m2.model, "sd.2"))!;
    const s2 = m2.scene.timeline;
    const start = t.stepStarts[1]!;
    // frame 2: sub beats at 0.3 and 0.65, flight 1.0 .. 1.6, change 1.6 .. 2.1
    const landed = poseAt(sp.keys, start + 1.6);
    const svg = svgOf(m2.model, { speed: 1, mode: "frame", time: 0 });
    const d = boardDom(svg, m2.model);
    // geometry of the docked item: its slot centre plus the pose is the attach point (40%, 35%)
    const grp = d.slice(d.indexOf(`id="${item(m2.model, "sp.2")}"`));
    const use =
      /<use[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+) ([-\d.]+)\)"/.exec(
        grp,
      )!;
    const cx = Number(use[1]) + (Number(use[3]) * 50) / 2;
    const cy = Number(use[2]) + (Number(use[4]) * 50) / 2;
    const mdl =
      /id="pc-t-bi_book__m\.2"[^>]*>\s*<use[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+) ([-\d.]+)\)"/.exec(
        d,
      )!;
    const mx = Number(mdl[1]);
    const my = Number(mdl[2]);
    expect(cx + landed.x).toBeCloseTo(mx + 0.4 * 256, 0);
    expect(cy + landed.y).toBeCloseTo(my + 0.35 * 192, 0);
    const sf = t.fades.find((p) => p.id === item(m2.model, "sf.2.0"))!;
    expect(fadeAt(sf.keys, start + 0.2)).toBe(0);
    expect(fadeAt(sf.keys, start + 0.5)).toBe(1); // the first mini step (s1) is shown ...
    expect(fadeAt(sf.keys, start + 0.9)).toBe(0); // ... replaced by the last one (s2)
    expect(fadeAt(sd.keys, start + 0.5)).toBe(0);
    expect(fadeAt(sd.keys, start + 0.9)).toBe(1);
    expect(fadeAt(sd.keys, start + 1.3)).toBe(1); // it flies to attach ...
    expect(fadeAt(sd.keys, start + 1.6)).toBe(0); // ... and is gone when the model changes
    expect(s2.length).toBe(2);
  });

  test("unbuild is the exact time reverse of build (same keys, mirrored easing)", () => {
    const tracks = boardsOf(model)!.tracks(1);
    // step 2 builds frames 2 and 3 forward (from level 1), step 3 unbuilds them
    // (3 -> 0, from frame 3); compare build 0 -> 3 (step 4) with unbuild 3 -> 0 (step 3)
    const s3 = tracks.stepStarts[2]!;
    const s4 = tracks.stepStarts[3]!;
    const L = 1.4 + 2.1 + 0.5;
    const all = [...tracks.poses, ...tracks.fades];
    for (let x = 0.05; x < L; x += 0.07) {
      for (const tr of all) {
        const get = (t: number): number[] =>
          "keys" in tr && "x" in (tr.keys[0] as object)
            ? Object.values(poseAt(tr.keys as never, t))
            : [fadeAt(tr.keys as never, t)];
        const a = get(s4 + x);
        const b = get(s3 + (L - x));
        a.forEach((v, i) => expect(v, `${tr.id} @${x}`).toBeCloseTo(b[i] as number, 1));
      }
    }
  });

  test("reduced motion: discrete keyframes, each step shows its end state", () => {
    const red = parseRules(layer.css, true);
    const rkf = parseKeyframes(layer.css);
    const media = /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\}/.exec(layer.css)![1]!;
    expect(media).toContain("step-end");
    expect(media).not.toContain("animation:none!important");
    const board = ids.filter((i) => red.has(i));
    expect(board.length).toBe(ids.length);
    const tracks = boardsOf(model)!.tracks(1);
    for (let k = 1; k <= 4; k++) {
      const end = animate(model, { speed: 1, mode: "step", step: k }).attrs!;
      const t = tracks.stepStarts[k - 1]! + 0.01;
      for (const id of ids) {
        const r = red.get(id)!;
        const css = cssAt(rkf.get(r.name)!, "step-end", r.dur, t);
        const f = end[id]!;
        if (f.transform !== undefined) {
          expect(transformOf(f.transform)[0], `${id} @step ${k}`).toBeCloseTo(css[0] as number, 1);
        } else expect(f.opacity as number, `${id} @step ${k}`).toBeCloseTo(css[0] as number, 1);
      }
    }
    // end states: after step 1 frame 1 shows; after step 3 nothing; after step 4 the finished model
    const at = (k: number, key: string) =>
      animate(model, { speed: 1, mode: "step", step: k }).attrs![item(model, key)];
    expect([1, 2, 3, 4].map((k) => at(k, "m.1")?.opacity)).toEqual([1, 0, 0, 0]);
    expect([1, 2, 3, 4].map((k) => at(k, "m.3")?.opacity)).toEqual([0, 1, 0, 1]);
    expect([1, 2, 3, 4].map((k) => at(k, "cap.2")?.opacity)).toEqual([0, 0, 0, 0]);
  });

  test("a story that ends part way returns to the finished rest frame in the closing window", () => {
    const { model: m, scene: sc } = pipeline(
      board({}, [
        { duration: 6, assembly: [{ build: "book", to: 1 }] },
        { duration: 6, assembly: [{ build: "book", to: 2 }] },
      ]),
    );
    const t = boardsOf(m)!.tracks(1);
    const total = t.loop;
    expect(total).toBe(12);
    expect(sc.timeline).toHaveLength(2);
    const m3 = t.fades.find((x) => x.id === item(m, "m.3"))!;
    const m2 = t.fades.find((x) => x.id === item(m, "m.2"))!;
    const tr = 0.25 * 6; // the closing transition reserved by the loop closure (§7.4)
    expect(fadeAt(m2.keys, 11)).toBe(1); // level 2 shows frame 2
    expect(fadeAt(m3.keys, 11)).toBe(0);
    expect(fadeAt(m3.keys, total - tr)).toBe(0);
    expect(fadeAt(m3.keys, total)).toBe(1); // back at the rest frame
    expect(fadeAt(m2.keys, total)).toBe(0);
    // the loop is seamless: the last value is the first (the rest frame)
    expect(fadeAt(m3.keys, 0)).toBe(fadeAt(m3.keys, total));
  });

  test("a story that ends finished needs no closing return", () => {
    const { model: m } = pipeline(
      board({}, [{ duration: 6, assembly: [{ build: "book", to: 3 }] }]),
    );
    const t = boardsOf(m)!.tracks(1);
    const m1 = t.fades.find((x) => x.id === item(m, "m.1"))!;
    expect(m1.keys[m1.keys.length - 1]!.t).toBe(6);
    expect(fadeAt(m1.keys, 6)).toBe(fadeAt(m1.keys, 0));
  });
});

// ---------------------------------------------------------------------------------------------
describe("images: the same pipeline and limits (§11.4)", () => {
  const fake = (key: string, bytes: number, hash = `h-${key}`): ImageAsset => ({
    key,
    format: "png",
    mime: "image/png",
    width: 100,
    height: 100,
    orientation: 1,
    hash,
    data: new Uint8Array(bytes),
  });
  const resolver = (assets: ImageAsset[]): ImageAssetResolver => ({
    get: (k) => assets.find((a) => a.key === k),
    keys: () => assets.map((a) => a.key).sort(),
  });
  const parsed = validate(board()).spec!;
  const all = IMAGE_LIST.map((i) => fake(i.id, 10));

  test("unknown image ids (model, parts, sub-build) are image/unknown with a did-you-mean", () => {
    const spec = board({
      frames: [{ model: "mm1", parts: [{ image: "t-2x" }], sub: [{ image: "s" }] }],
    });
    const d = validate(spec).diagnostics.filter((x) => x.code === "image/unknown");
    expect(d.map((x) => [x.path, x.suggestion])).toEqual([
      ["/storyboards/0/frames/0/model", 'Did you mean "m1"?'],
      ["/storyboards/0/frames/0/parts/0/image", 'Did you mean "t-2x4"?'],
      ["/storyboards/0/frames/0/sub/0/image", expect.stringMatching(/Did you mean|Images:/)],
    ]);
  });

  test("a missing image is image/not-found at its declaration, and nothing is rendered", async () => {
    const r = await render(board(), {
      theme: THEME,
      images: resolver(all.filter((a) => a.key !== "s2")),
    });
    expect(r.outputs).toEqual([]);
    expect(r.diagnostics.find((d) => d.code === "image/not-found")).toMatchObject({
      severity: "error",
      path: `/images/${IMAGE_LIST.findIndex((i) => i.id === "s2")}/src`,
    });
    const none = await render(board(), { theme: THEME });
    expect(none.diagnostics.filter((d) => d.code === "image/not-found")).toHaveLength(7);
  });

  test("more distinct images than the cap is image/too-many; the same bytes count once", () => {
    const limits = { ...DEFAULT_IMAGE_LIMITS, maxImages: 3 };
    const d = checkSpecImages(parsed, resolver(all), limits);
    expect(d.map((x) => [x.code, x.severity])).toEqual([["image/too-many", "error"]]);
    expect(
      checkSpecImages(parsed, resolver(all.map((a) => fake(a.key, 1, "same"))), limits),
    ).toEqual([]);
  });

  test("the embedded total is capped and warned about, counted in base64", () => {
    const MiB = 1024 * 1024;
    const loose = { ...DEFAULT_IMAGE_LIMITS, maxBytes: 64 * MiB, maxDimension: 99999 };
    const big = all.map((a) => fake(a.key, 1.2 * MiB));
    const d = checkSpecImages(parsed, resolver(big), loose);
    expect(d.map((x) => [x.code, x.severity])).toEqual([["image/too-large", "error"]]);
    const warm = all.map((a) => fake(a.key, 0.6 * MiB));
    expect(checkSpecImages(parsed, resolver(warm), loose).map((x) => x.code)).toEqual([
      "budget/images",
    ]);
    // a single image over the per-file cap is named at its declaration
    const huge = all.map((a) => (a.key === "m1" ? fake("m1", 20 * MiB) : a));
    expect(
      checkSpecImages(parsed, resolver(huge)).find((x) => x.code === "image/too-large"),
    ).toMatchObject({
      path: "/images/0/src",
    });
  });

  test("a degenerate model image draws no panel and never throws", async () => {
    const zero = all.map((a) => (a.key === "m1" ? ({ ...a, width: 0 } as ImageAsset) : a));
    const r = await render(board(), { theme: THEME, font: "system", images: resolver(zero) });
    expect(r.diagnostics.filter((d) => d.code === "render/internal-error")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the design's storyboard example (ingestion §7.4), end to end", () => {
  test("renders: animated, static, steps, interactive, png, gif, mp4", async () => {
    const frames: number[] = [];
    const encoder: VideoEncoder = {
      encode: async () => new Uint8Array([1]),
      open: () => ({
        write: async (f: Uint8Array) => {
          frames.push(f.length);
        },
        finish: async () => new Uint8Array([0x4d, 0x50, 0x34]),
        abort: async () => undefined,
      }),
    };
    const spec = designSpec();
    expect(validate(spec).diagnostics.filter((d) => d.code === "assembly/unsupported")).toEqual([]);
    const r = await render(spec, {
      theme: THEME,
      font: "system",
      outputs: ["animated", "static", "steps", "interactive", "png", "gif", "mp4"],
      images: IMAGES(),
      video: { fps: 4, durationSec: 6, encoder },
      png: { scale: 1 },
    });
    expect(errors(r.diagnostics)).toEqual([]);
    expect(r.outputs.map((o) => o.path).sort()).toEqual([
      "diagram.gif",
      "diagram.interactive.svg",
      "diagram.mp4",
      "diagram.png",
      "diagram.static.svg",
      "diagram.steps/step-01.svg",
      "diagram.steps/step-02.svg",
      "diagram.svg",
    ]);
    const gif = r.outputs.find((o) => o.kind === "gif")!.data as Uint8Array;
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe("GIF89a");
    expect(frames.length).toBe(24);
    expect(new Set(frames).size).toBeGreaterThan(1); // the frames differ: things move
    expect(
      decodePng(r.outputs.find((o) => o.kind === "png")!.data as Uint8Array).width,
    ).toBeGreaterThan(100);
    const animated = r.outputs.find((o) => o.kind === "animated")!.data as string;
    expect(animated).toContain("Brick toy");
    expect(animated).toMatch(/>2x</);
    // the credits of the document appear once
    expect(r.scene!.assemblies!.credits).toHaveLength(3);
  }, 120_000);

  test("is deterministic: the same inputs give the same bytes", async () => {
    const once = async () =>
      (
        await render(designSpec(), {
          theme: THEME,
          font: "system",
          outputs: ["animated", "steps"],
          images: IMAGES(),
        })
      ).outputs.map((o) => o.data as string);
    expect(await once()).toEqual(await once());
  });
});

// ---------------------------------------------------------------------------------------------
describe("1.1 output is untouched", () => {
  test("a spec without storyboards has no boards model and the 1.1 reduced-motion rule", () => {
    const spec = {
      meta: { version: "1" },
      nodes: [{ id: "a", type: "server" }],
      steps: [{ caption: "x" }],
    };
    const parsed = validate(spec).spec!;
    const scene = buildScene(parsed, {});
    const model = buildModel({ scene, theme: THEME, font: "system", prefix: "pc-t" });
    expect(model.boards).toBeUndefined();
    expect(scene.assemblies).toBeUndefined();
  });
});

describe("rest frame with a last callout", () => {
  test("the callout of the last frame stays on the finished panel", () => {
    const { model } = pipeline(
      board({ frames: FRAMES.slice(0, 2) }, [
        { duration: 8, assembly: [{ build: "book", to: 2 }] },
      ]),
    );
    const d = boardDom(svgOf(model, { speed: 1, mode: "frame", time: 0 }), model);
    expect(attrOf(d, item(model, "co.1"), "opacity")).toBe("0");
    expect(attrOf(d, item(model, "co.2"), "opacity")).toBe("1");
    expect(attrOf(d, item(model, "m.2"), "opacity")).toBe("1");
  });
});

describe.each(["fade", "wipe", "cut"] as const)("frame mode = CSS = tracks, %s", (transition) => {
  const { model, scene } = pipeline(board({ transition }, STEPS));
  const loop = scene.timeline.reduce((sum, x) => sum + x.duration, 0);
  const layer = animate(model, { speed: 1, mode: "loop" });
  const rules = parseRules(layer.css);
  const kf = parseKeyframes(layer.css);
  const ids = [...rules.keys()].filter((i) => /-bi_book__/.test(i));

  test("frame mode equals the CSS value at sampled times, and the tracks (boardsAt)", () => {
    const tracks = boardsOf(model)!.tracks(1);
    let moving = 0;
    for (let t = 0; t < loop; t += 0.13) {
      const frame = animate(model, { speed: 1, mode: "frame", time: t }).attrs!;
      const direct = boardsAt(tracks, t);
      for (const id of ids) {
        const r = rules.get(id)!;
        const css = cssAt(kf.get(r.name)!, r.tf, r.dur, t);
        const f = frame[id]!;
        expect(f).toEqual(direct[id]);
        if (f.transform !== undefined) {
          const [x, y] = transformOf(f.transform);
          expect(x, `${id} x @${t}`).toBeCloseTo(css[0] as number, 1);
          expect(y, `${id} y @${t}`).toBeCloseTo(css[1] as number, 1);
          if (Math.abs(x) > 1 && Math.abs(x) < 80) moving++;
        } else expect(f.opacity as number, `${id} @${t}`).toBeCloseTo(css[0] as number, 1);
      }
    }
    expect(moving).toBeGreaterThan(5); // mid-flight samples were compared, not just rest poses
    // the clock is the output clock at another speed
    const at = (speed: number, time: number) =>
      animate(model, { speed, mode: "frame", time }).attrs![item(model, "m.2")];
    expect(at(2, 3)).toEqual(at(1, 6));
    expect(at(1, loop + 3.3)).toEqual(at(1, 3.3));
  });
});

describe("wipe: complementary reveal, no bleed-through", () => {
  const { model } = pipeline(board({ transition: "wipe" }, STEPS.slice(0, 2)));
  const t = boardsOf(model)!.tracks(1);
  const pose = (key: string) => t.poses.find((p) => p.id === item(model, key))!;

  test("at mid-change the old image's visible clip is the right half, the new one's the left", () => {
    // step 2 starts at 4 s and plays frame 2 (2.1 s: change 1.6 .. 2.1) then frame 3 (0.5 s)
    const f3 = t.stepStarts[1]! + 2.1; // frame 3 begins: its change is 0 .. 0.5
    const mid = f3 + 0.25;
    // frame 2 (old) leaves to the right while frame 3 (new) enters from the left, both half way
    expect(poseAt(pose("mw.2").keys, mid).x).toBeCloseTo(128, 0);
    expect(poseAt(pose("mc.2").keys, mid).x).toBeCloseTo(-128, 0); // the image itself stays put
    expect(poseAt(pose("mw.3").keys, mid).x).toBeCloseTo(-128, 0);
    expect(poseAt(pose("mc.3").keys, mid).x).toBeCloseTo(128, 0);
    // before the change the old window is whole, after it it is out
    expect(poseAt(pose("mw.2").keys, f3).x).toBeCloseTo(0, 1);
    expect(poseAt(pose("mw.2").keys, f3 + 0.5).x).toBeCloseTo(256, 1);
    // the frame's attributes agree (translate only, so resvg and every browser draw the same)
    const attrs = animate(model, { speed: 1, mode: "frame", time: mid }).attrs!;
    expect(attrs[item(model, "mw.2")]!.transform).toMatch(/^translate\(12[78]/);
  });

  test("an unbuild reverses it exactly, with the old image's window", () => {
    const back = boardsOf(
      pipeline(
        board({ transition: "wipe" }, [
          { duration: 8, assembly: [{ build: "book", to: 3 }] },
          { duration: 8, assembly: [{ unbuild: "book", to: 0 }] },
        ]),
      ).model,
    )!.tracks(1);
    const w = back.poses.find((p) => /__mw\.2$/.test(p.id))!;
    const L = 4;
    for (let x = 0.1; x < L; x += 0.2) {
      expect(poseAt(w.keys, 0.0 + x).x).toBeCloseTo(poseAt(w.keys, 8 + (L - x)).x, 0);
    }
  });
});

describe("budget, narrow panels, labels, order, opening ease", () => {
  test("too many animated elements: budget/elements and a static rest frame", async () => {
    const many = Array.from({ length: 500 }, (_v, i) => ({
      number: i + 1,
      model: i % 2 === 0 ? "m1" : "m2",
      parts: [{ image: "t-2x4" }],
      sub: Array.from({ length: 19 }, () => ({ image: "s1" })),
    }));
    const spec = board({ frames: many }, [{ duration: 400, assembly: [{ build: "book" }] }]);
    const v = validate(spec);
    expect(errors(v.diagnostics)).toEqual([]);
    const r = await render(spec, {
      theme: THEME,
      font: "system",
      outputs: ["animated"],
      images: IMAGES(),
    });
    const d = r.diagnostics.filter((x) => x.code === "budget/elements");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "warning", path: "/storyboards" });
    const svg = r.outputs[0]!.data as string;
    expect(svg).not.toContain("@keyframes"); // no board tracks: a static diagram
    expect((svg.match(/-bi_book__m\./g) ?? []).length).toBe(1); // the finished frame only
    // under the budget the same board animates
    const fine = board({ frames: many.slice(0, 50) }, [
      { duration: 400, assembly: [{ build: "book" }] },
    ]);
    const ok = await render(fine, {
      theme: THEME,
      font: "system",
      outputs: ["animated"],
      images: IMAGES(),
    });
    expect(ok.diagnostics.filter((x) => x.code === "budget/elements")).toEqual([]);
    expect(ok.outputs[0]!.data as string).toContain("@keyframes");
  }, 60_000);

  test("narrow width: layout/callout-count-hidden is reported by render, per frame", async () => {
    const r = await render(board({ width: 1 }, STEPS.slice(0, 2)), {
      theme: THEME,
      font: "system",
      outputs: ["animated"],
      images: IMAGES(),
    });
    expect(errors(r.diagnostics)).toEqual([]);
    const d = r.diagnostics.filter((x) => x.code === "layout/callout-count-hidden");
    expect(d.map((x) => [x.path, x.severity])).toEqual([
      ["/storyboards/0/frames/0/parts", "info"],
      ["/storyboards/0/frames/1/parts", "info"],
    ]);
    // every thumbnail stays inside the (tiny) callout strip: no <use> wider than the panel
    const svg = r.outputs[0]!.data as string;
    for (const m of svg.matchAll(/scale\(([\d.]+) ([\d.]+)\)/g)) {
      expect(Number(m[1]) * 60).toBeLessThanOrEqual(32);
    }
  });

  test("a wide panel draws every count and none is reported", async () => {
    const r = await render(board({ width: 16 }, STEPS.slice(0, 2)), {
      theme: THEME,
      font: "system",
      outputs: ["animated"],
      images: IMAGES(),
    });
    expect(r.diagnostics.filter((x) => x.code === "layout/callout-count-hidden")).toEqual([]);
  });

  test("part and mini-step labels are <title> on the thumbnails, never ignored", () => {
    const frames = [
      {
        model: "m1",
        parts: [{ image: "t-2x4", label: "Plate 2x4" }],
        sub: [{ image: "s1", label: "Sub <1>" }, { image: "s2" }],
      },
    ];
    const { model } = pipeline(board({ frames }, [{ duration: 8, assembly: [{ build: "book" }] }]));
    const dom = boardDom(svgOf(model, { speed: 1, mode: "loop" }), model);
    expect(dom).toContain("<title>Plate 2x4</title>");
    expect(dom).toContain("<title>Sub &lt;1&gt;</title>");
    expect((dom.match(/<title>/g) ?? []).length).toBe(2);
  });

  test("figures and storyboards are drawn in one depth order by their anchor", () => {
    const figure = { id: "fig", base: "m1", parts: [{ id: "p", image: "s1", seat: [0, 0] }] };
    const order = (extra: Spec): string[] => {
      const { model } = pipeline(board({ pos: { x: 0, y: 0 } }, undefined, extra));
      const svg = svgOf(model, { speed: 1, mode: "frame", time: 0 });
      return [...svg.matchAll(/<g id="pc-t-bd_(\w+)"/g)].map((m) => m[1] as string);
    };
    // the figure stands nearer (larger x + y) than the storyboard at the origin, and farther
    expect(order({ figures: [{ ...figure, pos: { x: 20, y: 20 } }] })).toEqual(["book", "fig"]);
    expect(order({ figures: [{ ...figure, pos: { x: -30, y: -30 } }] })).toEqual(["fig", "book"]);
    // equal depth: by id
    expect(order({ figures: [{ ...figure, id: "aaa", pos: { x: 0, y: 0 } }] })).toEqual([
      "aaa",
      "book",
    ]);
  });

  test("the opening ramp eases away from the rest frame", () => {
    const { model } = pipeline(board({}, [{ duration: 8, assembly: [{ build: "book", to: 3 }] }]));
    const t = boardsOf(model)!.tracks(1);
    const m3 = t.fades.find((f) => f.id === item(model, "m.3"))!;
    expect(m3.keys[0]!.easing).toEqual([0.42, 0, 0.58, 1]);
    expect(m3.keys[0]!.v).toBe(1);
    expect(m3.keys[1]!.v).toBe(0);
  });
});
