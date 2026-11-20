/**
 * Semantic checks for schema revision 1.2.0, figure part (Track A2, A2-F; design
 * docs/design/assemblies.md §7, §15, §18). Assembly parts and programs are A2-1's.
 *
 * Covered: image ids and references (`image/unknown`), figure parts and stages (selectors,
 * duplicate and twice-moved parts), and explode/implode actions on figures with their timing.
 * Every diagnostic has a path, and a did-you-mean where an id or selector is involved.
 *
 * The merge guard (`unsupported.ts`) keeps rejecting `images`/`figures` until R-1 lifts
 * `phase1a`; these checks run alongside it. Once `phase1a` is lifted they also report
 * `assembly/unknown-target` for actions whose target is not a figure while the guard still
 * gates that target's phase (tracks §0), so a Phase 1a build never resolves such a target.
 */
import type { Diagnostic } from "../contracts/index.js";
import { planFigureSteps, resolveFigure, type ResolvedFigure } from "../scene/boards.js";
import { UNRENDERED, type GuardGroup } from "./unsupported.js";
import { didYouMean, q } from "./suggest.js";
import type { PlatformCosmoSpec } from "./types.gen.js";

export function figureDiagnostics(
  spec: PlatformCosmoSpec,
  groups: Readonly<Record<GuardGroup, boolean>> = UNRENDERED,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const hasActions = (spec.steps ?? []).some((s) => s.assembly !== undefined);
  if (spec.images === undefined && spec.figures === undefined && !hasActions) return out;

  // ---- image ids ----------------------------------------------------------------------
  const imageIds = new Map<string, number>();
  (spec.images ?? []).forEach((img, i) => {
    const first = imageIds.get(img.id);
    if (first !== undefined) {
      out.push({
        severity: "error",
        code: "semantic/duplicate-id",
        path: `/images/${i}/id`,
        message: `Duplicate image id ${q(img.id)} (first at /images/${first}/id)`,
        suggestion: "Rename one image",
        params: { id: img.id, first: `/images/${first}/id` },
      });
    } else imageIds.set(img.id, i);
  });
  const unknownImage = (path: string, id: string): void => {
    out.push({
      severity: "error",
      code: "image/unknown",
      path,
      message: `Unknown image ${q(id)}`,
      suggestion:
        didYouMean(id, imageIds.keys()) ??
        (imageIds.size > 0
          ? `Images: ${[...imageIds.keys()].slice(0, 8).join(", ")}`
          : `Declare it in "images" first`),
      params: { id },
    });
  };

  // ---- figures ------------------------------------------------------------------------
  const figures = new Map<string, ResolvedFigure>();
  (spec.figures ?? []).forEach((f, i) => {
    const at = `/figures/${i}`;
    if (!imageIds.has(f.base)) unknownImage(`${at}/base`, f.base);
    f.parts.forEach((p, j) => {
      if (!imageIds.has(p.image)) unknownImage(`${at}/parts/${j}/image`, p.image);
    });
    const { figure, diagnostics } = resolveFigure(f, i);
    out.push(...diagnostics);
    // Duplicate figure ids are reported by the shared id namespace (semantic.ts).
    if (!figures.has(figure.id)) figures.set(figure.id, figure);
  });

  // ---- actions ------------------------------------------------------------------------
  const views = (spec.steps ?? []).map((s) => s.focus);
  out.push(...planFigureSteps(spec, figures, views, { gated: groups }).diagnostics);
  return out;
}
