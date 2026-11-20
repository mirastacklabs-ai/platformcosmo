/**
 * Image XObjects and inline images (ingestion §4.4): colour spaces, bit depths, `/Decode`,
 * stencil masks, `/SMask` and colour-key `/Mask`, decoded to 8-bit RGB(A) and encoded as PNG
 * (fixed zlib level, no ancillary chunks). DCTDecode is passed through as the JPEG file.
 * Dimensions are checked against the caps before anything is allocated.
 */
import { zlibSync } from "fflate";
import type { PdfFile } from "./file.js";
import { PdfError, diag, type PdfDiagnostic, type PdfLimits, type Where } from "./limits.js";
import {
  PdfDict,
  PdfName,
  PdfStream,
  PdfString,
  intOf,
  nameOf,
  numOf,
  type PdfValue,
} from "./objects.js";

// ---- colour spaces -------------------------------------------------------------------------

export interface ColourSpace {
  readonly family: "gray" | "rgb" | "cmyk" | "indexed" | "approx" | "lab";
  /** Components per sample. */
  readonly n: number;
  readonly label: string;
  readonly base?: ColourSpace;
  readonly hival?: number;
  /** Indexed palette source (decoded lazily). */
  readonly lookup?: PdfValue;
}

const GRAY: ColourSpace = { family: "gray", n: 1, label: "DeviceGray" };
const RGB: ColourSpace = { family: "rgb", n: 3, label: "DeviceRGB" };
const CMYK: ColourSpace = { family: "cmyk", n: 4, label: "DeviceCMYK" };

const DEVICE: Record<string, ColourSpace> = {
  DeviceGray: GRAY,
  G: GRAY,
  CalGray: { ...GRAY, label: "CalGray" },
  DeviceRGB: RGB,
  RGB,
  CalRGB: { ...RGB, label: "CalRGB" },
  DeviceCMYK: CMYK,
  CMYK,
};

/** Resolves a colour space; `null` when unusable (Pattern, malformed). Depth-bounded (≤ 3). */
export function resolveColourSpace(
  file: PdfFile,
  value: PdfValue | undefined,
  resources: PdfDict | null,
  depth = 0,
): ColourSpace | null {
  if (depth > 3) return null;
  const v = file.resolve(value);
  if (v instanceof PdfName) {
    const d = DEVICE[v.name];
    if (d) return d;
    if (v.name === "Pattern") return null;
    const csd = resources ? file.resolveDict(resources.get("ColorSpace")) : null;
    const named = csd ? csd.get(v.name) : undefined;
    return named === undefined ? null : resolveColourSpace(file, named, null, depth + 1);
  }
  if (!Array.isArray(v) || v.length === 0) return null;
  const fam = nameOf(file.resolve(v[0]));
  switch (fam) {
    case "DeviceGray":
    case "DeviceRGB":
    case "DeviceCMYK":
    case "CalGray":
    case "CalRGB":
    case "G":
    case "RGB":
    case "CMYK":
      return DEVICE[fam] ?? null;
    case "ICCBased": {
      const s = file.resolve(v[1]);
      const n = s instanceof PdfStream ? intOf(file.resolve(s.dict.get("N"))) : null;
      if (n === 1) return { ...GRAY, label: "ICCBased" };
      if (n === 3) return { ...RGB, label: "ICCBased" };
      if (n === 4) return { ...CMYK, label: "ICCBased" };
      return null;
    }
    case "Lab":
      return { family: "lab", n: 3, label: "Lab" };
    case "Indexed":
    case "I": {
      const base = resolveColourSpace(file, v[1], resources, depth + 1);
      const hival = intOf(file.resolve(v[2]));
      if (!base || base.family === "indexed" || hival === null || hival < 0 || hival > 255) {
        return null;
      }
      return {
        family: "indexed",
        n: 1,
        label: `Indexed(${base.label})`,
        base,
        hival,
        lookup: v[3],
      };
    }
    case "Separation":
      return { family: "approx", n: 1, label: "Separation" };
    case "DeviceN": {
      const names = file.resolve(v[1]);
      const n = Array.isArray(names) ? names.length : 0;
      return n >= 1 && n <= 32 ? { family: "approx", n, label: "DeviceN" } : null;
    }
    default:
      return null;
  }
}

// ---- metadata ------------------------------------------------------------------------------

