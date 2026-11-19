/**
 * Merge guard for schema revision 1.2.0 (docs/design/assemblies-tracks.md §0, proposed D66).
 *
 * The schema accepts the 1.2.0 fields (assemblies, images, figures, storyboards, step actions,
 * rack programs, slot internals, close-ups, build programs) before the engine can draw them.
 * Until each phase's renderer lands, `validate` rejects them here with `assembly/unsupported`,
 * so a spec never renders the new fields silently as nothing. Each phase PR sets its group to
 * `false`; when every group is `false` this file and its call go away.
 */
import type { Diagnostic } from "../contracts/index.js";
import type { PlatformCosmoSpec, SpecPart, SpecProgram } from "./types.gen.js";

export type GuardGroup = "phase1a" | "phase1b" | "phase2" | "phase3";

/** Field groups not rendered yet, by the phase that lifts them (tracks §0). */
export const UNRENDERED: Readonly<Record<GuardGroup, boolean>> = {
  /** Phase 1a, figure mode: `images`, `figures`, explode/implode actions. */
  phase1a: true,
  /** Phase 1b, plans and basic explode: `assemblies`. */
  phase1b: true,
  /** Phase 2, server → rack → hall: rack `programs`, slot `assembly`, `closeup`, build programs and build/unbuild actions. */
  phase2: true,
  /** Phase 3: `storyboards`, build steps `from: "callout"` and `subBuild`. */
  phase3: true,
};

const MESSAGE =
  "is part of schema revision 1.2.0 (assemblies and figures), which this build validates but cannot render yet";
const SUGGESTION =
  "Remove it for now, or upgrade platformcosmo to a release that renders assemblies and figures";

const isBuild = (p: SpecProgram): boolean => "kind" in p && p.kind === "build";

/**
 * One `assembly/unsupported` error per unrendered 1.2.0 field present in the spec. A field is
 * reported once, at the outermost unrendered location (nothing inside a rejected `assemblies`
 * array is reported again).
 */
export function unsupportedDiagnostics(
  spec: PlatformCosmoSpec,
  groups: Readonly<Record<GuardGroup, boolean>> = UNRENDERED,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const flag = (path: string, field: string): void => {
    out.push({
      severity: "error",
      code: "assembly/unsupported",
      path,
      message: `"${field}" ${MESSAGE}.`,
      suggestion: SUGGESTION,
    });
  };

  const programs = (list: readonly SpecProgram[] | undefined, base: string): void => {
    (list ?? []).forEach((p, k) => {
      if (!isBuild(p) || !("steps" in p)) return;
      if (groups.phase2) {
        flag(`${base}/programs/${k}`, "kind: build");
        return;
      }
      if (!groups.phase3) return;
      p.steps.forEach((st, j) => {
        const at = `${base}/programs/${k}/steps/${j}`;
        if (st.from === "callout") flag(`${at}/from`, "from: callout");
        if (st.subBuild !== undefined) flag(`${at}/subBuild`, "subBuild");
      });
    });
  };
  const parts = (list: readonly SpecPart[] | undefined, base: string): void => {
    (list ?? []).forEach((part, i) => {
      const at = `${base}/parts/${i}`;
      if (groups.phase2 && part.closeup !== undefined) flag(`${at}/closeup`, "closeup");
      programs(part.programs, at);
      parts(part.parts, at);
    });
  };

  if (groups.phase1b && spec.assemblies !== undefined) flag("/assemblies", "assemblies");
  else {
    (spec.assemblies ?? []).forEach((a, i) => {
      const at = `/assemblies/${i}`;
      if (groups.phase2 && a.closeup !== undefined) flag(`${at}/closeup`, "closeup");
      programs(a.programs, at);
      parts(a.parts, at);
    });
  }
  if (groups.phase1a) {
    if (spec.images !== undefined) flag("/images", "images");
    if (spec.figures !== undefined) flag("/figures", "figures");
  }
  if (groups.phase3 && spec.storyboards !== undefined) flag("/storyboards", "storyboards");

  (spec.steps ?? []).forEach((step, i) => {
    if (step.assembly === undefined) return;
    if (groups.phase1a) {
      flag(`/steps/${i}/assembly`, "assembly");
      return;
    }
    if (!groups.phase2) return;
    step.assembly.forEach((a, j) => {
      if ("build" in a) flag(`/steps/${i}/assembly/${j}`, "build");
      if ("unbuild" in a) flag(`/steps/${i}/assembly/${j}`, "unbuild");
    });
  });

  if (groups.phase2) {
    (spec.racks ?? []).forEach((rack, i) => {
      if (rack.programs !== undefined) flag(`/racks/${i}/programs`, "programs");
      (rack.slots ?? []).forEach((slot, j) => {
        if (slot.assembly !== undefined) flag(`/racks/${i}/slots/${j}/assembly`, "assembly");
        if (slot.closeup !== undefined) flag(`/racks/${i}/slots/${j}/closeup`, "closeup");
      });
    });
  }
  return out;
}
