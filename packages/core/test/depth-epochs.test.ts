import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Box3, PartMove } from "../src/contracts/index.js";
import type { DepthEpochResult, DepthItemInput, LoopMove } from "../src/depth/epochs.js";
import {
  DEFAULT_DEPTH_BUDGETS,
  depthEpochs,
  displacementAt,
  easeProgress,
  sweptBox,
  toLoopMoves,
} from "../src/depth/epochs.js";
import {
  buildDrop,
  engine,
  rackDrawer,
  serverInternals,
  serverInternalsFullLoop,
} from "./depth-fixtures.js";
import type { Scene } from "./depth-zbuffer.js";
import { box, v } from "./depth-zbuffer.js";

// The machine is shared; the performance cases warm up and measure twice.
vi.setConfig({ testTimeout: 60_000 });

function run(scene: Scene, opts: Parameters<typeof depthEpochs>[3] = {}): DepthEpochResult {
  return depthEpochs(scene.items, scene.moves, scene.loop, opts);
}

function codes(r: DepthEpochResult): string[] {
  return r.diagnostics.map((d) => d.code);
}

function visibleAt(r: DepthEpochResult, t: number): string[] {
  const e = r.epochs.find((x, k) => t >= x.t0 && (t < x.t1 || k === r.epochs.length - 1))!;
  return [...e.order];
}

function inRanges(r: DepthEpochResult, t: number): boolean {
  return r.approximate.some((a) => t >= a.t0 - 1e-9 && t <= a.t1 + 1e-9);
}

/**
 * Every visible pair that overlaps on screen and is separated on exactly one side at the pose
 * of time t must be ordered that way (the static rule's separation, E-Q09).
 */
function staticViolations(s: Scene, r: DepthEpochResult, t: number): string[] {
  const e = r.epochs.find((x, k) => t >= x.t0 && (t < x.t1 || k === r.epochs.length - 1))!;
  const pos = new Map(e.order.map((k, q) => [k, q]));
  const posed = new Map(
    s.items.map((it) => {
      const d = displacementAt(s.moves, it.path, t);
      const b = it.box;
      return [
        it.key,
        [
          b.origin.x + d.x,
          b.origin.y + d.y,
          b.origin.z + d.z,
          b.origin.x + b.size.x + d.x,
          b.origin.y + b.size.y + d.y,
          b.origin.z + b.size.z + d.z,
        ],
      ] as const;
    }),
  );
  const rect = (b: readonly number[]): number[] => [
    (b[0]! - b[4]!) * 32,
    (b[3]! - b[1]!) * 32,
    (b[0]! + b[1]!) * 16 - b[5]! * 32,
    (b[3]! + b[4]!) * 16 - b[2]! * 32,
  ];
  const out: string[] = [];
  for (const a of e.order) {
    for (const b of e.order) {
      if (a >= b) continue;
      const A = posed.get(a)!;
      const B = posed.get(b)!;
      const ra = rect(A);
      const rb = rect(B);
      if (!(
        ra[0]! < rb[1]! - 1e-6 &&
        rb[0]! < ra[1]! - 1e-6 &&
        ra[2]! < rb[3]! - 1e-6 &&
        rb[2]! < ra[3]! - 1e-6
      ))
        continue;
      const ab = [0, 1, 2].some((k) => A[k + 3]! <= B[k]! + 1e-6);
      const ba = [0, 1, 2].some((k) => B[k + 3]! <= A[k]! + 1e-6);
      if (ab === ba) continue;
      if (ab !== pos.get(a)! < pos.get(b)!) out.push(`${a} / ${b} at ${t}`);
    }
  }
  return out;
}

function isSubsequence(sub: readonly string[], of: readonly string[]): boolean {
  let k = 0;
  for (const x of of) if (k < sub.length && sub[k] === x) k++;
  return k === sub.length;
}

/** Invariants every result must satisfy. */
function invariants(r: DepthEpochResult, loop: number): void {
  expect(r.epochs.length).toBeGreaterThan(0);
  expect(r.epochs[0]!.t0).toBe(0);
  expect(r.epochs[r.epochs.length - 1]!.t1).toBeCloseTo(loop, 9);
  for (let k = 1; k < r.epochs.length; k++) {
    expect(r.epochs[k]!.t0).toBeCloseTo(r.epochs[k - 1]!.t1, 9);
    expect(r.epochs[k]!.order).not.toEqual(r.epochs[k - 1]!.order);
  }
  for (const e of r.epochs) expect(isSubsequence(e.order, r.order)).toBe(true);
  for (const it of r.items) expect(it.copies).toBe(1);
}

function containsBox(outer: Box3, inner: Box3, eps = 1e-9): boolean {
  const ax = ["x", "y", "z"] as const;
  return ax.every(
    (a) =>
      outer.origin[a] <= inner.origin[a] + eps &&
      outer.origin[a] + outer.size[a] + eps >= inner.origin[a] + inner.size[a],
  );
}

function posed(b: Box3, d: { x: number; y: number; z: number }): Box3 {
  return {
    origin: { x: b.origin.x + d.x, y: b.origin.y + d.y, z: b.origin.z + d.z },
    size: b.size,
  };
}

