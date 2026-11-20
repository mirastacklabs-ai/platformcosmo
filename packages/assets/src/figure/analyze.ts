/**
 * Figure analysis (ingestion §6.2-6.3): the reference model that both the pipeline and the gate
 * use. From the manifest and the source drawings it derives, per moving unit (a group of parts
 * that move together) and state: seeded regions, bounding ink, whole ink where the unit stands
 * alone, the expected silhouette (one template per instance class, placed by `locate`), the
 * visible part of it, the hull, and the geodesic part ink; plus the alignment between the
 * states and every annotation's measured band, mask and allowances.
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
  checkRaster,
  err,
  warning,
  type Raster,
} from "../raster.js";
import {
  annotationGeometry,
  boxDistance,
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
  erode1,
  fillHoles,
  filter,
  has,
  intersect,
  isEmpty,
  minus,
  overlapCount,
  overlaps,
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
  /** Multiply-adds per matcher run (default 2·10⁹). */
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
  /** Preliminary mask: R, B and what they enclose. */
  readonly P: Mask;
  /** Whole ink (8-connected to B, after the allowance cut) when the unit stands alone here. */
  readonly W?: Mask;
  readonly standalone: boolean;
  /** First visible estimate (whole silhouette where standalone, else P). */
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
  /** Ink with every polyline's allowance squares cut out. */
  readonly cutInk: Partial<Record<FigureState, Uint8Array>>;
  /** Union of every annotation mask mapped into the state. */
  readonly excluded: Partial<Record<FigureState, Mask>>;
  /** Front relations: front[state] has "u>v" when unit u is in front of v there. */
  readonly front: Partial<Record<FigureState, ReadonlySet<string>>>;
  readonly diagnostics: Diagnostic[];
  /** Per annotation: invalidity reasons (rules 2-5) with their bbox. */
  readonly invalid: {
    readonly annotation: number | null;
    readonly state: FigureState;
    readonly reason: string;
    readonly bbox?: Box;
  }[];
}

const other = (s: FigureState): FigureState => (s === "exploded" ? "assembled" : "exploded");

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
 * Whole ink: ink 8-connected to `start` through `cut`, giving up (undefined) beyond `budget`
 * pixels. `scratch` is a W*H buffer that is left cleared.
 */
function wholeInk(
  cut: Uint8Array,
  W: number,
  H: number,
  start: Mask,
  budget: number,
  scratch: Uint8Array,
): Mask | undefined {
  const touched: number[] = [];
  const stack: number[] = [];
  for (let j = 0; j < start.h; j++) {
    for (let i = 0; i < start.w; i++) {
      if (!start.data[j * start.w + i]) continue;
      const p = (j + start.y) * W + i + start.x;
      if (cut[p] && !scratch[p]) {
        scratch[p] = 1;
        touched.push(p);
        stack.push(p);
      }
    }
  }
  let over = false;
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
        if (scratch[q] || !cut[q]) continue;
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
  return dilate(union(...polys.map((p) => rasterPolygon(convexOrder(p)))), 3, W, H);
}

/** The polygon's points as a convex outline (its hull), so rasterization is well defined. */
function convexOrder(pts: readonly Point[]): (readonly [number, number])[] {
  const m = convexHull(
    union(...pts.map(([x, y]) => ({ x, y, w: 1, h: 1, data: new Uint8Array([1]) }))),
  );
  const out: [number, number][] = [];
  const b = bounds(m);
  if (!b) return pts.map(([x, y]) => [x, y]);
  for (let j = 0; j < m.h; j++) {
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < m.w; i++) {
      if (m.data[j * m.w + i]) {
        if (lo < 0) lo = i;
        hi = i;
      }
    }
    if (lo >= 0) {
      out.push([lo + m.x, j + m.y]);
      out.push([hi + m.x, j + m.y]);
    }
  }
  return hullPoints(out);
}

function hullPoints(input: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  const pts = [...input].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]): number =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lower: (readonly [number, number])[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: (readonly [number, number])[] = [];
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = pts[k]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  const poly = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return poly.length > 0 ? poly : pts.slice(0, 1);
}

