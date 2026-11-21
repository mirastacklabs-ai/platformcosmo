import { expect, test } from "vitest";
import type { PartGeometry, PartShapeDef, PartTone, Vec2 } from "@platformcosmo/core";
import { createProjection, fmt, partGeometryFaces, round2 } from "@platformcosmo/core";
import { palette, registry } from "../src/index.js";

const TONE: Record<PartTone, string> = {
  base: "#6f8fb5",
  accent: "#d98a3d",
  muted: "#7d8794",
  glass: "#9fc7d9",
  metal: "#b9c0c8",
  led: "#52c27a",
  floor: "#c9c2b0",
  perforated: "#454c55",
};
const SHADE = { top: 1, left: 0.82, right: 0.66 } as const;

function shade(hex: string, k: number): string {
  const n = (i: number) =>
    Math.round(parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) * k)
      .toString(16)
      .padStart(2, "0");
  return `#${n(0)}${n(1)}${n(2)}`;
}

const proj = createProjection();
const CELL_W = 260;
const CELL_H = 220;
const COLS = 4;
/** True proportions: x, y in 8 mm studs, z in 3.2 mm plates. */
const MM = [8, 8, 3.2] as const;

interface Entry {
  readonly label: string;
  readonly shape: string;
  readonly size: readonly [number, number, number];
  readonly params?: Record<string, boolean | string>;
  readonly axis?: "x" | "y" | "z";
  readonly paint: keyof typeof palette;
}

const ENTRIES: readonly Entry[] = [
  { label: "brick 2x4x3", shape: "brick", size: [2, 4, 3], paint: "red" },
  { label: "brick 1x6x3", shape: "brick", size: [1, 6, 3], paint: "blue" },
  { label: "plate 4x4x1", shape: "plate", size: [4, 4, 1], paint: "gray" },
  { label: "plate 6x6x1", shape: "plate", size: [6, 6, 1], paint: "green" },
  { label: "tile 2x2x1", shape: "tile", size: [2, 2, 1], paint: "light-gray" },
  { label: "tile 4x2x1", shape: "tile", size: [4, 2, 1], paint: "white" },
  { label: "round 1x1x3", shape: "round", size: [1, 1, 3], paint: "yellow" },
  { label: "round 4x4x3", shape: "round", size: [4, 4, 3], paint: "orange" },
  { label: "wheel x 1x2x5", shape: "round", size: [1, 2, 5], axis: "x", paint: "dark-gray" },
  { label: "slope 2x4x3", shape: "slope", size: [2, 4, 3], paint: "red" },
  { label: "slope 3x2x3", shape: "slope", size: [3, 2, 3], paint: "teal" },
  {
    label: "slope inverted 3x2x3",
    shape: "slope",
    size: [3, 2, 3],
    params: { inverted: true },
    paint: "purple",
  },
];

function geometry(e: Entry): { s: PartShapeDef; g: PartGeometry } {
  const s = registry.get(`brick:${e.shape}`) as PartShapeDef;
  const g = s.build(s.readParams(e.params ?? {}).params, {
    size: { x: e.size[0], y: e.size[1], z: e.size[2] },
    units: "stud",
    axis: e.axis ?? "z",
    tone: "base",
    color: palette[e.paint] as never,
    state: "healthy",
  });
  return { s, g };
}

/** One part drawn to fit a cell; boxes are scaled to true proportions, then normalised. */
function cell(g: PartGeometry): string[] {
  const longest = Math.max(
    g.bounds.size.x * MM[0],
    g.bounds.size.y * MM[1],
    g.bounds.size.z * MM[2],
  );
  const k = 1.4 / longest;
  const scaled: PartGeometry = {
    ...g,
    primitives: g.primitives.map((p) => ({
      ...p,
      box: {
        origin: {
          x: p.box.origin.x * MM[0] * k,
          y: p.box.origin.y * MM[1] * k,
          z: p.box.origin.z * MM[2] * k,
        },
        size: {
          x: p.box.size.x * MM[0] * k,
          y: p.box.size.y * MM[1] * k,
          z: p.box.size.z * MM[2] * k,
        },
      },
    })),
  };
  const items: { d: string; fill: string }[] = [];
  const pts: Vec2[] = [];
  for (const pf of partGeometryFaces(scaled, proj)) {
    for (const f of pf.faces) {
      const d = f.d ?? `M${f.points.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join("L")}Z`;
      pts.push(...f.points);
      items.push({ d, fill: shade(pf.primitive.color ?? TONE[pf.primitive.tone], SHADE[f.face]) });
    }
  }
  const x0 = Math.min(...pts.map((p) => p.x));
  const x1 = Math.max(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y));
  const y1 = Math.max(...pts.map((p) => p.y));
  const fit = Math.min(1, (CELL_W - 20) / (x1 - x0), (CELL_H - 50) / (y1 - y0));
  const dx = round2(CELL_W / 2 - ((x0 + x1) / 2) * fit);
  const dy = round2((CELL_H - 20) / 2 - ((y0 + y1) / 2) * fit);
  return [
    `<g transform="translate(${dx} ${dy}) scale(${round2(fit)})" stroke="#1d232b" stroke-width="${round2(0.6 / fit)}" stroke-linejoin="round">`,
    ...items.map((i) => `<path d="${i.d}" fill="${i.fill}"/>`),
    "</g>",
  ];
}

function contactSheet(): string {
  const rows = Math.ceil(ENTRIES.length / COLS);
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * CELL_W}" height="${rows * CELL_H}" viewBox="0 0 ${COLS * CELL_W} ${rows * CELL_H}" font-family="monospace" font-size="12">`,
    `<rect width="100%" height="100%" fill="#f4f1ea"/>`,
  ];
  ENTRIES.forEach((e, i) => {
    const x = (i % COLS) * CELL_W;
    const y = Math.floor(i / COLS) * CELL_H;
    out.push(`<g transform="translate(${x} ${y})">`, ...cell(geometry(e).g));
    out.push(`<text x="10" y="${CELL_H - 8}" fill="#333">brick:${e.label}</text>`, "</g>");
  });
  out.push("</svg>");
  return `${out.join("\n")}\n`;
}

test("contact sheet of the brick: shapes (view the .svg to review the shapes)", async () => {
  const svg = contactSheet();
  expect(svg.match(/<g transform="translate\(\d+ \d+\)">/g)).toHaveLength(ENTRIES.length);
  expect(svg).not.toMatch(/NaN|undefined|Infinity/);
  await expect(svg).toMatchFileSnapshot("./__snapshots__/contact-sheet.svg");
});

test("contact sheet is deterministic", () => {
  expect(contactSheet()).toBe(contactSheet());
});
