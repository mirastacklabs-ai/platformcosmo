/**
 * Fonts for `pdf text` only (ingestion §3, §4.2): simple fonts (standard encodings and
 * `/Differences`), Type0 fonts with Identity or embedded codespaces, and ToUnicode CMaps.
 * No font program is ever read; unknown glyphs decode to U+FFFD.
 */
import type { PdfFile } from "./file.js";
import { PdfError } from "./limits.js";
import {
  Lexer,
  PdfDict,
  PdfName,
  PdfStream,
  PdfString,
  T_ARR_CLOSE,
  T_ARR_OPEN,
  T_EOF,
  T_KW,
  T_NAME,
  T_STR,
  intOf,
  nameOf,
  numOf,
  type PdfValue,
} from "./objects.js";

const REPLACEMENT = "�";
/** Mapping entries one CMap may define (ranges expanded). */
const MAX_CMAP_ENTRIES = 262_144;

// ---- encodings -----------------------------------------------------------------------------

const ASCII_NAMES =
  "space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde".split(
    " ",
  );

const GLYPHS = new Map<string, number>();
ASCII_NAMES.forEach((n, i) => GLYPHS.set(n, 32 + i));
for (const [n, c] of Object.entries({
  quoteright: 0x2019,
  quoteleft: 0x2018,
  quotedblleft: 0x201c,
  quotedblright: 0x201d,
  quotesinglbase: 0x201a,
  quotedblbase: 0x201e,
  bullet: 0x2022,
  endash: 0x2013,
  emdash: 0x2014,
  ellipsis: 0x2026,
  trademark: 0x2122,
  copyright: 0xa9,
  registered: 0xae,
  degree: 0xb0,
  multiply: 0xd7,
  divide: 0xf7,
  minus: 0x2212,
  plusminus: 0xb1,
  mu: 0xb5,
  periodcentered: 0xb7,
  section: 0xa7,
  paragraph: 0xb6,
  dagger: 0x2020,
  daggerdbl: 0x2021,
  fi: 0xfb01,
  fl: 0xfb02,
  Euro: 0x20ac,
  sterling: 0xa3,
  yen: 0xa5,
  cent: 0xa2,
  nbspace: 0xa0,
  guillemotleft: 0xab,
  guillemotright: 0xbb,
  exclamdown: 0xa1,
  questiondown: 0xbf,
  germandbls: 0xdf,
  onehalf: 0xbd,
  onequarter: 0xbc,
  threequarters: 0xbe,
  arrowright: 0x2192,
  arrowleft: 0x2190,
})) {
  GLYPHS.set(n, c);
}

function glyphToUnicode(name: string): string | null {
  const c = GLYPHS.get(name);
  if (c !== undefined) return String.fromCharCode(c);
  const base = name.split(".")[0] ?? name; // "a.sc" → "a"
  if (base !== name) return glyphToUnicode(base);
  if (base.length === 7 && base.startsWith("uni")) {
    const v = parseHex(base.slice(3));
    return v >= 0 ? String.fromCharCode(v) : null;
  }
  if (base.length >= 5 && base.length <= 7 && base.startsWith("u")) {
    const v = parseHex(base.slice(1));
    return v >= 0 && v <= 0x10ffff ? String.fromCodePoint(v) : null;
  }
  return null;
}

function parseHex(s: string): number {
  let v = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    const d =
      c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (d < 0) return -1;
    v = v * 16 + d;
  }
  return v;
}

const CP1252_HIGH = [
  0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0,
  0x17d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a,
  0x153, 0, 0x17e, 0x178,
];