function hullOf(a: Box3, b: Box3): Box3 {
  const ax = ["x", "y", "z"] as const;
  const lo = ax.map((k) => Math.min(a.origin[k], b.origin[k]));
  const hi = ax.map((k) => Math.max(a.origin[k] + a.size[k], b.origin[k] + b.size[k]));
  return box(lo[0]!, lo[1]!, lo[2]!, hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
}

describe("easing and moves", () => {
  it("every CSS easing is monotone, pinned at 0 and 1", () => {
    for (const e of ["linear", "ease", "ease-in", "ease-out", "ease-in-out"] as const) {
      expect(easeProgress(e, 0)).toBe(0);
      expect(easeProgress(e, 1)).toBe(1);
      let prev = 0;
      for (let k = 0; k <= 1000; k++) {
        const p = easeProgress(e, k / 1000);
        expect(p).toBeGreaterThanOrEqual(prev);
        prev = p;
      }
    }
    expect(easeProgress("ease-in-out", 0.5)).toBeCloseTo(0.5, 6);
    expect(easeProgress("ease-in", 0.5)).toBeCloseTo(0.3153, 3);
  });

  it("matches the CSS cubic-bézier curves (independent Newton solver, C-Q07)", () => {
    // CSS Easing Functions Level 1 keyword control points.
    const curves = {
      ease: [0.25, 0.1, 0.25, 1],
      "ease-in": [0.42, 0, 1, 1],
      "ease-out": [0, 0, 0.58, 1],
      "ease-in-out": [0.42, 0, 0.58, 1],
    } as const;
    const b = (p1: number, p2: number, s: number): number =>
      3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s ** 2 * p2 + s ** 3;
    const db = (p1: number, p2: number, s: number): number =>
      3 * (1 - s) ** 2 * p1 + 6 * (1 - s) * s * (p2 - p1) + 3 * s ** 2 * (1 - p2);
    for (const [name, [x1, y1, x2, y2]] of Object.entries(curves)) {
      for (let k = 1; k < 200; k++) {
        const x = k / 200;
        let s = x;
        for (let q = 0; q < 50; q++) {
          const d = db(x1, x2, s);
          if (Math.abs(d) < 1e-12) break;
          s = Math.min(1, Math.max(0, s - (b(x1, x2, s) - x) / d));
        }
        expect(easeProgress(name as keyof typeof curves, x), `${name} @ ${x}`).toBeCloseTo(
          b(y1, y2, s),
          9,
        );
      }
    }
    // A published reference point: ease(0.5) ≈ 0.8024 (cubic-bezier(.25, .1, .25, 1)).
    expect(easeProgress("ease", 0.5)).toBeCloseTo(0.8024, 3);
  });

  it("toLoopMoves: explode, implode mirrored, build from the origin", () => {
    const moves: PartMove[] = [
      { path: "a/x", offset: v(0, 0, 2), start: 0, duration: 1, easing: "linear" },
      { path: "a/y", offset: v(1, 0, 0), start: 0.5, duration: 1, easing: "linear" },
    ];
    const ex = toLoopMoves(moves, { at: 10, kind: "explode" });
    expect(ex.map((m) => [m.t0, m.t1])).toEqual([
      [10, 11],
      [10.5, 11.5],
    ]);
    const im = toLoopMoves(moves, { at: 20, kind: "implode", scale: 2 });
    // Mirrored in the 1.5 s segment, compressed ×2: y (start 0.5) plays first.
    expect(im.map((m) => [m.path, m.t0, m.t1])).toEqual([
      ["a/x", 21, 23],
      ["a/y", 20, 22],
    ]);
    const all = [...ex, ...im];
    expect(displacementAt(all, "a/x/leaf", 11)).toEqual(v(0, 0, 2));
    expect(displacementAt(all, "a/x/leaf", 30)).toEqual(v(0, 0, 0));
    const b = toLoopMoves([{ ...moves[0]!, offset: v(0, 0, -2) }], { at: 1, kind: "build" });
    expect(displacementAt(b, "a/x", 0)).toEqual(v(0, 0, 2)); // at the origin above the seat
    expect(displacementAt(b, "a/x", 2)).toEqual(v(0, 0, 0)); // seated
  });

  it("instant moves at t = 0 give the base pose", () => {
    const m: LoopMove = {
      path: "a",
      t0: 0,
      t1: 0,
      from: v(0, 0, 0),
      to: v(1, 0, 0),
      easing: "linear",
    };
    expect(displacementAt([m], "a/b", 0)).toEqual(v(1, 0, 0));
  });
});

describe("swept boxes (§9.3): concurrent composed moves", () => {
  // A drawer slides +y (ease-in) while its lid lifts +z (ease-out) and, `with: previous`, a child
  // lifts +z and is drawn back -y relative to the drawer (ease-out). The child's absolute y goes
  // negative mid-way although it is 0 at both ends.
  const moves: LoopMove[] = [
    { path: "d", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 2, 0), easing: "ease-in" },
    { path: "d/lid", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, 0, 1), easing: "ease-out" },
    { path: "d/child", t0: 0, t1: 1, from: v(0, 0, 0), to: v(0, -2, 0.5), easing: "ease-out" },
  ];
  const rest = box(0, 0, 0, 1, 1, 0.2);

  for (const leaf of ["d/lid", "d/child", "d/body"]) {
    it(`contains every sampled pose of ${leaf}`, () => {
      const sw = sweptBox(rest, leaf, moves, 0, 1);
      for (let k = 0; k <= 400; k++) {
        const t = k / 400;
        expect(containsBox(sw, posed(rest, displacementAt(moves, leaf, t)))).toBe(true);
      }
    });
  }

  it("the hull of the endpoint poses would not (regression for the unsound bound)", () => {
    const end = hullOf(
      posed(rest, displacementAt(moves, "d/child", 0)),
      posed(rest, displacementAt(moves, "d/child", 1)),
    );
    let escaped = 0;
    for (let k = 0; k <= 400; k++) {
      if (!containsBox(end, posed(rest, displacementAt(moves, "d/child", k / 400)))) escaped++;
    }
    expect(escaped).toBeGreaterThan(100);
    // And the solver must not certify what the endpoint hull would: a post standing where only
    // the swept path goes. The endpoint hull (y ∈ [0, 1]) is y-separated from it for the whole
    // phase, yet the child runs into it mid-way.
    const items: DepthItemInput[] = [
      { key: "d/child", path: "d/child", box: rest, solid: true, fills: true },
      { key: "post", box: box(0.2, -0.6, -1, 0.5, 0.3, 3), solid: true, fills: true },
    ];
    const minY = Math.min(
      ...Array.from({ length: 401 }, (_, k) => displacementAt(moves, "d/child", k / 400).y),
    );
    expect(minY).toBeLessThan(-0.6); // the child really reaches the post's y range
    expect(end.origin.y).toBeGreaterThanOrEqual(-0.3); // …which the endpoint hull never does
    const r = depthEpochs(items, moves, 1);
    expect(r.stats.bisections).toBeGreaterThan(0); // not certified for the whole phase
    expect(codes(r)).toContain("assembly/transit-collision");
  });
});

