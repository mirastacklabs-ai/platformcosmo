import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildModel,
  buildScene,
  createAnimator,
  defaultIdPrefix,
  emit,
  render,
  validate,
  type AnimationLayer,
  type ImageAsset,
  type ImageAssetResolver,
  type PlatformCosmoSpec,
  type RenderModel,
  type VideoEncoder,
} from "../src/index.js";
import { DEFAULT_IMAGE_LIMITS } from "../src/assets/prepare.js";
import type { BoardIdScheme } from "../src/emit/ids.js";
import { assertDataHref, orientationMatrix, unsafeSvgBody } from "../src/emit/index.js";
import { decodePng } from "../src/export/png.js";
import { boardsOf } from "../src/render/boards/types.js";
import { drawOrder, layoutFigure, stackLabels } from "../src/render/boards/layout.js";
import { checkFigureImages, creditsLine } from "../src/render/boards/images.js";
import { JPEG_METADATA, makeJpeg } from "./assets-fixtures.js";
import { heatSinkImages, realPng, resolverOf } from "./figure-fixtures.js";
import { fixtureTheme } from "./fixtures/theme.js";

// R-1: figure panels, motion, labels, credits and the emitter's image rule
// (docs/design/assemblies.md §7, §11.3, §11.6, §12, §15).

const THEME = fixtureTheme();
const bids = (m: RenderModel) => m.ids as RenderModel["ids"] & BoardIdScheme;
type Spec = Record<string, unknown>;

const designSpec = (): Spec => {
  const md = readFileSync(
    new URL("../../../docs/design/document-ingestion.md", import.meta.url),
    "utf8",
  );
  const found = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Spec)
    .find(
      (s) => (s.meta as { title?: string } | undefined)?.title === "Heat-sink installation figure",
    );
  return found as Spec;
};

/** Base 600 x 480, sprite 80 x 60: a panel of the default 8 tiles is 256 x 204.8, scale 0.42667. */
const IMAGES = (): ImageAssetResolver =>
  resolverOf({
    base: realPng(600, 480, (_x, y) => [230 - (y >> 3), 235, 240, 255]),
    spr: realPng(80, 60, (x, y) => [40 + x, 90, 160 - y, 255]),
  });
const SCALE = 256 / 600;

const fig = (over: Spec = {}, steps?: unknown[], extra: Spec = {}): Spec => ({
  meta: { version: "1", title: "fig" },
  images: [
    { id: "base", src: "base.png" },
    { id: "spr", src: "spr.png" },
  ],
  figures: [
    {
      id: "f",
      base: "base",
      parts: [
        { id: "p1", image: "spr", seat: [100, 300], exploded: [100, 100], label: "Part one" },
        { id: "p2", image: "spr", seat: [300, 320] },
      ],
      ...over,
    },
  ],
  ...(steps ? { steps } : {}),
  ...extra,
});

function pipeline(
  spec: Spec,
  images: ImageAssetResolver = IMAGES(),
  font: "system" | "outline" = "system",
): { model: RenderModel; scene: ReturnType<typeof buildScene>; spec: PlatformCosmoSpec } {
  const v = validate(spec);
  expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const parsed = v.spec as PlatformCosmoSpec;
  const scene = buildScene(parsed, { images });
  const model = buildModel({ scene, theme: THEME, font, prefix: "pc-t", spec: parsed, images });
  return { model, scene, spec: parsed };
}

const animate = (
  model: RenderModel,
  o: Parameters<ReturnType<typeof createAnimator>["animate"]>[1],
) => createAnimator().animate(model, o);
const svgOf = (model: RenderModel, layer: AnimationLayer, raster = false): string =>
  emit(model, layer, { font: "system", ...(raster ? { target: "raster" as const } : {}) });
