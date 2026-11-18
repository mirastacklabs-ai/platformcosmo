import { describe, expect, test } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import { frameViewBox, windows, zoomFor } from "../../src/anim/timeline.js";
import type { RenderModel, SceneStep } from "../../src/contracts/index.js";
import { buildFixture } from "./fixtures/render-model.js";

const animator = createAnimator();
const IDENTITY = "translate(0px,0px) scale(1)";

function withTimeline(timeline: SceneStep[]): RenderModel {
  const m = buildFixture();
  return { ...m, scene: { ...m.scene, timeline } };
}

const step = (index: number, duration: number, focus?: string): SceneStep => ({
  index,
  duration,
  states: {},
  flows: [],
  metrics: {},
  ...(focus ? { focus } : {}),
});

/** Camera keyframe stops (`[percent, transform]`) of the loop. */
function cameraStops(m: RenderModel): [string, string][] {
  const css = animator.animate(m, { speed: 1, mode: "loop" }).css.replace(/\n/g, "");
  const name = /#pc-test-camera\{transform-origin:0 0;animation:(\S+) /.exec(css)?.[1];
  const body = new RegExp(`@keyframes ${name}\\{([^@]*?\\})\\}(?=@|#|\\.|$)`).exec(css)?.[1] ?? "";
  return [...body.matchAll(/([\d.]+)%\{transform:([^}]*)\}/g)].map((x) => [x[1]!, x[2]!]);
}

describe("focus only on the last step", () => {
  const m = withTimeline([step(1, 3), step(2, 3), step(3, 2, "b")]);

  test("overview until the last step, zoom from its start to its end transition, then out", () => {
    const stops = cameraStops(m);
    // durations 3,3,2 -> transitions .75,.75,.5 s; step 3 starts at 6 of 8 s
    expect(stops.map((s) => s[0])).toEqual([
      "0",
      "9.375",
      "28.125",
      "37.5",
      "65.625",
      "75",
      "93.75",
      "100",
    ]);
    expect(stops.slice(0, 5).every((s) => s[1] === IDENTITY)).toBe(true);
    expect(stops[5]![1]).not.toBe(IDENTITY); // zoomed exactly at step 3's start (75 %)
    expect(stops[6]![1]).toBe(stops[5]![1]);
    expect(stops[7]![1]).toBe(IDENTITY); // loop ends on the overview
  });

  test("frame mode: mid end-transition is between the zoom and the overview", () => {
    const zs = m.scene.timeline.map((s) => zoomFor(m, s));
    const w = windows(m.scene.timeline, 1);
    expect(frameViewBox(m, w, zs, 0)).toBeUndefined();
    expect(frameViewBox(m, w, zs, 6.5)).toEqual(zs[2]!.viewBox);
    const mid = frameViewBox(m, w, zs, 7.75)!;
    expect(mid.width).toBeGreaterThan(zs[2]!.viewBox.width);
    expect(mid.width).toBeLessThan(560);
    expect(frameViewBox(m, w, zs, 7.999)).toBeUndefined(); // back on the overview
  });

  test("interactive Step targets are the starts (step 1 has no focus)", () => {
    const s = animator.animate(m, { speed: 1, mode: "interactive" }).script;
    expect(s).toContain("S=[0,3,6],G=[0,3,6]");
  });
});

describe("a single focused step", () => {
  const m = withTimeline([step(1, 4, "b")]);

  test("overview, ease in, hold, ease out", () => {
    const stops = cameraStops(m);
    // transition min(.8, .25*4 = 1) = .8 s of 4 s
    expect(stops.map((s) => s[0])).toEqual(["0", "20", "80", "100"]);
    expect(stops[0]![1]).toBe(IDENTITY);
    expect(stops[1]![1]).not.toBe(IDENTITY);
    expect(stops[2]![1]).toBe(stops[1]![1]);
    expect(stops[3]![1]).toBe(IDENTITY);
  });

  test("frame mode eases in at the start and out at the end", () => {
    const zs = m.scene.timeline.map((s) => zoomFor(m, s));
    const w = windows(m.scene.timeline, 1);
    const full = zs[0]!.viewBox;
    expect(frameViewBox(m, w, zs, 0)).toBeUndefined();
    expect(frameViewBox(m, w, zs, 0.4)!.width).toBeGreaterThan(full.width);
    expect(frameViewBox(m, w, zs, 2)).toEqual(full);
    const out = frameViewBox(m, w, zs, 3.6)!;
    expect(out.width).toBeGreaterThan(full.width);
    expect(out.width).toBeLessThan(560);
  });

  test("interactive Step pauses on the focus after the opening ease", () => {
    const s = animator.animate(m, { speed: 1, mode: "interactive" }).script;
    expect(s).toContain("S=[0],G=[0.8]");
  });
});
