/**
 * DC racks in assembly mode, wired into the scene (W-1; design docs/design/assemblies.md §8.1,
 * §8.2, §8.4, §8.5).
 *
 * A rack is an assembly only when a step action targets it or a path below it (`rackTargeted`;
 * a path through a close-up, `r2/srv/closeup/…`, targets the close-up instance, not the rack).
 * `buildRackAssemblies` asks the DC pack for every targeted rack, with the slot templates
 * expanded once at true scale and ONE shared planner (the caller's `AssemblyPrograms`, which also
 * plans the spec assemblies and the close-up instances), and collects the slot close-up hosts of
 * every rack. The scene, `validate` (`closeupDiagnostics`, `assemblyPlanDiagnostics`, the
 * rack-program selector checks) and the DC pack all use this module's targeting rule, so they
 * agree on which racks are assemblies. Nothing here throws on a valid spec; bad entries are
 * skipped (validation reports them).
 */
import type {
  CloseupHost,
  DcAssemblyPlanner,
  DcPack,
  DcSceneFragment,
  Diagnostic,
  PartShapePack,
  PartShapeRegistry,
  SceneAssembly,
  SceneAssemblyNode,
} from "../../contracts/index.js";
import { AssemblyModel, LEAF_ERROR } from "../../schema/assembly-tree.js";
import type { PlatformCosmoSpec } from "../../schema/types.gen.js";
import { assemblyNodes, buildTemplateInstance } from "./tree.js";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ACTION_KEYS = ["explode", "implode", "build", "unbuild"] as const;

/**
 * Does a step action target the rack `rackId` or a path below it (§8.1)? A path through the
 * reserved `closeup` segment names a close-up instance, so it does not make the rack an assembly.
 * Total on any input (the DC pack calls it on raw specs).
 * @internal
 */
export function rackTargeted(spec: PlatformCosmoSpec, rackId: string): boolean {
  const steps: unknown = (spec as { steps?: unknown }).steps;
  for (const step of Array.isArray(steps) ? steps : []) {
    const list: unknown = isObj(step) ? step["assembly"] : undefined;
    for (const a of Array.isArray(list) ? list : []) {
      if (!isObj(a)) continue;
      const key = ACTION_KEYS.find((k) => k in a);
      const t = key === undefined ? undefined : a[key];
      if (typeof t !== "string") continue;
      if (t === rackId) return true;
      if (t.startsWith(`${rackId}/`) && !t.split("/").includes("closeup", 1)) return true;
    }
  }
  return false;
}

/** Ids of the racks in assembly mode, spec order, each once. */
export function targetedRacks(spec: PlatformCosmoSpec): string[] {
  const out: string[] = [];
  if (!(spec.steps ?? []).some((s) => s.assembly !== undefined)) return out;
  for (const r of spec.racks ?? []) {
    if (typeof r.id === "string" && !out.includes(r.id) && rackTargeted(spec, r.id)) out.push(r.id);
  }
  return out;
}

/** Does any rack slot name a close-up? */
export const hasSlotCloseups = (spec: PlatformCosmoSpec): boolean =>
  (spec.racks ?? []).some((r) => (r.slots ?? []).some((s) => s.closeup !== undefined));

export interface RackBuildOptions {
  readonly parts?: PartShapeRegistry;
  readonly dcShapes?: PartShapePack;
  /** The scene's planner, shared with the spec assemblies; absent: the pack plans alone. */
  readonly planner?: DcAssemblyPlanner;
}

export interface RackBuild {
  /** The racks in assembly mode, sorted by id, programs attached. */
  readonly assemblies: readonly SceneAssembly[];
  /**
   * Slot close-up hosts of every rack, sorted by path; a rack in assembly mode gives its slot
   * node's rest box (the drawn device), any other rack the 1.1 slot object's box.
   */
  readonly hosts: readonly CloseupHost[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The racks a step action targets, as the DC pack builds them (`DcPack.buildAssembly`), and the
 * slot close-up hosts (`DcPack.slotHosts`). Slot templates (`slots[].assembly`) are expanded once
 * at true scale, unlifted, for every rack that uses them; an unknown, over-budget or cyclic
 * template gets no instance (the pack reports `assembly/unknown-target`, validation the cause).
 */
export function buildRackAssemblies(
  spec: PlatformCosmoSpec,
  dc: DcPack,
  frag: DcSceneFragment,
  opts: RackBuildOptions = {},
): RackBuild {
  const diagnostics: Diagnostic[] = [];
  const assemblies: SceneAssembly[] = [];
  const racks = dc.buildAssembly === undefined ? [] : targetedRacks(spec);
  if (racks.length > 0) {
    const model = new AssemblyModel(spec);
    const tids = new Set<string>();
    for (const r of spec.racks ?? []) {
      if (!racks.includes(r.id)) continue;
      for (const s of r.slots ?? []) if (s.assembly !== undefined) tids.add(s.assembly);
    }
    const templates: Record<string, SceneAssemblyNode> = {};
    for (const id of [...tids].sort(cmp)) {
      const t = buildTemplateInstance(spec, model, id, id, {
        lift: false,
        ...(opts.parts === undefined ? {} : { parts: opts.parts }),
        ...(opts.dcShapes === undefined ? {} : { dcShapes: opts.dcShapes }),
        leafBudget: LEAF_ERROR,
      });
      if (t !== undefined) templates[id] = t.assembly.root;
    }
    for (const id of racks) {
      const r = (dc.buildAssembly as NonNullable<DcPack["buildAssembly"]>)(
        spec,
        id,
        frag,
        templates,
        opts.planner,
      );
      diagnostics.push(...r.diagnostics);
      if (r.assembly !== undefined) assemblies.push(r.assembly);
    }
    assemblies.sort((p, q) => cmp(p.id, q.id));
  }
  let hosts: CloseupHost[] = [];
  if (dc.slotHosts !== undefined && hasSlotCloseups(spec)) {
    const built = new Map<string, SceneAssemblyNode>();
    for (const a of assemblies) for (const n of assemblyNodes(a)) built.set(n.path, n);
    hosts = dc
      .slotHosts(spec, frag)
      .map((h) => {
        const n = built.get(h.path);
        return n === undefined ? h : { ...h, box: n.world };
      })
      .sort((p, q) => cmp(p.path, q.path));
  }
  return { assemblies, hosts, diagnostics };
}