const sprite = (model: RenderModel, part: string, figure = "f"): string =>
  bids(model).boardItem(figure, `s.${part}`);

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
/** id -> { keyframes name, duration, timing } for plain `#id{animation:…}` rules (outside @media). */
function parseRules(css: string): Map<string, { name: string; dur: number; tf: string }> {
  const body = css.replace(/@media[^{]*\{[\s\S]*?\n\}/g, "");
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
/** Numbers of the declaration at loop time `t`, as a browser interpolates the keyframes. */
function cssAt(stops: Stop[], tf: string, loop: number, t: number): number[] {
  const u = (((t % loop) + loop) % loop) / loop;
  let i = 0;
  while (i < stops.length - 2 && u >= (stops[i + 1] as Stop).p) i++;
  const a = stops[i] as Stop;
  const b = stops[i + 1] as Stop;
  const nums = (s: Stop) => (s.decl.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (u >= (stops[stops.length - 1] as Stop).p) return nums(stops[stops.length - 1] as Stop);
  const x = (u - a.p) / (b.p - a.p);
  const f = bezier(a.tf || tf, x);
  const na = nums(a);
  const nb = nums(b);
  return na.map((v, k) => v + ((nb[k] as number) - v) * f);
}
const transformOf = (attr: string | number | undefined): [number, number] => {
  const m = /translate\((-?[\d.]+) (-?[\d.]+)\)/.exec(String(attr));
  return [Number(m?.[1]), Number(m?.[2])];
};

// ---------------------------------------------------------------------------------------------

describe("emitter image rule (§11.3)", () => {
  test("a data: href is accepted only as base64 PNG or JPEG", () => {
    expect(() => assertDataHref("data:image/png;base64,AAAA")).not.toThrow();
    expect(() => assertDataHref("data:image/jpeg;base64,AA==")).not.toThrow();
    for (const bad of [
      "data:image/png;base64,@@@@",
      "data:image/png;base64,",
      "data:image/png;base64,AA AA",
      "data:image/png,AAAA",
      "data:image/png;base64,AAAA\n",
      "data:image/svg+xml;base64,AAAA",
      "data:image/gif;base64,AAAA",
      "data:text/html;base64,AAAA",
      "DATA:image/png;base64,AAAA",
      "javascript:alert(1)",
    ]) {
      expect(() => assertDataHref(bad), bad).toThrow();
    }
  });

  const { model } = pipeline(fig());

  test("the emitter's own <image> carries the asset bytes, base64-encoded, in <defs> only", () => {
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    const defs = /<defs>([\s\S]*?)<\/defs>/.exec(svg)?.[1] as string;
    const hrefs = [...svg.matchAll(/href="(data:[^"]*)"/g)].map((m) => m[1] as string);
    expect(hrefs).toHaveLength(2);
    expect(hrefs.every((h) => defs.includes(h))).toBe(true);
    for (const [hash, asset] of boardsOf(model)!.assets) {
      const id = bids(model).image(hash);
      const href = new RegExp(`<image id="${id}" href="(data:image/png;base64,[^"]+)"`).exec(
        defs,
      )?.[1];
      expect(href, hash).toBeDefined();
      expect(Buffer.from(href!.split(",")[1] as string, "base64")).toEqual(Buffer.from(asset.data));
    }
    // outside <defs> there is no data: at all, and every use is a fragment reference
    expect(svg.replace(/<defs>[\s\S]*?<\/defs>/, "")).not.toMatch(/data:image/);
    for (const m of svg.matchAll(/<use [^>]*href="([^"]*)"/g)) expect(m[1]).toMatch(/^#/);
  });

  test.each([
    ["a node in defs", { defs: [{ tag: "image", attrs: { href: "data:image/png;base64,AAAA" } }] }],
    [
      "a use in a layer",
      { layers: { objects: [{ tag: "use", attrs: { href: "data:image/png;base64,AAAA" } }] } },
    ],
    [
      "a spec-supplied string in an attribute",
      { layers: { labels: [{ tag: "g", attrs: { "aria-label": "data:image/png;base64,AAAA" } }] } },
    ],
    [
      "spaced and upper-cased",
      { layers: { labels: [{ tag: "g", attrs: { title: "DATA :image/png;base64,AAAA" } }] } },
    ],
  ])("refuses data: from %s", (_n, extra) => {
    const layer = { css: "", defs: [], layers: {}, duration: 0, ...extra } as AnimationLayer;
    expect(() => svgOf(model, layer)).toThrow(/data:/);
  });

  test("refuses an asset that is not PNG or JPEG raster, and a placeholder with no asset", () => {
    const bm = boardsOf(model)!;
    const [hash, asset] = [...bm.assets][0] as [string, ImageAsset];
    const gif: RenderModel = {
      ...model,
      boards: { ...bm, assets: new Map([[hash, { ...asset, mime: "image/gif" }]]) },
    };
    expect(() => svgOf(gif, animate(gif, { speed: 1, mode: "frame", time: 0 }))).toThrow(/gif/);
    const none: RenderModel = { ...model, boards: { ...bm, assets: new Map() } };
    expect(() => svgOf(none, animate(none, { speed: 1, mode: "frame", time: 0 }))).toThrow(
      /no asset/,
    );
  });

  test("animation attribute overrides are limited to translate, hidden and opacity", () => {
    const id = sprite(model, "p1");
    const ok = (a: Record<string, string | number>) =>
      svgOf(model, { css: "", defs: [], layers: {}, duration: 0, attrs: { [id]: a } });
    expect(ok({ transform: "translate(1.5 -2)" })).toContain('transform="translate(1.5 -2)"');
    expect(ok({ opacity: 0.5 })).toContain('opacity="0.5"');
    for (const bad of [
      { transform: "rotate(45)" },
      { transform: "translate(1 2) rotate(3)" },
      { opacity: 2 },
      { opacity: "0.5" },
      { fill: "red" },
      { href: "#x" },
    ]) {
      expect(
        () => ok(bad as unknown as Record<string, string | number>),
        JSON.stringify(bad),
      ).toThrow(/not allowed/);
    }
  });

  test("an unknown id in the overrides is ignored", () => {
    const svg = svgOf(model, {
      css: "",
      defs: [],
      layers: {},
      duration: 0,
      attrs: { nope: { opacity: 0.5 } },
    });
    expect(svg).not.toContain("nope");
  });
});

describe("image assets once per hash, EXIF transform", () => {
  test("two images with the same bytes and two parts using one sprite embed one asset each", () => {
    const sprite = realPng(80, 60, () => [10, 20, 30, 255]);
    const images = resolverOf({
      base: realPng(600, 480, () => [200, 200, 200, 255]),
      spr: sprite,
      twin: sprite,
    });
    const spec = fig({}, undefined, {
      images: [
        { id: "base", src: "a.png" },
        { id: "spr", src: "b.png" },
        { id: "twin", src: "c.png" },
      ],
    });
    (spec.figures as { parts: { image: string }[] }[])[0]!.parts[1]!.image = "twin";
    const { model } = pipeline(spec, images);
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    expect(svg.match(/<image /g)).toHaveLength(2); // base + one shared sprite
    expect(svg.match(/<use /g)).toHaveLength(3); // base + two sprite uses
    expect(boardsOf(model)!.assets.size).toBe(2);
  });

  test("orientationMatrix maps the stored corners onto the upright box, for all 8 values", () => {
    const w = 40;
    const h = 20; // stored size
    const apply = (m: string, x: number, y: number): [number, number] => {
      const [a, b, c, d, e, f] = /matrix\(([^)]*)\)/
        .exec(m)![1]!
        .split(" ")
        .map(Number) as number[] as [number, number, number, number, number, number];
      return [a * x + c * y + e, b * x + d * y + f];
    };
    const expected: Record<number, [number, number]> = {
      // where the stored top-left corner ends up (EXIF definition)
      2: [w, 0],
      3: [w, h],
      4: [0, h],
      5: [0, 0],
      6: [h, 0],
      7: [h, w],
      8: [0, w],
    };
    expect(orientationMatrix(1, w, h)).toBeUndefined();
    for (let o = 2; o <= 8; o++) {
      const m = orientationMatrix(o, w, h)!;
      expect(apply(m, 0, 0), `orientation ${o}`).toEqual(expected[o]);
      // upright size: 5 to 8 swap
      const [dw, dh] = o >= 5 ? [h, w] : [w, h];
      for (const [x, y] of [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ] as const) {
        const [px, py] = apply(m, x, y);
        expect([0, dw]).toContain(px);
        expect([0, dh]).toContain(py);
      }
    }
  });

  test("a rotated JPEG is embedded with stored size and the transform, shown at its upright size", () => {
    const jpeg = makeJpeg({ w: 30, h: 10, meta: [JPEG_METADATA.exif(6)] });
    const images = resolverOf({ base: jpeg, spr: realPng(80, 60, () => [1, 2, 3, 255]) });
    expect(images.get("base")).toMatchObject({ width: 10, height: 30, orientation: 6 });
    const { model } = pipeline(fig(), images);
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    const base = images.get("base")!;
    expect(svg).toContain(
      `<image id="${bids(model).image(base.hash)}" href="data:image/jpeg;base64,`,
    );
    expect(svg).toMatch(
      /width="30" height="10" preserveAspectRatio="none" transform="matrix\(0 1 -1 0 10 0\)"\/>/,
    );
    // the panel follows the upright aspect (10 x 30): 256 wide, 768 tall
    expect(svg).toMatch(/<rect class="pc-t-board" x="0" y="-768" width="256" height="768"\/>/);
  });
});

describe("panels, sprites and draw order", () => {
  test("the panel stands upright at the board anchor; sprites are placed in base pixels", () => {
    const { model } = pipeline(fig());
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    expect(svg).toContain(`<g id="${bids(model).board("f")}">`);
    expect(svg).toContain('class="pc-t-board" x="0" y="-204.8" width="256" height="204.8"');
    // p1 seat (100, 300): translate(100 s, -204.8 + 300 s) scale(s)
    const n = (v: number) => String(Number(v.toFixed(2)));
    expect(svg).toContain(`translate(${n(100 * SCALE)} ${n(-204.8 + 300 * SCALE)})`);
  });

  test("default exploded place is straight up by the real sprite height plus 20%", () => {
    const { model } = pipeline(fig({ pose: "exploded" }));
    const attrs = animate(model, { speed: 1, mode: "frame", time: 0 }).attrs;
    // p2 has no `exploded`: up by 60 px * 1.2 in base pixels
    expect(attrs).toBeUndefined(); // no steps: nothing animates; the DOM carries the base pose
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    const dy = -(60 * 1.2 * SCALE);
    expect(svg).toContain(
      `<g id="${sprite(model, "p2")}" transform="translate(0 ${dy.toFixed(2)})">`,
    );
    // p1 has an explicit one: (100,100) - (100,300)
    expect(svg).toContain(
      `<g id="${sprite(model, "p1")}" transform="translate(0 ${(-200 * SCALE).toFixed(2)})">`,
    );
  });

  test("a different sprite height changes the default (real sizes, not a constant)", () => {
    const images = resolverOf({
      base: realPng(600, 480, () => [1, 1, 1, 255]),
      spr: realPng(80, 120, () => [1, 2, 3, 255]),
    });
    const { model } = pipeline(fig({ pose: "exploded" }), images);
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    expect(svg).toContain(`translate(0 ${(-(120 * 1.2 * SCALE)).toFixed(2)})`);
  });

  const mkSprite = (id: string, seatY: number, h: number, z?: number, index = 0) => ({
    part: { id, ...(z === undefined ? {} : { z }) },
    index,
    seat: { x: 0, y: seatY },
    height: h,
  });

  test("draw order: z, then the seat's bottom edge (lower = later), then spec order", () => {
    const a = mkSprite("a", 100, 50, undefined, 0); // bottom 150
    const b = mkSprite("b", 80, 100, undefined, 1); // bottom 180: nearer, drawn later
    const c = mkSprite("c", 10, 10, undefined, 2); // bottom 20
    const d = mkSprite("d", 100, 50, undefined, 3); // bottom 150, ties with a: spec order
    const ordered = [a, b, c, d].sort((x, y) => drawOrder(x as never, y as never));
    expect(ordered.map((s) => s.part.id)).toEqual(["c", "a", "d", "b"]);
    const z1 = mkSprite("z1", 0, 5, 1, 4); // z above every default
    const zm = mkSprite("zm", 900, 5, -1, 5); // z below every default
    expect(
      [a, b, c, d, z1, zm].sort((x, y) => drawOrder(x as never, y as never)).map((s) => s.part.id),
    ).toEqual(["zm", "c", "a", "d", "b", "z1"]);
  });

  test("the sprites of a figure appear in the DOM in draw order, from real sizes", () => {
    // tall sprite seated higher but with a lower bottom edge than the short one
    const images = resolverOf({
      base: realPng(600, 480, () => [1, 1, 1, 255]),
      tall: realPng(40, 200, () => [1, 2, 3, 255]),
      short: realPng(40, 20, () => [3, 2, 1, 255]),
    });
    const spec = fig(
      {
        parts: [
          { id: "t", image: "tall", seat: [0, 100] }, // bottom 300
          { id: "s", image: "short", seat: [0, 200] }, // bottom 220
          { id: "u", image: "short", seat: [0, 250], z: -1 },
        ],
      },
      undefined,
      {
        images: [
          { id: "base", src: "a.png" },
          { id: "tall", src: "b.png" },
          { id: "short", src: "c.png" },
        ],
      },
    );
    const { model } = pipeline(spec, images);
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    const at = (p: string) => svg.indexOf(`id="${sprite(model, p)}"`);
    expect(at("u")).toBeGreaterThan(-1);
    expect(at("u")).toBeLessThan(at("s")); // z -1: first
    expect(at("s")).toBeLessThan(at("t")); // bottom 220 before 300
  });

  test("layoutFigure leaves out a part whose image is unavailable", () => {
    const { figure } = {
      figure: {
        id: "f",
        base: "b",
        pose: "assembled" as const,
        baseLevel: 0,
        stages: [],
        parts: [
          { id: "a", image: "x", seat: [0, 0] as const, detail: [], tags: [], arrow: false },
          { id: "b", image: "y", seat: [0, 0] as const, detail: [], tags: [], arrow: false },
        ],
      },
    };
    const l = layoutFigure(figure, { x: 0, y: 0 }, 100, 100, (i) =>
      i === "x" ? { width: 1, height: 1 } : undefined,
    );
    expect(l.sprites.map((s) => s.part.id)).toEqual(["a"]);
  });

  test("stackLabels keeps fixed labels, steps the others down, and is deterministic", () => {
    const items = [
      { key: "b", centre: 50, height: 20 },
      { key: "a", centre: 50, height: 20 },
      { key: "fix", centre: 0, height: 20, fixedTop: 60 },
    ];
    const t = stackLabels(items, 4);
    expect(t.get("fix")).toBe(60);
    expect(t.get("a")).toBe(84); // wants 40..60, which touches the fixed 60..80: steps below it
    expect(t.get("b")).toBe(108);
    const placed = [...t]
      .map(([k, top]) => ({ k, top, bottom: top + 20 }))
      .sort((x, y) => x.top - y.top);
    for (let i = 1; i < placed.length; i++) {
      expect((placed[i] as { top: number }).top).toBeGreaterThanOrEqual(
        (placed[i - 1] as { bottom: number }).bottom + 4 - 1e-9,
      );
    }
    expect([...stackLabels([...items].reverse(), 4)].sort()).toEqual([...t].sort());
  });
});

describe("motion: tracks, frame mode equals CSS, zero SMIL in css mode", () => {
  const steps = [
    { caption: "a", duration: 2 },
    { caption: "b", duration: 5, assembly: [{ explode: "f" }] },
    { caption: "c", duration: 5, assembly: [{ implode: "f" }] },
  ];
  const spec = fig(
    {
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
    steps,
  );
  const { model, scene } = pipeline(spec);

  test("the plan's actions become CSS in the loop, in both motion modes", () => {
    for (const motion of ["smil", "css"] as const) {
      const layer = animate(model, { speed: 1, motion, mode: "loop" });
      const rules = parseRules(layer.css);
      expect(rules.has(sprite(model, "p1")), motion).toBe(true);
      expect(rules.has(sprite(model, "p2")), motion).toBe(true);
      expect(layer.duration).toBe(12);
      expect(layer.attrs).toBeUndefined();
    }
  });

  test("frame mode equals the CSS pose at sampled times (sprites and fades)", () => {
    const layer = animate(model, { speed: 1, mode: "loop" });
    const rules = parseRules(layer.css);
    const kf = parseKeyframes(layer.css);
    const ids = [...rules.keys()].filter((i) => /__[sal]\./.test(i));
    expect(ids.length).toBeGreaterThanOrEqual(4); // two sprites and labels and an arrow
    let moving = 0;
    for (let t = 0; t < 12; t += 0.05) {
      const frame = animate(model, { speed: 1, mode: "frame", time: t }).attrs!;
      for (const id of ids) {
        const r = rules.get(id)!;
        const css = cssAt(kf.get(r.name)!, r.tf, r.dur, t);
        const f = frame[id]!;
        if (f.transform !== undefined) {
          const [x, y] = transformOf(f.transform);
          expect(x, `${id} x @${t}`).toBeCloseTo(css[0] as number, 1);
          expect(y, `${id} y @${t}`).toBeCloseTo(css[1] as number, 1);
          if (Math.abs(y) > 0.5 && Math.abs(y) < 100) moving++;
        } else expect(f.opacity as number, `${id} @${t}`).toBeCloseTo(css[0] as number, 1);
      }
    }
    expect(moving).toBeGreaterThan(10); // mid-motion samples were compared, not just rest poses
  });

  test("frame mode with speed: the clock is the output clock, the pose is the loop's", () => {
    const at = (speed: number, time: number) =>
      animate(model, { speed, mode: "frame", time }).attrs![sprite(model, "p1")]!.transform;
    // speed 2: output time 3 is loop time 6, i.e. step 2's explode is in progress
    expect(at(2, 3)).toBe(at(1, 6));
    // wraps around the loop
    expect(at(1, 12 + 3.3)).toBe(at(1, 3.3));
    expect(at(1, -8.7)).toBe(at(1, 3.3));
  });

  test("zero SMIL elements in css mode, also with flows; pose motion is CSS in smil mode too", async () => {
    const withFlow = fig({ parts: (spec.figures as { parts: unknown[] }[])[0]!.parts }, steps, {
      nodes: [
        { id: "a", type: "server" },
        { id: "b", type: "sql" },
      ],
      edges: [{ from: "a", to: "b" }],
      flows: [{ from: "a", to: "b" }],
    });
    const r = async (motion: "css" | "smil") =>
      (
        await render(withFlow, {
          theme: THEME,
          font: "system",
          motion,
          optimize: false,
          images: IMAGES(),
        })
      ).outputs[0]!.data as string;
    const css = await r("css");
    expect(css).not.toMatch(/<(animate|set|animateMotion|animateTransform)\b/);
    expect(css).toContain("@keyframes");
    const smil = await r("smil");
    expect(smil).toMatch(/<animateMotion\b/); // the particles
    // the sprites still move by CSS, with no SMIL on them
    expect(smil).toContain(`#pc-`);
    expect(/<g id="[^"]*__s\.p1"[^>]*>(?!<animate)/.test(smil)).toBe(true);
  });

  test("motion arrows fade in and out around the move; labels fade after arrival", () => {
    const bm = boardsOf(model)!;
    const arrow = bm.tracks(1).fades.find((f) => f.id.includes("__a.p1.f"))!;
    expect(arrow).toBeDefined();
    const at = (t: number) =>
      animate(model, { speed: 1, mode: "frame", time: t }).attrs![arrow.id]!.opacity as number;
    // step 2 starts at 2.0; p1 moves 2.0 to 3.2: invisible before, peak mid-move, gone after
    expect(at(1.9)).toBe(0);
    expect(at(2.6)).toBe(1);
    expect(at(3.3)).toBe(0);
    // the reverse-direction arrow belongs to step 3's implode, not step 2
    const rev = bm.tracks(1).fades.find((f) => f.id.includes("__a.p1.r"))!;
    const atRev = (t: number) =>
      animate(model, { speed: 1, mode: "frame", time: t }).attrs![rev.id]!.opacity as number;
    expect(atRev(2.6)).toBe(0);
    expect(atRev(7 + 1.9)).toBe(1); // implode: p1 moves 8.3 to 9.5
    // label of p1 at its seat (pose 0): visible at rest, hidden while it travels, back after 0.2 s
    const l0 = bm.tracks(1).fades.find((f) => f.id.endsWith("__l.p1.0"))!;
    const l0at = (t: number) =>
      animate(model, { speed: 1, mode: "frame", time: t }).attrs![l0.id]!.opacity as number;
    expect(l0at(0)).toBe(1);
    expect(l0at(2.6)).toBe(0);
    expect(l0at(11.5)).toBe(1); // after the implode of step 3 (7.0 to 8.2) is long done
    void scene;
  });

  test("reduced motion: discrete per-step poses, state animations kept, camera fixed", () => {
    const layer = animate(model, { speed: 1, mode: "loop" });
    const media = /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\n\}/.exec(
      layer.css,
    )![1] as string;
    expect(media).not.toContain("animation:none!important");
    expect(media).toContain("step-end");
    // one discrete keyframes block per sprite: each step's END pose, no tween
    const kf = parseKeyframes(layer.css);
    const id = sprite(model, "p1");
    const red = [
      ...media.matchAll(/#([^{}\s,]+)\{animation:(\S+) ([\d.]+)s step-end infinite\}/g),
    ].find((m) => (m[1] as string).replace(/\\(.)/g, "$1") === id)!;
    const stops = kf.get(red[2] as string)!;
    const ends = [0, 1, 2].map((k) => {
      const t = boardsOf(model)!.tracks(1).stepEnds[k] as number;
      const f = animate(model, { speed: 1, mode: "step", step: k + 1 }).attrs![id]!;
      return { t, f: transformOf(f.transform) };
    });
    // step 1 (no action) ends exploded? base is assembled (0,0); step 2 exploded; step 3 back
    expect(ends[0]!.f).toEqual([0, 0]);
    expect(ends[1]!.f[1]).toBeCloseTo(-200 * SCALE, 1);
    expect(ends[2]!.f).toEqual([0, 0]);
    // the keyframes hold exactly those poses at the step starts (0%, 2/12, 7/12)
    const poses = stops.map((s) => [s.p, ...(s.decl.match(/-?[\d.]+/g) ?? []).map(Number)]);
    expect(poses.map((p) => [Math.round((p[0] as number) * 12 * 100) / 100, p[2]])).toEqual([
      [0, 0],
      [2, Number((-200 * SCALE).toFixed(2))],
      [7, 0],
    ]);
    // captions keep their step-end keyframes (not switched off), the camera/particles rules stay
    expect(layer.css).toMatch(/pc-t-cap_2\{animation:/);
    expect(media).not.toMatch(/pc-t-cap_/);
  });

  test("specs without figure actions keep the 1.1 reduced-motion rule", () => {
    const { model: m } = pipeline(fig({}, [{ caption: "a" }, { caption: "b" }]));
    const layer = animate(m, { speed: 1, mode: "loop" });
    expect(layer.css).toContain("animation:none!important");
    expect(boardsOf(m)!.tracks(1).poses).toEqual([]);
  });

  test("interactive: Step pauses at the settled time of steps that have actions", () => {
    const layer = animate(model, { speed: 1, mode: "interactive" });
    const G = /G=\[([^\]]*)\]/.exec(layer.script!)![1]!.split(",").map(Number);
    const S = /S=\[([^\]]*)\]/.exec(layer.script!)![1]!.split(",").map(Number);
    expect(S).toEqual([0, 2, 7]);
    // step 2: opens at 2.0; stage 1 (1.2) then stage 2 (delay .3 + 1.0): 2.5 s of motion
    expect(G[0]).toBe(0); // no actions: its start
    expect(G[1]).toBeCloseTo(2 + 2.5, 3);
    expect(G[2]).toBeCloseTo(7 + 2.5, 3);
    expect(boardsOf(model)!.tracks(1).settled).toEqual([undefined, 4.5, 9.5]);
  });

  test("interactive Step settled target is divided by the speed", () => {
    const layer = animate(model, { speed: 2, mode: "interactive" });
    const G = /G=\[([^\]]*)\]/.exec(layer.script!)![1]!.split(",").map(Number);
    expect(G[1]).toBeCloseTo(4.5 / 2, 3);
  });
});

describe("per-step outputs, static and raster frames", () => {
  const spec = fig(
    { pose: "exploded", width: 3 },
    [
      { caption: "start", duration: 2 },
      { caption: "in", duration: 4, assembly: [{ implode: "f" }], focus: "f" },
      { caption: "out", duration: 4, assembly: [{ explode: "f" }] },
    ],
    {
      nodes: [
        { id: "n", type: "server", pos: { x: 0, y: 0 } },
        { id: "m", type: "sql", pos: { x: 12, y: 0 } },
      ],
    },
  );

  test("static is the rest frame (base pose); each step shows its end pose, zoomed as focused", async () => {
    const r = await render(spec, {
      theme: THEME,
      font: "system",
      outputs: ["static", "steps"],
      images: IMAGES(),
      optimize: false,
    });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const byPath = Object.fromEntries(r.outputs.map((o) => [o.path, o.data as string]));
    const sprId = (variant: string) => `pc-${variant}`;
    void sprId;
    const tr = (svg: string, part: string) =>
      /<g id="[^"]*__s\.PART"(?: transform="([^"]*)")?/.exec(svg.replace(/PART/g, part))?.[1] ??
      /<g id="[^"]*__s\.PART"(?: transform="([^"]*)")?/.exec(svg.replace(/PART/g, part))?.[1];
    const at = (svg: string, part: string): string | undefined =>
      new RegExp(`<g id="[^"]*__s\\.${part}"( transform="([^"]*)")?`).exec(svg)?.[2];
    void tr;
    expect(Object.keys(byPath).sort()).toEqual([
      "diagram.static.svg",
      "diagram.steps/step-01.svg",
      "diagram.steps/step-02.svg",
      "diagram.steps/step-03.svg",
    ]);
    const up = `translate(0 ${Number((-200 * (96 / 600)).toFixed(2))})`;
    expect(at(byPath["diagram.static.svg"]!, "p1")).toBe(up);
    expect(at(byPath["diagram.steps/step-01.svg"]!, "p1")).toBe(up);
    expect(at(byPath["diagram.steps/step-02.svg"]!, "p1")).toBe("translate(0 0)");
    expect(at(byPath["diagram.steps/step-03.svg"]!, "p1")).toBe(up);
    // step 2 focuses on the figure: a zoomed view box, not the model's
    const vb = (s: string) => /viewBox="([^"]*)"/.exec(s)![1];
    expect(vb(byPath["diagram.steps/step-02.svg"]!)).not.toBe(vb(byPath["diagram.static.svg"]!));
    expect(vb(byPath["diagram.steps/step-01.svg"]!)).toBe(vb(byPath["diagram.static.svg"]!));
    // labels: the exploded-pose label shows in the step that ends exploded, the seated one in step 2
    expect(byPath["diagram.steps/step-02.svg"]).toMatch(/__l\.p1\.0"/);
  });

  test("PNG frames apply the pose: the sprite is where the pose says (pixels)", async () => {
    // a unique sprite colour on a plain base, so its pixels can be found
    const images = resolverOf({
      base: realPng(600, 480, () => [255, 255, 255, 255]),
      spr: realPng(80, 60, () => [255, 0, 0, 255]),
    });
    const one = fig(
      {
        pose: "exploded",
        parts: [{ id: "p1", image: "spr", seat: [100, 300], exploded: [100, 100] }],
      },
      [{ duration: 2 }, { duration: 4, assembly: [{ implode: "f" }] }],
    );
    const redBox = async (time: number) => {
      const r = await render(one, {
        theme: THEME,
        font: "outline",
        outputs: ["png"],
        png: { time, scale: 1 },
        images,
      });
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const png = decodePng(r.outputs[0]!.data as Uint8Array);
      let minY = Infinity;
      let maxY = -1;
      let n = 0;
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          const i = (y * png.width + x) * 4;
          if (png.data[i]! > 240 && png.data[i + 1]! < 20 && png.data[i + 2]! < 20) {
            n++;
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
      }
      return { minY, maxY, n };
    };
    const start = await redBox(0); // exploded: seat y 100
    const end = await redBox(5.1); // implode done by 3.2, the closing return starts at 5.2
    expect(start.n).toBeGreaterThan(500);
    expect(end.n).toBe(start.n); // same sprite, same size
    // 200 base px = 85.33 panel px apart, at scale 1
    expect(end.minY - start.minY).toBeGreaterThan(84);
    expect(end.minY - start.minY).toBeLessThan(87);
    const mid = await redBox(2.6);
    expect(mid.minY).toBeGreaterThan(start.minY + 5);
    expect(mid.minY).toBeLessThan(end.minY - 5);
  }, 60_000);

  test("the design's heat-sink example renders: animated, static, steps, interactive, png, gif", async () => {
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
    const r = await render(designSpec(), {
      theme: THEME,
      font: "system",
      outputs: ["animated", "static", "steps", "interactive", "png", "gif", "mp4"],
      images: heatSinkImages(),
      video: { fps: 4, durationSec: 10, encoder },
      png: { scale: 1 },
    });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.outputs.map((o) => o.path).sort()).toEqual([
      "diagram.gif",
      "diagram.interactive.svg",
      "diagram.mp4",
      "diagram.png",
      "diagram.static.svg",
      "diagram.steps/step-01.svg",
      "diagram.steps/step-02.svg",
      "diagram.steps/step-03.svg",
      "diagram.svg",
    ]);
    const gif = r.outputs.find((o) => o.kind === "gif")!.data as Uint8Array;
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe("GIF89a");
    expect(frames.length).toBe(40);
    // the frames are not all the same picture (the sprites move)
    expect(new Set(frames).size).toBeGreaterThan(1);
    const png = r.outputs.find((o) => o.kind === "png")!.data as Uint8Array;
    expect(decodePng(png).width).toBeGreaterThan(100);
    const animated = r.outputs.find((o) => o.kind === "animated")!.data as string;
    expect(animated).toContain("Heat sink 1");
    expect(animated).toContain("with retention clip");
    expect(animated).toContain("Installing the heat sinks");
    // credits: the figure and its images share one source, listed once
    expect(r.scene!.assemblies!.credits).toHaveLength(1);
  }, 120_000);
});