const MAC_HIGH = [
  0xc4, 0xc5, 0xc7, 0xc9, 0xd1, 0xd6, 0xdc, 0xe1, 0xe0, 0xe2, 0xe4, 0xe3, 0xe5, 0xe7, 0xe9, 0xe8,
  0xea, 0xeb, 0xed, 0xec, 0xee, 0xef, 0xf1, 0xf3, 0xf2, 0xf4, 0xf6, 0xf5, 0xfa, 0xf9, 0xfb, 0xfc,
  0x2020, 0xb0, 0xa2, 0xa3, 0xa7, 0x2022, 0xb6, 0xdf, 0xae, 0xa9, 0x2122, 0xb4, 0xa8, 0x2260, 0xc6,
  0xd8, 0x221e, 0xb1, 0x2264, 0x2265, 0xa5, 0xb5, 0x2202, 0x2211, 0x220f, 0x3c0, 0x222b, 0xaa, 0xba,
  0x3a9, 0xe6, 0xf8, 0xbf, 0xa1, 0xac, 0x221a, 0x192, 0x2248, 0x2206, 0xab, 0xbb, 0x2026, 0xa0,
  0xc0, 0xc3, 0xd5, 0x152, 0x153, 0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0xf7, 0x25ca,
  0xff, 0x178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02, 0x2021, 0xb7, 0x201a, 0x201e, 0x2030,
  0xc2, 0xca, 0xc1, 0xcb, 0xc8, 0xcd, 0xce, 0xcf, 0xcc, 0xd3, 0xd4, 0xf8ff, 0xd2, 0xda, 0xdb, 0xd9,
  0x131, 0x2c6, 0x2dc, 0xaf, 0x2d8, 0x2d9, 0x2da, 0xb8, 0x2dd, 0x2db, 0x2c7,
];

function baseEncoding(name: string | null): (string | null)[] {
  const t: (string | null)[] = new Array<string | null>(256).fill(null);
  for (let c = 32; c < 127; c++) t[c] = String.fromCharCode(c);
  if (name === "WinAnsiEncoding") {
    CP1252_HIGH.forEach((u, i) => (t[128 + i] = u ? String.fromCharCode(u) : null));
    for (let c = 160; c < 256; c++) t[c] = String.fromCharCode(c);
  } else if (name === "MacRomanEncoding") {
    MAC_HIGH.forEach((u, i) => (t[128 + i] = String.fromCharCode(u)));
  } else if (name === "PDFDocEncoding") {
    for (let c = 160; c < 256; c++) t[c] = String.fromCharCode(c);
  } else {
    // StandardEncoding (the default for simple fonts): curly quotes at 0x27 and 0x60
    t[0x27] = "’";
    t[0x60] = "‘";
  }
  return t;
}

// ---- CMaps ---------------------------------------------------------------------------------

interface CMap {
  /** [byteLength, low, high] code ranges. */
  readonly codespace: [number, number, number][];
  readonly map: Map<number, string>;
}

const codeOf = (b: Uint8Array): number => {
  let v = 0;
  for (let i = 0; i < Math.min(4, b.length); i++) v = v * 256 + (b[i] as number);
  return v;
};

/** Characters one ToUnicode mapping may produce (one code → at most 32 UTF-16 units). */
export const MAX_MAPPING_CHARS = 32;

function utf16be(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < b.length && i < MAX_MAPPING_CHARS * 2; i += 2) {
    s += String.fromCharCode(((b[i] as number) << 8) | (b[i + 1] as number));
  }
  if (b.length === 1) s = String.fromCharCode(b[0] as number);
  return s;
}

