import { describe, expect, it } from "vitest";
import { codes, mustOpen } from "./helpers.js";
import * as g from "./fixtures/gen.js";

describe("pdf text", () => {
  const doc = mustOpen(g.vectorPdf());

  it("extracts runs with bboxes from simple, Differences and Type0/ToUnicode fonts", () => {
    const t = doc.text(1);
    expect(t.diagnostics).toEqual([]);
    expect(t.runs).toEqual([
      { text: "Hello, PDF", bbox: { x: 50, y: 82.4, w: 60, h: 12 }, fontSize: 12, font: "F1" },
      // TJ: a -300 adjustment reads as a space and moves the pen
      { text: "Step 12", bbox: { x: 50, y: 134, w: 33, h: 10 }, fontSize: 10, font: "F1" },
      { text: "2x", bbox: { x: 50, y: 134, w: 10, h: 10 }, fontSize: 10, font: "F1" },
      // ToUnicode bfchar, bfrange with an incrementing string, /W widths (600, 700, 400×3)
      { text: "ÄZabc", bbox: { x: 50, y: 176, w: 50, h: 20 }, fontSize: 20, font: "F2" },
      // bfrange with an array destination, including a surrogate pair
      { text: "1\u{1F600}", bbox: { x: 100, y: 176, w: 40, h: 20 }, fontSize: 20, font: "F2" },
      // an unmapped code is U+FFFD (DW 1000)
      { text: "�", bbox: { x: 140, y: 176, w: 20, h: 20 }, fontSize: 20, font: "F2" },
      // /Differences glyph names; Tm scales the size to 20 pt
      { text: "•→•", bbox: { x: 300, y: 276, w: 25, h: 20 }, fontSize: 20, font: "F3" },
    ]);
  });

  it("matches pdftotext's reading of the same file", () => {
    // pdftotext -layout printed: "Hello, PDF", "Step 12", "2x", "ÄZabc1😀", "•→•"
    const joined = doc
      .text(1)
      .runs.map((r) => r.text)
      .join("|");
    expect(joined).toBe("Hello, PDF|Step 12|2x|ÄZabc|1😀|�|•→•");
  });

  it("decodes standard encodings and unknown fonts", () => {
    const pdf = g.onePage(
      "BT /W 10 Tf (\\200\\226) Tj /M 10 Tf (\\212\\245) Tj /S 10 Tf (`a') Tj /X 10 Tf (q) Tj /T0 10 Tf <0041> Tj ET",
      "/Font << /W 10 0 R /M 11 0 R /S 12 0 R /T0 13 0 R >>",
      [
        [10, "<< /Type /Font /Subtype /TrueType /Encoding /WinAnsiEncoding >>"],
        [11, "<< /Type /Font /Subtype /Type1 /Encoding /MacRomanEncoding >>"],
        [12, "<< /Type /Font /Subtype /Type1 >>"],
        [13, "<< /Type /Font /Subtype /Type0 /Encoding /Identity-H >>"],
      ],
    );
    const t = mustOpen(pdf).text(1);
    expect(t.runs.map((r) => r.text)).toEqual(["€–", "ä•", "‘a’", "�", "�"]);
    expect(t.runs[3]?.font).toBe("X");
  });

  it("returns no runs for an image page and never reads fonts for listing", () => {
    const raster = mustOpen(g.rasterPdf());
    expect(raster.text(1).runs).toEqual([]);
    expect(codes(raster.text(1).diagnostics)).toEqual([]);
    const v = mustOpen(g.vectorPdf());
    v.listImages(1);
    expect(v.file.loaded.has(5)).toBe(false); // the font dictionary
  });
});
