/**
 * Figure analysis (ingestion §6.2-6.3): the reference model that both the pipeline and the gate
 * use. From the manifest and the source drawings it derives, per moving unit (a group of parts
 * that move together) and state: seeded regions, bounding ink, the shape prior, whole ink where
 * the unit stands alone, the expected silhouette (one template per instance class, placed by
 * `locate`), the visible part of it, the hull and the geodesic part ink; plus the alignment
 * between the states, the static drawing, and every annotation's band, mask and allowances.
 *
 * The gate never trusts the outputs it checks: it recomputes this analysis and compares.
 */
import type { Diagnostic } from "@platformcosmo/core";
import { align } from "../align.js";
import { locate } from "../locate.js";
import { crop } from "../ops.js";
import {
  MAX_MULTIPLY_ADDS,
  MAX_PIXELS,
  badOption,
  checkRaster,
  err,
  warning,
  type Raster,
} from "../raster.js";
import {
  STEP,
  boxDistance,
  detectHead,
  inBox,
  measureAnnotation,
  polylineLength,
  type AnnotationGeometry,
} from "./annotations.js";
import {
  STATES,
  validateManifest,
  type FigureManifest,
  type FigureState,
  type Point,
} from "./manifest.js";
import {
  EMPTY,
  blank,
  bounds,
  clipBox,
  convexHull,
  count,
  dilate,
  erode,
  fillHoles,
  filter,
  has,
  capsules,
  hullOfPoints,
  intersect,
  isEmpty,
  labelMask,
  minus,
  nearest,
  overlapCount,
  overlaps,
  peelExterior,
  rasterPolygon,
  shifted,
  tight,
  union,
  type Box,
  type Mask,
} from "./mask.js";
import { analyzeState, type StateImage } from "./state.js";

export interface FigureLimits {
  /** Pixels per source image (default 16 MP). */
  readonly maxPixels?: number;
  /** Multiply-adds for all matcher runs of one figure together (default 2·10⁹). */
  readonly maxMultiplyAdds?: number;
}

export interface FigureOptions extends FigureLimits {
  /** Halves every pixel threshold of the gate (`--strict`). */
  readonly strict?: boolean;
}

/** Decoded source images keyed by the manifest's `sources` values (file names as written). */
export type FigureSources = Readonly<Record<string, Raster>>;

export interface Depiction {
  readonly state: FigureState;
  /** Seeds in state-image pixels. */
  readonly seeds: readonly Point[];
  /** Seeded paper regions. */
  readonly R: Mask;
  /** Bounding ink of R. */
  readonly B: Mask;
  /** Preliminary mask: R, B and what they enclose (peeled; bounded by polygon and prior). */
  readonly P: Mask;
  /** Shape prior fitted to the seeded mask (EMPTY for `none`). */
  readonly prior: Mask;
  /** The unit's ink without any annotation band (for contacts); bounded flood. */
  readonly contact: Mask;
  /** Whole ink (8-connected to B, after the allowance cut) when the unit stands alone here. */
  readonly W?: Mask;
  readonly standalone: boolean;
  /** The unit's own segmentation here: whole silhouette where standalone, else P. */
  readonly V: Mask;
}

export interface Placement {
  /** Top-left of the template in this state's image. */
  readonly x: number;
  readonly y: number;
  readonly score: number;
  /** Expected silhouette (template mask placed here). */
  E: Mask;
  /** Visible part: E minus the units in front. */
  visible: Mask;
  /** The convex hull (mapped whole ink, mask, prior) before the 2 px margin. */
  core: Mask;
  /** `core` dilated by 2 px. */
  hull: Mask;
  partInk: Mask;
}

export interface Unit {
  readonly index: number;
  /** Group id (the figure part id in the spec output). */
  readonly id: string;
  readonly partIds: readonly string[];
  readonly cls: number;
  readonly holes: boolean;
  readonly allowDisjoint: boolean;
  readonly prior: "box" | "cylinder" | "none";
  readonly z?: number;
  readonly nearest: Partial<Record<FigureState, Point>>;
  readonly polygons: Partial<Record<FigureState, readonly (readonly Point[])[]>>;
  /** Seeds of all the unit's parts, in state-image pixels. */
  readonly seeds: Partial<Record<FigureState, readonly Point[]>>;
  readonly dep: Partial<Record<FigureState, Depiction>>;
  readonly place: Partial<Record<FigureState, Placement>>;
  /** State whose whole ink built the hull, or undefined (hull-uncertain). */
  standaloneState?: FigureState;
}

export interface TemplateClass {
  readonly index: number;
  readonly id: string;
  readonly units: readonly number[];
  /** Template depiction. */
  readonly unit: number;
  readonly state: FigureState;
  /** Template mask in the template state's image coordinates. */
  mask: Mask;
  /** Template sprite colours (RGBA, the mask's box; alpha 255 inside). */
  sprite: Raster;
  /**
   * Template pixels that were hidden (covered by another unit, or under an annotation) and that no
   * other depiction showed: expected from the shape prior (or the mask's hull) but not in the
   * sprite. Template-state coordinates, like `mask`.
   */
  unrecovered: Mask;
  /** Pixels added to the template from other depictions (template-state coordinates). */
  recovered: Mask;
}

export interface Analysis {
  readonly manifest: FigureManifest;
  readonly strict: boolean;
  readonly states: readonly FigureState[];
  readonly base: FigureState;
  readonly img: Partial<Record<FigureState, StateImage>>;
  /** Base frame -> state frame: a base pixel (x, y) is at (x + d[0], y + d[1]). */
  readonly d: Partial<Record<FigureState, readonly [number, number]>>;
  readonly alignment?: {
    readonly dx: number;
    readonly dy: number;
    readonly score: number;
    readonly support: number;
  };
  readonly units: readonly Unit[];
  readonly classes: readonly TemplateClass[];
  readonly annotations: readonly AnnotationGeometry[];
  /** Exempt allowance squares per annotation and unit ("g:u"). */
  readonly exempt: ReadonlyMap<string, readonly Box[]>;
  /** Raw ink with every qualifying allowance square cut out (part ink runs on it). */
  readonly cutInk: Partial<Record<FigureState, Uint8Array>>;
  /** Union of the annotation masks mapped into the state (mapped ones minus part pixels). */
  readonly excluded: Partial<Record<FigureState, Mask>>;
  /** Front relations: front[state] has "u>v" when unit u is in front of v there. */
  readonly front: Partial<Record<FigureState, ReadonlySet<string>>>;
  readonly diagnostics: Diagnostic[];
  /** Matcher budget (multiply-adds) left for later searches (the exploded-only seat search). */
  readonly maxMultiplyAdds: number;
  /** Per annotation: invalidity reasons (rules 2-5) with their bbox. */
  readonly invalid: {
    readonly annotation: number | null;
    readonly state: FigureState;
    readonly reason: string;
    readonly bbox?: Box;
  }[];
}

const other = (s: FigureState): FigureState => (s === "exploded" ? "assembled" : "exploded");

/** A depiction considered as a class's template (§6.3). */
export interface TemplateCandidate {
  readonly u: {
    readonly index: number;
    readonly dep: Partial<Record<FigureState, { readonly V: Mask }>>;
  };
  readonly s: FigureState;
  /** Prior or hull pixels hidden under other units and not shown by this depiction. */
  readonly occ: number;
  /** 0 where the depiction stands alone. */
  readonly alone: number;
  /** Mean centred IoU with the other candidates, × 1000. */
  readonly cons: number;
}

/**
 * Template order (§6.3): fewest occluded pixels, then standing alone, then consistency with the
 * other depictions, then the exploded drawing, then unit order. Never the largest area: a
 * depiction that swallowed neighbouring ink is the largest.
 */
export function compareTemplates(a: TemplateCandidate, b: TemplateCandidate): number {
  return (
    a.occ - b.occ ||
    a.alone - b.alone ||
    b.cons - a.cons ||
    STATES.indexOf(a.s) - STATES.indexOf(b.s) ||
    a.u.index - b.u.index
  );
}

/** Pixel thresholds (ingestion §6.5); `strict` halves them. */
export function thresholds(strict: boolean) {
  const k = strict ? 0.5 : 1;
  return {
    residual: 24 * k,
    leftover: 12 * k,
    foreign: 4 * k,
    unrecovered: 24 * k,
    occluded: 24 * k,
    annotationResidual: 4 * k,
    cumulative: 16 * k,
    exclusionFraction: 0.05 * k,
    textFraction: 0.02 * k,
    leftoverNcc: 0.6,
    seatNcc: 0.3,
    luminance: 48,
  } as const;
}

/** Stand-alone test: at most this fraction of the whole ink beyond the seeded mask is static. */
const STANDALONE_STATIC = 0.25;
const TAN30 = Math.tan(Math.PI / 6);

function regionMask(st: StateImage, id: number): Mask {
  const o = (id - 1) * 4;
  const x = st.regions.bboxes[o]!;
  const y = st.regions.bboxes[o + 1]!;
  const w = st.regions.bboxes[o + 2]!;
  const h = st.regions.bboxes[o + 3]!;
  const m = blank(x, y, w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++)
      if (st.regions.labels[(y + j) * st.W + x + i] === id) m.data[j * w + i] = 1;
  }
  return m;
}

function inkMask(ink: Uint8Array, W: number, m: Mask): Mask {
  return filter(m, (x, y) => ink[y * W + x] !== 0);
}

/** Nearest paper pixel to a seed within Chebyshev radius 3 (fixed ring order), or undefined. */
function snapSeed(st: StateImage, x: number, y: number): [number, number] | undefined {
  for (let r = 0; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && py >= 0 && px < st.W && py < st.H && !st.ink[py * st.W + px])
          return [px, py];
      }
    }
  }
  return undefined;
}

/**
 * Ink 8-connected to `start` through `pass` (and not `block`), giving up (undefined) beyond
 * `budget` pixels. `scratch` is a W*H buffer that is left cleared.
 */
