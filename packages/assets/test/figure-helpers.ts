/** Shared helpers for the figure pipeline tests (fixtures come from tests/fixtures/figures/gen.mjs). */
import { expect } from "vitest";
import {
  figure,
  type GenFigure,
  type GenMask,
  type GenOptions,
} from "../../../tests/fixtures/figures/gen.mjs";
import {
  checkFigure,
  runFigure,
  type FigureOutputs,
  type FigureReport,
  type FigureResult,
  type Raster,
} from "../src/index.js";

export type { GenFigure, GenMask };

export function sourcesOf(f: GenFigure): Record<string, Raster> {
  const out: Record<string, Raster> = {};
  for (const [s, v] of Object.entries(f.states)) out[`${s}.png`] = v!.image;
  return out;
}

const cache = new Map<string, { f: GenFigure; result: FigureResult }>();

/** Generator options of a variant tag: "" (stroke 2), "s5" (scale 2, stroke 5), "aa". */
export function variant(tag: string): GenOptions {
  return tag === "s5" ? { scale: 2, stroke: 5 } : tag === "aa" ? { aa: true } : {};
}

/** Runs the correct pipeline on a preset once (cached); asserts the analysis succeeded. */
export function run(name: string, pad = 0, tag = ""): { f: GenFigure; result: FigureResult } {
  const key = `${name}:${pad}:${tag}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const f = figure(name, { ...variant(tag), ...(pad ? { pad } : {}) });
  const r = runFigure(f.manifest, sourcesOf(f));
  expect(r.value, JSON.stringify(r.diagnostics)).toBeDefined();
  const v = { f, result: r.value! };
  cache.set(key, v);
  return v;
}

export function check(
  manifest: unknown,
  sources: Record<string, Raster>,
  outputs: FigureOutputs,
): FigureReport {
  const r = checkFigure(manifest, sources, outputs);
  expect(r.value, JSON.stringify(r.diagnostics)).toBeDefined();
  return r.value!;
}

/** Codes of error-severity diagnostics. */
export const errorCodes = (r: FigureReport): Set<string> =>
  new Set(r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code));

export const clone = (r: Raster): Raster => ({
  width: r.width,
  height: r.height,
  data: new Uint8Array(r.data),
});

export function maskHas(m: GenMask, x: number, y: number): boolean {
  const i = x - m.x;
  const j = y - m.y;
  return i >= 0 && j >= 0 && i < m.w && j < m.h && m.data[j * m.w + i] !== 0;
}

export function eachInMask(m: GenMask, f: (x: number, y: number) => void): void {
  for (let j = 0; j < m.h; j++)
    for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) f(i + m.x, j + m.y);
}

export const lumAt = (r: Raster, x: number, y: number): number => {
  const o = (y * r.width + x) * 4;
  return Math.round(0.299 * r.data[o]! + 0.587 * r.data[o + 1]! + 0.114 * r.data[o + 2]!);
};

export function copyPx(dst: Raster, src: Raster, x: number, y: number, sx = x, sy = y): void {
  const d = (y * dst.width + x) * 4;
  const s = (sy * src.width + sx) * 4;
  dst.data[d] = src.data[s]!;
  dst.data[d + 1] = src.data[s + 1]!;
  dst.data[d + 2] = src.data[s + 2]!;
  dst.data[d + 3] = src.data[s + 3]!;
}

export function setPx(
  r: Raster,
  x: number,
  y: number,
  rgba: readonly [number, number, number, number],
): void {
  r.data.set(rgba, (y * r.width + x) * 4);
}

/** A 2 px vertical arrow (shaft at x, x+1) from y0 to y1 with a filled wedge at y1, as the generator draws it. */
export function drawArrow(r: Raster, x: number, y0: number, y1: number): void {
  const dir = y1 > y0 ? 1 : -1;
  const base = y1 - 8 * dir;
  for (let y = Math.min(y0, base); y <= Math.max(y0, base); y++)
    for (const dx of [0, 1]) setPx(r, x + dx, y, [0, 0, 0, 255]);
  for (let k = 0; k <= 8; k++) {
    const y = base + k * dir;
    const t = (k + 0.5) / 9;
    const lo = x - 4 + 5 * t;
    const hi = x + 6 - 5 * t;
    for (let xx = Math.ceil(lo - 0.5); xx <= Math.floor(hi - 0.5); xx++)
      setPx(r, xx, y, [0, 0, 0, 255]);
  }
}

export function line1(r: Raster, x0: number, y0: number, x1: number, y1: number): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let k = 0; k <= n; k++) {
    const x = Math.round(x0 + ((x1 - x0) * k) / Math.max(1, n));
    const y = Math.round(y0 + ((y1 - y0) * k) / Math.max(1, n));
    setPx(r, x, y, [0, 0, 0, 255]);
  }
}
