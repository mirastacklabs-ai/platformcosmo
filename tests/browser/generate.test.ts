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
import { render } from "../../packages/core/src/index.js";
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

const design = (doc: string, title: string): Record<string, unknown> => {
  const md = readFileSync(new URL(`../../docs/design/${doc}`, import.meta.url), "utf8");
  const found = [...md.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => JSON.parse(m[1] as string) as Record<string, unknown>)
    .find((x) => (x.meta as { title?: string } | undefined)?.title === title);
  if (!found) throw new Error(`design example not found: ${title}`);
  return found;
};

async function generateAssemblies(): Promise<Record<string, unknown>> {
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
  };
  const info: Record<string, { animate: [number, number]; mids: number[] }> = {};
  for (const ex of ASSEMBLY_EXAMPLES) {
    const spec = design(ex.doc, ex.title);
    const name = ex.file.replace(/\.svg$/, "");
    const r = await render(spec, { ...base, outputs: ["animated"], name });
    const svg = r.outputs.find((o) => o.kind === "animated")?.data;
    if (typeof svg !== "string") throw new Error(`${ex.title}: ${JSON.stringify(r.diagnostics)}`);
    writeFileSync(join(out, ex.file), svg);
    // frames of the exporter at candidate times: the first one that differs from the rest frame
    const png = async (time: number): Promise<string> => {
      const f = await render(spec, { ...base, outputs: ["png"], png: { scale: 0.25, time } });
      const d = f.outputs[0]?.data;
      if (!d || typeof d === "string") throw new Error("no frame");
      return Buffer.from(decodePng(d).data).toString("base64");
    };
    const rest = await png(0);
    let moving = -1;
    for (let t = 0.25; t < 40 && moving < 0; t += 0.25) if ((await png(t)) !== rest) moving = t;
    if (moving < 0) throw new Error(`${ex.title}: no motion within 40 s`);
    let t0 = 0;
    const mids = (r.scene?.timeline ?? []).map((s) => {
      const mid = t0 + s.duration / 2;
      t0 += s.duration;
      return Math.round(mid * 100) / 100;
    });
    info[ex.file] = { animate: [0.05, Math.round(moving * 100) / 100], mids };
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
        assemblies: await generateAssemblies(),
        stepButton: "#pc-x_btn_step",
        playButton: "#pc-x_btn_play",
        icaption1: "#pc-x-cap-1",
        icaption2: "#pc-x-cap-2",
      },
      null,
      2,
    ),
  );
});
