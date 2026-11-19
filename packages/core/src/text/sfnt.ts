/**
 * Minimal pure-JS TrueType (glyf) reader, glyph subsetter and WOFF2 writer.
 *
 * Scope: exactly what the engine needs from its vendored Oswald and JetBrains Mono subsets: character mapping
 * (cmap formats 4 and 12), advances, glyph outlines (simple and composite), per-diagram
 * subsetting, and a WOFF2 container with null table transforms compressed with Brotli
 * (`node:zlib`, Node-only like the rest of the CLI). No kerning or shaping.
 * Everything is deterministic: no timestamps, tables written in tag order.
 */
import { brotliCompressSync, constants } from "node:zlib";

export interface Point {
  readonly x: number;
  readonly y: number;
  readonly on: boolean;
}

export interface ParsedFont {
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  readonly numGlyphs: number;
  readonly cmap: ReadonlyMap<number, number>;
  readonly tables: ReadonlyMap<string, Uint8Array>;
  advance(gid: number): number;
  /** Contours of a glyph in font units (y up), composites resolved. */
  contours(gid: number): Point[][];
}

function u16(d: DataView, o: number): number {
  return d.getUint16(o);
}

function readTables(bytes: Uint8Array): Map<string, Uint8Array> {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = u16(d, 4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const r = 12 + 16 * i;
    const tag = String.fromCharCode(
      d.getUint8(r),
      d.getUint8(r + 1),
      d.getUint8(r + 2),
      d.getUint8(r + 3),
    );
    const off = d.getUint32(r + 8);
    const len = d.getUint32(r + 12);
    if (off + len > bytes.length) throw new Error(`font table ${tag} out of range`);
    tables.set(tag, bytes.subarray(off, off + len));
  }
  return tables;
}

function viewOf(t: Uint8Array): DataView {
  return new DataView(t.buffer, t.byteOffset, t.byteLength);
}

function need(tables: Map<string, Uint8Array>, tag: string): Uint8Array {
  const t = tables.get(tag);
  if (!t) throw new Error(`font is missing table ${tag}`);
  return t;
}

function parseCmap(t: Uint8Array): Map<number, number> {
  const d = viewOf(t);
  const n = u16(d, 2);
  let best: { off: number; score: number } | undefined;
  for (let i = 0; i < n; i++) {
    const plat = u16(d, 4 + 8 * i);
    const enc = u16(d, 6 + 8 * i);
    const off = d.getUint32(8 + 8 * i);
    const fmt = u16(d, off);
    if (fmt !== 4 && fmt !== 12) continue;
    const score = plat === 3 && enc === 10 ? 3 : plat === 3 && enc === 1 ? 2 : plat === 0 ? 1 : 0;
    if (!best || score > best.score) best = { off, score };
  }
  if (!best) throw new Error("font has no usable cmap subtable");
  const map = new Map<number, number>();
  const o = best.off;
  if (u16(d, o) === 12) {
    const groups = d.getUint32(o + 12);
    for (let g = 0; g < groups; g++) {
      const p = o + 16 + 12 * g;
      const start = d.getUint32(p);
      const end = d.getUint32(p + 4);
      const gid = d.getUint32(p + 8);
      for (let c = start; c <= end; c++) map.set(c, gid + (c - start));
    }
  } else {
    const segX2 = u16(d, o + 6);
    const seg = segX2 / 2;
    const endBase = o + 14;
    const startBase = endBase + segX2 + 2;
    const deltaBase = startBase + segX2;
    const rangeBase = deltaBase + segX2;
    for (let s = 0; s < seg; s++) {
      const end = u16(d, endBase + 2 * s);
      const start = u16(d, startBase + 2 * s);
      const delta = d.getInt16(deltaBase + 2 * s);
      const ro = u16(d, rangeBase + 2 * s);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let gid: number;
        if (ro === 0) gid = (c + delta) & 0xffff;
        else {
          const gp = rangeBase + 2 * s + ro + 2 * (c - start);
          const raw = u16(d, gp);
          gid = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }
        if (gid !== 0) map.set(c, gid);
      }
    }
  }
  return map;
}

