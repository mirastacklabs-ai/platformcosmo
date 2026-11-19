export { validateSpec, SCHEMA_ID, SCHEMA_REVISION } from "./schema/validate.js";
export type { SpecError, ValidationResult } from "./schema/validate.js";
export type * from "./schema/types.gen.js";
export type * from "./contracts/index.js";

// Stage entry points (stubs until each owning track lands; see contracts/render.ts).
export { parseSpec, validate } from "./schema/index.js";
export { buildScene } from "./scene/index.js";
export { render } from "./render/index.js";
export { emit } from "./emit/index.js";
export { optimize } from "./optimize/index.js";
export { createAnimator } from "./anim/index.js";
export {
  exportOutputs,
  rasterize,
  setResvgWasm,
  gifEncoder,
  validateRenderOptions,
} from "./export/index.js";
export type { StreamingVideoEncoder, VideoSink, VideoSinkOptions } from "./export/index.js";
export { sanitizeSvg, createIconResolver, fetchIconPack } from "./icons/index.js";
export {
  computeIconIntegrity,
  iconRejections,
  iconCost,
  PACK_ID_RE,
  verifyIconIntegrity,
  PROVIDER_IDS,
  PROVIDER_TERMS,
} from "./icons/index.js";

// Geometry (Track A1): projection and primitive solids.
export {
  createProjection,
  primitiveFaces,
  primitiveSilhouette,
  boxCorners,
  projectBoxBounds,
  boundsOfPoints,
  unionRects,
  convexHull,
  pointsToPath,
  faceToPath,
  round2,
  fmt,
  DEFAULT_TILE_WIDTH,
} from "./geometry/index.js";
export type { ProjectionOptions, Silhouette } from "./geometry/index.js";

// Depth ordering and text (Track A1).
export { depthOrder, compareBoxes, depthKey, orderGroups } from "./depth/index.js";
export type { DepthItem } from "./depth/index.js";
export {
  EMBED_FAMILY,
  measureText,
  missingGlyphs,
  lineMetrics,
  textToPath,
  subsetWoff2Base64,
  fontAssets,
} from "./text/index.js";
export type { TextAnchor, TextWeight, TextPathOptions } from "./text/index.js";

// Emit helpers (Track A1).
// `iconDef` is internal to the engine: it turns sanitizer output into SvgRaw, so it is not public API.
export { ICON_DEF_TAG, createIds, countElements } from "./emit/index.js";

// Render pipeline pieces (Track A1).
export {
  buildModel,
  createRender,
  withVariant,
  specSchema,
  canonicalJson,
  defaultIdPrefix,
} from "./render/index.js";
export type { ModelInputs, RenderDeps } from "./render/index.js";
