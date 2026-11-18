import { describe, expect, test, vi } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import type { RenderModel, RenderOptions, VideoEncoder } from "../../src/contracts/index.js";
import { exportOutputs, rasterize } from "../../src/export/index.js";
import { validateRenderOptions } from "../../src/export/options.js";
import { buildFixture, emit, withVariant } from "../anim/fixtures/render-model.js";

vi.setConfig({ testTimeout: 120_000 });

const baseDeps = { animator: createAnimator(), optimize: (s: string) => s, rasterize, withVariant };
const run = (
  kinds: Parameters<typeof exportOutputs>[1],
  options: RenderOptions = {},
  model: RenderModel = buildFixture(),
  emitFn: typeof emit = emit,
) => exportOutputs(model, kinds, { ...baseDeps, emit: emitFn }, options);

/** GIF graphic-control delays in centiseconds, one per frame. */
function gifDelays(g: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < g.length - 7; i++) {
    if (g[i] === 0x21 && g[i + 1] === 0xf9 && g[i + 2] === 4)
      out.push(g[i + 4]! | (g[i + 5]! << 8));
  }
  return out;
}

describe("gif frame rate", () => {
  test("above 50 fps the gif is sampled at 50 fps with every delay >= 2 cs, and warns", async () => {
    const r = await run(["gif"], { video: { fps: 60, durationSec: 1 } });
    const delays = gifDelays(r.outputs[0]!.data as Uint8Array);
    expect(delays).toHaveLength(50);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(2);
    expect(delays.reduce((a, b) => a + b, 0)).toBe(100);
    expect(r.diagnostics).toContainEqual(
      expect.objectContaining({ code: "export/gif-fps-lowered", severity: "warning" }),
    );
  });

  test("mp4 keeps the requested fps next to a lowered gif", async () => {
    const seen: number[] = [];
    const encoder: VideoEncoder = {
      encode: async (frames, o) => {
        seen.push(frames.length, o.fps);
        return new Uint8Array([0]);
      },
    };
    const r = await run(["gif", "mp4"], { video: { fps: 60, durationSec: 1, encoder } });
    expect(seen).toEqual([60, 60]);
    expect(r.outputs.map((o) => o.kind)).toEqual(["gif", "mp4"]);
  });

  test("no warning at 50 fps or below", async () => {
    const r = await run(["gif"], { video: { fps: 50, durationSec: 1 } });
    expect(r.diagnostics.map((d) => d.code)).not.toContain("export/gif-fps-lowered");
  });
});

describe("video duration cap", () => {
  test("a default duration over 120 s is capped with an info diagnostic", async () => {
    const m = buildFixture();
    const timeline = m.scene.timeline.map((s) => ({ ...s, duration: 100 }));
    const long = { ...m, scene: { ...m.scene, timeline } };
    const encoder: VideoEncoder = {
      encode: async (frames) => new Uint8Array([frames.length]),
    };
    const r = await run(["mp4"], { video: { fps: 1, encoder } }, long);
    expect((r.outputs[0]!.data as Uint8Array)[0]).toBe(120);
    expect(r.diagnostics).toContainEqual(
      expect.objectContaining({ code: "export/video-capped", severity: "info" }),
    );
  });
});

describe("root size", () => {
  test("an XML declaration or comment before <svg> is handled", async () => {
    const wrapped: typeof emit = (m, a, o) => `<?xml version="1.0"?><!-- x -->${emit(m, a, o)}`;
    const r = await run(["png"], { png: { scale: 1 } }, buildFixture(), wrapped);
    expect(r.diagnostics).toEqual([]);
    expect(r.outputs).toHaveLength(1);
  });

  test("an emit without a root svg is reported, not silently rasterized", async () => {
    const r = await run(["png"], { png: { scale: 1 } }, buildFixture(), () => "<g/>");
    expect(r.outputs).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ code: "export/raster-failed", severity: "error" });
    expect(r.diagnostics[0]?.message).toContain("no root <svg>");
  });
});

describe("option diagnostics order", () => {
  test("sorted by code point, not locale", () => {
    const d = validateRenderOptions({ name: "../x", speed: 0, png: { scale: 0 } });
    expect(d.map((x) => x.path)).toEqual(["/name", "/png/scale", "/speed"]);
  });
});
