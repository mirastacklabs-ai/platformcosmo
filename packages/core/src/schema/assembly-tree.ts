/**
 * Expanded part tree and selector matching for schema revision 1.2.0 validation (Track A2,
 * A2-1; design docs/design/assemblies.md §5, §6.1, §8, §13). Pure and bounded: sizes are
 * computed from the spec (saturating arithmetic, memoized per template, cycle-safe) before any
 * tree is built, and a tree is built only when it fits the §13 budgets, so `count: 64` nested
 * seven deep or a `use` cycle never allocates or loops. Nothing here throws on bad input.
 *
 * The tree is the *validation* view (ids, programs, types, tags), not the scene tree (A2-2):
 * `use` instances share their template's children instead of copying them, and DC rack frames
 * and slots without a template are opaque (their parts come from the DC pack).
 */
import type { Diagnostic, SceneAssemblyNode } from "../contracts/index.js";
import type { PlatformCosmoSpec, SpecAssembly, SpecPart, SpecProgram } from "./types.gen.js";
import { globMatch } from "./glob.js";
import { q } from "./suggest.js";

/** Longest path in segments (§13). */
export const MAX_DEPTH = 8;
/** Leaf parts per spec: error above, warning above `LEAF_WARN` (§13). */
export const LEAF_ERROR = 2000;
export const LEAF_WARN = 500;
/** Nodes one expanded tree may hold; sub-assemblies add at most `MAX_DEPTH` nodes per leaf. */
export const NODE_CAP = 20_000;
/** Selector-list entries (`Flat`) allocated across all owners of one validation run. */
export const FLAT_CAP = 200_000;
const SAT = 1_000_000_000;
const sat = (n: number): number => (n > SAT ? SAT : n);

export type NodeKind = "root" | "part" | "rack" | "frame" | "slot" | "closeup" | "figure" | "board";

export interface ProgInfo {
  readonly id: string;
  readonly kind: "explode" | "build";
  /** Stages (explode) or steps (build). */
  readonly count: number;
  readonly ptr: string;
}

export interface TNode {
  readonly id: string;
  readonly kind: NodeKind;
  /** JSON pointer of the defining spec object (a part, assembly, rack, slot). */
  readonly ptr: string;
  readonly part?: SpecPart;
  readonly type?: string;
  readonly tags: readonly string[];
  readonly role?: string;
  readonly shape?: string;
  /** Close-up reference (assembly, figure or storyboard id), addressed through `closeup`. */
  readonly closeup?: string;
  /** A figure or storyboard close-up instance (kind `figure` / `board`): the id it draws. */
  readonly ref?: string;
  progs: readonly ProgInfo[];
  /** `assemblies[].program`: the default program id. */
  readonly defaultProg?: string;
  /** Children are not known (DC rack frame, a slot without a template): any path under it passes. */
  opaque: boolean;
  /** Mutable while the tree is built; shared (not copied) between `use` instances. */
  children: TNode[];
  /** An explicit sub-assembly (`parts` or `use`); false for leaves. */
  readonly group: boolean;
}

export interface Metrics {
  readonly leaves: number;
  readonly nodes: number;
  /** Deepest chain below the owner, in segments (a top-level part is 1). */
  readonly height: number;
}

const LEAF_ONE: Metrics = { leaves: 1, nodes: 1, height: 1 };

export const progsOf = (list: readonly SpecProgram[] | undefined, base: string): ProgInfo[] => {
  const out: ProgInfo[] = [];
  (list ?? []).forEach((p, k) => {
    const build = "kind" in p && p.kind === "build";
    out.push({
      id: p.id,
      kind: build ? "build" : "explode",
      count: "steps" in p ? p.steps.length : p.stages.length,
      ptr: `${base}/${k}`,
    });
  });
  return out;
};

export interface DupReport {
  readonly path: string;
  readonly id: string;
  readonly first: string;
}

/** What a walk along a path found. */
export type Walk =
  | { readonly ok: true; readonly node: TNode; readonly opaque: boolean }
  | {
      readonly ok: false;
      /** Index in `segs` of the segment that does not resolve. */
      readonly at: number;
      readonly parent: TNode;
      readonly reason: "missing" | "no-closeup";
    };

