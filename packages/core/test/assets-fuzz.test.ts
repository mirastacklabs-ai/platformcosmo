import { describe, expect, test } from "vitest";
import { DEFAULT_IMAGE_LIMITS, prepareImage } from "../src/assets/prepare.js";
import {
  JPEG_METADATA,
  METADATA_CHUNKS,
  SVG_OK,
  b64,
  enc,
  makeJpeg,
  makePng,
  rng,
} from "./assets-fixtures.js";

const seeds = [
  makePng({ extra: [METADATA_CHUNKS.tEXt as Uint8Array, METADATA_CHUNKS.iCCP as Uint8Array] }),
  makeJpeg({ meta: [JPEG_METADATA.exif(6), JPEG_METADATA.xmp, JPEG_METADATA.com] }),
  enc(SVG_OK),
];
const srcs = ["a.png", "a.jpg", "a.svg", "a.webp", "data:image/png;base64,AAAA", ""];

function mutate(base: Uint8Array, r: () => number): Uint8Array {
  const b = Array.from(base);
  const ops = 1 + Math.floor(r() * 6);
  for (let i = 0; i < ops; i++) {
    const kind = Math.floor(r() * 5);
    const at = Math.floor(r() * (b.length + 1));
    if (kind === 0 && b.length > 0) b[Math.min(at, b.length - 1)] = Math.floor(r() * 256);
    else if (kind === 1) b.splice(at, Math.floor(r() * 8));
    else if (kind === 2)
      b.splice(
        at,
        0,
        ...Array.from({ length: 1 + Math.floor(r() * 8) }, () => Math.floor(r() * 256)),
      );
    else if (kind === 3) b.length = at;
    else if (b.length > 0)
      b[Math.min(at, b.length - 1)] = [0x00, 0xff, 0x7f, 0x80][Math.floor(r() * 4)] as number;
  }
  return Uint8Array.from(b);
}

describe("fuzz", () => {
  test("mutated and random input never throws, stays bounded, and is deterministic", () => {
    const runOnce = (): string[] => {
      const r = rng(0xc0ffee);
      const outcomes: string[] = [];
      const t0 = performance.now();
      for (let i = 0; i < 3000; i++) {
        const base = seeds[i % seeds.length] as Uint8Array;
        const bytes =
          i % 10 === 9
            ? Uint8Array.from({ length: Math.floor(r() * 200) }, () => Math.floor(r() * 256))
            : mutate(base, r);
        const src = srcs[Math.floor(r() * srcs.length)] as string;
        const res = prepareImage({ key: `k${i}`, src, bytes }, DEFAULT_IMAGE_LIMITS);
        // the contract: an asset or at least one diagnostic, and no error alongside an asset
        if (res.asset) {
          expect(res.diagnostics.some((d) => d.severity === "error")).toBe(false);
          expect(res.asset.width).toBeGreaterThan(0);
          expect(res.asset.height).toBeGreaterThan(0);
          expect(res.asset.hash).toMatch(/^sha256-/);
        } else {
          expect(res.diagnostics.some((d) => d.severity === "error")).toBe(true);
        }
        outcomes.push(`${res.asset?.hash ?? "-"}|${res.diagnostics.map((d) => d.code).join(",")}`);
      }
      expect(performance.now() - t0).toBeLessThan(20_000);
      return outcomes;
    };
    expect(runOnce()).toEqual(runOnce());
  }, 60_000);

  test("random data URIs never throw", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const bytes = mutate(seeds[i % 3] as Uint8Array, r);
      const mime = ["png", "jpeg", "svg+xml", "webp"][i % 4];
      const res = prepareImage(
        { key: "u", src: `data:image/${mime};base64,${b64(bytes)}`, bytes: new Uint8Array(0) },
        DEFAULT_IMAGE_LIMITS,
      );
      expect(res.asset !== undefined || res.diagnostics.length > 0).toBe(true);
    }
  });

  test("worst-case inputs finish quickly", () => {
    const t0 = performance.now();
    const huge = new Uint8Array(2 * 1024 * 1024);
    huge.set([0xff, 0xd8, 0xff]);
    huge.fill(0xff, 3); // endless fill bytes
    prepareImage({ key: "a", src: "a.jpg", bytes: huge }, DEFAULT_IMAGE_LIMITS);
    const deep = enc(`<svg viewBox="0 0 1 1">${"<g>".repeat(5000)}`);
    prepareImage({ key: "b", src: "b.svg", bytes: deep }, DEFAULT_IMAGE_LIMITS);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});
