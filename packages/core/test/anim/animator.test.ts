import { describe, expect, test } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import { pointAt } from "../../src/anim/particles.js";
import { metricTexts, stepIndexAt, windows, zoomFor } from "../../src/anim/timeline.js";
import type { AnimateOptions, SvgElement } from "../../src/contracts/index.js";
import { buildFixture, emit } from "./fixtures/render-model.js";

const animator = createAnimator();
const run = (o: Partial<AnimateOptions> & Pick<AnimateOptions, "mode">, fx = {}) =>
  animator.animate(buildFixture(fx), { speed: 1, ...o });

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

describe("loop mode", () => {
  const layer = run({ mode: "loop" });

  test("duration is the sum of step durations at speed", () => {
    expect(layer.duration).toBe(8);
    expect(run({ mode: "loop", speed: 2 }).duration).toBe(4);
  });

  test("particle count per flow is ceil(rate*2), traversal 2s/speed, staggered", () => {
    const motions = findAll(layer.layers.flows, "animateMotion");
    // f_1 rate 1.5 -> 3, s2_f_2 rate 1 -> 2
    expect(motions).toHaveLength(5);
    const f1 = motions.slice(0, 3);
    expect(f1.map((m) => m.attrs?.dur)).toEqual(["2s", "2s", "2s"]);
    expect(f1.map((m) => m.attrs?.begin)).toEqual(["0s", "-0.6667s", "-1.3333s"]);
    const f2 = motions.slice(3);
    expect(f2[0]?.attrs).toMatchObject({ keyPoints: "1;0", keyTimes: "0;1", calcMode: "linear" });
    const fast = findAll(run({ mode: "loop", speed: 4 }).layers.flows, "animateMotion");
    expect(fast[0]?.attrs?.dur).toBe("0.5s");
  });

  test("particles follow the edge path through mpath", () => {
    const mpath = findAll(layer.layers.flows, "mpath")[0];
    expect(mpath?.attrs?.href).toBe("#pc-test-ep-e1");
  });

  test("master timeline css: visibility, state, caption, camera and reduced motion", () => {
    expect(layer.css).toContain("@keyframes pc-test_kf1");
    expect(layer.css).toContain("#pc-test-fl-s2_f_2{animation:");
    expect(layer.css).toContain("#pc-test-o-b{animation:");
    expect(layer.css).toContain("var(--pc-states-down-opacity)");
    expect(layer.css).toContain("#pc-test-cap-2{animation:");
    expect(layer.css).toContain("#pc-test-mv-rps-2{animation:");
    expect(layer.css).toContain("#pc-test-camera{transform-origin:0 0;animation:");
    expect(layer.css).toContain("@media (prefers-reduced-motion:reduce)");
    expect(layer.css).toContain("animation:none!important");
    expect(layer.css).toContain("#pc-test_particles{display:none}");
  });

  test("no script in loop mode", () => {
    expect(layer.script).toBeUndefined();
  });

  test("deterministic", () => {
    expect(JSON.stringify(run({ mode: "loop" }))).toBe(JSON.stringify(layer));
  });

  test("no steps: only base flows, period duration, no timeline css", () => {
    const l = run({ mode: "loop" }, { noSteps: true });
    expect(l.duration).toBe(2);
    expect(l.css).not.toContain("#pc-test-cap-");
    expect(findAll(l.layers.flows, "animateMotion")).toHaveLength(3);
  });

  test("nothing animates without flows or steps", () => {
    const l = run({ mode: "loop" }, { noFlows: true });
    expect(l.duration).toBe(0);
    expect(l.layers.flows).toBeUndefined();
    expect(l.css).not.toContain("prefers-reduced-motion");
  });
});

describe("interactive mode", () => {
  const layer = run({ mode: "interactive" });
  test("adds controls and a DOM-only script", () => {
    expect(layer.script).toContain('getElementById("pc-test-root")');
    expect(layer.script).toContain("addEventListener");
    expect(layer.script).not.toMatch(/\bon[a-z]+=/);
    expect(layer.script).not.toContain("]]>");
    const ids = findAll(layer.layers.overlay, "g").map((g) => g.attrs?.id);
    expect(ids).toContain("pc-test_btn_play");
    expect(ids).toContain("pc-test_btn_step");
    expect(layer.css).toContain("#pc-test_controls{transform-origin:0 0;animation:");
  });
  test("step starts and settle times embedded", () => {
    expect(layer.script).toContain("S=[0,3,6]");
    expect(layer.script).toContain("T=8");
  });
});