function flood(
  pass: Uint8Array,
  W: number,
  H: number,
  start: Mask,
  budget: number,
  scratch: Uint8Array,
  block?: (x: number, y: number) => boolean,
): Mask | undefined {
  const touched: number[] = [];
  const stack: number[] = [];
  const ok = (p: number): boolean =>
    pass[p] !== 0 && !scratch[p] && !(block && block(p % W, (p - (p % W)) / W));
  for (let j = 0; j < start.h; j++) {
    for (let i = 0; i < start.w; i++) {
      if (!start.data[j * start.w + i]) continue;
      const x = i + start.x;
      const y = j + start.y;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const p = y * W + x;
      if (ok(p)) {
        scratch[p] = 1;
        touched.push(p);
        stack.push(p);
      }
    }
  }
  let over = touched.length > budget;
  while (stack.length > 0 && !over) {
    const p = stack.pop()!;
    const x = p % W;
    const y = (p - x) / W;
    for (let dy = -1; dy <= 1 && !over; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const a = x + dx;
        const b = y + dy;
        if (a < 0 || b < 0 || a >= W || b >= H) continue;
        const q = b * W + a;
        if (!ok(q)) continue;
        scratch[q] = 1;
        touched.push(q);
        stack.push(q);
        if (touched.length > budget) {
          over = true;
          break;
        }
      }
    }
  }
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (const p of touched) {
    const x = p % W;
    const y = (p - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  let out: Mask | undefined;
  if (!over && x1 >= 0) {
    out = blank(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    for (const p of touched) {
      const x = p % W;
      const y = (p - x) / W;
      out.data[(y - y0) * out.w + x - x0] = 1;
    }
  }
  for (const p of touched) scratch[p] = 0;
  if (over) return undefined;
  return out ?? EMPTY;
}

/** Geodesic flood: pixels of `pass` 8-connected to `start` inside `inside` (a local mask). */
function geodesic(pass: Uint8Array, W: number, start: Mask, inside: Mask): Mask {
  const out = blank(inside.x, inside.y, inside.w, inside.h);
  if (out === EMPTY) return out;
  const stack: number[] = [];
  const ok = (x: number, y: number): boolean => has(inside, x, y) && pass[y * W + x] !== 0;
  for (let j = 0; j < start.h; j++) {
    for (let i = 0; i < start.w; i++) {
      if (!start.data[j * start.w + i]) continue;
      const x = i + start.x;
      const y = j + start.y;
      if (!ok(x, y)) continue;
      const k = (y - out.y) * out.w + x - out.x;
      if (out.data[k]) continue;
      out.data[k] = 1;
      stack.push(k);
    }
  }
  while (stack.length > 0) {
    const k = stack.pop()!;
    const i = k % out.w;
    const j = (k - i) / out.w;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const a = i + di;
        const b = j + dj;
        if (a < 0 || b < 0 || a >= out.w || b >= out.h) continue;
        const q = b * out.w + a;
        if (out.data[q] || !ok(a + out.x, b + out.y)) continue;
        out.data[q] = 1;
        stack.push(q);
      }
    }
  }
  return out;
}

function boxMask(b: Box, W: number, H: number): Mask {
  const c = clipBox(b, W, H);
  const m = blank(c.x, c.y, c.w, c.h);
  m.data.fill(1);
  return m;
}

function polygonBound(
  polys: readonly (readonly Point[])[] | undefined,
  W: number,
  H: number,
): Mask | undefined {
  if (!polys || polys.length === 0) return undefined;
  // A rough outline: its convex hull, dilated by 3 px (outlines from a viewed image are approximate).
  return dilate(union(...polys.map((p) => rasterPolygon(hullOfPolygon(p)))), 3, W, H);
}

function hullOfPolygon(pts: readonly Point[]): (readonly [number, number])[] {
  const sorted = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]): number =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lower: (readonly [number, number])[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: (readonly [number, number])[] = [];
  for (let k = sorted.length - 1; k >= 0; k--) {
    const p = sorted[k]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  const poly = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return poly.length > 0 ? poly : sorted.slice(0, 1);
}

/**
 * The shape prior of §6.2 fitted to a seeded mask. `box`: the isometric box hull, the smallest
 * hexagon with vertical sides and ±30° edges containing the mask (an isometric box's
 * silhouette). `cylinder`: the convex hull of the mask and its mirror image about its vertical
 * axis (an upright cylinder is symmetric). `none`: no prior.
 */
export function fitPrior(m: Mask, kind: "box" | "cylinder" | "none"): Mask {
  if (kind === "none" || m.w === 0) return EMPTY;
  if (kind === "cylinder") {
    const b = bounds(m);
    if (!b) return EMPTY;
    const pts: [number, number][] = [];
    for (let j = 0; j < m.h; j++) {
      for (let i = 0; i < m.w; i++) {
        if (!m.data[j * m.w + i]) continue;
        const x = i + m.x;
        const y = j + m.y;
        pts.push([x, y], [2 * b.x + b.w - 1 - x, y]);
      }
    }
    return hullOfPoints(pts);
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let j = 0; j < m.h; j++) {
    for (let i = 0; i < m.w; i++) {
      if (!m.data[j * m.w + i]) continue;
      const x = i + m.x;
      const y = j + m.y;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      u0 = Math.min(u0, y + TAN30 * x);
      u1 = Math.max(u1, y + TAN30 * x);
      v0 = Math.min(v0, y - TAN30 * x);
      v1 = Math.max(v1, y - TAN30 * x);
    }
  }
  const out = blank(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const u = y + TAN30 * x;
      const v = y - TAN30 * x;
      if (u >= u0 - 1e-9 && u <= u1 + 1e-9 && v >= v0 - 1e-9 && v <= v1 + 1e-9)
        out.data[(y - y0) * out.w + x - x0] = 1;
    }
  }
  return out;
}

