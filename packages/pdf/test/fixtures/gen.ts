/**
 * Synthetic PDF fixtures (ingestion §12), written byte by byte by this script; nothing binary
 * is committed and no third-party document is used. Encoders here (JPEG, LZW, RunLength,
 * ASCII85, PNG predictors, the standard security handler) are written independently of the
 * parser so a shared misunderstanding cannot hide behind a round trip; `write-fixtures.test.ts`
 * writes them to disk (only when PDF_FIXTURES_OUT is set) for checking with other readers.
 */
import { createCipheriv, createHash } from "node:crypto";
import { zlibSync } from "fflate";

// ---- bytes ---------------------------------------------------------------------------------

export const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const md5 = (...p: Uint8Array[]): Uint8Array => {
  const h = createHash("md5");
  for (const x of p) h.update(x);
  return new Uint8Array(h.digest());
};
const sha = (alg: string, ...p: Uint8Array[]): Uint8Array => {
  const h = createHash(alg);
  for (const x of p) h.update(x);
  return new Uint8Array(h.digest());
};

/** Deterministic PRNG (mulberry32). */
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

// ---- encoders ------------------------------------------------------------------------------

export const flate = (b: Uint8Array): Uint8Array => zlibSync(b, { level: 9 });

/** PNG-predictor encoding (Predictor 10–15): `types[r]` is the filter of row r. */
export function pngPredict(
  data: Uint8Array,
  rowBytes: number,
  bpp: number,
  types: number[],
): Uint8Array {
  const rows = data.length / rowBytes;
  const out = new Uint8Array(rows * (rowBytes + 1));
  for (let r = 0; r < rows; r++) {
    const t = types[r % types.length] as number;
    out[r * (rowBytes + 1)] = t;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[r * rowBytes + i] as number;
      const a = i >= bpp ? (data[r * rowBytes + i - bpp] as number) : 0;
      const b = r > 0 ? (data[(r - 1) * rowBytes + i] as number) : 0;
      const c = r > 0 && i >= bpp ? (data[(r - 1) * rowBytes + i - bpp] as number) : 0;
      let pred = 0;
      if (t === 1) pred = a;
      else if (t === 2) pred = b;
      else if (t === 3) pred = (a + b) >> 1;
      else if (t === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[r * (rowBytes + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  return out;
}

/** TIFF predictor 2 for 8-bit samples. */
export function tiffPredict(data: Uint8Array, rowBytes: number, colors: number): Uint8Array {
  const out = data.slice();
  for (let r = 0; r < data.length / rowBytes; r++) {
    for (let i = rowBytes - 1; i >= colors; i--) {
      const o = r * rowBytes + i;
      out[o] = ((data[o] as number) - (data[o - colors] as number)) & 0xff;
    }
  }
  return out;
}

export function lzwEncode(data: Uint8Array, earlyChange = 1): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let nbits = 0;
  let width = 9;
  const write = (code: number): void => {
    acc = (acc << width) | code;
    nbits += width;
    while (nbits >= 8) {
      out.push((acc >>> (nbits - 8)) & 0xff);
      nbits -= 8;
    }
    acc &= (1 << nbits) - 1;
  };
  let dict = new Map<number, number>();
  let next = 258;
  write(256);
  let w = -1;
  const bump = (): void => {
    next++;
    // the decoder adds its entry one code later: it widens when (next-1)+earlyChange hits 2^w
    if (next - 1 + earlyChange >= 1 << width && width < 12) width++;
  };
  for (const b of data) {
    if (w < 0) {
      w = b;
      continue;
    }
    const key = w * 256 + b;
    const hit = dict.get(key);
    if (hit !== undefined) {
      w = hit;
      continue;
    }
    write(w);
    dict.set(key, next);
    bump();
    w = b;
    if (next >= 4000) {
      write(w);
      write(256);
      dict = new Map();
      next = 258;
      width = 9;
      w = -1;
    }
  }
  if (w >= 0) {
    write(w);
    bump();
  }
  write(257);
  if (nbits > 0) out.push((acc << (8 - nbits)) & 0xff);
  return Uint8Array.from(out);
}

export function runLengthEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    let run = 1;
    while (i + run < data.length && data[i + run] === data[i] && run < 128) run++;
    if (run >= 3) {
      out.push(257 - run, data[i] as number);
      i += run;
      continue;
    }
    let j = i;
    const lit: number[] = [];
    while (j < data.length && lit.length < 128) {
      if (j + 2 < data.length && data[j] === data[j + 1] && data[j] === data[j + 2]) break;
      lit.push(data[j++] as number);
    }
    out.push(lit.length - 1, ...lit);
    i = j;
  }
  out.push(128);
  return Uint8Array.from(out);
}

export function ascii85Encode(data: Uint8Array): Uint8Array {
  let s = "";
  for (let i = 0; i < data.length; i += 4) {
    const n = Math.min(4, data.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? (data[i + k] as number) : 0);
    if (n === 4 && v === 0) {
      s += "z";
      continue;
    }
    const d: string[] = [];
    for (let k = 0; k < 5; k++) {
      d.unshift(String.fromCharCode(33 + (v % 85)));
      v = Math.floor(v / 85);
    }
    s += d.slice(0, n + 1).join("");
    if (i % 40 === 36) s += "\n";
  }
  return bytes(`${s}~>`);
}

export const asciiHexEncode = (data: Uint8Array): Uint8Array => bytes(`${hex(data)}>`);

/** A raw DEFLATE stream (zlib-wrapped) of `size` zero bytes using fixed-Huffman matches. */
export function zeroBomb(size: number): Uint8Array {
  const out: number[] = [0x78, 0x01];
  let acc = 0;
  let n = 0;
  const bits = (v: number, len: number): void => {
    acc |= v << n;
    n += len;
    while (n >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      n -= 8;
    }
  };
  const huff = (code: number, len: number): void => {
    // Huffman codes are written MSB first
    let r = 0;
    for (let i = 0; i < len; i++) r |= ((code >> i) & 1) << (len - 1 - i);
    bits(r, len);
  };
  bits(1, 1); // BFINAL
  bits(1, 2); // fixed Huffman
  huff(0x30, 8); // literal 0
  let left = size - 1;
  while (left >= 258) {
    huff(0xc5, 8); // length code 285 (258 bytes): 11000101
    huff(0, 5); // distance code 0 (1)
    left -= 258;
  }
  while (left-- > 0) huff(0x30, 8);
  huff(0, 7); // end of block (256)
  if (n > 0) out.push(acc & 0xff);
  return Uint8Array.from(out);
}

/** Baseline JPEG of a flat colour: DC-only coefficients, standard DC table, EOB-only AC table. */
export function flatJpeg(
  w: number,
  h: number,
  rgb: [number, number, number],
  opts: { gray?: boolean; icc?: boolean } = {},
): Uint8Array {
  const [r, g, b] = rgb;
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const comps = opts.gray
    ? [clamp(0.299 * r + 0.587 * g + 0.114 * b)]
    : [
        clamp(0.299 * r + 0.587 * g + 0.114 * b),
        clamp(128 - 0.168736 * r - 0.331264 * g + 0.5 * b),
        clamp(128 + 0.5 * r - 0.418688 * g - 0.081312 * b),
      ];
  const seg = (m: number, payload: number[]): number[] => [
    0xff,
    m,
    (payload.length + 2) >> 8,
    (payload.length + 2) & 0xff,
    ...payload,
  ];
  const dcBits = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
  const dcVals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  // canonical codes of the DC table
  const dcCode: [number, number][] = [];
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < (dcBits[len - 1] as number); i++)
      dcCode[dcVals[k++] as number] = [code++, len];
    code <<= 1;
  }
  const data: number[] = [];
  let acc = 0;
  let n = 0;
  const put = (v: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) {
      acc = (acc << 1) | ((v >> i) & 1);
      if (++n === 8) {
        data.push(acc);
        if (acc === 0xff) data.push(0);
        acc = 0;
        n = 0;
      }
    }
  };
  const mcus = Math.ceil(w / 8) * Math.ceil(h / 8);
  for (let m = 0; m < mcus; m++) {
    comps.forEach((val) => {
      const diff = m === 0 ? val - 128 : 0; // quant 8: DC = 8(v-128)/8
      const cat = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1;
      const [c, l] = dcCode[cat] as [number, number];
      put(c, l);
      if (cat > 0) put(diff > 0 ? diff : diff + (1 << cat) - 1, cat);
      put(0, 1); // AC: EOB
    });
  }
  if (n > 0) put(0xff, 8 - n);
  const nc = comps.length;
  return Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xe0, [...bytes("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(opts.icc ? seg(0xe2, [...bytes("ICC_PROFILE\0"), 1, 1, ...bytes("SYNTHETIC")]) : []),
    ...seg(0xdb, [0, ...new Array<number>(64).fill(8)]),
    ...seg(0xc0, [
      8,
      h >> 8,
      h & 0xff,
      w >> 8,
      w & 0xff,
      nc,
      ...comps.flatMap((_, i) => [i + 1, 0x11, 0]),
    ]),
    ...seg(0xc4, [0x00, ...dcBits, ...dcVals]),
    ...seg(0xc4, [0x10, 1, ...new Array<number>(15).fill(0), 0x00]),
    ...seg(0xda, [nc, ...comps.flatMap((_, i) => [i + 1, 0x00]), 0, 63, 0]),
    ...data,
    0xff,
    0xd9,
  ]);
}

