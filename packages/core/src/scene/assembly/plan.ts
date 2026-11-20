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
 * Build programs and racks are A2-6 / Phase 2: their actions are left alone here.
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
  SceneAssemblyNode,
} from "../../contracts/index.js";
import { AssemblyModel, type ProgInfo, type TNode } from "../../schema/assembly-tree.js";
import type {
  PlatformCosmoSpec,
  SpecAssembly,
  SpecAssemblyAction,
  SpecExplodeProgram,
  SpecStage,
} from "../../schema/types.gen.js";
import { createProjection, projectBoxBounds } from "../../geometry/index.js";
import {
  planFigureSteps,
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

/** Reach growth above this multiple of the rest area is reported (§10). */
const GROWTH = 4;

const KEYS = ["explode", "implode", "build", "unbuild"] as const;
const actionKey = (a: SpecAssemblyAction): (typeof KEYS)[number] =>
  KEYS.find((k) => k in a) as (typeof KEYS)[number];
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
  readonly nodes: ReadonlyMap<string, SceneAssemblyNode>;
}

/** One assembly's simulated action sequence. */
interface Simulated {
  /** `step:action` -> action. */
  readonly actions: ReadonlyMap<string, ForeignAction>;
  /** Pose after each step (index = step), full list per assembly. */
  readonly poses: readonly (readonly ProgramLevel[])[];
  readonly base: readonly ProgramLevel[];
  /** Programs some action (or the base pose) plays: `<ownerRel>\0<id>`. */
  readonly used: ReadonlySet<string>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface AssemblyProgramsOptions {
  readonly work?: Work;
}

export class AssemblyPrograms {
  readonly diagnostics: Diagnostic[] = [];
  private readonly model: AssemblyModel;
  private readonly work: Work;
  private readonly resolved = new Map<string, Resolved | null>();
  private readonly simulated = new Map<string, Simulated>();
  private readonly reaches = new Map<string, Box3 | undefined>();
  private readonly leafMemo = new WeakMap<SceneAssemblyNode, SceneAssemblyNode[]>();
  private warned = false;

