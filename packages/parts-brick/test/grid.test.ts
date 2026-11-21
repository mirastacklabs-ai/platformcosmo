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

  test("other units are converted to studs first (8 mm studs, 3.2 mm plates)", () => {
    expect(part({ units: "mm", at: [8, 16, 6.4], size: [16, 32, 9.6] })).toEqual([]);
    const [d] = part({ units: "mm", at: [4, 0, 0] });
    expect(d?.code).toBe("brick/off-grid");
    expect(d?.suggestion).toBe("Use [8, 0, 0]"); // 0.5 studs rounds up
    expect(d?.params).toMatchObject({ axes: ["x"] });
    expect(part({ units: "mm", at: [0, 0, 3.2] })).toEqual([]); // one plate high
    expect(part({ units: "mm", at: [0, 0, 8] })).toHaveLength(1); // 2.5 plates
    expect(part({ units: "cm", at: [0.8, 0, 0] })).toEqual([]);
    expect(part({ units: "cm", at: [1, 0, 0] })).toHaveLength(1);
    expect(part({ units: "in", at: [0, 0, 0], size: [8 / 25.4, 8 / 25.4, 3.2 / 25.4] })).toEqual(
      [],
    );
  });

  test("unknown or missing units, and other shapes, are skipped", () => {
    expect(part({ units: "furlong", at: [0.5, 0, 0] })).toEqual([]);
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

  test("slope counts one stud column, or none when 1 wide; inverted counts the footprint", () => {
    const slope = (size: number[], params?: object) =>
      part({ shape: "brick:slope", size, ...(params ? { params } : {}) });
    expect(slope([2, 256, 3])).toEqual([]); // 256 studs in one column
    expect(slope([2, 257, 3])).toHaveLength(1);
    expect(slope([1, 1000, 3])).toEqual([]); // wedge only: no studs
    expect(slope([20, 20, 3])).toEqual([]); // 20 studs
    expect(slope([20, 20, 3], { inverted: true })).toHaveLength(1); // 400
    expect(slope([1, 1000, 3], { inverted: true })).toEqual([]); // too narrow to invert
  });

  test("a round on a side axis carries no studs", () => {
    const round = (axis?: string) =>
      part({ shape: "brick:round", size: [20, 20, 3], ...(axis ? { axis } : {}) });
    expect(round()).toHaveLength(1);
    expect(round("z")).toHaveLength(1);
    expect(round("x")).toEqual([]);
    expect(round("y")).toEqual([]);
  });

  test("the stud count uses the clamped size, in stud units", () => {
    expect(part({ units: "mm", shape: "brick:plate", size: [128, 128, 3.2] })).toEqual([]); // 16 x 16
    expect(part({ units: "mm", shape: "brick:plate", size: [136, 128, 3.2] })).toHaveLength(1);
    expect(part({ shape: "brick:plate", size: [1e30, 1e30, 1] })).toHaveLength(1);
  });

  test("a huge size is checked without allocation", () => {
    const t = performance.now();
    expect(part({ size: [1e12, 1e12, 1], shape: "brick:brick" })).toHaveLength(1);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe("group offsets", () => {
  const group = (over: Record<string, unknown>) =>
    checkBrickPlacement({
      path: "/assemblies/0/parts/1",
      kind: "group",
      units: "stud",
      shapes: ["brick:brick"],
      ...over,
    });

  test("an off-grid group holding bricks warns on at and on pitch when repeated", () => {
    const [d] = group({ at: [0.5, 0, 0] });
    expect(d).toMatchObject({
      code: "brick/off-grid",
      severity: "warning",
      path: "/assemblies/0/parts/1/at",
    });
    const p = group({ at: [0, 0, 0], pitch: [0, 1.5, 0], count: 2 });
    expect(p[0]?.path).toBe("/assemblies/0/parts/1/pitch");
    expect(group({ at: [0, 0, 0], pitch: [0, 1.5, 0] })).toEqual([]); // pitch unused without count
  });

  test("on-grid, brick-free and unitless groups are silent", () => {
    expect(group({ at: [1, 2, 3] })).toEqual([]);
    expect(group({ at: [0.5, 0, 0], shapes: ["hw:dimm"] })).toEqual([]);
    expect(group({ at: [0.5, 0, 0], shapes: [] })).toEqual([]);
    expect(group({ at: [0.5, 0, 0], units: undefined })).toEqual([]);
  });
});
