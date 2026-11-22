/** Crop, trim, edge-connected background removal and box-filter shrink (ingestion §3, §5). */
import type { ImageLimits } from "@platformcosmo/core";
import { floodFill } from "./cc.js";
import { decodeImage } from "./decode.js";
import { encodePng } from "./png.js";
import { bilinear, boxResample } from "./resample.js";
import {
  badOption,
  checkRaster,
  createRaster,
  err,
  MAX_PIXELS,
  warning,
  type OpResult,
  type Raster,
  type Rect,
} from "./raster.js";

/** Crops to `rect` (integers). A rectangle partly outside is clamped with `asset/rect-clamped`; fully outside is an error. */
export function crop(r: Raster, rect: Rect): OpResult<Raster> {
  const bad = checkRaster(r);
  if (bad) return { diagnostics: [bad] };
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isInteger) || rect.w <= 0 || rect.h <= 0) {
    return {
      diagnostics: [
        badOption(
          "rect",
          "the crop rectangle must be integers with positive width and height",
          rect,
        ),
      ],
    };
  }
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(r.width, rect.x + rect.w);
  const y1 = Math.min(r.height, rect.y + rect.h);
  if (x1 <= x0 || y1 <= y0) {
    return {
      diagnostics: [
        badOption("rect", `the crop rectangle lies outside the ${r.width}x${r.height} image`, rect),
      ],
    };
  }
  const w = x1 - x0;
  const h = y1 - y0;
  const out = createRaster(w, h);
  for (let y = 0; y < h; y++) {
    out.data.set(
      r.data.subarray(((y0 + y) * r.width + x0) * 4, ((y0 + y) * r.width + x1) * 4),
      y * w * 4,
    );
  }
  const clamped = x0 !== rect.x || y0 !== rect.y || w !== rect.w || h !== rect.h;
  return {
    value: out,
    diagnostics: clamped
      ? [
          warning("asset/rect-clamped", "the crop rectangle was clamped to the image", {
            bbox: { x: x0, y: y0, w, h },
          }),
        ]
      : [],
  };
}

/** Bounding box of the pixels with alpha > `threshold` (default 0); `undefined` when there are none. */
export function opaqueBounds(r: Raster, threshold = 0): Rect | undefined {
  let minX = r.width;
  let minY = r.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.data[(y * r.width + x) * 4 + 3]! > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  return maxX < 0 ? undefined : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** `crop --trim`: crops to the non-transparent bounding box. */
export function trim(r: Raster): OpResult<Raster> {
  const bad = checkRaster(r);
  if (bad) return { diagnostics: [bad] };
  const b = opaqueBounds(r);
  if (!b) {
    return { diagnostics: [err("asset/empty", "nothing to trim: the image is fully transparent")] };
  }
  return crop(r, b);
}

export interface BackgroundOptions {
  /** Per 8-bit channel distance from the border median colour, default 12. */
  readonly tolerance?: number;
  /** One-pixel alpha feather on the opaque side of the new edge (alpha halved); default off. */
  readonly feather?: boolean;
}

export interface BackgroundResult {
  readonly raster: Raster;
  /** Border median colour (R, G, B) of the border pixels that were not already transparent. */
  readonly background: readonly [number, number, number];
  /** Pixels made transparent by this call. */
  readonly removed: number;
  /** 1 where the edge-connected background was (includes pixels that were already transparent). */
  readonly mask: Uint8Array;
}

/**
 * Edge-connected background removal. Flood fill (4-connected, so a diagonal 1-px outline still
 * seals its inside) from every border pixel through pixels within `tolerance` of the border
 * median colour (or already fully transparent); only that region becomes transparent, so
 * enclosed whites (fin gaps, holes) stay opaque. When every border pixel is already transparent
 * the input is returned unchanged with `asset/no-background`.
 */
export function removeBackground(
  r: Raster,
  options: BackgroundOptions = {},
): OpResult<BackgroundResult> {
  const bad = checkRaster(r);
  if (bad) return { diagnostics: [bad] };
  const tol = options.tolerance ?? 12;
  if (!Number.isInteger(tol) || tol < 0 || tol > 255) {
    return { diagnostics: [badOption("tolerance", "tolerance must be an integer from 0 to 255")] };
  }
  const { width: w, height: h, data } = r;
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let counted = 0;
  for (const p of border) {
    if (data[p * 4 + 3] === 0) continue;
    counted++;
    for (let c = 0; c < 3; c++) hist[c]![data[p * 4 + c]!]!++;
  }
  let nonTransparent = 0;
  for (let p = 0; p < w * h; p++) if (data[p * 4 + 3] !== 0) nonTransparent++;
  if (counted === 0) {
    return {
      value: { raster: r, background: [255, 255, 255], removed: 0, mask: new Uint8Array(w * h) },
      diagnostics: [
        warning("asset/no-background", "the border is already transparent; nothing was removed"),
      ],
    };
  }
  const median = (c: number): number => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[c]![v]!;
      if (acc * 2 >= counted) return v;
    }
    return 255;
  };
  const bg: [number, number, number] = [median(0), median(1), median(2)];
  const isBg = (p: number): boolean =>
    data[p * 4 + 3] === 0 ||
    (Math.abs(data[p * 4]! - bg[0]) <= tol &&
      Math.abs(data[p * 4 + 1]! - bg[1]) <= tol &&
      Math.abs(data[p * 4 + 2]! - bg[2]) <= tol);

  const seen = floodFill(w, h, border, isBg, 4);
  const out = new Uint8Array(data);
  let removed = 0;
  for (let p = 0; p < w * h; p++) {
    if (!seen[p]) continue;
    if (data[p * 4 + 3] !== 0) removed++;
    out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = out[p * 4 + 3] = 0;
  }
  if (options.feather) {
    for (let p = 0; p < w * h; p++) {
      if (seen[p]) continue;
      const x = p % w;
      const y = (p - x) / w;
      if (
        (x > 0 && seen[p - 1]) ||
        (x < w - 1 && seen[p + 1]) ||
        (y > 0 && seen[p - w]) ||
        (y < h - 1 && seen[p + w])
      ) {
        out[p * 4 + 3] = Math.round(out[p * 4 + 3]! / 2);
      }
    }
  }
  const diagnostics = [];
  if (removed === 0) {
    diagnostics.push(
      warning("asset/no-background", "no edge-connected background was found", { background: bg }),
    );
  } else if (removed >= nonTransparent) {
    diagnostics.push(
      warning("asset/background-covers-image", "the background colour covers the whole image", {
        background: bg,
      }),
    );
  }
  return {
    value: { raster: { width: w, height: h, data: out }, background: bg, removed, mask: seen },
    diagnostics,
  };
}

