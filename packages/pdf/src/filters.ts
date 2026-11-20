/**
 * Stream filters (ingestion §4.4). Every decoder writes into a buffer that grows only up to an
 * explicit output cap; Flate is inflated in small input slices through fflate's streaming
 * `Inflate`, so a bomb is stopped after at most one slice's worth of output beyond the cap.
 */
import { Inflate } from "fflate";
import { PdfError, type Budget, type PdfLimits, type Where } from "./limits.js";
import { PdfDict, intOf, isWs, nameOf, type PdfValue } from "./objects.js";

/** What happens when a stage reaches its cap: stop quietly (images) or fail (`pdf/too-large`). */
export type CapMode = "truncate" | "error";

export interface StageResult {
  data: Uint8Array;
  /** The input ended early or was corrupt; `data` holds what decoded before that. */
  damaged: boolean;
}

interface StageCtx {
  readonly limit: number;
  readonly mode: CapMode;
  readonly limits: PdfLimits;
  readonly where: Where;
  readonly inputLength: number;
}

/** Growable byte buffer bounded by `limit`. `push` returns false once the cap is reached. */
class Out {
  buf: Uint8Array;
  len = 0;
  full = false;
  constructor(
    private readonly ctx: StageCtx,
    initial: number,
  ) {
    this.buf = new Uint8Array(Math.min(ctx.limit, Math.max(16, initial)));
  }
  private room(n: number): number {
    const want = this.len + n;
    if (want > this.buf.length) {
      const cap = this.ctx.limit;
      const size = Math.min(cap, Math.max(want, this.buf.length * 2));
      if (size > this.buf.length) {
        const nb = new Uint8Array(size);
        nb.set(this.buf.subarray(0, this.len));
        this.buf = nb;
      }
    }
    return Math.min(n, this.buf.length - this.len);
  }
  write(src: Uint8Array): boolean {
    const n = this.room(src.length);
    this.buf.set(n === src.length ? src : src.subarray(0, n), this.len);
    this.len += n;
    if (n < src.length) return this.overflow();
    return this.checkRatio();
  }
  byte(b: number): boolean {
    if (this.len >= this.buf.length && this.room(1) < 1) return this.overflow();
    this.buf[this.len++] = b;
    return true;
  }
  private overflow(): boolean {
    this.full = true;
    if (this.ctx.mode === "error") {
      throw new PdfError(
        "pdf/too-large",
        `a decoded stream exceeds ${this.ctx.limit} bytes`,
        this.ctx.where,
        "use `pcosmo assets pdf render --crop` at a lower DPI",
      );
    }
    return false;
  }
  checkRatio(): boolean {
    const { limits, inputLength } = this.ctx;
    if (this.len > limits.bombFloorBytes && this.len > limits.bombRatio * inputLength) {
      throw new PdfError(
        "pdf/too-large",
        `a stream decompresses more than ${limits.bombRatio}:1 (decompression bomb)`,
        this.ctx.where,
      );
    }
    return true;
  }
  result(damaged: boolean): StageResult {
    return { data: this.buf.subarray(0, this.len), damaged };
  }
}

/** Input slice per `Inflate.push`: at most ~1032× this much output per step (DEFLATE's max). */
const INFLATE_SLICE = 1024;

