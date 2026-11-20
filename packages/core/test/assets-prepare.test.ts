import { describe, expect, test } from "vitest";
import { DEFAULT_IMAGE_LIMITS, decodeImageDataUri, prepareImage } from "../src/assets/prepare.js";
import { crc32 } from "../src/assets/png.js";
import { parseExifOrientation } from "../src/assets/jpeg.js";
import type { ImageLimits } from "../src/contracts/index.js";
import {
  JPEG_METADATA,
  METADATA_CHUNKS,
  SVG_OK,
  b64,
  cat,
  enc,
  exifPayload,
  indexOfBytes,
  makeJpeg,
  makePng,
  pngChunk,
  seg,
} from "./assets-fixtures.js";

const L = DEFAULT_IMAGE_LIMITS;
const run = (bytes: Uint8Array, src = "img.png", limits: ImageLimits = L) =>
  prepareImage({ key: "pic", src, bytes }, limits);
const codes = (r: ReturnType<typeof run>) => r.diagnostics.map((d) => d.code);

describe("crc32", () => {
  test("matches the known IEND CRC", () => {
    expect(crc32(enc("IEND"), 0, 4)).toBe(0xae426082);
  });
});

describe("PNG", () => {
  test("good PNG: dimensions, mime, hash, bytes unchanged", () => {
    const png = makePng({ w: 40, h: 30 });
    const r = run(png);
    expect(r.diagnostics).toEqual([]);
    expect(r.asset).toMatchObject({
      key: "pic",
      format: "png",
      mime: "image/png",
      width: 40,
      height: 30,
      orientation: 1,
    });
    expect(r.asset?.data).toEqual(png);
    expect(r.asset?.hash).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    expect(r.asset?.svg).toBeUndefined();
  });

  test("hash is deterministic and content-addressed", () => {
    const a = run(makePng()).asset?.hash;
    expect(run(makePng()).asset?.hash).toBe(a);
    expect(run(makePng({ w: 5 })).asset?.hash).not.toBe(a);
    // metadata does not change the hash (it is stripped first)
    expect(run(makePng({ extra: [METADATA_CHUNKS.tEXt as Uint8Array] })).asset?.hash).toBe(a);
  });

  test("palette PNG keeps PLTE and tRNS", () => {
    const r = run(makePng({ color: 3, depth: 8 }));
    expect(r.asset).toBeDefined();
    const s = r.asset ? String.fromCharCode(...r.asset.data) : "";
    expect(s).toContain("PLTE");
    expect(s).toContain("tRNS");
  });

  test.each(Object.keys(METADATA_CHUNKS))("%s chunk is removed at byte level", (name) => {
    const png = makePng({ extra: [METADATA_CHUNKS[name] as Uint8Array] });
    expect(indexOfBytes(png, name)).toBeGreaterThan(0);
    const r = run(png);
    expect(r.asset).toBeDefined();
    const out = r.asset?.data ?? new Uint8Array();
    expect(indexOfBytes(out, name)).toBe(-1);
    expect(indexOfBytes(out, "SECRET")).toBe(-1);
    expect(out.length).toBeLessThan(png.length);
    // the result is itself a valid PNG that prepares identically
    expect(run(out).asset?.hash).toBe(r.asset?.hash);
  });

  test("metadata after IDAT is removed; ICC reports image/icc-ignored", () => {
    const png = makePng({ late: [METADATA_CHUNKS.tEXt as Uint8Array] });
    expect(indexOfBytes(run(png).asset?.data ?? new Uint8Array(), "tEXt")).toBe(-1);
    const icc = run(makePng({ extra: [METADATA_CHUNKS.iCCP as Uint8Array] }));
    expect(codes(icc)).toEqual(["image/icc-ignored"]);
    expect(icc.diagnostics[0]?.severity).toBe("info");
  });

  test("APNG is rejected with image/animated", () => {
    const apng = makePng({ extra: [pngChunk("acTL", new Uint8Array(8))] });
    const r = run(apng);
    expect(r.asset).toBeUndefined();
    expect(codes(r)).toEqual(["image/animated"]);
  });

  test("bad CRC, bad IHDR, missing IDAT and unknown critical chunk are rejected", () => {
    const bad = makePng().slice();
    bad[bad.length - 20] = (bad[bad.length - 20] as number) ^ 0xff; // inside IDAT data or CRC
    expect(codes(run(bad))).toEqual(["image/format"]);
    expect(codes(run(makePng({ w: 0 })))).toEqual(["image/format"]);
    expect(codes(run(makePng({ color: 9 })))).toEqual(["image/format"]);
    expect(codes(run(makePng({ extra: [pngChunk("ABCD")] })))).toEqual(["image/format"]);
    const noIdat = cat(makePng().subarray(0, 8), makePng().subarray(8, 33), pngChunk("IEND"));
    expect(codes(run(noIdat))).toEqual(["image/format"]);
  });

  test("truncated at every prefix length never yields an asset", () => {
    const png = makePng({ extra: [METADATA_CHUNKS.tEXt as Uint8Array] });
    for (let n = 0; n < png.length; n++) {
      const r = run(png.subarray(0, n));
      expect(r.asset).toBeUndefined();
      expect(r.diagnostics.length).toBeGreaterThan(0);
    }
  });

  test("oversized: bytes, dimension and pixel caps", () => {
    const small: ImageLimits = { ...L, maxBytes: 20 };
    expect(codes(run(makePng(), "a.png", small))).toEqual(["image/too-large"]);
    expect(codes(run(makePng({ w: 9000, h: 1 })))).toEqual(["image/too-large"]);
    expect(codes(run(makePng({ w: 5000, h: 5000 })))).toEqual(["image/too-large"]);
    expect(run(makePng({ w: 8192, h: 2048 })).asset).toBeDefined();
  });
});

