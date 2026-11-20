/**
 * Figure panels (Track A1, R-1; docs/design/assemblies.md §11.3, §15): the base image, the
 * sprites in draw order, motion arrows, labels with leaders and the credits line, as render
 * nodes, plus the tracks the animator plays (`BoardsModel`). A panel is upright in screen space
 * and one depth item: it is drawn after the 3D content, where the scene put it. Storyboard
 * frames join this module in R-2.
 */
import type {
  IdScheme,
  ImageAsset,
  ImageAssetResolver,
  Projection,
  Rect,
  SceneGraph,
  SvgElement,
  SvgNode,
} from "../../contracts/index.js";
import type { BoardIdScheme } from "../../emit/ids.js";
import { h } from "../../emit/xml.js";
import { fmt } from "../../geometry/index.js";
import {
  closesLoop,
  figureSegment,
  panelSize,
  resolveFigure,
  type FigureSegment,
  type ResolvedFigure,
} from "../../scene/boards.js";
import type { PlatformCosmoSpec } from "../../schema/types.gen.js";
import { measureText } from "../../text/index.js";
import { creditsDesc, creditsLine, imageDef, imageUse } from "./images.js";
import {
  layoutFigure,
  spriteRect,
  stackLabels,
  unionOf,
  type LabelBox,
  type SpriteBox,
} from "./layout.js";
import {
  arrowKeys,
  labelKeys,
  partSegments,
  poseKeys,
  stepTimes,
  type Seg,
  type StepTime,
} from "./timeline.js";
import type { BoardsModel, BoardsTracks, FadeKey, FadeTrack, PoseTrack } from "./types.js";

interface Timing {
  readonly times: StepTime[];
  readonly total: number;
}

export { boardsOf } from "./types.js";
export type { BoardsModel, FadeKey, FadeTrack, PoseKey, PoseTrack } from "./types.js";
export { checkFigureImages, creditsDesc, creditsLine } from "./images.js";

/** Text element of the model builder (`textEl` in `render/model.ts`), so glyphs are accounted. */
export interface TextSpec {
  readonly id?: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly anchor?: "start" | "middle" | "end";
  readonly cls: string;
  readonly bold?: boolean;
  readonly content: string;
}

export interface BoardsContext {
  readonly scene: SceneGraph;
  readonly spec: PlatformCosmoSpec | undefined;
  readonly images: ImageAssetResolver | undefined;
  readonly projection: Projection;
  readonly ids: IdScheme & BoardIdScheme;
  readonly prefix: string;
  /** Label font size and the drawing's text scale (`labelSize / theme.font.label`). */
  readonly labelSize: number;
  readonly fs: number;
  readonly text: (o: TextSpec) => SvgElement;
  readonly fit: (text: string, size: number, bold: boolean, maxWidth: number) => string;
}

export interface BoardsBuild {
  /** Panels, appended to the objects layer (after the 3D content). */
  readonly objects: SvgNode[];
  /** Arrows, labels and titles, appended to the labels layer. */
  readonly labels: SvgNode[];
  /** Image placeholders for the background layer (the emitter hoists them into `<defs>`). */
  readonly defs: SvgNode[];
  /** Screen rects that must stay inside the view box. */
  readonly extents: Rect[];
  /** Focus rect of every panel: the panel, its moving sprites and its labels. */
  readonly focus: Record<string, Rect>;
  readonly model: BoardsModel;
  /** Text of the pinned credits line; empty when no source credits anyone. */
  readonly creditsLine: string;
}

const LABEL_CLASS = "t-primary";
const MAX_LABEL = 150;
const GAP = 4;

