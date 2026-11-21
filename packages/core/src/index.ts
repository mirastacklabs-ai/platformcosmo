export { validateSpec, SCHEMA_ID, SCHEMA_REVISION } from "./schema/validate.js";
export type { SpecError, ValidationResult } from "./schema/validate.js";
export type * from "./schema/types.gen.js";
export type * from "./contracts/index.js";

// Stage entry points (stubs until each owning track lands; see contracts/render.ts).
export { parseSpec, validate } from "./schema/index.js";
export { buildScene } from "./scene/index.js";
export { spec, assembly, explode, build, figure } from "./scene/assembly/builder.js";
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
export { decodePng, pngSize } from "./export/png.js";
export type { DecodedPng } from "./export/png.js";
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
  partGeometryFaces,
  partPrimitiveFaces,
  partPrimitiveSilhouette,
  studGrid,
  STUD_DIAMETER,
  STUD_HEIGHT,
  halfOf,
} from "./geometry/index.js";
export type { Half, PartFace, PartPrimitiveFaces, StudGridOptions } from "./geometry/index.js";
/**
 * @internal For pack authors that need the same typo hints as core diagnostics. The suggestion
 * text and matching are not stable across releases; do not parse or snapshot them.
 */
export { didYouMean } from "./schema/suggest.js";
export {
  Draft,
  MAX_PARAM_DIAGNOSTICS,
  MIN_DIM,
  definePack,
  finishGeometry,
  sanitizeSize,
} from "./parts/define.js";
export type {
  PackOptions,
  Pack,
  ParamHandle,
  ParamSpec,
  ParamValue,
  ShapeInit,
} from "./parts/define.js";
export type { ProjectionOptions, Silhouette } from "./geometry/index.js";

/**
 * @internal For the DC pack's rack assemblies (assemblies.md 8): the A2-3 program resolver and
 * step planner run over a rack tree exactly as over a spec assembly, and a turned tray's depth
 * halves are reassigned with core's rule. Not stable API.
 */
export { AssemblyPrograms } from "./scene/assembly/plan.js";
export type { AssemblyProgramsOptions } from "./scene/assembly/plan.js";
export { reassignSplit } from "./geometry/parts.js";
/** @internal The resolved assembly tree, for `pcosmo validate --suggest` (effective placement). */
export { buildAssemblies } from "./scene/assembly/tree.js";
export type { AssemblyBuild, AssemblyBuildOptions } from "./scene/assembly/tree.js";

// Depth ordering and text (Track A1).
export { depthOrder, compareBoxes, depthKey, orderGroups } from "./depth/index.js";
export type { DepthItem } from "./depth/index.js";
export {
  EMBED_FAMILY,
  EMBED_MONO_FAMILY,
  measureText,
  missingGlyphs,
  lineMetrics,
  textToPath,
  subsetWoff2Base64,
  fontAssets,
} from "./text/index.js";
export type { TextAnchor, TextWeight, TextFamily, TextPathOptions } from "./text/index.js";

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

// Close-up size and depth checks for the CLI (assemblies section 8.5; D-1b). @internal, not public API.
export { closeupDiagnostics } from "./scene/assembly/closeup.js";
export type { CloseupCheckContext } from "./scene/assembly/closeup.js";

// Image assets (Track C-1): validate and clean image bytes, no I/O.
export { prepareImage, decodeImageDataUri, DEFAULT_IMAGE_LIMITS } from "./assets/prepare.js";