describe("JPEG", () => {
  test("good JPEG: dimensions, bytes unchanged when there is no metadata", () => {
    const jpg = makeJpeg({ w: 100, h: 50 });
    const r = run(jpg, "photo.jpg");
    expect(r.diagnostics).toEqual([]);
    expect(r.asset).toMatchObject({
      format: "jpeg",
      mime: "image/jpeg",
      width: 100,
      height: 50,
      orientation: 1,
    });
    expect(r.asset?.data).toEqual(jpg);
  });

  test("progressive JPEG is accepted", () => {
    expect(run(makeJpeg({ progressive: true }), "p.jpeg").asset?.format).toBe("jpeg");
  });

  test("EXIF, XMP, ICC, IPTC, COM and APPn removed; JFIF and Adobe APP14 kept", () => {
    const jpg = makeJpeg({
      meta: [
        JPEG_METADATA.exif(1),
        JPEG_METADATA.xmp,
        JPEG_METADATA.icc,
        JPEG_METADATA.iptc,
        JPEG_METADATA.com,
        JPEG_METADATA.adobe,
        JPEG_METADATA.app15,
      ],
    });
    const r = run(jpg, "a.jpg");
    const out = r.asset?.data ?? new Uint8Array();
    expect(out.length).toBeGreaterThan(0);
    for (const s of ["Exif", "xmpmeta", "ICC_PROFILE", "Photoshop", "SECRET"]) {
      expect(indexOfBytes(jpg, s)).toBeGreaterThan(0);
      expect(indexOfBytes(out, s)).toBe(-1);
    }
    expect(indexOfBytes(out, "JFIF")).toBeGreaterThan(0);
    expect(indexOfBytes(out, "Adobe")).toBeGreaterThan(0);
    expect(codes(r)).toEqual(["image/icc-ignored"]);
    // entropy data, stuffing and restart markers survive byte for byte
    expect(Array.from(out.slice(-10, -2))).toEqual([
      0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78,
    ]);
    // cleaned output prepares to the same asset
    expect(run(out, "a.jpg").asset?.hash).toBe(r.asset?.hash);
  });

  test.each([1, 2, 3, 4, 5, 6, 7, 8])("EXIF orientation %i (both byte orders)", (o) => {
    for (const endian of ["II", "MM"] as const) {
      const jpg = makeJpeg({ w: 100, h: 50, meta: [seg(0xe1, exifPayload(o, endian))] });
      const a = run(jpg, "o.jpg").asset;
      expect(a?.orientation).toBe(o);
      expect(a?.width).toBe(o >= 5 ? 50 : 100);
      expect(a?.height).toBe(o >= 5 ? 100 : 50);
      expect(indexOfBytes(a?.data ?? new Uint8Array(), "Exif")).toBe(-1);
    }
  });

  test("JPEG without EXIF has orientation 1 and no diagnostic", () => {
    const r = run(makeJpeg(), "a.jpg");
    expect(r.asset?.orientation).toBe(1);
    expect(r.diagnostics).toEqual([]);
  });

  test("malformed EXIF is ignored with image/exif-ignored (info)", () => {
    const good = exifPayload(6);
    const variants: Uint8Array[] = [
      good.subarray(0, 12), // truncated TIFF header
      cat(good.subarray(0, 8), enc("XX"), good.subarray(10)), // not II/MM
      (() => {
        const b = good.slice();
        b[8] = 0; // wrong magic
        return b;
      })(),
      (() => {
        const b = good.slice();
        b[24] = 9; // orientation out of range
        return b;
      })(),
      (() => {
        const b = good.slice();
        b[14] = 0xff; // huge entry count
        b[15] = 0xff;
        return b;
      })(),
      (() => {
        const b = good.slice();
        b[10] = 0xff; // IFD offset out of range
        return b;
      })(),
      enc("Exif\0\0"),
    ];
    for (const v of variants) {
      expect(parseExifOrientation(v)).toBeUndefined();
      const r = run(makeJpeg({ meta: [seg(0xe1, v)] }), "a.jpg");
      expect(r.asset?.orientation).toBe(1);
      expect(r.asset?.width).toBe(16);
      expect(codes(r)).toEqual(["image/exif-ignored"]);
      expect(r.diagnostics[0]?.severity).toBe("info");
      expect(indexOfBytes(r.asset?.data ?? new Uint8Array(), "Exif")).toBe(-1);
    }
  });

  test("CMYK is a warning", () => {
    const r = run(makeJpeg({ comps: 4 }), "c.jpg");
    expect(r.asset).toBeDefined();
    expect(r.diagnostics.map((d) => [d.code, d.severity])).toEqual([["image/cmyk", "warning"]]);
  });

  test("bad JPEGs are rejected", () => {
    const noSof = cat(
      Uint8Array.from([0xff, 0xd8]),
      seg(0xe0, enc("JFIF\0")),
      Uint8Array.from([0xff, 0xd9]),
    );
    expect(codes(run(noSof, "a.jpg"))).toEqual(["image/format"]);
    expect(codes(run(makeJpeg({ w: 0 }), "a.jpg"))).toEqual(["image/format"]);
    expect(codes(run(makeJpeg({ trailing: enc("<html>") }), "a.jpg"))).toEqual(["image/format"]);
    expect(codes(run(makeJpeg({ omitEoi: true }), "a.jpg"))).toEqual(["image/format"]);
    // arithmetic-coded SOF9
    const j = makeJpeg().slice();
    const at = j.findIndex((v, i) => v === 0xff && j[i + 1] === 0xc0);
    j[at + 1] = 0xc9;
    expect(codes(run(j, "a.jpg"))).toEqual(["image/format"]);
  });

  test("truncated at every prefix length never yields an asset", () => {
    const jpg = makeJpeg({ meta: [JPEG_METADATA.exif(6), JPEG_METADATA.com] });
    for (let n = 0; n < jpg.length; n++) {
      const r = run(jpg.subarray(0, n), "a.jpg");
      expect(r.asset).toBeUndefined();
      expect(r.diagnostics.length).toBeGreaterThan(0);
    }
  });

  test("oversized: bytes and dimensions", () => {
    expect(codes(run(makeJpeg(), "a.jpg", { ...L, maxBytes: 30 }))).toEqual(["image/too-large"]);
    expect(codes(run(makeJpeg({ w: 9000, h: 10 }), "a.jpg"))).toEqual(["image/too-large"]);
    expect(codes(run(makeJpeg({ w: 5000, h: 4000 }), "a.jpg"))).toEqual(["image/too-large"]);
  });
});