/** Builds the boards of a scene; undefined when there are none (1.1 scenes are untouched). */
export function buildBoards(ctx: BoardsContext): BoardsBuild | undefined {
  const { scene, spec, images, ids, prefix: P } = ctx;
  const boards = scene.assemblies?.boards.filter((b) => b.kind === "figure") ?? [];
  if (spec === undefined || images === undefined || boards.length === 0) return undefined;

  const plan = scene.assemblies?.plan ?? [];
  // The loop closes (§7.4) when some figure ends away from its base pose.
  const closeLast = closesLoop(
    (spec.figures ?? []).map((f, i) => resolveFigure(f, i).figure),
    plan,
  );
  const timingFor = (speed: number): Timing => {
    const { times, total } = stepTimes(scene, speed, closeLast);
    return { times, total };
  };
  // Rest values (the DOM shows the rest frame) do not depend on the speed.
  const rest1 = timingFor(1);
  const total = rest1.total;
  /** Track builders: re-run per output speed, since camera transitions are on the output clock. */
  const trackDefs: ((tm: Timing) => { pose?: PoseTrack; fade?: FadeTrack })[] = [];
  const objects: SvgNode[] = [];
  const labels: SvgNode[] = [];
  const defs: SvgNode[] = [];
  const extents: Rect[] = [];
  const focus: Record<string, Rect> = {};
  const assets = new Map<string, ImageAsset>();
  const f2 = (n: number): number => Number(fmt(n));
  const lineH = ctx.labelSize * 1.25;

  const addAsset = (a: ImageAsset): void => {
    if (assets.has(a.hash)) return;
    assets.set(a.hash, a);
    defs.push(imageDef(a.hash));
  };

  // Panels stand after the 3D content, in depth order (nearer = larger x + y), then by id.
  const ordered = [...boards].sort(
    (a, b) => a.anchor.x + a.anchor.y - (b.anchor.x + b.anchor.y) || (a.id < b.id ? -1 : 1),
  );
  for (const board of ordered) {
    const index = (spec.figures ?? []).findIndex((f) => f.id === board.id);
    const specFigure = spec.figures?.[index];
    const baseAsset = specFigure === undefined ? undefined : images.get(specFigure.base);
    if (specFigure === undefined || baseAsset === undefined) continue;
    const size = panelSize(board.width, baseAsset.width, baseAsset.height);
    if (size === undefined) continue;
    const figure: ResolvedFigure = resolveFigure(specFigure, index).figure;

    const o = ctx.projection.project(board.anchor);
    const panel: Rect = {
      x: o.x,
      y: f2(o.y - size.height),
      width: size.width,
      height: size.height,
    };
    const layout = layoutFigure(figure, panel, panel.width, baseAsset.width, (image) => {
      const a = images.get(image);
      return a === undefined ? undefined : { width: a.width, height: a.height };
    });
    const memo = new Map<string, FigureSegment>();
    const segment = (from: number, to: number): FigureSegment => {
      const k = `${from}>${to}`;
      let s = memo.get(k);
      if (s === undefined) {
        s = figureSegment(figure, from, to);
        memo.set(k, s);
      }
      return s;
    };

    addAsset(baseAsset);
    const spriteNodes: SvgNode[] = [];
    const arrowNodes: SvgNode[] = [];
    const labelNodes: SvgNode[] = [];
    const reach: Rect[] = [panel];

    // ---- sprites and their tracks ------------------------------------------------------
    const segsOf = new Map<string, { segs: Seg[]; base: number }>();
    const segsAt = (part: string, tm: Timing): Seg[] =>
      partSegments(
        figure.id,
        segment,
        part,
        plan,
        tm.times,
        tm.total,
        (segsOf.get(part) as { base: number }).base,
      ).segs;
    for (const sp of layout.sprites) {
      const base = sp.moves && (sp.stage as number) <= figure.baseLevel ? 1 : 0;
      const { segs } = sp.moves
        ? partSegments(figure.id, segment, sp.part.id, plan, rest1.times, total, base)
        : { segs: [] as Seg[] };
      segsOf.set(sp.part.id, { segs, base });
      const asset = images.get(sp.part.image) as ImageAsset;
      addAsset(asset);
      const id = ids.boardItem(figure.id, `s.${sp.part.id}`);
      const rest = base === 1 ? sp.offset : { x: 0, y: 0 };
      spriteNodes.push(
        h(
          "g",
          {
            id,
            ...(rest.x !== 0 || rest.y !== 0
              ? { transform: `translate(${fmt(rest.x)} ${fmt(rest.y)})` }
              : {}),
          },
          imageUse(ids.image(asset.hash), asset, {
            x: sp.seat.x,
            y: sp.seat.y,
            width: sp.width,
            height: sp.height,
          }),
        ),
      );
      if (sp.moves) {
        reach.push(spriteRect(sp, "seat"), spriteRect(sp, "exploded"));
        if (segs.length > 0) {
          trackDefs.push((tm) => ({
            pose: {
              id,
              keys: poseKeys(segsAt(sp.part.id, tm), base, sp.offset, tm.total),
            },
          }));
        }
      } else reach.push(spriteRect(sp, "seat"));
    }

    // ---- arrows --------------------------------------------------------------------------
    for (const sp of layout.sprites) {
      if (!sp.moves || !sp.part.arrow) continue;
      const segs = segsOf.get(sp.part.id)?.segs ?? [];
      for (const forward of [true, false]) {
        const keys = arrowKeys(segs, forward, total);
        if (keys.length === 0) continue;
        const a = arrowNode(
          ctx,
          ids.boardItem(figure.id, `a.${sp.part.id}.${forward ? "f" : "r"}`),
          sp,
          forward,
          keys,
        );
        if (a !== undefined) {
          arrowNodes.push(a.node);
          if (a.track !== undefined) {
            const id = a.track.id;
            trackDefs.push((tm) => ({
              fade: { id, keys: arrowKeys(segsAt(sp.part.id, tm), forward, tm.total) },
            }));
          }
        }
      }
    }

    // ---- labels --------------------------------------------------------------------------
    const lab = placeLabels(ctx, figure, layout.sprites, panel, segsOf, total, lineH);
    for (const l of lab.items) {
      labelNodes.push(l.node);
      if (l.track !== undefined) {
        const id = l.track.id;
        const { part, pose } = l;
        trackDefs.push((tm) => ({
          fade: {
            id,
            keys: labelKeys(
              segsAt(part, tm),
              (segsOf.get(part) as { base: number }).base,
              pose,
              tm.total,
            ),
          },
        }));
      }
      reach.push(l.rect);
    }

    // ---- panel node ----------------------------------------------------------------------
    const bd = ids.board(figure.id);
    objects.push(
      h(
        "g",
        { id: bd },
        imageUse(ids.image(baseAsset.hash), baseAsset, panel),
        h("rect", {
          class: `${P}-board`,
          x: panel.x,
          y: panel.y,
          width: panel.width,
          height: panel.height,
        }),
        ...spriteNodes,
      ),
    );
    if (figure.label !== undefined) {
      const title = ctx.fit(figure.label, ctx.labelSize, true, Math.max(panel.width, 160 * ctx.fs));
      labelNodes.unshift(
        ctx.text({
          x: panel.x,
          y: f2(panel.y - 6 * ctx.fs),
          size: ctx.labelSize,
          cls: LABEL_CLASS,
          bold: true,
          content: title,
        }),
      );
      reach.push({
        x: panel.x,
        y: panel.y - 6 * ctx.fs - ctx.labelSize,
        width: panel.width,
        height: ctx.labelSize + 4,
      });
    }
    labels.push(...arrowNodes, ...labelNodes);
    const r = unionOf(reach);
    extents.push(r);
    const m = 12;
    focus[figure.id] = {
      x: f2(r.x - m),
      y: f2(r.y - m),
      width: f2(r.width + 2 * m),
      height: f2(r.height + 2 * m),
    };
  }
  if (objects.length === 0) return undefined;

  const credits = scene.assemblies?.credits ?? [];
  const line = creditsLine(credits);
  const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : 1);
  const cache = new Map<number, BoardsTracks>();
  const model: BoardsModel = {
    tracks(speed) {
      const key = speed > 0 && Number.isFinite(speed) ? speed : 1;
      let t = cache.get(key);
      if (t === undefined) {
        const tm = timingFor(key);
        const built = trackDefs.map((d) => d(tm));
        t = {
          loop: tm.total,
          poses: built.flatMap((b) => (b.pose ? [b.pose] : [])).sort(byId),
          fades: built.flatMap((b) => (b.fade ? [b.fade] : [])).sort(byId),
          stepStarts: tm.times.map((x) => x.start),
          stepEnds: tm.times.map((x) => x.end),
          settled: tm.times.map((x, i) => {
            const acts = plan[i]?.actions ?? [];
            if (acts.length === 0) return undefined;
            return (
              Math.round((x.open + Math.max(...acts.map((a) => a.start + a.length))) * 10000) /
              10000
            );
          }),
        };
        cache.set(key, t);
      }
      return t;
    },
    ...(line === "" ? {} : { creditsId: ids.credits() }),
    assets,
    desc: creditsDesc(credits),
  };
  return { objects, labels, defs, extents, focus, model, creditsLine: line };
}

