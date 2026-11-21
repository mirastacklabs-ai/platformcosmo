import type {
  AssemblyDrawItem,
  AssemblyIdScheme,
  Axis,
  Box3,
  DepthEpoch,
  Diagnostic,
  PartMove,
  Projection,
  Vec3,
} from "../contracts/index.js";
import type { SpecEasing } from "../schema/types.gen.js";
import {
  EPS,
  MAX_UNION_BOXES,
  ZERO,
  behindAxis,
  blocksOf,
  containsClosed,
  enclosedThroughout,
  footprintInside,
  frontAxis,
  hideThroughout,
  insideUnion,
  interpenetrates,
  interpenetratesThroughout,
  mayInterpenetrate,
  mayInterpenetrateNeg,
  seatedOrEnclosed,
  shift,
  sweep,
  toBounds,
  fromBounds,
  unionBounds,
  weakBehind,
} from "./enclosure.js";
import type { Bounds, Vec } from "./enclosure.js";

/**
 * Depth epochs WITHOUT copies (assemblies §9.3–§9.5; track A1-2a). Input: the depth items of the
 * assembly layer (leaves, halves of split leaves, static scene objects) at rest, and the loop's
 * moves. Output: certified epochs, one DOM order valid for all of them, face-exit clips and
 * diagnostics. Pure, deterministic, never throws on bad input.
 *
 * Occluders. Only solids that FILL their `depthBox` (`solid && fills`: one box/plate/card
 * primitive) enclose, hide, clip, join blocks and order by weak-behind: every §9.5 rule reasons
 * about the box's faces, and a cylinder's or wedge's empty box corners would break it. Other
 * solids are ordered by separation or bisection only.
 *
 * Algorithm
 * 0. Clips (loop-wide, §9.5 validity, block level): a BLOCK is a set of touching occluders that
 *    never move relative to each other in the loop (one occluder is a block of one). An item gets
 *    a static clip at a block when its motion relative to the block over the whole loop is along
 *    one axis `u` (or none), its part below one exterior `+u` face plane F at its lowest position
 *    lies inside the union of the members, its part above F at its highest position meets no
 *    member, and at some time it crosses F. The clip solid is the member that carries F; the
 *    item is drawn after every member it meets (forced). `inserts` is preferred; at most one
 *    clip per item.
 * 1. Phases: the loop is split at every move start and end, every instant move, every presence
 *    change, and every instant a clipped item's `+u` face passes F (root finding): at or below F
 *    the item is inside the block and hidden (a `+u` face below F would project INTO the clip;
 *    §9.5's proof only covers side faces), beyond it the clip is exact. Over the phase-work
 *    budget, move start/end cuts are thinned (sound: a move partly inside a phase is active).
 * 2. Swept boxes: over `[ta, tb]` a move's offset stays on the segment between its values at `ta`
 *    and `tb` (monotonic easing), whose AABB is `I_m`. A leaf's swept box is its rest box at its
 *    pose at `ta` ⊕ the Minkowski sum of the ACTIVE moves' `I_m` (§9.3, sound for concurrent
 *    composed moves; `sweptBox`). Two refinements, both still sound: pair tests use the RELATIVE
 *    sweep of one item w.r.t. the other (moves shared through a common ancestor cancel exactly,
 *    moves of one side add their `I_m` with that side's sign), and moves with equal (t0, t1,
 *    easing) share one progress curve, so their signed sum is one segment before the Minkowski
 *    sum. Every test is monotone in the offset, so checking the interval box certifies every
 *    time inside it.
 * 3. Certification per pair whose swept screen rects overlap (sweep over screen x):
 *    clip relation (forced, every block member) → ring halves (forced: back < contents < front)
 *    → separating axis per sub-box (certified) → weak-behind of an occluder (forced: never past a
 *    visible face of the box, which covers enclosure in one solid and hidden-face exits) →
 *    at or below a clipped item's face plane F (certified) → if the pair does not move relative
 *    to itself, the static rule (§9.2, exact for the pose; containment and centre depth are
 *    heuristic edges; cached by relative offset) → else uncertain.
 *    Visibility per item: enclosed by an occluder or by a rigid union of touching occluders →
 *    hidden; crossing one visible face of an occluder or one exterior face of a rigid block
 *    without a valid clip there → hidden until clear (`assembly/clip-fallback`, never the
 *    static heuristic); else visible; else uncertain.
 * 4. Uncertain pairs or items bisect the interval (explicit stack, ≤ `maxBisectionDepth` levels,
 *    halves ≥ `minInterval`); only the uncertain pairs and items are re-tested in the halves. At
 *    the limit the pose at the midpoint time decides and the interval is approximate
 *    (`assembly/depth-approx`, naming the pair).
 * 5. One DOM order (Phase 1b has no copies): the union of every interval's edges. A pair whose
 *    two directions both occur would need a copy: a heuristic direction yields to a certified or
 *    forced one, else the shorter (then later) direction is dropped; its intervals are
 *    approximate (`assembly/depth-approx`, `copy: true`). Remaining cycles are broken by §9.3:
 *    heuristic edges first, then certified, then forced (only when a cycle has nothing else),
 *    each time the edge with the smallest centre-depth difference (ties by item keys); a dropped
 *    certified or forced edge is `assembly/depth-cycle` and makes its intervals approximate. A
 *    Kahn sort (lowest centre depth at t = 0, then key) emits the order.
 * 6. Epochs: adjacent intervals with the same visible set (hence the same order) merge. More than
 *    `maxEpochsPerTransition` epochs in one transition (a maximal run of moving phases): epochs are
 *    merged evenly and marked approximate.
 * `transit-collision`: sampled at interior times of every moving phase for pairs whose relative
 * sweep interpenetrates; an overlap that is neither an enclosure nor a one-face crossing (nor a
 * clip-block member) warns.
 *
 * Determinism: items are sorted by key and moves by (t0, t1, path, …) first; all iteration is by
 * index; every comparator compares raw values, then keys (strict weak orders). Tolerances:
 * `EPS = 1e-6` world units for every geometric comparison (closed: flush counts as inside /
 * separated) and `TIME_EPS = 1e-9` s for times. The static 1.1 path (`depth/index.ts`) keeps its
 * own 1e-9; here §9.5's 1e-6 is used throughout, so a pair two items apart by less than 1e-6 is
 * "touching" in epochs and "overlapping" in the 1.1 sort (it never matters for drawn boxes). Cost
 * is bounded by `DepthBudgets` (checked before the work they bound).
 */

export const TIME_EPS = 1e-9;

/** How often each phase is built (two clip passes, clip events, solving); see `spans`. */
const PHASE_PASSES = 4;

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/** One depth item (§9.1) at REST, world space. */
export interface DepthItemInput {
  /** Item key: leaf path, `path__back` / `path__front`, or a static scene object id. Unique. */
  readonly key: string;
  /**
   * Motion node of the item: moves on this path and on its ancestors (`a` is an ancestor of
   * `a/b`) move it. Absent for static scene objects and cable segments.
   */
  readonly path?: string;
  /** Leaf the item belongs to (halves share it); default `path`, else `key`. */
  readonly leaf?: string;
  /** World `depthBox` at rest (for a half: the box of that half). */
  readonly box: Box3;
  /**
   * Box-split half (`tray`): the half's primitive boxes, world, rest. Each is certified as an
   * ordinary box (A1-1 header). Default `[box]`.
   */
  readonly boxes?: readonly Box3[];
  /** `PartGeometry.solid` of an unsplit leaf (closed and opaque). */
  readonly solid?: boolean;
  /**
   * The solid FILLS its `depthBox`: its geometry is one `box`, `plate` or `card` primitive
   * whose box is the `depthBox` (default false). Only such solids enclose, hide, clip and order
   * by weak-behind (§9.5); every rule there reasons about the box's faces. A cylinder, shaft,
   * wedge, prism or multi-primitive solid leaves its box corners empty, so it is ordered by
   * separation or bisection only (and approximate where those cannot decide).
   */
  readonly fills?: boolean;
  /** Half of a `ring`: no box to certify, so halves get forced edges back < contents < front. */
  readonly ring?: "back" | "front";
  /** Spec `inserts` (`SceneAssemblyNode.inserts`): key of the solid item it is inserted into. */
  readonly inserts?: string;
  /**
   * Loop windows `[t0, t1]` in which the item exists (build appearance); default: always.
   * Outside them the item is hidden and takes no part.
   */
  readonly present?: readonly (readonly [number, number])[];
}

/**
 * One straight move in LOOP time (seconds, speed 1). The node's contribution to the
 * displacement of every item under it is `from` until `t0`, then follows the segment to `to`
 * with `easing`, and stays `to` after `t1` (an instant move, `t0 = t1`, jumps at `t0`). A leaf's
 * displacement is the sum over the moves of itself and its ancestors (§9.3). `toLoopMoves` builds
 * these from the contract's `PartMove`s.
 */
export interface LoopMove {
  readonly path: string;
  readonly t0: number;
  readonly t1: number;
  readonly from: Vec3;
  readonly to: Vec3;
  readonly easing: SpecEasing;
  /**
   * Optional CSS cubic-bezier `(x1, y1, x2, y2)` that REPLACES `easing`'s curve (the camera curve of
   * the loop closure, §7.4), so the certified and the drawn positions are the same function. All four
   * values must be in [0, 1] (monotone); `easing` stays set (keyword fallback for readers).
   */
  readonly bezier?: readonly [number, number, number, number];
}

export interface DepthBudgets {
  /** Depth items (`budget/assembly-parts` error beyond; nothing is ordered). */
  readonly maxItems: number;
  /** Moves, and presence windows over all items (`budget/time` error beyond; nothing is ordered). */
  readonly maxMoves: number;
  /**
   * Phases × the cost of building one (items + chain entries + moves + windows). Beyond it the
   * move boundaries are thinned (`budget/time` warning; sound, possibly more approximate).
   */
  readonly maxPhaseWork: number;
  /** §9.3: bisection levels per phase (6). */
  readonly maxBisectionDepth: number;
  /** §9.3: smallest half interval, seconds (1/120). */
  readonly minInterval: number;
  /** §13: epochs per transition (64). */
  readonly maxEpochsPerTransition: number;
  /**
   * Pair tests over the whole loop (`budget/time` warning beyond; the rest is approximate). The
   * default is for 300 items and scales with the item count, up to 5× at 2000 (§13).
   */
  readonly maxPairChecks: number;
  /** Intervals evaluated over the whole loop (same handling). */
  readonly maxIntervals: number;
  /** Pose tests for `transit-collision` sampling. */
  readonly maxCollisionSamples: number;
  /** Cycle-breaking edge drops, and their Tarjan work (× 1000), before the fallback release. */
  readonly maxCycleDrops: number;
  /** Diagnostics per code (one more summarizes the rest). */
  readonly maxDiagnosticsPerCode: number;
}

/**
 * Derived from §9.8 / §13 (300 leaves × 20 transitions in 2 s; 10 s at 2000 leaves). Measured
 * costs on the reference container: a pair test ≈ 0.5–0.7 µs all-in, a phase-build unit ≈ 5 ns,
 * an interval's fixed overhead ≈ 30 µs at 300 items, a collision pose test ≈ 1 µs. The §9.8 case
 * itself uses ≈ 0.2M pair checks and 40 intervals; a per-part staggered stress run ≈ 2.8M and 800.
 */
export const DEFAULT_DEPTH_BUDGETS: DepthBudgets = {
  maxItems: 6000,
  maxMoves: 50_000,
  maxPhaseWork: 20_000_000,
  maxBisectionDepth: 6,
  minInterval: 1 / 120,
  maxEpochsPerTransition: 64,
  maxPairChecks: 4_000_000,
  maxIntervals: 20_000,
  maxCollisionSamples: 1_000_000,
  maxCycleDrops: 10_000,
  maxDiagnosticsPerCode: 50,
};

export interface DepthEpochOptions {
  /** Screen mapping for the overlap tests; default tile 64 (`zScale = tileWidth / 2`). */
  readonly projection?: Pick<Projection, "tileWidth" | "zScale">;
  /** Clip path ids (A1-3 passes its `AssemblyIdScheme`); default `pc-clip-<item>-<copy>`. */
  readonly ids?: Pick<AssemblyIdScheme, "partClip">;
  /** JSON pointer of an item for diagnostics; default `""`. */
  readonly pointer?: (key: string) => string;
  readonly budgets?: Partial<DepthBudgets>;
  /** Interior samples per moving phase for `transit-collision` (default 7). */
  readonly collisionSamples?: number;
}

/**
 * A static face-exit or insert clip (§9.5), in the clipping SOLID's rest frame: the item is drawn
 * after the solid and clipped to the screen projection of `prism` (its footprint ⊥ `axis`,
 * extruded from the solid's `+axis` face outward). The emitter puts it on `partHost`, which
 * carries the solid's total track; the item's motion inside is relative to the solid.
 */
export interface DepthClip {
  readonly item: string;
  readonly solid: string;
  readonly axis: Axis;
  /** World box in the solid's rest frame; its projection (or the leaf primitive's silhouette over it) is the clip. */
  readonly prism: Box3;
  readonly clip: string;
}

export interface DepthEpochStats {
  readonly phases: number;
  readonly movingPhases: number;
  readonly intervals: number;
  readonly finalIntervals: number;
  readonly pairChecks: number;
  readonly bisections: number;
  readonly approximateIntervals: number;
  readonly collisionSamples: number;
  readonly cycleDrops: number;
  readonly copyConflicts: number;
}

export interface DepthEpochResult {
  /** Cover `[0, loop]`, time order; consecutive epochs differ in order. */
  readonly epochs: readonly DepthEpoch[];
  /** Sorted by item; `copies` is always 1 (no copies in Phase 1b). */
  readonly items: readonly AssemblyDrawItem[];
  /** Sorted by item. */
  readonly clips: readonly DepthClip[];
  /** The one DOM order (back to front) every epoch's `order` is a subsequence of. */
  readonly order: readonly string[];
  /** Maximal runs of moving phases. */
  readonly transitions: readonly { readonly t0: number; readonly t1: number }[];
  /**
   * Approximate time ranges, merged (finer than `epochs`: epochs merge by order, so an epoch's
   * flag covers all of it).
   */
  readonly approximate: readonly { readonly t0: number; readonly t1: number }[];
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: DepthEpochStats;
}

// ---------------------------------------------------------------------------------------------
// Easing and moves
// ---------------------------------------------------------------------------------------------

const BEZIER: Readonly<
  Record<Exclude<SpecEasing, "linear">, readonly [number, number, number, number]>
> = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

function bez(a: number, b: number, s: number): number {
  const u = 1 - s;
  return 3 * u * u * s * a + 3 * u * s * s * b + s * s * s;
}

