/**
 * The assembly layer's motion on the master loop (docs/design/assemblies.md §7): the step plan
 * (`AssemblyStepPlan`, A2-3) becomes `LoopMove`s in loop seconds (speed 1), plus the stage runs
 * labels and fades hang on. Pure and deterministic; nothing throws on odd input (a plan entry
 * that matches no program is skipped).
 *
 * - Base pose (`pose: exploded`): the root's default program at its last stage as INSTANT moves
 *   at `t = 0` (the contribution jumps, there is no key before it).
 * - An explode action plays implicit access first (`accessLength`), then its own segment; an
 *   implode plays its own segment (the exact time reverse) first and undoes the access last.
 *   Moves already `opened` are not played again.
 * - Loop closure (§7.4): during the last step's closing window every program returns to its base
 *   level, all moves together (no stagger), `ease-in-out`.
 */
import type {
  AssemblyStepPlan,
  CalloutEntry,
  LoopFade,
  ProgramLevel,
  ResolvedAction,
  ResolvedBuildProgram,
  ResolvedExplodeProgram,
  ResolvedStage,
  SceneAssembly,
  Vec3,
} from "../../contracts/index.js";
import type { SpecEasing } from "../../schema/types.gen.js";
import { toLoopMoves } from "../../depth/epochs.js";
import { appearance, buildSegment, presentAt } from "../../scene/assembly/build.js";
import { baseOf, fadeEnd, finalOf, type LeafPresence, type PresenceEvent } from "./builds.js";
import type { BezierMove } from "./tracks.js";

/** The camera's curve (`anim/index.ts` EASE): the loop closure's fast return plays it (§7.4). */
export const CLOSURE_BEZIER = [0.4, 0, 0.2, 1] as const;
import { REVERSED_EASING } from "../../scene/boards.js";
import { programSegment } from "../../scene/assembly/timing.js";
import type { StepTime } from "../boards/timeline.js";

export const r4 = (v: number): number => Math.round(v * 10000) / 10000 + 0;

/** One played stage: when its moves run and what they are (labels, fades). */
export interface StageRun {
  readonly assembly: string;
  /** 1-based step. */
  readonly step: number;
  readonly kind: "explode" | "implode";
  readonly program: ResolvedExplodeProgram;
  readonly stage: ResolvedStage;
  /** First move start / last move end, loop seconds. */
  readonly t0: number;
  readonly t1: number;
  /** Moves as played (`implode`: time-reversed). */
  readonly moves: readonly { readonly path: string; readonly t0: number; readonly t1: number }[];
  /** End of the step's closing hold (`StepTime.end`): the stage's pose is shown until then. */
  readonly holdEnd: number;
}

/**
 * One callout flight (§7.6): an overlay copy of `path` flies in screen space during `[t0, t1]`
 * (loop seconds, speed 1). A build flies from the callout slot to the hover point and the world
 * copy appears at `t1` (the swap); an unbuild is the exact reverse: the world copy leaves at
 * `t0` and the overlay copy flies from the hover point back to the slot.
 */
export interface FlightRun {
  /** The node the move belongs to (a leaf, or a sub-assembly flying as one unit). */
  readonly path: string;
  readonly kind: "build" | "unbuild";
  readonly t0: number;
  readonly t1: number;
  /** The flight's curve as played (an unbuild's is mirrored). */
  readonly easing: SpecEasing;
  /** Set when the move is one leaf of a partly added sub-assembly: its flight is one rigid unit. */
  readonly unit?: string;
  /** Index into `LoopBuild.callouts` of the build step this flight belongs to. */
  readonly callout: number;
}

/**
 * One play of a build step's parts callout (§6.5, §7.6): the box shows during `[t0, t1]` (loop
 * seconds, speed 1) and the step's flights start from its slot. A step played again (a loop that
 * builds, unbuilds and builds) has one run per play.
 */
export interface CalloutRun {
  /** Owner path and program id of the build program, and the 1-based step. */
  readonly owner: string;
  readonly program: string;
  readonly step: number;
  /** The step's callout groups (empty when the step has `callout: false`). */
  readonly entries: readonly CalloutEntry[];
  readonly t0: number;
  readonly t1: number;
}

