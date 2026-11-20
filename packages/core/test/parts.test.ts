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
  trayParts,
  halfOf,
  partGeometryFaces,
  STUD_HEIGHT,
} from "../src/geometry/index.js";
import type { Half, PartFace } from "../src/geometry/index.js";
import { createHash } from "node:crypto";

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
  test("every face point lies on the true cylinder (unprojected, x axis)", () => {
    const b = box(0, 0, 0, 2, 1, 1);
    const f = partPrimitiveFaces(prim("cylinder", b, { axis: "x" }), proj);
    for (const face of f) {
      for (const p of face.points) {
        // A point on an end plane x = 0 or x = 2: unproject (y, z) and check the radius.
        const ok = [0, 2].some((x) => {
          const y = x - p.x / 32;
          const z = ((x + y) * 16 - p.y) / 32;
          return Math.abs(Math.hypot(y - 0.5, z - 0.5) - 0.5) < 0.02;
        });
        expect(ok).toBe(true);
      }
    }
    // The cap (drawn last) lies entirely on the +x end plane.
    const cap = f[f.length - 1] as PartFace;
    for (const p of cap.points) {
      const y = 2 - p.x / 32;
      const z = ((2 + y) * 16 - p.y) / 32;
      expect(Math.abs(Math.hypot(y - 0.5, z - 0.5) - 0.5)).toBeLessThan(0.02);
    }
  });
  test("elliptical sections never repeat a face name (shaft 2 x 2 x 0.2 on x)", () => {
    const f = partPrimitiveFaces(prim("shaft", box(0, 0, 0, 2, 2, 0.2), { axis: "x" }), proj);
    expect(new Set(names(f)).size).toBe(f.length);
    expect(names(f)[names(f).length - 1]).toBe("right");
  });
  test("stud-unit x cylinder (2 studs long, 1 wide, 3 plates tall) has unique names", () => {
    const f = partPrimitiveFaces(prim("cylinder", box(0, 0, 0, 2, 1, 3), { axis: "x" }), proj);
    expect(new Set(names(f)).size).toBe(f.length);
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
  test("a flat wedge (height 0) is just its flat top", () => {
    expect(names(partPrimitiveFaces(prim("wedge", box(0, 0, 0, 1, 1, 0)), proj))).toEqual(["top"]);
  });
  test("rotate other than 0/90/180/270 is a clear RangeError", () => {
    for (const bad of [45, 360, NaN, "90"]) {
      expect(() =>
        partPrimitiveFaces(prim("wedge", box(0, 0, 0, 1, 1, 1), { rotate: bad as never }), proj),
      ).toThrow(/wedge rotate must be 0, 90, 180 or 270/);
    }
    expect(() =>
      partGeometry({
        kind: "wedge",
        size: { x: 1, y: 1, z: 1 },
        tone: "base",
        rotate: 45 as never,
      }),
    ).toThrow(RangeError);
  });
});

describe("ring", () => {
  const b = box(0, 0, 0, 1, 1, 1);
  for (const axis of ["x", "y", "z"] as const) {
    test(`axis ${axis}: back (bore, rim) then front (outer, rim), cap last in each`, () => {
      const f = partPrimitiveFaces(prim("ring", b, { axis }), proj);
      expect(f.map((x) => x.half)).toEqual(["back", "back", "back", "front", "front", "front"]);
      const cap = axis === "x" ? "right" : axis === "y" ? "left" : "top";
      expect(f[2]?.face).toBe(cap);
      expect(f[5]?.face).toBe(cap);
    });
    test(`axis ${axis}: the half argument selects a depth item`, () => {
      const whole = partPrimitiveFaces(prim("ring", b, { axis }), proj);
      const back = partPrimitiveFaces(prim("ring", b, { axis }), proj, "back");
      const front = partPrimitiveFaces(prim("ring", b, { axis }), proj, "front");
      expect([...back, ...front]).toEqual(whole);
      expect(back.every((x) => x.half === "back")).toBe(true);
      expect(front.every((x) => x.half === "front")).toBe(true);
    });
  }
  test("halfOf resolves halves from the geometry's split, ids unchanged", () => {
    const g = partGeometry({ id: "r", kind: "ring", size: { x: 1, y: 1, z: 0.2 }, tone: "base" });
    expect(halfOf(g, "r.back")).toBe("back");
    expect(halfOf(g, "r.front")).toBe("front");
    expect(halfOf(g, "other")).toBeUndefined();
    expect(partGeometryFaces(g, proj).map((e) => e.half)).toEqual(["back", "front"]);
  });
});

