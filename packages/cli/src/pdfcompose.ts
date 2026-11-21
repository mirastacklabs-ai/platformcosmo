/**
 * `assets pdf compose` (ingestion §3): the raster images of one page, placed at their matrices on
 * a white page-sized canvas, as a PNG or an SVG. Pure functions: no I/O. Every loop is bounded
 * by the canvas (at most 16 MP) and by a pixel-work budget the caller passes in, both checked
 * before the work starts. Nothing here is derived from PDF text; the only strings are numbers.
 */
import { MAX_PIXELS, shrink, type Raster } from "@platformcosmo/assets";

/** Image space (u right, v down, 0..1) to page units: x = a·u + c·v + e, y = b·u + d·v + f. */
export type Mat = readonly [number, number, number, number, number, number];

export interface View {
  /** Region of the page in pt (origin top-left). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Output pixels per pt (dpi / 72). */
  readonly scale: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface RasterPlacement {
  readonly raster: Raster;
  readonly matrix: Mat;
}

export interface Marker {
  readonly index: number;
  readonly bbox: Box;
}

export const MAX_SIDE = 16_384;
/** Total canvas pixels written by all placements of one compose (about 0.25 G). */
export const COMPOSE_WORK_BUDGET = 250_000_000;

/** Canvas size in pixels for a view, or undefined when it is over the 16 MP / side caps. */
export function canvasSize(view: View): { width: number; height: number } | undefined {
  const width = Math.max(1, Math.ceil(view.w * view.scale - 1e-9));
  const height = Math.max(1, Math.ceil(view.h * view.scale - 1e-9));
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) return undefined;
  return { width, height };
}

// 3x5 digit font for the annotation labels.
const DIGITS: readonly (readonly string[])[] = [
  ["111", "101", "101", "101", "111"],
  ["010", "110", "010", "010", "111"],
  ["111", "001", "111", "100", "111"],
  ["111", "001", "111", "001", "111"],
  ["101", "101", "111", "001", "001"],
  ["111", "100", "111", "001", "111"],
  ["111", "100", "111", "101", "111"],
  ["111", "001", "010", "010", "010"],
  ["111", "101", "111", "101", "111"],
  ["111", "101", "111", "001", "111"],
];

export interface ComposeResult {
  readonly raster: Raster;
  /** Placements skipped because the work budget ran out. */
  readonly skipped: number;
}

/**
 * Paints `placements` in order over a white canvas. Bilinear sampling with edge clamp; a source
 * much larger than its target is box-shrunk first. Pixel centres decide coverage (no edge AA).
 */
export function composeRaster(
  view: View,
  placements: readonly RasterPlacement[],
  budget = COMPOSE_WORK_BUDGET,
): ComposeResult {
  const size = canvasSize(view);
  if (!size) throw new RangeError("canvas over the pixel cap");
  const { width: cw, height: ch } = size;
  const out = new Uint8Array(cw * ch * 4).fill(255);
  let spent = 0;
  let skipped = 0;
  for (const p of placements) {
    const [a, b, c, d, e, f] = p.matrix;
    const A = view.scale * a;
    const B = view.scale * b;
    const C = view.scale * c;
    const D = view.scale * d;
    const E = view.scale * (e - view.x);
    const F = view.scale * (f - view.y);
    const det = A * D - B * C;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) continue;
    const xs = [E, E + A, E + C, E + A + C];
    const ys = [F, F + B, F + D, F + B + D];
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(cw, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(ch, Math.ceil(Math.max(...ys)));
    if (x1 <= x0 || y1 <= y0) continue;
    const area = (x1 - x0) * (y1 - y0);
    if (spent + area > budget) {
      skipped++;
      continue;
    }
    spent += area;
    let src = p.raster;
    const ratio = Math.max(Math.hypot(A, B) / src.width, Math.hypot(C, D) / src.height);
    if (ratio < 0.5) {
      const target = Math.ceil(Math.max(src.width, src.height) * ratio);
      if (target >= 1 && target <= 8192) src = shrink(src, target).value ?? src;
    }
    const sw = src.width;
    const sh = src.height;
    const sd = src.data;
    for (let py = y0; py < y1; py++) {
      const yy = py + 0.5 - F;
      for (let px = x0; px < x1; px++) {
        const xx = px + 0.5 - E;
        const u = (D * xx - C * yy) / det;
        const v = (-B * xx + A * yy) / det;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const sx = Math.min(Math.max(u * sw - 0.5, 0), sw - 1);
        const sy = Math.min(Math.max(v * sh - 0.5, 0), sh - 1);
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        const fx = sx - ix;
        const fy = sy - iy;
        const ix1 = Math.min(ix + 1, sw - 1);
        const iy1 = Math.min(iy + 1, sh - 1);
        const o00 = (iy * sw + ix) * 4;
        const o10 = (iy * sw + ix1) * 4;
        const o01 = (iy1 * sw + ix) * 4;
        const o11 = (iy1 * sw + ix1) * 4;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        const alpha =
          (sd[o00 + 3]! * w00 + sd[o10 + 3]! * w10 + sd[o01 + 3]! * w01 + sd[o11 + 3]! * w11) / 255;
        if (alpha <= 0) continue;
        const o = (py * cw + px) * 4;
        for (let k = 0; k < 3; k++) {
          // colour weighted by each tap's alpha, so a transparent neighbour's colour does not bleed
          const num =
            sd[o00 + k]! * sd[o00 + 3]! * w00 +
            sd[o10 + k]! * sd[o10 + 3]! * w10 +
            sd[o01 + k]! * sd[o01 + 3]! * w01 +
            sd[o11 + k]! * sd[o11 + 3]! * w11;
          const colour = num / (alpha * 255);
          out[o + k] = Math.round(colour * alpha + out[o + k]! * (1 - alpha));
        }
      }
    }
  }
  return { raster: { width: cw, height: ch, data: out }, skipped };
}

