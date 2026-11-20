import { describe, expect, test } from "vitest";
import { checkBrickPlacement, MAX_STUDS } from "../src/index.js";

const part = (over: Record<string, unknown>) =>
  checkBrickPlacement({
    path: "/assemblies/0/parts/2",
    shape: "brick:brick",
    units: "stud",
    ...over,
  });

describe("brick/off-grid", () => {
  test("whole positions and sizes are clean", () => {
    expect(part({ at: [0, 2, 3], size: [1, 6, 3] })).toEqual([]);
    expect(part({ at: [-1, 1, 0], pitch: [0, 6, 0], count: 2, size: [1, 2, 5] })).toEqual([]);
    expect(part({})).toEqual([]);
  });

  test("a non-integer stud position warns, naming the axis and a fix", () => {
    const [d, ...rest] = part({ at: [0.5, 2, 3], size: [1, 6, 3] });
    expect(rest).toEqual([]);
    expect(d).toMatchObject({
      severity: "warning",
      code: "brick/off-grid",
      path: "/assemblies/0/parts/2/at",
    });
    expect(d?.message).toContain("x (studs)");
    expect(d?.suggestion).toBe("Use [1, 2, 3]");
    expect(d?.params).toMatchObject({ field: "at", axes: ["x"] });
  });

  test("a non-integer plate position (z) warns", () => {
    const [d] = part({ at: [0, 0, 2.5] });
    expect(d?.code).toBe("brick/off-grid");
    expect(d?.message).toContain("z (plates)");
    expect(d?.params).toMatchObject({ axes: ["z"] });
  });

  test("several axes in one diagnostic; one diagnostic per field", () => {
    const ds = part({ at: [0.25, 1.5, 2.1], pitch: [0.5, 0, 0], count: 3, size: [1.5, 2, 1] });
    expect(ds.map((d) => d.path.split("/").at(-1))).toEqual(["at", "pitch", "size"]);
    expect(ds[0]?.params?.["axes"]).toEqual(["x", "y", "z"]);
  });

  test("pitch only matters when count > 1", () => {
    expect(part({ at: [0, 0, 0], pitch: [0.5, 0, 0] })).toEqual([]);
    expect(part({ at: [0, 0, 0], pitch: [0.5, 0, 0], count: 1 })).toEqual([]);
    expect(part({ at: [0, 0, 0], pitch: [0.5, 0, 0], count: 2 })).toHaveLength(1);
  });

  test("floating-point noise on whole numbers is not off-grid", () => {
    expect(part({ at: [0.1 + 0.2 - 0.3 + 1, 2.0000000001, 3 - 1e-12] })).toEqual([]);
    expect(part({ at: [1.001, 0, 0] })).toHaveLength(1);
  });

  test("only stud units are checked, only brick: shapes", () => {
    expect(part({ units: "mm", at: [0.5, 0, 0] })).toEqual([]);
    expect(part({ units: undefined, at: [0.5, 0, 0] })).toEqual([]);
    expect(part({ shape: "hw:dimm", at: [0.5, 0, 0] })).toEqual([]);
    expect(part({ shape: "box", at: [0.5, 0, 0] })).toEqual([]);
  });

  test("garbage input never throws and yields nothing for bad fields", () => {
    expect(part({ at: "x", pitch: 5, size: null, count: "9" })).toEqual([]);
    expect(part({ at: [NaN, Infinity, "1"], size: [undefined] })).toEqual([]);
    expect(() => checkBrickPlacement({ path: "", shape: 5 as never })).not.toThrow();
    expect(checkBrickPlacement({ path: "", shape: 5 as never })).toEqual([]);
    // a huge count does not loop over instances
    const t = performance.now();
    expect(part({ at: [0, 0, 0], pitch: [1, 0, 0], count: 1e12 })).toEqual([]);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe("stud count cap", () => {
  test("a footprint over the cap is an assembly/shape-params error", () => {
    const [d, ...rest] = part({ size: [17, 16, 1], shape: "brick:plate" });
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ severity: "error", code: "assembly/shape-params" });
    expect(d?.path).toBe("/assemblies/0/parts/2/size");
    expect(d?.message).toContain(String(MAX_STUDS));
  });

  test("at the cap, with studs off, on a tile or in other units: clean", () => {
    expect(part({ size: [16, 16, 1], shape: "brick:plate" })).toEqual([]);
    expect(part({ size: [40, 40, 1], shape: "brick:plate", params: { studs: false } })).toEqual([]);
    expect(part({ size: [40, 40, 1], shape: "brick:tile" })).toEqual([]);
    expect(part({ size: [40, 40, 1], shape: "brick:tile", params: { studs: true } })).toHaveLength(
      1,
    );
    expect(part({ size: [40, 40, 1], shape: "brick:unknown" })).toEqual([]);
  });

  test("a huge size is checked without allocation", () => {
    const t = performance.now();
    expect(part({ size: [1e12, 1e12, 1], shape: "brick:brick" })).toHaveLength(1);
    expect(performance.now() - t).toBeLessThan(100);
  });
});
