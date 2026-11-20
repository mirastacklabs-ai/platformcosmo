/**
 * Figure mode in the scene (Track A2, A2-F; docs/design/assemblies.md §7, §11.6, §15): resolves
 * `figures[]` into `SceneFlatBoard`s, stage timing, step plans and credits. Pure and
 * deterministic: no I/O, no image bytes (sprite sizes are unknown here, so the default exploded
 * position and the bottom-edge draw order are left to the renderer, R-1).
 *
 * The contract has no slot for figure sprites and moves (`SceneFlatBoard` carries ids only), so
 * `resolveFigure` is exported for R-1: it is cheap and gives the same answer as the scene.
 */
import type {
  AssemblyStepPlan,
  AssetSource,
  ProgramLevel,
  ResolvedAction,
  SceneAssemblies,
  SceneFlatBoard,
} from "../contracts/assembly.js";
import type { Diagnostic, Vec3 } from "../contracts/index.js";
import { closest, closestMatches, q } from "../schema/suggest.js";
import type {
  PlatformCosmoSpec,
  SpecAssemblyAction,
  SpecEasing,
  SpecFigure,
  SpecSource,
  SpecStep,
} from "../schema/types.gen.js";

const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Program id of a figure's stage list in `ResolvedAction.program` / `ProgramLevel.program`. */
export const FIGURE_PROGRAM = "stages";

const DEFAULT_WIDTH = 8;
/** Seconds the settled pose is held before the step's closing camera transition (§7.3). */
const HOLD = 0.2;
/** Floor of the motion window, so a tiny step still yields a finite compression scale. */
const MIN_WINDOW = 0.05;

// ---------------------------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------------------------

export type Bezier = readonly [number, number, number, number];

/** CSS cubic-bezier control points of the spec's keyword easings. */
export const BEZIER: Readonly<Record<SpecEasing, Bezier>> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

/** Mirrored easing of a time-reversed move: `(x1,y1,x2,y2)` → `(1−x2, 1−y2, 1−x1, 1−y1)`. */
export const mirrorBezier = ([x1, y1, x2, y2]: Bezier): Bezier => [
  r4(1 - x2),
  r4(1 - y2),
  r4(1 - x1),
  r4(1 - y1),
];

// ---------------------------------------------------------------------------------------------
// Resolved figure
// ---------------------------------------------------------------------------------------------

/** One part's travel within a stage or action segment. Times in seconds at speed 1. */
export interface FigureMove {
  readonly part: string;
  /** From the program start (stages) or from the segment start (`FigureSegment`). */
  readonly start: number;
  readonly duration: number;
  /** Spec easing of the stage; for a reversed move `bezier` is the mirrored curve. */
  readonly easing: SpecEasing;
  readonly bezier: Bezier;
  /** True when the move runs from the exploded to the seated position (implode). */
  readonly reversed: boolean;
}

export interface ResolvedFigureStage {
  /** 1-based; a level `k` has stages 1..k applied. */
  readonly index: number;
  readonly label?: string;
  /** Program time (speed 1, uncompressed) the stage starts (incl. its delay) and ends. */
  readonly start: number;
  readonly end: number;
  readonly labels: "show" | "hide";
  /** Sorted by (start, part). */
  readonly moves: readonly FigureMove[];
}

export interface ResolvedFigurePart {
  readonly id: string;
  readonly label?: string;
  readonly detail: readonly string[];
  readonly type?: string;
  readonly tags: readonly string[];
  readonly image: string;
  readonly seat: readonly [number, number];
  /** Absent: straight up by the sprite height plus 20% (needs the sprite size, R-1). */
  readonly exploded?: readonly [number, number];
  readonly z?: number;
  readonly arrow: boolean;
  /** 1-based stage that moves the part; absent: no stage moves it (it stays seated). */
  readonly stage?: number;
}

export interface ResolvedFigure {
  readonly id: string;
  readonly label?: string;
  readonly base: string;
  readonly pose: "assembled" | "exploded";
  /** Parts in spec order. */
  readonly parts: readonly ResolvedFigurePart[];
  readonly stages: readonly ResolvedFigureStage[];
  /** Level of the base pose: 0 assembled, `stages.length` exploded. */
  readonly baseLevel: number;
}

