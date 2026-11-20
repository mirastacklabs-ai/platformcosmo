/**
 * Decode PNG, JPEG and SVG bytes to straight RGBA. Input validation is C-1's `prepareImage`
 * (magic bytes, caps, APNG, sanitizer); pixels come from resvg-wasm through core's `rasterize`
 * (same dependency, same wasm loading), by rendering a one-element SVG at 1:1. The EXIF
 * orientation C-1 read before stripping is applied here, so the result is upright.
 */
import {
  DEFAULT_IMAGE_LIMITS,
  prepareImage,
  rasterize,
  type Diagnostic,
  type ImageAsset,
  type ImageLimits,
} from "@platformcosmo/core";
import { decodePng } from "@platformcosmo/core";
import { MAX_PIXELS, badOption, err, type OpResult, type Raster } from "./raster.js";

export interface DecodeOptions {
  /** C-1 limits; default `DEFAULT_IMAGE_LIMITS`. */
  readonly limits?: ImageLimits;
  /** SVG only: longest side in pixels of the rendered raster, default 1024 (max 8192). */
  readonly svgSize?: number;
  /** Label used as the C-1 image key in diagnostics, default "image". */
  readonly key?: string;
}

export interface DecodedImage {
  readonly raster: Raster;
  /** The C-1 asset (hash, cleaned bytes, format, orientation) the pixels came from. */
  readonly asset: ImageAsset;
}

const toBase64 = (b: Uint8Array): string =>
  Buffer.from(b.buffer, b.byteOffset, b.length).toString("base64");

const tooLarge = (w: number, h: number) =>
  err(
    "asset/too-large",
    `the decoded image would be ${w}x${h}, above the ${MAX_PIXELS} pixel limit`,
    {
      suggestion: "use a smaller svgSize or image",
      params: { width: w, height: h },
    },
  );

/** Applies EXIF orientation 1-8 (8-bit RGBA); the result is the upright image. */
export function applyOrientation(r: Raster, orientation: number): Raster {
  if (orientation === 1 || orientation < 1 || orientation > 8) return r;
  const swap = orientation >= 5;
  const w = swap ? r.height : r.width;
  const h = swap ? r.width : r.height;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      let dx: number;
      let dy: number;
      switch (orientation) {
        case 2:
          dx = r.width - 1 - x;
          dy = y;
          break; // mirror horizontal
        case 3:
          dx = r.width - 1 - x;
          dy = r.height - 1 - y;
          break; // rotate 180
        case 4:
          dx = x;
          dy = r.height - 1 - y;
          break; // mirror vertical
        case 5:
          dx = y;
          dy = x;
          break; // transpose
        case 6:
          dx = r.height - 1 - y;
          dy = x;
          break; // rotate 90 cw
        case 7:
          dx = r.height - 1 - y;
          dy = r.width - 1 - x;
          break; // transverse
        default:
          dx = y;
          dy = r.width - 1 - x;
          break; // 8: rotate 90 ccw
      }
      const s = (y * r.width + x) * 4;
      const d = (dy * w + dx) * 4;
      out[d] = r.data[s]!;
      out[d + 1] = r.data[s + 1]!;
      out[d + 2] = r.data[s + 2]!;
      out[d + 3] = r.data[s + 3]!;
    }
  }
  return { width: w, height: h, data: out };
}

/** Decodes validated bytes. Never throws; bad input yields C-1 diagnostics (`image/*`). */
export async function decodeImage(
  bytes: Uint8Array,
  options: DecodeOptions = {},
): Promise<OpResult<DecodedImage>> {
  const key = options.key ?? "image";
  const svgSize = options.svgSize ?? 1024;
  if (!Number.isInteger(svgSize) || svgSize < 1 || svgSize > 8192) {
    return {
      diagnostics: [badOption("svgSize", "svgSize must be an integer from 1 to 8192")],
    };
  }
  const prepared = prepareImage({ key, src: key, bytes }, options.limits ?? DEFAULT_IMAGE_LIMITS);
  const diagnostics: Diagnostic[] = [...prepared.diagnostics];
  const asset = prepared.asset;
  if (!asset) return { diagnostics };
  try {
    let svg: string;
    let w: number;
    let h: number;
    if (asset.format === "svg" && asset.svg) {
      const vb = asset.svg.viewBox
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      const vw = vb[2] ?? 0;
      const vh = vb[3] ?? 0;
      if (!(vw > 0 && vh > 0)) {
        return { diagnostics: [...diagnostics, err("image/format", "SVG has no usable viewBox")] };
      }
      const k = svgSize / Math.max(vw, vh);
      w = Math.max(1, Math.round(vw * k));
      h = Math.max(1, Math.round(vh * k));
      if (w * h > MAX_PIXELS) return { diagnostics: [...diagnostics, tooLarge(w, h)] };
      const body = asset.svg.body.replaceAll("__PCID__", "p");
      svg =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `width="${w}" height="${h}" viewBox="${asset.svg.viewBox}" preserveAspectRatio="xMidYMid meet">${body}</svg>`;
    } else {
      // asset.width/height are after orientation; the stored bitmap has them swapped for 5-8.
      const swap = asset.orientation >= 5;
      w = swap ? asset.height : asset.width;
      h = swap ? asset.width : asset.height;
      if (w * h > MAX_PIXELS) return { diagnostics: [...diagnostics, tooLarge(w, h)] };
      svg =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" ` +
        `preserveAspectRatio="none" href="data:${asset.mime};base64,${toBase64(asset.data)}"/></svg>`;
    }
    let png: Uint8Array;
    try {
      png = await rasterize(svg, { scale: 1, fonts: [] });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/resvg wasm/.test(msg)) {
        return { diagnostics: [...diagnostics, err("asset/renderer-failed", msg)] };
      }
      throw e;
    }
    // Only ever called on resvg output (8-bit RGBA); core's decoder bounds the inflate size.
    let raster: Raster = decodePng(png);
    if (raster.width !== w || raster.height !== h) {
      return {
        diagnostics: [
          ...diagnostics,
          err("image/format", "the renderer could not decode this image"),
        ],
      };
    }
    raster = applyOrientation(raster, asset.orientation);
    return { value: { raster, asset }, diagnostics };
  } catch (e) {
    return {
      diagnostics: [
        ...diagnostics,
        err(
          "image/format",
          `the image could not be decoded: ${e instanceof Error ? e.message : String(e)}`,
        ),
      ],
    };
  }
}
