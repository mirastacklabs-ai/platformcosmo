import type { Axis, PartPrimitiveKind, PartShapeDef, PartTone } from "@platformcosmo/core";
import { round2 } from "@platformcosmo/core";
import { defineShape, type Draft, type ParamSpec } from "./define.js";

/**
 * The `auto:` shapes (assemblies §5): a generic inline engine in millimetres, true scale.
 * Local frame: x = length (along the crankshaft), y = depth, z = height, min corner at the
 * origin. One canonical, upright orientation (turn it with the part's `rotate`). The intake side
 * is +y (the side the iso viewer sees), the exhaust side -y, as in assemblies §19.3.
 * Each shape is authored at its default size and scaled per axis when the spec gives `size`.
 * `depthBox` is the solid core (see `finish`): crank throws, cam lobes, manifold flanges, port
 * bosses, mounting lugs, pulleys and the belt's sprockets are drawn but excluded.
 * Geometry claims: only the `detail: false` housings are ONE box that fills its `depthBox`;
 * everything else is multi-primitive (or round) and never fills (the scene derives `fills`).
 * Nothing here copies a manufacturer's industrial design; the shapes are generic.
 */

const int = (min: number, max: number, def: number): ParamSpec => ({
  kind: "int",
  min,
  max,
  def,
});
const bool = (def: boolean): ParamSpec => ({ kind: "bool", def });
const enumOf = (values: readonly string[], def: string): ParamSpec => ({
  kind: "enum",
  values,
  def,
});

type V3 = readonly [number, number, number];
interface Opts {
  axis?: Axis;
  paint?: boolean;
  core?: boolean;
}

/** Add a primitive by its min and max corners (default-size mm); extents come from the corners. */
function put(
  g: Draft,
  id: string,
  kind: PartPrimitiveKind,
  lo: V3,
  hi: V3,
  tone: PartTone,
  opts: Opts = {},
): void {
  // Round the corners first, then take extents from the rounded corners: shared faces match.
  const a = lo.map(round2) as unknown as V3;
  const b = hi.map(round2) as unknown as V3;
  g.add(id, kind, a, [round2(b[0] - a[0]), round2(b[1] - a[1]), round2(b[2] - a[2])], tone, opts);
}

/** Cylinder / shaft on `axis` with a square cross-section [lo, hi] in the two other axes. */
function round(
  g: Draft,
  id: string,
  kind: "cylinder" | "shaft",
  axis: Axis,
  lo: V3,
  hi: V3,
  tone: PartTone,
  opts: Opts = {},
): void {
  put(g, id, kind, lo, hi, tone, { ...opts, axis });
}

/** Origin of item `i` of `n`, each `w` wide, evenly spaced inside [lo, hi]. */
function spread(i: number, n: number, w: number, lo: number, hi: number): number {
  const gap = (hi - lo - n * w) / (n + 1);
  return lo + gap + i * (w + gap);
}

const cyl = int(2, 8, 4);

/** `detail: false` housings: one plain box (fills its depthBox, so it encloses and hides). */
function plain(g: Draft, size: V3, tone: PartTone): void {
  put(g, "body", "box", [0, 0, 0], size, tone, { paint: true });
}

const blockI4 = defineShape({
  id: "block-i4",
  label: "Cylinder block",
  type: "block",
  role: "body",
  size: [420, 230, 260],
  params: { cylinders: cyl, bore: int(50, 110, 82), detail: bool(true) },
  draw(g, p, tone) {
    const [L, W, H] = [420, 230, 260];
    if (!p.detail) return void plain(g, [L, W, H], tone);
    const n = p.cylinders as number;
    const pitch = L / n;
    const b = Math.min(p.bore as number, Math.floor(0.8 * pitch)); // bores never touch
    const [y0, y1, deck] = [12, W - 12, 140];
    const r = (y1 - y0 - b) / 2;
    put(g, "crankcase", "box", [0, y0, 0], [L, y1, deck], tone, { paint: true });
    put(g, "rail-f", "box", [0, y0, deck], [L, y0 + r, H], tone, { paint: true });
    put(g, "rail-b", "box", [0, y1 - r, deck], [L, y1, H], tone, { paint: true });
    // One edge array, so a bore's end and the next web's start are the same number.
    const x0 = Array.from({ length: n }, (_, i) => round2(i * pitch + (pitch - b) / 2));
    const x1 = x0.map((x) => round2(x + b));
    for (let i = 0; i <= n; i++) {
      const lo = i === 0 ? 0 : (x1[i - 1] as number);
      const hi = i === n ? L : (x0[i] as number);
      put(g, `web-${i}`, "box", [lo, y0 + r, deck], [hi, y1 - r, H], tone, { paint: true });
    }
    for (let i = 0; i < n; i++) {
      const [xa, xb] = [x0[i] as number, x1[i] as number];
      round(g, `bore-${i}`, "cylinder", "z", [xa, y0 + r, deck], [xb, y1 - r, H], "muted");
    }
    // Engine-mount lugs: drawn, outside the solid core.
    for (const [k, x] of [
      ["a", 24],
      ["b", L - 64],
    ] as const) {
      put(g, `lug-f${k}`, "box", [x, 0, 60], [x + 40, y0, 100], "metal", { core: false });
      put(g, `lug-b${k}`, "box", [x, y1, 60], [x + 40, W, 100], "metal", { core: false });
    }
    return undefined;
  },
});

