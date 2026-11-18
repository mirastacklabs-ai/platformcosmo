import { describe, expect, test } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import type { RenderModel, SvgElement } from "../../src/contracts/index.js";
import { exportOutputs, rasterize } from "../../src/export/index.js";
import { buildFixture, emit, withVariant } from "../anim/fixtures/render-model.js";

const box: SvgElement = { tag: "g", attrs: { id: "caption-box" }, children: [] };

function model(): RenderModel {
  const m = buildFixture();
  return { ...m, layers: { ...m.layers, overlay: [box] } };
}

// withVariant rebuilds layers in the fixture; keep the overlay across it.
const wv = (m: RenderModel, v: string): RenderModel => {
  const next = withVariant(m, v);
  return { ...next, layers: { ...next.layers, overlay: m.layers.overlay } };
};

const deps = {
  animator: createAnimator(),
  emit,
  optimize: (s: string) => s,
  rasterize,
  withVariant: wv,
};

describe("overlay under zoom", () => {
  test("zoomed step outputs wrap the overlay in the inverse zoom, full view does not", async () => {
    const { outputs } = await exportOutputs(model(), ["steps"], deps, {});
    const one = outputs[0]!.data as string;
    const two = outputs[1]!.data as string;
    const m =
      /<g transform="translate\(([\d.-]+) ([\d.-]+)\) scale\(([\d.]+)\)"><g id="caption-box"/.exec(
        one,
      );
    expect(m).not.toBeNull();
    // inverse of a zoom: scale below 1, offset is the zoomed view's origin minus origin/scale
    expect(Number(m![3])).toBeLessThan(1);
    expect(two).not.toContain('<g transform="translate(');
    expect(two).toContain('<g id="caption-box"');
  });

  test("the caption lands at the same relative spot of the zoomed view", async () => {
    const { outputs } = await exportOutputs(model(), ["steps"], deps, {});
    const one = outputs[0]!.data as string;
    const vb = /viewBox="([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+)"/.exec(one)!.slice(1).map(Number);
    const t = /<g transform="translate\(([\d.-]+) ([\d.-]+)\) scale\(([\d.]+)\)"/
      .exec(one)!
      .slice(1)
      .map(Number);
    // full-view origin (0,0) maps to the zoomed view's origin
    expect(t[0]).toBeCloseTo(vb[0]!, 1);
    expect(t[1]).toBeCloseTo(vb[1]!, 1);
    expect(t[2]).toBeCloseTo(vb[2]! / 560, 2);
  });

  test("static output (frame at t=0) is the full overview: no zoom, no wrapper (D27)", async () => {
    const { outputs } = await exportOutputs(model(), ["static"], deps, {});
    const svg = outputs[0]!.data as string;
    expect(svg).not.toContain('<g transform="translate(');
    expect(svg).toContain('viewBox="0 0 560 320"');
  });
});