/** Mask of `sprite` alpha placed with its top-left at (x, y). */
export function spriteMask(sprite: Raster, x: number, y: number): Mask {
  const m = blank(x, y, sprite.width, sprite.height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = sprite.data[i * 4 + 3]! > 0 ? 1 : 0;
  return m;
}

const tooExpensive = (what: string, n: number, limit: number, suggestion: string): Diagnostic =>
  err("asset/too-expensive", `${what} (about ${Math.round(n)}, above ${Math.round(limit)})`, {
    suggestion,
    params: { estimate: Math.round(n), limit: Math.round(limit) },
  });

/**
 * Runs the analysis. Returns undefined (with error diagnostics) when the inputs cannot be
 * analysed at all: invalid manifest or limits, missing or oversized images, no alignment, or a
 * budget exceeded.
 */
export function analyzeFigure(
  input: unknown,
  sources: FigureSources,
  options: FigureOptions = {},
): { value?: Analysis; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  for (const k of ["maxPixels", "maxMultiplyAdds"] as const) {
    const v = options[k];
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) {
      return { diagnostics: [badOption(k, `${k} must be a positive finite number`)] };
    }
  }
  const val = validateManifest(input);
  if (!val.value) return { diagnostics: val.diagnostics };
  const manifest = val.value;
  const strict = options.strict === true;
  const maxPixels = Math.min(options.maxPixels ?? MAX_PIXELS, MAX_PIXELS);
  // One matcher budget for the whole figure: alignment, every locate and the seat search.
  const budget = {
    left: Math.min(options.maxMultiplyAdds ?? MAX_MULTIPLY_ADDS, MAX_MULTIPLY_ADDS),
  };

  // ---- states and images
  const files = STATES.filter((s) => manifest.sources[s] !== undefined);
  const states = STATES.filter(
    (s) => manifest.sources[s] !== undefined || manifest.regions?.[s] !== undefined,
  );
  const img: Partial<Record<FigureState, StateImage>> = {};
  let bgColour: [number, number, number] | undefined;
  if (manifest.background && manifest.background !== "auto") {
    const h = manifest.background.slice(1);
    bgColour = [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  for (const s of states) {
    const file = manifest.sources[s] ?? manifest.sources[files[0]!]!;
    const raster = Object.prototype.hasOwnProperty.call(sources, file) ? sources[file] : undefined;
    if (!raster) {
      diagnostics.push(
        err("asset/bad-option", `no image was given for source "${file}"`, {
          params: { option: "input", state: s },
        }),
      );
      continue;
    }
    const bad = checkRaster(raster, `the ${s} image`);
    if (bad) {
      diagnostics.push(bad);
      continue;
    }
    if (raster.width * raster.height > maxPixels) {
      diagnostics.push(
        err(
          "asset/too-large",
          `the ${s} image is ${raster.width}x${raster.height}, above the ${maxPixels} pixel limit`,
          {
            suggestion: "crop the figure (regions) or shrink it first",
            params: { width: raster.width, height: raster.height, limit: maxPixels },
          },
        ),
      );
      continue;
    }
    let image = raster;
    let origin: [number, number] = [0, 0];
    const region = manifest.regions?.[s];
    if (region) {
      const c = crop(raster, { x: region[0], y: region[1], w: region[2], h: region[3] });
      diagnostics.push(...c.diagnostics);
      if (!c.value) continue;
      image = c.value;
      origin = [Math.max(0, region[0]), Math.max(0, region[1])];
    }
    img[s] = analyzeState(s, image, origin, bgColour);
  }
  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  const base: FigureState = states.length === 1 ? states[0]! : (manifest.base ?? "assembled");
  let stateArea = 0;
  let maxSide = 0;
  for (const s of states) {
    stateArea += img[s]!.W * img[s]!.H;
    maxSide = Math.max(maxSide, img[s]!.W + img[s]!.H);
  }

  // Coordinates: manifest -> state image.
  const toLocal = (s: FigureState, p: Point, path: string): [number, number] | undefined => {
    const st = img[s]!;
    const x = p[0] - st.origin[0];
    const y = p[1] - st.origin[1];
    if (x < 0 || y < 0 || x >= st.W || y >= st.H) {
      diagnostics.push({
        ...err(
          "asset/bad-option",
          `point [${p[0]}, ${p[1]}] lies outside the ${s} drawing (${st.W}x${st.H})`,
          { params: { option: "manifest", state: s } },
        ),
        path,
      });
      return undefined;
    }
    return [x, y];
  };

  // ---- units and classes
  const groupOrder: string[] = [];
  const groupParts = new Map<string, number[]>();
  manifest.parts.forEach((p, i) => {
    const g = p.group ?? p.id;
    if (!groupParts.has(g)) {
      groupParts.set(g, []);
      groupOrder.push(g);
    }
    groupParts.get(g)!.push(i);
  });
  const classIds: string[] = [];
  const classOf = new Map<string, number>();
  const units: Unit[] = [];
  for (const g of groupOrder) {
    const idx = groupParts.get(g)!;
    const parts = idx.map((i) => manifest.parts[i]!);
    const inst = parts.find((p) => p.instanceOf !== undefined)?.instanceOf;
    const key = inst !== undefined ? `i:${inst}` : `u:${g}`;
    if (!classOf.has(key)) {
      classOf.set(key, classIds.length);
      classIds.push(inst ?? g);
    }
    const nearestHint: Partial<Record<FigureState, Point>> = {};
    const polygons: Partial<Record<FigureState, Point[][]>> = {};
    const seeds: Partial<Record<FigureState, Point[]>> = {};
    for (const s of states) {
      for (const i of idx) {
        const p = manifest.parts[i]!;
        for (const [k, q] of (p.seeds[s] ?? []).entries()) {
          const l = toLocal(s, q, `/parts/${i}/seeds/${s}/${k}`);
          if (l) (seeds[s] ??= []).push(l);
        }
        const n = p.nearest?.[s];
        if (n && nearestHint[s] === undefined) {
          const l = toLocal(s, n, `/parts/${i}/nearest/${s}`);
          if (l) nearestHint[s] = l;
        }
      }
      if (idx.every((i) => manifest.parts[i]!.polygon?.[s] !== undefined)) {
        const polys: Point[][] = [];
        for (const i of idx) {
          const pts: Point[] = [];
          for (const [k, q] of manifest.parts[i]!.polygon![s]!.entries()) {
            const l = toLocal(s, q, `/parts/${i}/polygon/${s}/${k}`);
            if (l) pts.push(l);
          }
          polys.push(pts);
        }
        polygons[s] = polys;
      }
    }
    const z = parts.find((p) => p.z !== undefined)?.z;
    // The group's prior: the first part's that names one (the group moves as one shape).
    const prior = parts.find((p) => p.prior !== undefined)?.prior ?? "none";
    units.push({
      index: units.length,
      id: g,
      partIds: parts.map((p) => p.id),
      cls: classOf.get(key)!,
      holes: parts.some((p) => p.holes === true),
      allowDisjoint: parts.some((p) => p.allowDisjoint === true),
      prior,
      ...(z !== undefined ? { z } : {}),
      nearest: nearestHint,
      polygons,
      seeds,
      dep: {},
      place: {},
    });
  }
  const seedsOf = (u: Unit, s: FigureState): readonly Point[] => u.seeds[s] ?? [];

  // ---- annotations: translate, budgets, first pass
  const annInputs: { index: number; points?: [number, number][]; rect?: Box }[] = [];
  let totalLength = 0;
  let maskArea = 0;
  (manifest.annotations ?? []).forEach((a, i) => {
    if (a.kind === "text") {
      const p = toLocal(a.state, [a.rect[0], a.rect[1]], `/annotations/${i}/rect`);
      if (!p) return;
      const st = img[a.state]!;
      if (a.rect[2] < 1 || a.rect[3] < 1 || p[0] + a.rect[2] > st.W || p[1] + a.rect[3] > st.H) {
        diagnostics.push({
          ...err(
            "asset/bad-option",
            `text rectangle ${i} must have a positive size inside the ${a.state} drawing`,
            { params: { option: "manifest", state: a.state } },
          ),
          path: `/annotations/${i}/rect`,
        });
        return;
      }
      maskArea += (a.rect[2] + 4) * (a.rect[3] + 4);
      annInputs.push({ index: i, rect: { x: p[0], y: p[1], w: a.rect[2], h: a.rect[3] } });
    } else {
      const pts: [number, number][] = [];
      a.polyline.forEach((q, k) => {
        const l = toLocal(a.state, q, `/annotations/${i}/polyline/${k}`);
        if (l) pts.push(l);
      });
      if (pts.length !== a.polyline.length) return;
      totalLength += polylineLength(pts);
      let mnx = Infinity;
      let mxx = -Infinity;
      let mny = Infinity;
      let mxy = -Infinity;
      for (const q of pts) {
        mnx = Math.min(mnx, q[0]);
        mxx = Math.max(mxx, q[0]);
        mny = Math.min(mny, q[1]);
        mxy = Math.max(mxy, q[1]);
      }
      // Each mask is allocated over the polyline's bbox plus the widest possible band.
      maskArea += (mxx - mnx + 80) * (mxy - mny + 80);
      annInputs.push({ index: i, points: pts });
    }
  });
  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  if (totalLength > 32 * maxSide) {
    return {
      diagnostics: [
        ...diagnostics,
        tooExpensive(
          "the annotation polylines are too long in total",
          totalLength,
          32 * maxSide,
          "declare each arrow or leader by its ends and corners only",
        ),
      ],
    };
  }
  if (maskArea > 4 * stateArea + 1_000_000) {
    return {
      diagnostics: [
        ...diagnostics,
        tooExpensive(
          "the annotation masks would cover the drawings too many times",
          maskArea,
          4 * stateArea + 1_000_000,
          "declare arrows and leaders by their ends, and text rectangles around the text only",
        ),
      ],
    };
  }
  const annotations: AnnotationGeometry[] = annInputs.map((ai) => {
    const a = manifest.annotations![ai.index]!;
    const st = img[a.state]!;
    return measureAnnotation(
      {
        index: ai.index,
        annotation: a,
        ...(ai.points ? { points: ai.points } : {}),
        ...(ai.rect ? { rect: ai.rect } : {}),
      },
      st.rawInk,
      st.W,
      st.H,
      st.ink,
    );
  });

  // ---- seeded regions
  const seededR = new Map<string, Mask>();
  for (const u of units) {
    for (const s of states) {
      const seeds = seedsOf(u, s);
      if (seeds.length === 0) continue;
      const st = img[s]!;
      const ids = new Set<number>();
      for (const [x, y] of seeds) {
        const sn = snapSeed(st, x, y);
        if (!sn) {
          diagnostics.push(
            err(
              "asset/not-found",
              `a seed of ${u.id} at [${x}, ${y}] is on ink with no paper within 3 px`,
              { params: { part: u.id, state: s, seed: [x, y] } },
            ),
          );
          continue;
        }
        const id = st.regions.labels[sn[1] * st.W + sn[0]]!;
        const o = (id - 1) * 4;
        const bx = st.regions.bboxes[o]!;
        const by = st.regions.bboxes[o + 1]!;
        const bw = st.regions.bboxes[o + 2]!;
        const bh = st.regions.bboxes[o + 3]!;
        if (bx === 0 || by === 0 || bx + bw === st.W || by + bh === st.H) {
          diagnostics.push(
            err(
              "asset/not-found",
              `a seed of ${u.id} at [${x}, ${y}] lies on the background, not inside a part`,
              { params: { part: u.id, state: s, seed: [x, y] } },
            ),
          );
          continue;
        }
        ids.add(id);
      }
      // Regions containing another unit's seeds are excluded.
      for (const w of units) {
        if (w === u) continue;
        for (const [x, y] of seedsOf(w, s)) {
          const sn = snapSeed(st, x, y);
          if (sn) ids.delete(st.regions.labels[sn[1] * st.W + sn[0]]!);
        }
      }
      if (ids.size === 0) {
        diagnostics.push(
          err("asset/not-found", `no region of ${u.id} was found in the ${s} drawing`, {
            params: { part: u.id, state: s },
          }),
        );
        continue;
      }
      seededR.set(
        `${u.index}:${s}`,
        union(...[...ids].sort((a, b) => a - b).map((id) => regionMask(st, id))),
      );
    }
  }
  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };

  // Up-front cost check: per-unit window work around the seeded regions, times the annotations.
  {
    let cost = 0;
    for (const [key, R] of seededR) {
      const s = key.split(":")[1] as FigureState;
      const st = img[s]!;
      const D = Math.max(6, 4 * st.stroke);
      const r = Math.ceil(1.5 * st.stroke) + 2;
      const nAnn = annotations.filter((g) => g.state === s).length;
      // Every nearby part (seeded regions within the window) is a rival in the bounding-ink and
      // stand-alone passes over the same window.
      let near = 0;
      for (const [k2, R2] of seededR) {
        if (k2 === key || k2.split(":")[1] !== s) continue;
        if (
          R2.x < R.x + R.w + 2 * D &&
          R2.x + R2.w > R.x - 2 * D &&
          R2.y < R.y + R.h + 2 * D &&
          R2.y + R2.h > R.y - 2 * D
        )
          near++;
      }
      cost += (R.w + 2 * D) * (R.h + 2 * D) * (1 + nAnn) * (1 + near) + count(R) * (2 * r + 1) ** 2;
    }
    const limit = 128 * stateArea + 8_000_000;
    if (cost > limit) {
      return {
        diagnostics: [
          ...diagnostics,
          tooExpensive(
            "the parts and annotations need too much work",
            cost,
            limit,
            "crop the figure (regions), or declare fewer parts or annotations",
          ),
        ],
      };
    }
  }

  // ---- bounding ink, preliminary masks and shape priors
  for (const u of units) {
    for (const s of states) {
      const R = seededR.get(`${u.index}:${s}`);
      if (!R) continue;
      const st = img[s]!;
      const rivals = units
        .filter((w) => w !== u && seededR.has(`${w.index}:${s}`))
        .map((w) => ({ R: seededR.get(`${w.index}:${s}`)! }));
      const B = boundingInk(st, R, rivals);
      const M0 = u.holes ? union(R, B) : fillHoles(union(R, B));
      // Stub bound: bounding ink that an opening of half a stroke removes is a protrusion
      // narrower than a stroke (a touching trace's end), not the part's outline.
      const rad = Math.max(1, Math.ceil(st.stroke / 2));
      const opened = dilate(erode(M0, rad), rad, st.W, st.H);
      const M1 = filter(M0, (x, y) => has(opened, x, y) || has(R, x, y) || !has(B, x, y));
      const P0 = peel(st, M1, R);
      const prior = fitPrior(P0, u.prior);
      let P = P0;
      const bound = polygonBound(u.polygons[s], st.W, st.H);
      if (bound) P = intersect(P, bound);
      if (prior !== EMPTY) P = intersect(P, dilate(prior, st.stroke + 1, st.W, st.H));
      (u.dep as Record<FigureState, Depiction>)[s] = {
        state: s,
        seeds: seedsOf(u, s),
        R,
        B,
        P,
        prior,
        contact: EMPTY,
        standalone: false,
        V: P,
      };
    }
  }

  // ---- alignment between the states (shared budget)
  const d: Partial<Record<FigureState, readonly [number, number]>> = { [base]: [0, 0] as const };
  let alignment: Analysis["alignment"];
  if (states.length === 2) {
    const a = img[base]!;
    const b = img[other(base)]!;
    const ex = new Uint8Array(a.W * a.H);
    const mark = (m: Mask): void => {
      for (let j = 0; j < m.h; j++)
        for (let i = 0; i < m.w; i++) if (m.data[j * m.w + i]) ex[(j + m.y) * a.W + i + m.x] = 1;
    };
    for (const u of units) if (u.dep[base]) mark(dilate(u.dep[base]!.P, 6, a.W, a.H));
    for (const g of annotations) if (g.state === base) mark(g.mask);
    // Align on the static drawing: a patch around the base's ink that no moving part or
    // annotation covers (at most 160 px a side); the default patch consensus is the fallback.
    let sx0 = a.W;
    let sy0 = a.H;
    let sx1 = -1;
    let sy1 = -1;
    for (let y = 0; y < a.H; y++) {
      for (let x = 0; x < a.W; x++) {
        if (!a.ink[y * a.W + x] || ex[y * a.W + x]) continue;
        if (x < sx0) sx0 = x;
        if (x > sx1) sx1 = x;
        if (y < sy0) sy0 = y;
        sy1 = y;
      }
    }
    let al: ReturnType<typeof align> | undefined;
    if (sx1 >= 0) {
      const w = Math.min(160, sx1 - sx0 + 1);
      const h = Math.min(160, sy1 - sy0 + 1);
      const patch = {
        x: Math.round((sx0 + sx1 + 1 - w) / 2),
        y: Math.round((sy0 + sy1 + 1 - h) / 2),
        w,
        h,
      };
      if (w >= 8 && h >= 8) {
        const tryPatch = align(a.image, b.image, {
          exclude: ex,
          patch,
          maxMultiplyAdds: budget.left,
        });
        if (tryPatch.value) budget.left -= tryPatch.value.multiplyAdds;
        if (tryPatch.value && tryPatch.value.score >= 0.9) al = tryPatch;
      }
    }
    if (!al) {
      if (budget.left <= 0) {
        return {
          diagnostics: [
            ...diagnostics,
            err(
              "asset/too-expensive",
              "the matcher budget was used up before the drawings were aligned",
              {
                suggestion: "crop the figure (regions) or raise maxMultiplyAdds",
                params: { limit: options.maxMultiplyAdds ?? MAX_MULTIPLY_ADDS },
              },
            ),
          ],
        };
      }
      al = align(a.image, b.image, { exclude: ex, maxMultiplyAdds: budget.left });
      if (al.value) budget.left -= al.value.multiplyAdds;
    }
    diagnostics.push(...al.diagnostics);
    if (!al.value) return { diagnostics };
    alignment = {
      dx: al.value.dx,
      dy: al.value.dy,
      score: al.value.score,
      support: al.value.support,
    };
    d[other(base)] = [al.value.dx, al.value.dy];
  }
  const shiftTo = (from: FigureState, to: FigureState): [number, number] => [
    d[to]![0] - d[from]![0],
    d[to]![1] - d[from]![1],
  ];

  // ---- the static drawing: ink also present, at the aligned place, in the other drawing, away
  // from every seeded part in both (boards, sockets, traces). Used to measure arrowheads.
  const near: Partial<Record<FigureState, Mask>> = {};
  for (const s of states) {
    const st = img[s]!;
    const ms = units.filter((u) => u.dep[s]).map((u) => dilate(u.dep[s]!.P, 1, st.W, st.H));
    near[s] = ms.length > 0 ? union(...ms) : EMPTY;
  }
  const isStatic: Partial<Record<FigureState, (x: number, y: number) => boolean>> = {};
  if (states.length === 2) {
    for (const s of states) {
      const o = other(s);
      const st = img[s]!;
      const so = img[o]!;
      const [dx, dy] = shiftTo(s, o);
      const nearO = units.filter((u) => u.dep[o]).map((u) => dilate(u.dep[o]!.P, 2, so.W, so.H));
      isStatic[s] = (x, y) => {
        const qx = x + dx;
        const qy = y + dy;
        if (qx < 0 || qy < 0 || qx >= so.W || qy >= so.H) return false;
        if (!st.rawInk[y * st.W + x] || !so.rawInk[qy * so.W + qx]) return false;
        return !nearO.some((m) => has(m, qx, qy));
      };
    }
  }

  // ---- the units' own ink without annotation bands (contacts are found against it)
  for (const s of states) {
    const st = img[s]!;
    const scratch = new Uint8Array(st.W * st.H);
    // Bands are barriers, except within a band width of the polyline's ends (where it meets
    // the part, the part's outline runs through the band).
    const polys = annotations.filter((g) => g.state === s && g.kind !== "text");
    const endDisks = polys
      .map((g) => capsules([g.points[0]!], g.halfWidth + 2, st.W, st.H))
      .concat(
        polys.map((g) => capsules([g.points[g.points.length - 1]!], g.halfWidth + 2, st.W, st.H)),
      );
    const inBand = (x: number, y: number): boolean =>
      polys.some((g) => has(g.band, x, y)) && !endDisks.some((m) => has(m, x, y));
    for (const u of units) {
      const dp = u.dep[s];
      if (!dp) continue;
      const hullP = count(convexHull(dp.P));
      const c = flood(st.rawInk, st.W, st.H, dp.B, 4 * hullP + 64, scratch, inBand);
      (u.dep as Record<FigureState, Depiction>)[s] = {
        ...dp,
        contact: c ?? inkMask(st.ink, st.W, dp.P),
      };
    }
  }

  // ---- contact allowances (rule 2): a w x w square (plus the closing's 1 px) centred where an
  // end or a crossing meets a part, at most 2 per polyline and 8 per part and state; these are
  // the only squares cut from the ink and the only exemptions.
  const exempt = new Map<string, Box[]>();
  const quota = new Map<string, number>();
  const contactEnds = new Map<number, [boolean, boolean]>();
  for (const g of annotations) {
    if (g.kind === "text") continue;
    const ink = (u: Unit): Mask => u.dep[g.state]?.contact ?? EMPTY;
    const owners = (x: number, y: number): Unit[] =>
      units.filter((u) => {
        const c = ink(u);
        return c.w > 0 && nearest(c, x, y, 1) !== undefined;
      });
    const r = Math.ceil(g.halfWidth) + 1;
    const found: { x: number; y: number; end?: 0 | 1 }[] = [];
    const ends = [g.points[0]!, g.points[g.points.length - 1]!] as const;
    const endsTouch: [boolean, boolean] = [false, false];
    ends.forEach(([ex, ey], e) => {
      let best: { x: number; y: number; d2: number } | undefined;
      for (const u of units) {
        const c = ink(u);
        if (c.w === 0) continue;
        const n = nearest(c, Math.round(ex), Math.round(ey), r);
        if (
          n &&
          (!best ||
            n.d2 < best.d2 ||
            (n.d2 === best.d2 && (n.y < best.y || (n.y === best.y && n.x < best.x))))
        )
          best = n;
      }
      if (best) {
        found.push({ x: best.x, y: best.y, end: e as 0 | 1 });
        endsTouch[e] = true;
      }
    });
    contactEnds.set(g.index, endsTouch);
    // Crossings: the centre line entering a part's ink away from the ends.
    const total = g.samples[g.samples.length - 1]?.s ?? 0;
    let prev = false;
    for (const smp of g.samples) {
      const x = Math.round(smp.x);
      const y = Math.round(smp.y);
      const on = smp.s > g.width && total - smp.s > g.width && units.some((u) => has(ink(u), x, y));
      if (on && !prev) found.push({ x, y });
      prev = on;
    }
    const side = g.width + 2;
    const half = Math.floor(side / 2);
    for (const c of found.slice(0, 2)) {
      const box: Box = { x: c.x - half, y: c.y - half, w: side, h: side };
      let cut = false;
      for (const u of owners(c.x, c.y)) {
        const key = `${u.index}:${g.state}`;
        const n = quota.get(key) ?? 0;
        if (n >= 8) continue;
        quota.set(key, n + 1);
        const k = `${g.index}:${u.index}`;
        exempt.set(k, [...(exempt.get(k) ?? []), box]);
        cut = true;
      }
      if (cut) g.allowances.push(box);
    }
  }

  // ---- arrowheads: the wedge's own ink (part outlines and the static drawing excluded)
  for (const g of annotations) {
    if (g.kind !== "arrow") continue;
    const st = img[g.state]!;
    const nearS = near[g.state]!;
    const stat = isStatic[g.state];
    detectHead(g, st.rawInk, st.W, st.H, (x, y) => has(nearS, x, y) || (stat ? stat(x, y) : false));
  }

  // ---- allowance cut (part ink runs on raw ink with the squares cut), stand-alone test and
  // whole ink. Whole ink is never cut: it floods raw ink with every polyline band as a barrier
  // except inside the allowance squares, so a square at a fin's root cannot sever the fin.
  const cutInk: Partial<Record<FigureState, Uint8Array>> = {};
  for (const s of states) {
    const st = img[s]!;
    const raw = new Uint8Array(st.rawInk);
    for (const g of annotations) {
      if (g.state !== s) continue;
      for (const b of g.allowances) {
        const c = clipBox(b, st.W, st.H);
        for (let y = c.y; y < c.y + c.h; y++)
          for (let x = c.x; x < c.x + c.w; x++) raw[y * st.W + x] = 0;
      }
    }
    cutInk[s] = raw;
  }
  for (const s of states) {
    const st = img[s]!;
    const scratch = new Uint8Array(st.W * st.H);
    const squares = annotations.filter((g) => g.state === s).flatMap((g) => g.allowances);
    const polys = annotations.filter((g) => g.state === s && g.kind !== "text");
    const barrier = (x: number, y: number): boolean =>
      polys.some((g) => has(g.band, x, y)) && !squares.some((b) => inBox(b, x, y));
    // Per square: the opening radius that removes the polyline's own stub (half its stroke).
    const squareR = annotations
      .filter((g) => g.state === s)
      .flatMap((g) =>
        g.allowances.map((b) => ({ b, g, r: Math.max(1, Math.ceil(g.medianRun / 2)) })),
      );
    const D = Math.max(6, 4 * st.stroke);
    for (const u of units) {
      const dp = u.dep[s];
      if (!dp) continue;
      const others = units.filter((w) => w !== u && w.dep[s]).map((w) => w.dep[s]!.P);
      const bound = polygonBound(u.polygons[s], st.W, st.H);
      const finish = (M1: Mask): Mask => {
        // Filled from closed ink: a 1 px break in an outline (a scan) is bridged by the closing,
        // so the face behind it stays enclosed; the peel then opens only closing-only pixels.
        const M0 = union(
          M1,
          filter(
            dilate(M1, 1, st.W, st.H),
            (x, y) => st.ink[y * st.W + x] !== 0 && st.rawInk[y * st.W + x] === 0,
          ),
        );
        let M = u.holes
          ? union(M0, intersect(fillHoles(M0), inkMask(st.ink, st.W, fillHoles(M0))))
          : fillHoles(M0);
        // Inside each allowance square the polyline's own stub joined the part: an opening of
        // half its stroke removes it there, but only on the polyline's own band (a thin part
        // feature at the contact, a fin's root, stays).
        for (const { b, g, r: rad } of squareR) {
          if (!overlaps(boxMask(b, st.W, st.H), M)) continue;
          const opened = dilate(erode(M, rad), rad, st.W, st.H);
          M = filter(M, (x, y) => has(opened, x, y) || !inBox(b, x, y) || !has(g.band, x, y));
        }
        M = peel(st, M, dp.R);
        if (bound) M = intersect(M, bound);
        return tight(M);
      };
      const nearP = dilate(dp.P, 4, st.W, st.H);
      const alone = !others.some((p) => overlaps(nearP, p));
      const hullP = count(convexHull(dp.P));
      const W0 = alone
        ? flood(st.rawInk, st.W, st.H, dp.B, 4 * hullP + 64, scratch, barrier)
        : undefined;
      // Stand-alone: the whole ink reaches no other part and stays inside the polygon when one
      // is given, and it is not the static drawing. With two drawings, ink of the whole ink
      // beyond the seeded mask that the other drawing also shows at the aligned place (a cage, a
      // bracket, a board) is static: more than a quarter of it (beyond D) means the part touches
      // static ink and is not alone. With one drawing there is no such evidence: the part stands
      // alone only where a polygon or a declared prior bounds its whole ink (a frame around it,
      // even one only 1.5x its size, is then outside); otherwise it keeps P (hull-uncertain).
      let standalone = false;
      if (W0 && !others.some((p) => overlaps(dilate(W0, 4, st.W, st.H), p))) {
        const extra = minus(W0, dilate(dp.P, D, st.W, st.H));
        const stat = isStatic[s];
        if (stat) {
          const n = count(extra);
          let k = 0;
          for (let j = 0; j < extra.h; j++)
            for (let i = 0; i < extra.w; i++)
              if (extra.data[j * extra.w + i] && stat(i + extra.x, j + extra.y)) k++;
          standalone = k <= STANDALONE_STATIC * n + 4 * st.stroke;
        } else {
          const lim =
            bound ?? (dp.prior !== EMPTY ? dilate(dp.prior, st.stroke + 1, st.W, st.H) : undefined);
          standalone = lim !== undefined && isEmpty(minus(W0, lim));
        }
        if (bound && !isEmpty(minus(W0, bound))) standalone = false;
      }
      if (standalone) {
        (u.dep as Record<FigureState, Depiction>)[s] = {
          ...dp,
          W: W0!,
          standalone: true,
          V: finish(union(dp.R, dp.B, W0!)),
        };
      } else if (bound) {
        // Not alone, but a rough polygon bounds it: its ink inside the polygon is its own,
        // except strokes that run on through the polygon's border (a trace passing by).
        const Wp = boundedInk(st, dp.B, bound);
        (u.dep as Record<FigureState, Depiction>)[s] = { ...dp, V: finish(union(dp.R, dp.B, Wp)) };
      }
    }
  }

  // ---- templates (§6.3): fewest occluded pixels, then stand-alone, then consistency across
  // the depictions (mean IoU, centres aligned), then exploded first, then manifest order.
  const dilatedV = new Map<string, Mask>();
  for (const w of units)
    for (const s of states)
      if (w.dep[s]) dilatedV.set(`${w.index}:${s}`, dilate(w.dep[s]!.V, 1, img[s]!.W, img[s]!.H));
  const occludedOf = (u: Unit, s: FigureState): number => {
    const dp = u.dep[s]!;
    const shape = dp.prior !== EMPTY ? dp.prior : convexHull(dp.V);
    const others = units
      .filter((w) => w !== u && w.dep[s])
      .map((w) => dilatedV.get(`${w.index}:${s}`)!);
    let n = 0;
    for (let j = 0; j < shape.h; j++) {
      for (let i = 0; i < shape.w; i++) {
        if (!shape.data[j * shape.w + i]) continue;
        const x = i + shape.x;
        const y = j + shape.y;
        if (!has(dp.V, x, y) && others.some((m) => has(m, x, y))) n++;
      }
    }
    return n;
  };
  const iouCentred = (a: Mask, b: Mask): number => {
    const ba = bounds(a);
    const bb = bounds(b);
    if (!ba || !bb) return 0;
    const dx = Math.round(ba.x + ba.w / 2 - (bb.x + bb.w / 2));
    const dy = Math.round(ba.y + ba.h / 2 - (bb.y + bb.h / 2));
    const m = shifted(b, dx, dy);
    const ov = overlapCount(a, m);
    return ov / (count(a) + count(m) - ov || 1);
  };
  const classes: TemplateClass[] = classIds.map((id, ci) => {
    const members = units.filter((u) => u.cls === ci);
    const cands: { u: Unit; s: FigureState; occ: number; alone: number; cons: number }[] = [];
    for (const u of members) {
      for (const s of STATES) {
        if (!u.dep[s]) continue;
        cands.push({ u, s, occ: occludedOf(u, s), alone: u.dep[s]!.standalone ? 0 : 1, cons: 0 });
      }
    }
    for (const c of cands) {
      const others = cands.filter((o) => o !== c);
      c.cons =
        others.length > 0
          ? Math.round(
              (others.reduce((t, o) => t + iouCentred(c.u.dep[c.s]!.V, o.u.dep[o.s]!.V), 0) /
                others.length) *
                1000,
            )
          : 1000;
    }
    cands.sort(compareTemplates);
    const t = cands[0]!;
    const mask = tight(t.u.dep[t.s]!.V);
    if (mask.w === 0) {
      diagnostics.push(
        err("asset/empty", `the mask of ${t.u.id} is empty (check its polygon against its seeds)`, {
          params: { part: t.u.id, state: t.s },
        }),
      );
    }
    return {
      index: ci,
      id,
      units: members.map((u) => u.index),
      unit: t.u.index,
      state: t.s,
      mask,
      sprite: colours(img[t.s]!.image, mask),
      unrecovered: EMPTY,
      recovered: EMPTY,
    };
  });
  if (diagnostics.some((x) => x.severity === "error")) return { diagnostics };

  // ---- placements (locate, one luminance plane per state, the shared budget)
  for (const c of classes) {
    for (const s of states) {
      const st = img[s]!;
      const members = c.units.map((i) => units[i]!);
      const need = members.filter((u) => !(u.index === c.unit && s === c.state));
      if (s === c.state) place(units[c.unit]!, s, c.mask.x, c.mask.y, 1, c.mask);
      if (need.length === 0) continue;
      let region: Box = { x: 0, y: 0, w: 0, h: 0 };
      for (const u of members) {
        const dp = u.dep[s];
        if (dp) region = region.w === 0 ? dp.P : boxUnion(region, dp.P);
      }
      region =
        region.w === 0
          ? { x: 0, y: 0, w: st.W, h: st.H }
          : clipBox(
              {
                x: region.x - c.mask.w,
                y: region.y - c.mask.h,
                w: region.w + 2 * c.mask.w,
                h: region.h + 2 * c.mask.h,
              },
              st.W,
              st.H,
            );
      if (budget.left <= 0) {
        return {
          diagnostics: [
            ...diagnostics,
            err(
              "asset/too-expensive",
              "the matcher budget was used up before every part was located",
              {
                suggestion: "crop the figure (regions) or raise maxMultiplyAdds",
                params: { limit: options.maxMultiplyAdds ?? MAX_MULTIPLY_ADDS },
              },
            ),
          ],
        };
      }
      const found = locate(st.image, c.sprite, {
        region,
        top: Math.min(64, 2 * members.length + 2),
        scales: [1],
        nmsIoU: 0.8,
        minScore: 0.5,
        maxMultiplyAdds: budget.left,
        plane: st.plane,
      });
      if (found.value) budget.left -= found.value.multiplyAdds;
      diagnostics.push(
        ...found.diagnostics.filter((x) => x.severity === "error" && x.code !== "asset/not-found"),
      );
      if (found.diagnostics.some((x) => x.code === "asset/too-expensive")) return { diagnostics };
      const peaks = (found.value?.matches ?? []).filter(
        (m) => !(s === c.state && Math.abs(m.x - c.mask.x) <= 2 && Math.abs(m.y - c.mask.y) <= 2),
      );
      // Assignment: seeds inside the placed silhouette first, then overlap with the seeded
      // mask, then the nearest hint, then the score.
      const pairs: { u: Unit; k: number; cost: number[] }[] = [];
      for (const u of need) {
        const dp = u.dep[s];
        peaks.forEach((m, k) => {
          const E = shifted(c.mask, m.x - c.mask.x, m.y - c.mask.y);
          const Ed = dilate(E, 1, st.W, st.H);
          const miss = dp ? dp.seeds.filter(([x, y]) => !has(Ed, x, y)).length : 0;
          const ov = dp ? overlapCount(E, dp.P) : 0;
          const n = u.nearest[s];
          const dist = n ? Math.hypot(m.x + c.mask.w / 2 - n[0], m.y + c.mask.h / 2 - n[1]) : 0;
          pairs.push({ u, k, cost: [miss, -ov, Math.round(dist), -m.score, k] });
        });
      }
      pairs.sort((a, b) => {
        for (let i = 0; i < a.cost.length; i++)
          if (a.cost[i] !== b.cost[i]) return a.cost[i]! - b.cost[i]!;
        return a.u.index - b.u.index;
      });
      const usedU = new Set<number>();
      const usedK = new Set<number>();
      for (const p of pairs) {
        if (usedU.has(p.u.index) || usedK.has(p.k)) continue;
        const dp = p.u.dep[s];
        // A unit with seeds here must get a peak that contains at least one of them.
        if (dp && p.cost[0] === dp.seeds.length) continue;
        usedU.add(p.u.index);
        usedK.add(p.k);
        const m = peaks[p.k]!;
        place(p.u, s, m.x, m.y, m.score, shifted(c.mask, m.x - c.mask.x, m.y - c.mask.y));
      }
      for (const u of need) {
        if (!usedU.has(u.index)) {
          diagnostics.push(
            err("asset/not-found", `${u.id} could not be located in the ${s} drawing`, {
              suggestion:
                "check its seeds, or that the drawings show the same part at the same scale",
              params: { part: u.id, state: s },
            }),
          );
        }
      }
    }
  }
  if (diagnostics.some((x) => x.severity === "error")) return { diagnostics };

  // ---- front relations and visible masks (bounded work, paid for up front)
  {
    let cost = 0;
    for (const s of states) {
      for (const u of units) {
        for (const w of units) {
          if (w.index <= u.index) continue;
          const a = u.place[s]!.E;
          const b = w.place[s]!.E;
          const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ow > 0 && oh > 0) cost += 2 * ow * oh + a.w * a.h + b.w * b.h;
        }
      }
    }
    const limit = 32 * stateArea + 1_000_000;
    if (cost > limit) {
      return {
        diagnostics: [
          ...diagnostics,
          tooExpensive(
            "the parts overlap too much to separate",
            cost,
            limit,
            "crop the figure (regions) or split it into fewer, smaller parts",
          ),
        ],
      };
    }
  }
  const front: Partial<Record<FigureState, Set<string>>> = {};
  const computeVisible = (): void => {
    for (const s of states) {
      const st = img[s]!;
      const rel = new Set<string>();
      for (const u of units) {
        for (const w of units) {
          if (w.index <= u.index) continue;
          const pu = u.place[s]!;
          const pw = w.place[s]!;
          const ov = intersect(pu.E, pw.E);
          if (isEmpty(ov)) continue;
          const su = classes[u.cls]!;
          const sw = classes[w.cls]!;
          let cu = 0;
          let cw = 0;
          for (let j = 0; j < ov.h; j++) {
            for (let i = 0; i < ov.w; i++) {
              if (!ov.data[j * ov.w + i]) continue;
              const x = i + ov.x;
              const y = j + ov.y;
              const src = st.lum[y * st.W + x]!;
              const mu = Math.abs(src - spriteLum(su.sprite, x - pu.x, y - pu.y)) <= 48;
              const mw = Math.abs(src - spriteLum(sw.sprite, x - pw.x, y - pw.y)) <= 48;
              if (mu && !mw) cu++;
              if (mw && !mu) cw++;
            }
          }
          let uFront: boolean;
          if (cu !== cw) uFront = cu > cw;
          else {
            const bu = pu.y + pu.E.h;
            const bw = pw.y + pw.E.h;
            uFront = bu !== bw ? bu > bw : false;
          }
          rel.add(uFront ? `${u.index}>${w.index}` : `${w.index}>${u.index}`);
        }
      }
      front[s] = rel;
      for (const u of units) {
        const p = u.place[s]!;
        let vis = p.E;
        for (const w of units)
          if (w !== u && rel.has(`${w.index}>${u.index}`)) vis = minus(vis, w.place[s]!.E);
        p.visible = vis;
      }
    }
  };
  computeVisible();

  // ---- occlusion recovery (§6.3): template pixels hidden by a unit in front are taken from
  // another depiction's OWN segmentation (its V, mapped by its placement) where that depiction
  // shows them. What no depiction shows is recorded as unrecovered (expected from the prior).
  let recovered = false;
  for (const c of classes) {
    const tu = units[c.unit]!;
    const tp = tu.place[c.state]!;
    const st = img[c.state]!;
    const fronts = units.filter((w) => w !== tu && front[c.state]!.has(`${w.index}>${tu.index}`));
    const covered = (x: number, y: number): boolean =>
      fronts.some((w) => has(w.place[c.state]!.E, x, y));
    // The template's own pixels under a unit in front belong to that unit (its outline drawn
    // over this one): they leave the template and are recovered like any hidden pixel.
    const kept = filter(c.mask, (x, y) => !covered(x, y));
    const claimed = (x: number, y: number): boolean =>
      units.some((w) => w !== tu && w.dep[c.state] !== undefined && has(w.dep[c.state]!.V, x, y));
    const agrees = (x: number, y: number, im: Raster, sx: number, sy: number): boolean => {
      if (sx < 0 || sy < 0 || sx >= im.width || sy >= im.height) return false;
      const a1 = st.lum[y * st.W + x]!;
      const q = (sy * im.width + sx) * 4;
      const a2 = Math.round(
        0.299 * im.data[q]! + 0.587 * im.data[q + 1]! + 0.114 * im.data[q + 2]!,
      );
      return Math.abs(a1 - a2) <= 48;
    };
    let add: Mask = EMPTY;
    const sources: { m: Mask; s: FigureState; dx: number; dy: number }[] = [];
    for (const ui of c.units) {
      const u = units[ui]!;
      for (const s of states) {
        const dp = u.dep[s];
        if (!dp || (u === tu && s === c.state)) continue;
        const p = u.place[s]!;
        // Pixels this depiction's own segmentation shows, that the template lacks, and that a
        // unit in front covers in the template's drawing.
        const fronts2 = units.filter((w) => w !== u && front[s]!.has(`${w.index}>${u.index}`));
        const own = filter(dp.V, (x, y) => !fronts2.some((w) => has(w.place[s]!.E, x, y)));
        const back = shifted(own, tp.x - p.x, tp.y - p.y);
        // Hidden in the template's drawing (covered in front), or shown there too (the drawings
        // agree) and claimed by no other unit: what segmentation dropped in one drawing (a corner
        // tip running into a touching stroke) may come back from the other (see below).
        const im = img[s]!.image;
        const cand = filter(
          minus(back, kept),
          (x, y) =>
            covered(x, y) || (!claimed(x, y) && agrees(x, y, im, x + p.x - tp.x, y + p.y - tp.y)),
        );
        const fresh = minus(cand, add);
        if (isEmpty(fresh)) continue;
        add = union(add, fresh);
        sources.push({ m: fresh, s, dx: p.x - tp.x, dy: p.y - tp.y });
      }
    }
    // A pixel the template's drawing shows (not hidden) comes back only where both depictions
    // agree: the other's segmentation claims it, and the template's drawing shows it as this
    // part's. Ink must be raw ink there, 8-connected to the kept mask; paper must be enclosed by
    // that ink. A face another depiction filled (an outline only it closes) stays out.
    {
      const hiddenAdd = filter(add, covered);
      const viaAgree = minus(add, hiddenAdd);
      if (!isEmpty(viaAgree)) {
        const base0 = union(kept, hiddenAdd);
        const inkA = filter(viaAgree, (x, y) => st.rawInk[y * st.W + x] !== 0);
        const conn = geodesic(st.rawInk, st.W, dilate(base0, 1, st.W, st.H), inkA);
        const enclosed = fillHoles(union(base0, conn));
        const ok = filter(
          viaAgree,
          (x, y) => has(conn, x, y) || (st.rawInk[y * st.W + x] === 0 && has(enclosed, x, y)),
        );
        add = union(hiddenAdd, ok);
        for (let k = 0; k < sources.length; k++)
          sources[k] = { ...sources[k]!, m: intersect(sources[k]!.m, add) };
      }
    }
    // Hidden and shown nowhere: the prior (or the hull) of the template, covered in front.
    const shape = tu.dep[c.state]!.prior !== EMPTY ? tu.dep[c.state]!.prior : convexHull(c.mask);
    // Pixels enclosed by the recovered silhouette that no depiction showed (a shared outline
    // that is behind a part in both drawings) are filled, and recorded as unrecovered.
    const joined = union(kept, add);
    const full = u0holes(units, c) ? joined : fillHoles(joined);
    const filledIn = minus(full, joined);
    c.unrecovered = tight(union(filter(minus(shape, full), covered), filledIn));
    c.recovered = tight(add);
    if (isEmpty(add) && count(kept) === count(c.mask)) continue;
    const mask = tight(full);
    const sprite = colours(st.image, mask);
    for (const src of sources) {
      const im = img[src.s]!.image;
      for (let j = 0; j < src.m.h; j++) {
        for (let i = 0; i < src.m.w; i++) {
          if (!src.m.data[j * src.m.w + i]) continue;
          const x = i + src.m.x;
          const y = j + src.m.y;
          const sx = x + src.dx;
          const sy = y + src.dy;
          if (sx < 0 || sy < 0 || sx >= im.width || sy >= im.height) continue;
          if (x < mask.x || y < mask.y || x >= mask.x + mask.w || y >= mask.y + mask.h) continue;
          const o = ((y - mask.y) * mask.w + x - mask.x) * 4;
          const q = (sy * im.width + sx) * 4;
          sprite.data[o] = im.data[q]!;
          sprite.data[o + 1] = im.data[q + 1]!;
          sprite.data[o + 2] = im.data[q + 2]!;
          sprite.data[o + 3] = 255;
        }
      }
    }
    const ox = mask.x - c.mask.x;
    const oy = mask.y - c.mask.y;
    c.mask = mask;
    c.sprite = sprite;
    for (const ui of c.units) {
      const u = units[ui]!;
      for (const s of states) {
        const p = u.place[s]!;
        const nx = p.x + ox;
        const ny = p.y + oy;
        (u.place as Record<FigureState, Placement>)[s] = {
          ...p,
          x: nx,
          y: ny,
          E: shifted(mask, nx - mask.x, ny - mask.y),
        };
      }
    }
    recovered = true;
  }
  if (recovered) computeVisible();

  // ---- hulls (whole ink where alone, mapped; plus the shape prior) and geodesic part ink
  for (const u of units) {
    const S0 = (["exploded", "assembled"] as const).find((s) => u.dep[s]?.standalone);
    u.standaloneState = S0;
    let H0: Mask | undefined;
    if (S0) H0 = convexHull(union(u.place[S0]!.E, u.dep[S0]!.W!));
    else {
      diagnostics.push(
        warning(
          "asset/hull-uncertain",
          `${u.id} stands alone in no state, so its hull comes from its mask and prior only`,
          { part: u.id },
        ),
      );
    }
    const tpl = classes[u.cls]!;
    const tplPrior = units[tpl.unit]!.dep[tpl.state]!.prior;
    for (const s of states) {
      const st = img[s]!;
      const p = u.place[s]!;
      const mapped =
        H0 && S0
          ? clipMask(shifted(H0, p.x - u.place[S0]!.x, p.y - u.place[S0]!.y), st.W, st.H)
          : EMPTY;
      const tp = units[tpl.unit]!.place[tpl.state]!;
      const prior =
        u.dep[s]?.prior ??
        (tplPrior !== EMPTY
          ? clipMask(shifted(tplPrior, p.x - tp.x, p.y - tp.y), st.W, st.H)
          : EMPTY);
      p.core = convexHull(union(mapped, p.E, prior));
      p.hull = dilate(p.core, 2, st.W, st.H);
      p.partInk = geodesic(
        cutInk[s]!,
        st.W,
        inkMask(cutInk[s]!, st.W, clipMask(p.visible, st.W, st.H)),
        p.hull,
      );
    }
  }

  // ---- template sprites: non-part annotation ink inside a template (§6.4 applied to sprites) is
  // replaced from another depiction's own segmentation where it is not annotated; what no other
  // depiction shows becomes background and is recorded as unrecovered.
  for (const c of classes) {
    const tu = units[c.unit]!;
    const s = c.state;
    const st = img[s]!;
    const tp = tu.place[s]!;
    const ann = annotations.filter((g) => g.state === s);
    if (ann.length === 0) continue;
    const allow = ann.flatMap((g) => g.allowances);
    const masks = union(...ann.map((g) => g.mask));
    const out = new Uint8Array(c.sprite.data);
    const lost = blank(c.mask.x, c.mask.y, c.mask.w, c.mask.h);
    let anyLost = false;
    for (let j = 0; j < c.mask.h; j++) {
      for (let i = 0; i < c.mask.w; i++) {
        if (!c.mask.data[j * c.mask.w + i]) continue;
        const x = i + tp.x;
        const y = j + tp.y;
        if (
          !has(masks, x, y) ||
          !st.rawInk[y * st.W + x] ||
          has(tp.partInk, x, y) ||
          allow.some((q) => inBox(q, x, y))
        )
          continue;
        let col: readonly [number, number, number] | undefined;
        for (const ui of c.units) {
          const u = units[ui]!;
          for (const s2 of states) {
            const dp = u.dep[s2];
            if (!dp || (u === tu && s2 === s)) continue;
            const p = u.place[s2]!;
            const qx = x - tp.x + p.x;
            const qy = y - tp.y + p.y;
            if (!has(dp.V, qx, qy)) continue;
            if (annotations.some((g) => g.state === s2 && has(g.mask, qx, qy))) continue;
            const st2 = img[s2]!;
            const q = (qy * st2.W + qx) * 4;
            col = [st2.image.data[q]!, st2.image.data[q + 1]!, st2.image.data[q + 2]!];
            break;
          }
          if (col) break;
        }
        if (!col) {
          col = st.background;
          lost.data[j * lost.w + i] = 1;
          anyLost = true;
        }
        const o = (j * c.mask.w + i) * 4;
        out[o] = col[0];
        out[o + 1] = col[1];
        out[o + 2] = col[2];
      }
    }
    c.sprite = { width: c.sprite.width, height: c.sprite.height, data: out };
    if (anyLost) c.unrecovered = tight(union(c.unrecovered, lost));
  }

  // ---- annotation validity (rules 2-5)
  const T = thresholds(strict);
  const invalid: Analysis["invalid"] = [];
  const inExempt = (g: AnnotationGeometry, u: Unit, x: number, y: number): boolean =>
    (exempt.get(`${g.index}:${u.index}`) ?? []).some((b) => inBox(b, x, y));
  // One mask per state of every unit's expected silhouette and part ink (hoisted lookups).
  const partMask: Partial<Record<FigureState, Mask>> = {};
  for (const s of states) {
    const ms = units.flatMap((u) => [u.place[s]!.E, u.place[s]!.partInk]);
    partMask[s] = clipMask(union(...ms), img[s]!.W, img[s]!.H);
  }
  const partAt = (s: FigureState, x: number, y: number): boolean => has(partMask[s]!, x, y);
  // Leaders: the free end (the one without a part contact) must end at a text rectangle.
  for (const g of annotations) {
    if (g.kind !== "leader") continue;
    const ends = [g.points[0]!, g.points[g.points.length - 1]!];
    const touch = contactEnds.get(g.index) ?? [false, false];
    const free = touch[0] !== touch[1] ? [ends[touch[0] ? 1 : 0]!] : ends;
    const texts = annotations.filter((t) => t.kind === "text" && t.state === g.state);
    if (!free.some(([x, y]) => texts.some((t) => boxDistance(x, y, t.rect!) <= 4))) {
      g.problems.push("the leader's free end is not within 4 px of a text rectangle of its state");
    }
  }
  for (const g of annotations) {
    const st = img[g.state]!;
    if (g.kind !== "text") {
      // A polyline must lie, for at least w px outside its allowances, on ink that is not part ink.
      let own = 0;
      for (const smp of g.samples) {
        if (
          smp.run === 0 ||
          g.allowances.some((b) => inBox(b, Math.round(smp.x), Math.round(smp.y)))
        )
          continue;
        if (!partAt(g.state, Math.round(smp.x), Math.round(smp.y))) own += STEP;
      }
      if (own < g.width) {
        g.problems.push(
          `the polyline lies on only ${own} px of its own (non-part) ink outside its allowances (at least ${g.width})`,
        );
      }
    }
    for (const reason of g.problems)
      invalid.push({
        annotation: g.index,
        state: g.state,
        reason,
        ...(bounds(g.band) ? { bbox: bounds(g.band)! } : {}),
      });
    if (g.kind === "text") {
      const r = g.rect!;
      let inkN = 0;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) if (st.ink[y * st.W + x]) inkN++;
      if (inkN === 0)
        invalid.push({
          annotation: g.index,
          state: g.state,
          reason: "the text rectangle contains no ink",
          bbox: r,
        });
      if (r.w * r.h > T.textFraction * st.W * st.H) {
        invalid.push({
          annotation: g.index,
          state: g.state,
          reason: `the text rectangle is more than ${T.textFraction * 100}% of the figure`,
          bbox: r,
        });
      }
      // A text rectangle is excluded in both states, so it may touch no part in either.
      for (const s of states) {
        const [dx, dy] = shiftTo(g.state, s);
        const rm = shifted(g.band, dx, dy);
        for (const u of units) {
          const p = u.place[s]!;
          const hitInk = intersect(rm, p.partInk);
          const hitHull = intersect(rm, p.hull);
          if (!isEmpty(hitInk) || !isEmpty(hitHull)) {
            invalid.push({
              annotation: g.index,
              state: s,
              reason: `the text rectangle ${!isEmpty(hitInk) ? "contains part ink of" : "overlaps the hull of"} ${u.id}${s !== g.state ? ` (mapped into the ${s} drawing)` : ""}`,
              bbox: bounds(!isEmpty(hitInk) ? hitInk : hitHull)!,
            });
          }
        }
      }
      continue;
    }
    for (const u of units) {
      const p = u.place[g.state]!;
      const hit = filter(intersect(g.band, union(p.E, p.partInk)), (x, y) => !inExempt(g, u, x, y));
      if (!isEmpty(hit)) {
        invalid.push({
          annotation: g.index,
          state: g.state,
          reason: `the band covers ${u.id} (its mask or part ink) outside the contact allowances`,
          bbox: bounds(hit)!,
        });
        continue;
      }
      // Ink under the band inside the hull: a stroke inside the hull that is not part ink (a
      // lever segmentation missed). The polyline's own stroke (the runs through its samples) is
      // exempt only in the hull's 2 px margin, never inside the convex hull itself: a leader
      // drawn along a missed stroke there would otherwise hide it.
      const own = ownStroke(g, st.W, st.H);
      const covered = filter(
        intersect(inkMask(st.rawInk, st.W, g.band), p.hull),
        (x, y) => !inExempt(g, u, x, y) && !(has(own, x, y) && !has(p.core, x, y)),
      );
      if (!isEmpty(covered)) {
        invalid.push({
          annotation: g.index,
          state: g.state,
          reason: `the band covers ink inside the hull of ${u.id}`,
          bbox: bounds(covered)!,
        });
      }
    }
  }
  // Rule 4: per unit and state, the pixels of its seated and exploded masks (the other one
  // mapped into this drawing) and of its part ink inside any annotation mask of this state,
  // outside that annotation's own exempt allowances, counted once.
  for (const s of states) {
    const inState = annotations.filter((g) => g.state === s);
    if (inState.length === 0) continue;
    const st = img[s]!;
    for (const u of units) {
      const p = u.place[s]!;
      const parts: Mask[] = [intersect(union(p.E, p.partInk), p.hull)];
      for (const o of states) {
        if (o === s) continue;
        const [dx, dy] = shiftTo(o, s);
        parts.push(clipMask(shifted(u.place[o]!.E, dx, dy), st.W, st.H));
      }
      const own = union(...parts);
      // An arrow's tip touching the mapped mask (the seat outline, in the exploded drawing) gets
      // an allowance there like a contact square: the arrow points at where the part goes.
      const tipBoxes = new Map<number, Box[]>();
      for (const g of inState) {
        if (g.kind !== "arrow") continue;
        const r = Math.ceil(g.halfWidth) + 1;
        const side = g.width + 2;
        const half = Math.floor(side / 2);
        const ends = g.head !== undefined ? [g.head] : [0, 1];
        for (const m of parts.slice(1)) {
          for (const e of ends) {
            const [ex, ey] = g.points[e === 0 ? 0 : g.points.length - 1]!;
            const n = nearest(m, Math.round(ex), Math.round(ey), r);
            if (!n) continue;
            const b: Box = { x: n.x - half, y: n.y - half, w: side, h: side };
            tipBoxes.set(g.index, [...(tipBoxes.get(g.index) ?? []), b]);
          }
        }
      }
      // The annotation masks of this state minus this unit's exempt squares, as one mask (a
      // mask is its band dilated by 2, so its exempt square is the allowance dilated by 2 too).
      const live = union(
        ...inState.map((g) => {
          const boxes = [
            ...(exempt.get(`${g.index}:${u.index}`) ?? []),
            ...(tipBoxes.get(g.index) ?? []),
          ].map((b) => ({
            x: b.x - 2,
            y: b.y - 2,
            w: b.w + 4,
            h: b.h + 4,
          }));
          return boxes.length === 0
            ? g.mask
            : filter(g.mask, (x, y) => !boxes.some((b) => inBox(b, x, y)));
        }),
      );
      const hit = intersect(own, live);
      const n = count(hit);
      if (n > T.cumulative) {
        invalid.push({
          annotation: null,
          state: s,
          reason: `${n} px of ${u.id} lie inside annotations (at most ${T.cumulative})`,
          bbox: bounds(hit)!,
        });
      }
    }
  }
  // Exclusion masks per state; rule 5.
  const excluded: Partial<Record<FigureState, Mask>> = {};
  for (const s of states) {
    const st = img[s]!;
    // An annotation mapped in from the other drawing is not drawn here: it excludes only
    // non-part pixels (the base areas recovered from or for it), never a part's silhouette or
    // part ink, so it cannot hide a defect of a part in this state.
    const parts = annotations.map((g) => {
      const [dx, dy] = shiftTo(g.state, s);
      const m = clipMask(shifted(g.mask, dx, dy), st.W, st.H);
      return g.state === s ? m : filter(m, (x, y) => !partAt(s, x, y));
    });
    const X = parts.length > 0 ? union(...parts) : EMPTY;
    excluded[s] = X;
    const n = count(X);
    if (n > T.exclusionFraction * st.W * st.H) {
      invalid.push({
        annotation: null,
        state: s,
        reason: `annotations exclude ${n} px, more than ${T.exclusionFraction * 100}% of the ${s} drawing`,
        ...(bounds(X) ? { bbox: bounds(X)! } : {}),
      });
    }
  }

  return {
    value: {
      manifest,
      strict,
      states,
      base,
      img,
      d,
      ...(alignment ? { alignment } : {}),
      units,
      classes,
      annotations,
      exempt,
      cutInk,
      excluded,
      front,
      diagnostics,
      maxMultiplyAdds: Math.max(0, budget.left),
      invalid,
    },
    diagnostics,
  };

  function place(u: Unit, s: FigureState, x: number, y: number, score: number, E: Mask): void {
    (u.place as Record<FigureState, Placement>)[s] = {
      x,
      y,
      score,
      E,
      visible: E,
      core: EMPTY,
      hull: EMPTY,
      partInk: EMPTY,
    };
  }
}

