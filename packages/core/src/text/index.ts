import type { FontAsset } from "../contracts/index.js";
import { fmt } from "../geometry/index.js";
import {
  JETBRAINS_BOLD_B64,
  JETBRAINS_REGULAR_B64,
  OSWALD_MEDIUM_B64,
  OSWALD_REGULAR_B64,
  OSWALD_SEMIBOLD_B64,
} from "./font-data.js";
import { type ParsedFont, type Point, parseFont, sfntToWoff2, subsetFont } from "./sfnt.js";

/**
 * Text support (PLAN §6 `text/`): label measurement, text-to-path, and per-diagram font
 * subsets. Two vendored families (D51), both SIL OFL 1.1, Latin subsets: Oswald for display text
 * (Regular 400, Medium 500, SemiBold 600 as "bold") and JetBrains Mono for technical text
 * (Regular 400, Bold 700). See LICENSES/ and assets/fonts/PROVENANCE.txt. No kerning or shaping:
 * measurement and outlines use plain advances, so both `<text>` and outlined output lay out
 * identically in the engine's own model.
 *
 * Fallback: a code point the display face lacks (Oswald has no arrows) is drawn, measured,
 * outlined and embedded with the mono face when that has it (`fallbackFamily`).
 */

/** Family names of the vendored fonts (used for raster `FontAsset`s). */
export const EMBED_FAMILY = "Oswald";
export const EMBED_MONO_FAMILY = "JetBrains Mono";
export const WEIGHT_REGULAR = 400;
export const WEIGHT_MEDIUM = 500;
/** Weight of the bold face per family: Oswald SemiBold, JetBrains Mono Bold. */
export const WEIGHT_BOLD = 600;
export const WEIGHT_MONO_BOLD = 700;

/** Text role: `display` (Oswald) for labels, pills, captions; `mono` (JetBrains Mono) for technical text. */
export type TextFamily = "display" | "mono";

/** `medium` exists for the display family only (mono maps it to regular). */
export type TextWeight = "regular" | "medium" | "bold";
export type TextAnchor = "start" | "middle" | "end";

export interface TextFont {
  readonly weight: number;
  readonly parsed: ParsedFont;
  readonly ttf: Uint8Array;
}

const cache = new Map<string, TextFont>();

const SOURCES = {
  display: {
    regular: OSWALD_REGULAR_B64,
    medium: OSWALD_MEDIUM_B64,
    bold: OSWALD_SEMIBOLD_B64,
    boldWeight: WEIGHT_BOLD,
  },
  mono: {
    regular: JETBRAINS_REGULAR_B64,
    medium: JETBRAINS_REGULAR_B64,
    bold: JETBRAINS_BOLD_B64,
    boldWeight: WEIGHT_MONO_BOLD,
  },
} as const;

