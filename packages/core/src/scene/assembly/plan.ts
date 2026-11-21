/**
 * Explode programs and the step plan (Track A2, A2-3; design docs/design/assemblies.md §6, §7,
 * §8.3, §10).
 *
 * `AssemblyPrograms` resolves, for every assembly of a spec:
 *   - its explode programs (`ResolvedExplodeProgram`): selectors scoped to the program owner
 *     (`selectors.ts`), directions (`directions.ts`), program-level stacking (`distances.ts`)
 *     and stage timing (`timing.ts`), all in the owner's local frame, moves in world space;
 *   - the level machine of the step actions (explode, implode; levels are cumulative across
 *     steps; implicit access for nested targets), mirroring `assembly-semantic.ts` rules so
 *     validation and scene agree: default program = `assemblies[].program` if it is of the
 *     action's kind, else the first of that kind; `to` defaults to the last stage (explode) or
 *     0 (implode); an implode reverses the program that exploded the target; `pose: exploded`
 *     starts the root's default program at its last stage;
 *   - the reach bounds the layout needs: rest box + the Minkowski sum of the offset intervals
 *     of every program the actions play (§9.3, §10).
 * The actions then flow through `planFigureSteps` (`foreign`): ONE cursor, motion window and
 * compression computation for figures and assemblies.
 *
 * Build programs (A2-6, `build.ts`) resolve beside the explode programs and play through the
 * same machine and step loop; racks are Phase 2 (E-1).
 *
 * Qualified program names: a `ProgramLevel.program` of a program owned by a sub-assembly is
 * `<owner path relative to the assembly>/<program id>` (`head/service`); a root program is its
 * plain id. `ResolvedAction.program` stays the plain id (the action's `target` is the owner).
 *
 * Bounded and total: every scan is charged to one `Work` budget first, a spent budget skips the
 * work and reports `budget/time`; nothing throws on bad input.
 */
import type {
  AssemblyStepPlan,
  Box3,
  Diagnostic,
  PartMove,
  ProgramLevel,
  ResolvedExplodeProgram,
  ResolvedProgram,
  ResolvedStage,
  SceneAssemblies,
  SceneAssembly,
  PartShapePack,
  PartShapeRegistry,
  LoopStart,
  QuarterTurn,
  ResolvedBuildProgram,
  SceneAssemblyNode,
} from "../../contracts/index.js";
import { LevelMachine, type AccessStep } from "../../schema/assembly-levels.js";
import {
  AssemblyModel,
  parseSelector,
  type ProgInfo,
  type TNode,
} from "../../schema/assembly-tree.js";
import type {
  PlatformCosmoSpec,
  SpecAssembly,
  SpecAssemblyAction,
  SpecBuildProgram,
  SpecExplodeProgram,
  SpecStage,
} from "../../schema/types.gen.js";
import { createProjection, projectBoxBounds } from "../../geometry/index.js";
import {
  planFigureSteps,
  resolveFigure,
  stepViews,
  type ForeignAction,
  type PlanOptions,
  type ResolvedFigure,
} from "../boards.js";
import {
  resolveDirection,
  toLBox,
  toWorld,
  type Dir,
  type DirectionContext,
} from "./directions.js";
import { parseDistance, programDistances, type LeafBox, type Mover } from "./distances.js";
import { frameMap, rnd, unionBoxes } from "./frame.js";
import {
  baseBuildLevel,
  buildSegment,
  loopStartOf,
  resolveBuild,
  viewAt,
  viewSwitches,
} from "./build.js";
import { buildAssemblies } from "./tree.js";
import {
  OwnerSelectors,
  indexOwner,
  makeWork,
  spend,
  type Item,
  type OwnerIndex,
  type Work,
} from "./selectors.js";
import {
  endsAwayFromBase,
  programSegment,
  r4,
  rankMovers,
  stageStart,
  transitionOf,
  type OrderKeys,
} from "./timing.js";

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

/** Node visits the reach sweep may spend (separate from program resolution). */
const SWEEP_CAP = 20_000_000;

/** Reach growth above this multiple of the rest area is reported (§10). */
const GROWTH = 4;

const KEYS = ["explode", "implode", "build", "unbuild"] as const;
const actionKey = (a: SpecAssemblyAction): (typeof KEYS)[number] =>
  KEYS.find((k) => k in a) as (typeof KEYS)[number];
const usesRole = (sels: readonly unknown[]): boolean =>
  sels.some((x) => typeof x === "string" && parseSelector(x).kind === "role");
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `ProgramLevel.program` of a program owned by `ownerRel` (empty: the assembly root). */
export const qualifiedProgram = (ownerRel: string, id: string): string =>
  ownerRel === "" ? id : `${ownerRel}/${id}`;

