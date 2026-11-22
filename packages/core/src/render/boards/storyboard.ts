/**
 * Storyboard panels (Track R, R-2; docs/design/assemblies.md §14): per frame the model image,
 * the parts callout (thumbnails with `<count>x`), the optional sub-build strip and the caption
 * with the document's step number, as render nodes, plus the tracks the animator plays (the same
 * `PoseTrack` / `FadeTrack` model as figures). A panel is upright in screen space and one depth
 * item. All motion is 2D inside the panel.
 *
 * Every animated element is described once, as a function of the storyboard's LEVEL (0 = empty
 * panel, `k` = after document step `k`) and of the time inside frame `k`: its keys while frame
 * `k` plays (`inK`) and, for elements that leave again, while frame `k + 1` plays (`outK`).
 * `build` plays the frames forward, `unbuild` plays the same keys backward with mirrored
 * easing, so an unbuild is the exact time reverse of the build, and frame mode (attributes) and
 * the CSS loop read the same keys.
 */
import type {
  AssemblyStepPlan,
  Diagnostic,
  ImageAsset,
  ImageAssetResolver,
  Rect,
  SceneFlatBoard,
  SvgElement,
  SvgNode,
  Vec3,
} from "../../contracts/index.js";
import { h } from "../../emit/xml.js";
import { fmt } from "../../geometry/index.js";
import { BEZIER, mirrorBezier, type Bezier } from "../../scene/boards.js";
import {
  CUT,
  INTRO,
  LAND,
  SUB_FADE,
  frameTiming,
  resolveStoryboard,
  storyboardGeometry,
  storyboardRuns,
  type ResolvedFrame,
  type ResolvedStoryboard,
  type StoryboardGeometry,
} from "../../scene/storyboards.js";
import type { PlatformCosmoSpec } from "../../schema/types.gen.js";
import { measureText } from "../../text/index.js";
import type { BoardsContext } from "./index.js";
import { imageUse } from "./images.js";
import { CLOSURE_EASE, LINEAR, type StepTime } from "./timeline.js";
import type { FadeTrack, PoseTrack } from "./types.js";

export interface Timing {
  readonly times: StepTime[];
  readonly total: number;
}

/** What the figure builder and the storyboard builder share (`buildBoards` owns it). */
export interface BoardsShared {
  readonly plan: readonly AssemblyStepPlan[];
  readonly objects: SvgNode[];
  readonly labels: SvgNode[];
  readonly defs: SvgNode[];
  readonly extents: Rect[];
  readonly focus: Record<string, Rect>;
  readonly trackDefs: ((tm: Timing) => { pose?: PoseTrack; fade?: FadeTrack })[];
  readonly diagnostics: Diagnostic[];
  addAsset(a: ImageAsset): void;
  /** Adds a panel node to the objects layer; panels of every kind are ordered by `anchor`. */
  place(node: SvgNode, anchor: Vec3, id: string): void;
}

const LABEL_CLASS = "t-primary";
/** First keys of a loop whose first action starts at the loop start: the rest frame is level n. */
const MIN_RAMP = 0.001;
/** The loop opens by easing from the rest frame to the level the first action starts from. */
const MAX_RAMP = 0.4;
const EASE: Bezier = BEZIER["ease-in-out"];

const r4 = (v: number): number => Math.round(v * 10000) / 10000;
const r2 = (v: number): number => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};

type V = readonly number[];
interface LKey {
  readonly t: number;
  readonly v: V;
  readonly e: Bezier;
}
/** An animated element: keys while its frame plays, and while the next frame plays (leaving). */
interface Elem {
  readonly id: string;
  readonly kind: "fade" | "pose";
  /** 1-based frame the element belongs to. */
  readonly frame: number;
  readonly inK: readonly LKey[];
  readonly outK?: readonly LKey[];
}