/**
 * The unbounded peel (§6.2): every closing-only pixel of the mask (ink only after the closing)
 * that the exterior reaches through closing-only pixels goes: comb fin gaps of up to 2 px open
 * to the outside. Raw ink, the seeded faces and paper stay, so a face behind a 1 px outline break
 * stays opaque (and so does a cavity behind a narrow mouth: declare it a hole).
 */
function peel(st: StateImage, m: Mask, R: Mask): Mask {
  return peelExterior(
    m,
    (x, y) => st.rawInk[y * st.W + x] !== 0 || has(R, x, y) || st.ink[y * st.W + x] === 0,
  );
}

/**
 * Bounding ink of seeded regions: ink whose distance to R is within the local stroke thickness
 * (the stroke along the direction to R: s·max(1, |cos θ| + |sin θ|) for a square brush), plus
 * every ink protrusion attached to it that ends within D = 4 strokes (an acute isometric corner
 * tip) without running on (a trace or another part's outline runs on, and is dropped whole, so a
 * stroke entering a concave notch leaves no stub). Ink nearer to another unit's seeded regions
 * is that unit's; ink equally near (a shared outline, within 1 px) is resolved later by the
 * measured front relation.
 */
function boundingInk(st: StateImage, R: Mask, rivals: readonly { R: Mask }[]): Mask {
  const s = st.stroke;
  const r = Math.ceil(1.5 * s) + 2;
  const D = Math.max(6, 4 * s);
  const close = rivals.filter((v) =>
    overlaps(dilate(v.R, r, st.W, st.H), dilate(R, r, st.W, st.H)),
  );
  const within = (x: number, y: number, m: Mask): number | undefined => {
    const n = nearest(m, x, y, r);
    if (!n) return undefined;
    const dx = Math.abs(x - n.x);
    const dy = Math.abs(y - n.y);
    const d = Math.sqrt(n.d2);
    const thick = d > 0 ? s * Math.max(1, (dx + dy) / d) : s;
    return d <= thick + 0.25 ? d : undefined;
  };
  const B0 = filter(inkMask(st.ink, st.W, dilate(R, r, st.W, st.H)), (x, y) => {
    const mine = within(x, y, R);
    if (mine === undefined) return false;
    for (const v of close) {
      const n = nearest(v.R, x, y, r);
      if (!n) continue;
      const dv = Math.sqrt(n.d2);
      // Nearer to the other unit: its ink. Equally near (a shared outline): both keep it here;
      // the drawing's measured front relation gives it to the unit in front when the template is
      // built (template pixels under a unit in front leave it), so no sprite carries it twice.
      if (dv < mine - 1) return false;
    }
    return true;
  });
  const far = dilate(R, D, st.W, st.H);
  const nearRim = dilate(R, D - 1, st.W, st.H);
  const hull = dilate(convexHull(union(R, B0)), D, st.W, st.H);
  const band = filter(inkMask(st.ink, st.W, far), (x, y) => !has(B0, x, y));
  const touch = dilate(B0, 1, st.W, st.H);
  const lab = labelMask(band);
  const keep = new Uint8Array(lab.count + 1).fill(1);
  const attached = new Uint8Array(lab.count + 1);
  for (let j = 0; j < band.h; j++) {
    for (let i = 0; i < band.w; i++) {
      const l = lab.labels[j * band.w + i]!;
      if (l === 0) continue;
      const x = i + band.x;
      const y = j + band.y;
      if (!has(nearRim, x, y) || !has(hull, x, y)) keep[l] = 0;
      if (has(touch, x, y)) attached[l] = 1;
      if (keep[l] && close.some((v) => nearest(v.R, x, y, 1) !== undefined)) keep[l] = 0;
    }
  }
  const add = filter(band, (x, y) => {
    const l = lab.labels[(y - band.y) * band.w + x - band.x]!;
    return l > 0 && keep[l] === 1 && attached[l] === 1;
  });
  return union(B0, add);
}