/** The part of a program between two levels, as played by one action. */
export interface FigureSegment {
  readonly kind: "explode" | "implode";
  readonly from: number;
  readonly to: number;
  /** Seconds at speed 1, uncompressed. */
  readonly length: number;
  /** Sorted by (start, part). */
  readonly moves: readonly FigureMove[];
}

// ---------------------------------------------------------------------------------------------
// Selectors over figure part ids (§6.1 restricted to a flat list)
// ---------------------------------------------------------------------------------------------

interface Selectable {
  readonly id: string;
  readonly type?: string;
  readonly tags?: readonly string[];
}

const globRe = (glob: string): RegExp =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*+/g, "[a-z0-9-]*")
      .replace(/\?/g, "[a-z0-9-]")}$`,
  );

/**
 * Ids matched by one selector, in the order of `parts`. Terms: an id glob, `tag:`/`type:` globs,
 * `**` (every part). Figure parts are flat: a leading any-depth scope (`**` then a slash) is accepted, any other scope matches
 * nothing; `role:` matches nothing (figure parts have no role).
 */
export function matchFigureSelector(selector: string, parts: readonly Selectable[]): string[] {
  const segs = selector.split("/");
  const term = segs.pop() as string;
  if (segs.some((s) => s !== "**")) return [];
  if (term === "**") return parts.map((p) => p.id);
  const colon = term.indexOf(":");
  if (colon < 0) {
    const re = globRe(term);
    return parts.filter((p) => re.test(p.id)).map((p) => p.id);
  }
  const kind = term.slice(0, colon);
  const re = globRe(term.slice(colon + 1));
  if (kind === "tag")
    return parts.filter((p) => (p.tags ?? []).some((t) => re.test(t))).map((p) => p.id);
  if (kind === "type")
    return parts.filter((p) => p.type !== undefined && re.test(p.type)).map((p) => p.id);
  return [];
}

/** Candidate selector strings for did-you-mean: part ids, then `tag:`/`type:` forms. */
function selectorCandidates(parts: readonly Selectable[]): string[] {
  const tags = new Set<string>();
  const types = new Set<string>();
  for (const p of parts) {
    for (const t of p.tags ?? []) tags.add(`tag:${t}`);
    if (p.type !== undefined) types.add(`type:${p.type}`);
  }
  return [...parts.map((p) => p.id), ...[...tags].sort(), ...[...types].sort()];
}

// ---------------------------------------------------------------------------------------------
// Diagnostics helper
// ---------------------------------------------------------------------------------------------

type Sev = Diagnostic["severity"];
function mk(
  severity: Sev,
  code: string,
  path: string,
  message: string,
  suggestion?: string,
  params?: Record<string, unknown>,
): Diagnostic {
  return {
    severity,
    code,
    path,
    message,
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(params === undefined ? {} : { params }),
  };
}

// ---------------------------------------------------------------------------------------------
// Stage timing (§7.1)
// ---------------------------------------------------------------------------------------------

/**
 * Resolves one figure: selectors, who moves in which stage, and stage times. Stage `s` starts at
 * `S_s = E_{s−1} + delay_s` (`E_0 = 0`; figure stages are always "after") and ends at the latest
 * end of its moves (`S_s` when it moves nothing). Mover rank `r` starts at `S_s + r·stagger`.
 * Diagnostics: duplicate parts, empty selectors, parts moved by two stages, parts no stage
 * moves.
 */
export function resolveFigure(
  fig: SpecFigure,
  index: number,
): { figure: ResolvedFigure; diagnostics: Diagnostic[] } {
  const base = `/figures/${index}`;
  const diagnostics: Diagnostic[] = [];

  // Duplicate part ids: the first one wins, later ones are reported and dropped.
  const seen = new Map<string, number>();
  const specParts: { p: SpecFigure["parts"][number]; i: number }[] = [];
  fig.parts.forEach((p, i) => {
    const first = seen.get(p.id);
    if (first !== undefined) {
      diagnostics.push(
        mk(
          "error",
          "assembly/duplicate-part",
          `${base}/parts/${i}/id`,
          `Duplicate part id ${q(p.id)} in figure ${q(fig.id)} (first at /parts/${first})`,
          "Rename one part",
          { id: p.id, first: `${base}/parts/${first}/id` },
        ),
      );
      return;
    }
    seen.set(p.id, i);
    specParts.push({ p, i });
  });
  const selectable = specParts.map(({ p }) => ({
    id: p.id,
    ...(p.type === undefined ? {} : { type: p.type }),
    tags: p.tags ?? [],
  }));
  const seatY = new Map(specParts.map(({ p }) => [p.id, p.seat[1]]));
  const specIdx = new Map(specParts.map(({ p }, k) => [p.id, k]));

  const specStages =
    fig.stages ?? ([{ parts: ["**"] }] as readonly NonNullable<SpecFigure["stages"]>[number][]);
  const stageOf = new Map<string, number>();
  const stages: ResolvedFigureStage[] = [];
  let prevEnd = 0;
  specStages.forEach((st, si) => {
    const start = r4(prevEnd + (st.delay ?? 0));
    const stagger = st.stagger ?? 0.08;
    const duration = st.duration ?? 0.8;
    const easing = st.easing ?? "ease-in-out";
    const picked = new Set<string>();
    st.parts.forEach((sel, k) => {
      const at = `${base}/stages/${si}/parts/${k}`;
      const hit = matchFigureSelector(sel, selectable);
      if (hit.length === 0) {
        const near = closestMatches(sel, selectorCandidates(selectable), 1)[0];
        const scoped = sel.includes("/") && !/^(\*\*\/)+[^/]+$/.test(sel);
        diagnostics.push(
          mk(
            "warning",
            "assembly/selector-empty",
            at,
            scoped
              ? `Selector ${q(sel)} matches no part: figure parts are a flat list, so scoped selectors match nothing`
              : `Selector ${q(sel)} matches no part of figure ${q(fig.id)}`,
            near !== undefined
              ? `Did you mean "${near}"?`
              : `Parts: ${selectable
                  .slice(0, 8)
                  .map((s) => s.id)
                  .join(", ")}${selectable.length > 8 ? ", ..." : ""}`,
            { selector: sel },
          ),
        );
        return;
      }
      for (const id of hit) {
        const prior = stageOf.get(id);
        if (prior !== undefined && !picked.has(id)) {
          diagnostics.push(
            mk(
              "error",
              "assembly/moved-twice",
              at,
              `Part ${q(id)} is moved by stage ${prior} and again by stage ${si + 1}`,
              "Narrow one of the selectors so each part belongs to a single stage",
              { part: id, stages: [prior, si + 1] },
            ),
          );
          picked.add(id); // report once per stage
        } else if (prior === undefined) {
          picked.add(id);
        }
      }
    });
    const movers = [...picked].filter((id) => !stageOf.has(id));
    const cmp = (a: string, b: string): number =>
      (specIdx.get(a) as number) - (specIdx.get(b) as number);
    movers.sort(
      st.order === "top-down"
        ? (a, b) => (seatY.get(a) as number) - (seatY.get(b) as number) || cmp(a, b)
        : st.order === "bottom-up"
          ? (a, b) => (seatY.get(b) as number) - (seatY.get(a) as number) || cmp(a, b)
          : cmp,
    );
    const bez = BEZIER[easing];
    const moves: FigureMove[] = movers.map((part, r) => {
      stageOf.set(part, si + 1);
      return {
        part,
        start: r4(start + r * stagger),
        duration: r4(duration),
        easing,
        bezier: bez,
        reversed: false,
      };
    });
    moves.sort((a, b) => a.start - b.start || (a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
    const end =
      moves.length === 0 ? start : r4(Math.max(...moves.map((m) => m.start + m.duration)));
    stages.push({
      index: si + 1,
      ...(st.label === undefined ? {} : { label: st.label }),
      start,
      end,
      labels: st.labels ?? "show",
      moves,
    });
    prevEnd = end;
  });

  if (fig.stages !== undefined) {
    specParts.forEach(({ p, i }) => {
      if (stageOf.has(p.id)) return;
      diagnostics.push(
        mk(
          "warning",
          "assembly/part-not-staged",
          `${base}/parts/${i}`,
          `Part ${q(p.id)} is moved by no stage, so it stays seated`,
          'Add it to a stage\'s "parts" or remove the part',
          { id: p.id },
        ),
      );
    });
  }

  const parts: ResolvedFigurePart[] = specParts.map(({ p }) => ({
    id: p.id,
    ...(p.label === undefined ? {} : { label: p.label }),
    detail: p.detail ?? [],
    ...(p.type === undefined ? {} : { type: p.type }),
    tags: p.tags ?? [],
    image: p.image,
    seat: [p.seat[0], p.seat[1]],
    ...(p.exploded === undefined ? {} : { exploded: [p.exploded[0], p.exploded[1]] as const }),
    ...(p.z === undefined ? {} : { z: p.z }),
    arrow: p.arrow ?? false,
    ...(stageOf.has(p.id) ? { stage: stageOf.get(p.id) as number } : {}),
  }));

  return {
    figure: {
      id: fig.id,
      ...(fig.label === undefined ? {} : { label: fig.label }),
      base: fig.base,
      pose: fig.pose ?? "assembled",
      parts,
      stages,
      baseLevel: (fig.pose ?? "assembled") === "exploded" ? stages.length : 0,
    },
    diagnostics,
  };
}

/**
 * The segment an action plays between levels `from` and `to` (`from !== to`). Explode of stages
 * `from+1 … to` is shifted so stage `from+1` starts at 0; implode is the exact time reverse of
 * the explode segment `to+1 … from`: a move `[st, en]` becomes `[L − en, L − st]` with the
 * mirrored easing (§7.2).
 */
export function figureSegment(fig: ResolvedFigure, from: number, to: number): FigureSegment {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const first = fig.stages[lo];
  const last = fig.stages[hi - 1];
  if (first === undefined || last === undefined) {
    return { kind: from < to ? "explode" : "implode", from, to, length: 0, moves: [] };
  }
  const offset = first.start;
  const length = r4(last.end - offset);
  const forward = fig.stages.slice(lo, hi).flatMap((s) => s.moves);
  const moves: FigureMove[] =
    from < to
      ? forward.map((m) => ({ ...m, start: r4(m.start - offset) }))
      : forward.map((m) => ({
          ...m,
          start: r4(length - (m.start - offset + m.duration)),
          bezier: mirrorBezier(m.bezier),
          reversed: true,
        }));
  moves.sort((a, b) => a.start - b.start || (a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
  return { kind: from < to ? "explode" : "implode", from, to, length, moves };
}

// ---------------------------------------------------------------------------------------------
// Step windows and compression (§7.3)
// ---------------------------------------------------------------------------------------------

/**
 * Closing camera transition of a step of `duration` seconds. Same formula as
 * `anim/timeline.ts#transitionSeconds` (kept local so the scene stage does not import anim; a
 * test pins them together).
 */