export interface Flat {
  readonly path: string;
  readonly segs: readonly string[];
  readonly node: TNode;
}

/**
 * The spec's assemblies as a validation model: sizes, cycles, trees, rack trees and path walks.
 * One instance per `assemblyDiagnostics` call; every memo is keyed by definition, so work is
 * linear in the spec once the budget checks pass.
 */
export class AssemblyModel {
  readonly assemblies: readonly SpecAssembly[];
  /** First definition wins (duplicate ids are reported by the shared id namespace). */
  readonly byId = new Map<string, number>();
  /** Diagnostics found while building trees (`assembly/duplicate-part`). */
  readonly diagnostics: Diagnostic[] = [];
  /** First expanded copy of each part definition, by definition pointer. */
  readonly firstDef = new Map<string, { node: TNode; parent: TNode }>();

  private readonly metricsMemo = new Map<number, Metrics>();
  private readonly visiting = new Set<number>();
  private readonly trees = new Map<number, TNode | null>();
  private readonly building = new Set<number>();
  private readonly reported = new Set<string>();
  private readonly closeups = new Map<string, TNode>();
  private readonly flats = new Map<TNode, { list: Flat[]; complete: boolean }>();
  private nodeBudget = NODE_CAP * 4;
  private flatBudget = FLAT_CAP;
  /** A validation work cap was hit (tree nodes or selector lists): later checks were skipped. */
  capped = false;

  constructor(readonly spec: PlatformCosmoSpec) {
    this.assemblies = spec.assemblies ?? [];
    this.assemblies.forEach((a, i) => {
      if (!this.byId.has(a.id)) this.byId.set(a.id, i);
    });
  }

  // ---- sizes (§13), computed before anything is expanded ------------------------------------

  /** Leaves, nodes and height of an assembly's parts after `count` and `use`. */
  metrics(i: number): Metrics {
    const memo = this.metricsMemo.get(i);
    if (memo !== undefined) return memo;
    // A template cycle (reported elsewhere) counts as one leaf, never recurses.
    if (this.visiting.has(i)) return LEAF_ONE;
    const a = this.assemblies[i];
    if (a === undefined) return LEAF_ONE;
    this.visiting.add(i);
    const m = this.listMetrics(a.parts, 1);
    this.visiting.delete(i);
    this.metricsMemo.set(i, m);
    return m;
  }

  private listMetrics(parts: readonly SpecPart[], level: number): Metrics {
    let leaves = 0;
    let nodes = 0;
    let height = 0;
    for (const p of parts) {
      const m = this.partMetrics(p, level);
      leaves = sat(leaves + m.leaves);
      nodes = sat(nodes + m.nodes);
      height = Math.max(height, m.height);
    }
    return { leaves, nodes, height };
  }

  private partMetrics(p: SpecPart, level: number): Metrics {
    const n = p.count ?? 1;
    let one: Metrics = LEAF_ONE;
    // Parts nested deeper than the path limit are reported (assembly/too-deep) and not counted.
    if (p.parts !== undefined && level < MAX_DEPTH - 1) {
      const c = this.listMetrics(p.parts, level + 1);
      one = { leaves: c.leaves, nodes: sat(1 + c.nodes), height: 1 + c.height };
    } else if (p.parts === undefined && p.use !== undefined) {
      const t = this.byId.get(p.use);
      if (t !== undefined) {
        const c = this.metrics(t);
        one = { leaves: c.leaves, nodes: sat(1 + c.nodes), height: 1 + c.height };
      }
    }
    return {
      leaves: sat(one.leaves * n),
      nodes: sat(one.nodes * n),
      height: one.height,
    };
  }

  /** Whether the assembly may be expanded: inside the leaf and node budgets. */
  fits(i: number): boolean {
    const m = this.metrics(i);
    return m.leaves <= LEAF_ERROR && m.nodes <= NODE_CAP;
  }

  // ---- trees ----------------------------------------------------------------------------