/**
 * CSS easing progress for linear time `x` ∈ [0, 1] (clamped). Fixed 48-step bisection on the
 * curve parameter, so the result is deterministic and monotone non-decreasing in `x` (every CSS
 * keyword curve is monotone), which the swept-box proof needs.
 */
export function easeProgress(easing: SpecEasing, x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  if (easing === "linear") return x;
  return curveProgress(BEZIER[easing] ?? BEZIER.ease, x);
}

/** Progress of an arbitrary cubic-bezier (same bisection as `easeProgress`). */
export function curveProgress(c: readonly [number, number, number, number], x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 48; k++) {
    const mid = (lo + hi) / 2;
    if (bez(c[0], c[2], mid) < x) lo = mid;
    else hi = mid;
  }
  return bez(c[1], c[3], (lo + hi) / 2);
}

function progress(m: NMove, t: number): number {
  if (m.t1 - m.t0 <= TIME_EPS) return t >= m.t0 - TIME_EPS ? 1 : 0;
  const x = (t - m.t0) / (m.t1 - m.t0);
  return m.bezier === undefined ? easeProgress(m.easing, x) : curveProgress(m.bezier, x);
}

/** Contribution of one move at time `t`. */
export function moveOffsetAt(m: LoopMove, t: number): Vec3 {
  const nm = normMove(m);
  const p = progress(nm, t);
  return {
    x: nm.from[0] + (nm.to[0] - nm.from[0]) * p,
    y: nm.from[1] + (nm.to[1] - nm.from[1]) * p,
    z: nm.from[2] + (nm.to[2] - nm.from[2]) * p,
  };
}

/** True when `node` is `path` or one of its ancestors. */
export function movesPath(node: string, path: string): boolean {
  return (
    path === node ||
    (path.length > node.length && path.startsWith(node) && path[node.length] === "/")
  );
}

/** Displacement of the node `path` at time `t`: the sum over moves of it and its ancestors. */
export function displacementAt(
  moves: readonly LoopMove[],
  path: string | undefined,
  t: number,
): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  if (path === undefined) return { x, y, z };
  for (const m of moves) {
    if (!movesPath(m.path, path)) continue;
    const o = moveOffsetAt(m, t);
    x += o.x;
    y += o.y;
    z += o.z;
  }
  return { x, y, z };
}

/**
 * Swept box of §9.3 over `[ta, tb]`: the rest box at its pose at `ta` ⊕ the Minkowski sum of the
 * offset intervals `I_m = hull(o_m(ta), o_m(tb))` of the moves of `path` and its ancestors. Contains
 * every pose in the interval for any number of concurrent composed moves.
 */
export function sweptBox(
  box: Box3,
  path: string | undefined,
  moves: readonly LoopMove[],
  ta: number,
  tb: number,
): Box3 {
  const lo = [0, 0, 0];
  const hi = [0, 0, 0];
  if (path !== undefined) {
    for (const m of moves) {
      if (!movesPath(m.path, path)) continue;
      const a = moveOffsetAt(m, ta);
      const b = moveOffsetAt(m, tb);
      const av = [a.x, a.y, a.z];
      const bv = [b.x, b.y, b.z];
      for (let k = 0; k < 3; k++) {
        lo[k] = lo[k]! + Math.min(av[k]!, bv[k]!);
        hi[k] = hi[k]! + Math.max(av[k]!, bv[k]!);
      }
    }
  }
  return fromBounds(sweep(toBounds(box), lo as unknown as Vec, hi as unknown as Vec));
}

/** How a program segment's moves play (§7.2): explode out, implode back (time-mirrored), build in, unbuild out (time-mirrored). */
export type SegmentKind = "explode" | "implode" | "build" | "unbuild";

/**
 * Converts the contract's `PartMove`s of one program segment into loop moves. `at` is the loop
 * time of the segment start, `scale` its compression (§7.3), `length` its uncompressed length
 * (needed by the mirrored kinds). explode: `0 → offset`; implode: `0 → −offset`, played at
 * `length − start − duration`; build: `−offset → 0` (`offset` is seat − origin); unbuild:
 * `0 → −offset`, mirrored. Contributions persist after a move, so an explode followed by its
 * implode returns to rest. A base pose (spec `pose`) is an instant move at `t = 0`.
 */
export function toLoopMoves(
  moves: readonly PartMove[],
  segment: {
    readonly at: number;
    readonly kind: SegmentKind;
    readonly scale?: number;
    readonly length?: number;
  },
): LoopMove[] {
  const scale = segment.scale ?? 1;
  const length = segment.length ?? moves.reduce((m, mv) => Math.max(m, mv.start + mv.duration), 0);
  const zero: Vec3 = { x: 0, y: 0, z: 0 };
  const neg = (v: Vec3): Vec3 => ({ x: -v.x, y: -v.y, z: -v.z });
  const mirrored = segment.kind === "implode" || segment.kind === "unbuild";
  return moves.map((mv) => {
    const start = mirrored ? length - mv.start - mv.duration : mv.start;
    const t0 = segment.at + start * scale;
    const t1 = t0 + mv.duration * scale;
    const from = segment.kind === "build" ? neg(mv.offset) : zero;
    const to =
      segment.kind === "explode" ? mv.offset : segment.kind === "build" ? zero : neg(mv.offset);
    return { path: mv.path, t0, t1, from, to, easing: mv.easing };
  });
}

// ---------------------------------------------------------------------------------------------
// Normalized internal model
// ---------------------------------------------------------------------------------------------

interface NMove {
  readonly path: string;
  readonly t0: number;
  readonly t1: number;
  readonly from: Vec;
  readonly to: Vec;
  readonly easing: SpecEasing;
  readonly bezier?: readonly [number, number, number, number];
}

function normMove(m: LoopMove): NMove {
  return {
    path: m.path,
    t0: m.t0,
    t1: Math.max(m.t0, m.t1),
    from: [m.from.x, m.from.y, m.from.z],
    to: [m.to.x, m.to.y, m.to.z],
    easing: m.easing,
    ...(m.bezier === undefined ? {} : { bezier: m.bezier }),
  };
}

interface NItem {
  readonly key: string;
  readonly leaf: string;
  readonly path: string | undefined;
  readonly bbox: Bounds;
  readonly boxes: readonly Bounds[];
  /** Occluder: a solid that fills its depthBox (`solid && fills`); only these take part in §9.5. */
  readonly solid: boolean;
  /** A closed solid of any shape (spec `solid`), for the collision yield rule. */
  readonly closed: boolean;
  /** 0 none, 1 back, 2 front. */
  readonly ring: 0 | 1 | 2;
  readonly insertsKey: string | undefined;
  readonly present: readonly (readonly [number, number])[] | undefined;
}

