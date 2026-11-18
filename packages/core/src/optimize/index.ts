import { optimize as svgo, type Config } from "svgo";
import type { OptimizeFn } from "../contracts/index.js";

/**
 * SVGO (exact version pinned in package.json) with an animation-safe config. The animator drives
 * elements by id, class and CSS, so anything that removes, merges, renames or restyles elements
 * is off: `cleanupIds`, `minifyStyles`, `inlineStyles`, `removeUselessDefs`, `removeHiddenElems`
 * (our hidden captions and edge paths are visible to CSS/SMIL), `convertShapeToPath`,
 * `removeUnknownsAndDefaults` (SMIL attributes), `removeEmptyContainers`, `collapseGroups`,
 * `moveElemsAttrsToGroup`, `moveGroupAttrsToElems`, `mergePaths`, `removeUselessStrokeAndFill`,
 * `sortDefsChildren`, `removeDesc`.
 * What remains: whitespace/comment removal, number and path-data rounding (2 decimals), colors.
 */
const DISABLED = [
  "cleanupIds",
  "minifyStyles",
  "inlineStyles",
  "removeUselessDefs",
  "removeHiddenElems",
  "convertShapeToPath",
  "removeUnknownsAndDefaults",
  "removeEmptyContainers",
  "collapseGroups",
  "moveElemsAttrsToGroup",
  "moveGroupAttrsToElems",
  "mergePaths",
  "removeUselessStrokeAndFill",
  "sortDefsChildren",
  "removeDesc",
] as const;

const overrides: Record<string, false | Record<string, unknown>> = {};
for (const name of DISABLED) overrides[name] = false;
overrides.convertPathData = { floatPrecision: 2 };
overrides.cleanupNumericValues = { floatPrecision: 2 };

const config: Config = {
  multipass: false,
  js2svg: { pretty: false },
  plugins: [{ name: "preset-default", params: { overrides } }],
};

export const optimize: OptimizeFn = (svg) => svgo(svg, config).data;
