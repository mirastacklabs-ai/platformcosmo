import { describe, expect, test } from "vitest";
import type { Box3, SceneGroup } from "../src/contracts/index.js";
import { compareBoxes, depthOrder, orderGroups } from "../src/depth/index.js";
import { createProjection } from "../src/geometry/index.js";

const proj = createProjection();
const box = (x: number, y: number, z: number, w = 1, d = 1, h = 1): Box3 => ({
  origin: { x, y, z },
  size: { x: w, y: d, z: h },
});

describe("compareBoxes", () => {
  test("smaller x, y or z is drawn first", () => {
    expect(compareBoxes(box(0, 0, 0), box(1, 0, 0))).toBe(-1);
    expect(compareBoxes(box(1, 0, 0), box(0, 0, 0))).toBe(1);
    expect(compareBoxes(box(0, 0, 0), box(0, 1, 0))).toBe(-1);
    expect(compareBoxes(box(0, 0, 0), box(0, 0, 1))).toBe(-1);
  });

  test("container before contents", () => {
    expect(compareBoxes(box(0, 0, 0, 2, 2, 2), box(0.5, 0.5, 0.5, 0.5, 0.5, 0.5))).toBe(-1);
    expect(compareBoxes(box(0.5, 0.5, 0.5, 0.5, 0.5, 0.5), box(0, 0, 0, 2, 2, 2))).toBe(1);
  });

  test("conflicting axes are undecided", () => {
    expect(compareBoxes(box(0, 1, 0), box(1, 0, 0))).toBe(0);
  });
});

describe("depthOrder", () => {
  test("orders a row along x back to front regardless of input order", () => {
    const items = [
      { id: "c", box: box(2, 0, 0) },
      { id: "a", box: box(0, 0, 0) },
      { id: "b", box: box(1, 0, 0) },
    ];
    expect(depthOrder(items, proj)).toEqual(["a", "b", "c"]);
  });

  test("a tall object behind a short one still draws first", () => {
    const items = [
      { id: "front-short", box: box(1, 1, 0, 1, 1, 0.5) },
      { id: "back-tall", box: box(0, 0, 0, 1, 1, 3) },
    ];
    expect(depthOrder(items, proj)).toEqual(["back-tall", "front-short"]);
  });

  test("stacked boxes sort by z", () => {
    const items = [
      { id: "top", box: box(0, 0, 1) },
      { id: "bottom", box: box(0, 0, 0) },
    ];
    expect(depthOrder(items, proj)).toEqual(["bottom", "top"]);
  });

  test("rack before the devices inside it (flat siblings)", () => {
    const items = [
      { id: "r1/u3", box: box(0.1, 0.1, 0.5, 0.8, 0.8, 0.1) },
      { id: "r1", box: box(0, 0, 0, 1, 1, 2) },
      { id: "r1/u1", box: box(0.1, 0.1, 0.1, 0.8, 0.8, 0.1) },
    ];
    const order = depthOrder(items, proj);
    expect(order[0]).toBe("r1");
    expect(order.indexOf("r1/u1")).toBeLessThan(order.indexOf("r1/u3"));
  });

  test("disjoint screen regions fall back to depth key then id", () => {
    const items = [
      { id: "z", box: box(0, 0, 0) },
      { id: "a", box: box(0, 20, 0) },
    ];
    // same depth key? no: a is nearer (y=20). z first.
    expect(depthOrder(items, proj)).toEqual(["z", "a"]);
    const same = [
      { id: "b", box: box(10, 0, 0) },
      { id: "a", box: box(0, 10, 0) },
    ];
    expect(depthOrder(same, proj)).toEqual(["a", "b"]);
  });

  test("cycles are broken deterministically", () => {
    // Classic three-box cycle.
    const items = [
      { id: "a", box: box(0, 2, 0, 3, 1, 1) },
      { id: "b", box: box(2, 0, 0, 1, 3, 1) },
      { id: "c", box: box(0, 0, 1, 3, 3, 1) },
    ];
    const first = depthOrder(items, proj);
    const second = depthOrder([...items].reverse(), proj);
    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
  });

  test("input order does not change the result", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `n${String(i).padStart(2, "0")}`,
      box: box(i % 4, Math.floor(i / 4), 0, 0.8, 0.8, 0.5 + (i % 3) * 0.25),
    }));
    const base = depthOrder(items, proj);
    expect(depthOrder([...items].reverse(), proj)).toEqual(base);
    expect(
      depthOrder(
        [...items].sort((a, b) => (a.id < b.id ? 1 : -1)),
        proj,
      ),
    ).toEqual(base);
  });

  test("rejects duplicate ids", () => {
    const items = [
      { id: "a", box: box(0, 0, 0) },
      { id: "a", box: box(1, 0, 0) },
    ];
    expect(() => depthOrder(items, proj)).toThrow(/duplicate/);
  });

  test("empty input", () => {
    expect(depthOrder([], proj)).toEqual([]);
  });
});

describe("orderGroups", () => {
  const g = (id: string, level: number, x: number): SceneGroup => ({
    id,
    kind: "group",
    style: "zone",
    box: box(x, 0, 0, 1, 1, 0.1),
    level,
  });
  test("by level, then depth, then id", () => {
    const out = orderGroups([g("c", 1, 0), g("b", 0, 5), g("a", 0, 1), g("d", 0, 1)]);
    expect(out.map((x) => x.id)).toEqual(["a", "d", "b", "c"]);
  });
});