describe("SVG", () => {
  test("good SVG goes through the sanitizer", () => {
    const r = run(enc(SVG_OK), "d.svg");
    expect(r.diagnostics).toEqual([]);
    expect(r.asset).toMatchObject({
      format: "svg",
      mime: "image/svg+xml",
      width: 40,
      height: 20,
      orientation: 1,
    });
    expect(r.asset?.data.length).toBe(0);
    expect(r.asset?.svg?.viewBox).toBe("0 0 40 20");
    expect(r.asset?.svg?.body).toContain("<rect");
    expect(r.asset?.hash).toMatch(/^sha256-/);
  });

  test("XML prolog, BOM and comments before <svg> are accepted", () => {
    const text = `${String.fromCharCode(0xfeff)}<?xml version="1.0"?>\n<!-- c -->\n${SVG_OK}`;
    expect(run(enc(text), "d.svg").asset?.format).toBe("svg");
  });

  test("script, handlers and foreignObject are removed (image/sanitized)", () => {
    const evil = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(1)</script><foreignObject><div>x</div></foreignObject><rect width="10" height="10" onclick="x()"/></svg>`;
    const r = run(enc(evil), "e.svg");
    expect(r.asset).toBeDefined();
    const body = r.asset?.svg?.body ?? "";
    expect(body).not.toMatch(/script|alert|foreignObject|onclick|onload/i);
    expect(codes(r)).toContain("image/sanitized");
  });

  test("external references are not kept", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="https://evil.example/x.png" width="10" height="10"/><rect width="1" height="1"/></svg>`;
    const r = run(enc(svg), "e.svg");
    expect(r.asset?.svg?.body ?? "").not.toContain("evil.example");
  });

  test("SVG cap: over 256 KiB is rejected, and the limit is configurable", () => {
    const big = enc(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><!--${"a".repeat(262_144)}--></svg>`,
    );
    expect(codes(run(big, "b.svg"))).toEqual(["image/too-large"]);
    expect(codes(run(enc(SVG_OK), "d.svg", { ...L, maxSvgBytes: 20 }))).toEqual([
      "image/too-large",
    ]);
  });

  test("no viewBox, not UTF-8 and zero-size are rejected", () => {
    expect(
      codes(run(enc(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`), "d.svg")),
    ).toEqual(["image/format"]);
    expect(
      codes(
        run(
          cat(enc("<svg viewBox='0 0 1 1'>"), Uint8Array.from([0xff, 0xfe]), enc("</svg>")),
          "d.svg",
        ),
      ),
    ).toEqual(["image/format"]);
    expect(
      codes(run(enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 5"></svg>`), "d.svg")),
    ).toEqual(["image/format"]);
  });

  test("truncated SVG is rejected", () => {
    expect(run(enc(SVG_OK.slice(0, 60)), "d.svg").asset).toBeUndefined();
  });
});

