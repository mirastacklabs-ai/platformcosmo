/**
 * Content-stream scan (ingestion §4.3): `q`/`Q` (≤ 256), `cm`, `Do` (image and form XObjects),
 * inline images (`BI`/`ID`/`EI`) and, for `pdf text`, `BT`/`ET` and the text operators. Forms
 * apply `/Matrix` and are entered through an explicit frame stack (≤ 16 deep, each form at
 * most once per stack). Every token counts toward the per-page cap (5 M, forms included) and
 * the per-document cap (50 M); page content counts toward the per-document content budget.
 */
import { MAX_GAP, isControl, type PdfFile } from "./file.js";
import { Font } from "./fonts.js";
import { PdfError, diag, type PdfBox, type PdfDiagnostic } from "./limits.js";
import {
  Lexer,
  PdfDict,
  PdfName,
  PdfRef,
  PdfStream,
  PdfString,
  T_ARR_OPEN,
  T_DICT_OPEN,
  T_EOF,
  T_KW,
  T_NAME,
  T_NUM,
  T_STR,
  intOf,
  isDelim,
  isWs,
  nameOf,
  numOf,
  parseValue,
  type PdfValue,
} from "./objects.js";
import { IDENTITY, bboxOf, mul, r3, type Matrix, type PageRec } from "./pages.js";

export interface Placement {
  /** 0-based, in content order (forms included). */
  readonly index: number;
  readonly stream: PdfStream;
  readonly inline: boolean;
  /** Object number of the image XObject; `null` for inline images. */
  readonly ref: number | null;
  readonly resources: PdfDict | null;
  /** CTM at the `Do` (user space). */
  readonly ctm: Matrix;
}

export interface TextRun {
  /** Text as data; C0/C1 controls and bidi formatting characters are replaced by U+FFFD. */
  readonly text: string;
  readonly bbox: PdfBox;
  /** Effective font size in pt on the page. */
  readonly fontSize: number;
  /** Font resource name. */
  readonly font: string | null;
}

export interface ScanResult {
  readonly placements: Placement[];
  readonly runs: TextRun[];
  readonly diagnostics: PdfDiagnostic[];
}

interface GState {
  ctm: Matrix;
  font: Font | null;
  fontName: string | null;
  size: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
}

interface Frame {
  readonly lx: Lexer;
  readonly resources: PdfDict | null;
  /** The form XObject (null for the page). */
  readonly form: PdfStream | null;
  /** Graphics-state stack depth when the frame was entered. */
  readonly qBase: number;
}

const INLINE_KEYS: Record<string, string> = {
  W: "Width",
  H: "Height",
  BPC: "BitsPerComponent",
  CS: "ColorSpace",
  D: "Decode",
  DP: "DecodeParms",
  F: "Filter",
  IM: "ImageMask",
  I: "Interpolate",
  L: "Length",
};

/** Text extent below/above the baseline, in units of the font size. */
const DESCENT = 0.2;
const ASCENT = 0.8;
/** A TJ adjustment at or below this (thousandths of an em) reads as a space. */
const TJ_SPACE = -200;
const REPLACEMENT = "�";

/** The last `size` operands, without shifting (a ring buffer). */
class Operands {
  private readonly ring: PdfValue[];
  private n = 0;
  private head = 0;
  constructor(private readonly size = 64) {
    this.ring = new Array<PdfValue>(size).fill(null);
  }
  push(v: PdfValue): void {
    this.ring[this.head] = v;
    this.head = (this.head + 1) % this.size;
    if (this.n < this.size) this.n++;
  }
  get length(): number {
    return this.n;
  }
  /** The k-th operand from the end (1 = last); undefined when absent. */
  last(k = 1): PdfValue | undefined {
    if (k > this.n) return undefined;
    return this.ring[(this.head - k + this.size) % this.size];
  }
  clear(): void {
    this.n = 0;
  }
}

/** Concatenated, decoded page content (array of streams joined by newlines). */
function pageContent(file: PdfFile, page: PageRec): Uint8Array {
  const hit = file.lastContent;
  if (hit?.page === page.page) {
    if (hit.data instanceof PdfError) throw hit.data;
    return hit.data;
  }
  try {
    const data = decodeContent(file, page);
    file.lastContent = { page: page.page, data };
    return data;
  } catch (e) {
    if (e instanceof PdfError && e.where.scope !== "total" && e.where.scope !== "document") {
      file.lastContent = { page: page.page, data: e };
    }
    throw e;
  }
}

