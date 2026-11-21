/**
 * Assembly render model and DOM (Track A1, A1-3; docs/design/assemblies.md §6.6, §7.4, §9, §10,
 * §11.3, §12). From the resolved assemblies and their step plan this builds
 *
 *  - the depth epochs (A1-2a) over the loop's moves, and the ONE DOM order every epoch is a
 *    subsequence of (Phase 1b: one copy per item, `copies = 1`);
 *  - the wrapper chain of §9.4 per item (`host > clip > motion > visible > fade > part`) and its
 *    tracks (`PartTrack`). The DOM is neutral (seated, everything visible, no pose attributes):
 *    every output applies `frameAt(t)` (static: `frameAt(0)`) as attribute overrides or CSS;
 *  - labels, leaders and top-face labels (labels.ts);
 *  - reach-bounds extents (swept boxes of every phase), per-step END-pose focus rects, `frameAt`
 *    / `stepEnd` for frame and per-step outputs, `settled` times.
 *
 * Nothing here runs unless the scene has assemblies; `buildModel` gates on that, so 1.1 and
 * figure output stay byte-identical. Pure and deterministic (sorted inputs, rounding at 2/4
 * decimals); never throws on odd input: problems are diagnostics.
 */
import type {
  AssemblyFrameState,
  AssemblyIdScheme,
  AssemblyRenderModel,
  Box3,
  Diagnostic,
  IdScheme,
  ImageAsset,
  ImageAssetResolver,
  OpacityKey,
  PartTrack,
  Projection,
  Rect,
  SceneGraph,
  SvgElement,
  SvgNode,
  TrackKey,
  Vec2,
} from "../../contracts/index.js";
import {
  DEFAULT_DEPTH_BUDGETS,
  depthEpochs,
  moveOffsetAt,
  type DepthBudgets,
  type DepthItemInput,
} from "../../depth/epochs.js";
import { h } from "../../emit/xml.js";
import { projectBoxBounds, unionRects } from "../../geometry/index.js";
import { endsAwayFromBase } from "../../scene/assembly/timing.js";
import { closesLoop, resolveFigure } from "../../scene/boards.js";
import type { PlatformCosmoSpec } from "../../schema/types.gen.js";
import { stepTimes } from "../boards/timeline.js";
import { clipDef, partGroup, wrap, type DomContext, type Wrappers } from "./dom.js";
import { buildLabels, type LabelTrack, type TextSpec } from "./labels.js";
import { buildLoop, type StageRun } from "./loop.js";
import {
  MoveIndex,
  evalOffset,
  evalOpacity,
  stepEndTime,
  evalVisible,
  offsetTrack,
  plain,
  relativeMoves,
  round2,
  translateFull,
  translateOf,
  visibilityTrack,
  windowsTrack,
} from "./tracks.js";
import type { AssemblyRenderModelX, StaticFadeTrack, StaticItem, StepClock } from "./types.js";
import { depthItems, worldLeaves, type WorldLeaf } from "./world.js";

export type { AssemblyRenderModelX, LabelTrack, StaticFadeTrack, StaticItem, StepClock };
export { worldLeaves, depthItems } from "./world.js";
export { buildLoop } from "./loop.js";

/** Leaf parts per spec (§13, `budget/assembly-parts` error beyond). */
export const MAX_LEAVES = 2000;
/** Opacity of leaves a stage dims with `fade` (§6.6). */
export const FADE_OPACITY = 0.25;

export interface AssemblyRenderContext {
  readonly scene: SceneGraph;
  readonly spec?: PlatformCosmoSpec | undefined;
  readonly images?: ImageAssetResolver | undefined;
  readonly projection: Projection;
  readonly ids: IdScheme & AssemblyIdScheme;
  readonly prefix: string;
  readonly labelSize: number;
  readonly fs: number;
  readonly text: (o: TextSpec) => SvgElement;
  readonly fit: (text: string, size: number, bold: boolean, maxWidth: number) => string;
  readonly nudge: (box: Rect, placed: readonly Rect[]) => { dy: number };
  /** Scene objects that share the depth order (default none, see model.ts). */
  readonly statics?: readonly StaticItem[];
  readonly budgets?: Partial<DepthBudgets>;
  /** Focus rect margins, as `RenderModel.focusRects` (default none). */
  readonly focusMargin?: { readonly side: number; readonly bottom: number };
}

