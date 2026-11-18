import type { FontAsset } from "../contracts/index.js";
import { fmt } from "../geometry/index.js";
import { INTER_BOLD_B64, INTER_REGULAR_B64 } from "./font-data.js";
import { type ParsedFont, type Point, parseFont, sfntToWoff2, subsetFont } from "./sfnt.js";

/**
 * Text support (PLAN §6 `text/`): label measurement, text-to-path, and per-diagram font
 * subsets. The vendored font is Inter (SIL OFL 1.1, LICENSES/Inter-OFL-1.1.txt), Latin subset,
 * Regular and Bold. No kerning or shaping: measurement and outlines use plain advances, so
 * both `<text>` and outlined output lay out identically in the engine's own model.
 */

/** Family name of the vendored font (used for raster `FontAsset`s). */
export const EMBED_FAMILY = "Inter";
export const WEIGHT_REGULAR = 400;
export const WEIGHT_BOLD = 700;

export type TextWeight = "regular" | "bold";
export type TextAnchor = "start" | "middle" | "end";

export interface TextFont {
  readonly weight: number;
  readonly parsed: ParsedFont;
  readonly ttf: Uint8Array;
}

const cache = new Map<TextWeight, TextFont>();

function load(weight: TextWeight): TextFont {
  const hit = cache.get(weight);
  if (hit) return hit;
  const ttf = new Uint8Array(
    Buffer.from(weight === "bold" ? INTER_BOLD_B64 : INTER_REGULAR_B64, "base64"),
  );
  const font: TextFont = {
    weight: weight === "bold" ? WEIGHT_BOLD : WEIGHT_REGULAR,
    parsed: parseFont(ttf),
    ttf,
  };
  cache.set(weight, font);
  return font;
}

/** Map a CSS font-weight to the vendored face: >= 600 is Bold. */
export function weightFace(weight: number): TextWeight {
  return weight >= 600 ? "bold" : "regular";
}

export function getFont(weight: TextWeight = "regular"): TextFont {
  return load(weight);
}

function codePoints(text: string): number[] {
  return Array.from(text, (ch) => ch.codePointAt(0) as number);
}

/** Advance width of `text` in SVG units for font-size `size`. */
export function measureText(text: string, size: number, weight: TextWeight = "regular"): number {
  const f = load(weight).parsed;
  let units = 0;
  for (const cp of codePoints(text)) units += f.advance(f.cmap.get(cp) ?? 0);
  return (units * size) / f.unitsPerEm;
}

/** Code points of `text` the vendored font cannot draw (rendered with the notdef glyph). */
export function missingGlyphs(text: string): number[] {
  const f = load("regular").parsed;
  const out = new Set<number>();
  for (const cp of codePoints(text)) if (cp > 0x20 && !f.cmap.has(cp)) out.add(cp);
  return [...out].sort((a, b) => a - b);
}

/** Line metrics scaled to `size`: ascent above and descent below the baseline (both positive). */
export function lineMetrics(size: number): { ascent: number; descent: number; height: number } {
  const f = load("regular").parsed;
  const s = size / f.unitsPerEm;
  return {
    ascent: f.ascent * s,
    descent: -f.descent * s,
    height: (f.ascent - f.descent + f.lineGap) * s,
  };
}

function contourPath(
  pts: readonly Point[],
  tx: (x: number) => string,
  ty: (y: number) => string,
): string {
  const n = pts.length;
  if (n === 0) return "";
  const first = pts[0] as Point;
  const last = pts[n - 1] as Point;
  let start: { x: number; y: number };
  let seq: readonly Point[];
  if (first.on) {
    start = first;
    seq = pts.slice(1);
  } else if (last.on) {
    start = last;
    seq = pts.slice(0, n - 1);
  } else {
    start = { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 };
    seq = pts;
  }
  const P = (p: { x: number; y: number }) => `${tx(p.x)} ${ty(p.y)}`;
  let d = `M${P(start)}`;
  let ctrl: Point | undefined;
  for (const p of seq) {
    if (p.on) {
      d += ctrl ? `Q${P(ctrl)} ${P(p)}` : `L${P(p)}`;
      ctrl = undefined;
    } else {
      if (ctrl) d += `Q${P(ctrl)} ${P({ x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2 })}`;
      ctrl = p;
    }
  }
  if (ctrl) d += `Q${P(ctrl)} ${P(start)}`;
  return `${d}Z`;
}

export interface TextPathOptions {
  /** Baseline origin. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly weight?: TextWeight;
  readonly anchor?: TextAnchor;
}

/** Glyph outlines of `text` as one SVG path (`d`) plus its advance width. Deterministic, 2 decimals. */
export function textToPath(text: string, o: TextPathOptions): { d: string; width: number } {
  const face = load(o.weight ?? "regular").parsed;
  const s = o.size / face.unitsPerEm;
  const width = measureText(text, o.size, o.weight ?? "regular");
  const x0 = o.x - (o.anchor === "middle" ? width / 2 : o.anchor === "end" ? width : 0);
  let pen = 0;
  let d = "";
  for (const cp of codePoints(text)) {
    const gid = face.cmap.get(cp) ?? 0;
    const ox = x0 + pen * s;
    const tx = (x: number) => fmt(ox + x * s);
    const ty = (y: number) => fmt(o.y - y * s);
    for (const c of face.contours(gid)) d += contourPath(c, tx, ty);
    pen += face.advance(gid);
  }
  return { d, width };
}

/** Base64 WOFF2 subset of one face covering exactly the code points of `text` (+ space, notdef). */
export function subsetWoff2Base64(text: string, weight: TextWeight = "regular"): string {
  const f = load(weight);
  const cps = new Set(codePoints(text));
  cps.add(0x20);
  const woff2 = sfntToWoff2(subsetFont(f.parsed, cps));
  return Buffer.from(woff2).toString("base64");
}

/** Subset TrueType bytes (used by tests; rasterization takes the full Latin faces). */
export function subsetTtf(text: string, weight: TextWeight = "regular"): Uint8Array {
  const cps = new Set(codePoints(text));
  cps.add(0x20);
  return subsetFont(load(weight).parsed, cps);
}

/** Fonts for `rasterize` (resvg wants TTF/OTF): the full vendored Latin faces. */
export function fontAssets(): readonly FontAsset[] {
  return [
    { family: EMBED_FAMILY, weight: WEIGHT_REGULAR, sfnt: new Uint8Array(load("regular").ttf) },
    { family: EMBED_FAMILY, weight: WEIGHT_BOLD, sfnt: new Uint8Array(load("bold").ttf) },
  ];
}