// ---- standard security handler (encryption side) -------------------------------------------

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const S = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + (S[i] as number) + (key[i % key.length] as number)) % 256;
    [S[i], S[j]] = [S[j] as number, S[i] as number];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) % 256;
    j = (j + (S[i] as number)) % 256;
    [S[i], S[j]] = [S[j] as number, S[i] as number];
    out[n] = (data[n] as number) ^ (S[((S[i] as number) + (S[j] as number)) % 256] as number);
  }
  return out;
}

function aes(
  bits: 128 | 256,
  key: Uint8Array,
  iv: Uint8Array | null,
  data: Uint8Array,
  pad: boolean,
): Uint8Array {
  const c = createCipheriv(iv ? `aes-${bits}-cbc` : `aes-${bits}-ecb`, key, iv);
  c.setAutoPadding(pad);
  return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
}

function hash2B(pw: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let K = sha("sha256", pw, salt, udata);
  let round = 0;
  let E: Uint8Array = new Uint8Array(0);
  while (round < 64 || (E[E.length - 1] as number) > round - 32) {
    const K1 = cat(...Array.from({ length: 64 }, () => cat(pw, K, udata)));
    E = aes(128, K.slice(0, 16), K.slice(16, 32), K1, false);
    const mod = E.slice(0, 16).reduce((s, x) => s + x, 0) % 3;
    K = sha(["sha256", "sha384", "sha512"][mod] as string, E);
    round++;
  }
  return K.slice(0, 32);
}

