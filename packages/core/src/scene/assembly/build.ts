/**
 * Build programs (Track A2, A2-6; design docs/design/assemblies.md §6.5, §6.6, §7.2, §7.4,
 * §7.7, §18).
 *
 * A build program is an ordered list of steps; a step makes its `add` leaves visible and moves
 * them from an origin to their seats. Leaves no step adds are the **base** (always present).
 * This module is the pure half of it:
 *   - `resolveBuild` turns one `SpecBuildProgram` into a `ResolvedBuildProgram`: selectors
 *     (`selectors.ts`), entry directions (`above`, `outside`, axes, vectors), automatic
 *     distances against the parts PLACED so far (`distances.ts`), the bottom-up stagger inside a
 *     step, step windows, static callout groups and the quarter-turn `view`;
 *   - `buildSegment` is the part of a program one build/unbuild action plays (unbuild is the
 *     exact time reverse of the build segment, like an implode, §7.2);
 *   - `presentAt`, `presenceDiff`, `appearance` say which leaves exist at a level (appearance
 *     tracks, loop start and loop closure fades, §7.4);
 *   - `viewAt` and `loopStartFades` are the view in effect at a level and the loop-start fade.
 *
 * Levels (`to`, `advance`, defaults, direction checks) are NOT decided here: they come from the
 * level machine shared with validation (`schema/assembly-levels.ts`, driven by `plan.ts`).
 *
 * Callout flights and sub-builds (A2-7, §6.5, §7.6): a `from: "callout"` move is the `above`
 * drop preceded by an overlay flight of `overlayDuration` seconds (as long as the drop), so its
 * `duration` is twice the step's; a step with `subBuild` first plays the sub-assembly's own build
 * program at a staging offset (`ResolvedBuildStep.subBuild`, its moves are part of the step's
 * `moves`), then moves the sub-assembly from staging to its seat as one unit.
 *
 * Bounded and total: every scan (selectors, leaves of a mover, the movers x placed-parts
 * obstruction and blocked-path scans, stacking) is charged to the shared `Work` budget BEFORE it
 * runs; a spent budget returns undefined (the caller reports `budget/time`). Nothing throws on a
 * malformed program, and nothing is allocated beyond the movers and the leaves of the owner.
 */
import type {
  AssemblyStepPlan,
  CalloutEntry,
  Diagnostic,
  LoopFade,
  LoopStart,
  PartMove,
  ProgramLevel,
  QuarterTurn,
  ResolvedBuildProgram,
  ResolvedBuildStep,
  SceneAssembly,
  SceneAssemblyNode,
} from "../../contracts/index.js";
import type { TNode } from "../../schema/assembly-tree.js";
import type { SpecBuildProgram, SpecBuildStep, SpecDirection } from "../../schema/types.gen.js";
import {
  resolveDirection,
  toLBox,
  toWorld,
  type Dir,
  type DirectionContext,
} from "./directions.js";
import { parseDistance, programDistances, type LeafBox, type Mover } from "./distances.js";
import { EPS, type LBox } from "./roles.js";
import { spend, type Item, type OwnerIndex, type OwnerSelectors, type Work } from "./selectors.js";
import { programSegment, r4, type ProgramSegment } from "./timing.js";

/** Build steps per program (the schema's `maxItems`); more are ignored. */
export const MAX_BUILD_STEPS = 500;
/** Blocked-path warnings per program before `assembly/diagnostics-capped` (§18). */
export const MAX_BLOCKED = 50;
/** Loop-start fade lasts at least this long (§7.4), seconds of output. */
export const LOOP_START_MIN = 0.4;

const VIEWS: ReadonlySet<number> = new Set([0, 90, 180, 270]);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

export interface BuildInput {
  readonly asm: SceneAssembly;
  /** The program owner (the assembly root or a sub-assembly). */
  readonly owner: SceneAssemblyNode;
  /** The owner's validation-tree node (part specs for the callout groups). */
  readonly tnode: TNode;
  readonly prog: SpecBuildProgram;
  /** JSON pointer of the program, for diagnostics. */
  readonly ptr: string;
  readonly index: OwnerIndex;
  readonly sel: OwnerSelectors;
  readonly work: Work;
  /**
   * The resolved build program of the sub-assembly at node `path` (`program`, default its first),
   * for a step's `subBuild`; undefined when there is none (validation reports it).
   */
  readonly subBuild?: (
    path: string,
    program: string | undefined,
  ) => ResolvedBuildProgram | undefined;
}