export const transitionOf = (duration: number): number => Math.min(0.8, 0.25 * duration);

export interface StepWindow {
  /** Opening camera transition (step 1 only, when it zooms). */
  readonly lead: number;
  /** Closing camera transition (0 when the next view is the same). */
  readonly tr: number;
  /** Length of the motion window: `duration − lead − tr − 0.2` (floored at 0.05). */
  readonly window: number;
}

/**
 * Motion windows of every step. `views[i]` is the zoom target of step `i` (`undefined` = the
 * overview); the last step's closing transition eases back to the overview.
 */
export function stepWindows(
  durations: readonly number[],
  views: readonly (string | undefined)[],
): StepWindow[] {
  return durations.map((d, i) => {
    const lead = i === 0 && views[0] !== undefined ? transitionOf(d) : 0;
    const next = i + 1 < durations.length ? views[i + 1] : undefined;
    const tr = views[i] !== next ? transitionOf(d) : 0;
    return { lead, tr, window: Math.max(MIN_WINDOW, r4(d - lead - tr - HOLD)) };
  });
}

// ---------------------------------------------------------------------------------------------
// Step plan: actions on figures
// ---------------------------------------------------------------------------------------------

/** Which guard phase gates actions on a root id of a given kind (tracks §0). */
export type RootPhase = "phase1a" | "phase1b" | "phase2" | "phase3";