  /** The assembly's expanded tree, or undefined when it does not fit the budgets. */
  tree(i: number): TNode | undefined {
    const memo = this.trees.get(i);
    if (memo !== undefined) return memo ?? undefined;
    const a = this.assemblies[i];
    if (a === undefined || this.building.has(i) || !this.fits(i)) return undefined;
    if (this.nodeBudget <= 0) {
      this.capped = true;
      return undefined;
    }
    this.building.add(i);
    const root: TNode = {
      id: a.id,
      kind: "root",
      ptr: `/assemblies/${i}`,
      tags: [],
      progs: progsOf(a.programs, `/assemblies/${i}/programs`),
      ...(a.program === undefined ? {} : { defaultProg: a.program }),
      ...(a.closeup === undefined ? {} : { closeup: a.closeup }),
      opaque: false,
      children: [],
      group: true,
    };
    this.expand(a.parts, `/assemblies/${i}/parts`, root, 1);
    this.building.delete(i);
    if (this.nodeBudget < 0) {
      // Out of node budget mid-expansion: a partial tree would give false "matches no part" and
      // "unknown target" results, so the assembly has no tree at all.
      this.capped = true;
      this.trees.set(i, null);
      for (const key of [...this.firstDef.keys()]) {
        if (key.startsWith(`/assemblies/${i}/`)) this.firstDef.delete(key);
      }
      return undefined;
    }
    this.trees.set(i, root);
    return root;
  }

  private expand(parts: readonly SpecPart[], base: string, parent: TNode, level: number): void {
    const seen = new Map<string, { ptr: string; counted: boolean }>();
    parts.forEach((p, k) => {
      const ptr = `${base}/${k}`;
      const n = p.count ?? 1;
      for (let c = 1; c <= n && this.nodeBudget >= 0; c++) {
        const id = n > 1 ? `${p.id}-${c}` : p.id;
        const first = seen.get(id);
        if (first !== undefined) {
          if (!this.reported.has(ptr)) {
            this.reported.add(ptr);
            this.diagnostics.push({
              severity: "error",
              code: "assembly/duplicate-part",
              path: `${ptr}/id`,
              message: `Duplicate part id ${q(id)} among siblings (first at ${first.ptr}/id${n > 1 || first.counted ? "; ids repeat after count expansion" : ""})`,
              suggestion:
                "Rename one part, or change the count so the copies <id>-1 ... do not collide",
              params: { id, first: `${first.ptr}/id` },
            });
          }
          continue;
        }
        seen.set(id, { ptr, counted: n > 1 });
        if (--this.nodeBudget < 0) return;
        const node = this.partNode(p, id, ptr, level);
        parent.children.push(node);
        if (!this.firstDef.has(ptr)) this.firstDef.set(ptr, { node, parent });
      }
    });
  }

  private partNode(p: SpecPart, id: string, ptr: string, level: number): TNode {
    const node: TNode = {
      id,
      kind: "part",
      ptr,
      part: p,
      tags: p.tags ?? [],
      ...(p.type === undefined ? {} : { type: p.type }),
      ...(p.role === undefined ? {} : { role: p.role }),
      ...(p.shape === undefined ? {} : { shape: p.shape }),
      ...(p.closeup === undefined ? {} : { closeup: p.closeup }),
      progs: progsOf(p.programs, `${ptr}/programs`),
      opaque: false,
      children: [],
      group: p.parts !== undefined || p.use !== undefined,
    };
    if (p.parts !== undefined) {
      if (level < MAX_DEPTH - 1) this.expand(p.parts, `${ptr}/parts`, node, level + 1);
    } else if (p.use !== undefined) {
      const t = this.byId.get(p.use);
      const tree = t === undefined ? undefined : this.tree(t);
      if (t === undefined || tree === undefined || level + this.metrics(t).height > MAX_DEPTH - 1) {
        node.opaque = true;
      } else {
        node.children = tree.children;
        if (node.progs.length === 0) node.progs = tree.progs;
      }
    }
    return node;
  }

