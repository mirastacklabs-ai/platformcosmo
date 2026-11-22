/**
 * The one sequence that builds what the step plan runs over (W-2; design
 * docs/design/assemblies.md §8.1, §8.4, §8.5): ONE planner (`AssemblyPrograms`), then the racks a
 * step action targets (through that planner), then the spec assemblies (their row starts past the
 * racks' drawer travel), then the close-up instances (spec hosts and rack slot hosts). The scene,
 * `closeupDiagnostics`, `assemblyPlanDiagnostics` and the rack-selector check all build through
 * here, so they see the same assemblies, in the same order, with the same work budget.
 */
import type {
  Box3,
  DcPack,
  DcSceneFragment,
  Diagnostic,
  ImageAssetResolver,
  PartShapePack,
  PartShapeRegistry,
  SceneAssembly,
} from "../../contracts/index.js";
import { sortDiagnostics } from "../../schema/diagnose.js";
import type { PlatformCosmoSpec } from "../../schema/types.gen.js";
import { resolveFigure, stepViews, type PlanOptions, type ResolvedFigure } from "../boards.js";
import { buildCloseups, type CloseupBuild } from "./closeup.js";
import { AssemblyPrograms } from "./plan.js";
import { buildRackAssemblies, hasSlotCloseups, targetedRacks, type RackBuild } from "./racks.js";
import { assemblyNodes, buildAssemblies, type AssemblyBuild } from "./tree.js";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface PlanSceneOptions {
  readonly parts?: PartShapeRegistry;
  readonly dcShapes?: PartShapePack;
  readonly images?: ImageAssetResolver;
  readonly color?: (c: string) => string | undefined;
  /** DC pack: the targeted racks and the slot close-up hosts come from it. */
  readonly dc?: DcPack;
  /** The DC fragment the scene laid out; absent: `dc.buildScene(spec)` when racks are needed. */
  readonly frag?: DcSceneFragment;
  /** Where the spec assemblies' row starts, given the racks' reach bounds (default 0, 0). */
  readonly origin?: (rackReach: readonly Box3[]) => { readonly x: number; readonly y: number };
  /** Build the spec assemblies (default true; the rack-selector check needs the racks only). */
  readonly assemblies?: boolean;
  /** Build the close-up instances (default true). */
  readonly closeups?: boolean;
  /**
   * Validation callers: a section that throws (the DC pack, the close-ups) becomes one
   * `render/internal-error` and the other sections are kept. The scene lets errors propagate.
   */
  readonly guard?: boolean;
}

export interface PlannedScene {
  readonly programs: AssemblyPrograms;
  /** Racks in assembly mode and slot hosts; absent without DC racks to build. */
  readonly racks?: RackBuild;
  /** The spec assemblies as built (with their diagnostics); absent when not built. */
  readonly built?: AssemblyBuild;
  /** Spec assemblies and racks, sorted by id, programs attached. */
  readonly assemblies: readonly SceneAssembly[];
  /** Close-up levels; absent when the scene has none. */
  readonly closeups?: CloseupBuild;
  /** `render/internal-error` of guarded sections. */
  readonly errors: readonly Diagnostic[];
}

const internalError = (what: string, e: unknown): Diagnostic => ({
  severity: "error",
  code: "render/internal-error",
  path: "",
  message: `Unexpected error while checking ${what}: ${e instanceof Error ? e.message : String(e)}`,
});

/** Does the spec need DC racks or slot hosts built (and can the pack build them)? */
export function needsRacks(spec: PlatformCosmoSpec, dc: DcPack | undefined): boolean {
  return (
    dc !== undefined &&
    ((dc.buildAssembly !== undefined && targetedRacks(spec).length > 0) ||
      (dc.slotHosts !== undefined && hasSlotCloseups(spec)))
  );
}

