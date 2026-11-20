import { studGrid, type Box3, type PartShapeDef } from "@platformcosmo/core";
import { defineShape, MAX_STEPS, MAX_STUDS, type ParamSpec, type Solid } from "./define.js";
import { palette, paletteNames } from "./palette.js";

/**
 * The `brick:` shapes (assemblies section 5.1): generic stud-grid bricks. Sizes are in stud
 * units, `[width, depth, plates]`: x and y count studs (8 mm), z counts plates (3.2 mm), and a
 * brick is 3 plates tall. Local frame: min corner at the origin; the part's `rotate` turns it.
 * Studs (4.8 mm across, 1.7 mm tall) stand on the top face, are drawn but kept out of
 * `depthBox` (a brick stacked on another then covers the lower studs instead of interpenetrating
 * them), and extend `bounds` by one stud height. Nothing here copies a manufacturer's design or
 * naming: the shapes are plain boxes, cylinders and wedges.
 */

const bool = (def: boolean): ParamSpec => ({ kind: "bool", def });
const paint: ParamSpec = { kind: "enum", values: ["default", ...paletteNames], def: "default" };

const EPS = 1e-9;

/** Studs on the top face of `host`: one per whole stud that fits, at most `MAX_STUDS`. */
function topStuds(
  s: Solid,
  host: Box3,
  cell?: (c: number, r: number, cols: number, rows: number) => boolean,
): void {
  const cols = Math.floor(host.size.x + EPS);
  const rows = Math.floor(host.size.y + EPS);
  // Cap before any allocation: the stud count follows the size, which is spec input.
  if (cols < 1 || rows < 1 || cols * rows > MAX_STUDS) return;
  try {
    s.addStuds(
      studGrid({
        host,
        cols,
        rows,
        ...(cell !== undefined ? { cell: (c: number, r: number) => cell(c, r, cols, rows) } : {}),
        ...s.style,
      }),
    );
  } catch {
    // A host the grid cannot sit on gets no studs; building never throws.
  }
}

/** Stud cells whose centre lies inside the footprint ellipse (round parts). */
function inEllipse(c: number, r: number, cols: number, rows: number): boolean {
  const dx = (c + 0.5 - cols / 2) / (cols / 2);
  const dy = (r + 0.5 - rows / 2) / (rows / 2);
  return dx * dx + dy * dy <= 1 + EPS;
}

const brick = defineShape(
  {
    id: "brick",
    label: "Brick",
    type: "brick",
    size: [2, 4, 3],
    params: { studs: bool(true), paint },
    draw(s, p) {
      const body = s.add("body", "box", [0, 0, 0], [s.size.x, s.size.y, s.size.z]);
      if (p["studs"]) topStuds(s, body);
    },
  },
  (n) => palette[n as keyof typeof palette],
);

const plate = defineShape(
  {
    id: "plate",
    label: "Plate",
    type: "plate",
    size: [2, 4, 1],
    params: { studs: bool(true), paint },
    draw(s, p) {
      const body = s.add("body", "plate", [0, 0, 0], [s.size.x, s.size.y, s.size.z]);
      if (p["studs"]) topStuds(s, body);
    },
  },
  (n) => palette[n as keyof typeof palette],
);

const tile = defineShape(
  {
    id: "tile",
    label: "Tile",
    type: "tile",
    size: [2, 2, 1],
    // A smooth top: studs are off by default (`studs: true` makes it a plate).
    params: { studs: bool(false), paint },
    draw(s, p) {
      const body = s.add("body", "box", [0, 0, 0], [s.size.x, s.size.y, s.size.z]);
      if (p["studs"]) topStuds(s, body);
    },
  },
  (n) => palette[n as keyof typeof palette],
);

const round = defineShape(
  {
    id: "round",
    label: "Round brick",
    type: "round",
    size: [1, 1, 3],
    params: { studs: bool(true), paint },
    draw(s, p, axis) {
      const body = s.add("body", "cylinder", [0, 0, 0], [s.size.x, s.size.y, s.size.z], { axis });
      // Studs stand on the top face of an upright round only.
      if (p["studs"] && axis === "z") topStuds(s, body, inEllipse);
    },
  },
  (n) => palette[n as keyof typeof palette],
);

/**
 * 45-degree-class slope: the sloped face is a planar quad, so it projects to a parallelogram and
 * sorts as a convex solid. The high side is at -x (turn it with the part's `rotate`). The first
 * stud of the run is a full-height block that carries the studs; the rest of the run is a wedge
 * (a width-1 slope is a wedge only and has no studs). `inverted` flips the slope under the part:
 * a flat studded top over a stepped underside, at most `MAX_STEPS` steps.
 */
const slope = defineShape(
  {
    id: "slope",
    label: "Slope",
    type: "slope",
    size: [2, 2, 3],
    params: { studs: bool(true), inverted: bool(false), paint },
    draw(s, p) {
      const { x: w, y: d, z: h } = s.size;
      if (p["inverted"]) {
        const n = Math.min(Math.max(1, Math.ceil(w - EPS)), MAX_STEPS);
        const step = w / n;
        for (let i = 0; i < n; i++) {
          const lift = (h * i) / n;
          s.add(`step-${i + 1}`, "box", [i * step, 0, lift], [step, d, h - lift]);
        }
        // The flat top is the union of the steps' top faces: stand the studs on the full footprint.
        if (p["studs"]) topStuds(s, { origin: { x: 0, y: 0, z: 0 }, size: { x: w, y: d, z: h } });
        return;
      }
      if (w >= 2 - EPS) {
        const high = s.add("high", "box", [0, 0, 0], [1, d, h]);
        s.add("slope", "wedge", [1, 0, 0], [w - 1, d, h], { rotate: 0 });
        if (p["studs"]) topStuds(s, high);
      } else {
        s.add("slope", "wedge", [0, 0, 0], [w, d, h], { rotate: 0 });
      }
    },
  },
  (n) => palette[n as keyof typeof palette],
);

/** All `brick:` shapes, in documentation order. */
export const brickShapes: readonly PartShapeDef[] = [brick, plate, tile, round, slope];
