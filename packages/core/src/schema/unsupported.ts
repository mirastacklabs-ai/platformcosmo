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
  /** Phase 1a, figure mode: `images`, `figures`, explode/implode actions on figures. Lifted by R-1. */
  phase1a: false,
  /** Phase 1b, plans and basic explode: `assemblies`, actions on assemblies, part paths. */
  phase1b: true,
  /**
   * Phase 2, server → rack → hall: rack `programs`, slot `assembly`, `closeup` (fields and
   * `…/closeup` paths), actions on racks and slots, build programs and build/unbuild actions.
   */
  phase2: true,
  /** Phase 3: `storyboards` (and actions on them), build steps `from: "callout"` and `subBuild`. */
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

  // Step actions are gated by their TARGET's kind, so each phase lifts only its own actions.
  const roots = new Map<string, GuardGroup>();
  for (const r of spec.racks ?? []) roots.set(r.id, "phase2");
  for (const a of spec.assemblies ?? []) roots.set(a.id, "phase1b");
  for (const f of spec.figures ?? []) roots.set(f.id, "phase1a");
  for (const b of spec.storyboards ?? []) roots.set(b.id, "phase3");
  // `closeup` is a reserved path segment only after the first segment and only in specs with
  // 1.2.0 content; in a plain 1.1 spec it is an ordinary id (`r1/closeup` is a slot).
  const has12 =
    spec.assemblies !== undefined ||
    spec.images !== undefined ||
    spec.figures !== undefined ||
    spec.storyboards !== undefined ||
    (spec.steps ?? []).some((st) => st.assembly !== undefined) ||
    (spec.racks ?? []).some(
      (r) =>
        r.programs !== undefined ||
        (r.slots ?? []).some((sl) => sl.assembly !== undefined || sl.closeup !== undefined),
    );
  const closeupPath = (segs: readonly string[]): boolean =>
    has12 && segs.indexOf("closeup", 1) >= 1;
  const pathGate = (path: string): boolean => {
    const segs = path.split("/");
    if (groups.phase2 && closeupPath(segs)) return true; // close-up levels (phase 2)
    const kind = roots.get(segs[0] as string);
    // Unknown roots are left to semantic validation once phase 1a is lifted.
    return kind === undefined ? groups.phase1a : groups[kind];
  };
  const ptr = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

  (spec.steps ?? []).forEach((step, i) => {
    (step.assembly ?? []).forEach((a, j) => {
      const at = `/steps/${i}/assembly/${j}`;
      if ("build" in a || "unbuild" in a) {
        const target = "build" in a ? a.build : a.unbuild;
        const storyboard = roots.get(target.split("/")[0] as string) === "phase3";
        if (storyboard ? groups.phase3 : groups.phase2 || pathGate(target)) {
          flag(at, "build" in a ? "build" : "unbuild");
        }
        return;
      }
      const target = "explode" in a ? a.explode : a.implode;
      if (pathGate(target)) flag(at, "explode" in a ? "explode" : "implode");
    });
    // Part paths (two or more `/`) and close-up paths only exist with 1.2.0 content.
    const deep = (path: string, at: string): void => {
      const segs = path.split("/");
      if (groups.phase2 && closeupPath(segs)) flag(at, path);
      else if (segs.length > 2 && pathGate(path)) flag(at, path);
    };
    if (step.focus !== undefined) deep(step.focus, `/steps/${i}/focus`);
    for (const key of Object.keys(step.set ?? {})) deep(key, `/steps/${i}/set/${ptr(key)}`);
  });

  // A plain 1.1 id `closeup` stays valid, with a warning: it would shadow the reserved close-up
  // segment once the node (or its parent) gets a close-up.
  const reserved = (id: string | undefined, at: string): void => {
    if (id !== "closeup") return;
    out.push({
      severity: "warning",
      code: "semantic/reserved-id",
      path: at,
      message:
        'The id "closeup" is reserved as a close-up path segment from schema revision 1.2.0.',
      suggestion: "Rename it (for example close-up-1) before adding close-ups to this spec",
    });
  };
  const lists = ["nodes", "groups", "racks", "equipment", "rows", "aisles", "cables"] as const;
  for (const list of lists) {
    (spec[list] ?? []).forEach((it: { readonly id?: string }, i: number) =>
      reserved(it.id, `/${list}/${i}/id`),
    );
  }
  (spec.racks ?? []).forEach((r, i) =>
    (r.slots ?? []).forEach((sl, j) => reserved(sl.id, `/racks/${i}/slots/${j}/id`)),
  );

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