// ---------------------------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------------------------

function arrowNode(
  ctx: BoardsContext,
  id: string,
  sp: SpriteBox,
  forward: boolean,
  keys: readonly FadeKey[],
): { node: SvgElement; track: FadeTrack | undefined } | undefined {
  const c = (at: "seat" | "exploded") => ({
    x: sp[at].x + sp.width / 2,
    y: sp[at].y + sp.height / 2,
  });
  const a = forward ? c("seat") : c("exploded");
  const b = forward ? c("exploded") : c("seat");
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len >= 8)) return undefined;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const pad = Math.min(len * 0.25, 14);
  const p1 = { x: a.x + ux * pad, y: a.y + uy * pad };
  const tip = { x: b.x - ux * pad, y: b.y - uy * pad };
  const size = 9;
  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const px = -uy * (size / 2);
  const py = ux * (size / 2);
  const P = ctx.prefix;
  const rest = (keys[0] as FadeKey).v;
  const node = h(
    "g",
    { id, ...(rest === 1 ? {} : { opacity: rest }) },
    h("path", {
      class: `${P}-edge ${P}-edge-solid`,
      d: `M${fmt(p1.x)} ${fmt(p1.y)}L${fmt(bx)} ${fmt(by)}`,
    }),
    h("polygon", {
      class: `${P}-arrow`,
      points: [tip, { x: bx + px, y: by + py }, { x: bx - px, y: by - py }]
        .map((p) => `${fmt(p.x)},${fmt(p.y)}`)
        .join(" "),
    }),
  );
  return { node, track: changes(keys) ? { id, keys } : undefined };
}

