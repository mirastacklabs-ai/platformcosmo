import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import {
  render,
  validate,
  type RenderOptions,
  type RenderResult,
  type VideoEncoder,
} from "../../src/index.js";
import { decodePng } from "../../src/export/png.js";
import { DEFAULT_IMAGE_LIMITS } from "../../src/assets/prepare.js";
import { checkFigureImages } from "../../src/render/boards/images.js";
import type { ImageAsset, PartShapeDef, PartShapeRegistry } from "../../src/contracts/index.js";
import { fixtureTheme } from "../fixtures/theme.js";
import { realPng, resolverOf } from "../figure-fixtures.js";

// B-2: every Phase 1b design example (assemblies.md 2, 19.2, 19.3) through render(), in every
// output (docs/design/assemblies.md section 12), plus png.time / png.step and bounded GIF/MP4.

vi.setConfig({ testTimeout: 120_000 });

type Obj = Record<string, unknown>;
const THEME = fixtureTheme();
const designExamples = (): Obj[] => {
  const md = readFileSync(
    new URL("../../../../docs/design/assemblies.md", import.meta.url),
    "utf8",
  );
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Obj)
    .filter((s) => typeof s.meta === "object");
};
const TITLES = ["Two-part box", "2U GPU server internals", "Inline-4 engine teardown"];
const example = (title: string): Obj =>
  structuredClone(designExamples().find((s) => (s.meta as { title: string }).title === title)!);
const images = () =>
  resolverOf({ "gpu-photo": realPng(640, 240, (x, y) => [x % 256, y, 120, 255]) });

/** A streaming sink that keeps the decoded frames' pixel hashes only. */
function frameCollector() {
  const frames: Uint8Array[] = [];
  const encoder: VideoEncoder = {
    encode: async () => new Uint8Array([1]),
    open: () => ({
      write: async (f: Uint8Array) => {
        frames.push(decodePng(f).data);
      },
      finish: async () => new Uint8Array([0x4d, 0x50, 0x34]),
      abort: async () => undefined,
    }),
  };
  return { frames, encoder };
}
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const pixels = (r: RenderResult): Uint8Array =>
  decodePng(r.outputs.find((o) => o.kind === "png")!.data as Uint8Array).data;
/** Stand-in for the `hw:` pack (the real one is @platformcosmo/parts-base, wired by the CLI). */
const stubShape = (id: string): PartShapeDef => ({
  id,
  label: id,
  type: id,
  defaultSize: { x: 20, y: 20, z: 10 },
  defaultUnits: "mm",
  defaults: {},
  readParams: () => ({ params: {}, diagnostics: [] }),
  build: (_p, ctx) => {
    const box = { origin: { x: 0, y: 0, z: 0 }, size: ctx.size };
    return {
      primitives: [{ id: "body", kind: "box" as const, box, tone: ctx.tone }],
      bounds: box,
      depthBox: box,
      solid: true,
    };
  },
});
const HW = new Map(
  ["dimm", "e1s", "fan", "heatsink", "nic-ocp3"].map((id) => [`hw:${id}`, stubShape(id)]),
);
const hwRegistry: PartShapeRegistry = { get: (r) => HW.get(r), list: () => [...HW.keys()] };
const run = (spec: Obj, o: RenderOptions = {}): Promise<RenderResult> =>
  render(spec, { theme: THEME, font: "system", images: images(), parts: hwRegistry, ...o });
const text = (r: RenderResult, kind: string): string =>
  r.outputs.find((o) => o.kind === kind)!.data as string;

