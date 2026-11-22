import { decodePng } from "@platformcosmo/core";
import { describe, expect, it } from "vitest";
import {
  MAX_MULTIPLY_ADDS,
  align,
  applyOrientation,
  crop,
  decodeImage,
  encodePng,
  locate,
  removeBackground,
  shrink,
  shrinkImage,
  trim,
  zoom,
  type Raster,
} from "../src/index.js";
import { makeJpeg, makeRaster, noise, paste, px, shifted, type Px } from "./fixtures.js";

const WHITE: Px = [255, 255, 255, 255];
const BLACK: Px = [0, 0, 0, 255];
const codes = (r: { diagnostics: readonly { code: string }[] }): string[] =>
  r.diagnostics.map((d) => d.code);

/** Round textured sprite with a soft-free circular mask: pixels outside the circle are alpha 0. */
function circleSprite(size: number, seed: number): Raster {
  const n = noise(size, size, seed);
  const c = (size - 1) / 2;
  return makeRaster(size, size, (x, y) => {
    const inside = (x - c) ** 2 + (y - c) ** 2 <= (size / 2) ** 2;
    return inside ? px(n, x, y) : [0, 0, 0, 0];
  });
}

describe("png codec and decode", () => {
  it("round-trips RGBA through encodePng/decodePng and has no ancillary chunks", () => {
    const r = makeRaster(13, 9, (x, y) => [x * 19, y * 27, (x * y) & 255, x === 3 ? 0 : 200]);
    const png = encodePng(r);
    expect(decodePng(png)).toEqual(r);
    const types: string[] = [];
    for (let o = 8; o < png.length;) {
      const len = new DataView(png.buffer, png.byteOffset).getUint32(o);
      types.push(String.fromCharCode(...png.subarray(o + 4, o + 8)));
      o += 12 + len;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("decodes a PNG to the same opaque pixels", async () => {
    const r = noise(17, 11, 5);
    const d = await decodeImage(encodePng(r));
    expect(d.diagnostics).toEqual([]);
    expect(d.value?.raster).toEqual(r);
    expect(d.value?.asset.format).toBe("png");
  });

  it("decodes an SVG at the requested size", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="20" height="20" fill="#f00"/></svg>';
    const d = await decodeImage(new TextEncoder().encode(svg), { svgSize: 80 });
    const r = d.value?.raster;
    expect(r && [r.width, r.height]).toEqual([80, 40]);
    expect(px(r!, 10, 10)).toEqual([255, 0, 0, 255]);
    expect(px(r!, 70, 10)[3]).toBe(0);
  });

  it("decodes a JPEG and applies the EXIF orientation from C-1", async () => {
    const level = (bx: number, by: number): number => 30 + bx * 60 + by * 20; // 2x1 blocks
    const plain = await decodeImage(makeJpeg(16, 8, level));
    const r1 = plain.value!.raster;
    expect([r1.width, r1.height]).toEqual([16, 8]);
    expect(Math.abs(px(r1, 2, 2)[0] - 30)).toBeLessThanOrEqual(2);
    expect(Math.abs(px(r1, 12, 2)[0] - 90)).toBeLessThanOrEqual(2);

    const rot = await decodeImage(makeJpeg(16, 8, level, 6)); // rotate 90 cw: left block ends on top
    const r6 = rot.value!.raster;
    expect([r6.width, r6.height]).toEqual([8, 16]);
    expect(Math.abs(px(r6, 4, 2)[0] - 30)).toBeLessThanOrEqual(2);
    expect(Math.abs(px(r6, 4, 12)[0] - 90)).toBeLessThanOrEqual(2);
    expect(rot.value!.asset.orientation).toBe(6);
  });

  it("applyOrientation implements all eight transforms", () => {
    // 2x3 raster with distinct pixels.
    const r = makeRaster(2, 3, (x, y) => [x * 100 + y * 10, 0, 0, 255]);
    const at = (o: Raster, x: number, y: number): number => px(o, x, y)[0];
    expect(applyOrientation(r, 1)).toBe(r);
    expect(at(applyOrientation(r, 2), 0, 0)).toBe(100);
    expect(at(applyOrientation(r, 3), 0, 0)).toBe(120);
    expect(at(applyOrientation(r, 4), 0, 0)).toBe(20);
    const t5 = applyOrientation(r, 5);
    expect([t5.width, t5.height, at(t5, 1, 0)]).toEqual([3, 2, 10]);
    const t6 = applyOrientation(r, 6);
    expect([t6.width, t6.height, at(t6, 0, 0), at(t6, 2, 0)]).toEqual([3, 2, 20, 0]);
    expect(at(applyOrientation(r, 7), 0, 0)).toBe(120);
    const t8 = applyOrientation(r, 8);
    expect([t8.width, at(t8, 0, 0), at(t8, 2, 1)]).toEqual([3, 100, 20]);
  });

  it("reports C-1 diagnostics for unsupported or corrupt input and never throws", async () => {
    const webp = Uint8Array.from([
      ...Buffer.from("RIFF"),
      0,
      0,
      0,
      0,
      ...Buffer.from("WEBPVP8 "),
      0,
      0,
      0,
      0,
    ]);
    const w = await decodeImage(webp);
    expect(w.value).toBeUndefined();
    expect(w.diagnostics.some((d) => d.severity === "error")).toBe(true);
    const junk = await decodeImage(Uint8Array.from([1, 2, 3]));
    expect(junk.value).toBeUndefined();
  });
});

describe("crop and trim", () => {
  const r = makeRaster(10, 8, (x, y) => [x, y, 0, 255]);
  it("crops exactly", () => {
    const c = crop(r, { x: 2, y: 3, w: 4, h: 2 });
    expect(c.diagnostics).toEqual([]);
    expect([c.value!.width, c.value!.height]).toEqual([4, 2]);
    expect(px(c.value!, 0, 0)).toEqual([2, 3, 0, 255]);
    expect(px(c.value!, 3, 1)).toEqual([5, 4, 0, 255]);
  });
  it("clamps a rectangle that overhangs, rejects one outside or malformed", () => {
    const c = crop(r, { x: 8, y: 6, w: 10, h: 10 });
    expect([c.value!.width, c.value!.height]).toEqual([2, 2]);
    expect(codes(c)).toEqual(["asset/rect-clamped"]);
    expect(codes(crop(r, { x: 20, y: 0, w: 2, h: 2 }))).toEqual(["asset/bad-option"]);
    expect(codes(crop(r, { x: 0, y: 0, w: 0, h: 2 }))).toEqual(["asset/bad-option"]);
    expect(codes(crop(r, { x: 0.5, y: 0, w: 2, h: 2 }))).toEqual(["asset/bad-option"]);
  });
  it("trims to the non-transparent box", () => {
    const t = makeRaster(9, 9, (x, y) =>
      x >= 3 && x <= 5 && y >= 2 && y <= 6 ? BLACK : [0, 0, 0, 0],
    );
    const out = trim(t).value!;
    expect([out.width, out.height]).toEqual([3, 5]);
    expect(codes(trim(makeRaster(3, 3, () => [0, 0, 0, 0])))).toEqual(["asset/empty"]);
  });
});

describe("removeBackground (edge-connected)", () => {
  // Black ring (outer 20x20, 2 px thick) with a white interior, a white gap channel closed off, on white.
  const ring = makeRaster(30, 30, (x, y) => {
    const inOuter = x >= 5 && x < 25 && y >= 5 && y < 25;
    const inInner = x >= 7 && x < 23 && y >= 7 && y < 23;
    return inOuter && !inInner ? BLACK : WHITE;
  });

  it("clears the outside and keeps enclosed whites opaque", () => {
    const res = removeBackground(ring);
    const out = res.value!.raster;
    expect(px(out, 0, 0)[3]).toBe(0);
    expect(px(out, 29, 15)[3]).toBe(0);
    expect(px(out, 15, 15)).toEqual(WHITE); // enclosed white stays opaque
    expect(px(out, 5, 5)).toEqual(BLACK);
    expect(res.value!.background).toEqual([255, 255, 255]);
    expect(res.value!.removed).toBe(900 - 400);
  });

  it("honours tolerance on a noisy near-white background and leaves other pixels alone", () => {
    const noisy = makeRaster(30, 30, (x, y) => {
      const base = ring.data[(y * 30 + x) * 4]!;
      return base === 0 ? BLACK : [250 + ((x * 7 + y) % 6), 252, 255 - ((x + y) % 5), 255];
    });
    const strict = removeBackground(noisy, { tolerance: 0 }).value!;
    expect(strict.removed).toBeLessThan(500);
    const lax = removeBackground(noisy, { tolerance: 12 }).value!;
    expect(lax.removed).toBe(500);
    expect(px(lax.raster, 15, 15)[3]).toBe(255);
  });

  it("leaves a white gap open to the border transparent but one closed by ink opaque", () => {
    // A comb: a slot reaching the edge is background, a closed slot is not.
    const comb = makeRaster(20, 12, (x, y) => {
      if (y < 2 || y >= 10) return WHITE;
      const open = x >= 4 && x < 7 && y < 6; // touches the top band of white
      const closed = x >= 12 && x < 15 && y >= 4 && y < 8;
      return open || closed ? WHITE : BLACK;
    });
    const out = removeBackground(comb).value!.raster;
    expect(px(out, 5, 3)[3]).toBe(0);
    expect(px(out, 13, 5)).toEqual(WHITE);
  });

  it("feather halves the alpha of the opaque pixels next to the new edge; default is off", () => {
    const plain = removeBackground(ring).value!.raster;
    const soft = removeBackground(ring, { feather: true }).value!.raster;
    expect(px(plain, 5, 15)[3]).toBe(255);
    expect(px(soft, 5, 15)[3]).toBe(128);
    expect(px(soft, 8, 15)[3]).toBe(255);
  });

  it("warns when the border is already transparent and rejects a bad tolerance", () => {
    expect(codes(removeBackground(makeRaster(8, 8, () => [0, 0, 0, 0])))).toEqual([
      "asset/no-background",
    ]);
    expect(codes(removeBackground(ring, { tolerance: 300 }))).toEqual(["asset/bad-option"]);
  });
});

describe("zoom", () => {
  const r = makeRaster(8, 4, (x, y) => [x * 30, y * 60, 100, 255]);
  it("scales by the factor: box filter below 1, bilinear above, identity at 1", () => {
    expect(zoom(r, 1).value).toBe(r);
    const up = zoom(r, 2.5).value!;
    expect([up.width, up.height]).toEqual([20, 10]);
    const down = zoom(r, 0.25).value!;
    expect([down.width, down.height]).toEqual([2, 1]);
    expect(zoom(r, 8).value).toMatchObject({ width: 64, height: 32 });
    expect(zoom(r, 0.25).value).toBeDefined();
  });
  it("is deterministic", () => {
    expect(Array.from(zoom(r, 3.3).value!.data)).toEqual(Array.from(zoom(r, 3.3).value!.data));
  });
  it("rejects a factor out of range or not finite with asset/bad-option", () => {
    for (const k of [0, 0.24, 8.01, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(codes(zoom(r, k))).toEqual(["asset/bad-option"]);
    }
  });
  it("refuses a result over the pixel limit with asset/too-large", () => {
    const big = makeRaster(4000, 1000, () => [0, 0, 0, 255]);
    expect(codes(zoom(big, 8))).toEqual(["asset/too-large"]);
  });
});

describe("shrink", () => {
  it("box-filters to the requested longest side and keeps flat colours exact", () => {
    const r = makeRaster(40, 20, (x) => (x < 20 ? [200, 10, 10, 255] : [10, 10, 200, 255]));
    const s = shrink(r, 10).value!;
    expect([s.width, s.height]).toEqual([10, 5]);
    expect(px(s, 1, 1)).toEqual([200, 10, 10, 255]);
    expect(px(s, 8, 4)).toEqual([10, 10, 200, 255]);
    expect(shrink(r, 100).value).toBe(r); // never upscales
  });

  it("averages a checkerboard and ignores transparent pixels' colour", () => {
    const cb = makeRaster(4, 4, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    expect(px(shrink(cb, 2).value!, 0, 0)).toEqual([128, 128, 128, 255]);
    const half = makeRaster(2, 1, (x) => (x ? [0, 0, 0, 0] : [10, 20, 30, 255]));
    expect(px(shrink(half, 1).value!, 0, 0)).toEqual([10, 20, 30, 128]);
  });

  it("shrinkImage re-encodes a PNG, passes a JPEG through, converts on request", async () => {
    const big = noise(64, 32, 9);
    const png = encodePng(big);
    const s = (await shrinkImage(png, 16)).value!;
    expect([s.format, s.width, s.height, s.resized]).toEqual(["png", 16, 8, true]);
    expect(decodePng(s.bytes).width).toBe(16);
    const same = (await shrinkImage(png, 128)).value!;
    expect(same.bytes).toEqual(png);
    expect(same.resized).toBe(false);

    const jpg = makeJpeg(64, 32, (bx) => 20 + bx * 10);
    const pass = await shrinkImage(jpg, 16);
    expect(pass.value!.bytes).toBe(jpg);
    expect(pass.value!.format).toBe("jpeg");
    expect(codes(pass)).toEqual(["asset/shrink-passthrough"]);
    expect(pass.diagnostics[0]!.severity).toBe("warning");
    const conv = (await shrinkImage(jpg, 16, { toPng: true })).value!;
    expect([conv.format, conv.width, conv.height]).toEqual(["png", 16, 8]);

    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
    );
    expect(codes(await shrinkImage(svg, 2))).toContain("asset/bad-option");
  });

  it("rejects a bad max-px", () => {
    expect(codes(shrink(noise(4, 4, 1), 0))).toEqual(["asset/bad-option"]);
  });
});

describe("locate", () => {
  const bg = noise(220, 140, 11);
  const sprite = circleSprite(36, 77);

  it("finds a known offset, ignoring background under the transparent corners", () => {
    const img = paste(bg, sprite, 83, 47);
    const res = locate(img, sprite, { scales: [1] });
    const m = res.value!.matches[0]!;
    expect([m.x, m.y, m.scale]).toEqual([83, 47, 1]);
    expect(m.score).toBeGreaterThan(0.99);
  });

  it("finds twin instances in a deterministic order (score, then y, then x)", () => {
    const img = paste(paste(paste(bg, sprite, 150, 30), sprite, 20, 90), sprite, 60, 30);
    const res = locate(img, sprite, { scales: [1], top: 3 });
    expect(res.value!.matches.map((m) => [m.x, m.y])).toEqual([
      [60, 30],
      [150, 30],
      [20, 90],
    ]);
    expect(new Set(res.value!.matches.map((m) => m.score)).size).toBe(1);
  });

  it("honours region and top", () => {
    const img = paste(paste(bg, sprite, 20, 20), sprite, 150, 80);
    const r = locate(img, sprite, { scales: [1], region: { x: 100, y: 50, w: 120, h: 90 } });
    expect(r.value!.matches.map((m) => [m.x, m.y])).toEqual([[150, 80]]);
    expect(locate(img, sprite, { scales: [1], top: 1 }).value!.matches).toHaveLength(1);
  });

  it("finds a sprite drawn at another scale", () => {
    const small = circleSprite(36, 77);
    const big = makeRaster(45, 45, (x, y) => {
      const i = Math.min(35, Math.floor(x / 1.25));
      const j = Math.min(35, Math.floor(y / 1.25));
      return px(small, i, j);
    });
    const img = paste(bg, big, 70, 40);
    const m = locate(img, small).value!.matches[0]!;
    expect(m.scale).toBe(1.25);
    expect(Math.abs(m.x - 70)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.y - 40)).toBeLessThanOrEqual(1);
  });

  it("returns nothing for an absent sprite and refuses flat sprites and bad input", () => {
    expect(locate(bg, circleSprite(36, 4), { scales: [1], minScore: 0.8 }).value!.matches).toEqual(
      [],
    );
    const flat = makeRaster(20, 20, () => [90, 90, 90, 255]);
    const flatRes = locate(bg, flat);
    expect(flatRes.value).toBeUndefined();
    expect(flatRes.diagnostics.at(-1)).toMatchObject({ severity: "error", code: "asset/flat" });
    expect(flatRes.diagnostics.slice(0, -1).every((d) => d.severity === "warning")).toBe(true);
    expect(codes(locate(bg, sprite, { top: 0 }))).toEqual(["asset/bad-option"]);
    expect(codes(locate(sprite, bg))).toEqual(["asset/not-found"]);
  });

  it("is deterministic across runs", () => {
    const img = paste(paste(bg, sprite, 150, 30), sprite, 60, 30);
    const a = JSON.stringify(locate(img, sprite).value);
    const b = JSON.stringify(locate(img, sprite).value);
    expect(a).toBe(b);
  });
});

describe("align", () => {
  const scene = (() => {
    let r = makeRaster(160, 120, () => WHITE);
    r = paste(r, noise(30, 24, 3), 20, 18);
    r = paste(r, noise(26, 30, 4), 80, 50);
    r = paste(r, noise(40, 16, 5), 40, 86);
    return r;
  })();

  it.each([
    [7, -5],
    [0, 0],
    [-12, 9],
  ])("recovers the shift (%i, %i)", (dx, dy) => {
    const res = align(scene, shifted(scene, dx, dy));
    expect(res.diagnostics).toEqual([]);
    expect([res.value!.dx, res.value!.dy]).toEqual([dx, dy]);
    expect(res.value!.score).toBeGreaterThan(0.99);
  });

  it("uses an explicit patch and reports a patch that cannot be found or a flat drawing", () => {
    const res = align(scene, shifted(scene, 4, 3), { patch: { x: 76, y: 46, w: 36, h: 40 } });
    expect([res.value!.dx, res.value!.dy]).toEqual([4, 3]);
    const flat = makeRaster(60, 60, () => WHITE);
    expect(codes(align(flat, flat))).toEqual(["asset/flat"]);
    expect(codes(align(scene, noise(160, 120, 99)))).toEqual(["asset/not-found"]);
  });
});

describe("CPU cap", () => {
  it("refuses an over-budget match with asset/too-expensive and a --region hint", () => {
    const img = makeRaster(3000, 3000, () => WHITE);
    const res = locate(img, circleSprite(300, 2));
    expect(res.value).toBeUndefined();
    expect(res.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "asset/too-expensive",
      params: { limit: MAX_MULTIPLY_ADDS },
    });
    expect(res.diagnostics[0]!.suggestion).toMatch(/region/);
  });

  it("a small region of the same image is within budget, and the cap is overridable", () => {
    const img = makeRaster(3000, 3000, () => WHITE);
    const ok = locate(paste(img, circleSprite(300, 2), 100, 100), circleSprite(300, 2), {
      scales: [1],
      region: { x: 0, y: 0, w: 500, h: 500 },
    });
    expect(ok.value!.matches[0]).toMatchObject({ x: 100, y: 100 });
    const tight = locate(noise(100, 100, 1), circleSprite(30, 2), { maxMultiplyAdds: 1000 });
    expect(codes(tight)).toEqual(["asset/too-expensive"]);
  });

  it("rejects a raster above the pixel cap", () => {
    const huge = { width: 5000, height: 5000, data: new Uint8Array(4) };
    expect(codes(crop(huge, { x: 0, y: 0, w: 1, h: 1 }))).toEqual(["asset/bad-raster"]);
    const big = { width: 4100, height: 4100, data: new Uint8Array(4100 * 4100 * 4) };
    expect(codes(shrink(big, 100))).toEqual(["asset/too-large"]);
  });
});

describe("determinism", () => {
  it("same input gives identical bytes and results", async () => {
    const r = noise(50, 30, 21);
    expect(encodePng(r)).toEqual(encodePng(r));
    const a = await shrinkImage(encodePng(r), 20);
    const b = await shrinkImage(encodePng(r), 20);
    expect(a.value!.bytes).toEqual(b.value!.bytes);
    const bgA = removeBackground(r).value!;
    const bgB = removeBackground(r).value!;
    expect(bgA.raster.data).toEqual(bgB.raster.data);
    const d1 = await decodeImage(encodePng(r));
    const d2 = await decodeImage(encodePng(r));
    expect(d1.value!.raster).toEqual(d2.value!.raster);
    expect(d1.value!.asset.hash).toBe(d2.value!.asset.hash);
  });
});
