/**
 * Lockfile integrity for icon packs: `sha256-<base64>` over the canonical manifest plus every
 * icon file sorted by path. Pure JS SHA-256 so core stays free of Node built-ins.
 */
import type { LoadedIconPack } from "../contracts/index.js";

const PRIMES: number[] = [];
for (let n = 2; PRIMES.length < 64; n++) {
  if (PRIMES.every((p) => n % p !== 0)) PRIMES.push(n);
}
const frac32 = (x: number): number => Math.floor((x - Math.floor(x)) * 2 ** 32) >>> 0;
const K = PRIMES.map((p) => frac32(Math.cbrt(p)));
const H0 = PRIMES.slice(0, 8).map((p) => frac32(Math.sqrt(p)));

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  const h = Uint32Array.from(H0);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0;
    h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0;
    h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0;
    h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0;
    h[7] = ((h[7] as number) + hh) | 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i] as number);
  return out;
}

/** JSON with recursively sorted object keys (stable across producers). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** `sha256-<base64>` over the canonical manifest and every file, sorted by path (UTF-8, length-prefixed). */
export function computeIconIntegrity(pack: LoadedIconPack): string {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const push = (s: string): void => {
    parts.push(enc.encode(s));
  };
  push(`manifest\n${canonicalJson(pack.manifest)}\n`);
  for (const path of Object.keys(pack.files).sort()) {
    const content = enc.encode(pack.files[path] as string);
    push(`file ${path}\n${content.length}\n`);
    parts.push(content);
    push("\n");
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  let bin = "";
  for (const b of sha256(all)) bin += String.fromCharCode(b);
  return `sha256-${btoa(bin)}`;
}

/** Constant-structure comparison of a lockfile integrity string against the pack. */
export function verifyIconIntegrity(pack: LoadedIconPack, integrity: string): boolean {
  return computeIconIntegrity(pack) === integrity;
}