/**
 * Ink attached to `B` inside a polygon bound: components of the polygon's ink (minus B) that
 * touch B and do not reach the bound's border.
 */
function boundedInk(st: StateImage, B: Mask, bound: Mask): Mask {
  const cand = filter(inkMask(st.ink, st.W, bound), (x, y) => !has(B, x, y));
  const lab = labelMask(cand);
  const keep = new Uint8Array(lab.count + 1).fill(1);
  const attached = new Uint8Array(lab.count + 1);
  const touch = dilate(B, 1, st.W, st.H);
  for (let j = 0; j < cand.h; j++) {
    for (let i = 0; i < cand.w; i++) {
      const l = lab.labels[j * cand.w + i]!;
      if (l === 0) continue;
      const x = i + cand.x;
      const y = j + cand.y;
      if (has(touch, x, y)) attached[l] = 1;
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        if (!has(bound, x + dx, y + dy)) keep[l] = 0;
      }
    }
  }
  return union(
    B,
    filter(cand, (x, y) => {
      const l = lab.labels[(y - cand.y) * cand.w + x - cand.x]!;
      return keep[l] === 1 && attached[l] === 1;
    }),
  );
}

/** The polyline's own stroke: the ink runs through its samples, half a step along each side. */
function ownStroke(g: AnnotationGeometry, W: number, H: number): Mask {
  const pts: [number, number][] = [];
  for (const s of g.samples) {
    if (s.run === 0) continue;
    for (let k = s.lo; k <= s.hi; k++) {
      for (let t = -1; t <= 1; t++) {
        pts.push([Math.round(s.x + k * s.nx + t * s.ux), Math.round(s.y + k * s.ny + t * s.uy)]);
      }
    }
  }
  if (pts.length === 0) return EMPTY;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const b = clipBox({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, W, H);
  const m = blank(b.x, b.y, b.w, b.h);
  for (const [x, y] of pts)
    if (x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h)
      m.data[(y - b.y) * b.w + x - b.x] = 1;
  return m;
}

/** True when a class's units declare real through-holes (its enclosed paper stays transparent). */
function u0holes(units: readonly Unit[], c: TemplateClass): boolean {
  return c.units.some((i) => units[i]!.holes);
}

function boxUnion(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function clipMask(m: Mask, W: number, H: number): Mask {
  if (m.x >= 0 && m.y >= 0 && m.x + m.w <= W && m.y + m.h <= H) return m;
  const b = clipBox(m, W, H);
  const out = blank(b.x, b.y, b.w, b.h);
  for (let j = 0; j < b.h; j++)
    for (let i = 0; i < b.w; i++)
      out.data[j * b.w + i] = m.data[(j + b.y - m.y) * m.w + i + b.x - m.x]!;
  return out;
}

/** RGBA of `image` under `mask` (alpha 255 inside, 0 outside), over the mask's box. */
function colours(image: Raster, mask: Mask): Raster {
  const data = new Uint8Array(mask.w * mask.h * 4);
  for (let j = 0; j < mask.h; j++) {
    for (let i = 0; i < mask.w; i++) {
      if (!mask.data[j * mask.w + i]) continue;
      const x = i + mask.x;
      const y = j + mask.y;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const q = (y * image.width + x) * 4;
      const o = (j * mask.w + i) * 4;
      data[o] = image.data[q]!;
      data[o + 1] = image.data[q + 1]!;
      data[o + 2] = image.data[q + 2]!;
      data[o + 3] = 255;
    }
  }
  return { width: mask.w, height: mask.h, data };
}

/** Luminance over white of a sprite pixel (255 outside or transparent). */
export function spriteLum(s: Raster, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= s.width || y >= s.height) return 255;
  const o = (y * s.width + x) * 4;
  const a = s.data[o + 3]!;
  const k = 255 - a;
  const R = (s.data[o]! * a + 255 * k + 127) / 255;
  const G = (s.data[o + 1]! * a + 255 * k + 127) / 255;
  const B = (s.data[o + 2]! * a + 255 * k + 127) / 255;
  return Math.round(0.299 * R + 0.587 * G + 0.114 * B);
}
