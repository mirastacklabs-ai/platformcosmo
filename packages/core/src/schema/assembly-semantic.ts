/**
 * Semantic checks for schema revision 1.2.0, figure part (Track A2, A2-F; design
 * docs/design/assemblies.md §7, §15, §18). Assembly parts and programs are A2-1's.
 *
 * Covered: image ids and references (`image/unknown`), figure parts and stages (selectors,
 * duplicate and twice-moved parts), and explode/implode actions on figures with their timing.
 * Every diagnostic has a path, and a did-you-mean where an id or selector is involved.
 *
 * R-1 lifted `phase1a` in the merge guard (`unsupported.ts`): `images`, `figures` and figure
 * actions render. These checks run alongside the guard, and, now that `phase1a` is lifted,
 * also report `assembly/unknown-target` for actions whose target is not a figure while the
 * guard still gates that target's phase (tracks §0), so a Phase 1a build never resolves such
 * a target. Figure ids are camera focus targets.
 */
import type {
  DcPack,
  Diagnostic,
  PartPlacement,
  PartPlacementCheck,
  PartShapeDef,
  PartShapeRegistry,
} from "../contracts/index.js";
import {
  closeupRefs,
  planFigureSteps,
  resolveFigure,
  stepViews,
  type ResolvedFigure,
} from "../scene/boards.js";
import { resolveStoryboard, type ResolvedStoryboard } from "../scene/storyboards.js";
import { planScene } from "../scene/assembly/plan-scene.js";
import { rackTargeted, targetedRacks } from "../scene/assembly/racks.js";
import { MAX_LEVEL_DEPTH } from "../scene/assembly/levels.js";
import { UNRENDERED, type GuardGroup } from "./unsupported.js";
import { globMatch } from "./glob.js";
import { LevelMachine, checkLevel, type LevelAction, type LevelFail } from "./assembly-levels.js";
import { closest, didYouMean, q } from "./suggest.js";
import {
  AssemblyModel,
  LEAF_ERROR,
  LEAF_WARN,
  MAX_DEPTH,
  ROLES,
  parseSelector,
  reachesOpaque,
  selects,
  type Flat,
  type ParsedSelector,
  type TNode,
  type Walk,
} from "./assembly-tree.js";
import type {
  PlatformCosmoSpec,
  SpecAssembly,
  SpecAssemblyAction,
  SpecBuildProgram,
  SpecExplodeProgram,
  SpecPart,
  SpecProgram,
  SpecRack,
} from "./types.gen.js";

export function figureDiagnostics(
  spec: PlatformCosmoSpec,
  groups: Readonly<Record<GuardGroup, boolean>> = UNRENDERED,
  /** Which `steps[].focus` ids zoom the camera; the same set the scene uses (default: all). */
  isFocusTarget: (id: string) => boolean = () => true,
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
  // Figures a `closeup` names are drawn only in their levels (§8.4): their bare id is no target;
  // an action on a close-up instance (`<host>/closeup`) plays that instance's own copy.
  const closeupOnly = closeupRefs(spec);
  const planned = new Map<string, ResolvedFigure>();
  for (const [id, f] of figures) if (!closeupOnly.has(id)) planned.set(id, f);
  for (const [path, ref] of figureInstanceTargets(spec)) {
    const f = figures.get(ref);
    if (f !== undefined) planned.set(path, { ...f, id: path });
  }
  const views = stepViews(spec, isFocusTarget);
  const storyboards = new Map<string, ResolvedStoryboard>();
  for (const sb of spec.storyboards ?? [])
    if (!storyboards.has(sb.id) && !closeupOnly.has(sb.id))
      storyboards.set(sb.id, resolveStoryboard(sb));
  out.push(
    ...planFigureSteps(spec, planned, views, {
      gated: groups,
      ...(storyboards.size > 0 ? { storyboards } : {}),
      ...(closeupOnly.size > 0 ? { closeupOnly } : {}),
    }).diagnostics,
  );
  return out;
}

/**
 * Figure close-up instances that step actions name (§8.4): the longest `…/closeup` prefix of an
 * action target that resolves, over the expanded tree, to a close-up drawing a figure, by path,
 * with the figure's id. Only built when some target passes through a `closeup` segment.
 */
function figureInstanceTargets(spec: PlatformCosmoSpec): Map<string, string> {
  const out = new Map<string, string>();
  const targets = (spec.steps ?? []).flatMap((s) => (s.assembly ?? []).map(actionTarget));
  if (!hasAssemblyContent(spec) || !targets.some((t) => t.includes("/closeup"))) return out;
  const model = new AssemblyModel(spec);
  const racks = new Set((spec.racks ?? []).map((r) => r.id));
  // a plain rack slot is opaque: its close-up is entered through the slot's `closeup` (as
  // `slotCloseupWalk` does), anything else walks the expanded tree
  const walkTo = (segs: readonly string[]): Walk | undefined => {
    const from = model.root(segs[0] as string);
    if (from === undefined) return undefined;
    if (segs[2] !== "closeup" || !racks.has(segs[0] as string)) return model.walk(from, segs);
    const slot = model.walk(from, segs.slice(0, 2));
    if (!slot.ok || slot.node.closeup === undefined) return undefined;
    const instance = model.closeupNode(slot.node.closeup);
    return instance === undefined ? undefined : model.walk(instance, ["closeup", ...segs.slice(3)]);
  };
  for (const target of targets) {
    const segs = target.split("/");
    for (let i = segs.length; i > 1; i--) {
      if (segs[i - 1] !== "closeup") continue;
      const path = segs.slice(0, i);
      const w = walkTo(path);
      if (w?.ok === true && w.node.kind === "figure" && w.node.ref !== undefined) {
        out.set(path.join("/"), w.node.ref);
        break;
      }
    }
  }
  return out;
}

// =============================================================================================
// Assemblies (A2-1): namespace, references, programs, budgets. Design: assemblies.md §3, §5,
// §6.1, §7.2, §8.3-§8.4, §13, §18. Every check returns diagnostics (nothing throws on bad
// input), is bounded by the §13 budgets before any expansion (assembly-tree.ts), and iterates
// in fixed spec order. Only 1.2.0 content triggers any of it, so 1.1 specs are untouched.
// =============================================================================================

export interface AssemblyContext {
  /** Installed pack shapes (`hw:`, `auto:`, `brick:`, user packs); absent: pack refs unchecked. */
  readonly parts?: PartShapeRegistry;
  /** `dc:` shapes come from the DC pack when no registry names them. */
  readonly dc?: DcPack;
  /** Pack placement check (`brick/off-grid`), called once per spec part with a pack shape. */
  readonly placement?: PartPlacementCheck;
}

const PRIMITIVES = [
  "box",
  "plate",
  "cylinder",
  "ring",
  "shaft",
  "stud",
  "prism",
  "wedge",
  "tray",
  "card",
  "sprite",
] as const;
const PACK_REF = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
/** Selector node-tests allowed per call before the remaining selector checks are skipped. */
const WORK_CAP = 2_000_000;
/** Candidate comparisons allowed per call for did-you-mean searches over parts and paths. */
const HINT_BUDGET = 100_000;
/** Warnings and infos one program may report before a summary replaces the rest. */
const PROGRAM_DIAG_CAP = 50;
/** Candidates per did-you-mean search (bounded edit distance, PLAN section 5). */
const CANDIDATE_CAP = 1024;

const mk = (
  severity: Diagnostic["severity"],
  code: string,
  path: string,
  message: string,
  suggestion?: string,
  params?: Record<string, unknown>,
): Diagnostic => ({
  severity,
  code,
  path,
  message,
  ...(suggestion === undefined ? {} : { suggestion }),
  ...(params === undefined ? {} : { params }),
});

const ptrKey = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");
const ACTION_KEYS = ["explode", "implode", "build", "unbuild"] as const;
type ActionKind = (typeof ACTION_KEYS)[number];
const actionKind = (a: SpecAssemblyAction): ActionKind =>
  ACTION_KEYS.find((k) => k in a) as ActionKind;
const actionTarget = (a: SpecAssemblyAction): string =>
  (a as unknown as Record<string, string>)[actionKind(a)] as string;
const article = (word: string): string => (/^[aeiou]/.test(word) ? "an" : "a");
const upper = (s: string): string => `${s[0]!.toUpperCase()}${s.slice(1)}`;

const contentMemo = new WeakMap<object, boolean>();

/** Whether the spec has any schema 1.2.0 content (the guard's `has12`); computed once per spec. */
export function hasAssemblyContent(spec: PlatformCosmoSpec): boolean {
  let has = contentMemo.get(spec);
  if (has === undefined) {
    has = computeContent(spec);
    contentMemo.set(spec, has);
  }
  return has;
}