export function flate(input: Uint8Array, ctx: StageCtx): StageResult {
  let start = 0;
  const cmf = input[0] ?? 0;
  const flg = input[1] ?? 0;
  if (input.length >= 2 && (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0) {
    start = 2;
  }
  const out = new Out(ctx, Math.min(ctx.limit, input.length * 4));
  let stop = false;
  let damaged = false;
  const inf = new Inflate((chunk: Uint8Array) => {
    if (stop) return;
    if (!out.write(chunk)) stop = true;
  });
  // fflate 0.8.3 (pinned) keeps its block state in `s`; `f` set and `l` unset means the final
  // block is done, so trailing bytes are not fed in (they would be re-buffered on every push).
  const state = (inf as unknown as { s?: { f?: number; l?: unknown } }).s;
  try {
    for (let i = start; i < input.length && !stop; i += INFLATE_SLICE) {
      const end = Math.min(input.length, i + INFLATE_SLICE);
      inf.push(input.subarray(i, end), end === input.length);
      if (state && state.f && !state.l) break;
    }
  } catch (e) {
    if (e instanceof PdfError) throw e;
    damaged = true; // corrupt or truncated deflate data: keep what decoded
  }
  return out.result(damaged);
}

export function lzw(input: Uint8Array, ctx: StageCtx, earlyChange: number): StageResult {
  const out = new Out(ctx, Math.min(ctx.limit, input.length * 3));
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
    first[i] = i;
  }
  const scratch = new Uint8Array(4096);
  let next = 258;
  let width = 9;
  let prev = -1;
  let bits = 0;
  let acc = 0;
  const damaged = false;
  const emit = (code: number): boolean => {
    const len = length[code] as number;
    let c = code;
    for (let k = len - 1; k >= 0; k--) {
      scratch[k] = suffix[c] as number;
      c = prefix[c] as number;
    }
    return out.write(scratch.subarray(0, len));
  };
  for (let i = 0; i < input.length; i++) {
    acc = ((acc << 8) | (input[i] as number)) >>> 0;
    bits += 8;
    while (bits >= width) {
      const code = (acc >>> (bits - width)) & ((1 << width) - 1);
      bits -= width;
      acc &= (1 << bits) - 1;
      if (code === 256) {
        next = 258;
        width = 9;
        prev = -1;
        continue;
      }
      if (code === 257) return out.result(damaged);
      if (prev < 0) {
        if (code > 255) return out.result(true);
        if (!emit(code)) return out.result(damaged);
        prev = code;
        continue;
      }
      const add = (suffixOf: number): void => {
        if (next >= 4096) return;
        prefix[next] = prev;
        suffix[next] = first[suffixOf] as number;
        length[next] = Math.min(4095, (length[prev] as number) + 1);
        first[next] = first[prev] as number;
        next++;
      };
      if (code < next) {
        if (!emit(code)) return out.result(damaged);
        add(code);
      } else if (code === next) {
        add(prev); // KwKwK: string(prev) + first(prev)
        if (!emit(code)) return out.result(damaged);
      } else return out.result(true);
      prev = code;
      if (next + earlyChange >= 1 << width && width < 12) width++;
    }
  }
  return out.result(damaged);
}

export function asciiHex(input: Uint8Array, ctx: StageCtx): StageResult {
  const out = new Out(ctx, (input.length >> 1) + 1);
  let hi = -1;
  for (let i = 0; i < input.length; i++) {
    const c = input[i] as number;
    if (c === 62) break;
    const v =
      c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      if (!out.byte(hi * 16 + v)) return out.result(false);
      hi = -1;
    }
  }
  if (hi >= 0) out.byte(hi * 16);
  return out.result(false);
}

