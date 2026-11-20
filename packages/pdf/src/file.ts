/**
 * Cross-reference tables and streams, `/Prev` chains, object streams, incremental updates and
 * repair (ingestion §4.1). Objects are loaded lazily and cached; references are resolved with
 * a cycle guard. Linearization hint tables are never read.
 *
 * Every parse is bounded: an indirect object is lexed only up to the next `endobj` (found by a
 * forward search that never revisits a byte) or, after repair, the next object header; an
 * object-stream member only within its own slice. Lexed bytes count against the decoded total.
 */
import { setupSecurity, type Decryptor, type PdfEncryptionInfo } from "./crypt.js";
import { decodeFilters, filterList, type CapMode } from "./filters.js";
import {
  Budget,
  PdfError,
  diag,
  type PdfDiagnostic,
  type PdfLimits,
  type Where,
} from "./limits.js";
import {
  Lexer,
  PdfDict,
  PdfRef,
  PdfStream,
  PdfString,
  T_KW,
  T_NUM,
  dictOf,
  indexOf,
  intOf,
  isWs,
  lastIndexOf,
  latin1,
  nameOf,
  parseValue,
  type PdfValue,
} from "./objects.js";

interface Entry {
  /** 1: at `offset`; 2: element `index` of object stream `stream`; 0: free. */
  readonly type: 0 | 1 | 2;
  readonly offset: number;
  readonly gen: number;
  readonly stream: number;
  readonly index: number;
}

interface ObjStm {
  /** Object number → member index (the first definition wins). */
  readonly index: Map<number, number>;
  readonly nums: number[];
  /** Strictly increasing member offsets, relative to `first`. */
  readonly offsets: number[];
  readonly data: Uint8Array;
  readonly first: number;
}

interface ScanResult {
  /** [num, gen, offset], in file order. */
  readonly objs: [number, number, number][];
  readonly trailers: number[];
}

const FREE: Entry = { type: 0, offset: 0, gen: 0, stream: 0, index: 0 };

/** Whitespace allowed between a stream's data and `endstream` (EOL plus a little slack). */
export const MAX_GAP = 8;
/** Trailers read by repair (the newest ones). */
const MAX_TRAILERS = 64;
/** Nested stream decodes (filter parameters resolved inside an object stream …). */
const MAX_DECODE_DEPTH = 4;

type DecodeOpts = { encrypted?: boolean; limit?: number; mode?: CapMode; where?: Where };

export class PdfFile {
  readonly entries = new Map<number, Entry>();
  trailer = new PdfDict();
  readonly budget: Budget;
  readonly diagnostics: PdfDiagnostic[] = [];
  /** Object numbers loaded so far (the allowlist tests read this). */
  readonly loaded = new Set<number>();
  version: string | null = null;
  repaired = false;
  encryption: PdfEncryptionInfo | null = null;
  /** The last page's decoded content (or its failure), so `text` after `list` decodes once. */
  lastContent: { page: number; data: Uint8Array | PdfError } | null = null;
  private headerOffset = 0;
  private decryptor: Decryptor | null = null;
  private encryptNum = -1;
  private readonly cache = new Map<number, PdfValue>();
  private readonly resolving = new Set<number>();
  private readonly objStms = new Map<number, ObjStm | null>();
  private endstreams: number[] | null = null;
  private scanResult: ScanResult | null = null;
  /** Sorted header offsets from the scan (bounds object parses after repair). */
  private headers: number[] | null = null;
  /** `endobj` positions found so far, and how far the forward search has gone. */
  private readonly endobjs: number[] = [];
  private endobjFrontier = 0;
  /** The table was rebuilt by `repair` (it runs at most once). */
  private rebuilt = false;
  private sections = 0;
  private readonly seenSections = new Set<number>();
  private lengthDepth = 0;
  private decodeDepth = 0;
  private readonly failures = new WeakMap<PdfStream, Map<string, PdfError>>();
  private readonly decrypted = new WeakMap<PdfStream, Uint8Array>();
  private readonly warnedObjStm = new Set<number>();
  private warnedCycle = false;

  constructor(
    readonly buf: Uint8Array,
    readonly limits: PdfLimits,
  ) {
    this.budget = new Budget(limits);
  }

  // ---- opening -----------------------------------------------------------------------------

  /** Reads the xref chain (or repairs) and sets up decryption. Throws `PdfError`. */
  open(): void {
    const b = this.buf;
    const h = indexOf(b, "%PDF-", 0, Math.min(b.length, 1024));
    if (h >= 0) {
      this.headerOffset = h;
      let e = h + 5;
      while (
        e < b.length &&
        e < h + 12 &&
        (b[e] === 46 || ((b[e] as number) >= 48 && (b[e] as number) <= 57))
      )
        e++;
      this.version = latin1(b, h + 5, e) || null;
    }
    let ok = false;
    try {
      ok = this.readXrefChain();
    } catch (e) {
      if (!(e instanceof PdfError) || e.code !== "pdf/malformed") throw e;
    }
    if (!ok || !this.catalog()) this.repair("the cross-reference table is damaged");
    if (!this.catalog()) {
      throw new PdfError("pdf/malformed", "no document catalog found: this is not a usable PDF");
    }
    this.setupEncryption();
  }

