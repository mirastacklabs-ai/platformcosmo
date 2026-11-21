/**
 * LIS copy construction (assemblies §9.4, track A1-2b): `planCopies` unit tests and a randomized
 * property (every epoch embeds increasingly in the final DOM, earlier epochs included).
 */
import { describe, expect, it } from "vitest";
import type { CopyPlan } from "../src/depth/copies.js";
import { copyKey, parseCopyKey, planCopies } from "../src/depth/copies.js";

const none = (): boolean => false;

function plan(
  n: number,
  initial: number[],
  epochs: number[][],
  isStatic: (i: number) => boolean = none,
  max = n,
): CopyPlan {
  const r = planCopies(n, initial, epochs, isStatic, max);
  if (!r.ok) throw new Error(`no plan: ${JSON.stringify(r)}`);
  return r.plan;
}

/** Every epoch's copies appear in the final DOM in its order (strictly increasing positions). */
function embeds(p: CopyPlan, epochs: number[][]): boolean {
  const at = new Map(p.dom.map(([i, c], q) => [`${i}/${c}`, q]));
  return epochs.every((order, k) => {
    let last = -1;
    return order.every((i, q) => {
      const pos = at.get(`${i}/${p.use[k]![q]}`);
      if (pos === undefined || pos <= last) return false;
      last = pos;
      return true;
    });
  });
}

describe("copy keys", () => {
  it("copy 0 is the item key; k ≥ 1 adds __c<k>; halves keep their marker", () => {
    expect(copyKey("a/b", 0)).toBe("a/b");
    expect(copyKey("a/b__front", 2)).toBe("a/b__front__c2");
    expect(parseCopyKey("a/b__front__c2")).toEqual({ item: "a/b__front", copy: 2 });
    expect(parseCopyKey("a/b__back")).toEqual({ item: "a/b__back", copy: 0 });
    expect(parseCopyKey("x__c0")).toEqual({ item: "x__c0", copy: 0 }); // not a copy key
  });
});

