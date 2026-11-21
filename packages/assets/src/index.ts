/**
 * `@platformcosmo/assets`: raster operations for figure ingestion (Track C-3). Pure functions over
 * straight RGBA buffers, deterministic, no network. CLI-only; not published.
 */
export type { Raster, Rect, OpResult } from "./raster.js";
export { MAX_PIXELS, MAX_MULTIPLY_ADDS, createRaster, luminanceOverWhite } from "./raster.js";
export { encodePng } from "./png.js";
export { decodeImage, applyOrientation } from "./decode.js";
export type { DecodeOptions, DecodedImage } from "./decode.js";
export { crop, trim, opaqueBounds, removeBackground, shrink, shrinkImage } from "./ops.js";
export type { BackgroundOptions, BackgroundResult, ShrunkImage } from "./ops.js";
export { floodFill, label, labelBox } from "./cc.js";
export type { Connectivity, Labels } from "./cc.js";
export { locate, nccAt, scaleSprite, luminancePlane, DEFAULT_SCALES } from "./locate.js";
export type { LocateOptions, LocateResult, LuminancePlane, Match, ScaledSprite } from "./locate.js";
export { align } from "./align.js";
export type { AlignOptions, Alignment } from "./align.js";
export {
  runFigure,
  checkFigure,
  cutout,
  fragmentOf,
  outputsFromFragment,
  exclusionOverlay,
  stableStringify,
  validateManifest,
  MANIFEST_LIMITS,
} from "./figure/index.js";
export type {
  FigureManifest,
  ManifestPart,
  Annotation,
  FigureState,
  FigureOptions,
  FigureSources,
  FigureLimits,
  FigureOutputs,
  FigureOutputPart,
  FigureReport,
  CheckEntry,
  CheckItem,
  CheckStatus,
  RunFigureOptions,
  FigureFragment,
  FigureFile,
  FigureResult,
  FigureSourceInfo,
  CutoutOptions,
  CutoutResult,
} from "./figure/index.js";
