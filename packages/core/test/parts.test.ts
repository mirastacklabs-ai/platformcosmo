import { describe, expect, test } from "vitest";
import type {
  Axis,
  Box3,
  PartPrimitive,
  PartPrimitiveKind,
  QuarterTurn,
  Rect,
  Vec2,
} from "../src/contracts/index.js";
import {
  applyMatrix,
  billboardRect,
  boxCorners,
  createProjection,
  decalPlacement,
  partGeometry,
  partPrimitiveFaces,
  partPrimitiveSilhouette,
  primitiveFaces,
  studGrid,
  trayBoxes,
} from "../src/geometry/index.js";
import type { PartFace } from "../src/geometry/index.js";

const proj = createProjection();
const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number): Box3 => ({
  origin: { x, y, z },
  size: { x: sx, y: sy, z: sz },
});
const prim = (
  kind: PartPrimitiveKind,
  b: Box3,
  extra: Partial<PartPrimitive> = {},
  id = "p",
): PartPrimitive => ({ id, kind, box: b, tone: "base", ...extra });

function signedArea(points: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Vec2;
    const q = points[(i + 1) % points.length] as Vec2;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}
const names = (fs: readonly PartFace[]): string[] =>
  fs.map((f) => (f.half ? `${f.half}:${f.face}` : f.face));
const twoDecimals = (n: number): boolean => Math.abs(Math.round(n * 100) / 100 - n) < 1e-9;

