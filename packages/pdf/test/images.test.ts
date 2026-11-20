import { describe, expect, it } from "vitest";
import type { PdfDocument } from "../src/index.js";
import { decodePng, findDiag, mustOpen, type Png } from "./helpers.js";
import * as g from "./fixtures/gen.js";

const raster = mustOpen(g.rasterPdf());

function png(doc: PdfDocument, page: number, index: number, mask = false): Png {
  const e = doc.extractImage(page, index, { mask });
  expect(e.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(e.ok).toBe(true);
  expect(e.image?.format).toBe("png");
  const p = decodePng((e.image as { bytes: Uint8Array }).bytes);
  expect(p.chunks).toEqual(["IHDR", "IDAT", "IEND"]); // no ancillary chunks
  return p;
}

/** One image per page; `cs`, `bpc`, `extra` go into the image dictionary. */
function single(
  cs: string,
  w: number,
  h: number,
  bpc: number,
  data: Uint8Array,
  extra = "",
  more: [number, string, Uint8Array?][] = [],
) {
  return mustOpen(
    g.onePage("q 10 0 0 10 0 0 cm /Im1 Do Q", "/XObject << /Im1 10 0 R >>", [
      [10, g.imageDict(w, h, cs, bpc, extra), data],
      ...more,
    ]),
  );
}

const gray = (p: Png): number[] =>
  Array.from({ length: p.w * p.h }, (_, i) => p.px[i * p.ch] as number);
const alpha = (p: Png): number[] =>
  Array.from({ length: p.w * p.h }, (_, i) => p.px[i * p.ch + 3] as number);

describe("fixture 1 images", () => {
  it("passes the JPEG through unchanged, ICC segment included", () => {
    const e = raster.extractImage(1, 0);
    expect(e.ok).toBe(true);
    expect(e.image?.format).toBe("jpeg");
    expect(e.image?.bytes).toEqual(g.JPEG_16x8);
    expect(String.fromCharCode(...(e.image as { bytes: Uint8Array }).bytes)).toContain(
      "ICC_PROFILE",
    );
    expect(e.image).toMatchObject({ width: 16, height: 8 });
  });

  it("decodes Flate RGB with PNG predictors to the exact pixels", () => {
    const p = png(raster, 1, 1);
    expect(p).toMatchObject({ w: 4, h: 5, ch: 3 });
    expect(p.px).toEqual(g.RGB_4x5);
  });

  it("decodes Indexed 4-bit with a 4×4 SMask resampled to 8×8", () => {
    const p = png(raster, 1, 2);
    expect(p).toMatchObject({ w: 8, h: 8, ch: 4 });
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const i = g.INDEX_8x8[y * 8 + x] as number;
        const o = (y * 8 + x) * 4;
        expect([...p.px.subarray(o, o + 4)]).toEqual([
          g.PALETTE[i * 3],
          g.PALETTE[i * 3 + 1],
          g.PALETTE[i * 3 + 2],
          g.SMASK_4x4[(y >> 1) * 4 + (x >> 1)],
        ]);
      }
    }
    const m = png(raster, 1, 2, true);
    expect(gray(m)).toEqual(
      Array.from({ length: 64 }, (_, i) => g.SMASK_4x4[((i >> 3) >> 1) * 4 + ((i & 7) >> 1)]),
    );
  });

  it("decodes both inline images (data containing `EI`, and an ASCIIHex one)", () => {
    expect(gray(png(raster, 1, 3))).toEqual([...g.INLINE_GRAY]);
    expect([...png(raster, 1, 4).px]).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it("has stable golden hashes, and the same XObject hashes identically everywhere", () => {
    const sha = [1, 2].map((p) => raster.listImages(p).images.map((i) => i.sha256));
    expect(sha).toEqual([
      [
        "b884cc24b562d803851ee0549c14ade7180a320f77c35a60e0713f12205385e5",
        "53459051d0a97547895573a46a57ddde44985f5032e26bce735c136ce65a6bcc",
        "fbfd61c45cb0c87319554531b100e8e48b5008a2e31ef004632ebd1e5b771cd8",
        "91707e00ff3c3ce3fdb95724c571628d510089b734b055c06c3d662ec21b7cb8",
        "4720d5e64cb8c496587a1665ed3c5673eead6c451d664dc514b071718ed215ad",
        "53459051d0a97547895573a46a57ddde44985f5032e26bce735c136ce65a6bcc",
      ],
      ["53459051d0a97547895573a46a57ddde44985f5032e26bce735c136ce65a6bcc"],
    ]);
    expect(raster.extractImage(1, 1).image?.sha256).toBe(sha[0]?.[1]);
  });

  it("lists metadata for each placement", () => {
    const im = raster.listImages(1).images;
    expect(
      im.map((i) => [i.format, i.colourSpace, i.bitsPerComponent, i.hasAlpha, i.inline, i.object]),
    ).toEqual([
      ["jpeg", "DeviceRGB", 8, false, false, 6],
      ["png", "DeviceRGB", 8, false, false, 7],
      ["png", "Indexed(DeviceRGB)", 4, true, false, 8],
      ["png", "DeviceGray", 8, false, true, null],
      ["png", "DeviceRGB", 8, false, true, null],
      ["png", "DeviceRGB", 8, false, false, 7],
    ]);
    expect(im[1]?.filters).toEqual(["FlateDecode"]);
  });
});

describe("colour spaces and depths", () => {
  it("converts CMYK naively", () => {
    const p = png(
      single("/DeviceCMYK", 2, 1, 8, Uint8Array.from([255, 0, 0, 0, 0, 0, 0, 128])),
      1,
      0,
    );
    expect([...p.px]).toEqual([0, 255, 255, 127, 127, 127]);
  });

  it("approximates Separation and DeviceN as gray (pdf/colour-approx)", () => {
    const sep = single(
      "[/Separation /Spot /DeviceCMYK 11 0 R]",
      2,
      1,
      8,
      Uint8Array.from([0, 255]),
      "",
      [[11, "<< /FunctionType 2 /Domain [0 1] /N 1 >>"]],
    );
    const e = sep.extractImage(1, 0);
    findDiag(e.diagnostics, "pdf/colour-approx", "warning");
    expect(gray(decodePng((e.image as { bytes: Uint8Array }).bytes))).toEqual([255, 0]);
    const dn = single(
      "[/DeviceN [/A /B] /DeviceCMYK 11 0 R]",
      1,
      1,
      8,
      Uint8Array.from([255, 0]),
      "",
      [[11, "<< >>"]],
    );
    expect(gray(png(dn, 1, 0))).toEqual([128]);
  });

  it("reads ICCBased by /N, CalRGB and Lab", () => {
    const icc = single("[/ICCBased 11 0 R]", 1, 1, 8, Uint8Array.from([1, 2, 3]), "", [
      [11, "<< /N 3 >>", g.bytes("profile")],
    ]);
    expect([...png(icc, 1, 0).px]).toEqual([1, 2, 3]);
    const cal = single(
      "[/CalRGB << /WhitePoint [0.9 1 1] >>]",
      1,
      1,
      8,
      Uint8Array.from([4, 5, 6]),
    );
    expect([...png(cal, 1, 0).px]).toEqual([4, 5, 6]);
    const lab = single("[/Lab << /WhitePoint [0.9 1 1] >>]", 1, 1, 8, Uint8Array.from([255, 0, 0]));
    expect(gray(png(lab, 1, 0))).toEqual([255]);
  });

  it("unpacks 1, 2, 4 and 16 bits per component", () => {
    expect(gray(png(single("/DeviceGray", 8, 1, 1, Uint8Array.from([0b10110000])), 1, 0))).toEqual([
      255, 0, 255, 255, 0, 0, 0, 0,
    ]);
    expect(gray(png(single("/DeviceGray", 4, 1, 2, Uint8Array.from([0b00011011])), 1, 0))).toEqual([
      0, 85, 170, 255,
    ]);
    expect(gray(png(single("/DeviceGray", 2, 1, 4, Uint8Array.from([0x0f])), 1, 0))).toEqual([
      0, 255,
    ]);
    expect(
      gray(png(single("/DeviceGray", 2, 1, 16, Uint8Array.from([0xff, 0xff, 0x80, 0x00])), 1, 0)),
    ).toEqual([255, 128]);
  });

  it("applies /Decode arrays", () => {
    expect(
      gray(png(single("/DeviceGray", 2, 1, 8, Uint8Array.from([0, 255]), "/Decode [1 0]"), 1, 0)),
    ).toEqual([255, 0]);
  });

  it("reads an Indexed palette from a stream", () => {
    const doc = single("[/Indexed /DeviceRGB 1 11 0 R]", 2, 1, 8, Uint8Array.from([1, 0]), "", [
      [11, "<< >>", Uint8Array.from([9, 8, 7, 1, 2, 3])],
    ]);
    expect([...png(doc, 1, 0).px]).toEqual([1, 2, 3, 9, 8, 7]);
  });
});

describe("masks", () => {
  it("ImageMask stencils: 0 paints black, 1 is transparent", () => {
    const doc = mustOpen(
      g.onePage("/Im1 Do", "/XObject << /Im1 10 0 R >>", [
        [
          10,
          "<< /Type /XObject /Subtype /Image /Width 8 /Height 1 /ImageMask true >>",
          Uint8Array.from([0b01010101]),
        ],
      ]),
    );
    const p = png(doc, 1, 0);
    expect(alpha(p)).toEqual([255, 0, 255, 0, 255, 0, 255, 0]);
    expect(gray(p)).toEqual(new Array(8).fill(0));
    expect(doc.listImages(1).images[0]).toMatchObject({ imageMask: true, hasAlpha: true });
  });

  it("colour-key /Mask ranges", () => {
    const p = png(
      single(
        "/DeviceRGB",
        2,
        1,
        8,
        Uint8Array.from([10, 20, 30, 200, 200, 200]),
        "/Mask [5 15 15 25 25 35]",
      ),
      1,
      0,
    );
    expect(alpha(p)).toEqual([0, 255]);
  });

  it("stencil /Mask streams", () => {
    const doc = single("/DeviceGray", 2, 1, 8, Uint8Array.from([100, 200]), "/Mask 11 0 R", [
      [
        11,
        "<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ImageMask true >>",
        Uint8Array.from([0b01000000]),
      ],
    ]);
    const p = png(doc, 1, 0);
    expect(gray(p)).toEqual([100, 200]);
    expect(alpha(p)).toEqual([255, 0]);
  });

  it("a JPEG with an SMask: the JPEG passes through, the mask is extractable", () => {
    const doc = single("/DeviceRGB", 16, 8, 8, g.JPEG_16x8, "/Filter /DCTDecode /SMask 11 0 R", [
      [11, g.imageDict(2, 1, "/DeviceGray", 8), Uint8Array.from([0, 255])],
    ]);
    const e = doc.extractImage(1, 0);
    expect(e.image?.format).toBe("jpeg");
    const m = png(doc, 1, 0, true);
    expect(m).toMatchObject({ w: 16, h: 8 });
    expect(gray(m).slice(0, 16)).toEqual([...new Array(8).fill(0), ...new Array(8).fill(255)]);
    const none = raster.extractImage(1, 1, { mask: true });
    expect(none.ok).toBe(false);
    findDiag(none.diagnostics, "pdf/malformed", "info"); // C-Q13: not a bad page
  });
});

describe("image limits and failures", () => {
  it("lists but never decodes images over the caps (pdf/too-large)", () => {
    for (const [w, h] of [
      [20_000, 1],
      [5000, 5000],
    ] as const) {
      const doc = single("/DeviceGray", w, h, 8, new Uint8Array(4));
      const t = performance.now();
      const list = doc.listImages(1);
      expect(list.images[0]).toMatchObject({
        width: w,
        height: h,
        withinCaps: false,
        sha256: null,
      });
      findDiag(list.diagnostics, "pdf/too-large", "warning");
      const e = doc.extractImage(1, 0);
      expect(e.ok).toBe(false);
      const d = findDiag(e.diagnostics, "pdf/too-large", "error");
      expect(d.params.page).toBe(1);
      expect(d.params.image).toBe(0);
      expect(d.params.bbox).toEqual({ x: 0, y: 190, w: 10, h: 10 });
      expect(performance.now() - t).toBeLessThan(500);
    }
  });

  it("checks image dimensions against overridden caps", () => {
    const doc = mustOpen(
      g.onePage("/Im1 Do", "/XObject << /Im1 10 0 R >>", [
        [10, g.imageDict(64, 64, "/DeviceGray", 8), new Uint8Array(4096)],
      ]),
      { limits: { maxImagePixels: 4095 } },
    );
    findDiag(doc.extractImage(1, 0).diagnostics, "pdf/too-large", "error");
  });

  it("pads short image data with a warning", () => {
    const e = single("/DeviceGray", 2, 2, 8, Uint8Array.from([7, 8, 9])).extractImage(1, 0);
    expect(e.ok).toBe(true);
    const d = findDiag(e.diagnostics, "pdf/malformed", "warning");
    expect(d.params).toMatchObject({ expected: 4, actual: 3 });
    expect(gray(decodePng((e.image as { bytes: Uint8Array }).bytes))).toEqual([7, 8, 9, 0]);
  });

  it("reports JPX/JBIG2/CCITT images as unsupported (pdf/unsupported-filter)", () => {
    for (const filter of ["/JPXDecode", "/JBIG2Decode", "/CCITTFaxDecode"]) {
      const doc = single("/DeviceGray", 2, 2, 8, new Uint8Array(4), `/Filter ${filter}`);
      const list = doc.listImages(1);
      expect(list.images[0]?.format).toBe("unsupported");
      findDiag(list.diagnostics, "pdf/unsupported-filter", "warning");
      const e = doc.extractImage(1, 0);
      expect(e.ok).toBe(false);
      expect(findDiag(e.diagnostics, "pdf/unsupported-filter", "error").suggestion).toMatch(
        /render/,
      );
    }
  });

  it("refuses an image without a usable colour space or a JPEG that is not one", () => {
    findDiag(
      single("/Pattern", 1, 1, 8, Uint8Array.from([1])).extractImage(1, 0).diagnostics,
      "pdf/malformed",
      "error",
    );
    findDiag(
      single("/DeviceRGB", 1, 1, 8, g.bytes("not a jpeg"), "/Filter /DCTDecode").extractImage(1, 0)
        .diagnostics,
      "pdf/malformed",
      "error",
    );
  });
});