/** True when a fade track takes more than one value over the loop. */
const changes = (keys: readonly FadeKey[]): boolean =>
  keys.some((k) => k.v !== (keys[0] as FadeKey).v);

// ---------------------------------------------------------------------------------------------
// Labels with leaders
// ---------------------------------------------------------------------------------------------

interface PlacedLabel {
  readonly part: string;
  readonly pose: 0 | 1;
  readonly node: SvgElement;
  readonly track: FadeTrack | undefined;
  readonly rect: Rect;
}

/**
 * Labels of a figure, in columns beside the panel (left or right of the half the sprite sits in),
 * one group per part and pose the part rests at: the group fades in when the part arrives and
 * out when it leaves. Stacked per pose with the parts at that pose (parts that never move keep
 * their place in both), so labels at one time do not overlap, except when parts are in mixed
 * poses (stages in between), which is not laid out separately.
 */
function placeLabels(
  ctx: BoardsContext,
  figure: ResolvedFigure,
  sprites: readonly SpriteBox[],
  panel: Rect,
  segsOf: ReadonlyMap<string, { segs: Seg[]; base: number }>,
  total: number,
  lineH: number,
): { items: PlacedLabel[] } {
  const { ids, prefix: P } = ctx;
  const items: PlacedLabel[] = [];
  const hidden = (sp: SpriteBox): boolean =>
    sp.stage !== undefined && figure.stages[sp.stage - 1]?.labels === "hide";
  const withLabel = [...sprites]
    .filter((s) => s.part.label !== undefined && !hidden(s))
    .sort((a, b) => a.index - b.index);
  if (withLabel.length === 0) return { items };

  const text = (sp: SpriteBox): string[] => [
    ctx.fit(sp.part.label as string, ctx.labelSize, false, MAX_LABEL * ctx.fs),
    ...sp.part.detail.map((d) => ctx.fit(d, ctx.labelSize - 1, false, MAX_LABEL * ctx.fs)),
  ];
  const lines = new Map(withLabel.map((s) => [s.part.id, text(s)]));
  const height = (sp: SpriteBox): number => (lines.get(sp.part.id) as string[]).length * lineH;
  const sideOf = (sp: SpriteBox): "left" | "right" =>
    sp.seat.x + sp.width / 2 >= panel.x + panel.width / 2 ? "right" : "left";
  const centre = (sp: SpriteBox, pose: 0 | 1): number =>
    (pose === 1 ? sp.exploded.y : sp.seat.y) + sp.height / 2;

  // Tracks per part and pose (keys exist only for poses the part rests at).
  const keysOf = (sp: SpriteBox, pose: 0 | 1): FadeKey[] | undefined => {
    if (!sp.moves) return pose === 0 ? [{ t: 0, v: 1, easing: [0, 0, 1, 1] }] : undefined;
    const s = segsOf.get(sp.part.id) as { segs: Seg[]; base: number };
    const k = labelKeys(s.segs, s.base, pose, total);
    return k.length === 0 ? undefined : k;
  };

  // Place per pose and side: pose 0 first (parts that never move are fixed there).
  const tops = new Map<string, number>();
  for (const pose of [0, 1] as const) {
    for (const side of ["left", "right"] as const) {
      const list: LabelBox[] = [];
      for (const sp of withLabel) {
        if (sideOf(sp) !== side) continue;
        const key = `${sp.part.id}.${pose}`;
        if (!sp.moves) {
          const fixed = tops.get(`${sp.part.id}.0`);
          list.push({
            key,
            centre: centre(sp, 0),
            height: height(sp),
            ...(pose === 1 && fixed !== undefined ? { fixedTop: fixed } : {}),
          });
        } else if (keysOf(sp, pose) !== undefined) {
          list.push({ key, centre: centre(sp, pose), height: height(sp) });
        }
      }
      for (const [k, v] of stackLabels(list, GAP * ctx.fs)) tops.set(k, v);
    }
  }

  const colGap = 14 * ctx.fs;
  for (const sp of withLabel) {
    for (const pose of [0, 1] as const) {
      const keys = keysOf(sp, pose);
      const top = tops.get(`${sp.part.id}.${pose}`);
      if (keys === undefined || top === undefined) continue;
      const side = sideOf(sp);
      const rows = lines.get(sp.part.id) as string[];
      const colX = side === "right" ? panel.x + panel.width + colGap : panel.x - colGap;
      const width = Math.max(
        ...rows.map((r, i) => measureText(r, ctx.labelSize - (i === 0 ? 0 : 1))),
      );
      const id = ids.boardItem(figure.id, `l.${sp.part.id}.${pose}`);
      const at = pose === 1 ? sp.exploded : sp.seat;
      const from = { x: side === "right" ? at.x + sp.width : at.x, y: at.y + sp.height / 2 };
      const to = {
        x: side === "right" ? colX - 4 * ctx.fs : colX + 4 * ctx.fs,
        y: top + lineH / 2,
      };
      const rest = (keys[0] as FadeKey).v;
      const node = h(
        "g",
        { id, ...(rest === 1 ? {} : { opacity: rest }) },
        h("path", {
          class: `${P}-leader`,
          d: `M${fmt(from.x)} ${fmt(from.y)}L${fmt(to.x)} ${fmt(to.y)}`,
        }),
        ...rows.map((row, i) =>
          ctx.text({
            x: colX,
            y: Number(fmt(top + i * lineH + ctx.labelSize)),
            size: i === 0 ? ctx.labelSize : ctx.labelSize - 1,
            anchor: side === "right" ? "start" : "end",
            cls: i === 0 ? LABEL_CLASS : "t-secondary",
            content: row,
          }),
        ),
      );
      items.push({
        part: sp.part.id,
        pose,
        node,
        track: changes(keys) ? { id, keys } : undefined,
        rect: {
          x: side === "right" ? colX : colX - width,
          y: top,
          width,
          height: rows.length * lineH,
        },
      });
    }
  }
  return { items };
}