function computeContent(spec: PlatformCosmoSpec): boolean {
  return (
    spec.assemblies !== undefined ||
    spec.images !== undefined ||
    spec.figures !== undefined ||
    spec.storyboards !== undefined ||
    (spec.steps ?? []).some((st) => st.assembly !== undefined) ||
    (spec.racks ?? []).some(
      (r) =>
        r.programs !== undefined ||
        (r.slots ?? []).some((sl) => sl.assembly !== undefined || sl.closeup !== undefined),
    )
  );
}

/**
 * True when the shared 1.1 reference checks (semantic.ts) must leave this `focus`/`set` path to
 * the assembly checks: its root is an assembly, or a rack path deeper than `rack/slot` in a spec
 * with 1.2.0 content (part and close-up paths).
 */
export function isAssemblyPath(spec: PlatformCosmoSpec, path: string): boolean {
  if (!hasAssemblyContent(spec)) return false;
  const segs = path.split("/");
  const root = segs[0] as string;
  if ((spec.assemblies ?? []).some((a) => a.id === root)) return true;
  return segs.length >= 3 && (spec.racks ?? []).some((r) => r.id === root);
}

type RootKind = "assembly" | "rack" | "storyboard" | "figure" | "other";
const ROOT_PHASE: Record<Exclude<RootKind, "other">, GuardGroup> = {
  assembly: "phase1b",
  rack: "phase2",
  storyboard: "storyboards",
  figure: "phase1a",
};

interface Check {
  readonly spec: PlatformCosmoSpec;
  readonly groups: Readonly<Record<GuardGroup, boolean>>;
  readonly ctx: AssemblyContext;
  readonly model: AssemblyModel;
  readonly out: Diagnostic[];
  readonly imageIds: ReadonlySet<string>;
  readonly kinds: ReadonlyMap<string, RootKind>;
  work: number;
  hints: number;
  /** Selector matches by owner and selector text. */
  readonly matches: Map<TNode, Map<string, { paths: readonly string[]; hint?: string | null }>>;
  /** Sorted installed shape refs, built once on first use. */
  known?: readonly string[];
  /** Placement-check calls made so far. */
  placed?: number;
  /** Racks in assembly mode with `programs`, as the DC pack built them, by rack index. */
  readonly builtRacks: ReadonlyMap<number, TNode>;
}

/** Candidates for a did-you-mean search, bounded (deterministic: the first ones in order). */
const cap = <T>(xs: readonly T[]): readonly T[] =>
  xs.length > CANDIDATE_CAP ? xs.slice(0, CANDIDATE_CAP) : xs;

/**
 * The closest candidate, within the call's hint budget: searches over parts and paths are
 * charged per candidate, so thousands of bad selectors cannot cost thousands of full searches.
 * Once the budget is spent no more suggestions are made (the diagnostics themselves remain).
 */
function near(c: Check, input: string, candidates: readonly string[]): string | undefined {
  const list = cap(candidates);
  if (c.hints < list.length) return undefined;
  c.hints -= list.length;
  return closest(input, list);
}

/** Charges `n` units of scan work; false (and `capped`) once the run's work cap is spent. */
function charge(c: Check, n: number): boolean {
  c.work += n;
  if (c.work > WORK_CAP) {
    c.model.capped = true;
    return false;
  }
  return true;
}

/** A path walk charged to the work cap; undefined when the cap is spent (check skipped). */
function walkOf(c: Check, from: TNode, segs: readonly string[]): Walk | undefined {
  return charge(c, 16 * segs.length) ? c.model.walk(from, segs) : undefined;
}

/**
 * Assembly validation (track A2-1). Namespace (sibling uniqueness after `count`, reserved ids,
 * depth), references with did-you-mean over the expanded tree (focus, `set`, actions, programs,
 * selectors, `overrides`, `mates`, `inserts`, `use`, `closeup`, images, shapes, template
 * cycles), program checks and the leaf budget.
 *
 * `groups` is the merge guard's phase map (default: `UNRENDERED`). Structure checks always run,
 * as the figure checks do; checks of step actions run for a target only once the guard lifts the
 * target's phase, mirroring `unsupported.ts` (tracks section 0), so lifting one phase never
 * enables another's.
 */
export function assemblyDiagnostics(
  spec: PlatformCosmoSpec,
  groups: Readonly<Record<GuardGroup, boolean>> = UNRENDERED,
  ctx: AssemblyContext = {},
): Diagnostic[] {
  if (!hasAssemblyContent(spec)) return [];
  const out: Diagnostic[] = [];
  const model = new AssemblyModel(spec);
  const kinds = new Map<string, RootKind>();
  // An id declared in two lists resolves as the merge guard resolves it (unsupported.ts): racks,
  // then assemblies, figures and storyboards override one another in that order; ids of the 1.1
  // object lists never override a 1.2.0 kind.
  const declare = (list: readonly { readonly id?: string }[] | undefined, k: RootKind): void => {
    for (const it of list ?? []) if (it.id !== undefined) kinds.set(it.id, k);
  };
  for (const list of [spec.nodes, spec.groups, spec.equipment, spec.rows, spec.aisles, spec.cables])
    declare(list, "other");
  declare(spec.racks, "rack");
  declare(spec.assemblies, "assembly");
  declare(spec.figures, "figure");
  declare(spec.storyboards, "storyboard");
  const c: Check = {
    spec,
    groups,
    ctx,
    model,
    out,
    imageIds: new Set((spec.images ?? []).map((i) => i.id)),
    kinds,
    work: 0,
    hints: HINT_BUDGET,
    matches: new Map(),
    builtRacks: builtRackTrees(spec, model, ctx),
  };

  checkCycles(c);
  checkBudget(c);
  (spec.assemblies ?? []).forEach((a, i) => checkAssembly(c, a, i));
  (spec.racks ?? []).forEach((r, i) => checkRack(c, r, i));
  checkStoryboards(c);
  checkSteps(c);
  checkCloseupChains(c);
  out.push(...model.diagnostics);
  if (model.capped) {
    out.push(
      mk(
        "warning",
        "budget/time",
        "/assemblies",
        "Validation reached its work limit; later selector checks (selector-empty, moved-twice) and reference checks were skipped",
        "Use fewer or broader selectors, or fewer parts",
      ),
    );
  }
  return out;
}

/**
 * Rack-program selectors resolve over the rack the DC pack builds (§6.1, §8.1), so with a DC pack
 * they are validated over that same tree: the targeted racks that have `programs`, built as the
 * scene builds them (one planner for all of them). Without a pack, or when it fails, the rack
 * tree stays opaque below the frame and plain slots (nothing there is reported).
 */
function builtRackTrees(
  spec: PlatformCosmoSpec,
  model: AssemblyModel,
  ctx: AssemblyContext,
): ReadonlyMap<number, TNode> {
  const out = new Map<number, TNode>();
  const dc = ctx.dc;
  if (dc?.buildAssembly === undefined) return out;
  const racks = spec.racks ?? [];
  const wanted = targetedRacks(spec).filter((id) =>
    racks.some((r) => r.id === id && r.programs !== undefined),
  );
  if (wanted.length === 0) return out;
  // the racks only, built as the scene builds them (`planScene`); a failing pack leaves the
  // opaque tree (`closeupDiagnostics`, in validate, and the render report the failure)
  const planned = planScene(spec, {
    dc,
    ...(ctx.parts === undefined ? {} : { parts: ctx.parts }),
    assemblies: false,
    closeups: false,
    guard: true,
  });
  for (const a of planned.racks?.assemblies ?? []) {
    const ri = racks.findIndex((r) => r.id === a.id);
    if (ri < 0 || !wanted.includes(a.id)) continue;
    const t = model.builtRackTree(ri, a.root);
    if (t !== undefined) out.set(ri, t);
  }
  return out;
}

// ---- cycles and budgets ----------------------------------------------------------------------