export interface BuildResolved {
  readonly program: ResolvedBuildProgram;
  readonly diagnostics: readonly Diagnostic[];
  /** The work budget cut obstruction, stacking or blocked-path scans short. */
  readonly capped: boolean;
}

/** `end[i]`: index after the last descendant of `items[i]` (items are depth-first). One pass. */
function subtreeEnds(items: readonly Item[]): number[] {
  const end = new Array<number>(items.length).fill(items.length);
  const stack: number[] = [];
  items.forEach((it, i) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as number;
      if ((items[top] as Item).segs.length < it.segs.length) break;
      end[top] = i;
      stack.pop();
    }
    stack.push(i);
  });
  return end;
}

const HORIZONTAL: readonly Dir[] = [
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, -1, 0],
];

/** `from` of a step as a `SpecDirection` for `resolveDirection`; `above` and `callout` are up. */
const originOf = (from: SpecBuildStep["from"]): SpecDirection | "outside" =>
  from === undefined || from === "above" || from === "callout"
    ? "up"
    : from === "outside"
      ? "outside"
      : from === "+x" || from === "-x" || from === "+y" || from === "-y" || Array.isArray(from)
        ? (from as SpecDirection)
        : "up"; // anything else is schema-invalid (reported by validation): treated as above

function unionL(boxes: readonly LBox[]): LBox | undefined {
  let out: LBox | undefined;
  for (const b of boxes) {
    out =
      out === undefined
        ? b
        : {
            x0: Math.min(out.x0, b.x0),
            y0: Math.min(out.y0, b.y0),
            z0: Math.min(out.z0, b.z0),
            x1: Math.max(out.x1, b.x1),
            y1: Math.max(out.y1, b.y1),
            z1: Math.max(out.z1, b.z1),
          };
  }
  return out;
}

/** The horizontal direction with the shortest way out of `bounds` for a part (§6.5 `outside`). */
function outsideDir(p: LBox, bounds: LBox): Dir {
  let best: Dir = HORIZONTAL[0] as Dir;
  let bestD = Infinity;
  for (const u of HORIZONTAL) {
    const d =
      u[0] > 0
        ? bounds.x1 - p.x0
        : u[0] < 0
          ? p.x1 - bounds.x0
          : u[1] > 0
            ? bounds.y1 - p.y0
            : p.y1 - bounds.y0;
    if (d < bestD - EPS) {
      bestD = d;
      best = u;
    }
  }
  return best;
}

const overlapXY = (a: LBox, b: LBox): boolean =>
  Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS &&
  Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > EPS;

/** Validation-tree nodes by path below the owner, at most `cap` of them (one pass). */
function specIndex(tnode: TNode, cap: number): Map<string, TNode> {
  const out = new Map<string, TNode>();
  const stack: { n: TNode; rel: string }[] = [{ n: tnode, rel: "" }];
  while (stack.length > 0 && out.size < cap) {
    const { n, rel } = stack.pop() as { n: TNode; rel: string };
    for (const c of n.children) {
      const r = rel === "" ? c.id : `${rel}/${c.id}`;
      if (out.size >= cap) break;
      out.set(r, c);
      stack.push({ n: c, rel: r });
    }
  }
  return out;
}

/** A step's sub-build: the mover it stages, its program and node path. */
interface SubPlan {
  readonly pm: { readonly item: Item };
  readonly program: ResolvedBuildProgram;
  readonly path: string;
}

/**
 * Where a sub-assembly is staged (§6.5): beside the parts placed so far along `+x`, `gap` clear
 * of them, at the height of its seat; along `-y` when `+x` would carry it further than three
 * quarters of the owner's width past the owner (a long model: the staging area stays near it).
 * Local units; the sub-assembly's seat is the origin of the docking line.
 */
