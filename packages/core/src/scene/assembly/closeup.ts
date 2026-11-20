/**
 * Close-up instances and size reconciliation (Track A2, A2-5; design docs/design/assemblies.md
 * §8.4, §8.5, §13, §18).
 *
 * `buildCloseups` instances every close-up of the placed assemblies at the reserved path
 * `<host>/closeup` (a part, sub-assembly or `hosts` entry whose spec `closeup` names an
 * assembly, figure or storyboard), breadth first so nesting levels build in order:
 * `r2/srv` -> `r2/srv/closeup` -> `r2/srv/closeup/board/cpu-1/closeup`. An assembly instance is
 * the template expanded under that path (`buildTemplateInstance`), true scale for physical
 * units, standing at its own origin; its programs are the template's, resolved by the shared
 * `AssemblyPrograms` (so actions on `<host>/closeup/...` plan like any assembly's). Two hosts of
 * one template are two independent instances. A figure or storyboard instance is a level
 * without geometry (the render fits it to the host's zoomed screen rect).
 *
 * Size reconciliation (§8.5): a physical template against a physical host compares the
 * template's size in millimetres with the host's, per axis, in the better of two orientations
 * (x/y as authored or swapped by a quarter turn). Within 10% the instance keeps true scale; above,
 * `assembly/size-mismatch` (warning) and the instance is fitted uniformly (contain). Hosts that
 * are not physical (`tile`, `stud`) or have no size are not reconciled.
 *
 * Bounded: the depth (<= 4) and count (<= 8) caps are checked BEFORE an instance is expanded,
 * template leaves are charged to the spec's 2000-leaf budget, and a reference cycle stops the
 * chain, so nothing here is sized by input before a check. Nothing throws; an unusable close-up
 * is skipped (validation reports unknown references, cycles and too-deep paths).
 */
import type {
  AssemblyUnits,
  Box3,
  Diagnostic,
  QuarterTurn,
  SceneAssemblies,
  SceneAssembly,
  Vec3,
} from "../../contracts/index.js";
import { AssemblyModel, LEAF_ERROR, MAX_DEPTH } from "../../schema/assembly-tree.js";
import type { PlatformCosmoSpec } from "../../schema/types.gen.js";
import { unitMm } from "./frame.js";
import { levelLimit, levelOverflow, type Level, type LevelKind } from "./levels.js";
import type { AssemblyPrograms } from "./plan.js";
import { assemblyNodes, buildTemplateInstance, type AssemblyBuildOptions } from "./tree.js";

/** Relative size difference above which a close-up is fitted and reported (§8.5). */
export const SIZE_TOLERANCE = 0.1;
const EPS = 1e-9;

/** A coarse node outside the spec assemblies that carries a close-up (a DC rack slot, E-1). */
export interface CloseupHost {
  /** Scene path, e.g. `r2/srv`. */
  readonly path: string;
  /** Spec `closeup`: assembly, figure or storyboard id. */
  readonly closeup: string;
  /** World box of the host in the main scene. */
  readonly box: Box3;
  /** Physical size in millimetres (DC device boxes), for size reconciliation. */
  readonly sizeMm?: Vec3;
  /** JSON pointer of the spec field, for diagnostics. */
  readonly pointer?: string;
}

export interface CloseupOptions extends Pick<
  AssemblyBuildOptions,
  "parts" | "dcShapes" | "images" | "color"
> {
  /** Close-up hosts that are not spec assembly nodes (rack slots). */
  readonly hosts?: readonly CloseupHost[];
  /**
   * The programs of the main assemblies. Every assembly instance is registered with it, built
   * with its `reach` and given its programs, so actions on instance paths plan (§8.3).
   */
  readonly programs?: AssemblyPrograms;
}

export interface CloseupBuild {
  /** Sorted by path. */
  readonly levels: readonly Level[];
  readonly diagnostics: readonly Diagnostic[];
}