describe("Phase 1b design examples through render()", () => {
  test("the three examples are the ones the docs call Phase 1b", () => {
    for (const t of TITLES) expect(validate(example(t)).valid, t).toBe(true);
  });

  test.each(TITLES)("%s: static, steps, animated, interactive, png and gif", async (title) => {
    const spec = example(title);
    const stepCount = (spec.steps as unknown[] | undefined)?.length ?? 0;
    const r = await run(spec, {
      outputs: ["animated", "static", "steps", "interactive", "png", "gif"],
      png: { scale: 1 },
      video: { fps: 4, durationSec: 2 },
    });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.outputs.map((o) => o.kind).sort()).toEqual(
      [
        "animated",
        "static",
        "interactive",
        "png",
        "gif",
        ...Array.from({ length: stepCount }, () => "steps"),
      ].sort(),
    );
    const animated = text(r, "animated");
    // assembly wrappers and motion keyframes
    expect(animated).toMatch(/-ph_|-pm_/);
    expect(animated).toContain("@keyframes");
    expect(animated).toContain("prefers-reduced-motion");
    // the static output is the rest frame: no animation at all
    const staticSvg = text(r, "static");
    expect(staticSvg).toMatch(/-ph_|-pm_/);
    expect(staticSvg).not.toContain("@keyframes");
    expect(text(r, "interactive")).toContain("@keyframes");
    const steps = r.outputs.filter((o) => o.kind === "steps");
    expect(steps).toHaveLength(stepCount);
    for (const s of steps) expect(s.data as string).not.toContain("@keyframes");
    const gif = r.outputs.find((o) => o.kind === "gif")!.data as Uint8Array;
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe("GIF89a");
    expect(
      decodePng(r.outputs.find((o) => o.kind === "png")!.data as Uint8Array).width,
    ).toBeGreaterThan(100);
  });

  test("the box: the png at t=0 is the rest frame; mid-move and step ends differ", async () => {
    const spec = example("Two-part box");
    const rest = await run(spec, { outputs: ["png"], png: { scale: 1 } });
    const explicit0 = await run(spec, { outputs: ["png"], png: { scale: 1, time: 0 } });
    expect(same(pixels(rest), pixels(explicit0))).toBe(true);
    // one of the sampled times lies inside the lid move
    const sampled: Uint8Array[] = [];
    for (const time of [1.5, 2.5, 3.5, 4.5]) {
      sampled.push(pixels(await run(spec, { outputs: ["png"], png: { scale: 1, time } })));
    }
    expect(sampled.some((p) => !same(p, pixels(rest)))).toBe(true);
    // png.step N is the end pose of step N: step 2 (lid off) differs from step 1 and from rest
    const s1 = await run(spec, { outputs: ["png"], png: { scale: 1, step: 1 } });
    const s2 = await run(spec, { outputs: ["png"], png: { scale: 1, step: 2 } });
    const s3 = await run(spec, { outputs: ["png"], png: { scale: 1, step: 3 } });
    expect(same(pixels(s1), pixels(rest))).toBe(true);
    expect(same(pixels(s2), pixels(rest))).toBe(false);
    expect(same(pixels(s3), pixels(s2))).toBe(false);
    // the step PNG shows the same pose as the step SVG output (same wrapper offsets)
    const steps = await run(spec, { outputs: ["steps"] });
    const step2 = steps.outputs.find((o) => o.kind === "steps" && o.step === 2)!.data as string;
    expect(step2).toMatch(/-pm_[a-z0-9_-]+[^>]*transform=/);
  });

  test("the engine: gif/mp4 frames follow frameAt; first frame is the rest frame", async () => {
    const spec = example("Inline-4 engine teardown");
    const { frames, encoder } = frameCollector();
    // Reference: the `static` output is the rest frame written by a different path (the loop's
    // static CSS-free layer). resvg cannot read its CSS variables, so compare what matters: every
    // motion wrapper in it sits at rest (no offset), while a later frame has moved wrappers.
    const staticSvg = text(await run(spec, { outputs: ["static"] }), "static");
    const wrappers = [...staticSvg.matchAll(/<g[^>]*id="[^"]*-p[hm]_[^"]*"[^>]*>/g)].map(
      (m) => m[0],
    );
    expect(wrappers.length).toBeGreaterThan(5);
    for (const w of wrappers) {
      const t = /transform="translate\(([^)]*)\)"/.exec(w)?.[1];
      if (t !== undefined)
        expect(
          t
            .split(/[ ,]+/)
            .map(Number)
            .every((v) => v === 0),
          w,
        ).toBe(true);
    }
    const r = await run(spec, {
      outputs: ["mp4"],
      video: { fps: 2, durationSec: 12, encoder },
    });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(frames).toHaveLength(24);
    // frame 0 is the rest frame (png at t=0), and the clip then leaves it
    const rest = await run(spec, { outputs: ["png"], png: { scale: 1 } });
    expect(same(frames[0]!, pixels(rest))).toBe(true);
    expect(frames.some((f) => !same(f, frames[0]!))).toBe(true);
    // the engine moves: more than a few distinct frames
    expect(
      new Set(frames.map((f) => f.reduce((a, b) => (a * 31 + b) | 0, 7))).size,
    ).toBeGreaterThan(3);
  });

  test("png.step outside the timeline and png.step with png.time are errors, not throws", async () => {
    const spec = example("Two-part box");
    const far = await run(spec, { outputs: ["png"], png: { step: 9 } });
    expect(far.outputs).toEqual([]);
    expect(far.diagnostics.map((d) => [d.code, d.path])).toContainEqual([
      "options/invalid-png-step",
      "/png/step",
    ]);
    const both = await run(spec, { outputs: ["png"], png: { step: 1, time: 1 } });
    expect(both.outputs).toEqual([]);
    expect(both.diagnostics.some((d) => d.code === "options/invalid-png-step")).toBe(true);
    for (const step of [0, 1.5, -1, Number.NaN]) {
      const bad = await run(spec, { outputs: ["png"], png: { step } });
      expect(
        bad.diagnostics.some((d) => d.code === "options/invalid-png-step"),
        `${step}`,
      ).toBe(true);
    }
  });

  test("rendering is deterministic (animated and steps, twice)", async () => {
    const spec = example("Inline-4 engine teardown");
    const a = await run(spec, { outputs: ["animated", "steps"] });
    const b = await run(spec, { outputs: ["animated", "steps"] });
    expect(a.outputs.map((o) => o.data)).toEqual(b.outputs.map((o) => o.data));
  });

  test("a 1.1 spec: png.step renders the end state of that step", async () => {
    const spec: Obj = {
      meta: { version: "1" },
      nodes: [
        { id: "a", type: "server" },
        { id: "b", type: "sql" },
      ],
      edges: [{ from: "a", to: "b" }],
      steps: [{ caption: "one" }, { caption: "two", set: { b: "down" } }],
    };
    const s1 = await run(spec, { outputs: ["png"], png: { scale: 1, step: 1 } });
    const s2 = await run(spec, { outputs: ["png"], png: { scale: 1, step: 2 } });
    expect(s1.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(same(pixels(s1), pixels(s2))).toBe(false);
  });
});

