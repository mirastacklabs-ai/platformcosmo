import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { decodeFilters, type CapMode, type FilterSpec } from "../src/filters.js";
import { Budget, DEFAULT_LIMITS, PdfError, resolveLimits, type PdfLimits } from "../src/limits.js";
import { Lexer, parseValue } from "../src/objects.js";
import * as g from "./fixtures/gen.js";

const parms = (s: string) => parseValue(new Lexer(g.bytes(s)), DEFAULT_LIMITS);

function run(
  data: Uint8Array,
  filters: FilterSpec[],
  o: { limit?: number; mode?: CapMode; limits?: PdfLimits } = {},
) {
  const limits = o.limits ?? DEFAULT_LIMITS;
  return decodeFilters(data, filters, {
    limit: o.limit ?? limits.maxStreamBytes,
    mode: o.mode ?? "error",
    limits,
    budget: new Budget(limits),
    where: { page: 1 },
  });
}

const f = (name: string, p?: string): FilterSpec => ({ name, parms: p ? parms(p) : undefined });

function sample(n: number, seed = 1): Uint8Array {
  const r = g.rng(seed);
  // runs and noise: exercises LZW table growth and RunLength repeats
  return Uint8Array.from({ length: n }, (_, i) =>
    i % 97 < 40 ? (i >> 5) & 0xff : (r() * 256) | 0,
  );
}

function expectPdfError(fn: () => unknown, code: string): PdfError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PdfError);
    expect((e as PdfError).code).toBe(code);
    return e as PdfError;
  }
  throw new Error(`expected ${code}`);
}