export interface ImageMeta {
  readonly width: number;
  readonly height: number;
  readonly bitsPerComponent: number;
  readonly colourSpace: string | null;
  readonly components: number;
  readonly filters: string[];
  /** "jpeg": DCT passthrough; "png": decoded; "unsupported": a filter we cannot decode. */
  readonly format: "jpeg" | "png" | "unsupported";
  readonly imageMask: boolean;
  /** An `/SMask`, `/Mask` or stencil gives the image an alpha channel. */
  readonly hasAlpha: boolean;
  /** Within the 16 384 px/side and 16 MP output caps. */
  readonly withinCaps: boolean;
}

const UNSUPPORTED_FILTERS = new Set(["JBIG2Decode", "JPXDecode", "CCITTFaxDecode", "Crypt"]);

export function imageMeta(
  file: PdfFile,
  s: PdfStream,
  resources: PdfDict | null,
  limits: PdfLimits,
): ImageMeta {
  const d = s.dict;
  const g = (k: string): PdfValue | undefined => file.resolve(d.get(k));
  const width = intOf(g("Width")) ?? 0;
  const height = intOf(g("Height")) ?? 0;
  const imageMask = g("ImageMask") === true;
  const cs = imageMask ? GRAY : resolveColourSpace(file, d.get("ColorSpace"), resources);
  const filters = file.filterNames(s);
  const last = filters[filters.length - 1];
  const format =
    last === "DCTDecode"
      ? "jpeg"
      : filters.some((f) => UNSUPPORTED_FILTERS.has(f) || f === "DCTDecode")
        ? "unsupported"
        : "png";
  const smask = g("SMask");
  const mask = g("Mask");
  return {
    width,
    height,
    bitsPerComponent: imageMask
      ? 1
      : (intOf(g("BitsPerComponent")) ?? (last === "DCTDecode" ? 8 : 0)),
    colourSpace: cs ? cs.label : null,
    components: cs ? cs.n : 0,
    filters,
    format,
    imageMask,
    hasAlpha:
      imageMask || smask instanceof PdfStream || mask instanceof PdfStream || Array.isArray(mask),
    withinCaps: dimsOk(width, height, limits),
  };
}

const dimsOk = (w: number, h: number, l: PdfLimits): boolean =>
  w >= 1 && h >= 1 && w <= l.maxImageSide && h <= l.maxImageSide && w * h <= l.maxImagePixels;

// ---- decoding ------------------------------------------------------------------------------

export type DecodedImage =
  | {
      readonly kind: "jpeg";
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "rgba";
      readonly width: number;
      readonly height: number;
      /** RGBA, 8 bits per channel, row-major. */
      readonly pixels: Uint8Array;
      readonly alpha: boolean;
    };

interface Samples {
  readonly data: Uint8Array;
  readonly rowBytes: number;
  readonly n: number;
  readonly bpc: number;
}

function checkDims(w: number, h: number, l: PdfLimits, where: Where): void {
  if (w < 1 || h < 1)
    throw new PdfError("pdf/malformed", "an image has no valid /Width or /Height", where);
  if (!dimsOk(w, h, l)) {
    throw new PdfError(
      "pdf/too-large",
      `image ${w}×${h} exceeds the output cap (${l.maxImageSide} px per side, ${l.maxImagePixels} px)`,
      { ...where, width: w, height: h },
      "use `pcosmo assets pdf render --crop` at a lower DPI",
    );
  }
}

/** Decodes the raw samples of an image stream (declared-size capped; short data is padded). */
function readSamples(
  file: PdfFile,
  s: PdfStream,
  w: number,
  h: number,
  n: number,
  bpc: number,
  where: Where,
  diags: PdfDiagnostic[],
): Samples {
  if (![1, 2, 4, 8, 16].includes(bpc)) {
    throw new PdfError("pdf/malformed", `unsupported BitsPerComponent ${bpc}`, where);
  }
  const rowBytes = Math.ceil((w * n * bpc) / 8);
  const expected = rowBytes * h;
  if (expected > file.limits.maxStreamBytes) {
    throw new PdfError(
      "pdf/too-large",
      `image data of ${expected} bytes exceeds the stream cap`,
      where,
    );
  }
  const r = file.decodeStream(s, { limit: expected, mode: "truncate", where });
  if (r.jpeg) throw new PdfError("pdf/unsupported-filter", "a JPEG cannot be decoded here", where);
  let data = r.data;
  if (data.length < expected) {
    diags.push(
      diag("warning", "pdf/malformed", "image data is shorter than declared; padded", {
        ...where,
        expected,
        actual: data.length,
      }),
    );
    const p = new Uint8Array(expected);
    p.set(data);
    data = p;
  }
  return { data, rowBytes, n, bpc };
}

