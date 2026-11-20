/**
 * PDF object model, lexer and object parser (ingestion §4.1). Linear scanners only (no regular
 * expressions on file data); containers are parsed with an explicit stack bounded by
 * `maxNesting`, and each container holds at most `maxObjects` elements.
 */
import { PdfError, type PdfLimits } from "./limits.js";

export class PdfName {
  constructor(readonly name: string) {}
}

export class PdfString {
  constructor(public bytes: Uint8Array) {}
}

export class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}

export class PdfDict {
  readonly map = new Map<string, PdfValue>();
  get(key: string): PdfValue | undefined {
    return this.map.get(key);
  }
}

export class PdfStream {
  constructor(
    readonly dict: PdfDict,
    /** Raw (still encrypted, still encoded) data. */
    readonly raw: Uint8Array,
    readonly num: number,
    readonly gen: number,
  ) {}
}

export type PdfValue =
  null | boolean | number | PdfName | PdfString | PdfRef | PdfDict | PdfStream | PdfValue[];

// ---- character classes ---------------------------------------------------------------------

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;

export const isWs = (c: number): boolean => WS[c] === 1;
const CHARS = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i));
export const isDelim = (c: number): boolean => DELIM[c] === 1;
export const isRegular = (c: number): boolean => WS[c] === 0 && DELIM[c] === 0;

const hexVal = (c: number): number =>
  c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;

/** Latin-1 decode of `b[start, end)`, chunked (no spread of large arrays). */
export function latin1(b: Uint8Array, start = 0, end = b.length): string {
  let s = "";
  for (let i = start; i < end; i += 4096) {
    s += String.fromCharCode.apply(
      null,
      b.subarray(i, Math.min(end, i + 4096)) as unknown as number[],
    );
  }
  return s;
}

/** Longest name or keyword materialized; longer runs are consumed but truncated. */
const MAX_WORD = 1024;

// ---- lexer ---------------------------------------------------------------------------------

export const T_EOF = 0;
export const T_NUM = 1;
export const T_STR = 2;
export const T_NAME = 3;
export const T_KW = 4;
export const T_ARR_OPEN = 5;
export const T_ARR_CLOSE = 6;
export const T_DICT_OPEN = 7;
export const T_DICT_CLOSE = 8;
export const T_OTHER = 9;

