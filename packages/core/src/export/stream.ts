/**
 * Streaming helpers for `VideoEncoder.open` (D33). Internal: the types live in the contract.
 */
import type { VideoEncoder, VideoSink, VideoSinkOptions } from "../contracts/index.js";

/** Encoded output (the gif/mp4 file) may not exceed this. */
export const MAX_OUTPUT_BYTES = 1024 ** 3;

/** Thrown by an encoder whose finished output would exceed its cap; reported as `export/too-large`. */
export class OutputTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly cap: number,
  ) {
    super(`encoded output is ${bytes} bytes, over the ${cap} byte cap`);
    this.name = "OutputTooLargeError";
  }
}

/** Sink for plain `VideoEncoder`s: collects the frames, encodes on `finish`. */
export function bufferingSink(encoder: VideoEncoder, options: VideoSinkOptions): VideoSink {
  let frames: Uint8Array[] = [];
  return {
    async write(frame) {
      frames.push(frame);
    },
    async finish() {
      const all = frames;
      frames = [];
      return encoder.encode(all, options);
    },
    abort() {
      frames = [];
    },
  };
}