function checkCycles(c: Check): void {
  const { model } = c;
  const n = model.assemblies.length;
  interface Edge {
    readonly to: number;
    readonly ptr: string;
  }
  const edges: Edge[][] = model.assemblies.map(() => []);
  model.assemblies.forEach((a, i) => {
    const add = (id: string | undefined, ptr: string): void => {
      const to = id === undefined ? undefined : model.byId.get(id);
      if (to !== undefined) (edges[i] as Edge[]).push({ to, ptr });
    };
    add(a.closeup, `/assemblies/${i}/closeup`);
    const walk = (parts: readonly SpecPart[], base: string, level: number): void => {
      parts.forEach((p, k) => {
        const ptr = `${base}/${k}`;
        if (p.parts === undefined) add(p.use, `${ptr}/use`);
        add(p.closeup, `${ptr}/closeup`);
        if (p.parts !== undefined && level < MAX_DEPTH - 1)
          walk(p.parts, `${ptr}/parts`, level + 1);
      });
    };
    walk(a.parts, `/assemblies/${i}/parts`, 1);
  });
  const color = new Array<number>(n).fill(0);
  const stack: number[] = [];
  const visit = (u: number): void => {
    color[u] = 1;
    stack.push(u);
    for (const e of edges[u] as Edge[]) {
      if (color[e.to] === 0) visit(e.to);
      else if (color[e.to] === 1) {
        const cycle = stack
          .slice(stack.indexOf(e.to))
          .map((x) => (model.assemblies[x] as SpecAssembly).id);
        c.out.push(
          mk(
            "error",
            "assembly/template-cycle",
            e.ptr,
            `Assemblies reference each other in a cycle: ${[...cycle, cycle[0]].join(" -> ")}`,
            'Break the cycle: an assembly cannot contain itself through "use" or "closeup"',
            { cycle },
          ),
        );
      }
    }
    stack.pop();
    color[u] = 2;
  };
  for (let i = 0; i < n; i++) if (color[i] === 0) visit(i);
}

function checkBudget(c: Check): void {
  const { model, spec } = c;
  let total = 0;
  model.assemblies.forEach((a, i) => {
    if (a.template !== true) total += model.metrics(i).leaves;
  });
  for (const r of spec.racks ?? []) {
    for (const s of r.slots ?? []) {
      const t = s.assembly === undefined ? undefined : model.byId.get(s.assembly);
      if (t !== undefined) total += model.metrics(t).leaves;
    }
  }
  // Templates drawn only as close-ups count too: budgets count every level (§8.4, §13).
  const counted = new Set<number>();
  model.assemblies.forEach((a, i) => {
    if (a.template !== true) counted.add(i);
  });
  for (const r of spec.racks ?? []) {
    for (const s of r.slots ?? []) {
      const t = s.assembly === undefined ? undefined : model.byId.get(s.assembly);
      if (t !== undefined) counted.add(t);
    }
  }
  const refs: (string | undefined)[] = [];
  model.assemblies.forEach((a, i) => {
    refs.push(a.closeup);
    const walk = (parts: readonly SpecPart[], level: number): void => {
      for (const p of parts) {
        refs.push(p.closeup);
        if (p.parts !== undefined && level < MAX_DEPTH - 1) walk(p.parts, level + 1);
      }
    };
    walk(a.parts, 1);
    void i;
  });
  for (const r of spec.racks ?? []) for (const s of r.slots ?? []) refs.push(s.closeup);
  for (const id of refs) {
    const t = id === undefined ? undefined : model.byId.get(id);
    if (t !== undefined && !counted.has(t)) {
      counted.add(t);
      total += model.metrics(t).leaves;
    }
  }
  if (total <= LEAF_WARN) return;
  const error = total > LEAF_ERROR;
  const shown = total >= 1e9 ? "over a billion" : String(total);
  c.out.push(
    mk(
      error ? "error" : "warning",
      "budget/assembly-parts",
      "/assemblies",
      error
        ? `Assemblies expand to ${shown} leaf parts after count and use (limit ${LEAF_ERROR})`
        : `Assemblies expand to ${shown} leaf parts after count and use (warning above ${LEAF_WARN})`,
      error
        ? "Lower count values, use fewer parts, or split the model; sub-assemblies move as one unit"
        : "Merge repeated parts with count, or use sub-assemblies that explode as units",
      { leaves: total, limit: LEAF_ERROR, warn: LEAF_WARN },
    ),
  );
}

// ---- shared reference helpers ------------------------------------------------------------------

type Failed = Extract<Walk, { ok: false }>;

/** The hint for an unresolved path: the nearest sibling, a deeper match, or what exists. */
function pathHint(c: Check, w: Failed, segs: readonly string[], skip: number): string {
  const upto = segs.slice(skip, w.at).join("/");
  const owner = upto === "" ? w.parent.id : upto;
  if (w.reason === "no-closeup") return `Set "closeup" on ${q(owner)} first`;
  const seg = segs[w.at] as string;
  const rest = segs.slice(w.at + 1);
  const own = [
    ...w.parent.children.map((x) => x.id),
    ...(w.parent.closeup === undefined ? [] : ["closeup"]),
  ];
  const join = (mid: string): string => [...segs.slice(skip, w.at), mid, ...rest].join("/");
  const hit = near(c, seg, own);
  if (hit !== undefined) return `Did you mean "${join(hit)}"?`;
  const all = c.model.flat(w.parent);
  if (!charge(c, all.length)) return `Check the part ids under ${q(owner)}`;
  const flat = all.filter((f) => f.segs.length >= 2);
  const exact = flat.find((f) => f.node.id === seg);
  if (exact !== undefined) return `Did you mean "${join(exact.path)}"?`;
  const deep = near(c, seg, [...new Set(flat.map((f) => f.node.id))]);
  if (deep !== undefined)
    return `Did you mean "${join((flat.find((f) => f.node.id === deep) as Flat).path)}"?`;
  const kids = w.parent.children;
  return kids.length > 0
    ? `${q(owner)} has: ${kids
        .slice(0, 8)
        .map((x) => x.id)
        .join(", ")}${kids.length > 8 ? ", ..." : ""}`
    : `${q(owner)} has no child parts`;
}

/** An `assembly/unknown-target` error for a walk that failed. */
function unresolved(
  c: Check,
  path: string,
  what: string,
  original: string,
  w: Failed,
  segs: readonly string[],
  skip = 0,
): Diagnostic {
  const upto = segs.slice(skip, w.at).join("/");
  const owner = q(upto === "" ? w.parent.id : upto);
  return mk(
    "error",
    "assembly/unknown-target",
    path,
    w.reason === "no-closeup"
      ? `Unknown ${what} ${q(original)}: ${owner} has no close-up`
      : `Unknown ${what} ${q(original)}: ${owner} has no part ${q(segs[w.at])}`,
    pathHint(c, w, segs, skip),
    { id: original },
  );
}

/** Ids of the given kinds, sorted, for did-you-mean. */
const idsOfKind = (c: Check, ...ks: RootKind[]): string[] =>
  [...c.kinds.entries()]
    .filter(([, k]) => ks.includes(k))
    .map(([id]) => id)
    .sort();

function unknownImage(c: Check, path: string, id: string): void {
  // Same wording as the figure checks (A2-F), kept local so that part stays untouched.
  c.out.push(
    mk(
      "error",
      "image/unknown",
      path,
      `Unknown image ${q(id)}`,
      didYouMean(id, c.imageIds) ??
        (c.imageIds.size > 0
          ? `Images: ${[...c.imageIds].slice(0, 8).join(", ")}`
          : `Declare it in "images" first`),
      { id },
    ),
  );
}

/**
 * A `use`, slot `assembly` or `closeup` reference. Returns the assembly's index when it names
 * one; otherwise reports (unknown id, or an id of the wrong kind) and returns undefined.
 */
function checkRef(
  c: Check,
  path: string,
  id: string,
  what: string,
  allow: readonly RootKind[],
): number | undefined {
  const kind = c.kinds.get(id);
  if (kind !== undefined && allow.includes(kind)) return c.model.byId.get(id);
  const names = allow.length > 1 ? "an assembly, figure or storyboard" : "an assembly";
  const candidates = idsOfKind(c, ...allow);
  c.out.push(
    mk(
      "error",
      "assembly/unknown-target",
      path,
      kind === undefined ? `Unknown ${what} ${q(id)}` : `${upper(what)} ${q(id)} is not ${names}`,
      didYouMean(id, cap(candidates)) ??
        (candidates.length > 0
          ? `Available: ${candidates.slice(0, 8).join(", ")}`
          : `Declare ${names} with that id first`),
      { id },
    ),
  );
  return undefined;
}

const CLOSEUP_KINDS: readonly RootKind[] = ["assembly", "figure", "storyboard"];

/** Depth of a template under a path prefix of `prefix` segments (§13: at most 8 segments). */
function checkTemplateDepth(c: Check, path: string, ai: number, prefix: number, id: string): void {
  const h = c.model.metrics(ai).height;
  if (prefix + h <= MAX_DEPTH) return;
  c.out.push(
    mk(
      "error",
      "assembly/too-deep",
      path,
      `Template ${q(id)} is ${h} levels deep; placed here its paths would be ${prefix + h} segments (limit ${MAX_DEPTH})`,
      "Flatten the template or use it at a shallower level",
      { depth: prefix + h, limit: MAX_DEPTH },
    ),
  );
}

// ---- parts ---------------------------------------------------------------------------------------

const hintOf = (m: string | undefined): string | undefined =>
  m === undefined ? undefined : `Did you mean "${m}"?`;

