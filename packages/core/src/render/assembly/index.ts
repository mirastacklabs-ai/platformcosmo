/**
 * Assembly render model and DOM (Track A1, A1-3; docs/design/assemblies.md §6.6, §7.4, §9, §10,
 * §11.3, §12). From the resolved assemblies and their step plan this builds
 *
 *  - the depth epochs (A1-2a) over the loop's moves, and the ONE DOM order every epoch is a
 *    subsequence of, with depth copies where the order changes (A1-2b, §9.4): copy k ≥ 1 of an
 *    item is a full duplicate of its subtree with every id suffixed `__c<k>`, and its own
 *    visibility track; `ids.copyIds` lists an element's ids across copies;
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
  QuarterTurn,
  Rect,
  SceneAssembly,
  SceneGraph,
  SceneLevel,
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
import { resolveStoryboard } from "../../scene/storyboards.js";
import { closesLoop, resolveFigure } from "../../scene/boards.js";
import type { PlatformCosmoSpec } from "../../schema/types.gen.js";
import { stepTimes } from "../boards/timeline.js";
import { parseCopyKey } from "../../depth/copies.js";
import { copySuffix } from "../../emit/ids.js";
import { ELEMENT_WARN, MAX_LEVELS } from "../../scene/assembly/levels.js";
import { MAX_VIEWS } from "../../scene/assembly/views.js";
import { levelOf } from "../../scene/assembly/levels.js";
import { buildLevelGroups, levelFocusRect, roundRect } from "./levels.js";
import { groupTracks, placementAttr } from "./groups.js";
import { scopeIds, viewNode, viewRender } from "./views.js";
import { clipDef, partGroup, withIdSuffix, wrap, type DomContext, type Wrappers } from "./dom.js";
import { buildLabels, type LabelTrack, type TextSpec } from "./labels.js";
import { andVisibility, presenceTracks, presentWindows, type PresenceTracks } from "./builds.js";
import { flightTracks, slotOf } from "./flights.js";
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
  /**
   * Close-up level groups for the OVERLAY layer (pinned against the camera, a sibling of it,
   * §8.4); absent without levels. Their content is in the levels' own coordinates.
   */
  readonly levelNodes?: SvgNode[];
}

const EPS = 1e-9;

/** Start tags of the element trees: the REAL element count of what a group draws (§13). */
function countElements(nodes: readonly SvgNode[]): number {
  let n = 0;
  const walk = (list: readonly SvgNode[]): void => {
    for (const x of list) {
      if (typeof x !== "object" || !("tag" in x)) continue;
      n++;
      walk(x.children ?? []);
    }
  };
  walk(nodes);
  return n;
}

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

/** Everything one group (the main scene, a quarter-turn view, a close-up level) is built from. */
export interface GroupInput {
  readonly assemblies: readonly SceneAssembly[];
  /** Id scheme of the group (views scope it, see views.ts). */
  readonly ids: IdScheme & AssemblyIdScheme;
  /** Scene objects sharing the depth order (the main scene only). */
  readonly statics: readonly StaticItem[];
  /** The ONE loop clock every group of the scene shares. */
  readonly clock: LoopClock;
  /** Image assets by hash, shared by the groups of a scene so each placeholder is defined once. */
  readonly assets: Map<string, ImageAsset>;
  /** Paths of close-up levels: actions on them belong to their own group (loop.ts). */
  readonly foreign?: readonly string[];
  /** Instance path -> id of the spec assembly it is built from (close-up levels). */
  readonly templateOf?: ReadonlyMap<string, string>;
}

/** Step times of the master loop (`stepTimes`) and whether it closes (§7.4). */
export interface LoopClock {
  readonly times: ReturnType<typeof stepTimes>["times"];
  readonly total: number;
  readonly closeLast: boolean;
}

/** One built group: the contract-visible parts plus what the level and view code needs. */
export interface GroupBuild extends AssemblyBuild {
  /** Screen rect of a node (assembly, sub-assembly or part) at the END of a step, margin-free. */
  nodeRect(step: number, id: string): Rect | undefined;
}