/** Parses codespace ranges and bfchar/bfrange mappings with a linear token loop. */
export function parseCMap(data: Uint8Array): CMap {
  const lx = new Lexer(data);
  const codespace: [number, number, number][] = [];
  const map = new Map<number, string>();
  const ops: (PdfString | PdfName | PdfString[])[] = [];
  let mode = "";
  let arr: PdfString[] | null = null;
  const room = (n: number): void => {
    if (map.size + n > MAX_CMAP_ENTRIES) {
      throw new PdfError(
        "pdf/too-complex",
        `a ToUnicode CMap maps more than ${MAX_CMAP_ENTRIES} codes`,
      );
    }
  };
  for (;;) {
    const t = lx.next();
    if (t === T_EOF) break;
    if (ops.length > 3 * 65536) {
      throw new PdfError("pdf/too-complex", "a CMap section has too many entries");
    }
    if (t === T_STR) {
      if (arr) {
        if (arr.length < 65536) arr.push(lx.str as PdfString);
      } else ops.push(lx.str as PdfString);
      continue;
    }
    if (t === T_NAME) {
      ops.push(new PdfName(lx.word));
      continue;
    }
    if (t === T_ARR_OPEN) {
      arr = [];
      continue;
    }
    if (t === T_ARR_CLOSE) {
      if (arr) ops.push(arr);
      arr = null;
      continue;
    }
    if (t !== T_KW) continue;
    const kw = lx.word;
    if (kw.startsWith("begin")) {
      mode = kw;
      ops.length = 0;
      continue;
    }
    if (!kw.startsWith("end")) {
      ops.length = 0;
      continue;
    }
    if (mode === "begincodespacerange" && kw === "endcodespacerange") {
      for (let i = 0; i + 1 < ops.length; i += 2) {
        const lo = ops[i];
        const hi = ops[i + 1];
        if (
          lo instanceof PdfString &&
          hi instanceof PdfString &&
          lo.bytes.length >= 1 &&
          lo.bytes.length <= 4
        ) {
          if (codespace.length < 256)
            codespace.push([lo.bytes.length, codeOf(lo.bytes), codeOf(hi.bytes)]);
        }
      }
    } else if (mode === "beginbfchar" && kw === "endbfchar") {
      for (let i = 0; i + 1 < ops.length; i += 2) {
        const src = ops[i];
        const dst = ops[i + 1];
        if (!(src instanceof PdfString)) continue;
        room(1);
        if (dst instanceof PdfString) map.set(codeOf(src.bytes), utf16be(dst.bytes));
        else if (dst instanceof PdfName) {
          const u = glyphToUnicode(dst.name);
          if (u) map.set(codeOf(src.bytes), u);
        }
      }
    } else if (mode === "beginbfrange" && kw === "endbfrange") {
      for (let i = 0; i + 2 < ops.length; i += 3) {
        const lo = ops[i];
        const hi = ops[i + 1];
        const dst = ops[i + 2];
        if (!(lo instanceof PdfString) || !(hi instanceof PdfString)) continue;
        const a = codeOf(lo.bytes);
        const b = codeOf(hi.bytes);
        if (b < a || b - a > 65535) continue;
        room(b - a + 1);
        if (Array.isArray(dst)) {
          for (let k = 0; k <= b - a && k < dst.length; k++)
            map.set(a + k, utf16be((dst[k] as PdfString).bytes));
        } else if (dst instanceof PdfString && dst.bytes.length >= 1) {
          const base = utf16be(dst.bytes);
          const head = base.slice(0, -1);
          const last = base.charCodeAt(base.length - 1);
          for (let k = 0; k <= b - a; k++)
            map.set(a + k, head + String.fromCharCode((last + k) & 0xffff));
        }
      }
    }
    mode = "";
    ops.length = 0;
  }
  return { codespace, map };
}

// ---- fonts ---------------------------------------------------------------------------------

export class Font {
  private constructor(
    private readonly simple: (string | null)[] | null,
    private readonly toUnicode: CMap | null,
    private readonly codespace: [number, number, number][],
    private readonly widthOf: (code: number) => number,
  ) {}

  /**
   * Calls `fn(text, width, space)` per glyph code, without building arrays; `fn` returning
   * false stops the walk.
   */
  each(bytes: Uint8Array, fn: (text: string, width: number, space: boolean) => boolean): void {
    let i = 0;
    while (i < bytes.length) {
      let len = 1;
      if (!this.simple) {
        len = 2;
        for (const [l, lo, hi] of this.codespace) {
          if (i + l > bytes.length) continue;
          let c = 0;
          for (let k = 0; k < l; k++) c = c * 256 + (bytes[i + k] as number);
          if (c >= lo && c <= hi) {
            len = l;
            break;
          }
        }
        len = Math.min(len, bytes.length - i);
      }
      let code = 0;
      for (let k = 0; k < len; k++) code = code * 256 + (bytes[i + k] as number);
      i += len;
      let text = this.toUnicode?.map.get(code) ?? null;
      if (text === null && this.simple) text = this.simple[code] ?? null;
      if (!fn(text ?? REPLACEMENT, this.widthOf(code), len === 1 && code === 32)) return;
    }
  }