export type CryptKind = "rc4-40" | "rc4-128" | "rc4-v4" | "aes-128" | "aes-256-r5" | "aes-256-r6";

export interface CryptConfig {
  readonly kind: CryptKind;
  /** Non-empty: the file needs this user password (the parser must refuse it). */
  readonly userPassword?: string;
  readonly encryptMetadata?: boolean;
  /** Permission flags (/P). */
  readonly p?: number;
}

export const FILE_ID = md5(bytes("platformcosmo synthetic fixture"));

export class Security {
  readonly key: Uint8Array;
  readonly dict: string;
  readonly method: "rc4" | "aesv2" | "aesv3";
  constructor(readonly cfg: CryptConfig) {
    const p = cfg.p ?? -3904;
    const pw = bytes(cfg.userPassword ?? "");
    const em = cfg.encryptMetadata !== false;
    const pb = Uint8Array.from([p & 255, (p >> 8) & 255, (p >> 16) & 255, (p >>> 24) & 255]);
    if (cfg.kind === "aes-256-r5" || cfg.kind === "aes-256-r6") {
      const r6 = cfg.kind === "aes-256-r6";
      this.method = "aesv3";
      this.key = sha("sha256", bytes("file key"));
      const vsalt = bytes("vsalt-01");
      const ksalt = bytes("ksalt-02");
      const h = (s: Uint8Array): Uint8Array =>
        r6 ? hash2B(pw, s, new Uint8Array(0)) : sha("sha256", pw, s);
      const U = cat(h(vsalt), vsalt, ksalt);
      const UE = aes(256, h(ksalt), new Uint8Array(16), this.key, false);
      const O = cat(sha("sha256", bytes("owner")), bytes("osalt-01osalt-02"));
      const OE = sha("sha256", bytes("owner key"));
      const perms = aes(
        256,
        this.key,
        null,
        cat(
          pb,
          Uint8Array.from([255, 255, 255, 255]),
          bytes(em ? "T" : "F"),
          bytes("adb"),
          bytes("0000"),
        ),
        false,
      );
      this.dict =
        `<< /Filter /Standard /V 5 /R ${r6 ? 6 : 5} /Length 256 /P ${p} /O <${hex(O)}> /U <${hex(U)}> ` +
        `/OE <${hex(OE)}> /UE <${hex(UE)}> /Perms <${hex(perms)}>` +
        `${em ? "" : " /EncryptMetadata false"} /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF >>`;
      return;
    }
    const v = cfg.kind === "rc4-40" ? 1 : cfg.kind === "rc4-128" ? 2 : 4;
    const r = cfg.kind === "rc4-40" ? 2 : cfg.kind === "rc4-128" ? 3 : 4;
    const n = cfg.kind === "rc4-40" ? 5 : 16;
    this.method = cfg.kind === "aes-128" ? "aesv2" : "rc4";
    const padded = cat(pw, PAD).slice(0, 32);
    const O = cat(md5(bytes("owner")), md5(bytes("owner2")));
    let k = md5(
      padded,
      O,
      pb,
      FILE_ID,
      r >= 4 && !em ? Uint8Array.from([255, 255, 255, 255]) : new Uint8Array(0),
    );
    if (r >= 3) for (let i = 0; i < 50; i++) k = md5(k.slice(0, n));
    this.key = k.slice(0, n);
    let U: Uint8Array;
    if (r === 2) U = rc4(this.key, PAD);
    else {
      let x = rc4(this.key, md5(PAD, FILE_ID));
      for (let i = 1; i <= 19; i++)
        x = rc4(
          this.key.map((b) => b ^ i),
          x,
        );
      U = cat(x, new Uint8Array(16));
    }
    const base = `/Filter /Standard /V ${v} /R ${r} /P ${p} /O <${hex(O)}> /U <${hex(U)}>`;
    if (v === 1) this.dict = `<< ${base} >>`;
    else if (v === 2) this.dict = `<< ${base} /Length 128 >>`;
    else {
      const cfm = cfg.kind === "aes-128" ? "AESV2" : "V2";
      this.dict =
        `<< ${base} /Length 128${em ? "" : " /EncryptMetadata false"} ` +
        `/CF << /StdCF << /CFM /${cfm} /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF >>`;
    }
  }

