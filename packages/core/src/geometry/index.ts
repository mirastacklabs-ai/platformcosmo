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