function stagingOf(placed: readonly LeafBox[], sub: LBox, ownerBox: LBox, gap: number): Dir {
  const bounds = unionL(placed.map((p) => p.box)) ?? ownerBox;
  const dx = bounds.x1 + gap - sub.x0;
  const reach = ownerBox.x1 + 0.75 * (ownerBox.x1 - ownerBox.x0);
  if (sub.x1 + dx <= reach + EPS) return [dx, 0, 0];
  return [0, bounds.y0 - gap - sub.y1, 0];
}

const json = (v: unknown): string => (v === undefined ? "" : (JSON.stringify(v) ?? ""));

/**
 * Static callout of one step (§6.5): the step's leaves grouped by (shape, size, color, image) as
 * `count x thumbnail`, in order of first appearance. The sample is the first leaf of the group.
 */
function calloutOf(specs: ReadonlyMap<string, TNode>, leaves: readonly Item[]): CalloutEntry[] {
  const groups = new Map<string, { count: number; sample: Item }>();
  for (const it of leaves) {
    const part = specs.get(it.rel)?.part;
    const size = part?.size ?? [it.node.local.size.x, it.node.local.size.y, it.node.local.size.z];
    const key = [
      part?.shape ?? it.node.type ?? "",
      json(size),
      json(part?.color ?? part?.tone),
      json(part?.image),
    ].join("\u0000");
    const g = groups.get(key);
    if (g === undefined) groups.set(key, { count: 1, sample: it });
    else g.count++;
  }
  return [...groups.values()].map((g) => ({
    count: g.count,
    sample: g.sample.node.path,
    ...(g.sample.node.label === undefined ? {} : { label: g.sample.node.label }),
  }));
}

/**
 * Resolves one build program. Undefined when the work budget runs out (nothing partial is
 * returned; the caller reports `budget/time` and skips actions on the program).
 */