  encrypt(num: number, gen: number, data: Uint8Array): Uint8Array {
    if (this.method === "aesv3") {
      const iv = md5(bytes(`iv ${num}`));
      return cat(iv, aes(256, this.key, iv, data, true));
    }
    const ext = Uint8Array.from([
      num & 255,
      (num >> 8) & 255,
      (num >> 16) & 255,
      gen & 255,
      (gen >> 8) & 255,
    ]);
    const salt = this.method === "aesv2" ? bytes("sAlT") : new Uint8Array(0);
    const k = md5(this.key, ext, salt).slice(0, Math.min(this.key.length + 5, 16));
    if (this.method === "rc4") return rc4(k, data);
    const iv = md5(bytes(`iv ${num}`));
    return cat(iv, aes(128, k, iv, data, true));
  }
}

// ---- writer --------------------------------------------------------------------------------

export type StrFn = (s: string | Uint8Array) => string;

export interface ObjOpts {
  /** Text written for /Length instead of the true length (a wrong length, a reference). */
  readonly length?: string;
  /** Never encrypted (xref streams, or a deliberately plain object). */
  readonly plain?: boolean;
}

export class PdfWriter {
  private parts: Uint8Array[] = [];
  private size = 0;
  readonly offsets = new Map<number, number>();
  readonly inStm = new Map<number, [number, number]>();
  lastXref = -1;

  constructor(
    readonly sec: Security | null = null,
    header = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n",
  ) {
    this.raw(header);
  }

  get length(): number {
    return this.size;
  }

  raw(s: string | Uint8Array): number {
    const b = typeof s === "string" ? bytes(s) : s;
    const at = this.size;
    this.parts.push(b);
    this.size += b.length;
    return at;
  }

  /** A string token for object `num`: hex, encrypted when the file is. */
  str(num: number, s: string | Uint8Array, plain = false): string {
    const b = typeof s === "string" ? bytes(s) : s;
    return `<${hex(this.sec && !plain ? this.sec.encrypt(num, 0, b) : b)}>`;
  }

  obj(
    num: number,
    body: string | ((s: StrFn) => string),
    data?: Uint8Array,
    o: ObjOpts = {},
  ): this {
    const at = this.raw(`${num} 0 obj\n`);
    this.offsets.set(num, at);
    const text = typeof body === "string" ? body : body((s) => this.str(num, s, o.plain));
    if (data) {
      const enc = this.sec && !o.plain ? this.sec.encrypt(num, 0, data) : data;
      const len = o.length ?? String(enc.length);
      this.raw(text.replace("<<", `<< /Length ${len}`));
      this.raw("\nstream\n");
      this.raw(enc);
      this.raw("\nendstream\nendobj\n");
    } else this.raw(`${text}\nendobj\n`);
    return this;
  }

  /** An object stream holding `members` (bodies with plain strings). */
  objStm(num: number, members: [number, string][]): this {
    let head = "";
    let body = "";
    members.forEach(([n, b], i) => {
      head += `${n} ${body.length} `;
      body += `${b}\n`;
      this.inStm.set(n, [num, i]);
    });
    const data = bytes(head + body);
    return this.obj(
      num,
      `<< /Type /ObjStm /N ${members.length} /First ${head.length} /Filter /FlateDecode >>`,
      flate(data),
    );
  }

