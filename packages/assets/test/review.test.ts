import { createHash } from "node:crypto";
import { decodePng } from "@platformcosmo/core";
import { describe, expect, it } from "vitest";
import {
  MAX_MULTIPLY_ADDS,
  align,
  applyOrientation,
  decodeImage,
  encodePng,
  floodFill,
  label,
  locate,
  nccAt,
  removeBackground,
  scaleSprite,
  type Raster,
} from "../src/index.js";
import { makeJpeg, makeRaster, noise, paste, px, shifted, type Px } from "./fixtures.js";

const WHITE: Px = [255, 255, 255, 255];
const BLACK: Px = [0, 0, 0, 255];
const codes = (r: { diagnostics: readonly { code: string }[] }): string[] =>
  r.diagnostics.map((d) => d.code);
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

function circleSprite(size: number, seed: number): Raster {
  const n = noise(size, size, seed);
  const c = (size - 1) / 2;
  return makeRaster(size, size, (x, y) =>
    (x - c) ** 2 + (y - c) ** 2 <= (size / 2) ** 2 ? px(n, x, y) : [0, 0, 0, 0],
  );
}

describe("locate: limits before allocation (Q01)", () => {
  const blank = (w: number, h: number): Raster => {
    const data = new Uint8Array(w * h * 4);
    data.fill(255);
    return { width: w, height: h, data };
  };

  it("refuses a 4096x4096 sprite in a 4096x4096 image quickly and without big allocations", () => {
    const image = blank(4096, 4096);
    const sprite = blank(4096, 4096);
    const before = process.memoryUsage().arrayBuffers;
    const t0 = Date.now();
    const res = locate(image, sprite);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.value).toBeUndefined();
    expect(
      res.diagnostics.some((d) => d.code === "asset/too-expensive" || d.code === "asset/not-found"),
    ).toBe(true);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(96 * 1024 * 1024);
  });

  it("refuses scales [4] before scaling anything", () => {
    const image = blank(4096, 4096);
    const sprite = blank(1100, 1100);
    const before = process.memoryUsage().arrayBuffers;
    const res = locate(image, sprite, { scales: [4] });
    expect(codes(res)).toEqual(["asset/not-found"]);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(32 * 1024 * 1024);
    expect(scaleSprite(blank(2200, 2200), 4).diagnostics[0]!.code).toBe("asset/too-large");
  });

  it("validates minScore and scales", () => {
    const img = noise(40, 40, 1);
    const sp = noise(10, 10, 2);
    expect(locate(img, sp, { minScore: 2 }).diagnostics[0]).toMatchObject({
      code: "asset/bad-option",
      params: { option: "minScore" },
    });
    expect(codes(locate(img, sp, { minScore: Number.NaN }))).toEqual(["asset/bad-option"]);
    expect(codes(locate(img, sp, { scales: [0.1] }))).toEqual(["asset/bad-option"]);
  });

  it("reports multiplyAdds within the estimate and counts refinement", () => {
    const bg = noise(220, 140, 11);
    const sprite = circleSprite(36, 77);
    const img = paste(bg, sprite, 83, 47);
    const res = locate(img, sprite);
    const v = res.value!;
    expect(v.refineMultiplyAdds).toBeGreaterThan(0);
    expect(v.multiplyAdds).toBeGreaterThan(v.refineMultiplyAdds);
    expect(v.multiplyAdds).toBeLessThanOrEqual(v.estimate);
    expect(v.estimate).toBeLessThan(MAX_MULTIPLY_ADDS);
    // A cap between the real cost and the estimate is still refused: the estimate is what is checked.
    expect(codes(locate(img, sprite, { maxMultiplyAdds: v.estimate - 1 }))).toEqual([
      "asset/too-expensive",
    ]);
  });

  it("reports the region as a bbox and warns when it is clamped", () => {
    const bg = noise(100, 80, 3);
    const sprite = noise(20, 20, 4);
    const res = locate(paste(bg, sprite, 10, 10), sprite, {
      scales: [1],
      region: { x: -5, y: -5, w: 60, h: 60 },
    });
    expect(res.diagnostics[0]).toMatchObject({
      code: "asset/rect-clamped",
      params: { bbox: { x: 0, y: 0, w: 55, h: 55 } },
    });
    const tight = locate(bg, sprite, { maxMultiplyAdds: 10, scales: [1] });
    expect(tight.diagnostics[0]!.params).toHaveProperty("bbox");
  });

  it("skips a flat scale with a warning but still searches the others", () => {
    // Sprite 8x4 px: a 2 px black bar on grey; at 0.25 it has no texture left under its mask.
    const sprite = makeRaster(8, 8, (x) => (x < 2 ? BLACK : [128, 128, 128, 255]));
    const bg = makeRaster(60, 40, () => [128, 128, 128, 255]);
    const img = paste(bg, sprite, 20, 10);
    const res = locate(img, sprite, { scales: [1] });
    expect(res.value!.matches[0]).toMatchObject({ x: 20, y: 10 });
  });
});

