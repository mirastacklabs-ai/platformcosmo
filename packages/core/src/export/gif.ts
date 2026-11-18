/** Built-in GIF `VideoEncoder` (pure JS: `gifenc`). Deterministic for identical frames. */
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import type { Palette } from "gifenc";
import type { VideoEncoder } from "../contracts/index.js";
import { decodePng } from "./png.js";

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

export const gifEncoder: VideoEncoder = {
  async encode(frames, options) {
    if (options.format !== "gif") {
      throw new Error(`gifEncoder cannot encode ${options.format}; supply an encoder for it`);
    }
    if (frames.length === 0) throw new Error("no frames to encode");
    const gif = GIFEncoder();
    const delay = Math.round(1000 / options.fps);
    let prev: { data: Uint8Array; palette: Palette; index: Uint8Array } | undefined;
    for (const frame of frames) {
      const img = decodePng(frame);
      if (img.width !== options.width || img.height !== options.height) {
        throw new Error(
          `frame is ${img.width}x${img.height}, expected ${options.width}x${options.height}`,
        );
      }
      // Still stretches of an animation repeat frames: quantize each distinct frame once.
      if (!prev || !sameBytes(prev.data, img.data)) {
        const palette = quantize(img.data, 256);
        prev = { data: img.data, palette, index: applyPalette(img.data, palette) };
      }
      gif.writeFrame(prev.index, img.width, img.height, { palette: prev.palette, delay });
    }
    gif.finish();
    return gif.bytes();
  },
};
