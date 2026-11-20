import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, PdfError, resolveLimits } from "../src/limits.js";
import {
  Lexer,
  PdfDict,
  PdfName,
  PdfRef,
  PdfString,
  T_EOF,
  T_KW,
  T_NUM,
  parseValue,
  type PdfValue,
} from "../src/objects.js";
import { bytes } from "./fixtures/gen.js";

const parse = (s: string, limits = DEFAULT_LIMITS): PdfValue | undefined =>
  parseValue(new Lexer(bytes(s)), limits);
const str = (v: PdfValue | undefined): string => {
  expect(v).toBeInstanceOf(PdfString);
  return String.fromCharCode(...(v as PdfString).bytes);
};

describe("lexer", () => {
  it("parses numbers, including lenient forms", () => {
    for (const [src, want] of [
      ["42", 42],
      ["-17", -17],
      ["+3", 3],
      ["3.25", 3.25],
      ["-.5", -0.5],
      ["4.", 4],
      ["--5", -5],
      ["-0", 0],
    ] as const) {
      const lx = new Lexer(bytes(src));
      expect(lx.next()).toBe(T_NUM);
      expect(lx.num).toBe(want);
    }
    const lx = new Lexer(bytes("1e400"));
    lx.next();
    expect(lx.num).toBe(1); // "e400" is a keyword, not an exponent
    expect(lx.next()).toBe(T_KW);
  });

  it("decodes literal strings: escapes, octal, nesting, continuations, CR", () => {
    expect(str(parse("(a\\(b\\)c)"))).toBe("a(b)c");
    expect(str(parse("(x(y)z)"))).toBe("x(y)z");
    expect(str(parse("(\\101\\60\\0073)"))).toBe("A0\x073");
    expect(str(parse("(\\n\\r\\t\\b\\f\\\\)"))).toBe("\n\r\t\b\f\\");
    expect(str(parse("(line\\\ncont)"))).toBe("linecont");
    expect(str(parse("(a\r\nb)"))).toBe("a\nb");
    expect(str(parse("(unterminated"))).toBe("unterminated");
  });

  it("decodes hex strings with whitespace and an odd digit", () => {
    expect(str(parse("<41 42\n43>"))).toBe("ABC");
    expect(str(parse("<414>"))).toBe("A@");
  });

  it("decodes names with #xx escapes", () => {
    const v = parse("/A#20B#2f");
    expect(v).toBeInstanceOf(PdfName);
    expect((v as PdfName).name).toBe("A B/");
  });

  it("skips comments", () => {
    const lx = new Lexer(bytes("% comment\n12 % more\r%x"));
    expect(lx.next()).toBe(T_NUM);
    expect(lx.next()).toBe(T_EOF);
  });
});

describe("object parser", () => {
  it("parses dictionaries, arrays and references", () => {
    const v = parse("<< /Type /Page /Kids [1 0 R 2 0 R 3] /N null /B true /S (x) >>");
    expect(v).toBeInstanceOf(PdfDict);
    const d = v as PdfDict;
    expect((d.get("Type") as PdfName).name).toBe("Page");
    const kids = d.get("Kids") as PdfValue[];
    expect(kids).toHaveLength(3);
    expect(kids[0]).toBeInstanceOf(PdfRef);
    expect((kids[1] as PdfRef).num).toBe(2);
    expect(kids[2]).toBe(3);
    expect(d.map.has("N")).toBe(false); // null values are absent
    expect(d.get("B")).toBe(true);
  });

  it("parses a top-level reference and leaves a plain integer alone", () => {
    expect(parse("12 0 R")).toBeInstanceOf(PdfRef);
    const lx = new Lexer(bytes("12 0 obj"));
    expect(parseValue(lx, DEFAULT_LIMITS)).toBe(12);
  });

  it("closes containers at a structural keyword (missing >>)", () => {
    const lx = new Lexer(bytes("<< /A [1 2 endobj"));
    const v = parseValue(lx, DEFAULT_LIMITS);
    expect(v).toBeInstanceOf(PdfDict);
    expect((v as PdfDict).get("A")).toEqual([1, 2]);
    expect(lx.next()).toBe(T_KW);
    expect(lx.word).toBe("endobj");
  });

  it("tolerates odd dictionary keys and stray closers", () => {
    const v = parse("<< 5 /A 1 ] /B 2 >>") as PdfDict;
    expect(v.get("A")).toBe(1);
    expect(v.get("B")).toBe(2);
  });

  it("allows nesting up to the limit and refuses one more (pdf/too-complex)", () => {
    const ok = parse("[".repeat(64) + "]".repeat(64));
    expect(Array.isArray(ok)).toBe(true);
    try {
      parse("[".repeat(65) + "]".repeat(65));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PdfError);
      expect((e as PdfError).code).toBe("pdf/too-complex");
    }
  });

  it("caps the elements of one container (maxObjects)", () => {
    const limits = resolveLimits({ maxObjects: 100 });
    expect(() => parse(`[${"1 ".repeat(100)}]`, limits)).not.toThrow();
    expect(() => parse(`[${"1 ".repeat(101)}]`, limits)).toThrow(PdfError);
  });

  it("parses a hostile 1 MB nesting attempt quickly", () => {
    const t = performance.now();
    expect(() => parse("[".repeat(1_000_000))).toThrow(PdfError);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});

describe("limits", () => {
  it("ignores invalid overrides", () => {
    const l = resolveLimits({ maxObjects: -1, maxPages: Number.NaN, maxNesting: 3 });
    expect(l.maxObjects).toBe(DEFAULT_LIMITS.maxObjects);
    expect(l.maxPages).toBe(DEFAULT_LIMITS.maxPages);
    expect(l.maxNesting).toBe(3);
    // overrides only lower limits (S-Q14)
    const hi = resolveLimits({ maxNesting: 10_000, maxFileBytes: 1e12, bombRatio: 1e9 });
    expect(hi.maxNesting).toBe(64);
    expect(hi.maxFileBytes).toBe(DEFAULT_LIMITS.maxFileBytes);
    expect(hi.bombRatio).toBe(1024);
    expect(resolveLimits(null)).toEqual(DEFAULT_LIMITS);
  });

  it("matches ingestion §4.6", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxFileBytes: 256 * 1024 * 1024,
      maxObjects: 500_000,
      maxStreamBytes: 64 * 1024 * 1024,
      bombRatio: 1024,
      bombFloorBytes: 1024 * 1024,
      maxTotalDecoded: 1024 * 1024 * 1024,
      maxImageSide: 16_384,
      maxImagePixels: 16_777_216,
      maxNesting: 64,
      maxFormDepth: 16,
      maxQStack: 256,
      maxXrefSections: 64,
      maxPages: 100_000,
      maxOpsPerPage: 5_000_000,
      maxFilters: 4,
      maxDocOps: 50_000_000,
      maxDocContentBytes: 256 * 1024 * 1024,
      maxPlacements: 100_000,
      maxRunChars: 65_536,
      maxRuns: 200_000,
      maxHashBytes: 256 * 1024 * 1024,
      maxLexedBytes: 1024 * 1024 * 1024,
      maxParsedValues: 20_000_000,
      maxPageChars: 4_000_000,
    });
  });
});
