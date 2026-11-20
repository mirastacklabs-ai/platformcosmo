import { describe, expect, it } from "vitest";
import { openPdf } from "../src/index.js";
import { codes, findDiag, mustOpen, timed } from "./helpers.js";
import * as g from "./fixtures/gen.js";

describe("allowlist (ingestion §4.2)", () => {
  it("never resolves actions, JavaScript, names, forms, annotations, metadata or outlines", () => {
    const pdf = g.activeContentPdf();
    const doc = mustOpen(pdf);
    const info = doc.info();
    expect(info.pageCount).toBe(1);
    const list = doc.listImages(1);
    expect(list.images).toHaveLength(1);
    expect(doc.extractImage(1, 0).ok).toBe(true);
    doc.text(1);
    // the referenced objects exist in the file…
    for (const n of g.ACTIVE_OBJECTS) expect(doc.file.entries.has(n), `object ${n}`).toBe(true);
    // …and none was ever loaded: the bomb (21) and the deep nesting (30) never fired
    for (const n of g.ACTIVE_OBJECTS) expect(doc.file.loaded.has(n), `object ${n}`).toBe(false);
    expect([...doc.file.loaded].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 10]);
    expect(codes([...info.diagnostics, ...list.diagnostics])).toEqual([]);
  });
});

describe("hostile-input limits (ingestion §4.6, §14)", () => {
  it("file size cap: pdf/too-large before parsing", () => {
    const r = timed(100, () => openPdf(g.rasterPdf(), { limits: { maxFileBytes: 1000 } }));
    expect(r.ok).toBe(false);
    findDiag(r.diagnostics, "pdf/too-large", "error");
  });

  it("an image bomb never allocates more than its declared image", () => {
    const doc = mustOpen(g.bombImagePdf(200 * 1024 * 1024));
    const before = process.memoryUsage().arrayBuffers;
    const e = timed(1000, () => doc.extractImage(1, 0));
    expect(e.ok).toBe(true);
    expect(e.image).toMatchObject({ width: 10, height: 10, format: "png" });
    // 10×10 declared: decoding stops after the first slice, far below the bomb's 200 MiB
    expect(doc.file.budget.decoded).toBeLessThan(4 * 1024 * 1024);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);
  });

  it("decoded total per command: pdf/too-large once the budget is spent", () => {
    const probe = mustOpen(g.rasterPdf());
    expect(probe.extractImage(1, 1).ok).toBe(true);
    const limits = { maxTotalDecoded: probe.file.budget.decoded + 10 };
    const doc = mustOpen(g.rasterPdf(), { limits });
    expect(doc.extractImage(1, 1).ok).toBe(true); // exactly what the probe needed
    const e = doc.extractImage(1, 2); // Indexed + SMask + pixels: over the total
    expect(e.ok).toBe(false);
    expect(findDiag(e.diagnostics, "pdf/too-large", "error").params.scope).toBe("total");
    // listing keeps going without hashes (C-Q06)
    const list = mustOpen(g.rasterPdf(), { limits }).listImages(1);
    expect(list.images).toHaveLength(6);
    expect(findDiag(list.diagnostics, "pdf/too-large", "warning").params.scope).toBe("total");
  });

  it("per-stream decoded cap (overridden): pdf/too-large", () => {
    const list = mustOpen(g.bombContentPdf(2 * 1024 * 1024), {
      limits: { maxStreamBytes: 1024 * 1024 },
    }).listImages(1);
    findDiag(list.diagnostics, "pdf/too-large", "error");
  });

  it("pages: at most maxPages, then a warning", () => {
    const r = openPdf(g.rasterPdf(), { limits: { maxPages: 1 } });
    expect(r.ok).toBe(true);
    findDiag(r.diagnostics, "pdf/too-complex", "warning");
    expect(r.ok && r.doc.pageCount).toBe(1);
  });

  it("page-tree cycles terminate", () => {
    const w = new g.PdfWriter();
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(2, "<< /Type /Pages /Kids [5 0 R 3 0 R 2 0 R] /Count 1 >>");
    w.obj(5, "<< /Type /Pages /Kids [2 0 R 5 0 R] /Count 0 >>");
    w.obj(3, "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>");
    w.obj(4, "<< >>", g.bytes(""));
    w.xref("/Root 1 0 R");
    expect(timed(200, () => mustOpen(w.bytes())).pageCount).toBe(1);
  });

  it("deep nesting in a followed object: pdf/too-complex, never a stack overflow", () => {
    const r = timed(3000, () => openPdf(g.onePage("", `/XObject ${g.deepArray(100_000)}`)));
    expect(r.ok).toBe(false);
    findDiag(r.diagnostics, "pdf/too-complex", "error");
  });

  it("a huge declared xref subsection is refused or repaired, not allocated", () => {
    const s = String.fromCharCode(...g.rasterPdf());
    const r = timed(500, () => openPdf(g.bytes(s.replace(/\nxref\n0 \d+/, "\nxref\n0 400000000"))));
    expect(r.diagnostics.length).toBeGreaterThan(0);
    const r2 = openPdf(g.bytes(s.replace(/\nxref\n0 \d+/, "\nxref\n0 400")));
    expect(r2.ok).toBe(true); // lying count: repaired
    findDiag(r2.diagnostics, "pdf/xref-repaired", "info");
  });

  it("chains of object streams or indirect lengths never recurse deeply", () => {
    const w = new g.PdfWriter(null, "%PDF-1.5\n");
    w.obj(1, "<< /Type /Catalog /Pages 3 0 R >>");
    for (let n = 3; n < 50_000; n++) w.inStm.set(n, [n + 1, 0]);
    w.xrefStream(2, "/Root 1 0 R");
    const r = timed(2000, () => openPdf(w.bytes()));
    expect(r.ok && r.doc.pageCount).toBe(0); // the page tree root is unreachable, not a crash
    findDiag(r.diagnostics, "pdf/bad-page", "warning");

    const v = new g.PdfWriter();
    v.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    v.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    v.obj(3, "<< /Type /Page /Parent 2 0 R /Contents 10 0 R >>");
    for (let n = 10; n < 5000; n++) v.obj(n, "<< >>", g.bytes("q Q"), { length: `${n + 1} 0 R` });
    v.xref("/Root 1 0 R");
    const doc = timed(2000, () => mustOpen(v.bytes()));
    expect(timed(2000, () => doc.listImages(1)).images).toHaveLength(0);
  });

  it("huge object streams and xref /W are refused", () => {
    const w = new g.PdfWriter(null, "%PDF-1.5\n");
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(
      7,
      "<< /Type /ObjStm /N 999999999 /First 4 >>",
      g.bytes("2 0 << /Type /Pages /Kids [] /Count 0 >>"),
    );
    w.xrefStream(8, "/Root 1 0 R");
    const t = performance.now();
    const r = openPdf(w.bytes());
    expect(performance.now() - t).toBeLessThan(500);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
