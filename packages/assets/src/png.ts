/**
 * Deterministic PNG codec for 8-bit RGBA. Encoding: fixed zlib level (fflate, pure JS so output
 * does not depend on the Node zlib build), per-row filter chosen by a fixed heuristic, IHDR/IDAT/
 * IEND only (no ancillary chunks). Decoding reads only what resvg emits (8-bit RGBA).
 */
import { unzlibSync, zlibSync } from "fflate";
import { crc32 } from "node:zlib";
import type { Raster } from "./raster.js";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u32 = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Filters 0 (none), 1 (sub), 2 (up); picks the lowest sum of absolute signed residuals, ties to the lower id. */
export function encodePng(r: Raster): Uint8Array {
  const { width, height, data } = r;
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  const cand = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)];
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? data.subarray((y - 1) * stride, y * stride) : undefined;
    for (let x = 0; x < stride; x++) {
      cand[0]![x] = row[x]!;
      cand[1]![x] = (row[x]! - (x >= 4 ? row[x - 4]! : 0)) & 0xff;
      cand[2]![x] = (row[x]! - (up ? up[x]! : 0)) & 0xff;
    }
    let best = 0;
    let bestCost = Infinity;
    for (let f = 0; f < 3; f++) {
      let c = 0;
      const k = cand[f]!;
      for (let x = 0; x < stride; x++) c += k[x]! < 128 ? k[x]! : 256 - k[x]!;
      if (c < bestCost) {
        bestCost = c;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(cand[best]!, y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return concat([
    Uint8Array.from(SIG),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Decodes an 8-bit RGBA non-interlaced PNG (resvg output or `encodePng`). Throws otherwise. */
export function decodeRgbaPng(png: Uint8Array): Raster {
  if (png.length < 33 || SIG.some((v, i) => png[i] !== v)) throw new Error("not a PNG");
  const width = u32(png, 16);
  const height = u32(png, 20);
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) {
    throw new Error("unsupported PNG: only 8-bit RGBA non-interlaced is supported");
  }
  const idat: Uint8Array[] = [];
  for (let o = 8; o + 8 <= png.length;) {
    const len = u32(png, o);
    const type = String.fromCharCode(png[o + 4]!, png[o + 5]!, png[o + 6]!, png[o + 7]!);
    if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
    if (type === "IEND") break;
    o += 12 + len;
  }
  const stride = width * 4;
  const raw = unzlibSync(concat(idat), { out: new Uint8Array((stride + 1) * height) });
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