/** Draws the bbox outline and the index of each marker (red) onto `r`, in place. */
export function annotateRaster(r: Raster, view: View, markers: readonly Marker[]): void {
  const put = (x: number, y: number, rgb: readonly [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
    const o = (y * r.width + x) * 4;
    r.data[o] = rgb[0];
    r.data[o + 1] = rgb[1];
    r.data[o + 2] = rgb[2];
    r.data[o + 3] = 255;
  };
  const RED = [220, 30, 30] as const;
  const WHITE = [255, 255, 255] as const;
  for (const m of markers) {
    const x0 = Math.round((m.bbox.x - view.x) * view.scale);
    const y0 = Math.round((m.bbox.y - view.y) * view.scale);
    const x1 = Math.round((m.bbox.x + m.bbox.w - view.x) * view.scale);
    const y1 = Math.round((m.bbox.y + m.bbox.h - view.y) * view.scale);
    if (x1 < 0 || y1 < 0 || x0 >= r.width || y0 >= r.height) continue;
    // outline, 2 px, clipped to the canvas (the loops are bounded by the canvas, not the bbox)
    for (let x = Math.max(0, x0); x <= Math.min(r.width - 1, x1); x++) {
      for (const y of [y0, y0 + 1, y1, y1 - 1]) put(x, y, RED);
    }
    for (let y = Math.max(0, y0); y <= Math.min(r.height - 1, y1); y++) {
      for (const x of [x0, x0 + 1, x1, x1 - 1]) put(x, y, RED);
    }
    // label: the index in 3x5 digits at 3x, on white, inside the top-left corner
    const text = String(m.index).slice(0, 6);
    const k = 3;
    const lw = text.length * 4 * k + k;
    const lh = 5 * k + 2 * k;
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) put(x0 + 2 + x, y0 + 2 + y, WHITE);
    }
    for (let i = 0; i < text.length; i++) {
      const glyph = DIGITS[Number(text[i])]!;
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (glyph[gy]![gx] !== "1") continue;
          for (let yy = 0; yy < k; yy++) {
            for (let xx = 0; xx < k; xx++) {
              put(x0 + 2 + k + (i * 4 + gx) * k + xx, y0 + 2 + k + gy * k + yy, RED);
            }
          }
        }
      }
    }
  }
}

export interface SvgImage {
  /** Index of the unique source in `sources`. */
  readonly source: number;
  readonly matrix: Mat;
}

export interface SvgSource {
  readonly mime: "image/png" | "image/jpeg";
  readonly bytes: Uint8Array;
}

const num = (n: number): string => {
  const s = (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
};

/** A page-sized SVG: sources once in `<defs>`, each placement a `<use>` with its matrix. */
export function composeSvg(
  view: View,
  sources: readonly SvgSource[],
  images: readonly SvgImage[],
  markers: readonly Marker[],
): string {
  const px = (v: number): string => num(v * view.scale);
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px(view.w)}" height="${px(view.h)}" ` +
      `viewBox="${num(view.x)} ${num(view.y)} ${num(view.w)} ${num(view.h)}">`,
    `<rect x="${num(view.x)}" y="${num(view.y)}" width="${num(view.w)}" height="${num(view.h)}" fill="#fff"/>`,
  ];
  const used = [...new Set(images.map((i) => i.source))].sort((a, b) => a - b);
  if (used.length > 0) {
    out.push("<defs>");
    for (const s of used) {
      const src = sources[s]!;
      out.push(
        `<image id="m${s}" width="1" height="1" preserveAspectRatio="none" ` +
          `href="data:${src.mime};base64,${Buffer.from(src.bytes).toString("base64")}"/>`,
      );
    }
    out.push("</defs>");
  }
  for (const im of images) {
    out.push(`<use href="#m${im.source}" transform="matrix(${im.matrix.map(num).join(" ")})"/>`);
  }
  for (const m of markers) {
    const fs = Math.max(6, Math.min(24, m.bbox.h / 4));
    out.push(
      `<rect x="${num(m.bbox.x)}" y="${num(m.bbox.y)}" width="${num(m.bbox.w)}" height="${num(m.bbox.h)}" fill="none" stroke="#dc1e1e" stroke-width="1"/>`,
      `<text x="${num(m.bbox.x + 2)}" y="${num(m.bbox.y + fs + 1)}" font-family="sans-serif" font-size="${num(fs)}" fill="#dc1e1e">${Math.trunc(m.index)}</text>`,
    );
  }
  out.push("</svg>\n");
  return out.join("\n");
}
