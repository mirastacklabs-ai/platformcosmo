/* global Buffer */
/**
 * Dependency-free PNG helpers for the visual regression run: a decoder for the 8-bit RGBA PNGs
 * resvg writes (non-interlaced), an encoder for diff images, and a pixelmatch-style comparison.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @returns {{ width: number, height: number, data: Uint8Array }} RGBA, row-major. */
export function decodePng(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) {
    throw new Error("unsupported PNG: only 8-bit RGBA, non-interlaced");
  }
  const idat = [];
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("latin1", o + 4, o + 8);
    if (type === "IDAT") idat.push(buf.subarray(o + 8, o + 8 + len));
    if (type === "IEND") break;
    o += 12 + len;
  }
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= 4 ? out[dst + x - 4] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[dst - stride + x - 4] : 0;
      let p;
      if (filter === 0) p = v;
      else if (filter === 1) p = v + a;
      else if (filter === 2) p = v + b;
      else if (filter === 3) p = v + ((a + b) >> 1);
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad PNG filter ${filter}`);
      out[dst + x] = p & 0xff;
    }
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** Encodes RGBA pixels as a PNG (filter 0, deterministic). */
export function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Pixel color over white (so transparent areas compare as the page background would show them). */
function blend(data, i) {
  const a = data[i + 3] / 255;
  return [0, 1, 2].map((k) => 255 + (data[i + k] - 255) * a);
}

/** Perceptual delta in YIQ space (the pixelmatch measure); 35215 is its maximum. */
function yiqDelta(r1, g1, b1, r2, g2, b2) {
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const i = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
}

/**
 * Compares two decoded images. A pixel differs when its YIQ delta exceeds `threshold` (0..1,
 * pixelmatch semantics). Returns the differing count and a diff image (actual faded, differences
 * in red), or `sameSize: false`.
 */
export function compare(expected, actual, threshold = 0.1) {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return { sameSize: false, differing: Infinity, fraction: 1, diff: undefined };
  }
  const max = 35215 * threshold * threshold;
  const diff = new Uint8Array(actual.data.length);
  let differing = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    const [r1, g1, b1] = blend(expected.data, i);
    const [r2, g2, b2] = blend(actual.data, i);
    const bad = yiqDelta(r1, g1, b1, r2, g2, b2) > max;
    if (bad) {
      differing++;
      diff.set([255, 0, 0, 255], i);
    } else {
      const gray = 255 - 0.1 * (255 - (0.299 * r2 + 0.587 * g2 + 0.114 * b2));
      diff.set([gray, gray, gray, 255], i);
    }
  }
  return {
    sameSize: true,
    differing,
    fraction: differing / (actual.width * actual.height),
    diff: { width: actual.width, height: actual.height, data: diff },
  };
}
