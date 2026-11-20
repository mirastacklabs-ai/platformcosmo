/** RGBA raster type shared by every operation, plus the result and limit helpers. */
import type { Diagnostic } from "@platformcosmo/core";

/** Straight (non-premultiplied) 8-bit RGBA, row-major. `data.length === width * height * 4`. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Every operation returns its value (absent on error) plus diagnostics; none throws on bad input. */
export interface OpResult<T> {
  readonly value?: T;
  readonly diagnostics: readonly Diagnostic[];
}

/** Ingestion §14: images ≤ 16 MP, matcher runs ≤ 2·10⁹ multiply-adds. */
export const MAX_PIXELS = 16_777_216;
export const MAX_MULTIPLY_ADDS = 2_000_000_000;

export function createRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function isRaster(r: Raster): boolean {
  return (
    Number.isInteger(r.width) &&
    Number.isInteger(r.height) &&
    r.width > 0 &&
    r.height > 0 &&
    r.data.length === r.width * r.height * 4
  );
}

export const err = (
  code: string,
  message: string,
  extra: { suggestion?: string; params?: Record<string, unknown> } = {},
): Diagnostic => ({ severity: "error", code, path: "", message, ...extra });

/** Returns an error diagnostic when the raster is malformed or over the pixel cap. */
export function checkRaster(r: Raster, what = "image"): Diagnostic | undefined {
  if (!isRaster(r)) return err("asset/bad-raster", `${what} is not a valid RGBA buffer`);
  if (r.width * r.height > MAX_PIXELS) {
    return err(
      "asset/too-large",
      `${what} is ${r.width}x${r.height}, above the ${MAX_PIXELS} pixel limit`,
      {
        suggestion: "crop or shrink the image first",
        params: { width: r.width, height: r.height },
      },
    );
  }
  return undefined;
}

/** Luminance over white, 0..255 integers (alpha composited on white first). */
export function luminanceOverWhite(r: Raster): Uint8Array {
  const n = r.width * r.height;
  const out = new Uint8Array(n);
  const d = r.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3]!;
    const k = 255 - a;
    const R = (d[i * 4]! * a + 255 * k + 127) / 255;
    const G = (d[i * 4 + 1]! * a + 255 * k + 127) / 255;
    const B = (d[i * 4 + 2]! * a + 255 * k + 127) / 255;
    out[i] = Math.round(0.299 * R + 0.587 * G + 0.114 * B);
  }
  return out;
}