export function ascii85(input: Uint8Array, ctx: StageCtx): StageResult {
  const out = new Out(ctx, input.length);
  let i = 0;
  // optional `<~` prefix
  while (i < input.length && isWs(input[i] as number)) i++;
  if (input[i] === 60 && input[i + 1] === 126) i += 2;
  const group = [0, 0, 0, 0, 0];
  let n = 0;
  let damaged = false;
  for (; i < input.length; i++) {
    const c = input[i] as number;
    if (c === 126) break; // `~>`
    if (isWs(c)) continue;
    if (c === 122 && n === 0) {
      for (let k = 0; k < 4; k++) if (!out.byte(0)) return out.result(false);
      continue;
    }
    if (c < 33 || c > 117) {
      damaged = true;
      break;
    }
    group[n++] = c - 33;
    if (n === 5) {
      let v = 0;
      for (let k = 0; k < 5; k++) v = v * 85 + (group[k] as number);
      if (v > 0xffffffff) damaged = true;
      v = v >>> 0;
      if (!out.byte(v >>> 24) || !out.byte((v >>> 16) & 255)) return out.result(damaged);
      if (!out.byte((v >>> 8) & 255) || !out.byte(v & 255)) return out.result(damaged);
      n = 0;
    }
  }
  if (n > 1) {
    for (let k = n; k < 5; k++) group[k] = 84;
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + (group[k] as number);
    v = v >>> 0;
    const bytes = [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    for (let k = 0; k < n - 1; k++) if (!out.byte(bytes[k] as number)) break;
  } else if (n === 1) damaged = true;
  return out.result(damaged);
}

export function runLength(input: Uint8Array, ctx: StageCtx): StageResult {
  const out = new Out(ctx, input.length * 2);
  let i = 0;
  while (i < input.length) {
    const len = input[i++] as number;
    if (len === 128) return out.result(false);
    if (len < 128) {
      const end = Math.min(input.length, i + len + 1);
      if (!out.write(input.subarray(i, end))) return out.result(false);
      if (end - i < len + 1) return out.result(true);
      i = end;
    } else {
      if (i >= input.length) return out.result(true);
      const b = input[i++] as number;
      for (let k = 0; k < 257 - len; k++) if (!out.byte(b)) return out.result(false);
    }
  }
  return out.result(false);
}

// ---- predictors ----------------------------------------------------------------------------

export interface PredictorParams {
  readonly predictor: number;
  readonly colors: number;
  readonly bpc: number;
  readonly columns: number;
}

export function predictorParams(parms: PdfValue | undefined): PredictorParams {
  const d = parms instanceof PdfDict ? parms : null;
  const get = (k: string, dflt: number): number => {
    const v = d ? intOf(d.get(k)) : null;
    return v === null ? dflt : v;
  };
  return {
    predictor: get("Predictor", 1),
    colors: get("Colors", 1),
    bpc: get("BitsPerComponent", 8),
    columns: get("Columns", 1),
  };
}

/** Bytes per row the predictor needs (excluding PNG filter bytes), or -1 when invalid. */
export function predictorRowBytes(p: PredictorParams, limits: PdfLimits): number {
  if (p.colors < 1 || p.colors > 32 || ![1, 2, 4, 8, 16].includes(p.bpc) || p.columns < 1) {
    return -1;
  }
  const rowBytes = Math.ceil((p.columns * p.colors * p.bpc) / 8);
  // a row never exceeds the stream cap (checked before anything is sized from it)
  return rowBytes > limits.maxStreamBytes ? -1 : rowBytes;
}

export function unpredict(data: Uint8Array, p: PredictorParams, limits: PdfLimits): StageResult {
  if (p.predictor <= 1) return { data, damaged: false };
  const rowBytes = predictorRowBytes(p, limits);
  if (rowBytes < 0) return { data, damaged: true };
  const bpp = Math.max(1, Math.ceil((p.colors * p.bpc) / 8));
  if (p.predictor === 2) {
    const out = data.slice();
    const rows = Math.floor(out.length / rowBytes);
    for (let r = 0; r < rows; r++) tiffRow(out, r * rowBytes, rowBytes, p);
    return { data: out, damaged: out.length % rowBytes !== 0 };
  }
  if (p.predictor < 10) return { data, damaged: true };
  // PNG predictors: each row starts with a filter-type byte
  const stride = rowBytes + 1;
  const rows = Math.ceil(data.length / stride);
  const out = new Uint8Array(rows * rowBytes);
  let damaged = data.length % stride !== 0;
  for (let r = 0; r < rows; r++) {
    const src = r * stride;
    const ft = data[src] as number;
    const dst = r * rowBytes;
    const up = dst - rowBytes;
    const n = Math.min(rowBytes, data.length - src - 1);
    for (let i = 0; i < n; i++) {
      const x = data[src + 1 + i] as number;
      const a = i >= bpp ? (out[dst + i - bpp] as number) : 0;
      const b = r > 0 ? (out[up + i] as number) : 0;
      const c = r > 0 && i >= bpp ? (out[up + i - bpp] as number) : 0;
      let v: number;
      switch (ft) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          damaged = true;
          v = x;
      }
      out[dst + i] = v & 0xff;
    }
  }
  return { data: out, damaged };
}

function tiffRow(buf: Uint8Array, off: number, rowBytes: number, p: PredictorParams): void {
  const { colors, bpc, columns } = p;
  if (bpc === 8) {
    for (let i = colors; i < rowBytes; i++) {
      buf[off + i] = ((buf[off + i] as number) + (buf[off + i - colors] as number)) & 0xff;
    }
    return;
  }
  if (bpc === 16) {
    for (let i = colors * 2; i + 1 < rowBytes; i += 2) {
      const v =
        (((buf[off + i] as number) << 8) | (buf[off + i + 1] as number)) +
        (((buf[off + i - colors * 2] as number) << 8) | (buf[off + i - colors * 2 + 1] as number));
      buf[off + i] = (v >> 8) & 0xff;
      buf[off + i + 1] = v & 0xff;
    }
    return;
  }
  // 1, 2 or 4 bits: per-sample, in place
  const mask = (1 << bpc) - 1;
  const read = (s: number): number => {
    const bit = s * bpc;
    return ((buf[off + (bit >> 3)] as number) >> (8 - bpc - (bit & 7))) & mask;
  };
  const write = (s: number, v: number): void => {
    const bit = s * bpc;
    const shift = 8 - bpc - (bit & 7);
    const at = off + (bit >> 3);
    buf[at] = ((buf[at] as number) & ~(mask << shift)) | ((v & mask) << shift);
  };
  for (let s = colors; s < columns * colors; s++) write(s, read(s) + read(s - colors));
}

// ---- filter chains -------------------------------------------------------------------------

const ABBREV: Record<string, string> = {
  AHx: "ASCIIHexDecode",
  A85: "ASCII85Decode",
  LZW: "LZWDecode",
  Fl: "FlateDecode",
  RL: "RunLengthDecode",
  CCF: "CCITTFaxDecode",
  DCT: "DCTDecode",
};

const UNSUPPORTED = new Set(["JBIG2Decode", "JPXDecode", "CCITTFaxDecode", "Crypt"]);

