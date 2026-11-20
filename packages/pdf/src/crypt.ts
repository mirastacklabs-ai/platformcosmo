/**
 * Standard security handler with an empty user password (ingestion §4.1): RC4 40–128 bit
 * (V1/V2, R2–R4), AES-128 (V4 `AESV2`, R4) and AES-256 (V5 `AESV3`, R5–R6). MD5, SHA-2 and AES
 * come from `node:crypto`; RC4 is implemented here because OpenSSL 3 only ships it in the
 * legacy provider, which Node does not load by default.
 */
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { PdfDict, PdfString, intOf, nameOf, type PdfValue } from "./objects.js";

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  const kl = key.length || 1;
  for (let i = 0; i < 256; i++) {
    j = (j + (s[i] as number) + ((key[i % kl] as number) | 0)) & 0xff;
    const t = s[i] as number;
    s[i] = s[j] as number;
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 0xff;
    b = (b + (s[a] as number)) & 0xff;
    const t = s[a] as number;
    s[a] = s[b] as number;
    s[b] = t;
    out[n] = (data[n] as number) ^ (s[((s[a] as number) + (s[b] as number)) & 0xff] as number);
  }
  return out;
}

const hash = (alg: string, ...parts: Uint8Array[]): Uint8Array => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const equal = (a: Uint8Array, b: Uint8Array, n: number): boolean => {
  if (a.length < n || b.length < n) return false;
  let d = 0;
  for (let i = 0; i < n; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
};

function aesCbc(
  decrypt: boolean,
  bits: 128 | 256,
  key: Uint8Array,
  iv: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  const alg = `aes-${bits}-cbc`;
  const c = decrypt ? createDecipheriv(alg, key, iv) : createCipheriv(alg, key, iv);
  c.setAutoPadding(false);
  const a = c.update(data);
  const b = c.final();
  return new Uint8Array(Buffer.concat([a, b]));
}

/** AES-CBC with the IV in the first 16 bytes and lenient PKCS#5 padding removal. */
function aesDecryptPayload(bits: 128 | 256, key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 32) return new Uint8Array(0);
  const body = data.subarray(16, 16 + Math.floor((data.length - 16) / 16) * 16);
  const out = aesCbc(true, bits, key, data.subarray(0, 16), body);
  const p = out[out.length - 1] as number;
  if (p >= 1 && p <= 16 && p <= out.length) {
    let ok = true;
    for (let i = out.length - p; i < out.length; i++) if (out[i] !== p) ok = false;
    if (ok) return out.subarray(0, out.length - p);
  }
  return out;
}

/** ISO 32000-2 algorithm 2.B (R6 hash). The loop runs at most 288 rounds. */
export function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let k = hash("sha256", password, salt, udata);
  let i = 0;
  for (;;) {
    const unit = concat(password, k, udata);
    const k1 = new Uint8Array(unit.length * 64);
    for (let r = 0; r < 64; r++) k1.set(unit, r * unit.length);
    const e = aesCbc(false, 128, k.subarray(0, 16), k.subarray(16, 32), k1);
    let sum = 0;
    for (let b = 0; b < 16; b++) sum += e[b] as number;
    const alg = ["sha256", "sha384", "sha512"][sum % 3] as string;
    k = hash(alg, e);
    i++;
    if (i >= 64 && (e[e.length - 1] as number) <= i - 32) break;
  }
  return k.subarray(0, 32);
}

export type CryptMethod = "none" | "rc4" | "aesv2" | "aesv3";

export interface PdfEncryptionInfo {
  /** Security handler (`/Filter`), e.g. "Standard". */
  readonly filter: string;
  readonly v: number;
  readonly r: number;
  readonly keyBits: number;
  /** Methods for streams and strings: "RC4", "AES-128", "AES-256" or "none". */
  readonly streams: string;
  readonly strings: string;
  /** `/P` permission flags as a signed 32-bit integer; reported, never enforced. */
  readonly permissions: number;
  readonly encryptMetadata: boolean;
}

const METHOD_LABEL: Record<CryptMethod, string> = {
  none: "none",
  rc4: "RC4",
  aesv2: "AES-128",
  aesv3: "AES-256",
};

export class Decryptor {
  constructor(
    private readonly key: Uint8Array,
    readonly stm: CryptMethod,
    readonly str: CryptMethod,
  ) {}

  decrypt(data: Uint8Array, num: number, gen: number, kind: "stream" | "string"): Uint8Array {
    const m = kind === "stream" ? this.stm : this.str;
    if (m === "none") return data;
    if (m === "aesv3") return aesDecryptPayload(256, this.key, data);
    const salt = m === "aesv2" ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0);
    const ext = Uint8Array.from([
      num & 0xff,
      (num >> 8) & 0xff,
      (num >> 16) & 0xff,
      gen & 0xff,
      (gen >> 8) & 0xff,
    ]);
    const k = hash("md5", this.key, ext, salt).subarray(0, Math.min(this.key.length + 5, 16));
    return m === "aesv2" ? aesDecryptPayload(128, k, data) : rc4(k, data);
  }
}

export type SecuritySetup =
  | { readonly ok: true; readonly decryptor: Decryptor; readonly info: PdfEncryptionInfo }
  | { readonly ok: false; readonly reason: string; readonly info: PdfEncryptionInfo | null };