  private setupEncryption(): void {
    const encRef = this.trailer.get("Encrypt");
    if (encRef === undefined || encRef === null) return;
    if (encRef instanceof PdfRef) this.encryptNum = encRef.num;
    const enc = this.resolve(encRef);
    if (!(enc instanceof PdfDict)) {
      throw new PdfError("pdf/encrypted", "the /Encrypt dictionary is unreadable");
    }
    const ids = this.resolve(this.trailer.get("ID"));
    const id0 =
      Array.isArray(ids) && ids[0] instanceof PdfString ? ids[0].bytes : new Uint8Array(0);
    const s = setupSecurity(enc, id0, (v) => this.resolve(v));
    this.encryption = s.info;
    if (!s.ok) {
      throw new PdfError(
        "pdf/encrypted",
        `the document is encrypted and cannot be opened: ${s.reason}`,
        {},
        "only files with an empty user password (Standard handler, RC4 or AES) are supported",
      );
    }
    this.decryptor = s.decryptor;
    // objects parsed before the handler was known held encrypted strings: drop them
    for (const k of [...this.cache.keys()]) if (k !== this.encryptNum) this.cache.delete(k);
    this.objStms.clear();
  }

  private catalog(): PdfDict | null {
    try {
      const root = this.resolve(this.trailer.get("Root"));
      return root instanceof PdfDict && root.get("Pages") !== undefined ? root : null;
    } catch (e) {
      if (e instanceof PdfError && e.code !== "pdf/malformed") throw e;
      return null;
    }
  }

  get root(): PdfDict {
    const r = this.catalog();
    if (!r) throw new PdfError("pdf/malformed", "no document catalog");
    return r;
  }

  private note(message: string): void {
    if (!this.repaired) {
      this.repaired = true;
      this.diagnostics.push(diag("info", "pdf/xref-repaired", message));
    }
  }

  private malformed(message: string): never {
    throw new PdfError("pdf/malformed", message);
  }

  private setEntry(num: number, e: Entry): void {
    if (num < 0 || !Number.isSafeInteger(num) || this.entries.has(num)) return;
    if (this.entries.size >= this.limits.maxObjects) {
      throw new PdfError("pdf/too-complex", `more than ${this.limits.maxObjects} objects`);
    }
    this.entries.set(num, e);
  }

  private mergeTrailer(d: PdfDict): void {
    for (const [k, v] of d.map) if (!this.trailer.map.has(k)) this.trailer.map.set(k, v);
  }

  /**
   * Registers a section (a `/Prev` target or a hybrid file's `/XRefStm`): false when it was
   * already read; throws (`scope: "sections"`) past the 64-section cap.
   */
  private enterSection(off: number): boolean {
    if (this.seenSections.has(off)) {
      if (!this.warnedCycle) {
        this.warnedCycle = true;
        this.diagnostics.push(
          diag(
            "warning",
            "pdf/malformed",
            "a cross-reference section points back at one already read; it is not read again",
            { offset: off },
          ),
        );
      }
      return false;
    }
    this.seenSections.add(off);
    if (++this.sections > this.limits.maxXrefSections) {
      throw new PdfError(
        "pdf/too-complex",
        `more than ${this.limits.maxXrefSections} cross-reference sections; the rest are not followed`,
        { scope: "sections" },
      );
    }
    return true;
  }

  /** Follows startxref and the /Prev chain. Returns false when it is unusable. */
  private readXrefChain(): boolean {
    const b = this.buf;
    const sx = lastIndexOf(b, "startxref", Math.max(0, b.length - 2048), b.length);
    if (sx < 0) return false;
    const lx = new Lexer(b, sx + 9);
    if (lx.next() !== T_NUM || !lx.isInt) return false;
    const queue: number[] = [lx.num];
    try {
      while (queue.length > 0) {
        const off = queue.shift() as number;
        if (!this.enterSection(off)) continue; // /Prev cycle
        const trailer = this.readSection(off) ?? this.readSection(off + this.headerOffset);
        if (!trailer) return false;
        this.mergeTrailer(trailer);
        const prev = intOf(trailer.get("Prev"));
        if (prev !== null) queue.push(prev);
      }
    } catch (e) {
      if (e instanceof PdfError && e.where.scope === "sections") {
        // ingestion §4.6: ≤ 64 sections; past that the file is rebuilt by the one-pass scan
        this.diagnostics.push(diag("warning", "pdf/too-complex", e.message));
        return false;
      }
      throw e;
    }
    return this.entries.size > 0;
  }

  /** Reads one section at `off`: a classic table plus trailer, or an xref stream. */
  private readSection(off: number): PdfDict | null {
    const b = this.buf;
    if (off < 0 || off >= b.length) return null;
    const lx = new Lexer(b, off);
    const t = lx.next();
    if (t === T_KW && lx.word === "xref") return this.readTable(lx);
    if (t !== T_NUM) return null;
    const obj = this.parseIndirectAt(off, -1);
    if (!obj || !(obj.value instanceof PdfStream)) return null;
    const s = obj.value;
    if (nameOf(s.dict.get("Type")) !== "XRef") return null;
    this.readXrefStream(s);
    return s.dict;
  }

