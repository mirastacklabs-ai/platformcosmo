/**
 * Streaming video encoding (D33). The frozen `VideoEncoder` contract takes every frame at once;
 * an encoder that also implements `open` is fed one frame at a time instead, so memory stays
 * bounded by a single frame. Encoders without `open` still work: frames are buffered for them.
 */
import type { VideoEncoder } from "../contracts/index.js";

export type VideoSinkOptions = Parameters<VideoEncoder["encode"]>[1];

/** Receives PNG frames in order. `write` resolves once the frame was consumed (backpressure). */
export interface VideoSink {
  write(frame: Uint8Array): Promise<void>;
  /** Ends the stream and returns the finished file. */
  finish(): Promise<Uint8Array>;
  /** Drops everything (kills child processes); must be safe to call at any point. */
  abort(): void;
}

export interface StreamingVideoEncoder extends VideoEncoder {
  open(options: VideoSinkOptions): Promise<VideoSink> | VideoSink;
}

export function isStreamingEncoder(e: VideoEncoder): e is StreamingVideoEncoder {
  return typeof (e as Partial<StreamingVideoEncoder>).open === "function";
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