  /** A classic xref table for `nums` (all written objects by default) and the trailer. */
  xref(trailer: string, o: { prev?: number; nums?: number[]; startxref?: number } = {}): this {
    const nums = (o.nums ?? [...this.offsets.keys()]).slice().sort((a, b) => a - b);
    const at = this.raw("xref\n");
    const full = o.nums === undefined;
    const max = nums.length ? (nums[nums.length - 1] as number) : 0;
    const entry = (n: number): string => {
      const off = this.offsets.get(n);
      return off === undefined
        ? "0000000000 65535 f \n"
        : `${String(off).padStart(10, "0")} 00000 n \n`;
    };
    if (full) {
      let s = `0 ${max + 1}\n0000000000 65535 f \n`;
      for (let n = 1; n <= max; n++) s += entry(n);
      this.raw(s);
    } else {
      // consecutive runs
      let i = 0;
      while (i < nums.length) {
        let j = i;
        while (j + 1 < nums.length && (nums[j + 1] as number) === (nums[j] as number) + 1) j++;
        let s = `${nums[i]} ${j - i + 1}\n`;
        for (let k = i; k <= j; k++) s += entry(nums[k] as number);
        this.raw(s);
        i = j + 1;
      }
    }
    const prev = o.prev !== undefined ? ` /Prev ${o.prev}` : "";
    this.raw(
      `trailer\n<< /Size ${max + 1}${prev} ${trailer} >>\nstartxref\n${o.startxref ?? at}\n%%EOF\n`,
    );
    this.lastXref = at;
    return this;
  }

  /** A cross-reference stream (W [1 4 2]) covering every object, then startxref. */
  xrefStream(num: number, trailer: string, o: { prev?: number } = {}): this {
    const all = new Set<number>([...this.offsets.keys(), ...this.inStm.keys(), num]);
    const max = Math.max(...all);
    const at = this.size;
    this.offsets.set(num, at);
    const rows: number[] = [];
    for (let n = 0; n <= max; n++) {
      const off = n === num ? at : this.offsets.get(n);
      const st = this.inStm.get(n);
      if (st) rows.push(2, ...be(st[0], 4), ...be(st[1], 2));
      else if (off !== undefined) rows.push(1, ...be(off, 4), 0, 0);
      else rows.push(0, 0, 0, 0, 0, 0xff, 0xff);
    }
    const data = flate(Uint8Array.from(rows));
    const prev = o.prev !== undefined ? ` /Prev ${o.prev}` : "";
    this.raw(
      `${num} 0 obj\n<< /Type /XRef /Size ${max + 1} /W [1 4 2] /Filter /FlateDecode /Length ${data.length}${prev} ${trailer} >>\nstream\n`,
    );
    this.raw(data);
    this.raw(`\nendstream\nendobj\nstartxref\n${at}\n%%EOF\n`);
    this.lastXref = at;
    return this;
  }

  bytes(): Uint8Array {
    return cat(...this.parts);
  }
}

const be = (v: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => (v >>> (8 * (n - 1 - i))) & 0xff);

const trailerFor = (w: PdfWriter, root: number, extra = ""): string => {
  const id = `/ID [<${hex(FILE_ID)}> <${hex(FILE_ID)}>]`;
  return w.sec
    ? `/Root ${root} 0 R /Encrypt 99 0 R ${id} ${extra}`
    : `/Root ${root} 0 R ${id} ${extra}`;
};

// ---- fixture images ------------------------------------------------------------------------

/** 4×5 RGB, one row per PNG filter type 0..4. */
export const RGB_4x5 = Uint8Array.from(
  Array.from({ length: 4 * 5 * 3 }, (_, i) => (i * 37 + ((i / 3) | 0) * 11) & 0xff),
);
export const JPEG_COLOUR: [number, number, number] = [200, 30, 40];
export const JPEG_16x8 = flatJpeg(16, 8, JPEG_COLOUR, { icc: true });
/** 16-colour palette (RGB) for the Indexed image. */
export const PALETTE = Uint8Array.from(Array.from({ length: 48 }, (_, i) => (i * 53 + 7) & 0xff));
/** 8×8 indexed samples, 4 bits each. */
export const INDEX_8x8 = Array.from({ length: 64 }, (_, i) => (i * 7 + (i >> 3)) & 15);
export const SMASK_4x4 = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i * 17));
export const INLINE_GRAY = Uint8Array.from([10, 69, 73, 32]); // contains "EI " on purpose