export class Lexer {
  pos: number;
  /** Values of the last token. */
  num = 0;
  isInt = false;
  str: PdfString | null = null;
  word = "";
  /** Offset where the last token started. */
  tokStart = 0;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }

  skipWs(): void {
    const b = this.buf;
    let p = this.pos;
    while (p < this.end) {
      const c = b[p] as number;
      if (WS[c]) p++;
      else if (c === 37 /* % */) {
        while (p < this.end && b[p] !== 10 && b[p] !== 13) p++;
      } else break;
    }
    this.pos = p;
  }

  next(): number {
    this.skipWs();
    const b = this.buf;
    const end = this.end;
    this.tokStart = this.pos;
    if (this.pos >= end) return T_EOF;
    const c = b[this.pos] as number;
    switch (c) {
      case 91: // [
        this.pos++;
        return T_ARR_OPEN;
      case 93: // ]
        this.pos++;
        return T_ARR_CLOSE;
      case 40: // (
        this.str = this.literalString();
        return T_STR;
      case 47: // /
        this.pos++;
        this.word = this.name();
        return T_NAME;
      case 60: // <
        if (b[this.pos + 1] === 60) {
          this.pos += 2;
          return T_DICT_OPEN;
        }
        this.str = this.hexString();
        return T_STR;
      case 62: // >
        if (b[this.pos + 1] === 62) {
          this.pos += 2;
          return T_DICT_CLOSE;
        }
        this.pos++;
        return T_OTHER;
      case 41: // ) { }
      case 123:
      case 125:
        this.pos++;
        return T_OTHER;
    }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      if (this.number()) return T_NUM;
    }
    // keyword: a run of regular characters
    const s = this.pos;
    let p = s;
    while (p < end && isRegular(b[p] as number)) p++;
    if (p === s) p++; // a lone stray byte
    this.pos = p;
    const n = p - s;
    // operators are short: avoid a subarray per token on the hot path
    this.word =
      n === 1
        ? (CHARS[c] as string)
        : n === 2
          ? String.fromCharCode(c, b[s + 1] as number)
          : latin1(b, s, Math.min(p, s + MAX_WORD));
    return T_KW;
  }

  /** Parses a number at `pos`; false (pos unchanged) when the run is not numeric. */
  private number(): boolean {
    const b = this.buf;
    let p = this.pos;
    let neg = false;
    // leniency: any run of signs, the first decides (`--5` → -5, seen in the wild)
    while (p < this.end && (b[p] === 43 || b[p] === 45)) {
      if (p === this.pos) neg = b[p] === 45;
      p++;
    }
    let intPart = 0;
    let frac = 0;
    let scale = 1;
    let dot = false;
    let digits = 0;
    while (p < this.end) {
      const c = b[p] as number;
      if (c >= 48 && c <= 57) {
        digits++;
        if (dot) {
          if (scale < 1e15) {
            scale *= 10;
            frac = frac * 10 + (c - 48);
          }
        } else intPart = intPart * 10 + (c - 48);
        p++;
      } else if (c === 46 && !dot) {
        dot = true;
        p++;
      } else break;
    }
    if (digits === 0) {
      if (p === this.pos) return false;
      // `-` or `.` alone: PDF readers treat it as 0
    }
    this.pos = p;
    let v = intPart + frac / scale;
    if (!Number.isFinite(v)) v = 0;
    this.num = neg ? -v : v;
    if (Object.is(this.num, -0)) this.num = 0;
    this.isInt = !dot && Number.isSafeInteger(this.num);
    return true;
  }

  private name(): string {
    const b = this.buf;
    let p = this.pos;
    const out: number[] = [];
    while (p < this.end) {
      const c = b[p] as number;
      if (!isRegular(c)) break;
      if (c === 35 /* # */ && p + 2 < this.end) {
        const h = hexVal(b[p + 1] as number);
        const l = hexVal(b[p + 2] as number);
        if (h >= 0 && l >= 0) {
          if (out.length < MAX_WORD) out.push(h * 16 + l);
          p += 3;
          continue;
        }
      }
      if (out.length < MAX_WORD) out.push(c);
      p++;
    }
    this.pos = p;
    return String.fromCharCode(...out);
  }

  private literalString(): PdfString {
    const b = this.buf;
    const end = this.end;
    // pass 1: find the closing parenthesis (linear)
    let p = this.pos + 1;
    let depth = 1;
    while (p < end) {
      const c = b[p] as number;
      if (c === 92) p += 2;
      else {
        if (c === 40) depth++;
        else if (c === 41 && --depth === 0) break;
        p++;
      }
    }
    const stop = Math.min(p, end);
    // pass 2: decode into a buffer no larger than the span
    const out = new Uint8Array(Math.max(0, stop - this.pos - 1));
    let n = 0;
    let i = this.pos + 1;
    while (i < stop) {
      let c = b[i++] as number;
      if (c === 92 && i < stop) {
        c = b[i++] as number;
        switch (c) {
          case 110:
            out[n++] = 10;
            break;
          case 114:
            out[n++] = 13;
            break;
          case 116:
            out[n++] = 9;
            break;
          case 98:
            out[n++] = 8;
            break;
          case 102:
            out[n++] = 12;
            break;
          case 13: // line continuation
            if (b[i] === 10) i++;
            break;
          case 10:
            break;
          default:
            if (c >= 48 && c <= 55) {
              let v = c - 48;
              for (
                let k = 0;
                k < 2 && i < stop && (b[i] as number) >= 48 && (b[i] as number) <= 55;
                k++
              ) {
                v = v * 8 + ((b[i++] as number) - 48);
              }
              out[n++] = v & 0xff;
            } else out[n++] = c;
        }
      } else if (c === 13) {
        // end-of-line in a string is LF
        out[n++] = 10;
        if (b[i] === 10) i++;
      } else out[n++] = c;
    }
    this.pos = Math.min(end, stop + 1);
    return new PdfString(out.slice(0, n));
  }

  private hexString(): PdfString {
    const b = this.buf;
    let p = this.pos + 1;
    let q = p;
    while (q < this.end && b[q] !== 62) q++;
    const out = new Uint8Array(((q - p) >> 1) + 1);
    let n = 0;
    let hi = -1;
    for (; p < q; p++) {
      const v = hexVal(b[p] as number);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out[n++] = hi * 16 + v;
        hi = -1;
      }
    }
    if (hi >= 0) out[n++] = hi * 16;
    this.pos = Math.min(this.end, q + 1);
    return new PdfString(out.slice(0, n));
  }
}

// ---- object parser -------------------------------------------------------------------------

/** Keywords that end an object; meeting one inside a container closes everything. */
const STRUCTURAL = new Set([
  "endobj",
  "stream",
  "endstream",
  "obj",
  "xref",
  "trailer",
  "startxref",
  "ID",
  "BI",
  "EI",
]);

interface Frame {
  readonly dict: boolean;
  readonly items: PdfValue[];
}