/** Mask of `sprite` alpha placed with its top-left at (x, y). */
export function spriteMask(sprite: Raster, x: number, y: number): Mask {
  const m = blank(x, y, sprite.width, sprite.height);
  for (let i = 0; i < m.data.length; i++) m.data[i] = sprite.data[i * 4 + 3]! > 0 ? 1 : 0;
  return m;
}

/**
 * Runs the analysis. Returns undefined (with error diagnostics) when the inputs cannot be
 * analysed at all: invalid manifest, missing or oversized images, or no alignment.
 */
export function analyzeFigure(
  input: unknown,
  sources: FigureSources,
  options: FigureOptions = {},
): { value?: Analysis; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const v = validateManifest(input);
  if (!v.value) return { diagnostics: v.diagnostics };
  const manifest = v.value;
  const strict = options.strict === true;
  const maxPixels = Math.min(options.maxPixels ?? MAX_PIXELS, MAX_PIXELS);
  const maxMacs = Math.min(options.maxMultiplyAdds ?? MAX_MULTIPLY_ADDS, MAX_MULTIPLY_ADDS);

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
          {
            params: { option: "manifest", state: s },
          },
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
    const nearest: Partial<Record<FigureState, Point>> = {};
    const polygons: Partial<Record<FigureState, Point[][]>> = {};
    const seeds: Partial<Record<FigureState, Point[]>> = {};
    for (const s of states) {
      for (const i of idx) {
        const p = manifest.parts[i]!;
        for (const [k, pt] of (p.seeds[s] ?? []).entries()) {
          const l = toLocal(s, pt, `/parts/${i}/seeds/${s}/${k}`);
          if (l) (seeds[s] ??= []).push(l);
        }
        const n = p.nearest?.[s];
        if (n && nearest[s] === undefined) {
          const l = toLocal(s, n, `/parts/${i}/nearest/${s}`);
          if (l) nearest[s] = l;
        }
      }
      if (idx.every((i) => manifest.parts[i]!.polygon?.[s] !== undefined)) {
        const polys: Point[][] = [];
        for (const i of idx) {
          const pts: Point[] = [];
          for (const [k, pt] of manifest.parts[i]!.polygon![s]!.entries()) {
            const l = toLocal(s, pt, `/parts/${i}/polygon/${s}/${k}`);
            if (l) pts.push(l);
          }
          polys.push(pts);
        }
        polygons[s] = polys;
      }
    }
    const z = parts.find((p) => p.z !== undefined)?.z;
    const unit: Unit = {
      index: units.length,
      id: g,
      partIds: parts.map((p) => p.id),
      cls: classOf.get(key)!,
      holes: parts.some((p) => p.holes === true),
      allowDisjoint: parts.some((p) => p.allowDisjoint === true),
      ...(z !== undefined ? { z } : {}),
      nearest,
      polygons,
      seeds,
      dep: {},
      place: {},
    };
    units.push(unit);
  }
  const seedsOf = (u: Unit, s: FigureState): readonly Point[] => u.seeds[s] ?? [];

  // ---- annotations: translate, budget, geometry
  const annInputs: { index: number; points?: [number, number][]; rect?: Box }[] = [];
  let totalLength = 0;
  let maxSide = 0;
  for (const s of states) maxSide = Math.max(maxSide, img[s]!.W + img[s]!.H);
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
            {
              params: { option: "manifest", state: a.state },
            },
          ),
          path: `/annotations/${i}/rect`,
        });
        return;
      }
      annInputs.push({ index: i, rect: { x: p[0], y: p[1], w: a.rect[2], h: a.rect[3] } });
    } else {
      const pts: [number, number][] = [];
      a.polyline.forEach((pt, k) => {
        const l = toLocal(a.state, pt, `/annotations/${i}/polyline/${k}`);
        if (l) pts.push(l);
      });
      if (pts.length !== a.polyline.length) return;
      totalLength += polylineLength(pts);
      annInputs.push({ index: i, points: pts });
    }
  });
  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  // Bounded measuring and rasterization: about 70 probes and (2r+1) band pixels per px of length.
  if (totalLength > 32 * maxSide) {
    return {
      diagnostics: [
        ...diagnostics,
        err(
          "asset/too-expensive",
          `the annotation polylines are ${Math.round(totalLength)} px long in total, above ${32 * maxSide}`,
          {
            suggestion: "declare each arrow or leader by its ends and corners only",
            params: { length: Math.round(totalLength), limit: 32 * maxSide },
          },
        ),
      ],
    };
  }
  const annotations: AnnotationGeometry[] = annInputs.map((ai) => {
    const a = manifest.annotations![ai.index]!;
    const st = img[a.state]!;
    return annotationGeometry(
      {
        index: ai.index,
        annotation: a,
        ...(ai.points ? { points: ai.points } : {}),
        ...(ai.rect ? { rect: ai.rect } : {}),
      },
      st.ink,
      st.W,
      st.H,
    );
  });
  for (const g of annotations) {
    if (g.kind !== "leader") continue;
    const texts = annotations.filter((t) => t.kind === "text" && t.state === g.state);
    const ends = [g.points[0]!, g.points[g.points.length - 1]!];
    if (!ends.some(([x, y]) => texts.some((t) => boxDistance(x, y, t.rect!) <= 4))) {
      g.problems.push("the leader does not end within 4 px of a text rectangle of its state");
    }
  }

  // ---- preliminary depictions (seeded regions)
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
              {
                params: { part: u.id, state: s, seed: [x, y] },
              },
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
              {
                params: { part: u.id, state: s, seed: [x, y] },
              },
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
  for (const u of units) {
    for (const s of states) {
      const R = seededR.get(`${u.index}:${s}`);
      if (!R) continue;
      const st = img[s]!;
      const rivals = units
        .filter((w) => w !== u && seededR.has(`${w.index}:${s}`))
        .map((w) => seededR.get(`${w.index}:${s}`)!);
      const B = boundingInk(st, R, rivals);
      const bound = polygonBound(u.polygons[s], st.W, st.H);
      let P = peelClosing(st, u.holes ? union(R, B) : fillHoles(union(R, B)));
      if (bound) P = intersect(P, bound);
      (u.dep as Record<FigureState, Depiction>)[s] = {
        state: s,
        seeds: seedsOf(u, s),
        R,
        B,
        P,
        standalone: false,
        V: P,
      };
    }
  }

  // ---- alignment between the states
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
        const tryPatch = align(a.image, b.image, { exclude: ex, patch, maxMultiplyAdds: maxMacs });
        if (tryPatch.value && tryPatch.value.score >= 0.9) al = tryPatch;
      }
    }
    al ??= align(a.image, b.image, { exclude: ex, maxMultiplyAdds: maxMacs });
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

  // ---- allowance cut, standalone, whole ink
  const cutInk: Partial<Record<FigureState, Uint8Array>> = {};
  for (const s of states) {
    const st = img[s]!;
    const cut = new Uint8Array(st.ink);
    for (const g of annotations) {
      if (g.state !== s) continue;
      for (const b of g.allowances) {
        const c = clipBox(b, st.W, st.H);
        for (let y = c.y; y < c.y + c.h; y++)
          for (let x = c.x; x < c.x + c.w; x++) cut[y * st.W + x] = 0;
      }
    }
    cutInk[s] = cut;
  }
  for (const s of states) {
    const st = img[s]!;
    const cut = cutInk[s]!;
    const scratch = new Uint8Array(st.W * st.H);
    const squares = annotations.filter((g) => g.state === s).flatMap((g) => g.allowances);
    for (const u of units) {
      const dp = u.dep[s];
      if (!dp) continue;
      const near = dilate(dp.P, 4, st.W, st.H);
      const others = units.filter((w) => w !== u && w.dep[s]).map((w) => w.dep[s]!.P);
      if (others.some((p) => overlaps(near, p))) continue;
      const hullP = count(convexHull(dp.P));
      const W0 = wholeInk(cut, st.W, st.H, dp.B, 4 * hullP + 64, scratch);
      if (!W0) continue;
      if (others.some((p) => overlaps(dilate(W0, 4, st.W, st.H), p))) continue;
      if (count(convexHull(union(dp.P, W0))) > 4 * hullP) continue;
      // Close the outline across the allowance squares: cut ink inside a square that touches the
      // whole ink, then remove what a radius-1 opening removes inside the squares (the 1-2 px
      // stub of the polyline itself).
      let inSq: Mask = EMPTY;
      const wd = dilate(W0, 1, st.W, st.H);
      for (const b of squares) {
        const sq = boxMask(b, st.W, st.H);
        if (!overlaps(sq, wd)) continue;
        const inkSq = inkMask(st.ink, st.W, sq);
        inSq = union(inSq, geodesic(st.ink, st.W, intersect(inkSq, wd), sq));
      }
      let M = union(dp.R, dp.B, W0, inSq);
      M = u.holes
        ? union(M, intersect(fillHoles(M), inkMask(st.ink, st.W, fillHoles(M))))
        : fillHoles(M);
      if (!isEmpty(inSq)) {
        const opened = dilate(erode1(within1(M)), 1, st.W, st.H);
        M = filter(
          M,
          (x, y) =>
            has(opened, x, y) ||
            !squares.some((b) => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h),
        );
      }
      M = peelClosing(st, M);
      const bound = polygonBound(u.polygons[s], st.W, st.H);
      if (bound) M = intersect(M, bound);
      (u.dep as Record<FigureState, Depiction>)[s] = {
        ...dp,
        W: W0,
        standalone: true,
        V: tight(M),
      };
    }
  }

  // ---- templates and placements
  const classes: TemplateClass[] = classIds.map((id, ci) => {
    const members = units.filter((u) => u.cls === ci);
    let best: { u: Unit; s: FigureState; n: number } | undefined;
    for (const u of members) {
      for (const s of STATES) {
        const dp = u.dep[s];
        if (!dp) continue;
        const n = count(dp.V);
        if (!best || n > best.n) best = { u, s, n };
      }
    }
    const t = best!;
    const mask = tight(t.u.dep[t.s]!.V);
    return {
      index: ci,
      id,
      units: members.map((u) => u.index),
      unit: t.u.index,
      state: t.s,
      mask,
      sprite: colours(img[t.s]!.image, mask),
    };
  });
  for (const c of classes) {
    for (const s of states) {
      const st = img[s]!;
      const members = c.units.map((i) => units[i]!);
      const need = members.filter((u) => !(u.index === c.unit && s === c.state));
      if (need.length === 0) {
        place(units[c.unit]!, s, c.mask.x, c.mask.y, 1, c.mask);
        continue;
      }
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
      const found = locate(st.image, c.sprite, {
        region,
        top: Math.min(64, 2 * members.length + 2),
        scales: [1],
        nmsIoU: 0.8,
        minScore: 0.5,
        maxMultiplyAdds: maxMacs,
      });
      diagnostics.push(
        ...found.diagnostics.filter((x) => x.severity === "error" && x.code !== "asset/not-found"),
      );
      if (found.diagnostics.some((x) => x.code === "asset/too-expensive")) return { diagnostics };
      const peaks = (found.value?.matches ?? []).filter(
        (m) => !(s === c.state && Math.abs(m.x - c.mask.x) <= 2 && Math.abs(m.y - c.mask.y) <= 2),
      );
      if (s === c.state) place(units[c.unit]!, s, c.mask.x, c.mask.y, 1, c.mask);
      // Assignment: seeds inside the placed silhouette first, then overlap with the seeded
      // mask, then the nearest hint, then the score.
      const pairs: { u: Unit; k: number; cost: number[] }[] = [];
      for (const u of need) {
        const dp = u.dep[s];
        peaks.forEach((m, k) => {
          const E = shifted(c.mask, m.x - c.mask.x, m.y - c.mask.y);
          const miss = dp
            ? dp.seeds.filter(([x, y]) => !has(dilate(E, 1, st.W, st.H), x, y)).length
            : 0;
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

  // ---- front relations and visible masks
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
              const lu = spriteLum(su.sprite, x - pu.x, y - pu.y);
              const lw = spriteLum(sw.sprite, x - pw.x, y - pw.y);
              const mu = Math.abs(src - lu) <= 48;
              const mw = Math.abs(src - lw) <= 48;
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

  // ---- occlusion recovery into the template (one pass)
  for (const c of classes) {
    const tu = units[c.unit]!;
    const tp = tu.place[c.state]!;
    const st = img[c.state]!;
    let covered: Mask = EMPTY;
    for (const w of units) if (w !== tu) covered = union(covered, w.place[c.state]!.E);
    let add: Mask = EMPTY;
    const sources: { m: Mask; s: FigureState; dx: number; dy: number }[] = [];
    for (const ui of c.units) {
      const u = units[ui]!;
      for (const s of states) {
        if (u === tu && s === c.state) continue;
        const p = u.place[s]!;
        // Pixels this depiction shows that the template lacks and that are covered in the template.
        const back = shifted(p.visible, tp.x - p.x, tp.y - p.y);
        const cand = intersect(minus(back, c.mask), covered);
        if (isEmpty(cand)) continue;
        const fresh = minus(cand, add);
        add = union(add, fresh);
        sources.push({ m: fresh, s, dx: p.x - tp.x, dy: p.y - tp.y });
      }
    }
    if (isEmpty(add)) continue;
    const mask = tight(union(c.mask, add));
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
    computeVisible();
  }

  // ---- hulls and part ink
  for (const u of units) {
    const S0 = (["exploded", "assembled"] as const).find((s) => u.dep[s]?.standalone);
    u.standaloneState = S0;
    let H0: Mask | undefined;
    if (S0) H0 = convexHull(union(u.place[S0]!.E, u.dep[S0]!.W!));
    else {
      diagnostics.push(
        warning(
          "asset/hull-uncertain",
          `${u.id} stands alone in no state, so its hull comes from its mask only`,
          {
            part: u.id,
          },
        ),
      );
    }
    for (const s of states) {
      const st = img[s]!;
      const p = u.place[s]!;
      const mapped = H0 && S0 ? clipMask(shifted(H0, p.x - u.place[S0]!.x, p.y - u.place[S0]!.y), st.W, st.H) : EMPTY;
      p.hull = dilate(convexHull(union(mapped, p.E)), 2, st.W, st.H);
      p.partInk = geodesic(
        cutInk[s]!,
        st.W,
        inkMask(cutInk[s]!, st.W, clipMask(p.visible, st.W, st.H)),
        p.hull,
      );
    }
  }

  // ---- annotation validity (rules 2-5)
  const T = thresholds(strict);
  const invalid: Analysis["invalid"] = [];
  const shiftTo = (from: FigureState, to: FigureState): [number, number] => [
    d[to]![0] - d[from]![0],
    d[to]![1] - d[from]![1],
  ];
  // Exemptions: an annotation's allowance square exempts that annotation's own band and mask
  // where it touches a unit, at most 8 squares per unit and state (in annotation order).
  const exempt = new Map<string, Box[]>();
  const exemptCount = new Map<string, number>();
  for (const g of annotations) {
    const st = img[g.state]!;
    for (const b of g.allowances) {
      const sq = boxMask(b, st.W, st.H);
      for (const u of units) {
        const p = u.place[g.state]!;
        if (!overlaps(sq, dilate(p.E, 1, st.W, st.H)) && !overlaps(sq, p.partInk)) continue;
        const key = `${u.index}:${g.state}`;
        const n = exemptCount.get(key) ?? 0;
        if (n >= 8) continue;
        exemptCount.set(key, n + 1);
        const k = `${g.index}:${u.index}`;
        exempt.set(k, [...(exempt.get(k) ?? []), b]);
      }
    }
  }
  const inExempt = (g: AnnotationGeometry, u: Unit, x: number, y: number): boolean =>
    (exempt.get(`${g.index}:${u.index}`) ?? []).some(
      (b) => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h,
    );
  for (const g of annotations) {
    const st = img[g.state]!;
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
      const covered = filter(
        intersect(inkMask(st.ink, st.W, g.band), p.hull),
        (x, y) => !inExempt(g, u, x, y),
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
  // Rule 4: pixels of each unit (mask and part ink, inside its hull) inside any annotation mask
  // outside that annotation's own exempt allowances, counted once, per unit and state.
  for (const s of states) {
    const inState = annotations.filter((g) => g.state === s);
    if (inState.length === 0) continue;
    for (const u of units) {
      const p = u.place[s]!;
      const own = intersect(union(p.E, p.partInk), p.hull);
      const hit = filter(own, (x, y) =>
        inState.some((g) => has(g.mask, x, y) && !inExempt(g, u, x, y)),
      );
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
    const parts = annotations.map((g) => {
      const [dx, dy] = shiftTo(g.state, s);
      return clipMask(shifted(g.mask, dx, dy), st.W, st.H);
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
      cutInk,
      excluded,
      front,
      diagnostics,
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
      hull: EMPTY,
      partInk: EMPTY,
    };
  }
}

/**
 * Bounding ink of seeded regions: ink within the stroke width of R, plus every ink protrusion
 * attached to it that ends within 4 stroke widths (an acute isometric corner tip is thicker than
 * a stroke), but not a stroke that runs on beyond that (a trace or another part's outline).
 */
function boundingInk(st: StateImage, R: Mask, rivals: readonly Mask[] = []): Mask {
  // Ink nearer (Euclidean) to another unit's seeded regions belongs to that unit: on a diagonal
  // edge the Chebyshev band reaches a rear part's stroke touching the outline from outside.
  const near = (m: Mask, x: number, y: number, r: number): number => {
    let best = Infinity;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (has(m, x + dx, y + dy)) best = Math.min(best, dx * dx + dy * dy);
    return best;
  };
  const reach = st.stroke + 1;
  const D = Math.max(6, 4 * st.stroke);
  const far = dilate(R, D, st.W, st.H);
  const close = rivals.filter((v) => overlaps(dilate(v, 2 * reach, st.W, st.H), far));
  // One union of the nearby rivals: each pixel costs at most two (4 reach + 1)^2 window scans.
  const rival = close.length > 0 ? union(...close) : undefined;
  const mineFirst = (x: number, y: number, r: number): boolean => !rival || near(rival, x, y, r) >= near(R, x, y, r);
  const B00 = filter(inkMask(st.ink, st.W, dilate(R, st.stroke, st.W, st.H)), (x, y) => mineFirst(x, y, reach));
  // The rest of the outline: ink connected to it inside the convex hull of the seeded regions and
  // their outline, within D of the regions (where a face tapers into a corner its stroke is
  // farther than one stroke width).
  const hull = intersect(convexHull(union(R, B00)), far);
  const B0 = filter(union(B00, geodesic(st.ink, st.W, B00, hull)), (x, y) => has(B00, x, y) || mineFirst(x, y, 2 * reach));
  const nearRim = dilate(R, D - 1, st.W, st.H);
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
      if (!has(nearRim, x, y)) keep[l] = 0;
      if (has(touch, x, y)) attached[l] = 1;
    }
  }
  const add = filter(band, (x, y) => {
    const l = lab.labels[(y - band.y) * band.w + x - band.x]!;
    return l > 0 && keep[l] === 1 && attached[l] === 1;
  });
  return union(B0, add);
}

/**
 * Removes, from the outer boundary of a mask, pixels that are ink only because of the radius-1
 * closing (notches between a stroke's stair steps): they are paper in the drawing.
 */
function peelClosing(st: StateImage, m: Mask): Mask {
  let cur = m;
  for (let k = 0; k < 3; k++) {
    const pad = within1(cur);
    const out = filter(cur, (x, y) => {
      const p = y * st.W + x;
      if (!(st.ink[p] && !st.rawInk[p])) return true;
      return has(pad, x - 1, y) && has(pad, x + 1, y) && has(pad, x, y - 1) && has(pad, x, y + 1);
    });
    if (count(out) === count(cur)) return cur;
    cur = out;
  }
  return cur;
}

/** 8-connected labels of a local mask (1..count, raster order). */
function labelMask(m: Mask): { labels: Int32Array; count: number } {
  const labels = new Int32Array(m.w * m.h);
  let n = 0;
  const stack: number[] = [];
  for (let p0 = 0; p0 < m.w * m.h; p0++) {
    if (!m.data[p0] || labels[p0]) continue;
    n++;
    labels[p0] = n;
    stack.push(p0);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const i = p % m.w;
      const j = (p - i) / m.w;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const a = i + di;
          const b = j + dj;
          if (a < 0 || b < 0 || a >= m.w || b >= m.h) continue;
          const q = b * m.w + a;
          if (!m.data[q] || labels[q]) continue;
          labels[q] = n;
          stack.push(q);
        }
      }
    }
  }
  return { labels, count: n };
}

function boxUnion(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** A mask padded by one empty pixel on each side (so erosion treats the outside as unset). */
function within1(m: Mask): Mask {
  const out = blank(m.x - 1, m.y - 1, m.w + 2, m.h + 2);
  for (let j = 0; j < m.h; j++)
    for (let i = 0; i < m.w; i++) out.data[(j + 1) * out.w + i + 1] = m.data[j * m.w + i]!;
  return out;
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