  /**
   * A classic table. Pass 1 only validates the subsections and finds the trailer; a hybrid
   * file's /XRefStm is then read (its entries must win); pass 2 re-lexes the entries straight
   * into the table. Nothing is held per entry while /XRefStm sections recurse (R-N3).
   */
  private readTable(lx: Lexer): PdfDict | null {
    const max = this.limits.maxObjects;
    const body = lx.pos;
    let total = 0;
    for (;;) {
      const save = lx.pos;
      const t = lx.next();
      if (t === T_KW && lx.word === "trailer") break;
      if (t !== T_NUM || !lx.isInt) {
        lx.pos = save;
        return null;
      }
      const start = lx.num;
      if (lx.next() !== T_NUM || !lx.isInt) return null;
      const count = lx.num;
      if (count < 0 || start < 0) return null;
      // a count above the cap or the bytes left is damage (or a lie): repair instead
      total += count;
      if (count > max || total > max) return null;
      if (count * 18 > this.buf.length - lx.pos + 18) return null;
      for (let i = 0; i < count; i++) {
        if (lx.next() !== T_NUM || lx.next() !== T_NUM || lx.next() !== T_KW) return null;
        if (lx.word !== "n" && lx.word !== "f") return null;
      }
    }
    const trailer = parseValue(lx, this.limits);
    if (!(trailer instanceof PdfDict)) return null;
    const xs = intOf(trailer.get("XRefStm"));
    if (xs !== null && this.enterSection(xs)) this.readSection(xs);
    // pass 2: the entries, validated above
    const ex = new Lexer(this.buf, body);
    for (;;) {
      if (ex.next() !== T_NUM) break; // `trailer`
      const start = ex.num;
      ex.next();
      const count = ex.num;
      for (let i = 0; i < count; i++) {
        ex.next();
        const offset = ex.num;
        ex.next();
        const gen = ex.num;
        ex.next();
        const num = start + i;
        // object 0 is always free; an offset-0 "in use" entry is a known writer bug
        if (ex.word === "f" || num === 0 || offset <= 0) this.setEntry(num, FREE);
        else this.setEntry(num, { type: 1, offset, gen, stream: 0, index: 0 });
      }
    }
    return trailer;
  }

  private readXrefStream(s: PdfStream): void {
    const d = s.dict;
    const w = d.get("W");
    if (!Array.isArray(w) || w.length < 3) this.malformed("an xref stream has no /W");
    const ws = w.slice(0, 3).map((x) => intOf(x) ?? -1);
    const [w0, w1, w2] = ws as [number, number, number];
    if (ws.some((x) => x < 0 || x > 8)) this.malformed("an xref stream has invalid /W widths");
    const row = w0 + w1 + w2;
    if (row === 0) return;
    const size = intOf(d.get("Size")) ?? 0;
    const idx = d.get("Index");
    const ranges: number[] = Array.isArray(idx) ? idx.map((x) => intOf(x) ?? -1) : [0, size];
    // xref streams are never encrypted
    const data = this.streamBytes(s, { encrypted: false, mode: "error" });
    let at = 0;
    const read = (n: number, dflt: number): number => {
      if (n === 0) return dflt;
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + (data[at++] as number);
      return v;
    };
    for (let r = 0; r + 1 < ranges.length; r += 2) {
      const start = ranges[r] as number;
      const count = ranges[r + 1] as number;
      if (start < 0 || count < 0) this.malformed("an xref stream has an invalid /Index");
      const rows = Math.min(count, Math.floor((data.length - at) / row));
      for (let i = 0; i < rows; i++) {
        const type = read(w0, 1);
        const f2 = read(w1, 0);
        const f3 = read(w2, 0);
        const num = start + i;
        if (type === 1) {
          this.setEntry(num, f2 > 0 ? { type: 1, offset: f2, gen: f3, stream: 0, index: 0 } : FREE);
        } else if (type === 2)
          this.setEntry(num, { type: 2, offset: 0, gen: 0, stream: f2, index: f3 });
        else this.setEntry(num, FREE);
      }
    }
  }

  // ---- repair ------------------------------------------------------------------------------

  /** Parses the dictionary of the object whose header is at `h`, bounded to `[h, end)`. */
  private headerDict(h: number, end: number): PdfDict | null {
    const lx = new Lexer(this.buf, h, end);
    if (lx.next() !== T_NUM || lx.next() !== T_NUM || lx.next() !== T_KW || lx.word !== "obj")
      return null;
    try {
      const v = parseValue(lx, this.limits);
      return v instanceof PdfDict ? v : null;
    } catch (e) {
      if (e instanceof PdfError) return null;
      throw e;
    }
  }

