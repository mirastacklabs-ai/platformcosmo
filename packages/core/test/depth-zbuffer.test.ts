/**
 * Clip and order correctness against a per-pixel z-buffer (see `depth-zbuffer.ts`): painter
 * frames are real SVG rendered by resvg; the reference is an exact ray cast of the same boxes.
 */
import { describe, expect, it, vi } from "vitest";
import type { Vec3 } from "../src/contracts/index.js";
import type { DepthEpochResult, DepthItemInput, LoopMove } from "../src/depth/epochs.js";
import { depthEpochs, displacementAt } from "../src/depth/epochs.js";
import { interpenetrates, toBounds, shift } from "../src/depth/enclosure.js";
import { buildDrop, engine, rackDrawer, serverInternals } from "./depth-fixtures.js";
import type { Scene, View } from "./depth-zbuffer.js";
import { box, check, count, indexOf, v, viewOf } from "./depth-zbuffer.js";

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
  }
}

// Piston rising out of a STATIC block through its top face (§9.5), and back.
const piston: Scene = {
  items: [
    { key: "e/block", path: "e/block", box: box(0, 0, 0, 4, 4, 2), solid: true },
    { key: "e/piston", path: "e/piston", box: box(1, 1, 0.5, 2, 2, 1.3), solid: true },
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
      { key: "e/head", path: "e/head", box: box(0, 0, 0, 4, 2, 1), solid: true },
    ];
    const moves: LoopMove[] = [];
    for (let k = 0; k < 3; k++) {
      const key = `e/valve-${k}`;
      items.push({
        key,
        path: key,
        box: box(0.5 + 1.2 * k, 0.85, 0.3, 0.3, 0.3, 1.1),
        solid: true,
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
      { key: "e/block", path: "e/block", box: box(0, 0, 0, 4, 2, 1.5), solid: true },
      {
        key: "e/head/casting",
        path: "e/head/casting",
        box: box(0, 0, 1.5, 4, 2, 0.8),
        solid: true,
      },
    ];
    for (let k = 0; k < 3; k++) {
      items.push({
        key: `e/head/valve-${k}`,
        path: `e/head/valve-${k}`,
        box: box(0.6 + 1.2 * k, 0.85, 1.8, 0.3, 0.3, 0.9),
        solid: true,
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
      { key: "e/block", path: "e/block", box: box(0, 0, 0, 4, 2, 2), solid: true },
      {
        key: "e/head/casting",
        path: "e/head/casting",
        box: box(0.5, 0.5, 1.5, 3, 1, 1),
        solid: true,
        inserts: "e/block",
      },
    ];
    for (let k = 0; k < 2; k++) {
      items.push({
        key: `e/head/valve-${k}`,
        path: `e/head/valve-${k}`,
        box: box(1.2 + 1.2 * k, 0.85, 2.0, 0.3, 0.3, 0.9),
        solid: true,
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

  it("clip validity: a piston that slides sideways after clearing is not clipped; hidden until clear", async () => {
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
    expect(r.clips).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toContain("assembly/clip-fallback");
    const view = viewOf(scene, [0, 1, 2], 2);
    const p = indexOf(scene, "e/piston");
    // Crossing (top above the deck at t = 0.3, bottom still inside): hidden, though visible in truth.
    const crossing = await check(scene, r, 0.3, view);
    expect(count(crossing.ref, p)).toBeGreaterThan(100);
    expect(count(crossing.got, p)).toBe(0);
    // Clear of the deck: drawn, unclipped, and exact.
    await expectExact(scene, r, [0.8, 1.5, 2.5, 3.2], view);
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
    items.push({ key, path: key, box: box(cx * 1.2, cy * 1.2, cz * 1.2, sx, sy, sz), solid: true });
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

describe("randomized property: painter's order of sampled frames vs z-buffer", () => {
  it("within 0.5% of pixels, except approximate epochs", { timeout: 180_000 }, async () => {
    const rand = mulberry32(0xa12a);
    let scenes = 0;
    let frames = 0;
    let skipped = 0;
    let worst = 0;
    for (let attempt = 0; attempt < 400 && scenes < 40; attempt++) {
      const s = randomScene(rand);
      if (!s) continue;
      scenes++;
      const r = solve(s);
      const view = viewOf(s, samples(s.loop, 9), 1);
      for (const t of samples(s.loop, 6)) {
        if (inApprox(r, t)) {
          skipped++;
          continue;
        }
        const c = await check(s, r, t, view);
        frames++;
        worst = Math.max(worst, c.fraction);
        expect(c.fraction, `scene ${scenes} t=${t}`).toBeLessThanOrEqual(0.005);
      }
    }
    console.info(
      `property: ${scenes} scenes, ${frames} frames compared, ${skipped} approximate skipped, worst ${(worst * 100).toFixed(4)}%`,
    );
    expect(scenes).toBe(40);
    expect(frames).toBeGreaterThan(150);
  });

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
      for (let n = 0; n < 20; n++) {
        const items: DepthItemInput[] = [
          { key: "e/block", path: "e/block", box: box(0, 0, 0, 6, 2, 2), solid: true },
        ];
        const moves: LoopMove[] = [];
        for (let k = 0; k < 3; k++) {
          const key = `e/p${k}`;
          const h = 0.6 + rand();
          const z = 2 - h - 0.3 * rand() + (rand() < 0.3 ? 0.4 : 0); // some start crossing the deck
          items.push({ key, path: key, box: box(0.4 + 2 * k, 0.5, z, 1.2, 1, h), solid: true });
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
        const unclipped = new Set(
          items
            .filter((i) => i.key !== "e/block" && !r.clips.some((c) => c.item === i.key))
            .map((i) => indexOf(s, i.key)),
        );
        for (const t of samples(5, 7)) {
          if (inApprox(r, t)) continue;
          const c = await check(s, r, t, view);
          // The fallback (an unclipped piston hidden while it crosses) is a known, reported
          // deviation: skip frames whose ONLY differences are such pistons missing.
          if (c.byItem.size > 0 && [...c.byItem.keys()].every((k) => unclipped.has(k))) continue;
          frames++;
          expect(c.fraction, `scene ${n} t=${t}`).toBeLessThanOrEqual(0.005);
        }
      }
      expect(clipped).toBeGreaterThan(20);
      expect(fallbacks).toBeGreaterThan(0);
      expect(frames).toBeGreaterThan(60);
    },
  );
});