function decodeContent(file: PdfFile, page: PageRec): Uint8Array {
  const where = { page: page.page };
  file.budget.ensure(0, where);
  file.budget.ensureContent(where);
  const c = file.resolve(page.dict.get("Contents"));
  const parts: Uint8Array[] = [];
  const list = Array.isArray(c) ? c : [c];
  let total = 0;
  for (const x of list) {
    const s = file.resolve(x);
    if (!(s instanceof PdfStream)) continue;
    const p = file.streamBytes(s, { where });
    total += p.length + 1;
    if (total > file.limits.maxStreamBytes) {
      throw new PdfError("pdf/too-large", "the page content exceeds the stream cap", where);
    }
    parts.push(p);
  }
  file.budget.charge(total, where); // the concatenated copy
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
    out[at++] = 10;
  }
  return out;
}

/** Finds the end of inline image data starting at `start`; returns [dataEnd, afterEI]. */
function inlineEnd(
  b: Uint8Array,
  start: number,
  end: number,
  known: number | null,
): [number, number] {
  // EI after the known length: at most MAX_GAP whitespace bytes in between
  if (known !== null && known >= 0 && start + known <= end) {
    let q = start + known;
    while (q < end && q - (start + known) < MAX_GAP && isWs(b[q] as number)) q++;
    if (
      b[q] === 69 &&
      b[q + 1] === 73 &&
      (q + 2 >= end || isWs(b[q + 2] as number) || isDelim(b[q + 2] as number))
    ) {
      return [start + known, q + 2];
    }
  }
  // otherwise the first plausible `EI`; the lexer resumes after it, so each byte is seen once
  for (let i = start; i + 1 < end; i++) {
    if (b[i] !== 69 || b[i + 1] !== 73) continue;
    if (i > start && !isWs(b[i - 1] as number)) continue;
    if (i + 2 < end && !isWs(b[i + 2] as number) && !isDelim(b[i + 2] as number)) continue;
    // what follows EI must look like content (no binary within 8 bytes)
    let binary = false;
    for (let k = i + 2; k < Math.min(end, i + 10); k++) {
      const c = b[k] as number;
      if ((c < 32 && !isWs(c)) || c > 126) binary = true;
    }
    if (binary) continue;
    let dEnd = i;
    if (dEnd > start && isWs(b[dEnd - 1] as number)) dEnd--;
    return [dEnd, i + 2];
  }
  return [end, end];
}

/** Replaces control and bidi characters of one glyph's text (C-Q05). */
function clean(t: string): string {
  if (t.length === 1) return isControl(t.charCodeAt(0)) ? REPLACEMENT : t;
  let out = "";
  for (const ch of t) out += isControl(ch.codePointAt(0) as number) ? REPLACEMENT : ch;
  return out;
}

