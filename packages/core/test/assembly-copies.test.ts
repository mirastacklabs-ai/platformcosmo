/**
 * Depth copies end to end (assemblies §9.4, track A1-2b): the crafted one-copy specs through the
 * scene, the render model, the emitter and the animator. Frame and step outputs must agree with
 * the animation at the swap times, and exactly one copy of an item is visible at any time.
 */
import { describe, expect, test } from "vitest";
import { buildModelWithDiagnostics } from "../src/render/model.js";
import {
  buildScene,
  createAnimator,
  emit,
  validate,
  type PlatformCosmoSpec,
  type RenderModel,
  type SvgElement,
  type SvgNode,
} from "../src/index.js";
import type { AssemblyIdScheme, AssemblyRenderModel, IdScheme } from "../src/contracts/index.js";
import { assemblyAnim, assemblyFrame, assemblyStepEnd } from "../src/anim/assembly.js";
import { parseCopyKey } from "../src/depth/copies.js";
import { decodePng } from "../src/export/png.js";
import { rasterize } from "../src/export/rasterize.js";
import { themeRegistry } from "../../themes/src/index.js";
import { fixtureTheme } from "./fixtures/theme.js";
import { clippedCopySpec, copySwapSpec, crossingClipSpec } from "./copies-fixtures.js";

function build(spec: PlatformCosmoSpec): { model: RenderModel; codes: string[] } {
  const scene = buildScene(spec, {});
  const { model, diagnostics } = buildModelWithDiagnostics({
    scene,
    theme: fixtureTheme(),
    font: "system",
    prefix: "pc-t",
    spec,
  });
  return { model, codes: diagnostics.map((d) => d.code) };
}
/** The assembly model; its `ids` is the full scheme (`IdScheme & AssemblyIdScheme`). */
const A = (m: RenderModel): AssemblyRenderModel & { ids: IdScheme & AssemblyIdScheme } =>
  m.assembly as AssemblyRenderModel & { ids: IdScheme & AssemblyIdScheme };
const animator = createAnimator();
const BLK = "kit/arm/blk";

const isEl = (n: SvgNode): n is SvgElement => typeof n === "object" && "tag" in n;
/** Ancestor chain (outermost first) of the element with `id`. */
function chainTo(nodes: readonly SvgNode[], id: string, path: SvgElement[] = []): SvgElement[] {
  for (const n of nodes) {
    if (!isEl(n)) continue;
    if (n.attrs?.["id"] === id) return [...path, n];
    const r = chainTo(n.children ?? [], id, [...path, n]);
    if (r.length > 0) return r;
  }
  return [];
}
const idsIn = (svg: string): string[] => [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);

const r4 = (t: number): number => Math.round(t * 1e4) / 1e4;
/**
 * The epoch of time t as the tracks see it: a boundary belongs to the next epoch, and track keys
 * sit at boundaries rounded to 4 decimals (A1-3).
 */
function epochOf(am: AssemblyRenderModel, t: number): AssemblyRenderModel["epochs"][number] {
  const last = am.epochs.length - 1;
  return am.epochs.find((e, k) => t >= r4(e.t0) - 1e-9 && (t < r4(e.t1) - 1e-9 || k === last))!;
}

/** Times around every copy swap (epoch start) and through the loop. */
function swapTimes(am: AssemblyRenderModel): number[] {
  const out: number[] = [];
  for (const e of am.epochs.slice(1))
    out.push(e.t0 - 0.01, e.t0 - 1e-4, e.t0, e.t0 + 1e-4, e.t0 + 0.01);
  for (let k = 0; k < 40; k++) out.push((am.loop * (k + 0.5)) / 40);
  return out;
}

