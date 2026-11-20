/** Real (decodable) image fixtures and an image resolver for figure render tests. */
import { deflateSync } from "node:zlib";
import { crc32 } from "../src/assets/png.js";
import { DEFAULT_IMAGE_LIMITS, prepareImage } from "../src/assets/prepare.js";
import type { ImageAsset, ImageAssetResolver } from "../src/index.js";
import { cat, pngChunk, PNG_SIG, ihdr } from "./assets-fixtures.js";

void crc32;

/** A valid RGBA PNG of `w` by `h` pixels; `pixel(x, y)` gives [r, g, b, a]. */
export function realPng(
  w: number,
  h: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): Uint8Array {
  const raw = new Uint8Array(h * (1 + w * 4));
  let at = 0;
  for (let y = 0; y < h; y++) {
    raw[at++] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
      raw[at++] = a;
    }
  }
  return cat(
    PNG_SIG,
    ihdr(w, h, 8, 6),
    pngChunk("IDAT", new Uint8Array(deflateSync(raw))),
    pngChunk("IEND"),
  );
}

/** Prepared assets by id, as the CLI would hand them to `render`. */
export function resolverOf(files: Record<string, Uint8Array>): ImageAssetResolver {
  const map = new Map<string, ImageAsset>();
  for (const [key, bytes] of Object.entries(files)) {
    const ext = bytes[0] === 0xff ? "jpg" : "png";
    const r = prepareImage({ key, src: `${key}.${ext}`, bytes }, DEFAULT_IMAGE_LIMITS);
    if (r.asset === undefined) throw new Error(`fixture ${key}: ${JSON.stringify(r.diagnostics)}`);
    map.set(key, r.asset);
  }
  return {
    get: (k) => map.get(k),
    keys: () => [...map.keys()].sort(),
  };
}

/** The design's heat-sink example images: a 600 x 480 base and a 80 x 60 sprite. */
export function heatSinkImages(): ImageAssetResolver {
  return resolverOf({
    "hs-base": realPng(600, 480, (x, y) => [230 - (y >> 3), 235, 240, 255]),
    "hs-sprite": realPng(80, 60, (x, y) => [40 + x, 90, 160 - y, 255]),
  });
}
