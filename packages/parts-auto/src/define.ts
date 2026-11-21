import {
  Draft,
  MAX_PARAM_DIAGNOSTICS,
  definePack,
  type ParamSpec,
  type ParamValue,
} from "@platformcosmo/core";

/** Validated shape params: integers, booleans and enum strings only. */
export type AutoParams = Record<string, ParamValue>;

export { Draft, MAX_PARAM_DIAGNOSTICS };
export type { ParamSpec };

/**
 * Extent limits per axis. Pack shapes expect real length units (mm, cm or in): coordinates are
 * rounded to 2 decimals of the unit, so a part a few hundredths of a unit across degenerates.
 * Sizes are clamped to [MIN_DIM, MAX_EXTENT_MM] so every origin is non-negative and finite.
 */
export const MAX_EXTENT_MM = 100_000;

const pack = definePack<AutoParams>({ prefix: "auto", maxExtent: MAX_EXTENT_MM });

/** Declared params of an `auto:` shape id, for docs and tests. */
export const paramSpecsOf = pack.paramSpecsOf;
export const defineShape = pack.defineShape;