export function resolveBuild(input: BuildInput): BuildResolved | undefined {
  const { asm, owner, prog, ptr, index, sel, work } = input;
  const diagnostics: Diagnostic[] = [];
  let capped = false;
  const specSteps: readonly SpecBuildStep[] = (Array.isArray(prog.steps) ? prog.steps : [])
    .slice(0, MAX_BUILD_STEPS)
    .map((s) =>
      s !== null && typeof s === "object" ? s : ({ add: [] } as unknown as SpecBuildStep),
    );

  // pass 1: what each step adds (a leaf is added once; the validator reports a second add)
  if (!spend(work, index.items.length * 2 + 1)) return undefined;
  const itemOf = new Map<SceneAssemblyNode, Item>();
  for (const it of index.items) itemOf.set(it.node, it);
  const ends = subtreeEnds(index.items);
  // part specs for the callout groups: one capped pass, only when some step shows a callout
  const wantsCallout = specSteps.some((st) => st.callout !== false);
  if (wantsCallout && !spend(work, index.items.length + 1)) return undefined;
  const specs = wantsCallout
    ? specIndex(input.tnode, index.items.length)
    : new Map<string, TNode>();
  const added = new Set<SceneAssemblyNode>();
  /**
   * A node some step adds. When earlier steps already added some of its leaves (a sub-assembly
   * after one of its parts, or the reverse), `rest` is only the leaves still to add and they
   * move together as one rigid unit (`partial`); nothing is dropped.
   */
  interface PMover {
    readonly item: Item;
    readonly rest: readonly SceneAssemblyNode[];
    readonly partial: boolean;
  }
  interface Planned {
    readonly spec: SpecBuildStep;
    readonly movers: readonly PMover[];
    readonly leaves: readonly SceneAssemblyNode[];
  }
  const planned: Planned[] = [];
  for (const st of specSteps) {
    const add: readonly unknown[] = Array.isArray(st.add) ? st.add : [];
    const r = sel.stage(add as string[], undefined);
    if (r === undefined) return undefined;
    const movers: PMover[] = [];
    const leaves: SceneAssemblyNode[] = [];
    for (const it of r.movers) {
      const stop = ends[it.index] as number;
      if (!spend(work, stop - it.index + 1)) return undefined; // the subtree walk below
      const lv: SceneAssemblyNode[] = [];
      for (let k = it.index; k < stop; k++) {
        const n = (index.items[k] as Item).node;
        if (n.kind === "leaf") lv.push(n);
      }
      const rest = lv.filter((l) => !added.has(l));
      if (rest.length === 0) continue;
      movers.push({ item: it, rest, partial: rest.length < lv.length });
      for (const l of rest) {
        added.add(l);
        leaves.push(l);
      }
    }
    planned.push({ spec: st, movers, leaves });
  }
  const base: SceneAssemblyNode[] = [];
  for (const it of index.items)
    if (it.node.kind === "leaf" && !added.has(it.node)) base.push(it.node);

  // geometry
  const ownerBox = toLBox(owner.local);
  const size = Math.max(
    ownerBox.x1 - ownerBox.x0,
    ownerBox.y1 - ownerBox.y0,
    ownerBox.z1 - ownerBox.z0,
  );
  const gap = 0.1 * size;
  const dctx: DirectionContext = { frame: asm.frame, owner, cache: new Map() };
  const placed: LeafBox[] = [];
  for (const l of base) {
    const it = itemOf.get(l);
    if (it !== undefined) placed.push({ item: it, box: toLBox(l.local), chain: [] });
  }

  const resolved: ResolvedBuildStep[] = [];
  let prevEnd = 0;
  let blocked = 0;
  let spent = false;
  planned.forEach((pl, si) => {
    if (spent) return;
    const st = pl.spec;
    const at = `${ptr}/steps/${si}`;
    const origin = originOf(st.from);
    if (origin === "outside" && !spend(work, placed.length + 1)) {
      spent = true;
      return;
    }
    const bounds = origin === "outside" ? (unionL(placed.map((p) => p.box)) ?? ownerBox) : ownerBox;

    // sub-build (§6.5): the named sub-assembly, one of this step's whole movers, is built at a
    // staging offset by its own program, then docked; it is not a plain mover of the step
    let sub: SubPlan | undefined;
    if (typeof st.subBuild === "string" && st.subBuild !== "") {
      const subPath = `${owner.path}/${st.subBuild}`;
      const pm = pl.movers.find((m) => m.item.node.path === subPath && !m.partial);
      if (pm === undefined) {
        diagnostics.push(
          mk(
            "warning",
            "assembly/subbuild-not-added",
            `${at}/subBuild`,
            `Step ${si + 1}: ${JSON.stringify(st.subBuild)} is not added whole by this step (an earlier step added part of it, or "add" does not select it); it is added as a plain part`,
            'Add the sub-assembly itself in "add" (for example "add": ["cab"]) and not an earlier step\'s parts of it',
            { step: si + 1, path: subPath },
          ),
        );
      } else {
        const program = input.subBuild?.(subPath, st.program);
        if (program !== undefined) {
          if (!spend(work, placed.length + 1)) {
            spent = true;
            return;
          }
          sub = { pm, program, path: subPath };
        }
      }
    }
    const movers: Mover[] = pl.movers
      .filter((pm) => pm !== sub?.pm)
      .map((pm) => {
        const it = pm.item;
        const box = pm.partial
          ? (unionL(pm.rest.map((l) => toLBox(l.local))) as LBox)
          : toLBox(it.node.local);
        const u: Dir =
          origin === "outside"
            ? outsideDir(box, bounds)
            : resolveDirection(origin, it, dctx, ownerBox);
        const d = parseDistance(st.distance);
        return {
          rel: it.rel,
          item: it,
          box,
          u,
          lift: false,
          drawer: false,
          k: d.k,
          ...(d.fixed === undefined ? {} : { fixed: d.fixed }),
        };
      });
    const dist = programDistances({ movers, leaves: placed, gap, owner: ownerBox }, work);
    if (dist.capped) capped = true;

    // blocked paths (§6.5): a placed part strictly above the seat, over its footprint
    if ((st.from === undefined || st.from === "above" || st.from === "callout") && movers.length) {
      if (!spend(work, movers.length * placed.length + 1)) {
        capped = true;
      } else {
        const hit: { part: string; by: string }[] = [];
        for (const m of movers) {
          const by = placed.find(
            (e) =>
              overlapXY(m.box, e.box) && e.box.z0 >= m.box.z1 - EPS && e.item.node !== m.item.node,
          );
          if (by !== undefined) hit.push({ part: m.item.node.path, by: by.item.node.path });
        }
        if (hit.length > 0) {
          blocked++;
          if (blocked <= MAX_BLOCKED) {
            const first = hit[0] as { part: string; by: string };
            diagnostics.push(
              mk(
                "warning",
                "assembly/build-path-blocked",
                `${at}/from`,
                `Step ${si + 1}: ${JSON.stringify(first.part)}${hit.length > 1 ? ` and ${hit.length - 1} more` : ""} cannot be lowered from above: ${JSON.stringify(first.by)} is already placed over its seat`,
                'Set "from": "outside" or an axis ("+x", "-y") on this step, or add the part before the one above it',
                { step: si + 1, part: first.part, blockedBy: first.by, count: hit.length },
              ),
            );
          }
        }
      }
    }

    // timing: bottom-up inside a step (§17: base first, bottom-up)
    const start = prevEnd;
    const stagger =
      typeof st.stagger === "number" && Number.isFinite(st.stagger) && st.stagger >= 0
        ? st.stagger
        : 0.1;
    const duration =
      typeof st.duration === "number" && Number.isFinite(st.duration) && st.duration > 0
        ? st.duration
        : 0.6;
    const easing = st.easing ?? "ease-out";
    const keys = (m: Mover): { minZ: number } => ({ minZ: m.box.z0 });
    // bottom-up by the part's lowest face, then spec order, then path (§6.5)
    const ranked = [...movers].sort(
      (a, b) => keys(a).minZ - keys(b).minZ || a.item.index - b.item.index || cmp(a.rel, b.rel),
    );
    const restOf = new Map(pl.movers.map((pm) => [pm.item.rel, pm]));
    // callout flight (§7.6): the overlay flight comes first and lasts as long as the drop
    const flight = st.from === "callout";
    const moves: PartMove[] = ranked.flatMap((m, r) => {
      const d = dist.distance.get(m.rel) ?? 0;
      const one = {
        // seat - origin: the part starts at -offset and ends on its seat
        offset: toWorld(asm.frame, [-m.u[0] * d, -m.u[1] * d, -m.u[2] * d]),
        start: r4(start + r * stagger),
        duration: r4(flight ? 2 * duration : duration),
        easing,
        ...(flight ? { overlayDuration: r4(duration) } : {}),
      };
      const pm = restOf.get(m.rel) as PMover;
      // a partly added sub-assembly: its remaining leaves move together, one move each
      return pm.partial
        ? pm.rest.map((l) => ({ path: l.path, ...one }))
        : [{ path: m.item.node.path, ...one }];
    });
    let subBuild: ResolvedBuildStep["subBuild"];
    if (sub !== undefined) {
      const staged = stagingOf(placed, toLBox(sub.pm.item.node.local), ownerBox, gap);
      const staging = toWorld(asm.frame, staged);
      // the sub-assembly's own steps play at the staging offset; its moves (program time) shift
      // to this step, then it docks: staging to seat along the straight line, as one unit
      let built = 0;
      for (const ss of sub.program.steps) {
        built = Math.max(built, ss.end);
        for (const m of ss.moves) moves.push({ ...m, start: r4(start + m.start) });
      }
      moves.push({
        path: sub.path,
        offset: { x: -staging.x + 0, y: -staging.y + 0, z: -staging.z + 0 },
        start: r4(start + built),
        duration: r4(duration),
        easing,
      });
      subBuild = { path: sub.path, program: sub.program.id, staging };
    }
    moves.sort((a, b) => a.start - b.start || cmp(a.path, b.path));
    let end = start;
    for (const m of moves) end = Math.max(end, r4(m.start + m.duration));
    prevEnd = end;
    const view =
      typeof st.view === "number" && VIEWS.has(st.view) ? (st.view as QuarterTurn) : undefined;
    const leafItems = pl.leaves.flatMap((l) => {
      const it = itemOf.get(l);
      return it === undefined ? [] : [it];
    });
    resolved.push({
      index: si + 1,
      number: typeof st.number === "number" ? st.number : si + 1,
      ...(st.caption === undefined ? {} : { caption: st.caption }),
      adds: pl.leaves.map((l) => l.path).sort(cmp),
      moves,
      callout: st.callout === false ? [] : calloutOf(specs, leafItems),
      ...(view === undefined ? {} : { view }),
      ...(subBuild === undefined ? {} : { subBuild }),
      start,
      end,
    });
    // the step's leaves are placed for the next one
    for (const it of leafItems) placed.push({ item: it, box: toLBox(it.node.local), chain: [] });
  });

  if (spent) return undefined;
  if (blocked > MAX_BLOCKED) {
    diagnostics.push(
      mk(
        "info",
        "assembly/diagnostics-capped",
        ptr,
        `Program ${JSON.stringify(prog.id)} has ${blocked} blocked steps; only the first ${MAX_BLOCKED} are reported`,
        undefined,
        { program: prog.id, omitted: blocked - MAX_BLOCKED },
      ),
    );
  }
  return {
    program: {
      kind: "build",
      id: prog.id,
      owner: owner.path,
      ...(prog.label === undefined ? {} : { label: prog.label }),
      steps: resolved,
      base: base.map((l) => l.path).sort(cmp),
    },
    diagnostics,
    capped,
  };
}

