import { describe, expect, it } from "vitest";
import type { Bounds, Vec } from "../src/depth/enclosure.js";
import {
  EPS,
  MAX_UNION_BOXES,
  behindAxis,
  blocksOf,
  containsClosed,
  core,
  enclosedThroughout,
  frontAxis,
  hideThroughout,
  insideUnion,
  interpenetrates,
  interpenetratesThroughout,
  mayInterpenetrate,
  neverEnclosed,
  neverHide,
  seatedOrEnclosed,
  shift,
  touches,
  weakBehind,
} from "../src/depth/enclosure.js";

const B = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Bounds => [
  x0,
  y0,
  z0,
  x1,
  y1,
  z1,
];

describe("closed predicates with ε = 1e-6", () => {
  it("flush faces are inside; beyond ε is not", () => {
    const cover = B(10, 10, 430, 470, 210, 520);
    const cam = B(10, 60, 450, 470, 90, 480); // flush with both ends
    expect(containsClosed(cover, cam)).toBe(true);
    expect(containsClosed(cover, shift(cam, [EPS / 2, 0, 0]))).toBe(true);
    expect(containsClosed(cover, shift(cam, [3 * EPS, 0, 0]))).toBe(false);
  });

  it("touching boxes do not interpenetrate; touching faces join a block, edges do not", () => {
    const a = B(0, 0, 0, 1, 1, 1);
    expect(interpenetrates(a, B(1, 0, 0, 2, 1, 1))).toBe(false);
    expect(interpenetrates(a, B(1 - 2 * EPS, 0, 0, 2, 1, 1))).toBe(true);
    expect(touches(a, B(0, 0, 1, 1, 1, 2))).toBe(true); // shared face
    expect(touches(a, B(1, 1, 0, 2, 2, 1))).toBe(false); // shared edge only
    expect(touches(a, B(0.5, 0.5, 0.5, 2, 2, 2))).toBe(true); // overlapping
    expect(touches(a, B(1.1, 0, 0, 2, 1, 1))).toBe(false);
  });

  it("union of touching solids: casting ∪ cover encloses a valve neither encloses alone", () => {
    const casting = B(0, 0, 340, 480, 220, 430);
    const cover = B(10, 10, 430, 470, 210, 520);
    const valve = B(50, 95, 380, 62, 107, 450);
    expect(containsClosed(casting, valve)).toBe(false);
    expect(containsClosed(cover, valve)).toBe(false);
    expect(insideUnion(valve, [casting, cover])).toBe(true);
    // A valve poking out beside the cover's footprint is not.
    expect(insideUnion(B(2, 95, 380, 8, 107, 450), [casting, cover])).toBe(false);
    expect(insideUnion(valve, [])).toBe(false);
    expect(
      insideUnion(
        valve,
        Array.from({ length: MAX_UNION_BOXES + 1 }, () => casting),
      ),
    ).toBe(false);
  });

  it("insideUnion: L-shaped notch, overlapping members, exactly 8 boxes, zero thickness (C-Q10)", () => {
    // L: a 2×2 square missing its (+x, +y) quarter, made of two boxes.
    const L = [B(0, 0, 0, 2, 1, 1), B(0, 1, 0, 1, 2, 1)];
    expect(insideUnion(B(0.2, 0.2, 0.2, 1.8, 0.8, 0.8), L)).toBe(true);
    expect(insideUnion(B(0.2, 0.2, 0.2, 0.8, 1.8, 0.8), L)).toBe(true);
    expect(insideUnion(B(0.2, 0.2, 0.2, 1.8, 1.8, 0.8), L)).toBe(false); // reaches into the notch
    expect(insideUnion(B(0.5, 0.5, 0.2, 1.2, 1.2, 0.8), L)).toBe(false); // just the notch corner
    // Overlapping members (not just touching) cover their union.
    const over = [B(0, 0, 0, 1.5, 1, 1), B(1, 0, 0, 3, 1, 1)];
    expect(insideUnion(B(0.1, 0.1, 0.1, 2.9, 0.9, 0.9), over)).toBe(true);
    expect(insideUnion(B(0.1, 0.1, 0.1, 3.1, 0.9, 0.9), over)).toBe(false);
    // Exactly MAX_UNION_BOXES unit cubes in a row: accepted; one more box: refused (false).
    const row = Array.from({ length: MAX_UNION_BOXES }, (_, k) => B(k, 0, 0, k + 1, 1, 1));
    expect(insideUnion(B(0.1, 0.1, 0.1, MAX_UNION_BOXES - 0.1, 0.9, 0.9), row)).toBe(true);
    expect(insideUnion(B(0.1, 0.1, 0.1, 0.9, 0.9, 0.9), [...row, B(20, 0, 0, 21, 1, 1)])).toBe(
      false,
    );
    // A gap of more than ε between members is not covered.
    const gap = [B(0, 0, 0, 1, 1, 1), B(1.01, 0, 0, 2, 1, 1)];
    expect(insideUnion(B(0.5, 0.2, 0.2, 1.5, 0.8, 0.8), gap)).toBe(false);
    // Zero-thickness boxes (a flat plate, a line) on a seam or face count as inside (closed).
    expect(insideUnion(B(0.5, 0.2, 0.5, 1.5, 0.8, 0.5), over)).toBe(true);
    expect(
      insideUnion(B(1, 0.5, 0.5, 1, 0.5, 0.5), [B(0, 0, 0, 1, 1, 1), B(1, 0, 0, 2, 1, 1)]),
    ).toBe(true);
    expect(insideUnion(B(0.5, 0.5, 1, 1.5, 0.5, 1), L)).toBe(true); // on the top face
    expect(insideUnion(B(0.5, 0.5, 1.5, 1.5, 0.5, 1.5), L)).toBe(false); // above it
  });

  it("blocks are connected components with the smallest index as id", () => {
    const boxes: Bounds[] = [
      B(0, 0, 0, 1, 1, 1),
      B(5, 5, 5, 6, 6, 6),
      B(0, 0, 1, 1, 1, 2),
      B(0, 0, 2, 1, 1, 3),
    ];
    const ids = blocksOf(
      4,
      [
        [0, 2],
        [2, 3],
        [1, 3],
      ],
      boxes,
    );
    expect([...ids]).toEqual([0, 1, 0, 0]);
  });

  it("seated or enclosed: inside, one-face crossings; not two-face", () => {
    const block = B(0, 0, 0, 4, 4, 2);
    expect(seatedOrEnclosed(B(1, 1, 0.5, 3, 3, 1.5), block)).toBe(true);
    expect(seatedOrEnclosed(B(1, 1, 1, 3, 3, 3), block)).toBe(true); // through the top
    expect(seatedOrEnclosed(B(1, 1, -1, 3, 3, 1), block)).toBe(true); // through the bottom
    expect(seatedOrEnclosed(B(1, 1, -1, 3, 3, 3), block)).toBe(false); // through both
    expect(seatedOrEnclosed(B(3, 1, 1, 5, 3, 3), block)).toBe(false); // corner
  });
});