/** Reads sample `c` of pixel `x` in row `y`. */
function sample(sm: Samples, x: number, y: number, c: number): number {
  const { data, rowBytes, n, bpc } = sm;
  const i = x * n + c;
  const row = y * rowBytes;
  if (bpc === 8) return data[row + i] as number;
  if (bpc === 16) return ((data[row + 2 * i] as number) << 8) | (data[row + 2 * i + 1] as number);
  const bit = i * bpc;
  return ((data[row + (bit >> 3)] as number) >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1);
}

function decodeArray(
  file: PdfFile,
  d: PdfDict,
  n: number,
  dflt: (c: number) => [number, number],
): [number, number][] {
  const v = file.resolve(d.get("Decode"));
  const out: [number, number][] = [];
  for (let c = 0; c < n; c++) {
    const lo = Array.isArray(v) ? numOf(file.resolve(v[2 * c])) : null;
    const hi = Array.isArray(v) ? numOf(file.resolve(v[2 * c + 1])) : null;
    out.push(lo !== null && hi !== null ? [lo, hi] : dflt(c));
  }
  return out;
}

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const to8 = (v: number): number => Math.round(clamp01(v) * 255);

/** Palette bytes of an Indexed space, `(hival+1) * base.n` long (zero-padded). */
function palette(file: PdfFile, cs: ColourSpace, where: Where): Uint8Array {
  const base = cs.base as ColourSpace;
  const len = ((cs.hival as number) + 1) * base.n;
  const out = new Uint8Array(len);
  const v = file.resolve(cs.lookup);
  if (v instanceof PdfString) out.set(v.bytes.subarray(0, len));
  else if (v instanceof PdfStream) {
    out.set(file.decodeStream(v, { limit: len, mode: "truncate", where }).data.subarray(0, len));
  }
  return out;
}

/** Converts component values in [0,1] of `cs` to RGB bytes. */
function toRgb(cs: ColourSpace, v: Float64Array, out: Uint8Array, at: number): void {
  switch (cs.family) {
    case "gray": {
      const g = to8(v[0] as number);
      out[at] = g;
      out[at + 1] = g;
      out[at + 2] = g;
      return;
    }
    case "rgb":
      out[at] = to8(v[0] as number);
      out[at + 1] = to8(v[1] as number);
      out[at + 2] = to8(v[2] as number);
      return;
    case "cmyk": {
      // naive conversion (ingestion §4.4)
      const k = 1 - clamp01(v[3] as number);
      out[at] = to8((1 - clamp01(v[0] as number)) * k);
      out[at + 1] = to8((1 - clamp01(v[1] as number)) * k);
      out[at + 2] = to8((1 - clamp01(v[2] as number)) * k);
      return;
    }
    case "lab": {
      const g = to8((v[0] as number) / 100);
      out[at] = g;
      out[at + 1] = g;
      out[at + 2] = g;
      return;
    }
    default: {
      // Separation / DeviceN approximated to gray: 1 − mean tint
      let s = 0;
      for (let c = 0; c < cs.n; c++) s += clamp01(v[c] as number);
      const g = to8(1 - s / cs.n);
      out[at] = g;
      out[at + 1] = g;
      out[at + 2] = g;
    }
  }
}

