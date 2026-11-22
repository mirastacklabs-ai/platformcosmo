/**
 * Layout of a step's parts callout (Track A2, A2-6; docs/design/assemblies.md §6.5, §7.6): the box
 * with `count x thumbnail` per part kind, and the callout slot its flights start from. Pure and
 * deterministic; every number is rounded here.
 *
 * The group (box, then the slot where the copies of the flying parts are centred) is placed INSIDE
 * the camera window of the step (the zoomed view box, or the view box unzoomed): in the free area
 * nearest the window's left edge, nearest a quarter of its height down. Free means: no part,
 * non-assembly object or label that shows in the window is covered, and no flight's straight path
 * from the slot to its hover point crosses a non-assembly object. When it does not fit at full
 * size the thumbnails shrink (down to `FLOOR` px); when it still does not fit, the position with
 * the least overlap is used (the box is an overlay, so it then covers the least area it can).
 * The window is never widened: the camera framing is the focused node's alone.
 */
import type { Rect, Vec2 } from "../../contracts/index.js";
import { measureText } from "../../text/index.js";

/** Longest side of the largest thumbnail of an assembly at full size. */
export const THUMB = 44;
/** Smallest thumbnail box when the callout is shrunk to fit. */
export const FLOOR = 20;
/** Part kinds one box shows (the rest are reported: `layout/callout-truncated`). */
export const MAX_CELLS = 12;
const PAD = 8;
const COLS = 4;
const GAP_BOX = 12;
const CLEAR = 6;
const MARGIN = 8;
const STEP = 8;
const FACTORS = [1, 0.8, 0.6, FLOOR / THUMB];

const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;
const even = (v: number): number => 2 * Math.ceil(v / 2);

export interface CalloutPart {
  /** Screen size of the part at rest. */
  readonly width: number;
  readonly height: number;
  readonly count: number;
  /** The assembly's callout scale (at most 1): the same for every kind of an assembly (§6.5). */
  readonly scale: number;
}

/** The callout scale of an assembly: its largest kind fits `THUMB` px, the others keep their size relative to it. */
export function calloutScale(
  sizes: readonly { readonly width: number; readonly height: number }[],
): number {
  const side = Math.max(0, ...sizes.map((s) => Math.max(s.width, s.height)));
  return side > THUMB ? THUMB / side : 1;
}

export interface BoxCell {
  /** Centre of the thumbnail and of the `<count>x` baseline, relative to the box's top-left. */
  readonly center: Vec2;
  readonly label: Vec2;
  /** Scale of the thumbnail. */
  readonly scale: number;
}

export interface BoxLayout {
  readonly width: number;
  readonly height: number;
  /** Side of a thumbnail cell. */
  readonly cell: number;
  readonly cells: readonly BoxCell[];
}

/** The box at thumbnail factor `f` (1: full size), relative to its top-left corner. */
export function boxLayout(parts: readonly CalloutPart[], f: number, labelSize: number): BoxLayout {
  const T = r2(THUMB * f);
  const n = parts.length;
  const cellW = even(
    Math.max(T, ...parts.map((p) => measureText(`${p.count}x`, labelSize, "bold"))) + 8,
  );
  const cellH = even(T + 4 + labelSize * 1.2);
  const cols = Math.min(n, COLS);
  const rows = Math.ceil(n / COLS);
  return {
    width: cols * cellW + 2 * PAD,
    height: rows * cellH + 2 * PAD,
    cell: T,
    cells: parts.map((p, k) => {
      const x = PAD + (k % COLS) * cellW + cellW / 2;
      const y = PAD + Math.floor(k / COLS) * cellH;
      return {
        center: { x: r2(x), y: r2(y + T / 2) },
        label: { x: r2(x), y: r2(y + T + 4 + labelSize * 0.95) },
        scale: Math.round(p.scale * f * 10000) / 10000,
      };
    }),
  };
}

export interface CalloutPlacement {
  readonly slot: Vec2;
  /** Rect of the largest copy at the slot (undefined without flights). */
  readonly copy?: Rect;
  /** Top-left of the box and its layout (undefined without a box). */
  /** Top-left of the box in window units; its layout is in screen units (drawn at `1 / zoom`). */
  readonly box?: { readonly x: number; readonly y: number; readonly layout: BoxLayout };
}

/**
 * The silhouette of a projected box (a hexagon) as two rects: its full width over the middle half
 * of its height, and the middle half of its width over its full height. The bounding rect would
 * keep a callout out of the empty corners of every part.
 */
export function plusRects(r: Rect): Rect[] {
  return [
    { x: r.x, y: r.y + r.height / 4, width: r.width, height: r.height / 2 },
    { x: r.x + r.width / 4, y: r.y, width: r.width / 2, height: r.height },
  ];
}

const overlapArea = (a: Rect, b: Rect, clear: number): number => {
  const w = Math.min(a.x + a.width, b.x + b.width + clear) - Math.max(a.x, b.x - clear);
  const h = Math.min(a.y + a.height, b.y + b.height + clear) - Math.max(a.y, b.y - clear);
  return w > 0 && h > 0 ? w * h : 0;
};

