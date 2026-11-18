/**
 * Node-only helpers (`@platformcosmo/core/node`): they spawn processes, which the main entry never
 * does. The CLI builds an mp4 encoder here and passes it as `RenderOptions.video.encoder`.
 */
export { buildFfmpegArgs, createFfmpegEncoder, ffmpegAvailable } from "./export/ffmpeg.js";
export type { FfmpegEncoderOptions } from "./export/ffmpeg.js";
