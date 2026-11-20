import { decodePng } from "@platformcosmo/core";
import { describe, expect, it } from "vitest";
import { align, encodePng, luminancePlane, nccAt, scaleSprite, type Raster } from "../src/index.js";
import { makeRaster, noise, paste, px, shifted, type Px } from "./fixtures.js";

const WHITE: Px = [255, 255, 255, 255];
const codes = (r: { diagnostics: readonly { code: string }[] }): string[] =>
  r.diagnostics.map((d) => d.code);

function circleSprite(size: number, seed: number): Raster {
  const n = noise(size, size, seed);
  const c = (size - 1) / 2;
  return makeRaster(size, size, (x, y) =>
    (x - c) ** 2 + (y - c) ** 2 <= (size / 2) ** 2 ? px(n, x, y) : [0, 0, 0, 0],
  );
}

describe("final review items (N2, N3, N4, N8, N9, N11)", () => {
  const scene = (() => {
    let r = makeRaster(160, 120, () => WHITE);
    r = paste(r, noise(30, 24, 3), 20, 18);
    r = paste(r, noise(26, 30, 4), 80, 50);
    r = paste(r, noise(40, 16, 5), 40, 86);
    r = paste(r, noise(24, 24, 6), 110, 20);
    return r;
  })();

  it("N2: one align run shares one budget and suggests --max-shift", () => {
    const moved = shifted(scene, 4, 3);
    expect(align(scene, moved, { patches: 1 }).value).toBeDefined();
    const res = align(scene, moved, { maxMultiplyAdds: 5 });
    expect(res.value).toBeUndefined();
    expect(res.diagnostics[0]).toMatchObject({ code: "asset/too-expensive" });
    expect(res.diagnostics[0]!.suggestion).toMatch(/max-shift/);
  });

  it("N2: a budget that covers one patch but not three stops early with a warning", () => {
    const moved = shifted(scene, 4, 3);
    const full = align(scene, moved);
    expect(full.value!.tried).toBe(3);
    // Find a cap that lets the first patch through but not all three.
    let found = false;
    for (let cap = 1e5; cap < 5e8 && !found; cap *= 1.1) {
      const r = align(scene, moved, { maxMultiplyAdds: Math.round(cap) });
      if (r.value && r.value.tried < 3) {
        expect(codes(r)).toContain("asset/too-expensive");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("N3: a precomputed luminance plane gives the same scores as the raster", () => {
    const sp = circleSprite(30, 8);
    const img = paste(noise(120, 80, 5), sp, 40, 25);
    const plane = luminancePlane(img);
    for (const [x, y] of [
      [40, 25],
      [41, 26],
      [10, 10],
    ] as const) {
      expect(nccAt(plane, sp, x, y)).toBe(nccAt(img, sp, x, y));
    }
    expect(nccAt({ ...plane, width: 3 }, sp, 0, 0)).toBeUndefined();
  });

  it("N4: a periodic drawing is reported ambiguous when the window holds several periods", () => {
    const tile = noise(8, 8, 9, 4);
    const rep = makeRaster(160, 120, (x, y) => px(tile, x % 8, y % 8));
    const moved = shifted(rep, 3, 2);
    const res = align(rep, moved, { maxShift: 12 });
    expect(codes(res)).toContain("asset/ambiguous");
    expect(res.value!.margin).toBeLessThan(0.05);
    // Within less than one period the shift is unique and the margin is real.
    const ok = align(rep, moved, { maxShift: 3 });
    expect([ok.value!.dx, ok.value!.dy]).toEqual([3, 2]);
    expect(ok.value!.margin).toBeGreaterThan(0.1);
  });

  it("N9: exclude rectangles are validated like crop's", () => {
    for (const bad of [
      { x: 0.5, y: 0, w: 4, h: 4 },
      { x: 0, y: 0, w: 0, h: 4 },
    ]) {
      expect(align(scene, scene, { exclude: [bad] }).diagnostics[0]).toMatchObject({
        code: "asset/bad-option",
        params: { option: "exclude" },
      });
    }
  });

  it("N8: core's decodePng refuses an absurd declared size before allocating", () => {
    const forged = new Uint8Array(encodePng(noise(4, 4, 1)));
    new DataView(forged.buffer).setUint32(16, 100000);
    new DataView(forged.buffer).setUint32(20, 100000);
    expect(() => decodePng(forged)).toThrow(/outside the supported range/);
  });

  it("N11: upscaling premultiplies, so a transparent pixel's colour never bleeds in", () => {
    const sp = makeRaster(2, 1, (x) => (x ? [255, 0, 0, 0] : [0, 0, 255, 255]));
    const up = scaleSprite(sp, 2).value!.sprite;
    for (let x = 0; x < up.width; x++) {
      const p = px(up, x, 0);
      if (p[3] > 0) expect([p[0], p[1], p[2]]).toEqual([0, 0, 255]);
    }
  });
});
