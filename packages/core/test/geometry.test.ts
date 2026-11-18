import { describe, expect, test } from "vitest";
import type { Box3, PrimitiveKind, Vec2 } from "../src/contracts/index.js";
import {
  boxCorners,
  convexHull,
  createProjection,
  faceToPath,
  fmt,
  pointsToPath,
  primitiveFaces,
  primitiveSilhouette,
  projectBoxBounds,
  round2,
  unionRects,
} from "../src/geometry/index.js";

const proj = createProjection();
const unit: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } };

/** Positive = clockwise in screen space (y down). */
function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec2;
    const q = points[(i + 1) % points.length] as Vec2;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

describe("rounding", () => {
  test("round2 caps at two decimals and normalizes -0", () => {
    expect(round2(1.005)).toBe(1);
    expect(round2(1.239)).toBe(1.24);
    expect(Object.is(round2(-0.001), 0)).toBe(true);
    expect(fmt(12.5)).toBe("12.5");
    expect(fmt(3)).toBe("3");
    expect(() => round2(NaN)).toThrow(RangeError);
  });
});

describe("projection", () => {
  test("2:1 dimetric defaults", () => {
    expect(proj.tileWidth).toBe(64);
    expect(proj.zScale).toBe(32);
    expect(proj.project({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0 });
    expect(proj.project({ x: 1, y: 0, z: 0 })).toEqual({ x: 32, y: 16 });
    expect(proj.project({ x: 0, y: 1, z: 0 })).toEqual({ x: -32, y: 16 });
    expect(proj.project({ x: 1, y: 1, z: 0 })).toEqual({ x: 0, y: 32 });
    expect(proj.project({ x: 0, y: 0, z: 1 })).toEqual({ x: 0, y: -32 });
  });

  test("tile is a 64x32 diamond", () => {
    const r = projectBoxBounds(proj, { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 0 } });
    expect(r).toEqual({ x: -32, y: 0, width: 64, height: 32 });
  });

  test("custom tile width and zScale; invalid values throw", () => {
    const p = createProjection({ tileWidth: 100, zScale: 10 });
    expect(p.project({ x: 1, y: 0, z: 2 })).toEqual({ x: 50, y: 5 });
    expect(() => createProjection({ tileWidth: 0 })).toThrow(RangeError);
    expect(() => createProjection({ zScale: -1 })).toThrow(RangeError);
  });

  test("output has at most two decimals", () => {
    const p = createProjection({ tileWidth: 64 });
    const v = p.project({ x: 0.123456, y: 0.987654, z: 0.333333 });
    expect(round2(v.x)).toBe(v.x);
    expect(round2(v.y)).toBe(v.y);
  });

  test("boxCorners and unionRects", () => {
    expect(boxCorners(unit)).toHaveLength(8);
    expect(boxCorners(unit)[7]).toEqual({ x: 1, y: 1, z: 1 });
    expect(unionRects([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(
      unionRects([
        { x: 0, y: 0, width: 2, height: 2 },
        { x: 5, y: -1, width: 1, height: 1 },
      ]),
    ).toEqual({ x: 0, y: -1, width: 6, height: 3 });
  });
});

describe("box primitives", () => {
  for (const kind of ["cube", "slab", "platform"] as const) {
    test(`${kind}: three clockwise faces in drawing order`, () => {
      const faces = primitiveFaces(kind, unit, proj);
      expect(faces.map((f) => f.face)).toEqual(["left", "right", "top"]);
      for (const f of faces) {
        expect(f.points).toHaveLength(4);
        expect(signedArea(f.points)).toBeGreaterThan(0);
        expect(f.d).toBeUndefined();
      }
    });
  }

  test("unit cube face coordinates", () => {
    const [left, right, top] = primitiveFaces("cube", unit, proj);
    expect(top?.points).toEqual([
      { x: 0, y: -32 },
      { x: 32, y: -16 },
      { x: 0, y: 0 },
      { x: -32, y: -16 },
    ]);
    // Left face is the +y side (lower left), right face the +x side (lower right).
    const xs = (f?: { points: readonly Vec2[] }) => f?.points.map((p) => p.x);
    expect(Math.min(...(xs(left) ?? []))).toBe(-32);
    expect(Math.max(...(xs(left) ?? []))).toBe(0);
    expect(Math.min(...(xs(right) ?? []))).toBe(0);
    expect(Math.max(...(xs(right) ?? []))).toBe(32);
  });

  test("face areas follow the projection (top diamond = tile area)", () => {
    const faces = primitiveFaces("cube", unit, proj);
    const top = faces.find((f) => f.face === "top");
    expect(signedArea(top?.points ?? [])).toBe(1024);
  });

  test("zero-height solids omit the side faces", () => {
    const flat: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 0 } };
    expect(primitiveFaces("slab", flat, proj).map((f) => f.face)).toEqual(["top"]);
  });

  test("invalid boxes throw", () => {
    const bad: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 1, z: 1 } };
    expect(() => primitiveFaces("cube", bad, proj)).toThrow(RangeError);
    const nan: Box3 = { origin: { x: NaN, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } };
    expect(() => primitiveFaces("cube", nan, proj)).toThrow(RangeError);
  });

  test("silhouette of a cube is the 6-point hexagon, clockwise", () => {
    const s = primitiveSilhouette("cube", unit, proj);
    expect(s.points).toHaveLength(6);
    expect(signedArea(s.points)).toBeGreaterThan(0);
    expect(s.d.startsWith("M")).toBe(true);
    expect(s.d.endsWith("Z")).toBe(true);
  });
});