const head = defineShape({
  id: "head",
  label: "Cylinder head",
  type: "head",
  role: "body",
  size: [420, 230, 100],
  params: { cylinders: cyl, valves: int(2, 4, 2), detail: bool(true) },
  draw(g, p, tone) {
    const [L, W, H] = [420, 230, 100];
    if (!p.detail) return void plain(g, [L, W, H], tone);
    const n = p.cylinders as number;
    const v = p.valves as number;
    const pitch = L / n;
    put(g, "casting", "box", [0, 12, 0], [L, W - 12, H], tone, { paint: true });
    const ports = [Math.floor(v / 2), Math.ceil(v / 2)]; // exhaust, intake per cylinder
    const w = Math.min(34, 0.4 * pitch);
    ports.forEach((k, side) => {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < k; j++) {
          const x = spread(j, k, w, i * pitch, (i + 1) * pitch);
          const [ya, yb] = side === 0 ? [0, 12] : [W - 12, W];
          put(
            g,
            `${side === 0 ? "exh" : "int"}-port-${i}-${j}`,
            "box",
            [x, ya, 28],
            [x + w, yb, 72],
            "muted",
            {
              core: false,
            },
          );
        }
      }
    });
    return undefined;
  },
});

const valveCover = defineShape({
  id: "valve-cover",
  label: "Valve cover",
  type: "valve-cover",
  role: "cover",
  size: [400, 200, 70],
  params: { cylinders: cyl, detail: bool(true) },
  draw(g, p, tone) {
    const [L, W, H] = [400, 200, 70];
    if (!p.detail) return void plain(g, [L, W, H], tone);
    const n = p.cylinders as number;
    const pitch = L / n;
    put(g, "gasket", "plate", [0, 0, 0], [L, W, 3], "muted");
    put(g, "body", "box", [0, 0, 3], [L, W, H - 10], tone, { paint: true });
    const d = Math.min(24, 0.5 * pitch);
    for (let i = 0; i < n; i++) {
      const x = i * pitch + (pitch - d) / 2;
      round(g, `plug-${i}`, "cylinder", "z", [x, 88, H - 10], [x + d, 88 + d, H], "metal", {
        core: false,
      });
    }
    const c = Math.min(30, 0.4 * pitch);
    round(
      g,
      "cap",
      "cylinder",
      "z",
      [pitch - c / 2, 150, H - 10],
      [pitch + c / 2, 150 + c, H],
      "accent",
      {
        core: false,
      },
    );
    return undefined;
  },
});

const crankshaft = defineShape({
  id: "crankshaft",
  label: "Crankshaft",
  type: "crankshaft",
  role: "internal",
  size: [420, 120, 120],
  params: { cylinders: cyl, flange: bool(true) },
  draw(g, p) {
    const [L, C] = [420, 60];
    const n = p.cylinders as number;
    const pitch = L / n;
    for (let i = 0; i < n; i++) {
      const down = ((i + 1) >> 1) % 2 === 0; // flat-plane throw order: down, up, up, down...
      const [wz0, wz1] = down ? [10, 90] : [30, 110];
      const [pz0, pz1] = down ? [10, 50] : [70, 110];
      const f = (a: number): number => (i + a) * pitch;
      round(
        g,
        `journal-${i}a`,
        "shaft",
        "x",
        [f(0), C - 25, C - 25],
        [f(0.21), C + 25, C + 25],
        "metal",
        { paint: true },
      );
      put(g, `web-${i}a`, "box", [f(0.21), 25, wz0], [f(0.35), 95, wz1], "metal", { core: false });
      round(g, `pin-${i}`, "shaft", "x", [f(0.35), 40, pz0], [f(0.65), 80, pz1], "base", {
        core: false,
      });
      put(g, `web-${i}b`, "box", [f(0.65), 25, wz0], [f(0.79), 95, wz1], "metal", { core: false });
      const last = i === n - 1 && (p.flange as boolean);
      if (last)
        round(g, "flange", "cylinder", "x", [f(0.79), 0, 0], [f(1), 120, 120], "metal", {
          core: false,
        });
      else
        round(
          g,
          `journal-${i}b`,
          "shaft",
          "x",
          [f(0.79), C - 25, C - 25],
          [f(1), C + 25, C + 25],
          "metal",
          { paint: true },
        );
    }
    return undefined;
  },
});