export function planScene(spec: PlatformCosmoSpec, opts: PlanSceneOptions = {}): PlannedScene {
  const errors: Diagnostic[] = [];
  const section = <T>(what: string, run: () => T): T | undefined => {
    if (opts.guard !== true) return run();
    try {
      return run();
    } catch (e) {
      errors.push(internalError(what, e));
      return undefined;
    }
  };
  const programs = new AssemblyPrograms(spec);
  const dcShapes = opts.dcShapes ?? opts.dc?.shapes;
  const shared = {
    ...(opts.parts === undefined ? {} : { parts: opts.parts }),
    ...(dcShapes === undefined ? {} : { dcShapes }),
  };
  const dc = opts.dc;
  const racks =
    dc !== undefined && needsRacks(spec, dc)
      ? section("slot internals", () =>
          buildRackAssemblies(spec, dc, opts.frag ?? dc.buildScene(spec), {
            planner: programs,
            ...shared,
          }),
        )
      : undefined;
  const rackAssemblies = racks?.assemblies ?? [];
  const built =
    opts.assemblies === false
      ? undefined
      : section("close-ups", () =>
          programs.attach(
            buildAssemblies(spec, {
              reach: programs.reach,
              ...(opts.origin === undefined
                ? {}
                : { origin: opts.origin(rackAssemblies.map((a) => a.reachBounds)) }),
              ...(opts.color === undefined ? {} : { color: opts.color }),
              ...(opts.images === undefined ? {} : { images: opts.images }),
              ...shared,
            }),
          ),
        );
  const assemblies = [...(built?.assemblies ?? []), ...rackAssemblies].sort((p, q) =>
    cmp(p.id, q.id),
  );
  const hosts = racks?.hosts ?? [];
  const closeups =
    opts.closeups !== false &&
    built !== undefined &&
    (hosts.length > 0 ||
      assemblies.some((a) => assemblyNodes(a).some((n) => n.closeup !== undefined)))
      ? section("close-ups", () =>
          buildCloseups(spec, assemblies, {
            programs,
            hosts,
            ...(opts.color === undefined ? {} : { color: opts.color }),
            ...shared,
          }),
        )
      : undefined;
  return {
    programs,
    ...(racks === undefined ? {} : { racks }),
    ...(built === undefined ? {} : { built }),
    assemblies,
    ...(closeups === undefined ? {} : { closeups }),
    errors,
  };
}

// ---------------------------------------------------------------------------------------------
// Validation entry points (the scene's sequence, for a spec without a scene)
// ---------------------------------------------------------------------------------------------

export interface AssemblyPlanContext {
  readonly parts?: PartShapeRegistry;
  readonly dcShapes?: PartShapePack;
  /** DC pack: racks a step action targets and slot close-ups plan as in the scene. */
  readonly dc?: DcPack;
  /** Which `steps[].focus` ids zoom the camera (the scene's rule). */
  readonly isFocusTarget: (id: string) => boolean;
  readonly gated?: PlanOptions["gated"];
}

/**
 * `assembly/compressed` of the whole step plan (assemblies, racks, close-up instances and figures
 * through one step loop), for `validate`: the scene computes the same plan through `planScene`
 * but does not report it, so a diagnostic never appears twice. Empty without assemblies, DC racks
 * or slot close-ups, or without steps.
 */
export function assemblyPlanDiagnostics(
  spec: PlatformCosmoSpec,
  ctx: AssemblyPlanContext,
): Diagnostic[] {
  if ((spec.steps?.length ?? 0) === 0) return [];
  if ((spec.assemblies?.length ?? 0) === 0 && !needsRacks(spec, ctx.dc)) return [];
  const p = planScene(spec, {
    ...(ctx.parts === undefined ? {} : { parts: ctx.parts }),
    ...(ctx.dcShapes === undefined ? {} : { dcShapes: ctx.dcShapes }),
    ...(ctx.dc === undefined ? {} : { dc: ctx.dc }),
    guard: true,
  });
  const figures = new Map<string, ResolvedFigure>();
  (spec.figures ?? []).forEach((f, i) => {
    const { figure } = resolveFigure(f, i);
    if (!figures.has(figure.id)) figures.set(figure.id, figure);
  });
  const all = [
    ...p.assemblies,
    ...(p.closeups?.levels.flatMap((l) => (l.assembly === undefined ? [] : [l.assembly])) ?? []),
  ];
  const views = stepViews(spec, ctx.isFocusTarget);
  const { compression } = p.programs.plan(
    all,
    figures,
    views,
    ctx.gated ? { gated: ctx.gated } : {},
  );
  // a section that threw is reported here too (`validate` drops the copy `closeupDiagnostics` adds)
  return [...p.errors, ...compression];
}