function knownShapes(c: Check): readonly string[] {
  const dc = c.ctx.dc?.shapes;
  return [
    ...new Set([
      ...(c.ctx.parts?.list() ?? []),
      ...(dc?.shapes.map((s) => `${dc.id}:${s.id}`) ?? []),
    ]),
  ].sort();
}

function shapeLookup(c: Check, ref: string): PartShapeDef | undefined | "unchecked" {
  const registry = c.ctx.parts;
  const def = registry?.get(ref);
  if (def !== undefined) return def;
  const dc = c.ctx.dc?.shapes;
  if (dc !== undefined && ref.startsWith(`${dc.id}:`)) {
    return dc.shapes.find((s) => `${dc.id}:${s.id}` === ref);
  }
  return registry === undefined ? "unchecked" : undefined;
}

/** Diagnostics kept per placement call, and calls made per validation run. */
const PLACEMENT_DIAG_CAP = 8;
const PLACEMENT_CALL_CAP = 20_000;
const GROUP_NODE_CAP = 2_000;

/** Pack-shape refs below a group, for the placement check: bounded, sorted, deduplicated. */
function groupShapes(c: Check, p: SpecPart): readonly string[] {
  const found = new Set<string>();
  const seen = new Set<string>();
  let nodes = 0;
  const walk = (parts: readonly SpecPart[], depth: number): void => {
    for (const q of parts) {
      if (++nodes > GROUP_NODE_CAP || depth > MAX_DEPTH) return;
      if (q.parts !== undefined) walk(q.parts, depth + 1);
      else if (q.use !== undefined) {
        if (seen.has(q.use)) continue;
        seen.add(q.use);
        const t = (c.spec.assemblies ?? []).find((a) => a.id === q.use);
        if (t !== undefined) walk(t.parts, depth + 1);
      } else if (q.shape !== undefined && PACK_REF.test(q.shape)) found.add(q.shape);
    }
  };
  walk([p], 0);
  return [...found].sort();
}

const wellFormed = (d: unknown): d is Diagnostic => {
  const x = d as Partial<Diagnostic> | null;
  return (
    typeof x === "object" &&
    x !== null &&
    (x.severity === "error" || x.severity === "warning" || x.severity === "info") &&
    typeof x.code === "string" &&
    typeof x.path === "string" &&
    typeof x.message === "string" &&
    (x.suggestion === undefined || typeof x.suggestion === "string")
  );
};

/**
 * Runs the pack's placement check for one spec part or group; never throws, the output is
 * capped and only well-formed diagnostics are kept.
 */
function checkPlacement(
  c: Check,
  p: SpecPart,
  ptr: string,
  shape: string | undefined,
  units: string,
): void {
  const fn = c.ctx.placement;
  if (fn === undefined) return;
  c.placed = (c.placed ?? 0) + 1;
  if (c.placed > PLACEMENT_CALL_CAP) {
    if (c.placed === PLACEMENT_CALL_CAP + 1) {
      c.out.push(
        mk(
          "info",
          "assembly/diagnostics-capped",
          "/assemblies",
          `Placement checks stopped after ${PLACEMENT_CALL_CAP} parts; later parts are not checked`,
          "Merge repeated parts with count",
          { limit: PLACEMENT_CALL_CAP },
        ),
      );
    }
    return;
  }
  const req: PartPlacement = {
    path: ptr,
    ...(shape === undefined ? { kind: "group" as const, shapes: groupShapes(c, p) } : { shape }),
    units,
    ...(p.at === undefined ? {} : { at: p.at }),
    ...(p.pitch === undefined ? {} : { pitch: p.pitch }),
    ...(p.count === undefined ? {} : { count: p.count }),
    ...(p.size === undefined ? {} : { size: p.size }),
    ...(p.axis === undefined ? {} : { axis: p.axis }),
    ...(p.params === undefined ? {} : { params: p.params }),
  };
  try {
    const ds = fn(req);
    if (!Array.isArray(ds)) return;
    let kept = 0;
    for (const d of ds) {
      if (!wellFormed(d)) continue;
      if (kept++ >= PLACEMENT_DIAG_CAP) {
        c.out.push(
          mk(
            "info",
            "assembly/diagnostics-capped",
            ptr,
            `This part's placement check reported more than ${PLACEMENT_DIAG_CAP} diagnostics; the rest are omitted`,
            undefined,
            { limit: PLACEMENT_DIAG_CAP },
          ),
        );
        break;
      }
      c.out.push(d);
    }
  } catch {
    // A pack's placement check must not throw; if it does, it reports nothing.
  }
}

function checkShape(c: Check, p: SpecPart, ptr: string, units: string): void {
  const shape = p.shape;
  if (shape === undefined || (PRIMITIVES as readonly string[]).includes(shape)) {
    if (p.params !== undefined) {
      c.out.push(
        mk(
          "error",
          "assembly/shape-params",
          `${ptr}/params`,
          `"params" only applies to pack shapes (pack:id), not to ${q(shape ?? "box")}`,
          'Remove "params", or use a pack shape such as "brick:brick"',
          { shape: shape ?? "box" },
        ),
      );
    }
    return;
  }
  if (!PACK_REF.test(shape)) {
    c.out.push(
      mk(
        "error",
        "assembly/unknown-shape",
        `${ptr}/shape`,
        `Unknown shape ${q(shape)}`,
        didYouMean(shape, PRIMITIVES) ??
          `Use a primitive (${PRIMITIVES.join(", ")}) or a pack shape such as "hw:dimm"`,
        { shape },
      ),
    );
    return;
  }
  const def = shapeLookup(c, shape);
  if (def === "unchecked") return; // no pack registry wired: nothing to check against
  if (def === undefined) {
    c.known ??= knownShapes(c);
    c.out.push(
      mk(
        "error",
        "assembly/unknown-shape",
        `${ptr}/shape`,
        `Shape ${q(shape)} is not installed`,
        hintOf(near(c, shape, c.known)) ?? "Install the pack that provides it, or use a primitive",
        { shape },
      ),
    );
    return;
  }
  checkPlacement(c, p, ptr, shape, units);
  if (p.params === undefined) return;
  try {
    for (const d of def.readParams(p.params).diagnostics) {
      const sub = d.path === "" ? "" : d.path.startsWith("/") ? d.path : `/${d.path}`;
      c.out.push({
        severity: d.severity,
        code: "assembly/shape-params",
        path: `${ptr}/params${sub}`,
        message: d.message,
        ...(d.suggestion === undefined ? {} : { suggestion: d.suggestion }),
        params: { shape, ...(d.params ?? {}) },
      });
    }
  } catch {
    // A pack's readParams must not throw; if it does, report its params as unusable.
    c.out.push(
      mk("error", "assembly/shape-params", `${ptr}/params`, `Invalid params for shape ${q(shape)}`),
    );
  }
}

function checkAssembly(c: Check, a: SpecAssembly, i: number): void {
  const base = `/assemblies/${i}`;
  const root = c.model.tree(i);
  if (a.closeup !== undefined) {
    const t = checkRef(c, `${base}/closeup`, a.closeup, "close-up", CLOSEUP_KINDS);
    if (t !== undefined) checkTemplateDepth(c, `${base}/closeup`, t, 2, a.closeup);
  }
  if (a.program !== undefined && !(a.programs ?? []).some((p) => p.id === a.program)) {
    const ids = (a.programs ?? []).map((p) => p.id);
    c.out.push(
      mk(
        "error",
        "assembly/unknown-program",
        `${base}/program`,
        `Assembly ${q(a.id)} has no program ${q(a.program)}`,
        didYouMean(a.program, ids) ??
          (ids.length > 0 ? `Programs: ${ids.join(", ")}` : 'Add the program to "programs" first'),
        { id: a.program },
      ),
    );
  }
  checkParts(c, a.parts, `${base}/parts`, 1, a.units ?? "mm");
  if (root !== undefined) checkPrograms(c, root, a.programs, `${base}/programs`);
}