// ---------------------------------------------------------------------------------------------
// Levels, segments, appearance
// ---------------------------------------------------------------------------------------------

/**
 * What an action plays. `build`: steps `from+1 .. to`. `unbuild-played`: the exact reverse
 * (§7.2) with `moves` ALREADY reversed (offsets negated, starts mirrored, easing mirrored),
 * so it is the "as played" view of the action.
 *
 * Two inputs, never mixed (the same hazard exists for `programSegment`'s `implode`):
 *  - `moves` are the moves AS PLAYED: use them to sample positions or draw the action;
 *  - `forward` are the moves of the forward (build) segment, unreversed: this is the input of
 *    `toLoopMoves` (`depth/epochs.ts`), which mirrors `unbuild` and `implode` itself. Feeding
 *    `moves` of an `unbuild-played` segment to `toLoopMoves` reverses it twice.
 * For a `build` segment the two are equal.
 */
export interface BuildSegment extends Omit<ProgramSegment, "kind"> {
  readonly kind: "build" | "unbuild-played";
  /** Unreversed moves, in segment time: the input of `toLoopMoves` (see above). */
  readonly forward: readonly PartMove[];
}

/**
 * The part of a build program between levels `from` and `to`. A build is shifted so step
 * `from+1` starts at 0; an unbuild is the EXACT time reverse of the build segment `to+1 .. from`:
 * a move `[st, en]` becomes `[L - en, L - st]`, its offset is negated and its easing mirrored.
 */