const ARG_WORDS = 0x1;
const ARGS_ARE_XY = 0x2;
const HAVE_SCALE = 0x8;
const MORE = 0x20;
const HAVE_XY_SCALE = 0x40;
const HAVE_2X2 = 0x80;

export function parseFont(bytes: Uint8Array): ParsedFont {
  const tables = readTables(bytes);
  const head = viewOf(need(tables, "head"));
  const hhea = viewOf(need(tables, "hhea"));
  const maxp = viewOf(need(tables, "maxp"));
  const hmtx = viewOf(need(tables, "hmtx"));
  const loca = viewOf(need(tables, "loca"));
  const glyf = need(tables, "glyf");
  const glyfView = viewOf(glyf);
  const unitsPerEm = u16(head, 18);
  const longLoca = head.getInt16(50) === 1;
  const numGlyphs = u16(maxp, 4);
  const numH = u16(hhea, 34);
  const cmap = parseCmap(need(tables, "cmap"));

  const locaAt = (g: number): number => (longLoca ? loca.getUint32(4 * g) : 2 * u16(loca, 2 * g));

  const advance = (gid: number): number => {
    const i = Math.min(gid, numH - 1);
    return u16(hmtx, 4 * i);
  };

  const contours = (gid: number, depth = 0): Point[][] => {
    if (gid < 0 || gid >= numGlyphs || depth > 8) return [];
    const start = locaAt(gid);
    const end = locaAt(gid + 1);
    if (end <= start) return [];
    const nc = glyfView.getInt16(start);
    if (nc >= 0) return simpleGlyph(glyfView, start, nc);
    // composite
    const out: Point[][] = [];
    let p = start + 10;
    for (;;) {
      const flags = glyfView.getUint16(p);
      const child = glyfView.getUint16(p + 2);
      p += 4;
      let dx = 0;
      let dy = 0;
      if (flags & ARG_WORDS) {
        if (flags & ARGS_ARE_XY) {
          dx = glyfView.getInt16(p);
          dy = glyfView.getInt16(p + 2);
        }
        p += 4;
      } else {
        if (flags & ARGS_ARE_XY) {
          dx = glyfView.getInt8(p);
          dy = glyfView.getInt8(p + 1);
        }
        p += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      const f2 = (o: number) => glyfView.getInt16(o) / 16384;
      if (flags & HAVE_SCALE) {
        a = d = f2(p);
        p += 2;
      } else if (flags & HAVE_XY_SCALE) {
        a = f2(p);
        d = f2(p + 2);
        p += 4;
      } else if (flags & HAVE_2X2) {
        a = f2(p);
        b = f2(p + 2);
        c = f2(p + 4);
        d = f2(p + 6);
        p += 8;
      }
      for (const contour of contours(child, depth + 1)) {
        out.push(
          contour.map((pt) => ({
            x: a * pt.x + c * pt.y + dx,
            y: b * pt.x + d * pt.y + dy,
            on: pt.on,
          })),
        );
      }
      if (!(flags & MORE)) break;
    }
    return out;
  };

  return {
    unitsPerEm,
    ascent: hhea.getInt16(4),
    descent: hhea.getInt16(6),
    lineGap: hhea.getInt16(8),
    numGlyphs,
    cmap,
    tables,
    advance,
    contours: (g) => contours(g),
  };
}

function simpleGlyph(d: DataView, start: number, nc: number): Point[][] {
  if (nc === 0) return [];
  let p = start + 10;
  const ends: number[] = [];
  for (let i = 0; i < nc; i++) {
    ends.push(u16(d, p));
    p += 2;
  }
  const nPts = (ends[nc - 1] as number) + 1;
  const insLen = u16(d, p);
  p += 2 + insLen;
  const flags: number[] = [];
  while (flags.length < nPts) {
    const f = d.getUint8(p++);
    flags.push(f);
    if (f & 8) {
      let r = d.getUint8(p++);
      while (r-- > 0) flags.push(f);
    }
  }
  const xs: number[] = [];
  let v = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i] as number;
    if (f & 2) {
      const dv = d.getUint8(p++);
      v += f & 16 ? dv : -dv;
    } else if (!(f & 16)) {
      v += d.getInt16(p);
      p += 2;
    }
    xs.push(v);
  }
  const ys: number[] = [];
  v = 0;
  for (let i = 0; i < nPts; i++) {
    const f = flags[i] as number;
    if (f & 4) {
      const dv = d.getUint8(p++);
      v += f & 32 ? dv : -dv;
    } else if (!(f & 32)) {
      v += d.getInt16(p);
      p += 2;
    }
    ys.push(v);
  }
  const out: Point[][] = [];
  let s = 0;
  for (const e of ends) {
    const c: Point[] = [];
    for (let i = s; i <= e; i++) {
      c.push({ x: xs[i] as number, y: ys[i] as number, on: ((flags[i] as number) & 1) === 1 });
    }
    out.push(c);
    s = e + 1;
  }
  return out;
}