/** Decodes a gray mask image (SMask or stencil `/Mask`) to `w*h` alpha bytes. */
function maskAlpha(
  file: PdfFile,
  ms: PdfStream,
  w: number,
  h: number,
  stencil: boolean,
  where: Where,
  diags: PdfDiagnostic[],
): Uint8Array | null {
  const d = ms.dict;
  const mw = intOf(file.resolve(d.get("Width"))) ?? 0;
  const mh = intOf(file.resolve(d.get("Height"))) ?? 0;
  const mwhere = { ...where, mask: true };
  checkDims(mw, mh, file.limits, mwhere);
  if (file.filterNames(ms).some((f) => f === "DCTDecode" || UNSUPPORTED_FILTERS.has(f))) {
    diags.push(
      diag(
        "warning",
        "pdf/unsupported-filter",
        "the image's mask uses a filter that cannot be decoded; the image is extracted without alpha",
        mwhere,
      ),
    );
    return null;
  }
  const bpc = stencil ? 1 : (intOf(file.resolve(d.get("BitsPerComponent"))) ?? 8);
  const sm = readSamples(file, ms, mw, mh, 1, bpc, mwhere, diags);
  const maxv = (1 << bpc) - 1;
  const [[d0, d1]] = decodeArray(file, d, 1, () => [0, 1]) as [[number, number]];
  const lut = new Uint8Array(maxv + 1 > 256 ? 0 : maxv + 1);
  const value = (s: number): number => {
    const t = d0 + (s * (d1 - d0)) / maxv;
    return stencil ? (t < 0.5 ? 255 : 0) : to8(t);
  };
  for (let s = 0; s < lut.length; s++) lut[s] = value(s);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const my = mh === h ? y : Math.min(mh - 1, Math.floor((y * mh) / h));
    for (let x = 0; x < w; x++) {
      const mx = mw === w ? x : Math.min(mw - 1, Math.floor((x * mw) / w));
      const s = sample(sm, mx, my, 0);
      out[y * w + x] = lut.length ? (lut[s] as number) : value(s);
    }
  }
  return out;
}

export function decodeImage(
  file: PdfFile,
  s: PdfStream,
  resources: PdfDict | null,
  where: Where,
  diags: PdfDiagnostic[],
): DecodedImage {
  const d = s.dict;
  const g = (k: string): PdfValue | undefined => file.resolve(d.get(k));
  const w = intOf(g("Width")) ?? 0;
  const h = intOf(g("Height")) ?? 0;
  checkDims(w, h, file.limits, where);
  const filters = file.filterNames(s);
  if (filters[filters.length - 1] === "DCTDecode") {
    const r = file.decodeStream(s, { where });
    const b = r.data;
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
      throw new PdfError("pdf/malformed", "a DCTDecode stream is not a JPEG file", where);
    }
    return { kind: "jpeg", bytes: b, width: w, height: h };
  }
  const imageMask = g("ImageMask") === true;
  const cs = imageMask ? GRAY : resolveColourSpace(file, d.get("ColorSpace"), resources);
  if (!cs) {
    throw new PdfError("pdf/malformed", "an image has a missing or unsupported /ColorSpace", where);
  }
  if (cs.family === "approx" || cs.family === "lab") {
    diags.push(
      diag("warning", "pdf/colour-approx", `${cs.label} colours are approximated as gray`, where),
    );
  }
  const bpc = imageMask ? 1 : (intOf(g("BitsPerComponent")) ?? 8);
  const sm = readSamples(file, s, w, h, cs.n, bpc, where, diags);
  const maxv = bpc === 16 ? 65535 : (1 << bpc) - 1;
  const pixels = new Uint8Array(w * h * 4);
  let alpha = false;

  if (imageMask) {
    const [[d0, d1]] = decodeArray(file, d, 1, () => [0, 1]) as [[number, number]];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = d0 + sample(sm, x, y, 0) * (d1 - d0);
        pixels[(y * w + x) * 4 + 3] = t < 0.5 ? 255 : 0; // painted with black
      }
    }
    return { kind: "rgba", width: w, height: h, pixels, alpha: true };
  }

  const indexed = cs.family === "indexed";
  const dec = decodeArray(file, d, cs.n, (c) =>
    indexed ? [0, maxv] : cs.family === "lab" && c === 0 ? [0, 100] : [0, 1],
  );
  // per-component lookup tables for bpc ≤ 8 (≤ 256 entries each)
  const luts: Float64Array[] = [];
  if (bpc <= 8) {
    for (let c = 0; c < cs.n; c++) {
      const [lo, hi] = dec[c] as [number, number];
      const t = new Float64Array(maxv + 1);
      for (let v = 0; v <= maxv; v++) t[v] = lo + (v * (hi - lo)) / maxv;
      luts.push(t);
    }
  }
  const comp = (x: number, y: number, c: number): number => {
    const v = sample(sm, x, y, c);
    if (bpc <= 8) return (luts[c] as Float64Array)[v] as number;
    const [lo, hi] = dec[c] as [number, number];
    return lo + (v * (hi - lo)) / maxv;
  };
  const vals = new Float64Array(Math.max(4, cs.n));
  if (indexed) {
    const base = cs.base as ColourSpace;
    const pal = palette(file, cs, where);
    const hival = cs.hival as number;
    const rgbPal = new Uint8Array((hival + 1) * 3);
    const bv = new Float64Array(Math.max(4, base.n));
    for (let i = 0; i <= hival; i++) {
      for (let c = 0; c < base.n; c++) {
        bv[c] = (pal[i * base.n + c] as number) / (base.family === "lab" && c === 0 ? 2.55 : 255);
      }
      toRgb(base, bv, rgbPal, i * 3);
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let i = Math.round(comp(x, y, 0));
        i = i < 0 ? 0 : i > hival ? hival : i;
        const o = (y * w + x) * 4;
        pixels[o] = rgbPal[i * 3] as number;
        pixels[o + 1] = rgbPal[i * 3 + 1] as number;
        pixels[o + 2] = rgbPal[i * 3 + 2] as number;
        pixels[o + 3] = 255;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < cs.n; c++) vals[c] = comp(x, y, c);
        const o = (y * w + x) * 4;
        toRgb(cs, vals, pixels, o);
        pixels[o + 3] = 255;
      }
    }
  }

  // alpha: /SMask (soft mask) wins over /Mask
  const smask = g("SMask");
  const mask = g("Mask");
  let a: Uint8Array | null = null;
  if (smask instanceof PdfStream) a = maskAlpha(file, smask, w, h, false, where, diags);
  else if (mask instanceof PdfStream) a = maskAlpha(file, mask, w, h, true, where, diags);
  else if (Array.isArray(mask)) {
    const ranges = mask.map((x) => numOf(file.resolve(x)));
    if (ranges.length >= 2 * cs.n && ranges.every((x) => x !== null)) {
      a = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let inside = true;
          for (let c = 0; c < cs.n && inside; c++) {
            const v = sample(sm, x, y, c);
            inside = v >= (ranges[2 * c] as number) && v <= (ranges[2 * c + 1] as number);
          }
          a[y * w + x] = inside ? 0 : 255;
        }
      }
    }
  }
  if (a) {
    alpha = true;
    for (let i = 0; i < w * h; i++) pixels[i * 4 + 3] = a[i] as number;
  }
  return { kind: "rgba", width: w, height: h, pixels, alpha };
}

