import { describe, expect, test } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import type { AnimateOptions } from "../../src/contracts/index.js";
import { validateRenderOptions } from "../../src/export/options.js";
import { defaultIdPrefix } from "../../src/render/index.js";
import { buildFixture, emit, lightTheme } from "./fixtures/render-model.js";

const animator = createAnimator();
const model = buildFixture();
const run = (o: Pick<AnimateOptions, "mode"> & Partial<AnimateOptions>) =>
  animator.animate(model, { speed: 1, ...o });
const svgOf = (o: Pick<AnimateOptions, "mode"> & Partial<AnimateOptions>) =>
  emit(model, run(o), { font: "system" });
const SMIL = /<(animateMotion|animate|set|mpath|animateTransform)[\s/>]/;
const circles = (svg: string) => (svg.match(/<circle\b/g) ?? []).length;

describe("motion css", () => {
  test("loop output has no SMIL and the same particle count as smil", () => {
    const css = svgOf({ mode: "loop", motion: "css" });
    const smil = svgOf({ mode: "loop", motion: "smil" });
    expect(smil).toMatch(SMIL);
    expect(css).not.toMatch(SMIL);
    expect(circles(css)).toBe(circles(smil));
    expect(circles(css)).toBeGreaterThanOrEqual(5); // f_1 rate 1.5 -> 3, s2_f_2 rate 1 -> 2
  });

  test("each flow has an offset-path rule, shared 0->100% keyframes and negative delays", () => {
    const l = run({ mode: "loop", motion: "css" });
    expect(l.css).toContain('#pc-test-fl-f_1>.pc-test_pt{offset-path:path("');
    expect(l.css).toContain(model.edgePaths["e1"]!.d);
    expect(l.css).toContain("offset-rotate:0deg");
    expect(l.css).toMatch(
      /@keyframes pc-test_kf1\{0%\{offset-distance:0%\}100%\{offset-distance:100%\}\}/,
    );
    expect(l.css).toContain("linear infinite}");
    expect(l.css).toContain("#pc-test-fl-f_1>.pc-test_pt:nth-child(2){animation-delay:-0.6667s}");
    expect(l.css).toContain("#pc-test-fl-f_1>.pc-test_pt:nth-child(3){animation-delay:-1.3333s}");
    expect(l.css).not.toContain("nth-child(1)");
    // the reverse flow runs the keyframes backwards
    expect(l.css).toMatch(/#pc-test-fl-s2_f_2>.pc-test_pt\{[^}]*2s linear infinite reverse\}/);
    expect(l.duration).toBe(8);
  });

  test("speed scales the period", () => {
    expect(run({ mode: "loop", motion: "css", speed: 4 }).css).toContain("0.5s linear infinite");
  });

  test("step gating by visibility is kept, reduced motion hides the particles", () => {
    const l = run({ mode: "loop", motion: "css" });
    expect(l.css).toContain("#pc-test-fl-s2_f_2{animation:");
    expect(l.css).toContain("@media (prefers-reduced-motion:reduce)");
    expect(l.css).toContain("animation:none!important");
    expect(l.css).toContain("#pc-test_particles{display:none}");
  });

  test("step and interactive modes: no SMIL, particles hidden under reduced motion", () => {
    const s = run({ mode: "step", step: 2, motion: "css" });
    expect(svgOf({ mode: "step", step: 2, motion: "css" })).not.toMatch(SMIL);
    expect(s.css).toContain("offset-path:path(");
    expect(s.css).toContain("#pc-test_particles{display:none}");
    expect(s.duration).toBe(2);
    const i = run({ mode: "interactive", motion: "css" });
    expect(svgOf({ mode: "interactive", motion: "css" })).not.toMatch(SMIL);
    expect(i.script).toContain("getAnimations");
    // Play/Pause drive CSS animations; the timeline clock ignores particle (circle) animations
    expect(i.script).toContain("a.pause()");
    expect(i.script).toContain('classList.contains("pc-test_pt")');
    expect(i.script).toContain("S=[0,3,6],G=[0.75,3,6]");
  });

  test("frame mode is identical for smil and css", () => {
    for (const time of [0, 1.3]) {
      expect(run({ mode: "frame", time, motion: "css" })).toEqual(
        run({ mode: "frame", time, motion: "smil" }),
      );
    }
    expect(run({ mode: "frame", motion: "css" })).toEqual(run({ mode: "frame" }));
  });

  test("smil output is unchanged by the option default", () => {
    expect(run({ mode: "loop" })).toEqual(run({ mode: "loop", motion: "smil" }));
  });

  test("deterministic", () => {
    expect(svgOf({ mode: "loop", motion: "css" })).toBe(svgOf({ mode: "loop", motion: "css" }));
  });
});

describe("motion option", () => {
  test("validation", () => {
    expect(validateRenderOptions({ motion: "css" })).toEqual([]);
    expect(validateRenderOptions({ motion: "smil" })).toEqual([]);
    const bad = validateRenderOptions({ motion: "js" as never });
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ severity: "error", code: "options/invalid-motion" });
  });

  test("default id prefix hashes motion only when it is not smil", () => {
    const base = { theme: lightTheme, font: "embed", speed: 1, optimize: true };
    const spec = { a: 1 };
    expect(defaultIdPrefix(spec, { ...base, motion: "smil" })).toBe(defaultIdPrefix(spec, base));
    expect(defaultIdPrefix(spec, { ...base, motion: "css" })).not.toBe(defaultIdPrefix(spec, base));
  });
});