export function buildSegment(
  program: ResolvedBuildProgram,
  from: number,
  to: number,
): BuildSegment {
  const seg = programSegment({ stages: program.steps }, from, to);
  if (seg.kind === "explode") return { ...seg, kind: "build", forward: seg.moves };
  const fwd = programSegment({ stages: program.steps }, to, from);
  return { ...seg, kind: "unbuild-played", forward: fwd.moves };
}

/** Leaves present at `level` (steps done): the base plus everything steps `1 .. level` add. */
export function presentAt(program: ResolvedBuildProgram, level: number): Set<string> {
  const out = new Set(program.base);
  const n = Math.max(0, Math.min(program.steps.length, level));
  for (let i = 0; i < n; i++)
    for (const p of (program.steps[i] as ResolvedBuildStep).adds) out.add(p);
  return out;
}

/** Leaves that appear and that vanish going from level `a` to level `b`; sorted. */
export function presenceDiff(
  program: ResolvedBuildProgram,
  a: number,
  b: number,
): { readonly appear: string[]; readonly vanish: string[] } {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(program.steps.length, Math.max(a, b));
  const between: string[] = [];
  for (let i = lo; i < hi; i++) between.push(...(program.steps[i] as ResolvedBuildStep).adds);
  between.sort(cmp);
  return a <= b ? { appear: between, vanish: [] } : { appear: [], vanish: between };
}