/** Glyph ids to keep: `0`, the mapped glyphs, and every composite component, ascending. */
function glyphClosure(font: ParsedFont, gids: Iterable<number>): number[] {
  const glyf = need(font.tables as Map<string, Uint8Array>, "glyf");
  const d = viewOf(glyf);
  const loca = viewOf(need(font.tables as Map<string, Uint8Array>, "loca"));
  const longLoca = viewOf(need(font.tables as Map<string, Uint8Array>, "head")).getInt16(50) === 1;
  const at = (g: number) => (longLoca ? loca.getUint32(4 * g) : 2 * u16(loca, 2 * g));
  const keep = new Set<number>([0]);
  const stack = [...gids];
  while (stack.length) {
    const g = stack.pop() as number;
    if (keep.has(g) || g >= font.numGlyphs) continue;
    keep.add(g);
    const s = at(g);
    if (at(g + 1) > s && d.getInt16(s) < 0) {
      let p = s + 10;
      for (;;) {
        const flags = d.getUint16(p);
        stack.push(d.getUint16(p + 2));
        p += 4 + (flags & ARG_WORDS ? 4 : 2);
        p += flags & HAVE_SCALE ? 2 : flags & HAVE_XY_SCALE ? 4 : flags & HAVE_2X2 ? 8 : 0;
        if (!(flags & MORE)) break;
      }
    }
  }
  return [...keep].sort((a, b) => a - b);
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function checksum(b: Uint8Array): number {
  let sum = 0;
  const n = pad4(b.length);
  for (let i = 0; i < n; i += 4) {
    const w =
      ((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
    sum = (sum + (w >>> 0)) >>> 0;
  }
  return sum;
}

function tagBytes(tag: string): number[] {
  return [0, 1, 2, 3].map((i) => tag.charCodeAt(i));
}

/** Assemble an sfnt (TrueType) file from tables, sorted by tag, with a valid checkSumAdjustment. */
export function buildSfnt(input: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const tags = [...input.keys()].sort();
  const n = tags.length;
  let total = 12 + 16 * n;
  for (const t of tags) total += pad4((input.get(t) as Uint8Array).length);
  const out = new Uint8Array(total);
  const d = new DataView(out.buffer);
  d.setUint32(0, 0x00010000);
  d.setUint16(4, n);
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  const sr = (1 << es) * 16;
  d.setUint16(6, sr);
  d.setUint16(8, es);
  d.setUint16(10, n * 16 - sr);
  let off = 12 + 16 * n;
  tags.forEach((tag, i) => {
    const data = input.get(tag) as Uint8Array;
    const r = 12 + 16 * i;
    out.set(tagBytes(tag), r);
    d.setUint32(r + 4, checksum(data));
    d.setUint32(r + 8, off);
    d.setUint32(r + 12, data.length);
    out.set(data, off);
    off += pad4(data.length);
  });
  // checkSumAdjustment lives at head + 8.
  const headIdx = tags.indexOf("head");
  if (headIdx >= 0) {
    const headOff = d.getUint32(12 + 16 * headIdx + 8);
    d.setUint32(headOff + 8, 0);
    d.setUint32(
      12 + 16 * headIdx + 4,
      checksum(out.subarray(headOff, headOff + (input.get("head") as Uint8Array).length)),
    );
    d.setUint32(headOff + 8, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return out;
}

/**
 * Subset to the given code points (those the font maps). Returns a complete TrueType font with
 * `cmap` (format 4), `glyf`/`loca`, `hmtx`, `head`, `hhea`, `maxp`, `name`, `OS/2` and a
 * format 3 `post`. Glyph order follows the original, so output is deterministic.
 */
export function subsetFont(font: ParsedFont, codePoints: Iterable<number>): Uint8Array {
  const tables = font.tables as Map<string, Uint8Array>;
  const mapped = new Map<number, number>();
  for (const cp of codePoints) {
    const g = font.cmap.get(cp);
    if (g !== undefined && g !== 0 && cp <= 0xfffe) mapped.set(cp, g);
  }
  const keep = glyphClosure(font, mapped.values());
  const newId = new Map<number, number>(keep.map((g, i) => [g, i]));

  const glyf = need(tables, "glyf");
  const loca = viewOf(need(tables, "loca"));
  const longLoca = viewOf(need(tables, "head")).getInt16(50) === 1;
  const at = (g: number) => (longLoca ? loca.getUint32(4 * g) : 2 * u16(loca, 2 * g));

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let pos = 0;
  for (const g of keep) {
    const raw = glyf.subarray(at(g), at(g + 1));
    const copy = new Uint8Array(pad4(raw.length));
    copy.set(raw);
    if (raw.length >= 10) {
      const v = viewOf(copy);
      if (v.getInt16(0) < 0) {
        let p = 10;
        for (;;) {
          const flags = v.getUint16(p);
          v.setUint16(p + 2, newId.get(v.getUint16(p + 2)) as number);
          p += 4 + (flags & ARG_WORDS ? 4 : 2);
          p += flags & HAVE_SCALE ? 2 : flags & HAVE_XY_SCALE ? 4 : flags & HAVE_2X2 ? 8 : 0;
          if (!(flags & MORE)) break;
        }
      }
    }
    chunks.push(copy);
    pos += copy.length;
    offsets.push(pos);
  }
  const newGlyf = new Uint8Array(pos);
  let w = 0;
  for (const c of chunks) {
    newGlyf.set(c, w);
    w += c.length;
  }
  const newLoca = new Uint8Array(4 * offsets.length);
  const lv = viewOf(newLoca);
  offsets.forEach((o, i) => lv.setUint32(4 * i, o));

  const n = keep.length;
  const hmtx = new Uint8Array(4 * n);
  const hv = viewOf(hmtx);
  const srcH = viewOf(need(tables, "hmtx"));
  const numH = u16(viewOf(need(tables, "hhea")), 34);
  keep.forEach((g, i) => {
    const hi = Math.min(g, numH - 1);
    hv.setUint16(4 * i, u16(srcH, 4 * hi));
    hv.setInt16(
      4 * i + 2,
      g < numH ? srcH.getInt16(4 * g + 2) : srcH.getInt16(4 * numH + 2 * (g - numH)),
    );
  });

  const head = Uint8Array.from(need(tables, "head"));
  viewOf(head).setInt16(50, 1);
  const hhea = Uint8Array.from(need(tables, "hhea"));
  viewOf(hhea).setUint16(34, n);
  const maxp = Uint8Array.from(need(tables, "maxp"));
  viewOf(maxp).setUint16(4, n);

  // post format 3: copy the 32-byte header and set the version.
  const post = Uint8Array.from(need(tables, "post").subarray(0, 32));
  viewOf(post).setUint32(0, 0x00030000);

  const cps = [...mapped.keys()].sort((a, b) => a - b);
  const segs: { start: number; end: number; delta: number }[] = [];
  for (const cp of cps) {
    const gid = newId.get(mapped.get(cp) as number) as number;
    const last = segs[segs.length - 1];
    if (last && cp === last.end + 1 && ((gid - cp) & 0xffff) === last.delta) {
      last.end = cp;
    } else {
      segs.push({ start: cp, end: cp, delta: (gid - cp) & 0xffff });
    }
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const sc = segs.length;
  const sub = 16 + 8 * sc;
  const cmap = new Uint8Array(12 + sub);
  const cv = viewOf(cmap);
  cv.setUint16(2, 1);
  cv.setUint16(4, 3);
  cv.setUint16(6, 1);
  cv.setUint32(8, 12);
  const b = 12;
  cv.setUint16(b, 4);
  cv.setUint16(b + 2, sub);
  cv.setUint16(b + 6, sc * 2);
  let es = 0;
  while (1 << (es + 1) <= sc) es++;
  cv.setUint16(b + 8, (1 << es) * 2);
  cv.setUint16(b + 10, es);
  cv.setUint16(b + 12, sc * 2 - (1 << es) * 2);
  segs.forEach((s, i) => {
    cv.setUint16(b + 14 + 2 * i, s.end);
    cv.setUint16(b + 16 + 2 * sc + 2 * i, s.start);
    cv.setUint16(b + 16 + 4 * sc + 2 * i, s.delta);
  });

  const out = new Map<string, Uint8Array>([
    ["cmap", cmap],
    ["glyf", newGlyf],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", newLoca],
    ["maxp", maxp],
    ["post", post],
  ]);
  for (const tag of ["OS/2", "name"]) {
    const t = tables.get(tag);
    if (t) out.set(tag, t);
  }
  return buildSfnt(out);
}

const WOFF2_KNOWN = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
];

function base128(n: number): number[] {
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return out;
}

/** Wrap an sfnt as WOFF2 (null transforms, Brotli quality 11, font mode). */
export function sfntToWoff2(sfnt: Uint8Array): Uint8Array {
  const tables = readTables(sfnt);
  const tags = [...tables.keys()].sort();
  const dir: number[] = [];
  const parts: Uint8Array[] = [];
  let sfntSize = 12 + 16 * tags.length;
  for (const tag of tags) {
    const data = tables.get(tag) as Uint8Array;
    sfntSize += pad4(data.length);
    const idx = WOFF2_KNOWN.indexOf(tag);
    const nullTransform = tag === "glyf" || tag === "loca" ? 3 : 0;
    if (idx >= 0) dir.push(idx | (nullTransform << 6));
    else dir.push(63, ...tagBytes(tag));
    dir.push(...base128(data.length));
    parts.push(data);
  }
  const joined = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    joined.set(p, o);
    o += p.length;
  }
  const compressed = brotliCompressSync(joined, {
    params: {
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT,
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: joined.length,
    },
  });
  const headerLen = 48;
  const total = pad4(headerLen + dir.length + compressed.length);
  const out = new Uint8Array(total);
  const d = new DataView(out.buffer);
  d.setUint32(0, 0x774f4632);
  d.setUint32(4, 0x00010000);
  d.setUint32(8, total);
  d.setUint16(12, tags.length);
  d.setUint32(16, sfntSize);
  d.setUint32(20, compressed.length);
  d.setUint16(24, 1);
  out.set(dir, headerLen);
  out.set(compressed, headerLen + dir.length);
  return out;
}
