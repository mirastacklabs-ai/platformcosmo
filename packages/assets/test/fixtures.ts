/** Fixtures generated in the tests (no committed binaries). */
import type { Raster } from "../src/raster.js";

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

export type Px = readonly [number, number, number, number];

export function makeRaster(w: number, h: number, f: (x: number, y: number) => Px): Raster {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}

export const px = (r: Raster, x: number, y: number): Px => {
  const i = (y * r.width + x) * 4;
  return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!, r.data[i + 3]!];
};

/** Opaque grey texture: random cells of `cell` px (structure survives a 1/4 downsample). */
export function noise(w: number, h: number, seed: number, cell = 6): Raster {
  const r = rng(seed);
  const cw = Math.ceil(w / cell);
  const vals = Array.from({ length: cw * Math.ceil(h / cell) }, () => Math.floor(r() * 256));
  return makeRaster(w, h, (x, y) => {
    const v = vals[Math.floor(y / cell) * cw + Math.floor(x / cell)]!;
    return [v, v, v, 255];
  });
}

/** Copies `src` into `dst` at (x, y), honouring src alpha as all-or-nothing. Returns a new raster. */
export function paste(dst: Raster, src: Raster, x: number, y: number): Raster {
  const data = new Uint8Array(dst.data);
  for (let sy = 0; sy < src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) {
      const s = (sy * src.width + sx) * 4;
      if (src.data[s + 3] === 0) continue;
      const d = ((y + sy) * dst.width + x + sx) * 4;
      data.set(src.data.subarray(s, s + 4), d);
    }
  }
  return { width: dst.width, height: dst.height, data };
}

/** Translates content by (dx, dy), filling with white. */
export function shifted(r: Raster, dx: number, dy: number): Raster {
  return makeRaster(r.width, r.height, (x, y) => {
    const sx = x - dx;
    const sy = y - dy;
    return sx >= 0 && sy >= 0 && sx < r.width && sy < r.height
      ? px(r, sx, sy)
      : [255, 255, 255, 255];
  });
}

const u16 = (v: number): number[] => [(v >> 8) & 255, v & 255];

/**
 * A real baseline grayscale JPEG whose 8x8 blocks are flat (DC only), with custom Huffman tables
 * (DC category = 4-bit code, AC end-of-block = "0"). `level(bx, by)` is the block grey (0..255).
 * Optional EXIF orientation in an APP1 segment.
 */
export function makeJpeg(
  w: number,
  h: number,
  level: (bx: number, by: number) => number,
  orientation?: number,
): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  if (orientation) {
    // II, 42, IFD at 8; one entry: tag 0x0112 SHORT count 1 value=orientation.
    const exif = [
      ...Buffer.from("Exif\0\0"),
      0x49,
      0x49,
      0x2a,
      0x00,
      8,
      0,
      0,
      0,
      1,
      0,
      0x12,
      0x01,
      3,
      0,
      1,
      0,
      0,
      0,
      orientation,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ];
    out.push(0xff, 0xe1, ...u16(exif.length + 2), ...exif);
  }
  out.push(0xff, 0xdb, ...u16(67), 0, ...new Array<number>(64).fill(1));
  out.push(0xff, 0xc0, ...u16(11), 8, ...u16(h), ...u16(w), 1, 1, 0x11, 0);
  // DC table: 12 symbols (categories 0..11) with 4-bit codes 0..11.
  const dcCounts = new Array<number>(16).fill(0);
  dcCounts[3] = 12;
  out.push(
    0xff,
    0xc4,
    ...u16(2 + 1 + 16 + 12),
    0x00,
    ...dcCounts,
    ...Array.from({ length: 12 }, (_, i) => i),
  );
  const acCounts = new Array<number>(16).fill(0);
  acCounts[0] = 1;
  out.push(0xff, 0xc4, ...u16(2 + 1 + 16 + 1), 0x10, ...acCounts, 0x00);
  out.push(0xff, 0xda, ...u16(8), 1, 1, 0x00, 0, 63, 0);
  let acc = 0;
  let nbits = 0;
  const put = (value: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++nbits === 8) {
        out.push(acc);
        if (acc === 0xff) out.push(0);
        acc = 0;
        nbits = 0;
      }
    }
  };
  let prev = 0;
  for (let by = 0; by < h / 8; by++) {
    for (let bx = 0; bx < w / 8; bx++) {
      const dc = (level(bx, by) - 128) * 8;
      const diff = dc - prev;
      prev = dc;
      const mag = Math.abs(diff);
      const cat = mag === 0 ? 0 : Math.floor(Math.log2(mag)) + 1;
      put(cat, 4);
      if (cat > 0) put(diff < 0 ? diff + (1 << cat) - 1 : diff, cat);
      put(0, 1); // EOB
    }
  }
  while (nbits !== 0) put(1, 1);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}