/** Keys from `[t, v, easing?]` points: sorted, first at 0, last at `length`, one per time. */
function lkeys(
  points: readonly (readonly [number, V] | readonly [number, V, Bezier])[],
  length: number,
): LKey[] {
  const out: LKey[] = [];
  const push = (t: number, v: V, e: Bezier): void => {
    const last = out[out.length - 1];
    if (last !== undefined && t <= last.t) out[out.length - 1] = { t: last.t, v, e };
    else out.push({ t, v, e });
  };
  const first = points[0] as readonly [number, V];
  if (first[0] > 0) push(0, first[1], LINEAR);
  for (const p of points) push(r4(Math.min(p[0], length)), p[1], p[2] ?? LINEAR);
  const last = out[out.length - 1] as LKey;
  if (last.t < length) push(r4(length), last.v, LINEAR);
  return out;
}

const fadeIn = (t0: number, t1: number, len: number): LKey[] =>
  lkeys(
    [
      [0, [0]],
      [t0, [0]],
      [t1, [1]],
    ],
    len,
  );
const fadeOut = (t0: number, t1: number, len: number): LKey[] =>
  lkeys(
    [
      [0, [1]],
      [t0, [1]],
      [t1, [0]],
    ],
    len,
  );

/** Fit of an image into a rect: centred, aspect kept. */
function fitRect(a: ImageAsset, r: Rect): Rect {
  const s = Math.min(r.width / a.width, r.height / a.height);
  const w = a.width * s;
  const hh = a.height * s;
  return { x: r.x + (r.width - w) / 2, y: r.y + (r.height - hh) / 2, width: w, height: hh };
}

/** `<title>` child (the part's name, for tooltips and screen readers) when there is a label. */
const titled = (el: SvgElement, label: string | undefined): SvgElement =>
  label === undefined || label === "" ? el : { ...el, children: [h("title", null, label)] };

/** Animated elements above which the storyboards are drawn as a static rest frame (§13). */
export const MAX_BOARD_ELEMENTS = 12000;

/** Upper bound of the animated elements one frame adds. */
function frameElements(f: ResolvedFrame, wipe: boolean): number {
  const callout = f.parts.length > 0 || f.sub.length > 0;
  return (
    2 + // model, caption
    (wipe ? 2 : 0) +
    (callout ? 1 : 0) +
    (f.parts.length > 0 ? 2 : 0) +
    f.sub.length +
    (f.sub.length > 0 ? 1 : 0)
  );
}

const translate = (x: number, y: number): string => `translate(${fmt(x)} ${fmt(y)})`;

/** One run of a frame inside the loop (an action traversing it). */
interface Run {
  readonly t0: number;
  readonly scale: number;
  readonly length: number;
  readonly reversed: boolean;
  readonly limit: number;
}

interface BoardTiming {
  /** Runs by frame (1-based), in time order. */
  readonly runs: ReadonlyMap<number, readonly Run[]>;
  /** Start of the loop's first traversal of this board (`total` when it never plays). */
  readonly firstAt: number;
  /** Closing window of the last step (0 without). */
  readonly closing: number;
  readonly total: number;
}

function boardTiming(
  sb: ResolvedStoryboard,
  plan: readonly AssemblyStepPlan[],
  tm: Timing,
): BoardTiming {
  const runs = new Map<number, Run[]>();
  let firstAt = tm.total;
  tm.times.forEach((st, i) => {
    const last = i === tm.times.length - 1;
    const limit =
      last && st.window.tr > 0 ? r4(tm.total - st.window.tr) : r4(st.start + st.duration);
    for (const a of plan[i]?.actions ?? []) {
      if (a.target !== sb.id || a.from === a.to) continue;
      const base = r4(st.open + a.start);
      for (const r of storyboardRuns(sb, a.from, a.to).runs) {
        const t0 = r4(base + r.offset * a.scale);
        if (t0 >= limit) continue;
        firstAt = Math.min(firstAt, t0);
        const list = runs.get(r.frame.index) ?? [];
        list.push({
          t0,
          scale: a.scale,
          length: frameTiming(r.frame).length,
          reversed: r.reversed,
          limit,
        });
        runs.set(r.frame.index, list);
      }
    }
  });
  for (const list of runs.values()) list.sort((a, b) => a.t0 - b.t0);
  const lastTime = tm.times[tm.times.length - 1];
  return { runs, firstAt, closing: lastTime?.window.tr ?? 0, total: tm.total };
}

