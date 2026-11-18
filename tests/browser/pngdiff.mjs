/* global Buffer */
/**
 * Node-side PNG comparison for the Safari check (dependency-free): decodes 8-bit gray, RGB, gray+alpha
 * and RGBA non-interlaced PNGs and returns the share of pixels whose channels differ clearly.
 */
import { inflateSync } from "node:zlib";

function decode(b64) {
  const buf = Buffer.from(b64, "base64");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const type = buf[25];
  const interlace = buf[28];
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${depth}, color type ${type}, interlace ${interlace})`);
  }
  const idat = [];
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    const t = buf.toString("latin1", o + 4, o + 8);
    if (t === "IDAT") idat.push(buf.subarray(o + 8, o + 8 + len));
    if (t === "IEND") break;
    o += 12 + len;
  }
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels] : 0;
      let p;
      if (f === 0) p = v;
      else if (f === 1) p = v + a;
      else if (f === 2) p = v + b;
      else if (f === 3) p = v + ((a + b) >> 1);
      else {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + x] = p & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** Share of pixels with a channel difference > 64; a string describes why it cannot be computed. */
export function diffFraction(aB64, bB64) {
  try {
    const A = decode(aB64);
    const B = decode(bB64);
    if (A.width !== B.width || A.height !== B.height) {
      return `size ${A.width}x${A.height} vs ${B.width}x${B.height}`;
    }
    let n = 0;
    for (let i = 0; i < A.width * A.height; i++) {
      let max = 0;
      for (let k = 0; k < Math.min(A.channels, 3); k++) {
        max = Math.max(max, Math.abs(A.data[i * A.channels + k] - B.data[i * B.channels + k]));
      }
      if (max > 64) n++;
    }
    return n / (A.width * A.height);
  } catch (e) {
    return `error ${e.message}`;
  }
}
