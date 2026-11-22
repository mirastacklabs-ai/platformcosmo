/**
 * Layout of a step's parts callout (Track A2, A2-6; docs/design/assemblies.md §6.5, §7.6): the box
 * with `count x thumbnail` per part kind, and the callout slot its flights start from. Pure and
 * deterministic; every number is rounded here.
 *
 * Left to right, centred on a quarter of the reference rect's height down: the box, the slot (the
 * copies of the flying parts are centred on it, clear of the box and of the model), the model.
 * The reference rect is the step's focus rect (the camera frames it, so the box and the slot are
 * on screen under zoom) or, without focus, the rest bounds of the assemblies. The group of box and
 * copies moves left until it overlaps no part of the model.
 */
import type { Rect, Vec2 } from "../../contracts/index.js";
import { unionRects } from "../../geometry/index.js";
import { measureText } from "../../text/index.js";

/** Longest side of a thumbnail (a smaller part is drawn at its own scale, never enlarged). */
export const THUMB = 44;
/** Part kinds one box shows (the rest are reported: `layout/callout-truncated`). */
export const MAX_CELLS = 12;
const PAD = 8;
const COLS = 4;
const GAP_REF = 16;
const GAP_BOX = 12;
const CLEAR = 6;

const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;
const even = (v: number): number => 2 * Math.ceil(v / 2);

export interface CalloutCell {
  /** Centre of the thumbnail. */
  readonly center: Vec2;
  /** Scale of the thumbnail (at most 1). */
  readonly scale: number;
  /** Baseline and centre of the `<count>x` text. */
  readonly label: Vec2;
}

export interface CalloutLayout {
  readonly slot: Vec2;
  /** Rect of the largest copy at the slot (for the view box); undefined without flights. */
  readonly copy?: Rect;
  readonly box?: Rect;
  /** One per part kind given, in order. */
  readonly cells: readonly CalloutCell[];
}

export interface CalloutPart {
  /** Screen size of the part at rest. */
  readonly width: number;
  readonly height: number;
  readonly count: number;
}

export function layoutCallout(input: {
  readonly ref: Rect;
  /** Rest rects of the parts of the model, which the callout must not cover. */
  readonly avoid: readonly Rect[];
  /** Size of the largest flying copy (none: the step has no flights). */
  readonly copy: { readonly width: number; readonly height: number } | undefined;
  /** The part kinds to show, at most `MAX_CELLS`. */
  readonly parts: readonly CalloutPart[];
  readonly labelSize: number;
}): CalloutLayout {
  const { ref, parts, labelSize } = input;
  const cy = ref.y + 0.25 * ref.height;
  const cw = input.copy?.width ?? 0;
  const ch = input.copy?.height ?? 0;
  const copyRight = ref.x - GAP_REF;
  let slotX = copyRight - cw / 2;

  const n = parts.length;
  const cols = Math.min(n, COLS);
  const rows = Math.ceil(n / COLS);
  const cellW = even(
    Math.max(THUMB, ...parts.map((p) => measureText(`${p.count}x`, labelSize, "bold"))) + 8,
  );
  const cellH = even(THUMB + 4 + labelSize * 1.2);
  const W = cols * cellW + 2 * PAD;
  const H = rows * cellH + 2 * PAD;
  let boxX = (cw > 0 ? copyRight - cw - GAP_BOX : copyRight) - W;
  const boxY = Math.round(cy - H / 2);

  // clear of the model: shift the whole group left past every part it would cover
  const groupRect = (): Rect => {
    const rs: Rect[] = [];
    if (n > 0) rs.push({ x: boxX, y: boxY, width: W, height: H });
    if (cw > 0) rs.push({ x: slotX - cw / 2, y: cy - ch / 2, width: cw, height: ch });
    return unionRects(rs.length > 0 ? rs : [{ x: slotX, y: cy, width: 0, height: 0 }]);
  };
  for (let i = 0; i <= input.avoid.length; i++) {
    const g = groupRect();
    const hit = input.avoid.find(
      (a) =>
        a.x - CLEAR < g.x + g.width &&
        a.x + a.width + CLEAR > g.x &&
        a.y - CLEAR < g.y + g.height &&
        a.y + a.height + CLEAR > g.y,
    );
    if (hit === undefined) break;
    const dx = hit.x - CLEAR - (g.x + g.width);
    boxX += dx;
    slotX += dx;
  }
  boxX = Math.round(boxX);
  slotX = Math.round(slotX);
  const slotY = Math.round(cy);

  const cells = parts.map((p, k): CalloutCell => {
    const x = boxX + PAD + (k % COLS) * cellW + cellW / 2;
    const y = boxY + PAD + Math.floor(k / COLS) * cellH;
    const side = Math.max(p.width, p.height);
    return {
      center: { x: r2(x), y: r2(y + THUMB / 2) },
      scale: side > THUMB ? THUMB / side : 1,
      label: { x: r2(x), y: r2(y + THUMB + 4 + labelSize * 0.95) },
    };
  });
  return {
    slot: { x: slotX, y: slotY },
    ...(cw > 0 ? { copy: { x: slotX - cw / 2, y: slotY - ch / 2, width: cw, height: ch } } : {}),
    ...(n > 0 ? { box: { x: boxX, y: boxY, width: W, height: H } } : {}),
    cells,
  };
}
