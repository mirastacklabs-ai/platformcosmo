/**
 * Clip and order correctness against a per-pixel z-buffer (see `depth-zbuffer.ts`): painter
 * frames are real SVG rendered by resvg; the reference is an exact ray cast of the same boxes.
 *
 * What the comparison does NOT count (C-Q11): reference pixels whose 3×3 neighbourhood holds two
 * ids (rasterizer edge rules differ by up to a pixel), and pixels where two items' visible faces
 * are exactly coplanar (a flush end face has no single right answer). `fraction` is over the
 * non-background reference pixels; `worstItem` caps each item's own share of wrong pixels, so a
 * small part cannot vanish inside a large image. Shapes are boxes unless listed in `zcyl`.
 */
import { describe, expect, it, vi } from "vitest";
import type { Box3, Vec3 } from "../src/contracts/index.js";
import type { DepthEpochResult, DepthItemInput, LoopMove } from "../src/depth/epochs.js";
import { depthEpochs, displacementAt } from "../src/depth/epochs.js";
import { interpenetrates, toBounds, shift } from "../src/depth/enclosure.js";
import { buildDrop, engine, rackDrawer, serverInternals } from "./depth-fixtures.js";
import type { Scene, View } from "./depth-zbuffer.js";
import { box, check, count, epochAt, indexOf, v, viewOf } from "./depth-zbuffer.js";

// resvg renders dozens of frames per test; generous under a shared, loaded machine.
vi.setConfig({ testTimeout: 60_000 });

/** Non-boundary mismatches allowed for an "exact" frame (rasterizer rounding at clip corners). */
const EXACT = 1e-4;

function solve(scene: Scene): DepthEpochResult {
  return depthEpochs(scene.items, scene.moves, scene.loop);
}

function inApprox(r: DepthEpochResult, t: number): boolean {
  return r.approximate.some((a) => t >= a.t0 - 1e-9 && t <= a.t1 + 1e-9);
}

function samples(loop: number, n: number): number[] {
  return Array.from({ length: n }, (_, k) => ((k + 0.5) * loop) / n);
}

async function expectExact(
  scene: Scene,
  r: DepthEpochResult,
  times: readonly number[],
  view: View,
): Promise<void> {
  for (const t of times) {
    expect(inApprox(r, t), `t=${t} approximate`).toBe(false);
    const c = await check(scene, r, t, view);
    expect(c.fraction, `t=${t}: ${c.mismatches} px differ`).toBeLessThanOrEqual(EXACT);
    expect(c.worstItem, `t=${t}: worst item share`).toBeLessThanOrEqual(ITEM_CAP);
  }
}

/** Per-item cap on wrong pixels (share of that item's reference pixels). */
const ITEM_CAP = 0.01;

const solidBox = { solid: true, fills: true } as const;

// Piston rising out of a STATIC block through its top face (§9.5), and back.
const piston: Scene = {
  items: [
    { key: "e/block", path: "e/block", box: box(0, 0, 0, 4, 4, 2), solid: true, fills: true },
    { key: "e/piston", path: "e/piston", box: box(1, 1, 0.5, 2, 2, 1.3), solid: true, fills: true },
  ],
  moves: [
    { path: "e/piston", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, 2), easing: "ease-in-out" },
    { path: "e/piston", t0: 1, t1: 2, from: v(0, 0, 0), to: v(0, 0, -2), easing: "linear" },
  ],
  loop: 2,
};

