import { expect, test } from "vitest";
import type { PartGeometry, PartShapeDef, PartTone, Vec2 } from "@platformcosmo/core";
import { createProjection, fmt, partGeometryFaces, round2 } from "@platformcosmo/core";
import { hwShapes } from "../src/index.js";

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

/** One shape drawn to fit a cell: boxes are scaled so the longest side is the same for all. */
function cell(s: PartShapeDef, g: PartGeometry): { w: number; h: number; paths: string[] } {
  const longest = Math.max(g.bounds.size.x, g.bounds.size.y, g.bounds.size.z);
  const k = 1.4 / longest; // world tiles per mm after normalising
  const scaled: PartGeometry = {
    ...g,
    primitives: g.primitives.map((p) => ({
      ...p,
      box: {
        origin: { x: p.box.origin.x * k, y: p.box.origin.y * k, z: p.box.origin.z * k },
        size: { x: p.box.size.x * k, y: p.box.size.y * k, z: p.box.size.z * k },
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
  return {
    w: CELL_W,
    h: CELL_H,
    paths: [
      `<g transform="translate(${dx} ${dy}) scale(${round2(fit)})" stroke="#1d232b" stroke-width="${round2(0.6 / fit)}" stroke-linejoin="round">`,
      ...items.map((i) => `<path d="${i.d}" fill="${i.fill}"/>`),
      "</g>",
    ],
  };
}

function contactSheet(): string {
  const rows = Math.ceil(hwShapes.length / COLS);
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * CELL_W}" height="${rows * CELL_H}" viewBox="0 0 ${COLS * CELL_W} ${rows * CELL_H}" font-family="monospace" font-size="12">`,
    `<rect width="100%" height="100%" fill="#f4f1ea"/>`,
  ];
  hwShapes.forEach((s, i) => {
    const g = s.build(s.defaults, {
      size: s.defaultSize,
      units: "mm",
      axis: "z",
      tone: "base",
      state: "healthy",
    });
    const c = cell(s, g);
    const x = (i % COLS) * CELL_W;
    const y = Math.floor(i / COLS) * CELL_H;
    out.push(`<g transform="translate(${x} ${y})">`, ...c.paths);
    out.push(
      `<text x="10" y="${CELL_H - 8}" fill="#333">hw:${s.id} ${s.defaultSize.x} x ${s.defaultSize.y} x ${s.defaultSize.z} mm</text>`,
      "</g>",
    );
  });
  out.push("</svg>");
  return `${out.join("\n")}\n`;
}

test("contact sheet of all 14 hw: shapes (view the .svg to review the shapes)", async () => {
  const svg = contactSheet();
  expect(svg.match(/<g transform="translate\(\d+ \d+\)">/g)).toHaveLength(14);
  expect(svg).not.toMatch(/NaN|undefined|Infinity/);
  await expect(svg).toMatchFileSnapshot("./__snapshots__/contact-sheet.svg");
});

test("contact sheet is deterministic", () => {
  expect(contactSheet()).toBe(contactSheet());
});