describe("FlateDecode", () => {
  it("inflates zlib-wrapped and raw deflate data", () => {
    const data = sample(50_000);
    expect(run(g.flate(data), [f("FlateDecode")]).data).toEqual(data);
    expect(run(deflateSync(data), [f("FlateDecode")]).data).toEqual(data);
  });

  it("keeps the prefix of a truncated stream and marks it damaged", () => {
    const data = sample(50_000);
    const z = g.flate(data);
    const r = run(z.subarray(0, z.length >> 1), [f("FlateDecode")]);
    expect(r.damaged).toBe(true);
    expect(r.data.length).toBeGreaterThan(1000);
    expect(r.data).toEqual(data.subarray(0, r.data.length));
  });

  it("does not re-buffer megabytes of trailing garbage", () => {
    const z = g.cat(g.flate(sample(1000)), new Uint8Array(8 * 1024 * 1024).fill(0x41));
    const t = performance.now();
    expect(run(z, [f("FlateDecode")]).data).toHaveLength(1000);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("stops a bomb at the stream cap (pdf/too-large)", () => {
    const limits = resolveLimits({ maxStreamBytes: 4 * 1024 * 1024 });
    const t = performance.now();
    expectPdfError(
      () => run(g.zeroBomb(64 * 1024 * 1024), [f("FlateDecode")], { limits }),
      "pdf/too-large",
    );
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("truncates quietly at a declared size in truncate mode", () => {
    const r = run(g.zeroBomb(64 * 1024 * 1024), [f("FlateDecode")], {
      limit: 300,
      mode: "truncate",
    });
    expect(r.data).toHaveLength(300);
  });

  it("refuses a decoded/encoded ratio above the bomb guard", () => {
    // fixed-Huffman zeros compress about 158:1; a guard of 100:1 above 1 MiB must trip
    const bomb = g.zeroBomb(3 * 1024 * 1024);
    expect(run(bomb, [f("FlateDecode")]).data).toHaveLength(3 * 1024 * 1024);
    const e = expectPdfError(
      () => run(bomb, [f("FlateDecode")], { limits: resolveLimits({ bombRatio: 100 }) }),
      "pdf/too-large",
    );
    expect(e.message).toMatch(/bomb/);
  });
});

describe("predictors", () => {
  it("undoes every PNG filter type (Predictor 15)", () => {
    const px = g.RGB_4x5;
    const enc = g.flate(g.pngPredict(px, 12, 3, [0, 1, 2, 3, 4]));
    const r = run(enc, [f("FlateDecode", "<< /Predictor 15 /Colors 3 /Columns 4 >>")]);
    expect(r.data).toEqual(px);
  });

  it("undoes TIFF predictor 2 for 8, 16 and 1 bit samples", () => {
    const px = sample(4 * 3 * 6);
    const enc = g.flate(g.tiffPredict(px, 12, 3));
    expect(run(enc, [f("FlateDecode", "<< /Predictor 2 /Colors 3 /Columns 4 >>")]).data).toEqual(
      px,
    );
    // 16-bit, one colour, 3 columns: samples 1000, 1500, 400 → deltas 1000, 500, -1100
    const d16 = Uint8Array.from([0x03, 0xe8, 0x01, 0xf4, 0xfb, 0xb4]);
    const r16 = run(g.flate(d16), [
      f("FlateDecode", "<< /Predictor 2 /BitsPerComponent 16 /Columns 3 >>"),
    ]);
    expect([...r16.data]).toEqual([0x03, 0xe8, 0x05, 0xdc, 0x01, 0x90]);
    // 1-bit, 8 columns: deltas 1,0,0,1,0,0,0,1 → 1,1,1,0,0,0,0,1
    const r1 = run(g.flate(Uint8Array.from([0b10010001])), [
      f("FlateDecode", "<< /Predictor 2 /BitsPerComponent 1 /Columns 8 >>"),
    ]);
    expect(r1.data[0]).toBe(0b11100001);
  });

  it("never sizes a buffer from a hostile /Columns", () => {
    const t = performance.now();
    const r = run(g.flate(new Uint8Array(100)), [
      f("FlateDecode", "<< /Predictor 15 /Columns 100000000 /Colors 32 /BitsPerComponent 16 >>"),
    ]);
    expect(r.damaged).toBe(true);
    expect(r.data).toHaveLength(100);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it("pads a partial last row and marks it damaged", () => {
    const enc = g.flate(g.pngPredict(g.RGB_4x5, 12, 3, [2]).subarray(0, 13 * 4 + 5));
    const r = run(enc, [f("FlateDecode", "<< /Predictor 12 /Colors 3 /Columns 4 >>")]);
    expect(r.damaged).toBe(true);
    // sized from the data: 57 bytes minus 5 filter bytes (the image layer pads, not this one)
    expect(r.data).toHaveLength(52);
    expect(r.data.subarray(0, 48)).toEqual(g.RGB_4x5.subarray(0, 48));
  });
});

describe("LZW, ASCII85, ASCIIHex, RunLength", () => {
  it("LZWDecode round-trips with EarlyChange 1 and 0, across code widths and table resets", () => {
    const data = sample(40_000, 7);
    expect(run(g.lzwEncode(data), [f("LZWDecode")]).data).toEqual(data);
    expect(run(g.lzwEncode(data, 0), [f("LZWDecode", "<< /EarlyChange 0 >>")]).data).toEqual(data);
  });

  it("LZWDecode decodes the ISO 32000 example", () => {
    // ISO 32000-1 §7.4.4.2: "-----A---B" encodes to 80 0B 60 50 22 0C 0C 85 01
    const enc = Uint8Array.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
    expect(String.fromCharCode(...run(enc, [f("LZWDecode")]).data)).toBe("-----A---B");
  });

  it("ASCII85Decode handles z, partial groups, whitespace and the <~ prefix", () => {
    const data = g.cat(new Uint8Array(8), g.bytes("Man is distinguished"), Uint8Array.from([1, 2]));
    expect(run(g.ascii85Encode(data), [f("ASCII85Decode")]).data).toEqual(data);
    expect(
      String.fromCharCode(
        ...run(g.bytes("<~9jqo^BlbD-BleB1DJ+*+F(f,q~>"), [f("ASCII85Decode")]).data,
      ),
    ).toBe("Man is distinguished");
  });

  it("ASCIIHexDecode handles whitespace and an odd final digit", () => {
    expect([...run(g.bytes("41 4 2\n4>"), [f("ASCIIHexDecode")]).data]).toEqual([0x41, 0x42, 0x40]);
  });

  it("RunLengthDecode round-trips literal and repeat runs", () => {
    const data = g.cat(new Uint8Array(300).fill(7), sample(500), g.bytes("abc"));
    expect(run(g.runLengthEncode(data), [f("RunLengthDecode")]).data).toEqual(data);
  });

  it("decodes chains in order", () => {
    const data = sample(5000);
    expect(
      run(g.ascii85Encode(g.flate(data)), [f("ASCII85Decode"), f("FlateDecode")]).data,
    ).toEqual(data);
    expect(
      run(g.asciiHexEncode(g.lzwEncode(data)), [f("ASCIIHexDecode"), f("LZWDecode")]).data,
    ).toEqual(data);
  });
});

describe("filter limits and unsupported filters", () => {
  it("refuses more than four filters (pdf/too-complex)", () => {
    const five = Array.from({ length: 5 }, () => f("ASCIIHexDecode"));
    expectPdfError(() => run(g.bytes("41>"), five), "pdf/too-complex");
    expect(() => run(g.bytes("3431>"), five.slice(0, 2))).not.toThrow();
  });

  it("refuses JBIG2, JPX, CCITT, Crypt and unknown filters (pdf/unsupported-filter)", () => {
    for (const name of ["JBIG2Decode", "JPXDecode", "CCITTFaxDecode", "Crypt", "BogusDecode"]) {
      const e = expectPdfError(() => run(new Uint8Array(4), [f(name)]), "pdf/unsupported-filter");
      expect(e.where.filter).toBe(name);
    }
  });

  it("passes DCTDecode through as the JPEG, after earlier filters", () => {
    const r = run(g.asciiHexEncode(g.JPEG_16x8), [f("ASCIIHexDecode"), f("DCTDecode")]);
    expect(r.jpeg).toBe(true);
    expect(r.data).toEqual(g.JPEG_16x8);
    expectPdfError(
      () => run(g.JPEG_16x8, [f("DCTDecode"), f("FlateDecode")]),
      "pdf/unsupported-filter",
    );
  });

  it("charges the per-command total (scope: total)", () => {
    const limits = resolveLimits({ maxTotalDecoded: 10_000 });
    const budget = new Budget(limits);
    const o = { limit: limits.maxStreamBytes, mode: "error" as const, limits, budget, where: {} };
    decodeFilters(g.flate(sample(6000)), [f("FlateDecode")], o);
    const e = expectPdfError(
      () => decodeFilters(g.flate(sample(6000)), [f("FlateDecode")], o),
      "pdf/too-large",
    );
    expect(e.where.scope).toBe("total");
  });
});
