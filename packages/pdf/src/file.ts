/**
 * Cross-reference tables and streams, `/Prev` chains, object streams, incremental updates and
 * repair (ingestion §4.1). Objects are loaded lazily and cached; references are resolved with
 * a cycle guard. Linearization hint tables are never read.
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
  readonly nums: number[];
  readonly offsets: number[];
  readonly data: Uint8Array;
  readonly first: number;
}

const FREE: Entry = { type: 0, offset: 0, gen: 0, stream: 0, index: 0 };

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
  private scanResult: { objs: [number, number][]; trailers: number[] } | null = null;
  /** The table was rebuilt by `repair` (it runs at most once). */
  private rebuilt = false;

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
        ((b[e] as number) === 46 || ((b[e] as number) >= 48 && (b[e] as number) <= 57))
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

  /** Follows startxref and the /Prev chain. Returns false when it is unusable. */
  private readXrefChain(): boolean {
    const b = this.buf;
    const sx = lastIndexOf(b, "startxref", Math.max(0, b.length - 2048), b.length);
    if (sx < 0) return false;
    const lx = new Lexer(b, sx + 9);
    if (lx.next() !== T_NUM || !lx.isInt) return false;
    const queue: number[] = [lx.num];
    const seen = new Set<number>();
    let sections = 0;
    while (queue.length > 0) {
      const off = queue.shift() as number;
      if (seen.has(off)) continue; // /Prev cycle
      seen.add(off);
      if (++sections > this.limits.maxXrefSections) {
        // ingestion §4.6: ≤ 64 sections; past that the file is rebuilt by the one-pass scan
        this.diagnostics.push(
          diag(
            "warning",
            "pdf/too-complex",
            `more than ${this.limits.maxXrefSections} cross-reference sections; the rest are not followed`,
          ),
        );
        return false;
      }
      const trailer = this.readSection(off) ?? this.readSection(off + this.headerOffset);
      if (!trailer) return false;
      this.mergeTrailer(trailer);
      const prev = intOf(trailer.get("Prev"));
      if (prev !== null) queue.push(prev);
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
    lx.pos = off;
    const obj = this.parseIndirectAt(off, -1);
    if (!obj || !(obj.value instanceof PdfStream)) return null;
    const s = obj.value;
    if (nameOf(s.dict.get("Type")) !== "XRef") return null;
    this.readXrefStream(s);
    return s.dict;
  }

  private readTable(lx: Lexer): PdfDict | null {
    // pending entries of this section; the XRefStm of a hybrid file must win over them
    const pending: [number, Entry][] = [];
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
      if (count > this.limits.maxObjects) {
        throw new PdfError("pdf/too-complex", `an xref subsection declares ${count} entries`);
      }
      if (count * 18 > this.buf.length - lx.pos + 18) return null; // lying count: repair
      for (let i = 0; i < count; i++) {
        if (lx.next() !== T_NUM) return null;
        const offset = lx.num;
        if (lx.next() !== T_NUM) return null;
        const gen = lx.num;
        if (lx.next() !== T_KW) return null;
        const kind = lx.word;
        const num = start + i;
        if (kind === "n") pending.push([num, { type: 1, offset, gen, stream: 0, index: 0 }]);
        else if (kind === "f") pending.push([num, FREE]);
        else return null;
      }
    }
    const trailer = parseValue(lx, this.limits);
    if (!(trailer instanceof PdfDict)) return null;
    const xs = intOf(trailer.get("XRefStm"));
    if (xs !== null) this.readSection(xs);
    for (const [num, e] of pending) {
      // object 0 is always free; an offset-0 "in use" entry is a known writer bug
      if (num === 0 || (e.type === 1 && e.offset <= 0)) this.setEntry(num, FREE);
      else this.setEntry(num, e);
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

  /** One pass over the file for `N G obj`, `endstream` and `trailer` (ingestion §4.1). */
  private scan(): { objs: [number, number][]; trailers: number[] } {
    if (this.scanResult) return this.scanResult;
    const b = this.buf;
    const objs: [number, number][] = [];
    const trailers: number[] = [];
    const ends: number[] = [];
    const n = b.length;
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
        let digits = 0;
        while (p >= 0 && (b[p] as number) >= 48 && (b[p] as number) <= 57 && digits < 6) {
          p--;
          digits++;
        }
        if (digits === 0 || p < 0 || !isWs(b[p] as number)) continue;
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
        objs.push([num, p + 1]);
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
        if (b[i + 1] === 114 && indexOf(b, "trailer", i, i + 7) === i) trailers.push(i + 7);
      }
    }
    this.endstreams = ends;
    this.scanResult = { objs, trailers };
    return this.scanResult;
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
    // the last definition of an object wins
    const last = new Map<number, number>();
    for (const [num, off] of objs) last.set(num, off);
    for (const [num, off] of [...last.entries()].sort((a, b) => a[0] - b[0])) {
      this.entries.set(num, { type: 1, offset: off, gen: 0, stream: 0, index: 0 });
    }
    // trailers, newest (last in the file) first
    for (let i = trailers.length - 1; i >= 0; i--) {
      const lx = new Lexer(this.buf, trailers[i] as number);
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
        os.nums.forEach((n, index) => {
          if (!this.entries.has(n))
            this.setEntry(n, { type: 2, offset: 0, gen: 0, stream: num, index });
        });
      }
    }
    for (let i = xrefDicts.length - 1; i >= 0; i--) this.mergeTrailer(xrefDicts[i] as PdfDict);
    if (!this.catalog() && catalog !== null) this.trailer.map.set("Root", new PdfRef(catalog, 0));
    this.cache.clear();
    this.objStms.clear();
  }

  // ---- objects -----------------------------------------------------------------------------

  /** Parses `N G obj … endobj` at `off`; `expect` is the object number (-1: any). */
  private parseIndirectAt(off: number, expect: number): { num: number; value: PdfValue } | null {
    const b = this.buf;
    if (off < 0 || off >= b.length) return null;
    const lx = new Lexer(b, off);
    if (lx.next() !== T_NUM || !lx.isInt) return null;
    const num = lx.num;
    if (lx.next() !== T_NUM || !lx.isInt) return null;
    const gen = lx.num;
    if (lx.next() !== T_KW || lx.word !== "obj") return null;
    if (expect >= 0 && num !== expect) return null;
    const value = parseValue(lx, this.limits);
    if (value === undefined) return { num, value: null };
    const save = lx.pos;
    if (value instanceof PdfDict && lx.next() === T_KW && (lx.word as string) === "stream") {
      return { num, value: this.readStream(value, lx.pos, num, gen) };
    }
    lx.pos = save;
    return { num, value };
  }

  private readStream(dict: PdfDict, after: number, num: number, gen: number): PdfStream {
    const b = this.buf;
    let start = after;
    if (b[start] === 13 && b[start + 1] === 10) start += 2;
    else if (b[start] === 10 || b[start] === 13) start += 1;
    const lenV = dict.get("Length");
    let len = intOf(lenV instanceof PdfRef ? this.resolveLength(lenV) : lenV);
    if (len !== null && len >= 0 && start + len <= b.length) {
      let p = start + len;
      while (p < b.length && isWs(b[p] as number)) p++;
      if (indexOf(b, "endstream", p, p + 9) !== p) len = null;
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

  private lengthDepth = 0;

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
    for (let i = 0; i < n; i++) {
      if (lx.next() !== T_NUM) break;
      const on = lx.num;
      if (lx.next() !== T_NUM) break;
      nums.push(on);
      offsets.push(lx.num);
    }
    const os: ObjStm = { nums, offsets, data, first };
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
      {
        const sv = this.loadObject(e.stream);
        if (!(sv instanceof PdfStream)) return null;
        const os = this.objStm(e.stream, sv);
        if (!os) return null;
        let i = os.nums[e.index] === num ? e.index : os.nums.indexOf(num);
        if (i < 0) i = e.index;
        const rel = os.offsets[i];
        if (rel === undefined) return null;
        const lx = new Lexer(os.data, os.first + rel);
        const v = parseValue(lx, this.limits);
        return v === undefined || v instanceof PdfStream ? null : v;
      }
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

  resolveDict(v: PdfValue | undefined): PdfDict | null {
    const r = this.resolve(v);
    return r instanceof PdfDict ? r : null;
  }

  // ---- streams -----------------------------------------------------------------------------

  /** Decrypts and decodes a stream. Images pass `limit` (declared size) and "truncate". */
  streamBytes(
    s: PdfStream,
    o: { encrypted?: boolean; limit?: number; mode?: CapMode; where?: Where } = {},
  ): Uint8Array {
    return this.decodeStream(s, o).data;
  }

  decodeStream(
    s: PdfStream,
    o: { encrypted?: boolean; limit?: number; mode?: CapMode; where?: Where } = {},
  ): { data: Uint8Array; jpeg: boolean; damaged: boolean } {
    let raw = s.raw;
    if (this.decryptor && o.encrypted !== false && s.num >= 0) {
      raw = this.decryptor.decrypt(raw, s.num, s.gen, "stream");
    }
    const filters = filterList(s.dict.get("Filter"), s.dict.get("DecodeParms"), (v) =>
      this.resolve(v),
    );
    return decodeFilters(raw, filters, {
      limit: o.limit ?? this.limits.maxStreamBytes,
      mode: o.mode ?? "error",
      limits: this.limits,
      budget: this.budget,
      where: o.where ?? {},
    });
  }

  /** Filter names of a stream (resolved), for listings. */
  filterNames(s: PdfStream | PdfDict): string[] {
    const d = s instanceof PdfStream ? s.dict : s;
    return filterList(d.get("Filter"), d.get("DecodeParms"), (v) => this.resolve(v)).map(
      (f) => f.name,
    );
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
    const c = ch.codePointAt(0) as number;
    if (c < 32 || (c >= 0x7f && c < 0xa0)) continue;
    out += ch;
    if (out.length >= max) break;
  }
  return out;
}