  constructor(
    readonly spec: PlatformCosmoSpec,
    opts: AssemblyProgramsOptions = {},
  ) {
    this.model = new AssemblyModel(spec);
    this.work = opts.work ?? makeWork();
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
    const i = this.model.byId.get(asm.id);
    const specAsm = i === undefined ? undefined : (this.spec.assemblies ?? [])[i];
    let tree: TNode | undefined;
    try {
      tree = i === undefined ? undefined : this.model.tree(i);
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
          owners.set(rel, { rel, node: n, tnode: t, explodes, dflt });
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
    const indexes = new Map<string, { index: OwnerIndex; sel: OwnerSelectors }>();
    for (const rel of [...owners.keys()].sort(cmp)) {
      const owner = owners.get(rel) as OwnerInfo;
      for (const info of owner.explodes) {
        const spec = atPointer(this.spec, info.ptr) as SpecExplodeProgram | undefined;
        if (spec === undefined || !Array.isArray(spec.stages)) continue;
        let ix = indexes.get(rel);
        if (ix === undefined) {
          const index = indexOwner(owner.node, this.work);
          ix = { index, sel: new OwnerSelectors(index, this.work) };
          indexes.set(rel, ix);
        }
        if (!ix.index.complete) {
          this.budgetWarning();
          continue;
        }
        const r = this.resolveExplode(asm, owner, spec, ix.index, ix.sel);
        if (r === undefined) this.budgetWarning();
        else programs.set(`${rel}\0${info.id}`, r);
      }
    }
    const out: Resolved = { asm, spec: specAsm, owners, programs, nodes };
    this.resolved.set(asm.id, out);
    return out;
  }

  private resolveExplode(
    asm: SceneAssembly,
    owner: OwnerInfo,
    prog: SpecExplodeProgram,
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
    const dctx: DirectionContext = { frame: asm.frame, owner: owner.node };

    interface Staged {
      readonly spec: SpecStage;
      readonly movers: readonly Mover[];
      readonly selected: Set<string>;
    }
    const moved = new Set<Item>();
    const staged: Staged[] = [];
    const all: Mover[] = [];
    const stages = prog.stages.slice(0, 32);
    for (const raw of stages) {
      // a schema-invalid stage (not an object) is an empty stage: validation reports it
      const st: SpecStage =
        raw !== null && typeof raw === "object" ? raw : ({ parts: [] } as unknown as SpecStage);
      const r = sel.stage(
        Array.isArray(st.parts) ? st.parts : [],
        Array.isArray(st.except) ? st.except : undefined,
      );
      if (r === undefined) return undefined;
      const fresh = r.movers.filter((it) => !moved.has(it));
      for (const it of r.selected) moved.add(it);
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

  /** Actions, poses and used programs of one assembly (levels are per assembly). */
  private simulate(asm: SceneAssembly): Simulated | undefined {
    const memo = this.simulated.get(asm.id);
    if (memo !== undefined) return memo;
    const res = this.resolve(asm);
    if (res === undefined) return undefined;
    const spec = this.spec;
    const levels = new Map<string, number>();
    const used = new Set<string>();
    const progKey = (rel: string, id: string): string => `${rel}\0${id}`;
    const allProgs: { key: string; q: string; count: number }[] = [];
    for (const rel of [...res.owners.keys()].sort(cmp)) {
      for (const p of (res.owners.get(rel) as OwnerInfo).explodes) {
        allProgs.push({ key: progKey(rel, p.id), q: qualifiedProgram(rel, p.id), count: p.count });
      }
    }
    allProgs.sort((a, b) => cmp(a.q, b.q));
    // base pose: `pose: exploded` shows the root's default explode program fully exploded
    const root = res.owners.get("");
    if (res.spec.pose === "exploded" && root?.dflt !== undefined) {
      levels.set(progKey("", root.dflt.id), root.dflt.count);
      used.add(progKey("", root.dflt.id));
    }
    const snapshot = (): ProgramLevel[] =>
      allProgs.map((p) => ({ program: p.q, level: levels.get(p.key) ?? 0 }));
    const base = snapshot();

    const diagnostics: Diagnostic[] = [];
    const actions = new Map<string, ForeignAction>();
    const poses: (readonly ProgramLevel[])[] = [];
    const exploded = new Map<string, string>(); // target -> program id that exploded it
    const access = new Map<string, { key: string; q: string; prior: number }[]>();

    const segLen = (rel: string, id: string, from: number, to: number): number => {
      const r = res.programs.get(progKey(rel, id));
      return r === undefined ? 0 : programSegment(r.program, from, to).length;
    };

    (spec.steps ?? []).forEach((step, si) => {
      (step.assembly ?? []).forEach((a, ai) => {
        const kind = actionKey(a);
        if (kind !== "explode" && kind !== "implode") return; // build programs: A2-6
        const target = (a as unknown as Record<string, string>)[kind] as string;
        if (typeof target !== "string") return;
        const segs = target.split("/");
        if (segs[0] !== asm.id) return;
        const node = res.nodes.get(target);
        const rel = segs.slice(1).join("/");
        const owner = res.owners.get(rel);
        if (node === undefined || owner === undefined || owner.explodes.length === 0) return;
        const named = (a as { program?: string }).program;
        let prog: ProgInfo | undefined;
        if (named !== undefined) prog = owner.explodes.find((p) => p.id === named);
        else {
          const last = kind === "implode" ? exploded.get(target) : undefined;
          prog = owner.explodes.find((p) => p.id === last) ?? owner.dflt;
        }
        if (prog === undefined) return;
        const key = progKey(rel, prog.id);
        const n = prog.count;
        const cur = levels.get(key) ?? 0;
        const spec_ = a as { to?: number };
        const to = spec_.to ?? (kind === "explode" ? n : 0);
        if (!Number.isInteger(to) || to < 0 || to > n) return;
        if ((kind === "explode" && to < cur) || (kind === "implode" && to > cur)) return;
        levels.set(key, to);
        used.add(key);
        if (kind === "explode") exploded.set(target, prog.id);

        const own = to === cur ? 0 : segLen(rel, prog.id, cur, to);
        const implied: ProgramLevel[] = [];
        let extra = 0;
        const at = `/steps/${si}/assembly/${ai}/${kind}`;
        if (kind === "explode" && segs.length >= 2) {
          const prior: { key: string; q: string; prior: number }[] = [];
          for (let j = 1; j < segs.length; j++) {
            const orel = segs.slice(1, j).join("/");
            const o = res.owners.get(orel);
            if (o?.dflt === undefined) continue;
            const info = res.programs.get(progKey(orel, o.dflt.id));
            if (info === undefined) continue;
            const below = segs.slice(j);
            const chain = below.map((_, m) => below.slice(0, m + 1).join("/"));
            const stage = info.selected.findIndex((s) => chain.some((c) => s.has(c))) + 1;
            const lk = progKey(orel, o.dflt.id);
            const at0 = levels.get(lk) ?? 0;
            if (stage === 0 || at0 >= stage) continue;
            const q = qualifiedProgram(orel, o.dflt.id);
            implied.push({ program: q, level: stage });
            prior.push({ key: lk, q, prior: at0 });
            extra += segLen(orel, o.dflt.id, at0, stage);
            levels.set(lk, stage);
            used.add(lk);
            diagnostics.push(
              mk(
                "info",
                "assembly/implicit-access",
                at,
                `Exploding ${JSON.stringify(target)} first moves it out through ${JSON.stringify(
                  orel === "" ? asm.id : `${asm.id}/${orel}`,
                )} stage ${stage} (program ${JSON.stringify(o.dflt.id)})`,
                `Add an explicit explode of ${JSON.stringify(orel === "" ? asm.id : `${asm.id}/${orel}`)} to "to": ${stage} before this action to control it`,
                { target, program: q, level: stage },
              ),
            );
          }
          if (prior.length > 0) access.set(target, prior);
        } else if (kind === "implode" && to === 0) {
          const prior = access.get(target);
          if (prior !== undefined) {
            access.delete(target);
            for (const p of prior) {
              const cur2 = levels.get(p.key) ?? 0;
              implied.push({ program: p.q, level: p.prior });
              const owner2 = p.q.includes("/") ? p.q.slice(0, p.q.lastIndexOf("/")) : "";
              extra += segLen(owner2, p.q.slice(p.q.lastIndexOf("/") + 1), p.prior, cur2);
              levels.set(p.key, p.prior);
            }
          }
        }
        actions.set(`${si}:${ai}`, {
          natural: r4(own + extra),
          action: {
            target,
            kind,
            program: prog.id,
            from: cur,
            to,
            start: 0,
            length: r4(own + extra),
            scale: 1,
            implied,
          },
        });
      });
      poses.push(snapshot());
    });
    const sim: Simulated = { actions, poses, base, used, diagnostics };
    this.simulated.set(asm.id, sim);
    return sim;
  }

  // ---- reach bounds (§10) -----------------------------------------------------------------

  /**
   * The `reach` hook of `buildAssemblies`: rest bounds plus the swept box of every leaf some
   * played program moves (offset intervals add along the chain of owners; programs of one owner
   * are alternatives, so their hull is taken). World space, the unlifted frame of `probe`.
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
    const byOwner = new Map<string, Map<string, Iv>>();
    for (const key of [...sim.used].sort()) {
      const r = res.programs.get(key);
      if (r === undefined) continue;
      const ownerRel = key.slice(0, key.indexOf("\0"));
      const per = new Map<string, Iv>();
      for (const st of r.program.stages) {
        for (const m of st.moves) {
          const node = res.nodes.get(m.path);
          if (node === undefined) continue;
          const o = m.offset;
          let leaves = this.leafMemo.get(node);
          if (leaves === undefined) {
            leaves = leavesOf(node);
            this.leafMemo.set(node, leaves);
          }
          if (!spend(this.work, leaves.length + 1)) {
            this.budgetWarning();
            return undefined;
          }
          for (const l of leaves) {
            const iv = per.get(l.path) ?? [0, 0, 0, 0, 0, 0];
            iv[0] += Math.min(0, o.x);
            iv[1] += Math.max(0, o.x);
            iv[2] += Math.min(0, o.y);
            iv[3] += Math.max(0, o.y);
            iv[4] += Math.min(0, o.z);
            iv[5] += Math.max(0, o.z);
            per.set(l.path, iv);
          }
        }
      }
      // alternatives within one owner: hull
      const hull = byOwner.get(ownerRel) ?? new Map<string, Iv>();
      for (const [p, iv] of per) {
        const h = hull.get(p);
        hull.set(
          p,
          h === undefined
            ? iv
            : [
                Math.min(h[0], iv[0]),
                Math.max(h[1], iv[1]),
                Math.min(h[2], iv[2]),
                Math.max(h[3], iv[3]),
                Math.min(h[4], iv[4]),
                Math.max(h[5], iv[5]),
              ],
        );
      }
      byOwner.set(ownerRel, hull);
    }
    for (const hull of byOwner.values()) {
      for (const [p, iv] of hull) {
        const t = total.get(p) ?? [0, 0, 0, 0, 0, 0];
        for (let k = 0; k < 6; k++) t[k] = (t[k] as number) + (iv[k] as number);
        total.set(p, t);
      }
    }
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
    const reach = unionBoxes(boxes);
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
            `/assemblies/${this.model.byId.get(probe.id) ?? 0}`,
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
        const programs: ResolvedProgram[] = [...res.programs.values()]
          .map((r) => r.program)
          .sort((p, q) => cmp(p.owner, q.owner) || cmp(p.id, q.id));
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
  ): { plan: AssemblyStepPlan[]; diagnostics: Diagnostic[] } {
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
    const plan = planned.plan.map((p, si) => {
      const poses: Record<string, readonly ProgramLevel[]> = { ...p.poses };
      for (const id of ids)
        poses[id] = (sims.get(id) as Simulated).poses[si] as readonly ProgramLevel[];
      const sorted: Record<string, readonly ProgramLevel[]> = {};
      for (const k of Object.keys(poses).sort()) sorted[k] = poses[k] as readonly ProgramLevel[];
      return { ...p, poses: sorted };
    });
    diagnostics.push(...planned.diagnostics.filter((d) => d.code === "assembly/compressed"));
    return { plan, diagnostics };
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
