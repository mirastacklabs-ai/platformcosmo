/** PlatformCosmo `brick:` part shapes (Track E-3): generic stud-grid bricks in stud units. */
import type { PartShapePack, PartShapeRegistry } from "@platformcosmo/core";
import { brickShapes } from "./shapes.js";

export { brickShapes } from "./shapes.js";
export { palette, paletteNames } from "./palette.js";
export type { PaletteColour } from "./palette.js";
export { checkBrickPlacement } from "./grid.js";
export type { BrickPlacement } from "./grid.js";
export { MAX_EXTENT, MAX_STUDS, paramSpecsOf } from "./define.js";
export type { BrickParams, ParamSpec } from "./define.js";

export const brickPack: PartShapePack = {
  id: "brick",
  name: "Bricks (stud grid)",
  license: "Apache-2.0",
  shapes: brickShapes,
};

const byRef = new Map(brickShapes.map((s) => [`brick:${s.id}`, s]));
const refs = [...byRef.keys()].sort();

/** Registry over the `brick:` pack; `get` takes the full `brick:id` ref. */
export const registry: PartShapeRegistry = {
  get: (ref) => byRef.get(ref),
  list: () => refs,
};
