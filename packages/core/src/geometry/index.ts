export { round2, fmt } from "./num.js";
export {
  DEFAULT_TILE_WIDTH,
  createProjection,
  boxCorners,
  boundsOfPoints,
  projectBoxBounds,
  unionRects,
} from "./projection.js";
export type { ProjectionOptions } from "./projection.js";
export {
  primitiveFaces,
  primitiveSilhouette,
  convexHull,
  pointsToPath,
  faceToPath,
} from "./primitives.js";
export type { Silhouette } from "./primitives.js";
export {
  CIRCULAR_KINDS,
  RING_INNER_RATIO,
  TRAY_WALL_RATIO,
  partGeometry,
  partPrimitiveFaces,
  partPrimitiveSilhouette,
  studGrid,
  trayParts,
  halfOf,
  reassignSplit,
  partGeometryFaces,
  STUD_DIAMETER,
  STUD_HEIGHT,
} from "./parts.js";
export type {
  Half,
  PartFace,
  PartGeometrySpec,
  PartPrimitiveFaces,
  StudGridOptions,
  TrayPart,
} from "./parts.js";
export { applyMatrix, billboardRect, decalPlacement } from "./decals.js";
export type { BillboardPlacement, DecalPlacement, Fit, Matrix } from "./decals.js";
