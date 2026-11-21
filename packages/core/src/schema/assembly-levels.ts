/**
 * The ONE level machine of step actions (assemblies.md §7.2, §8.3), shared by validation
 * (`checkSteps` in `assembly-semantic.ts`, which reports) and the scene (`scene/assembly/plan.ts`,
 * which plans), so the two cannot diverge on:
 *   - the default program (`assemblies[].program` when it is of the action's kind, else the first
 *     of that kind; an implode reverses the program that exploded the target);
 *   - the timeline start level (`pose: exploded` = the root's default explode program at its last
 *     stage; a build starts at `to - advance`; an unbuild starts finished unless `pose: empty`);
 *   - the target level (`to`, `advance`, defaults), its range and direction checks, no-ops;
 *   - implicit access (§8.3): the access move of a nested target and its reversal.
 * Pure and total: nothing here throws or reports; callers turn outcomes into diagnostics.
 */
import type { ProgInfo } from "./assembly-tree.js";

export type LevelKind = "explode" | "implode" | "build" | "unbuild";

/** The part of an action the machine reads. */
export interface LevelAction {
  readonly to?: number;
  readonly advance?: number;
  readonly program?: string;
}

/** What the machine needs of the target node. */
export interface LevelNode {
  readonly progs: readonly ProgInfo[];
  readonly defaultProg?: string;
}

export type LevelFail =
  | {
      /** `named`: `program` is missing or of the wrong kind; `none`: no program of that kind. */
      readonly type: "program";
      readonly why: "named" | "none";
      readonly named?: string;
      readonly found?: ProgInfo;
      readonly ofKind: readonly ProgInfo[];
    }
  | { readonly type: "start"; readonly to: number; readonly advance: number }
  | {
      readonly type: "range";
      readonly to: number;
      readonly count: number;
      readonly cur: number;
      readonly via: "to" | "advance" | "default";
    }
  | {
      readonly type: "direction";
      readonly code:
        | "assembly/explode-backwards"
        | "assembly/implode-forwards"
        | "assembly/build-backwards"
        | "assembly/unbuild-forwards";
      readonly cur: number;
      readonly to: number;
      readonly via: "to" | "advance" | "default";
    };

export type Applied =
  | {
      readonly ok: true;
      readonly prog: ProgInfo;
      /** `<target>\0<program id>`. */
      readonly key: string;
      readonly from: number;
      readonly to: number;
      /** The level does not change (reported as `assembly/no-op-action`). */
      readonly noop: boolean;
    }
  | { readonly ok: false; readonly fail: LevelFail };

/** Target level of an action from level `cur` (§7.2), before any range check. */
export function targetLevel(
  kind: LevelKind,
  a: LevelAction,
  n: number,
  cur: number,
): { to: number; via: "to" | "advance" | "default" } {
  if (a.to !== undefined) return { to: a.to, via: "to" };
  if (kind === "explode") return { to: n, via: "default" };
  if (kind === "implode" || kind === "unbuild") return { to: 0, via: "default" };
  if (a.advance !== undefined) return { to: cur + a.advance, via: "advance" };
  return { to: cur + 1, via: "default" };
}

/** Range and direction check of a target level; undefined when valid (a no-op is valid). */
export function checkLevel(
  kind: LevelKind,
  a: LevelAction,
  n: number,
  cur: number,
): { to: number; fail?: LevelFail } {
  const { to, via } = targetLevel(kind, a, n, cur);
  if (to > n) return { to, fail: { type: "range", to, count: n, cur, via } };
  const code =
    (kind === "explode" && to < cur && "assembly/explode-backwards") ||
    (kind === "implode" && to > cur && "assembly/implode-forwards") ||
    (kind === "build" && to < cur && "assembly/build-backwards") ||
    (kind === "unbuild" && to > cur && "assembly/unbuild-forwards");
  if (code) return { to, fail: { type: "direction", code, cur, to, via } };
  return { to };
}

