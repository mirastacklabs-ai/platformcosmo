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
export { sanitizeSvg, createIconResolver, fetchIconPack } from "./icons/index.js";