function checkParts(
  c: Check,
  parts: readonly SpecPart[],
  base: string,
  level: number,
  units: string,
): void {
  parts.forEach((p, k) => {
    const ptr = `${base}/${k}`;
    if (p.id === "closeup") {
      c.out.push(
        mk(
          "error",
          "assembly/reserved-id",
          `${ptr}/id`,
          'The id "closeup" is reserved as the close-up path segment',
          'Rename the part (for example "close-up-1")',
          { id: p.id },
        ),
      );
    }
    checkShape(c, p, ptr, units);
    // A group moved off the stud grid shifts its bricks off it (only when it has pack leaves).
    if (
      (p.parts !== undefined || p.use !== undefined) &&
      c.ctx.parts !== undefined &&
      (p.at !== undefined || p.pitch !== undefined)
    ) {
      checkPlacement(c, p, ptr, undefined, units);
    }
    const image = p.image;
    if (image !== undefined) {
      const ref = typeof image === "string" ? image : image.ref;
      if (!c.imageIds.has(ref)) {
        unknownImage(c, typeof image === "string" ? `${ptr}/image` : `${ptr}/image/ref`, ref);
      }
    }
    if (p.use !== undefined) {
      if (p.parts !== undefined) {
        c.out.push(
          mk(
            "warning",
            "assembly/use-ignored",
            `${ptr}/use`,
            '"use" is ignored because "parts" is set',
            'Remove "use", or remove "parts" to instance the template',
            { id: p.use },
          ),
        );
      }
      const t = checkRef(c, `${ptr}/use`, p.use, "template", ["assembly"]);
      if (t !== undefined && p.parts === undefined) {
        checkTemplateDepth(c, `${ptr}/use`, t, 1 + level, p.use);
      }
    }
    if (p.closeup !== undefined) {
      const t = checkRef(c, `${ptr}/closeup`, p.closeup, "close-up", CLOSEUP_KINDS);
      if (t !== undefined) checkTemplateDepth(c, `${ptr}/closeup`, t, 2 + level, p.closeup);
    }
    const here = c.model.firstDef.get(ptr);
    for (const key of ["mates", "inserts"] as const) {
      const ref = p[key];
      if (ref === undefined || here === undefined) continue;
      const segs = [here.parent.id, ...ref.split("/")];
      const w = walkOf(c, here.parent, segs);
      if (w !== undefined && !w.ok) {
        c.out.push(unresolved(c, `${ptr}/${key}`, `"${key}" part`, ref, w, segs, 1));
      }
    }
    if (p.parts !== undefined) {
      if (level >= MAX_DEPTH - 1) {
        c.out.push(
          mk(
            "error",
            "assembly/too-deep",
            `${ptr}/parts/0`,
            `Part paths would be ${level + 2} segments long (limit ${MAX_DEPTH})`,
            "Flatten the nesting: the assembly id plus at most 7 levels of parts",
            { depth: level + 2, limit: MAX_DEPTH },
          ),
        );
      } else checkParts(c, p.parts, `${ptr}/parts`, level + 1, units);
    }
    if (here !== undefined) checkPrograms(c, here.node, p.programs, `${ptr}/programs`);
  });
}

// ---- programs -----------------------------------------------------------------------------------

function typeOfFn(c: Check): (n: TNode) => string | undefined {
  return (n) => {
    if (n.type !== undefined) return n.type;
    if (n.shape === undefined || !n.shape.includes(":")) return undefined;
    const def = shapeLookup(c, n.shape);
    return def === undefined || def === "unchecked" ? undefined : def.type;
  };
}

/** Evaluates one selector against the owner's expanded tree; reports an empty match. */
function evalSelector(c: Check, owner: TNode, sel: string, path: string): readonly string[] {
  const flat = c.model.flat(owner);
  // A selector scans the owner's whole list: charged up front. An incomplete list (a cap was
  // hit while it was built) or a spent work cap skips the check rather than guess.
  if (!c.model.complete(owner)) return [];
  const p = parseSelector(sel);
  const typeOf = typeOfFn(c);
  // The same selector text is often repeated across stages: matched once per owner.
  let cache = c.matches.get(owner);
  if (cache === undefined) c.matches.set(owner, (cache = new Map()));
  let entry = cache.get(sel);
  if (entry === undefined) {
    if (!charge(c, flat.length * (1 + p.scopes.length))) return [];
    entry = { paths: flat.filter((f) => selects(p, f, typeOf)).map((f) => f.path) };
    cache.set(sel, entry);
  }
  const paths = entry.paths;
  if (paths.length > 0) return paths;

  // Empty match. Not reported when the answer depends on what this validator cannot see:
  // opaque DC parts, inferred roles, or pack shapes whose default type is not known.
  if (reachesOpaque(p, flat)) return paths;
  if (p.kind === "role" && ROLES.some((r) => globMatch(p.glob, r))) return paths;
  if (p.kind === "type") {
    // only the nodes this selector's scopes can reach matter
    const reach: ParsedSelector = { scopes: p.scopes, term: "*", glob: "*" };
    const unknown = flat.some(
      (f) =>
        typeOf(f.node) === undefined &&
        f.node.shape?.includes(":") === true &&
        selects(reach, f, typeOf),
    );
    if (unknown) return paths;
  }
  // The hint scans the owner's list several times: charged, computed once per owner and selector.
  const hintFor = (e: { hint?: string | null }): string | undefined => {
    if (e.hint === undefined) {
      e.hint = charge(c, flat.length * 4) ? (selectorHint(c, sel, p, flat, typeOf) ?? null) : null;
    }
    return e.hint ?? undefined;
  };
  c.out.push(
    mk(
      "warning",
      "assembly/selector-empty",
      path,
      `Selector ${q(sel)} matches no part of ${q(owner.id)}`,
      hintFor(entry),
      { selector: sel },
    ),
  );
  return paths;
}

function selectorHint(
  c: Check,
  sel: string,
  p: ParsedSelector,
  flat: readonly Flat[],
  typeOf: (n: TNode) => string | undefined,
): string | undefined {
  const direct = flat.filter((f) => f.segs.length === 1);
  const deep = flat.filter((f) => f.segs.length >= 2);
  if (p.kind === "role") {
    const near = closest(p.glob, ROLES);
    return near === undefined
      ? `Roles: ${ROLES.join(", ")}`
      : `Did you mean "${[...p.scopes, `role:${near}`].join("/")}"?`;
  }
  if (p.scopes.length === 0) {
    // The same term matches deeper: suggest the any-depth form.
    const anyDepth: ParsedSelector = { ...p, scopes: ["**"] };
    if (deep.some((f) => selects(anyDepth, f, typeOf))) return `Did you mean "**/${sel}"?`;
    if (p.kind === undefined) {
      const hit = near(
        c,
        p.term,
        direct.map((f) => f.node.id),
      );
      if (hit !== undefined) return `Did you mean "${hit}"?`;
      const far = near(c, p.term, [...new Set(deep.map((f) => f.node.id))]);
      if (far !== undefined) return `Did you mean "**/${far}"?`;
    } else {
      const values = new Set<string>();
      for (const f of flat) {
        if (p.kind === "type") {
          const t = typeOf(f.node);
          if (t !== undefined) values.add(t);
        } else for (const t of f.node.tags) values.add(t);
      }
      const hit = near(c, p.glob, [...values].sort());
      if (hit !== undefined) return `Did you mean "${p.kind}:${hit}"?`;
    }
  } else {
    const hit = near(
      c,
      sel,
      flat.map((f) => f.path),
    );
    if (hit !== undefined) return `Did you mean "${hit}"?`;
  }
  return direct.length > 0
    ? `Parts: ${direct
        .slice(0, 8)
        .map((f) => f.node.id)
        .join(", ")}${direct.length > 8 ? ", ..." : ""}`
    : undefined;
}

function checkPrograms(
  c: Check,
  owner: TNode,
  programs: readonly SpecProgram[] | undefined,
  base: string,
): void {
  (programs ?? []).forEach((prog, k) => {
    const pp = `${base}/${k}`;
    const start = c.out.length;
    if ("steps" in prog) buildProgram(c, owner, prog, pp);
    else explodeProgram(c, owner, prog, pp);
    // One program cannot flood the report: errors always stay, warnings and infos stop at the cap.
    const mine = c.out.splice(start);
    let soft = 0;
    let dropped = 0;
    for (const d of mine) {
      if (d.severity !== "error" && ++soft > PROGRAM_DIAG_CAP) dropped++;
      else c.out.push(d);
    }
    if (dropped > 0) {
      c.out.push(
        mk(
          "info",
          "assembly/diagnostics-capped",
          pp,
          `${dropped} more warning${dropped === 1 ? "" : "s"} in this program are not shown (limit ${PROGRAM_DIAG_CAP})`,
          "Fix the first selectors and validate again",
          { dropped, limit: PROGRAM_DIAG_CAP },
        ),
      );
    }
  });
}