/** Box-filter downscale (exact area coverage, alpha-weighted) so the longest side is `maxPx`. No upscaling. */
export function shrink(r: Raster, maxPx: number): OpResult<Raster> {
  const bad = checkRaster(r);
  if (bad) return { diagnostics: [bad] };
  if (!Number.isInteger(maxPx) || maxPx < 1 || maxPx > 8192) {
    return { diagnostics: [badOption("maxPx", "max-px must be an integer from 1 to 8192")] };
  }
  const long = Math.max(r.width, r.height);
  if (long <= maxPx) return { value: r, diagnostics: [] };
  const nw = Math.max(1, Math.round((r.width * maxPx) / long));
  const nh = Math.max(1, Math.round((r.height * maxPx) / long));
  return { value: boxResample(r, nw, nh), diagnostics: [] };
}

/** Smallest and largest `zoom` factor. */
export const ZOOM_RANGE = { min: 0.25, max: 8 } as const;

/**
 * Scales by `k` (0.25 to 8): box filter below 1, bilinear above, sizes rounded to whole pixels (at
 * least 1). `k` of 1 returns the raster as is. A result over `MAX_PIXELS` is `asset/too-large`.
 */
export function zoom(r: Raster, k: number): OpResult<Raster> {
  const bad = checkRaster(r);
  if (bad) return { diagnostics: [bad] };
  if (!(k >= ZOOM_RANGE.min && k <= ZOOM_RANGE.max)) {
    return {
      diagnostics: [
        badOption("scale", `scale must be from ${ZOOM_RANGE.min} to ${ZOOM_RANGE.max}`),
      ],
    };
  }
  if (k === 1) return { value: r, diagnostics: [] };
  const nw = Math.max(1, Math.round(r.width * k));
  const nh = Math.max(1, Math.round(r.height * k));
  if (nw * nh > MAX_PIXELS) {
    return {
      diagnostics: [
        err(
          "asset/too-large",
          `the result at scale ${k} would be ${nw}x${nh} (over ${MAX_PIXELS} px)`,
        ),
      ],
    };
  }
  return { value: k < 1 ? boxResample(r, nw, nh) : bilinear(r, nw, nh), diagnostics: [] };
}

export interface ShrunkImage {
  readonly bytes: Uint8Array;
  readonly format: "png" | "jpeg";
  readonly width: number;
  readonly height: number;
  /** True when pixels were resampled and re-encoded. */
  readonly resized: boolean;
}

/**
 * `assets shrink`: PNG gets a deterministic box-filter downscale and a PNG re-encode; a PNG that
 * already fits is returned as C-1's cleaned bytes. JPEG is never re-encoded: passed through
 * unchanged (`asset/shrink-passthrough`, a warning when it is larger than `maxPx`), or with
 * `toPng` decoded (orientation applied), shrunk and written as PNG. SVG is rejected.
 */
export async function shrinkImage(
  bytes: Uint8Array,
  maxPx: number,
  options: { readonly toPng?: boolean; readonly limits?: ImageLimits } = {},
): Promise<OpResult<ShrunkImage>> {
  const dec = await decodeImage(bytes, options.limits ? { limits: options.limits } : {});
  if (!dec.value) return { diagnostics: dec.diagnostics };
  const { raster, asset } = dec.value;
  const diagnostics = [...dec.diagnostics];
  if (asset.format === "svg") {
    return {
      diagnostics: [...diagnostics, badOption("input", "shrink works on PNG and JPEG, not SVG")],
    };
  }
  const s = shrink(raster, maxPx);
  if (!s.value) return { diagnostics: [...diagnostics, ...s.diagnostics] };
  const resized = s.value !== raster;
  if (asset.format === "jpeg" && !options.toPng) {
    diagnostics.push({
      severity: resized ? "warning" : "info",
      code: "asset/shrink-passthrough",
      path: "",
      message: resized
        ? `JPEG is never re-encoded, so it stays ${raster.width}x${raster.height}`
        : "JPEG passed through unchanged",
      ...(resized ? { suggestion: "use toPng (--to-png) to shrink it as a PNG" } : {}),
    });
    return {
      value: { bytes, format: "jpeg", width: raster.width, height: raster.height, resized: false },
      diagnostics,
    };
  }
  if (asset.format === "png" && !resized && asset.orientation === 1) {
    return {
      value: {
        bytes: asset.data,
        format: "png",
        width: raster.width,
        height: raster.height,
        resized: false,
      },
      diagnostics,
    };
  }
  return {
    value: {
      bytes: encodePng(s.value),
      format: "png",
      width: s.value.width,
      height: s.value.height,
      resized,
    },
    diagnostics,
  };
}
