import { describe, expect, it } from "vitest";
import { openPdf } from "../src/index.js";
import { PdfString } from "../src/objects.js";
import { codes, decodePng, findDiag, mustOpen } from "./helpers.js";
import * as g from "./fixtures/gen.js";

const grayPng = (doc: ReturnType<typeof mustOpen>, page = 1, index = 0): number[] => {
  const e = doc.extractImage(page, index);
  expect(e.ok).toBe(true);
  const png = decodePng((e.image as { bytes: Uint8Array }).bytes);
  return Array.from({ length: png.w * png.h }, (_, i) => png.px[i * png.ch] as number);
};

describe("cross-reference tables", () => {
  it("reads a classic table without repair", () => {
    const doc = mustOpen(g.rasterPdf());
    expect(doc.info().repaired).toBe(false);
    expect(doc.pageCount).toBe(2);
  });

  it("reads an xref stream and an object stream (normal path, no repair)", () => {
    const doc = mustOpen(g.objStmPdf());
    const info = doc.info();
    expect(info.repaired).toBe(false);
    expect(info.version).toBe("1.5");
    expect(codes(info.diagnostics)).toEqual([]);
    expect(info.pages[0]).toMatchObject({ width: 300, height: 200 });
    expect(grayPng(doc)).toEqual([...g.GRAY_3x2]);
    // object 6 lives in the object stream and was never needed; it resolves on demand
    expect(doc.file.loaded.has(6)).toBe(false);
    const six = doc.file.loadObject(6);
    expect(six).toBeInstanceOf(PdfString);
    expect(String.fromCharCode(...(six as PdfString).bytes)).toBe("objstm string");
  });

  it("follows /Prev: the newer revision of an incremental update wins", () => {
    const { v1, v2 } = g.incrementalPdf();
    const a = mustOpen(v1).listImages(1);
    const b = mustOpen(v2).listImages(1);
    expect(a.images).toHaveLength(1);
    expect(b.images).toHaveLength(2);
    expect(b.images[1]).toMatchObject({
      width: 2,
      height: 1,
      bbox: { x: 100, y: 60, w: 60, h: 40 },
    });
    expect(b.images[0]?.sha256).toBe(a.images[0]?.sha256);
  });

  it("repairs a wrong startxref, wrong /Length values and finds pages in an object stream", () => {
    const r = openPdf(g.damagedPdf());
    expect(r.ok).toBe(true);
    const d = findDiag(r.diagnostics, "pdf/xref-repaired", "info");
    expect(d.message).toMatch(/rebuilt/);
    const doc = (r as { doc: ReturnType<typeof mustOpen> }).doc;
    expect(doc.info().repaired).toBe(true);
    const list = doc.listImages(1);
    expect(list.images).toHaveLength(1);
    expect(list.images[0]?.bbox).toEqual({ x: 10, y: 170, w: 30, h: 20 });
    expect(grayPng(doc)).toEqual([...g.GRAY_3x2]);
    // the linearization hint stream (object 9) is never read
    expect(doc.file.loaded.has(9)).toBe(false);
  });

  it("repairs a stream whose /Length is wrong even when the table is fine", () => {
    const pdf = g.onePage("q 10 0 0 10 0 0 cm /Im1 Do Q", "/XObject << /Im1 10 0 R >>", [
      [10, g.imageDict(3, 2, "/DeviceGray", 8), g.GRAY_3x2, { length: "4" }],
    ]);
    const doc = mustOpen(pdf);
    expect(doc.info().repaired).toBe(false);
    const e = doc.extractImage(1, 0);
    findDiag(e.diagnostics, "pdf/xref-repaired", "info");
    expect(grayPng(doc)).toEqual([...g.GRAY_3x2]);
  });

  it("resolves an indirect /Length", () => {
    const w = new g.PdfWriter();
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    w.obj(
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R /Resources << /XObject << /Im1 6 0 R >> >> >>",
    );
    w.obj(4, "<< >>", g.bytes("/Im1 Do"), { length: "5 0 R" });
    w.obj(5, "7");
    w.obj(6, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([9]));
    w.xref("/Root 1 0 R");
    const doc = mustOpen(w.bytes());
    const list = doc.listImages(1);
    expect(list.images).toHaveLength(1);
    expect(doc.info().repaired).toBe(false);
  });

  it("tolerates garbage before the header (offsets shifted)", () => {
    const pdf = g.cat(g.bytes("JUNK JUNK\n"), g.objStmPdf());
    const doc = mustOpen(pdf);
    expect(grayPng(doc)).toEqual([...g.GRAY_3x2]);
  });

  it("survives a /Prev cycle", () => {
    const base = g.rasterPdf();
    const s = String.fromCharCode(...base);
    const at = s.lastIndexOf("\nxref\n") + 1;
    const cyc = g.bytes(s.replace("/Size", `/Prev ${at} /Size`));
    const doc = mustOpen(cyc);
    expect(doc.pageCount).toBe(2);
    expect(doc.info().repaired).toBe(false);
  });

  it("falls back to the repair scan after more than 64 xref sections (pdf/too-complex)", () => {
    const w = new g.PdfWriter();
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(2, "<< /Type /Pages /Kids [] /Count 0 >>");
    w.xref("/Root 1 0 R");
    for (let i = 0; i < 65; i++) {
      const prev = w.lastXref;
      w.obj(3, `<< /Rev ${i} >>`);
      w.xref("/Root 1 0 R", { prev, nums: [3] });
    }
    const r = openPdf(w.bytes());
    expect(r.ok).toBe(true);
    findDiag(r.diagnostics, "pdf/too-complex", "warning");
    findDiag(r.diagnostics, "pdf/xref-repaired", "info");
  });

  it("refuses more objects than the cap (pdf/too-complex)", () => {
    const r = openPdf(g.rasterPdf(), { limits: { maxObjects: 5 } });
    expect(r.ok).toBe(false);
    findDiag(r.diagnostics, "pdf/too-complex", "error");
  });

  it("returns null for reference cycles and missing objects", () => {
    const pdf = g.onePage("/Im1 Do /Im2 Do", "/XObject << /Im1 10 0 R /Im2 77 0 R >>", [
      [10, "11 0 R"],
      [11, "10 0 R"],
    ]);
    const doc = mustOpen(pdf);
    const list = doc.listImages(1);
    expect(list.images).toHaveLength(0);
    findDiag(list.diagnostics, "pdf/no-images");
  });

  it("is not a PDF: pdf/malformed, never a throw", () => {
    for (const b of [new Uint8Array(0), g.bytes("hello world"), g.bytes("%PDF-1.7\n%%EOF\n")]) {
      const r = openPdf(b);
      expect(r.ok).toBe(false);
      findDiag(r.diagnostics, "pdf/malformed", "error");
    }
  });
});