describe("format detection", () => {
  test("WebP is rejected with the PNG/JPEG hint", () => {
    const webp = cat(
      enc("RIFF"),
      Uint8Array.from([26, 0, 0, 0]),
      enc("WEBPVP8 "),
      new Uint8Array(20),
    );
    for (const src of ["a.webp", "a.png"]) {
      const r = run(webp, src);
      expect(r.asset).toBeUndefined();
      expect(codes(r)).toEqual(["image/format"]);
      expect(r.diagnostics[0]?.message).toContain("WebP");
      expect(r.diagnostics[0]?.suggestion).toContain("PNG or JPEG");
    }
  });

  test.each([
    ["GIF", enc("GIF89a\x01\0\x01\0")],
    ["AVIF", cat(Uint8Array.from([0, 0, 0, 24]), enc("ftypavif"), new Uint8Array(12))],
    ["HEIC", cat(Uint8Array.from([0, 0, 0, 24]), enc("ftypheic"), new Uint8Array(12))],
    ["TIFF", cat(enc("II*\0"), new Uint8Array(16))],
    ["BMP", cat(enc("BM"), new Uint8Array(30))],
  ])("%s is rejected with the hint", (name, bytes) => {
    const r = run(bytes, "x.png");
    expect(codes(r)).toEqual(["image/format"]);
    expect(r.diagnostics[0]?.message).toContain(name);
    expect(r.diagnostics[0]?.suggestion).toContain("PNG or JPEG");
  });

  test("unknown bytes and empty input are rejected", () => {
    expect(codes(run(enc("hello world"), "x.png"))).toEqual(["image/format"]);
    expect(codes(run(new Uint8Array(0), "x.png"))).toEqual(["image/format"]);
  });

  test("extension mismatch is an error (JPEG named .png, PNG named .svg, SVG named .jpg)", () => {
    for (const [bytes, src] of [
      [makeJpeg(), "x.png"],
      [makePng(), "x.svg"],
      [enc(SVG_OK), "x.jpg"],
      [makePng(), "dir/X.JPEG"],
    ] as const) {
      const r = run(bytes, src);
      expect(r.asset).toBeUndefined();
      expect(codes(r)).toEqual(["image/format-mismatch"]);
    }
  });

  test("an unknown extension does not matter; the bytes decide", () => {
    expect(run(makePng(), "x.dat").asset?.format).toBe("png");
  });
});