function buildGroup(ctx: AssemblyRenderContext, input: GroupInput): GroupBuild {
  const { scene, projection } = ctx;
  const { ids, assemblies } = input;
  const diagnostics: Diagnostic[] = [];
  const specAsm = new Map((ctx.spec?.assemblies ?? []).map((a) => [a.id, a]));

  const leaves = worldLeaves(assemblies);
  const leafByPath = new Map(leaves.map((l) => [l.path, l]));

  // ---- loop clock and moves --------------------------------------------------------------
  const plan = scene.assemblies?.plan ?? [];
  const { times, total, closeLast } = input.clock;
  const clock: StepClock[] = times.map((t, i) => ({
    step: i + 1,
    start: t.start,
    duration: t.duration,
    open: t.open,
    end: t.end,
  }));
  const loopBuild = buildLoop(assemblies, plan, times, total, closeLast, input.foreign);
  const index = new MoveIndex(loopBuild.moves);

  // ---- depth epochs ----------------------------------------------------------------------
  const statics = input.statics.filter((s) => !leafByPath.has(s.key));
  // built parts exist in windows only (B-3): the depth order skips them while absent
  const pres = new Map<string, PresenceTracks>();
  for (const [path, p] of loopBuild.presence) {
    pres.set(path, presenceTracks(p, loopBuild.loopFades.get(path), total, loopBuild.closure));
  }
  const inputs: DepthItemInput[] = [
    ...depthItems(leaves).map((it) => {
      const w =
        it.path === undefined
          ? undefined
          : presentWindows(pres.get(it.path)?.visibility ?? [], total);
      return w === undefined ? it : { ...it, present: w };
    }),
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
    labelMode: (id) => specAsm.get(input.templateOf?.get(id) ?? id)?.labels ?? "exploded",
    leaves,
    index,
    runs: loopBuild.runs,
    loop: total,
    ...(loopBuild.closure === undefined ? {} : { closure: loopBuild.closure }),
  });
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
    assets: input.assets,
    defs: [],
    diagnostics,
    count: () => {},
  };
  const objects: SvgNode[] = [];
  const staticByKey = new Map(statics.map((s) => [s.key, s]));
  const staticFades: StaticFadeTrack[] = [];

  // Per item (shared by its copies): the copy-0 part group, the motion tracks, the fade track.
  interface ItemDom {
    readonly inner: SvgElement;
    readonly host: readonly TrackKey[];
    readonly motion: readonly TrackKey[];
    readonly opacity: OpacityKey[];
    readonly clip: string | undefined;
  }
  const itemDom = new Map<string, ItemDom>();
  const copiesOf = new Map(result.items.map((i) => [i.item, i.copies]));
  /**
   * Copy-0 element id → the ids of that element in every copy (copy 0 first), for items with more
   * than one copy (`copyIds`). Recorded as emitted: wrapper ids come from the (possibly
   * view-scoped) scheme, part-group ids from `withIdSuffix`.
   */
  const copyList = new Map<string, string[]>();
  const collectIds = (node: SvgNode, n: number): void => {
    if (typeof node !== "object" || !("tag" in node)) return;
    const id = node.attrs?.["id"];
    if (typeof id === "string") {
      copyList.set(
        id,
        Array.from({ length: n }, (_, k) => `${id}${copySuffix(k)}`),
      );
    }
    for (const kid of node.children ?? []) collectIds(kid, n);
  };

  for (const copyKey of result.order) {
    const { item: key, copy } = parseCopyKey(copyKey);
    const st = staticByKey.get(key);
    if (st !== undefined) {
      // static items are never copied (§9.4)
      const opacity = windowsTrack(staticWindows, FADE_OPACITY, total);
      if (opacity.length === 0) {
        objects.push(st.node);
        continue;
      }
      const id = ids.fadeWrap(key);
      staticFades.push({ key, id, opacity });
      const o0 = round2(evalOpacity(opacity, 0));
      objects.push(h("g", { id, ...(o0 < 1 ? { opacity: o0 } : {}) }, st.node));
      continue;
    }
    const path = pathOf.get(key);
    const leaf = path === undefined ? undefined : leafByPath.get(path);
    if (path === undefined || leaf === undefined) continue;
    let dom = itemDom.get(key);
    if (dom === undefined) {
      const half =
        key === `${path}__back` ? "back" : key === `${path}__front` ? "front" : undefined;
      const clip = clipOf.get(key);
      const chain = index.chain(path);
      let host: readonly TrackKey[] = [];
      let motion: readonly TrackKey[];
      if (clip !== undefined) {
        const solidPath = pathOf.get(clip.solid);
        const solidChain = solidPath === undefined ? [] : index.chain(solidPath);
        host = offsetTrack(plain(solidChain), total, projection, extraTimes);
        motion = offsetTrack(relativeMoves(chain, solidChain), total, projection, extraTimes);
        // one static clip path, shared by every copy (defined in the solid's frame)
        domCtx.defs.push(clipDef(domCtx, clip.clip, clip.prism));
      } else {
        motion = offsetTrack(plain(chain), total, projection, extraTimes);
      }
      const top = labels.top.get(path);
      const inner = partGroup(domCtx, leaf, half, top === undefined ? {} : { extra: [top] });
      const opacity = windowsTrack(fadeWindows.get(path) ?? [], FADE_OPACITY, total);
      dom = { inner, host, motion, opacity, clip: clip?.clip };
      itemDom.set(key, dom);
      const n = copiesOf.get(key) ?? 1;
      if (n > 1) collectIds(inner, n);
    }
    const { host, motion } = dom;
    // this copy's epochs (§9.4) AND the leaf's presence (B-3: built parts exist from their move's
    // start): a copy never shows while its leaf is absent. Fades are per item: every copy shares
    // them, presence fades included.
    let visibility = visibilityTrack(
      result.epochs.map((e, i) => ({
        t0: e.t0,
        visible: (epochSets[i] as Set<string>).has(copyKey),
      })),
      total,
    );
    let opacity = dom.opacity;
    const pt = pres.get(path);
    if (pt !== undefined) {
      visibility = andVisibility(visibility, pt.visibility, total);
      if (pt.opacity.length > 0) opacity = pt.opacity;
    }
    const track: PartTrack = { copy: copyKey, host, motion, visibility, opacity };
    tracks.push(track);
    const w: { -readonly [K in keyof Wrappers]: Wrappers[K] } = {};
    const reg: { -readonly [K in keyof Registered]: Registered[K] } = { key: copyKey, track };
    if (dom.clip !== undefined) {
      if (host.length > 0) {
        const hid = ids.partHost(key, copy);
        const tf = translateOf(evalOffset(host, 0));
        w.host = { id: hid, ...(tf === undefined ? {} : { transform: tf }) };
        reg.host = hid;
      }
      w.clip = dom.clip;
    }
    if (motion.length > 0) {
      const mid = ids.partMotion(key, copy);
      const tf = translateOf(evalOffset(motion, 0));
      w.motion = { id: mid, ...(tf === undefined ? {} : { transform: tf }) };
      reg.motion = mid;
    }
    if (visibility.length > 0) {
      const vid = ids.partVisible(key, copy);
      w.visible = { id: vid, hidden: !evalVisible(visibility, 0) };
      reg.visible = vid;
    }
    if (opacity.length > 0) {
      const fid = ids.partFade(key, copy);
      w.fade = { id: fid, opacity: round2(evalOpacity(opacity, 0)) };
      reg.fade = fid;
    }
    registered.push(reg);
    if (copy === 0) {
      const n = copiesOf.get(key) ?? 1;
      if (n > 1) {
        const wrappers: [unknown, (item: string, copy?: number) => string][] = [
          [w.host, ids.partHost],
          [w.motion, ids.partMotion],
          [w.visible, ids.partVisible],
          [w.fade, ids.partFade],
        ];
        for (const [has, idOf] of wrappers) {
          if (has === undefined) continue;
          copyList.set(
            idOf(key, 0),
            Array.from({ length: n }, (_, k) => idOf(key, k)),
          );
        }
      }
    }
    const inner = copy === 0 ? dom.inner : withIdSuffix(dom.inner, copySuffix(copy), domCtx);
    objects.push(wrap(inner, w, domCtx));
  }
  // ---- callout flights (§7.6) ---------------------------------------------------------------
  // The overlay copy of each flying leaf: not a depth item, drawn after every item of the group.
  const flights =
    loopBuild.flights.length === 0 || leaves.length === 0
      ? undefined
      : flightTracks({
          id: ids.flight,
          runs: loopBuild.flights,
          leaves,
          index,
          projection,
          slot: slotOf(
            unionRects(leaves.map((l) => projectBoxBounds(projection, l.geometry.bounds))),
          ),
          loop: total,
        });
  const flightList = flights?.tracks ?? [];
  const idOf = (n: SvgNode): unknown =>
    typeof n === "object" && "tag" in n ? n.attrs?.["id"] : undefined;
  for (const ft of flightList) {
    const leaf = leafByPath.get(ft.path);
    if (leaf === undefined) continue;
    const before = domCtx.defs.length;
    const group = partGroup(domCtx, leaf, undefined, {});
    // what the copy defines again (image clips, same ids) is already there
    const known = new Set(domCtx.defs.slice(0, before).map(idOf));
    const fresh = domCtx.defs.splice(before).filter((d) => !known.has(idOf(d)));
    domCtx.defs.push(...fresh);
    // the copy's ids are listed with the item's copies, so per-id rules reach it too
    const list = (node: SvgNode): void => {
      if (typeof node !== "object" || !("tag" in node)) return;
      const id = node.attrs?.["id"];
      if (typeof id === "string") copyList.set(id, [...(copyList.get(id) ?? [id]), `${id}__f`]);
      for (const kid of node.children ?? []) list(kid);
    };
    list(group);
    const tf = translateOf(evalOffset(ft.motion, 0));
    const o0 = round2(evalOpacity(ft.opacity, 0));
    objects.push(
      h(
        "g",
        {
          id: ft.id,
          ...(tf === undefined ? {} : { transform: tf }),
          ...(evalVisible(ft.visibility, 0) ? {} : { visibility: "hidden" }),
          ...(o0 < 1 ? { opacity: o0 } : {}),
        },
        withIdSuffix(group, "__f", domCtx),
      ),
    );
  }

  // Copy-aware ids (§9.4): `copyIds(id)` lists `id`, `id__c1`, … for every element of a copied
  // item (wrappers, part group, faces, overlay, top-face label); B emits per-id rules for all.
  const asmIds: IdScheme & AssemblyIdScheme = {
    ...ids,
    copyIds: (id) => copyList.get(id) ?? [id],
  };

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
  // flights: the copy at the callout slot and at the hover point (§10)
  reachRects.push(...(flights?.rects ?? []));
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
    for (const f of flightList) {
      transforms[f.id] = translateFull(evalOffset(f.motion, t));
      (evalVisible(f.visibility, t) ? visible : hidden).push(f.id);
      opacity[f.id] = round2(evalOpacity(f.opacity, t));
    }
    for (const lt of labelTracks) {
      // a top-face label rides inside its part, so each copy has its own (copyIds)
      for (const id of asmIds.copyIds(lt.id)) {
        if (lt.motion.length > 0) transforms[id] = translateFull(evalOffset(lt.motion, t));
        opacity[id] = round2(evalOpacity(lt.opacity, t));
      }
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
  const nodeRect = (step: number, id: string): Rect | undefined => {
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
    // what the camera frames also holds the labels and leaders shown during this step (the
    // camera's lead sits inside it, boards/timeline.ts; the previous step's tail is not framed)
    return unionRects([...rects, ...labels.rectsUnder(id, c.start, at)]);
  };
  const focusRect = (step: number, id: string): Rect | undefined => {
    const r = nodeRect(step, id);
    if (r === undefined) return undefined;
    return {
      x: round2(r.x - m.side),
      y: round2(r.y - m.side),
      width: round2(r.width + 2 * m.side),
      height: round2(r.height + 2 * m.side + m.bottom),
    };
  };

  // ---- depth items, model ------------------------------------------------------------------
  const model: AssemblyRenderModelX = {
    ids: asmIds,
    items: result.items,
    epochs: result.epochs,
    tracks: tracks.sort((a, b) => (a.copy < b.copy ? -1 : a.copy > b.copy ? 1 : 0)),
    loop: total,
    settled: loopBuild.settled,
    focusRect,
    frameAt,
    stepEnd,
    elements: countElements([...objects, ...labels.nodes, ...domCtx.defs]),
    labelTracks,
    staticFades,
    assets: domCtx.assets,
    clock,
    ...(loopBuild.closure === undefined ? {} : { closure: loopBuild.closure }),
    approximate: result.approximate,
    moves: loopBuild.moves,
    ...(flightList.length === 0 ? {} : { flights: flightList }),
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
    nodeRect,
  };
}

