/** Regression tests for the second C-2 review round (R-N*, N*). */
import { describe, expect, it } from "vitest";
import { Budget, DEFAULT_LIMITS, resolveLimits } from "../src/limits.js";
import { decodeFilters } from "../src/filters.js";
import { openPdf } from "../src/index.js";
import { Lexer, PdfString, parseValue } from "../src/objects.js";
import { findDiag, mustOpen } from "./helpers.js";
import * as c from "./fixtures/crafted.js";
import * as g from "./fixtures/gen.js";

describe("R-N4 repair skips stream data with an indirect /Length", () => {
  it("a damaged file never adopts an embedded PDF whose length is `7 0 R`", () => {
    const inner = g.onePage("", "", [], { pageExtra: "/MediaBox [0 0 999 999]" });
    const w = new g.PdfWriter();
    w.obj(
      1,
      "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(a.pdf) 5 0 R] >> >> >>",
    );
    w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    w.obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>");
    w.obj(4, "<< >>", g.bytes(""));
    w.obj(5, "<< /Type /Filespec /F (a.pdf) /EF << /F 6 0 R >> >>");
    w.obj(6, "<< /Type /EmbeddedFile >>", inner, { length: "7 0 R" });
    w.obj(7, String(inner.length));
    w.xref("/Root 1 0 R", { startxref: 3 }); // damaged: forces the repair scan
    const r = openPdf(w.bytes());
    expect(r.ok).toBe(true);
    findDiag(r.diagnostics, "pdf/xref-repaired", "info");
    const info = (r as { doc: ReturnType<typeof mustOpen> }).doc.info();
    expect(info.pageCount).toBe(1);
    expect(info.pages[0]?.mediaBox).toEqual([0, 0, 300, 200]);
  });
});

describe("R-N7 a stream without endstream does not end the scan", () => {
  it("objects after it are still found", () => {
    const pdf = g.bytes(
      "%PDF-1.7\n5 0 obj << /Length 3 >> stream\nabc\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n",
    );
    const r = openPdf(pdf);
    expect(r.ok).toBe(true);
    expect(r.ok && r.doc.pageCount).toBe(0);
  });
});

describe("R-N5 object streams chained through /DecodeParms", () => {
  it("six levels give pdf/too-complex, never a RangeError", () => {
    const w = new g.PdfWriter(null, "%PDF-1.5\n");
    w.obj(1, "<< /Type /Catalog /Pages 20 0 R >>");
    for (let k = 1; k <= 6; k++) {
      const members: [number, string][] = [[30 + k, "<< >>"]];
      if (k === 1) members.push([20, "<< /Type /Pages /Kids [] /Count 0 >>"]);
      let head = "";
      let body = "";
      members.forEach(([n, b], i) => {
        head += `${n} ${body.length} `;
        body += `${b}\n`;
        w.inStm.set(n, [10 + k, i]);
      });
      const parms = k < 6 ? ` /DecodeParms ${31 + k} 0 R` : "";
      w.obj(
        10 + k,
        `<< /Type /ObjStm /N ${members.length} /First ${head.length} /Filter /FlateDecode${parms} >>`,
        g.flate(g.bytes(head + body)),
      );
    }
    w.xrefStream(9, "/Root 1 0 R");
    const r = openPdf(w.bytes());
    expect(r.ok).toBe(false);
    const d = findDiag(r.diagnostics, "pdf/too-complex", "error");
    expect(d.message).toMatch(/nest too deeply/); // not the RangeError fallback message
  });
});

describe("R-N6 boundaries and per-document budgets", () => {
  it("Q06: /Columns 67108864 on one byte sizes nothing from the row width", () => {
    const parms = parseValue(
      new Lexer(g.bytes("<< /Predictor 12 /Columns 67108864 /Colors 1 /BitsPerComponent 8 >>")),
      DEFAULT_LIMITS,
    );
    const before = process.memoryUsage().arrayBuffers;
    const t = performance.now();
    const r = decodeFilters(g.flate(Uint8Array.from([2])), [{ name: "FlateDecode", parms }], {
      limit: DEFAULT_LIMITS.maxStreamBytes,
      mode: "error",
      limits: DEFAULT_LIMITS,
      budget: new Budget(DEFAULT_LIMITS),
      where: {},
    });
    expect(performance.now() - t).toBeLessThan(200);
    expect(r.data).toHaveLength(0); // one filter byte, no samples
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 * 1024 * 1024);
  });

  it("Q07: object-stream members are found by number, not by the xref index", () => {
    const w = new g.PdfWriter(null, "%PDF-1.5\n");
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(2, "<< /Type /Pages /Kids [] /Count 0 >>");
    w.objStm(7, [
      [10, "(ten)"],
      [11, "(eleven)"],
      [12, "(twelve)"],
    ]);
    w.inStm.set(11, [7, 0]); // a wrong index in the xref stream
    w.xrefStream(8, "/Root 1 0 R");
    const doc = mustOpen(w.bytes());
    const v = doc.file.loadObject(11);
    expect(String.fromCharCode(...(v as PdfString).bytes)).toBe("eleven");
  });

  it("maxDocOps stops a later page with scope document", () => {
    const doc = mustOpen(c.pagesSharedContent(3, 8000), { limits: { maxDocOps: 3000 } });
    expect(doc.listImages(1, { hash: false }).diagnostics.some((d) => d.severity === "error")).toBe(
      false,
    );
    const d = findDiag(doc.listImages(2, { hash: false }).diagnostics, "pdf/too-complex", "error");
    expect(d.params.scope).toBe("document");
  });

  it("maxLexedBytes refuses parsing past the budget", () => {
    const r = openPdf(g.rasterPdf(), { limits: { maxLexedBytes: 100 } });
    expect(r.ok).toBe(false);
    expect(findDiag(r.diagnostics, "pdf/too-large", "error").params.scope).toBe("lexed");
  });

  it("maxParsedValues refuses parsing past the budget (R-N1)", () => {
    const r = openPdf(g.rasterPdf(), { limits: { maxParsedValues: 10 } });
    expect(r.ok).toBe(false);
    expect(findDiag(r.diagnostics, "pdf/too-complex", "error").params.scope).toBe("values");
    expect(resolveLimits({ maxParsedValues: 1e12 }).maxParsedValues).toBe(20_000_000);
  });

  it("R-N1: /Kids entries that are not dictionaries are not cached", () => {
    const pdf = g.onePage("", "");
    const s = String.fromCharCode(...pdf)
      .replace("/Kids [3 0 R]", "/Kids [3 0 R 9 0 R]")
      .replace("xref", "9 0 obj [/a /b /c] endobj\nxref");
    const doc = mustOpen(g.bytes(s));
    expect(doc.file.loaded.has(9)).toBe(true);
    expect((doc.file as unknown as { cache: Map<number, unknown> }).cache.has(9)).toBe(false);
  });
});