const camshaft = defineShape({
  id: "camshaft",
  label: "Camshaft",
  type: "camshaft",
  role: "internal",
  size: [420, 40, 40],
  params: { cylinders: cyl, lobes: int(1, 2, 2) },
  draw(g, p) {
    const n = p.cylinders as number;
    const k = p.lobes as number;
    const pitch = 420 / n;
    // Lobe boxes (bounding boxes of the eccentric profile) cycle up, right, down, left.
    const dir = [
      [8, 32, 8, 40],
      [8, 40, 8, 32],
      [8, 32, 0, 32],
      [0, 32, 8, 32],
    ] as const;
    const cuts = k === 2 ? [0, 0.29, 0.43, 0.57, 0.71, 1] : [0, 0.43, 0.57, 1];
    for (let i = 0; i < n; i++) {
      const f = (a: number): number => (i + a) * pitch;
      for (let s = 0; s + 1 < cuts.length; s++) {
        const [a, c] = [cuts[s] as number, cuts[s + 1] as number];
        if (s % 2 === 1) {
          const [y0, y1, z0, z1] = dir[(i * k + (s >> 1)) % 4]!;
          put(g, `lobe-${i}-${s >> 1}`, "box", [f(a), y0, z0], [f(c), y1, z1], "base", {
            core: false,
          });
        } else if (i === n - 1 && s === cuts.length - 2) {
          round(g, "gear", "cylinder", "x", [f(a), 0, 0], [f(c), 40, 40], "metal", { core: false });
        } else {
          round(g, `journal-${i}-${s >> 1}`, "shaft", "x", [f(a), 8, 8], [f(c), 32, 32], "metal", {
            paint: true,
          });
        }
      }
    }
    return undefined;
  },
});

const piston = defineShape({
  id: "piston",
  label: "Piston",
  type: "piston",
  role: "internal",
  size: [82, 82, 66],
  params: { rings: int(0, 4, 3) },
  draw(g, p, tone) {
    const r = p.rings as number;
    const top = 58;
    round(g, "crown", "cylinder", "z", [0, 0, top], [82, 82, 66], tone, { paint: true });
    for (let j = 0; j < r; j++) {
      const z = top - j * 6.5;
      round(g, `land-${j}`, "cylinder", "z", [2, 2, z - 4], [80, 80, z], tone);
      round(g, `ring-${j}`, "cylinder", "z", [0, 0, z - 6.5], [82, 82, z - 4], "metal");
    }
    round(g, "skirt", "cylinder", "z", [1, 1, 0], [81, 81, top - r * 6.5], tone, { paint: true });
    return undefined;
  },
});

const rod = defineShape({
  id: "rod",
  label: "Connecting rod",
  type: "rod",
  role: "internal",
  size: [24, 50, 150],
  params: { section: enumOf(["i-beam", "plain"], "i-beam") },
  draw(g, p, tone) {
    round(g, "big-end", "cylinder", "x", [0, 0, 0], [24, 50, 50], tone, { paint: true });
    round(g, "small-end", "cylinder", "x", [0, 11, 122], [24, 39, 150], tone, { paint: true });
    if (p.section === "plain") {
      put(g, "beam", "box", [6, 14, 50], [18, 36, 122], tone, { paint: true });
    } else {
      put(g, "beam-l", "box", [0, 14, 50], [6, 36, 122], tone, { paint: true });
      put(g, "web", "box", [6, 18, 50], [18, 32, 122], tone);
      put(g, "beam-r", "box", [18, 14, 50], [24, 36, 122], tone, { paint: true });
    }
    return undefined;
  },
});

const valve = defineShape({
  id: "valve",
  label: "Poppet valve",
  type: "valve",
  role: "internal",
  size: [34, 34, 110],
  params: { kind: enumOf(["intake", "exhaust"], "intake") },
  draw(g, p) {
    const m = p.kind === "exhaust" ? 2 : 0; // exhaust heads are smaller
    round(g, "head", "cylinder", "z", [m, m, 0], [34 - m, 34 - m, 4], "metal", { paint: true });
    round(g, "neck", "cylinder", "z", [11, 11, 4], [23, 23, 14], "metal");
    round(g, "stem", "shaft", "z", [14, 14, 14], [20, 20, 96], "metal");
    round(g, "retainer", "cylinder", "z", [10, 10, 96], [24, 24, 102], "muted");
    round(g, "tip", "cylinder", "z", [13, 13, 102], [21, 21, 110], "metal");
    return undefined;
  },
});