describe("step mode", () => {
  test("static states of step 2 with its own particles, no master loop", () => {
    const l = run({ mode: "step", step: 2 });
    expect(l.css).toContain("#pc-test-o-b{opacity:var(--pc-states-down-opacity)}");
    expect(l.css).toContain("#pc-test-cap-2{visibility:visible}");
    expect(l.css).toContain("#pc-test-cap-1{visibility:hidden}");
    expect(l.css).toContain("#pc-test-mv-rps-2{visibility:visible}");
    expect(l.css).toContain("#pc-test-mv-rps-0{visibility:hidden}");
    expect(l.css).not.toContain("@keyframes");
    expect(l.css).toContain("@media (prefers-reduced-motion:reduce)");
    expect(l.css).toContain("#pc-test_particles{display:none}");
    expect(findAll(l.layers.flows, "animateMotion")).toHaveLength(5);
    expect(l.duration).toBe(2);
    expect(l.viewBox).toBeUndefined();
  });

  test("step 1 zooms to focus through viewBox", () => {
    const l = run({ mode: "step", step: 1 });
    expect(l.viewBox).toBeDefined();
    expect(l.viewBox!.width).toBeLessThan(560);
    expect(l.viewBox!.width / l.viewBox!.height).toBeCloseTo(560 / 320, 1);
    expect(findAll(l.layers.flows, "animateMotion")).toHaveLength(3);
  });
});

describe("frame mode", () => {
  test("no animation constructs at all; plain selectors", () => {
    const l = run({ mode: "frame", time: 3.5 });
    expect(l.css).not.toMatch(/@keyframes|@media|animation/);
    expect(findAll(l.layers.flows, "animateMotion")).toHaveLength(0);
    expect(l.duration).toBe(0);
    // time 3.5 is in step 2: both flows, 3 + 2 circles frozen
    expect(findAll(l.layers.flows, "circle")).toHaveLength(5);
    expect(l.css).toContain("#pc-test-o-b{opacity:var(--pc-states-down-opacity)}");
  });

  test("particles are frozen at computed positions", () => {
    const c0 = findAll(run({ mode: "frame", time: 0 }).layers.flows, "circle");
    const c1 = findAll(run({ mode: "frame", time: 1 }).layers.flows, "circle");
    expect(c0[0]?.attrs).toMatchObject({ cx: 100, cy: 140 });
    expect(c1[0]?.attrs?.cx).toBe(200);
  });

  test("frame time wraps over the loop", () => {
    const a = run({ mode: "frame", time: 3.5 });
    const b = run({ mode: "frame", time: 11.5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("time 0 equals the first step", () => {
    const l = run({ mode: "frame", time: 0 });
    expect(l.css).not.toContain("cap-1{visibility");
    expect(l.viewBox).toBeDefined();
  });
});

describe("emitted document", () => {
  test("loop svg contains only ids with the prefix for animated nodes", () => {
    const m = buildFixture();
    const svg = emit(m, animator.animate(m, { mode: "loop", speed: 1 }), { font: "system" });
    expect(svg).toContain("<animateMotion");
    expect(svg).toContain('href="#pc-test-ep-e1"');
  });
});

describe("timeline helpers", () => {
  const m = buildFixture();
  test("windows and stepIndexAt", () => {
    const w = windows(m.scene.timeline, 1);
    expect(w.starts).toEqual([0, 3, 6]);
    expect(stepIndexAt(w, 2.9)).toBe(0);
    expect(stepIndexAt(w, 3)).toBe(1);
    expect(stepIndexAt(w, 8.5)).toBe(0);
  });
  test("metricTexts picks the latest change", () => {
    expect(metricTexts(100, m.scene.timeline, "rps")).toEqual({ ns: [0, 2], shown: [0, 2, 2] });
  });
  test("zoomFor: none without focus, scaled otherwise", () => {
    expect(zoomFor(m, m.scene.timeline[1])).toBeUndefined();
    const z = zoomFor(m, m.scene.timeline[0]);
    expect(z!.scale).toBeGreaterThan(1);
    expect(z!.tx).toBeLessThan(0);
  });
  test("pointAt walks a polyline", () => {
    const p = pointAt(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      0.75,
    );
    expect(p).toEqual({ x: 10, y: 5 });
  });
});