/** A nested target's access move through one ancestor (§8.3), supplied by the caller. */
export interface AccessStep {
  /** Level key of the ancestor's default program. */
  readonly key: string;
  /** Qualified program name (`ProgramLevel.program`). */
  readonly program: string;
  /** Owner path below the assembly root (empty: the root) and the program id. */
  readonly owner: string;
  readonly id: string;
  /** Stage of the ancestor's default program that moves the target (1-based). */
  readonly stage: number;
  /** Scene path of the node that stage moves on the way to the target. */
  readonly path: string;
}

export class LevelMachine {
  readonly levels = new Map<string, number>();
  /** Program that exploded each target (the default of its implode). */
  readonly exploded = new Map<string, string>();
  /** Moves opened by implicit access, by ancestor level key: scene paths. */
  readonly opened = new Map<string, Set<string>>();
  private readonly access = new Map<string, AccessStep[]>();

  /** Applies one explode/implode/build/unbuild action; levels move only when it is valid. */
  apply(
    a: LevelAction,
    kind: LevelKind,
    target: string,
    node: LevelNode,
    pose: string | undefined,
    isRoot: boolean,
  ): Applied {
    const want = kind === "explode" || kind === "implode" ? "explode" : "build";
    const ofKind = node.progs.filter((p) => p.kind === want);
    const dflt = ofKind.find((p) => p.id === node.defaultProg) ?? ofKind[0];
    let prog: ProgInfo | undefined;
    if (a.program !== undefined) {
      prog = node.progs.find((p) => p.id === a.program);
      if (prog === undefined || prog.kind !== want) {
        return {
          ok: false,
          fail: {
            type: "program",
            why: "named",
            named: a.program,
            ...(prog === undefined ? {} : { found: prog }),
            ofKind,
          },
        };
      }
    } else {
      if (dflt === undefined) {
        return { ok: false, fail: { type: "program", why: "none", ofKind } };
      }
      const last = kind === "implode" ? this.exploded.get(target) : undefined;
      prog = ofKind.find((p) => p.id === last) ?? dflt;
    }
    const key = `${target}\u0000${prog.id}`;
    let cur = this.levels.get(key);
    if (cur === undefined) {
      if (want === "explode") cur = isRoot && pose === "exploded" && prog === dflt ? prog.count : 0;
      else if (kind === "build") {
        cur = a.to !== undefined && a.advance !== undefined ? a.to - a.advance : 0;
        if (cur < 0) {
          return {
            ok: false,
            fail: { type: "start", to: a.to as number, advance: a.advance as number },
          };
        }
      } else cur = pose === "empty" ? 0 : prog.count;
    }
    const r = checkLevel(kind, a, prog.count, cur);
    if (r.fail !== undefined) return { ok: false, fail: r.fail };
    this.levels.set(key, r.to);
    this.opened.delete(key); // an explicit action on a program ends its implicit openings
    if (kind === "explode") this.exploded.set(target, prog.id);
    return { ok: true, prog, key, from: cur, to: r.to, noop: r.to === cur };
  }

  /**
   * Implicit access before exploding `target` (§8.3): for each ancestor whose default program
   * has not yet displaced the target, its access move (only that move) is opened. Returns the
   * steps that play, outermost first.
   */
  open(target: string, steps: readonly AccessStep[]): AccessStep[] {
    const played: AccessStep[] = [];
    for (const s of steps) {
      if ((this.levels.get(s.key) ?? 0) >= s.stage) continue;
      const set = this.opened.get(s.key) ?? new Set<string>();
      if (set.has(s.path)) continue;
      set.add(s.path);
      this.opened.set(s.key, set);
      played.push(s);
    }
    if (played.length > 0) this.access.set(target, played);
    return played;
  }

  /**
   * Reverses the access opened for `target` (its implode to 0): only openings still in place
   * are undone; an ancestor explicitly moved in between keeps its pose.
   */
  close(target: string): AccessStep[] {
    const list = this.access.get(target) ?? [];
    this.access.delete(target);
    const played: AccessStep[] = [];
    for (const s of list) {
      const set = this.opened.get(s.key);
      if (set === undefined || !set.delete(s.path)) continue;
      if (set.size === 0) this.opened.delete(s.key);
      played.push(s);
    }
    return played;
  }
}