const oilPan = defineShape({
  id: "oil-pan",
  label: "Oil pan",
  type: "oil-pan",
  role: "cover",
  size: [420, 230, 90],
  params: { detail: bool(true) },
  draw(g, p, tone) {
    const [L, W, H] = [420, 230, 90];
    if (!p.detail) return void plain(g, [L, W, H], tone);
    put(g, "flange", "plate", [0, 0, H - 6], [L, W, H], "metal");
    put(g, "body", "box", [10, 10, 24], [L - 10, W - 10, H - 6], tone, { paint: true });
    put(g, "sump", "box", [10, 10, 0], [170, W - 10, 24], tone, { paint: true });
    round(g, "drain", "cylinder", "x", [0, W / 2 - 8, 8], [10, W / 2 + 8, 20], "muted", {
      core: false,
    });
    return undefined;
  },
});

const intake = defineShape({
  id: "intake",
  label: "Intake manifold",
  type: "intake",
  role: "internal",
  size: [380, 110, 90],
  params: { cylinders: cyl, throttle: bool(true) },
  draw(g, p, tone) {
    const L = 380;
    const n = p.cylinders as number;
    const pitch = L / n;
    const x0 = p.throttle ? 24 : 0;
    put(g, "flange", "plate", [0, 0, 0], [L, 8, 90], "metal", { core: false });
    const w = Math.min(40, 0.5 * pitch);
    for (let i = 0; i < n; i++) {
      const x = i * pitch + (pitch - w) / 2;
      put(g, `runner-${i}`, "box", [x, 8, 20], [x + w, 60, 70], tone, { paint: true });
    }
    round(g, "plenum", "cylinder", "x", [x0, 60, 20], [L, 110, 70], tone, { paint: true });
    if (p.throttle) {
      round(g, "throttle", "cylinder", "x", [0, 62, 22], [24, 108, 68], "metal", { core: false });
    }
    return undefined;
  },
});

const exhaust = defineShape({
  id: "exhaust",
  label: "Exhaust manifold",
  type: "exhaust",
  role: "internal",
  size: [380, 90, 80],
  params: { cylinders: cyl, shield: bool(false) },
  draw(g, p, tone) {
    const L = 380;
    const n = p.cylinders as number;
    const pitch = L / n;
    put(g, "flange", "plate", [0, 82, 0], [L, 90, 80], "metal", { core: false });
    const w = Math.min(30, 0.6 * pitch);
    for (let i = 0; i < n; i++) {
      const x = i * pitch + (pitch - w) / 2;
      round(g, `primary-${i}`, "shaft", "y", [x, 40, 25], [x + w, 82, 55], tone, { paint: true });
    }
    round(g, "collector", "cylinder", "x", [16, 0, 20], [L - 50, 40, 60], tone, { paint: true });
    round(g, "outlet", "cylinder", "x", [L - 50, 5, 25], [L, 35, 55], "muted", { core: false });
    if (p.shield) put(g, "shield", "plate", [10, 40, 60], [L - 10, 82, 64], "metal");
    return undefined;
  },
});

const timingBelt = defineShape({
  id: "timing-belt",
  label: "Timing belt",
  type: "timing-belt",
  role: "cover",
  size: [20, 200, 300],
  params: { tensioner: bool(true) },
  draw(g, p, tone) {
    put(g, "belt-l", "plate", [2, 0, 0], [18, 8, 300], tone, { paint: true });
    put(g, "belt-r", "plate", [2, 192, 0], [18, 200, 300], tone, { paint: true });
    put(g, "belt-t", "plate", [2, 8, 292], [18, 192, 300], tone, { paint: true });
    put(g, "belt-b", "plate", [2, 8, 0], [18, 192, 8], tone, { paint: true });
    round(g, "crank-pulley", "cylinder", "x", [0, 65, 25], [20, 135, 95], "metal", { core: false });
    round(g, "cam-pulley-l", "cylinder", "x", [0, 15, 200], [20, 95, 280], "metal", {
      core: false,
    });
    round(g, "cam-pulley-r", "cylinder", "x", [0, 105, 200], [20, 185, 280], "metal", {
      core: false,
    });
    if (p.tensioner) {
      round(g, "tensioner", "cylinder", "x", [0, 142, 112], [20, 178, 148], "muted", {
        core: false,
      });
    }
    return undefined;
  },
});

/** The 12 `auto:` shapes in assemblies §5 order. */
export const autoShapes: readonly PartShapeDef[] = [
  blockI4,
  head,
  valveCover,
  crankshaft,
  camshaft,
  piston,
  rod,
  valve,
  oilPan,
  intake,
  exhaust,
  timingBelt,
];