const listPaths = (paths: readonly string[]): string =>
  `${paths
    .slice(0, 3)
    .map((p) => q(p))
    .join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;

function explodeProgram(c: Check, owner: TNode, prog: SpecExplodeProgram, pp: string): void {
  const movedBy = new Map<string, number>();
  prog.stages.forEach((st, j) => {
    const sp = `${pp}/stages/${j}`;
    const sel = new Set<string>();
    st.parts.forEach((s, i) => {
      for (const p of evalSelector(c, owner, s, `${sp}/parts/${i}`)) sel.add(p);
    });
    const except = new Set<string>();
    (st.except ?? []).forEach((s, i) => {
      for (const p of evalSelector(c, owner, s, `${sp}/except/${i}`)) except.add(p);
    });
    // no scan of the owner's list: only the selected paths are visited
    const moved = sel.size === 0 ? [] : [...sel].filter((p) => !except.has(p));
    const twice = moved.filter((p) => movedBy.has(p));
    if (twice.length > 0) {
      const first = movedBy.get(twice[0] as string) as number;
      c.out.push(
        mk(
          "error",
          "assembly/moved-twice",
          `${sp}/parts`,
          `Stage ${j + 1} moves ${listPaths(twice)} that stage ${first + 1} already moves; a part moves in one stage per program`,
          `Add ${q(twice[0])} to the "except" of stage ${j + 1}, or remove it from stage ${first + 1}`,
          { paths: twice.slice(0, 8), stage: j + 1, first: first + 1 },
        ),
      );
    }
    for (const p of moved) if (!movedBy.has(p)) movedBy.set(p, j);
    for (const key of Object.keys(st.overrides ?? {})) {
      const segs = [owner.id, ...key.split("/")];
      const w = walkOf(c, owner, segs);
      if (w !== undefined && !w.ok) {
        c.out.push(
          unresolved(c, `${sp}/overrides/${ptrKey(key)}`, "override part", key, w, segs, 1),
        );
      }
    }
  });
}

/** Whether any assembly, part or rack slot names a close-up (levels and views do not combine yet). */
function hasCloseups(spec: PlatformCosmoSpec): boolean {
  const walk = (parts: readonly SpecPart[] | undefined): boolean =>
    (parts ?? []).some((p) => p.closeup !== undefined || walk(p.parts));
  return (
    (spec.assemblies ?? []).some((a) => a.closeup !== undefined || walk(a.parts)) ||
    (spec.racks ?? []).some((r) => (r.slots ?? []).some((sl) => sl.closeup !== undefined))
  );
}

function buildProgram(c: Check, owner: TNode, prog: SpecBuildProgram, pp: string): void {
  const addedBy = new Map<string, number>();
  /** Proper ancestors of added nodes, with the first step that added something below them. */
  const below = new Map<string, number>();
  const { spec } = c;
  const mixed =
    (spec.nodes?.length ?? 0) +
      (spec.groups?.length ?? 0) +
      (spec.racks?.length ?? 0) +
      (spec.equipment?.length ?? 0) +
      (spec.rows?.length ?? 0) +
      (spec.aisles?.length ?? 0) +
      (spec.cables?.length ?? 0) +
      (spec.figures?.length ?? 0) +
      (spec.storyboards?.length ?? 0) >
    0;
  prog.steps.forEach((st, j) => {
    const sp = `${pp}/steps/${j}`;
    const sel = new Set<string>();
    st.add.forEach((s, i) => {
      for (const p of evalSelector(c, owner, s, `${sp}/add/${i}`)) sel.add(p);
    });
    const added = [...sel];
    // overlap by leaf set: the same node, an ancestor of an earlier add, or a node below one
    // (a descendant of a node selected in this very step is not a conflict)
    const firstStep = (p: string): number | undefined => {
      const hit = addedBy.get(p) ?? below.get(p);
      if (hit !== undefined) return hit;
      const segs = p.split("/");
      for (let k = segs.length - 1; k > 0; k--) {
        const up = addedBy.get(segs.slice(0, k).join("/"));
        if (up !== undefined) return up;
      }
      return undefined;
    };
    const twice = added.filter((p) => firstStep(p) !== undefined);
    if (twice.length > 0) {
      const first = firstStep(twice[0] as string) as number;
      c.out.push(
        mk(
          "error",
          "assembly/moved-twice",
          `${sp}/add`,
          `Step ${j + 1} adds ${listPaths(twice)} that step ${first + 1} already adds; a part is added by one step per program`,
          `Remove ${q(twice[0])} from step ${j + 1} or from step ${first + 1}`,
          { paths: twice.slice(0, 8), step: j + 1, first: first + 1 },
        ),
      );
    }
    for (const p of added) {
      if (!addedBy.has(p)) addedBy.set(p, j);
      const segs = p.split("/");
      for (let k = 1; k < segs.length; k++) {
        const up = segs.slice(0, k).join("/");
        if (!below.has(up)) below.set(up, j);
      }
    }
    if (st.view !== undefined && mixed) {
      c.out.push(
        mk(
          "error",
          "assembly/view-needs-assembly-only",
          `${sp}/view`,
          "Quarter-turn views need an assembly-only spec (no nodes, DC content, figures or storyboards)",
          'Remove "view", or move the nodes and racks to another spec',
        ),
      );
    }
    if (st.view !== undefined && !mixed && hasCloseups(spec)) {
      c.out.push(
        mk(
          "error",
          "assembly/view-needs-assembly-only",
          `${sp}/view`,
          "Quarter-turn views cannot be combined with close-ups: a close-up level is drawn from the front only",
          'Remove "view", or remove the "closeup" references from this spec',
        ),
      );
    }
    if (st.subBuild === undefined) return;
    const segs = [owner.id, ...st.subBuild.split("/")];
    const w = walkOf(c, owner, segs);
    if (w === undefined) return;
    if (!w.ok) {
      c.out.push(unresolved(c, `${sp}/subBuild`, "sub-assembly", st.subBuild, w, segs, 1));
    } else if (!w.opaque && !w.node.group) {
      c.out.push(
        mk(
          "error",
          "assembly/unknown-target",
          `${sp}/subBuild`,
          `${q(st.subBuild)} is a leaf part, not a sub-assembly`,
          "Name a part that has child parts or a template",
          { id: st.subBuild },
        ),
      );
    } else if (st.program !== undefined && !w.opaque) {
      const builds = w.node.progs.filter((p) => p.kind === "build").map((p) => p.id);
      if (!builds.includes(st.program)) {
        c.out.push(
          mk(
            "error",
            "assembly/unknown-program",
            `${sp}/program`,
            `Sub-assembly ${q(st.subBuild)} has no build program ${q(st.program)}`,
            didYouMean(st.program, builds) ??
              (builds.length > 0
                ? `Build programs: ${builds.join(", ")}`
                : "Add a build program to the sub-assembly"),
            { id: st.program },
          ),
        );
      }
    }
  });
}

// ---- racks ----------------------------------------------------------------------------------

function checkRack(c: Check, r: SpecRack, ri: number): void {
  const base = `/racks/${ri}`;
  // Assembly mode (§8.1): only a rack a step action targets is an assembly (the scene's and the
  // DC pack's rule); programs, internals and close-ups alone leave it a 1.1 rack.
  const mode = rackTargeted(c.spec, r.id);
  (r.slots ?? []).forEach((s, si) => {
    const at = `${base}/slots/${si}`;
    if (mode && s.id === "frame") {
      c.out.push(
        mk(
          "error",
          "assembly/reserved-id",
          `${at}/id`,
          'The slot id "frame" is reserved for the rack frame parts in assembly mode',
          'Rename the slot (for example "frame-1")',
          { id: s.id },
        ),
      );
    }
    if (s.assembly !== undefined) {
      const t = checkRef(c, `${at}/assembly`, s.assembly, "template", ["assembly"]);
      if (t !== undefined) checkTemplateDepth(c, `${at}/assembly`, t, 2, s.assembly);
    }
    if (s.closeup !== undefined) {
      const t = checkRef(c, `${at}/closeup`, s.closeup, "close-up", CLOSEUP_KINDS);
      if (t !== undefined) checkTemplateDepth(c, `${at}/closeup`, t, 3, s.closeup);
    }
  });
  if (r.programs !== undefined) {
    // over the rack the DC pack builds when there is one, so validation and the scene select the
    // same nodes; else the opaque validation tree
    const root = c.builtRacks.get(ri) ?? c.model.rackTree(ri);
    if (root !== undefined) checkPrograms(c, root, r.programs, `${base}/programs`);
  }
}

// ---- close-up chains (§8.4, §8.5) ------------------------------------------------------------

/**
 * `assembly/too-deep` along close-up chains: an instance is rooted at its host's path plus
 * `closeup`, so the path prefix accumulates through nested close-ups
 * (`r2/srv/closeup/board/cpu-1/closeup/…`). The per-reference checks above measure one level from
 * the reference's own assembly; this walk follows every chain from what is drawn (non-template
 * assemblies; racks: slot close-ups, and slot internals of racks in assembly mode) with the prefix
 * the scene builds, as far as levels nest (§8.4), and reports a reference once, at its own
 * `closeup` pointer (a reference the checks above already reported is not reported again).
 * Charged to the work cap; cycles stop (reported as template cycles).
 */
function checkCloseupChains(c: Check): void {
  const { model, spec } = c;
  const reported = new Set(c.out.filter((d) => d.code === "assembly/too-deep").map((d) => d.path));
  const seen = new Set<string>();
  /** Every node of `root` with a close-up, root first; `segs` = segments of the root's path. */
  const hosts = (
    root: TNode,
    path: string,
    segs: number,
    chain: readonly string[],
    level: number,
  ) => {
    const stack: { n: TNode; path: string; depth: number }[] = [{ n: root, path, depth: 0 }];
    while (stack.length > 0) {
      const { n, path: at, depth } = stack.pop() as { n: TNode; path: string; depth: number };
      if (!charge(c, 1)) return;
      if (n.closeup !== undefined) host(n, at, segs + depth + 1, chain, level);
      for (let k = n.children.length - 1; k >= 0; k--) {
        const ch = n.children[k] as TNode;
        stack.push({ n: ch, path: `${at}/${ch.id}`, depth: depth + 1 });
      }
    }
  };
  /** The close-up of `n` (instance path `at/closeup`, `segs` segments) and what nests in it. */
  const host = (n: TNode, at: string, segs: number, chain: readonly string[], level: number) => {
    const ref = n.closeup as string;
    const ti = model.byId.get(ref);
    if (ti === undefined || chain.includes(ref) || level > MAX_LEVEL_DEPTH) return;
    const depth = segs + model.metrics(ti).height;
    const ptr = `${n.ptr}/closeup`;
    if (depth > MAX_DEPTH) {
      if (!reported.has(ptr)) {
        reported.add(ptr);
        c.out.push(
          mk(
            "error",
            "assembly/too-deep",
            ptr,
            `Close-up ${q(ref)} of ${q(at)} would reach ${depth} path segments through the close-ups above it (limit ${MAX_DEPTH}); it is not built`,
            "Use a shallower host or a flatter template, or nest fewer close-ups",
            { host: at, closeup: ref, depth, limit: MAX_DEPTH },
          ),
        );
      }
      return;
    }
    const key = `${ti}\0${segs}`;
    if (seen.has(key)) return;
    seen.add(key);
    const tree = model.tree(ti);
    if (tree !== undefined) hosts(tree, `${at}/closeup`, segs, [...chain, ref], level + 1);
  };
  model.assemblies.forEach((a, i) => {
    if (a.template === true || model.byId.get(a.id) !== i) return;
    const tree = model.tree(i);
    if (tree !== undefined) hosts(tree, a.id, 1, [a.id], 1);
  });
  (spec.racks ?? []).forEach((r, ri) => {
    const targeted = rackTargeted(spec, r.id);
    if (!targeted && !(r.slots ?? []).some((sl) => sl.closeup !== undefined)) return;
    const tree = model.rackTree(ri);
    if (tree === undefined) return;
    if (targeted) hosts(tree, r.id, 1, [], 1);
    else
      for (const sl of tree.children)
        if (sl.closeup !== undefined) host(sl, `${r.id}/${sl.id}`, 3, [], 1);
  });
}

// ---- storyboards ----------------------------------------------------------------------------

function checkStoryboards(c: Check): void {
  (c.spec.storyboards ?? []).forEach((b, bi) => {
    b.frames.forEach((f, fi) => {
      const at = `/storyboards/${bi}/frames/${fi}`;
      if (!c.imageIds.has(f.model)) unknownImage(c, `${at}/model`, f.model);
      (f.parts ?? []).forEach((it, i) => {
        if (!c.imageIds.has(it.image)) unknownImage(c, `${at}/parts/${i}/image`, it.image);
      });
      (f.sub ?? []).forEach((it, i) => {
        if (!c.imageIds.has(it.image)) unknownImage(c, `${at}/sub/${i}/image`, it.image);
      });
    });
  });
}

// ---- steps: focus, set, actions ---------------------------------------------------------------

function checkSteps(c: Check): void {
  const { spec, model, kinds } = c;
  const machine = new LevelMachine();
  const levels = machine.levels;

  /** `focus` / `set` path: assembly roots and deep rack paths resolve over the expanded tree. */
  const checkPath = (path: string, at: string, what: string): void => {
    if (!isAssemblyPath(spec, path)) return;
    const segs = path.split("/");
    const root = segs[0] as string;
    const ai = model.byId.get(root);
    if (ai !== undefined && (spec.assemblies ?? [])[ai]?.template === true) {
      c.out.push(templateTarget(at, upper(what), path));
      return;
    }
    const node = model.root(root);
    if (node === undefined) return; // over budget: reported as budget/assembly-parts
    const w = walkOf(c, node, segs);
    if (w !== undefined && !w.ok) c.out.push(unresolved(c, at, what, path, w, segs));
  };

  (spec.steps ?? []).forEach((step, si) => {
    if (step.focus !== undefined) checkPath(step.focus, `/steps/${si}/focus`, "focus target");
    for (const key of Object.keys(step.set ?? {})) {
      checkPath(key, `/steps/${si}/set/${ptrKey(key)}`, "step target");
    }

    (step.assembly ?? []).forEach((a, ai) => {
      const at = `/steps/${si}/assembly/${ai}`;
      const kind = actionKind(a);
      const target = actionTarget(a);
      const segs = target.split("/");
      const root = segs[0] as string;
      const rk = kinds.get(root);
      // Figures are A2-F's, and so are nodes and the like (reported there as "not a figure").
      if (rk === "figure" || rk === "other") return;
      if (actionGated(c, kind, rk, segs)) return;

      if (rk === undefined) {
        const names = idsOfKind(c, "assembly", "rack", "storyboard", "figure");
        c.out.push(
          mk(
            "error",
            "assembly/unknown-target",
            `${at}/${kind}`,
            `Unknown ${kind} target ${q(target)}`,
            didYouMean(root, cap(names)) ??
              (names.length > 0
                ? `Targets: ${names.slice(0, 8).join(", ")}`
                : 'Declare an assembly in "assemblies" first'),
            { id: target },
          ),
        );
        return;
      }
      if (rk === "storyboard") {
        storyboardAction(c, a, kind, target, segs, at, levels);
        return;
      }
      const asm =
        rk === "assembly" ? (spec.assemblies ?? [])[model.byId.get(root) as number] : undefined;
      if (asm?.template === true) {
        c.out.push(templateTarget(`${at}/${kind}`, upper(`${kind} target`), target));
        return;
      }
      const rootNode = model.root(root);
      if (rootNode === undefined) return;
      // `<rack>/<slot>/closeup/...`: the slot's close-up instance, checked as a spec host's
      // (an assembly template; a figure close-up, or one nested below it, is the figure rules')
      const slotWalk = rk === "rack" ? slotCloseupWalk(c, rootNode, segs) : null;
      const w = slotWalk === null ? walkOf(c, rootNode, segs) : slotWalk;
      if (w === undefined) return;
      // a close-up that names a figure or storyboard (or anything below it) is the figure rules'
      if (atFigure(w)) return;
      if (!w.ok) {
        c.out.push(unresolved(c, `${at}/${kind}`, `${kind} target`, target, w, segs));
        return;
      }
      if (w.opaque && w.node.progs.length === 0) {
        // a slot without `assembly`, a part of it or of the frame: the DC pack gives it no program
        // of its own, so the scene would make the rack an assembly and then do nothing (§8.3)
        // (a path through a close-up names the close-up instance: not this case)
        if (rk === "rack" && !segs.includes("closeup", 1)) {
          c.out.push(
            mk(
              "error",
              "assembly/unknown-program",
              `${at}/${kind}`,
              `Cannot ${kind} ${q(target)}: it has no program (only a slot with "assembly" has one, "internals"; a plain slot moves with its rack's programs)`,
              `${upper(kind)} ${q(root)} (its "drawers" program slides the slots out), or give the slot internals with "assembly"`,
              { id: target },
            ),
          );
        }
        return;
      }
      assemblyAction(c, a, kind, target, w.node, asm, segs.length === 1, at, machine);
    });
  });
}