describe("locate: overlap suppression by mask IoU (Q02)", () => {
  /** 300x120 frame (6 px thick) of random cells; the inside is transparent. */
  function frame(): Raster {
    const n = noise(300, 120, 31);
    return makeRaster(300, 120, (x, y) =>
      x < 6 || y < 6 || x >= 294 || y >= 114 ? px(n, x, y) : [0, 0, 0, 0],
    );
  }
  it("finds every instance of a vertical stack at a 20 px pitch, in deterministic order", () => {
    const sp = frame();
    let img = makeRaster(320, 240, () => [200, 200, 200, 255]);
    const ys = [10, 30, 50, 70, 90];
    for (const y of ys) img = paste(img, sp, 10, y);
    const a = locate(img, sp, { scales: [1], top: 5, minScore: 0.3 });
    const m = a.value!.matches;
    expect(m.map((x) => x.y).sort((p, q) => p - q)).toEqual(ys);
    expect(m.every((x) => x.x === 10)).toBe(true);
    // Ordered by score (1e-6 buckets), then y.
    for (let i = 1; i < m.length; i++) {
      const p = m[i - 1]!;
      const c = m[i]!;
      expect(p.score > c.score || (p.score === c.score && p.y <= c.y)).toBe(true);
    }
    expect(JSON.stringify(locate(img, sp, { scales: [1], top: 5, minScore: 0.3 }).value)).toBe(
      JSON.stringify(a.value),
    );
  });
});

describe("locate: coarse stage is alpha-weighted (Q06)", () => {
  /** 1 px line art: diagonal, horizontal, vertical and a ring on grey. */
  const ink = (x: number, y: number): boolean =>
    x === y || y === 20 || x === 12 || Math.abs((x - 28) ** 2 + (y - 14) ** 2 - 81) < 10;
  const opaque = makeRaster(40, 40, (x, y) => (ink(x, y) ? BLACK : [128, 128, 128, 255]));
  const halo = makeRaster(40, 40, (x, y) => {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        if (ink(x + dx, y + dy)) return ink(x, y) ? BLACK : [128, 128, 128, 255];
    return [0, 0, 0, 0];
  });
  const grey = makeRaster(140, 100, () => [128, 128, 128, 255]);

  it.each([1, 2, 3, 5])("finds the line-art sprite at phase offset %i (mod 4)", (o) => {
    for (const sp of [opaque, halo]) {
      const img = paste(grey, sp, 40 + o, 30 + o);
      const m = locate(img, sp, { scales: [1] }).value!.matches[0];
      expect(m).toMatchObject({ x: 40 + o, y: 30 + o });
      expect(m!.score).toBeGreaterThan(0.95);
    }
  });
});

describe("nccAt and scaleSprite (Q09)", () => {
  const bg = noise(120, 80, 5);
  const sprite = circleSprite(30, 8);
  const img = paste(bg, sprite, 40, 25);

  it("scores a fixed placement with the default or a custom mask", () => {
    expect(nccAt(img, sprite, 40, 25)).toBeGreaterThan(0.99);
    expect(nccAt(img, sprite, 41, 25)!).toBeLessThan(0.9);
    const left = new Uint8Array(30 * 30);
    for (let y = 0; y < 30; y++)
      for (let x = 0; x < 15; x++) left[y * 30 + x] = sprite.data[(y * 30 + x) * 4 + 3]!;
    expect(nccAt(img, sprite, 40, 25, left)).toBeGreaterThan(0.99);
    expect(nccAt(img, sprite, 100, 25)).toBeUndefined();
    expect(nccAt(img, sprite, 0.5, 0)).toBeUndefined();
    expect(nccAt(img, sprite, 40, 25, new Uint8Array(3))).toBeUndefined();
  });

  it("locate returns the scaled sprite and mask it matched with", () => {
    const res = locate(img, sprite, { scales: [0.9, 1] }).value!;
    expect(res.sprites.map((s) => s.scale)).toContain(res.matches[0]!.scale);
    const s = res.sprites.find((x) => x.scale === res.matches[0]!.scale)!;
    expect([s.sprite.width, s.sprite.height]).toEqual([
      res.matches[0]!.width,
      res.matches[0]!.height,
    ]);
    expect(s.mask).toHaveLength(s.sprite.width * s.sprite.height);
    expect(scaleSprite(sprite, 0.9).value!.mask).toEqual(scaleSprite(sprite, 0.9).value!.mask);
    expect(scaleSprite(sprite, 1).value!.sprite).toBe(sprite);
  });
});