/** One appearance key of an action: leaf `path` becomes visible (or hidden) at `at` seconds. */
export interface Appearance {
  readonly path: string;
  /** Seconds from the action's start, speed 1, before compression. */
  readonly at: number;
  readonly visible: boolean;
  /**
   * The swap of a callout flight (§7.6): the world copy appears (or vanishes) at once, with no
   * fade, because the overlay copy is there before (after) it at the same position.
   */
  readonly swap?: true;
}

/**
 * Appearance of the leaves one action adds or removes (B-3's visibility keys). A built leaf
 * appears when its move starts (a callout flight: when the flight ends and the world drop
 * starts); in an unbuild (the exact reverse) it disappears when the reversed move ends,
 * `L - start` (a flight: when the world lift ends and the overlay flight back starts). A leaf of
 * a staged sub-assembly that its own program does not add is there from the step's start (and
 * leaves at the end of the reversed step). Sorted by (at, path).
 */
export function appearance(program: ResolvedBuildProgram, from: number, to: number): Appearance[] {
  const seg = buildSegment(program, from, to);
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(program.steps.length, Math.max(from, to));
  const out: Appearance[] = [];
  const reverse = seg.kind === "unbuild-played";
  const startOf = new Map(seg.moves.map((m) => [m.path, m]));
  const off = lo < hi ? (program.steps[lo] as ResolvedBuildStep).start : 0;
  for (let i = lo; i < hi; i++) {
    const step = program.steps[i] as ResolvedBuildStep;
    for (const leaf of step.adds) {
      const segs = leaf.split("/");
      let m: PartMove | undefined;
      for (let k = segs.length; k > 0 && m === undefined; k--)
        m = startOf.get(segs.slice(0, k).join("/"));
      if (m === undefined) continue;
      const ov = m.overlayDuration ?? 0;
      if (step.subBuild !== undefined && m.path === step.subBuild.path) {
        // no move of its own inside the sub-assembly: present while it is staged
        const at = reverse ? r4(seg.length - (step.start - off)) : r4(step.start - off);
        out.push({ path: leaf, at, visible: !reverse });
        continue;
      }
      out.push({
        path: leaf,
        at: reverse ? r4(m.start + m.duration - ov) : r4(m.start + ov),
        visible: !reverse,
        ...(ov > 0 ? { swap: true as const } : {}),
      });
    }
  }
  // an unbuild leaf vanishes when its reversed move has ended (the part is back at its origin)
  return out.sort((a, b) => a.at - b.at || cmp(a.path, b.path));
}

/**
 * View in effect at `level` (§7.7): the `view` of the latest step `<= level` that sets one;
 * undefined while none has (the program has not touched the view yet, or sets none).
 */
export function viewAt(program: ResolvedBuildProgram, level: number): QuarterTurn | undefined {
  let cur: QuarterTurn | undefined;
  const n = Math.min(level, program.steps.length);
  for (let i = 0; i < n; i++) {
    const v = (program.steps[i] as ResolvedBuildStep).view;
    if (v !== undefined) cur = v;
  }
  return cur;
}

/**
 * View switches of the action `from -> to` (`ResolvedAction.views`): a build switches at the
 * start of each step that sets a view; an unbuild, the exact reverse, switches back to the view
 * before the step at the start of the reversed step. Times are segment times before compression.
 */
