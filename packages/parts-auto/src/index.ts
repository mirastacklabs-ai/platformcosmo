/** PlatformCosmo `auto:` part shapes (Track E-2b): a generic inline engine in millimetres. */
import type { PartShapePack, PartShapeRegistry } from "@platformcosmo/core";
import { autoShapes } from "./shapes.js";

export { autoShapes } from "./shapes.js";
export { engineLayout } from "./anchors.js";
export type { EngineLayout } from "./anchors.js";
export { MAX_EXTENT_MM, paramSpecsOf } from "./define.js";
export type { AutoParams, ParamSpec } from "./define.js";

export const autoPack: PartShapePack = {
  id: "auto",
  name: "Automotive (engine)",
  license: "Apache-2.0",
  shapes: autoShapes,
};

const byRef = new Map(autoShapes.map((s) => [`auto:${s.id}`, s]));
const refs = [...byRef.keys()].sort();

/** Registry over the `auto:` pack; `get` takes the full `auto:id` ref. */
export const registry: PartShapeRegistry = {
  get: (ref) => byRef.get(ref),
  list: () => refs,
};
