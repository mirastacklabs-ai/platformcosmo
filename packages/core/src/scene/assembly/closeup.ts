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
 * without geometry (the render fits it to the host's zoomed screen rect). Instances stay out of
 * `SceneAssemblies.assemblies`; the images and credits they use are returned for merging.
 *
 * Size reconciliation (§8.5) is containment in the host's INTERIOR (`interiorMm`, world axes:
 * a DC slot passes its 450 mm interior, any other host its box). The template front is turned
 * onto the host front in world axes (the host assembly's `frame.rotate` included), never by a
 * footprint guess. Only a template LARGER than the interior by more than 10% on an axis warns
 * (`assembly/size-mismatch`) and is shrunk uniformly to fit; a short z never warns; a template
 * much smaller in x/y (< 50%) gets an info and is never scaled up. When the footprint would
 * match better turned a quarter, `assembly/closeup-turned` (info) says so and nothing turns.
 * Hosts that are not physical (`tile`, `stud`) or have no size are not reconciled.
 *
 * Bounded: the depth (<= 4), count (<= 8) and path-length (<= 8 segments, template height
 * included) caps are checked BEFORE an instance is expanded and each skip is reported;
 * template leaves are charged to the spec's 2000-leaf budget, and a reference cycle stops the
 * chain (validation reports cycles), so nothing here is sized by input before a check. Nothing
 * throws.
 */
import type {
  AssemblyUnits,
  CloseupHost,
  AssetSource,
  Box3,
  Diagnostic,
  FrontSide,
  QuarterTurn,
  SceneAssemblies,
  SceneAssembly,
  Vec3,
} from "../../contracts/index.js";
import { AssemblyModel, LEAF_ERROR, MAX_DEPTH } from "../../schema/assembly-tree.js";
import type { PlatformCosmoSpec, SpecPart } from "../../schema/types.gen.js";
import { unitMm } from "./frame.js";
import { levelLimit, levelOverflow, type Level, type LevelKind } from "./levels.js";
import { AssemblyPrograms } from "./plan.js";
import { assemblyNodes, buildTemplateInstance, type AssemblyBuildOptions } from "./tree.js";

/** Oversize above which a close-up is shrunk and reported (§8.5). */
export const SIZE_TOLERANCE = 0.1;
/** A template under this fraction of the interior in x or y gets an info (§8.5). */
export const SMALL_RATIO = 0.5;
const EPS = 1e-9;

export type { CloseupHost } from "../../contracts/index.js";

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
  /** Image keys the instances use, sorted. */
  readonly images: readonly string[];
  /** Credits of the instances in first-use order (deduplicate against the main scene's). */
  readonly credits: readonly AssetSource[];
  readonly diagnostics: readonly Diagnostic[];
}