describe("planCopies (LIS construction)", () => {
  it("no order change: no copies, D is the initial order", () => {
    const p = plan(
      3,
      [2, 0, 1],
      [
        [2, 0, 1],
        [2, 1],
        [0, 1],
      ],
    );
    expect(p.extra).toBe(0);
    expect(p.dom).toEqual([
      [2, 0],
      [0, 0],
      [1, 0],
    ]);
    expect(p.use).toEqual([
      [0, 0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  it("one swap: one new copy right after its predecessor", () => {
    // 0 = static b, 1 = moving a: [a, b] then [b, a]
    const p = plan(
      2,
      [1, 0],
      [
        [1, 0],
        [0, 1],
      ],
      (i) => i === 0,
    );
    expect(p.extra).toBe(1);
    expect(p.dom).toEqual([
      [1, 0],
      [0, 0],
      [1, 1],
    ]);
    expect(p.use).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(p.copies).toEqual([1, 2]);
  });

  it("ties between moving items go by item key: the smaller key keeps its place", () => {
    const p = plan(
      2,
      [0, 1],
      [
        [0, 1],
        [1, 0],
      ],
    );
    // LIS of length 1 either way; item 0 (the smaller key) is kept, item 1 is copied in front
    expect(p.copies).toEqual([1, 2]);
    expect(p.dom).toEqual([
      [1, 1],
      [0, 0],
      [1, 0],
    ]);
  });

  it("static items are never copied, even when copying them would be cheaper", () => {
    // s (0) static; a (1), b (2) moving: [s, a, b] → [a, b, s]. A plain LIS keeps a, b and
    // copies s; the weighted one keeps s and copies a and b.
    const p = plan(
      3,
      [0, 1, 2],
      [
        [0, 1, 2],
        [1, 2, 0],
      ],
      (i) => i === 0,
    );
    expect(p.copies).toEqual([1, 2, 2]);
    expect(p.extra).toBe(2);
    const plain = plan(
      3,
      [0, 1, 2],
      [
        [0, 1, 2],
        [1, 2, 0],
      ],
    );
    expect(plain.copies).toEqual([2, 1, 1]);
  });

  it("the wrap back to epoch 1 stays valid and reuses copy 0", () => {
    const epochs = [
      [1, 0],
      [0, 1],
      [1, 0],
    ];
    const p = plan(2, [1, 0], epochs, (i) => i === 0);
    expect(p.extra).toBe(1);
    expect(p.use[2]).toEqual([0, 0]); // epoch 3 = epoch 1: copy 0 again
    expect(embeds(p, epochs)).toBe(true);
  });

  it("reuses an existing copy that lies between the epoch's neighbours", () => {
    // static walls w0 (0) < w1 (1) < w2 (2); x (3) moves from before w0 to between w1/w2, to
    // after w2, and back between w1/w2: the last epoch reuses the copy made for the second.
    const W = (i: number): boolean => i < 3;
    const epochs = [
      [3, 0, 1, 2],
      [0, 1, 3, 2],
      [0, 1, 2, 3],
      [0, 1, 3, 2],
    ];
    const p = plan(4, [3, 0, 1, 2], epochs, W);
    expect(p.copies).toEqual([1, 1, 1, 3]);
    expect(p.use[1]![2]).toBe(1);
    expect(p.use[2]![3]).toBe(2);
    expect(p.use[3]![2]).toBe(1); // reused, no fourth copy
    expect(embeds(p, epochs)).toBe(true);
  });

  it("several new copies after one predecessor keep the epoch's order", () => {
    // [s, a, b] → [b?]: s static (0), a (1), b (2), c (3): [a, b, c, s] → [s, c, b, a]
    const epochs = [
      [1, 2, 3, 0],
      [0, 3, 2, 1],
    ];
    const p = plan(4, [1, 2, 3, 0], epochs, (i) => i === 0);
    expect(p.extra).toBeGreaterThanOrEqual(2);
    expect(embeds(p, epochs)).toBe(true);
  });

  it("hidden items keep their copy for later epochs; items absent from an epoch need nothing", () => {
    const epochs = [[0, 1], [1], [1, 0]];
    const p = plan(2, [0, 1], epochs);
    expect(p.use[1]).toEqual([0]);
    expect(embeds(p, epochs)).toBe(true);
  });

  it("over the budget: reason budget; a static item that would need a copy: reason static", () => {
    expect(
      planCopies(
        2,
        [1, 0],
        [
          [1, 0],
          [0, 1],
        ],
        (i) => i === 0,
        0,
      ),
    ).toEqual({
      ok: false,
      reason: "budget",
      extra: 1,
    });
    expect(
      planCopies(
        2,
        [0, 1],
        [
          [0, 1],
          [1, 0],
        ],
        () => true,
        5,
      ),
    ).toEqual({
      ok: false,
      reason: "static",
      item: 1,
    });
  });

  it("randomized: every epoch embeds in the final DOM; statics never copied; deterministic", () => {
    let seed = 0x1a2b;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 300; round++) {
      const n = 2 + Math.floor(rand() * 9);
      const statics = new Set<number>();
      for (let i = 0; i < n; i++) if (rand() < 0.3) statics.add(i);
      const sorted = (xs: number[]): number[] =>
        xs
          .map((x) => [x, rand()] as const)
          .sort((a, b) => a[1] - b[1])
          .map((x) => x[0]);
      const staticOrder = sorted([...statics]);
      const epoch = (): number[] => {
        // a random order of the visible items with the statics in one fixed order
        const moving = sorted([...Array(n).keys()].filter((i) => !statics.has(i) && rand() < 0.8));
        const out = [...staticOrder];
        for (const m of moving) out.splice(Math.floor(rand() * (out.length + 1)), 0, m);
        return out;
      };
      const first = epoch();
      const initial = [...first, ...[...Array(n).keys()].filter((i) => !first.includes(i))];
      const epochs = [first, ...Array.from({ length: 1 + Math.floor(rand() * 6) }, epoch)];
      const r = planCopies(n, initial, epochs, (i) => statics.has(i), 1000);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(embeds(r.plan, epochs)).toBe(true);
      for (const s of statics) expect(r.plan.copies[s]).toBe(1);
      expect(r.plan.dom).toHaveLength(n + r.plan.extra);
      expect(planCopies(n, initial, epochs, (i) => statics.has(i), 1000)).toEqual(r);
    }
  });
});