export function scanPage(
  file: PdfFile,
  page: PageRec,
  mode: { images: boolean; text: boolean },
): ScanResult {
  const limits = file.limits;
  const diagnostics: PdfDiagnostic[] = [];
  const placements: Placement[] = [];
  const runs: TextRun[] = [];
  /** Characters kept on this page so far (`maxPageChars`, N01). */
  let pageChars = 0;
  const where = { page: page.page };
  const fonts = new Map<PdfDict, Font | null>();
  let gs: GState = {
    ctm: IDENTITY,
    font: null,
    fontName: null,
    size: 0,
    tc: 0,
    tw: 0,
    th: 1,
    tl: 0,
    rise: 0,
  };
  const gstack: GState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let tokens = 0;
  const warned = new Set<unknown>();
  const warnOnce = (key: unknown, d: PdfDiagnostic): void => {
    if (!warned.has(key)) {
      warned.add(key);
      diagnostics.push(d);
    }
  };

  let content: Uint8Array;
  try {
    content = pageContent(file, page);
    file.budget.chargeContent(content.length, where);
  } catch (e) {
    if (!(e instanceof PdfError)) throw e;
    diagnostics.push(diag("error", e.code, e.message, { ...where, ...e.where }, e.suggestion));
    return { placements, runs, diagnostics };
  }
  const frames: Frame[] = [
    { lx: new Lexer(content), resources: page.resources, form: null, qBase: 0 },
  ];
  const operands = new Operands();

  const push = (): void => {
    if (gstack.length >= limits.maxQStack) {
      throw new PdfError(
        "pdf/too-complex",
        `the q/Q stack is deeper than ${limits.maxQStack}`,
        where,
      );
    }
    gstack.push({ ...gs });
  };
  const pop = (base: number): void => {
    if (gstack.length > base) gs = gstack.pop() as GState;
  };
  const nums = (n: number): number[] | null => {
    if (operands.length < n) return null;
    const out: number[] = [];
    for (let k = n; k >= 1; k--) {
      const v = numOf(operands.last(k));
      if (v === null) return null;
      out.push(v);
    }
    return out;
  };
  const resDict = (f: Frame, key: string): PdfDict | null =>
    f.resources ? file.resolveDict(f.resources.get(key)) : null;

  const fontFor = (f: Frame, name: string): Font | null => {
    const fd = resDict(f, "Font");
    const d = fd ? file.resolveDict(fd.get(name)) : null;
    if (!d) return null;
    if (fonts.has(d)) return fonts.get(d) as Font | null;
    let font: Font | null = null;
    try {
      font = Font.load(file, d);
    } catch (e) {
      if (!(e instanceof PdfError) || e.code === "pdf/too-large") throw e;
      warnOnce(d, diag("warning", e.code, e.message, where));
    }
    fonts.set(d, font);
    return font;
  };

  const place = (p: Omit<Placement, "index">): void => {
    if (placements.length >= limits.maxPlacements) {
      warnOnce(
        "placements",
        diag(
          "warning",
          "pdf/too-complex",
          `the page has more than ${limits.maxPlacements} image placements; the rest are not listed`,
          where,
        ),
      );
      return;
    }
    placements.push({ index: placements.length, ...p });
  };

  /** Shows glyphs one by one (no per-byte arrays), records one run, advances the text matrix. */
  const show = (items: readonly PdfValue[]): void => {
    if (!mode.text) return;
    if (runs.length >= limits.maxRuns) {
      warnOnce(
        "runs",
        diag(
          "warning",
          "pdf/too-complex",
          `the page has more than ${limits.maxRuns} text runs; the rest are skipped`,
          where,
        ),
      );
      return;
    }
    const font = gs.font;
    const size = gs.size;
    const cap = limits.maxRunChars;
    let text = "";
    let truncated = false;
    let adv = 0;
    const add = (t: string, width: number, space: boolean): boolean => {
      // past either cap no text is kept, but the pen still advances (positions stay right)
      if (!truncated && pageChars < limits.maxPageChars) {
        if (text.length + t.length > cap) truncated = true;
        else {
          text += clean(t);
          pageChars += t.length;
        }
      }
      adv += (width * size + gs.tc + (space ? gs.tw : 0)) * gs.th;
      return true;
    };
    for (const it of items) {
      if (typeof it === "number") {
        adv -= (it / 1000) * size * gs.th;
        if (it <= TJ_SPACE && text.length > 0 && !text.endsWith(" ") && !truncated) text += " ";
        continue;
      }
      if (!(it instanceof PdfString)) continue;
      if (font) font.each(it.bytes, add);
      else for (let i = 0; i < it.bytes.length; i++) add(REPLACEMENT, 0.5, false);
    }
    if (pageChars >= limits.maxPageChars) {
      warnOnce(
        "page-chars",
        diag(
          "warning",
          "pdf/too-complex",
          `the page has more than ${limits.maxPageChars} characters of text; the rest is skipped`,
          where,
        ),
      );
    }
    if (truncated) {
      warnOnce(
        "chars",
        diag(
          "warning",
          "pdf/too-complex",
          `a text run is longer than ${cap} characters; it is truncated`,
          where,
        ),
      );
    }
    if (text.length > 0) {
      const trm = mul(mul([1, 0, 0, 1, 0, gs.rise], tm), gs.ctm);
      const m = mul(trm, page.toPage);
      const bbox = bboxOf(m, Math.min(0, adv), -DESCENT * size, Math.max(0, adv), ASCENT * size);
      const sy = Math.hypot(m[2], m[3]);
      runs.push({ text, bbox, fontSize: r3(sy * size), font: gs.fontName });
    }
    tm = mul([1, 0, 0, 1, adv, 0], tm);
  };
  const nextLine = (): void => {
    tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
    tm = tlm;
  };

  try {
    while (frames.length > 0) {
      const f = frames[frames.length - 1] as Frame;
      const lx = f.lx;
      const t = lx.next();
      if (t === T_EOF) {
        while (gstack.length > f.qBase) pop(f.qBase);
        frames.pop();
        if (f.form) pop(f.qBase - 1); // the implicit q around the form
        operands.clear();
        continue;
      }
      // every token counts, operands included (S-Q13)
      if (++tokens > limits.maxOpsPerPage) {
        throw new PdfError(
          "pdf/too-complex",
          `the page has more than ${limits.maxOpsPerPage} content tokens (operators and operands)`,
          where,
        );
      }
      if (!file.budget.op()) {
        throw new PdfError(
          "pdf/too-complex",
          `more than ${limits.maxDocOps} content tokens in this command`,
          { ...where, scope: "document" },
        );
      }
      if (t === T_NUM) operands.push(lx.num);
      else if (t === T_STR) operands.push(lx.str);
      else if (t === T_NAME) operands.push(new PdfName(lx.word));
      else if (t === T_ARR_OPEN || t === T_DICT_OPEN) {
        lx.pos = lx.tokStart;
        const v = parseValue(lx, limits, false);
        if (v === undefined)
          lx.next(); // skip the structural keyword
        else operands.push(v);
      }
      if (t !== T_KW) continue;
      const op = lx.word;
      switch (op) {
        case "q":
          push();
          break;
        case "Q":
          pop(f.qBase);
          break;
        case "cm": {
          const n = nums(6);
          if (n) gs.ctm = mul(n as unknown as Matrix, gs.ctm);
          break;
        }
        case "Do": {
          const name = nameOf(operands.last());
          const xd = resDict(f, "XObject");
          const ref = name && xd ? xd.get(name) : undefined;
          const xo = file.resolve(ref);
          if (!(xo instanceof PdfStream)) break;
          const sub = nameOf(file.resolve(xo.dict.get("Subtype")));
          if (sub === "Image") {
            if (mode.images) {
              place({
                stream: xo,
                inline: false,
                ref: ref instanceof PdfRef ? ref.num : null,
                resources: f.resources,
                ctm: gs.ctm,
              });
            }
          } else if (sub === "Form") {
            // keyed on the resolved object, so two references to one form are one form
            if (frames.some((x) => x.form === xo)) {
              warnOnce(
                xo,
                diag(
                  "warning",
                  "pdf/too-complex",
                  "a form XObject draws itself; the repeat is skipped",
                  where,
                ),
              );
              break;
            }
            if (frames.length > limits.maxFormDepth) {
              warnOnce(
                "depth",
                diag(
                  "warning",
                  "pdf/too-complex",
                  `form XObjects nest deeper than ${limits.maxFormDepth}`,
                  where,
                ),
              );
              break;
            }
            let data: Uint8Array;
            try {
              data = file.streamBytes(xo, { where });
            } catch (e) {
              if (!(e instanceof PdfError) || e.code === "pdf/too-large") throw e;
              warnOnce(
                xo,
                diag("warning", e.code, e.message, { ...where, ...e.where }, e.suggestion),
              );
              break;
            }
            push();
            const mx = file.resolve(xo.dict.get("Matrix"));
            if (Array.isArray(mx) && mx.length >= 6) {
              const m = mx.slice(0, 6).map((x) => numOf(file.resolve(x)));
              if (m.every((x) => x !== null)) gs.ctm = mul(m as unknown as Matrix, gs.ctm);
            }
            const res = file.resolveDict(xo.dict.get("Resources")) ?? f.resources;
            frames.push({ lx: new Lexer(data), resources: res, form: xo, qBase: gstack.length });
          }
          break;
        }
        case "BI": {
          const d = new PdfDict();
          for (let k = 0; k < 256; k++) {
            const kt = lx.next();
            if (kt === T_EOF || (kt === T_KW && lx.word === "ID")) break;
            if (kt !== T_NAME) continue;
            const key = INLINE_KEYS[lx.word] ?? lx.word;
            const v = parseValue(lx, limits, false);
            if (v === undefined) {
              // a structural keyword: `ID` (value missing) or garbage; either way stop here
              const at = lx.pos;
              if (!(lx.next() === T_KW && lx.word === "ID")) lx.pos = at;
              break;
            }
            if (v !== null) d.map.set(key, v);
          }
          // one whitespace byte after ID, then the data
          let start = lx.pos;
          if (start < lx.end && isWs(lx.buf[start] as number)) start++;
          let known = intOf(d.get("Length"));
          if (known === null && d.get("Filter") === undefined) {
            const w = intOf(d.get("Width")) ?? 0;
            const h = intOf(d.get("Height")) ?? 0;
            const im = d.get("ImageMask") === true;
            const bpc = im ? 1 : (intOf(d.get("BitsPerComponent")) ?? 8);
            const cs = d.get("ColorSpace");
            const csn = nameOf(cs);
            let n = -1; // unknown (a named resource): find EI by scanning
            if (im || csn === "G" || csn === "DeviceGray" || Array.isArray(cs)) n = 1;
            else if (csn === "RGB" || csn === "DeviceRGB") n = 3;
            else if (csn === "CMYK" || csn === "DeviceCMYK") n = 4;
            if (
              w > 0 &&
              h > 0 &&
              n > 0 &&
              bpc > 0 &&
              w <= limits.maxStreamBytes &&
              h <= limits.maxStreamBytes
            ) {
              const len = Math.ceil((w * n * bpc) / 8) * h;
              if (len <= limits.maxStreamBytes) known = len;
            }
          }
          const [dEnd, after] = inlineEnd(lx.buf, start, lx.end, known);
          lx.pos = after;
          if (mode.images) {
            place({
              stream: new PdfStream(d, lx.buf.subarray(start, dEnd), -1, 0),
              inline: true,
              ref: null,
              resources: f.resources,
              ctm: gs.ctm,
            });
          }
          break;
        }
        case "BT":
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case "Tf": {
          const size = numOf(operands.last(1));
          const name = nameOf(operands.last(2));
          if (size !== null) gs.size = size;
          if (name !== null && mode.text) {
            gs.font = fontFor(f, name);
            gs.fontName = name;
          }
          break;
        }
        case "Tc":
        case "Tw":
        case "Tz":
        case "TL":
        case "Ts": {
          const n = nums(1);
          if (!n) break;
          const v = n[0] as number;
          if (op === "Tc") gs.tc = v;
          else if (op === "Tw") gs.tw = v;
          else if (op === "Tz") gs.th = v / 100;
          else if (op === "TL") gs.tl = v;
          else gs.rise = v;
          break;
        }
        case "Td":
        case "TD": {
          const n = nums(2);
          if (!n) break;
          if (op === "TD") gs.tl = -(n[1] as number);
          tlm = mul([1, 0, 0, 1, n[0] as number, n[1] as number], tlm);
          tm = tlm;
          break;
        }
        case "Tm": {
          const n = nums(6);
          if (!n) break;
          tlm = n as unknown as Matrix;
          tm = tlm;
          break;
        }
        case "T*":
          nextLine();
          break;
        case "Tj":
        case "'":
        case '"': {
          const s = operands.last();
          if (op === '"') {
            const n = numOf(operands.last(3));
            const c = numOf(operands.last(2));
            if (n !== null) gs.tw = n;
            if (c !== null) gs.tc = c;
          }
          if (op !== "Tj") nextLine();
          if (s instanceof PdfString) show([s]);
          break;
        }
        case "TJ": {
          const a = operands.last();
          if (Array.isArray(a)) show(a);
          break;
        }
        default:
          break;
      }
      operands.clear();
    }
  } catch (e) {
    if (!(e instanceof PdfError)) throw e;
    diagnostics.push(diag("error", e.code, e.message, { ...where, ...e.where }, e.suggestion));
  }
  return { placements, runs, diagnostics };
}