describe("polyglots", () => {
  test("PNG with trailing HTML is rejected", () => {
    const r = run(makePng({ trailing: enc("<html><script>alert(1)</script></html>") }));
    expect(r.asset).toBeUndefined();
    expect(codes(r)).toEqual(["image/format"]);
    expect(r.diagnostics[0]?.message).toContain("trailing");
  });

  test("PNG with HTML hidden in a text chunk is stripped", () => {
    const r = run(makePng({ extra: [pngChunk("tEXt", enc("x\0<script>alert(1)</script>"))] }));
    expect(indexOfBytes(r.asset?.data ?? new Uint8Array(), "<script>")).toBe(-1);
  });

  test("HTML in a JPEG comment is stripped; trailing HTML rejected", () => {
    const r = run(makeJpeg({ meta: [seg(0xfe, enc("<script>alert(1)</script>"))] }), "a.jpg");
    expect(indexOfBytes(r.asset?.data ?? new Uint8Array(), "<script>")).toBe(-1);
    expect(run(makeJpeg({ trailing: enc("<script>") }), "a.jpg").asset).toBeUndefined();
  });

  test("JPEG with a .png name is rejected as a mismatch", () => {
    expect(codes(run(makeJpeg(), "photo.png"))).toEqual(["image/format-mismatch"]);
  });

  test("HTML or SVG-with-HTML masquerading as PNG is rejected", () => {
    expect(codes(run(enc("<html><svg viewBox='0 0 1 1'/></html>"), "x.png"))).toEqual([
      "image/format",
    ]);
    expect(codes(run(enc(SVG_OK), "x.png"))).toEqual(["image/format-mismatch"]);
  });
});

describe("data URIs", () => {
  test("decode PNG, JPEG and SVG; bytes may be empty", () => {
    const png = makePng();
    const uri = `data:image/png;base64,${b64(png)}`;
    expect(decodeImageDataUri(uri)).toMatchObject({ format: "png" });
    expect(run(new Uint8Array(0), uri).asset?.data).toEqual(png);
    const jpg = run(new Uint8Array(0), `data:image/jpeg;base64,${b64(makeJpeg())}`);
    expect(jpg.asset?.format).toBe("jpeg");
    const svg = run(new Uint8Array(0), `data:image/svg+xml;base64,${b64(enc(SVG_OK))}`);
    expect(svg.asset?.format).toBe("svg");
  });

  test("diagnostics never echo the data URI", () => {
    const r = run(new Uint8Array(0), `data:image/png;base64,${b64(enc("not an image at all"))}`);
    expect(r.asset).toBeUndefined();
    expect(JSON.stringify(r.diagnostics)).not.toContain("base64,");
  });

  test("media type vs content mismatch and malformed URIs are errors", () => {
    const wrong = run(new Uint8Array(0), `data:image/jpeg;base64,${b64(makePng())}`);
    expect(codes(wrong)).toEqual(["image/format-mismatch"]);
    for (const bad of [
      "data:image/webp;base64,AAAA",
      "data:image/png;base64,@@@@",
      "data:image/png;base64,AAA",
      "data:image/png,rawtext",
      "data:text/html;base64,PGh0bWw+",
    ]) {
      expect(decodeImageDataUri(bad)).toBeUndefined();
      expect(codes(run(new Uint8Array(0), bad))).toEqual(["image/format"]);
    }
  });
});

describe("contract details", () => {
  test("never mutates the input bytes", () => {
    const jpg = makeJpeg({ meta: [JPEG_METADATA.exif(6), JPEG_METADATA.com] });
    const copy = jpg.slice();
    run(jpg, "a.jpg");
    expect(jpg).toEqual(copy);
  });

  test("diagnostic path is a JSON pointer under /images", () => {
    const r = prepareImage({ key: "a/b", src: "x.png", bytes: enc("nope") }, L);
    expect(r.diagnostics[0]?.path).toBe("/images/a~1b");
    expect(r.diagnostics[0]?.severity).toBe("error");
  });

  test("identical content gives identical hashes across sources", () => {
    const png = makePng();
    const a = run(png, "a.png").asset?.hash;
    const b = run(new Uint8Array(0), `data:image/png;base64,${b64(png)}`).asset?.hash;
    expect(a).toBe(b);
  });
});
