/**
 * Generates the browser-check input into tests/browser/out/fixtures/ (git-ignored): the animated
 * and interactive SVGs, the expected first frame (PNG via the exporter's raster path) and
 * fixture.json (ids the fixture-specific checks use). Run through `tests/browser/run.sh`; it is not
 * part of the normal test run.
 *
 * Fixtures come from the fixture RenderModel (packages/core/test/anim/fixtures) until Track A's
 * render pipeline lands. To check real output instead, point run.sh at a directory of SVGs
 * (see tests/browser/README.md).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { buildModel, buildScene, render } from "../../packages/core/src/index.js";
import type { AssemblyRenderModel, PlatformCosmoSpec } from "../../packages/core/src/index.js";
import { parseCopyKey } from "../../packages/core/src/depth/copies.js";
import {
  clippedCopySpec,
  copySwapSpec,
  crossingClipSpec,
} from "../../packages/core/test/copies-fixtures.js";
import { registry as hwRegistry } from "../../packages/parts-base/src/index.js";
import { decodePng } from "../../packages/core/src/export/png.js";
import { fixtureTheme } from "../../packages/core/test/fixtures/theme.js";
import { realPng, resolverOf } from "../../packages/core/test/figure-fixtures.js";
import { createAnimator } from "../../packages/core/src/anim/index.js";
import { exportOutputs, rasterize } from "../../packages/core/src/export/index.js";
import {
  buildFixture,
  emit,
  withVariant,
} from "../../packages/core/test/anim/fixtures/render-model.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "out", "fixtures");
const animator = createAnimator();

function buildSvg(mode: "loop" | "interactive", prefix: string): string {
  const model = buildFixture({ prefix });
  return emit(model, animator.animate(model, { speed: 1, mode }), { font: "system" });
}

/**
 * B-2: the Phase 1b design examples (engine 19.3, GPU server 19.2, box 2) and the heat-sink
 * figure (ingestion 8) rendered through the real pipeline, with the data the assembly checks
 * need: two times whose frames differ (motion plays) and one mid-time per step (under reduced
 * motion each step shows its end pose for the whole step, so frames inside one step are equal and
 * different steps can differ).
 */
const ASSEMBLY_EXAMPLES = [
  { file: "asm-engine.svg", doc: "assemblies.md", title: "Inline-4 engine teardown" },
  { file: "asm-gpu.svg", doc: "assemblies.md", title: "2U GPU server internals" },
  { file: "asm-box.svg", doc: "assemblies.md", title: "Two-part box" },
  {
    file: "fig-heatsink.svg",
    doc: "document-ingestion.md",
    title: "Heat-sink installation figure",
  },
] as const;

/**
 * A1-2b: crafted specs that need depth copies (packages/core/test/copies-fixtures.ts). Their ids
 * use a fixed prefix so the check can find each copy's visibility wrapper.
 */
const COPY_EXAMPLES = [
  { file: "asm-copies.svg", prefix: "pc-cp", spec: () => copySwapSpec({ label: true }) },
  { file: "asm-copies-clip.svg", prefix: "pc-cc", spec: clippedCopySpec },
  // A1-2c: clipped only while it crosses, an unclipped copy for the slide (§9.5); `exact`: the
  // two copies must draw the same pixels at each swap (the flush fixture is the named exception,
  // `assembly/clip-swap-rim`, so it only gets the A1-2b swap check)
  { file: "asm-copies-window.svg", prefix: "pc-cw", spec: () => crossingClipSpec(), exact: true },
  {
    file: "asm-copies-window-x.svg",
    prefix: "pc-cx",
    spec: () => crossingClipSpec({ exit: "x" }),
    exact: true,
  },
  {
    file: "asm-copies-window-flush.svg",
    prefix: "pc-cf",
    spec: () => crossingClipSpec({ flush: true }),
  },
] as const;

/**
 * Copy swaps of a model: epoch starts where an item visible on both sides changes its copy, with
 * the `partVisible` ids of that item's copies (exactly one of them must be visible at any time).
 */