describe("hex-prism", () => {
  test("one left strip, one right strip, one hexagonal top", () => {
    const faces = primitiveFaces("hex-prism", unit, proj);
    expect(faces.map((f) => f.face)).toEqual(["left", "right", "top"]);
    expect(faces[2]?.points).toHaveLength(6);
    // a vertex faces the viewer: one visible side each, 2 top + 2 bottom points
    expect(faces[1]?.points).toHaveLength(4);
    expect(faces[0]?.points).toHaveLength(4);
    for (const f of faces) expect(signedArea(f.points)).toBeGreaterThan(0);
  });

  test("silhouette stays inside the footprint bounds", () => {
    const s = primitiveSilhouette("hex-prism", unit, proj);
    const b = projectBoxBounds(proj, unit);
    for (const p of s.points) {
      expect(p.x).toBeGreaterThanOrEqual(b.x);
      expect(p.x).toBeLessThanOrEqual(b.x + b.width);
    }
  });
});

describe("cylinder", () => {
  const cyl: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } };

  test("circular footprint gives arc paths", () => {
    const faces = primitiveFaces("cylinder", cyl, proj);
    expect(faces.map((f) => f.face)).toEqual(["left", "right", "top"]);
    for (const f of faces) {
      expect(f.d).toMatch(/^M[-\d. ]+A/);
      expect(f.d?.endsWith("Z")).toBe(true);
      expect(signedArea(f.points)).toBeGreaterThan(0);
    }
    // top ellipse: rx = r*sqrt(2)*tw/2 = 22.63, ry = 11.31
    expect(faces[2]?.d).toBe(
      "M-22.63 -16A22.63 11.31 0 0 1 22.63 -16A22.63 11.31 0 0 1 -22.63 -16Z",
    );
  });

  test("elliptic footprint falls back to polylines", () => {
    const wide: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 1 } };
    for (const f of primitiveFaces("cylinder", wide, proj)) {
      expect(f.d).toBeUndefined();
      expect(f.points.length).toBeGreaterThan(4);
      expect(signedArea(f.points)).toBeGreaterThan(0);
    }
  });

  test("silhouette arc path", () => {
    const s = primitiveSilhouette("cylinder", cyl, proj);
    expect(s.d).toBe(
      "M-22.63 -16A22.63 11.31 0 0 1 22.63 -16L22.63 16A22.63 11.31 0 0 1 -22.63 16Z",
    );
  });
});

