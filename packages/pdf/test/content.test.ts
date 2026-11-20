import { describe, expect, it } from "vitest";
import { codes, findDiag, mustOpen } from "./helpers.js";
import * as g from "./fixtures/gen.js";

const IMG = "/XObject << /Im1 10 0 R >>";
const one: [number, string, Uint8Array][] = [
  [10, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([0])],
];

describe("placements", () => {
  const doc = mustOpen(g.rasterPdf());

  it("computes bboxes from the CTM: XObjects, inline images and nested forms", () => {
    const list = doc.listImages(1);
    expect(list.diagnostics).toEqual([]);
    expect(list.images.map((i) => i.bbox)).toEqual([
      { x: 20, y: 20, w: 160, h: 80 },
      { x: 200, y: 170, w: 40, h: 30 },
      { x: 300, y: 20, w: 80, h: 80 },
      { x: 10, y: 270, w: 20, h: 20 },
      { x: 60, y: 280, w: 30, h: 10 },
      { x: 110, y: 150, w: 40, h: 40 }, // Fm1 (/Matrix 0.5) → q 2 cm → Fm2 (/Matrix +10) → 40 cm
    ]);
    expect(list.images[0]?.bboxPercent).toEqual({ x: 5, y: 6.667, w: 40, h: 26.667 });
    expect(list.images.map((i) => i.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("maps a 90° page to its displayed orientation (checked against poppler)", () => {
    const im = doc.listImages(2).images[0];
    expect(im?.bbox).toEqual({ x: 30, y: 10, w: 20, h: 50 });
    // image top-left (u=0, v=0) lands at the displayed point (50, 10)
    expect(im?.matrix).toEqual([0, 50, -20, 0, 50, 10]);
    expect(doc.info().pages[1]).toMatchObject({ width: 100, height: 200, rotate: 90 });
  });

  it("applies every /Rotate value with an offset CropBox (checked against poppler)", () => {
    const want: Record<number, { bbox: object; size: [number, number] }> = {
      0: { bbox: { x: 20, y: 30, w: 20, h: 10 }, size: [100, 50] },
      90: { bbox: { x: 10, y: 20, w: 10, h: 20 }, size: [50, 100] },
      180: { bbox: { x: 60, y: 10, w: 20, h: 10 }, size: [100, 50] },
      270: { bbox: { x: 30, y: 60, w: 10, h: 20 }, size: [50, 100] },
      [-90]: { bbox: { x: 30, y: 60, w: 10, h: 20 }, size: [50, 100] },
    };
    for (const [rot, w] of Object.entries(want)) {
      const d = mustOpen(
        g.onePage("q 20 0 0 10 30 20 cm /Im1 Do Q", IMG, one, {
          pageExtra: `/Rotate ${rot} /CropBox [10 10 110 60]`,
        }),
      );
      expect(d.listImages(1).images[0]?.bbox, `rotate ${rot}`).toEqual(w.bbox);
      const p = d.info().pages[0];
      expect([p?.width, p?.height]).toEqual(w.size);
    }
  });

  it("restores the CTM on Q and handles skew", () => {
    const d = mustOpen(
      g.onePage("q 5 0 0 5 0 0 cm Q q 1 0 1 1 0 0 cm 10 0 0 10 0 0 cm /Im1 Do Q", IMG, one),
    );
    // shear x' = x + y: the unit square spans 20 pt horizontally
    expect(d.listImages(1).images[0]?.bbox).toEqual({ x: 0, y: 190, w: 20, h: 10 });
  });

  it("concatenates a /Contents array", () => {
    const w = new g.PdfWriter();
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    w.obj(
      3,
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents [4 0 R 5 0 R] /Resources << /XObject << /Im1 6 0 R >> >> >>",
    );
    w.obj(4, "<< >>", g.bytes("q 2 0 0"));
    w.obj(5, "<< >>", g.bytes("2 0 0 cm /Im1 Do Q"));
    w.obj(6, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([0]));
    w.xref("/Root 1 0 R");
    expect(mustOpen(w.bytes()).listImages(1).images[0]?.bbox).toEqual({ x: 0, y: 8, w: 2, h: 2 });
  });

  it("inherits MediaBox, Rotate and Resources through the page tree", () => {
    const w = new g.PdfWriter();
    w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    w.obj(
      2,
      `<< /Type /Pages /Kids [5 0 R] /Count 1 /MediaBox [0 0 50 40] /Rotate 180 /Resources << ${IMG} >> >>`,
    );
    w.obj(5, "<< /Type /Pages /Kids [3 0 R] /Count 1 /Parent 2 0 R >>");
    w.obj(3, "<< /Type /Page /Parent 5 0 R /Contents 4 0 R >>");
    w.obj(4, "<< >>", g.bytes("q 10 0 0 10 0 0 cm /Im1 Do Q"));
    w.obj(10, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([0]));
    w.xref("/Root 1 0 R");
    const d = mustOpen(w.bytes());
    expect(d.info().pages[0]).toMatchObject({ width: 50, height: 40, rotate: 180 });
    expect(d.listImages(1).images[0]?.bbox).toEqual({ x: 40, y: 0, w: 10, h: 10 });
  });
});

describe("content limits", () => {
  it("q/Q stack ≤ 256: deeper is pdf/too-complex, earlier placements kept", () => {
    const ok = mustOpen(g.onePage(`/Im1 Do ${"q ".repeat(256)}/Im1 Do`, IMG, one)).listImages(1);
    expect(ok.images).toHaveLength(2);
    expect(codes(ok.diagnostics)).toEqual([]);
    const bad = mustOpen(g.onePage(`/Im1 Do ${"q ".repeat(257)}/Im1 Do`, IMG, one)).listImages(1);
    expect(bad.images).toHaveLength(1);
    findDiag(bad.diagnostics, "pdf/too-complex", "error");
  });

  it("operators per page (overridden cap) stop with pdf/too-complex", () => {
    const pdf = g.onePage(`/Im1 Do ${"q Q ".repeat(600)}/Im1 Do`, IMG, one);
    expect(mustOpen(pdf).listImages(1).images).toHaveLength(2);
    const t = performance.now();
    const list = mustOpen(pdf, { limits: { maxOpsPerPage: 1000 } }).listImages(1);
    expect(performance.now() - t).toBeLessThan(500);
    expect(list.images).toHaveLength(1);
    findDiag(list.diagnostics, "pdf/too-complex", "error");
  });

  it("operators per page at the default cap (5 M) stop quickly", () => {
    const n = 5_000_001;
    const content = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      content[2 * i] = 0x51; // Q
      content[2 * i + 1] = 0x20;
    }
    const t = performance.now();
    const list = mustOpen(g.onePage(content, IMG, one)).listImages(1);
    expect(performance.now() - t).toBeLessThan(20_000); // ~1 s in plain node
    expect(findDiag(list.diagnostics, "pdf/too-complex", "error").message).toMatch(/5000000/);
  }, 30_000);

  it("form nesting ≤ 16: the 17th level is skipped with a warning", () => {
    const chain = (n: number): Uint8Array => {
      const extra: [number, string, Uint8Array][] = [
        [10, g.imageDict(1, 1, "/DeviceGray", 8), Uint8Array.from([0])],
      ];
      for (let i = 0; i < n; i++) {
        const next = i + 1 < n ? `/F ${12 + i} 0 R` : "/Im1 10 0 R";
        extra.push([
          11 + i,
          `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << ${next} >> >> >>`,
          g.bytes(i + 1 < n ? "/F Do" : "/Im1 Do"),
        ]);
      }
      return g.onePage("/F Do", "/XObject << /F 11 0 R >>", extra);
    };
    const ok = mustOpen(chain(16)).listImages(1);
    expect(ok.images).toHaveLength(1);
    const deep = mustOpen(chain(17)).listImages(1);
    expect(deep.images).toHaveLength(0);
    expect(findDiag(deep.diagnostics, "pdf/too-complex", "warning").message).toMatch(
      /deeper than 16/,
    );
  });

  it("self-referencing and mutually recursive forms terminate", () => {
    const list = mustOpen(g.selfFormPdf()).listImages(1);
    // Fm1 draws Im1 then itself (skipped); FmA → FmB draws Im1 then FmA (skipped): 2, like poppler
    expect(list.images).toHaveLength(2);
    expect(list.images[0]?.bbox).toEqual({ x: 0, y: 195, w: 5, h: 5 });
    findDiag(list.diagnostics, "pdf/too-complex", "warning");
  });

  it("deep nesting inside a content stream stops that page only", () => {
    const pdf = g.onePage(`/Im1 Do ${g.deepArray(65)} TJ /Im1 Do`, IMG, one);
    const doc = mustOpen(pdf);
    const list = doc.listImages(1);
    expect(list.images).toHaveLength(1);
    findDiag(list.diagnostics, "pdf/too-complex", "error");
    expect(doc.info().pageCount).toBe(1);
  });

  it("a content-stream bomb is pdf/too-large, quickly", () => {
    const t = performance.now();
    const list = mustOpen(g.bombContentPdf(80 * 1024 * 1024)).listImages(1);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(findDiag(list.diagnostics, "pdf/too-large", "error").params.page).toBe(1);
  });
});