export interface PlanOptions {
  /** Phases still gated by the merge guard. Non-figure targets of a gated phase are reported
   * as `assembly/unknown-target` once `phase1a` is lifted (tracks §0). */
  readonly gated?: Readonly<Record<RootPhase, boolean>>;
}

const KEYS = ["explode", "implode", "build", "unbuild"] as const;
const actionKey = (a: SpecAssemblyAction): (typeof KEYS)[number] =>
  KEYS.find((k) => k in a) as (typeof KEYS)[number];

/**
 * Plans the figure actions of every step: levels are cumulative across steps; a step's actions
 * play in array order, each after the previous one unless `start` places it; if they need more
 * than the motion window they are compressed uniformly (`ResolvedAction.scale`).
 * Diagnostics: unknown/non-figure targets, programs, stage range, backwards moves, no-ops,
 * compression. Invalid actions are reported and left out of the plan.
 */
export function planFigureSteps(
  spec: PlatformCosmoSpec,
  figures: ReadonlyMap<string, ResolvedFigure>,
  views: readonly (string | undefined)[],
  opts: PlanOptions = {},
): { plan: AssemblyStepPlan[]; diagnostics: Diagnostic[] } {
  const steps: readonly SpecStep[] = spec.steps ?? [];
  const diagnostics: Diagnostic[] = [];
  const level = new Map<string, number>();
  for (const f of figures.values()) level.set(f.id, f.baseLevel);
  const windows = stepWindows(
    steps.map((s) => s.duration ?? 3),
    views,
  );
  const phaseOf = new Map<string, RootPhase | "none">();
  for (const r of spec.racks ?? []) phaseOf.set(r.id, "phase2");
  for (const a of spec.assemblies ?? []) phaseOf.set(a.id, "phase1b");
  for (const b of spec.storyboards ?? []) phaseOf.set(b.id, "phase3");
  for (const n of spec.nodes ?? []) phaseOf.set(n.id, "none");
  const sortedFigs = [...figures.keys()].sort();
  const plan: AssemblyStepPlan[] = [];

  steps.forEach((step, si) => {
    const planned: { action: ResolvedAction; natural: number }[] = [];
    let cursor = 0;
    (step.assembly ?? []).forEach((a, ai) => {
      const at = `/steps/${si}/assembly/${ai}`;
      const kind = actionKey(a);
      const target = (a as unknown as Record<string, string>)[kind] as string;
      const root = target.split("/")[0] as string;
      const fig = figures.get(root);
      if (fig === undefined) {
        // A non-figure target. While its phase is gated the guard already rejects it; after
        // phase1a lifts it must not resolve here (tracks §0), so report it unknown.
        const gatedPhases = opts.gated;
        if (gatedPhases === undefined || gatedPhases.phase1a) return;
        const phase = phaseOf.get(root);
        if (phase !== undefined && phase !== "none" && !gatedPhases[phase]) return; // lifted: other track
        diagnostics.push(
          mk(
            "error",
            "assembly/unknown-target",
            `${at}/${kind}`,
            phase === undefined
              ? `Unknown ${kind} target ${q(target)}`
              : `Cannot ${kind} ${q(target)}: this build only animates figures, not ${phase === "none" ? "nodes" : phase === "phase1b" ? "assemblies" : phase === "phase2" ? "racks and slots" : "storyboards"}`,
            closest(root, sortedFigs) !== undefined
              ? `Did you mean "${closest(root, sortedFigs)}"?`
              : sortedFigs.length > 0
                ? `Figures: ${sortedFigs.join(", ")}`
                : 'Declare a figure in "figures"',
            { id: target },
          ),
        );
        return;
      }
      if (target !== root) {
        diagnostics.push(
          mk(
            "error",
            "assembly/unknown-target",
            `${at}/${kind}`,
            `Figure ${q(root)} moves as a whole; ${q(target)} is not a target`,
            `Use "${root}"`,
            { id: target },
          ),
        );
        return;
      }
      if (kind === "build" || kind === "unbuild") {
        diagnostics.push(
          mk(
            "error",
            "assembly/figure-no-build",
            `${at}/${kind}`,
            `Figure ${q(root)} cannot ${kind}: figures explode and implode`,
            `Use "${kind === "build" ? "implode" : "explode"}" instead`,
            { id: target },
          ),
        );
        return;
      }
      const prog = (a as { program?: string }).program;
      if (prog !== undefined) {
        diagnostics.push(
          mk(
            "error",
            "assembly/unknown-program",
            `${at}/program`,
            `Figure ${q(root)} has no programs (program ${q(prog)}); its stages are its only program`,
            'Remove "program"',
            { id: prog },
          ),
        );
        return;
      }
      const n = fig.stages.length;
      const cur = level.get(root) as number;
      const to = (a as { to?: number }).to ?? (kind === "explode" ? n : 0);
      if (to > n) {
        diagnostics.push(
          mk(
            "error",
            "assembly/stage-out-of-range",
            `${at}/to`,
            `Figure ${q(root)} has ${n} stage${n === 1 ? "" : "s"}; "to": ${to} is out of range`,
            `Use a value from 0 to ${n}`,
            { to, stages: n },
          ),
        );
        return;
      }
      if (kind === "explode" && to < cur) {
        diagnostics.push(
          mk(
            "error",
            "assembly/explode-backwards",
            `${at}/to`,
            `Figure ${q(root)} is at stage ${cur}; explode to ${to} would go backwards`,
            `Use "implode" to return to stage ${to}`,
            { from: cur, to },
          ),
        );
        return;
      }
      if (kind === "implode" && to > cur) {
        diagnostics.push(
          mk(
            "error",
            "assembly/implode-forwards",
            `${at}/to`,
            `Figure ${q(root)} is at stage ${cur}; implode to ${to} would go forwards`,
            `Use "explode" to reach stage ${to}`,
            { from: cur, to },
          ),
        );
        return;
      }
      let natural = 0;
      if (to === cur) {
        diagnostics.push(
          mk(
            "info",
            "assembly/no-op-action",
            at,
            `${kind} of ${q(root)} does not change its stage (already at ${cur})`,
            undefined,
            { level: cur },
          ),
        );
      } else natural = figureSegment(fig, cur, to).length;
      const startSpec = (a as { start?: number }).start;
      const start = startSpec ?? cursor;
      cursor = r4(start + natural);
      level.set(root, to);
      planned.push({
        natural,
        action: {
          target: root,
          kind: kind === "explode" ? "explode" : "implode",
          program: FIGURE_PROGRAM,
          from: cur,
          to,
          start,
          length: natural,
          scale: 1,
          implied: [],
        },
      });
    });

    // Compression (§7.3)
    const w = windows[si] as StepWindow;
    const need = planned.reduce((m, p) => Math.max(m, p.action.start + p.natural), 0);
    let scale = 1;
    if (need > w.window) {
      scale = r4(w.window / need);
      const fit = Math.ceil(need + w.lead + w.tr + HOLD);
      diagnostics.push(
        mk(
          scale < 0.5 ? "warning" : "info",
          "assembly/compressed",
          `/steps/${si}/assembly`,
          `The step's actions need ${r2(need)} s but its motion window is ${r2(w.window)} s; they play at ${Math.round(scale * 100)}% length`,
          `Set "duration": ${fit} on this step`,
          { need: r2(need), window: r2(w.window), scale, duration: fit },
        ),
      );
    }
    const actions = planned.map(({ action, natural }) => ({
      ...action,
      start: r4(action.start * scale),
      length: r4(natural * scale),
      scale,
    }));
    const poses: Record<string, readonly ProgramLevel[]> = {};
    for (const id of sortedFigs)
      poses[id] = [{ program: FIGURE_PROGRAM, level: level.get(id) as number }];
    plan.push({ step: si + 1, actions, poses, view: 0 });
  });
  return { plan, diagnostics };
}