/** Built leaves (main + levels + every turned view) beyond which nothing is built (§13). */
export const MAX_BUILT_LEAVES = 2 * MAX_LEAVES;

const leavesOf = (list: readonly SceneAssembly[]): number =>
  list.reduce((n, a) => n + a.leaves.length, 0);

const capError = (
  code: "budget/assembly-parts" | "budget/views" | "budget/levels",
  message: string,
  suggestion: string,
  params: Diagnostic["params"],
): { readonly diagnostics: Diagnostic[] } => ({
  diagnostics: [{ severity: "error", code, path: "/assemblies", message, suggestion, params }],
});

const dedupe = (list: readonly Diagnostic[]): Diagnostic[] => {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of list) {
    const k = `${d.code}\u0000${d.path}\u0000${d.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
};

/** Sorted ranges with overlapping or touching ones merged. */
function mergeRanges(
  list: readonly { readonly t0: number; readonly t1: number }[],
): { readonly t0: number; readonly t1: number }[] {
  const out: { t0: number; t1: number }[] = [];
  for (const r of [...list].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1)) {
    const last = out[out.length - 1];
    if (last !== undefined && r.t0 <= last.t1 + EPS) last.t1 = Math.max(last.t1, r.t1);
    else out.push({ t0: r.t0, t1: r.t1 });
  }
  return out;
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sortedRecord = <T>(r: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(r).sort(([a], [b]) => byKey(a, b)));

/**
 * Builds the assembly layer of a scene: the main scene (view 0), the close-up levels (§8.4) and
 * the quarter-turn views (§7.7), all on ONE loop clock. Caps come first, sized by counts only:
 * leaves of the main scene and levels (`MAX_LEAVES`), leaves built over all views
 * (`MAX_BUILT_LEAVES`), at most `MAX_VIEWS` views and `MAX_LEVELS` levels. Without levels and
 * views the result is the main group alone, exactly as before A1-4.
 */
export function buildAssemblyRender(
  ctx: AssemblyRenderContext,
): AssemblyBuild | { readonly diagnostics: Diagnostic[] } | undefined {
  const { scene, projection, ids } = ctx;
  const sa = scene.assemblies;
  const assemblies = sa?.assemblies ?? [];
  if (sa === undefined || assemblies.length === 0) return undefined;
  // sorted, so the output does not depend on the order the scene lists them in
  const levels: readonly SceneLevel[] = [...(sa.levels ?? [])].sort((a, b) =>
    byKey(a.path, b.path),
  );
  const turned = (sa.views ?? []).filter((v) => v.turn !== 0).sort((a, b) => a.turn - b.turn);

  // ---- cap before any work sized by the input -------------------------------------------
  const levelLeaves = levels.reduce(
    (n, l) => n + (l.assembly === undefined ? 0 : l.assembly.leaves.length),
    0,
  );
  const leafCount = leavesOf(assemblies) + levelLeaves;
  if (leafCount > MAX_LEAVES) {
    return capError(
      "budget/assembly-parts",
      `${leafCount} leaf parts exceed the limit of ${MAX_LEAVES}; assemblies are not drawn`,
      "Use fewer parts (fewer `count` repeats, simpler `use` templates)",
      { parts: leafCount, limit: MAX_LEAVES },
    );
  }
  if (levels.length > MAX_LEVELS) {
    return capError(
      "budget/levels",
      `${levels.length} close-up levels exceed the limit of ${MAX_LEVELS}; assemblies are not drawn`,
      "Drop some close-ups",
      { count: levels.length, max: MAX_LEVELS },
    );
  }
  if (turned.length + 1 > MAX_VIEWS) {
    return capError(
      "budget/views",
      `${turned.length + 1} views exceed the limit of ${MAX_VIEWS}; assemblies are not drawn`,
      "Use fewer view changes",
      { views: turned.length + 1, max: MAX_VIEWS },
    );
  }
  const built = leafCount + turned.reduce((n, v) => n + leavesOf(v.assemblies), 0);
  if (built > MAX_BUILT_LEAVES) {
    return capError(
      "budget/views",
      `${built} leaf parts over ${turned.length + 1} views exceed the limit of ${MAX_BUILT_LEAVES}; assemblies are not drawn`,
      "Use fewer view changes, or fewer parts",
      { parts: built, views: turned.length + 1, limit: MAX_BUILT_LEAVES },
    );
  }

  // ---- the ONE loop clock ------------------------------------------------------------------
  const plan = sa.plan;
  const basePoses: Record<string, readonly { program: string; level: number }[]> = {};
  for (const a of assemblies) basePoses[a.id] = a.basePose;
  for (const l of levels) if (l.assembly !== undefined) basePoses[l.path] = l.assembly.basePose;
  let closeLast = endsAwayFromBase(plan[plan.length - 1]?.poses, basePoses);
  if (!closeLast && (ctx.spec?.figures !== undefined || ctx.spec?.storyboards !== undefined)) {
    closeLast = closesLoop(
      (ctx.spec.figures ?? []).map((f, i) => resolveFigure(f, i).figure),
      plan,
      (ctx.spec.storyboards ?? []).map((b) => resolveStoryboard(b)),
    );
  }
  const { times, total } = stepTimes(scene, 1, closeLast);
  const clock: LoopClock = { times, total, closeLast };
  const assets = new Map<string, ImageAsset>();
  const foreign = levels.map((l) => l.path);

  const main = buildGroup(ctx, {
    assemblies,
    ids,
    statics: ctx.statics ?? [],
    clock,
    assets,
    foreign,
  });
  if (levels.length === 0 && turned.length === 0) return main;

  // ---- quarter-turn views ------------------------------------------------------------------
  const diagnostics: Diagnostic[] = [...main.diagnostics];
  const extents: Rect[] = [...main.extents];
  const defs: SvgNode[] = [...main.defs];
  const viewGroups = turned.map((v) => {
    const vids = scopeIds(ids, v.turn);
    return {
      turn: v.turn,
      scene: v.assemblies,
      ids: vids,
      group: buildGroup(ctx, {
        assemblies: v.assemblies,
        ids: vids,
        statics: [],
        clock,
        assets,
        foreign,
      }),
    };
  });
  for (const v of viewGroups) {
    diagnostics.push(...v.group.diagnostics);
    extents.push(...v.group.extents);
    defs.push(...v.group.defs);
  }
  const allViews = [
    { turn: 0 as QuarterTurn, scene: assemblies, ids, group: main },
    ...viewGroups,
  ].sort((a, b) => a.turn - b.turn);
  const viewRenders =
    turned.length === 0
      ? []
      : allViews.map((v) => viewRender(ids, projection, v.turn, v.scene, v.group));
  if (turned.length > 0) {
    const real = viewRenders.reduce((n, v) => n + v.elements, 0);
    if (real > ELEMENT_WARN) {
      diagnostics.push({
        severity: "warning",
        code: "budget/views",
        path: "/assemblies",
        message: `${viewRenders.length} views need ${real} elements (warning above ${ELEMENT_WARN})`,
        suggestion: "Use fewer view changes, or fewer parts",
        params: { views: viewRenders.length, elements: real, limit: ELEMENT_WARN },
      });
    }
  }

  // ---- close-up levels ---------------------------------------------------------------------
  const target = roundRect(unionRects(main.extents));
  const lv =
    levels.length === 0
      ? undefined
      : buildLevelGroups(levels, {
          projection,
          levelId: ids.level,
          margin: ctx.focusMargin ?? { side: 0, bottom: 0 },
          target,
          main,
          build: (l) =>
            buildGroup(ctx, {
              assemblies: l.assembly === undefined ? [] : [l.assembly],
              ids,
              statics: [],
              clock,
              assets,
              foreign,
              templateOf: new Map([[l.path, l.ref]]),
            }),
        });
  if (lv !== undefined) {
    diagnostics.push(...lv.diagnostics);
    defs.push(...lv.defs);
  }

  // ---- the composed model ------------------------------------------------------------------
  const all: AssemblyRenderModel[] = [
    main.model,
    ...viewGroups.map((v) => v.group.model),
    ...(lv?.levels.flatMap((l) => (l.model === undefined ? [] : [l.model])) ?? []),
  ];
  const merge = (state: (g: AssemblyRenderModel) => AssemblyFrameState): AssemblyFrameState => {
    const transforms: Record<string, string> = {};
    const opacity: Record<string, number> = {};
    const hidden: string[] = [];
    const visible: string[] = [];
    for (const g of all) {
      const st = state(g);
      Object.assign(transforms, st.transforms);
      Object.assign(opacity, st.opacity);
      hidden.push(...st.hidden);
      visible.push(...st.visible);
    }
    return {
      transforms: sortedRecord(transforms),
      hidden: hidden.sort(byKey),
      visible: visible.sort(byKey),
      opacity: sortedRecord(opacity),
    };
  };
  // Opacity and placement of the view and level groups (groups.ts): keys on the loop clock that
  // frameAt/stepEnd evaluate and the animator writes as CSS (§7.7, §8.4).
  const clk = main.model.clock;
  const levelAtStep = (k: number): string | undefined => {
    const focus = k < 0 ? undefined : scene.timeline[k]?.focus;
    return focus === undefined ? undefined : levelOf(levels, focus)?.path;
  };
  const gtracks = groupTracks({
    total,
    clock: clk,
    plan,
    views: viewRenders,
    levels: lv?.levels ?? [],
    levelAtStep,
    mainLayers:
      lv === undefined
        ? []
        : ["background", "groups", "edges", "flows", "objects", "labels", "dcflows"].map(
            (l) => `${ctx.prefix}-ly_${l}`,
          ),
  });
  const groupState = (
    t: number,
  ): { transforms: Record<string, string>; opacity: Record<string, number> } => {
    const transforms: Record<string, string> = {};
    const opacity: Record<string, number> = {};
    for (const g of gtracks) {
      opacity[g.id] = round2(evalOpacity(g.opacity, t));
      if (g.placement !== undefined) transforms[g.id] = placementAttr(g.placement, t);
    }
    return { transforms, opacity };
  };
  const withGroups = (st: AssemblyFrameState, t: number): AssemblyFrameState => {
    const g = groupState(t);
    return {
      ...st,
      transforms: sortedRecord({ ...st.transforms, ...g.transforms }),
      opacity: sortedRecord({ ...st.opacity, ...g.opacity }),
    };
  };
  const settled = main.model.settled.map((v, i) => {
    const list = all.map((g) => g.settled[i]).filter((x): x is number => x !== undefined);
    return list.length === 0 ? v : Math.max(...list);
  });
  const reachRects = [
    ...(main.model.reach === undefined ? [] : [main.model.reach]),
    ...viewGroups.flatMap((v) => (v.group.model.reach === undefined ? [] : [v.group.model.reach])),
  ];
  const model: AssemblyRenderModelX = {
    ...main.model,
    settled,
    approximate: mergeRanges(all.flatMap((g) => g.approximate)),
    reach: reachRects.length === 0 ? undefined : unionRects(reachRects),
    elements:
      (turned.length === 0 ? main.model.elements : 0) +
      viewRenders.reduce((n, v) => n + v.elements, 0) +
      (lv?.levels.reduce((n, l) => n + l.elements, 0) ?? 0),
    frameAt: (t) => {
      const w = total > 0 ? ((t % total) + total) % total : 0;
      return withGroups(
        merge((g) => g.frameAt(t)),
        w,
      );
    },
    stepEnd: (step) => {
      const c = main.model.clock[step - 1];
      return withGroups(
        merge((g) => g.stepEnd(step)),
        c === undefined ? 0 : stepEndTime(Math.min(c.end, total)),
      );
    },
    focusRect: (step, id) => {
      // levels have their own coordinates (`levelFocusRect`); this is the world only
      if (levelOf(levels, id) !== undefined) return undefined;
      const v = plan[step - 1]?.view ?? 0;
      const inView = v === 0 ? undefined : viewGroups.find((x) => x.turn === v);
      return (inView?.group.model ?? main.model).focusRect(step, id);
    },
    levelFocusRect: (step, id) =>
      lv === undefined
        ? undefined
        : levelFocusRect(levels, lv, step, id, ctx.focusMargin ?? { side: 0, bottom: 0 }).rect,
    ...(lv === undefined ? {} : { levels: lv.levels }),
    ...(turned.length === 0 ? {} : { views: viewRenders }),
    groups: gtracks,
  };
  const _check: AssemblyRenderModel = model;
  void _check;
  const wrapped = turned.length > 0;
  return {
    model,
    objects: wrapped ? allViews.map((v) => viewNode(ids, v.turn, v.group)) : main.objects,
    labels: wrapped ? [] : main.labels,
    defs,
    extents,
    diagnostics: dedupe(diagnostics),
    ...(lv === undefined ? {} : { levelNodes: lv.nodes }),
  };
}

export type { StageRun, OpacityKey, Vec2 };