interface Pending {
  readonly host: string;
  readonly ref: string;
  readonly box: Box3;
  readonly interiorMm?: Vec3;
  readonly front: FrontSide;
  readonly ptr: string;
  readonly parent?: string;
  /** Template ids from the main assembly down to the host's level (cycle guard). */
  readonly chain: readonly string[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isPhysical = (u: AssemblyUnits): boolean => u === "mm" || u === "cm" || u === "in";
const r1 = (v: number): number => Math.round(v * 10) / 10;
const SIDES: readonly FrontSide[] = ["+x", "+y", "-x", "-y"];

/**
 * JSON pointer of the spec field `closeup` of the node at `rel` (path segments below the
 * assembly root; none: the assembly's own `closeup`). A segment is a part id, or `<id>-<n>` of a
 * counted part; a node that comes from a `use` template is not in this assembly's parts, so the
 * assembly pointer `base` itself is the fallback.
 */
function closeupPointer(spec: PlatformCosmoSpec, base: string, rel: readonly string[]): string {
  if (base === "") return "";
  const root = (spec.assemblies ?? [])[Number(base.slice("/assemblies/".length))];
  if (root === undefined) return base;
  if (rel.length === 0) return `${base}/closeup`;
  let list: readonly SpecPart[] | undefined = root.parts;
  let at = base;
  for (const seg of rel) {
    const k: number = (list ?? []).findIndex((p) => p.id === seg || counted(p, seg));
    if (k < 0) return base;
    at = `${at}/parts/${k}`;
    list = list?.[k]?.parts;
  }
  return `${at}/closeup`;
}

/**
 * JSON pointer of the `closeup` field of a node inside a rack slot's internals (`rel` below the
 * rack: the slot id, then the path below the slot): the part of the slot's template that defines it.
 */
function slotTemplatePointer(
  spec: PlatformCosmoSpec,
  model: AssemblyModel,
  rackId: string,
  rel: readonly string[],
): string {
  const rack = (spec.racks ?? []).find((r) => r.id === rackId);
  const slot = (rack?.slots ?? []).find((sl) => (sl.id ?? `u${sl.at}`) === rel[0]);
  const ti = slot?.assembly === undefined ? undefined : model.byId.get(slot.assembly);
  return ti === undefined ? "" : closeupPointer(spec, `/assemblies/${ti}`, rel.slice(1));
}

/** `seg` is an instance id (`<id>-<n>`, n in 1..count) of the counted part `p`. */
function counted(p: SpecPart, seg: string): boolean {
  const n = p.count ?? 1;
  if (n < 2 || !seg.startsWith(`${p.id}-`)) return false;
  const k = Number(seg.slice(p.id.length + 1));
  return Number.isInteger(k) && k >= 1 && k <= n && String(k) === seg.slice(p.id.length + 1);
}

function hostsOf(
  spec: PlatformCosmoSpec,
  a: SceneAssembly,
  templateId: string,
  parent: string | undefined,
  chain: readonly string[],
  ptr: string,
  pointerOf: (rel: readonly string[]) => string = (rel) => closeupPointer(spec, ptr, rel),
): Pending[] {
  const mm = unitMm(a.frame.units);
  const physical = isPhysical(a.frame.units);
  const odd = a.frame.rotate === 90 || a.frame.rotate === 270;
  const out: Pending[] = [];
  for (const n of assemblyNodes(a)) {
    if (n.closeup === undefined) continue;
    const rel = n.path === a.root.path ? [] : n.path.slice(a.root.path.length + 1).split("/");
    const s = n.local.size;
    // local axes turn with the host assembly's own rotate: the interior in WORLD axes
    const ix = (odd ? s.y * mm.y : s.x * mm.x) as number;
    const iy = (odd ? s.x * mm.x : s.y * mm.y) as number;
    out.push({
      host: n.path,
      ref: n.closeup,
      box: n.world,
      ...(physical ? { interiorMm: { x: ix, y: iy, z: s.z * mm.z } } : {}),
      front: a.frame.front,
      ptr: pointerOf(rel),
      ...(parent === undefined ? {} : { parent }),
      chain: [...chain, templateId],
    });
  }
  return out;
}

interface Fit {
  readonly turn: QuarterTurn;
  readonly fit: number;
  /** Template size over the interior, minus 1, per axis (world axes, after `turn`). */
  readonly dev: Vec3;
  readonly worst: number;
  readonly axis: "x" | "y" | "z";
  readonly small: boolean;
  /** The footprint would match better with x and y swapped (nothing is turned). */
  readonly swapBetter: boolean;
}

/** Template of world size `t` (front still to be turned by `turn`) in the interior `h` (§8.5). */
function reconcile(size: Vec3, turn: QuarterTurn, h: Vec3): Fit | undefined {
  const odd = turn === 90 || turn === 270;
  const t = odd ? { x: size.y, y: size.x, z: size.z } : size;
  if (!(h.x > 0 && h.y > 0 && h.z > 0) || !(t.x > 0 && t.y > 0 && t.z > 0)) return undefined;
  const dev: Vec3 = { x: t.x / h.x - 1, y: t.y / h.y - 1, z: t.z / h.z - 1 };
  const over = (d: Vec3): { v: number; axis: "x" | "y" | "z" } =>
    d.x >= d.y && d.x >= d.z
      ? { v: d.x, axis: "x" }
      : d.y >= d.z
        ? { v: d.y, axis: "y" }
        : { v: d.z, axis: "z" };
  const w = over(dev);
  const warn = w.v > SIZE_TOLERANCE + EPS;
  const fit = warn ? Math.min(1, h.x / t.x, h.y / t.y, h.z / t.z) : 1;
  const xy = (a: number, b: number): number =>
    Math.max(Math.abs(a / h.x - 1), Math.abs(b / h.y - 1));
  const aligned = xy(t.x, t.y);
  const swapped = xy(t.y, t.x);
  return {
    turn: 0,
    fit,
    dev,
    worst: w.v,
    axis: w.axis,
    small: t.x / h.x < SMALL_RATIO || t.y / h.y < SMALL_RATIO,
    swapBetter: aligned > SIZE_TOLERANCE + EPS && swapped < aligned - EPS,
  };
}

/** Quarter turns that bring the world side `from` onto `to`. */
const turnBetween = (from: FrontSide, to: FrontSide): QuarterTurn =>
  (((((SIDES.indexOf(to) - SIDES.indexOf(from)) % 4) + 4) % 4) * 90) as QuarterTurn;

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
  const images = new Set<string>();
  const credits: AssetSource[] = [];
  const creditKeys = new Set<string>();
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
    frontier.push(
      ...(a.source === "dc"
        ? hostsOf(spec, a, a.id, undefined, [], "", (rel) =>
            slotTemplatePointer(spec, model, a.id, rel),
          )
        : hostsOf(spec, a, a.id, undefined, [], i === undefined ? "" : `/assemblies/${i}`)),
    );
  }
  for (const h of opts.hosts ?? []) {
    frontier.push({
      host: h.path,
      ref: h.closeup,
      box: h.box,
      ...(h.interiorMm === undefined ? {} : { interiorMm: h.interiorMm }),
      front: h.front ?? "+y",
      ptr: h.pointer ?? "",
      chain: [],
    });
  }
  frontier.sort((p, q) => cmp(p.host, q.host));

