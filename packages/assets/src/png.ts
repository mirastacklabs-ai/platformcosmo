/**
 * Deterministic PNG codec for 8-bit RGBA. Encoding: fixed zlib level (fflate, pure JS so output
 * does not depend on the Node zlib build), per-row filter chosen by a fixed heuristic, IHDR/IDAT/
 * IEND only (no ancillary chunks). Decoding of resvg output uses core's `decodePng`.
 */
import { zlibSync } from "fflate";
import { crc32 } from "node:zlib";
import type { Raster } from "./raster.js";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