describe("clip frames (§9.4, §9.5)", () => {
  it("piston leaving a static block: clip on the block, visible section intact at every sample", async () => {
    const r = solve(piston);
    expect(r.clips).toEqual([
      expect.objectContaining({ item: "e/piston", solid: "e/block", axis: "z" }),
    ]);
    expect(r.items.find((x) => x.item === "e/piston")!.clips![0]!.solid).toBe("e/block");
    const view = viewOf(piston, [0, 1], 2);
    const p = indexOf(piston, "e/piston");
    for (const t of samples(2, 12)) {
      const c = await check(piston, r, t, view);
      expect(c.fraction, `t=${t}`).toBeLessThanOrEqual(EXACT);
      // Whatever of the piston the z-buffer shows, the painter shows too.
      expect(Math.abs(count(c.got, p) - count(c.ref, p))).toBeLessThanOrEqual(
        0.02 * count(c.ref, p) + 40,
      );
    }
  });

  it("regression: the same clip placed inside the leaf's own motion group FAILS the z-buffer", async () => {
    const r = solve(piston);
    const view = viewOf(piston, [0, 1], 2);
    let worst = 0;
    for (const t of samples(2, 12)) {
      const c = await check(piston, r, t, view, { clipMode: "motion" });
      worst = Math.max(worst, c.fraction);
    }
    expect(worst).toBeGreaterThan(0.01);
  });

  it("without the clip the piston would show through the block (the clip is needed)", async () => {
    const r = solve(piston);
    const view = viewOf(piston, [0, 1], 2);
    const c = await check(piston, r, 0.4, view, { clipMode: "none" });
    expect(c.fraction).toBeGreaterThan(0.01);
  });

  it("valves pulled out of a static head", async () => {
    const items: DepthItemInput[] = [
      { key: "e/head", path: "e/head", box: box(0, 0, 0, 4, 2, 1), solid: true, fills: true },
    ];
    const moves: LoopMove[] = [];
    for (let k = 0; k < 3; k++) {
      const key = `e/valve-${k}`;
      items.push({
        key,
        path: key,
        box: box(0.5 + 1.2 * k, 0.85, 0.3, 0.3, 0.3, 1.1),
        solid: true,
        fills: true,
        inserts: "e/head",
      });
      moves.push({
        path: key,
        t0: 0.2 * k,
        t1: 0.2 * k + 1,
        from: v(0, 0, 0),
        to: v(0, 0, 1.5),
        easing: "ease-out",
      });
      moves.push({
        path: key,
        t0: 2,
        t1: 3,
        from: v(0, 0, 0),
        to: v(0, 0, -1.5),
        easing: "ease-in",
      });
    }
    const scene: Scene = { items, moves, loop: 3 };
    const r = solve(scene);
    expect(r.clips.map((c) => [c.item, c.solid])).toEqual([
      ["e/valve-0", "e/head"],
      ["e/valve-1", "e/head"],
      ["e/valve-2", "e/head"],
    ]);
    await expectExact(scene, r, samples(3, 10), viewOf(scene, [0, 1.5], 2));
  });

  it("valves inserted in a head that lifts: partHost carries the head's track, relative motion zero", async () => {
    const items: DepthItemInput[] = [
      { key: "e/block", path: "e/block", box: box(0, 0, 0, 4, 2, 1.5), solid: true, fills: true },
      {
        key: "e/head/casting",
        path: "e/head/casting",
        box: box(0, 0, 1.5, 4, 2, 0.8),
        solid: true,
        fills: true,
      },
    ];
    for (let k = 0; k < 3; k++) {
      items.push({
        key: `e/head/valve-${k}`,
        path: `e/head/valve-${k}`,
        box: box(0.6 + 1.2 * k, 0.85, 1.8, 0.3, 0.3, 0.9),
        solid: true,
        fills: true,
        inserts: "e/head/casting",
      });
    }
    const scene: Scene = {
      items,
      moves: [
        { path: "e/head", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, 1.5), easing: "ease-in-out" },
        {
          path: "e/head",
          t0: 1,
          t1: 2,
          from: v(0, 0, 0),
          to: v(0, 0, -1.5),
          easing: "ease-in-out",
        },
      ],
      loop: 2,
    };
    const r = solve(scene);
    for (let k = 0; k < 3; k++) {
      const c = r.clips.find((x) => x.item === `e/head/valve-${k}`)!;
      expect(c.solid).toBe("e/head/casting");
      for (const t of [0.3, 1.2]) {
        // Motion relative to the host is zero: the valve rides on partHost alone.
        expect(displacementAt(scene.moves, `e/head/valve-${k}`, t)).toEqual(
          displacementAt(scene.moves, "e/head/casting", t),
        );
      }
    }
    await expectExact(scene, r, samples(2, 8), viewOf(scene, [0, 1], 2));
  });

  describe("nested inserts: a valve in a head inserted in a block, on a moving pallet", () => {
    // The pallet (`e`) slides +x while the head lifts out of the block's recess; the head's
    // casting is clipped at the block, the valves at the casting. A valve's partHost must carry
    // the casting's TOTAL track (its own host, the block's pallet slide, plus its lift).
    const items: DepthItemInput[] = [
      { key: "e/block", path: "e/block", box: box(0, 0, 0, 4, 2, 2), solid: true, fills: true },
      {
        key: "e/head/casting",
        path: "e/head/casting",
        box: box(0.5, 0.5, 1.5, 3, 1, 1),
        solid: true,
        fills: true,
        inserts: "e/block",
      },
    ];
    for (let k = 0; k < 2; k++) {
      items.push({
        key: `e/head/valve-${k}`,
        path: `e/head/valve-${k}`,
        box: box(1.2 + 1.2 * k, 0.85, 2.0, 0.3, 0.3, 0.9),
        solid: true,
        fills: true,
        inserts: "e/head/casting",
      });
    }
    const scene: Scene = {
      items,
      moves: [
        { path: "e", t0: 0, t1: 2, from: v(0, 0, 0), to: v(3, 0, 0), easing: "linear" },
        { path: "e/head", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, 1.2), easing: "ease-out" },
        { path: "e/head", t0: 1, t1: 2, from: v(0, 0, 0), to: v(0, 0, -1.2), easing: "ease-in" },
      ],
      loop: 2,
    };
    const r = solve(scene);
    const view = viewOf(scene, [0, 0.5, 1, 1.5, 2], 2);

    it("clips chain: valves at the casting, the casting at the block", () => {
      expect(r.clips.map((c) => [c.item, c.solid])).toEqual([
        ["e/head/casting", "e/block"],
        ["e/head/valve-0", "e/head/casting"],
        ["e/head/valve-1", "e/head/casting"],
      ]);
    });

    it("with the casting's total track on partHost the frames match the z-buffer", async () => {
      await expectExact(scene, r, samples(2, 8), view);
    });

    it("with only the casting's own relative motion (no pallet slide) they do not", async () => {
      const relOnly = (solid: string, t: number): Vec3 => {
        const d = displacementAt(scene.moves, solid, t);
        if (solid !== "e/head/casting") return d;
        const host = displacementAt(scene.moves, "e/block", t);
        return { x: d.x - host.x, y: d.y - host.y, z: d.z - host.z };
      };
      let worst = 0;
      for (const t of samples(2, 8))
        worst = Math.max(worst, (await check(scene, r, t, view, { host: relOnly })).fraction);
      expect(worst).toBeGreaterThan(0.005);
    });
  });

  describe("clip validity: a piston that slides sideways once clear (two copies, §9.5, A1-2c)", () => {
    const scene: Scene = {
      items: piston.items,
      moves: [
        { path: "e/piston", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, 3), easing: "linear" },
        { path: "e/piston", t0: 1, t1: 2, from: v(0, 0, 0), to: v(3, 0, 0), easing: "linear" },
        { path: "e/piston", t0: 2, t1: 3, from: v(0, 0, 0), to: v(-3, 0, 0), easing: "linear" },
        { path: "e/piston", t0: 3, t1: 4, from: v(0, 0, 0), to: v(0, 0, -3), easing: "linear" },
      ],
      loop: 4,
    };
    const r = solve(scene);
    const view = viewOf(scene, [0, 1, 2], 2);
    const p = indexOf(scene, "e/piston");

    it("a clipped copy while it crosses, an unclipped one for the slide; no fallback", () => {
      // one clip for the crossing window [0, 1] ∪ [3, 4] (z only, one footprint): copy 0
      expect(r.clips).toEqual([
        expect.objectContaining({ item: "e/piston", solid: "e/block", axis: "z" }),
      ]);
      expect(r.items.find((x) => x.item === "e/piston")).toEqual({
        item: "e/piston",
        path: "e/piston",
        copies: 2,
        clips: { 0: { clip: r.clips[0]!.clip, solid: "e/block" } },
      });
      expect(r.stats.copies).toBe(1);
      expect(r.diagnostics.map((d) => d.code)).toEqual([]);
      expect(r.approximate).toEqual([]);
      // the copies swap at the window's ends (t = 1, 3), where the piston is clear of the deck;
      // inside the block (its top below the deck) it is hidden
      const at = (t: number): readonly string[] => epochAt(r, t).order;
      expect(at(0.03)).toEqual(["e/block"]);
      for (const t of [0.5, 0.999, 3.001, 3.5]) expect(at(t)).toEqual(["e/block", "e/piston"]);
      for (const t of [1.001, 2, 2.999]) expect(at(t)).toEqual(["e/block", "e/piston__c1"]);
      expect(at(3.97)).toEqual(["e/block"]);
      expect(r.order).toEqual(["e/block", "e/piston", "e/piston__c1"]);
    });

    it("exact at every sample, while crossing and on both sides of each swap", async () => {
      // t = 0.3: top above the deck, bottom still inside (Phase 1b hid it until clear)
      const crossing = await check(scene, r, 0.3, view);
      expect(count(crossing.ref, p)).toBeGreaterThan(100);
      expect(Math.abs(count(crossing.got, p) - count(crossing.ref, p))).toBeLessThanOrEqual(
        0.02 * count(crossing.ref, p) + 40,
      );
      await expectExact(
        scene,
        r,
        [0.3, 0.8, 0.999, 1.001, 1.5, 2.5, 2.999, 3.001, 3.2, 3.7, ...samples(4, 8)],
        view,
      );
    });

    it("controls: the clip on every copy cuts the slide; no clip shows it through the block", async () => {
      const all = await check(scene, r, 1.5, view, { clipEveryCopy: true });
      expect(all.fraction).toBeGreaterThan(0.01);
      const none = await check(scene, r, 0.3, view, { clipMode: "none" });
      expect(none.fraction).toBeGreaterThan(0.01);
    });

    it("over the pair budget: no two-copy candidates (budget/time), hidden while it crosses", () => {
      const b = depthEpochs(scene.items, scene.moves, scene.loop, {
        budgets: { maxPairChecks: 1 },
      });
      expect(b.clips).toEqual([]);
      expect(b.stats.copies).toBe(0);
      const w = b.diagnostics.find(
        (d) => d.code === "budget/time" && d.message.includes("two-copy clip candidates"),
      )!;
      expect(w.severity).toBe("warning");
      // piston in block and block in piston: both directions are candidates
      expect(w.params).toMatchObject({ candidates: 2 });
    });

    it("a cylinder (does not fill its box) is not split: hidden while it crosses, named", async () => {
      const cyl: Scene = {
        ...scene,
        items: [
          scene.items[0]!,
          { ...scene.items[1]!, fills: false },
        ],
        zcyl: ["e/piston"],
      };
      const c = solve(cyl);
      expect(c.clips).toEqual([]);
      expect(c.stats.copies).toBe(0);
      expect(c.diagnostics.map((d) => d.code)).toContain("assembly/clip-fallback");
      const v = viewOf(cyl, [0, 1, 2], 2);
      expect(count((await check(cyl, c, 0.3, v)).got, p)).toBe(0);
      await expectExact(cyl, c, [0.8, 1.5, 2.5, 3.2], v);
    });

    it("no second copy when the block is weak-behind the piston (flush corner, §9.5)", async () => {
      // the piston sits in the block's +x+y corner (flush) and already crosses the deck at rest,
      // so the block never passes a hidden face of the piston in the crossing window:
      // block < piston is exact without a clip, and no copy is made
      const corner: Scene = {
        items: [
          scene.items[0]!,
          { key: "e/piston", path: "e/piston", box: box(2, 2, 1, 2, 2, 1.5), ...solidBox },
        ],
        moves: scene.moves,
        loop: 4,
      };
      const c = solve(corner);
      expect(c.clips).toEqual([]);
      expect(c.stats.copies).toBe(0);
      expect(c.diagnostics).toEqual([]);
      await expectExact(corner, c, [0.3, 0.6, 1.5, 2.5, 3.4], viewOf(corner, [0, 1, 2], 2));
    });

    it("beyond the copy budget: hidden while it crosses (fallback), budget/depth-copies", async () => {
      const b = depthEpochs(scene.items, scene.moves, scene.loop, {
        budgets: { maxCopyRatio: 0 },
      });
      expect(b.clips).toEqual([]);
      expect(b.stats.copies).toBe(0);
      const w = b.diagnostics.find((d) => d.code === "budget/depth-copies")!;
      expect(w.severity).toBe("warning");
      expect(w.params).toEqual({ limit: 0, items: 2, hidden: 1 });
      expect(b.diagnostics.map((d) => d.code)).toContain("assembly/clip-fallback");
      const c = await check(scene, b, 0.3, view);
      expect(count(c.got, p)).toBe(0);
      await expectExact(scene, b, [0.8, 1.5, 2.5, 3.2], view);
    });
  });
});