  const tooDeep = (h: Pending, path: string, depth: number, limit: number): void => {
    diagnostics.push({
      severity: "error",
      code: "assembly/too-deep",
      path: h.ptr,
      message: `Close-up of ${JSON.stringify(h.host)} would reach ${depth} path segments (limit ${limit}); it is not built`,
      suggestion: "Use a shallower host or a flatter template",
      params: { host: h.host, closeup: h.ref, depth, limit },
    });
  };

  let overflow = false;
  for (let d = 1; frontier.length > 0 && !overflow; d++) {
    const next: Pending[] = [];
    for (const h of frontier) {
      const path = `${h.host}/closeup`;
      if (seen.has(path)) continue; // a host listed twice
      const kind = kindOf(h.ref);
      if (kind === undefined) continue; // unknown reference: `assembly/unknown-target`
      if (h.chain.includes(h.ref)) continue; // cycle: `assembly/template-cycle` (validation)
      const segs = path.split("/").length;
      const ai = kind === "assembly" ? model.byId.get(h.ref) : undefined;
      const height = ai === undefined ? 0 : model.metrics(ai).height;
      if (segs + height > MAX_DEPTH) {
        tooDeep(h, path, segs + height, MAX_DEPTH);
        continue;
      }
      const why = levelLimit(d, levels.length);
      if (why !== undefined) {
        diagnostics.push(levelOverflow(why, h.host, d, levels.length, h.ptr));
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
        depth: d,
        hostBox: h.box,
      };
      if (kind !== "assembly") {
        levels.push({ ...common, turn: 0, fit: 1 });
        continue;
      }
      opts.programs?.registerInstance(path, h.ref);
      let fitted: Fit | undefined;
      let turnUsed: QuarterTurn = 0;
      const built = buildTemplateInstance(spec, model, h.ref, path, {
        ...(opts.parts === undefined ? {} : { parts: opts.parts }),
        ...(opts.dcShapes === undefined ? {} : { dcShapes: opts.dcShapes }),
        ...(opts.images === undefined ? {} : { images: opts.images }),
        ...(opts.color === undefined ? {} : { color: opts.color }),
        ...(opts.programs === undefined ? {} : { reach: opts.programs.reach }),
        leafBudget,
        adapt: (size, units, front) => {
          // align the template front with the host front in world axes (never by footprint)
          const turn = turnBetween(front, h.front);
          turnUsed = turn;
          if (h.interiorMm === undefined || !isPhysical(units)) return turn === 0 ? {} : { turn };
          fitted = reconcile(size, turn, h.interiorMm);
          return { turn, ...(fitted === undefined ? {} : { fit: fitted.fit }) };
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
      for (const k of built.images) images.add(k);
      for (const c of built.credits) {
        const key = JSON.stringify(c);
        if (creditKeys.has(key)) continue;
        creditKeys.add(key);
        credits.push(c);
      }
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
          message: `Close-up ${JSON.stringify(h.ref)} is ${r1(f.worst * 100)}% larger than the interior of ${JSON.stringify(h.host)} on ${f.axis} (limit ${SIZE_TOLERANCE * 100}%); shrunk uniformly to ${r1(f.fit * 100) / 100}x`,
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
      } else if (f !== undefined && f.small) {
        diagnostics.push({
          severity: "info",
          code: "assembly/size-mismatch",
          path: h.ptr,
          message: `Close-up ${JSON.stringify(h.ref)} is less than ${SMALL_RATIO * 100}% of the interior of ${JSON.stringify(h.host)} in x or y; it is drawn at true scale, not enlarged`,
          suggestion: "Check the template's size against the part's",
          params: { host: h.host, closeup: h.ref, ratio: SMALL_RATIO },
        });
      }
      if (f?.swapBetter === true) {
        diagnostics.push({
          severity: "info",
          code: "assembly/closeup-turned",
          path: h.ptr,
          message: `The footprint of close-up ${JSON.stringify(h.ref)} would match ${JSON.stringify(h.host)} better turned a quarter; its front stays aligned with the host's front and it is not turned`,
          suggestion: "Rotate the template or the part if the other orientation is meant",
          params: { host: h.host, closeup: h.ref },
        });
      }
      levels.push({
        ...common,
        assembly,
        turn: turnUsed,
        fit: f?.fit ?? 1,
        ...(f === undefined ? {} : { mismatch: f.dev }),
      });
      next.push(...hostsOf(spec, assembly, h.ref, path, h.chain, `/assemblies/${built.index}`));
    }
    frontier = next.sort((p, q) => cmp(p.host, q.host));
  }
  levels.sort((p, q) => cmp(p.path, q.path));
  return { levels, images: [...images].sort(), credits, diagnostics };
}