interface Pending {
  readonly host: string;
  readonly ref: string;
  readonly box: Box3;
  readonly sizeMm?: Vec3;
  readonly ptr: string;
  readonly parent?: string;
  /** Template ids from the main assembly down to the host's level (cycle guard). */
  readonly chain: readonly string[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isPhysical = (u: AssemblyUnits): boolean => u === "mm" || u === "cm" || u === "in";
const r1 = (v: number): number => Math.round(v * 10) / 10;

function hostsOf(
  a: SceneAssembly,
  templateId: string,
  parent: string | undefined,
  chain: readonly string[],
  ptr: string,
): Pending[] {
  const mm = unitMm(a.frame.units);
  const physical = isPhysical(a.frame.units);
  const out: Pending[] = [];
  for (const n of assemblyNodes(a)) {
    if (n.closeup === undefined) continue;
    out.push({
      host: n.path,
      ref: n.closeup,
      box: n.world,
      ...(physical
        ? {
            sizeMm: {
              x: n.local.size.x * mm.x,
              y: n.local.size.y * mm.y,
              z: n.local.size.z * mm.z,
            },
          }
        : {}),
      ptr,
      ...(parent === undefined ? {} : { parent }),
      chain: [...chain, templateId],
    });
  }
  return out;
}

/** Relative difference of `t` to the reference `h` (> 0). */
const rel = (t: number, h: number): number => Math.abs(t - h) / h;

interface Fit {
  readonly turn: QuarterTurn;
  readonly fit: number;
  readonly dev: Vec3;
  readonly worst: number;
  readonly axis: "x" | "y" | "z";
}

/** The better orientation of a template of size `t` against the host size `h` (§8.5). */
function reconcile(t: Vec3, h: Vec3): Fit | undefined {
  if (!(h.x > 0 && h.y > 0 && h.z > 0) || !(t.x > 0 && t.y > 0 && t.z > 0)) return undefined;
  const dev = (s: Vec3): Vec3 => ({ x: rel(s.x, h.x), y: rel(s.y, h.y), z: rel(s.z, h.z) });
  const worstOf = (d: Vec3): { v: number; axis: "x" | "y" | "z" } =>
    d.x >= d.y && d.x >= d.z
      ? { v: d.x, axis: "x" }
      : d.y >= d.z
        ? { v: d.y, axis: "y" }
        : { v: d.z, axis: "z" };
  const a = dev(t);
  const swapped = { x: t.y, y: t.x, z: t.z };
  const b = dev(swapped);
  const turned = worstOf(b).v < worstOf(a).v - EPS;
  const d = turned ? b : a;
  const s = turned ? swapped : t;
  const w = worstOf(d);
  const fit = w.v > SIZE_TOLERANCE + EPS ? Math.min(h.x / s.x, h.y / s.y, h.z / s.z) : 1;
  return { turn: turned ? 90 : 0, fit, dev: d, worst: w.v, axis: w.axis };
}

/**
 * Builds every close-up level of `base` (placed, programs attached) and `opts.hosts`. The levels
 * come back sorted by path; an assembly level carries the instance with `programs` attached.
 */
export function buildCloseups(
  spec: PlatformCosmoSpec,
  base: readonly SceneAssembly[],
  opts: CloseupOptions = {},
): CloseupBuild {
  const diagnostics: Diagnostic[] = [];
  const levels: Level[] = [];
  const model = new AssemblyModel(spec);
  const figures = new Set((spec.figures ?? []).map((f) => f.id));
  const boards = new Set((spec.storyboards ?? []).map((b) => b.id));
  const kindOf = (ref: string): LevelKind | undefined =>
    model.byId.has(ref)
      ? "assembly"
      : figures.has(ref)
        ? "figure"
        : boards.has(ref)
          ? "storyboard"
          : undefined;

  let leafBudget = LEAF_ERROR - base.reduce((n, a) => n + a.leaves.length, 0);
  const seen = new Set<string>();
  let frontier: Pending[] = [];
  for (const a of base) {
    const i = model.byId.get(a.id);
    frontier.push(...hostsOf(a, a.id, undefined, [], i === undefined ? "" : `/assemblies/${i}`));
  }
  for (const h of opts.hosts ?? []) {
    frontier.push({
      host: h.path,
      ref: h.closeup,
      box: h.box,
      ...(h.sizeMm === undefined ? {} : { sizeMm: h.sizeMm }),
      ptr: h.pointer ?? "",
      chain: [],
    });
  }
  frontier.sort((p, q) => cmp(p.host, q.host));

  let overflow = false;
  for (let depth = 1; frontier.length > 0 && !overflow; depth++) {
    const next: Pending[] = [];
    for (const h of frontier) {
      const path = `${h.host}/closeup`;
      if (seen.has(path)) continue; // a host listed twice
      const kind = kindOf(h.ref);
      if (kind === undefined) continue; // unknown reference: `assembly/unknown-target`
      if (h.chain.includes(h.ref)) continue; // cycle: `assembly/template-cycle` (validation)
      if (path.split("/").length > MAX_DEPTH) continue; // `assembly/too-deep` (validation)
      const why = levelLimit(depth, levels.length);
      if (why !== undefined) {
        diagnostics.push(levelOverflow(why, h.host, depth, levels.length));
        overflow = true; // the rest is not looked at: nothing past the cap is built or counted
        break;
      }
      seen.add(path);
      const common = {
        path,
        host: h.host,
        ref: h.ref,
        kind,
        ...(h.parent === undefined ? {} : { parent: h.parent }),
        depth,
        hostBox: h.box,
      };
      if (kind !== "assembly") {
        levels.push({ ...common, turn: 0, fit: 1 });
        continue;
      }
      opts.programs?.registerInstance(path, h.ref);
      let fitted: Fit | undefined;
      const built = buildTemplateInstance(spec, model, h.ref, path, {
        ...(opts.parts === undefined ? {} : { parts: opts.parts }),
        ...(opts.dcShapes === undefined ? {} : { dcShapes: opts.dcShapes }),
        ...(opts.images === undefined ? {} : { images: opts.images }),
        ...(opts.color === undefined ? {} : { color: opts.color }),
        ...(opts.programs === undefined ? {} : { reach: opts.programs.reach }),
        leafBudget,
        adapt: (size, units) => {
          if (h.sizeMm === undefined || !isPhysical(units)) return {};
          fitted = reconcile(size, h.sizeMm);
          return fitted === undefined ? {} : { turn: fitted.turn, fit: fitted.fit };
        },
      });
      if (built === undefined) {
        const i = model.byId.get(h.ref);
        if (i !== undefined && (!model.fits(i) || model.metrics(i).leaves > leafBudget)) {
          diagnostics.push({
            severity: "error",
            code: "budget/assembly-parts",
            path: h.ptr,
            message: `Close-up ${JSON.stringify(h.ref)} of ${JSON.stringify(h.host)} would exceed the ${LEAF_ERROR}-part budget of the spec`,
            suggestion: "Use a smaller close-up template or fewer close-ups",
            params: { host: h.host, closeup: h.ref, limit: LEAF_ERROR },
          });
        }
        seen.delete(path);
        continue;
      }
      leafBudget -= built.leafCount;
      diagnostics.push(...built.diagnostics);
      let assembly: SceneAssembly = built.assembly;
      if (opts.programs !== undefined) {
        const att = opts.programs.attach<SceneAssemblies>({
          assemblies: [assembly],
          boards: [],
          plan: [],
          images: [],
          credits: [],
        });
        assembly = att.assemblies[0] as SceneAssembly;
      }
      const f = fitted as Fit | undefined;
      if (f !== undefined && f.worst > SIZE_TOLERANCE + EPS) {
        diagnostics.push({
          severity: "warning",
          code: "assembly/size-mismatch",
          path: h.ptr,
          message: `Close-up ${JSON.stringify(h.ref)} differs from ${JSON.stringify(h.host)} by ${r1(f.worst * 100)}% on ${f.axis} (limit ${SIZE_TOLERANCE * 100}%); fitted uniformly at ${r1(f.fit * 100) / 100}x`,
          suggestion: "Correct the template's size or the part's size so they agree",
          params: {
            host: h.host,
            closeup: h.ref,
            axis: f.axis,
            mismatch: f.worst,
            limit: SIZE_TOLERANCE,
            fit: f.fit,
          },
        });
      }
      levels.push({
        ...common,
        assembly,
        turn: f?.turn ?? 0,
        fit: f?.fit ?? 1,
        ...(f === undefined ? {} : { mismatch: f.dev }),
      });
      next.push(...hostsOf(assembly, h.ref, path, h.chain, `/assemblies/${built.index}`));
    }
    frontier = next.sort((p, q) => cmp(p.host, q.host));
  }
  levels.sort((p, q) => cmp(p.path, q.path));
  return { levels, diagnostics };
}
