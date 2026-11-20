/**
 * Placement of a figure panel (docs/design/assemblies.md §15): the base image fills the panel,
 * sprites sit at their seat and move to their exploded place (both in the base image's pixels,
 * scaled to the panel). Pure geometry over real sprite sizes: the default exploded place and
 * the draw order need them.
 */
import type { Rect } from "../../contracts/index.js";
import type { ResolvedFigure, ResolvedFigurePart } from "../../scene/boards.js";

export interface SpriteBox {
  readonly part: ResolvedFigurePart;
  /** Position in the spec's part order. */
  readonly index: number;
  /** Sprite size in screen units. */
  readonly width: number;
  readonly height: number;
  /** Top-left corner when seated and when exploded, screen units. */
  readonly seat: { readonly x: number; readonly y: number };
  readonly exploded: { readonly x: number; readonly y: number };
  /** Exploded minus seat. */
  readonly offset: { readonly x: number; readonly y: number };
  /** Whether a stage moves it and the two places differ. */
  readonly moves: boolean;
  /** Level whose stages have moved it (undefined: never moves). */
  readonly stage: number | undefined;
  /** Source sprite size in the sprite image's own pixels. */
  readonly px: { readonly width: number; readonly height: number };
}

export interface FigureLayout {
  /** Scale of base-image pixels to screen units. */
  readonly scale: number;
  /** Sprites in draw order: `z` (default 0), then the seat's bottom edge, then spec order. */
  readonly sprites: readonly SpriteBox[];
}

/** Draw order: lower `z` first; the lower the seat's bottom edge on screen, the later it draws. */
export function drawOrder(a: SpriteBox, b: SpriteBox): number {
  return (
    (a.part.z ?? 0) - (b.part.z ?? 0) ||
    a.seat.y + a.height - (b.seat.y + b.height) ||
    a.index - b.index
  );
}

/**
 * Lays out the sprites of a figure whose panel has its top-left corner at `origin` and a width of
 * `panelWidth` screen units for a base image `baseWidth` pixels wide. `sizeOf` gives a sprite's
 * pixel size (undefined: the image is not available, the part is left out).
 */
export function layoutFigure(
  figure: ResolvedFigure,
  origin: { readonly x: number; readonly y: number },
  panelWidth: number,
  baseWidth: number,
  sizeOf: (image: string) => { readonly width: number; readonly height: number } | undefined,
): FigureLayout {
  const scale = panelWidth / baseWidth;
  const sprites: SpriteBox[] = [];
  figure.parts.forEach((part, index) => {
    const px = sizeOf(part.image);
    if (px === undefined) return;
    // Default exploded place: straight up by the sprite height plus 20%.
    const ex = part.exploded?.[0] ?? part.seat[0];
    const ey = part.exploded?.[1] ?? part.seat[1] - px.height * 1.2;
    const seat = { x: origin.x + part.seat[0] * scale, y: origin.y + part.seat[1] * scale };
    const exploded = { x: origin.x + ex * scale, y: origin.y + ey * scale };
    const offset = { x: exploded.x - seat.x, y: exploded.y - seat.y };
    sprites.push({
      part,
      index,
      width: px.width * scale,
      height: px.height * scale,
      seat,
      exploded,
      offset,
      moves: part.stage !== undefined && (offset.x !== 0 || offset.y !== 0),
      stage: part.stage,
      px,
    });
  });
  return { scale, sprites: [...sprites].sort(drawOrder) };
}

export const spriteRect = (s: SpriteBox, at: "seat" | "exploded"): Rect => ({
  x: s[at].x,
  y: s[at].y,
  width: s.width,
  height: s.height,
});

export function unionOf(rects: readonly Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** One label to place in a column beside the panel. */
export interface LabelBox {
  readonly key: string;
  /** Wanted vertical centre (the sprite's centre at its pose). */
  readonly centre: number;
  readonly height: number;
  /** Fixed labels keep their centre; the others step down to clear what is placed. */
  readonly fixedTop?: number;
}

/**
 * Stacks labels of one column so none overlaps another (gap `gap`): fixed ones keep their top,
 * the rest go in order of wanted position and step below anything in the way. Returns the top
 * of every label by key. Deterministic: ties break by key.
 */
export function stackLabels(items: readonly LabelBox[], gap: number): Map<string, number> {
  const tops = new Map<string, number>();
  const placed: { top: number; bottom: number }[] = [];
  for (const it of items) {
    if (it.fixedTop === undefined) continue;
    tops.set(it.key, it.fixedTop);
    placed.push({ top: it.fixedTop, bottom: it.fixedTop + it.height });
  }
  const free = items
    .filter((it) => it.fixedTop === undefined)
    .sort((a, b) => a.centre - b.centre || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const it of free) {
    let top = it.centre - it.height / 2;
    for (let guard = 0; guard <= placed.length; guard++) {
      const hit = placed
        .filter((p) => top < p.bottom + gap && top + it.height + gap > p.top)
        .sort((a, b) => b.bottom - a.bottom)[0];
      if (hit === undefined) break;
      top = hit.bottom + gap;
    }
    tops.set(it.key, top);
    placed.push({ top, bottom: top + it.height });
  }
  return tops;
}
