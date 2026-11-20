/** PlatformCosmo `hw:` part shapes (Track E-2a): generic server internals in millimetres. */
import type { PartShapePack, PartShapeRegistry } from "@platformcosmo/core";
import { hwShapes } from "./shapes.js";

export { hwShapes } from "./shapes.js";
export { MAX_EXTENT_MM, paramSpecsOf } from "./define.js";
export type { HwParams, ParamSpec } from "./define.js";

export const hwPack: PartShapePack = {
  id: "hw",
  name: "Hardware (server internals)",
  license: "Apache-2.0",
  shapes: hwShapes,
};

const byRef = new Map(hwShapes.map((s) => [`hw:${s.id}`, s]));
const refs = [...byRef.keys()].sort();

/** Registry over the `hw:` pack; `get` takes the full `hw:id` ref. */
export const registry: PartShapeRegistry = {
  get: (ref) => byRef.get(ref),
  list: () => refs,
};
