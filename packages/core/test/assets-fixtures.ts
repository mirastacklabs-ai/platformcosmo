/** Image fixtures generated in code (no binary files are committed). */
import { crc32 } from "../src/assets/png.js";

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
export const toStr = (b: Uint8Array): string => String.fromCharCode(...b);
export const indexOfBytes = (hay: Uint8Array, needle: string): number => toStr(hay).indexOf(needle);

export function pngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  out.set(enc(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function ihdr(w: number, h: number, depth = 8, color = 2, interlace = 0): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  d[8] = depth;
  d[9] = color;
  d[12] = interlace;
  return pngChunk("IHDR", d);
}

export interface PngOpts {
  readonly w?: number;
  readonly h?: number;
  readonly color?: number;
  readonly depth?: number;
  /** Extra chunks inserted after IHDR (ancillary metadata). */
  readonly extra?: readonly Uint8Array[];
  /** Chunks inserted between IDAT and IEND. */
  readonly late?: readonly Uint8Array[];
  readonly trailing?: Uint8Array;
}

export function makePng(o: PngOpts = {}): Uint8Array {
  const color = o.color ?? 2;
  return cat(
    PNG_SIG,
    ihdr(o.w ?? 4, o.h ?? 3, o.depth ?? 8, color),
    ...(o.extra ?? []),
    ...(color === 3 ? [pngChunk("PLTE", Uint8Array.from([1, 2, 3, 4, 5, 6]))] : []),
    ...(color === 3 ? [pngChunk("tRNS", Uint8Array.from([255, 128]))] : []),
    pngChunk("IDAT", Uint8Array.from([0x78, 0x9c, 1, 2, 3, 4, 5, 6, 7, 8])),
    ...(o.late ?? []),
    pngChunk("IEND"),
    o.trailing ?? new Uint8Array(0),
  );
}

export const METADATA_CHUNKS: Record<string, Uint8Array> = {
  tEXt: pngChunk("tEXt", enc("Author\0SECRET_AUTHOR")),
  zTXt: pngChunk("zTXt", enc("Comment\0\0SECRET_ZTXT")),
  iTXt: pngChunk("iTXt", enc("XML:com.adobe.xmp\0\0\0\0\0SECRET_XMP")),
  iCCP: pngChunk("iCCP", enc("SECRET_ICC\0\0profile-bytes")),
  eXIf: pngChunk("eXIf", enc("SECRET_EXIF")),
  gAMA: pngChunk("gAMA", Uint8Array.from([0, 0, 0xb1, 0x8f])),
  pHYs: pngChunk("pHYs", Uint8Array.from([0, 0, 0x0e, 0xc4, 0, 0, 0x0e, 0xc4, 1])),
  tIME: pngChunk("tIME", Uint8Array.from([7, 0xe8, 1, 2, 3, 4, 5])),
};

// ---- JPEG ----------------------------------------------------------------------------------

export const seg = (marker: number, payload: Uint8Array): Uint8Array =>
  cat(
    Uint8Array.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  );

/** Minimal EXIF APP1 payload with an Orientation tag; `endian` picks II or MM. */
export function exifPayload(orientation: number, endian: "II" | "MM" = "II"): Uint8Array {
  const le = endian === "II";
  const b = new Uint8Array(6 + 8 + 2 + 12 + 4);
  const v = new DataView(b.buffer);
  b.set(enc("Exif\0\0"), 0);
  b.set(enc(endian), 6);
  v.setUint16(8, 42, le);
  v.setUint32(10, 8, le);
  v.setUint16(14, 1, le);
  v.setUint16(16, 0x0112, le);
  v.setUint16(18, 3, le);
  v.setUint32(20, 1, le);
  v.setUint16(24, orientation, le);
  return b;
}

export interface JpegOpts {
  readonly w?: number;
  readonly h?: number;
  readonly comps?: number;
  readonly progressive?: boolean;
  /** Segments after SOI/APP0, before DQT. */
  readonly meta?: readonly Uint8Array[];
  readonly trailing?: Uint8Array;
  readonly omitEoi?: boolean;
}

export function makeJpeg(o: JpegOpts = {}): Uint8Array {
  const comps = o.comps ?? 3;
  const w = o.w ?? 16;
  const h = o.h ?? 8;
  const sof = [8, h >> 8, h & 0xff, w >> 8, w & 0xff, comps];
  for (let i = 0; i < comps; i++) sof.push(i + 1, 0x11, 0);
  return cat(
    Uint8Array.from([0xff, 0xd8]),
    seg(0xe0, enc("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...(o.meta ?? []),
    seg(0xdb, Uint8Array.from([0, ...new Array(64).fill(8)])),
    seg(o.progressive ? 0xc2 : 0xc0, Uint8Array.from(sof)),
    seg(0xc4, Uint8Array.from([0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5])),
    seg(
      0xda,
      Uint8Array.from([
        comps,
        ...Array.from({ length: comps }, (_, i) => [i + 1, 0]).flat(),
        0,
        63,
        0,
      ]),
    ),
    // entropy data with byte stuffing (FF00) and a restart marker (FFD0)
    Uint8Array.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78]),
    o.omitEoi ? new Uint8Array(0) : Uint8Array.from([0xff, 0xd9]),
    o.trailing ?? new Uint8Array(0),
  );
}

export const JPEG_METADATA = {
  exif: (o = 1) => seg(0xe1, exifPayload(o)),
  xmp: seg(0xe1, enc("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>SECRET_XMP</x:xmpmeta>")),
  icc: seg(0xe2, enc("ICC_PROFILE\0\x01\x01SECRET_ICC")),
  iptc: seg(0xed, enc("Photoshop 3.0\0SECRET_IPTC")),
  com: seg(0xfe, enc("SECRET_COMMENT")),
  adobe: seg(0xee, enc("Adobe\0\x64\0\0\0\0\x01")),
  app15: seg(0xef, enc("SECRET_APP15")),
};

// ---- misc ----------------------------------------------------------------------------------

export const SVG_OK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#336699"/></svg>`;

export const b64 = (b: Uint8Array): string => btoa(toStr(b));

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