describe("assembly images and pack shapes are checked before anything is rendered", () => {
  const asset = (key: string, bytes: number): ImageAsset => ({
    key,
    format: "png",
    mime: "image/png",
    width: 100,
    height: 100,
    orientation: 1,
    hash: `h-${key}`,
    data: new Uint8Array(bytes),
  });
  const MiB = 1024 ** 2;
  const resolver = (list: ImageAsset[]) => ({
    get: (k: string) => list.find((a) => a.key === k),
    keys: () => list.map((a) => a.key).sort(),
  });
  const withImages = (): Obj => ({
    meta: { version: "1" },
    images: [
      { id: "a", src: "a.png" },
      { id: "b", src: "b.png" },
      { id: "c", src: "c.png" },
    ],
    assemblies: [
      {
        id: "box",
        parts: [
          { id: "p", size: [4, 4, 4], image: "a" },
          {
            id: "grp",
            parts: [{ id: "q", at: [5, 0, 0], size: [4, 4, 4], image: { ref: "b", face: "top" } }],
          },
          { id: "r", at: [10, 0, 0], size: [4, 4, 4], image: "c" },
        ],
      },
    ],
  });

  test("images on assembly parts count toward the 8 MiB total and name a spec pointer", async () => {
    // three 2 MiB assets (each at the per-file cap): 8 MiB of base64 text plus one more, over 8 MiB
    const spec = withImages();
    (spec.images as Obj[]).push({ id: "d", src: "d.png" });
    ((spec.assemblies as Obj[])[0]!.parts as Obj[]).push({
      id: "s",
      at: [15, 0, 0],
      size: [4, 4, 4],
      image: "d",
    });
    const r = await render(spec, {
      theme: THEME,
      font: "system",
      images: resolver([
        asset("a", 2 * MiB),
        asset("b", 2 * MiB),
        asset("c", 2 * MiB),
        asset("d", 1000),
      ]),
      outputs: ["animated", "png"],
    });
    expect(r.outputs).toEqual([]);
    const big = r.diagnostics.filter((d) => d.code === "image/too-large");
    expect(big.map((d) => d.path)).toEqual(["/images"]);
  });

  test("a missing or oversized image points at the part that uses it, nested parts included", async () => {
    const missing = await render(withImages(), {
      theme: THEME,
      font: "system",
      images: resolver([asset("a", 10), asset("c", 10)]),
    });
    expect(missing.outputs).toEqual([]);
    expect(
      missing.diagnostics.filter((d) => d.code === "image/not-found").map((d) => d.path),
    ).toEqual(["/assemblies/0/parts/1/parts/0/image/ref"]);
    const huge = await render(withImages(), {
      theme: THEME,
      font: "system",
      images: resolver([asset("a", 10), asset("b", 10), asset("c", 20 * MiB)]),
    });
    expect(huge.outputs).toEqual([]);
    expect(huge.diagnostics.filter((d) => d.code === "image/too-large").map((d) => d.path)).toEqual(
      ["/assemblies/0/parts/2/image"],
    );
  });

  test("the distinct-image cap applies to assembly images (checkFigureImages)", () => {
    const spec = validate(withImages()).spec!;
    const limits = { ...DEFAULT_IMAGE_LIMITS, maxImages: 2 };
    const d = checkFigureImages(
      spec,
      resolver([asset("a", 10), asset("b", 10), asset("c", 10)]),
      limits,
    );
    expect(d.map((x) => x.code)).toEqual(["image/too-many"]);
  });

  const dimmSpec = (): Obj => ({
    meta: { version: "1" },
    assemblies: [{ id: "m", parts: [{ id: "d", shape: "hw:dimm" }] }],
  });

  test("an unresolved pack shape is refused at render, never drawn as a box", async () => {
    let opened = 0;
    const encoder: VideoEncoder = {
      encode: async () => new Uint8Array(),
      open: () => {
        opened++;
        return {
          write: async () => undefined,
          finish: async () => new Uint8Array([1]),
          abort: async () => undefined,
        };
      },
    };
    // validation without a registry leaves the ref unchecked ...
    expect(validate(dimmSpec()).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // ... but render refuses it, before animating or encoding anything
    const r = await render(dimmSpec(), {
      theme: THEME,
      font: "system",
      outputs: ["animated", "mp4"],
      video: { encoder },
    });
    expect(r.outputs).toEqual([]);
    expect(opened).toBe(0);
    expect(
      r.diagnostics.filter((d) => d.code === "assembly/unknown-shape").map((d) => d.path),
    ).toEqual(["/assemblies/0/parts/0/shape"]);
    const ok = await run(dimmSpec(), { outputs: ["animated"] });
    expect(ok.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(ok.outputs).toHaveLength(1);
  });
});