function copySwaps(spec: PlatformCosmoSpec, prefix: string): { t: number; ids: string[] }[] {
  const scene = buildScene(spec, {});
  const model = buildModel({ scene, theme: fixtureTheme(), font: "system", prefix, spec });
  const am = model.assembly as AssemblyRenderModel;
  const copies = new Map(am.items.map((i) => [i.item, i.copies]));
  const used = (e: number): Map<string, number> =>
    new Map(am.epochs[e]!.order.map((c) => [parseCopyKey(c).item, parseCopyKey(c).copy]));
  const out: { t: number; ids: string[] }[] = [];
  for (let k = 1; k < am.epochs.length; k++) {
    const [a, b] = [used(k - 1), used(k)];
    const items = [...b].filter(([i, c]) => a.has(i) && a.get(i) !== c).map(([i]) => i);
    if (items.length === 0) continue;
    const ids = items.flatMap((i) =>
      Array.from({ length: copies.get(i) ?? 1 }, (_, c) => am.ids.partVisible(i, c)),
    );
    out.push({ t: Math.round(am.epochs[k]!.t0 * 1e4) / 1e4, ids });
  }
  return out;
}

const design = (doc: string, title: string): Record<string, unknown> => {
  const md = readFileSync(new URL(`../../docs/design/${doc}`, import.meta.url), "utf8");
  const found = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Record<string, unknown>)
    .find((x) => (x.meta as { title?: string } | undefined)?.title === title);
  if (!found) throw new Error(`design example not found: ${title}`);
  return found;
};

async function generateAssemblies(): Promise<{
  assemblies: Record<string, unknown>;
  copies: Record<string, unknown>;
}> {
  const images = resolverOf({
    "gpu-photo": realPng(640, 240, (x, y) => [x % 256, y, 120, 255]),
    "hs-base": realPng(600, 480, (_x, y) => [230 - (y >> 3), 235, 240, 255]),
    "hs-sprite": realPng(80, 60, (x, y) => [40 + x, 90, 160 - y, 255]),
  });
  const base = {
    theme: fixtureTheme(),
    darkTheme: fixtureTheme("dark", true),
    font: "system" as const,
    images,
    // the real `hw:` pack: the GPU example draws DIMMs, heat sinks and fans from it
    parts: hwRegistry,
  };
  const info: Record<string, { animate: [number, number]; mids: number[] }> = {};
  const copies: Record<string, { swaps: { t: number; ids: string[] }[]; exact?: true }> = {};
  const all = [
    ...ASSEMBLY_EXAMPLES.map((ex) => ({
      file: ex.file,
      spec: design(ex.doc, ex.title),
      idPrefix: undefined,
    })),
    ...COPY_EXAMPLES.map((ex) => {
      const spec = ex.spec();
      copies[ex.file] = {
        swaps: copySwaps(spec, ex.prefix),
        ...("exact" in ex && ex.exact ? { exact: true as const } : {}),
      };
      if (copies[ex.file]!.swaps.length === 0) throw new Error(`${ex.file}: no copy swap`);
      return {
        file: ex.file,
        spec: spec as unknown as Record<string, unknown>,
        idPrefix: ex.prefix,
      };
    }),
  ];
  for (const ex of all) {
    const spec = ex.spec;
    const title = (spec.meta as { title: string }).title;
    const name = ex.file.replace(/\.svg$/, "");
    const opts = { ...base, name, ...(ex.idPrefix === undefined ? {} : { idPrefix: ex.idPrefix }) };
    const r = await render(spec, { ...opts, outputs: ["animated"] });
    const svg = r.outputs.find((o) => o.kind === "animated")?.data;
    if (typeof svg !== "string") throw new Error(`${title}: ${JSON.stringify(r.diagnostics)}`);
    writeFileSync(join(out, ex.file), svg);
    // frames of the exporter at candidate times: the first one that differs from the rest frame
    const png = async (time: number): Promise<Uint8Array> => {
      const f = await render(spec, { ...opts, outputs: ["png"], png: { scale: 0.25, time } });
      const d = f.outputs[0]?.data;
      if (!d || typeof d === "string") throw new Error("no frame");
      return decodePng(d).data;
    };
    // the sampled time whose frame differs most from the rest frame (a clear difference, not a
    // hairline: engines round a barely started move differently)
    const share = (a: Uint8Array, b: Uint8Array): number => {
      let n = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
      }
      return n / (a.length / 4);
    };
    const rest = await png(0);
    let moving = -1;
    let best = 0.01;
    for (let t = 0.5; t < 40; t += 0.5) {
      const d = share(rest, await png(t));
      if (d > best) {
        best = d;
        moving = t;
      }
    }
    if (moving < 0) throw new Error(`${title}: no motion within 40 s`);
    let t0 = 0;
    const mids = (r.scene?.timeline ?? []).map((s) => {
      const mid = t0 + s.duration / 2;
      t0 += s.duration;
      return Math.round(mid * 100) / 100;
    });
    info[ex.file] = { animate: [0.05, Math.round(moving * 100) / 100], mids };
  }
  return { assemblies: info, copies };
}