export interface LoopBuild {
  readonly moves: BezierMove[];
  /** Callout flights, sorted by (t0, path). */
  readonly flights: FlightRun[];
  /** Every play of a build step, in play order (`FlightRun.callout` indexes it). */
  readonly callouts: CalloutRun[];
  readonly runs: StageRun[];
  /** Closing window of the last step, when some program returns to its base level. */
  readonly closure?: { readonly t0: number; readonly t1: number };
  /** Per step (0-based): when its assembly motion settles (§7.5); the step start without actions. */
  readonly settled: (number | undefined)[];
  /** Leaves of build programs with actions: when they exist (B-3), by leaf path. */
  readonly presence: ReadonlyMap<string, LeafPresence>;
  /** Loop-start fades of the assemblies (`SceneAssembly.loopStart`), by leaf path. */
  readonly loopFades: ReadonlyMap<string, LoopFade>;
}

const eps = 1e-9;
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x + 0, y: a.y + b.y + 0, z: a.z + b.z + 0 });

function programOf(
  asm: SceneAssembly,
  q: string,
  kind: "explode" | "build" = "explode",
): { program: ResolvedExplodeProgram; ownerPath: string } | undefined {
  const k = q.lastIndexOf("/");
  const rel = k < 0 ? "" : q.slice(0, k);
  const id = k < 0 ? q : q.slice(k + 1);
  const owner = rel === "" ? asm.id : `${asm.id}/${rel}`;
  const p = asm.programs.find((x) => x.kind === kind && x.owner === owner && x.id === id);
  return p === undefined ? undefined : { program: p as ResolvedExplodeProgram, ownerPath: owner };
}

/** The stage (1-based index >= `from`) of a program whose move belongs to `path`, with the move. */
function moveOfPath(program: ResolvedExplodeProgram, path: string, from: number) {
  for (let i = Math.max(0, from - 1); i < program.stages.length; i++) {
    const st = program.stages[i] as ResolvedStage;
    const m = st.moves.find((x) => x.path === path);
    if (m !== undefined) return { stage: st, move: m };
  }
  return undefined;
}

/**
 * The assembly an action target belongs to: the longest assembly id that is the target or a
 * prefix of it (close-up instances are rooted at multi-segment paths, `r2/srv/closeup`). A longer
 * `foreign` path (an instance built in its own group) owns the target instead: undefined.
 */
export function ownerOf<T>(
  byId: ReadonlyMap<string, T>,
  target: string,
  foreign: readonly string[] = [],
): T | undefined {
  let best: string | undefined;
  const take = (id: string): void => {
    if (
      (target === id || target.startsWith(`${id}/`)) &&
      (best === undefined || id.length > best.length)
    ) {
      best = id;
    }
  };
  for (const id of byId.keys()) take(id);
  const own = best;
  best = undefined;
  for (const id of foreign) take(id);
  if (best !== undefined && (own === undefined || (best as string).length > own.length)) {
    return undefined;
  }
  return own === undefined ? undefined : byId.get(own);
}