/** Value of an element at a level (before its frame, while it is the current frame, after it). */
function valueAt(el: Elem, level: number): V {
  const before = (el.inK[0] as LKey).v;
  const mid = (el.inK[el.inK.length - 1] as LKey).v;
  if (level < el.frame) return before;
  if (level < el.frame + 1 || el.outK === undefined) return mid;
  return (el.outK[el.outK.length - 1] as LKey).v;
}

type OutKey = { t: number; v: V; e: Bezier };

/** The keys of one element over the loop, or undefined when nothing changes. */
function trackOf(
  el: Elem,
  n: number,
  start: number,
  end: number,
  bt: BoardTiming,
): OutKey[] | undefined {
  const keys: OutKey[] = [];
  const push = (t: number, v: V, e: Bezier): void => {
    const last = keys[keys.length - 1];
    if (last !== undefined && t <= last.t) {
      if (t === last.t) keys[keys.length - 1] = { t, v, e };
      return;
    }
    keys.push({ t, v, e });
  };
  const mine = [
    ...(bt.runs.get(el.frame)?.map((r) => ({ r, k: el.inK })) ?? []),
    ...(el.outK === undefined
      ? []
      : (bt.runs.get(el.frame + 1)?.map((r) => ({ r, k: el.outK as readonly LKey[] })) ?? [])),
  ].sort((a, b) => a.r.t0 - b.r.t0);
  const rest = valueAt(el, n);
  const from = valueAt(el, start);
  const ramps = from.some((x, i) => x !== (rest[i] as number));
  // the opening ramp from the rest frame eases (§14)
  push(0, rest, ramps ? EASE : LINEAR);
  // The ramp lasts until the element's own first traversal (at most MAX_RAMP), so the frame at
  // t = 0 and the ones right after it differ by a hair, not by a jump: a seek to exactly 0 in
  // Chromium can land a millisecond late, and a 1 ms ramp made that visible (a flaky browser
  // check). Only the last frame's elements ramp, and their traversal starts late.
  const ownFirst = mine[0]?.r.t0 ?? bt.firstAt;
  if (ramps) push(r4(Math.min(MAX_RAMP, Math.max(MIN_RAMP, ownFirst))), from, LINEAR);
  for (const { r, k } of mine) {
    const at = (tau: number): number =>
      r4(Math.min(r.limit, r.t0 + (r.reversed ? r.length - tau : tau) * r.scale));
    if (!r.reversed) {
      for (const key of k) push(at(key.t), key.v, key.e);
    } else {
      for (let j = k.length - 1; j >= 0; j--) {
        const key = k[j] as LKey;
        const seg = j > 0 ? mirrorBezier((k[j - 1] as LKey).e) : LINEAR;
        push(at(key.t), key.v, seg);
      }
    }
  }
  const to = valueAt(el, end);
  const last = keys[keys.length - 1] as OutKey;
  const differs = to.some((x, i) => x !== (rest[i] as number));
  if (differs && bt.closing > 0) {
    // loop closure (§7.4): back to the rest frame during the last step's closing window
    const t = r4(bt.total - bt.closing);
    if (last.t < t) push(t, last.v, CLOSURE_EASE);
    else keys[keys.length - 1] = { ...last, e: CLOSURE_EASE };
    push(bt.total, rest, LINEAR);
  } else if (last.t < bt.total) push(bt.total, last.v, LINEAR);
  const first = keys[0] as OutKey;
  return keys.every((k) => k.v.every((x, i) => x === (first.v[i] as number))) ? undefined : keys;
}