export interface FilterSpec {
  readonly name: string;
  readonly parms: PdfValue | undefined;
}

/** Normalizes `/Filter` and `/DecodeParms` (already resolved) into a list. */
export function filterList(
  filter: PdfValue | undefined,
  parms: PdfValue | undefined,
  resolve: (v: PdfValue | undefined) => PdfValue | undefined,
): FilterSpec[] {
  const names: (string | null)[] = [];
  const f = resolve(filter);
  if (Array.isArray(f)) for (const x of f) names.push(nameOf(resolve(x)));
  else if (f !== undefined && f !== null) names.push(nameOf(f));
  const p = resolve(parms);
  return names.map((n, i) => ({
    name: n === null ? "?" : (ABBREV[n] ?? n),
    parms: resolve(Array.isArray(p) ? p[i] : i === 0 ? p : undefined),
  }));
}

export interface DecodeOptions {
  /** Cap of the final stage's output. */
  readonly limit: number;
  readonly mode: CapMode;
  readonly limits: PdfLimits;
  readonly budget: Budget;
  readonly where: Where;
}

export interface DecodeResult {
  readonly data: Uint8Array;
  /** The final filter was DCTDecode: `data` is the JPEG file. */
  readonly jpeg: boolean;
  readonly damaged: boolean;
}

/** Bytes a PNG/TIFF predictor stage needs to produce `limit` bytes of output. */
function predictedLimit(limit: number, p: PredictorParams, limits: PdfLimits): number {
  if (p.predictor < 10) return limit;
  const rb = predictorRowBytes(p, limits);
  if (rb <= 0) return limit;
  return Math.ceil(limit / rb) * (rb + 1);
}

export function decodeFilters(
  input: Uint8Array,
  filters: readonly FilterSpec[],
  o: DecodeOptions,
): DecodeResult {
  if (filters.length > o.limits.maxFilters) {
    throw new PdfError(
      "pdf/too-complex",
      `a stream has more than ${o.limits.maxFilters} filters`,
      o.where,
    );
  }
  let data = input;
  let damaged = false;
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i] as FilterSpec;
    const last = i === filters.length - 1;
    if (f.name === "DCTDecode") {
      if (!last) {
        throw new PdfError(
          "pdf/unsupported-filter",
          "DCTDecode followed by another filter is not supported",
          o.where,
        );
      }
      if (data.length > o.limits.maxStreamBytes) {
        throw new PdfError("pdf/too-large", "a JPEG stream exceeds the stream cap", o.where);
      }
      return { data, jpeg: true, damaged };
    }
    if (UNSUPPORTED.has(f.name)) {
      throw new PdfError(
        "pdf/unsupported-filter",
        `the ${f.name} filter is not supported`,
        { ...o.where, filter: f.name },
        "use `pcosmo assets pdf render` or attach a screenshot",
      );
    }
    const pred = predictorParams(f.parms);
    const usesPred = f.name === "FlateDecode" || f.name === "LZWDecode";
    const finalLimit = Math.min(o.limit, o.limits.maxStreamBytes);
    const limit = last
      ? usesPred
        ? Math.min(o.limits.maxStreamBytes, predictedLimit(finalLimit, pred, o.limits))
        : finalLimit
      : o.limits.maxStreamBytes;
    const ctx: StageCtx = {
      limit,
      mode: last ? o.mode : "error",
      limits: o.limits,
      where: o.where,
      inputLength: data.length,
    };
    let r: StageResult;
    switch (f.name) {
      case "FlateDecode":
        r = flate(data, ctx);
        break;
      case "LZWDecode": {
        const ec = f.parms instanceof PdfDict ? intOf(f.parms.get("EarlyChange")) : null;
        r = lzw(data, ctx, ec === 0 ? 0 : 1);
        break;
      }
      case "ASCIIHexDecode":
        r = asciiHex(data, ctx);
        break;
      case "ASCII85Decode":
        r = ascii85(data, ctx);
        break;
      case "RunLengthDecode":
        r = runLength(data, ctx);
        break;
      default:
        throw new PdfError(
          "pdf/unsupported-filter",
          `unknown filter ${f.name}`,
          { ...o.where, filter: f.name },
          "use `pcosmo assets pdf render` or attach a screenshot",
        );
    }
    o.budget.charge(r.data.length, o.where);
    if (usesPred && pred.predictor > 1) {
      const u = unpredict(r.data, pred, o.limits);
      r = { data: u.data, damaged: r.damaged || u.damaged };
    }
    damaged ||= r.damaged;
    data = r.data;
  }
  if (data.length > o.limit) data = data.subarray(0, o.limit);
  return { data, jpeg: false, damaged };
}
