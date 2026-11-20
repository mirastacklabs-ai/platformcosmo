/** Test helpers: an independent PNG decoder and small assertions. */
import { unzlibSync } from "fflate";
import { expect } from "vitest";
import { openPdf, type PdfDiagnostic, type PdfDocument, type PdfOptions } from "../src/index.js";

export interface Png {
  readonly w: number;
  readonly h: number;
  /** 3 (RGB) or 4 (RGBA). */
  readonly ch: number;
  readonly px: Uint8Array;
  /** Chunk types in order. */
  readonly chunks: string[];
}

/** Decodes an 8-bit RGB/RGBA PNG (all five filter types). */
export function decodePng(b: Uint8Array): Png {
  expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8;
  let w = 0;
  let h = 0;
  let ch = 0;
  const idat: Uint8Array[] = [];
  const chunks: string[] = [];
  while (off < b.length) {
    const len = v.getUint32(off);
    const type = String.fromCharCode(...b.subarray(off + 4, off + 8));
    chunks.push(type);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = v.getUint32(off + 8);
      h = v.getUint32(off + 12);
      expect(data[8]).toBe(8);
      ch = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      expect(ch).toBeGreaterThan(0);
    } else if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = unzlibSync(Uint8Array.from(idat.flatMap((x) => [...x])));
  const stride = w * ch;
  const px = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)] as number;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] as number;
      const a = i >= ch ? (px[y * stride + i - ch] as number) : 0;
      const up = y > 0 ? (px[(y - 1) * stride + i] as number) : 0;
      const c = y > 0 && i >= ch ? (px[(y - 1) * stride + i - ch] as number) : 0;
      let p = 0;
      if (ft === 1) p = a;
      else if (ft === 2) p = up;
      else if (ft === 3) p = (a + up) >> 1;
      else if (ft === 4) {
        const q = a + up - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - up);
        const pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      px[y * stride + i] = (x + p) & 0xff;
    }
  }
  return { w, h, ch, px, chunks };
}

/** Opens and asserts success. */
export function mustOpen(b: Uint8Array, o?: PdfOptions): PdfDocument {
  const r = openPdf(b, o);
  if (!r.ok) throw new Error(`open failed: ${JSON.stringify(r.diagnostics)}`);
  return r.doc;
}

export const codes = (ds: readonly PdfDiagnostic[]): string[] => ds.map((d) => d.code);

/** Asserts a diagnostic with `code` exists (and optionally severity) and returns it. */
export function findDiag(
  ds: readonly PdfDiagnostic[],
  code: string,
  severity?: "error" | "warning" | "info",
): PdfDiagnostic {
  const d = ds.find((x) => x.code === code && (severity === undefined || x.severity === severity));
  expect(
    d,
    `expected ${code}${severity ? ` (${severity})` : ""} in ${JSON.stringify(codes(ds))}`,
  ).toBeDefined();
  const out = d as PdfDiagnostic;
  expect(out.params).toHaveProperty("page");
  expect(out.params).toHaveProperty("image");
  expect(out.params).toHaveProperty("bbox");
  return out;
}

/** Runs `fn`, asserting it finishes within `ms` (deterministic work, generous bound). */
export function timed<T>(ms: number, fn: () => T): T {
  const t = performance.now();
  const r = fn();
  expect(performance.now() - t).toBeLessThan(ms);
  return r;
}

/** Everything the API exposes for a document, for determinism and no-throw checks. */
export function everything(b: Uint8Array, o?: PdfOptions): unknown {
  const r = openPdf(b, o);
  if (!r.ok) return { open: r.diagnostics };
  const doc = r.doc;
  const pages: unknown[] = [];
  for (let p = 1; p <= Math.min(doc.pageCount, 4); p++) {
    const list = doc.listImages(p);
    const ex = list.images.slice(0, 8).map((im) => {
      const e = doc.extractImage(p, im.index);
      return { ok: e.ok, sha: e.image?.sha256 ?? null, d: codes(e.diagnostics) };
    });
    pages.push({ list, ex, text: doc.text(p) });
  }
  return { info: doc.info(), pages };
}