/** Builds the storyboards of a scene into `shared`. Returns nothing when there are none. */
export function buildStoryboards(
  ctx: BoardsContext,
  shared: BoardsShared,
  spec: PlatformCosmoSpec,
  images: ImageAssetResolver,
  boards: readonly SceneFlatBoard[],
  levels: { readonly start: (id: string) => number; readonly end: (id: string) => number },
): void {
  const f2 = (n: number): number => Number(fmt(n));
  const total = boards.reduce((sum, b) => {
    const sp = spec.storyboards?.find((x) => x.id === b.id);
    if (sp === undefined) return sum;
    const wipe = sp.transition === "wipe";
    return sum + resolveStoryboard(sp).frames.reduce((a, f) => a + frameElements(f, wipe), 0);
  }, 0);
  const staticOnly = total > MAX_BOARD_ELEMENTS;
  if (staticOnly) {
    shared.diagnostics.push({
      severity: "warning",
      code: "budget/elements",
      path: "/storyboards",
      message: `The storyboards animate about ${total} elements (budget ${MAX_BOARD_ELEMENTS}); they are drawn as a static rest frame`,
      suggestion: "Split the booklet into several specs, or use fewer frames, parts and mini steps",
      params: { elements: total, budget: MAX_BOARD_ELEMENTS },
    });
  }
  const ordered = [...boards].sort(
    (a, b) => a.anchor.x + a.anchor.y - (b.anchor.x + b.anchor.y) || (a.id < b.id ? -1 : 1),
  );
  for (const board of ordered) {
    const specBoard = spec.storyboards?.find((b) => b.id === board.id);
    if (specBoard === undefined) continue;
    const sb = resolveStoryboard(specBoard);
    const first = images.get((sb.frames[0] as ResolvedFrame).model);
    const geo = storyboardGeometry(sb, first);
    if (geo === undefined) continue;
    drawBoard(
      ctx,
      shared,
      sb,
      board,
      geo,
      images,
      levels,
      f2,
      staticOnly,
      spec.storyboards?.findIndex((x) => x.id === board.id) ?? 0,
    );
  }
}

