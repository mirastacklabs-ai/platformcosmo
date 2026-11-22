/**
 * `@platformcosmo/core/internal`: exports for first-party packages (the CLI and the packs). They are
 * not public API and may change in any release; do not depend on them from outside this repository.
 */

/** Typo hints as core diagnostics give them. The suggestion text and matching are not stable. */
export { didYouMean } from "./schema/suggest.js";
/**
 * For the DC pack's rack assemblies (assemblies.md 8): the A2-3 program resolver and step planner
 * run over a rack tree exactly as over a spec assembly, and a turned tray's depth halves are
 * reassigned with core's rule.
 */
export { AssemblyPrograms } from "./scene/assembly/plan.js";
export type { AssemblyProgramsOptions } from "./scene/assembly/plan.js";
export { reassignSplit } from "./geometry/parts.js";
// The rack targeting rule of assembly mode (assemblies 8.1), shared with the DC pack.
export { rackTargeted } from "./scene/assembly/racks.js";
// The resolved assembly tree, for `pcosmo validate --suggest` (effective placement).
export { buildAssemblies } from "./scene/assembly/tree.js";
export type { AssemblyBuild, AssemblyBuildOptions } from "./scene/assembly/tree.js";
// Close-up size and depth checks for the CLI (assemblies section 8.5; D-1b).
export { closeupDiagnostics } from "./scene/assembly/plan-scene.js";
export type { CloseupCheckContext } from "./scene/assembly/plan-scene.js";