describe("labels, leaders and credits (§11.6)", () => {
  test("labels have leaders, details and a figure title; hide suppresses them", () => {
    const { model } = pipeline(
      fig({
        label: "My figure",
        parts: [
          {
            id: "p1",
            image: "spr",
            seat: [100, 300],
            exploded: [100, 100],
            label: "Part one",
            detail: ["d1", "d2"],
          },
          { id: "p2", image: "spr", seat: [300, 320], label: "Part two" },
          { id: "p3", image: "spr", seat: [400, 320] },
        ],
        stages: [{ parts: ["p1"] }, { parts: ["p2"], labels: "hide" }],
      }),
    );
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    expect(svg).toContain(">My figure</text>");
    expect(svg).toContain(">Part one</text>");
    expect(svg).toContain(">d1</text>");
    expect(svg).toContain(">d2</text>");
    expect(svg).not.toContain(">Part two</text>"); // its stage hides labels
    expect(svg).toMatch(/<g id="[^"]*__l\.p1\.0"><path class="pc-t-leader" d="M[^"]*L[^"]*"\/>/);
    // p3 has no label: no label group
    expect(svg).not.toContain("__l.p3");
  });

  test("labels of one pose do not overlap in their column", () => {
    const parts = Array.from({ length: 6 }, (_, i) => ({
      id: `q${i}`,
      image: "spr",
      seat: [500, 100 + i * 4],
      label: `Label ${i}`,
    }));
    const { model } = pipeline(fig({ parts }));
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    const ys = [...svg.matchAll(/<text x="[^"]*" y="([\d.-]+)"[^>]*>Label \d<\/text>/g)].map((m) =>
      Number(m[1]),
    );
    expect(ys).toHaveLength(6);
    const sorted = [...ys].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(12);
    }
  });

  const credited = (n: number) =>
    fig({}, undefined, {
      images: [
        {
          id: "base",
          src: "a.png",
          source: { attribution: "Acme", document: "Manual", page: 3, license: "CC-BY-4.0" },
        },
        ...(n > 1
          ? [{ id: "spr", src: "b.png", source: { attribution: "Bob & <Co>", document: "Other" } }]
          : [{ id: "spr", src: "b.png" }]),
      ],
    });

  test("credits line: pinned in the overlay, escaped; <desc> lists every entry", () => {
    const { model, scene } = pipeline(credited(2));
    expect(scene.assemblies!.credits).toHaveLength(2);
    const svg = svgOf(model, animate(model, { speed: 1, mode: "frame", time: 0 }));
    expect(svg).toContain(`<g id="${bids(model).credits()}">`);
    expect(svg).toContain(
      "Images: Acme, Manual p. 3 (CC-BY-4.0); Bob &amp; &lt;Co&gt;, Other</text>",
    );
    expect(/<desc[^>]*>([^<]*)<\/desc>/.exec(svg)![1]).toMatch(/Acme, Manual p\. 3 \(CC-BY-4\.0\)/);
    expect(/<desc[^>]*>([^<]*)<\/desc>/.exec(svg)![1]).toContain("Bob &amp; &lt;Co&gt;, Other");
    // pinned like the legend: in the loop with zoom the credits get the inverse camera
    const zoomed = pipeline(
      fig({ width: 3 }, [{ duration: 3, focus: "f" }], {
        nodes: [
          { id: "a", type: "server", pos: { x: 0, y: 0 } },
          { id: "m", type: "sql", pos: { x: 14, y: 0 } },
        ],
        images: [
          { id: "base", src: "a.png", source: { license: "MIT" } },
          { id: "spr", src: "b.png" },
        ],
      }),
    );
    const css = animate(zoomed.model, { speed: 1, mode: "loop" }).css;
    expect(css).toContain(`#${bids(zoomed.model).credits()}`);
  });

  test("credits line: up to 3 entries, then 'and N more'; none without attribution or license", () => {
    const src = (n: number) => ({ attribution: `A${n}`, document: `D${n}` });
    expect(creditsLine([src(1), src(2), src(3)])).toBe("Images: A1, D1; A2, D2; A3, D3");
    expect(creditsLine([src(1), src(2), src(3), src(4), src(5)])).toBe(
      "Images: A1, D1; A2, D2; A3, D3; and 2 more",
    );
    expect(creditsLine([{ document: "only provenance", page: 2 }])).toBe("");
    expect(creditsLine([])).toBe("");
    expect(creditsLine([{ license: "MIT" }])).toBe("Images: (MIT)");
    const { model } = pipeline(credited(1));
    // a source with no attribution or license does not make a line
    const none = pipeline(
      fig({}, undefined, {
        images: [
          { id: "base", src: "a.png", source: { document: "d" } },
          { id: "spr", src: "b.png" },
        ],
      }),
    );
    expect(boardsOf(none.model)!.creditsId).toBeUndefined();
    expect(boardsOf(model)!.creditsId).toBe(bids(model).credits());
  });
});