describe("clip switch at the face plane (§9.5, C-Q08/C-Q09)", () => {
  it("the epoch boundary is the analytic crossing time: hidden just before, visible just after", () => {
    // Linear lift by 2 over [0, 1]: the piston's top (1.8) reaches the deck (2) at t = 0.1.
    const scene: Scene = {
      items: piston.items,
      moves: [
        { path: "e/piston", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, 2), easing: "linear" },
        { path: "e/piston", t0: 1, t1: 2, from: v(0, 0, 0), to: v(0, 0, -2), easing: "linear" },
      ],
      loop: 2,
    };
    const r = solve(scene);
    expect(r.approximate).toEqual([]);
    expect(r.epochs.some((e) => Math.abs(e.t0 - 0.1) < 1e-9)).toBe(true);
    expect(r.epochs.some((e) => Math.abs(e.t0 - 1.9) < 1e-9)).toBe(true); // and on the way back
    expect(epochAt(r, 0.1 - 1e-4).order).not.toContain("e/piston");
    expect(epochAt(r, 0.1 + 1e-4).order).toContain("e/piston");
  });

  it("while still below the deck the piston is hidden; forcing it visible fails the z-buffer", async () => {
    const r = solve(piston);
    expect(epochAt(r, 0.083).order).not.toContain("e/piston");
    const view = viewOf(piston, [0, 1], 2);
    const right = await check(piston, r, 0.083, view);
    expect(right.fraction).toBeLessThanOrEqual(EXACT);
    const wrong = await check(piston, r, 0.083, view, { forceVisible: ["e/piston"] });
    expect(wrong.fraction).toBeGreaterThan(0.01); // its top face below the deck shows through
  });
});