describe("floodFill and label (Q09)", () => {
  // Two diagonal pixels: 8-connected, not 4-connected; one separate pixel.
  const w = 5;
  const h = 4;
  const fg = new Uint8Array(w * h);
  for (const [x, y] of [
    [0, 0],
    [1, 1],
    [4, 3],
  ] as const)
    fg[y * w + x] = 1;

  it("labels in raster-scan order with 4 and 8 connectivity", () => {
    const l4 = label(w, h, fg, 4);
    expect([l4.count, [...l4.areas]]).toEqual([3, [1, 1, 1]]);
    const l8 = label(w, h, fg, 8);
    expect([l8.count, [...l8.areas]]).toEqual([2, [2, 1]]);
    expect(l8.labels[0]).toBe(1);
    expect(l8.labels[w + 1]).toBe(1);
    expect(l8.labels[3 * w + 4]).toBe(2);
    expect(l8.bboxes[0]).toEqual({ x: 0, y: 0, w: 2, h: 2 });
  });

  it("floods from seeds through a predicate", () => {
    const m = floodFill(w, h, [0], (i) => fg[i] === 1, 8);
    expect([...m].reduce((a, b) => a + b, 0)).toBe(2);
    expect(m[3 * w + 4]).toBe(0);
  });
});

describe("removeBackground details (Q07, Q12, Q19)", () => {
  it("returns the input unchanged when the whole border is transparent", () => {
    const r = makeRaster(8, 8, (x, y) => (x > 2 && x < 5 && y > 2 && y < 5 ? BLACK : [0, 0, 0, 0]));
    const res = removeBackground(r);
    expect(codes(res)).toEqual(["asset/no-background"]);
    expect(res.value!.raster).toBe(r);
    expect(res.value!.removed).toBe(0);
  });

  it("a 1 px diagonal outline still seals its inside (4-connected fill)", () => {
    const c = 12;
    const r = makeRaster(25, 25, (x, y) =>
      Math.abs(x - c) + Math.abs(y - c) === 8 ? BLACK : WHITE,
    );
    const res = removeBackground(r).value!;
    expect(px(res.raster, 0, 0)[3]).toBe(0);
    expect(px(res.raster, c, c)).toEqual(WHITE);
    expect(res.mask[c * 25 + c]).toBe(0);
    expect(res.mask[0]).toBe(1);
  });

  it("warns background-covers-image when everything is background, and counts only non-transparent pixels", () => {
    const flat = makeRaster(6, 6, () => WHITE);
    const res = removeBackground(flat);
    expect(codes(res)).toEqual(["asset/background-covers-image"]);
    expect(res.value!.removed).toBe(36);
    // Half already transparent: removing the rest still covers the image.
    const half = makeRaster(6, 6, (x) => (x < 3 ? [0, 0, 0, 0] : WHITE));
    expect(codes(removeBackground(half))).toEqual(["asset/background-covers-image"]);
    expect(removeBackground(half).value!.removed).toBe(18);
  });
});

describe("decode (Q03, Q17, orientation)", () => {
  it("applies every EXIF orientation 1-8 with the right dimensions", async () => {
    const level = (bx: number): number => 30 + bx * 60;
    const plain = (await decodeImage(makeJpeg(16, 8, level))).value!.raster;
    for (let o = 1; o <= 8; o++) {
      const d = (await decodeImage(makeJpeg(16, 8, level, o))).value!;
      expect(d.asset.orientation).toBe(o);
      expect([d.raster.width, d.raster.height]).toEqual(o >= 5 ? [8, 16] : [16, 8]);
      expect(d.raster.data).toEqual(applyOrientation(plain, o).data);
    }
  });

  it("validates svgSize and refuses an SVG that would exceed the pixel cap", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    );
    for (const bad of [0, -3, 1.5, Number.NaN, 99999]) {
      expect((await decodeImage(svg, { svgSize: bad })).diagnostics[0]).toMatchObject({
        code: "asset/bad-option",
        params: { option: "svgSize" },
      });
    }
    const big = await decodeImage(svg, { svgSize: 8192 });
    expect(big.value).toBeUndefined();
    expect(codes(big)).toEqual(["asset/too-large"]);
  });
});

