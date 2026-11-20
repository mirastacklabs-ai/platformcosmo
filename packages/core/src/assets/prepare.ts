/**
 * `prepareImage` (§11): bytes in, validated and metadata-free `ImageAsset` out. Pure, offline,
 * deterministic, never throws for bad input. Raster pixels are never decoded or re-encoded.
 */
import type {
  Diagnostic,
  ImageAsset,
  ImageAssetInput,
  ImageFormat,
  ImageLimits,
  PrepareImageFn,
} from "../contracts/index.js";
import { sha256 } from "../icons/integrity.js";
import { cleanJpeg, isJpeg } from "./jpeg.js";
import { cleanPng, isPng } from "./png.js";
import { cleanSvg, looksLikeSvg } from "./svg.js";

/** Successful raster parse (internal, shared by png.ts and jpeg.ts). */
export interface RasterOk {
  readonly ok: true;
  readonly data: Uint8Array;
  /** Stored size (before orientation). */
  readonly width: number;
  readonly height: number;
  readonly orientation: number;
  readonly icc: boolean;
  readonly cmyk: boolean;
  readonly exifIgnored: boolean;
  readonly stripped: boolean;
}
export interface RasterFail {
  readonly ok: false;
  readonly code: "format" | "animated";
  readonly message: string;
}

/** §11.4 defaults. */
export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxBytes: 2 * 1024 * 1024,
  maxSvgBytes: 256 * 1024,
  maxDimension: 8192,
  maxPixels: 16_777_216,
  maxTotalBytes: 8 * 1024 * 1024,
  maxImages: 256,
  warnTotalBytes: 1024 * 1024,
};

const DATA_URI_RE = /^data:image\/(png|jpeg|svg\+xml);base64,([A-Za-z0-9+/]*={0,2})$/;
const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};
const EXT_FORMAT: Record<string, ImageFormat> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  svg: "svg",
};
const HINT = "convert it to PNG or JPEG";

