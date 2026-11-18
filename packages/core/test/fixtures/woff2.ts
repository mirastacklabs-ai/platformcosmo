import { brotliDecompressSync } from "node:zlib";
import { buildSfnt, parseFont, type ParsedFont } from "../../src/text/sfnt.js";

const KNOWN = [
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

/** Test-side WOFF2 reader for null-transform fonts: container -> sfnt -> parsed font. */
export function decodeWoff2(base64: string): ParsedFont {
  const b = Buffer.from(base64, "base64");
  if (b.readUInt32BE(0) !== 0x774f4632) throw new Error("not WOFF2");
  const n = b.readUInt16BE(12);
  const compressed = b.readUInt32BE(20);
  let p = 48;
  const dir: { tag: string; len: number }[] = [];
  for (let i = 0; i < n; i++) {
    const flags = b[p++] as number;
    const idx = flags & 0x3f;
    let tag: string;
    if (idx === 63) {
      tag = b.subarray(p, p + 4).toString("latin1");
      p += 4;
    } else tag = KNOWN[idx] as string;
    if (flags >> 6 !== (tag === "glyf" || tag === "loca" ? 3 : 0)) {
      throw new Error("transformed table");
    }
    let len = 0;
    for (;;) {
      const byte = b[p++] as number;
      len = len * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    dir.push({ tag, len });
  }
  const raw = brotliDecompressSync(b.subarray(p, p + compressed));
  const tables = new Map<string, Uint8Array>();
  let o = 0;
  for (const { tag, len } of dir) {
    tables.set(tag, new Uint8Array(raw.subarray(o, o + len)));
    o += len;
  }
  return parseFont(buildSfnt(tables));
}