describe("align (Q08)", () => {
  const scene = (() => {
    let r = makeRaster(160, 120, () => WHITE);
    r = paste(r, noise(30, 24, 3), 20, 18);
    r = paste(r, noise(26, 30, 4), 80, 50);
    r = paste(r, noise(40, 16, 5), 40, 86);
    r = paste(r, noise(24, 24, 6), 110, 20);
    return r;
  })();

  it("recovers a shift larger than the default patch inset and reports consensus and margin", () => {
    const res = align(scene, shifted(scene, 30, -20));
    expect([res.value!.dx, res.value!.dy]).toEqual([30, -20]);
    expect(res.value!.tried).toBeGreaterThan(1);
    expect(res.value!.support).toBeGreaterThanOrEqual(2);
    expect(res.value!.margin).toBeGreaterThan(0.05);
  });

  it("uses maxShift to resolve a repeated structure", () => {
    const tile = noise(24, 24, 9, 4);
    const rep = makeRaster(144, 96, (x, y) => px(tile, x % 24, y % 24));
    const moved = shifted(rep, 5, 3);
    const res = align(rep, moved, { maxShift: 10 });
    expect([res.value!.dx, res.value!.dy]).toEqual([5, 3]);
    // Unconstrained, a periodic drawing is ambiguous and says so.
    const free = align(rep, moved);
    expect(free.value).toBeDefined();
    expect(free.value!.margin).toBeLessThan(0.05);
    expect(codes(free)).toContain("asset/ambiguous");
  });

  it("an exclusion mask keeps the patch off a part that moves on its own", () => {
    const b = (() => {
      const s = shifted(scene, 7, 5);
      // The blob at (80,50) 26x30 does not follow the global shift: it stays put.
      return paste(
        s,
        makeRaster(26, 30, (x, y) => px(scene, 80 + x, 50 + y)),
        80,
        50,
      );
    })();
    const fixed = [{ x: 76, y: 46, w: 34, h: 38 }];
    const res = align(scene, b, { exclude: fixed, patches: 3 });
    expect([res.value!.dx, res.value!.dy]).toEqual([7, 5]);
    const asMask = new Uint8Array(160 * 120);
    for (let y = 46; y < 84; y++) for (let x = 76; x < 110; x++) asMask[y * 160 + x] = 1;
    expect(align(scene, b, { exclude: asMask }).value).toMatchObject({ dx: 7, dy: 5 });
    expect(codes(align(scene, b, { exclude: new Uint8Array(4) }))).toEqual(["asset/bad-option"]);
  });
});

describe("shrink pass-through (Q14)", () => {
  it("returns C-1's cleaned bytes for a PNG that already fits", async () => {
    const { shrinkImage } = await import("../src/index.js");
    const png = encodePng(noise(20, 10, 2));
    const out = (await shrinkImage(png, 64)).value!;
    expect(out.resized).toBe(false);
    expect(out.bytes).toEqual(png);
  });
});

describe("ordering and goldens (Q18, Q19)", () => {
  const bg = noise(220, 140, 11);
  const sprite = circleSprite(36, 77);

  it("rounds scores to 1e-6 buckets and is independent of paste order", () => {
    const a = paste(paste(paste(bg, sprite, 150, 30), sprite, 20, 90), sprite, 60, 30);
    const b = paste(paste(paste(bg, sprite, 60, 30), sprite, 150, 30), sprite, 20, 90);
    const ra = locate(a, sprite, { scales: [1], top: 3 }).value!.matches;
    const rb = locate(b, sprite, { scales: [1], top: 3 }).value!.matches;
    expect(ra).toEqual(rb);
    for (const m of ra)
      expect(Math.abs(m.score * 1e6 - Math.round(m.score * 1e6))).toBeLessThan(1e-6);
    // Score-bucket order, not reading order: a perturbed twin ranks below the exact ones even though it is higher on the page.
    const dim = makeRaster(36, 36, (x, y) => {
      const p = px(sprite, x, y);
      return x === 18 && y === 18 ? [(p[0] + 90) & 255, p[1], p[2], p[3]] : p;
    });
    const c = paste(paste(bg, sprite, 100, 90), dim, 40, 10);
    const rc = locate(c, sprite, { scales: [1], top: 2 }).value!.matches;
    expect(rc.map((m) => [m.x, m.y])).toEqual([
      [100, 90],
      [40, 10],
    ]);
  });

  it("pins golden SHA-256s of encodePng and locate output", () => {
    const r = makeRaster(13, 9, (x, y) => [x * 19, y * 27, (x * y) & 255, x === 3 ? 0 : 200]);
    expect(sha(encodePng(r))).toBe(
      "c14da3c8c8093a1d3d88cf0a2755da0c16d0c930fd079f5b8baa8dfc40789169",
    );
    expect(decodePng(encodePng(r)).data).toEqual(r.data);
    const img = paste(paste(bg, sprite, 150, 30), sprite, 60, 30);
    expect(sha(JSON.stringify(locate(img, sprite).value!.matches))).toBe(
      "4c7c644ea4b3e2e0cb2d2b3257646e68ba9904ea6c34e6e25984de0be5b5786d",
    );
  });
});