describe("§9.7 worked proofs (one certified order, no copies)", () => {
  it("rack drawer: one epoch over the whole loop", () => {
    const s = rackDrawer();
    const r = run(s);
    invariants(r, s.loop);
    expect(r.epochs).toHaveLength(1);
    expect(r.epochs[0]!.approximate).toBe(false);
    expect(r.approximate).toEqual([]);
    expect(r.stats.bisections).toBe(0);
    expect(r.stats.copyConflicts).toBe(0);
    expect(codes(r)).toEqual([]);
    // Posts: left before the pulled device, right after it (x separation), door after it (y).
    const o = r.order;
    expect(o.indexOf("rack/post-fl")).toBeLessThan(o.indexOf("rack/s3"));
    expect(o.indexOf("rack/s3")).toBeLessThan(o.indexOf("rack/post-fr"));
    expect(o.indexOf("rack/s3")).toBeLessThan(o.indexOf("rack/door"));
  });

  it("server internals on a pulled drawer: one epoch, tray halves around the internals", () => {
    const s = serverInternals();
    const r = run(s);
    invariants(r, s.loop);
    expect(r.epochs).toHaveLength(1);
    expect(r.approximate).toEqual([]);
    expect(r.stats.bisections).toBe(0);
    expect(codes(r)).toEqual([]);
    const o = r.order;
    for (const p of ["board", "cpu", "dimm", "fan"]) {
      expect(o.indexOf("rack/s3__back")).toBeLessThan(o.indexOf(`rack/s3/${p}`));
      expect(o.indexOf(`rack/s3/${p}`)).toBeLessThan(o.indexOf("rack/s3__front"));
    }
  });

  it("the same tray pulled within the loop needs a copy (Phase 3): merged, approximate", () => {
    const s = serverInternalsFullLoop();
    const r = run(s);
    invariants(r, s.loop);
    expect(r.stats.copyConflicts).toBeGreaterThan(0);
    const copy = r.diagnostics.filter(
      (d) => d.code === "assembly/depth-approx" && d.params?.["copy"] === true,
    );
    expect(copy.length).toBeGreaterThan(0);
    for (const d of copy) {
      const pair = d.params!["items"] as [string, string];
      expect(pair.some((k) => /^rack\/s[4-7]$/.test(k))).toBe(true);
      expect(pair.some((k) => k.startsWith("rack/s3/"))).toBe(true);
    }
  });

  it("build drop: one epoch per build step", () => {
    const s = buildDrop();
    const r = run(s);
    invariants(r, s.loop);
    expect(r.epochs.map((e) => [e.t0, e.t1])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(r.epochs.map((e) => e.order)).toEqual([
      ["kit/plate"],
      ["kit/plate", "kit/a"],
      ["kit/plate", "kit/a", "kit/b"],
      ["kit/plate", "kit/a", "kit/b", "kit/c"],
    ]);
    expect(r.approximate).toEqual([]);
    expect(r.stats.bisections).toBe(0);
    expect(codes(r)).toEqual([]);
  });
});

describe("engine example (§19.3) as a regression fixture", () => {
  const s = engine();
  const r = run(s);

  it("is certified: no approximate interval, no copy conflict, no cycle, no collision", () => {
    invariants(r, s.loop);
    expect(r.approximate).toEqual([]);
    expect(r.epochs.every((e) => !e.approximate)).toBe(true);
    expect(r.stats.copyConflicts).toBe(0);
    expect(r.stats.cycleDrops).toBe(0);
    expect(codes(r)).toEqual([]);
  });

  it("pistons and rods leave through the deck with a clip on the static block", () => {
    const byItem = new Map(r.clips.map((c) => [c.item, c]));
    for (let k = 1; k <= 4; k++) {
      for (const p of ["piston", "rod"]) {
        const c = byItem.get(`engine/pr-${k}/${p}`);
        expect(c, `pr-${k}/${p}`).toBeDefined();
        expect(c!.solid).toBe("engine/block");
        expect(c!.axis).toBe("z");
        expect(c!.prism.origin.z).toBeCloseTo(340 / 80, 9); // starts at the deck
      }
    }
    // The crankshaft leaves through the hidden bottom face: no clip, drawn before the block.
    expect(byItem.has("engine/crankshaft")).toBe(false);
    expect(r.order.indexOf("engine/crankshaft")).toBeLessThan(r.order.indexOf("engine/block"));
    expect(r.order.indexOf("engine/block")).toBeLessThan(r.order.indexOf("engine/pr-1/piston"));
  });

  it("valves are inserted in the casting (clip on the head's track) and enclosed by casting ∪ cover at rest", () => {
    for (let k = 1; k <= 8; k++) {
      const c = r.clips.find((x) => x.item === `engine/head/valve-${k}`);
      expect(c?.solid).toBe("engine/head/casting");
      expect(c?.axis).toBe("z");
      const d = r.items.find((x) => x.item === `engine/head/valve-${k}`)!;
      expect(d.clips?.[0]?.solid).toBe("engine/head/casting");
    }
    const atRest = visibleAt(r, 1);
    expect(atRest.some((k) => k.includes("head/valve-"))).toBe(false);
    // Cover lifting: the union splits, valves show (clipped, before the cover).
    expect(visibleAt(r, 3).filter((k) => k.includes("head/valve-"))).toHaveLength(8);
    expect(r.order.indexOf("engine/head/valve-1")).toBeLessThan(
      r.order.indexOf("engine/valve-cover"),
    );
    expect(r.order.indexOf("engine/head/casting")).toBeLessThan(
      r.order.indexOf("engine/head/valve-1"),
    );
  });

  it("flush camshafts are inside the cover (closed containment) until it lifts", () => {
    expect(visibleAt(r, 1)).not.toContain("engine/cam-intake");
    expect(visibleAt(r, 1)).not.toContain("engine/cam-exhaust");
    expect(visibleAt(r, 2.5)).toContain("engine/cam-intake");
    // Back in the settled cover at the loop end.
    expect(visibleAt(r, 15.95)).not.toContain("engine/cam-intake");
  });

  it("internals hidden at rest, shown while they cross, hidden again", () => {
    const rest = visibleAt(r, 1);
    for (const k of ["engine/crankshaft", "engine/pr-1/piston", "engine/pr-1/rod"])
      expect(rest).not.toContain(k);
    const out = visibleAt(r, 10);
    for (const k of ["engine/crankshaft", "engine/pr-1/piston", "engine/pr-4/rod"])
      expect(out).toContain(k);
    expect(visibleAt(r, 13.5)).not.toContain("engine/crankshaft");
  });
});

describe("cycles and copies", () => {
  // Three static boxes, pairwise separated on different axes: x before y (x), y before z (y),
  // z before x (z). Every edge is certified and every centre depth equals 2.5.
  const items: DepthItemInput[] = [
    { key: "x", box: box(0, 0, 0, 1, 3, 1) },
    { key: "y", box: box(1, 0, -1, 2, 1, 2) },
    { key: "z", box: box(0, 1, -1, 2, 2, 1) },
  ];

  it("breaks a certified cycle deterministically and reports assembly/depth-cycle", () => {
    const r = depthEpochs(items, [], 1);
    expect(codes(r)).toEqual(["assembly/depth-cycle"]);
    expect(r.diagnostics[0]!.params).toMatchObject({ from: "x", to: "y", strength: "certified" });
    expect(r.order).toEqual(["y", "z", "x"]);
    expect(r.epochs).toHaveLength(1);
    expect(r.epochs[0]!.approximate).toBe(true);
    // Input order does not matter.
    expect(depthEpochs([...items].reverse(), [], 1)).toEqual(r);
  });

  it("an order swap that needs a copy is merged and approximate (assembly/depth-approx)", () => {
    // a starts under b (a before b), moves out beside it, rises and comes back above it (b before a).
    const scene: Scene = {
      items: [
        { key: "a", path: "a", box: box(0, 0, 0, 1, 1, 0.9) },
        { key: "b", box: box(0, 0, 1, 1, 1, 1) },
      ],
      moves: [
        { path: "a", t0: 0, t1: 1, from: v(0, 0, 0), to: v(1.5, 0, 0), easing: "linear" },
        { path: "a", t0: 1, t1: 2, from: v(0, 0, 0), to: v(0, 0, 2.2), easing: "linear" },
        { path: "a", t0: 2, t1: 3, from: v(0, 0, 0), to: v(-1.5, 0, 0), easing: "linear" },
      ],
      loop: 3,
    };
    const r = run(scene);
    invariants(r, 3);
    expect(r.stats.copyConflicts).toBe(1);
    const d = r.diagnostics.find((x) => x.code === "assembly/depth-approx")!;
    expect(d.params).toMatchObject({ items: ["a", "b"], copy: true });
    // b before a held for 2 s, a before b for 1 s: the longer one wins.
    expect(r.order).toEqual(["b", "a"]);
    expect(r.approximate).toEqual([{ t0: 0, t1: 1 }]);
  });

  it("a cycle of FORCED edges only: one forced edge is dropped and reported (E-Q05/E-Q09)", () => {
    // Within one interval the forced rules cannot close a cycle, but across intervals they can:
    // a sits in b's bottom face [0,1) (a < b, weak-behind), b in c's [1,2) (b < c), c in a's
    // [2,3) (c < a); the others are parked far away. No pair has both directions, so the union
    // graph has a cycle of forced edges only.
    const instant = (path: string, t: number, d: ReturnType<typeof v>): LoopMove => ({
      path,
      t0: t,
      t1: t,
      from: v(0, 0, 0),
      to: d,
      easing: "linear",
    });
    const items: DepthItemInput[] = [
      { key: "a", path: "a", box: box(0, 0, -0.5, 1, 1, 1), solid: true, fills: true },
      { key: "b", path: "b", box: box(0, 0, 0, 1, 1, 1), solid: true, fills: true },
      { key: "c", path: "c", box: box(20, 20, 0, 1, 1, 1), solid: true, fills: true },
    ];
    const moves: LoopMove[] = [
      instant("a", 1, v(10, 10, 0)),
      instant("c", 1, v(-20, -20, 0.5)),
      instant("b", 2, v(20, 0, 0)),
      instant("a", 2, v(-10, -10, 1.5)),
    ];
    const r = depthEpochs(items, moves, 3);
    expect(r.stats.copyConflicts).toBe(0);
    const cyc = r.diagnostics.filter((d) => d.code === "assembly/depth-cycle");
    expect(cyc).toHaveLength(1);
    expect(cyc[0]!.params).toMatchObject({ strength: "forced" });
    expect([...r.order].sort()).toEqual(["a", "b", "c"]);
    expect(r.approximate.length).toBeGreaterThan(0);
    expect(depthEpochs([...items].reverse(), [...moves].reverse(), 3)).toEqual(r);
  });

  it("copy conflicts: between certified and forced the longer-held direction wins (E-Q04)", () => {
    // a sits in b's bottom face (forced a before b, weak-behind) for 1 s, drops out, slides
    // beside b and rises (certified b before a, x-separated) for longer.
    const scene: Scene = {
      items: [
        { key: "a", path: "a", box: box(0.5, 0.5, -0.5, 1, 1, 1.5), solid: true, fills: true },
        { key: "b", box: box(0, 0, 0, 2, 2, 2), solid: true, fills: true },
      ],
      moves: [
        { path: "a", t0: 1, t1: 1.5, from: v(0, 0, 0), to: v(0, 0, -2), easing: "linear" },
        { path: "a", t0: 1.5, t1: 2, from: v(0, 0, 0), to: v(2.2, 0, 0), easing: "linear" },
        { path: "a", t0: 2, t1: 2.5, from: v(0, 0, 0), to: v(0, 0, 4), easing: "linear" },
      ],
      loop: 6,
    };
    const r = run(scene);
    invariants(r, 6);
    expect(r.stats.copyConflicts).toBe(1);
    expect(r.order).toEqual(["b", "a"]); // certified, held ~3.9 s, beats forced held ~1.6 s
    const d = r.diagnostics.find((x) => x.code === "assembly/depth-approx" && x.params?.["copy"]);
    expect(d?.params).toMatchObject({ items: ["a", "b"] });
    expect(inRanges(r, 0.5)).toBe(true);
    expect(inRanges(r, 4)).toBe(false);
  });

  it("caps epochs per transition: merged and approximate beyond the cap", () => {
    // Ten parts enclosed in a housing leave through its hidden bottom face at staggered times.
    // Each is hidden while enclosed throughout a phase and visible (before the housing, which
    // covers it: weak-behind) once its phase also contains the exit: 9 certified epochs.
    const items: DepthItemInput[] = [
      { key: "h", box: box(0, 0, 0, 11, 1, 1), solid: true, fills: true },
    ];
    const moves: LoopMove[] = [];
    for (let k = 0; k < 10; k++) {
      items.push({
        key: `p${k}`,
        path: `p${k}`,
        box: box(k + 0.2, 0.2, 0.2, 0.6, 0.6, 0.6),
        solid: true,
        fills: true,
      });
      moves.push({
        path: `p${k}`,
        t0: 0.1 * k,
        t1: 0.1 * k + 2,
        from: v(0, 0, 0),
        to: v(0, 0, -2),
        easing: "linear",
      });
    }
    const free = depthEpochs(items, moves, 3);
    invariants(free, 3);
    expect(free.epochs.length).toBe(9);
    expect(free.epochs.every((e) => !e.approximate)).toBe(true);
    expect(free.transitions).toHaveLength(1);
    const capped = depthEpochs(items, moves, 3, { budgets: { maxEpochsPerTransition: 4 } });
    invariants(capped, 3);
    expect(capped.epochs.length).toBeLessThanOrEqual(4);
    expect(capped.epochs.some((e) => e.approximate)).toBe(true);
    expect(codes(capped)).toContain("assembly/depth-approx");
  });
});

describe("bisection and transit collisions", () => {
  // b (wider than a in y) slides through a: they collide mid-way, nothing certifies the pair.
  const scene: Scene = {
    items: [
      { key: "a", box: box(0, 0, 0, 1, 1, 1), solid: true, fills: true },
      { key: "b", path: "b", box: box(-2, -0.25, 0.25, 0.5, 1.5, 0.5), solid: true, fills: true },
    ],
    moves: [{ path: "b", t0: 0, t1: 1, from: v(0, 0, 0), to: v(4, 0, 0), easing: "linear" }],
    loop: 1,
  };

  it("bisects to at most 6 levels, then the midpoint decides (approximate)", () => {
    const r = run(scene);
    invariants(r, 1);
    expect(r.stats.bisections).toBeGreaterThan(0);
    expect(r.approximate.length).toBeGreaterThan(0);
    for (const a of r.approximate) expect(a.t1 - a.t0).toBeGreaterThanOrEqual(1 / 64 - 1e-9);
    expect(codes(r)).toContain("assembly/depth-approx");
    // No interval below 1/120 s.
    const tight = run(scene, { budgets: { minInterval: 0.3 } });
    expect(tight.stats.finalIntervals).toBeLessThanOrEqual(4);
  });

  it("warns assembly/transit-collision once per pair, not for seated crossings", () => {
    const r = run(scene);
    const w = r.diagnostics.filter((d) => d.code === "assembly/transit-collision");
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe("warning");
    expect(w[0]!.params).toMatchObject({ items: ["a", "b"] });
    // The engine's pistons crossing the deck and rods on the crank pins are not collisions, nor
    // is a narrower part passing through a solid (enclosed or a one-face crossing throughout).
    expect(codes(run(engine()))).not.toContain("assembly/transit-collision");
    const through = run({
      ...scene,
      items: [scene.items[0]!, { ...scene.items[1]!, box: box(-2, 0.25, 0.25, 0.5, 0.5, 0.5) }],
    });
    expect(codes(through)).not.toContain("assembly/transit-collision");
  });
});

describe("enclosure (§9.5)", () => {
  it("hides a part enclosed by one solid, shows contents of a non-solid tray", () => {
    const r = depthEpochs(
      [
        { key: "case", box: box(0, 0, 0, 2, 2, 2), solid: true, fills: true },
        { key: "chip", box: box(0.5, 0.5, 0.5, 1, 1, 1) },
        { key: "tray", box: box(3, 0, 0, 2, 2, 1), solid: false },
        { key: "card", box: box(3.5, 0.5, 0.3, 1, 1, 0.5) },
      ],
      [],
      1,
    );
    expect(r.epochs[0]!.order).not.toContain("chip");
    expect(r.epochs[0]!.order).toContain("card");
  });

  it("hides a part enclosed by the union of touching solids only", () => {
    const items: DepthItemInput[] = [
      { key: "low", box: box(0, 0, 0, 2, 2, 1), solid: true, fills: true },
      { key: "high", box: box(0, 0, 1, 2, 2, 1), solid: true, fills: true },
      { key: "pin", box: box(0.8, 0.8, 0.5, 0.4, 0.4, 1) },
    ];
    expect(depthEpochs(items, [], 1).epochs[0]!.order).not.toContain("pin");
    const apart = items.map((i) =>
      i.key === "high" ? { ...i, box: box(0, 0, 1.01, 2, 2, 1) } : i,
    );
    // Not touching: no union; the pin crosses low's visible top face without a clip → hidden
    // until clear (clip-fallback) only if it moves; static: inferred insert clip instead.
    const r = depthEpochs(apart, [], 1);
    expect(r.clips.map((c) => [c.item, c.solid])).toEqual([["pin", "low"]]);
    expect(r.epochs[0]!.order).toContain("pin");
  });
});

describe("diagnostics, never throws", () => {
  it("reports bad input as assembly/depth-input and ignores it", () => {
    const items = [
      { key: "ok", box: box(0, 0, 0, 1, 1, 1) },
      { key: "ok", box: box(2, 0, 0, 1, 1, 1) },
      { key: "nan", box: box(Number.NaN, 0, 0, 1, 1, 1) },
      { key: "neg", box: box(0, 0, 0, -1, 1, 1) },
    ] as DepthItemInput[];
    const moves = [
      { path: "ok", t0: 1, t1: 0, from: v(0, 0, 0), to: v(1, 0, 0), easing: "linear" },
      { path: "ok", t0: 0, t1: 1, from: v(0, 0, 0), to: v(Infinity, 0, 0), easing: "linear" },
      { path: "ok", t0: 0, t1: 1, from: v(0, 0, 0), to: v(1, 0, 0), easing: "bounce" },
    ] as unknown as LoopMove[];
    let r: DepthEpochResult | undefined;
    expect(() => {
      r = depthEpochs(items, moves, Number.NaN);
    }).not.toThrow();
    expect(codes(r!).filter((c) => c === "assembly/depth-input")).toHaveLength(7);
    expect(r!.order).toEqual(["ok"]);
    expect(r!.epochs).toEqual([{ t0: 0, t1: 0, order: ["ok"], approximate: false }]);
  });

  it("checks item and move caps before any input-sized work", () => {
    const many = Array.from({ length: 11 }, (_, k) => ({
      key: `k${k}`,
      box: box(k, 0, 0, 1, 1, 1),
    }));
    const r = depthEpochs(many, [], 1, { budgets: { maxItems: 10 } });
    expect(codes(r)).toEqual(["budget/assembly-parts"]);
    expect(r.epochs).toEqual([]);
    const m = Array.from({ length: 3 }, () => ({
      path: "a",
      t0: 0,
      t1: 1,
      from: v(0, 0, 0),
      to: v(1, 0, 0),
      easing: "linear" as const,
    }));
    expect(codes(depthEpochs(many.slice(0, 2), m, 1, { budgets: { maxMoves: 2 } }))).toEqual([
      "budget/time",
    ]);
  });

  it("stops at the pair budget with budget/time and approximate intervals", () => {
    const s = engine();
    const r = run(s, { budgets: { maxPairChecks: 200 } });
    expect(codes(r)).toContain("budget/time");
    expect(r.approximate.length).toBeGreaterThan(0);
    invariants(r, s.loop);
  });

  it("thins phases beyond the phase-work budget (budget/time), staying sound", () => {
    const s = engine();
    const full = run(s);
    const thin = run(s, { budgets: { maxPhaseWork: 20 * 80 } });
    expect(codes(thin)).toContain("budget/time");
    expect(thin.stats.phases).toBeLessThan(full.stats.phases);
    invariants(thin, s.loop);
    // Presence and clip-event cuts are kept; thinned move cuts only coarsen the sweeps.
    expect(thin.clips).toEqual(full.clips);
    // Every non-approximate sampled pose of the thinned run agrees with the static rule.
    let checked = 0;
    for (let k = 0; k < 160; k++) {
      const t = ((k + 0.5) * s.loop) / 160;
      if (inRanges(thin, t)) continue;
      checked++;
      expect(staticViolations(s, thin, t)).toEqual([]);
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("bounds cycle breaking work and still emits a total order", () => {
    const items: DepthItemInput[] = [
      { key: "x", box: box(0, 0, 0, 1, 3, 1) },
      { key: "y", box: box(1, 0, -1, 2, 1, 2) },
      { key: "z", box: box(0, 1, -1, 2, 2, 1) },
    ];
    const r = depthEpochs(items, [], 1, { budgets: { maxCycleDrops: 0 } });
    expect([...r.order].sort()).toEqual(["x", "y", "z"]);
    expect(codes(r)).toContain("budget/time");
    expect(r.epochs[0]!.approximate).toBe(true);
  });

  it("guards against wrong types and reports assembly/depth-input (E-Q08)", () => {
    const junk = [
      null,
      7,
      { key: "a", box: box(0, 0, 0, 1, 1, 1), path: 3 },
      { key: "b", box: box(0, 0, 0, 1, 1, 1), boxes: "nope" },
      { key: "c", box: box(0, 0, 0, 1, 1, 1), present: [[0]] },
      { key: "d", box: box(0, 0, 0, 1, 1, 1), ring: "middle" },
      { key: "ok", box: box(0, 0, 0, 1, 1, 1) },
    ] as unknown as DepthItemInput[];
    let r: DepthEpochResult | undefined;
    expect(() => (r = depthEpochs(junk, [null, "x"] as unknown as LoopMove[], 1))).not.toThrow();
    expect(codes(r!).filter((c) => c === "assembly/depth-input")).toHaveLength(8);
    expect(r!.order).toEqual(["ok"]);
    const notArrays = depthEpochs(
      "x" as unknown as DepthItemInput[],
      {} as unknown as LoopMove[],
      1,
    );
    expect(codes(notArrays)).toEqual(["assembly/depth-input"]);
    expect(notArrays.epochs).toEqual([{ t0: 0, t1: 1, order: [], approximate: false }]);
  });

  it("emits only codes listed in assemblies §18", () => {
    const doc = readFileSync(
      new URL("../../../docs/design/assemblies.md", import.meta.url),
      "utf8",
    );
    const table = doc.slice(doc.indexOf("## 18. Diagnostics"), doc.indexOf("## 19. Examples"));
    const src = readFileSync(new URL("../src/depth/epochs.ts", import.meta.url), "utf8");
    const used = [...new Set([...src.matchAll(/code: "([a-z0-9/-]+)"/g)].map((m) => m[1]!))].sort();
    expect(used).toEqual([
      "assembly/clip-fallback",
      "assembly/depth-approx",
      "assembly/depth-cycle",
      "assembly/depth-input",
      "assembly/transit-collision",
      "budget/assembly-parts",
      "budget/time",
    ]);
    for (const c of used) expect(table, c).toContain(`\`${c}\``);
  });
});

describe("determinism", () => {
  it("same input → same output; input order irrelevant", () => {
    const s = engine();
    const a = run(s);
    const b = run(s);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const shuffled = {
      ...s,
      items: [...s.items].reverse(),
      moves: [...s.moves].sort((x, y) => (x.path < y.path ? 1 : -1)),
    };
    expect(JSON.stringify(run(shuffled))).toBe(JSON.stringify(a));
  });
});

describe("performance (§9.8): 300 leaves × 20 transitions", () => {
  // 10 × 10 × 3 grid of parts in one assembly, the whole assembly drifting +x over the loop.
  // Each of the 20 transitions lifts one row out and back. The machine is shared, so the
  // load-independent bound is the operation count; the wall-clock bound is generous.
  function grid(): DepthItemInput[] {
    const items: DepthItemInput[] = [];
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 10; col++) {
        for (let layer = 0; layer < 3; layer++) {
          const key = `g/r${row}/c${col}-l${layer}`;
          items.push({
            key,
            path: key,
            box: box(col * 1.0, row * 1.0, layer * 0.6, 0.8, 0.8, 0.5),
            solid: true,
            fills: true,
          });
        }
      }
    }
    return items;
  }
  const drift: LoopMove = {
    path: "g",
    t0: 0,
    t1: 40,
    from: v(0, 0, 0),
    to: v(2, 0, 0),
    easing: "linear",
  };

  function measure(label: string, moves: LoopMove[]): { r: DepthEpochResult; ms: number } {
    const items = grid();
    expect(items.length).toBe(300);
    depthEpochs(items, moves, 40); // warm-up (JIT)
    const t0 = performance.now();
    const r = depthEpochs(items, moves, 40);
    const ms = performance.now() - t0;
    console.info(
      `depth epochs 300 × 20 (${label}): ${ms.toFixed(0)} ms, ${r.stats.pairChecks} pair checks, ` +
        `${r.stats.phases} phases, ${r.stats.finalIntervals} intervals`,
    );
    invariants(r, 40);
    expect(r.transitions).toHaveLength(1);
    expect(r.approximate).toEqual([]);
    return { r, ms };
  }

  it("rows as sub-assemblies (one move per row and direction)", () => {
    const moves: LoopMove[] = [drift];
    for (let t = 0; t < 20; t++) {
      const row = t % 10;
      const d = 3 + (t % 3);
      moves.push({
        path: `g/r${row}`,
        t0: 2 * t,
        t1: 2 * t + 1,
        from: v(0, 0, 0),
        to: v(0, 0, d),
        easing: "ease-in-out",
      });
      moves.push({
        path: `g/r${row}`,
        t0: 2 * t + 1,
        t1: 2 * t + 2,
        from: v(0, 0, 0),
        to: v(0, 0, -d),
        easing: "ease-in-out",
      });
    }
    const { r, ms } = measure("rows", moves);
    // The §9.8 target in operations: well inside the default budget derived from 2 s (E-Q03).
    expect(r.stats.pairChecks).toBeLessThan(DEFAULT_DEPTH_BUDGETS.maxPairChecks / 10);
    expect(r.diagnostics.map((d) => d.code)).not.toContain("budget/time");
    expect(ms).toBeLessThan(10_000);
  });

  it("stress: every part moves on its own, staggered by column (~40 phases per transition)", () => {
    const moves: LoopMove[] = [drift];
    for (let t = 0; t < 20; t++) {
      const row = t % 10;
      for (let col = 0; col < 10; col++) {
        for (let layer = 0; layer < 3; layer++) {
          const path = `g/r${row}/c${col}-l${layer}`;
          const d = 3 + 0.7 * layer; // stacking order kept
          const s = 2 * t + 0.04 * col;
          moves.push({
            path,
            t0: s,
            t1: s + 0.6,
            from: v(0, 0, 0),
            to: v(0, 0, d),
            easing: "ease-in-out",
          });
          moves.push({
            path,
            t0: s + 1,
            t1: s + 1.5,
            from: v(0, 0, 0),
            to: v(0, 0, -d),
            easing: "ease-in-out",
          });
        }
      }
    }
    const { r, ms } = measure("stress", moves);
    expect(r.stats.phases).toBeGreaterThan(700);
    expect(r.stats.pairChecks).toBeLessThan(DEFAULT_DEPTH_BUDGETS.maxPairChecks);
    expect(r.diagnostics.map((d) => d.code)).not.toContain("budget/time");
    expect(ms).toBeLessThan(30_000);
  });
});
