/**
 * Program selectors over the scene tree (Track A2, A2-3; design docs/design/assemblies.md §6.1).
 *
 * Selectors are evaluated against the program OWNER: a bare term matches the owner's direct
 * children, scopes reach deeper, `**` spans segments, `kind:glob` tests tag, type or role. The
 * grammar and matching are A2-1's (`parseSelector`, `selects` in `schema/assembly-tree.ts`), so
 * validation and scene agree on what a selector matches: this file only supplies the scene's
 * items in the same shape (path segments relative to the owner, tags, type, role) and bounds
 * the work. No regular expression ever runs on a spec string (`globMatch` is linear).
 *
 * Work is budgeted: a `Work` counter is charged before an owner is indexed or a selector
 * scans, and a spent budget makes `match` return undefined (the caller degrades and reports).
 */
import type { SceneAssemblyNode } from "../../contracts/index.js";
import {
  NODE_CAP,
  parseSelector,
  selects,
  type Flat,
  type ParsedSelector,
  type TNode,
} from "../../schema/assembly-tree.js";

/** Shared work counter (units are node visits); one per resolution run. */
export interface Work {
  left: number;
}

export const WORK_CAP = 40_000_000;

const isText = (s: unknown): s is string => typeof s === "string";

/** Selectors per stage list (the schema's `maxItems`); more are ignored. */
export const MAX_SELECTORS = 64;

export const makeWork = (n: number = WORK_CAP): Work => ({ left: n });

/** Charges `n` units; false (and nothing left) when the budget cannot cover it. */
export function spend(w: Work, n: number): boolean {
  if (!(n <= w.left)) {
    w.left = 0;
    return false;
  }
  w.left -= n;
  return true;
}

/** One descendant of a program owner. */
export interface Item {
  /** Path relative to the owner, `head/valve-1`. */
  readonly rel: string;
  readonly segs: readonly string[];
  readonly node: SceneAssemblyNode;
  readonly parent: Item | undefined;
  /** Depth-first spec order (0-based). */
  readonly index: number;
  /** The same item in the validator's shape. */
  readonly flat: Flat;
}

export interface OwnerIndex {
  readonly owner: SceneAssemblyNode;
  /** Every descendant, depth-first in spec order (at most `NODE_CAP`). */
  readonly items: readonly Item[];
  readonly byRel: ReadonlyMap<string, Item>;
  /** False when the cap cut the list. */
  readonly complete: boolean;
}

const shim = (n: SceneAssemblyNode): TNode => ({
  id: n.id,
  kind: "part",
  ptr: "",
  tags: n.tags,
  ...(n.type === undefined ? {} : { type: n.type }),
  role: n.role,
  progs: [],
  opaque: false,
  children: [],
  group: n.kind === "sub",
});

const typeOf = (n: TNode): string | undefined => n.type;

/** Lists the owner's descendants; bounded by `NODE_CAP` items and the shared `work`. */
export function indexOwner(owner: SceneAssemblyNode, work: Work): OwnerIndex {
  const items: Item[] = [];
  const byRel = new Map<string, Item>();
  let complete = true;
  const visit = (n: SceneAssemblyNode, parent: Item | undefined, segs: readonly string[]): void => {
    for (const c of n.children) {
      if (!complete) return;
      if (items.length >= NODE_CAP || !spend(work, 1)) {
        complete = false;
        return;
      }
      const s = [...segs, c.id];
      const rel = s.join("/");
      const item: Item = {
        rel,
        segs: s,
        node: c,
        parent,
        index: items.length,
        flat: { path: rel, segs: s, node: shim(c) },
      };
      items.push(item);
      byRel.set(rel, item);
      visit(c, item, s);
    }
  };
  visit(owner, undefined, []);
  return { owner, items, byRel, complete };
}

/** Selector evaluation over one owner, memoized by selector text. */
export class OwnerSelectors {
  private readonly memo = new Map<string, readonly Item[] | undefined>();

  constructor(
    readonly index: OwnerIndex,
    private readonly work: Work,
  ) {}

  /** Items the selector matches, in spec order; undefined when the work budget is spent. */
  match(sel: string): readonly Item[] | undefined {
    if (this.memo.has(sel)) return this.memo.get(sel);
    const p: ParsedSelector = parseSelector(sel);
    let out: readonly Item[] | undefined;
    if (spend(this.work, this.index.items.length * (1 + p.scopes.length) + 1)) {
      out = this.index.items.filter((it) => selects(p, it.flat, typeOf));
    }
    this.memo.set(sel, out);
    return out;
  }

  /**
   * The nodes a stage moves: the union of `parts` minus `except`, in spec order. A selected
   * sub-assembly moves as one unit with its subtree, so a descendant selected in the same stage
   * (for example by `**`) is not a separate mover. Undefined when the budget is spent.
   */
  stage(
    parts: readonly string[],
    except: readonly string[] | undefined,
  ): { readonly movers: readonly Item[]; readonly selected: readonly Item[] } | undefined {
    const sel = new Set<Item>();
    for (const s of parts.filter(isText).slice(0, MAX_SELECTORS)) {
      const m = this.match(s);
      if (m === undefined) return undefined;
      for (const it of m) sel.add(it);
    }
    const drop = new Set<Item>();
    for (const s of (except ?? []).filter(isText).slice(0, MAX_SELECTORS)) {
      const m = this.match(s);
      if (m === undefined) return undefined;
      for (const it of m) drop.add(it);
    }
    const selected = [...sel].filter((it) => !drop.has(it)).sort((a, b) => a.index - b.index);
    const have = new Set(selected);
    const movers = selected.filter((it) => {
      for (let p = it.parent; p !== undefined; p = p.parent) if (have.has(p)) return false;
      return true;
    });
    return { movers, selected };
  }
}

/** Whether `a` is `b` or lies below it. */
export function isWithin(a: Item, b: Item): boolean {
  for (let p: Item | undefined = a; p !== undefined; p = p.parent) if (p === b) return true;
  return false;
}