describe("certificates are sound: if one holds for [lo, hi], the pose predicate holds at every offset in it", () => {
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
  const rand = mulberry32(7);
  const rb = (): Bounds => {
    const x = rand() * 4;
    const y = rand() * 4;
    const z = rand() * 4;
    return B(x, y, z, x + 0.2 + rand() * 3, y + 0.2 + rand() * 3, z + 0.2 + rand() * 3);
  };
  const ri = (): [Vec, Vec] => {
    const lo: number[] = [];
    const hi: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = (rand() - 0.5) * 3 * (rand() < 0.3 ? 0 : 1);
      const b = a + rand() * 2 * (rand() < 0.3 ? 0 : 1);
      lo.push(a);
      hi.push(b);
    }
    return [lo as unknown as Vec, hi as unknown as Vec];
  };
  const at = (lo: Vec, hi: Vec): Vec => [
    lo[0] + rand() * (hi[0] - lo[0]),
    lo[1] + rand() * (hi[1] - lo[1]),
    lo[2] + rand() * (hi[2] - lo[2]),
  ];
  const poseHide = (p: Bounds, s: Bounds): boolean => {
    let over = 0;
    for (let k = 0; k < 3; k++) {
      if (p[k]! < s[k]! - EPS || p[k]! >= s[k + 3]! - EPS) return false;
      if (p[k + 3]! > s[k + 3]! + EPS) over++;
    }
    return over <= 1;
  };

  it("for 20 000 random boxes and intervals", { timeout: 60_000 }, () => {
    const hits = {
      behind: 0,
      front: 0,
      weak: 0,
      enc: 0,
      never: 0,
      hide: 0,
      nohide: 0,
      inter: 0,
      may: 0,
    };
    for (let n = 0; n < 20_000; n++) {
      const s = rb();
      // A quarter of the pairs start nested, so enclosure and crossing certificates fire too.
      const p: Bounds =
        rand() < 0.25
          ? (() => {
              const w = [0, 1, 2].map((k) => (s[k + 3]! - s[k]!) * (0.2 + 0.6 * rand()));
              const o = [0, 1, 2].map((k) => s[k]! + rand() * (s[k + 3]! - s[k]! - w[k]!));
              return B(o[0]!, o[1]!, o[2]!, o[0]! + w[0]!, o[1]! + w[1]!, o[2]! + w[2]!);
            })()
          : rb();
      const [lo, hi] = ri();
      const certs = {
        behind: behindAxis(p, s, hi) >= 0,
        front: frontAxis(p, s, lo) >= 0,
        weak: weakBehind(p, s, hi),
        enc: enclosedThroughout(p, s, lo, hi),
        never: neverEnclosed(p, s, lo, hi),
        hide: hideThroughout(p, s, lo, hi),
        nohide: neverHide(p, s, lo, hi),
        inter: interpenetratesThroughout(p, s, lo, hi),
        may: mayInterpenetrate(p, s, lo, hi),
      };
      for (const [k, v] of Object.entries(certs)) if (v) hits[k as keyof typeof hits]++;
      let anyInter = false;
      for (let q = 0; q < 12; q++) {
        const r = q === 0 ? lo : q === 1 ? hi : at(lo, hi);
        const pp = shift(p, r);
        if (certs.behind) expect([0, 1, 2].some((k) => pp[k + 3]! <= s[k]! + EPS)).toBe(true);
        if (certs.front) expect([0, 1, 2].some((k) => s[k + 3]! <= pp[k]! + EPS)).toBe(true);
        if (certs.weak) expect([0, 1, 2].every((k) => pp[k + 3]! <= s[k + 3]! + EPS)).toBe(true);
        if (certs.enc) expect(containsClosed(s, pp)).toBe(true);
        if (certs.never) expect(containsClosed(s, pp)).toBe(false);
        if (certs.hide) expect(poseHide(pp, s)).toBe(true);
        if (certs.nohide) expect(poseHide(pp, s)).toBe(false);
        if (certs.inter) expect(interpenetrates(pp, s)).toBe(true);
        if (interpenetrates(pp, s)) anyInter = true;
      }
      if (anyInter) expect(certs.may).toBe(true);
      const c = core(p, lo, hi);
      if (c) for (let q = 0; q < 4; q++) expect(containsClosed(shift(p, at(lo, hi)), c)).toBe(true);
    }
    // Every certificate fired often enough to be tested.
    for (const [k, v] of Object.entries(hits)) expect(v, k).toBeGreaterThan(50);
  });
});