describe("block-level insertion (§9.5, C-Q01)", () => {
  const solid = { solid: true, fills: true } as const;

  it("A: a seam pin straddling A = x[0,1] and B = x[1,2] is clipped at the block's top face", async () => {
    const scene: Scene = {
      items: [
        { key: "e/a", path: "e/a", box: box(0, 0, 0, 1, 1, 1), ...solid },
        { key: "e/b", path: "e/b", box: box(1, 0, 0, 1, 1, 1), ...solid },
        {
          key: "e/pin",
          path: "e/pin",
          box: box(0.8, 0.4, 0.3, 0.4, 0.2, 1.2),
          ...solid,
          inserts: "e/a",
        },
      ],
      moves: [
        { path: "e/pin", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, 1.5), easing: "ease-out" },
        { path: "e/pin", t0: 1, t1: 2, from: v(0, 0, 0), to: v(0, 0, -1.5), easing: "ease-in" },
      ],
      loop: 2,
    };
    const r = solve(scene);
    expect(r.clips).toHaveLength(1);
    const c = r.clips[0]!;
    expect([c.item, c.solid, c.axis]).toEqual(["e/pin", "e/a", "z"]);
    expect(c.prism.origin.z).toBeCloseTo(1, 9);
    expect(c.prism.origin.x).toBeCloseTo(0.8, 9);
    expect(c.prism.size.x).toBeCloseTo(0.4, 9); // the pin's footprint, across the seam
    expect(r.order.indexOf("e/a")).toBeLessThan(r.order.indexOf("e/pin"));
    expect(r.order.indexOf("e/b")).toBeLessThan(r.order.indexOf("e/pin")); // forced after both
    expect(r.diagnostics.map((d) => d.code)).toEqual([]);
    const view = viewOf(scene, [0, 1], 3);
    await expectExact(scene, r, samples(2, 10), view);
    // Without the clip the pin's lower part shows through the block (the block's pixels there
    // are wrong: a large share of the pin's footprint area on the block's top face).
    const none = await check(scene, r, 0.3, view, { clipMode: "none" });
    expect(none.fraction).toBeGreaterThan(10 * EXACT);
    expect(none.mismatches).toBeGreaterThan(50);
  });

  it("B: a pin through two stacked members z[0,1] and z[1,2] is clipped at the upper's top", async () => {
    const scene: Scene = {
      items: [
        { key: "e/lower", path: "e/lower", box: box(0, 0, 0, 2, 2, 1), ...solid },
        { key: "e/upper", path: "e/upper", box: box(0, 0, 1, 2, 2, 1), ...solid },
        { key: "e/pin", path: "e/pin", box: box(0.8, 0.8, 0.5, 0.4, 0.4, 2), ...solid },
      ],
      moves: [
        { path: "e/pin", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, 2.2), easing: "ease-in-out" },
        { path: "e/pin", t0: 1, t1: 2, from: v(0, 0, 0), to: v(0, 0, -2.2), easing: "ease-in-out" },
      ],
      loop: 2,
    };
    const r = solve(scene);
    expect(r.clips.map((c) => [c.item, c.solid, c.axis])).toEqual([["e/pin", "e/upper", "z"]]);
    expect(r.clips[0]!.prism.origin.z).toBeCloseTo(2, 9);
    const view = viewOf(scene, [0, 1], 3);
    await expectExact(scene, r, samples(2, 10), view);
    // A clip at the LOWER member's face (an internal face of the block) would show the pin
    // through the upper member.
    const atLower = (_: string, b: Box3): Box3 => ({
      origin: { ...b.origin, z: 1 },
      size: { ...b.size, z: b.size.z + 1 },
    });
    let worst = 0;
    for (const t of samples(2, 6))
      worst = Math.max(worst, (await check(scene, r, t, view, { prism: atLower })).fraction);
    expect(worst).toBeGreaterThan(0.01);
  });

  it("a head bolt through the cover into the casting, on a lifting head", async () => {
    const items: DepthItemInput[] = [
      { key: "e/block", path: "e/block", box: box(0, 0, 0, 4, 2, 1.5), ...solid },
      { key: "e/head/casting", path: "e/head/casting", box: box(0, 0, 1.5, 4, 2, 0.8), ...solid },
      {
        key: "e/head/cover",
        path: "e/head/cover",
        box: box(0.2, 0.2, 2.3, 3.6, 1.6, 0.6),
        ...solid,
      },
    ];
    for (let k = 0; k < 3; k++) {
      items.push({
        key: `e/head/bolt-${k}`,
        path: `e/head/bolt-${k}`,
        box: box(0.6 + 1.1 * k, 0.9, 1.9, 0.2, 0.2, 1.3),
        ...solid,
        inserts: "e/head/cover",
      });
    }
    const scene: Scene = {
      items,
      moves: [
        { path: "e/head", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, 1.5), easing: "ease-in-out" },
        {
          path: "e/head",
          t0: 1,
          t1: 2,
          from: v(0, 0, 0),
          to: v(0, 0, -1.5),
          easing: "ease-in-out",
        },
      ],
      loop: 2,
    };
    const r = solve(scene);
    for (let k = 0; k < 3; k++) {
      const c = r.clips.find((x) => x.item === `e/head/bolt-${k}`)!;
      expect([c.solid, c.axis]).toEqual(["e/head/cover", "z"]);
      expect(c.prism.origin.z).toBeCloseTo(2.9, 9); // the BLOCK's exit face: the cover's top
      expect(r.order.indexOf("e/head/casting")).toBeLessThan(r.order.indexOf(`e/head/bolt-${k}`));
      expect(r.order.indexOf("e/head/cover")).toBeLessThan(r.order.indexOf(`e/head/bolt-${k}`));
    }
    expect(r.diagnostics.map((d) => d.code)).toEqual([]);
    await expectExact(scene, r, samples(2, 8), viewOf(scene, [0, 1], 2));
  });

  it("crossing faces of two different blocks: hidden while it crosses, clip-fallback", () => {
    const r = depthEpochs(
      [
        { key: "a", box: box(0, 0, 0, 1, 1, 1), ...solid },
        { key: "b", box: box(1.2, 0, 0, 1, 1, 1), ...solid },
        { key: "pin", box: box(0.8, 0.4, 0.3, 0.6, 0.2, 1), ...solid },
      ],
      [],
      1,
    );
    expect(r.clips).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toContain("assembly/clip-fallback");
    expect(r.epochs[0]!.order).not.toContain("pin");
    expect(r.epochs[0]!.order).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("a seam pin whose block comes apart in the loop: no clip, hidden while it crosses", () => {
    const scene: Scene = {
      items: [
        { key: "e/a", path: "e/a", box: box(0, 0, 0, 1, 1, 1), ...solid },
        { key: "e/b", path: "e/b", box: box(1, 0, 0, 1, 1, 1), ...solid },
        { key: "e/pin", path: "e/a/pin", box: box(0.8, 0.4, 0.3, 0.4, 0.2, 1.2), ...solid },
      ],
      moves: [
        { path: "e/b", t0: 1, t1: 2, from: v(0, 0, 0), to: v(2, 0, 0), easing: "linear" },
        { path: "e/b", t0: 3, t1: 4, from: v(0, 0, 0), to: v(-2, 0, 0), easing: "linear" },
      ],
      loop: 4,
    };
    const r = solve(scene);
    expect(r.clips).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toContain("assembly/clip-fallback");
    for (const t of [0.5, 2.5, 3.5]) expect(epochAt(r, t).order).not.toContain("e/pin");
  });
});