  /**
   * One pass over the file (ingestion §4.1) for `N G obj`, `endstream` and `trailer`. Stream
   * data is skipped (by a valid /Length, else to the next `endstream`), so objects of an
   * embedded file are never adopted.
   */
  private scan(): ScanResult {
    if (this.scanResult) return this.scanResult;
    const b = this.buf;
    const objs: [number, number, number][] = [];
    const trailers: number[] = [];
    const ends: number[] = [];
    const n = b.length;
    const bound = (c: number | undefined): boolean => c === undefined || isWs(c) || isDelimByte(c);
    let lastDictHeader = -1;
    /** [data start, object number of its /Length] for streams with an indirect length. */
    const pendingLens: [number, number][] = [];
    for (let i = 0; i + 3 <= n; i++) {
      const c = b[i] as number;
      if (c === 111 /* o */) {
        if (b[i + 1] !== 98 || b[i + 2] !== 106) continue;
        if (
          i + 3 < n &&
          !isWs(b[i + 3] as number) &&
          b[i + 3] !== 60 &&
          b[i + 3] !== 91 &&
          b[i + 3] !== 47 &&
          b[i + 3] !== 40
        )
          continue;
        // walk back: ws gen ws num
        let p = i - 1;
        if (p < 0 || !isWs(b[p] as number)) continue;
        while (p >= 0 && isWs(b[p] as number)) p--;
        const genEnd = p + 1;
        let digits = 0;
        while (p >= 0 && (b[p] as number) >= 48 && (b[p] as number) <= 57 && digits < 6) {
          p--;
          digits++;
        }
        if (digits === 0 || p < 0 || !isWs(b[p] as number)) continue;
        const gen = Number(latin1(b, p + 1, genEnd));
        while (p >= 0 && isWs(b[p] as number)) p--;
        const numEnd = p + 1;
        digits = 0;
        while (p >= 0 && (b[p] as number) >= 48 && (b[p] as number) <= 57 && digits < 11) {
          p--;
          digits++;
        }
        if (digits === 0 || (p >= 0 && !isWs(b[p] as number) && !isDelimByte(b[p] as number)))
          continue;
        const num = Number(latin1(b, p + 1, numEnd));
        if (!Number.isSafeInteger(num)) continue;
        if (objs.length >= this.limits.maxObjects) {
          throw new PdfError("pdf/too-complex", `more than ${this.limits.maxObjects} objects`);
        }
        objs.push([num, gen, p + 1]);
      } else if (c === 101 /* e */) {
        if (
          b[i + 1] === 110 &&
          b[i + 2] === 100 &&
          b[i + 3] === 115 &&
          indexOf(b, "endstream", i, i + 9) === i
        ) {
          ends.push(i);
          i += 8;
        }
      } else if (c === 116 /* t */) {
        if (
          b[i + 1] === 114 &&
          indexOf(b, "trailer", i, i + 7) === i &&
          bound(b[i - 1]) &&
          bound(b[i + 7])
        ) {
          trailers.push(i + 7);
          i += 6;
        }
      } else if (c === 115 /* s */) {
        if (b[i + 1] !== 116 || indexOf(b, "stream", i, i + 6) !== i) continue;
        const after = b[i + 6];
        if (after !== 10 && after !== 13) continue;
        const before = b[i - 1];
        if (before === undefined || (!isWs(before) && before !== 62)) continue;
        let start = i + 6;
        if (b[start] === 13 && b[start + 1] === 10) start += 2;
        else start += 1;
        // the stream's own /Length, when it lands on `endstream`
        const last = objs[objs.length - 1];
        let lenV: PdfValue | undefined;
        if (last && last[2] > lastDictHeader) {
          lastDictHeader = last[2];
          lenV = this.headerDict(last[2], i)?.get("Length");
        }
        if (lenV instanceof PdfRef) {
          // indirect: resolved after the pass (R-N4); meanwhile the data is scanned as usual
          pendingLens.push([start, lenV.num]);
          continue;
        }
        let skipTo = -1;
        const len = intOf(lenV);
        if (len !== null && len >= 0 && start + len <= n) skipTo = this.endstreamNear(start + len);
        if (skipTo < 0) skipTo = this.nextEndstreamFrom(start);
        if (skipTo < 0) continue; // no endstream after it: scanning resumes at the data (R-N7)
        ends.push(skipTo);
        i = skipTo + 8;
      }
    }
    if (pendingLens.length > 0) this.dropStreamData(pendingLens, objs, trailers, ends);
    this.endstreams = ends;
    this.scanResult = { objs, trailers };
    return this.scanResult;
  }

  private esFrom = -1;
  private esAt = -1;

  /** The first `endstream` at or after `p` (-1: none); repeated forward queries are O(1). */
  private nextEndstreamFrom(p: number): number {
    if (this.esFrom >= 0 && this.esFrom <= p && (this.esAt < 0 || this.esAt >= p)) return this.esAt;
    this.esFrom = p;
    this.esAt = indexOf(this.buf, "endstream", p);
    return this.esAt;
  }