describe("crafted one-copy spec (§9.4)", () => {
  const { model, codes } = build(copySwapSpec());
  const am = A(model);

  test("validates; exactly one copy, swapped by visibility, nothing approximate", () => {
    for (const spec of [copySwapSpec(), copySwapSpec({ label: true }), clippedCopySpec()]) {
      expect(validate(spec).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    }
    expect(codes).not.toContain("assembly/depth-approx");
    expect(codes).not.toContain("budget/depth-copies");
    expect(am.items.map((i) => [i.item, i.copies])).toEqual([
      [BLK, 2],
      ["kit/base", 1],
    ]);
    expect(am.epochs.map((e) => e.order)).toEqual([
      [BLK, "kit/base"],
      ["kit/base", `${BLK}__c1`],
      [BLK, "kit/base"],
    ]);
    expect(am.epochs.every((e) => !e.approximate)).toBe(true);
    expect(am.approximate).toEqual([]);
    expect(am.tracks.map((t) => t.copy)).toEqual([BLK, `${BLK}__c1`, "kit/base"]);
    // both copies sit at the same place: identical motion tracks, complementary visibility
    const [c0, c1] = am.tracks;
    expect(c1!.motion).toEqual(c0!.motion);
    expect(c0!.visibility.map((k) => k.t)).toEqual(c1!.visibility.map((k) => k.t));
    expect(c0!.visibility.map((k) => !k.visible)).toEqual(c1!.visibility.map((k) => k.visible));
  });

  test("DOM: copy 1 is a full duplicate subtree, every id suffixed __c1; ids unique", () => {
    const ids = am.ids;
    const objects = model.layers.objects;
    const o1 = chainTo(objects, `${ids.object(BLK)}__c1`);
    expect(o1.map((e) => e.attrs?.["id"])).toEqual([
      ids.partMotion(BLK, 1),
      ids.partVisible(BLK, 1),
      `${ids.object(BLK)}__c1`,
    ]);
    const o0 = chainTo(objects, ids.object(BLK));
    const strip = (n: SvgNode): unknown =>
      isEl(n)
        ? {
            ...n,
            attrs: n.attrs && {
              ...n.attrs,
              ...(typeof n.attrs["id"] === "string"
                ? { id: (n.attrs["id"] as string).replace(/__c1$/, "") }
                : {}),
            },
            children: n.children?.map(strip),
          }
        : n;
    expect(strip(o1[o1.length - 1]!)).toEqual(strip(o0[o0.length - 1]!));
    // every element id of copy 0's part group has its __c1 twin, and copyIds lists both
    const inner0: string[] = [];
    const walk = (n: SvgNode): void => {
      if (!isEl(n)) return;
      if (typeof n.attrs?.["id"] === "string") inner0.push(n.attrs["id"] as string);
      n.children?.forEach(walk);
    };
    walk(o0[o0.length - 1]!);
    expect(inner0.length).toBeGreaterThan(3); // object, faces, overlay
    for (const id of [...inner0, ids.partMotion(BLK), ids.partVisible(BLK)]) {
      expect(ids.copyIds(id)).toEqual([id, `${id}__c1`]);
    }
    expect(ids.copyIds(ids.object("kit/base"))).toEqual([ids.object("kit/base")]);
    for (const opts of [
      { speed: 1, mode: "loop" },
      { speed: 1, mode: "interactive" },
      { speed: 1, mode: "frame", time: 0 },
    ] as const) {
      const mode = opts.mode;
      const svg = emit(model, animator.animate(model, opts), { font: "system" });
      const all = idsIn(svg);
      expect(new Set(all).size, mode).toBe(all.length);
    }
  });

  test("the DOM carries the rest frame: copy 1 hidden by attribute", () => {
    const v1 = chainTo(model.layers.objects, am.ids.partVisible(BLK, 1)).at(-1)!;
    const v0 = chainTo(model.layers.objects, am.ids.partVisible(BLK, 0)).at(-1)!;
    expect(v1.attrs?.["visibility"]).toBe("hidden");
    expect(v0.attrs?.["visibility"]).toBeUndefined();
    expect(am.frameAt(0).hidden).toContain(am.ids.partVisible(BLK, 1));
  });

  test("no flicker: exactly one copy visible at every time, and it is the epoch's", () => {
    const v = [am.ids.partVisible(BLK, 0), am.ids.partVisible(BLK, 1)];
    for (const t of swapTimes(am)) {
      const f = am.frameAt(t);
      const shown = v.filter((id) => f.visible.includes(id));
      expect(shown, `t=${t}`).toHaveLength(1);
      const want = epochOf(am, t).order.find((k) => parseCopyKey(k).item === BLK)!;
      expect(shown[0], `t=${t}`).toBe(am.ids.partVisible(BLK, parseCopyKey(want).copy));
      // the full state lists every wrapper of every copy
      expect([...f.visible, ...f.hidden].sort()).toEqual([...v].sort());
      expect(Object.keys(f.transforms)).toEqual(
        expect.arrayContaining([am.ids.partMotion(BLK, 0), am.ids.partMotion(BLK, 1)]),
      );
      expect(f.transforms[am.ids.partMotion(BLK, 1)]).toBe(f.transforms[am.ids.partMotion(BLK, 0)]);
    }
  });

  test("frame and step outputs agree with the animation at the swap times", () => {
    const anim = assemblyAnim(am, 1);
    const vis = anim.props.filter((p) => p.kind === "visibility");
    expect(vis.map((p) => p.id).sort()).toEqual(
      [am.ids.partVisible(BLK, 0), am.ids.partVisible(BLK, 1)].sort(),
    );
    // both copies switch at the same keyframe times
    expect(vis[0]!.keys.map((k) => k.t)).toEqual(vis[1]!.keys.map((k) => k.t));
    for (const t of swapTimes(am)) {
      const f = am.frameAt(t);
      const a = assemblyFrame(am, 1, t)!;
      for (const id of f.visible) expect(a[id]?.visibility, `${id} @${t}`).toBe("visible");
      for (const id of f.hidden) expect(a[id]?.visibility, `${id} @${t}`).toBe("hidden");
      for (const [id, tf] of Object.entries(f.transforms)) {
        expect(a[id]?.transform, `${id} @${t}`).toBe(tf);
      }
      const layer = animator.animate(model, { speed: 1, mode: "frame", time: t });
      expect(layer.attrs?.[am.ids.partVisible(BLK, 1)]?.visibility).toBe(
        a[am.ids.partVisible(BLK, 1)]!.visibility,
      );
    }
    am.clock.forEach((_, k) => {
      const s = am.stepEnd(k + 1);
      const a = assemblyStepEnd(am, 1, k + 1)!;
      for (const id of s.visible) expect(a[id]?.visibility).toBe("visible");
      for (const id of s.hidden) expect(a[id]?.visibility).toBe("hidden");
      expect([...s.visible, ...s.hidden]).toHaveLength(2);
    });
  });

  test("the loop CSS animates both copies' visibility wrappers", () => {
    const css = animator.animate(model, { speed: 1, mode: "loop" }).css;
    for (const c of [0, 1]) {
      expect(css).toContain(am.ids.sel(am.ids.partVisible(BLK, c)));
      expect(css).toContain(am.ids.sel(am.ids.partMotion(BLK, c)));
    }
  });

  test("deterministic: the same spec renders byte-identical output", () => {
    const svg = (): string => {
      const m = build(copySwapSpec()).model;
      return emit(m, animator.animate(m, { speed: 1, mode: "loop" }), { font: "system" });
    };
    expect(svg()).toBe(svg());
  });
});

describe("top-face labels ride inside every copy (copyIds)", () => {
  const { model } = build(copySwapSpec({ label: true }));
  const am = A(model);

  test("the label group is copied with its id suffixed and animated per copy", () => {
    const top = am.labelTracks.find((l) => l.id.endsWith("__top"))!;
    expect(top).toBeDefined();
    expect(am.ids.copyIds(top.id)).toEqual([top.id, `${top.id}__c1`]);
    expect(chainTo(model.layers.objects, `${top.id}__c1`).map((e) => e.attrs?.["id"])).toContain(
      am.ids.partVisible(BLK, 1),
    );
    const f = am.frameAt(3);
    expect(f.opacity[top.id]).toBeDefined();
    expect(f.opacity[`${top.id}__c1`]).toBe(f.opacity[top.id]);
    const props = assemblyAnim(am, 1).props.filter((p) => p.id.startsWith(top.id));
    expect(props.map((p) => p.id).sort()).toEqual([top.id, `${top.id}__c1`].sort());
  });
});

describe("clipped copies (§9.4, §9.5)", () => {
  const { model, codes } = build(clippedCopySpec());
  const am = A(model);
  const P = "kit/piston";

  test("the clipped piston gets copy 1, clipped by the same static clip outside its motion", () => {
    expect(codes).not.toContain("assembly/depth-approx");
    const it = am.items.find((i) => i.item === P)!;
    expect(it.copies).toBe(2);
    expect(it.clips?.[0]).toEqual(it.clips?.[1]);
    const clip = it.clips![1]!.clip;
    for (const c of [0, 1]) {
      const chain = chainTo(model.layers.objects, am.ids.partMotion(P, c));
      expect(chain.length).toBeGreaterThan(0);
      // the clip wrapper is an ancestor of the copy's motion wrapper (static in the solid's frame)
      expect(chain.some((e) => e.attrs?.["clip-path"] === `url(#${clip})`)).toBe(true);
    }
    // one clip path definition shared by both copies
    const svg = emit(model, animator.animate(model, { speed: 1, mode: "loop" }), {
      font: "system",
    });
    expect(svg.split(`<clipPath id="${clip}"`)).toHaveLength(2);
    const all = idsIn(svg);
    expect(new Set(all).size).toBe(all.length);
    // the static block is never copied
    expect(am.items.find((i) => i.item === "kit/block")!.copies).toBe(1);
  });

  test("exactly one piston copy is visible while it is out of the block", () => {
    const v = [am.ids.partVisible(P, 0), am.ids.partVisible(P, 1)];
    for (const t of swapTimes(am)) {
      const e = epochOf(am, t);
      const f = am.frameAt(t);
      const shown = v.filter((id) => f.visible.includes(id));
      expect(shown.length, `t=${t}`).toBe(e.order.some((k) => k.startsWith(P)) ? 1 : 0);
    }
  });
});

describe("clipped only while crossing: a clipped and an unclipped copy (§9.5, A1-2c)", () => {
  const { model, codes } = build(crossingClipSpec());
  const am = A(model);
  const P = "kit/arm/piston";

  test("validates; copy 0 clipped, copy 1 not; nothing hidden until clear, nothing approximate", () => {
    expect(validate(crossingClipSpec()).diagnostics.filter((d) => d.severity === "error")).toEqual(
      [],
    );
    expect(codes).not.toContain("assembly/clip-fallback");
    expect(codes).not.toContain("assembly/depth-approx");
    const it = am.items.find((i) => i.item === P)!;
    expect(it.copies).toBe(2);
    expect(Object.keys(it.clips ?? {})).toEqual(["0"]);
    expect(am.approximate).toEqual([]);
    expect(am.items.find((i) => i.item === "kit/block")!.copies).toBe(1);
  });

  test("DOM: only copy 0 sits under the clip; ids unique; copyIds lists both copies", () => {
    const clip = am.items.find((i) => i.item === P)!.clips![0]!.clip;
    const c0 = chainTo(model.layers.objects, am.ids.partMotion(P, 0));
    const c1 = chainTo(model.layers.objects, am.ids.partMotion(P, 1));
    expect(c0.some((e) => e.attrs?.["clip-path"] === `url(#${clip})`)).toBe(true);
    expect(c1.length).toBeGreaterThan(0);
    expect(c1.some((e) => e.attrs?.["clip-path"] !== undefined)).toBe(false);
    for (const id of [am.ids.partMotion(P, 0), am.ids.partVisible(P, 0), am.ids.object(P)]) {
      expect(am.ids.copyIds(id)).toEqual([id, `${id}__c1`]);
    }
    for (const mode of ["loop", "interactive"] as const) {
      const svg = emit(model, animator.animate(model, { speed: 1, mode }), { font: "system" });
      const all = idsIn(svg);
      expect(new Set(all).size, mode).toBe(all.length);
      expect(svg.split(`<clipPath id="${clip}"`), mode).toHaveLength(2);
    }
  });

  test("a cylinder does not fill its box: no split, the named fallback stays (§9.5)", () => {
    const cyl = build(crossingClipSpec({ shape: "cylinder" }));
    const it = A(cyl.model).items.find((i) => i.item === P)!;
    expect(it.copies).toBe(1);
    expect(it.clips).toBeUndefined();
    expect(cyl.codes).toContain("assembly/clip-fallback");
  });

  test("one copy at a time, the epoch's; frames agree with the animation at every swap", () => {
    const v = [am.ids.partVisible(P, 0), am.ids.partVisible(P, 1)];
    const anim = assemblyAnim(am, 1);
    expect(anim.props.filter((p) => p.kind === "visibility").map((p) => p.id)).toEqual(
      expect.arrayContaining(v),
    );
    let both = 0;
    for (const t of swapTimes(am)) {
      const e = epochOf(am, t);
      const f = am.frameAt(t);
      const shown = v.filter((id) => f.visible.includes(id));
      const want = e.order.find((k) => parseCopyKey(k).item === P);
      expect(shown, `t=${t}`).toEqual(
        want === undefined ? [] : [am.ids.partVisible(P, parseCopyKey(want).copy)],
      );
      if (want !== undefined) both |= 1 << parseCopyKey(want).copy;
      const a = assemblyFrame(am, 1, t)!;
      for (const id of f.visible) expect(a[id]?.visibility, `${id} @${t}`).toBe("visible");
      for (const id of f.hidden) expect(a[id]?.visibility, `${id} @${t}`).toBe("hidden");
      for (const [id, tf] of Object.entries(f.transforms)) {
        expect(a[id]?.transform, `${id} @${t}`).toBe(tf);
      }
    }
    expect(both).toBe(3); // both copies are used
  });
});

describe("window clip swaps: same pixels, or named when flush (A1-2c, §9.5)", () => {
  const P = "kit/arm/piston";
  /** The crossing fixture in the light theme (its outline strokes; the fixture theme draws none). */
  function setup(spec: PlatformCosmoSpec) {
    const { model, diagnostics } = buildModelWithDiagnostics({
      scene: buildScene(spec, {}),
      theme: themeRegistry.get("light")!,
      font: "system",
      prefix: "pc-t",
      spec,
    });
    const am = A(model);
    /** RGBA of the frame at t, at scale 2; `show` forces one copy visible and the other hidden. */
    const frame = async (t: number, show?: 0 | 1): Promise<Uint8Array> => {
      const layer = animator.animate(model, { speed: 1, mode: "frame", time: t });
      const attrs = { ...(layer.attrs ?? {}) };
      if (show !== undefined) {
        for (const c of [0, 1] as const) {
          const id = am.ids.partVisible(P, c);
          attrs[id] = { ...(attrs[id] ?? {}), visibility: c === show ? "visible" : "hidden" };
        }
      }
      const svg = emit(model, { ...layer, attrs }, { font: "system", target: "raster" });
      return decodePng(await rasterize(svg, { scale: 2, fonts: [] })).data;
    };
    const copyAt = (o: readonly string[]): number | undefined => {
      const x = o.find((y) => parseCopyKey(y).item === P);
      return x === undefined ? undefined : parseCopyKey(x).copy;
    };
    const swaps = am.epochs
      .slice(1)
      .filter((e, k) => {
        const before = copyAt(am.epochs[k]!.order);
        const after = copyAt(e.order);
        return before !== undefined && after !== undefined && before !== after;
      })
      .map((e) => e.t0);
    const rims = diagnostics.filter((d) => d.code === "assembly/clip-swap-rim");
    return { frame, swaps, rims };
  }
  const diff = (a: Uint8Array, b: Uint8Array): number => {
    let n = 0;
    for (let q = 0; q < a.length; q += 4) {
      const d =
        Math.abs(a[q]! - b[q]!) + Math.abs(a[q + 1]! - b[q + 1]!) + Math.abs(a[q + 2]! - b[q + 2]!);
      if (d > 6) n++;
    }
    return n;
  };

  for (const exit of ["z", "x"] as const) {
    test(`exit through the +${exit} face: both copies draw the same pixels at every swap`, async () => {
      const { frame, swaps, rims } = setup(crossingClipSpec({ exit }));
      expect(swaps).toHaveLength(2);
      expect(rims).toEqual([]);
      for (const t of swaps) {
        expect(diff(await frame(t, 0), await frame(t, 1)), `t=${t}`).toBe(0);
      }
    }, 120_000);

    test(`flush on the +${exit} face at the swap: named (assembly/clip-swap-rim)`, async () => {
      const { frame, swaps, rims } = setup(crossingClipSpec({ exit, flush: true }));
      expect(swaps).toHaveLength(2);
      expect(rims).toHaveLength(1);
      expect(rims[0]!.severity).toBe("info");
      expect(rims[0]!.params).toMatchObject({ item: P, solid: "kit/block", t: swaps[0] });
      // the named exception is real: the stroke along the face differs between the copies
      expect(diff(await frame(swaps[0]!, 0), await frame(swaps[0]!, 1))).toBeGreaterThan(0);
    }, 120_000);
  }

  test("frames 1 ms either side of a swap differ by motion only (no outline pop)", async () => {
    const { frame, swaps } = setup(crossingClipSpec());
    for (const t of swaps) {
      const across = diff(await frame(t - 0.001), await frame(t + 0.001));
      // the same 2 ms of motion without a swap, on one copy
      const c = t < 5 ? 0 : 1;
      const same = diff(await frame(t - 0.001, c), await frame(t + 0.001, c));
      expect(across, `t=${t}`).toBeLessThanOrEqual(same + 8);
    }
  }, 120_000);
});

describe("copies in quarter-turn views (A1-4): copyIds lists the ids as emitted", () => {
  test("every id copyIds names exists once in the SVG, in every view", () => {
    const spec = copySwapSpec() as unknown as {
      assemblies: { programs: unknown[] }[];
    };
    spec.assemblies[0]!.programs.push({
      id: "b",
      kind: "build",
      steps: [{ add: ["base"], view: 270 }, { add: ["arm"] }],
    });
    const { model } = build(spec as unknown as PlatformCosmoSpec);
    const views = (A(model) as { views?: readonly { turn: number; model: AssemblyRenderModel }[] })
      .views;
    expect(views?.length).toBeGreaterThan(1);
    const svg = emit(model, animator.animate(model, { speed: 1, mode: "loop" }), {
      font: "system",
    });
    const all = idsIn(svg);
    expect(new Set(all).size).toBe(all.length);
    const present = new Set(all);
    let copied = 0;
    for (const v of views!) {
      const am = v.model as AssemblyRenderModel & { ids: IdScheme & AssemblyIdScheme };
      for (const it of am.items.filter((i) => i.copies > 1)) {
        copied++;
        for (const id of [
          am.ids.partMotion(it.item, 0),
          am.ids.partVisible(it.item, 0),
          am.ids.object(it.item),
        ]) {
          const list = am.ids.copyIds(id);
          expect(list, `view ${v.turn} ${id}`).toHaveLength(it.copies);
          for (const x of list) expect(present.has(x), `view ${v.turn} ${x}`).toBe(true);
        }
      }
    }
    expect(copied).toBeGreaterThan(1); // the swap needs a copy in the turned view too
  });
});
