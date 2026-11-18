import { describe, expect, test } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import { frameViewBox, metricTexts, windows, zoomFor } from "../../src/anim/timeline.js";
import type { AnimateOptions, SceneStep, SvgElement } from "../../src/contracts/index.js";
import { buildFixture, emit } from "./fixtures/render-model.js";

const animator = createAnimator();
const run = (o: Partial<AnimateOptions> & Pick<AnimateOptions, "mode">) =>
  animator.animate(buildFixture(), { speed: 1, ...o });

function findAll(node: unknown, tag: string, out: SvgElement[] = []): SvgElement[] {
  if (typeof node !== "object" || node === null) return out;
  if (Array.isArray(node)) {
    for (const c of node) findAll(c, tag, out);
    return out;
  }
  const n = node as SvgElement;
  if (n.tag === tag) out.push(n);
  for (const c of n.children ?? []) findAll(c, tag, out);
  return out;
}

/** Fixture with extra scene changes (LED object degraded in step 1, a slot object). */
function variant() {
  const m = buildFixture();
  const objects = [...m.scene.objects, { ...m.scene.objects[0]!, id: "rack/u1", parts: [] }];
  const timeline = m.scene.timeline.map((s, i): SceneStep =>
    i === 0
      ? { ...s, states: { a: "degraded" as const, "rack/u1": "down" as const } }
      : { ...s, states: { ...s.states, a: "healthy" as const } },
  );
  return { ...m, scene: { ...m.scene, objects, timeline } };
}

describe("camera keyframes", () => {
  const css = run({ mode: "loop" }).css.replace(/\n/g, "");
  const block = /@keyframes \S+\{(0%\{transform:[^@]*?100%\{[^}]*\})\}/.exec(css)?.[1] ?? "";
  const stops = [...block.matchAll(/([\d.]+)%\{transform:([^}]*)\}/g)].map((m) => [m[1], m[2]]);

  test("0% is the overview, eases into step 1's focus, back to the overview at 100%", () => {
    const identity = "translate(0px,0px) scale(1)";
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
    expect(stops[0]![1]).toBe(identity);
    expect(stops[1]![1]).not.toBe(identity);
    expect(stops[2]![1]).toBe(stops[1]![1]); // holds step 1's focus until its end transition
    expect(stops.slice(3).every((s) => s[1] === identity)).toBe(true);
  });

  test("frame mode eases along the same curve", () => {
    const m = buildFixture();
    const zs = m.scene.timeline.map((s) => zoomFor(m, s));
    const w = windows(m.scene.timeline, 1);
    expect(frameViewBox(m, w, zs, 0)).toBeUndefined(); // overview at rest
    expect(frameViewBox(m, w, zs, 2)).toEqual(zs[0]!.viewBox);
    const into = frameViewBox(m, w, zs, 0.4)!; // easing into step 1's focus
    expect(into.width).toBeLessThan(560);
    expect(into.width).toBeGreaterThan(zs[0]!.viewBox.width);
    const mid = frameViewBox(m, w, zs, 2.6)!;
    expect(mid.width).toBeGreaterThan(zs[0]!.viewBox.width);
    expect(mid.width).toBeLessThan(560);
    expect(frameViewBox(m, w, zs, 3.5)).toBeUndefined();
  });
});

describe("states, LEDs, reduced motion, slots", () => {
  test("LED rules in loop and step modes", () => {
    const loop = animator.animate(variant(), { speed: 1, mode: "loop" }).css;
    expect(loop).toContain("#pc-test-o-a .pc-test-led{animation:");
    expect(loop).toContain("fill:var(--pc-dc-led-warn)");
    const step = animator.animate(variant(), { speed: 1, mode: "step", step: 1 }).css;
    expect(step).toContain("#pc-test-o-a .pc-test-led{fill:var(--pc-dc-led-warn)}");
  });

  test("reduced motion applies step 1's static rules and camera view", () => {
    const css = animator.animate(variant(), { speed: 1, mode: "loop" }).css;
    const media = css.slice(css.indexOf("@media (prefers-reduced-motion"));
    expect(media).toContain("#pc-test-o-a{opacity:var(--pc-states-degraded-opacity)}");
    expect(media).toContain("#pc-test-o-a .pc-test-led{fill:var(--pc-dc-led-warn)}");
    // D27: reduced motion rests on the overview, not on step 1's zoom
    expect(media).toContain("#pc-test-camera{transform:none}");
    expect(media).not.toContain("visibility:visible");
  });

  test("reduced-motion media: loop and step yes, frame no", () => {
    for (const mode of ["loop", "step"] as const) {
      expect(run({ mode }).css).toContain("prefers-reduced-motion");
    }
    expect(run({ mode: "frame" }).css).not.toContain("@media");
  });

  test("slot ids escape the dot in selectors", () => {
    const css = animator.animate(variant(), { speed: 1, mode: "loop" }).css;
    expect(css).toContain("#pc-test-o-rack\\.u1{animation:");
    expect(css).toContain("#pc-test-ov-rack\\.u1{animation:");
  });

  test("B-owned names use an underscore namespace", () => {
    const css = run({ mode: "interactive" }).css;
    expect(css).toMatch(/@keyframes pc-test_kf1/);
    expect(css).toContain(".pc-test_pc1{fill:");
    expect(css).toContain(".pc-test_btn rect");
  });
});

