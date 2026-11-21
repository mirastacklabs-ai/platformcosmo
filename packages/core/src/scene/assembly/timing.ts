/**
 * Program time (Track A2, A2-3; design docs/design/assemblies.md §6.4, §7.1, §7.2).
 *
 * Stage timing, stagger order and the segment an action plays between two levels. The step
 * windows, compression and loop closure (§7.3, §7.4) are NOT computed here: assemblies and
 * figures share one computation (`stepWindows`, `fitDuration` and the step loop of
 * `planFigureSteps` in `scene/boards.ts`), which this module re-exports so both tracks name the
 * same functions.
 *
 * All times are seconds at speed 1, rounded to 4 decimals (`r4`); rounding of a scaled span
 * always floors (the plan loop does that), so a compressed action never overruns its window.
 */
import type { PartMove, ResolvedStage } from "../../contracts/index.js";
import type { SpecStage } from "../../schema/types.gen.js";
import { BEZIER, REVERSED_EASING, mirrorBezier, type Bezier } from "../boards.js";

export { fitDuration, stepViews, stepWindows, transitionOf, type StepWindow } from "../boards.js";

export const r4 = (v: number): number => Math.round(v * 10000) / 10000 + 0;

export type StageOrder = NonNullable<SpecStage["order"]>;

/** Start of stage `s` (§7.1): after the previous stage's end, or together with its start. */
export function stageStart(
  prev: { readonly start: number; readonly end: number } | undefined,
  st: Pick<SpecStage, "with" | "delay">,
): number {
  const base = prev === undefined ? 0 : st.with === "previous" ? prev.start : prev.end;
  return r4(base + (st.delay ?? 0));
}

/** Geometry the stagger order looks at (world boxes of the movers). */
export interface OrderKeys {
  /** Depth-first spec index. */
  readonly spec: number;
  /** Distance of the mover's centre from the owner's centre. */
  readonly radius: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Centre depth key `x + y + z` (larger = nearer the viewer). */
  readonly depth: number;
  readonly path: string;
}

/**
 * Rank of each mover within a stage (§6.4): `overrides[path].order` first (lower first; movers
 * without one follow), then the stage's `order`; ties by path. Returns the movers sorted.
 */
export function rankMovers<T>(
  movers: readonly T[],
  keys: (m: T) => OrderKeys,
  order: StageOrder,
  override: (m: T) => number | undefined,
): T[] {
  const cmpPath = (a: OrderKeys, b: OrderKeys): number =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  const base = (a: OrderKeys, b: OrderKeys): number => {
    switch (order) {
      case "outside-in":
        return b.radius - a.radius;
      case "inside-out":
        return a.radius - b.radius;
      case "top-down":
        return b.maxZ - a.maxZ;
      case "bottom-up":
        return a.minZ - b.minZ;
      case "front-first":
        return b.depth - a.depth;
      case "back-first":
        return a.depth - b.depth;
      default:
        return a.spec - b.spec;
    }
  };
  return [...movers].sort((x, y) => {
    const ox = override(x) ?? Infinity;
    const oy = override(y) ?? Infinity;
    if (ox !== oy) return ox < oy ? -1 : 1;
    const a = keys(x);
    const b = keys(y);
    return base(a, b) || cmpPath(a, b);
  });
}

/** What a segment needs of a stage or build step: its window and moves. */
export type TimedStage = Pick<ResolvedStage, "start" | "end" | "moves">;

/** One move of a segment: a `PartMove` with the curve it plays. */
export interface SegmentMove extends PartMove {
  readonly bezier: Bezier;
  /** True for a move played backwards (implode): offsets negated, curve mirrored. */
  readonly reversed: boolean;
}

export interface ProgramSegment {
  readonly kind: "explode" | "implode";
  readonly from: number;
  readonly to: number;
  /** Seconds at speed 1, uncompressed. */
  readonly length: number;
  /** Sorted by (start, path). */
  readonly moves: readonly SegmentMove[];
}

const byStartPath = (a: PartMove, b: PartMove): number =>
  a.start - b.start || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The part of an explode program between levels `from` and `to`, as one action plays it.
 * Explode of stages `from+1 .. to` is shifted so stage `from+1` starts at 0 (its own `delay` has
 * no effect); implode is the EXACT time reverse of the explode segment `to+1 .. from`: a move
 * `[st, en]` becomes `[L - en, L - st]`, its offset is negated and its easing mirrored (§7.2).
 */
export function programSegment(
  program: { readonly stages: readonly TimedStage[] },
  from: number,
  to: number,
  /** Node paths whose moves are left out (already opened by implicit access, §8.3). */
  exclude?: ReadonlySet<string>,
): ProgramSegment {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(program.stages.length, Math.max(from, to));
  const kind = from <= to ? "explode" : "implode";
  const stages: readonly TimedStage[] = program.stages.slice(lo, hi);
  if (stages.length === 0) return { kind, from, to, length: 0, moves: [] };
  const offset = (stages[0] as TimedStage).start;
  const forward = stages.flatMap((s) => s.moves).filter((m) => exclude?.has(m.path) !== true);
  const end =
    exclude === undefined || exclude.size === 0
      ? Math.max(...stages.map((s) => s.end))
      : Math.max(offset, ...forward.map((m) => m.start + m.duration));
  const length = r4(end - offset);
  const moves: SegmentMove[] =
    kind === "explode"
      ? forward.map((m) => ({
          ...m,
          start: r4(m.start - offset),
          bezier: BEZIER[m.easing],
          reversed: false,
        }))
      : forward.map((m) => ({
          ...m,
          offset: { x: -m.offset.x + 0, y: -m.offset.y + 0, z: -m.offset.z + 0 },
          start: r4(length - (m.start - offset + m.duration)),
          easing: REVERSED_EASING[m.easing],
          bezier: mirrorBezier(BEZIER[m.easing]),
          reversed: true,
        }));
  return { kind, from, to, length, moves: moves.sort(byStartPath) };
}

/** Level of every program after the last step differs from its base (§7.4): the loop must close. */
export function endsAwayFromBase(
  last: Readonly<Record<string, readonly { program: string; level: number }[]>> | undefined,
  base: Readonly<Record<string, readonly { program: string; level: number }[]>>,
): boolean {
  if (last === undefined) return false;
  for (const id of Object.keys(last)) {
    const b = new Map((base[id] ?? []).map((p) => [p.program, p.level]));
    for (const p of last[id] ?? []) if (p.level !== (b.get(p.program) ?? 0)) return true;
  }
  return false;
}