export function packBits(samples: number[], bpc: number, perRow: number): Uint8Array {
  const rowBytes = Math.ceil((perRow * bpc) / 8);
  const rows = samples.length / perRow;
  const out = new Uint8Array(rowBytes * rows);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < perRow; i++) {
      const v = samples[r * perRow + i] as number;
      const bit = i * bpc;
      const at = r * rowBytes + (bit >> 3);
      out[at] = (out[at] as number) | (v << (8 - bpc - (bit & 7)));
    }
  }
  return out;
}

// ---- fixture 1: raster page ----------------------------------------------------------------

export interface FixtureOpts {
  readonly crypt?: CryptConfig;
}

export const RASTER_PAGE1 = [
  "q 160 0 0 80 20 200 cm /Im1 Do Q",
  "q 40 0 0 30 200 100 cm /Im2 Do Q",
  "q 80 0 0 80 300 200 cm /Im3 Do Q",
  "q 20 0 0 20 10 10 cm BI /W 2 /H 2 /CS /G /BPC 8 ID\n",
].join("\n");

/**
 * (1) Page 1: JPEG XObject, Flate RGB with PNG predictors, Flate Indexed with a 4×4 SMask,
 * two inline images, nested forms with matrices. Page 2: rotated 90°. Info /Producer.
 */
