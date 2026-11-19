// Other workspace packages typecheck this file through a path import without core's tsconfig, so
// the ambient typings for gifenc are referenced here.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./gifenc.d.ts" />
/** Built-in GIF `VideoEncoder` (pure JS: `gifenc`). Deterministic for identical frames. */
import * as gifencNs from "gifenc";
import type { Palette } from "gifenc";
import { decodePng } from "./png.js";
import type { VideoEncoder, VideoSink, VideoSinkOptions } from "../contracts/index.js";
import { MAX_OUTPUT_BYTES, OutputTooLargeError } from "./stream.js";

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

// gifenc is CommonJS: under plain Node ESM only `default` carries the functions, under bundlers
// the namespace does; use whichever has them.
type Gifenc = typeof gifencNs;
const gifenc = (
  (gifencNs as unknown as { default?: Gifenc }).default?.GIFEncoder
    ? (gifencNs as unknown as { default: Gifenc }).default
    : gifencNs
) as Gifenc;
const { GIFEncoder, applyPalette, quantize } = gifenc;

/** Streaming GIF sink: one frame decoded, quantized and written at a time. */
function openGif(options: VideoSinkOptions, maxOutputBytes: number): VideoSink {
  if (options.format !== "gif") {
    throw new Error(`gifEncoder cannot encode ${options.format}; supply an encoder for it`);
  }
  const gif = GIFEncoder();
  let index = 0;
  let prev: { data: Uint8Array; palette: Palette; index: Uint8Array } | undefined;
  // GIF delays are whole centiseconds: spread the rounding remainder so the total stays exact.
  const centis = (i: number): number =>
    Math.round(((i + 1) * 100) / options.fps) - Math.round((i * 100) / options.fps);
  return {
    async write(frame) {
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
      gif.writeFrame(prev.index, img.width, img.height, {
        palette: prev.palette,
        delay: centis(index++) * 10,
      });
      const size = gif.bytesView().length;
      if (size > maxOutputBytes) throw new OutputTooLargeError(size, maxOutputBytes);
    },
    async finish() {
      if (index === 0) throw new Error("no frames to encode");
      gif.finish();
      return gif.bytes();
    },
    abort() {
      prev = undefined;
    },
  };
}

/** Built-in GIF encoder; `maxOutputBytes` (default 1 GiB) is injectable for tests. */
export function createGifEncoder(maxOutputBytes = MAX_OUTPUT_BYTES): VideoEncoder {
  return {
    open: (options) => openGif(options, maxOutputBytes),
    async encode(frames, options) {
      const sink = openGif(options, maxOutputBytes);
      try {
        for (const f of frames) await sink.write(f);
        return await sink.finish();
      } catch (e) {
        await sink.abort();
        throw e;
      }
    },
  };
}

export const gifEncoder: VideoEncoder = createGifEncoder();