const H = 0; // heuristic
const C = 1; // certified
const F = 2; // forced
type Strength = 0 | 1 | 2;
const STRENGTH_NAME = ["heuristic", "certified", "forced"] as const;

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteVec(v: Vec3 | undefined): boolean {
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function validBox(b: Box3 | undefined): boolean {
  return (
    !!b &&
    finiteVec(b.origin) &&
    finiteVec(b.size) &&
    b.size.x >= 0 &&
    b.size.y >= 0 &&
    b.size.z >= 0
  );
}

const EASINGS: ReadonlySet<string> = new Set([
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
]);

function vecCmp(a: Vec, b: Vec): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

class Diags {
  readonly list: Diagnostic[] = [];
  private readonly counts = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly suppressed = new Map<string, { severity: Diagnostic["severity"]; n: number }>();
  constructor(private readonly max: number) {}
  add(d: Diagnostic, dedupe?: string): void {
    if (dedupe !== undefined) {
      const k = `${d.code}\u0000${dedupe}`;
      if (this.seen.has(k)) return;
      this.seen.add(k);
    }
    const n = this.counts.get(d.code) ?? 0;
    this.counts.set(d.code, n + 1);
    if (n < this.max) {
      this.list.push(d);
      return;
    }
    const s = this.suppressed.get(d.code);
    if (s) s.n++;
    else this.suppressed.set(d.code, { severity: d.severity, n: 1 });
  }
  finish(): Diagnostic[] {
    for (const [code, s] of [...this.suppressed].sort((a, b) => cmpStr(a[0], b[0]))) {
      this.list.push({
        severity: s.severity,
        code,
        path: "",
        message: `${s.n} more ${code} diagnostic(s) suppressed.`,
        params: { suppressed: s.n },
      });
    }
    return this.list;
  }
}

// ---------------------------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------------------------

/**
 * Certified depth epochs for one loop (Phase 1b: no copies). `loop` is the loop length in
 * seconds at speed 1 (0 without steps: one static epoch).
 */
export function depthEpochs(
  items: readonly DepthItemInput[],
  moves: readonly LoopMove[],
  loop: number,
  options: DepthEpochOptions = {},
): DepthEpochResult {
  return new EpochSolver(items, moves, loop, options).run();
}

interface FinalInterval {
  readonly ta: number;
  readonly tb: number;
  approximate: boolean;
}

interface EdgeDir {
  strength: Strength;
  duration: number;
  first: number;
  diff: number;
  /** Flat `[ta, tb, ta, tb, …]`, time order, contiguous runs merged. */
  readonly occ: number[];
}

interface PairEdges {
  readonly i: number;
  readonly j: number;
  fwd?: EdgeDir; // i before j
  bwd?: EdgeDir; // j before i
}

interface Span {
  readonly a: number;
  readonly b: number;
  /** Set when the phase is built: a present item has an active move. */
  moving: boolean;
}

interface Phase {
  readonly a: number;
  readonly b: number;
  readonly present: Uint8Array;
  /** Per item: indices (into `moves`) of its active moves, ascending. */
  readonly act: (readonly number[])[];
  /** Per item: displacement from the moves that are constant in the phase. */
  readonly base: Float64Array;
  readonly activeMoves: readonly number[];
  /** Move index → slot in `activeMoves`, or -1. */
  readonly slot: Int32Array;
  readonly moving: boolean;
  /** Per item: union block id among rigidly connected touching solids (-1: not a solid). */
  block?: Int32Array;
  /** Members per block id (blocks of ≥ 2 only). */
  blockMembers?: Map<number, number[]>;
  /** Per block id: does the union fill its bounding box (one box occluder)? */
  blockFills?: Map<number, boolean>;
}

interface Pose {
  readonly ta: number;
  readonly tb: number;
  /** Per item displacement at `ta` (3 per item). */
  readonly disp: Float64Array;
  /** Per active slot increment `o(tb) − o(ta)` (3 per slot). */
  readonly inc: Float64Array;
}

interface Task {
  readonly ta: number;
  readonly tb: number;
  readonly depth: number;
  /** Pairs to test for order (flat i, j), or null for the full sweep. */
  readonly pairs: Int32Array | null;
  /** Items whose visibility is pending, or null for all present items. */
  readonly items: Int32Array | null;
  /** Candidate solids per pending item (from the parent). */
  readonly cands: Map<number, number[]> | null;
}

const NO_CLIP = -1;

class EpochSolver {
  private readonly diags: Diags;
  private readonly hw: number;
  private readonly hh: number;
  private readonly zs: number;
  private readonly pointer: (key: string) => string;
  private readonly clipId: (item: string, copy: number) => string;
  private readonly samples: number;

  private it: NItem[] = [];
  private mv: NMove[] = [];
  private chain: number[][] = [];
  /** Per move: synchronized group id (same t0, t1, easing). */
  private sync = new Int32Array(0);
  private loop = 0;
  private clipSolid = new Int32Array(0);
  /** Clip axis per item (0..2), -1 without a clip. */
  private clipAxis = new Int8Array(0);
  /** Per clipped item: the block members it meets (forced: drawn after each of them). */
  private clipMembers: number[][] = [];
  private clips: DepthClip[] = [];
  private depth0 = new Float64Array(0);

  private finals: FinalInterval[] = [];
  private pairEdges = new Map<number, PairEdges>();
  /** Per item hidden ranges, flat `[ta, tb, …]` merged. */
  private hidden: number[][] = [];
  private approxRanges: number[] = [];

  private pairChecks = 0;
  private intervals = 0;
  private bisections = 0;
  private collisionSamples = 0;
  private cycleDrops = 0;
  private copyConflicts = 0;
  private readonly inputNotArray: boolean;
  private degraded = false;
  private collided = new Set<number>();
  /** Rigid pair → [rx, ry, rz, code, from, to, strength] of its last static relation. */
  private rigidCache = new Map<number, number[]>();

  private readonly rawItems: readonly DepthItemInput[];
  private readonly rawMoves: readonly LoopMove[];
  private budgets: DepthBudgets;
  private readonly pairBudgetGiven: boolean;

  constructor(
    items: readonly DepthItemInput[],
    moves: readonly LoopMove[],
    private readonly rawLoop: number,
    options: DepthEpochOptions,
  ) {
    options = typeof options === "object" && options !== null ? options : {};
    this.budgets = { ...DEFAULT_DEPTH_BUDGETS, ...(options.budgets ?? {}) };
    this.pairBudgetGiven = options.budgets?.maxPairChecks !== undefined;
    this.rawItems = Array.isArray(items) ? items : [];
    this.rawMoves = Array.isArray(moves) ? moves : [];
    this.inputNotArray = !Array.isArray(items) || !Array.isArray(moves);
    this.diags = new Diags(this.budgets.maxDiagnosticsPerCode);
    const tw = options.projection?.tileWidth ?? 64;
    const zs = options.projection?.zScale ?? tw / 2;
    this.hw = Number.isFinite(tw) && tw > 0 ? tw / 2 : 32;
    this.hh = this.hw / 2;
    this.zs = Number.isFinite(zs) && zs > 0 ? zs : this.hw;
    this.pointer = options.pointer ?? (() => "");
    this.clipId =
      options.ids?.partClip.bind(options.ids) ??
      ((item: string, copy: number) => `pc-clip-${item.replace(/\//g, ".")}-${copy}`);
    const s = options.collisionSamples ?? 7;
    this.samples = Number.isInteger(s) && s >= 0 && s <= 64 ? s : 7;
  }

  // -------------------------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------------------------

  private bad(message: string, key?: string): void {
    this.diags.add({
      severity: "error",
      code: "assembly/depth-input",
      path: key !== undefined ? this.pointer(key) : "",
      message,
      ...(key !== undefined ? { params: { item: key } } : {}),
    });
  }

  private empty(): DepthEpochResult {
    return {
      epochs: [],
      items: [],
      clips: [],
      order: [],
      transitions: [],
      approximate: [],
      diagnostics: this.diags.finish(),
      stats: this.stats(),
    };
  }

  private stats(): DepthEpochStats {
    return {
      phases: this.statPhases,
      movingPhases: this.statMoving,
      intervals: this.intervals,
      finalIntervals: this.finals.length,
      pairChecks: this.pairChecks,
      bisections: this.bisections,
      approximateIntervals: this.finals.filter((f) => f.approximate).length,
      collisionSamples: this.collisionSamples,
      cycleDrops: this.cycleDrops,
      copyConflicts: this.copyConflicts,
    };
  }

  private statPhases = 0;
  /** Work of building one phase (items + chain entries + moves + presence windows). */
  private phaseCost = 1;
  private statMoving = 0;

  run(): DepthEpochResult {
    const b = this.budgets;
    // Caps before any allocation sized by the input.
    if (this.rawItems.length > b.maxItems) {
      this.diags.add({
        severity: "error",
        code: "budget/assembly-parts",
        path: "",
        message: `${this.rawItems.length} depth items exceed the limit of ${b.maxItems}; the assembly layer is not ordered.`,
        params: { items: this.rawItems.length, limit: b.maxItems },
      });
      return this.empty();
    }
    let rawWindows = 0;
    for (const x of this.rawItems) rawWindows += Array.isArray(x?.present) ? x.present.length : 0;
    if (this.rawMoves.length > b.maxMoves || rawWindows > b.maxMoves) {
      this.diags.add({
        severity: "error",
        code: "budget/time",
        path: "",
        message: `${this.rawMoves.length} moves and ${rawWindows} presence windows: more than ${b.maxMoves}; the assembly layer is not ordered.`,
        params: { moves: this.rawMoves.length, windows: rawWindows, limit: b.maxMoves },
      });
      return this.empty();
    }
    this.loop = Number.isFinite(this.rawLoop) && this.rawLoop > 0 ? this.rawLoop : 0;
    if (!(Number.isFinite(this.rawLoop) && this.rawLoop >= 0)) {
      this.bad(`loop length ${String(this.rawLoop)} is not a finite number ≥ 0; 0 is used.`);
    }
    if (this.inputNotArray) this.bad("depth items or moves are not arrays; they are ignored.");
    this.normalize();
    const n = this.it.length;
    if (!this.pairBudgetGiven) {
      // §13: 2 s at 300 leaves, 10 s at 2000. The default budget (4M pair checks at ~0.5 µs)
      // scales with the item count from 300 up to 5× at 2000 items.
      const f = Math.min(5, Math.max(1, n / 300));
      this.budgets = { ...this.budgets, maxPairChecks: Math.ceil(this.budgets.maxPairChecks * f) };
    }
    this.hidden = Array.from({ length: n }, () => []);
    this.clipSolid = new Int32Array(n).fill(NO_CLIP);
    this.clipAxis = new Int8Array(n).fill(-1);
    this.clipMembers = Array.from({ length: n }, () => []);
    this.depth0 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = this.dispAtTime(i, 0);
      const bb = shift(this.it[i]!.bbox, d);
      this.depth0[i] = (bb[0] + bb[3] + bb[1] + bb[4] + bb[2] + bb[5]) / 2;
    }
    let windows = 0;
    for (const x of this.it) windows += x.present?.length ?? 0;
    this.phaseCost = n + this.chain.reduce((s, c) => s + c.length, 0) + this.mv.length + windows;
    let spans = this.spans([]);
    this.assignClips(spans);
    const events = this.clipEvents(spans);
    if (events.length > 0) spans = this.spans(events);
    for (const sp of spans) this.solvePhase(this.phase(sp));
    this.statPhases = spans.length;
    this.statMoving = spans.filter((s) => s.moving).length;
    const order = this.domOrder();
    const { epochs, transitions } = this.buildEpochs(order, spans);
    const approximate: { t0: number; t1: number }[] = [];
    for (const f of this.finals) {
      if (!f.approximate) continue;
      const last = approximate[approximate.length - 1];
      if (last && f.ta <= last.t1 + TIME_EPS) last.t1 = Math.max(last.t1, f.tb);
      else approximate.push({ t0: f.ta, t1: f.tb });
    }
    return {
      epochs,
      items: this.drawItems(),
      clips: this.clips,
      order: order.map((i) => this.it[i]!.key),
      transitions,
      approximate,
      diagnostics: this.diags.finish(),
      stats: this.stats(),
    };
  }

  private normalize(): void {
    const seen = new Set<string>();
    const items: NItem[] = [];
    const optString = (v: unknown): boolean => v === undefined || typeof v === "string";
    for (const raw of this.rawItems as readonly unknown[]) {
      if (typeof raw !== "object" || raw === null) {
        this.bad("a depth item is not an object; it is ignored.");
        continue;
      }
      const it = raw as DepthItemInput;
      const key = it.key;
      if (typeof key !== "string" || key.length === 0) {
        this.bad("a depth item has no key; it is ignored.");
        continue;
      }
      if (seen.has(key)) {
        this.bad(`duplicate depth item "${key}"; the later one is ignored.`, key);
        continue;
      }
      if (
        !optString(it.path) ||
        !optString(it.leaf) ||
        !optString(it.inserts) ||
        (it.ring !== undefined && it.ring !== "back" && it.ring !== "front") ||
        (it.boxes !== undefined && !Array.isArray(it.boxes)) ||
        (it.present !== undefined &&
          (!Array.isArray(it.present) ||
            !it.present.every((w) => Array.isArray(w) && w.length === 2)))
      ) {
        this.bad(`depth item "${key}" has a field of the wrong type; it is ignored.`, key);
        continue;
      }
      if (!validBox(it.box) || (it.boxes !== undefined && !it.boxes.every(validBox))) {
        this.bad(`depth item "${key}" has a non-finite or negative box; it is ignored.`, key);
        continue;
      }
      seen.add(key);
      const boxes = (it.boxes && it.boxes.length > 0 ? it.boxes : [it.box]).map(toBounds);
      const ring = it.ring === "back" ? 1 : it.ring === "front" ? 2 : 0;
      let present: [number, number][] | undefined;
      if (it.present !== undefined) {
        const ws = it.present
          .filter((w) => Number.isFinite(w[0]) && Number.isFinite(w[1]) && w[1] >= w[0])
          .map((w) => [w[0], w[1]] as [number, number])
          .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
        if (ws.length !== it.present.length) {
          this.bad(`depth item "${key}" has an invalid presence window; it is ignored.`, key);
        }
        present = [];
        for (const w of ws) {
          const last = present[present.length - 1];
          if (last && w[0] <= last[1] + TIME_EPS) last[1] = Math.max(last[1], w[1]);
          else present.push(w);
        }
      }
      items.push({
        key,
        leaf: it.leaf ?? it.path ?? key,
        path: it.path,
        bbox:
          ring === 0 && boxes.length > 1
            ? unionBounds([toBounds(it.box), ...boxes])
            : toBounds(it.box),
        boxes,
        // Occluder: only a solid that fills its box takes part in §9.5 (E-Q02).
        solid: it.solid === true && it.fills === true && ring === 0 && boxes.length === 1,
        closed: it.solid === true && ring === 0 && boxes.length === 1,
        ring,
        insertsKey: it.inserts,
        present,
      });
    }
    items.sort((p, q) => cmpStr(p.key, q.key));
    this.it = items;

    const mv: NMove[] = [];
    for (const m of this.rawMoves as readonly (LoopMove | null | undefined)[]) {
      if (
        !m ||
        typeof m.path !== "string" ||
        !Number.isFinite(m.t0) ||
        !Number.isFinite(m.t1) ||
        m.t1 < m.t0 ||
        !finiteVec(m.from) ||
        !finiteVec(m.to) ||
        !EASINGS.has(m.easing) ||
        (m.bezier !== undefined &&
          !(
            Array.isArray(m.bezier) &&
            m.bezier.length === 4 &&
            m.bezier.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
          ))
      ) {
        this.bad(
          `a move${typeof m?.path === "string" ? ` of "${m.path}"` : ""} has invalid times, offsets or easing; it is ignored.`,
        );
        continue;
      }
      mv.push(normMove(m));
    }
    mv.sort(
      (p, q) =>
        p.t0 - q.t0 ||
        p.t1 - q.t1 ||
        cmpStr(p.path, q.path) ||
        cmpStr(p.easing, q.easing) ||
        vecCmp(p.from, q.from) ||
        vecCmp(p.to, q.to),
    );
    this.mv = mv;
    // Synchronized groups: equal (t0, t1, easing) → equal progress curve.
    const groups = new Map<string, number>();
    this.sync = Int32Array.from(mv, (m) => {
      const k = `${m.t0}|${m.t1}|${m.easing}|${m.bezier?.join(",") ?? ""}`;
      let g = groups.get(k);
      if (g === undefined) {
        g = groups.size;
        groups.set(k, g);
      }
      return g;
    });

    // Moves per node path, then per item through its ancestor chain (bounded by path length).
    const byPath = new Map<string, number[]>();
    mv.forEach((m, k) => {
      const l = byPath.get(m.path);
      if (l) l.push(k);
      else byPath.set(m.path, [k]);
    });
    this.chain = items.map((item) => {
      if (item.path === undefined) return [];
      const out: number[] = [];
      let p = item.path;
      for (;;) {
        const l = byPath.get(p);
        if (l) out.push(...l);
        const cut = p.lastIndexOf("/");
        if (cut <= 0) break;
        p = p.slice(0, cut);
      }
      return out.sort((a, b) => a - b);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Displacements
  // -------------------------------------------------------------------------------------------

  private contrib(m: NMove, t: number, out: number[] | Float64Array, o = 0): void {
    const p = progress(m, t);
    out[o] = m.from[0] + (m.to[0] - m.from[0]) * p;
    out[o + 1] = m.from[1] + (m.to[1] - m.from[1]) * p;
    out[o + 2] = m.from[2] + (m.to[2] - m.from[2]) * p;
  }

  private dispAtTime(i: number, t: number): Vec {
    const c = [0, 0, 0];
    const d = [0, 0, 0];
    for (const k of this.chain[i]!) {
      this.contrib(this.mv[k]!, t, c);
      d[0] = d[0]! + c[0]!;
      d[1] = d[1]! + c[1]!;
      d[2] = d[2]! + c[2]!;
    }
    return d as unknown as Vec;
  }

  // -------------------------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------------------------

  /**
   * Phase spans: the loop cut at every move start and end (optional cuts), every presence change
   * and every clip event (mandatory cuts). Phases are built one at a time (`phase`), each costing
   * about `n + Σ|chain| + moves + windows`; when all cuts together exceed `maxPhaseWork`, optional
   * cuts are thinned evenly (`budget/time`). That stays sound: a move that overlaps a phase only
   * in part is treated as active, and its offset is still monotone over the phase.
   */
  private spans(extra: readonly number[]): Span[] {
    const L = this.loop;
    const inside = (t: number): boolean => t > TIME_EPS && t < L - TIME_EPS;
    const must: number[] = [0, L];
    for (const t of extra) if (inside(t)) must.push(t);
    for (const item of this.it)
      for (const w of item.present ?? []) for (const t of w) if (inside(t)) must.push(t);
    const opt: number[] = [];
    for (const m of this.mv) {
      // An instant move (loop closure, base pose) jumps: a phase must never contain its time,
      // since the phase model needs every move constant or monotone across a phase (E-Q01).
      if (m.t1 - m.t0 <= TIME_EPS) {
        if (inside(m.t0)) must.push(m.t0);
        continue;
      }
      for (const t of [m.t0, m.t1]) if (inside(t)) opt.push(t);
    }
    const uniq = (list: number[]): number[] => {
      list.sort((a, b) => a - b);
      const out: number[] = [];
      for (const t of list)
        if (out.length === 0 || t - out[out.length - 1]! > TIME_EPS) out.push(t);
      return out;
    };
    const mustU = uniq(must);
    let optU = uniq(opt);
    // Every phase is built PHASE_PASSES times (two clip passes, clip events, solving).
    const cost = Math.max(1, this.phaseCost) * PHASE_PASSES;
    const cap = Math.max(1, Math.floor(this.budgets.maxPhaseWork / cost));
    if (mustU.length + optU.length - 1 > cap) {
      const keep = Math.max(0, cap - mustU.length + 1);
      const thinned: number[] = [];
      for (let q = 0; q < keep; q++) thinned.push(optU[Math.floor((q * optU.length) / keep)]!);
      this.diags.add({
        severity: "warning",
        code: "budget/time",
        path: "",
        message: `${mustU.length + optU.length - 1} depth phases exceed the work budget; move boundaries are thinned to ${mustU.length + thinned.length - 1} phases (more intervals may be approximate).`,
        params: { phases: mustU.length + optU.length - 1, kept: mustU.length + thinned.length - 1 },
      });
      optU = thinned;
    }
    const bp = uniq([...mustU, ...optU]);
    if (bp.length === 1) bp.push(bp[0]!); // loop 0: one static instant
    const out: Span[] = [];
    for (let s = 0; s + 1 < bp.length; s++) out.push({ a: bp[s]!, b: bp[s + 1]!, moving: false });
    return out;
  }

  /** Builds the per-phase data of one span (and records whether it moves). */
  private phase(span: Span): Phase {
    const { a, b } = span;
    const n = this.it.length;
    const M = this.mv.length;
    const mid = (a + b) / 2;
    const slot = new Int32Array(M).fill(-1);
    const activeMoves: number[] = [];
    for (let k = 0; k < M; k++) {
      const m = this.mv[k]!;
      if (m.t1 - m.t0 > TIME_EPS && m.t0 < b - TIME_EPS && m.t1 > a + TIME_EPS) {
        slot[k] = activeMoves.length;
        activeMoves.push(k);
      }
    }
    const present = new Uint8Array(n);
    const act: number[][] = [];
    const base = new Float64Array(3 * n);
    const c = [0, 0, 0];
    let moving = false;
    for (let i = 0; i < n; i++) {
      const w = this.it[i]!.present;
      present[i] = !w || w.some((x) => x[0] <= a + TIME_EPS && x[1] >= b - TIME_EPS) ? 1 : 0;
      const list: number[] = [];
      for (const k of this.chain[i]!) {
        if (slot[k]! >= 0) {
          list.push(k);
          continue;
        }
        this.contrib(this.mv[k]!, mid, c);
        base[3 * i] = base[3 * i]! + c[0]!;
        base[3 * i + 1] = base[3 * i + 1]! + c[1]!;
        base[3 * i + 2] = base[3 * i + 2]! + c[2]!;
      }
      act.push(list);
      if (present[i] && list.length > 0) moving = true;
    }
    span.moving = moving;
    return { a, b, present, act, base, activeMoves, slot, moving };
  }

  private pose(ph: Phase, ta: number, tb: number): Pose {
    const n = this.it.length;
    const S = ph.activeMoves.length;
    const at = new Float64Array(3 * S);
    const inc = new Float64Array(3 * S);
    const c = [0, 0, 0];
    for (let s = 0; s < S; s++) {
      const m = this.mv[ph.activeMoves[s]!]!;
      this.contrib(m, ta, at, 3 * s);
      this.contrib(m, tb, c);
      for (let k = 0; k < 3; k++) inc[3 * s + k] = c[k]! - at[3 * s + k]!;
    }
    const disp = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      let x = ph.base[3 * i]!;
      let y = ph.base[3 * i + 1]!;
      let z = ph.base[3 * i + 2]!;
      for (const k of ph.act[i]!) {
        const s = ph.slot[k]!;
        x += at[3 * s]!;
        y += at[3 * s + 1]!;
        z += at[3 * s + 2]!;
      }
      disp[3 * i] = x;
      disp[3 * i + 1] = y;
      disp[3 * i + 2] = z;
    }
    return { ta, tb, disp, inc };
  }

  /** Absolute swept bounds of item `i` over the pose interval. */
  private sweptOf(ph: Phase, p: Pose, i: number, b: Bounds): Bounds {
    this.accG.length = 0;
    this.accV.length = 0;
    for (const k of ph.act[i]!) this.accumulate(1, k, 3 * ph.slot[k]!, p);
    const lo = [p.disp[3 * i]!, p.disp[3 * i + 1]!, p.disp[3 * i + 2]!];
    const hi = [lo[0]!, lo[1]!, lo[2]!];
    this.spread(lo, hi);
    return [
      b[0] + lo[0]!,
      b[1] + lo[1]!,
      b[2] + lo[2]!,
      b[3] + hi[0]!,
      b[4] + hi[1]!,
      b[5] + hi[2]!,
    ];
  }

  private readonly rlo = [0, 0, 0];
  private readonly rhi = [0, 0, 0];
  private readonly plo: [number, number, number] = [0, 0, 0];
  private readonly phi: [number, number, number] = [0, 0, 0];
  /** Scratch: summed signed increments per synchronized move group. */
  private readonly accG: number[] = [];
  private readonly accV: number[] = [];

  /**
   * Moves with the same (t0, t1, easing) share one progress curve, so their signed sum is ONE
   * segment from 0 to the summed increment (exact). Different groups are independent and add
   * as a Minkowski sum (§9.3).
   */
  private accumulate(sign: number, move: number, s: number, p: Pose): void {
    const g = this.sync[move]!;
    let q = this.accG.indexOf(g);
    if (q < 0) {
      q = this.accG.length;
      this.accG.push(g);
      this.accV.push(0, 0, 0);
    }
    for (let k = 0; k < 3; k++) this.accV[3 * q + k] = this.accV[3 * q + k]! + sign * p.inc[s + k]!;
  }

  private spread(lo: number[], hi: number[]): void {
    for (let q = 0; q < this.accG.length; q++) {
      for (let k = 0; k < 3; k++) {
        const d = this.accV[3 * q + k]!;
        if (d < 0) lo[k] = lo[k]! + d;
        else hi[k] = hi[k]! + d;
      }
    }
  }

  /**
   * Relative displacement interval of item `i` with respect to item `j` over the pose interval,
   * into `rlo`/`rhi`. Shared active moves cancel; returns true when the pair is rigid (no relative
   * motion in the interval).
   */
  private rel(ph: Phase, p: Pose, i: number, j: number): boolean {
    const lo = this.rlo;
    const hi = this.rhi;
    for (let k = 0; k < 3; k++) lo[k] = hi[k] = p.disp[3 * i + k]! - p.disp[3 * j + k]!;
    const A = ph.act[i]!;
    const B = ph.act[j]!;
    this.accG.length = 0;
    this.accV.length = 0;
    let a = 0;
    let b = 0;
    while (a < A.length || b < B.length) {
      const ma = a < A.length ? A[a]! : Infinity;
      const mb = b < B.length ? B[b]! : Infinity;
      if (ma === mb) {
        a++;
        b++;
        continue;
      }
      const m = ma < mb ? ma : mb;
      if (ma < mb) a++;
      else b++;
      this.accumulate(ma < mb ? 1 : -1, m, 3 * ph.slot[m]!, p);
    }
    this.spread(lo, hi);
    return hi[0]! - lo[0]! <= 0 && hi[1]! - lo[1]! <= 0 && hi[2]! - lo[2]! <= 0;
  }

  // -------------------------------------------------------------------------------------------
  // Screen
  // -------------------------------------------------------------------------------------------

  private rect(b: Bounds, out: Float64Array, o: number): void {
    out[o] = (b[0] - b[4]) * this.hw;
    out[o + 1] = (b[3] - b[1]) * this.hw;
    out[o + 2] = (b[0] + b[1]) * this.hh - b[5] * this.zs;
    out[o + 3] = (b[3] + b[4]) * this.hh - b[2] * this.zs;
  }

  private screenOverlap(a: Bounds, b: Bounds): boolean {
    const SE = 1e-6;
    const ax0 = (a[0] - a[4]) * this.hw;
    const ax1 = (a[3] - a[1]) * this.hw;
    const bx0 = (b[0] - b[4]) * this.hw;
    const bx1 = (b[3] - b[1]) * this.hw;
    if (!(ax0 < bx1 - SE && bx0 < ax1 - SE)) return false;
    const ay0 = (a[0] + a[1]) * this.hh - a[5] * this.zs;
    const ay1 = (a[3] + a[4]) * this.hh - a[2] * this.zs;
    const by0 = (b[0] + b[1]) * this.hh - b[5] * this.zs;
    const by1 = (b[3] + b[4]) * this.hh - b[2] * this.zs;
    return ay0 < by1 - SE && by0 < ay1 - SE;
  }

  /**
   * Pairs (i < j) whose bounds overlap on screen, by a sweep over screen x. Stops at the pair
   * budget (returns null).
   */
  private screenPairs(idx: readonly number[], bounds: (i: number) => Bounds): number[] | null {
    const m = idx.length;
    const r = new Float64Array(4 * m);
    for (let a = 0; a < m; a++) this.rect(bounds(idx[a]!), r, 4 * a);
    const ord = Array.from({ length: m }, (_, a) => a).sort(
      (p, q) => r[4 * p]! - r[4 * q]! || idx[p]! - idx[q]!,
    );
    const out: number[] = [];
    const active: number[] = [];
    const SE = 1e-6;
    for (const a of ord) {
      const x0 = r[4 * a]!;
      let w = 0;
      for (const c of active) if (r[4 * c + 1]! > x0 + SE) active[w++] = c;
      active.length = w;
      for (const c of active) {
        if (!(r[4 * a + 2]! < r[4 * c + 3]! - SE && r[4 * c + 2]! < r[4 * a + 3]! - SE)) continue;
        if (r[4 * a]! >= r[4 * c + 1]! - SE) continue;
        if (++this.pairChecks > this.budgets.maxPairChecks) return null;
        const i = idx[a]!;
        const j = idx[c]!;
        if (i < j) out.push(i, j);
        else out.push(j, i);
      }
      active.push(a);
    }
    return out;
  }

  private overBudget(): void {
    if (this.degraded) return;
    this.degraded = true;
    this.diags.add({
      severity: "warning",
      code: "budget/time",
      path: "",
      message:
        "Depth certification exceeded its work budget; the remaining intervals use the order found so far and are approximate.",
      params: { pairChecks: this.pairChecks, intervals: this.intervals },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Clips (loop-wide, §9.5 validity rule, block level)
  // -------------------------------------------------------------------------------------------

  /**
   * Assigns at most one static clip per item, at the exit face of a BLOCK: touching solids that
   * never move relative to each other in the loop (one solid is a block of one). Candidates are
   * (item, solid) pairs whose loop-wide swept bounds overlap on screen and interpenetrate; their
   * loop-wide relative ranges are accumulated with ONE pose per phase (cost: phases × (items +
   * candidates), charged to the pair budget).
   */
  private assignClips(spans: readonly Span[]): void {
    const n = this.it.length;
    const keyIndex = new Map<string, number>();
    this.it.forEach((x, i) => keyIndex.set(x.key, i));
    const poses = (fn: (ph: Phase, p: Pose) => void): void => {
      for (const span of spans) {
        const ph = this.phase(span);
        fn(ph, this.pose(ph, ph.a, ph.b));
      }
    };
    // Loop-wide swept bounds per item.
    const lb: number[][] = this.it.map(() => [
      Infinity,
      Infinity,
      Infinity,
      -Infinity,
      -Infinity,
      -Infinity,
    ]);
    poses((ph, p) => {
      for (let i = 0; i < n; i++) {
        const b = this.sweptOf(ph, p, i, this.it[i]!.bbox);
        const l = lb[i]!;
        for (let k = 0; k < 3; k++) {
          if (b[k]! < l[k]!) l[k] = b[k]!;
          if (b[k + 3]! > l[k + 3]!) l[k + 3] = b[k + 3]!;
        }
      }
    });
    const loopBounds = lb as unknown as Bounds[];
    const pairs = this.screenPairs(
      Array.from({ length: n }, (_, i) => i),
      (i) => loopBounds[i]!,
    );
    if (pairs === null) {
      this.overBudget();
      return;
    }
    const disp0 = this.it.map((_, i) => this.dispAtTime(i, 0));
    const at0 = (i: number): Bounds => shift(this.it[i]!.bbox, disp0[i]!);
    // Loop blocks: solids touching at t = 0 and rigid with each other over the whole loop.
    const solidPairs: [number, number][] = [];
    for (let q = 0; q < pairs.length; q += 2) {
      const i = pairs[q]!;
      const j = pairs[q + 1]!;
      const I = this.it[i]!;
      const J = this.it[j]!;
      if (I.solid && J.solid && I.leaf !== J.leaf && this.motionAxes(i, j) === 0) {
        solidPairs.push([i, j]);
      }
    }
    const blockOf = blocksOf(
      n,
      solidPairs,
      this.it.map((_, i) => at0(i)),
    );
    const blockBox = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (!this.it[i]!.solid) continue;
      const b = at0(i);
      const cur = blockBox.get(blockOf[i]!);
      if (!cur) blockBox.set(blockOf[i]!, [...b]);
      else
        for (let k = 0; k < 3; k++) {
          cur[k] = Math.min(cur[k]!, b[k]!);
          cur[k + 3] = Math.max(cur[k + 3]!, b[k + 3]!);
        }
    }
    interface Cand {
      readonly p: number;
      readonly s: number;
      readonly lo: number[];
      readonly hi: number[];
      meets: boolean;
    }
    const cands: Cand[] = [];
    for (let q = 0; q < pairs.length; q += 2) {
      for (const [p, s] of [
        [pairs[q]!, pairs[q + 1]!],
        [pairs[q + 1]!, pairs[q]!],
      ] as const) {
        const P = this.it[p]!;
        const S = this.it[s]!;
        if (!S.solid || P.ring !== 0 || P.boxes.length !== 1 || P.leaf === S.leaf) continue;
        if (!interpenetrates(loopBounds[p]!, loopBounds[s]!)) continue;
        // Cheap pair-only filters first: at most one axis of relative motion, and the item's
        // footprint ⊥ that axis inside the block's bounding box (an explicit `inserts` target
        // always stays, so an invalid insert is reported).
        const axes = this.motionAxes(p, s);
        if (P.insertsKey !== S.key) {
          if (axes < 0) continue;
          // Rigid with each other over the loop: only a seated (interpenetrating) pair matters.
          if (axes === 0 && !interpenetrates(at0(p), at0(s))) continue;
          if (axes > 0) {
            const u = axes - 1;
            const bb = blockBox.get(blockOf[s]!)!;
            if (!footprintInside(at0(p), bb as unknown as Bounds, u)) continue;
          }
        }
        cands.push({
          p,
          s,
          lo: [Infinity, Infinity, Infinity],
          hi: [-Infinity, -Infinity, -Infinity],
          meets: false,
        });
      }
    }
    cands.sort((a, b) => a.p - b.p || a.s - b.s);
    if (cands.length * spans.length + this.pairChecks > this.budgets.maxPairChecks) {
      // No clips: crossings fall back to hidden-until-clear; ordering still runs.
      this.diags.add({
        severity: "warning",
        code: "budget/time",
        path: "",
        message: `${cands.length} clip candidates over ${spans.length} phases exceed the work budget; no face-exit clips are assigned.`,
        params: { candidates: cands.length, phases: spans.length },
      });
      return;
    }
    this.pairChecks += cands.length * spans.length;
    poses((ph, pose) => {
      for (const c of cands) {
        this.rel(ph, pose, c.p, c.s);
        for (let k = 0; k < 3; k++) {
          c.lo[k] = Math.min(c.lo[k]!, this.rlo[k]!);
          c.hi[k] = Math.max(c.hi[k]!, this.rhi[k]!);
        }
        if (!c.meets) {
          const lo: Vec = [this.rlo[0]!, this.rlo[1]!, this.rlo[2]!];
          const hi: Vec = [this.rhi[0]!, this.rhi[1]!, this.rhi[2]!];
          c.meets = mayInterpenetrate(this.it[c.p]!.bbox, this.it[c.s]!.bbox, lo, hi);
        }
      }
    });
    const byItem = new Map<number, Cand[]>();
    for (const c of cands) {
      const l = byItem.get(c.p);
      if (l) l.push(c);
      else byItem.set(c.p, [c]);
    }
    for (let p = 0; p < n; p++) {
      const P = this.it[p]!;
      const insertsIdx = P.insertsKey !== undefined ? keyIndex.get(P.insertsKey) : undefined;
      if (P.insertsKey !== undefined && (insertsIdx === undefined || !this.it[insertsIdx]!.solid)) {
        this.diags.add({
          severity: "info",
          code: "assembly/clip-fallback",
          path: this.pointer(P.key),
          message: `"${P.key}" inserts "${P.insertsKey}", which is not a solid depth item that fills its box; it is not clipped.`,
          params: { item: P.key, solid: P.insertsKey },
        });
      }
      // Group the solids this item meets by loop block; the inserts block goes first.
      const groups = new Map<number, Cand[]>();
      for (const c of byItem.get(p) ?? []) {
        if (!c.meets) continue;
        const g = groups.get(blockOf[c.s]!);
        if (g) g.push(c);
        else groups.set(blockOf[c.s]!, [c]);
      }
      const insertsBlock = insertsIdx !== undefined ? blockOf[insertsIdx] : undefined;
      const order = [...groups.keys()].sort(
        (a, b) => (a === insertsBlock ? 0 : 1) - (b === insertsBlock ? 0 : 1) || a - b,
      );
      let done = false;
      for (const g of order) {
        const members = groups.get(g)!;
        const clip = this.blockClip(p, members, disp0);
        if (clip) {
          this.clips.push(clip.clip);
          this.clipSolid[p] = clip.solid;
          this.clipAxis[p] = clip.u;
          this.clipMembers[p] = members.map((c) => c.s);
          done = true;
          break;
        }
      }
      if (!done && insertsIdx !== undefined && this.it[insertsIdx]!.solid) {
        // Report an invalid insert only if it ever reaches past a VISIBLE face of its solid:
        // hidden-face entries need no clip (weak-behind orders them exactly).
        const c = (byItem.get(p) ?? []).find((x) => x.s === insertsIdx);
        const S = this.it[insertsIdx]!.bbox;
        const visible =
          c !== undefined && [0, 1, 2].some((k) => P.bbox[k + 3]! + c.hi[k]! > S[k + 3]! + EPS);
        if (visible) {
          this.diags.add({
            severity: "info",
            code: "assembly/clip-fallback",
            path: this.pointer(P.key),
            message: `"${P.key}" is inserted in "${this.it[insertsIdx]!.key}" but no static clip at one exterior face of its block is valid (motion across the face's axis, or several faces crossed); it is hidden while it crosses a visible face.`,
            params: { item: P.key, solid: this.it[insertsIdx]!.key },
          });
        }
      }
    }
  }

  /**
   * Axes of p's motion relative to s over the whole loop (moves of only one of them with a
   * non-zero offset): 0 none (rigid), 1..3 one axis (x, y, z), -1 several.
   */
  private motionAxes(p: number, s: number): number {
    const A = this.chain[p]!;
    const B = this.chain[s]!;
    const axes = [false, false, false];
    let a = 0;
    let b = 0;
    while (a < A.length || b < B.length) {
      const ma = a < A.length ? A[a]! : Infinity;
      const mb = b < B.length ? B[b]! : Infinity;
      if (ma === mb) {
        a++;
        b++;
        continue;
      }
      const m = this.mv[ma < mb ? ma : mb]!;
      if (ma < mb) a++;
      else b++;
      for (let k = 0; k < 3; k++) if (Math.abs(m.to[k]! - m.from[k]!) > EPS) axes[k] = true;
    }
    const count = axes.filter(Boolean).length;
    return count === 0 ? 0 : count > 1 ? -1 : axes.indexOf(true) + 1;
  }

  /**
   * A valid static clip of item p at a loop-rigid block (§9.5, block level). In the frame of the
   * block (members at their constant relative offsets), with p's loop-wide relative range along
   * `u` being [uLo, uHi]: p moves relative to the block along `u` only (or not at all), and for
   * one exterior `+u` face plane F of the block
   *   - the part of p below F at its lowest position lies inside the union of the members (so p
   *     never reaches past a hidden face or out of the side, and its footprint is inside F),
   *   - the part of p above F at its highest position meets no member (F is exterior there),
   *   - p reaches past F at some time and is inside below F at some time.
   * Then the prism over p's footprint from F outward is exact while p's `+u` face is at or beyond
   * F (§9.5's side-face proof only uses the plane), and p is enclosed by the block while below.
   * The clip solid is the member that carries F over p's footprint (its track is the block's).
   */
  private blockClip(
    p: number,
    members: readonly { readonly s: number; readonly lo: number[]; readonly hi: number[] }[],
    disp0: readonly Vec[],
  ): { clip: DepthClip; solid: number; u: number } | undefined {
    if (members.length === 0 || members.length > MAX_UNION_BOXES) return undefined;
    const s0 = members[0]!.s;
    const axes = this.motionAxes(p, s0);
    if (axes < 0) return undefined;
    const lo = members[0]!.lo;
    const hi = members[0]!.hi;
    const r0: Vec = [
      disp0[p]![0] - disp0[s0]![0],
      disp0[p]![1] - disp0[s0]![1],
      disp0[p]![2] - disp0[s0]![2],
    ];
    const P = this.it[p]!.bbox;
    const P0 = shift(P, r0);
    const frame: Bounds[] = members.map((m) =>
      shift(this.it[m.s]!.bbox, [
        disp0[m.s]![0] - disp0[s0]![0],
        disp0[m.s]![1] - disp0[s0]![1],
        disp0[m.s]![2] - disp0[s0]![2],
      ]),
    );
    const overlaps = (a: Bounds, b: Bounds, u: number): boolean => {
      for (let j = 0; j < 3; j++) {
        if (j === u) continue;
        if (Math.min(a[j + 3]!, b[j + 3]!) - Math.max(a[j]!, b[j]!) <= EPS) return false;
      }
      return true;
    };
    for (const u of axes > 0 ? [axes - 1] : [0, 1, 2]) {
      const uLo = P[u]! + lo[u]!;
      const uHi = P[u + 3]! + hi[u]!;
      const planes = [
        ...new Set(frame.filter((b) => overlaps(b, P0, u)).map((b) => b[u + 3]!)),
      ].sort((a, b) => a - b);
      for (const F of planes) {
        if (!(uHi > F + EPS && uLo < F - EPS)) continue;
        const low = [...P0];
        low[u] = uLo;
        low[u + 3] = F;
        this.pairChecks += frame.length;
        if (!insideUnion(low as unknown as Bounds, frame)) continue;
        const high = [...P0];
        high[u] = F;
        high[u + 3] = uHi;
        if (frame.some((b) => interpenetrates(high as unknown as Bounds, b))) continue;
        const k = frame.findIndex((b) => Math.abs(b[u + 3]! - F) <= EPS && overlaps(b, P0, u));
        if (k < 0) continue;
        const M = members[k]!.s;
        // Prism in M's rest frame: the block frame shifted by M's offset from s0.
        const c: Vec = [
          disp0[M]![0] - disp0[s0]![0],
          disp0[M]![1] - disp0[s0]![1],
          disp0[M]![2] - disp0[s0]![2],
        ];
        const top = Math.max(uHi, F);
        const prism = [...P0];
        prism[u] = F;
        prism[u + 3] = top + Math.max(1, top - F);
        const item = this.it[p]!.key;
        return {
          clip: {
            item,
            solid: this.it[M]!.key,
            axis: (["x", "y", "z"] as const)[u]!,
            prism: fromBounds(shift(prism as unknown as Bounds, neg(c))),
            clip: this.clipId(item, 0),
          },
          solid: M,
          u,
        };
      }
    }
    return undefined;
  }

  /**
   * Times at which a clipped leaf's `+u` face passes its clip face (`p.max_u(t) = F(t)`): there
   * it switches between enclosed (hidden) and crossing (clipped, visible). When every relative
   * move along `u` active in the phase has the same sign, the gap is monotone and one bisection
   * from the end signs locates the single root; otherwise the phase is sampled (17 points) and
   * each sign change refined (60 steps on time). These are only extra phase breakpoints: every
   * interval is still certified, so a missed root costs bisection, never soundness. Bounded by
   * `maxCollisionSamples` evaluations (`budget/time` when hit).
   */
  private clipEvents(spans: readonly Span[]): number[] {
    const out: number[] = [];
    if (this.clips.length === 0) return out;
    let evals = 0;
    const cap = this.budgets.maxCollisionSamples;
    const keyIndex = new Map(this.it.map((x, i) => [x.key, i] as const));
    const clipped = this.clips.map((c) => {
      const p = keyIndex.get(c.item)!;
      return { p, s: this.clipSolid[p]!, u: this.clipAxis[p]! };
    });
    const refine = (f: (t: number) => number, a: number, b: number, fa: number): number => {
      let lo = a;
      let hi = b;
      const neg0 = fa < 0;
      for (let q = 0; q < 60; q++) {
        const mid = (lo + hi) / 2;
        if (f(mid) < 0 === neg0) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    for (const span of spans) {
      const ph = this.phase(span);
      for (const { p, s, u } of clipped) {
        if (evals > cap) {
          this.diags.add({
            severity: "warning",
            code: "budget/time",
            path: "",
            message:
              "Clip event search exceeded its work budget; the remaining clip switches are found by bisection (approximate near them).",
            params: { evaluations: evals },
          });
          return out;
        }
        const A = ph.act[p]!;
        const B = ph.act[s]!;
        if (A.length === B.length && A.every((m, k) => m === B[k])) continue; // no relative motion
        const P = this.it[p]!.bbox;
        const S = this.it[s]!.bbox;
        const f = (t: number): number => {
          evals++;
          return P[u + 3]! + this.dispAtTime(p, t)[u]! - (S[u + 3]! + this.dispAtTime(s, t)[u]!);
        };
        // Signs of the active relative moves along u (moves of only one side).
        let pos = false;
        let negS = false;
        const onlyIn = (X: readonly number[], Y: readonly number[], sign: number): void => {
          for (const m of X) {
            if (Y.includes(m)) continue;
            const d = sign * (this.mv[m]!.to[u]! - this.mv[m]!.from[u]!);
            if (d > EPS) pos = true;
            else if (d < -EPS) negS = true;
          }
        };
        onlyIn(A, B, 1);
        onlyIn(B, A, -1);
        if (!(pos && negS)) {
          const fa = f(ph.a);
          const fb = f(ph.b);
          if (fa < 0 !== fb < 0) out.push(refine(f, ph.a, ph.b, fa));
          continue;
        }
        const N = 16;
        let t0 = ph.a;
        let f0 = f(t0);
        for (let k = 1; k <= N; k++) {
          const t1 = ph.a + ((ph.b - ph.a) * k) / N;
          const f1 = f(t1);
          if (f0 < 0 !== f1 < 0) out.push(refine(f, t0, t1, f0));
          t0 = t1;
          f0 = f1;
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Pair relation
  // -------------------------------------------------------------------------------------------

  private eFrom = 0;
  private eTo = 0;
  private eStr: Strength = H;

  private edge(from: number, to: number, s: Strength): 1 {
    this.eFrom = from;
    this.eTo = to;
    this.eStr = s;
    return 1;
  }

  /**
   * Relation of i and j (i relative to j by [lo, hi]): 0 none, 1 edge (`eFrom`, `eTo`, `eStr`),
   * 2 uncertain. `rigid`: the offset is one point, so the static rule is exact.
   */
  private relate(i: number, j: number, lo: Vec, hi: Vec, rigid: boolean): 0 | 1 | 2 {
    const I = this.it[i]!;
    const J = this.it[j]!;
    if (!this.screenOverlap(sweep(I.bbox, lo, hi), J.bbox)) return 0;
    if (this.clipMembers[i]!.includes(j)) return this.edge(j, i, F);
    if (this.clipMembers[j]!.includes(i)) return this.edge(i, j, F);
    const sameLeaf = I.leaf === J.leaf;
    if (I.ring !== 0 && J.ring !== 0 && sameLeaf) {
      return I.ring === 1 ? this.edge(i, j, F) : this.edge(j, i, F);
    }
    if ((I.ring !== 0) !== (J.ring !== 0) && !sameLeaf) {
      // Ring half vs another item: bbox separation, else contents get back < q < front.
      const bh = behindAxis(I.bbox, J.bbox, hi) >= 0;
      const fr = frontAxis(I.bbox, J.bbox, lo) >= 0;
      if (bh !== fr) return bh ? this.edge(i, j, C) : this.edge(j, i, C);
      if (bh && fr) return 0;
      if (interpenetratesThroughout(I.bbox, J.bbox, lo, hi)) {
        const ringIdx = I.ring !== 0 ? i : j;
        const q = ringIdx === i ? j : i;
        return this.it[ringIdx]!.ring === 1 ? this.edge(ringIdx, q, F) : this.edge(q, ringIdx, F);
      }
      return rigid ? this.staticRule(i, j, lo) : 2;
    }
    // Separating axis over every screen-overlapping sub-box pair.
    let dir = 0;
    let unresolved = false;
    let conflict = false;
    for (const a of I.boxes) {
      const sa = sweep(a, lo, hi);
      for (const b of J.boxes) {
        if (I.boxes.length > 1 || J.boxes.length > 1) {
          if (!this.screenOverlap(sa, b)) continue;
        }
        const bh = behindAxis(a, b, hi) >= 0;
        const fr = frontAxis(a, b, lo) >= 0;
        if (bh && fr) continue;
        if (!bh && !fr) {
          unresolved = true;
          continue;
        }
        const d = bh ? 1 : -1;
        if (dir !== 0 && d !== dir) conflict = true;
        dir = d;
      }
    }
    if (!unresolved && !conflict) {
      if (dir === 0) return 0;
      return dir > 0 ? this.edge(i, j, C) : this.edge(j, i, C);
    }
    if (!sameLeaf) {
      if (J.solid && weakBehind(I.bbox, J.bbox, hi)) return this.edge(i, j, F);
      // j relative to i ranges over [-hi, -lo]: its upper end is -lo.
      if (I.solid && weakBehind(J.bbox, I.bbox, neg(lo))) return this.edge(j, i, F);
      if (this.blockWeakBehind(i, j, hi)) return this.edge(i, j, F);
      if (this.blockWeakBehind(j, i, neg(lo))) return this.edge(j, i, F);
      if (this.behindClipSolid(j, i)) return this.edge(j, i, C);
      if (this.behindClipSolid(i, j)) return this.edge(i, j, C);
    }
    return rigid ? this.staticRule(i, j, lo) : 2;
  }

  private curPh: Phase | undefined;
  private curPose: Pose | undefined;

  /**
   * Weak-behind a BLOCK that fills its bounding box (its union is one box occluder, e.g. a
   * housing split in two halves): `p` (relative to member `s`, upper offset `hi`) never reaches
   * past a visible face of that box, so `p` before every member is exact (as for one box).
   */
  private blockWeakBehind(p: number, s: number, hi: Vec): boolean {
    const ph = this.curPh;
    const pose = this.curPose;
    if (!ph?.block || !ph.blockMembers || !pose || !this.it[s]!.solid) return false;
    const b = ph.block[s]!;
    const members = b >= 0 ? ph.blockMembers.get(b) : undefined;
    if (!members || members.length > MAX_UNION_BOXES || members.includes(p)) return false;
    const frame = members.map((m) =>
      shift(this.it[m]!.bbox, [
        pose.disp[3 * m]! - pose.disp[3 * s]!,
        pose.disp[3 * m + 1]! - pose.disp[3 * s + 1]!,
        pose.disp[3 * m + 2]! - pose.disp[3 * s + 2]!,
      ]),
    );
    const ub = unionBounds(frame);
    let fills = ph.blockFills?.get(b);
    if (fills === undefined) {
      this.pairChecks += frame.length;
      fills = insideUnion(ub, frame);
      ph.blockFills?.set(b, fills);
    }
    return fills && weakBehind(this.it[p]!.bbox, ub, hi);
  }

  /**
   * `q` before `p` when `p` is clipped at face plane F (`+u` face of its clip solid `s`) and `q`
   * stays at or below F along `u` for the whole interval (`q.max_u ≤ F` in `s`'s frame): every
   * visible point of `p` lies beyond F, and the ray from such a point toward the viewer only
   * increases `u`, so it never meets `q`. A rod resting on a crank pin inside a block, the rod
   * leaving through the deck (clipped) and the crank through the bottom: crank < rod, exactly.
   */
  private behindClipSolid(q: number, p: number): boolean {
    const s = this.clipSolid[p]!;
    if (s < 0 || s === q || !this.curPh || !this.curPose) return false;
    if (this.clipMembers[p]!.includes(q)) return false; // members are forced already
    const u = this.clipAxis[p]!;
    this.rel(this.curPh, this.curPose, q, s);
    return this.it[q]!.bbox[u + 3]! + this.rhi[u]! <= this.it[s]!.bbox[u + 3]! + EPS;
  }

  /** §9.2 for one relative offset `r` (i in j's frame): separation, containment, centre depth. */
  private staticRule(i: number, j: number, r: Vec): 0 | 1 {
    const I = this.it[i]!;
    const J = this.it[j]!;
    let dir = 0;
    let conflict = false;
    let sep = true;
    for (const a0 of I.boxes) {
      const a = shift(a0, r);
      for (const b of J.boxes) {
        if ((I.boxes.length > 1 || J.boxes.length > 1) && !this.screenOverlap(a, b)) continue;
        const d = boxRel(a, b);
        if (d === 0) {
          sep = false;
          continue;
        }
        if (dir !== 0 && d !== dir) conflict = true;
        dir = d;
      }
    }
    if (sep && !conflict) {
      if (dir === 0) return 0;
      return dir > 0 ? this.edge(i, j, C) : this.edge(j, i, C);
    }
    const a = shift(I.bbox, r);
    const b = J.bbox;
    const d = boxRel(a, b);
    if (d !== 0) return d > 0 ? this.edge(i, j, H) : this.edge(j, i, H);
    const ab = containsClosed(a, b);
    const ba = containsClosed(b, a);
    if (ab && !ba) return this.edge(i, j, H); // container first, contents on top
    if (ba && !ab) return this.edge(j, i, H);
    const dk = a[0] + a[3] + a[1] + a[4] + a[2] + a[5] - (b[0] + b[3] + b[1] + b[4] + b[2] + b[5]);
    if (Math.abs(dk) <= EPS) return 0;
    return dk < 0 ? this.edge(i, j, H) : this.edge(j, i, H);
  }

  // -------------------------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------------------------

  private record(
    from: number,
    to: number,
    s: Strength,
    ta: number,
    tb: number,
    disp: Float64Array,
  ): void {
    const i = Math.min(from, to);
    const j = Math.max(from, to);
    const key = i * this.it.length + j;
    let pe = this.pairEdges.get(key);
    if (!pe) {
      pe = { i, j };
      this.pairEdges.set(key, pe);
    }
    const fwd = from === i;
    let d = fwd ? pe.fwd : pe.bwd;
    if (!d) {
      const A = shift(this.it[from]!.bbox, [
        disp[3 * from]!,
        disp[3 * from + 1]!,
        disp[3 * from + 2]!,
      ]);
      const B = shift(this.it[to]!.bbox, [disp[3 * to]!, disp[3 * to + 1]!, disp[3 * to + 2]!]);
      const diff =
        Math.abs(
          A[0] + A[3] + A[1] + A[4] + A[2] + A[5] - (B[0] + B[3] + B[1] + B[4] + B[2] + B[5]),
        ) / 2;
      d = { strength: s, duration: 0, first: ta, diff, occ: [] };
      if (fwd) pe.fwd = d;
      else pe.bwd = d;
    }
    if (s > d.strength) d.strength = s;
    d.duration += tb - ta;
    const o = d.occ;
    if (o.length > 0 && ta <= o[o.length - 1]! + TIME_EPS)
      o[o.length - 1] = Math.max(o[o.length - 1]!, tb);
    else o.push(ta, tb);
  }

  private hide(i: number, ta: number, tb: number): void {
    const h = this.hidden[i]!;
    if (h.length > 0 && ta <= h[h.length - 1]! + TIME_EPS)
      h[h.length - 1] = Math.max(h[h.length - 1]!, tb);
    else h.push(ta, tb);
  }

  // -------------------------------------------------------------------------------------------
  // Phase solving with bisection
  // -------------------------------------------------------------------------------------------

  private solvePhase(ph: Phase): void {
    // Items that do not exist in this phase (build appearance) are hidden and take no part.
    for (let i = 0; i < this.it.length; i++) if (!ph.present[i]) this.hide(i, ph.a, ph.b);
    const stack: Task[] = [{ ta: ph.a, tb: ph.b, depth: 0, pairs: null, items: null, cands: null }];
    while (stack.length > 0) {
      const task = stack.pop()!;
      if (this.degraded) {
        this.finals.push({ ta: task.ta, tb: task.tb, approximate: true });
        continue;
      }
      if (++this.intervals > this.budgets.maxIntervals) {
        this.overBudget();
        this.finals.push({ ta: task.ta, tb: task.tb, approximate: true });
        continue;
      }
      const res = this.evaluate(ph, task);
      if (res === null) {
        this.overBudget();
        this.finals.push({ ta: task.ta, tb: task.tb, approximate: true });
        continue;
      }
      const uncertain = res.pairs.length > 0 || res.items.length > 0;
      if (!uncertain) {
        this.finals.push({ ta: task.ta, tb: task.tb, approximate: false });
        continue;
      }
      const half = (task.tb - task.ta) / 2;
      if (
        task.depth < this.budgets.maxBisectionDepth &&
        half >= this.budgets.minInterval - TIME_EPS
      ) {
        this.bisections++;
        const mid = task.ta + half;
        const pairs = Int32Array.from(res.pairs);
        const items = Int32Array.from(res.items);
        stack.push({ ta: mid, tb: task.tb, depth: task.depth + 1, pairs, items, cands: res.cands });
        stack.push({ ta: task.ta, tb: mid, depth: task.depth + 1, pairs, items, cands: res.cands });
        continue;
      }
      this.resolveAtMidpoint(ph, task, res);
      this.finals.push({ ta: task.ta, tb: task.tb, approximate: true });
    }
  }

  /**
   * Tests one interval. Records certified edges and hidden ranges for the whole interval and
   * returns what stays uncertain (pairs flat, items, and their candidate solids).
   */
  private evaluate(
    ph: Phase,
    task: Task,
  ): { pairs: number[]; items: number[]; cands: Map<number, number[]> } | null {
    const { ta, tb } = task;
    const p = this.pose(ph, ta, tb);
    this.curPh = ph;
    this.curPose = p;
    const n = this.it.length;
    let pairs: Int32Array | number[];
    const full = task.pairs === null;
    if (full) {
      const idx: number[] = [];
      for (let i = 0; i < n; i++) if (ph.present[i]) idx.push(i);
      const sp = this.screenPairs(idx, (i) => this.sweptOf(ph, p, i, this.it[i]!.bbox));
      if (sp === null) return null;
      pairs = sp;
    } else {
      pairs = task.pairs!;
    }

    // Candidate solids per item (visibility) and order relations.
    const cands: Map<number, number[]> = full ? new Map() : (task.cands ?? new Map());
    const relEdges: number[] = []; // from, to, strength
    const unsure: number[] = [];
    if (full && !ph.block) {
      // Blocks first (relate() orders items against filled blocks): touching occluders that
      // do not move relative to each other in this phase.
      const rigidSolids: [number, number][] = [];
      for (let q = 0; q < pairs.length; q += 2) {
        const i = pairs[q]!;
        const j = pairs[q + 1]!;
        const I = this.it[i]!;
        const J = this.it[j]!;
        if (I.solid && J.solid && I.leaf !== J.leaf && this.rel(ph, p, i, j))
          rigidSolids.push([i, j]);
      }
      const solidBoxes = this.it.map((x, i) =>
        shift(x.bbox, [p.disp[3 * i]!, p.disp[3 * i + 1]!, p.disp[3 * i + 2]!]),
      );
      ph.block = blocksOf(n, rigidSolids, solidBoxes);
      for (let i = 0; i < n; i++) if (!this.it[i]!.solid) ph.block[i] = -1;
      ph.blockMembers = new Map();
      for (let i = 0; i < n; i++) if (ph.block[i]! >= 0) pushMap(ph.blockMembers, ph.block[i]!, i);
      for (const [b, m] of [...ph.blockMembers]) if (m.length < 2) ph.blockMembers.delete(b);
      ph.blockFills = new Map();
    }
    for (let q = 0; q < pairs.length; q += 2) {
      const i = pairs[q]!;
      const j = pairs[q + 1]!;
      if (!full && ++this.pairChecks > this.budgets.maxPairChecks) return null;
      const rigid = this.rel(ph, p, i, j);
      // Scratch copies (relate() may reuse rlo/rhi for a third item); no allocation per pair.
      const lo = this.plo;
      const hi = this.phi;
      for (let k = 0; k < 3; k++) {
        lo[k] = this.rlo[k]!;
        hi[k] = this.rhi[k]!;
      }
      const I = this.it[i]!;
      const J = this.it[j]!;
      if (full && I.leaf !== J.leaf) {
        if (J.solid && this.meets(i, J.bbox, lo, hi, false)) pushMap(cands, i, j);
        if (I.solid && J.boxes.some((b) => mayInterpenetrateNeg(b, I.bbox, lo, hi)))
          pushMap(cands, j, i);
      }
      // A rigid pair's relation depends only on the pair and its relative offset (clipped items
      // excepted: `behindClipSolid` looks at a third item), so it is cached by exact offset.
      // (Nor members of a multi-member block: block weak-behind looks at the other members.)
      const inBlock = (x: number): boolean =>
        !!ph.blockMembers && ph.block![x]! >= 0 && ph.blockMembers.has(ph.block![x]!);
      const cacheable =
        rigid && this.clipSolid[i]! < 0 && this.clipSolid[j]! < 0 && !inBlock(i) && !inBlock(j);
      const key = i * n + j;
      const hit = cacheable ? this.rigidCache.get(key) : undefined;
      let r: 0 | 1 | 2;
      if (hit && hit[0] === lo[0] && hit[1] === lo[1] && hit[2] === lo[2]) {
        r = hit[3] as 0 | 1;
        if (r === 1) relEdges.push(hit[4]!, hit[5]!, hit[6]!);
      } else {
        r = this.relate(i, j, lo, hi, rigid);
        if (r === 1) relEdges.push(this.eFrom, this.eTo, this.eStr);
        if (cacheable && r !== 2)
          this.rigidCache.set(key, [lo[0], lo[1], lo[2], r, this.eFrom, this.eTo, this.eStr]);
      }
      if (r === 2) unsure.push(i, j);
      if (full && ph.moving && !rigid) this.collisions(i, j, lo, hi, ta, tb);
    }
    if (full) for (const l of cands.values()) l.sort((a, b) => a - b);

    // Visibility.
    const status = new Int8Array(n); // 0 visible, 1 hidden, 2 uncertain
    const visItems: number[] = [];
    if (task.items === null) {
      for (const i of cands.keys()) visItems.push(i);
      visItems.sort((a, b) => a - b);
    } else {
      visItems.push(...task.items);
    }
    const unsureItems: number[] = [];
    for (const i of visItems) {
      const st = this.visibility(ph, p, i, cands.get(i) ?? [], false);
      status[i] = st;
      if (st === 1) this.hide(i, ta, tb);
      else if (st === 2) unsureItems.push(i);
    }

    // Edges between items that can be visible here; uncertain pairs with a hidden item drop out.
    // Items not pending here were decided visible by an ancestor interval (hidden ones dropped out).
    const pending = task.items === null ? null : new Uint8Array(n);
    if (pending) for (const i of task.items!) pending[i] = 1;
    const known = (i: number): number => (pending === null || pending[i] ? status[i]! : 0);
    for (let q = 0; q < relEdges.length; q += 3) {
      const a = relEdges[q]!;
      const b = relEdges[q + 1]!;
      if (known(a) === 1 || known(b) === 1) continue;
      this.record(a, b, relEdges[q + 2] as Strength, ta, tb, p.disp);
    }
    const outPairs: number[] = [];
    for (let q = 0; q < unsure.length; q += 2) {
      const i = unsure[q]!;
      const j = unsure[q + 1]!;
      if (known(i) === 1 || known(j) === 1) continue;
      outPairs.push(i, j);
    }
    // Items of uncertain visibility go down with their candidate solids; their certified order
    // edges were recorded above for the whole interval (conservative: they also cover sub-ranges
    // in which the item turns out hidden).
    const outCands = new Map<number, number[]>();
    for (const i of unsureItems) outCands.set(i, cands.get(i) ?? []);
    return { pairs: outPairs, items: unsureItems, cands: outCands };
  }

  /**
   * Visibility of item i over the pose interval against its candidate occluders: 0 visible, 1
   * hidden, 2 uncertain. `exact`: the pose is a point (midpoint resolution), never uncertain.
   * Every occluder i interpenetrates is resolved one of four ways: i's clip block (exact while i
   * is beyond the clip face, hidden while inside), an exact pair order (weak-behind either way),
   * a block decision (members of a rigid group of ≥ 2: enclosed, block crossing), or hiding i
   * with `assembly/clip-fallback`. Nothing is left to the static heuristic.
   */
  private visibility(
    ph: Phase,
    p: Pose,
    i: number,
    cands: readonly number[],
    exact: boolean,
  ): 0 | 1 | 2 {
    const P = this.it[i]!.bbox;
    const iSolid = this.it[i]!.solid;
    let unsure = false;
    const ok = new Set<number>();
    const members = this.clipMembers[i]!;
    if (members.length > 0 && cands.some((s) => members.includes(s))) {
      // The clip is exact only while the leaf's +u face is at or beyond the clip face F (§9.5's
      // proof covers side-face points; a +u face still below F would project inside the clip).
      // Fully below F the leaf lies inside the block and is hidden. The switch instants are
      // phase breakpoints (`clipEvents`), so both sides certify.
      const M = this.clipSolid[i]!;
      const u = this.clipAxis[i]!;
      this.rel(ph, p, i, M);
      const lo = exact ? mid3(this.rlo, this.rhi) : this.rlo;
      const hi = exact ? lo : this.rhi;
      const F = this.it[M]!.bbox[u + 3]!;
      if (P[u + 3]! + hi[u]! <= F + EPS) return 1;
      if (P[u + 3]! + lo[u]! >= F - EPS) for (const m of members) ok.add(m);
      else unsure = true;
    }
    const block = ph.block;
    const grouped = (s: number): boolean =>
      !!block && block[s]! >= 0 && cands.some((t) => t !== s && block[t] === block[s]);
    for (const s of cands) {
      if (members.includes(s)) continue;
      this.rel(ph, p, i, s);
      const lo: Vec = exact ? mid3(this.rlo, this.rhi) : [this.rlo[0]!, this.rlo[1]!, this.rlo[2]!];
      const hi: Vec = exact ? lo : [this.rhi[0]!, this.rhi[1]!, this.rhi[2]!];
      const S = this.it[s]!.bbox;
      if (!this.meets(i, S, lo, hi, false)) {
        ok.add(s); // no sub-box of i meets s here
        continue;
      }
      const nlo = neg(hi);
      const nhi = neg(lo);
      // s crossing, enclosed in, or weak-behind the occluder i (or i's filled block): the pair
      // is decided from s's side (s hidden, or drawn before i), i stays as it is.
      if (
        iSolid &&
        (hideThroughout(S, P, nlo, nhi) ||
          weakBehind(S, P, nhi) ||
          this.clipMembers[s]!.includes(i) ||
          this.blockWeakBehind(s, i, nhi))
      ) {
        ok.add(s);
        continue;
      }
      if (grouped(s)) continue; // a member of a block among the candidates: decided below
      if (hideThroughout(P, S, lo, hi)) {
        if (!enclosedThroughout(P, S, lo, hi)) this.fallback(i, s);
        return 1;
      }
      // i never past a visible face of s: i before s, exact.
      if (weakBehind(P, S, hi)) {
        ok.add(s);
        continue;
      }
      if (this.meets(i, S, lo, hi, true)) {
        if (!this.yields(i, s)) {
          ok.add(s); // a collision of two occluders: the other one is hidden
          continue;
        }
        this.fallback(i, s);
        return 1;
      }
      if (!exact) unsure = true;
    }
    // Blocks of touching occluders rigid in this phase, with ≥ 2 candidate members.
    if (block && cands.length >= 2) {
      const groups = new Map<number, number[]>();
      for (const s of cands) {
        const b = block[s]!;
        if (b < 0) continue;
        pushMap(groups, b, s);
      }
      for (const group of [...groups.keys()].sort((a, b) => a - b).map((k) => groups.get(k)!)) {
        if (group.length < 2) {
          // Alone among the candidates: decide it as a single occluder.
          const s = group[0]!;
          if (ok.has(s) || members.includes(s)) continue;
          this.rel(ph, p, i, s);
          const lo: Vec = exact
            ? mid3(this.rlo, this.rhi)
            : [this.rlo[0]!, this.rlo[1]!, this.rlo[2]!];
          const hi: Vec = exact ? lo : [this.rhi[0]!, this.rhi[1]!, this.rhi[2]!];
          if (this.meets(i, this.it[s]!.bbox, lo, hi, true) && this.yields(i, s)) {
            this.fallback(i, s);
            return 1;
          }
          if (!exact && !ok.has(s)) unsure = true;
          continue;
        }
        if (group.length > MAX_UNION_BOXES) {
          if (group.every((m) => ok.has(m))) continue;
          this.fallback(i, group[0]!);
          return 1;
        }
        const s0 = group[0]!;
        this.rel(ph, p, i, s0);
        const lo: Vec = exact
          ? mid3(this.rlo, this.rhi)
          : [this.rlo[0]!, this.rlo[1]!, this.rlo[2]!];
        const hi: Vec = exact ? lo : [this.rhi[0]!, this.rhi[1]!, this.rhi[2]!];
        const frame: Bounds[] = group.map((m) =>
          shift(this.it[m]!.bbox, [
            p.disp[3 * m]! - p.disp[3 * s0]!,
            p.disp[3 * m + 1]! - p.disp[3 * s0 + 1]!,
            p.disp[3 * m + 2]! - p.disp[3 * s0 + 2]!,
          ]),
        );
        this.pairChecks += frame.length;
        const sw = sweep(P, lo, hi);
        if (insideUnion(sw, frame)) return 1; // enclosed by the union
        if (group.every((m) => ok.has(m))) continue;
        // A block that fills its bounding box is one box occluder: weak-behind it (never past a
        // visible face: inside, or out through hidden faces) draws i before every member, exact.
        const ub = unionBounds(frame);
        if (insideUnion(ub, frame) && weakBehind(P, ub, hi)) continue;
        // Crossing ONE exterior face of the block without a valid clip at it: hidden until
        // clear (§9.5 fallback).
        if (this.blockCross(sw, [P[0] + hi[0], P[1] + hi[1], P[2] + hi[2]], frame)) {
          this.fallback(i, s0);
          return 1;
        }
        // Interpenetrating a member otherwise (several faces): hidden while it lasts.
        const k = group.findIndex(
          (m, q) => !ok.has(m) && this.meets(i, frame[q]!, lo, hi, true) && this.yields(i, m),
        );
        if (k >= 0) {
          this.fallback(i, group[k]!);
          return 1;
        }
        if (!exact) unsure = true;
      }
    }
    return unsure && !exact ? 2 : 0;
  }

  /**
   * The item crosses ONE exterior `+k` face of a block (members `frame`) at every time of the
   * interval: for a face plane F of a member over the swept box's footprint, the swept box's part
   * below F lies inside the union, its part above F meets no member, and the item never clears F
   * (`mins` = its min corner at the top of its range). Then every pose is a crossing at F (or
   * enclosed below it): hidden without a clip (§9.5 fallback).
   */
  private blockCross(sw: Bounds, mins: readonly number[], frame: readonly Bounds[]): boolean {
    for (let k = 0; k < 3; k++) {
      const planes = new Set<number>();
      for (const b of frame) {
        let over = true;
        for (let j = 0; j < 3; j++) {
          if (j !== k && Math.min(b[j + 3]!, sw[j + 3]!) - Math.max(b[j]!, sw[j]!) <= EPS) {
            over = false;
          }
        }
        if (over) planes.add(b[k + 3]!);
      }
      for (const F of [...planes].sort((a, b) => a - b)) {
        if (!(mins[k]! < F - EPS) || !(sw[k + 3]! > F + EPS)) continue;
        const below = [...sw];
        below[k + 3] = F;
        this.pairChecks += frame.length; // union tests are charged to the pair budget
        if (!insideUnion(below as unknown as Bounds, frame)) continue;
        const above = [...sw];
        above[k] = F;
        if (frame.some((b) => interpenetrates(above as unknown as Bounds, b))) continue;
        return true;
      }
    }
    return false;
  }

  /**
   * Whether item i (any of its sub-boxes, offset by [lo, hi] relative to `s`) may meet the box
   * `S` (`throughout`: interpenetrates it at every offset).
   */
  private meets(i: number, S: Bounds, lo: Vec, hi: Vec, throughout: boolean): boolean {
    for (const b of this.it[i]!.boxes) {
      if (throughout ? interpenetratesThroughout(b, S, lo, hi) : mayInterpenetrate(b, S, lo, hi)) {
        return true;
      }
    }
    return false;
  }

  /**
   * In a collision no rule orders (neither crosses one face of the other), the item that goes
   * through yields and is hidden: a non-occluder always; between occluders the smaller box
   * (then the smaller key), so exactly one of the two hides.
   */
  private yields(i: number, s: number): boolean {
    const I = this.it[i]!;
    if (!I.closed) return true; // not a closed solid (tray half, sprite, …)
    const vol = (b: Bounds): number => (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
    const vi = vol(I.bbox);
    const vs = vol(this.it[s]!.bbox);
    return vi !== vs ? vi < vs : cmpStr(I.key, this.it[s]!.key) < 0;
  }

  /**
   * At time t, box `a` of item i (in j's rest frame) is enclosed by, crossing one
   * exterior face of, or weak-behind the filled block that j belongs to in the current phase: a
   * seated relation with the block, not a collision with the member.
   */
  private seatedInBlock(i: number, j: number, a: Bounds, t: number): boolean {
    const ph = this.curPh;
    if (!ph?.block || !ph.blockMembers || !this.it[j]!.solid) return false;
    const members = ph.blockMembers.get(ph.block[j]!);
    if (!members || members.includes(i) || members.length > MAX_UNION_BOXES) return false;
    // `a` is in j's rest frame (collision sampling works relative to j).
    const dj = this.dispAtTime(j, t);
    const frame = members.map((m) => {
      const dm = this.dispAtTime(m, t);
      return shift(this.it[m]!.bbox, [dm[0] - dj[0], dm[1] - dj[1], dm[2] - dj[2]]);
    });
    this.pairChecks += frame.length;
    if (insideUnion(a, frame)) return true;
    if (this.blockCross(a, [a[0], a[1], a[2]], frame)) return true;
    const ub = unionBounds(frame);
    return insideUnion(ub, frame) && weakBehind(a, ub, ZERO);
  }

  private fallback(i: number, s: number): void {
    this.diags.add(
      {
        severity: "info",
        code: "assembly/clip-fallback",
        path: this.pointer(this.it[i]!.key),
        message: `"${this.it[i]!.key}" crosses a visible face of "${this.it[s]!.key}"${this.clipMembers[i]!.length > 0 ? " (outside its clip block)" : ""} without a valid static clip; it is hidden until clear.`,
        params: { item: this.it[i]!.key, solid: this.it[s]!.key },
      },
      `${i}/${s}`,
    );
  }

  /** Bisection limit: the static rule at the midpoint decides (§9.3 step 3); approximate. */
  private resolveAtMidpoint(
    ph: Phase,
    task: Task,
    res: { pairs: number[]; items: number[]; cands: Map<number, number[]> },
  ): void {
    const { ta, tb } = task;
    // The pose AT the midpoint time (a point interval), not the middle of the swept interval.
    const p = this.pose(ph, (ta + tb) / 2, (ta + tb) / 2);
    this.curPh = ph;
    this.curPose = p;
    const hiddenNow = new Set<number>();
    for (const i of res.items) {
      const st = this.visibility(ph, p, i, res.cands.get(i) ?? [], true);
      if (st === 1) {
        hiddenNow.add(i);
        this.hide(i, ta, tb);
      }
      this.diags.add(
        {
          severity: "info",
          code: "assembly/depth-approx",
          path: this.pointer(this.it[i]!.key),
          message: `Visibility of "${this.it[i]!.key}" could not be certified in [${fmtT(ta)}, ${fmtT(tb)}] s; the midpoint pose decides.`,
          params: { item: this.it[i]!.key, t0: ta, t1: tb },
        },
        `v${i}`,
      );
    }
    for (let q = 0; q < res.pairs.length; q += 2) {
      const i = res.pairs[q]!;
      const j = res.pairs[q + 1]!;
      if (hiddenNow.has(i) || hiddenNow.has(j)) continue;
      this.rel(ph, p, i, j);
      const r = mid3(this.rlo, this.rhi);
      const rr = this.relate(i, j, r, r, true);
      if (rr === 1) this.record(this.eFrom, this.eTo, H, ta, tb, p.disp);
      this.diags.add(
        {
          severity: "info",
          code: "assembly/depth-approx",
          path: this.pointer(this.it[i]!.key),
          message: `Depth order of "${this.it[i]!.key}" and "${this.it[j]!.key}" could not be certified in [${fmtT(ta)}, ${fmtT(tb)}] s; the static rule at the midpoint decides.`,
          params: { items: [this.it[i]!.key, this.it[j]!.key], t0: ta, t1: tb },
        },
        `p${i}/${j}`,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // transit-collision
  // -------------------------------------------------------------------------------------------

  private collisions(i: number, j: number, lo: Vec, hi: Vec, ta: number, tb: number): void {
    const I = this.it[i]!;
    const J = this.it[j]!;
    if (this.samples === 0 || I.leaf === J.leaf || I.ring !== 0 || J.ring !== 0) return;
    if (this.clipMembers[i]!.includes(j) || this.clipMembers[j]!.includes(i)) return;
    const key = i * this.it.length + j;
    if (this.collided.has(key)) return;
    let possible = false;
    for (const a of I.boxes)
      for (const b of J.boxes) if (mayInterpenetrate(a, b, lo, hi)) possible = true;
    if (!possible) return;
    for (let k = 1; k <= this.samples; k++) {
      if (++this.collisionSamples > this.budgets.maxCollisionSamples) return;
      const t = ta + ((tb - ta) * k) / (this.samples + 1);
      const di = this.dispAtTime(i, t);
      const dj = this.dispAtTime(j, t);
      const r: Vec = [di[0] - dj[0], di[1] - dj[1], di[2] - dj[2]];
      for (const a0 of I.boxes) {
        const a = shift(a0, r);
        for (const b of J.boxes) {
          if (!interpenetrates(a, b) || seatedOrEnclosed(a, b)) continue;
          if (this.seatedInBlock(i, j, a, t)) continue;
          // (j's box in i's rest frame, for j seated in i's block)
          if (this.seatedInBlock(j, i, shift(b, neg(r)), t)) continue;
          this.collided.add(key);
          this.diags.add({
            severity: "warning",
            code: "assembly/transit-collision",
            path: this.pointer(I.key),
            message: `"${I.key}" and "${J.key}" interpenetrate at t = ${fmtT(t)} s during a transition.`,
            params: { items: [I.key, J.key], t },
          });
          return;
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // One DOM order
  // -------------------------------------------------------------------------------------------

  private markApprox(occ: readonly number[]): void {
    for (let q = 0; q < occ.length; q += 2) this.approxRanges.push(occ[q]!, occ[q + 1]!);
  }

  private domOrder(): number[] {
    const n = this.it.length;
    const efrom: number[] = [];
    const eto: number[] = [];
    const estr: Strength[] = [];
    const ediff: number[] = [];
    const eocc: (readonly number[])[] = [];
    const keys = [...this.pairEdges.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      const pe = this.pairEdges.get(k)!;
      let keep: { d: EdgeDir; fwd: boolean } | undefined;
      if (pe.fwd && pe.bwd) {
        const f = pe.fwd;
        const b = pe.bwd;
        // A heuristic direction always yields to a certified or forced one; between two
        // certified/forced directions the one held longer wins (strength does not decide which
        // epochs are right), then the earlier one.
        const hf = f.strength === H ? 0 : 1;
        const hb = b.strength === H ? 0 : 1;
        const fwin =
          hf !== hb
            ? hf > hb
            : f.duration !== b.duration
              ? f.duration > b.duration
              : f.first <= b.first;
        const lose = fwin ? b : f;
        keep = fwin ? { d: f, fwd: true } : { d: b, fwd: false };
        this.copyConflicts++;
        if (lose.strength >= C) {
          this.markApprox(lose.occ);
          const [x, y] = fwin ? [pe.j, pe.i] : [pe.i, pe.j];
          this.diags.add(
            {
              severity: "info",
              code: "assembly/depth-approx",
              path: this.pointer(this.it[x]!.key),
              message: `"${this.it[x]!.key}" must be drawn before "${this.it[y]!.key}" in some epochs and after it in others; that needs a depth copy (Phase 3), so those epochs are approximate.`,
              params: { items: [this.it[x]!.key, this.it[y]!.key], copy: true },
            },
            `c${pe.i}/${pe.j}`,
          );
        }
      } else if (pe.fwd) keep = { d: pe.fwd, fwd: true };
      else if (pe.bwd) keep = { d: pe.bwd, fwd: false };
      if (!keep) continue;
      efrom.push(keep.fwd ? pe.i : pe.j);
      eto.push(keep.fwd ? pe.j : pe.i);
      estr.push(keep.d.strength);
      ediff.push(keep.d.diff);
      eocc.push(keep.d.occ);
    }
    const E = efrom.length;
    const out: number[][] = Array.from({ length: n }, () => []);
    const inn: number[][] = Array.from({ length: n }, () => []);
    const indeg = new Int32Array(n);
    for (let e = 0; e < E; e++) {
      out[efrom[e]!]!.push(e);
      inn[eto[e]!]!.push(e);
      indeg[eto[e]!]!++;
    }
    const dropped = new Uint8Array(E);
    const placed = new Uint8Array(n);
    const better = (x: number, y: number): boolean => {
      const d = this.depth0[x]! - this.depth0[y]!;
      if (d !== 0) return d < 0; // raw values: a strict weak order (E-Q06)
      return cmpStr(this.it[x]!.key, this.it[y]!.key) < 0;
    };
    const heap = new MinHeap(better);
    for (let i = 0; i < n; i++) if (indeg[i] === 0) heap.push(i);
    const order: number[] = [];
    // Total order on edges: weakest first, then smallest centre-depth difference, then keys.
    const edgeLess = (a: number, b: number): boolean => {
      if (estr[a] !== estr[b]) return estr[a]! < estr[b]!;
      if (ediff[a] !== ediff[b]) return ediff[a]! < ediff[b]!;
      const f = cmpStr(this.it[efrom[a]!]!.key, this.it[efrom[b]!]!.key);
      if (f !== 0) return f < 0;
      return cmpStr(this.it[eto[a]!]!.key, this.it[eto[b]!]!.key) < 0;
    };
    let released = false;
    let tarjanWork = 0;
    const drop = (e: number): void => {
      dropped[e] = 1;
      this.cycleDrops++;
      const t = eto[e]!;
      indeg[t]!--;
      if (indeg[t] === 0 && !placed[t]) heap.push(t);
      if (estr[e]! >= C) {
        this.markApprox(eocc[e]!);
        this.diags.add(
          {
            severity: "info",
            code: "assembly/depth-cycle",
            path: this.pointer(this.it[efrom[e]!]!.key),
            message: `The ${STRENGTH_NAME[estr[e]!]} depth edge "${this.it[efrom[e]!]!.key}" before "${this.it[t]!.key}" was dropped to break a cycle; the affected epochs are approximate.`,
            params: {
              from: this.it[efrom[e]!]!.key,
              to: this.it[t]!.key,
              strength: STRENGTH_NAME[estr[e]!],
            },
          },
          `${e}`,
        );
      }
    };
    while (order.length < n) {
      if (heap.size() === 0) {
        if (
          this.cycleDrops >= this.budgets.maxCycleDrops ||
          tarjanWork > this.budgets.maxCycleDrops * 1000
        ) {
          // Fallback release: the best unplaced node; its pending in-edges are ignored.
          let pick = -1;
          for (let i = 0; i < n; i++) if (!placed[i] && (pick < 0 || better(i, pick))) pick = i;
          if (!released) {
            released = true;
            this.overBudget();
          }
          for (const e of inn[pick]!) {
            if (!dropped[e] && !placed[efrom[e]!]) {
              dropped[e] = 1;
              this.markApprox(eocc[e]!);
            }
          }
          indeg[pick] = 0;
          heap.push(pick);
        } else {
          tarjanWork += n + E;
          for (const e of this.cycleEdges(n, E, efrom, eto, out, dropped, placed, edgeLess)) {
            drop(e);
          }
          continue;
        }
      }
      const v = heap.pop()!;
      if (placed[v]) continue;
      placed[v] = 1;
      order.push(v);
      for (const e of out[v]!) {
        if (dropped[e]) continue;
        const t = eto[e]!;
        indeg[t]!--;
        if (indeg[t] === 0 && !placed[t]) heap.push(t);
      }
    }
    return order;
  }

  /**
   * One edge to drop per nontrivial strongly connected component of the unplaced graph
   * (iterative Tarjan): the least by (strength, centre-depth difference, keys).
   */
  private cycleEdges(
    n: number,
    E: number,
    efrom: readonly number[],
    eto: readonly number[],
    out: readonly (readonly number[])[],
    dropped: Uint8Array,
    placed: Uint8Array,
    less: (a: number, b: number) => boolean,
  ): number[] {
    const index = new Int32Array(n).fill(-1);
    const low = new Int32Array(n);
    const onStack = new Uint8Array(n);
    const comp = new Int32Array(n).fill(-1);
    const st: number[] = [];
    let counter = 0;
    let comps = 0;
    const callV: number[] = [];
    const callE: number[] = [];
    for (let root = 0; root < n; root++) {
      if (placed[root] || index[root] !== -1) continue;
      callV.push(root);
      callE.push(0);
      index[root] = low[root] = counter++;
      st.push(root);
      onStack[root] = 1;
      while (callV.length > 0) {
        const v = callV[callV.length - 1]!;
        const ei = callE[callE.length - 1]!;
        const edges = out[v]!;
        if (ei < edges.length) {
          callE[callE.length - 1] = ei + 1;
          const e = edges[ei]!;
          if (dropped[e]) continue;
          const w = eto[e]!;
          if (placed[w]) continue;
          if (index[w] === -1) {
            index[w] = low[w] = counter++;
            st.push(w);
            onStack[w] = 1;
            callV.push(w);
            callE.push(0);
          } else if (onStack[w]) {
            low[v] = Math.min(low[v]!, index[w]!);
          }
          continue;
        }
        callV.pop();
        callE.pop();
        if (callV.length > 0) {
          const u = callV[callV.length - 1]!;
          low[u] = Math.min(low[u]!, low[v]!);
        }
        if (low[v] === index[v]) {
          for (;;) {
            const w = st.pop()!;
            onStack[w] = 0;
            comp[w] = comps;
            if (w === v) break;
          }
          comps++;
        }
      }
    }
    const best = new Map<number, number>();
    for (let e = 0; e < E; e++) {
      if (dropped[e]) continue;
      const a = efrom[e]!;
      const b = eto[e]!;
      if (placed[a] || placed[b] || comp[a] !== comp[b]) continue;
      const c = comp[a]!;
      const cur = best.get(c);
      if (cur === undefined || less(e, cur)) best.set(c, e);
    }
    return [...best.entries()].sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  }

  // -------------------------------------------------------------------------------------------
  // Epochs
  // -------------------------------------------------------------------------------------------

  /**
   * Epochs from the final intervals: runs of equal visibility, merged per transition beyond the
   * cap. Two streaming passes over the visibility toggles, so memory is O(items + intervals),
   * never intervals × items.
   */
  private buildEpochs(
    order: readonly number[],
    spans: readonly Span[],
  ): { epochs: DepthEpoch[]; transitions: { t0: number; t1: number }[] } {
    const F_ = this.finals;
    const K = F_.length;
    const n = this.it.length;
    const firstAfter = (t: number): number => {
      let lo = 0;
      let hi = K;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (F_[m]!.tb > t + TIME_EPS) hi = m;
        else lo = m + 1;
      }
      return lo;
    };
    // Final intervals [k0, k1) overlapping the open range (a, b); a zero-length loop has one
    // instant interval that every range covers.
    const range = (a: number, b: number): [number, number] => {
      if (this.loop === 0) return K > 0 ? [0, 1] : [0, 0];
      const k0 = firstAfter(a);
      let k1 = k0;
      while (k1 < K && F_[k1]!.ta < b - TIME_EPS) k1++;
      return [k0, k1];
    };
    for (let q = 0; q < this.approxRanges.length; q += 2) {
      const [k0, k1] = range(this.approxRanges[q]!, this.approxRanges[q + 1]!);
      for (let k = k0; k < k1; k++) F_[k]!.approximate = true;
    }
    // Hidden ranges per item (merged, time order) → toggles per final interval.
    const toggles: number[][] = Array.from({ length: K + 1 }, () => []);
    for (let i = 0; i < n; i++) {
      const h = this.hidden[i]!;
      for (let q = 0; q < h.length; q += 2) {
        const [k0, k1] = range(h[q]!, h[q + 1]!);
        if (k1 > k0) {
          toggles[k0]!.push(i);
          toggles[k1]!.push(i);
        }
      }
    }
    // Pass 1: runs of equal visibility (boundaries only). A toggle pair at one k cancels.
    const parity = new Uint8Array(n);
    const changes = (k: number): boolean => {
      const list = toggles[k]!;
      for (const i of list) parity[i] = parity[i]! ^ 1;
      let changed = false;
      for (const i of list) {
        if (parity[i]) changed = true;
        parity[i] = 0;
      }
      return changed;
    };
    interface Run {
      readonly k0: number;
      k1: number;
      approximate: boolean;
    }
    const runs: Run[] = [];
    for (let k = 0; k < K; k++) {
      if (runs.length === 0 || changes(k)) {
        runs.push({ k0: k, k1: k + 1, approximate: F_[k]!.approximate });
      } else {
        const r = runs[runs.length - 1]!;
        r.k1 = k + 1;
        r.approximate ||= F_[k]!.approximate;
      }
    }
    // Transitions: maximal runs of moving phases.
    const transitions: { t0: number; t1: number }[] = [];
    for (const sp of spans) {
      if (!sp.moving) continue;
      const last = transitions[transitions.length - 1];
      if (last && sp.a <= last.t1 + TIME_EPS) last.t1 = sp.b;
      else transitions.push({ t0: sp.a, t1: sp.b });
    }
    // Epoch cap per transition: keep evenly spaced boundaries, merge the rest.
    const cap = Math.max(1, Math.floor(this.budgets.maxEpochsPerTransition));
    const keepBoundary = new Uint8Array(runs.length).fill(1);
    let ri = 0;
    for (const tr of transitions) {
      while (ri < runs.length && F_[runs[ri]!.k0]!.ta < tr.t0 - TIME_EPS) ri++;
      const inside: number[] = [];
      for (let r = ri; r < runs.length && F_[runs[r]!.k0]!.ta < tr.t1 - TIME_EPS; r++) {
        if (F_[runs[r]!.k0]!.ta > tr.t0 + TIME_EPS) inside.push(r);
      }
      if (inside.length + 1 <= cap) continue;
      const keep = new Set<number>();
      for (let q = 1; q < cap; q++) keep.add(inside[Math.floor((q * inside.length) / cap)]!);
      for (const r of inside) if (!keep.has(r)) keepBoundary[r] = 0;
      this.diags.add({
        severity: "info",
        code: "assembly/depth-approx",
        path: "",
        message: `The transition [${fmtT(tr.t0)}, ${fmtT(tr.t1)}] s needs ${inside.length + 1} depth epochs, more than ${cap}; they are merged and approximate.`,
        params: { t0: tr.t0, t1: tr.t1, epochs: inside.length + 1, limit: cap },
      });
    }
    // Groups of runs; each takes the visibility of its longest run (earliest on ties).
    interface Group {
      readonly g: number;
      readonly h: number;
      readonly pick: number;
      readonly approximate: boolean;
    }
    const groups: Group[] = [];
    const len = (r: number): number => F_[runs[r]!.k1 - 1]!.tb - F_[runs[r]!.k0]!.ta;
    for (let g = 0; g < runs.length;) {
      let h = g + 1;
      while (h < runs.length && !keepBoundary[h]) h++;
      let pick = g;
      let approximate = h - g > 1;
      for (let r = g; r < h; r++) {
        if (len(r) > len(pick) + TIME_EPS) pick = r;
        approximate ||= runs[r]!.approximate;
      }
      groups.push({ g, h, pick, approximate });
      g = h;
    }
    // Pass 2: replay the toggles; snapshot the order when reaching each group's chosen run.
    const hidden = new Uint8Array(n);
    const epochs: DepthEpoch[] = [];
    let k = 0;
    for (const grp of groups) {
      const target = runs[grp.pick]!.k0;
      for (; k <= target; k++) for (const i of toggles[k]!) hidden[i] = hidden[i]! ^ 1;
      const ord = order.filter((i) => !hidden[i]).map((i) => this.it[i]!.key);
      const t0 = F_[runs[grp.g]!.k0]!.ta;
      const t1 = F_[runs[grp.h - 1]!.k1 - 1]!.tb;
      const prev = epochs[epochs.length - 1];
      if (prev && sameList(prev.order, ord)) {
        epochs[epochs.length - 1] = {
          t0: prev.t0,
          t1,
          order: prev.order,
          approximate: prev.approximate || grp.approximate,
        };
      } else {
        epochs.push({ t0, t1, order: ord, approximate: grp.approximate });
      }
    }
    return { epochs, transitions };
  }

  private drawItems(): AssemblyDrawItem[] {
    const clipOf = new Map(this.clips.map((c) => [c.item, c]));
    return this.it.map((x) => {
      const c = clipOf.get(x.key);
      return {
        item: x.key,
        path: x.path ?? x.key,
        copies: 1,
        ...(c ? { clips: { 0: { clip: c.clip, solid: c.solid } } } : {}),
      };
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** 1: a behind b on some axis (a first); -1: b behind a; 0: neither or both. */
function boxRel(a: Bounds, b: Bounds): -1 | 0 | 1 {
  let ab = false;
  let ba = false;
  for (let k = 0; k < 3; k++) {
    if (a[k + 3]! <= b[k]! + EPS) ab = true;
    if (b[k + 3]! <= a[k]! + EPS) ba = true;
  }
  return ab === ba ? 0 : ab ? 1 : -1;
}

function pushMap(m: Map<number, number[]>, k: number, v: number): void {
  const l = m.get(k);
  if (l) {
    if (!l.includes(v)) l.push(v);
  } else m.set(k, [v]);
}

function neg(v: Vec): Vec {
  return [-v[0], -v[1], -v[2]];
}

function mid3(lo: readonly number[], hi: readonly number[]): Vec {
  return [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
}

function fmtT(t: number): string {
  return String(Math.round(t * 1e4) / 1e4);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

class MinHeap {
  private readonly h: number[] = [];
  constructor(private readonly less: (a: number, b: number) => boolean) {}
  size(): number {
    return this.h.length;
  }
  push(v: number): void {
    const h = this.h;
    h.push(v);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  pop(): number | undefined {
    const h = this.h;
    if (h.length === 0) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}
