import { describe, expect, test } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import type { RenderModel, SceneFlow, SvgElement } from "../../src/contracts/index.js";
import { buildFixture } from "./fixtures/render-model.js";

const animator = createAnimator();
const dc: SceneFlow = { id: "dc_f_1", edge: "h1", kind: "airflow", rate: 1, reverse: false };

function withDc(m: RenderModel): RenderModel {
  return { ...m, scene: { ...m.scene, flows: [...m.scene.flows, dc] } };
}

function groupIds(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((c) => groupIds(c, out));
  else if (typeof node === "object" && node !== null) {
    const n = node as SvgElement;
    if (n.tag === "g" && typeof n.attrs?.id === "string" && n.attrs.id.includes("-fl-")) {
      out.push(n.attrs.id);
    }
    for (const c of n.children ?? []) groupIds(c, out);
  }
  return out;
}

describe("DC flows", () => {
  const m = withDc(buildFixture());

  test("loop: one group, always visible (no visibility keyframes), step flows replace only base flows", () => {
    const l = animator.animate(m, { speed: 1, mode: "loop" });
    const ids = groupIds(l.layers.flows);
    expect(ids).toContain("pc-test-fl-dc_f_1");
    expect(ids.filter((i) => i.endsWith("dc_f_1"))).toHaveLength(1);
    expect(l.css).not.toContain("#pc-test-fl-dc_f_1{animation");
    expect(l.css).toContain("#pc-test-fl-f_1{animation"); // base flow still follows the steps
  });

  test("every step and frame shows the DC flow", () => {
    for (const step of [1, 2, 3]) {
      const ids = groupIds(animator.animate(m, { speed: 1, mode: "step", step }).layers.flows);
      expect(ids).toContain("pc-test-fl-dc_f_1");
    }
    for (const time of [0, 3.5, 7]) {
      const ids = groupIds(animator.animate(m, { speed: 1, mode: "frame", time }).layers.flows);
      expect(ids).toContain("pc-test-fl-dc_f_1");
    }
    // step 3 has only the s2_f_2 flow plus DC; the base f_1 is replaced
    const ids = groupIds(animator.animate(m, { speed: 1, mode: "step", step: 3 }).layers.flows);
    expect(ids).toEqual(["pc-test-fl-s2_f_2", "pc-test-fl-dc_f_1"]);
  });

  test("a spec without steps shows base and DC flows", () => {
    const noSteps = withDc(buildFixture({ noSteps: true }));
    const ids = groupIds(animator.animate(noSteps, { speed: 1, mode: "loop" }).layers.flows);
    expect(ids).toEqual(["pc-test-fl-f_1", "pc-test-fl-dc_f_1"]);
  });
});
