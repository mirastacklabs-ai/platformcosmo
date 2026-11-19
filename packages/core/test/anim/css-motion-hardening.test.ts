import { describe, expect, test } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import type { AnimateOptions, RenderModel, SceneFlow } from "../../src/contracts/index.js";
import { optimize } from "../../src/optimize/index.js";
import { buildFixture, emit } from "./fixtures/render-model.js";

const animator = createAnimator();
const run = (o: Pick<AnimateOptions, "mode"> & Partial<AnimateOptions>, m = buildFixture()) =>
  animator.animate(m, { speed: 1, ...o });
const svgOf = (o: Pick<AnimateOptions, "mode"> & Partial<AnimateOptions>) => {
  const m = buildFixture();
  return emit(m, run(o, m), { font: "system" });
};
const SMIL = /<(animateMotion|animate|set|mpath|animateTransform)[\s/>]/;
const circles = (svg: string) => (svg.match(/<circle\b/g) ?? []).length;

const withFlows = (flows: SceneFlow[]): RenderModel => {
  const m = buildFixture({ noSteps: true });
  return { ...m, scene: { ...m.scene, flows } };
};
const flow = (id: string, edge: string, over: Partial<SceneFlow> = {}): SceneFlow => ({
  id,
  edge,
  kind: "normal",
  rate: 1,
  reverse: false,
  ...over,
});

describe("motion css hardening", () => {
  test("an edge path with unexpected characters skips the flow", () => {
    const m = buildFixture();
    const edgePaths = { ...m.edgePaths, e1: { ...m.edgePaths["e1"]!, d: 'M0 0");x{y:z}/*' } };
    const l = animator.animate({ ...m, edgePaths }, { speed: 1, mode: "loop", motion: "css" });
    expect(l.css).not.toContain("x{y:z}");
    expect(l.css).not.toContain("#pc-test-fl-f_1>");
    expect(l.css).toContain("#pc-test-fl-s2_f_2>");
  });

  test("particles carry the B-owned class; rules and the script target it", () => {
    const l = run({ mode: "interactive", motion: "css" });
    expect(l.css).toContain("#pc-test-fl-f_1>.pc-test_pt{offset-path");
    expect(l.css).toContain("#pc-test-fl-f_1>.pc-test_pt:nth-child(2){animation-delay");
    expect(l.css).not.toContain(">circle");
    expect(l.script).toContain('classList.contains("pc-test_pt")');
    expect(svgOf({ mode: "loop", motion: "css" })).toMatch(
      /<circle [^>]*class="pc-\S+ pc-test_pt"/,
    );
  });

  test("survives the real optimizer: circles, classes and order", () => {
    const raw = svgOf({ mode: "loop", motion: "css" });
    const out = optimize(raw);
    expect(out).not.toMatch(SMIL);
    expect(circles(out)).toBe(circles(raw));
    const cls = (s: string) => [...s.matchAll(/<circle\b[^>]*class="([^"]*)"/g)].map((x) => x[1]);
    expect(cls(out)).toEqual(cls(raw));
    expect(out).toContain("pc-test_pt");
    expect(out).toContain("nth-child(2)");
    expect(out).toContain("offset-path");
    expect(out).toMatch(/<g id="pc-test-fl-f_1"><circle/);
  });

  test("@supports guard hides the particle groups when offset-path is missing", () => {
    for (const mode of ["loop", "step", "interactive"] as const) {
      const css = run({ mode, motion: "css", step: 1 }).css;
      expect(css).toContain(
        '@supports not (offset-path:path("M0 0")){\n#pc-test_particles,#pc-test_particles_dc{display:none}\n}',
      );
    }
    expect(run({ mode: "loop" }).css).not.toContain("@supports");
  });

  test("DC flows: offset-path rules, always visible, hidden under reduced motion", () => {
    const m = withFlows([flow("f_1", "e1"), flow("dc_f_1", "h1", { kind: "airflow" })]);
    const l = run({ mode: "loop", motion: "css" }, m);
    expect(l.css).toContain('#pc-test-fl-dc_f_1>.pc-test_pt{offset-path:path("');
    expect(l.css).not.toContain("#pc-test-fl-dc_f_1{animation");
    expect(l.css).toMatch(
      /prefers-reduced-motion:reduce\)\{[^@]*#pc-test_particles\{display:none\}/,
    );
  });

  test("interactive css without steps: clock falls back to the particle animation", () => {
    const l = run({ mode: "interactive", motion: "css" }, buildFixture({ noSteps: true }));
    expect(l.script).toContain("S=[]");
    expect(l.script).toContain("||l[0]");
    expect(l.duration).toBe(2);
  });

  test("an edge shared by two flows gets separate rules per flow", () => {
    const m = withFlows([flow("f_1", "e1"), flow("f_9", "e1", { rate: 0.5 })]);
    const l = run({ mode: "loop", motion: "css" }, m);
    const d = m.edgePaths["e1"]!.d;
    expect(l.css.split(`path("${d}")`)).toHaveLength(3);
    expect(l.css).toContain("#pc-test-fl-f_1>.pc-test_pt{");
    expect(l.css).toContain("#pc-test-fl-f_9>.pc-test_pt{");
    expect(l.css.match(/@keyframes pc-test_kf\d+\{0%\{offset-distance/g)).toHaveLength(1);
  });
});
