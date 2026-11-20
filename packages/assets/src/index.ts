/**
 * `@platformcosmo/assets`: raster operations for figure ingestion (Track C-3). Pure functions over
 * straight RGBA buffers, deterministic, no network. CLI-only; not published.
 */
export type { Raster, Rect, OpResult } from "./raster.js";
export { MAX_PIXELS, MAX_MULTIPLY_ADDS, createRaster, luminanceOverWhite } from "./raster.js";
export { encodePng, decodeRgbaPng } from "./png.js";
export { decodeImage, applyOrientation } from "./decode.js";
export type { DecodeOptions, DecodedImage } from "./decode.js";
export {
  crop,
  trim,
  opaqueBounds,
  removeBackground,
  shrink,
  boxResample,
  shrinkImage,
} from "./ops.js";
export type { BackgroundOptions, BackgroundResult, ShrunkImage } from "./ops.js";
export { locate, align, defaultPatch, DEFAULT_SCALES } from "./locate.js";
export type { LocateOptions, LocateResult, Match, AlignOptions, Alignment } from "./locate.js";