function atPointer(root: unknown, ptr: string): unknown {
  let cur = root;
  for (const raw of ptr.split("/").slice(1)) {
    if (cur === null || typeof cur !== "object") return undefined;
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------
// Resolution of one assembly
// ---------------------------------------------------------------------------------------------

interface OwnerInfo {
  /** Path relative to the assembly root; empty for the root. */
  readonly rel: string;
  readonly node: SceneAssemblyNode;
  readonly tnode: TNode;
  /** Explode programs of the owner, spec order. */
  readonly explodes: readonly ProgInfo[];
  /** Default explode program (A2-1 rule). */
  readonly dflt: ProgInfo | undefined;
  /** Build programs of the owner, spec order. */
  readonly builds: readonly ProgInfo[];
}

interface ResolvedProgramInfo {
  readonly program: ResolvedExplodeProgram;
  /** Per stage: relative paths the stage selects (before pruning), for implicit access. */
  readonly selected: readonly ReadonlySet<string>[];
}

interface Resolved {
  readonly asm: SceneAssembly;
  readonly spec: SpecAssembly;
  readonly owners: ReadonlyMap<string, OwnerInfo>;
  /** By `<ownerRel>\0<program id>`. */
  readonly programs: ReadonlyMap<string, ResolvedProgramInfo>;
  /** Resolved build programs, by `<ownerRel>\0<program id>`. */
  readonly builds: ReadonlyMap<string, ResolvedBuildProgram>;
  readonly nodes: ReadonlyMap<string, SceneAssemblyNode>;
  /** Programs that could not be resolved (budget or malformed): `<ownerRel>\0<id>`. */
  readonly unresolved: ReadonlySet<string>;
}

/** One assembly's simulated action sequence. */
interface Simulated {
  /** `step:action` -> action. */
  readonly actions: ReadonlyMap<string, ForeignAction>;
  /** Pose after each step (index = step), full list per assembly. */
  readonly poses: readonly (readonly ProgramLevel[])[];
  /** View a step's build/unbuild actions leave in effect (`at` = action index), by step. */
  readonly views: ReadonlyMap<number, { readonly at: number; readonly view: QuarterTurn }>;
  readonly base: readonly ProgramLevel[];
  /** Programs some action (or the base pose) plays: `<ownerRel>\0<id>`. */
  readonly used: ReadonlySet<string>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface AssemblyProgramsOptions {
  readonly work?: Work;
  /** Budget of the reach sweep (default `SWEEP_CAP`). */
  readonly sweepWork?: Work;
  /**
   * Program bodies the spec does not carry, by (assembly id, owner path below it, program id):
   * the DC pack's built-in rack program `drawers` and the slot `internals` program, which
   * `schema/assembly-tree.ts` counts but no spec pointer holds (assemblies.md 8.1, 8.2).
   */
  readonly synthetic?: (
    assembly: string,
    owner: string,
    id: string,
  ) => SpecExplodeProgram | undefined;
}

export class AssemblyPrograms {
  readonly diagnostics: Diagnostic[] = [];
  private readonly model: AssemblyModel;
  private readonly work: Work;
  /** Reach has its own budget, so a big program cannot starve it (and vice versa). */
  private readonly sweepWork: Work;
  private readonly resolved = new Map<string, Resolved | null>();
  private readonly simulated = new Map<string, Simulated>();
  private readonly reaches = new Map<string, Box3 | undefined>();
  private readonly leafMemo = new WeakMap<SceneAssemblyNode, SceneAssemblyNode[]>();
  private warned = false;
  /** Close-up instances (A2-5): instance path -> id of the template it instances. */
  private readonly templates = new Map<string, string>();
  private readonly synthetic: AssemblyProgramsOptions["synthetic"];

  constructor(
    readonly spec: PlatformCosmoSpec,
    opts: AssemblyProgramsOptions = {},
  ) {
    this.model = new AssemblyModel(spec);
    this.synthetic = opts.synthetic;
    this.work = opts.work ?? makeWork();
    this.sweepWork = opts.sweepWork ?? makeWork(SWEEP_CAP);
  }

  /**
   * Declares `path` (a close-up instance, `<host>/closeup`, built from the assembly `templateId`)
   * so its programs resolve and actions on `path/…` plan against it like those of a top-level
   * assembly. Call before `reach`, `attach` or `plan` see the instance.
   */
  registerInstance(path: string, templateId: string): void {
    this.templates.set(path, templateId);
  }

  /** Index of the spec assembly an assembly (or close-up instance) is built from. */
  private specIndex(id: string): number | undefined {
    return this.model.byId.get(this.templates.get(id) ?? id);
  }

  private budgetWarning(): void {
    if (this.warned) return;
    this.warned = true;
    this.diagnostics.push(
      mk(
        "warning",
        "budget/time",
        "/assemblies",
        "Program resolution reached its work limit; some programs were skipped or use plain clearances without stacking",
        "Use fewer or broader selectors, or fewer parts",
      ),
    );
  }

  // ---- owners and programs ----------------------------------------------------------------

  private resolve(asm: SceneAssembly): Resolved | undefined {
    const memo = this.resolved.get(asm.id);
    if (memo !== undefined) return memo ?? undefined;
    const i = this.specIndex(asm.id);
    // a rack in assembly mode (`source: "dc"`): the rack tree, no spec assembly behind it
    const ri =
      asm.source === "dc" ? (this.spec.racks ?? []).findIndex((r) => r?.id === asm.id) : -1;
    const specAsm =
      ri >= 0
        ? ({ id: asm.id, parts: [] } as unknown as SpecAssembly)
        : i === undefined
          ? undefined
          : (this.spec.assemblies ?? [])[i];
    let tree: TNode | undefined;
    try {
      tree = ri >= 0 ? this.model.rackTree(ri) : i === undefined ? undefined : this.model.tree(i);
    } catch {
      tree = undefined; // a schema-invalid spec: validation reports it, the scene skips it
    }
    if (specAsm === undefined || tree === undefined) {
      this.resolved.set(asm.id, null);
      return undefined;
    }
    const nodes = new Map<string, SceneAssemblyNode>();
    const owners = new Map<string, OwnerInfo>();
    const collect = (n: SceneAssemblyNode, t: TNode, rel: string): void => {
      nodes.set(n.path, n);
      if (n.kind === "sub" || rel === "") {
        const explodes = t.progs.filter((p) => p.kind === "explode");
        if (t.progs.length > 0) {
          const dflt = explodes.find((p) => p.id === t.defaultProg) ?? explodes[0];
          const builds = t.progs.filter((p) => p.kind === "build");
          owners.set(rel, { rel, node: n, tnode: t, explodes, dflt, builds });
        }
      }
      let byId: Map<string, TNode> | undefined;
      for (const c of n.children) {
        if (c.kind === "leaf") {
          nodes.set(c.path, c);
          continue;
        }
        byId ??= new Map(t.children.map((x) => [x.id, x]));
        const tc = byId.get(c.id);
        if (tc === undefined) {
          // unmatched (cannot happen: A2-1 and A2-2 expand identically): list nodes only
          for (const d of flatten(c)) nodes.set(d.path, d);
          continue;
        }
        collect(c, tc, rel === "" ? c.id : `${rel}/${c.id}`);
      }
    };
    collect(asm.root, tree, "");

    const programs = new Map<string, ResolvedProgramInfo>();
    const builds = new Map<string, ResolvedBuildProgram>();
    const unresolved = new Set<string>();
    const indexes = new Map<string, { index: OwnerIndex; sel: OwnerSelectors }>();
    const tried = new Set<string>();
    /**
     * Resolves one build program (once). A step's `subBuild` asks for the build program of a
     * sub-assembly, which may belong to an owner that sorts later, so programs resolve on demand
     * (`subOf`); the nesting is strict (a sub-assembly is below its owner), so this ends.
     */
    const buildOne = (rel: string, info: ProgInfo): void => {
      const pk = `${rel}\0${info.id}`;
      if (tried.has(pk)) return;
      tried.add(pk);
      const owner = owners.get(rel) as OwnerInfo;
      const spec = atPointer(this.spec, info.ptr) as SpecBuildProgram | undefined;
      if (spec === undefined || !Array.isArray(spec.steps)) {
        unresolved.add(pk);
        return;
      }
      let ix = indexes.get(rel);
      if (ix === undefined) {
        const index = indexOwner(owner.node, this.work);
        ix = { index, sel: new OwnerSelectors(index, this.work) };
        indexes.set(rel, ix);
      }
      if (!ix.index.complete) {
        this.budgetWarning();
        unresolved.add(pk);
        return;
      }
      const r = resolveBuild({
        asm,
        owner: owner.node,
        tnode: owner.tnode,
        prog: spec,
        ptr: info.ptr,
        index: ix.index,
        sel: ix.sel,
        work: this.work,
        subBuild: subOf,
      });
      if (r === undefined) {
        this.budgetWarning();
        unresolved.add(pk);
        return;
      }
      if (r.capped) this.budgetWarning();
      this.diagnostics.push(...r.diagnostics);
      builds.set(pk, r.program);
    };
    const subOf = (path: string, program: string | undefined): ResolvedBuildProgram | undefined => {
      const rel =
        path === asm.id
          ? ""
          : path.startsWith(`${asm.id}/`)
            ? path.slice(asm.id.length + 1)
            : undefined;
      const o = rel === undefined ? undefined : owners.get(rel);
      if (rel === undefined || o === undefined) return undefined;
      const info = program === undefined ? o.builds[0] : o.builds.find((b) => b.id === program);
      if (info === undefined) return undefined;
      buildOne(rel, info);
      return builds.get(`${rel}\0${info.id}`);
    };
    for (const rel of [...owners.keys()].sort(cmp)) {
      const owner = owners.get(rel) as OwnerInfo;
      for (const info of owner.explodes) {
        const pk = `${rel}\0${info.id}`;
        const spec = (this.synthetic?.(asm.id, rel, info.id) ?? atPointer(this.spec, info.ptr)) as
          SpecExplodeProgram | undefined;
        if (spec === undefined || !Array.isArray(spec.stages)) {
          unresolved.add(pk);
          continue;
        }
        let ix = indexes.get(rel);
        if (ix === undefined) {
          const index = indexOwner(owner.node, this.work);
          ix = { index, sel: new OwnerSelectors(index, this.work) };
          indexes.set(rel, ix);
        }
        if (!ix.index.complete) {
          this.budgetWarning();
          unresolved.add(pk);
          continue;
        }
        const r = this.resolveExplode(asm, owner, spec, info.ptr, ix.index, ix.sel);
        if (r === undefined) {
          this.budgetWarning();
          unresolved.add(pk);
        } else programs.set(pk, r);
      }
      for (const info of owner.builds) buildOne(rel, info);
    }
    const out: Resolved = { asm, spec: specAsm, owners, programs, builds, nodes, unresolved };
    this.resolved.set(asm.id, out);
    return out;
  }

  private resolveExplode(
    asm: SceneAssembly,
    owner: OwnerInfo,
    prog: SpecExplodeProgram,
    ptr: string,
    index: OwnerIndex,
    sel: OwnerSelectors,
  ): ResolvedProgramInfo | undefined {
    const work = this.work;
    const ownerBox = toLBox(owner.node.local);
    const size = Math.max(
      ownerBox.x1 - ownerBox.x0,
      ownerBox.y1 - ownerBox.y0,
      ownerBox.z1 - ownerBox.z0,
    );
    const gap =
      typeof prog.gap === "number" && Number.isFinite(prog.gap) && prog.gap >= 0
        ? prog.gap
        : 0.1 * size;
    const degraded = { count: 0 };
    const dctx: DirectionContext = {
      frame: asm.frame,
      owner: owner.node,
      cache: new Map(),
      degraded,
      dc: asm.source === "dc",
    };

    interface Staged {
      readonly spec: SpecStage;
      readonly movers: readonly Mover[];
      readonly selected: Set<string>;
    }
    const moved = new Set<Item>();
    const byRole = new Set<Item>(); // claimed by a stage that selects through a role
    const staged: Staged[] = [];
    const all: Mover[] = [];
    const stages = prog.stages.slice(0, 32);
    for (const raw of stages) {
      // a schema-invalid stage (not an object) is an empty stage: validation reports it
      const st: SpecStage =
        raw !== null && typeof raw === "object" ? raw : ({ parts: [] } as unknown as SpecStage);
      const parts: readonly unknown[] = Array.isArray(st.parts) ? st.parts : [];
      const except: readonly unknown[] = Array.isArray(st.except) ? st.except : [];
      const sels = [...parts, ...except];
      const r = sel.stage(parts as string[], except as string[]);
      if (r === undefined) return undefined;
      const fresh = r.movers.filter((it) => !moved.has(it));
      const again = r.selected.filter((it) => moved.has(it));
      if (again.length > 0 && (usesRole(sels) || again.some((it) => byRole.has(it)))) {
        // The validator sees explicit roles only; the scene also matches inferred and shape
        // roles, so a part can be selected twice here without validation having said so.
        this.diagnostics.push(
          mk(
            "info",
            "assembly/moved-twice",
            `${ptr}/stages/${staged.length}/parts`,
            `Stage ${staged.length + 1} selects ${JSON.stringify(again[0]?.rel)}, which an earlier stage already moves (through an inferred or shape role); it moves once`,
            "Narrow the selector, or set the part's role explicitly",
            { path: again[0]?.rel, stage: staged.length + 1 },
          ),
        );
      }
      for (const it of r.selected) moved.add(it);
      if (usesRole(sels)) for (const it of r.selected) byRole.add(it);
      const movers: Mover[] = [];
      for (const it of fresh) {
        const ov =
          st.overrides !== undefined && Object.hasOwn(st.overrides, it.rel)
            ? st.overrides[it.rel]
            : undefined;
        const dir = ov?.direction ?? st.direction;
        const parent = it.parent?.node ?? owner.node;
        if (!spend(work, parent.children.length + 1)) return undefined;
        const u: Dir = resolveDirection(dir, it, dctx, ownerBox);
        const d = parseDistance(ov?.distance ?? st.distance);
        movers.push({
          rel: it.rel,
          item: it,
          box: toLBox(it.node.local),
          u,
          lift: dir === "lift",
          drawer: dir === "drawer",
          k: d.k,
          ...(d.fixed === undefined ? {} : { fixed: d.fixed }),
        });
      }
      all.push(...movers);
      staged.push({ spec: st, movers, selected: new Set(r.selected.map((it) => it.rel)) });
    }

    if (degraded.count > 0) {
      this.diagnostics.push(
        mk(
          "warning",
          "budget/time",
          ptr,
          `${degraded.count} part${degraded.count === 1 ? "" : "s"} of ${JSON.stringify(owner.node.path)} sit among more than 400 siblings: the sibling-contact scan was skipped for them (their mate and inserts still apply), so "away" falls back to "out"`,
          "Group the parts into sub-assemblies, or set explicit directions",
          { count: degraded.count },
        ),
      );
    }

    // static leaves, with the movers above each (itself and ancestors)
    const moverItems = new Set(all.map((m) => m.item));
    if (!spend(work, index.items.length * 8 + 1)) return undefined;
    const leaves: LeafBox[] = [];
    for (const it of index.items) {
      if (it.node.kind !== "leaf") continue;
      const chain: string[] = [];
      for (let p: Item | undefined = it; p !== undefined; p = p.parent) {
        if (moverItems.has(p)) chain.push(p.rel);
      }
      leaves.push({ item: it, box: toLBox(it.node.local), chain });
    }
    const dist = programDistances({ movers: all, leaves, gap, owner: ownerBox }, work);
    if (dist.capped) this.budgetWarning();

    // timing (§6.4, §7.1)
    const oc = worldCentre(owner.node.world);
    const resolvedStages: ResolvedStage[] = [];
    let prev: { start: number; end: number } | undefined;
    staged.forEach((s, si) => {
      const st = s.spec;
      const start = stageStart(prev, st);
      const stagger = st.stagger ?? 0.08;
      const duration = typeof st.duration === "number" && st.duration > 0 ? st.duration : 0.8;
      const easing = st.easing ?? "ease-in-out";
      const keys = (m: Mover): OrderKeys => {
        const w = m.item.node.world;
        const c = worldCentre(w);
        return {
          spec: m.item.index,
          radius: Math.hypot(c[0] - oc[0], c[1] - oc[1], c[2] - oc[2]),
          minZ: w.origin.z,
          maxZ: w.origin.z + w.size.z,
          depth: c[0] + c[1] + c[2],
          path: m.rel,
        };
      };
      const ovr = (m: Mover): number | undefined => {
        const o =
          st.overrides !== undefined && Object.hasOwn(st.overrides, m.rel)
            ? st.overrides[m.rel]
            : undefined;
        return typeof o?.order === "number" ? o.order : undefined;
      };
      const ranked = rankMovers(s.movers, keys, st.order ?? "spec", ovr);
      const moves: PartMove[] = ranked.map((m, r) => {
        const o =
          st.overrides !== undefined && Object.hasOwn(st.overrides, m.rel)
            ? st.overrides[m.rel]
            : undefined;
        const d = dist.distance.get(m.rel) ?? 0;
        const delay = typeof o?.delay === "number" && o.delay > 0 ? o.delay : 0;
        return {
          path: m.item.node.path,
          offset: toWorld(asm.frame, [m.u[0] * d, m.u[1] * d, m.u[2] * d]),
          start: r4(start + r * stagger + delay),
          duration: r4(duration),
          easing,
        };
      });
      moves.sort((a, b) => a.start - b.start || cmp(a.path, b.path));
      const end =
        moves.length === 0 ? start : r4(Math.max(...moves.map((m) => m.start + m.duration)));
      resolvedStages.push({
        index: si + 1,
        ...(st.label === undefined ? {} : { label: st.label }),
        moves,
        start,
        end,
        labels: st.labels ?? "show",
        leaders: st.leaders ?? true,
        details: st.details ?? false,
        fade: st.fade ?? "none",
      });
      prev = { start, end };
    });
    return {
      program: {
        kind: "explode",
        id: prog.id,
        owner: owner.node.path,
        ...(prog.label === undefined ? {} : { label: prog.label }),
        stages: resolvedStages,
      },
      selected: staged.map((s) => s.selected),
    };
  }

  // ---- the level machine ------------------------------------------------------------------

  /**
   * Actions, poses and used programs of one assembly (levels are per assembly). The levels come
   * from the machine shared with validation (`schema/assembly-levels.ts`); this adds the
   * program lengths, implicit access and the poses.
   */
  private simulate(asm: SceneAssembly): Simulated | undefined {
    const memo = this.simulated.get(asm.id);
    if (memo !== undefined) return memo;
    const res = this.resolve(asm);
    if (res === undefined) return undefined;
    const machine = new LevelMachine();
    const used = new Set<string>();
    const targetOf = (rel: string): string => (rel === "" ? asm.id : `${asm.id}/${rel}`);
    const levelKey = (rel: string, id: string): string => `${targetOf(rel)}\u0000${id}`;
    // `rest`: the base level of a build program (finished, or 0 for `pose: empty`)
    const allProgs: { key: string; q: string; rest?: number }[] = [];
    for (const rel of [...res.owners.keys()].sort(cmp)) {
      const o = res.owners.get(rel) as OwnerInfo;
      for (const p of o.explodes) {
        allProgs.push({ key: levelKey(rel, p.id), q: qualifiedProgram(rel, p.id) });
      }
      for (const p of o.builds) {
        allProgs.push({
          key: levelKey(rel, p.id),
          q: qualifiedProgram(rel, p.id),
          rest: baseBuildLevel(p.count, res.spec.pose),
        });
      }
    }
    allProgs.sort((a, b) => cmp(a.q, b.q));
    // base pose: `pose: exploded` shows the root's default explode program fully exploded
    const root = res.owners.get("");
    if (res.spec.pose === "exploded" && root?.dflt !== undefined) {
      machine.levels.set(levelKey("", root.dflt.id), root.dflt.count);
      used.add(`\u0000${root.dflt.id}`);
    }
    // A build program's timeline starts at `k - advance` of its first action (§7.2): until
    // then its level is that start, known only once the action is applied, so earlier
    // snapshots are patched afterwards. A program no action plays stays at its rest level.
    const startLevel = new Map<string, number>();
    const unstarted: { entry: { level: number }; key: string; rest: number }[] = [];
    const snapshot = (forBase = false): ProgramLevel[] =>
      allProgs.map((p) => {
        const only = machine.opened.get(p.key);
        const entry = {
          program: p.q,
          level: machine.levels.get(p.key) ?? p.rest ?? 0,
          ...(only === undefined || only.size === 0 ? {} : { only: [...only].sort() }),
        };
        if (!forBase && p.rest !== undefined && !machine.levels.has(p.key)) {
          unstarted.push({ entry, key: p.key, rest: p.rest });
        }
        return entry;
      });
    const base = snapshot(true);
    const views = new Map<number, { at: number; view: QuarterTurn }>();

    const diagnostics: Diagnostic[] = [];
    const actions = new Map<string, ForeignAction>();
    const poses: (readonly ProgramLevel[])[] = [];

    const segLen = (
      rel: string,
      id: string,
      from: number,
      to: number,
      exclude?: ReadonlySet<string>,
    ): number => {
      const b = res.builds.get(`${rel}\u0000${id}`);
      if (b !== undefined) return buildSegment(b, from, to).length;
      const r = res.programs.get(`${rel}\u0000${id}`);
      return r === undefined ? 0 : programSegment(r.program, from, to, exclude).length;
    };
    /** Duration of the one move of `path` in stage `stage` (the access move). */
    const moveLen = (rel: string, id: string, stage: number, path: string): number => {
      const st = res.programs.get(`${rel}\u0000${id}`)?.program.stages[stage - 1];
      return st?.moves.find((m) => m.path === path)?.duration ?? 0;
    };
    /** The access moves of a target through each ancestor's default program (§8.3). */
    const accessSteps = (segs: readonly string[]): AccessStep[] => {
      const out: AccessStep[] = [];
      for (let j = 1; j < segs.length; j++) {
        const orel = segs.slice(1, j).join("/");
        const o = res.owners.get(orel);
        if (o?.dflt === undefined) continue;
        const info = res.programs.get(`${orel}\u0000${o.dflt.id}`);
        if (info === undefined) continue;
        const below = segs.slice(j);
        const chain = below.map((_, m) => below.slice(0, m + 1).join("/"));
        for (let si = 0; si < info.selected.length; si++) {
          const hit = chain.find((c) => (info.selected[si] as ReadonlySet<string>).has(c));
          if (hit === undefined) continue;
          out.push({
            key: levelKey(orel, o.dflt.id),
            program: qualifiedProgram(orel, o.dflt.id),
            owner: orel,
            id: o.dflt.id,
            stage: si + 1,
            path: `${targetOf(orel)}/${hit}`,
          });
          break;
        }
      }
      return out;
    };

    (this.spec.steps ?? []).forEach((step, si) => {
      (step.assembly ?? []).forEach((a, ai) => {
        const kind = actionKey(a);
        const target = (a as unknown as Record<string, string>)[kind] as string;
        if (typeof target !== "string") return;
        // an instance is rooted at a multi-segment path (`r2/srv/closeup`): the target is
        // `<asm.id>` or `<asm.id>/<rel>`, and segs[0] stands for the whole root path
        if (target !== asm.id && !target.startsWith(`${asm.id}/`)) return;
        // the longest registered instance prefix owns the target (a deeper close-up's action)
        for (const k of this.templates.keys()) {
          if (k.length > asm.id.length && k.startsWith(`${asm.id}/`)) {
            if (target === k || target.startsWith(`${k}/`)) return;
          }
        }
        const segs = [
          asm.id,
          ...(target === asm.id ? [] : target.slice(asm.id.length + 1).split("/")),
        ];
        const rel = segs.slice(1).join("/");
        const owner = res.owners.get(rel);
        if (!res.nodes.has(target) || owner === undefined) return;
        const at = `/steps/${si}/assembly/${ai}/${kind}`;
        const node = {
          progs: owner.tnode.progs,
          ...(owner.tnode.defaultProg === undefined
            ? {}
            : { defaultProg: owner.tnode.defaultProg }),
        };
        // moves an earlier implicit access already opened are not played again (an explicit
        // action on the parent program takes the opening over)
        const openedBefore = new Map([...machine.opened].map(([k, v]) => [k, new Set(v)]));
        const r = machine.apply(
          a as { to?: number; program?: string },
          kind,
          target,
          node,
          res.spec.pose,
          rel === "",
        );
        if (!r.ok) return; // invalid: validation reports it
        used.add(`${rel}\u0000${r.prog.id}`);
        const isBuild = kind === "build" || kind === "unbuild";
        if (isBuild && !startLevel.has(r.key)) startLevel.set(r.key, r.from);
        const built = res.builds.get(`${rel}\u0000${r.prog.id}`);
        let switches: { at: number; view: QuarterTurn }[] = [];
        if (isBuild && built !== undefined && !r.noop) {
          // the view this action leaves: that of the new level, or the rest view (0) when it
          // leaves a level that had set one (§7.7); a no-op action changes nothing
          const nv = viewAt(built, r.to);
          const eff = nv ?? (viewAt(built, r.from) === undefined ? undefined : 0);
          if (eff !== undefined) {
            const prev = views.get(si);
            if (prev !== undefined && prev.view !== eff) {
              diagnostics.push(
                mk(
                  "info",
                  "assembly/view-conflict",
                  at,
                  `Actions ${prev.at + 1} and ${ai + 1} of this step set different views (${prev.view} and ${eff}); the last one wins`,
                  "Put the view changes in separate steps",
                  { views: [prev.view, eff] },
                ),
              );
            }
            views.set(si, { at: ai, view: eff });
          }
          switches = viewSwitches(built, r.from, r.to);
        }
        if (!(isBuild ? built !== undefined : res.programs.has(`${rel}\u0000${r.prog.id}`))) {
          // not resolved (budget or malformed): reported, never planned with a zero length
          diagnostics.push(
            mk(
              "warning",
              "budget/time",
              at,
              `Action on ${JSON.stringify(target)} skipped: program ${JSON.stringify(r.prog.id)} could not be resolved`,
              "Use fewer or broader selectors, or fewer parts",
              { target, program: r.prog.id },
            ),
          );
          return;
        }
        const skip = isBuild ? undefined : openedBefore.get(r.key);
        const own = r.noop ? 0 : segLen(rel, r.prog.id, r.from, r.to, skip);
        const implied: ProgramLevel[] = [];
        let access = 0;
        if (!r.noop && kind === "explode" && segs.length >= 2) {
          for (const s of machine.open(target, accessSteps(segs))) {
            implied.push({ program: s.program, level: s.stage, only: [s.path] });
            used.add(`${s.owner}\u0000${s.id}`);
            access += moveLen(s.owner, s.id, s.stage, s.path);
            diagnostics.push(
              mk(
                "info",
                "assembly/implicit-access",
                at,
                `Exploding ${JSON.stringify(target)} first moves ${JSON.stringify(s.path)} out through ${JSON.stringify(targetOf(s.owner))} stage ${s.stage} (program ${JSON.stringify(s.id)})`,
                `Add an explicit explode of ${JSON.stringify(targetOf(s.owner))} to control it`,
                { target, program: s.program, level: s.stage },
              ),
            );
          }
        } else if (!r.noop && kind === "implode" && r.to === 0) {
          for (const s of machine.close(target)) {
            implied.push({
              program: s.program,
              level: machine.levels.get(levelKey(s.owner, s.id)) ?? 0,
              only: [s.path],
            });
            access += moveLen(s.owner, s.id, s.stage, s.path);
          }
        }
        const natural = r4(own + access);
        actions.set(`${si}:${ai}`, {
          natural,
          action: {
            target,
            kind,
            program: r.prog.id,
            from: r.from,
            to: r.to,
            start: 0,
            length: natural,
            scale: 1,
            ...(switches.length === 0 ? {} : { views: switches }),
            ...(implied.length === 0 ? {} : { accessLength: r4(access) }),
            ...(skip === undefined || skip.size === 0 || r.noop
              ? {}
              : { opened: [...skip].sort() }),
            implied,
          },
        });
      });
      poses.push(snapshot());
    });
    for (const u of unstarted) u.entry.level = startLevel.get(u.key) ?? u.rest;
    const sim: Simulated = { actions, poses, views, base, used, diagnostics };
    this.simulated.set(asm.id, sim);
    return sim;
  }

  // ---- reach bounds (§10) -----------------------------------------------------------------

  /**
   * The `reach` hook of `buildAssemblies`: rest bounds plus the swept box of every leaf some
   * played program moves (offset intervals of every played program add, along the chain of owners and
   * between programs of one owner, which can be exploded together). World space, the unlifted frame of `probe`.
   */
  reach = (probe: SceneAssembly): Box3 | undefined => {
    if (this.reaches.has(probe.id)) return this.reaches.get(probe.id);
    const out = this.sweep(probe);
    this.reaches.set(probe.id, out);
    return out;
  };

  private sweep(probe: SceneAssembly): Box3 | undefined {
    const res = this.resolve(probe);
    const sim = this.simulate(probe);
    if (res === undefined || sim === undefined || sim.used.size === 0) return undefined;
    type Iv = [number, number, number, number, number, number];
    const total = new Map<string, Iv>();
    const used = [...sim.used].sort().filter((k) => res.programs.has(k) || res.builds.has(k));
    // every move of a played program with its sign: an explode move runs 0 -> offset, a build
    // move runs -offset -> 0 (the part starts at its origin, `offset` = seat - origin)
    const movesOf = (key: string): { moves: readonly PartMove[]; sign: 1 | -1 }[] => {
      const b = res.builds.get(key);
      if (b !== undefined) return b.steps.map((st) => ({ moves: st.moves, sign: -1 }));
      return (res.programs.get(key) as ResolvedProgramInfo).program.stages.map((st) => ({
        moves: st.moves,
        sign: 1,
      }));
    };
    // Cheap bound: the sum of |offset| of every move of every played program, on every axis
    // (any leaf's displacement is at most that, in either direction).
    const bound = (): Box3 | undefined => {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const key of used) {
        for (const st of movesOf(key)) {
          for (const m of st.moves) {
            sx += Math.abs(m.offset.x);
            sy += Math.abs(m.offset.y);
            sz += Math.abs(m.offset.z);
          }
        }
      }
      if (used.length === 0) return undefined;
      const r = probe.restBounds;
      return {
        origin: { x: rnd(r.origin.x - sx), y: rnd(r.origin.y - sy), z: rnd(r.origin.z - sz) },
        size: { x: rnd(r.size.x + 2 * sx), y: rnd(r.size.y + 2 * sy), z: rnd(r.size.z + 2 * sz) },
      };
    };
    let reach: Box3 | undefined;
    let exact = true;
    sweep: {
      // Programs of one owner can be exploded together (two programs, both at their last
      // stage), so their offsets ADD, like those of nested owners.
      for (const key of used) {
        for (const st of movesOf(key)) {
          for (const m of st.moves) {
            const node = res.nodes.get(m.path);
            if (node === undefined) continue;
            let leaves = this.leafMemo.get(node);
            if (leaves === undefined) {
              leaves = leavesOf(node);
              this.leafMemo.set(node, leaves);
            }
            if (!spend(this.sweepWork, leaves.length + 1)) {
              exact = false;
              break sweep;
            }
            const o = st.sign > 0 ? m.offset : { x: -m.offset.x, y: -m.offset.y, z: -m.offset.z };
            for (const l of leaves) {
              const iv = total.get(l.path) ?? [0, 0, 0, 0, 0, 0];
              iv[0] += Math.min(0, o.x);
              iv[1] += Math.max(0, o.x);
              iv[2] += Math.min(0, o.y);
              iv[3] += Math.max(0, o.y);
              iv[4] += Math.min(0, o.z);
              iv[5] += Math.max(0, o.z);
              total.set(l.path, iv);
            }
          }
        }
      }
    }
    if (!exact) {
      this.budgetWarning();
      reach = bound();
    } else {
      const map = frameMap(probe.frame, probe.root.local);
      const boxes: Box3[] = [];
      for (const p of [...total.keys()].sort()) {
        const leaf = res.nodes.get(p);
        if (leaf === undefined) continue;
        const iv = total.get(p) as Iv;
        const g = leaf.geometry;
        const b =
          g === undefined
            ? leaf.world
            : map.box({
                origin: {
                  x: leaf.local.origin.x + g.bounds.origin.x,
                  y: leaf.local.origin.y + g.bounds.origin.y,
                  z: leaf.local.origin.z + g.bounds.origin.z,
                },
                size: g.bounds.size,
              });
        boxes.push({
          origin: {
            x: rnd(b.origin.x + iv[0]),
            y: rnd(b.origin.y + iv[2]),
            z: rnd(b.origin.z + iv[4]),
          },
          size: {
            x: rnd(b.size.x + iv[1] - iv[0]),
            y: rnd(b.size.y + iv[3] - iv[2]),
            z: rnd(b.size.z + iv[5] - iv[4]),
          },
        });
      }
      reach = unionBoxes(boxes);
    }
    if (reach !== undefined) {
      const proj = createProjection();
      const area = (b: Box3): number => {
        const r = projectBoxBounds(proj, b);
        return r.width * r.height;
      };
      const all = unionBoxes([probe.restBounds, reach]) as Box3;
      const rest = area(probe.restBounds);
      if (rest > 0 && area(all) > GROWTH * rest) {
        this.diagnostics.push(
          mk(
            "info",
            "assembly/bounds-growth",
            `/assemblies/${this.specIndex(probe.id) ?? 0}`,
            `Assembly ${JSON.stringify(probe.id)} needs more than ${GROWTH}x its assembled area to explode`,
            "Use smaller distances, or fade the other parts",
            { assembly: probe.id },
          ),
        );
      }
    }
    return reach;
  }

  // ---- results ----------------------------------------------------------------------------

  /** Attaches programs and base poses to the placed assemblies (moves do not depend on the origin). */
  attach<T extends SceneAssemblies>(built: T): T {
    return {
      ...built,
      assemblies: built.assemblies.map((a) => {
        const res = this.resolve(a);
        const sim = this.simulate(a);
        if (res === undefined || sim === undefined) return a;
        const programs: ResolvedProgram[] = [
          ...[...res.programs.values()].map((r) => r.program),
          ...res.builds.values(),
        ].sort((p, q) => cmp(p.owner, q.owner) || cmp(p.id, q.id));
        return { ...a, programs, basePose: sim.base };
      }),
    };
  }

  /**
   * Plans every step through the shared step loop of `planFigureSteps`, so figure and assembly
   * actions share one cursor, motion window and compression, then adds the assemblies' poses.
   * `figures` may be empty. Diagnostics: `assembly/compressed` and `assembly/implicit-access`.
   */
  plan(
    assemblies: readonly SceneAssembly[],
    figures: ReadonlyMap<string, ResolvedFigure>,
    views: readonly (string | undefined)[],
    opts: PlanOptions = {},
  ): {
    plan: AssemblyStepPlan[];
    diagnostics: Diagnostic[];
    compression: Diagnostic[];
    /** Loop-start fades by assembly id (§7.4), only for assemblies that have any. */
    loopStart: Map<string, LoopStart>;
  } {
    const sims = new Map<string, Simulated>();
    const diagnostics: Diagnostic[] = [];
    for (const a of assemblies) {
      const s = this.simulate(a);
      if (s !== undefined) {
        sims.set(a.id, s);
        diagnostics.push(...s.diagnostics);
      }
    }
    const table = new Map<string, ForeignAction>();
    for (const s of sims.values()) for (const [k, v] of s.actions) table.set(k, v);
    const steps = (this.spec.steps ?? []).length;
    const ids = [...sims.keys()].sort();
    const last = steps === 0 ? undefined : steps - 1;
    const lastPose: Record<string, readonly ProgramLevel[]> = {};
    const basePose: Record<string, readonly ProgramLevel[]> = {};
    for (const id of ids) {
      const s = sims.get(id) as Simulated;
      basePose[id] = s.base;
      if (last !== undefined) lastPose[id] = s.poses[last] as readonly ProgramLevel[];
    }
    const planned = planFigureSteps(this.spec, figures, views, {
      ...opts,
      foreign: (si, ai) => table.get(`${si}:${ai}`),
      closeLoop:
        opts.closeLoop === true ||
        endsAwayFromBase(last === undefined ? undefined : lastPose, basePose),
    });
    // View in effect at the end of each step (§7.7): the build/unbuild action that comes last
    // in the step (across assemblies) and whose program sets views decides; else it carries over
    let view: QuarterTurn = 0;
    const plan = planned.plan.map((p, si) => {
      let at = -1;
      let first: { id: string; view: QuarterTurn } | undefined;
      for (const id of ids) {
        const v = (sims.get(id) as Simulated).views.get(si);
        if (v === undefined) continue;
        if (first !== undefined && first.id !== id && first.view !== v.view) {
          diagnostics.push(
            mk(
              "info",
              "assembly/view-conflict",
              `/steps/${si}/assembly`,
              `Assemblies ${JSON.stringify(first.id)} and ${JSON.stringify(id)} set different views (${first.view} and ${v.view}) in one step; the later action wins`,
              "Put the view changes in separate steps",
              { views: [first.view, v.view] },
            ),
          );
        }
        first ??= { id, view: v.view };
        if (v.at > at) {
          at = v.at;
          view = v.view;
        }
      }
      const poses: Record<string, readonly ProgramLevel[]> = { ...p.poses };
      for (const id of ids)
        poses[id] = (sims.get(id) as Simulated).poses[si] as readonly ProgramLevel[];
      const sorted: Record<string, readonly ProgramLevel[]> = {};
      for (const k of Object.keys(poses).sort()) sorted[k] = poses[k] as readonly ProgramLevel[];
      return { ...p, poses: sorted, view };
    });
    // Compression is reported by validation (`assemblyPlanDiagnostics`), never twice.
    const compression = planned.diagnostics.filter((d) => d.code === "assembly/compressed");
    // loop start (§7.4): the opening transition of step 1 is the plan's own `lead_1`
    const d1 = (this.spec.steps ?? [])[0]?.duration ?? 3;
    const lead = views[0] === undefined ? 0 : transitionOf(d1);
    const loopStart = new Map<string, LoopStart>();
    for (const a of assemblies) {
      const ls = loopStartOf(a, plan, lead);
      if (ls !== undefined) loopStart.set(a.id, ls);
    }
    return { plan, diagnostics, compression, loopStart };
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function flatten(n: SceneAssemblyNode): SceneAssemblyNode[] {
  const out: SceneAssemblyNode[] = [];
  const walk = (x: SceneAssemblyNode): void => {
    for (const c of x.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
}

const leavesOf = (n: SceneAssemblyNode): SceneAssemblyNode[] =>
  n.kind === "leaf" ? [n] : flatten(n).filter((c) => c.kind === "leaf");

function worldCentre(b: Box3): [number, number, number] {
  return [b.origin.x + b.size.x / 2, b.origin.y + b.size.y / 2, b.origin.z + b.size.z / 2];
}

// ---------------------------------------------------------------------------------------------
// Validation entry point
// ---------------------------------------------------------------------------------------------

export interface AssemblyPlanContext {
  readonly parts?: PartShapeRegistry;
  readonly dcShapes?: PartShapePack;
  /** Which `steps[].focus` ids zoom the camera (the scene's rule). */
  readonly isFocusTarget: (id: string) => boolean;
  readonly gated?: PlanOptions["gated"];
}

/**
 * `assembly/compressed` of the whole step plan (assemblies and figures through one step loop),
 * for `validate`: the scene computes the same plan with the same helpers but does not report it,
 * so a diagnostic never appears twice. Empty without assemblies or steps.
 */
export function assemblyPlanDiagnostics(
  spec: PlatformCosmoSpec,
  ctx: AssemblyPlanContext,
): Diagnostic[] {
  if ((spec.assemblies?.length ?? 0) === 0 || (spec.steps?.length ?? 0) === 0) return [];
  const programs = new AssemblyPrograms(spec);
  const built = programs.attach(
    buildAssemblies(spec, {
      reach: programs.reach,
      ...(ctx.parts === undefined ? {} : { parts: ctx.parts }),
      ...(ctx.dcShapes === undefined ? {} : { dcShapes: ctx.dcShapes }),
    }),
  );
  const figures = new Map<string, ResolvedFigure>();
  (spec.figures ?? []).forEach((f, i) => {
    const { figure } = resolveFigure(f, i);
    if (!figures.has(figure.id)) figures.set(figure.id, figure);
  });
  const views = stepViews(spec, ctx.isFocusTarget);
  return programs.plan(built.assemblies, figures, views, ctx.gated ? { gated: ctx.gated } : {})
    .compression;
}