export function viewSwitches(
  program: ResolvedBuildProgram,
  from: number,
  to: number,
): { at: number; view: QuarterTurn }[] {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(program.steps.length, Math.max(from, to));
  if (lo >= hi) return [];
  const off = (program.steps[lo] as ResolvedBuildStep).start;
  const len = buildSegment(program, lo, hi).length;
  const out: { at: number; view: QuarterTurn }[] = [];
  for (let i = lo; i < hi; i++) {
    const st = program.steps[i] as ResolvedBuildStep;
    if (st.view === undefined) continue;
    if (from <= to) out.push({ at: r4(st.start - off), view: st.view });
    else out.push({ at: r4(len - (st.end - off)), view: viewAt(program, i) ?? 0 });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Build leaves fading out at the start of the loop (§7.4). */
export interface LoopStartFade {
  /** Program owner path and the program's id. */
  readonly owner: string;
  readonly program: string;
  /** Level the timeline starts at (`k - advance` of the first action) and the base pose level. */
  readonly startLevel: number;
  readonly baseLevel: number;
  /** Leaves present at the base pose but not at the start level (fade out), sorted. */
  readonly leaves: readonly string[];
  /** Leaves present at the start level but not at the base pose (fade in), sorted. */
  readonly appear: readonly string[];
  /** Seconds of output the fade lasts: `max(lead_1, 0.4)`. */
  readonly window: number;
}

/** Rest level of a build program of `steps` steps: finished, or 0 for `pose: "empty"`. */
export const baseBuildLevel = (steps: number, pose: string | undefined): number =>
  pose === "empty" ? 0 : Math.min(steps, MAX_BUILD_STEPS);

/**
 * Loop-start fades of an assembly (§7.4): for each build program whose first action starts at a
 * level other than its base pose, the leaves not present at that level fade out during
 * `[0, max(lead, 0.4)]` (`lead` = the opening camera transition when step 1 zooms, in seconds
 * of output; 0 otherwise). Programs no valid action plays have no fade. Sorted by (owner, id).
 */
export function loopStartFades(
  asm: SceneAssembly,
  plan: readonly AssemblyStepPlan[],
  lead = 0,
): LoopStartFade[] {
  const first = new Map<string, { from: number }>();
  for (const p of plan) {
    for (const a of p.actions) {
      if (a.kind !== "build" && a.kind !== "unbuild") continue;
      const k = `${a.target}\u0000${a.program}`;
      if (!first.has(k)) first.set(k, { from: a.from });
    }
  }
  const out: LoopStartFade[] = [];
  const rest = asm.basePose;
  for (const p of asm.programs) {
    if (p.kind !== "build") continue;
    const f = first.get(`${p.owner}\u0000${p.id}`);
    if (f === undefined) continue;
    const base = baseOf(rest, asm, p);
    if (f.from === base) continue;
    out.push({
      owner: p.owner,
      program: p.id,
      startLevel: f.from,
      baseLevel: base,
      leaves: presenceDiff(p, base, f.from).vanish,
      appear: presenceDiff(p, base, f.from).appear,
      window: Math.max(lead, LOOP_START_MIN),
    });
  }
  return out.sort((a, b) => cmp(a.owner, b.owner) || cmp(a.program, b.program));
}

function baseOf(
  pose: readonly ProgramLevel[],
  asm: SceneAssembly,
  p: ResolvedBuildProgram,
): number {
  const rel = p.owner === asm.id ? "" : p.owner.slice(asm.id.length + 1);
  const q = rel === "" ? p.id : `${rel}/${p.id}`;
  return pose.find((x) => x.program === q)?.level ?? p.steps.length;
}

/**
 * The contract form of the loop-start fades of an assembly (`SceneAssembly.loopStart`, §7.4):
 * one `LoopFade` per leaf over `[0, max(lead, 0.4)]` (loop seconds at speed 1; `lead` is the
 * plan's own opening transition `lead_1`). Parts of the base pose that the start level lacks
 * fade out (1 -> 0); parts the start level has but the base pose lacks (`pose: empty` with a
 * build starting at 3) fade in (0 -> 1). Undefined when there are none.
 */
export function loopStartOf(
  asm: SceneAssembly,
  plan: readonly AssemblyStepPlan[],
  lead = 0,
): LoopStart | undefined {
  const fades = new Map<string, LoopFade>();
  for (const f of loopStartFades(asm, plan, lead)) {
    for (const path of f.leaves) fades.set(path, { path, t0: 0, t1: f.window, from: 1, to: 0 });
    for (const path of f.appear) fades.set(path, { path, t0: 0, t1: f.window, from: 0, to: 1 });
  }
  if (fades.size === 0) return undefined;
  return { fades: [...fades.values()].sort((a, b) => cmp(a.path, b.path)) };
}