/**
 * The walk of `<rack>/<slot>/closeup/...` inside the slot's close-up instance. `null`: not a
 * close-up path (the ordinary walk applies); `undefined`: nothing to check here (the slot's
 * close-up is a figure, the path enters a figure's, or the work cap is spent). An unknown slot,
 * a slot without `closeup` and a typo of the reserved segment fail like a spec host's.
 */
function slotCloseupWalk(c: Check, rack: TNode, segs: readonly string[]): Walk | undefined | null {
  if (segs.length < 3) return null;
  const slot = walkOf(c, rack, segs.slice(0, 2));
  if (slot === undefined) return undefined;
  const isCloseup = segs[2] === "closeup";
  if (!slot.ok) return isCloseup ? slot : null;
  const typo =
    !isCloseup &&
    slot.node.closeup !== undefined &&
    near(c, segs[2] as string, ["closeup"]) !== undefined;
  if (!isCloseup && !typo) return null;
  if (typo) return { ok: false, at: 2, parent: slot.node, reason: "missing" };
  if (slot.node.closeup === undefined) {
    return { ok: false, at: 2, parent: slot.node, reason: "no-closeup" };
  }
  if (c.kinds.get(slot.node.closeup) !== "assembly") return undefined;
  const instance = c.model.closeupNode(slot.node.closeup);
  if (instance === undefined || !charge(c, 16 * segs.length)) return undefined;
  const w = c.model.walk(instance, ["closeup", ...segs.slice(3)]);
  // the walk's segments start at the instance: `at` is relative to `segs[2]`
  return w.ok ? w : { ...w, at: w.at + 2 };
}

