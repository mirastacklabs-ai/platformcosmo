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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
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