const bytesOf = (v: PdfValue | undefined): Uint8Array | null =>
  v instanceof PdfString ? v.bytes : null;

/** Sets up decryption for an empty user password; `resolve` follows references in `/CF`. */
export function setupSecurity(
  enc: PdfDict,
  id0: Uint8Array,
  resolve: (v: PdfValue | undefined) => PdfValue | undefined,
): SecuritySetup {
  const filter = nameOf(resolve(enc.get("Filter"))) ?? "";
  const v = intOf(resolve(enc.get("V"))) ?? 0;
  const r = intOf(resolve(enc.get("R"))) ?? 0;
  const p = (intOf(resolve(enc.get("P"))) ?? 0) | 0;
  const em = resolve(enc.get("EncryptMetadata")) !== false;
  let stm: CryptMethod = "rc4";
  let str: CryptMethod = "rc4";
  let keyLen = 5;
  if (v === 2) {
    const bits = intOf(resolve(enc.get("Length"))) ?? 40;
    keyLen = bits >= 40 && bits <= 128 && bits % 8 === 0 ? bits / 8 : 5;
  } else if (v === 4 || v === 5) {
    const cf = resolve(enc.get("CF"));
    const method = (fname: string | null): { m: CryptMethod; len: number } | null => {
      if (fname === null || fname === "Identity") return { m: "none", len: 0 };
      const entry = cf instanceof PdfDict ? resolve(cf.get(fname)) : undefined;
      if (!(entry instanceof PdfDict)) return null;
      const cfm = nameOf(resolve(entry.get("CFM"))) ?? "None";
      const l = intOf(resolve(entry.get("Length"))) ?? 16;
      const len = l <= 32 ? l : l / 8;
      if (cfm === "None") return { m: "none", len: 0 };
      if (cfm === "V2") return { m: "rc4", len: len >= 5 && len <= 16 ? len : 16 };
      if (cfm === "AESV2") return { m: "aesv2", len: 16 };
      if (cfm === "AESV3") return { m: "aesv3", len: 32 };
      return null;
    };
    const s = method(nameOf(resolve(enc.get("StmF"))));
    const t = method(nameOf(resolve(enc.get("StrF"))));
    if (s === null || t === null) {
      return { ok: false, reason: "unsupported crypt filter", info: null };
    }
    stm = s.m;
    str = t.m;
    keyLen = v === 5 ? 32 : Math.max(s.len, t.len, 5);
  }
  const info: PdfEncryptionInfo = {
    filter,
    v,
    r,
    keyBits: keyLen * 8,
    streams: METHOD_LABEL[stm],
    strings: METHOD_LABEL[str],
    permissions: p,
    encryptMetadata: em,
  };
  const refuse = (reason: string): SecuritySetup => ({ ok: false, reason, info });
  if (filter !== "Standard") return refuse(`security handler "${filter}" is not supported`);
  if (![1, 2, 4, 5].includes(v) || ![2, 3, 4, 5, 6].includes(r)) {
    return refuse(`security handler version V${v} R${r} is not supported`);
  }
  if ((v === 5) !== r >= 5) return refuse(`inconsistent security handler V${v} R${r}`);
  const o = bytesOf(resolve(enc.get("O")));
  const u = bytesOf(resolve(enc.get("U")));
  if (o === null || u === null) return refuse("the /O or /U entry is missing");

  if (r >= 5) {
    const ue = bytesOf(resolve(enc.get("UE")));
    if (u.length < 48 || ue === null || ue.length < 32) {
      return refuse("the /U or /UE entry is malformed");
    }
    const pw = new Uint8Array(0);
    const empty = new Uint8Array(0);
    const vsalt = u.subarray(32, 40);
    const ksalt = u.subarray(40, 48);
    const check = r === 5 ? hash("sha256", pw, vsalt) : hash2B(pw, vsalt, empty);
    if (!equal(check, u, 32)) return refuse("a user password is required");
    const ikey = r === 5 ? hash("sha256", pw, ksalt) : hash2B(pw, ksalt, empty);
    const key = aesCbc(true, 256, ikey, new Uint8Array(16), ue.subarray(0, 32));
    return { ok: true, decryptor: new Decryptor(key, stm, str), info };
  }

  if (o.length < 32 || u.length < (r === 2 ? 32 : 16)) {
    return refuse("the /O or /U entry is malformed");
  }
  const pb = Uint8Array.from([p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff, (p >>> 24) & 0xff]);
  const tail = r >= 4 && !em ? Uint8Array.from([255, 255, 255, 255]) : new Uint8Array(0);
  let h = hash("md5", PAD, o.subarray(0, 32), pb, id0, tail);
  if (r >= 3) for (let i = 0; i < 50; i++) h = hash("md5", h.subarray(0, keyLen));
  const key = h.slice(0, keyLen);
  let ok: boolean;
  if (r === 2) ok = equal(rc4(key, PAD), u, 32);
  else {
    let x = rc4(key, hash("md5", PAD, id0));
    for (let i = 1; i <= 19; i++) {
      const k = key.map((b) => b ^ i);
      x = rc4(k, x);
    }
    ok = equal(x, u, 16);
  }
  if (!ok) return refuse("a user password is required");
  return { ok: true, decryptor: new Decryptor(key, stm, str), info };
}