export interface AssemblyBuild {
  readonly model: AssemblyRenderModelX;
  /** The depth-ordered items, appended to the objects layer. */
  readonly objects: SvgNode[];
  /** Leader labels and top-face labels, appended to the labels layer. */
  readonly labels: SvgNode[];
  /** Non-rendered definitions (clip paths, image placeholders) for the background layer. */
  readonly defs: SvgNode[];
  /** Screen rects that must stay inside the view box (swept boxes, labels, leaders). */
  readonly extents: Rect[];
  readonly diagnostics: Diagnostic[];
}

const EPS = 1e-9;

interface Registered {
  readonly key: string;
  readonly track: PartTrack;
  readonly host?: string;
  readonly motion?: string;
  readonly visible?: string;
  readonly fade?: string;
}

/** Swept screen box of a box over `[ta, tb]` (§9.3): rest ⊕ the sum of the move intervals. */
function swept(box: Box3, chain: ReturnType<MoveIndex["chain"]>, ta: number, tb: number): Box3 {
  let lx = 0;
  let ly = 0;
  let lz = 0;
  let hx = 0;
  let hy = 0;
  let hz = 0;
  for (const m of chain) {
    const a = moveOffsetAt(m, ta);
    const b = moveOffsetAt(m, tb);
    lx += Math.min(a.x, b.x);
    ly += Math.min(a.y, b.y);
    lz += Math.min(a.z, b.z);
    hx += Math.max(a.x, b.x);
    hy += Math.max(a.y, b.y);
    hz += Math.max(a.z, b.z);
  }
  return {
    origin: { x: box.origin.x + lx, y: box.origin.y + ly, z: box.origin.z + lz },
    size: { x: box.size.x + hx - lx, y: box.size.y + hy - ly, z: box.size.z + hz - lz },
  };
}