  /** Rack as an assembly: the frame (opaque), then one node per slot (template children shared). */
  rackTree(ri: number): TNode | undefined {
    const rack = (this.spec.racks ?? [])[ri];
    if (rack === undefined) return undefined;
    const memo = this.trees.get(-1 - ri);
    if (memo !== undefined) return memo ?? undefined;
    const base = `/racks/${ri}`;
    const custom = progsOf(rack.programs as readonly SpecProgram[] | undefined, `${base}/programs`);
    const progs =
      custom.length > 0
        ? custom
        : [{ id: "drawers", kind: "explode" as const, count: 2, ptr: base }];
    const root: TNode = {
      id: rack.id,
      kind: "rack",
      ptr: base,
      tags: [],
      progs,
      opaque: false,
      children: [],
      group: true,
    };
    root.children.push({
      id: "frame",
      kind: "frame",
      ptr: base,
      tags: [],
      progs: [],
      opaque: true,
      children: [],
      group: true,
    });
    const seen = new Set<string>(["frame"]);
    (rack.slots ?? []).forEach((s, si) => {
      const id = s.id ?? `u${s.at}`;
      if (seen.has(id)) return;
      seen.add(id);
      const ptr = `${base}/slots/${si}`;
      const t = s.assembly === undefined ? undefined : this.byId.get(s.assembly);
      const tree = t === undefined ? undefined : this.tree(t);
      const internals: ProgInfo[] =
        tree === undefined
          ? []
          : [
              {
                id: "internals",
                kind: "explode",
                count: 1 + this.defaultExplodeStages(tree),
                ptr,
              },
            ];
      root.children.push({
        id,
        kind: "slot",
        ptr,
        type: s.type,
        tags: [],
        progs: internals,
        ...(s.closeup === undefined ? {} : { closeup: s.closeup }),
        // A slot without (or with an unusable) template: its device parts come from the DC pack.
        opaque: tree === undefined,
        children: tree === undefined ? [] : tree.children,
        group: true,
      });
    });
    this.trees.set(-1 - ri, root);
    return root;
  }

  /**
   * The rack as the DC pack built it in assembly mode (`root`: the scene tree, §8.1): the
   * validation rack tree with the frame and every slot opened up to the scene's nodes (frame
   * parts, device parts; around a template, the pack's `tray`, `lid`, `faceplate/…`, `rear/…`),
   * so rack-program selectors are checked over exactly the nodes the scene resolves them over.
   * A slot's template children keep their nodes (and programs). Not memoized: call it once per
   * rack; `rackTree` itself is unchanged (paths through an opaque node still pass).
   */
  builtRackTree(ri: number, root: SceneAssemblyNode): TNode | undefined {
    const base = this.rackTree(ri);
    if (base === undefined) return undefined;
    const convert = (n: SceneAssemblyNode, ptr: string): TNode => ({
      id: n.id,
      kind: "part",
      ptr,
      tags: [...n.tags],
      ...(n.type === undefined ? {} : { type: n.type }),
      role: n.role,
      progs: [],
      opaque: false,
      children: n.children.map((c) => convert(c, ptr)),
      group: n.kind === "sub",
    });
    const built = new Map(root.children.map((c) => [c.id, c]));
    return {
      ...base,
      children: base.children.map((t) => {
        const scene = built.get(t.id);
        if (scene === undefined) return t;
        const own = new Map(t.children.map((c) => [c.id, c]));
        return {
          ...t,
          opaque: false,
          children: scene.children.map((c) => own.get(c.id) ?? convert(c, t.ptr)),
        };
      }),
    };
  }

  /**
   * Length of a template's default program (§8.2): the stages of `program`, or its steps when
   * that is a build program; without `program`, the first explode program's stages.
   */
  defaultExplodeStages(root: TNode): number {
    const named = root.progs.find((p) => p.id === root.defaultProg);
    const pick = named ?? root.progs.find((p) => p.kind === "explode");
    return pick === undefined ? 0 : pick.count;
  }

  // ---- paths ----------------------------------------------------------------------------

  /** Root node of an assembly or rack id (undefined: unknown, or its tree is over budget). */
  root(id: string): TNode | undefined {
    const a = this.byId.get(id);
    if (a !== undefined) return this.tree(a);
    const ri = (this.spec.racks ?? []).findIndex((r) => r.id === id);
    return ri >= 0 ? this.rackTree(ri) : undefined;
  }