/**
 * R-2: one storyboard per transition (wipe, fade) rendered through the real pipeline. The two
 * model images have a transparent window, so a wipe that left the old image under the sweep
 * would show in the pixels. Times: rest (the finished model) and the middle of the second
 * frame's change (frame 2 starts at 0.5 s, its change lasts 0.5 s), where fade and wipe are
 * half way; reduced motion shows each step's end state.
 */
async function generateStoryboards(): Promise<
  Record<string, { animate: [number, number]; mids: number[] }>
> {
  const images = resolverOf({
    m1: realPng(320, 240, (x, y) =>
      x > 100 && x < 220 && y > 60 && y < 180 ? [0, 0, 0, 0] : [200, 80, 80, 255],
    ),
    m2: realPng(320, 240, (x, y) =>
      x > 100 && x < 220 && y > 60 && y < 180 ? [0, 0, 0, 0] : [60, 90, 200, 255],
    ),
  });
  const info: Record<string, { animate: [number, number]; mids: number[] }> = {};
  for (const transition of ["wipe", "fade"] as const) {
    const spec = {
      meta: { version: "1", title: `Storyboard ${transition}` },
      images: [
        { id: "m1", src: "m1.png" },
        { id: "m2", src: "m2.png" },
      ],
      storyboards: [
        { id: "book", transition, frames: [{ model: "m1" }, { model: "m2", caption: "Step 2" }] },
      ],
      steps: [
        { caption: "Build", duration: 4, assembly: [{ build: "book", to: 2 }] },
        { caption: "Hold", duration: 4 },
      ],
    };
    const file = `sb-${transition}.svg`;
    const r = await render(spec, {
      theme: fixtureTheme(),
      darkTheme: fixtureTheme("dark", true),
      font: "system",
      images,
      outputs: ["animated"],
      name: `sb-${transition}`,
    });
    const svg = r.outputs.find((o) => o.kind === "animated")?.data;
    if (typeof svg !== "string") throw new Error(`${file}: ${JSON.stringify(r.diagnostics)}`);
    writeFileSync(join(out, file), svg);
    info[file] = { animate: [0, 0.75], mids: [2, 6] };
  }
  return info;
}

test("generate browser fixtures", async () => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "loop.svg"), buildSvg("loop", "pc-test"));
  writeFileSync(join(out, "interactive.svg"), buildSvg("interactive", "pc-x"));

  // Expected first frame: the exporter's png at t=0, scale 1 (same size as the page element).
  const png = await exportOutputs(
    buildFixture({ prefix: "pc-test" }),
    ["png"],
    { animator, emit, optimize: (s) => s, rasterize, withVariant },
    { png: { scale: 1, time: 0 } },
  );
  const frame = png.outputs[0];
  if (!frame || typeof frame.data === "string") throw new Error("no expected frame");
  writeFileSync(join(out, "loop.expected.png"), frame.data);

  writeFileSync(
    join(out, "fixture.json"),
    JSON.stringify(
      {
        loop: "loop.svg",
        interactive: "interactive.svg",
        expected: "loop.expected.png",
        objectB: "#pc-test-o-b",
        particles: "#pc-test_particles",
        caption1: "#pc-test-cap-1",
        bg: ".pc-test-bg",
        light: "rgb(255, 255, 255)",
        dark: "rgb(15, 23, 42)",
        ...(await generateAssemblies().then(async (a) => ({
          ...a,
          assemblies: { ...a.assemblies, ...(await generateStoryboards()) },
        }))),
        stepButton: "#pc-x_btn_step",
        playButton: "#pc-x_btn_play",
        icaption1: "#pc-x-cap-1",
        icaption2: "#pc-x-cap-2",
      },
      null,
      2,
    ),
  );
}, 300_000);