/** Decodes an image's mask alone (`/SMask`, stencil `/Mask` or `/ImageMask`) as gray alpha. */
export function decodeMask(
  file: PdfFile,
  s: PdfStream,
  where: Where,
  diags: PdfDiagnostic[],
): DecodedImage | null {
  const d = s.dict;
  const w = intOf(file.resolve(d.get("Width"))) ?? 0;
  const h = intOf(file.resolve(d.get("Height"))) ?? 0;
  checkDims(w, h, file.limits, where);
  let a: Uint8Array | null = null;
  const smask = file.resolve(d.get("SMask"));
  const mask = file.resolve(d.get("Mask"));
  if (file.resolve(d.get("ImageMask")) === true) a = maskAlpha(file, s, w, h, true, where, diags);
  else if (smask instanceof PdfStream) a = maskAlpha(file, smask, w, h, false, where, diags);
  else if (mask instanceof PdfStream) a = maskAlpha(file, mask, w, h, true, where, diags);
  if (!a) return null;
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = a[i] as number;
    pixels[i * 4] = v;
    pixels[i * 4 + 1] = v;
    pixels[i * 4 + 2] = v;
    pixels[i * 4 + 3] = 255;
  }
  return { kind: "rgba", width: w, height: h, pixels, alpha: false };
}

// ---- PNG -----------------------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC[(c ^ (b[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** PNG zlib level: fixed so the same pixels always give the same bytes. */
export const PNG_ZLIB_LEVEL = 6;

/** Encodes RGBA pixels as an 8-bit RGB (no alpha) or RGBA PNG; Sub filter on every row. */
export function encodePng(w: number, h: number, rgba: Uint8Array, alpha: boolean): Uint8Array {
  const ch = alpha ? 4 : 3;
  const stride = w * ch;
  const raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = 1; // Sub
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      for (let c = 0; c < ch; c++) {
        const v = rgba[s + c] as number;
        const left = x > 0 ? (rgba[s - 4 + c] as number) : 0;
        raw[o + 1 + x * ch + c] = (v - left) & 0xff;
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw, { level: PNG_ZLIB_LEVEL })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