/** Decodes a `data:image/(png|jpeg|svg+xml);base64,…` URI; `undefined` when it is not one. */
export function decodeImageDataUri(
  src: string,
): { readonly format: ImageFormat; readonly bytes: Uint8Array } | undefined {
  const m = DATA_URI_RE.exec(src);
  if (!m || (m[2] as string).length % 4 !== 0) return undefined;
  try {
    const bin = atob(m[2] as string);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const format: ImageFormat = m[1] === "svg+xml" ? "svg" : (m[1] as ImageFormat);
    return { format, bytes };
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const hashOf = (bytes: Uint8Array): string => `sha256-${toBase64(sha256(bytes))}`;

const ptr = (key: string): string => `/images/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;

/** Magic bytes of formats that are recognised only to be rejected with a useful message. */
function otherFormat(b: Uint8Array): string | undefined {
  const s = (at: number, t: string): boolean =>
    b.length >= at + t.length && [...t].every((c, i) => b[at + i] === c.charCodeAt(0));
  if (s(0, "RIFF") && s(8, "WEBP")) return "WebP";
  if (s(0, "GIF8")) return "GIF";
  if (s(4, "ftyp")) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (brand === "avif" || brand === "avis") return "AVIF";
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return "HEIC";
  }
  if (s(0, "II*\0") || s(0, "MM\0*")) return "TIFF";
  if (s(0, "BM")) return "BMP";
  return undefined;
}

export const prepareImage: PrepareImageFn = (input: ImageAssetInput, limits: ImageLimits) => {
  const diagnostics: Diagnostic[] = [];
  try {
    const asset = prepare(input, limits, diagnostics);
    return asset ? { asset, diagnostics } : { diagnostics };
  } catch {
    return {
      diagnostics: [
        {
          severity: "error",
          code: "image/format",
          path: ptr(input.key),
          message: `image "${input.key}" could not be read`,
        },
      ],
    };
  }
};

function prepare(
  input: ImageAssetInput,
  limits: ImageLimits,
  diagnostics: Diagnostic[],
): ImageAsset | undefined {
  const path = ptr(input.key);
  const inline = input.src.startsWith("data:");
  const label = inline ? "inline data URI" : input.src.slice(0, 120);
  const err = (code: string, message: string, suggestion?: string): undefined => {
    diagnostics.push({
      severity: "error",
      code,
      path,
      message,
      ...(suggestion ? { suggestion } : {}),
    });
    return undefined;
  };

  let bytes = input.bytes;
  let declared: ImageFormat | undefined;
  if (inline) {
    const dec = decodeImageDataUri(input.src);
    if (!dec) {
      return err(
        "image/format",
        `image "${input.key}": the data URI is not base64 data:image/(png|jpeg|svg+xml)`,
        "use a PNG or JPEG data URI, or a relative file path",
      );
    }
    declared = dec.format;
    if (bytes.length === 0) bytes = dec.bytes;
  } else {
    const ext = /\.([A-Za-z0-9]+)$/.exec(input.src)?.[1]?.toLowerCase();
    declared = ext ? EXT_FORMAT[ext] : undefined;
  }

  if (bytes.length === 0) return err("image/format", `image "${input.key}" (${label}) is empty`);

  let format: ImageFormat;
  if (isPng(bytes)) format = "png";
  else if (isJpeg(bytes)) format = "jpeg";
  else if (looksLikeSvg(bytes)) format = "svg";
  else {
    const other = otherFormat(bytes);
    return err(
      "image/format",
      `image "${input.key}" (${label}) is ${other ?? "not a PNG, JPEG or SVG"} (checked by content, not extension)`,
      other ? `${HINT} (${other} is not supported)` : HINT,
    );
  }
  if (declared !== undefined && declared !== format) {
    return err(
      "image/format-mismatch",
      `image "${input.key}" (${label}) is ${format.toUpperCase()} by content but declared ${declared.toUpperCase()}`,
      "rename the file or fix the data URI media type",
    );
  }

  const cap = format === "svg" ? limits.maxSvgBytes : limits.maxBytes;
  if (bytes.length > cap) {
    return err(
      "image/too-large",
      `image "${input.key}" (${label}) is ${bytes.length} bytes; the ${format === "svg" ? "SVG" : "raster"} limit is ${cap}`,
      format === "svg" ? "simplify the SVG" : "downscale or recompress the image",
    );
  }

  if (format === "svg") {
    const r = cleanSvg(bytes, limits.maxSvgBytes);
    if (!r.ok) return err("image/format", `image "${input.key}" (${label}): ${r.message}`);
    if (r.removed.length > 0) {
      diagnostics.push({
        severity: "info",
        code: "image/sanitized",
        path,
        message: `image "${input.key}": the sanitizer removed ${r.removed.length} unsafe or unsupported item(s): ${r.removed.slice(0, 8).join(", ")}`,
        params: { removed: r.removed },
      });
    }
    return {
      key: input.key,
      format,
      mime: MIME.svg,
      width: r.width,
      height: r.height,
      orientation: 1,
      hash: hashOf(new TextEncoder().encode(r.svg.body)),
      data: new Uint8Array(0),
      svg: r.svg,
    };
  }

  const r = format === "png" ? cleanPng(bytes) : cleanJpeg(bytes);
  if (!r.ok) {
    return err(
      r.code === "animated" ? "image/animated" : "image/format",
      `image "${input.key}" (${label}): ${r.message}`,
    );
  }
  if (
    r.width > limits.maxDimension ||
    r.height > limits.maxDimension ||
    r.width * r.height > limits.maxPixels
  ) {
    return err(
      "image/too-large",
      `image "${input.key}" (${label}) is ${r.width}x${r.height} px; limits are ${limits.maxDimension} px per side and ${limits.maxPixels} pixels`,
      "downscale the image",
    );
  }
  if (r.icc) {
    diagnostics.push({
      severity: "info",
      code: "image/icc-ignored",
      path,
      message: `image "${input.key}": the embedded colour profile was removed; sRGB is assumed`,
    });
  }
  if (r.cmyk) {
    diagnostics.push({
      severity: "warning",
      code: "image/cmyk",
      path,
      message: `image "${input.key}": CMYK JPEG; browsers render it but the PNG/GIF/MP4 renderer may not`,
      suggestion: "convert it to an RGB JPEG or PNG",
    });
  }
  if (r.exifIgnored) {
    diagnostics.push({
      severity: "info",
      code: "image/exif-ignored",
      path,
      message: `image "${input.key}": malformed EXIF block ignored; orientation 1 assumed`,
    });
  }
  const o = r.orientation as ImageAsset["orientation"];
  const swap = o >= 5;
  return {
    key: input.key,
    format,
    mime: MIME[format],
    width: swap ? r.height : r.width,
    height: swap ? r.width : r.height,
    orientation: o,
    hash: hashOf(r.data),
    data: r.data,
  };
}