describe("bounds, focus and explicit positions", () => {
  test("boards are in bounds and focusTargets once the base image size is known", () => {
    const spec = fig({}, undefined, { nodes: [{ id: "a", type: "server" }] });
    const parsed = validate(spec).spec!;
    const without = buildScene(parsed, {});
    const withImages = buildScene(parsed, { images: IMAGES() });
    expect(Object.keys(without.focusTargets)).toEqual(["a"]);
    expect(Object.keys(withImages.focusTargets)).toEqual(["a", "f"]);
    const box = withImages.focusTargets.f!;
    // the panel: 8 tiles along +x, upright, 204.8 px = 6.4 z units high
    expect(box.size.x).toBe(8);
    expect(box.size.y).toBe(0);
    expect(box.size.z).toBe(6.4);
    expect(box.origin).toEqual(withImages.assemblies!.boards[0]!.anchor);
    // bounds grew to include it, and still contain the nodes
    expect(withImages.bounds.origin.x).toBe(without.bounds.origin.x);
    expect(withImages.bounds.size.x).toBeGreaterThan(without.bounds.size.x + 8);
    expect(withImages.bounds.size.z).toBeGreaterThanOrEqual(6.4);
    // 1.1 content is untouched
    expect(without.bounds).toEqual(
      buildScene(
        validate({ meta: { version: "1" }, nodes: [{ id: "a", type: "server" }] }).spec!,
        {},
      ).bounds,
    );
  });

  test("a figure-only scene's bounds are the board's", () => {
    const g = buildScene(validate(fig()).spec!, { images: IMAGES() });
    expect(g.bounds).toEqual({ origin: { x: 0, y: 0, z: 0 }, size: { x: 8, y: 0, z: 6.4 } });
  });

  test("focus on a figure: valid in validate, a camera zoom in the scene, a warning without the image", () => {
    const spec = fig({ width: 3 }, [{ duration: 3, focus: "f", caption: "x" }, { duration: 3 }], {
      nodes: [
        { id: "a", type: "server", pos: { x: 0, y: 0 } },
        { id: "m", type: "sql", pos: { x: 14, y: 0 } },
      ],
    });
    const v = validate(spec);
    expect(v.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(validate(fig({}, [{ focus: "nope" }])).diagnostics.map((d) => d.code)).toContain(
      "semantic/unknown-node",
    );
    const parsed = v.spec!;
    const ok = buildScene(parsed, { images: IMAGES() });
    expect(ok.timeline[0]!.focus).toBe("f");
    expect(ok.diagnostics.filter((d) => d.code === "semantic/unknown-focus")).toEqual([]);
    const bare = buildScene(parsed, {});
    expect(bare.timeline[0]!.focus).toBeUndefined();
    expect(bare.diagnostics.find((d) => d.code === "semantic/unknown-focus")?.path).toBe(
      "/steps/0/focus",
    );
    // zoom: the focus rect covers the panel, the loop zooms into it
    const model = buildModel({
      scene: ok,
      theme: THEME,
      font: "system",
      prefix: "pc-t",
      spec: parsed,
      images: IMAGES(),
    });
    expect(model.focusRects.f).toBeDefined();
    expect(model.focusRects.f!.width).toBeGreaterThanOrEqual(96);
    expect(animate(model, { speed: 1, mode: "loop" }).css).toMatch(/scale\(/);
  });

  test("the zoomed windows agree between validate and scene (the same stepViews)", () => {
    const steps = [{ duration: 1, focus: "f", assembly: [{ explode: "f" }] }, { duration: 1 }];
    const spec = fig({}, steps);
    const v = validate(spec);
    const parsed = v.spec!;
    const inValidate = v.diagnostics.find((d) => d.code === "assembly/compressed");
    const inScene = buildScene(parsed, { images: IMAGES() }).assemblies!.plan[0]!.actions[0]!;
    expect(inValidate).toBeDefined();
    expect(inValidate!.params!.scale).toBe(inScene.scale);
  });

  test("explicit pos overlapping other content warns (layout/overlap); automatic placement does not", () => {
    const base = fig({}, undefined, { nodes: [{ id: "a", type: "server", pos: { x: 0, y: 0 } }] });
    const warn = (spec: Spec) =>
      buildScene(validate(spec).spec!, { images: IMAGES() }).diagnostics.filter(
        (d) => d.code === "layout/overlap",
      );
    expect(warn(base)).toEqual([]); // auto: beyond the node
    const onTop = fig({ pos: { x: 0, y: 0 } }, undefined, {
      nodes: [{ id: "a", type: "server", pos: { x: 0, y: 0 } }],
    });
    const w = warn(onTop);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: "warning", path: "/figures/0/pos" });
    expect(w[0]!.message).toBe('Figure "f" overlaps "a" at its manual position');
    // far away: no warning
    expect(
      warn(fig({ pos: { x: 40, y: 40 } }, undefined, { nodes: [{ id: "a", type: "server" }] })),
    ).toEqual([]);
    // two boards on the same spot
    const two = fig({ pos: { x: 0, y: 0 } });
    (two.figures as unknown[]).push({
      id: "g",
      base: "base",
      pos: { x: 1, y: 0 },
      parts: [{ id: "p", image: "spr", seat: [0, 0] }],
    });
    const ww = warn(two);
    expect(ww.map((d) => d.path)).toEqual(["/figures/0/pos", "/figures/1/pos"]);
    // without images there is no size, so no overlap can be known
    expect(
      buildScene(validate(onTop).spec!, {}).diagnostics.filter((d) => d.code === "layout/overlap"),
    ).toEqual([]);
  });
});