/** Does the walk end at, or fail directly below, a figure or storyboard close-up? */
const atFigure = (w: Walk): boolean => {
  const leaf = w.ok ? w.node : w.parent;
  return leaf.kind === "figure" || leaf.kind === "board";
};

const templateTarget = (path: string, what: string, id: string): Diagnostic =>
  mk(
    "error",
    "assembly/unknown-target",
    path,
    `${what} ${q(id)} is a template, which is not drawn by itself`,
    "Name a place that uses it (a part's use, a slot's assembly or a closeup)",
    { id },
  );

/** The guard's per-target gating (unsupported.ts), mirrored: a gated target is the guard's. */
function actionGated(
  c: Check,
  kind: ActionKind,
  rk: RootKind | undefined,
  segs: readonly string[],
): boolean {
  const { groups } = c;
  const closeupSeg = segs.indexOf("closeup", 1) >= 1;
  const phase = rk === undefined || rk === "other" ? undefined : ROOT_PHASE[rk];
  const pathGate =
    (groups.phase2 && closeupSeg) || (phase === undefined ? groups.phase1a : groups[phase]);
  if (kind === "build" || kind === "unbuild") {
    return rk === "storyboard" ? groups.storyboards : groups.phase2 || pathGate;
  }
  return pathGate;
}

/** Reports a failed level check (range, direction) as the diagnostics of §18. */
function levelFail(
  c: Check,
  fail: LevelFail,
  kind: ActionKind,
  target: string,
  at: string,
  unit: "stage" | "step" | "frame",
): void {
  if (fail.type === "range") {
    const toPath =
      fail.via === "to" ? `${at}/to` : fail.via === "advance" ? `${at}/advance` : `${at}/${kind}`;
    c.out.push(
      mk(
        "error",
        "assembly/stage-out-of-range",
        toPath,
        `${q(target)} has ${fail.count} ${unit}${fail.count === 1 ? "" : "s"}; ${
          fail.via === "default" && kind === "build"
            ? `building from ${fail.cur} reaches ${fail.to}`
            : `"to": ${fail.to}`
        } is out of range`,
        `Use a value from 0 to ${fail.count}`,
        { to: fail.to, count: fail.count, unit },
      ),
    );
  } else if (fail.type === "direction") {
    const toPath =
      fail.via === "to" ? `${at}/to` : fail.via === "advance" ? `${at}/advance` : `${at}/${kind}`;
    const fix = { explode: "implode", implode: "explode", build: "unbuild", unbuild: "build" }[
      kind
    ];
    const dir = kind === "explode" || kind === "build" ? "backwards" : "forwards";
    c.out.push(
      mk(
        "error",
        fail.code,
        toPath,
        `${q(target)} is at ${unit} ${fail.cur}; ${kind} to ${fail.to} would go ${dir}`,
        `Use "${fix}" to reach ${unit} ${fail.to}`,
        { from: fail.cur, to: fail.to },
      ),
    );
  }
}

/**
 * Level arithmetic of a storyboard action (frames; the shared machine handles programs).
 * Undefined when the action is invalid (reported) and must not move the level.
 */
function advance(
  c: Check,
  a: SpecAssemblyAction,
  kind: ActionKind,
  target: string,
  n: number,
  cur: number,
  at: string,
  unit: "stage" | "step" | "frame",
): number | undefined {
  const r = checkLevel(kind, a as unknown as LevelAction, n, cur);
  if (r.fail !== undefined) {
    levelFail(c, r.fail, kind, target, at, unit);
    return undefined;
  }
  if (r.to === cur) {
    c.out.push(
      mk(
        "info",
        "assembly/no-op-action",
        at,
        `${kind} of ${q(target)} does not change its ${unit} (already at ${cur})`,
        undefined,
        { level: cur },
      ),
    );
  }
  return r.to;
}

function assemblyAction(
  c: Check,
  a: SpecAssemblyAction,
  kind: ActionKind,
  target: string,
  node: TNode,
  asm: SpecAssembly | undefined,
  isRoot: boolean,
  at: string,
  machine: LevelMachine,
): void {
  const want = kind === "explode" || kind === "implode" ? "explode" : "build";
  const r = machine.apply(a as unknown as LevelAction, kind, target, node, asm?.pose, isRoot);
  if (!r.ok) {
    const f = r.fail;
    if (f.type === "program") {
      const named = f.named as string;
      if (f.why === "named") {
        c.out.push(
          mk(
            "error",
            "assembly/unknown-program",
            `${at}/program`,
            f.found === undefined
              ? `${q(target)} has no program ${q(named)}`
              : `Program ${q(named)} of ${q(target)} is ${article(f.found.kind)} ${f.found.kind} program, but ${kind} needs ${article(want)} ${want} program`,
            didYouMean(
              named,
              f.ofKind.map((p) => p.id),
            ) ??
              (f.ofKind.length > 0
                ? `${upper(want)} programs: ${f.ofKind.map((p) => p.id).join(", ")}`
                : `${q(target)} has no ${want} programs`),
            { id: named },
          ),
        );
      } else {
        c.out.push(
          mk(
            "error",
            "assembly/unknown-program",
            `${at}/${kind}`,
            `Cannot ${kind} ${q(target)}: it has no ${want} program`,
            node.kind === "rack"
              ? "Racks have explode programs only"
              : `Add ${article(want)} ${want} program to "programs"`,
            { id: target },
          ),
        );
      }
    } else if (f.type === "start") {
      c.out.push(
        mk(
          "error",
          "assembly/stage-out-of-range",
          `${at}/advance`,
          `${q(target)}: "advance": ${f.advance} is more than "to": ${f.to}, so the timeline would start below step 0`,
          `Use "advance" of at most ${f.to}`,
          { to: f.to, advance: f.advance },
        ),
      );
    } else {
      levelFail(c, f, kind, target, at, want === "explode" ? "stage" : "step");
    }
    return;
  }
  if (r.noop) {
    const unit = want === "explode" ? "stage" : "step";
    c.out.push(
      mk(
        "info",
        "assembly/no-op-action",
        at,
        `${kind} of ${q(target)} does not change its ${unit} (already at ${r.from})`,
        undefined,
        { level: r.from },
      ),
    );
  }
}

function storyboardAction(
  c: Check,
  a: SpecAssemblyAction,
  kind: ActionKind,
  target: string,
  segs: readonly string[],
  at: string,
  levels: Map<string, number>,
): void {
  const root = segs[0] as string;
  if (kind === "explode" || kind === "implode") {
    c.out.push(
      mk(
        "error",
        "assembly/storyboard-no-explode",
        `${at}/${kind}`,
        `Storyboard ${q(root)} cannot ${kind}: storyboards replay frames`,
        `Use "${kind === "explode" ? "build" : "unbuild"}" instead`,
        { id: target },
      ),
    );
    return;
  }
  if (segs.length > 1) {
    c.out.push(
      mk(
        "error",
        "assembly/unknown-target",
        `${at}/${kind}`,
        `Storyboard ${q(root)} plays as a whole; ${q(target)} is not a target`,
        `Use "${root}"`,
        { id: target },
      ),
    );
    return;
  }
  const named = (a as { program?: string }).program;
  if (named !== undefined) {
    c.out.push(
      mk(
        "error",
        "assembly/unknown-program",
        `${at}/program`,
        `Storyboard ${q(root)} has no programs (program ${q(named)}); its frames are its only program`,
        'Remove "program"',
        { id: named },
      ),
    );
    return;
  }
  const board = (c.spec.storyboards ?? []).find((b) => b.id === root);
  if (board === undefined) return;
  const n = board.frames.length;
  const key = `${target}\u0000frames`;
  const to = advance(
    c,
    a,
    kind,
    target,
    n,
    levels.get(key) ?? (kind === "build" ? 0 : n),
    at,
    "frame",
  );
  if (to !== undefined) levels.set(key, to);
}

export { LevelMachine, checkLevel, targetLevel } from "./assembly-levels.js";
export type { LevelAction, LevelFail, LevelKind, Applied, AccessStep } from "./assembly-levels.js";