  /** The instance a `closeup` reference draws: a template tree, or a figure/storyboard leaf. */
  closeupNode(ref: string): TNode | undefined {
    const memo = this.closeups.get(ref);
    if (memo !== undefined) return memo;
    let node: TNode | undefined;
    const a = this.byId.get(ref);
    if (a !== undefined) {
      const tree = this.tree(a);
      node = {
        id: "closeup",
        kind: "closeup",
        ptr: `/assemblies/${a}`,
        tags: [],
        progs: tree?.progs ?? [],
        ...(tree?.defaultProg === undefined ? {} : { defaultProg: tree.defaultProg }),
        ...(this.assemblies[a]?.closeup === undefined
          ? {}
          : { closeup: this.assemblies[a]!.closeup! }),
        opaque: tree === undefined,
        children: tree?.children ?? [],
        group: true,
      };
    } else if ((this.spec.figures ?? []).some((f) => f.id === ref)) {
      node = {
        id: "closeup",
        kind: "figure",
        ref,
        ptr: "",
        tags: [],
        progs: [],
        opaque: false,
        children: [],
        group: false,
      };
    } else if ((this.spec.storyboards ?? []).some((b) => b.id === ref)) {
      node = {
        id: "closeup",
        kind: "board",
        ref,
        ptr: "",
        tags: [],
        progs: [],
        opaque: false,
        children: [],
        group: false,
      };
    }
    if (node !== undefined) this.closeups.set(ref, node);
    return node;
  }

  /**
   * Resolves `segs` (first segment is `from`'s own id) below `from`. The reserved segment
   * `closeup` enters the node's close-up instance; an opaque node accepts any remainder.
   */
  walk(from: TNode, segs: readonly string[]): Walk {
    let node = from;
    for (let i = 1; i < segs.length; i++) {
      if (node.opaque) return { ok: true, node, opaque: true };
      const seg = segs[i] as string;
      if (seg === "closeup" && node.closeup !== undefined) {
        const c = this.closeupNode(node.closeup);
        if (c === undefined) return { ok: false, at: i, parent: node, reason: "missing" };
        node = c;
        continue;
      }
      const child = node.children.find((c) => c.id === seg);
      if (child === undefined) {
        return {
          ok: false,
          at: i,
          parent: node,
          reason: seg === "closeup" ? "no-closeup" : "missing",
        };
      }
      node = child;
    }
    return { ok: true, node, opaque: node.opaque };
  }

  // ---- selectors (§6.1) -------------------------------------------------------------------

  /**
   * Depth-first spec order, paths relative to the owner (`head/valve-1`). Bounded: at most
   * `NODE_CAP` entries per owner and `FLAT_CAP` across owners; an incomplete list is reported
   * by `complete`, and callers then skip their emptiness checks.
   */
  flat(owner: TNode): readonly Flat[] {
    return this.flatInfo(owner).list;
  }

  /** Whether `flat(owner)` lists every descendant (no cap was hit). */
  complete(owner: TNode): boolean {
    return this.flatInfo(owner).complete;
  }

  private flatInfo(owner: TNode): { list: Flat[]; complete: boolean } {
    const memo = this.flats.get(owner);
    if (memo !== undefined) return memo;
    const list: Flat[] = [];
    let complete = true;
    const visit = (n: TNode, segs: readonly string[]): void => {
      for (const c of n.children) {
        if (!complete) return;
        if (list.length >= NODE_CAP || this.flatBudget <= 0) {
          complete = false;
          this.capped = true;
          return;
        }
        this.flatBudget--;
        const s = [...segs, c.id];
        list.push({ path: s.join("/"), segs: s, node: c });
        visit(c, s);
      }
    };
    visit(owner, []);
    const info = { list, complete };
    this.flats.set(owner, info);
    return info;
  }
}

// ---------------------------------------------------------------------------------------------
// Selector matching
// ---------------------------------------------------------------------------------------------

export const SELECTOR_KINDS = ["tag", "type", "role"] as const;
export const ROLES = ["body", "cover", "fastener", "internal", "cable", "shell"] as const;