describe("loop closure (§7.4)", () => {
  const closing = (focus: boolean) => {
    const spec = fig({}, [
      { duration: 4, assembly: [{ explode: "f" }], ...(focus ? { focus: "f" } : {}) },
    ]);
    return pipeline(spec);
  };
  const track = (model: RenderModel) =>
    boardsOf(model)!
      .tracks(1)
      .poses.find((p) => p.id === sprite(model, "p1"))!;

  test("last step zoomed: the loop ends back at the base pose by a fast return in the closing transition", () => {
    const { model } = closing(true);
    const keys = track(model).keys;
    expect(keys[0]).toMatchObject({ t: 0, y: 0 });
    // explode ends inside the window; the return starts where the closing transition starts
    const closeStart = 4 - 0.8;
    const start = keys.find((k) => k.t === closeStart)!;
    expect(start).toBeDefined();
    expect(start.y).toBeCloseTo(-200 * SCALE, 1);
    expect(start.easing).toEqual([0.4, 0, 0.2, 1]);
    expect(keys[keys.length - 1]).toMatchObject({ t: 4, y: 0 });
    // strictly increasing times, no NaN
    for (let i = 1; i < keys.length; i++) expect(keys[i]!.t).toBeGreaterThan(keys[i - 1]!.t);
    expect(JSON.stringify(keys)).not.toMatch(/null|NaN/);
    // frame mode agrees: seated at the loop start, exploded just before the return, seated at the wrap
    const y = (t: number) =>
      transformOf(
        animate(model, { speed: 1, mode: "frame", time: t }).attrs![track(model).id]!.transform,
      )[1];
    expect(y(0)).toBe(0);
    expect(y(closeStart)).toBeCloseTo(-200 * SCALE, 1);
    expect(y(4 - 0.01)).toBeGreaterThan(-5);
    expect(y(4)).toBe(0);
  });

  test("last step not zoomed: it reserves the closing window and returns smoothly, no snap (Q03)", () => {
    const steps = [{ caption: "A" }, { assembly: [{ explode: "f" }] }];
    const { model, scene } = pipeline(fig({}, steps));
    expect(scene.timeline[1]!.focus).toBeUndefined();
    // the window is the step's own: tr = min(0.8, 0.25 * 3) = 0.75, so the return is [5.25, 6]
    const keys = track(model).keys;
    const startKey = keys.find((k) => k.t === 5.25)!;
    expect(startKey).toBeDefined();
    expect(startKey.y).toBeCloseTo(-200 * SCALE, 1);
    expect(startKey.easing).toEqual([0.4, 0, 0.2, 1]);
    expect(keys[keys.length - 1]).toMatchObject({ t: 6, y: 0 });
    const y = (t: number) =>
      transformOf(
        animate(model, { speed: 1, mode: "frame", time: t }).attrs![track(model).id]!.transform,
      )[1];
    // eased in between, and the frame just before the restart is (almost) the frame at 0
    expect(y(5.6)).toBeLessThan(-5);
    expect(y(5.6)).toBeGreaterThan(-200 * SCALE + 5);
    expect(Math.abs(y(6 - 0.002) - y(0))).toBeLessThan(1);
    // continuity everywhere: no sample jumps by more than a fraction of the travel
    let prev = y(0);
    for (let t = 0.01; t < 6; t += 0.01) {
      expect(Math.abs(y(t) - prev)).toBeLessThan(6);
      prev = y(t);
    }
    // the label follows: the exploded label fades out as it leaves, the seated one in as it lands
    const l0 = boardsOf(model)!
      .tracks(1)
      .fades.find((f) => f.id.endsWith("__l.p1.0"))!;
    expect(l0.keys[l0.keys.length - 1]).toMatchObject({ t: 6, v: 1 });
  });

  test("scene and validate agree on the closing window, so compression and suggestions do", () => {
    const stages = [
      { parts: ["p1", "p2"], stagger: 0.5, duration: 1, delay: 0.25 },
      { parts: ["p3"], delay: 0.5, duration: 0.6 },
    ];
    const parts = [
      { id: "p1", image: "spr", seat: [0, 100] },
      { id: "p2", image: "spr", seat: [50, 300] },
      { id: "p3", image: "spr", seat: [90, 200] },
    ];
    const spec = fig({ stages, parts }, [{ duration: 2, assembly: [{ explode: "f" }] }]);
    const v = validate(spec);
    const fromValidate = v.diagnostics.find((d) => d.code === "assembly/compressed")!;
    const act = buildScene(v.spec!, {}).assemblies!.plan[0]!.actions[0]!;
    // 2 - tr (0.5) - 0.2 = 1.3: the same in both, and the suggestion removes it
    expect(fromValidate.params!.window).toBe(1.3);
    expect(fromValidate.params!.scale).toBe(act.scale);
    expect(fromValidate.suggestion).toBe('Set "duration": 4 on this step');
    const fixed = validate(fig({ stages, parts }, [{ duration: 4, assembly: [{ explode: "f" }] }]));
    expect(fixed.diagnostics.filter((d) => d.code === "assembly/compressed")).toEqual([]);
    // a loop that ends at its base pose reserves nothing: the full 2 - 0.2 window
    const back = validate(
      fig({ stages, parts }, [{ duration: 2, assembly: [{ explode: "f" }, { implode: "f" }] }]),
    );
    expect(back.diagnostics.find((d) => d.code === "assembly/compressed")?.params?.window).toBe(
      1.8,
    );
  });

  const zoomSpec = (speedSteps: unknown[]) =>
    fig({ width: 3 }, speedSteps, {
      nodes: [
        { id: "a", type: "server", pos: { x: 0, y: 0 } },
        { id: "m", type: "sql", pos: { x: 14, y: 0 } },
      ],
    });

  test.each([2, 0.5, 1])(
    "at speed %s the closure starts with the camera's ease-out and step 1 moves after the zoom-in",
    (speed) => {
      const { model } = pipeline(
        zoomSpec([{ duration: 4, focus: "f", assembly: [{ explode: "f" }] }]),
      );
      const layer = animate(model, { speed, mode: "loop" });
      const cam = /#pc-t-cam\{[^}]*animation:(\S+) ([\d.]+)s/.exec(layer.css)!;
      const dur = Number(cam[2]);
      expect(dur).toBeCloseTo(4 / speed, 3);
      const stops = parseKeyframes(layer.css).get(cam[1] as string)!;
      // camera stops: 0 overview, zoom-in done, ..., ease-out starts, end
      const zoomInEnd = (stops[1] as { p: number }).p * dur;
      const easeOutStart = (stops[stops.length - 2] as { p: number }).p * dur;
      expect(easeOutStart).toBeLessThan(dur);
      expect(zoomInEnd).toBeGreaterThan(0);
      const keys = boardsOf(model)!
        .tracks(speed)
        .poses.find((p) => p.id === sprite(model, "p1"))!.keys;
      const closure = keys.find((k) => Array.isArray(k.easing) && k.easing[0] === 0.4)!;
      expect(closure).toBeDefined();
      // loop seconds / speed = output seconds
      expect(closure.t / speed).toBeCloseTo(easeOutStart, 3);
      const firstMove = keys.find((k) => k.t > 0)!;
      expect(firstMove.t / speed).toBeCloseTo(zoomInEnd, 3);
      // and the CSS carries the same moments
      const css = parseKeyframes(layer.css).get(
        parseRules(layer.css).get(sprite(model, "p1"))!.name,
      )!;
      expect(css.some((s) => Math.abs(s.p * dur - easeOutStart) < 1e-3)).toBe(true);
    },
  );

  test("a loop that ends at its base pose needs no return", () => {
    const spec = fig({ pose: "exploded" }, [
      { duration: 3 },
      { duration: 4, assembly: [{ implode: "f" }, { explode: "f" }], focus: "f" },
    ]);
    const { model } = pipeline(spec);
    const keys = boardsOf(model)!
      .tracks(1)
      .poses.find((p) => p.id === sprite(model, "p1"))!.keys;
    expect(keys[keys.length - 1]!.y).toBeCloseTo(-200 * SCALE, 1);
    // no key at the closing transition start (7 - 0.8) other than part of the hold
    expect(keys.filter((k) => k.easing instanceof Array && k.easing[0] === 0.4)).toEqual([]);
  });

  test("overlapping actions on one part never jump: the later move starts where the earlier one is", () => {
    const spec = fig({}, [
      { duration: 8, assembly: [{ explode: "f" }, { implode: "f", start: 0.4 }] },
    ]);
    const { model } = pipeline(spec);
    const t = track(model);
    const y = (time: number) =>
      transformOf(animate(model, { speed: 1, mode: "frame", time }).attrs![t.id]!.transform)[1];
    for (const cut of t.keys.map((k) => k.t)) {
      expect(Math.abs(y(cut + 1e-3) - y(Math.max(0, cut - 1e-3)))).toBeLessThan(0.5);
    }
    for (let i = 1; i < t.keys.length; i++) expect(t.keys[i]!.t).toBeGreaterThan(t.keys[i - 1]!.t);
  });
});