describe("tray", () => {
  const size = { x: 2, y: 1.5, z: 0.8 };
  test("emitted as five boxes; back = floor, wall-nx, wall-ny; front = wall-py, wall-px", () => {
    const g = partGeometry({ id: "t", kind: "tray", size, tone: "base" });
    expect(g.primitives.map((p) => `${p.id}:${p.kind}`)).toEqual([
      "t.floor:box",
      "t.wall-nx:box",
      "t.wall-ny:box",
      "t.wall-py:box",
      "t.wall-px:box",
    ]);
    expect(g.split).toEqual({
      back: ["t.floor", "t.wall-nx", "t.wall-ny"].map((x) => x),
      front: ["t.wall-py", "t.wall-px"],
    });
    expect(g.solid).toBe(false);
  });
  test("a tray primitive passed directly yields its boxes' faces by half", () => {
    const t = prim("tray", box(0, 0, 0, 2, 2, 1));
    const all = partPrimitiveFaces(t, proj);
    expect([
      ...partPrimitiveFaces(t, proj, "back"),
      ...partPrimitiveFaces(t, proj, "front"),
    ]).toEqual(all);
    expect(all.filter((f) => f.half === "back").length).toBe(9);
    expect(all.filter((f) => f.half === "front").length).toBe(6);
  });
  test("walls and floor stay inside the box and never overlap in volume", () => {
    const parts = trayParts(box(0, 0, 0, 2, 2, 1));
    for (const { box: p } of parts) {
      expect(p.origin.x).toBeGreaterThanOrEqual(0);
      expect(p.origin.x + p.size.x).toBeLessThanOrEqual(2 + 1e-9);
      expect(p.origin.z + p.size.z).toBeLessThanOrEqual(1 + 1e-9);
    }
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = (parts[i] as { box: Box3 }).box;
        const c = (parts[j] as { box: Box3 }).box;
        const ov = (k: "x" | "y" | "z"): number =>
          Math.min(a.origin[k] + a.size[k], c.origin[k] + c.size[k]) -
          Math.max(a.origin[k], c.origin[k]);
        expect(ov("x") > 1e-9 && ov("y") > 1e-9 && ov("z") > 1e-9).toBe(false);
      }
    }
  });
  test("rejects a zero-height tray", () => {
    expect(() => partPrimitiveFaces(prim("tray", box(0, 0, 0, 1, 1, 0)), proj)).toThrow(RangeError);
    expect(() => partGeometry({ kind: "tray", size: { x: 1, y: 1, z: 0 }, tone: "base" })).toThrow(
      RangeError,
    );
  });
});

describe("each face name appears at most once per primitive", () => {
  const sizes = [
    { x: 1, y: 1, z: 1 },
    { x: 2, y: 2, z: 0.2 },
    { x: 2, y: 1, z: 3 },
    { x: 0.5, y: 3, z: 1.5 },
  ];
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
  for (const kind of kinds) {
    for (const axis of ["x", "y", "z"] as const) {
      for (const rotate of [0, 90, 180, 270] as const) {
        test(`${kind} axis ${axis} rotate ${rotate}`, () => {
          for (const size of sizes) {
            const g = partGeometry({ kind, size, axis, rotate, tone: "base" });
            for (const e of partGeometryFaces(g, proj)) {
              const n = e.faces.map((f) => f.face);
              expect(new Set(n).size, `${e.primitive.id} ${n.join()}`).toBe(n.length);
              for (const f of e.faces) expect(signedArea(f.points)).toBeGreaterThan(0);
            }
          }
        });
      }
    }
  }
});

/** Even-odd point in polygon. */
function pip(poly: readonly Vec2[], p: Vec2): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Vec2;
    const b = poly[j] as Vec2;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