function drawBoard(
  ctx: BoardsContext,
  shared: BoardsShared,
  sb: ResolvedStoryboard,
  board: SceneFlatBoard,
  geo: StoryboardGeometry,
  images: ImageAssetResolver,
  levels: { readonly start: (id: string) => number; readonly end: (id: string) => number },
  f2: (n: number) => number,
  staticOnly: boolean,
  specIndex: number,
): void {
  const { ids, prefix: P } = ctx;
  const n = sb.frames.length;
  const o = ctx.projection.project(board.anchor);
  const panel: Rect = { x: o.x, y: f2(o.y - geo.height), width: geo.width, height: geo.height };
  const calloutRect: Rect = { x: panel.x, y: panel.y, width: panel.width, height: geo.calloutH };
  const modelRect: Rect = {
    x: panel.x,
    y: f2(panel.y + geo.calloutH),
    width: panel.width,
    height: geo.modelH,
  };
  const capRect: Rect = {
    x: panel.x,
    y: f2(modelRect.y + geo.modelH),
    width: panel.width,
    height: geo.captionH,
  };
  const W = panel.width;
  const item = (key: string): string => ids.boardItem(sb.id, key);
  const wipe = sb.transition === "wipe";
  const capCut = sb.transition === "cut";

  // over budget: only the finished frame is drawn, with no tracks (a static rest frame)
  const frames = staticOnly ? [sb.frames[n - 1] as ResolvedFrame] : sb.frames;
  const elems: Elem[] = [];
  /** Rest-frame attributes of an element (the DOM shows level n). */
  const restOf = (el: Elem): V => valueAt(el, n);
  const fadeAttr = (el: Elem): Record<string, string | number> => {
    const v = (restOf(el)[0] as number) ?? 1;
    return v === 1 ? {} : { opacity: r4(v) };
  };
  const poseAttr = (el: Elem): Record<string, string | number> => {
    const [x, y] = restOf(el) as [number, number];
    return x === 0 && y === 0 ? {} : { transform: translate(x, y) };
  };
  const add = (el: Elem): Elem => {
    elems.push(el);
    return el;
  };

  const modelNodes: SvgNode[] = [];
  const calloutNodes: SvgNode[] = [];
  const capNodes: SvgNode[] = [];
  const clipDefs: SvgNode[] = [];

  frames.forEach((f, idx) => {
    const k = f.index;
    const nf = frames[idx + 1];
    const T = frameTiming(f);
    const Tn = nf === undefined ? undefined : frameTiming(nf);
    const D = T.length;
    const Dn = Tn?.length ?? 0;
    const modelAsset = images.get(f.model);
    const fm = modelAsset === undefined ? undefined : fitRect(modelAsset, modelRect);

    // ---- model image -----------------------------------------------------------------------
    const mid = (a: number, b: number): number => r4((a + b) / 2);
    // The caption text changes in two halves (old out, then new in) so two captions never
    // overlap; with `cut` it is a hard swap at the middle.
    const inFade = (c0: number, c1: number, len: number): LKey[] =>
      capCut ? fadeIn(mid(c0, c1), mid(c0, c1) + CUT, len) : fadeIn(mid(c0, c1), c1, len);
    const outFade = (c0: number, c1: number, len: number): LKey[] =>
      capCut ? fadeOut(mid(c0, c1), mid(c0, c1) + CUT, len) : fadeOut(c0, mid(c0, c1), len);
    if (modelAsset !== undefined && fm !== undefined) {
      shared.addAsset(modelAsset);
      const href = ids.image(modelAsset.hash);
      const use = imageUse(href, modelAsset, fm);
      let inK: LKey[];
      let outK: LKey[] | undefined;
      if (wipe) {
        inK = fadeIn(T.changeStart, T.changeStart + CUT, D);
        outK = Tn === undefined ? undefined : fadeOut(Tn.changeEnd - CUT, Tn.changeEnd, Dn);
      } else if (sb.transition === "cut") {
        const m = mid(T.changeStart, T.changeEnd);
        inK = fadeIn(m, m + CUT, D);
        outK =
          Tn === undefined
            ? undefined
            : fadeOut(
                mid(Tn.changeStart, Tn.changeEnd),
                mid(Tn.changeStart, Tn.changeEnd) + CUT,
                Dn,
              );
      } else {
        inK = fadeIn(T.changeStart, T.changeEnd, D);
        outK = Tn === undefined ? undefined : fadeOut(Tn.changeStart, Tn.changeEnd, Dn);
      }
      const me = add({
        id: item(`m.${k}`),
        kind: "fade",
        frame: k,
        inK,
        ...(outK ? { outK } : {}),
      });
      if (wipe) {
        const win = add({
          id: item(`mw.${k}`),
          kind: "pose",
          frame: k,
          inK: lkeys(
            [
              [0, [-W, 0]],
              [T.changeStart, [-W, 0], EASE],
              [T.changeEnd, [0, 0]],
            ],
            D,
          ),
          // the old image keeps the complementary part: its window slides out to the right
          // while the next image's slides in, so a transparent new image never shows it
          ...(Tn === undefined
            ? {}
            : {
                outK: lkeys(
                  [
                    [0, [0, 0]],
                    [Tn.changeStart, [0, 0], EASE],
                    [Tn.changeEnd, [W, 0]],
                  ],
                  Dn,
                ),
              }),
        });
        // The window is the clip rect itself (one clipPath per image) and the image stands
        // still: only the rect's translate animates, so no clip-path sits on an animated
        // element (Chromium would not re-resolve it after a seek).
        clipDefs.push(
          h(
            "clipPath",
            { id: item(`cp.${k}`) },
            h("rect", {
              id: win.id,
              x: modelRect.x,
              y: modelRect.y,
              width: W,
              height: modelRect.height,
              ...poseAttr(win),
            }),
          ),
        );
        modelNodes.push(
          h(
            "g",
            { id: me.id, ...fadeAttr(me) },
            h("g", { "clip-path": `url(#${item(`cp.${k}`)})` }, use),
          ),
        );
      } else {
        modelNodes.push(h("g", { id: me.id, ...fadeAttr(me) }, use));
      }
    }

    // ---- caption -----------------------------------------------------------------------------
    {
      const inK = inFade(T.changeStart, T.changeEnd, D);
      const outK = Tn === undefined ? undefined : outFade(Tn.changeStart, Tn.changeEnd, Dn);
      const ce = add({
        id: item(`cap.${k}`),
        kind: "fade",
        frame: k,
        inK,
        ...(outK ? { outK } : {}),
      });
      const numSize = ctx.labelSize + 2;
      const num = String(f.number);
      const baseline = f2(capRect.y + capRect.height / 2 + ctx.labelSize * 0.35);
      const pad = 8 * ctx.fs;
      const numW = measureText(num, numSize, "bold");
      const kids: SvgElement[] = [
        ctx.text({
          x: f2(capRect.x + pad),
          y: baseline,
          size: numSize,
          cls: LABEL_CLASS,
          bold: true,
          content: num,
        }),
      ];
      if (f.caption !== undefined) {
        const x = capRect.x + pad + numW + pad;
        kids.push(
          ctx.text({
            x: f2(x),
            y: baseline,
            size: ctx.labelSize,
            cls: "t-secondary",
            content: ctx.fit(
              f.caption,
              ctx.labelSize,
              false,
              Math.max(40, capRect.x + W - pad - x),
            ),
          }),
        );
      }
      capNodes.push(h("g", { id: ce.id, ...fadeAttr(ce) }, ...kids));
    }

    // ---- callout: parts, sub-build, flights ------------------------------------------------
    if (!T.callout) return;
    const pad = f2(geo.calloutH * 0.1);
    const subSide = f.sub.length > 0 ? f2(geo.calloutH - 2 * pad) : 0;
    const subRect: Rect = {
      x: f2(calloutRect.x + W - pad - subSide),
      y: f2(calloutRect.y + pad),
      width: subSide,
      height: subSide,
    };
    const regionW = W - 2 * pad - (f.sub.length > 0 ? subSide + pad : 0);
    const textH = ctx.labelSize * 1.3;
    const inner = geo.calloutH - 2 * pad;
    // counts need a line under the thumbnail; on a callout too low for one, thumbnails take it all
    const roomForText = inner - textH >= 8;
    const thumbH = roomForText ? inner - textH : inner;
    const cell = f.parts.length > 0 ? Math.min(geo.calloutH, regionW / f.parts.length) : 0;
    // never larger than its cell or the strip (narrow panels), and none under 2 px
    const box = Math.max(0, Math.min(cell - 2, thumbH, inner));
    const thumbs: { rect: Rect; asset: ImageAsset; count: number; label?: string; at: number }[] =
      [];
    f.parts.forEach((p, i) => {
      const a = images.get(p.image);
      if (a === undefined || box < 2) return;
      shared.addAsset(a);
      const cx = calloutRect.x + pad + i * cell + cell / 2;
      const slot: Rect = { x: cx - box / 2, y: calloutRect.y + pad, width: box, height: box };
      thumbs.push({
        rect: fitRect(a, slot),
        asset: a,
        count: p.count,
        at: i,
        ...(p.label === undefined ? {} : { label: p.label }),
      });
    });

    const attach =
      fm === undefined
        ? { x: modelRect.x + modelRect.width / 2, y: modelRect.y + modelRect.height / 2 }
        : { x: fm.x + (f.attach[0] / 100) * fm.width, y: fm.y + (f.attach[1] / 100) * fm.height };

    const calloutOut = Tn === undefined ? undefined : fadeOut(0, INTRO, Dn);
    const coEl = add({
      id: item(`co.${k}`),
      kind: "fade",
      frame: k,
      inK: fadeIn(0, INTRO, D),
      ...(calloutOut ? { outK: calloutOut } : {}),
    });

    const kids: SvgNode[] = [];
    // the thumbnails and their counts (static; flights are copies)
    let hidden = 0;
    thumbs.forEach((t) => {
      const label = `${t.count}x`;
      kids.push(titled(imageUse(ids.image(t.asset.hash), t.asset, t.rect), t.label));
      if (!roomForText || measureText(label, ctx.labelSize, "bold") > cell) {
        hidden++;
        return;
      }
      kids.push(
        ctx.text({
          x: f2(t.rect.x + t.rect.width / 2),
          y: f2(calloutRect.y + pad + box + ctx.labelSize * 1.05),
          size: ctx.labelSize,
          anchor: "middle",
          cls: LABEL_CLASS,
          bold: true,
          content: label,
        }),
      );
    });
    if (hidden > 0) {
      shared.diagnostics.push({
        severity: "info",
        code: "layout/callout-count-hidden",
        path: `/storyboards/${specIndex}/frames/${f.index - 1}/parts`,
        message: `The <count>x of ${hidden} part${hidden === 1 ? "" : "s"} in step ${f.number} of storyboard "${sb.id}" does not fit its thumbnail cell and is not drawn`,
        suggestion: "Make the storyboard wider (width), or use fewer parts in this step",
        params: { id: sb.id, frame: f.index, hidden },
      });
    }
    if (f.sub.length > 0) {
      kids.push(
        h("rect", {
          class: `${P}-board`,
          x: subRect.x,
          y: subRect.y,
          width: subRect.width,
          height: subRect.height,
        }),
      );
    }
    // mini steps: each replaces the previous one; the last docks at attach
    const subAssets = f.sub.map((s) => images.get(s.image));
    f.sub.forEach((_s, i) => {
      const a = subAssets[i];
      if (a === undefined) return;
      shared.addAsset(a);
      const slot: Rect = {
        x: subRect.x + 2,
        y: subRect.y + 2,
        width: Math.max(2, subRect.width - 4),
        height: Math.max(2, subRect.height - 4),
      };
      const r = fitRect(a, slot);
      const use = titled(imageUse(ids.image(a.hash), a, r), f.sub[i]?.label);
      const t = T.subAt[i] as number;
      const lastSub = i === f.sub.length - 1;
      if (!lastSub) {
        const nt = T.subAt[i + 1] as number;
        const fe = add({
          id: item(`sf.${k}.${i}`),
          kind: "fade",
          frame: k,
          inK: lkeys(
            [
              [0, [0]],
              [t, [0]],
              [t + SUB_FADE, [1]],
              [nt, [1]],
              [nt + SUB_FADE, [0]],
            ],
            D,
          ),
        });
        kids.push(h("g", { id: fe.id, ...fadeAttr(fe) }, use));
        return;
      }
      const dx = r2(attach.x - (r.x + r.width / 2));
      const dy = r2(attach.y - (r.y + r.height / 2));
      const fe = add({
        id: item(`sd.${k}`),
        kind: "fade",
        frame: k,
        inK: lkeys(
          [
            [0, [0]],
            [t, [0]],
            [t + SUB_FADE, [1]],
            [T.flightEnd - LAND, [1]],
            [T.flightEnd, [0]],
          ],
          D,
        ),
      });
      const pe = add({
        id: item(`sp.${k}`),
        kind: "pose",
        frame: k,
        inK: lkeys(
          [
            [0, [0, 0]],
            [T.flightStart, [0, 0], EASE],
            [T.flightEnd, [dx, dy]],
          ],
          D,
        ),
      });
      kids.push(
        h("g", { id: fe.id, ...fadeAttr(fe) }, h("g", { id: pe.id, ...poseAttr(pe) }, use)),
      );
    });
    // flight of the part thumbnails: one group, copies of the callout's thumbnails
    if (thumbs.length > 0) {
      const union = thumbs.reduce(
        (u, t) => ({
          x0: Math.min(u.x0, t.rect.x),
          y0: Math.min(u.y0, t.rect.y),
          x1: Math.max(u.x1, t.rect.x + t.rect.width),
          y1: Math.max(u.y1, t.rect.y + t.rect.height),
        }),
        { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
      );
      const dx = r2(attach.x - (union.x0 + union.x1) / 2);
      const dy = r2(attach.y - (union.y0 + union.y1) / 2);
      const fe = add({
        id: item(`fl.${k}`),
        kind: "fade",
        frame: k,
        inK: lkeys(
          [
            [0, [0]],
            [T.flightStart, [0]],
            [T.flightStart + 0.04, [1]],
            [T.flightEnd - LAND, [1]],
            [T.flightEnd, [0]],
          ],
          D,
        ),
      });
      const pe = add({
        id: item(`fp.${k}`),
        kind: "pose",
        frame: k,
        inK: lkeys(
          [
            [0, [0, 0]],
            [T.flightStart, [0, 0], EASE],
            [T.flightEnd, [dx, dy]],
          ],
          D,
        ),
      });
      kids.push(
        h(
          "g",
          { id: fe.id, ...fadeAttr(fe) },
          h(
            "g",
            { id: pe.id, ...poseAttr(pe) },
            ...thumbs.map((t) => imageUse(ids.image(t.asset.hash), t.asset, t.rect)),
          ),
        ),
      );
    }
    calloutNodes.push(h("g", { id: coEl.id, ...fadeAttr(coEl) }, ...kids));
  });

  // ---- tracks ------------------------------------------------------------------------------
  const start = levels.start(sb.id);
  const end = levels.end(sb.id);
  const bts = new WeakMap<Timing, BoardTiming>();
  const timingOf = (tm: Timing): BoardTiming => {
    let b = bts.get(tm);
    if (b === undefined) {
      b = boardTiming(sb, shared.plan, tm);
      bts.set(tm, b);
    }
    return b;
  };
  for (const el of staticOnly ? [] : elems) {
    shared.trackDefs.push((tm) => {
      const keys = trackOf(el, n, start, end, timingOf(tm));
      if (keys === undefined) return {};
      return el.kind === "fade"
        ? {
            fade: {
              id: el.id,
              keys: keys.map((k) => ({ t: k.t, v: r4(k.v[0] as number), easing: k.e })),
            },
          }
        : {
            pose: {
              id: el.id,
              keys: keys.map((k) => ({
                t: k.t,
                x: r2(k.v[0] as number),
                y: r2(k.v[1] as number),
                easing: k.e,
              })),
            },
          };
    });
  }

  // ---- the panel node ----------------------------------------------------------------------
  const line = (y: number): SvgElement =>
    h("path", {
      class: `${P}-leader`,
      d: `M${fmt(panel.x)} ${fmt(y)}L${fmt(panel.x + W)} ${fmt(y)}`,
    });
  shared.defs.push(...clipDefs);
  shared.place(
    h(
      "g",
      { id: ids.board(sb.id) },
      ...modelNodes,
      ...calloutNodes,
      ...capNodes,
      h("rect", {
        class: `${P}-board`,
        x: panel.x,
        y: panel.y,
        width: panel.width,
        height: panel.height,
      }),
      geo.calloutH > 0 ? line(f2(panel.y + geo.calloutH)) : null,
      line(capRect.y),
    ),
    board.anchor,
    sb.id,
  );
  const reach: Rect[] = [panel];
  if (sb.label !== undefined) {
    const title = ctx.fit(sb.label, ctx.labelSize, true, Math.max(panel.width, 160 * ctx.fs));
    shared.labels.unshift(
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
  const x0 = Math.min(...reach.map((r) => r.x));
  const y0 = Math.min(...reach.map((r) => r.y));
  const x1 = Math.max(...reach.map((r) => r.x + r.width));
  const y1 = Math.max(...reach.map((r) => r.y + r.height));
  const r: Rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  shared.extents.push(r);
  const m = 12;
  shared.focus[sb.id] = {
    x: f2(r.x - m),
    y: f2(r.y - m),
    width: f2(r.width + 2 * m),
    height: f2(r.height + 2 * m),
  };
}
