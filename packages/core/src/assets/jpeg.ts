/**
 * JPEG validation and metadata stripping (§11.2). No decoding: markers are walked, SOF0/1/2
 * dimensions read, EXIF orientation parsed from APP1 before it is dropped. Everything except
 * APP1..APP15 (APP14 Adobe kept) and COM is copied byte for byte.
 */
import type { RasterFail, RasterOk } from "./prepare.js";

export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

const fail = (message: string): RasterFail => ({ ok: false, code: "format", message });

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/**
 * Orientation from an APP1 payload that starts with `Exif\0\0`: `undefined` when the block is
 * malformed, `1` when it is well formed but carries no orientation tag.
 */
export function parseExifOrientation(p: Uint8Array): number | undefined {
  const t = 6; // TIFF header offset after "Exif\0\0"
  if (p.length < t + 8) return undefined;
  const le = p[t] === 0x49 && p[t + 1] === 0x49;
  if (!le && !(p[t] === 0x4d && p[t + 1] === 0x4d)) return undefined;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  if (v.getUint16(t + 2, le) !== 42) return undefined;
  const ifd = t + v.getUint32(t + 4, le);
  if (ifd < t + 8 || ifd + 2 > p.length) return undefined;
  const count = v.getUint16(ifd, le);
  if (ifd + 2 + count * 12 > p.length) return undefined;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (v.getUint16(e, le) !== 0x0112) continue;
    if (v.getUint16(e + 2, le) !== 3 || v.getUint32(e + 4, le) !== 1) return undefined;
    const o = v.getUint16(e + 8, le);
    return o >= 1 && o <= 8 ? o : undefined;
  }
  return 1;
}

export function cleanJpeg(bytes: Uint8Array): RasterOk | RasterFail {
  const out: Uint8Array[] = [bytes.subarray(0, 2)];
  let off = 2;
  let width = 0;
  let height = 0;
  let comps = 0;
  let sawSof = false;
  let sawScan = false;
  let orientation = 1;
  let exifSeen = false;
  let exifIgnored = false;
  let icc = false;
  let dropped = false;
  let eoi = false;
  while (off < bytes.length) {
    if (bytes[off] !== 0xff) return fail("JPEG has a stray byte between segments");
    let m = off + 1;
    while (bytes[m] === 0xff) m++; // fill bytes
    if (m >= bytes.length) break;
    const marker = bytes[m] as number;
    const segStart = off;
    off = m + 1;
    if (marker === 0xd9) {
      out.push(bytes.subarray(segStart, off));
      eoi = true;
      break;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      return fail("JPEG has an unexpected marker");
    }
    if (off + 2 > bytes.length) return fail("truncated JPEG (incomplete segment header)");
    const len = ((bytes[off] as number) << 8) | (bytes[off + 1] as number);
    if (len < 2) return fail("JPEG has an invalid segment length");
    const end = off + len;
    if (end > bytes.length) return fail("truncated JPEG (segment runs past the end)");
    const payload = bytes.subarray(off + 2, end);
    let keep = true;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (sawSof) return fail("JPEG has more than one frame header");
      if (payload.length < 6) return fail("JPEG frame header is too short");
      height = ((payload[1] as number) << 8) | (payload[2] as number);
      width = ((payload[3] as number) << 8) | (payload[4] as number);
      comps = payload[5] as number;
      if (width === 0 || height === 0) return fail("JPEG has invalid dimensions");
      if (comps < 1 || comps > 4 || payload.length < 6 + comps * 3) {
        return fail("JPEG frame header is malformed");
      }
      sawSof = true;
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
      return fail("unsupported JPEG variant (only baseline and progressive Huffman are accepted)");
    } else if (marker === 0xfe) {
      keep = false;
    } else if (marker >= 0xe1 && marker <= 0xef) {
      if (marker === 0xee && ascii(payload, 0, "Adobe")) {
        keep = true; // APP14 Adobe carries the colour transform needed to decode CMYK/YCCK
      } else {
        keep = false;
        if (marker === 0xe1 && ascii(payload, 0, "Exif\0\0") && !exifSeen) {
          exifSeen = true;
          const o = parseExifOrientation(payload);
          if (o === undefined) exifIgnored = true;
          else orientation = o;
        }
        if (marker === 0xe2 && ascii(payload, 0, "ICC_PROFILE\0")) icc = true;
      }
    } else if (marker === 0xda) {
      if (!sawSof) return fail("JPEG scan before the frame header");
      sawScan = true;
    }
    if (keep) out.push(bytes.subarray(segStart, end));
    else dropped = true;
    off = end;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not stuffing (FF00), RSTn or fill.
      const scanStart = off;
      for (;;) {
        if (off >= bytes.length) return fail("truncated JPEG (scan has no end)");
        if (bytes[off] === 0xff) {
          const n = bytes[off + 1];
          if (n === undefined) return fail("truncated JPEG (scan has no end)");
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
            off += 2;
            continue;
          }
          if (n === 0xff) {
            off += 1;
            continue;
          }
          break;
        }
        off++;
      }
      out.push(bytes.subarray(scanStart, off));
    }
  }
  if (!sawSof) return fail("JPEG has no frame header");
  if (!sawScan) return fail("JPEG has no image data");
  if (!eoi) return fail("truncated JPEG (no end-of-image marker)");
  if (off !== bytes.length) return fail("JPEG has trailing data after the end-of-image marker");
  let total = 0;
  for (const p of out) total += p.length;
  const data = new Uint8Array(total);
  let at = 0;
  for (const p of out) {
    data.set(p, at);
    at += p.length;
  }
  return {
    ok: true,
    data,
    width,
    height,
    orientation,
    icc,
    cmyk: comps === 4,
    exifIgnored,
    stripped: dropped,
  };
}