export interface ParsedSelector {
  readonly scopes: readonly string[];
  readonly term: string;
  readonly kind?: "tag" | "type" | "role";
  /** The term without its `kind:` prefix. */
  readonly glob: string;
}

export function parseSelector(sel: string): ParsedSelector {
  const segs = sel.split("/");
  const term = segs.pop() as string;
  const colon = term.indexOf(":");
  const kind = colon > 0 ? term.slice(0, colon) : undefined;
  const k = SELECTOR_KINDS.find((x) => x === kind);
  return {
    scopes: segs,
    term,
    ...(k === undefined ? {} : { kind: k }),
    glob: k === undefined ? term : term.slice(colon + 1),
  };
}

/** Effective type of a node (registry defaults are applied by the caller via `typeOf`). */
export type TypeOf = (n: TNode) => string | undefined;

function termMatches(p: ParsedSelector, node: TNode, typeOf: TypeOf): boolean {
  switch (p.kind) {
    case undefined:
      return globMatch(p.glob, node.id);
    case "tag":
      return node.tags.some((t) => globMatch(p.glob, t));
    case "type": {
      const t = typeOf(node);
      return t !== undefined && globMatch(p.glob, t);
    }
    default:
      return node.role !== undefined && globMatch(p.glob, node.role);
  }
}

/**
 * Layered reachability of the scopes over `segs[0..end)` as a bit set: bit `s` is set when the
 * scopes consume exactly the first `s` segments (`**` consumes any number, including none).
 * One integer per scope layer, so the work is O(scopes x segments) however many `**` there
 * are (a naive recursion is exponential in the number of `**` scopes) and nothing allocates.
 * Paths have at most 8 segments, so `end <= 8` fits the 9 bits. `visit` sees every layer and
 * may stop early.
 */
function scopeStates(
  scopes: readonly string[],
  segs: readonly string[],
  end: number,
  visit?: (states: number) => boolean,
): number {
  const full = (1 << (end + 1)) - 1;
  let cur = 1; // bit 0: nothing consumed yet
  if (visit?.(cur) === true) return cur;
  for (const pat of scopes) {
    if (pat === "**") {
      // every position at or after the first reachable one
      cur = cur === 0 ? 0 : full & ~((cur & -cur) - 1);
    } else {
      let next = 0;
      for (let s = 0; s < end; s++) {
        if ((cur & (1 << s)) !== 0 && globMatch(pat, segs[s] as string)) next |= 1 << (s + 1);
      }
      cur = next;
    }
    if (visit?.(cur) === true) return cur;
  }
  return cur;
}

/** Do `scopes` match exactly the first `end` segments of `segs`? */
function scopesMatch(scopes: readonly string[], segs: readonly string[], end: number): boolean {
  return (scopeStates(scopes, segs, end) & (1 << end)) !== 0;
}

/** Does selector `p` select the node at `f` (the selector is evaluated against the owner)? */
export function selects(p: ParsedSelector, f: Flat, typeOf: TypeOf): boolean {
  const last = f.segs.length - 1;
  if (p.term === "**") {
    // every descendant below the scopes: at least one segment remains for the term
    return scopeStates(p.scopes, f.segs, last) !== 0;
  }
  return termMatches(p, f.node, typeOf) && scopesMatch(p.scopes, f.segs, last);
}

/** Do the scopes consume the whole node path at some point (the rest of the selector is below)? */
function scopesPrefixMatch(scopes: readonly string[], segs: readonly string[]): boolean {
  const end = segs.length;
  let hit = false;
  scopeStates(scopes, segs, end, (st) => (hit = (st & (1 << end)) !== 0));
  return hit;
}

/**
 * Could the selector reach below an opaque node (a DC rack frame, a slot without a template),
 * whose parts are unknown here? Then an empty match is not reported.
 */
export function reachesOpaque(p: ParsedSelector, flat: readonly Flat[]): boolean {
  if (p.scopes.length === 0) return false;
  return flat.some((f) => f.node.opaque && scopesPrefixMatch(p.scopes, f.segs));
}