function load(weight: TextWeight, family: TextFamily = "display"): TextFont {
  const key = `${family}:${weight}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const src = SOURCES[family];
  const ttf = new Uint8Array(Buffer.from(src[weight], "base64"));
  const font: TextFont = {
    weight:
      weight === "bold"
        ? src.boldWeight
        : weight === "medium" && family === "display"
          ? WEIGHT_MEDIUM
          : WEIGHT_REGULAR,
    parsed: parseFont(ttf),
    ttf,
  };
  cache.set(key, font);
  return font;
}

/** Map a CSS font-weight to the vendored face: >= 600 is the bold face. */
export function weightFace(weight: number): TextWeight {
  return weight >= 600 ? "bold" : "regular";
}

export function getFont(weight: TextWeight = "regular", family: TextFamily = "display"): TextFont {
  return load(weight, family);
}

function codePoints(text: string): number[] {
  return Array.from(text, (ch) => ch.codePointAt(0) as number);
}

/** True when `cp` is drawn by the mono face instead of the (display) face that lacks it. */
export function fallsBackToMono(cp: number): boolean {
  return (
    cp > 0x20 &&
    !load("regular", "display").parsed.cmap.has(cp) &&
    load("regular", "mono").parsed.cmap.has(cp)
  );
}

/** Face used for one code point: the role's own, or the mono fallback for display text. */
function faceFor(cp: number, weight: TextWeight, family: TextFamily): TextFont {
  if (family === "display" && fallsBackToMono(cp)) {
    return load(weight === "bold" ? "bold" : "regular", "mono");
  }
  return load(weight, family);
}

/** Text a display run hands to the mono face (fallback code points), for embedding. */
export function fallbackText(text: string): string {
  return codePoints(text)
    .filter(fallsBackToMono)
    .map((cp) => String.fromCodePoint(cp))
    .join("");
}

/**
 * Label font size for a drawing of projected width `widthPx` (D51 follow-up): wide scenes are
 * shown small, so text grows with the scene, about width / 100, between 1x and 2.2x `base`.
 * Shared by the renderer and the router's label keep-outs so both agree.
 */
export function labelFontSize(widthPx: number, base: number): number {
  return Math.min(base * 2.2, Math.max(base, Math.round(widthPx / 100)));
}

/** Advance width of `text` in SVG units for font-size `size`. */
export function measureText(
  text: string,
  size: number,
  weight: TextWeight = "regular",
  family: TextFamily = "display",
): number {
  let width = 0;
  for (const cp of codePoints(text)) {
    const f = faceFor(cp, weight, family).parsed;
    width += (f.advance(f.cmap.get(cp) ?? 0) * size) / f.unitsPerEm;
  }
  return width;
}

/**
 * Code points of `text` no vendored face can draw (rendered with the notdef glyph). Display
 * text may use the mono fallback.
 */
export function missingGlyphs(text: string, family: TextFamily = "display"): number[] {
  const f = load("regular", family).parsed;
  const out = new Set<number>();
  for (const cp of codePoints(text)) {
    if (cp > 0x20 && !f.cmap.has(cp) && !(family === "display" && fallsBackToMono(cp))) out.add(cp);
  }
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
  readonly family?: TextFamily;
}

/** Glyph outlines of `text` as one SVG path (`d`) plus its advance width. Deterministic, 2 decimals. */
export function textToPath(text: string, o: TextPathOptions): { d: string; width: number } {
  const weight = o.weight ?? "regular";
  const width = measureText(text, o.size, weight, o.family);
  const x0 = o.x - (o.anchor === "middle" ? width / 2 : o.anchor === "end" ? width : 0);
  let pen = 0; // SVG units
  let d = "";
  for (const cp of codePoints(text)) {
    const face = faceFor(cp, weight, o.family ?? "display").parsed;
    const s = o.size / face.unitsPerEm;
    const gid = face.cmap.get(cp) ?? 0;
    const ox = x0 + pen;
    const tx = (x: number) => fmt(ox + x * s);
    const ty = (y: number) => fmt(o.y - y * s);
    for (const c of face.contours(gid)) d += contourPath(c, tx, ty);
    pen += face.advance(gid) * s;
  }
  return { d, width };
}

/** Base64 WOFF2 subset of one face covering exactly the code points of `text` (+ space, notdef). */
export function subsetWoff2Base64(
  text: string,
  weight: TextWeight = "regular",
  family: TextFamily = "display",
): string {
  const f = load(weight, family);
  const cps = new Set(codePoints(text));
  cps.add(0x20);
  const woff2 = sfntToWoff2(subsetFont(f.parsed, cps));
  return Buffer.from(woff2).toString("base64");
}

/** Subset TrueType bytes (used by tests; rasterization takes the full Latin faces). */
export function subsetTtf(
  text: string,
  weight: TextWeight = "regular",
  family: TextFamily = "display",
): Uint8Array {
  const cps = new Set(codePoints(text));
  cps.add(0x20);
  return subsetFont(load(weight, family).parsed, cps);
}

/**
 * Fonts for `rasterize` (resvg wants TTF/OTF): the full vendored Latin faces of both families.
 * The display family comes first (resvg's default family).
 */
export function fontAssets(): readonly FontAsset[] {
  const asset = (family: string, kind: TextFamily, weight: TextWeight): FontAsset => ({
    family,
    weight: load(weight, kind).weight,
    sfnt: new Uint8Array(load(weight, kind).ttf),
  });
  return [
    asset(EMBED_FAMILY, "display", "regular"),
    asset(EMBED_FAMILY, "display", "medium"),
    asset(EMBED_FAMILY, "display", "bold"),
    asset(EMBED_MONO_FAMILY, "mono", "regular"),
    asset(EMBED_MONO_FAMILY, "mono", "bold"),
  ];
}