/** The codes `closeupDiagnostics` reports (the size and depth checks of §8.5). */
const CHECK_CODES: ReadonlySet<string> = new Set([
  "assembly/size-mismatch",
  "assembly/closeup-turned",
  "assembly/too-deep",
  "budget/levels",
]);

/** Codes of a rack in assembly mode that only building it finds (§8.1, §8.2, §13), plus the above. */
const RACK_CODES: ReadonlySet<string> = new Set([
  ...CHECK_CODES,
  "assembly/below-ground",
  "budget/assembly-parts",
]);

/** @internal Used by the CLI's `validate`; not public API. */
export interface CloseupCheckContext {
  readonly parts?: PartShapeRegistry;
  /**
   * DC pack: builds the racks a step action targets, so `assembly/size-mismatch` of
   * `racks[].slots[].assembly` (§8.2) and the close-ups of rack slots (`slots[].closeup`, §8.5)
   * are checked as the scene checks them.
   */
  readonly dc?: DcPack;
}

/** Does any assembly or part of the raw spec name a `closeup`? (cheap pre-check, iterative.) */
function hasCloseup(spec: PlatformCosmoSpec): boolean {
  const todo: (readonly { closeup?: string; parts?: readonly unknown[] }[])[] = [
    (spec.assemblies ?? []) as never,
  ];
  let seen = 0;
  while (todo.length > 0 && seen < 100_000) {
    for (const x of todo.pop()!) {
      seen++;
      if (x.closeup !== undefined) return true;
      if (Array.isArray(x.parts)) todo.push(x.parts as never);
    }
  }
  return false;
}

/**
 * The size and depth diagnostics of close-ups (`assembly/size-mismatch`, `assembly/closeup-turned`,
 * `assembly/too-deep`, `budget/levels`) and of the racks in assembly mode (slot internals'
 * `assembly/size-mismatch`, `assembly/below-ground`, the rack's `budget/assembly-parts`), for
 * `pcosmo validate`: the scene computes them through the same `planScene`, but validation of the
 * spec alone does not build it. Call it only for a spec without errors; it never throws (an
 * internal failure is one `render/internal-error` per section, the other sections' results are
 * kept). Sorted by (path, code); empty, and no work, when the spec has no `closeup` and no rack
 * a step action targets.
 * @internal
 */
export function closeupDiagnostics(
  spec: PlatformCosmoSpec,
  ctx: CloseupCheckContext = {},
): Diagnostic[] {
  const dc = ctx.dc;
  const racks = needsRacks(spec, dc);
  const closeups = hasCloseup(spec) || (dc?.slotHosts !== undefined && hasSlotCloseups(spec));
  if (!racks && !closeups) return [];
  const p = planScene(spec, {
    ...(ctx.parts === undefined ? {} : { parts: ctx.parts }),
    ...(dc === undefined ? {} : { dc }),
    assemblies: closeups,
    closeups,
    guard: true,
  });
  return sortDiagnostics([
    ...p.errors,
    ...(p.racks?.diagnostics.filter((d) => RACK_CODES.has(d.code)) ?? []),
    ...(p.closeups?.diagnostics.filter((d) => CHECK_CODES.has(d.code)) ?? []),
  ]);
}