  static load(file: PdfFile, fd: PdfDict): Font {
    const r = (v: PdfValue | undefined): PdfValue | undefined => file.resolve(v);
    const subtype = nameOf(r(fd.get("Subtype")));
    let tu: CMap | null = null;
    const tus = r(fd.get("ToUnicode"));
    if (tus instanceof PdfStream) {
      try {
        tu = parseCMap(file.streamBytes(tus));
      } catch (e) {
        if (!(e instanceof PdfError) || e.code === "pdf/too-large") throw e;
        tu = null;
      }
    }
    if (subtype === "Type0") {
      const enc = r(fd.get("Encoding"));
      let codespace: [number, number, number][] = [[2, 0, 0xffff]];
      if (enc instanceof PdfStream) {
        try {
          const cm = parseCMap(file.streamBytes(enc));
          if (cm.codespace.length) codespace = cm.codespace;
        } catch (e) {
          if (!(e instanceof PdfError) || e.code === "pdf/too-large") throw e;
        }
      } else if (tu && tu.codespace.length) codespace = tu.codespace;
      const kids = r(fd.get("DescendantFonts"));
      const cid = Array.isArray(kids) ? file.resolveDict(kids[0]) : null;
      const dw = (cid ? numOf(r(cid.get("DW"))) : null) ?? 1000;
      const widths = new Map<number, number>();
      const ranges: [number, number, number][] = [];
      const w = cid ? r(cid.get("W")) : undefined;
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length;) {
          const first = intOf(r(w[i]));
          const next = r(w[i + 1]);
          if (first === null) break;
          if (Array.isArray(next)) {
            for (let k = 0; k < next.length && widths.size < 65536; k++) {
              widths.set(first + k, numOf(r(next[k])) ?? dw);
            }
            i += 2;
          } else {
            const last = intOf(next);
            const width = numOf(r(w[i + 2]));
            if (last === null || width === null) break;
            if (ranges.length < 4096) ranges.push([first, last, width]);
            i += 3;
          }
        }
      }
      const widthOf = (code: number): number => {
        const x = widths.get(code);
        if (x !== undefined) return x / 1000;
        for (const [a, b, wd] of ranges) if (code >= a && code <= b) return wd / 1000;
        return dw / 1000;
      };
      return new Font(null, tu, codespace, widthOf);
    }
    // simple font
    const enc = r(fd.get("Encoding"));
    let table: (string | null)[];
    if (enc instanceof PdfName) table = baseEncoding(enc.name);
    else if (enc instanceof PdfDict) {
      table = baseEncoding(nameOf(r(enc.get("BaseEncoding"))));
      const diffs = r(enc.get("Differences"));
      if (Array.isArray(diffs)) {
        let code = 0;
        for (const x of diffs) {
          const v = r(x);
          if (typeof v === "number") code = Math.trunc(v);
          else if (v instanceof PdfName) {
            if (code >= 0 && code < 256) table[code] = glyphToUnicode(v.name);
            code++;
          }
        }
      }
    } else table = baseEncoding(null);
    const firstChar = intOf(r(fd.get("FirstChar"))) ?? 0;
    const ws = r(fd.get("Widths"));
    const desc = file.resolveDict(fd.get("FontDescriptor"));
    const missing = (desc ? numOf(r(desc.get("MissingWidth"))) : null) ?? 500;
    let scale = 1 / 1000;
    if (subtype === "Type3") {
      const fm = r(fd.get("FontMatrix"));
      const a = Array.isArray(fm) ? numOf(r(fm[0])) : null;
      if (a !== null && a > 0 && a < 1) scale = a;
    }
    const widthOf = (code: number): number => {
      const i = code - firstChar;
      const v = Array.isArray(ws) && i >= 0 && i < ws.length ? numOf(r(ws[i])) : null;
      return (v ?? missing) * scale;
    };
    return new Font(table, tu, [], widthOf);
  }
}

export { REPLACEMENT };