export function buildAssemblyRender(
  ctx: AssemblyRenderContext,
): AssemblyBuild | { readonly diagnostics: Diagnostic[] } | undefined {
  const { scene, projection, ids } = ctx;
  const assemblies = scene.assemblies?.assemblies ?? [];
  if (assemblies.length === 0) return undefined;
  const diagnostics: Diagnostic[] = [];
  const specAsm = new Map((ctx.spec?.assemblies ?? []).map((a) => [a.id, a]));

  // ---- cap before any work sized by the input -------------------------------------------
  let leafCount = 0;
  for (const a of assemblies) leafCount += a.leaves.length;
  if (leafCount > MAX_LEAVES) {
    diagnostics.push({
      severity: "error",
      code: "budget/assembly-parts",
      path: "/assemblies",
      message: `${leafCount} leaf parts exceed the limit of ${MAX_LEAVES}; assemblies are not drawn`,
      suggestion: "Use fewer parts (fewer `count` repeats, simpler `use` templates)",
      params: { parts: leafCount, limit: MAX_LEAVES },
    });
    return { diagnostics };
  }

  const leaves = worldLeaves(assemblies);
  const leafByPath = new Map(leaves.map((l) => [l.path, l]));

  // ---- loop clock and moves --------------------------------------------------------------
  const plan = scene.assemblies?.plan ?? [];
  const basePoses: Record<string, readonly { program: string; level: number }[]> = {};
  for (const a of assemblies) basePoses[a.id] = a.basePose;
  let closeLast = endsAwayFromBase(plan[plan.length - 1]?.poses, basePoses);
  if (!closeLast && ctx.spec?.figures !== undefined) {
    closeLast = closesLoop(
      ctx.spec.figures.map((f, i) => resolveFigure(f, i).figure),
      plan,
    );
  }
  const { times, total } = stepTimes(scene, 1, closeLast);
  const clock: StepClock[] = times.map((t, i) => ({
    step: i + 1,
    start: t.start,
    duration: t.duration,
    open: t.open,
    end: t.end,
  }));
  const loopBuild = buildLoop(assemblies, plan, times, total, closeLast);
  const index = new MoveIndex(loopBuild.moves);

  // ---- depth epochs ----------------------------------------------------------------------
  const statics = (ctx.statics ?? []).filter((s) => !leafByPath.has(s.key));
  const inputs: DepthItemInput[] = [
    ...depthItems(leaves),
    ...statics.map((s) => ({ key: s.key, box: s.box })),
  ];
  const result = depthEpochs(inputs, loopBuild.moves, total, {
    projection,
    ids: { partClip: ids.partClip },
    ...(ctx.budgets === undefined ? {} : { budgets: ctx.budgets }),
  });
  diagnostics.push(...result.diagnostics);
  const pathOf = new Map<string, string | undefined>(inputs.map((i) => [i.key, i.path]));
  const clipOf = new Map(result.clips.map((c) => [c.item, c]));
  const epochSets = result.epochs.map((e) => new Set(e.order));

  // ---- fades (§6.6) ----------------------------------------------------------------------
  const fadeWindows = new Map<string, { a: number; b: number }[]>();
  const staticWindows: { a: number; b: number }[] = [];
  for (const run of loopBuild.runs) {
    if (run.kind !== "explode" || run.stage.fade === "none") continue;
    const next = loopBuild.runs.find(
      (r) =>
        r.kind === "explode" &&
        r.assembly === run.assembly &&
        r.step === run.step &&
        r.program === run.program &&
        r.stage.index === run.stage.index + 1,
    );
    const w = { a: run.t0, b: Math.max(run.t0, next === undefined ? run.holdEnd : next.t0) };
    const moved = (leaf: string): boolean =>
      run.moves.some((m) => leaf === m.path || leaf.startsWith(`${m.path}/`));
    for (const l of leaves) {
      const inOwner = l.path === run.program.owner || l.path.startsWith(`${run.program.owner}/`);
      const dim =
        run.stage.fade === "unselected" ? inOwner && !moved(l.path) : l.assembly !== run.assembly;
      if (!dim) continue;
      const list = fadeWindows.get(l.path);
      if (list === undefined) fadeWindows.set(l.path, [w]);
      else list.push(w);
    }
    if (run.stage.fade === "others") staticWindows.push(w);
  }

  let elements = 0;

  // ---- labels ------------------------------------------------------------------------------
  const labels = buildLabels({
    projection,
    prefix: ctx.prefix,
    ids,
    labelSize: ctx.labelSize,
    fs: ctx.fs,
    text: ctx.text,
    fit: ctx.fit,
    nudge: ctx.nudge,
    assemblies,
    labelMode: (id) => specAsm.get(id)?.labels ?? "exploded",
    leaves,
    index,
    runs: loopBuild.runs,
    loop: total,
    ...(loopBuild.closure === undefined ? {} : { closure: loopBuild.closure }),
  });
  elements += labels.elements;
  diagnostics.push(...labels.diagnostics);
  const labelTracks = [...labels.tracks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ---- tracks and wrappers per item -------------------------------------------------------
  const registered: Registered[] = [];
  // a key at every instant the DOM swaps (epoch starts) and at approximate edges
  const extraTimes = [
    ...result.epochs.map((e) => e.t0),
    ...result.approximate.flatMap((a) => [a.t0, a.t1]),
  ];
  const tracks: PartTrack[] = [];
  const domCtx: DomContext = {
    projection,
    ids,
    prefix: ctx.prefix,
    images: ctx.images,
    assets: new Map<string, ImageAsset>(),
    defs: [],
    diagnostics,
    count: (n) => {
      elements += n;
    },
  };
  const objects: SvgNode[] = [];
  const staticByKey = new Map(statics.map((s) => [s.key, s]));
  const staticFades: StaticFadeTrack[] = [];

  for (const key of result.order) {
    const st = staticByKey.get(key);
    if (st !== undefined) {
      const opacity = windowsTrack(staticWindows, FADE_OPACITY, total);
      if (opacity.length === 0) {
        objects.push(st.node);
        continue;
      }
      const id = ids.fadeWrap(key);
      staticFades.push({ key, id, opacity });
      const o0 = round2(evalOpacity(opacity, 0));
      objects.push(h("g", { id, ...(o0 < 1 ? { opacity: o0 } : {}) }, st.node));
      elements += 1;
      continue;
    }
    const path = pathOf.get(key);
    const leaf = path === undefined ? undefined : leafByPath.get(path);
    if (path === undefined || leaf === undefined) continue;
    const half = key === `${path}__back` ? "back" : key === `${path}__front` ? "front" : undefined;
    const clip = clipOf.get(key);
    const chain = index.chain(path);
    let host: readonly TrackKey[] = [];
    let motion: readonly TrackKey[];
    if (clip !== undefined) {
      const solidPath = pathOf.get(clip.solid);
      const solidChain = solidPath === undefined ? [] : index.chain(solidPath);
      host = offsetTrack(plain(solidChain), total, projection, extraTimes);
      motion = offsetTrack(relativeMoves(chain, solidChain), total, projection, extraTimes);
    } else {
      motion = offsetTrack(plain(chain), total, projection, extraTimes);
    }
    const visibility = visibilityTrack(
      result.epochs.map((e, i) => ({ t0: e.t0, visible: (epochSets[i] as Set<string>).has(key) })),
      total,
    );
    const opacity = windowsTrack(fadeWindows.get(path) ?? [], FADE_OPACITY, total);
    const track: PartTrack = { copy: key, host, motion, visibility, opacity };
    tracks.push(track);
    const w: { -readonly [K in keyof Wrappers]: Wrappers[K] } = {};
    const reg: { -readonly [K in keyof Registered]: Registered[K] } = { key, track };
    if (clip !== undefined) {
      if (host.length > 0) {
        const hid = ids.partHost(key);
        const tf = translateOf(evalOffset(host, 0));
        w.host = { id: hid, ...(tf === undefined ? {} : { transform: tf }) };
        reg.host = hid;
      }
      domCtx.defs.push(clipDef(domCtx, clip.clip, clip.prism));
      w.clip = clip.clip;
    }
    if (motion.length > 0) {
      const mid = ids.partMotion(key);
      const tf = translateOf(evalOffset(motion, 0));
      w.motion = { id: mid, ...(tf === undefined ? {} : { transform: tf }) };
      reg.motion = mid;
    }
    if (visibility.length > 0) {
      const vid = ids.partVisible(key);
      w.visible = { id: vid, hidden: !evalVisible(visibility, 0) };
      reg.visible = vid;
    }
    if (opacity.length > 0) {
      const fid = ids.partFade(key);
      w.fade = { id: fid, opacity: round2(evalOpacity(opacity, 0)) };
      reg.fade = fid;
    }
    registered.push(reg);
    const top = labels.top.get(path);
    objects.push(
      wrap(partGroup(domCtx, leaf, half, top === undefined ? {} : { extra: [top] }), w, domCtx),
    );
  }

  // ---- reach bounds (§10): swept boxes of every phase -------------------------------------
  const extents: Rect[] = [...labels.extents];
  const budgets = { ...DEFAULT_DEPTH_BUDGETS, ...ctx.budgets };
  const sweepOk = loopBuild.moves.length <= budgets.maxMoves;
  const reachRects: Rect[] = [];
  for (const l of leaves) {
    const b = l.geometry.bounds;
    const chain = index.chain(l.path);
    reachRects.push(projectBoxBounds(projection, b));
    if (chain.length === 0) continue;
    const ts = [...new Set([0, total, ...chain.flatMap((m) => [m.t0, m.t1])])]
      .filter((t) => t >= 0 && t <= total + EPS)
      .sort((x, y) => x - y);
    if (!sweepOk) {
      for (const t of ts) {
        const d = index.displacement(l.path, t);
        reachRects.push(
          projectBoxBounds(projection, {
            origin: { x: b.origin.x + d.x, y: b.origin.y + d.y, z: b.origin.z + d.z },
            size: b.size,
          }),
        );
      }
      continue;
    }
    for (let i = 0; i + 1 < ts.length; i++) {
      reachRects.push(
        projectBoxBounds(projection, swept(b, chain, ts[i] as number, ts[i + 1] as number)),
      );
    }
    // instants (base pose at t = 0): the pose itself
    const d0 = index.displacement(l.path, 0);
    reachRects.push(
      projectBoxBounds(projection, {
        origin: { x: b.origin.x + d0.x, y: b.origin.y + d0.y, z: b.origin.z + d0.z },
        size: b.size,
      }),
    );
  }
  const reach = reachRects.length === 0 ? undefined : unionRects(reachRects);
  if (reach !== undefined) extents.push(reach);

  // ---- frame states ------------------------------------------------------------------------
  const stateAt = (t: number): AssemblyFrameState => {
    const transforms: Record<string, string> = {};
    const hidden: string[] = [];
    const visible: string[] = [];
    const opacity: Record<string, number> = {};
    for (const r of registered) {
      if (r.host !== undefined) transforms[r.host] = translateFull(evalOffset(r.track.host, t));
      if (r.motion !== undefined) {
        transforms[r.motion] = translateFull(evalOffset(r.track.motion, t));
      }
      if (r.visible !== undefined) {
        (evalVisible(r.track.visibility, t) ? visible : hidden).push(r.visible);
      }
      if (r.fade !== undefined) opacity[r.fade] = round2(evalOpacity(r.track.opacity, t));
    }
    for (const s of staticFades) opacity[s.id] = round2(evalOpacity(s.opacity, t));
    for (const lt of labelTracks) {
      if (lt.motion.length > 0) transforms[lt.id] = translateFull(evalOffset(lt.motion, t));
      opacity[lt.id] = round2(evalOpacity(lt.opacity, t));
    }
    hidden.sort();
    visible.sort();
    const sortedT: Record<string, string> = {};
    for (const k of Object.keys(transforms).sort()) sortedT[k] = transforms[k] as string;
    const sortedO: Record<string, number> = {};
    for (const k of Object.keys(opacity).sort()) sortedO[k] = opacity[k] as number;
    return { transforms: sortedT, hidden, visible, opacity: sortedO };
  };
  // the loop repeats: any time wraps (as boards do)
  const frameAt = (t: number): AssemblyFrameState =>
    stateAt(total > 0 ? ((t % total) + total) % total : 0);
  // the END of a step is read where its closing hold ends, which may be the loop's end: no wrap
  const stepEnd = (step: number): AssemblyFrameState => {
    const c = clock[step - 1];
    return stateAt(c === undefined ? 0 : stepEndTime(Math.min(c.end, total)));
  };

  // ---- focus rects at the END pose (§7.4) -------------------------------------------------
  const nodeLeaves = new Map<string, WorldLeaf[]>();
  for (const l of leaves) {
    let p = l.path;
    for (;;) {
      const list = nodeLeaves.get(p);
      if (list === undefined) nodeLeaves.set(p, [l]);
      else list.push(l);
      const k = p.lastIndexOf("/");
      if (k < 0) break;
      p = p.slice(0, k);
    }
  }
  const m = ctx.focusMargin ?? { side: 0, bottom: 0 };
  const focusRect = (step: number, id: string): Rect | undefined => {
    const c = clock[step - 1];
    const list = nodeLeaves.get(id);
    if (c === undefined || list === undefined) return undefined;
    const at = stepEndTime(Math.min(c.end, total));
    const rects = list.map((l) => {
      const d = index.displacement(l.path, at);
      const b = l.geometry.bounds;
      return projectBoxBounds(projection, {
        origin: { x: b.origin.x + d.x, y: b.origin.y + d.y, z: b.origin.z + d.z },
        size: b.size,
      });
    });
    // what the camera frames also holds the labels and leaders shown from its lead to the end
    const lead = Math.min(0.8, 0.25 * c.duration);
    const r = unionRects([...rects, ...labels.rectsUnder(id, Math.max(0, c.start - lead), at)]);
    return {
      x: round2(r.x - m.side),
      y: round2(r.y - m.side),
      width: round2(r.width + 2 * m.side),
      height: round2(r.height + 2 * m.side + m.bottom),
    };
  };

  // ---- depth items, model ------------------------------------------------------------------
  const model: AssemblyRenderModelX = {
    ids,
    items: result.items,
    epochs: result.epochs,
    tracks: tracks.sort((a, b) => (a.copy < b.copy ? -1 : a.copy > b.copy ? 1 : 0)),
    loop: total,
    settled: loopBuild.settled,
    focusRect,
    frameAt,
    stepEnd,
    elements,
    labelTracks,
    staticFades,
    assets: domCtx.assets,
    clock,
    ...(loopBuild.closure === undefined ? {} : { closure: loopBuild.closure }),
    approximate: result.approximate,
    moves: loopBuild.moves,
    reach,
  };
  const _check: AssemblyRenderModel = model;
  void _check;
  return {
    model,
    objects,
    labels: labels.nodes,
    defs: domCtx.defs,
    extents,
    diagnostics,
  };
}

export type { StageRun, OpacityKey, Vec2 };