describe("helpers and determinism", () => {
  test("convexHull drops interior and collinear points", () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
      { x: 2, y: 2 },
    ]);
    expect(hull).toHaveLength(4);
    expect(signedArea(hull)).toBeGreaterThan(0);
  });

  test("faceToPath prefers d, pointsToPath formats compactly", () => {
    expect(
      pointsToPath([
        { x: 0, y: 0 },
        { x: 1.5, y: 2 },
        { x: 3, y: 0 },
      ]),
    ).toBe("M0 0L1.5 2L3 0Z");
    expect(pointsToPath([])).toBe("");
    expect(faceToPath({ face: "top", points: [], d: "M0 0Z" })).toBe("M0 0Z");
  });

  test("same input gives identical output for every primitive", () => {
    const kinds: PrimitiveKind[] = ["cube", "slab", "platform", "hex-prism", "cylinder"];
    const box: Box3 = { origin: { x: 1.3, y: 2.7, z: 0.2 }, size: { x: 1.1, y: 0.9, z: 0.45 } };
    for (const k of kinds) {
      const a = JSON.stringify(primitiveFaces(k, box, proj));
      const b = JSON.stringify(primitiveFaces(k, box, createProjection()));
      expect(a).toBe(b);
    }
  });
});

describe("review follow-ups", () => {
  test("round2 rounds halves away from zero", () => {
    expect(round2(0.125)).toBe(0.13);
    expect(round2(-0.125)).toBe(-0.13);
    expect(round2(2.5)).toBe(2.5);
  });

  test("exact cube left/right coordinates", () => {
    const [left, right] = primitiveFaces("cube", unit, proj);
    expect(left?.points).toEqual([
      { x: -32, y: -16 },
      { x: 0, y: 0 },
      { x: 0, y: 32 },
      { x: -32, y: 16 },
    ]);
    expect(right?.points).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: -16 },
      { x: 32, y: 16 },
      { x: 0, y: 32 },
    ]);
  });

  test("exact hex vertices touch the box extremes", () => {
    const faces = primitiveFaces("hex-prism", unit, proj);
    const top = faces.find((f) => f.face === "top");
    expect(top?.points).toMatchInlineSnapshot(`
      [
        {
          "x": 0,
          "y": -4.29,
        },
        {
          "x": -20.29,
          "y": -10.14,
        },
        {
          "x": -20.29,
          "y": -21.86,
        },
        {
          "x": 0,
          "y": -27.71,
        },
        {
          "x": 20.29,
          "y": -21.86,
        },
        {
          "x": 20.29,
          "y": -10.14,
        },
      ]
    `);
  });

  test("zero-height cylinder and hex give only the top", () => {
    const flat: Box3 = { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 0 } };
    expect(primitiveFaces("cylinder", flat, proj).map((f) => f.face)).toEqual(["top"]);
    expect(primitiveFaces("hex-prism", flat, proj).map((f) => f.face)).toEqual(["top"]);
  });

  test("negative origin never prints -0; non-square hex works", () => {
    const b: Box3 = { origin: { x: -1, y: -1, z: 0 }, size: { x: 2, y: 1, z: 1 } };
    for (const k of ["cube", "hex-prism", "cylinder"] as const) {
      const json = JSON.stringify(primitiveFaces(k, b, proj));
      expect(json).not.toContain("-0,");
      expect(json).not.toContain('"-0"');
      expect(primitiveSilhouette(k, b, proj).d).not.toMatch(/-0[^.\d]/);
    }
    const hex = primitiveFaces("hex-prism", b, proj);
    expect(hex.map((f) => f.face)).toEqual(["left", "right", "top"]);
    for (const f of hex) expect(signedArea(f.points)).toBeGreaterThan(0);
  });

  test("golden output per primitive for an odd box", () => {
    const box: Box3 = { origin: { x: 1.3, y: 2.7, z: 0.2 }, size: { x: 1.1, y: 0.9, z: 0.45 } };
    for (const k of ["cube", "slab", "platform", "hex-prism", "cylinder"] as const) {
      expect(JSON.stringify(primitiveFaces(k, box, proj))).toMatchSnapshot(k);
    }
  });
});