export function buildLoop(
  assemblies: readonly SceneAssembly[],
  plan: readonly AssemblyStepPlan[],
  times: readonly StepTime[],
  total: number,
  closeLast: boolean,
  foreign: readonly string[] = [],
): LoopBuild {
  const moves: BezierMove[] = [];
  const runs: StageRun[] = [];
  const byId = new Map(assemblies.map((a) => [a.id, a]));
  const zero = { x: 0, y: 0, z: 0 };
  const neg = (v: { x: number; y: number; z: number }) => ({
    x: -v.x + 0,
    y: -v.y + 0,
    z: -v.z + 0,
  });

  // Base pose: instant moves at t = 0.
  for (const asm of assemblies) {
    for (const pl of asm.basePose) {
      if (pl.level <= 0) continue;
      const found = programOf(asm, pl.program);
      if (found === undefined) continue;
      for (const st of found.program.stages.slice(0, pl.level)) {
        for (const m of st.moves) {
          moves.push({ path: m.path, t0: 0, t1: 0, from: zero, to: m.offset, easing: m.easing });
        }
      }
    }
  }

  // Build programs (B-3): moves from origin to seat, and when each leaf exists.
  const presence = new Map<string, LeafPresence>();
  const loopFades = new Map<string, LoopFade>();
  for (const asm of assemblies)
    for (const f of asm.loopStart?.fades ?? []) loopFades.set(f.path, f);
  const net = new Map<string, Vec3>();
  /** Segment of the first build move of each path: all its moves there get the loop-start jump. */
  const firstBuild = new Map<string, number>();
  let segNo = 0;
  const seen = new Set<string>();
  const buildMoves: { readonly mv: BezierMove; readonly seg: number }[] = [];
  const flights: FlightRun[] = [];
  const callouts: CalloutRun[] = [];
  const playBuild = (
    prog: ResolvedBuildProgram,
    a: ResolvedAction,
    segStart: number,
    floor: number,
  ): void => {
    const key = `${prog.owner}\u0000${prog.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      const startSet = presentAt(prog, a.from);
      for (const st of prog.steps) {
        for (const leaf of st.adds) {
          presence.set(leaf, { start: startSet.has(leaf), events: [] });
        }
      }
    }
    const seg = buildSegment(prog, a.from, a.to);
    const lm = toLoopMoves(seg.forward, {
      at: segStart,
      kind: a.kind === "unbuild" ? "unbuild" : "build",
      scale: a.scale,
      length: seg.length,
    });
    // callout flights (§7.6): a move with an overlay phase plays it first (a build) or last (an
    // unbuild); only the world phase is a loop move. The swap time is the one `appearance` uses.
    segNo++;
    // what each node carries from earlier unbuilds, before this segment's moves (a node with two
    // moves, a sub-assembly's slide and drop, goes back leg by leg)
    const carried = new Map<string, Vec3>();
    const legs = new Map<string, number>();
    for (const m of lm) {
      if (!carried.has(m.path)) carried.set(m.path, net.get(m.path) ?? zero);
      legs.set(m.path, (legs.get(m.path) ?? 0) + 1);
    }
    // each step of the segment is one play of its callout, over the window of its own moves
    // (an unbuild plays the steps and their windows reversed)
    const lo = Math.min(a.from, a.to);
    const hi = Math.max(a.from, a.to);
    const steps = prog.steps.slice(lo, hi);
    const offset = steps[0]?.start ?? 0;
    const playOf = new Map<number, number>();
    for (const st of steps) {
      const s0 = st.start - offset;
      const s1 = st.end - offset;
      const [w0, w1] = seg.kind === "build" ? [s0, s1] : [seg.length - s1, seg.length - s0];
      const t0 = r4(segStart + w0 * a.scale);
      const t1 = r4(segStart + w1 * a.scale);
      if (!(t1 - t0 > 1e-4)) continue;
      playOf.set(st.index, callouts.length);
      callouts.push({
        owner: prog.owner,
        program: prog.id,
        step: st.index,
        entries: st.callout,
        t0,
        t1,
      });
    }
    const swapOf = new Map<string, number>();
    for (const sm of seg.moves) {
      const ov = sm.overlayDuration ?? 0;
      if (!(ov > 0)) continue;
      const owner = steps.find((st) => st.moves.some((m) => m.path === sm.path));
      const found = owner === undefined ? undefined : playOf.get(owner.index);
      // a flight of no listed step (not expected) still gets a slot, with no box
      const calloutOf = (t0: number, t1: number): number =>
        found ??
        callouts.push({ owner: prog.owner, program: prog.id, step: 0, entries: [], t0, t1 }) - 1;
      if (sm.reversed) {
        const ts = r4(segStart + r4(sm.start + sm.duration - ov) * a.scale);
        swapOf.set(sm.path, ts);
        const t1 = r4(segStart + (sm.start + sm.duration) * a.scale);
        flights.push({
          path: sm.path,
          kind: "unbuild",
          t0: ts,
          t1,
          callout: calloutOf(ts, t1),
          easing: sm.easing,
          ...(sm.unit === undefined ? {} : { unit: sm.unit }),
        });
      } else {
        const ts = r4(segStart + r4(sm.start + ov) * a.scale);
        swapOf.set(sm.path, ts);
        const t0 = r4(segStart + sm.start * a.scale);
        flights.push({
          path: sm.path,
          kind: "build",
          t0,
          t1: ts,
          callout: calloutOf(t0, ts),
          easing: sm.easing,
          ...(sm.unit === undefined ? {} : { unit: sm.unit }),
        });
      }
    }
    for (const m of lm) {
      // `toLoopMoves` mirrors an unbuild in time; its curve is mirrored here, as an implode's
      let mv: BezierMove = {
        ...m,
        t0: r4(m.t0),
        t1: r4(m.t1),
        ...(a.kind === "unbuild" ? { easing: REVERSED_EASING[m.easing] } : {}),
      };
      const swap = swapOf.get(m.path);
      if (swap !== undefined) mv = a.kind === "unbuild" ? { ...mv, t1: swap } : { ...mv, t0: swap };
      const prev = carried.get(m.path) ?? zero;
      if (a.kind === "build" && (prev.x !== 0 || prev.y !== 0 || prev.z !== 0)) {
        // rebuilt after an unbuild: it starts where the unbuild left it (its origin) and
        // arrives at the seat; nothing is displaced before the move. With several moves each
        // takes back its own leg.
        mv = { ...mv, from: zero, to: (legs.get(m.path) ?? 1) > 1 ? neg(m.from) : neg(prev) };
        net.set(m.path, zero);
      } else if (a.kind === "unbuild") {
        net.set(m.path, add(net.get(m.path) ?? zero, m.to));
      }
      moves.push(mv);
      if (a.kind === "build") buildMoves.push({ mv, seg: segNo });
    }
    for (const ap of appearance(prog, a.from, a.to)) {
      const p = presence.get(ap.path);
      if (p === undefined) continue;
      const e: PresenceEvent = {
        t: r4(segStart + ap.at * a.scale),
        visible: ap.visible,
        floor,
        ...(ap.swap === true ? { swap: true as const } : {}),
      };
      p.events.push(e);
    }
  };

  const settled: (number | undefined)[] = [];
  plan.forEach((sp, si) => {
    const st = times[si];
    if (st === undefined) return;
    let end = st.start;
    for (const a of sp.actions) {
      const asm = ownerOf(byId, a.target, foreign);
      if (asm === undefined) continue;
      const qualified =
        a.target === asm.id ? a.program : `${a.target.slice(asm.id.length + 1)}/${a.program}`;
      if (a.kind === "build" || a.kind === "unbuild") {
        const bp = programOf(asm, qualified, "build") as unknown as
          { program: ResolvedBuildProgram } | undefined;
        if (bp === undefined) continue;
        const at = r4(st.open + a.start);
        playBuild(bp.program, a, at, at);
        end = Math.max(end, at + a.length);
        continue;
      }
      const found = programOf(asm, qualified);
      if (found === undefined) continue;
      const scale = a.scale;
      const segStart = r4(st.open + a.start);
      const prog = found.program;
      const opened = a.opened === undefined ? undefined : new Set(a.opened);
      const seg = programSegment(prog, a.from, a.to, opened);
      const lo = Math.max(0, Math.min(a.from, a.to));
      const hi = Math.min(prog.stages.length, Math.max(a.from, a.to));
      const stages = prog.stages.slice(lo, hi);
      const off0 = stages.length === 0 ? 0 : (stages[0] as ResolvedStage).start;
      const explode = a.kind === "explode";
      const access = a.accessLength ?? 0;
      const ownAt = explode ? segStart + access : segStart;
      const ownEnd = ownAt + seg.length * scale;
      // own segment
      for (const s of stages) {
        const played: { path: string; t0: number; t1: number }[] = [];
        for (const m of s.moves) {
          if (opened?.has(m.path) === true) continue;
          const rel = explode ? m.start - off0 : seg.length - (m.start - off0 + m.duration);
          const t0 = r4(ownAt + rel * scale);
          const t1 = r4(t0 + m.duration * scale);
          moves.push({
            path: m.path,
            t0,
            t1,
            from: zero,
            to: explode ? m.offset : neg(m.offset),
            easing: explode ? m.easing : REVERSED_EASING[m.easing],
          });
          played.push({ path: m.path, t0, t1 });
        }
        if (played.length > 0) {
          runs.push({
            assembly: asm.id,
            step: sp.step,
            kind: a.kind === "explode" ? "explode" : "implode",
            program: prog,
            stage: s,
            t0: Math.min(...played.map((x) => x.t0)),
            t1: Math.max(...played.map((x) => x.t1)),
            moves: played,
            holdEnd: st.end,
          });
        }
      }
      // implicit access (§8.3): sequential single moves of ancestor programs
      let cum = 0;
      for (const lv of a.implied) {
        const f = programOf(asm, lv.program);
        const path = lv.only?.[0];
        if (f === undefined || path === undefined) continue;
        const hit = moveOfPath(f.program, path, explode ? lv.level : lv.level + 1);
        if (hit === undefined) continue;
        const dur = hit.move.duration * scale;
        const t0 = r4((explode ? segStart : ownEnd) + cum);
        cum += dur;
        moves.push({
          path,
          t0,
          t1: r4(t0 + dur),
          from: zero,
          to: explode ? hit.move.offset : neg(hit.move.offset),
          easing: explode ? hit.move.easing : REVERSED_EASING[hit.move.easing],
        });
      }
      end = Math.max(end, segStart + a.length);
    }
    settled.push(
      sp.actions.some((a) => ownerOf(byId, a.target, foreign) !== undefined)
        ? r4(Math.min(end, st.end))
        : undefined,
    );
  });

  // Loop start: base-pose leaves that fade out are still displaced at their origin (a build
  // move holds its `from` before it starts): they fade where they sit seated, then go back.
  for (const { mv: m, seg } of buildMoves) {
    if (firstBuild.get(m.path) !== undefined && firstBuild.get(m.path) !== seg) continue;
    firstBuild.set(m.path, seg);
    const ends = [...loopFades.values()]
      .filter(
        (f) => f.from === 1 && f.to === 0 && (f.path === m.path || f.path.startsWith(`${m.path}/`)),
      )
      .map((f) => fadeEnd(f, presence.get(f.path) as LeafPresence));
    if (ends.length === 0) continue;
    // the jump back to the origin happens while the part is absent, just after its fade
    const t = r4(Math.max(...ends) + 0.001);
    moves.push({ path: m.path, t0: t, t1: t, from: neg(m.from), to: zero, easing: "linear" });
  }

  // Loop closure (§7.4): every program back to its base level, all moves together.
  let closure: LoopBuild["closure"];
  const lastStep = times[times.length - 1];
  const lastPlan = plan[plan.length - 1];
  const closeT0 =
    closeLast && lastStep !== undefined && lastStep.window.tr > 0
      ? r4(total - lastStep.window.tr)
      : undefined;
  // Build programs end away from rest: parts present at rest but gone at the end fade in
  // (seated), the others fade out, over the same closing window (B-3).
  let buildClosure = false;
  if (closeT0 !== undefined) {
    for (const [path, p] of presence) {
      const f = loopFades.get(path);
      if (finalOf(p) === baseOf(p, f)) continue;
      buildClosure = true;
      if (!baseOf(p, f)) continue;
      for (const [node, o] of net) {
        if (
          (path === node || path.startsWith(`${node}/`)) &&
          (o.x !== 0 || o.y !== 0 || o.z !== 0)
        ) {
          moves.push({
            path: node,
            t0: closeT0,
            t1: closeT0,
            from: zero,
            to: neg(o),
            easing: "linear",
          });
          net.set(node, zero);
        }
      }
    }
  }
  if (closeT0 !== undefined && lastPlan !== undefined) {
    const t0 = closeT0;
    for (const asm of assemblies) {
      const base = new Map(asm.basePose.map((p) => [p.program, p.level]));
      const pose: readonly ProgramLevel[] = lastPlan.poses[asm.id] ?? [];
      for (const pl of pose) {
        const f = programOf(asm, pl.program);
        if (f === undefined) continue;
        const b = base.get(pl.program) ?? 0;
        const stagesUp = f.program.stages.slice(Math.min(b, pl.level), Math.max(b, pl.level));
        const sign = pl.level > b ? -1 : 1;
        for (const s of stagesUp) {
          for (const m of s.moves) {
            const o = m.offset;
            moves.push({
              path: m.path,
              t0,
              t1: total,
              from: zero,
              to: { x: sign * o.x + 0, y: sign * o.y + 0, z: sign * o.z + 0 },
              easing: "ease-in-out",
              bezier: CLOSURE_BEZIER,
            });
          }
        }
        for (const path of pl.only ?? []) {
          const hit = moveOfPath(f.program, path, pl.level + 1);
          if (hit === undefined) continue;
          moves.push({
            path,
            t0,
            t1: total,
            from: zero,
            to: neg(hit.move.offset),
            easing: "ease-in-out",
            bezier: CLOSURE_BEZIER,
          });
        }
      }
    }
    if (moves.some((m) => Math.abs(m.t0 - t0) < eps && m.t1 >= total - eps)) {
      closure = { t0, t1: total };
    }
  }
  if (closure === undefined && buildClosure && closeT0 !== undefined) {
    closure = { t0: closeT0, t1: total };
  }
  return {
    moves,
    runs,
    callouts,
    flights: flights.sort(
      (x, y) => x.t0 - y.t0 || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0),
    ),
    ...(closure === undefined ? {} : { closure }),
    settled,
    presence,
    loopFades,
  };
}

/** Whether an action plays anything for assemblies (figure actions have other targets). */
export const isAssemblyAction = (a: ResolvedAction, ids: ReadonlySet<string>): boolean =>
  ownerOf(new Map([...ids].map((i) => [i, i])), a.target) !== undefined;