describe("solids that do not fill their box (E-Q02)", () => {
  // A z-cylinder (inscribed in [0,2]³) and a bar through its bottom near the +x+y corner:
  // part of the bar is inside the cylinder, part is in the box corner in FRONT of it.
  const scene = (fills: boolean): Scene => ({
    items: [
      { key: "e/cyl", path: "e/cyl", box: box(0, 0, 0, 2, 2, 2), solid: true, fills },
      {
        key: "e/bar",
        path: "e/bar",
        box: box(1.45, 1.45, -0.5, 0.4, 0.4, 2),
        solid: true,
        fills: true,
      },
    ],
    moves: [
      { path: "e/bar", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, -3), easing: "linear" },
      { path: "e/bar", t0: 1, t1: 2, from: v(0, 0, 0), to: v(0, 0, 3), easing: "linear" },
    ],
    loop: 2,
    zcyl: ["e/cyl"],
  });

  it("a cylinder gives no weak-behind: approximate while crossing, exact once clear", async () => {
    const s = scene(false);
    const r = solve(s);
    expect(inApprox(r, 0.1)).toBe(true);
    const view = viewOf(s, [0, 1], 2);
    await expectExact(s, r, [0.75, 1.25], view);
  });

  it("control: treating the cylinder as a box certifies a wrong order", async () => {
    const s = scene(true);
    const r = solve(s);
    expect(inApprox(r, 0.1)).toBe(false);
    const c = await check(s, r, 0.1, viewOf(s, [0, 1], 2));
    expect(c.fraction).toBeGreaterThan(0.005); // the bar's corner in front is painted over
  });
});

describe("phase thinning keeps instant moves as cuts (E-Q01, E-Q09)", () => {
  it("a zero-length snap inside a thinned phase stays exact", async () => {
    // b slides out [0,1], snaps INTO the housing at 2.5 (enclosed: hidden), snaps back at 3.5.
    const items: DepthItemInput[] = [
      { key: "h", box: box(3, 0, 0, 2, 2, 2), solid: true, fills: true },
      { key: "b", path: "b", box: box(0.5, 0.5, 0.5, 1, 1, 1), solid: true, fills: true },
    ];
    const moves: LoopMove[] = [
      { path: "b", t0: 0, t1: 1, from: v(0, 0, 0), to: v(1, 0, 0), easing: "linear" },
      { path: "b", t0: 2.5, t1: 2.5, from: v(0, 0, 0), to: v(2, 0, 0), easing: "linear" },
      { path: "b", t0: 3.5, t1: 3.5, from: v(0, 0, 0), to: v(-3, 0, 0), easing: "linear" },
    ];
    // Far-away dummies with many staggered moves force the phase budget to thin cuts.
    for (let k = 0; k < 20; k++) {
      items.push({ key: `d${k}`, path: `d${k}`, box: box(20 + 2 * k, 20, 0, 1, 1, 1) });
      for (let q = 0; q < 10; q++) {
        const t0 = 0.37 * q + 0.011 * k;
        moves.push({
          path: `d${k}`,
          t0,
          t1: t0 + 0.2,
          from: v(0, 0, 0),
          to: v(0, 0, 0.1),
          easing: "linear",
        });
      }
    }
    const scene: Scene = { items, moves, loop: 4 };
    const full = solve(scene);
    const thin = depthEpochs(items, moves, 4, { budgets: { maxPhaseWork: 4 * 700 * 12 } });
    expect(thin.diagnostics.map((d) => d.code)).toContain("budget/time");
    expect(thin.stats.phases).toBeLessThan(full.stats.phases);
    for (const r of [full, thin]) {
      expect(epochAt(r, 2.4).order).toContain("b");
      expect(epochAt(r, 2.6).order).not.toContain("b");
      expect(epochAt(r, 3.6).order).toContain("b");
    }
    const view = viewOf({ ...scene, items: items.slice(0, 2) }, [0, 1, 2.6], 2);
    const near: Scene = { items: items.slice(0, 2), moves: moves.slice(0, 3), loop: 4 };
    // Every non-approximate sampled frame of the thinned run matches the z-buffer.
    const projected: DepthEpochResult = {
      ...thin,
      order: thin.order.filter((k) => k === "h" || k === "b"),
      epochs: thin.epochs.map((e) => ({
        ...e,
        order: e.order.filter((k) => k === "h" || k === "b"),
      })),
    };
    for (const t of [0.5, 1.5, 2.4, 2.6, 3.0, 3.6]) {
      if (inApprox(thin, t)) continue;
      const c = await check(near, projected, t, view);
      expect(c.fraction, `t=${t}`).toBeLessThanOrEqual(EXACT);
    }
  });
});