/** Builds a dictionary from alternating key/value items (non-name keys are skipped). */
function toDict(items: PdfValue[]): PdfDict {
  const d = new PdfDict();
  for (let i = 0; i + 1 < items.length; i += 2) {
    const k = items[i];
    if (k instanceof PdfName) {
      const v = items[i + 1] as PdfValue;
      if (v !== null) d.map.set(k.name, v);
    } else {
      i--; // resynchronize on the next name
    }
  }
  return d;
}

/**
 * Parses one value at the lexer position. Returns `undefined` at EOF or on a structural
 * keyword (the lexer is left before it). `allowRefs` turns `N G R` into references.
 */
export function parseValue(lx: Lexer, limits: PdfLimits, allowRefs = true): PdfValue | undefined {
  const stack: Frame[] = [];
  const close = (): PdfValue => {
    const f = stack.pop() as Frame;
    return f.dict ? toDict(f.items) : f.items;
  };
  for (;;) {
    const save = lx.pos;
    const t = lx.next();
    let v: PdfValue | undefined;
    switch (t) {
      case T_EOF:
        if (stack.length === 0) return undefined;
        while (stack.length > 1) {
          const inner = close();
          (stack[stack.length - 1] as Frame).items.push(inner);
        }
        return close();
      case T_NUM: {
        v = lx.num;
        if (allowRefs && lx.isInt && lx.num >= 0) {
          const num = lx.num;
          const after = lx.pos;
          if (lx.next() === T_NUM && lx.isInt && lx.num >= 0) {
            const gen = lx.num;
            if (lx.next() === T_KW && lx.word === "R") v = new PdfRef(num, gen);
            else lx.pos = after;
          } else lx.pos = after;
        }
        break;
      }
      case T_STR:
        v = lx.str;
        break;
      case T_NAME:
        v = new PdfName(lx.word);
        break;
      case T_KW:
        if (lx.word === "true") v = true;
        else if (lx.word === "false") v = false;
        else if (lx.word === "null") v = null;
        else if (STRUCTURAL.has(lx.word)) {
          lx.pos = save;
          if (stack.length === 0) return undefined;
          while (stack.length > 1) {
            const inner = close();
            (stack[stack.length - 1] as Frame).items.push(inner);
          }
          return close();
        } else v = null; // unknown keyword: a null value (leniency)
        break;
      case T_ARR_OPEN:
      case T_DICT_OPEN:
        if (stack.length >= limits.maxNesting) {
          throw new PdfError(
            "pdf/too-complex",
            `arrays and dictionaries nest deeper than ${limits.maxNesting}`,
          );
        }
        stack.push({ dict: t === T_DICT_OPEN, items: [] });
        continue;
      case T_ARR_CLOSE:
      case T_DICT_CLOSE: {
        // a closer only closes its own kind; `>>` also closes arrays left open inside the dict
        const dict = t === T_DICT_CLOSE;
        let target = stack.length - 1;
        while (target >= 0 && (stack[target] as Frame).dict !== dict) target--;
        if (target < 0 || (!dict && target !== stack.length - 1)) continue; // stray: skip
        while (stack.length - 1 > target) {
          const inner = close();
          (stack[stack.length - 1] as Frame).items.push(inner);
        }
        v = close();
        break;
      }
      default:
        continue; // `)`, `{`, `}`, `>`: ignored
    }
    if (stack.length === 0) return v as PdfValue;
    const top = stack[stack.length - 1] as Frame;
    if (top.items.length >= limits.maxObjects) {
      throw new PdfError(
        "pdf/too-complex",
        `an array or dictionary has more than ${limits.maxObjects} elements`,
      );
    }
    top.items.push(v as PdfValue);
  }
}

// ---- typed accessors -----------------------------------------------------------------------

export const nameOf = (v: PdfValue | undefined): string | null =>
  v instanceof PdfName ? v.name : null;

export const numOf = (v: PdfValue | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export const intOf = (v: PdfValue | undefined): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) ? v : null;

export const dictOf = (v: PdfValue | undefined): PdfDict | null =>
  v instanceof PdfDict ? v : v instanceof PdfStream ? v.dict : null;

/** Finds `needle` in `hay[from, to)`; -1 when absent. Linear. */
export function indexOf(hay: Uint8Array, needle: string, from = 0, to = hay.length): number {
  const n0 = needle.charCodeAt(0);
  const len = needle.length;
  const last = Math.min(to, hay.length) - len;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (hay[i] !== n0) continue;
    for (let k = 1; k < len; k++) if (hay[i + k] !== needle.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

/** Last occurrence of `needle` starting in `[from, to)`; -1 when absent. */
export function lastIndexOf(hay: Uint8Array, needle: string, from: number, to: number): number {
  const len = needle.length;
  outer: for (let i = Math.min(to, hay.length) - len; i >= Math.max(0, from); i--) {
    for (let k = 0; k < len; k++) if (hay[i + k] !== needle.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}
