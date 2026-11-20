/**
 * PNG validation and metadata stripping (§11.2). No decoding: chunks are walked, CRCs verified,
 * and only IHDR, PLTE, tRNS, IDAT and IEND are copied through, so the pixel stream is untouched.
 */
import type { RasterFail, RasterOk } from "./prepare.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
const APNG = new Set(["acTL", "fcTL", "fdAT"]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 over `bytes[start, end)` (PNG chunk type + data). */
export function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && SIGNATURE.every((v, i) => b[i] === v);
}

const fail = (message: string, code: RasterFail["code"] = "format"): RasterFail => ({
  ok: false,
  code,
  message,
});

const VALID_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function cleanPng(bytes: Uint8Array): RasterOk | RasterFail {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let first = true;
  let sawIdat = false;
  let sawTrns = false;
  let palette = 0;
  let sawPlte = false;
  let sawIend = false;
  let afterIdat = false;
  let icc = false;
  while (off < bytes.length) {
    if (off + 12 > bytes.length) return fail("truncated PNG (incomplete chunk header)");
    const len = view.getUint32(off);
    if (len > 0x7fffffff) return fail("invalid PNG chunk length");
    const end = off + 12 + len;
    if (end > bytes.length) return fail("truncated PNG (chunk runs past the end)");
    const type = String.fromCharCode(
      bytes[off + 4] as number,
      bytes[off + 5] as number,
      bytes[off + 6] as number,
      bytes[off + 7] as number,
    );
    if (!/^[A-Za-z]{4}$/.test(type)) return fail("invalid PNG chunk type");
    if (view.getUint32(end - 4) !== crc32(bytes, off + 4, end - 4)) {
      return fail(`PNG chunk ${type} has a bad CRC`);
    }
    if (first && type !== "IHDR") return fail("PNG does not start with IHDR");
    if (APNG.has(type)) {
      return fail("animated PNG (APNG) is not supported; use a still PNG", "animated");
    }
    if (type === "IHDR") {
      if (!first || len !== 13) return fail("invalid PNG IHDR");
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      const depth = bytes[off + 16] as number;
      colorType = bytes[off + 17] as number;
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
        return fail("PNG has invalid dimensions");
      }
      if (!VALID_DEPTHS[colorType]?.includes(depth)) return fail("PNG has an invalid bit depth");
      if (bytes[off + 18] !== 0 || bytes[off + 19] !== 0 || (bytes[off + 20] as number) > 1) {
        return fail("PNG uses an unknown compression, filter or interlace method");
      }
    } else if (type === "IDAT") {
      if (afterIdat) return fail("PNG IDAT chunks are not contiguous");
      sawIdat = true;
    } else {
      if (sawIdat) afterIdat = true;
      if (type === "PLTE") {
        if (sawPlte || sawIdat) return fail("PNG PLTE is duplicated or after IDAT");
        if (len % 3 !== 0 || len === 0 || len > 768) return fail("PNG PLTE has an invalid length");
        sawPlte = true;
        palette = len / 3;
      }
      if (type === "tRNS") {
        if (sawTrns || sawIdat) return fail("PNG tRNS is duplicated or after IDAT");
        const okLen =
          colorType === 0
            ? len === 2
            : colorType === 2
              ? len === 6
              : colorType === 3 && sawPlte && len >= 1 && len <= palette;
        if (!okLen) return fail("PNG tRNS is not valid for this colour type");
        sawTrns = true;
      }
      if (type === "IEND") {
        if (len !== 0) return fail("PNG IEND must be empty");
        sawIend = true;
      }
    }
    first = false;
    if (KEEP.has(type)) {
      out.push(bytes.subarray(off, end));
    } else if (type.charCodeAt(0) < 0x61) {
      return fail(`PNG has an unknown critical chunk ${type}`);
    } else {
      if (type === "iCCP") icc = true;
    }
    off = end;
    if (sawIend) break;
  }
  if (first) return fail("empty PNG");
  if (!sawIend) return fail("truncated PNG (no IEND)");
  if (off !== bytes.length) return fail("PNG has trailing data after IEND");
  if (!sawIdat) return fail("PNG has no image data");
  if (colorType === 3 && !sawPlte) return fail("indexed PNG has no palette");
  return {
    ok: true,
    data: concat(out),
    width,
    height,
    orientation: 1,
    icc,
    cmyk: false,
    exifIgnored: false,
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const data = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.length;
  }
  return data;
}
