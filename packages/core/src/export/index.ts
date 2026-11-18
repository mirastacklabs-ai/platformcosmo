/** Entry point owned by Track B (stub until implemented). */
import type { ExportFn, RasterizeFn, VideoEncoder } from "../contracts/index.js";

export const exportOutputs: ExportFn = () =>
  Promise.reject(new Error("not implemented: owned by Track B"));
export const rasterize: RasterizeFn = () =>
  Promise.reject(new Error("not implemented: owned by Track B"));
export const gifEncoder: VideoEncoder = {
  encode: () => Promise.reject(new Error("not implemented: owned by Track B")),
};