describe("images: presence and caps before anything is encoded (§11.4)", () => {
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
  const spec = validate(fig()).spec!;

  test("a missing image is image/not-found at the declaration, and nothing is rendered", async () => {
    const r = await render(fig(), { theme: THEME, images: resolver([fake("base", 10)]) });
    expect(r.outputs).toEqual([]);
    expect(r.diagnostics.find((d) => d.code === "image/not-found")).toMatchObject({
      severity: "error",
      path: "/images/1/src",
    });
    const none = await render(fig(), { theme: THEME });
    expect(none.diagnostics.filter((d) => d.code === "image/not-found")).toHaveLength(2);
  });

  const MiB = 1024 * 1024;
  const loose = { ...DEFAULT_IMAGE_LIMITS, maxBytes: 64 * MiB, maxDimension: 99999 };

  test("the total counts base64 bytes: 6 MiB raw is 8 MiB embedded, the cap's edge (Q07)", () => {
    // 2 x 3 MiB raw = 2 x 4 MiB of base64 = exactly 8 MiB: not over the cap, over the warning
    expect(
      checkFigureImages(spec, resolver([fake("base", 3 * MiB), fake("spr", 3 * MiB)]), loose),
    ).toEqual([expect.objectContaining({ code: "budget/images", severity: "warning" })]);
    // one raw byte more per file pushes the encoded total over 8 MiB (raw would not have)
    const over = checkFigureImages(
      spec,
      resolver([fake("base", 3 * MiB + 1), fake("spr", 3 * MiB + 1)]),
      loose,
    );
    expect(over.map((d) => [d.code, d.severity])).toEqual([["image/too-large", "error"]]);
    expect(over[0]!.params!.bytes).toBe(2 * 4 * Math.ceil((3 * MiB + 1) / 3));
    // the same bytes under two ids are embedded once
    expect(
      checkFigureImages(
        spec,
        resolver([fake("base", 5 * MiB, "same"), fake("spr", 5 * MiB, "same")]),
        loose,
      ).map((d) => d.code),
    ).toEqual(["budget/images"]);
    expect(checkFigureImages(spec, resolver([fake("base", 10), fake("spr", 10)]))).toEqual([]);
  });

  test("an SVG counts its UTF-8 bytes, not its UTF-16 length", () => {
    const svgAsset = (key: string, body: string): ImageAsset => ({
      key,
      format: "svg",
      mime: "image/svg+xml",
      width: 10,
      height: 10,
      orientation: 1,
      hash: `h-${key}`,
      data: new Uint8Array(0),
      svg: { viewBox: "0 0 10 10", body, monochrome: false },
    });
    // 3-byte characters: 90_000 chars = 270_000 bytes, over the 256 KiB SVG cap, 90_000 < cap
    const body = `<text>${"€".repeat(90_000)}</text>`;
    const d = checkFigureImages(spec, resolver([svgAsset("base", body), fake("spr", 10)]));
    expect(d.map((x) => [x.code, x.path])).toEqual([["image/too-large", "/images/0/src"]]);
  });

  test("per-file caps are re-checked from the asset's sizes (caller-built images)", () => {
    const d = (a: ImageAsset) => checkFigureImages(spec, resolver([a, fake("spr", 10)]));
    expect(d(fake("base", 3 * MiB)).map((x) => x.code)).toEqual(["image/too-large"]);
    expect(d({ ...fake("base", 10), width: 9000 }).map((x) => x.code)).toEqual(["image/too-large"]);
    expect(d({ ...fake("base", 10), width: 8000, height: 8000 }).map((x) => x.code)).toEqual([
      "image/too-large",
    ]); // 64 MP
    expect(d(fake("base", 10))).toEqual([]);
  });

  describe("user SVG safety is a diagnostic, before rendering (Q04, Q05)", () => {
    const svgAsset = (key: string, body: string): ImageAsset => ({
      key,
      format: "svg",
      mime: "image/svg+xml",
      width: 10,
      height: 10,
      orientation: 1,
      hash: `h-${key}`,
      data: new Uint8Array(0),
      svg: { viewBox: "0 0 10 10", body, monochrome: false },
    });
    test.each([
      ["a handler", '<rect onclick="x()" width="1" height="1"/>'],
      ["a link element", '<a href="#x"><rect width="1" height="1"/></a>'],
      ["a set element", '<rect id="a"><set attributeName="x" to="9"/></rect>'],
      [
        "an animate element",
        '<rect><animateTransform attributeName="transform" values="a"/></rect>',
      ],
      ["an external href", '<use href="http://x/y.svg"/>'],
      ["an animation target", '<rect><foo to="http://x"/></rect>'],
      ["a script", "<script>1</script>"],
      ["an external url()", '<rect style="fill:url(http://x)"/>'],
    ])("%s is image/format at the declaration, and render does not throw", async (_n, body) => {
      const r = await render(fig(), {
        theme: THEME,
        font: "system",
        images: resolver([svgAsset("base", body), fake("spr", 10)]),
      });
      expect(r.outputs).toEqual([]);
      const dg = r.diagnostics.find((x) => x.code === "image/format")!;
      expect(dg).toMatchObject({ severity: "error", path: "/images/0/src" });
      expect(dg.message).toMatch(/SVG the renderer will not embed/);
      expect(r.diagnostics.some((x) => x.code === "render/internal-error")).toBe(false);
    });

    test("text that merely contains 'on…=' or 'to=' is not attribute context", () => {
      for (const body of [
        "<text>online = 3</text>",
        '<text x="1">onload = 1 and to="a"</text>',
        "<text>a &lt;a href=&quot;x&quot;&gt; b</text>",
        '<style>g > rect { fill: red }</style><rect width="1" height="1"/>',
      ]) {
        expect(unsafeSvgBody(body), body).toBeUndefined();
      }
      expect(unsafeSvgBody('<text onclick="x">hi</text>')).toBeDefined();
      expect(unsafeSvgBody("<rect \tONCLICK = 'x'/>")).toBeDefined();
      expect(unsafeSvgBody("<!-- <script> --><rect/>")).toBeUndefined();
      expect(unsafeSvgBody("<rect")).toMatch(/unterminated/);
    });

    test("the predicate is linear: a hostile body of 256 KiB takes well under a second", () => {
      const t = Date.now();
      for (const body of [
        "<".repeat(256 * 1024),
        `<a ${"on".repeat(128 * 1024)}`,
        `<rect ${' to=" '.repeat(50_000)}`,
        " ".repeat(256 * 1024) + "<rect/>",
        `<rect x="${">".repeat(256 * 1024)}"/>`,
      ]) {
        unsafeSvgBody(body);
      }
      expect(Date.now() - t).toBeLessThan(1000);
    });

    test("a clean SVG asset renders and is embedded as a symbol", async () => {
      const r = await render(fig(), {
        theme: THEME,
        font: "system",
        optimize: false,
        images: resolver([
          svgAsset("base", '<rect width="10" height="10" fill="#369"/>'),
          fake("spr", 10),
        ]),
      });
      const svg = r.outputs[0]?.data as string;
      expect(svg).toContain("<symbol ");
      expect(svg).toContain('viewBox="0 0 10 10"');
    });
  });

  test("more distinct images than the cap is image/too-many (from sizes, no bytes touched)", () => {
    const limits = { ...DEFAULT_IMAGE_LIMITS, maxImages: 1 };
    const d = checkFigureImages(spec, resolver([fake("base", 1), fake("spr", 1)]), limits);
    expect(d.map((x) => [x.code, x.severity])).toEqual([["image/too-many", "error"]]);
    // the same bytes under two ids count once
    expect(
      checkFigureImages(spec, resolver([fake("base", 1, "same"), fake("spr", 1, "same")]), limits),
    ).toEqual([]);
  });

  test("a degenerate image size draws no panel and never throws", async () => {
    const zero = { ...fake("base", 10), width: 0 } as ImageAsset;
    const r = await render(fig(), {
      theme: THEME,
      font: "system",
      images: resolver([zero, fake("spr", 10)]),
    });
    expect(r.diagnostics.filter((d) => d.code === "render/internal-error")).toEqual([]);
  });
});

