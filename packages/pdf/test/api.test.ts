import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, openPdf, PNG_ZLIB_LEVEL, type PdfDiagnostic } from "../src/index.js";
import { everything, findDiag, mustOpen } from "./helpers.js";
import * as g from "./fixtures/gen.js";

/** Every pdf/* code this package emits must be listed in ingestion §13. */
const SECTION_13 = [
  "pdf/encrypted",
  "pdf/xref-repaired",
  "pdf/unsupported-filter",
  "pdf/colour-approx",
  "pdf/too-complex",
  "pdf/too-large",
  "pdf/no-images",
  "pdf/bad-page",
  "pdf/malformed",
];

describe("public API", () => {
  it("never throws on bad input", () => {
    for (const b of [null, undefined, "x", 42, {}, new Uint8Array(0)] as unknown as Uint8Array[]) {
      const r = openPdf(b);
      expect(r.ok).toBe(false);
      findDiag(r.diagnostics, "pdf/malformed", "error");
    }
  });

  it("reports missing pages and images as pdf/bad-page", () => {
    const doc = mustOpen(g.rasterPdf());
    for (const p of [0, 3, -1, 1.5, Number.NaN]) {
      const d = findDiag(doc.listImages(p).diagnostics, "pdf/bad-page", "error");
      expect(d.params.page).toBe(p);
      findDiag(doc.text(p).diagnostics, "pdf/bad-page", "error");
      expect(doc.extractImage(p, 0).ok).toBe(false);
    }
    const e = doc.extractImage(1, 6);
    expect(e.ok).toBe(false);
    expect(findDiag(e.diagnostics, "pdf/bad-page", "error").params.image).toBe(6);
  });

  it("puts page, image index and bbox in every image diagnostic", () => {
    const doc = mustOpen(
      g.onePage("q 10 0 0 10 5 5 cm /Im1 Do Q", "/XObject << /Im1 10 0 R >>", [
        [10, g.imageDict(2, 1, "/DeviceGray", 8, "/Filter /JPXDecode"), new Uint8Array(2)],
      ]),
    );
    const d = findDiag(doc.extractImage(1, 0).diagnostics, "pdf/unsupported-filter", "error");
    expect(d.params).toMatchObject({
      page: 1,
      image: 0,
      bbox: { x: 5, y: 185, w: 10, h: 10 },
      filter: "JPXDecode",
    });
    expect(d.path).toBe("");
  });

  it("emits only §13 codes", () => {
    const seen = new Set<string>();
    const add = (ds: readonly PdfDiagnostic[]): void => ds.forEach((d) => seen.add(d.code));
    for (const b of [
      g.bytes("not a pdf"),
      g.rasterPdf(),
      g.vectorPdf(),
      g.damagedPdf(),
      g.selfFormPdf(),
      g.activeContentPdf(),
      g.bombContentPdf(70 * 1024 * 1024),
      g.encryptedPdf({ kind: "rc4-40" }),
      g.encryptedPdf({ kind: "rc4-40", userPassword: "x" }),
      g.onePage("/A Do /B Do", "/XObject << /A 10 0 R /B 11 0 R >>", [
        [10, g.imageDict(1, 1, "[/Separation /S /DeviceGray 12 0 R]", 8), Uint8Array.from([1])],
        [11, g.imageDict(1, 1, "/DeviceGray", 8, "/Filter /JPXDecode"), Uint8Array.from([1])],
        [12, "<< >>"],
      ]),
    ]) {
      const r = openPdf(b);
      add(r.diagnostics);
      if (!r.ok) continue;
      for (let p = 1; p <= r.doc.pageCount; p++) {
        const l = r.doc.listImages(p);
        add(l.diagnostics);
        l.images.forEach((i) => add(r.doc.extractImage(p, i.index).diagnostics));
        add(r.doc.text(p).diagnostics);
      }
    }
    expect([...seen].every((c) => SECTION_13.includes(c))).toBe(true);
    expect([...seen].sort()).toEqual(SECTION_13.filter((c) => c !== "pdf/bad-page").sort());
  }, 30_000);

  it("is deterministic across documents handles", () => {
    const a = JSON.stringify(everything(g.rasterPdf()));
    const b = JSON.stringify(everything(g.rasterPdf()));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(1000);
  });

  it("returns a copy of JPEG bytes (callers cannot corrupt the file buffer)", () => {
    const doc = mustOpen(g.rasterPdf());
    const a = doc.extractImage(1, 0).image?.bytes as Uint8Array;
    a.fill(0);
    expect(doc.extractImage(1, 0).image?.bytes).toEqual(g.JPEG_16x8);
  });

  it("exposes its defaults", () => {
    expect(DEFAULT_LIMITS.maxImagePixels).toBe(16_777_216);
    expect(PNG_ZLIB_LEVEL).toBe(6);
  });

  it("reports document info", () => {
    const info = mustOpen(g.rasterPdf()).info();
    expect(info).toMatchObject({
      version: "1.7",
      pageCount: 2,
      producer: "Synthetic Writer 1.0",
      encryption: null,
      repaired: false,
    });
    expect(info.pages.map((p) => [p.width, p.height, p.rotate])).toEqual([
      [400, 300, 0],
      [100, 200, 90],
    ]);
  });
});