export function rasterPdf(o: FixtureOpts = {}): Uint8Array {
  const w = new PdfWriter(o.crypt ? new Security(o.crypt) : null);
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w.obj(2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
  w.obj(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 5 0 R " +
      "/Resources << /XObject << /Im1 6 0 R /Im2 7 0 R /Im3 8 0 R /Fm1 10 0 R /Fm2 11 0 R >> >> >>",
  );
  w.obj(
    4,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Rotate 90 /Contents 12 0 R /Resources << /XObject << /Im2 7 0 R >> >> >>",
  );
  const content = cat(
    bytes(RASTER_PAGE1),
    INLINE_GRAY,
    bytes("\nEI Q\n"),
    bytes("q 30 0 0 10 60 10 cm BI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID ff0000 00ff00> EI Q\n"),
    bytes("q 1 0 0 1 100 100 cm /Fm1 Do Q\n"),
  );
  w.obj(5, "<< /Filter /FlateDecode >>", flate(content));
  w.obj(
    6,
    "<< /Type /XObject /Subtype /Image /Width 16 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>",
    JPEG_16x8,
  );
  w.obj(
    7,
    "<< /Type /XObject /Subtype /Image /Width 4 /Height 5 /ColorSpace /DeviceRGB /BitsPerComponent 8 " +
      "/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns 4 >> >>",
    flate(pngPredict(RGB_4x5, 12, 3, [0, 1, 2, 3, 4])),
  );
  w.obj(
    8,
    (s) =>
      `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace [/Indexed /DeviceRGB 15 ${s(PALETTE)}] ` +
      "/BitsPerComponent 4 /SMask 9 0 R /Filter /FlateDecode >>",
    flate(packBits(INDEX_8x8, 4, 8)),
  );
  w.obj(
    9,
    "<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>",
    flate(SMASK_4x4),
  );
  w.obj(
    10,
    "<< /Type /XObject /Subtype /Form /BBox [0 0 400 400] /Matrix [0.5 0 0 0.5 0 0] >>",
    bytes("q 2 0 0 2 0 0 cm /Fm2 Do Q"),
  );
  w.obj(
    11,
    "<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 10 10] /Resources << /XObject << /Im2 7 0 R >> >> >>",
    bytes("q 40 0 0 40 0 0 cm /Im2 Do Q"),
  );
  w.obj(12, "<< >>", bytes("q 50 0 0 20 10 30 cm /Im2 Do Q"));
  w.obj(13, (s) => `<< /Producer ${s("Synthetic Writer 1.0")} >>`);
  if (w.sec) w.obj(99, w.sec.dict, undefined, { plain: true });
  w.xref(trailerFor(w, 1, "/Info 13 0 R"));
  return w.bytes();
}

// ---- fixture 2: vector-only page with text -------------------------------------------------

export const TOUNICODE = [
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
  "1 begincodespacerange <0000> <FFFF> endcodespacerange",
  "2 beginbfchar <0001> <00C4> <0002> <005A> endbfchar",
  "1 beginbfrange <0010> <0012> <0061> endbfrange",
  "1 beginbfrange <0020> <0021> [<0031> <D83DDE00>] endbfrange",
  "endcmap CMapName currentdict /CMap defineresource pop end end",
].join("\n");

/** (2) A vector-only page: paths, and text in a simple, a Differences and a Type0 font. */
export function vectorPdf(): Uint8Array {
  const w = new PdfWriter();
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>");
  w.obj(
    3,
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 8 0 R >> >> >>",
  );
  const content = [
    "0 0 m 100 100 l S 10 10 50 50 re f",
    "BT /F1 12 Tf 50 700 Td (Hello, PDF) Tj ET",
    "BT /F1 10 Tf 1 0 0 1 50 650 Tm [(Step) -300 (12)] TJ T* (2x) Tj ET",
    "BT /F2 20 Tf 50 600 Td <00010002001000110012> Tj <00200021> Tj <0099> Tj ET",
    "BT /F3 10 Tf 2 0 0 2 300 500 Tm (AB\\101) Tj ET",
  ].join("\n");
  w.obj(4, "<< >>", bytes(content));
  w.obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  w.obj(
    6,
    "<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 9 0 R >>",
  );
  w.obj(
    7,
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [1 [600 700] 16 18 400] >>",
  );
  w.obj(
    8,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /FirstChar 65 /Widths [250 750] /Encoding << /Differences [65 /bullet /uni2192] >> >>",
  );
  w.obj(9, "<< >>", bytes(TOUNICODE));
  w.xref(trailerFor(w, 1));
  return w.bytes();
}

// ---- fixture 3: damaged ----------------------------------------------------------------------

export const GRAY_3x2 = Uint8Array.from([0, 50, 100, 150, 200, 250]);

/**
 * (3) Damaged: startxref points at garbage, a content stream with a wrong /Length, a bogus
 * linearization hint table, and the page dictionary inside an object stream.
 */
export function damagedPdf(): Uint8Array {
  const w = new PdfWriter();
  w.obj(1, "<< /Linearized 1 /L 99999 /H [9 999] /O 3 /E 0 /N 1 /T 0 >>");
  w.obj(
    9,
    "<< /Filter /FlateDecode >>",
    bytes("this is not a hint table \x00\x01\x02 Invalid number of bits"),
  );
  w.obj(2, "<< /Type /Catalog /Pages 4 0 R >>");
  w.objStm(10, [
    [4, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [
      3,
      "<< /Type /Page /Parent 4 0 R /MediaBox [0 0 300 200] /Contents 5 0 R /Resources << /XObject << /Im1 6 0 R >> >> >>",
    ],
  ]);
  w.obj(5, "<< >>", bytes("q 30 0 0 20 10 10 cm /Im1 Do Q"), { length: "7" });
  w.obj(
    6,
    "<< /Type /XObject /Subtype /Image /Width 3 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>",
    flate(GRAY_3x2),
    { length: "9999" },
  );
  w.xref(trailerFor(w, 2), { startxref: 17 });
  return w.bytes();
}

/** A valid file using an xref stream and an object stream (the normal path). */
export function objStmPdf(): Uint8Array {
  const w = new PdfWriter(null, "%PDF-1.5\n%\xe2\xe3\xcf\xd3\n");
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w.objStm(7, [
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
    ],
    [6, "(objstm string)"],
  ]);
  w.obj(4, "<< >>", bytes("q 30 0 0 20 10 10 cm /Im1 Do Q"));
  w.obj(
    5,
    "<< /Type /XObject /Subtype /Image /Width 3 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>",
    flate(GRAY_3x2),
  );
  w.xrefStream(8, trailerFor(w, 1));
  return w.bytes();
}

/** An incremental update: revision 2 redefines the page content and adds an image. */
export function incrementalPdf(): { v1: Uint8Array; v2: Uint8Array } {
  const w = new PdfWriter();
  w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  w.obj(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
  );
  w.obj(4, "<< >>", bytes("q 30 0 0 20 10 10 cm /Im1 Do Q"));
  w.obj(
    5,
    "<< /Type /XObject /Subtype /Image /Width 3 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 >>",
    GRAY_3x2,
  );
  w.xref(trailerFor(w, 1));
  const v1 = w.bytes();
  const first = w.lastXref;
  w.obj(4, "<< >>", bytes("q 30 0 0 20 10 10 cm /Im1 Do Q q 60 0 0 40 100 100 cm /Im2 Do Q"));
  w.obj(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R /Im2 6 0 R >> >> >>",
  );
  w.obj(
    6,
    "<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>",
    Uint8Array.from([1, 2, 3, 4, 5, 6]),
  );
  w.xref(trailerFor(w, 1), { prev: first, nums: [3, 4, 6] });
  return { v1, v2: w.bytes() };
}

// ---- fixture 4: hostile ----------------------------------------------------------------------

/** One page whose content is `content` and whose resources are `resources` (objects ≥ 10). */
export function onePage(
  content: Uint8Array | string,
  resources = "",
  extra: [number, string, Uint8Array?, ObjOpts?][] = [],
  o: { catalogExtra?: string; pageExtra?: string; filter?: string; crypt?: CryptConfig } = {},
): Uint8Array {
  const w = new PdfWriter(o.crypt ? new Security(o.crypt) : null);
  w.obj(1, `<< /Type /Catalog /Pages 2 0 R ${o.catalogExtra ?? ""} >>`);
  w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  w.obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << ${resources} >> ${o.pageExtra ?? ""} >>`,
  );
  const c = typeof content === "string" ? bytes(content) : content;
  w.obj(4, o.filter ? `<< /Filter ${o.filter} >>` : "<< >>", c);
  for (const [n, body, data, opts] of extra) w.obj(n, body, data, opts);
  if (w.sec) w.obj(99, w.sec.dict, undefined, { plain: true });
  w.xref(trailerFor(w, 1));
  return w.bytes();
}

export const imageDict = (wd: number, ht: number, cs: string, bpc: number, extra = ""): string =>
  `<< /Type /XObject /Subtype /Image /Width ${wd} /Height ${ht} /ColorSpace ${cs} /BitsPerComponent ${bpc} ${extra} >>`;

/** Image whose Flate data inflates to `size` zero bytes while declaring 10×10 gray. */
export function bombImagePdf(size: number): Uint8Array {
  return onePage("q 10 0 0 10 0 0 cm /Im1 Do Q", "/XObject << /Im1 10 0 R >>", [
    [10, imageDict(10, 10, "/DeviceGray", 8, "/Filter /FlateDecode"), zeroBomb(size)],
  ]);
}

/** Page content that inflates to `size` bytes (a bomb in a content stream). */
export const bombContentPdf = (size: number): Uint8Array =>
  onePage(zeroBomb(size), "", [], { filter: "/FlateDecode" });

/** Catalog, page and annotation entries that must never be followed (ingestion §4.2). */
export const ACTIVE_OBJECTS = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];

export function activeContentPdf(): Uint8Array {
  return onePage(
    "q 10 0 0 10 0 0 cm /Im1 Do Q",
    "/XObject << /Im1 10 0 R >>",
    [
      [10, imageDict(2, 1, "/DeviceGray", 8), Uint8Array.from([0, 255])],
      [20, "<< /Type /Action /S /JavaScript /JS 21 0 R >>"],
      [21, "<< /Filter /FlateDecode >>", zeroBomb(80 * 1024 * 1024)],
      [
        22,
        "<< /JavaScript << /Names [(a) 20 0 R] >> /EmbeddedFiles << /Names [(evil.exe) 23 0 R] >> >>",
      ],
      [23, "<< /Type /Filespec /F (evil.exe) /EF << /F 24 0 R >> >>"],
      [24, "<< /Type /EmbeddedFile >>", bytes("MZ not really")],
      [
        25,
        "<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /URI /URI (https://example.invalid/) >> >>",
      ],
      [26, "<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /Launch /F (calc.exe) >> >>"],
      [27, "<< /Fields [] /XFA 28 0 R >>"],
      [28, "<< >>", bytes("<xdp:xdp/>")],
      [29, "<< /Type /Metadata /Subtype /XML >>", bytes("<x:xmpmeta/>")],
      [
        30,
        "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]",
      ],
    ],
    {
      catalogExtra:
        "/OpenAction 20 0 R /Names 22 0 R /AcroForm 27 0 R /Metadata 29 0 R /Outlines 30 0 R /AA << /WC 20 0 R >>",
      pageExtra: "/Annots [25 0 R 26 0 R] /AA << /O 20 0 R >>",
    },
  );
}

export const deepArray = (n: number): string => "[".repeat(n) + "]".repeat(n);

/** A form that draws an image and then itself; and a pair of mutually recursive forms. */
export function selfFormPdf(): Uint8Array {
  return onePage("/Fm1 Do /FmA Do", "/XObject << /Fm1 10 0 R /FmA 12 0 R >>", [
    [
      10,
      "<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Fm1 10 0 R /Im1 11 0 R >> >> >>",
      bytes("q 5 0 0 5 0 0 cm /Im1 Do Q /Fm1 Do"),
    ],
    [11, imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([128])],
    [
      12,
      "<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /FmB 13 0 R >> >> >>",
      bytes("/FmB Do"),
    ],
    [
      13,
      "<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /FmA 12 0 R /Im1 11 0 R >> >> >>",
      bytes("/Im1 Do /FmA Do"),
    ],
  ]);
}

/** Page with a 2×1 RGB image and an encrypted string in the image's Indexed palette. */
export function encryptedPdf(crypt: CryptConfig): Uint8Array {
  return rasterPdf({ crypt });
}