describe("§9.7 scenes and the engine match the z-buffer", () => {
  it("rack drawer: no post drawn over the pulled device", { timeout: 60_000 }, async () => {
    const s = rackDrawer();
    await expectExact(s, solve(s), samples(s.loop, 10), viewOf(s, [0, 1, 2], 1));
  });

  it("server internals on a pulled drawer", { timeout: 60_000 }, async () => {
    const s = serverInternals();
    await expectExact(s, solve(s), samples(s.loop, 8), viewOf(s, [0, 1], 2));
  });

  it("build drop", { timeout: 60_000 }, async () => {
    const s = buildDrop();
    await expectExact(s, solve(s), samples(s.loop, 8), viewOf(s, [0, 1, 2, 3, 4], 2));
  });

  it(
    "engine: pistons cut at the deck, valves at the casting, crank out the bottom",
    { timeout: 120_000 },
    async () => {
      const s = engine();
      const r = solve(s);
      const times = [1, 2.4, 3.5, 4.7, 6, 7.3, 7.8, 8.6, 10, 11.7, 12.6, 13.6, 15.2];
      await expectExact(s, r, times, viewOf(s, [0, 3, 6, 9, 12, 15], 2));
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Randomized property test
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EASE = ["linear", "ease", "ease-in", "ease-out", "ease-in-out"] as const;

/** Random boxes in distinct grid cells and random concurrent moves; rejected if any pose collides. */
function randomScene(rand: () => number): Scene | undefined {
  const cells: [number, number, number][] = [];
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 3; y++) for (let z = 0; z < 2; z++) cells.push([x, y, z]);
  for (let k = cells.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [cells[k], cells[j]] = [cells[j]!, cells[k]!];
  }
  const n = 4 + Math.floor(rand() * 5);
  const items: DepthItemInput[] = [];
  const moves: LoopMove[] = [];
  const loop = 4;
  for (let k = 0; k < n; k++) {
    const [cx, cy, cz] = cells[k]!;
    const sx = 0.4 + 0.6 * rand();
    const sy = 0.4 + 0.6 * rand();
    const sz = 0.3 + 0.6 * rand();
    const group = rand() < 0.4 ? "g/" : "";
    const key = `${group}p${k}`;
    items.push({
      key,
      path: key,
      box: box(cx * 1.2, cy * 1.2, cz * 1.2, sx, sy, sz),
      solid: true,
      fills: true,
    });
    const m = Math.floor(rand() * 3);
    for (let q = 0; q < m; q++) {
      const axis = Math.floor(rand() * 3);
      const d = (rand() < 0.5 ? -1 : 1) * (0.5 + 2 * rand());
      const t0 = rand() * 3;
      const t1 = Math.min(loop, t0 + 0.3 + rand() * 1.5);
      const off = [0, 0, 0];
      off[axis] = d;
      moves.push({
        path: key,
        t0,
        t1,
        from: v(0, 0, 0),
        to: v(off[0]!, off[1]!, off[2]!),
        easing: EASE[Math.floor(rand() * 5)]!,
      });
    }
  }
  if (items.some((i) => i.key.startsWith("g/"))) {
    const t0 = rand() * 2;
    moves.push({
      path: "g",
      t0,
      t1: t0 + 1.5,
      from: v(0, 0, 0),
      to: v(0, 0, 1.5 + rand()),
      easing: "ease-in-out",
    });
  }
  // Reject scenes in which any two boxes interpenetrate at a sampled pose.
  for (let k = 0; k <= 200; k++) {
    const t = (loop * k) / 200;
    const posed = items.map((i) => {
      const d = displacementAt(moves, i.path, t);
      return shift(toBounds(i.box), [d.x, d.y, d.z]);
    });
    for (let a = 0; a < posed.length; a++) {
      for (let b = a + 1; b < posed.length; b++)
        if (interpenetrates(posed[a]!, posed[b]!)) return undefined;
    }
  }
  return { items, moves, loop };
}

/**
 * Random housings (one box, or two touching halves: a block) with parts nested inside that
 * leave through one face (+z, −z, +y, −y; visible faces need a clip, hidden faces weak-behind),
 * a part across the seam when split, and free boxes around. Rejected when anything but a part
 * and its housing interpenetrates at a sampled pose.
 */
function nestedScene(rand: () => number): Scene | undefined {
  const occ = { solid: true, fills: true } as const;
  const split = rand() < 0.5;
  const items: DepthItemInput[] = split
    ? [
        { key: "h/a", path: "h/a", box: box(0, 0, 0, 2, 1.6, 1.4), ...occ },
        { key: "h/b", path: "h/b", box: box(2, 0, 0, 2, 1.6, 1.4), ...occ },
      ]
    : [{ key: "h/a", path: "h/a", box: box(0, 0, 0, 4, 1.6, 1.4), ...occ }];
  const housing = new Set(items.map((i) => i.key));
  const moves: LoopMove[] = [];
  const parts = 1 + Math.floor(rand() * 3);
  for (let k = 0; k < parts; k++) {
    const w = 0.5 + 0.4 * rand();
    const x0 = 0.7 + 1.3 * k - w / 2;
    const dy = 0.4 + 0.4 * rand();
    const y0 = 0.3 + (1 - dy) * rand();
    const dz = 0.3 + 0.5 * rand();
    const z0 = 0.2 + (1 - dz) * rand();
    const key = `p${k}`;
    items.push({ key, path: key, box: box(x0, y0, z0, w, dy, dz), ...occ });
    const dir = Math.floor(rand() * 4);
    const extra = 0.2 + 0.6 * rand();
    const d =
      dir === 0
        ? v(0, 0, 1.4 - z0 + extra)
        : dir === 1
          ? v(0, 0, -(z0 + dz + extra))
          : dir === 2
            ? v(0, 1.6 - y0 + extra, 0)
            : v(0, -(y0 + dy + extra), 0);
    const t0 = 1.5 * rand();
    const dur = 0.6 + 0.6 * rand();
    const ease = EASE[Math.floor(rand() * 5)]!;
    moves.push({ path: key, t0, t1: t0 + dur, from: v(0, 0, 0), to: d, easing: ease });
    moves.push({
      path: key,
      t0: t0 + 2,
      t1: t0 + 2 + dur,
      from: v(0, 0, 0),
      to: v(-d.x, -d.y, -d.z),
      easing: ease,
    });
  }
  const free = Math.floor(rand() * 3);
  for (let k = 0; k < free; k++) {
    const key = `f${k}`;
    const y = rand() < 0.5 ? -2 : 2.6;
    items.push({ key, path: key, box: box(4 * rand(), y, 2 * rand(), 0.6, 0.6, 0.6), ...occ });
    const t0 = 3 * rand();
    moves.push({
      path: key,
      t0,
      t1: t0 + 1,
      from: v(0, 0, 0),
      to: v((rand() - 0.5) * 4, 0, 0),
      easing: "ease",
    });
  }
  const loop = 4.6;
  for (let q = 0; q <= 200; q++) {
    const t = (loop * q) / 200;
    const posed = items.map((i) => {
      const dd = displacementAt(moves, i.path, t);
      return shift(toBounds(i.box), [dd.x, dd.y, dd.z]);
    });
    for (let a = 0; a < posed.length; a++) {
      for (let b = a + 1; b < posed.length; b++) {
        const pair = [items[a]!.key, items[b]!.key];
        if (pair.some((k) => housing.has(k)) && pair.some((k) => k.startsWith("p"))) continue;
        if (interpenetrates(posed[a]!, posed[b]!)) return undefined;
      }
    }
  }
  return { items, moves, loop };
}

describe("depth copies (§9.4, A1-2b)", () => {
  // a starts under b, moves out beside it, rises and comes back above it, then returns the same
  // way: a before b, then b before a (copy 1 of a), then a before b again (copy 0 reused).
  const swap: Scene = {
    items: [
      { key: "a", path: "a", box: box(0, 0, 0, 1, 1, 0.9), solid: true, fills: true },
      { key: "b", path: "b", box: box(0, 0, 1, 1, 1, 1), solid: true, fills: true },
    ],
    moves: [
      { path: "a", t0: 0, t1: 1, from: v(0, 0, 0), to: v(1.5, 0, 0), easing: "ease-in-out" },
      { path: "a", t0: 1, t1: 2, from: v(0, 0, 0), to: v(0, 0, 2.2), easing: "linear" },
      { path: "a", t0: 2, t1: 3, from: v(0, 0, 0), to: v(-1.5, 0, 0), easing: "ease" },
      { path: "a", t0: 3, t1: 4, from: v(0, 0, 0), to: v(1.5, 0, 0), easing: "ease" },
      { path: "a", t0: 4, t1: 5, from: v(0, 0, 0), to: v(0, 0, -2.2), easing: "linear" },
      { path: "a", t0: 5, t1: 6, from: v(0, 0, 0), to: v(-1.5, 0, 0), easing: "ease-in-out" },
    ],
    loop: 6,
  };

  it("exact at every sample and on both sides of every swap; one copy", async () => {
    const r = solve(swap);
    expect(r.stats.copies).toBe(1);
    expect(r.approximate).toEqual([]);
    const view = viewOf(swap, samples(6, 12), 2);
    const swaps = r.epochs.slice(1).map((e) => e.t0);
    expect(swaps).toHaveLength(2);
    const times = [...samples(6, 12), ...swaps.flatMap((t) => [t - 1e-3, t, t + 1e-3])];
    await expectExact(swap, r, times, view);
  });

  it("the comparison is sensitive: the merged order (no copy) is wrong in some epoch", async () => {
    const merged = depthEpochs(swap.items, swap.moves, swap.loop, {
      budgets: { maxCopyRatio: 0 },
    });
    expect(merged.diagnostics.map((d) => d.code)).toContain("budget/depth-copies");
    const view = viewOf(swap, samples(6, 12), 2);
    let worst = 0;
    for (const t of samples(6, 12))
      worst = Math.max(worst, (await check(swap, merged, t, view)).fraction);
    expect(worst).toBeGreaterThan(0.01);
  });
});

describe("randomized property: painter's order of sampled frames vs z-buffer", () => {
  it(
    "free boxes: exact (≤ EXACT, per-item cap) except approximate epochs",
    { timeout: 180_000 },
    async () => {
      const rand = mulberry32(0xa12a);
      let scenes = 0;
      let frames = 0;
      let skipped = 0;
      let worst = 0;
      let copies = 0;
      for (let attempt = 0; attempt < 400 && scenes < 40; attempt++) {
        const s = randomScene(rand);
        if (!s) continue;
        scenes++;
        const r = solve(s);
        copies += r.stats.copies;
        const view = viewOf(s, samples(s.loop, 9), 1);
        for (const t of samples(s.loop, 6)) {
          if (inApprox(r, t)) {
            skipped++;
            continue;
          }
          const c = await check(s, r, t, view);
          frames++;
          worst = Math.max(worst, c.fraction);
          expect(c.fraction, `scene ${scenes} t=${t}`).toBeLessThanOrEqual(EXACT);
          expect(c.worstItem, `scene ${scenes} t=${t}`).toBeLessThanOrEqual(ITEM_CAP);
        }
      }
      console.info(
        `property (free): ${scenes} scenes, ${frames} frames, ${skipped} approximate skipped, ${copies} depth copies, worst ${(worst * 100).toFixed(4)}% of covered px`,
      );
      expect(scenes).toBe(40);
      expect(copies).toBeGreaterThan(0); // the painter draws copies (A1-2b)
      expect(frames).toBeGreaterThan(150);
    },
  );

  it(
    "nested: parts in housings and split blocks (enclosure, unions, clips): exact except approximate",
    { timeout: 240_000 },
    async () => {
      const rand = mulberry32(0x5eed);
      let scenes = 0;
      let frames = 0;
      let skipped = 0;
      let worst = 0;
      let clips = 0;
      let blockClips = 0;
      let splitScenes = 0;
      let hiddenFrames = 0;
      for (let attempt = 0; attempt < 600 && scenes < 40; attempt++) {
        const s = nestedScene(rand);
        if (!s) continue;
        scenes++;
        if (s.items.some((i) => i.key === "h/b")) splitScenes++;
        const r = solve(s);
        clips += r.clips.length;
        blockClips += r.clips.filter((c) => {
          const p = s.items.find((i) => i.key === c.item)!;
          return (
            p.box.origin.x < 2 &&
            p.box.origin.x + p.box.size.x > 2 &&
            s.items.some((i) => i.key === "h/b")
          );
        }).length;
        expect(r.diagnostics.map((d) => d.code)).not.toContain("assembly/clip-fallback");
        const view = viewOf(s, samples(s.loop, 9), 1);
        for (const t of samples(s.loop, 6)) {
          if (inApprox(r, t)) {
            skipped++;
            continue;
          }
          const c = await check(s, r, t, view);
          frames++;
          if (s.items.some((i) => i.key.startsWith("p") && !epochAt(r, t).order.includes(i.key)))
            hiddenFrames++;
          worst = Math.max(worst, c.fraction);
          expect(c.fraction, `scene ${scenes} t=${t}`).toBeLessThanOrEqual(EXACT);
          expect(c.worstItem, `scene ${scenes} t=${t}`).toBeLessThanOrEqual(ITEM_CAP);
        }
      }
      console.info(
        `property (nested): ${scenes} scenes (${splitScenes} split), ${frames} frames, ${skipped} approximate skipped, ` +
          `${clips} clips (${blockClips} across a seam), ${hiddenFrames} frames with an enclosed part, worst ${(worst * 100).toFixed(4)}%`,
      );
      expect(scenes).toBe(40);
      expect(splitScenes).toBeGreaterThan(10);
      expect(clips).toBeGreaterThan(15);
      expect(blockClips).toBeGreaterThan(2);
      expect(hiddenFrames).toBeGreaterThan(20);
      expect(frames).toBeGreaterThan(150);
    },
  );

  it(
    "the comparison is sensitive: the reversed order fails on the same scenes",
    { timeout: 120_000 },
    async () => {
      const rand = mulberry32(0xa12a);
      let failing = 0;
      let scenes = 0;
      for (let attempt = 0; attempt < 400 && scenes < 10; attempt++) {
        const s = randomScene(rand);
        if (!s) continue;
        scenes++;
        const r = solve(s);
        const wrong: DepthEpochResult = {
          ...r,
          order: [...r.order].reverse(),
          epochs: r.epochs.map((e) => ({ ...e, order: [...e.order].reverse() })),
        };
        const view = viewOf(s, samples(s.loop, 9), 1);
        for (const t of samples(s.loop, 3)) {
          if ((await check(s, wrong, t, view)).fraction > 0.005) failing++;
        }
      }
      expect(failing).toBeGreaterThan(10);
    },
  );

  it(
    "pistons in a block: random lifts, staggers and sideways slides (clips, fallback, events)",
    { timeout: 180_000 },
    async () => {
      const rand = mulberry32(0x9e37);
      let frames = 0;
      let clipped = 0;
      let fallbacks = 0;
      let skippedCrossing = 0;
      for (let n = 0; n < 20; n++) {
        const items: DepthItemInput[] = [
          { key: "e/block", path: "e/block", box: box(0, 0, 0, 6, 2, 2), solid: true, fills: true },
        ];
        const moves: LoopMove[] = [];
        for (let k = 0; k < 3; k++) {
          const key = `e/p${k}`;
          const h = 0.6 + rand();
          const z = 2 - h - 0.3 * rand() + (rand() < 0.3 ? 0.4 : 0); // some start crossing the deck
          items.push({
            key,
            path: key,
            box: box(0.4 + 2 * k, 0.5, z, 1.2, 1, h),
            solid: true,
            fills: true,
          });
          const t0 = rand();
          const d = 2 - z + 0.1 + 1.5 * rand(); // clears the deck before any slide
          const ease = EASE[Math.floor(rand() * 5)]!;
          moves.push({ path: key, t0, t1: t0 + 1, from: v(0, 0, 0), to: v(0, 0, d), easing: ease });
          const slide = rand() < 0.35;
          if (slide)
            moves.push({
              path: key,
              t0: 2.2,
              t1: 2.8,
              from: v(0, 0, 0),
              to: v(0, -3, 0),
              easing: "linear",
            });
          moves.push({
            path: key,
            t0: 3 + t0,
            t1: 4 + t0,
            from: v(0, 0, 0),
            to: v(0, 0, -d),
            easing: ease,
          });
          if (slide)
            moves.push({
              path: key,
              t0: 2.8,
              t1: 2.95,
              from: v(0, 0, 0),
              to: v(0, 3, 0),
              easing: "linear",
            });
        }
        const s: Scene = { items, moves, loop: 5 };
        const r = solve(s);
        clipped += r.clips.length;
        fallbacks += r.diagnostics.filter((d) => d.code === "assembly/clip-fallback").length;
        const view = viewOf(s, samples(5, 11), 1);
        for (const t of samples(5, 7)) {
          if (inApprox(r, t)) continue;
          // The reported fallback deviation: an UNCLIPPED piston hidden while it actually crosses
          // the deck at t (C-Q04). Only those frames are skipped.
          const crossing = items.some((i) => {
            if (i.key === "e/block" || r.clips.some((c) => c.item === i.key)) return false;
            const z0 = i.box.origin.z + displacementAt(moves, i.path, t).z;
            return z0 < 2 - 1e-6 && z0 + i.box.size.z > 2 + 1e-6;
          });
          if (crossing) {
            skippedCrossing++;
            continue;
          }
          const c = await check(s, r, t, view);
          frames++;
          expect(c.fraction, `scene ${n} t=${t}`).toBeLessThanOrEqual(EXACT);
          expect(c.worstItem, `scene ${n} t=${t}`).toBeLessThanOrEqual(ITEM_CAP);
        }
      }
      expect(clipped).toBeGreaterThan(20);
      // sliding pistons get a clipped and an unclipped copy (A1-2c): nothing falls back
      expect(fallbacks).toBe(0);
      expect(skippedCrossing).toBe(0);
      expect(frames).toBeGreaterThan(60);
    },
  );
});

describe("copies for cycles across intervals and the group-derived static chain (A1-2c)", () => {
  const instant = (path: string, t: number, d: Vec3): LoopMove => ({
    path,
    t0: t,
    t1: t,
    from: v(0, 0, 0),
    to: d,
    easing: "linear",
  });
  const solid = { solid: true, fills: true } as const;

  it("a forced cycle that closes only across intervals: copies, exact; one order is not", async () => {
    // a in b's bottom face [0, 1), b in c's [1, 2), c in a's [2, 3): no pair flips
    const scene: Scene = {
      items: [
        { key: "a", path: "a", box: box(0, 0, -0.5, 1, 1, 1), ...solid },
        { key: "b", path: "b", box: box(0, 0, 0, 1, 1, 1), ...solid },
        { key: "c", path: "c", box: box(20, 20, 0, 1, 1, 1), ...solid },
      ],
      moves: [
        instant("a", 1, v(10, 10, 0)),
        instant("c", 1, v(-20, -20, 0.5)),
        instant("b", 2, v(20, 0, 0)),
        instant("a", 2, v(-10, -10, 1.5)),
      ],
      loop: 3,
    };
    const r = solve(scene);
    expect(r.stats.copyConflicts).toBe(0);
    expect(r.stats.copies).toBe(1);
    expect(r.diagnostics).toEqual([]);
    const times = [0.5, 1.5, 2.5];
    const view = viewOf(scene, times, 2);
    await expectExact(scene, r, times, view);
    const one = depthEpochs(scene.items, scene.moves, scene.loop, {
      budgets: { maxCopyRatio: 0 },
    });
    let worst = 0;
    for (const t of times) worst = Math.max(worst, (await check(scene, one, t, view)).fraction);
    expect(worst).toBeGreaterThan(0.01);
  });

  it("the static chain follows the groups: no chain-induced cycle", async () => {
    // s1 (a tall post, deepest centre) is behind a on x, a behind s2 on x; then a jumps behind
    // s1 and back. s1 and s2 never overlap on screen, so the loop-wide edges alone (a < s2)
    // release s2 before s1 (lower centre depth): with that chain, a's group order s1 < a < s2
    // closes a cycle through s2 < s1 and drops a certified edge. Derived from the groups, the
    // chain is s1 < s2 and every group is exact.
    const scene: Scene = {
      items: [
        { key: "a", path: "a", box: box(2, 0, 0, 1, 1, 1) },
        { key: "s1", box: box(1, 0, 0, 1, 1, 7) },
        { key: "s2", box: box(3, 0, 0, 1, 1, 1) },
      ],
      moves: [instant("a", 1, v(-2, 0, 0)), instant("a", 2, v(2, 0, 0))],
      loop: 3,
    };
    const r = solve(scene);
    expect(r.diagnostics).toEqual([]);
    expect(r.approximate).toEqual([]);
    expect(r.stats.cycleDrops).toBe(0);
    expect(r.epochs.map((e) => e.order)).toEqual([
      ["s1", "a", "s2"],
      ["a__c1", "s1", "s2"],
      ["s1", "a", "s2"],
    ]);
    const times = [0.5, 1.5, 2.5];
    await expectExact(scene, r, times, viewOf(scene, times, 2));
  });
});