  /**
   * Second step of the scan for streams whose /Length is indirect: the length object is looked
   * up among the headers found (at most 8 candidates each), and when the length lands on
   * `endstream` everything recorded inside the data (an embedded file's objects, trailers and
   * `endstream`s) is dropped. Linear: positions are sorted, intervals merged.
   */
  private dropStreamData(
    pending: [number, number][],
    objs: [number, number, number][],
    trailers: number[],
    ends: number[],
  ): void {
    const b = this.buf;
    const byNum = new Map<number, number[]>();
    for (const [num, , off] of objs) {
      let a = byNum.get(num);
      if (!a) byNum.set(num, (a = []));
      a.push(off);
    }
    const spans: [number, number][] = [];
    for (const [start, num] of pending) {
      const offs = byNum.get(num);
      if (!offs) continue;
      // candidates: headers after the data start first (the usual layout), then before it
      let lo = 0;
      let hi = offs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((offs[mid] as number) <= start) lo = mid + 1;
        else hi = mid;
      }
      const after = offs.slice(lo, lo + 8);
      const before = offs.slice(Math.max(0, lo - 8), lo).reverse();
      for (const h of [...after, ...before]) {
        const lx = new Lexer(b, h, Math.min(b.length, h + 64));
        if (lx.next() !== T_NUM || lx.next() !== T_NUM || lx.next() !== T_KW || lx.word !== "obj")
          continue;
        if (lx.next() !== T_NUM || !lx.isInt) continue;
        const len = lx.num;
        if (len < 0 || start + len > b.length) continue;
        const e = this.endstreamNear(start + len);
        if (e < 0) continue;
        spans.push([start, e]);
        break;
      }
    }
    if (spans.length === 0) return;
    spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const merged: [number, number][] = [];
    for (const sp of spans) {
      const top = merged[merged.length - 1];
      if (top && sp[0] <= top[1]) top[1] = Math.max(top[1], sp[1]);
      else merged.push([sp[0], sp[1]]);
    }
    const inside = (pos: number, k: { i: number }): boolean => {
      while (k.i < merged.length && (merged[k.i] as [number, number])[1] <= pos) k.i++;
      const m = merged[k.i];
      return m !== undefined && pos > m[0] && pos < m[1];
    };
    const keep = <T>(arr: T[], pos: (x: T) => number): void => {
      const k = { i: 0 };
      let w = 0;
      for (const x of arr) if (!inside(pos(x), k)) arr[w++] = x;
      arr.length = w;
    };
    keep(objs, (o) => o[2]);
    keep(trailers, (t) => t);
    keep(ends, (e) => e);
  }

  /** `endstream` within `MAX_GAP` whitespace bytes of `p`, or -1. */
  private endstreamNear(p: number): number {
    const b = this.buf;
    let q = p;
    while (q < b.length && q - p < MAX_GAP && isWs(b[q] as number)) q++;
    return indexOf(b, "endstream", q, q + 9) === q ? q : -1;
  }

  private repair(reason: string): void {
    if (this.rebuilt) return;
    this.rebuilt = true;
    this.note(`${reason}; rebuilt by scanning the file`);
    const { objs, trailers } = this.scan();
    this.entries.clear();
    this.cache.clear();
    this.objStms.clear();
    this.trailer = new PdfDict();
    this.headers = objs.map((o) => o[2]).sort((a, b) => a - b);
    // the last definition of an object wins
    const last = new Map<number, [number, number]>();
    for (const [num, gen, off] of objs) last.set(num, [gen, off]);
    for (const [num, [gen, off]] of [...last.entries()].sort((a, b) => a[0] - b[0])) {
      this.entries.set(num, { type: 1, offset: off, gen, stream: 0, index: 0 });
    }
    // the newest 64 trailers, each lexed only up to the next one (no byte is lexed twice)
    for (let i = trailers.length - 1; i >= Math.max(0, trailers.length - MAX_TRAILERS); i--) {
      const end = i + 1 < trailers.length ? (trailers[i + 1] as number) - 7 : this.buf.length;
      const lx = new Lexer(this.buf, trailers[i] as number, end);
      try {
        const t = parseValue(lx, this.limits);
        if (t instanceof PdfDict) this.mergeTrailer(t);
      } catch (e) {
        if (!(e instanceof PdfError) || e.code === "pdf/too-large") throw e;
      }
    }
    // object streams and xref-stream trailers, and a catalog if the trailer has none
    let catalog: number | null = null;
    const plain = [...this.entries.keys()];
    const xrefDicts: PdfDict[] = [];
    for (const num of plain) {
      let v: PdfValue | undefined;
      try {
        v = this.parseIndirectAt((this.entries.get(num) as Entry).offset, num)?.value;
      } catch (e) {
        if (e instanceof PdfError && (e.code === "pdf/malformed" || e.code === "pdf/too-complex"))
          continue;
        throw e;
      }
      const d = dictOf(v);
      if (!d) continue;
      const type = nameOf(d.get("Type"));
      if (type === "Catalog") catalog = num;
      else if (type === "XRef") xrefDicts.push(d);
      else if (type === "ObjStm" && v instanceof PdfStream) {
        let os: ObjStm | null = null;
        try {
          os = this.objStm(num, v);
        } catch (e) {
          if (!(e instanceof PdfError) || e.code === "pdf/too-large") throw e;
        }
        if (!os) continue;
        for (let index = 0; index < os.nums.length; index++) {
          const m = os.nums[index] as number;
          if (!this.entries.has(m))
            this.setEntry(m, { type: 2, offset: 0, gen: 0, stream: num, index });
        }
      }
    }
    for (let i = xrefDicts.length - 1; i >= 0; i--) this.mergeTrailer(xrefDicts[i] as PdfDict);
    if (!this.catalog() && catalog !== null) this.trailer.map.set("Root", new PdfRef(catalog, 0));
    this.cache.clear();
    this.objStms.clear();
  }

  // ---- objects -----------------------------------------------------------------------------

  /** First `endobj` at or after `pos` (file length if none). Each byte is searched once. */
  private nextEndobj(pos: number): number {
    const a = this.endobjs;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((a[mid] as number) < pos) lo = mid + 1;
      else hi = mid;
    }
    if (lo < a.length) return a[lo] as number;
    for (;;) {
      if (this.endobjFrontier >= this.buf.length) return this.buf.length;
      const at = indexOf(this.buf, "endobj", this.endobjFrontier);
      if (at < 0) {
        this.endobjFrontier = this.buf.length;
        return this.buf.length;
      }
      a.push(at);
      this.endobjFrontier = at + 6;
      if (at >= pos) return at;
    }
  }

  /** After repair: the next object header after `off` (file length if none). */
  private nextHeader(off: number): number {
    const h = this.headers;
    if (!h) return this.buf.length;
    let lo = 0;
    let hi = h.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((h[mid] as number) <= off) lo = mid + 1;
      else hi = mid;
    }
    return lo < h.length ? (h[lo] as number) : this.buf.length;
  }

  /** Parses `N G obj … endobj` at `off`; `expect` is the object number (-1: any). */
  private parseIndirectAt(off: number, expect: number): { num: number; value: PdfValue } | null {
    const b = this.buf;
    if (off < 0 || off >= b.length) return null;
    if (this.budget.lexed >= this.limits.maxLexedBytes) this.budget.chargeLex(1);
    const end = Math.min(this.nextEndobj(off), this.nextHeader(off));
    const lx = new Lexer(b, off, end);
    // every return path pays for what it lexed (R-N2)
    try {
      if (lx.next() !== T_NUM || !lx.isInt) return null;
      const num = lx.num;
      if (lx.next() !== T_NUM || !lx.isInt) return null;
      const gen = lx.num;
      if (lx.next() !== T_KW || lx.word !== "obj") return null;
      if (expect >= 0 && num !== expect) return null;
      const value = parseValue(lx, this.limits, true, this.countValue);
      if (value === undefined) return { num, value: null };
      const save = lx.pos;
      if (value instanceof PdfDict && lx.next() === T_KW && (lx.word as string) === "stream") {
        return { num, value: this.readStream(value, lx.pos, num, gen) };
      }
      lx.pos = save;
      return { num, value };
    } finally {
      this.budget.chargeLex(lx.pos - off); // lexed bytes, strings included
    }
  }

  private readonly countValue = (): void => this.budget.value();

  private readStream(dict: PdfDict, after: number, num: number, gen: number): PdfStream {
    const b = this.buf;
    let start = after;
    if (b[start] === 13 && b[start + 1] === 10) start += 2;
    else if (b[start] === 10 || b[start] === 13) start += 1;
    const lenV = dict.get("Length");
    let len = intOf(lenV instanceof PdfRef ? this.resolveLength(lenV) : lenV);
    if (len !== null && len >= 0 && start + len <= b.length) {
      if (this.endstreamNear(start + len) < 0) len = null;
    } else len = null;
    if (len === null) {
      // wrong /Length: the stream ends at the next `endstream` (repair scan, ingestion §4.1)
      this.note("a stream /Length is wrong");
      if (!this.endstreams) this.scan();
      const ends = this.endstreams as number[];
      let lo = 0;
      let hi = ends.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((ends[mid] as number) < start) lo = mid + 1;
        else hi = mid;
      }
      let end = lo < ends.length ? (ends[lo] as number) : b.length;
      if (end > start && b[end - 1] === 10) end--;
      if (end > start && b[end - 1] === 13) end--;
      len = end - start;
    }
    return new PdfStream(dict, b.subarray(start, start + len), num, gen);
  }

  /** An indirect /Length; nested look-ups (a length object that is itself a stream…) stop at 4. */
  private resolveLength(ref: PdfRef): PdfValue {
    if (this.lengthDepth >= 4) return null;
    this.lengthDepth++;
    try {
      const v = this.resolve(ref);
      return typeof v === "number" ? v : null;
    } finally {
      this.lengthDepth--;
    }
  }

  private objStm(num: number, s: PdfStream): ObjStm | null {
    if (this.objStms.has(num)) return this.objStms.get(num) as ObjStm | null;
    this.objStms.set(num, null); // guards re-entry
    const n = intOf(s.dict.get("N")) ?? -1;
    const first = intOf(s.dict.get("First")) ?? -1;
    if (n < 0 || first < 0) return null;
    if (n > this.limits.maxObjects) {
      throw new PdfError("pdf/too-complex", `an object stream holds ${n} objects`);
    }
    const data = this.streamBytes(s, { encrypted: true, mode: "error" });
    const lx = new Lexer(data, 0, Math.min(first, data.length));
    const nums: number[] = [];
    const offsets: number[] = [];
    const index = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (lx.next() !== T_NUM || !lx.isInt) break;
      const on = lx.num;
      if (lx.next() !== T_NUM || !lx.isInt) break;
      const off = lx.num;
      const prev = offsets[offsets.length - 1];
      if (off < 0 || (prev !== undefined && off <= prev) || first + off > data.length) {
        // duplicate or decreasing offsets would let every member re-parse the same bytes
        if (!this.warnedObjStm.has(num)) {
          this.warnedObjStm.add(num);
          this.diagnostics.push(
            diag(
              "warning",
              "pdf/malformed",
              `object stream ${num} has overlapping member offsets; it is ignored`,
              { object: num },
            ),
          );
        }
        return null;
      }
      if (!index.has(on)) index.set(on, nums.length);
      nums.push(on);
      offsets.push(off);
    }
    const os: ObjStm = { index, nums, offsets, data, first };
    this.objStms.set(num, os);
    return os;
  }

  private loadEntry(num: number, e: Entry): PdfValue {
    if (e.type === 1) {
      let r = this.parseIndirectAt(e.offset, num);
      if (!r && this.headerOffset > 0) r = this.parseIndirectAt(e.offset + this.headerOffset, num);
      if (!r) {
        if (this.rebuilt) return null;
        this.repair(`object ${num} is not at its cross-reference offset`);
        const e2 = this.entries.get(num);
        if (!e2 || e2.type === 0) return null;
        return this.loadEntry(num, e2);
      }
      return r.value;
    }
    if (e.type === 2) {
      // an object stream is itself a plain object: this bounds the nesting to one level
      if (this.entries.get(e.stream)?.type !== 1) return null;
      const sv = this.loadObject(e.stream);
      if (!(sv instanceof PdfStream)) return null;
      const os = this.objStm(e.stream, sv);
      if (!os) return null;
      const i = os.index.get(num);
      if (i === undefined) return null;
      // each member is parsed only within its own slice
      const start = os.first + (os.offsets[i] as number);
      const next = os.offsets[i + 1];
      const end = next === undefined ? os.data.length : os.first + next;
      if (this.budget.lexed >= this.limits.maxLexedBytes) this.budget.chargeLex(1);
      const lx = new Lexer(os.data, start, end);
      let v: PdfValue | undefined;
      try {
        v = parseValue(lx, this.limits, true, this.countValue);
      } finally {
        this.budget.chargeLex(lx.pos - start);
      }
      return v === undefined || v instanceof PdfStream ? null : v;
    }
    return null;
  }

  loadObject(num: number): PdfValue {
    if (this.cache.has(num)) return this.cache.get(num) as PdfValue;
    const e = this.entries.get(num);
    if (!e || e.type === 0) return null;
    if (this.resolving.has(num)) return null; // reference cycle
    this.resolving.add(num);
    this.loaded.add(num);
    let v: PdfValue;
    try {
      v = this.loadEntry(num, e);
      if (this.decryptor && e.type === 1 && num !== this.encryptNum) {
        this.decryptStrings(v, num, e.gen);
      }
    } catch (err) {
      if (err instanceof PdfError && err.code === "pdf/malformed") v = null;
      else throw err;
    } finally {
      this.resolving.delete(num);
    }
    this.cache.set(num, v);
    return v;
  }

  /** Decrypts every string inside `v` in place (explicit stack). */
  private decryptStrings(v: PdfValue, num: number, gen: number): void {
    const dec = this.decryptor as Decryptor;
    const stack: PdfValue[] = [v];
    while (stack.length > 0) {
      const x = stack.pop() as PdfValue;
      if (x instanceof PdfString) x.bytes = dec.decrypt(x.bytes, num, gen, "string");
      else if (Array.isArray(x)) for (const y of x) stack.push(y);
      else if (x instanceof PdfDict) for (const y of x.map.values()) stack.push(y);
      else if (x instanceof PdfStream) for (const y of x.dict.map.values()) stack.push(y);
    }
  }

  /** Resolves references (chains of up to 8). */
  resolve(v: PdfValue | undefined): PdfValue | undefined {
    for (let i = 0; i < 8 && v instanceof PdfRef; i++) v = this.loadObject(v.num);
    return v instanceof PdfRef ? null : v;
  }

  /**
   * Resolves to a dictionary without keeping anything else in the cache: a page-tree /Kids
   * entry that is an array or a string must not stay resident (R-N1).
   */
  resolveDictTransient(v: PdfValue | undefined): PdfDict | null {
    if (v instanceof PdfRef && !this.cache.has(v.num)) {
      const r = this.loadObject(v.num);
      if (r instanceof PdfDict) return r;
      this.cache.delete(v.num);
      return null;
    }
    return this.resolveDict(v);
  }

  resolveDict(v: PdfValue | undefined): PdfDict | null {
    const r = this.resolve(v);
    return r instanceof PdfDict ? r : null;
  }

  // ---- streams -----------------------------------------------------------------------------

  /** Decrypts and decodes a stream. Images pass `limit` (declared size) and "truncate". */
  streamBytes(s: PdfStream, o: DecodeOpts = {}): Uint8Array {
    return this.decodeStream(s, o).data;
  }

  decodeStream(
    s: PdfStream,
    o: DecodeOpts = {},
  ): { data: Uint8Array; jpeg: boolean; damaged: boolean } {
    const limit = o.limit ?? this.limits.maxStreamBytes;
    const mode = o.mode ?? "error";
    const key = `${mode}:${limit}:${o.encrypted !== false}`;
    const failed = this.failures.get(s)?.get(key);
    if (failed) throw failed;
    if (this.decodeDepth >= MAX_DECODE_DEPTH) {
      throw new PdfError("pdf/too-complex", "stream decodes nest too deeply", {
        ...(o.where ?? {}),
        scope: "depth",
      });
    }
    this.decodeDepth++;
    try {
      let filters = filterList(
        s.dict.get("Filter"),
        s.dict.get("DecodeParms"),
        (v) => this.resolve(v),
        this.limits.maxFilters + 1,
      );
      // an Identity /Crypt filter (the default name) means: this stream is not encrypted
      let encrypted = o.encrypted !== false && s.num >= 0;
      if (filters[0]?.name === "Crypt") {
        const p = filters[0].parms;
        const name = p instanceof PdfDict ? nameOf(this.resolve(p.get("Name"))) : null;
        if (name === null || name === "Identity") {
          encrypted = false;
          filters = filters.slice(1);
        }
      }
      let raw = s.raw;
      if (this.decryptor && encrypted && this.decryptor.method("stream") !== "none") {
        const cached = this.decrypted.get(s);
        if (cached) raw = cached;
        else if (
          this.decryptor.method("stream") === "rc4" &&
          filters.length === 0 &&
          limit < raw.length
        ) {
          // a stream cipher: only the prefix the caller can use is decrypted
          this.budget.charge(limit, o.where ?? {});
          raw = this.decryptor.decrypt(raw.subarray(0, limit), s.num, s.gen, "stream");
        } else {
          this.budget.charge(raw.length, o.where ?? {});
          raw = this.decryptor.decrypt(raw, s.num, s.gen, "stream");
          this.decrypted.set(s, raw);
        }
      }
      return decodeFilters(raw, filters, {
        limit,
        mode,
        limits: this.limits,
        budget: this.budget,
        where: o.where ?? {},
      });
    } catch (e) {
      // depth and per-command budget failures depend on the path, not the stream: not cached
      const scope = e instanceof PdfError ? e.where.scope : undefined;
      if (
        e instanceof PdfError &&
        scope !== "total" &&
        scope !== "depth" &&
        scope !== "values" &&
        scope !== "lexed"
      ) {
        let m = this.failures.get(s);
        if (!m) this.failures.set(s, (m = new Map()));
        m.set(key, e);
      }
      throw e;
    } finally {
      this.decodeDepth--;
    }
  }

  /** Filter names of a stream (resolved), for listings. */
  filterNames(s: PdfStream | PdfDict): string[] {
    const d = s instanceof PdfStream ? s.dict : s;
    return filterList(
      d.get("Filter"),
      d.get("DecodeParms"),
      (v) => this.resolve(v),
      this.limits.maxFilters + 1,
    ).map((f) => f.name);
  }

  /** `/Info` `/Producer` as text (the only `/Info` entry read). */
  producer(): string | null {
    const info = this.resolveDict(this.trailer.get("Info"));
    const p = info ? this.resolve(info.get("Producer")) : undefined;
    return p instanceof PdfString ? textString(p.bytes) : null;
  }
}

const isDelimByte = (c: number): boolean =>
  c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 47 || c === 37;

/** True for C0/C1 controls and bidirectional formatting characters (never shown raw). */
export function isControl(c: number): boolean {
  return (
    c < 32 ||
    (c >= 0x7f && c < 0xa0) ||
    c === 0x061c ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0xfeff ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

/** Decodes a PDF text string (UTF-16BE with BOM, UTF-8 with BOM, else PDFDocEncoding ≈ Latin-1). */
export function textString(bytes: Uint8Array, max = 1024): string {
  const b = bytes.subarray(0, max * 4 + 3);
  let s: string;
  if (b[0] === 0xfe && b[1] === 0xff) {
    s = "";
    for (let i = 2; i + 1 < b.length; i += 2)
      s += String.fromCharCode(((b[i] as number) << 8) | (b[i + 1] as number));
  } else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    s = new TextDecoder("utf-8", { fatal: false }).decode(b.subarray(3));
  } else s = latin1(b);
  let out = "";
  for (const ch of s) {
    if (isControl(ch.codePointAt(0) as number)) continue;
    out += ch;
    if (out.length >= max) break;
  }
  return out;
}