/** Whether the segment `p -> q` crosses `r` (slab method). */
export function segmentHits(p: Vec2, q: Vec2, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  for (const [a, d, lo, hi] of [
    [p.x, q.x - p.x, r.x, r.x + r.width],
    [p.y, q.y - p.y, r.y, r.y + r.height],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (a < lo || a > hi) return false;
    } else {
      const u = (lo - a) / d;
      const v = (hi - a) / d;
      t0 = Math.max(t0, Math.min(u, v));
      t1 = Math.min(t1, Math.max(u, v));
      if (t0 > t1) return false;
    }
  }
  return true;
}

export function placeCallout(input: {
  /** The camera window of the step. */
  readonly window: Rect;
  /** Rects the group must not cover (parts, non-assembly objects, labels). */
  readonly avoid: readonly Rect[];
  /** Non-assembly objects a flight must not cross on its way to its hover point. */
  readonly obstacles: readonly Rect[];
  /** Size of the largest flying copy (none: the step has no flights). */
  readonly copy: { readonly width: number; readonly height: number } | undefined;
  /** Centres of the copies at their hover points. */
  readonly ends: readonly Vec2[];
  readonly parts: readonly CalloutPart[];
  readonly labelSize: number;
  /** Camera scale of the window: the box is drawn `1 / zoom` as big, so it looks the same at any zoom. */
  readonly zoom: number;
}): CalloutPlacement {
  const { window: win, parts, labelSize, zoom } = input;
  const seen = input.avoid.filter((a) => overlapArea(a, win, 0) > 0);
  const walls = input.obstacles.filter((a) => overlapArea(a, win, 0) > 0);
  const target = win.y + 0.25 * win.height;

  /**
   * The free spot for a `w x h` rect nearest the window's left edge (then nearest `aim` down),
   * given the rects it must not cover; the cheapest one when none is free.
   */
  const find = (
    w: number,
    h: number,
    aim: number,
    extra: readonly Rect[],
    pathFrom: ((x: number, y: number) => Vec2) | undefined,
  ): { x: number; y: number; free: boolean } => {
    const xs: number[] = [];
    for (let x = win.x + MARGIN; x + w <= win.x + win.width - MARGIN + 1e-9; x += STEP) xs.push(x);
    const ys: number[] = [];
    for (let y = win.y + MARGIN; y + h <= win.y + win.height - MARGIN + 1e-9; y += STEP) ys.push(y);
    ys.sort((a, b) => Math.abs(a + h / 2 - aim) - Math.abs(b + h / 2 - aim) || a - b);
    if (xs.length === 0) xs.push(win.x + MARGIN);
    if (ys.length === 0) ys.push(win.y + MARGIN);
    let best = { x: xs[0] as number, y: ys[0] as number, cost: Infinity };
    for (const x of xs) {
      for (const y of ys) {
        const g: Rect = { x, y, width: w, height: h };
        let c = 0;
        for (const a of seen) c += overlapArea(g, a, CLEAR);
        for (const a of extra) c += overlapArea(g, a, CLEAR);
        if (pathFrom !== undefined) {
          const s = pathFrom(x, y);
          for (const e of input.ends) for (const o of walls) if (segmentHits(s, e, o)) c += 1e6;
        }
        if (c === 0) return { x, y, free: true };
        if (c < best.cost) best = { x, y, cost: c };
      }
    }
    return { x: best.x, y: best.y, free: false };
  };

  // 1. the box, shrinking its thumbnails until it fits
  let box: CalloutPlacement["box"];
  if (parts.length > 0) {
    let least: { x: number; y: number; layout: BoxLayout } | undefined;
    for (const f of FACTORS) {
      const layout = boxLayout(parts, f, labelSize);
      const at = find(layout.width / zoom, layout.height / zoom, target, [], undefined);
      least = { x: at.x, y: at.y, layout };
      if (at.free) break;
    }
    // nothing is free even at the smallest thumbnails: the box overlays the least it can (it never widens the window)
    const l = least as { x: number; y: number; layout: BoxLayout };
    box = { x: Math.round(l.x), y: Math.round(l.y), layout: l.layout };
  }
  // 2. the copies' slot: beside the box when there is room, else the nearest free spot
  const cw = input.copy?.width ?? 0;
  const ch = input.copy?.height ?? 0;
  if (cw === 0)
    return {
      slot: { x: Math.round(win.x + MARGIN), y: Math.round(target) },
      ...(box === undefined ? {} : { box }),
    };
  const boxRect: Rect[] =
    box === undefined
      ? []
      : [
          {
            x: box.x - GAP_BOX / 2,
            y: box.y - GAP_BOX / 2,
            width: box.layout.width + GAP_BOX,
            height: box.layout.height + GAP_BOX,
          },
        ];
  const aim = box === undefined ? target : box.y + box.layout.height / 2;
  const at = find(cw, ch, aim, boxRect, (x, y) => ({ x: x + cw / 2, y: y + ch / 2 }));
  const slot = { x: Math.round(at.x + cw / 2), y: Math.round(at.y + ch / 2) };
  return {
    slot,
    copy: { x: slot.x - cw / 2, y: slot.y - ch / 2, width: cw, height: ch },
    ...(box === undefined ? {} : { box }),
  };
}