// ---------------------------------------------------------------------------------------------
// Boards, images and credits
// ---------------------------------------------------------------------------------------------

const SOURCE_KEYS = ["document", "page", "figure", "license", "attribution", "url"] as const;

function toSource(s: SpecSource | undefined): AssetSource | undefined {
  if (s === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of SOURCE_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return Object.keys(out).length > 0 ? (out as AssetSource) : undefined;
}

export interface BoardOptions {
  /** Where figures without `pos` start: placed in a row along +x, one tile apart. */
  readonly origin?: Vec3;
  /** Zoom target of each step (`SceneStep.focus`), for the motion windows. */
  readonly views?: readonly (string | undefined)[];
  /** Merge-guard groups, for the post-lift unknown-target rule (see `PlanOptions`). */
  readonly gated?: PlanOptions["gated"];
}

export interface FigureScene {
  /** Figures by id (spec order of `Map` insertion). */
  readonly figures: ReadonlyMap<string, ResolvedFigure>;
  /** Diagnostics of the resolution and of the step plan. */
  readonly diagnostics: readonly Diagnostic[];
  readonly assemblies: SceneAssemblies;
}

/** Image keys of a figure in first-use order: the base, then the parts' sprites. */
function figureImages(f: ResolvedFigure): string[] {
  const out: string[] = [];
  for (const k of [f.base, ...f.parts.map((p) => p.image)]) if (!out.includes(k)) out.push(k);
  return out;
}

/**
 * Figures of a spec as scene content: boards, step plan, image keys and credits. Returns
 * undefined without `figures`, so pre-1.2 scenes are unchanged.
 */
export function buildFigureScene(
  spec: PlatformCosmoSpec,
  opts: BoardOptions = {},
): FigureScene | undefined {
  const specFigures = spec.figures;
  if (specFigures === undefined) return undefined;
  const diagnostics: Diagnostic[] = [];
  const figures = new Map<string, ResolvedFigure>();
  const boards: SceneFlatBoard[] = [];
  const used: string[] = [];
  const credits: AssetSource[] = [];
  const creditKeys = new Set<string>();
  const imageSource = new Map<string, AssetSource | undefined>(
    (spec.images ?? []).map((i) => [i.id, toSource(i.source)]),
  );
  const credit = (s: AssetSource | undefined): void => {
    if (s === undefined) return;
    const key = JSON.stringify(s);
    if (creditKeys.has(key)) return;
    creditKeys.add(key);
    credits.push(s);
  };
  const origin = opts.origin ?? { x: 0, y: 0, z: 0 };
  let nextX = origin.x;

  specFigures.forEach((sf, i) => {
    const { figure, diagnostics: d } = resolveFigure(sf, i);
    diagnostics.push(...d);
    if (figures.has(figure.id)) return; // duplicate id: reported by semantic validation
    figures.set(figure.id, figure);
    const width = sf.width ?? DEFAULT_WIDTH;
    const images = figureImages(figure);
    for (const k of images) if (!used.includes(k)) used.push(k);
    const anchor: Vec3 =
      sf.pos === undefined
        ? { x: r2(nextX), y: origin.y, z: 0 }
        : { x: sf.pos.x, y: sf.pos.y, z: 0 };
    if (sf.pos === undefined) nextX += width + 1;
    const source = toSource(sf.source);
    boards.push({
      id: figure.id,
      kind: "figure",
      ...(figure.label === undefined ? {} : { label: figure.label }),
      anchor,
      width,
      images,
      ...(source === undefined ? {} : { source }),
    });
    credit(source);
    credit(imageSource.get(figure.base));
    sf.parts.forEach((p) => {
      credit(toSource(p.source));
      credit(imageSource.get(p.image));
    });
  });

  const views = opts.views ?? (spec.steps ?? []).map((s) => s.focus);
  const planned = planFigureSteps(spec, figures, views, opts.gated ? { gated: opts.gated } : {});
  diagnostics.push(...planned.diagnostics);

  return {
    figures,
    diagnostics,
    assemblies: {
      assemblies: [],
      boards: boards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      plan: planned.plan,
      images: used.sort(),
      credits,
    },
  };
}