describe("painter's order against a ray-cast reference (point sampling)", () => {
  /** Ray through screen point s along the view direction; z = 0 anchor. */
  const anchor = (s: Vec2): { x: number; y: number } => ({
    x: (s.x / 32 + s.y / 16) / 2,
    y: (s.y / 16 - s.x / 32) / 2,
  });

  /** Last drawn owner at s, or "" if none. */
  function painted(
    items: readonly { owner: string; faces: readonly PartFace[] }[],
    s: Vec2,
  ): string {
    let owner = "";
    for (const it of items) for (const f of it.faces) if (pip(f.points, s)) owner = it.owner;
    return owner;
  }

  function agreement(
    items: readonly { owner: string; faces: readonly PartFace[] }[],
    truth: (s: Vec2) => string,
  ): number {
    const pts = items.flatMap((i) => i.faces.flatMap((f) => f.points));
    const x0 = Math.min(...pts.map((p) => p.x));
    const x1 = Math.max(...pts.map((p) => p.x));
    const y0 = Math.min(...pts.map((p) => p.y));
    const y1 = Math.max(...pts.map((p) => p.y));
    let total = 0;
    let same = 0;
    for (let x = x0 + 0.37; x < x1; x += 1.1) {
      for (let y = y0 + 0.41; y < y1; y += 1.1) {
        const s = { x, y };
        const t = truth(s);
        const g = painted(items, s);
        if (t === "" && g === "") continue;
        total++;
        if (t === g) same++;
      }
    }
    return same / total;
  }

  test("tray with contents: back boxes, contents, front boxes", () => {
    const tb = box(0, 0, 0, 3, 2, 1);
    const g = partGeometry({ id: "t", kind: "tray", size: tb.size, tone: "base" });
    const content = box(0.9, 0.7, 0.2, 1.0, 0.7, 0.5);
    const order = partGeometryFaces(g, proj);
    const back = order.filter((e) => e.half === "back");
    const front = order.filter((e) => e.half === "front");
    const items = [
      ...back.map((e) => ({ owner: e.primitive.id, faces: e.faces })),
      { owner: "content", faces: primitiveFaces("cube", content, proj) },
      ...front.map((e) => ({ owner: e.primitive.id, faces: e.faces })),
    ];
    const solids: [string, Box3][] = [
      ...g.primitives.map((p) => [p.id, p.box] as [string, Box3]),
      ["content", content],
    ];
    const truth = (s: Vec2): string => {
      const a = anchor(s);
      let best = "";
      let bt = -Infinity;
      for (const [id, bx] of solids) {
        // p(t) = (a.x + t, a.y + t, t): slab intersection on each axis.
        let lo = -Infinity;
        let hi = Infinity;
        for (const [o, d, mn, mx] of [
          [a.x, 1, bx.origin.x, bx.origin.x + bx.size.x],
          [a.y, 1, bx.origin.y, bx.origin.y + bx.size.y],
          [0, 1, bx.origin.z, bx.origin.z + bx.size.z],
        ] as const) {
          lo = Math.max(lo, mn - o / d);
          hi = Math.min(hi, mx - o / d);
        }
        if (hi - lo > 1e-6 && hi > bt) {
          bt = hi;
          best = id;
        }
      }
      return best;
    };
    expect(agreement(items, truth)).toBeGreaterThan(0.985);
  });

  test("z ring with a shaft through the bore: back half, shaft, front half", () => {
    const rb = box(0, 0, 0.3, 1.6, 1.6, 0.3);
    const g = partGeometry({ id: "r", kind: "ring", size: rb.size, tone: "base" });
    const shaftBox = box(0.55, 0.55, 0, 0.5, 0.5, 1.2);
    const order = partGeometryFaces(g, proj).map((e) => ({
      half: e.half as Half,
      faces: e.faces.map((f) => ({
        ...f,
        points: f.points.map((p) => ({ x: p.x, y: p.y - 0.3 * 32 })),
      })),
    }));
    // The ring box above starts at z = 0.3: shift its faces up by 0.3 * zScale.
    const shaft = primitiveFaces("cylinder", shaftBox, proj);
    const items = [
      { owner: "ring", faces: order.filter((e) => e.half === "back").flatMap((e) => e.faces) },
      { owner: "shaft", faces: shaft },
      { owner: "ring", faces: order.filter((e) => e.half === "front").flatMap((e) => e.faces) },
    ];
    // Reference: nearest of (outer cylinder minus bore) and the shaft cylinder along the ray.
    const circleHit = (
      a: { x: number; y: number },
      cx: number,
      cy: number,
      r: number,
      z0: number,
      z1: number,
    ): [number, number] | undefined => {
      // p(t) = (a.x + t, a.y + t, t); circle in xy: quadratic in t.
      const dx = a.x - cx;
      const dy = a.y - cy;
      const A = 2;
      const B = 2 * (dx + dy);
      const C = dx * dx + dy * dy - r * r;
      const disc = B * B - 4 * A * C;
      if (disc <= 0) return undefined;
      const lo = Math.max((-B - Math.sqrt(disc)) / (2 * A), z0);
      const hi = Math.min((-B + Math.sqrt(disc)) / (2 * A), z1);
      return hi - lo > 1e-6 ? [lo, hi] : undefined;
    };
    const truth = (s: Vec2): string => {
      const a = anchor(s);
      let best = "";
      let bt = -Infinity;
      const consider = (id: string, hi: number): void => {
        if (hi > bt) {
          bt = hi;
          best = id;
        }
      };
      const sh = circleHit(a, 0.8, 0.8, 0.25, 0, 1.2);
      if (sh) consider("shaft", sh[1]);
      const outer = circleHit(a, 0.8, 0.8, 0.8, 0.3, 0.6);
      if (outer) {
        const inner = circleHit(a, 0.8, 0.8, 0.8 * 0.6, 0.3, 0.6);
        if (!inner) consider("ring", outer[1]);
        else {
          if (inner[0] - outer[0] > 1e-6) consider("ring", inner[0]);
          if (outer[1] - inner[1] > 1e-6) consider("ring", outer[1]);
        }
      }
      return best;
    };
    expect(agreement(items, truth)).toBeGreaterThan(0.97);
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
  test("ring splits into .back/.front and is not solid", () => {
    const g = partGeometry({ id: "r", kind: "ring", size, tone: "base" });
    expect(g.primitives.map((p) => p.id)).toEqual(["r.back", "r.front"]);
    expect(g.split).toEqual({ back: ["r.back"], front: ["r.front"] });
    expect(g.solid).toBe(false);
  });
  test("every primitive id matches the id pattern and is unique", () => {
    for (const kind of ["ring", "tray", "box"] as const) {
      const g = partGeometry({ id: "a.b-c_1", kind, size, tone: "base" });
      const ids = g.primitives.map((p) => p.id);
      expect(ids.every((i) => /^[a-z0-9_.-]+$/.test(i))).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  test("invalid ids and stud id collisions are rejected", () => {
    for (const id of ["", "A", "a b", "a/b"]) {
      expect(() => partGeometry({ id, kind: "box", size, tone: "base" })).toThrow(RangeError);
    }
    expect(() =>
      partGeometry({
        id: "stud-1-1",
        kind: "box",
        size: { x: 2, y: 2, z: 1 },
        tone: "base",
        studs: { cols: 1, rows: 1 },
      }),
    ).toThrow(/collides/);
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
    expect(g.bounds.size.z).toBeCloseTo(1 + STUD_HEIGHT, 9);
    expect(g.solid).toBe(true);
  });
  test("studs honour a cell mask (round host) and are rejected on x/y circular kinds", () => {
    const g = partGeometry({
      kind: "cylinder",
      size: { x: 4, y: 4, z: 1 },
      tone: "base",
      studs: { cols: 4, rows: 4, cell: (c, r) => (c - 1.5) ** 2 + (r - 1.5) ** 2 <= 2.6 },
    });
    expect(g.primitives.length).toBe(1 + 12);
    for (const axis of ["x", "y"] as const) {
      expect(() =>
        partGeometry({
          kind: "cylinder",
          axis,
          size: { x: 4, y: 4, z: 4 },
          tone: "base",
          studs: { cols: 1, rows: 1 },
        }),
      ).toThrow(/along/);
    }
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
  test("non-finite hosts and options throw RangeError", () => {
    const ok = box(0, 0, 0, 4, 4, 1);
    for (const host of [
      box(NaN, 0, 0, 4, 4, 1),
      box(0, 0, 0, Infinity, 4, 1),
      box(0, 0, 0, 4, 4, NaN),
      box(0, 0, 0, 0, 4, 1),
    ]) {
      expect(() => studGrid({ host, cols: 1, rows: 1, tone: "base" })).toThrow(RangeError);
    }
    for (const o of [
      { pitch: NaN },
      { diameter: NaN },
      { height: NaN },
      { height: -1 },
      { pitch: Infinity },
    ]) {
      expect(() => studGrid({ host: ok, cols: 1, rows: 1, tone: "base", ...o })).toThrow(
        RangeError,
      );
    }
  });
  test("§5.1 defaults (4.8 mm / 8 mm pitch, 1.7 mm / 3.2 mm plates)", () => {
    const [st] = studGrid({ host: box(0, 0, 0, 1, 1, 3), cols: 1, rows: 1, tone: "base" });
    expect(st?.box.size.x).toBeCloseTo(0.6, 12);
    expect(st?.box.size.z).toBeCloseTo(1.7 / 3.2, 12);
    expect(st?.box.origin.z).toBe(3);
  });
  test("§5.1: at 8 mm pitch, 4.8 mm diameter, 1.7 mm height no stud overlaps another on screen", () => {
    // World scale: one stud pitch = 0.5 tile (offsets (±16, 8) and (0, 16) in screen units),
    // isotropic, so the stud is 0.3 wide and 1.7 / 8 * 0.5 high.
    const studs = studGrid({
      host: box(0, 0, 0, 5, 5, 0.5),
      cols: 6,
      rows: 6,
      pitch: 0.5,
      diameter: 0.3,
      height: (1.7 / 8) * 0.5,
      tone: "base",
    });
    const rects = studs.map((st) => {
      const pts = partPrimitiveSilhouette(st, proj).points;
      const xs = pts.map((q) => q.x);
      const ys = pts.map((q) => q.y);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    });
    // Spans x within +-6.79 and y within [-6.79, 3.39] of the base centre (design §5.1).
    const r0 = rects[0] as (typeof rects)[number];
    expect((r0.x1 - r0.x0) / 2).toBeCloseTo(6.79, 1);
    expect(r0.y1 - r0.y0).toBeCloseTo(10.18, 1);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i] as (typeof rects)[number];
        const c = rects[j] as (typeof rects)[number];
        const overlap = a.x0 < c.x1 && c.x0 < a.x1 && a.y0 < c.y1 && c.y0 < a.y1;
        expect(overlap).toBe(false);
      }
    }
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
  test("emit path: unit matrix on a 1x1 viewBox=crop svg lands the crop on the face", () => {
    const d = decalPlacement(b, "left", crop, "stretch", proj);
    expect("matrix" in d).toBe(false);
    // Crop corner (x, y) -> unit square ((x - crop.x) / w, (y - crop.y) / h) -> screen.
    const map = (px: number, py: number): Vec2 =>
      applyMatrix(d.unit, { x: (px - crop.x) / crop.width, y: (py - crop.y) / crop.height });
    expect(map(crop.x, crop.y)).toEqual(d.faceCorners[0]);
    expect(map(crop.x + crop.width, crop.y + crop.height)).toEqual(d.faceCorners[2]);
    for (const v of Object.values(d.unit)) expect(twoDecimals(v)).toBe(true);
  });
  test("non-finite crops and boxes throw RangeError", () => {
    for (const c of [
      { x: NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: Infinity, width: 1, height: 1 },
      { x: 0, y: 0, width: NaN, height: 1 },
    ]) {
      expect(() => decalPlacement(b, "top", c, "stretch", proj)).toThrow(RangeError);
      expect(() => billboardRect(b, c, "contain", proj)).toThrow(RangeError);
    }
    expect(() => decalPlacement(box(NaN, 0, 0, 1, 1, 1), "top", crop, "stretch", proj)).toThrow(
      RangeError,
    );
    expect(() => billboardRect(box(0, 0, 0, 1, NaN, 1), crop, "contain", proj)).toThrow(RangeError);
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
    test(`${name}: identical across calls, fresh projections and call order`, () => {
      const g = partGeometry({ kind: p.kind, size: p.box.size, axis: p.axis, tone: "base" });
      const first = JSON.stringify(partGeometryFaces(g, createProjection()));
      partPrimitiveFaces(prim("wedge", box(0, 0, 0, 1, 1, 1), { rotate: 90 }), proj); // unrelated call
      expect(JSON.stringify(partGeometryFaces(g, createProjection()))).toBe(first);
      expect(JSON.stringify(partGeometryFaces(g, proj))).toBe(first);
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
  test("existing primitiveFaces output is pinned (golden hash)", () => {
    const out: unknown[] = [];
    for (const kind of ["cube", "slab", "platform", "hex-prism", "cylinder"] as const) {
      for (const size of [
        { x: 1, y: 1, z: 1 },
        { x: 2, y: 1, z: 0.5 },
        { x: 1.5, y: 3, z: 2 },
      ]) {
        out.push(primitiveFaces(kind, { origin: { x: 1, y: 2, z: 0.5 }, size }, proj));
      }
    }
    expect(createHash("sha256").update(JSON.stringify(out)).digest("hex")).toBe(
      "fd48a5c32e29d0d61ed6cac66fec9e12eeb103aaed1c64bd066c54a6ede82786",
    );
  });
});