/** mulberry32 seeded PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("every face is a clockwise, 2-decimal polygon", () => {
  const b = box(1, 2, 0.5, 1, 1, 1);
  const kinds: PartPrimitiveKind[] = [
    "box",
    "plate",
    "card",
    "prism",
    "wedge",
    "cylinder",
    "shaft",
    "stud",
    "ring",
    "tray",
  ];
  const axes: Axis[] = ["x", "y", "z"];
  for (const kind of kinds) {
    for (const axis of axes) {
      test(`${kind} axis ${axis}`, () => {
        const faces = partPrimitiveFaces(prim(kind, b, { axis }), proj);
        expect(faces.length).toBeGreaterThan(0);
        for (const f of faces) {
          expect(signedArea(f.points)).toBeGreaterThan(0);
          for (const p of f.points) {
            expect(twoDecimals(p.x)).toBe(true);
            expect(twoDecimals(p.y)).toBe(true);
          }
        }
      });
    }
  }
});

describe("boxes, plates, cards, prisms delegate to primitiveFaces", () => {
  const b = box(0, 0, 0, 2, 1, 0.5);
  test("box = cube, plate = slab, prism = hex-prism, card = cube", () => {
    expect(partPrimitiveFaces(prim("box", b), proj)).toEqual(primitiveFaces("cube", b, proj));
    expect(partPrimitiveFaces(prim("plate", b), proj)).toEqual(primitiveFaces("slab", b, proj));
    expect(partPrimitiveFaces(prim("card", b), proj)).toEqual(primitiveFaces("cube", b, proj));
    expect(partPrimitiveFaces(prim("prism", b), proj)).toEqual(
      primitiveFaces("hex-prism", b, proj),
    );
  });
  test("painter's order left, right, top", () => {
    expect(names(partPrimitiveFaces(prim("box", b), proj))).toEqual(["left", "right", "top"]);
  });
  test("z cylinder/shaft/stud match the existing cylinder, arcs included", () => {
    const c = box(0, 0, 0, 1, 1, 2);
    for (const kind of ["cylinder", "shaft", "stud"] as const) {
      expect(partPrimitiveFaces(prim(kind, c, { axis: "z" }), proj)).toEqual(
        primitiveFaces("cylinder", c, proj),
      );
    }
  });
});

describe("cylinders along x and y", () => {
  test("axis x: lateral left and top bands, then the +x cap as right", () => {
    const f = partPrimitiveFaces(prim("cylinder", box(0, 0, 0, 2, 1, 1), { axis: "x" }), proj);
    expect(names(f)).toEqual(["left", "top", "right"]);
  });
  test("axis y: lateral right and top bands, then the +y cap as left", () => {
    const f = partPrimitiveFaces(prim("cylinder", box(0, 0, 0, 1, 2, 1), { axis: "y" }), proj);
    expect(names(f)).toEqual(["right", "top", "left"]);
  });
  test("the cap is the true projected ellipse at the near end", () => {
    const b = box(0, 0, 0, 2, 1, 1);
    const f = partPrimitiveFaces(prim("cylinder", b, { axis: "x" }), proj);
    const cap = f[f.length - 1] as PartFace;
    // Centre of the +x end cap: world (2, 0.5, 0.5).
    const c = proj.project({ x: 2, y: 0.5, z: 0.5 });
    const xs = cap.points.map((p) => p.x);
    const ys = cap.points.map((p) => p.y);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(c.x, 0);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(c.y, 0);
    // A circle of radius 0.5 in the y-z plane under the 2:1 projection spans
    // x: ±r*32 (from y) and y: (±r*16) from y plus ±r*32 from z.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(32, 0);
  });
  test("lateral surface joins the cap without a gap: hull of faces = silhouette", () => {
    const b = box(0, 0, 0, 3, 1, 1);
    const p = prim("shaft", b, { axis: "x" });
    const sil = partPrimitiveSilhouette(p, proj);
    const all = partPrimitiveFaces(p, proj).flatMap((f) => f.points);
    for (const pt of all) {
      expect(sil.points.some((h) => h.x === pt.x && h.y === pt.y) || inside(sil.points, pt)).toBe(
        true,
      );
    }
  });
  test("lateral bands are ordered before the cap so the cap paints on top", () => {
    for (const axis of ["x", "y"] as const) {
      const f = partPrimitiveFaces(prim("stud", box(0, 0, 0, 1, 1, 1), { axis }), proj);
      expect(f.length).toBe(3);
      expect(f[2]?.face).toBe(axis === "x" ? "right" : "left");
    }
  });
  test("zero-length axis keeps only the cap", () => {
    const f = partPrimitiveFaces(prim("cylinder", box(0, 0, 0, 0, 1, 1), { axis: "x" }), proj);
    expect(names(f)).toEqual(["right"]);
  });
});

function inside(poly: readonly Vec2[], p: Vec2): boolean {
  // Convex, clockwise on screen: all cross products >= 0 (small tolerance for rounding).
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Vec2;
    const b = poly[(i + 1) % poly.length] as Vec2;
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < -0.05) return false;
  }
  return true;
}

describe("wedge", () => {
  const b = box(0, 0, 0, 2, 1, 1);
  const expected: Record<QuarterTurn, string[]> = {
    0: ["left", "top"], // high at -x: hidden wall, +y end triangle
    90: ["right", "top"], // high at -y
    180: ["left", "right", "top"], // high at +x: wall visible
    270: ["left", "right"], // high at +y: this 45° slope faces away and is edge-on
  };
  for (const rot of [0, 90, 180, 270] as const) {
    test(`rotate ${rot}`, () => {
      const f = partPrimitiveFaces(prim("wedge", b, { rotate: rot }), proj);
      expect(names(f)).toEqual(expected[rot]);
    });
  }
  test("slope top edge sits at the high side, low edge on the floor", () => {
    const f = partPrimitiveFaces(prim("wedge", b, { rotate: 0 }), proj);
    const top = f.find((x) => x.face === "top") as PartFace;
    const hi = proj.project({ x: 0, y: 0, z: 1 });
    const lo = proj.project({ x: 2, y: 1, z: 0 });
    expect(top.points).toContainEqual(hi);
    expect(top.points).toContainEqual(lo);
    // No slope vertex is higher than the high edge's lowest screen position at x=2.
    expect(top.points).not.toContainEqual(proj.project({ x: 2, y: 1, z: 1 }));
  });
  test("a shallow slope facing away is hidden only when steeper than the view", () => {
    const shallow = partPrimitiveFaces(prim("wedge", box(0, 0, 0, 2, 2, 1), { rotate: 270 }), proj);
    expect(names(shallow)).toContain("top");
    const steep = partPrimitiveFaces(prim("wedge", box(0, 0, 0, 2, 1, 2), { rotate: 270 }), proj);
    expect(names(steep)).toEqual(["left", "right"]);
  });
  test("a flat wedge (height 0) draws nothing visible but does not throw", () => {
    expect(() => partPrimitiveFaces(prim("wedge", box(0, 0, 0, 1, 1, 0)), proj)).not.toThrow();
  });
});

describe("ring", () => {
  for (const axis of ["x", "y", "z"] as const) {
    test(`axis ${axis}: back item first (bore, rim), then front (outer, rim)`, () => {
      const b = box(0, 0, 0, 1, 1, 1);
      const f = partPrimitiveFaces(prim("ring", b, { axis }), proj);
      const halves = f.map((x) => x.half);
      expect(halves).toEqual(["back", "back", "back", "front", "front", "front"]);
      const cap = axis === "x" ? "right" : axis === "y" ? "left" : "top";
      expect(f[2]?.face).toBe(cap);
      expect(f[5]?.face).toBe(cap);
      // Within one item every face name is unique (ids stay unique per half).
      for (const half of ["back", "front"]) {
        const n = f.filter((x) => x.half === half).map((x) => x.face);
        expect(new Set(n).size).toBe(n.length);
      }
    });
    test(`axis ${axis}: suffix selects one half; halves concatenate to the whole`, () => {
      const b = box(0, 0, 0, 1, 1, 1);
      const whole = partPrimitiveFaces(prim("ring", b, { axis }, "r"), proj);
      const back = partPrimitiveFaces(prim("ring", b, { axis }, "r.back"), proj);
      const front = partPrimitiveFaces(prim("ring", b, { axis }, "r.front"), proj);
      expect([...back, ...front]).toEqual(whole);
      expect(back.every((x) => x.half === "back")).toBe(true);
      expect(front.every((x) => x.half === "front")).toBe(true);
    });
  }
  test("the front half is nearer the viewer than the back half (z ring)", () => {
    const b = box(0, 0, 0, 1, 1, 0.2);
    const back = partPrimitiveFaces(prim("ring", b, { axis: "z" }, "r.back"), proj);
    const front = partPrimitiveFaces(prim("ring", b, { axis: "z" }, "r.front"), proj);
    const meanY = (fs: PartFace[]): number => {
      const ps = fs.flatMap((f) => f.points);
      return ps.reduce((s, p) => s + p.y, 0) / ps.length;
    };
    expect(meanY(front)).toBeGreaterThan(meanY(back));
  });
  test("the bore is open: no face covers the axis centre line on the top cap", () => {
    const b = box(0, 0, 0, 1, 1, 0.2);
    const f = partPrimitiveFaces(prim("ring", b, { axis: "z" }), proj);
    const centre = proj.project({ x: 0.5, y: 0.5, z: 0.2 });
    const caps = f.filter((x) => x.face === "top");
    for (const cap of caps) expect(inside(cap.points, centre)).toBe(false);
  });
});

describe("tray", () => {
  const b = box(0, 0, 0, 2, 2, 1);
  test("back = floor, -x and -y walls; front = +y and +x walls", () => {
    const f = partPrimitiveFaces(prim("tray", b), proj);
    expect(names(f)).toEqual([
      "back:left",
      "back:right",
      "back:top", // floor
      "back:left",
      "back:right",
      "back:top", // -x wall
      "back:left",
      "back:top", // -y wall
      "front:left",
      "front:top", // +y wall
      "front:left",
      "front:right",
      "front:top", // +x wall
    ]);
  });
  test("suffix selects a half and halves concatenate to the whole", () => {
    const whole = partPrimitiveFaces(prim("tray", b, {}, "t"), proj);
    const back = partPrimitiveFaces(prim("tray", b, {}, "t.back"), proj);
    const front = partPrimitiveFaces(prim("tray", b, {}, "t.front"), proj);
    expect([...back, ...front]).toEqual(whole);
  });
  test("walls and floor tile the box without overlap and stay inside it", () => {
    const t = trayBoxes(b);
    const parts = [t.floor, t.wallNX, t.wallNY, t.wallPX, t.wallPY];
    for (const p of parts) {
      expect(p.origin.x).toBeGreaterThanOrEqual(0);
      expect(p.origin.x + p.size.x).toBeLessThanOrEqual(2 + 1e-9);
      expect(p.origin.z + p.size.z).toBeLessThanOrEqual(1 + 1e-9);
    }
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i] as Box3;
        const c = parts[j] as Box3;
        const ov = (k: "x" | "y" | "z"): number =>
          Math.min(a.origin[k] + a.size[k], c.origin[k] + c.size[k]) -
          Math.max(a.origin[k], c.origin[k]);
        expect(ov("x") > 1e-9 && ov("y") > 1e-9 && ov("z") > 1e-9).toBe(false);
      }
    }
  });
  test("rejects a zero-height tray", () => {
    expect(() => partPrimitiveFaces(prim("tray", box(0, 0, 0, 1, 1, 0)), proj)).toThrow(RangeError);
  });
});

describe("card and sprite", () => {
  test("card is a thin upright plate with box faces", () => {
    const f = partPrimitiveFaces(prim("card", box(0, 0, 0, 1, 0.05, 1)), proj);
    expect(names(f)).toEqual(["left", "right", "top"]);
  });
  test("sprite has no faces; the silhouette is the box's projected hexagon", () => {
    const b = box(0, 0, 0, 1, 1, 1);
    const p = prim("sprite", b);
    expect(partPrimitiveFaces(p, proj)).toEqual([]);
    const sil = partPrimitiveSilhouette(p, proj);
    expect(sil.points.length).toBe(6);
    for (const c of boxCorners(b)) {
      const s = proj.project(c);
      expect(inside(sil.points, s)).toBe(true);
    }
    expect(sil.d.startsWith("M")).toBe(true);
  });
  test("sprite may be flat in y (a screen-facing plane)", () => {
    expect(() =>
      partPrimitiveSilhouette(prim("sprite", box(0, 0, 0, 1, 0, 1)), proj),
    ).not.toThrow();
  });
});

describe("partGeometry", () => {
  const size = { x: 2, y: 1, z: 1 };
  test("solid kinds are one primitive, solid, depthBox = bounds = box", () => {
    for (const kind of [
      "box",
      "plate",
      "prism",
      "wedge",
      "card",
      "cylinder",
      "shaft",
      "stud",
    ] as const) {
      const g = partGeometry({ kind, size, tone: "base" });
      expect(g.primitives).toHaveLength(1);
      expect(g.solid).toBe(true);
      expect(g.split).toBeUndefined();
      expect(g.depthBox).toEqual(box(0, 0, 0, 2, 1, 1));
      expect(g.bounds).toEqual(g.depthBox);
    }
  });
  test("ring and tray split into .back/.front and are not solid", () => {
    for (const kind of ["ring", "tray"] as const) {
      const g = partGeometry({ id: "r", kind, size, tone: "base" });
      expect(g.primitives.map((p) => p.id)).toEqual(["r.back", "r.front"]);
      expect(g.split).toEqual({ back: ["r.back"], front: ["r.front"] });
      expect(g.solid).toBe(false);
      expect(g.primitives.every((p) => /^[a-z0-9_.-]+$/.test(p.id))).toBe(true);
    }
  });
  test("sprite is not solid and has no split", () => {
    const g = partGeometry({ kind: "sprite", size, tone: "base" });
    expect(g.solid).toBe(false);
    expect(g.split).toBeUndefined();
  });
  test("axis only on circular kinds, rotate only on wedge; defaults", () => {
    expect(partGeometry({ kind: "cylinder", size, tone: "base" }).primitives[0]?.axis).toBe("z");
    expect(partGeometry({ kind: "shaft", size, tone: "base", axis: "x" }).primitives[0]?.axis).toBe(
      "x",
    );
    expect(partGeometry({ kind: "box", size, tone: "base", axis: "x" }).primitives[0]?.axis).toBe(
      undefined,
    );
    expect(partGeometry({ kind: "wedge", size, tone: "base" }).primitives[0]?.rotate).toBe(0);
    expect(
      partGeometry({ kind: "wedge", size, tone: "base", rotate: 90 }).primitives[0]?.rotate,
    ).toBe(90);
  });
  test("studs extend bounds, not depthBox, and are listed after the body", () => {
    const g = partGeometry({
      kind: "box",
      size: { x: 4, y: 2, z: 1 },
      tone: "base",
      studs: { cols: 4, rows: 2 },
    });
    expect(g.primitives).toHaveLength(1 + 8);
    expect(g.primitives[0]?.kind).toBe("box");
    expect(g.depthBox).toEqual(box(0, 0, 0, 4, 2, 1));
    expect(g.bounds.size.z).toBeCloseTo(1.25, 9);
    expect(g.solid).toBe(true);
  });
  test("studs on a tray, ring, sprite or wedge are rejected", () => {
    for (const kind of ["tray", "ring", "sprite", "wedge"] as const) {
      expect(() => partGeometry({ kind, size, tone: "base", studs: { cols: 1, rows: 1 } })).toThrow(
        RangeError,
      );
    }
  });
  test("images pass through", () => {
    const images = [
      {
        image: "i",
        face: "billboard" as const,
        crop: { x: 0, y: 0, width: 4, height: 3 },
        fit: "contain" as const,
      },
    ];
    expect(partGeometry({ kind: "card", size, tone: "base", images }).images).toBe(images);
  });
  test("rejects degenerate sizes", () => {
    expect(() => partGeometry({ kind: "box", size: { x: 0, y: 1, z: 1 }, tone: "base" })).toThrow(
      RangeError,
    );
    expect(() => partGeometry({ kind: "box", size: { x: NaN, y: 1, z: 1 }, tone: "base" })).toThrow(
      RangeError,
    );
  });
});

describe("stud grid property (seeded)", () => {
  type B = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  const bx = (p: PartPrimitive): B => ({
    x0: p.box.origin.x,
    x1: p.box.origin.x + p.box.size.x,
    y0: p.box.origin.y,
    y1: p.box.origin.y + p.box.size.y,
    z0: p.box.origin.z,
    z1: p.box.origin.z + p.box.size.z,
  });
  const behind = (a: B, b: B): boolean => a.x1 <= b.x0 || a.y1 <= b.y0 || a.z1 <= b.z0;
  const rect = (p: PartPrimitive): Rect => {
    const pts = partPrimitiveSilhouette(p, proj).points;
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  };
  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  test("200 random grids: no two studs overlap in 3D, all stand on the host, painter's order holds", () => {
    const rand = rng(0xc0ffee);
    for (let iter = 0; iter < 200; iter++) {
      const cols = 1 + Math.floor(rand() * 8);
      const rows = 1 + Math.floor(rand() * 8);
      const pitch = 0.5 + rand() * 1.5;
      const diameter = pitch * (0.2 + rand() * 0.75);
      const height = pitch * (0.05 + rand() * 0.6);
      const host = box(
        rand() * 3,
        rand() * 3,
        rand() * 2,
        cols * pitch + rand() * 2,
        rows * pitch + rand() * 2,
        0.3 + rand(),
      );
      const studs = studGrid({ host, cols, rows, pitch, diameter, height, tone: "base" });
      expect(studs).toHaveLength(cols * rows);
      expect(new Set(studs.map((s) => s.id)).size).toBe(studs.length);
      const boxes = studs.map(bx);
      const top = host.origin.z + host.size.z;
      for (const s of boxes) {
        expect(s.z0).toBeCloseTo(top, 9);
        expect(s.x0).toBeGreaterThanOrEqual(host.origin.x - 1e-9);
        expect(s.x1).toBeLessThanOrEqual(host.origin.x + host.size.x + 1e-9);
        expect(s.y0).toBeGreaterThanOrEqual(host.origin.y - 1e-9);
        expect(s.y1).toBeLessThanOrEqual(host.origin.y + host.size.y + 1e-9);
      }
      const rects = studs.map(rect);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i] as B;
          const c = boxes[j] as B;
          const sep = a.x1 <= c.x0 || c.x1 <= a.x0 || a.y1 <= c.y0 || c.y1 <= a.y0;
          expect(sep).toBe(true);
          // Where two studs overlap on screen, the earlier one must not be in front.
          if (overlaps(rects[i] as Rect, rects[j] as Rect)) {
            const jBehindI = behind(c, a) && !behind(a, c);
            expect(jBehindI).toBe(false);
          }
        }
      }
    }
  });
  test("the grid is centred and ordered back to front", () => {
    const studs = studGrid({ host: box(0, 0, 0, 4, 4, 1), cols: 2, rows: 2, tone: "base" });
    expect(studs.map((s) => s.id)).toEqual(["stud-1-1", "stud-1-2", "stud-2-1", "stud-2-2"]);
    const first = studs[0] as PartPrimitive;
    expect(first.box.origin.x).toBeCloseTo(1 + 0.5 - 0.3, 9);
  });
  test("bad grids throw", () => {
    const host = box(0, 0, 0, 2, 2, 1);
    expect(() => studGrid({ host, cols: 3, rows: 1, tone: "base" })).toThrow(RangeError);
    expect(() => studGrid({ host, cols: 0, rows: 1, tone: "base" })).toThrow(RangeError);
    expect(() => studGrid({ host, cols: 1, rows: 1, diameter: 1, tone: "base" })).toThrow(
      RangeError,
    );
  });
});

describe("decals", () => {
  const b = box(1, 2, 0, 3, 2, 1.5);
  const crop: Rect = { x: 10, y: 20, width: 300, height: 150 };
  test("unit matrix maps the unit square exactly onto the face parallelogram (stretch)", () => {
    for (const face of ["top", "left", "right"] as const) {
      const d = decalPlacement(b, face, crop, "stretch", proj);
      const m = d.unit;
      const got = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ].map((p) => applyMatrix(m, p));
      expect(got).toEqual([...d.faceCorners]);
      expect(d.corners).toEqual(d.faceCorners);
    }
  });
  test("face corners are the projected world corners", () => {
    const l = decalPlacement(b, "left", crop, "stretch", proj);
    // Left face: y = 4, x from 1..4, z from 1.5 down to 0.
    expect(l.faceCorners).toEqual([
      proj.project({ x: 1, y: 4, z: 1.5 }),
      proj.project({ x: 4, y: 4, z: 1.5 }),
      proj.project({ x: 4, y: 4, z: 0 }),
      proj.project({ x: 1, y: 4, z: 0 }),
    ]);
    const r = decalPlacement(b, "right", crop, "stretch", proj);
    // Right face: x = 4, u runs from y=4 to y=2.
    expect(r.faceCorners).toEqual([
      proj.project({ x: 4, y: 4, z: 1.5 }),
      proj.project({ x: 4, y: 2, z: 1.5 }),
      proj.project({ x: 4, y: 2, z: 0 }),
      proj.project({ x: 4, y: 4, z: 0 }),
    ]);
    const t = decalPlacement(b, "top", crop, "stretch", proj);
    expect(t.faceCorners).toEqual([
      proj.project({ x: 1, y: 2, z: 1.5 }),
      proj.project({ x: 4, y: 2, z: 1.5 }),
      proj.project({ x: 4, y: 4, z: 1.5 }),
      proj.project({ x: 1, y: 4, z: 1.5 }),
    ]);
  });
  test("pixel matrix maps the crop corners onto the face corners (within rounding)", () => {
    for (const face of ["top", "left", "right"] as const) {
      const d = decalPlacement(b, face, crop, "stretch", proj);
      const px = [
        { x: crop.x, y: crop.y },
        { x: crop.x + crop.width, y: crop.y },
        { x: crop.x + crop.width, y: crop.y + crop.height },
        { x: crop.x, y: crop.y + crop.height },
      ];
      px.forEach((p, i) => {
        const g = applyMatrix(d.matrix, p);
        expect(Math.abs(g.x - (d.corners[i] as Vec2).x)).toBeLessThan(0.005);
        expect(Math.abs(g.y - (d.corners[i] as Vec2).y)).toBeLessThan(0.005);
      });
    }
  });
  test("contain keeps the crop inside the face; cover covers it and carries a clip", () => {
    const wide: Rect = { x: 0, y: 0, width: 400, height: 100 };
    const c = decalPlacement(b, "left", wide, "contain", proj);
    expect(c.clip).toBeUndefined();
    // Contain, wide image on a 3 x 1.5 face: full width, half height, centred.
    expect(c.corners[0]).toEqual(proj.project({ x: 1, y: 4, z: 1.5 - 0.375 }));
    expect(c.corners[2]).toEqual(proj.project({ x: 4, y: 4, z: 0.375 }));
    const v = decalPlacement(b, "left", wide, "cover", proj);
    expect(v.clip).toEqual([...v.faceCorners]);
    // Cover: full height, wider than the face: u overflows both sides equally.
    expect(v.corners[0].x).toBeLessThan(v.faceCorners[0].x);
  });
  test("rejects empty crops and degenerate faces", () => {
    expect(() =>
      decalPlacement(b, "top", { x: 0, y: 0, width: 0, height: 1 }, "stretch", proj),
    ).toThrow(RangeError);
    expect(() => decalPlacement(box(0, 0, 0, 1, 1, 0), "left", crop, "stretch", proj)).toThrow(
      RangeError,
    );
  });
  test("a decal on a face matches the drawn face of the same box", () => {
    const f = primitiveFaces("cube", b, proj);
    for (const face of ["left", "right", "top"] as const) {
      const poly = (f.find((x) => x.face === face) as PartFace).points;
      const d = decalPlacement(b, face, crop, "stretch", proj);
      for (const c of d.faceCorners) expect(poly).toContainEqual(c);
    }
  });
});

describe("billboards", () => {
  const b = box(0, 0, 0, 1, 1, 2);
  const sil = { x: -32, y: -64, width: 64, height: 96 };
  test("stretch fills the silhouette rect", () => {
    const r = billboardRect(b, { x: 0, y: 0, width: 10, height: 10 }, "stretch", proj);
    expect(r.rect).toEqual(sil);
    expect(r.clip).toBeUndefined();
  });
  test("contain is upright, bottom-aligned, centred, inside the silhouette", () => {
    const r = billboardRect(b, { x: 0, y: 0, width: 200, height: 100 }, "contain", proj).rect;
    expect(r.width).toBe(64);
    expect(r.height).toBe(32);
    expect(r.x).toBe(sil.x);
    expect(r.y + r.height).toBe(sil.y + sil.height);
    const tall = billboardRect(b, { x: 0, y: 0, width: 100, height: 400 }, "contain", proj).rect;
    expect(tall.height).toBe(96);
    expect(tall.width).toBe(24);
    expect(tall.x).toBe(-12);
  });
  test("cover overflows and is clipped to the silhouette", () => {
    const r = billboardRect(b, { x: 0, y: 0, width: 200, height: 100 }, "cover", proj);
    expect(r.rect.height).toBe(96);
    expect(r.rect.width).toBe(192);
    expect(r.clip).toEqual(sil);
    expect(r.rect.y + r.rect.height).toBe(sil.y + sil.height);
  });
  test("rejects empty crops", () => {
    expect(() => billboardRect(b, { x: 0, y: 0, width: 0, height: 5 }, "contain", proj)).toThrow(
      RangeError,
    );
  });
});

describe("determinism and snapshots", () => {
  const cases: [string, PartPrimitive][] = [
    ["wedge-90", prim("wedge", box(0, 0, 0, 2, 1, 1), { rotate: 90 })],
    ["cyl-x", prim("cylinder", box(0, 0, 0, 2, 1, 1), { axis: "x" })],
    ["cyl-y", prim("shaft", box(0, 0, 0, 1, 3, 0.5), { axis: "y" })],
    ["ring-z", prim("ring", box(0, 0, 0, 1, 1, 0.25), { axis: "z" })],
    ["ring-x", prim("ring", box(0, 0, 0, 0.5, 1, 1), { axis: "x" })],
    ["tray", prim("tray", box(0, 0, 0, 2, 1.5, 0.5))],
  ];
  for (const [name, p] of cases) {
    test(`${name}: identical across calls and projections instances`, () => {
      const a = JSON.stringify(partPrimitiveFaces(p, proj));
      const b = JSON.stringify(partPrimitiveFaces(p, createProjection()));
      expect(a).toBe(b);
      expect(JSON.stringify(partGeometry({ kind: p.kind, size: p.box.size, tone: "base" }))).toBe(
        JSON.stringify(partGeometry({ kind: p.kind, size: p.box.size, tone: "base" })),
      );
    });
    test(`${name}: snapshot`, () => {
      const faces = partPrimitiveFaces(p, proj).map((f) => ({
        face: f.face,
        half: f.half,
        n: f.points.length,
        points: f.points.map((q) => `${q.x} ${q.y}`).join(" "),
      }));
      expect(faces).toMatchSnapshot();
    });
  }
  test("decal and billboard snapshot", () => {
    const b = box(0, 0, 0, 2, 1, 1);
    expect({
      decal: decalPlacement(b, "right", { x: 0, y: 0, width: 640, height: 480 }, "contain", proj),
      billboard: billboardRect(b, { x: 0, y: 0, width: 640, height: 480 }, "contain", proj),
    }).toMatchSnapshot();
  });
  test("existing primitiveFaces output is untouched by this module", () => {
    expect(primitiveFaces("cylinder", box(0, 0, 0, 1, 1, 1), proj)[0]?.d).toBeDefined();
  });
});
