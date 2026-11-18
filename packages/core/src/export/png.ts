/**
 * Minimal PNG reader for frames produced by resvg (8-bit RGBA, non-interlaced). Used to turn the
 * `VideoEncoder` PNG frames into pixels for the GIF encoder, and to read frame sizes.
 */
import { inflateSync } from "node:zlib";

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major. */
  readonly data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u32 = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/** Width and height from the IHDR chunk, without decoding pixels. */
export function pngSize(png: Uint8Array): { readonly width: number; readonly height: number } {
  if (png.length < 24 || SIGNATURE.some((v, i) => png[i] !== v)) {
    throw new Error("not a PNG");
  }
  return { width: u32(png, 16), height: u32(png, 20) };
}

export function decodePng(png: Uint8Array): DecodedPng {
  const { width, height } = pngSize(png);
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) {
    throw new Error("unsupported PNG: only 8-bit RGBA non-interlaced is supported");
  }
  const idat: Uint8Array[] = [];
  let o = 8;
  while (o + 8 <= png.length) {
    const len = u32(png, o);
    const type = String.fromCharCode(png[o + 4]!, png[o + 5]!, png[o + 6]!, png[o + 7]!);
    if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
    if (type === "IEND") break;
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]!;
      const a = x >= 4 ? out[dst + x - 4]! : 0;
      const b = y > 0 ? out[dst - stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[dst - stride + x - 4]! : 0;
      let p: number;
      switch (filter) {
        case 0:
          p = v;
          break;
        case 1:
          p = v + a;
          break;
        case 2:
          p = v + b;
          break;
        case 3:
          p = v + ((a + b) >> 1);
          break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      out[dst + x] = p & 0xff;
    }
  }
  return { width, height, data: out };
}