describe("1.1 output is untouched", () => {
  test("a 1.1 spec has no boards model, no attrs, the 1.1 reduced rule and no image or board ids", async () => {
    const spec = {
      meta: { version: "1" },
      nodes: [
        { id: "a", type: "server" },
        { id: "b", type: "sql" },
      ],
      edges: [{ from: "a", to: "b" }],
      steps: [{ caption: "x", set: { a: "degraded" } }, { caption: "y" }],
    };
    const v = validate(spec);
    const scene = buildScene(v.spec!, {});
    expect(scene.assemblies).toBeUndefined();
    const model = buildModel({ scene, theme: THEME, font: "system", prefix: "pc-t" });
    expect(boardsOf(model)).toBeUndefined();
    for (const mode of ["loop", "frame", "step", "interactive"] as const) {
      const layer = animate(model, { speed: 1, mode, ...(mode === "step" ? { step: 1 } : {}) });
      expect(layer.attrs, mode).toBeUndefined();
    }
    const loop = animate(model, { speed: 1, mode: "loop" });
    expect(loop.css).toContain("animation:none!important");
    const svg = svgOf(model, loop);
    expect(svg).not.toMatch(/pc-t-(bd|bi|im)_|-board|<image /);
    // the same spec with the new keys absent from the inputs is the same model
    const again = buildModel({
      scene,
      theme: THEME,
      font: "system",
      prefix: "pc-t",
      spec: v.spec!,
      images: IMAGES(),
    });
    expect(svgOf(again, animate(again, { speed: 1, mode: "loop" }))).toBe(svg);
  });

  test("the id scheme of 1.1 ids is unchanged, and the new ids do not collide with them", () => {
    const m = buildModel({
      scene: buildScene(
        validate({ meta: { version: "1" }, nodes: [{ id: "a", type: "server" }] }).spec!,
        {},
      ),
      theme: THEME,
      font: "system",
      prefix: "pc-t",
    });
    const ids = m.ids as RenderModel["ids"] &
      ReturnType<typeof import("../src/index.js").createIds>;
    expect(ids.object("a")).toBe("pc-t-o_a");
    expect(ids.icon("x:y")).toBe("pc-t-i_x_3ay");
    expect(ids.image("sha256-a+b/c=")).toBe("pc-t-im_sha256-a_2bb_2fc_3d");
    expect(ids.board("f")).toBe("pc-t-bd_f");
    expect(ids.boardItem("f", "s.p1")).toBe("pc-t-bi_f__s.p1");
    expect(ids.credits()).toBe("pc-t-credits");
  });

  test("1.2.0 specs fold the asset hashes into the id prefix; 1.1 prefixes are unchanged (Q09)", async () => {
    const mk = (spr: number) =>
      resolverOf({
        base: realPng(600, 480, () => [200, 200, 200, 255]),
        spr: realPng(80, 60, () => [spr, 20, 30, 255]),
      });
    const prefix = async (images: ImageAssetResolver) => {
      const r = await render(fig(), { theme: THEME, font: "system", optimize: false, images });
      return /<svg [^>]*id="([^"]*)"/.exec(r.outputs[0]!.data as string)![1];
    };
    const a = await prefix(mk(10));
    const b = await prefix(mk(11));
    expect(a).not.toBe(b);
    expect(await prefix(mk(10))).toBe(a);
    // defaultIdPrefix: assets only enter the hash when present
    const o = { theme: THEME, font: "system", speed: 1, optimize: true };
    expect(defaultIdPrefix({ x: 1 }, o)).toBe(defaultIdPrefix({ x: 1 }, { ...o, assets: [] }));
    expect(defaultIdPrefix({ x: 1 }, o)).not.toBe(
      defaultIdPrefix({ x: 1 }, { ...o, assets: [["a", "h"]] }),
    );
    // a 1.1 spec renders with the prefix it always had, whether or not images are passed
    const plain = { meta: { version: "1" }, nodes: [{ id: "a", type: "server" }] };
    const p1 = await render(plain, { theme: THEME, font: "system" });
    const p2 = await render(plain, { theme: THEME, font: "system", images: mk(10) });
    expect(p1.outputs[0]!.data).toBe(p2.outputs[0]!.data);
    expect(/id="(pc-[0-9a-f]{8})"/.exec(p1.outputs[0]!.data as string)![1]).toBe(
      defaultIdPrefix(plain, { theme: THEME, font: "system", speed: 1, optimize: true }),
    );
  });

  test("deterministic: the same inputs give the same bytes", async () => {
    const run = async () =>
      (
        await render(designSpec(), {
          theme: THEME,
          font: "system",
          outputs: ["animated", "steps"],
          images: heatSinkImages(),
          optimize: false,
        })
      ).outputs.map((o) => o.data as string);
    expect(await run()).toEqual(await run());
  });
});