describe("robust input", () => {
  test("non-finite time and non-integer step", () => {
    const at0 = JSON.stringify(run({ mode: "frame", time: 0 }));
    expect(JSON.stringify(run({ mode: "frame", time: Number.NaN }))).toBe(at0);
    expect(JSON.stringify(run({ mode: "frame", time: Infinity }))).toBe(at0);
    const s1 = JSON.stringify(run({ mode: "step", step: 1 }));
    expect(JSON.stringify(run({ mode: "step", step: 1.7 }))).toBe(s1);
    expect(JSON.stringify(run({ mode: "step", step: Number.NaN }))).toBe(s1);
  });

  test("duration is 0 when nothing on the timeline changes", () => {
    const m = buildFixture({ noFlows: true });
    const timeline = [{ index: 1, duration: 3, states: {}, flows: [], metrics: {} }];
    const l = animator.animate(
      { ...m, scene: { ...m.scene, timeline } },
      { speed: 1, mode: "loop" },
    );
    expect(l.duration).toBe(0);
  });

  test("degenerate paths are skipped in loop and frame alike", () => {
    const m = buildFixture();
    const e1 = m.edgePaths.e1!;
    const bad = { ...m, edgePaths: { ...m.edgePaths, e1: { ...e1, points: [e1.points[0]!] } } };
    const loop = animator.animate(bad, { speed: 1, mode: "loop" });
    const frame = animator.animate(bad, { speed: 1, mode: "frame", time: 0 });
    expect(findAll(loop.layers.flows, "animateMotion")).toHaveLength(2); // only s2_f_2
    expect(findAll(frame.layers.flows, "circle")).toHaveLength(0);
  });

  test("metric texts follow Step.index, changed vs previous step", () => {
    const tl = [
      { index: 1, duration: 1, states: {}, flows: [], metrics: { m: 5 } },
      { index: 2, duration: 1, states: {}, flows: [], metrics: { m: "5" } },
      { index: 3, duration: 1, states: {}, flows: [], metrics: { m: 6 } },
    ];
    expect(metricTexts(5, tl, "m")).toEqual({ ns: [0, 3], shown: [0, 0, 3] });
  });

  test("raster-target frame has no custom properties or at-rules", () => {
    const m = buildFixture();
    const svg = emit(m, animator.animate(m, { speed: 1, mode: "frame", time: 3.5 }), {
      font: "system",
      target: "raster",
    });
    expect(svg).not.toMatch(/var\(--|@keyframes|@media/);
  });
});

describe("overlay pinned against camera zoom", () => {
  const loop = run({ mode: "loop" }).css.replace(/\n/g, "");
  // Inverse keyframes: 0% overview, then step 1's inverse (scale < 1).
  const inverse =
    /@keyframes (\S+)\{0%\{transform:translate\(0px,0px\) scale\(1\)\}9\.375%\{transform:translate\(-?[\d.]+px,-?[\d.]+px\) scale\(0\.\d+\)/;

  test("caption, metric tiles and legend get the inverse of the camera keyframes", () => {
    const m = inverse.exec(loop);
    expect(m).not.toBeNull();
    expect(loop).toContain("#pc-test-legend");
    expect(loop).toContain(
      `#pc-test-cap,#pc-test-m-rps,#pc-test-legend{transform-origin:0 0;animation:${m![1]} `,
    );
    // same stop positions as the camera keyframes
    const stops = (name: string) =>
      [
        ...(new RegExp(`@keyframes ${name}\\{([^@]*?)\\}\\}`).exec(loop)?.[1] ?? "").matchAll(
          /([\d.]+)%/g,
        ),
      ].map((x) => x[1]);
    const camName = /#pc-test-camera\{transform-origin:0 0;animation:(\S+) /.exec(loop)![1]!;
    expect(stops(m![1]!)).toEqual(stops(camName));
  });

  test("reduced motion rests on the overview", () => {
    const media = loop.slice(loop.indexOf("@media (prefers-reduced-motion"));
    expect(media).toContain("#pc-test-cap,#pc-test-m-rps,#pc-test-legend{transform:none}");
  });
});

describe("controls", () => {
  test("group and buttons are labelled", () => {
    const g = findAll(run({ mode: "interactive" }).layers.overlay, "g");
    expect(g[0]?.attrs).toMatchObject({ role: "group", "aria-label": "Animation controls" });
    expect(g.slice(1).every((b) => typeof b.attrs?.["aria-label"] === "string")).toBe(true);
  });
});
