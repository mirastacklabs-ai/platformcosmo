/**
 * Z-buffer reference for depth-epoch tests.
 *
 * Painter side: a real SVG of the epoch at time t (item copies in the DOM order, copies not visible
 * in the epoch omitted, every box as its projected silhouette in a unique flat id colour), rendered by core's
 * resvg `rasterize` with `shape-rendering="crispEdges"`, so the id map comes from actual SVG
 * paint order, transforms and `clip-path` semantics (a clip inside a translated group moves with
 * it). Clipped items use the §9.4 wrapper chain: `<g transform=host>` (the clipping solid's
 * TOTAL track) > `<g clip-path>` (static prism, solid's rest frame) > `<g transform=motion>`
 * (leaf track relative to the solid). The `"motion"` mode puts the clip inside the leaf's own
 * motion group instead (the regression the tracks doc demands), `"none"` drops clips.
 *
 * Reference side: an exact per-pixel ray cast of the same boxes at time t (pure TS). The view
 * ray of screen point (sx, sy) is p0 + s·(1, 1, 1) (tile 64, zScale 32: project(1,1,1) = 0); a
 * box is hit on s ∈ [max_k(min_k − p0_k), min_k(max_k − p0_k)] and its visible point is the
 * largest s. The nearest box's item wins.
 *
 * Comparison: pixels whose 3×3 reference neighbourhood holds more than one id are boundary
 * pixels (rasterizer edge rules differ by up to one pixel) and are not counted.
 */
import type { Box3, Vec3 } from "../src/contracts/index.js";
import { decodePng } from "../src/export/png.js";
import { rasterize } from "../src/export/rasterize.js";
import type { DepthEpochResult, DepthItemInput, LoopMove } from "../src/depth/epochs.js";
import { displacementAt } from "../src/depth/epochs.js";
import { parseCopyKey } from "../src/depth/copies.js";

export interface Scene {
  readonly items: readonly DepthItemInput[];
  readonly moves: readonly LoopMove[];
  readonly loop: number;
  /**
   * Item keys drawn and ray-cast as a vertical (z) cylinder inscribed in their box instead of the
   * box (tests of solids that do not fill their `depthBox`).
   */
  readonly zcyl?: readonly string[];
}

/** Reference pixel where two items' visible faces are coplanar (excluded from comparison). */
export const AMBIGUOUS = -3;

const HW = 32;
const HH = 16;
const ZS = 32;

export function proj(v: Vec3): { x: number; y: number } {
  return { x: (v.x - v.y) * HW, y: (v.x + v.y) * HH - v.z * ZS };
}

function corners(b: Box3): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({
      x: b.origin.x + (i & 1 ? b.size.x : 0),
      y: b.origin.y + (i & 2 ? b.size.y : 0),
      z: b.origin.z + (i & 4 ? b.size.z : 0),
    });
  }
  return out;
}

function hull(pts: { x: number; y: number }[]): { x: number; y: number }[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (
    o: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper: { x: number; y: number }[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0)
      upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function silhouette(b: Box3, zcyl = false): string {
  let pts: { x: number; y: number }[];
  if (zcyl) {
    // Vertical cylinder inscribed in the box: hull of its top and bottom ellipses.
    pts = [];
    const cx = b.origin.x + b.size.x / 2;
    const cy = b.origin.y + b.size.y / 2;
    for (let k = 0; k < 96; k++) {
      const a = (2 * Math.PI * k) / 96;
      for (const z of [b.origin.z, b.origin.z + b.size.z]) {
        pts.push(
          proj({ x: cx + (b.size.x / 2) * Math.cos(a), y: cy + (b.size.y / 2) * Math.sin(a), z }),
        );
      }
    }
  } else {
    pts = corners(b).map(proj);
  }
  return hull(pts)
    .map((q) => `${q.x.toFixed(4)},${q.y.toFixed(4)}`)
    .join(" ");
}

export function colorOf(index: number): number {
  // Distinct, far-apart colours; the decoder uses an exact reverse map.
  return ((index + 1) * 0x9e3779b1) >>> 8;
}

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, "0")}`;
}

export interface View {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Pixels per user unit. */
  readonly scale: number;
}

/** A view covering every box of the scene at the given times, with a margin. */
export function viewOf(scene: Scene, times: readonly number[], scale = 1): View {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of times) {
    for (const it of scene.items) {
      const d = displacementAt(scene.moves, it.path, t);
      for (const b of it.boxes ?? [it.box]) {
        for (const c of corners(b)) {
          const q = proj({ x: c.x + d.x, y: c.y + d.y, z: c.z + d.z });
          x0 = Math.min(x0, q.x);
          y0 = Math.min(y0, q.y);
          x1 = Math.max(x1, q.x);
          y1 = Math.max(y1, q.y);
        }
      }
    }
  }
  const m = 8;
  return {
    x: Math.floor(x0 - m),
    y: Math.floor(y0 - m),
    w: Math.ceil(x1 - x0 + 2 * m),
    h: Math.ceil(y1 - y0 + 2 * m),
    scale,
  };
}

export type ClipMode = "host" | "motion" | "none";

export function epochAt(result: DepthEpochResult, t: number): DepthEpochResult["epochs"][number] {
  const e = result.epochs;
  for (let k = 0; k < e.length; k++) {
    if (t >= e[k]!.t0 && (t < e[k]!.t1 || k === e.length - 1)) return e[k]!;
  }
  return e[e.length - 1]!;
}

export interface PaintOptions {
  readonly clipMode?: ClipMode;
  /** Host track override per solid key (tests of nested composition). */
  readonly host?: (solid: string, t: number) => Vec3;
  /** Draw these items even where the epoch hides them (negative controls). */
  readonly forceVisible?: readonly string[];
  /** Replace an item's clip prism (negative controls: a clip at the wrong face). */
  readonly prism?: (item: string, prism: Box3) => Box3;
  /** Clip every copy of a clipped item, ignoring per-copy clips (negative control, §9.5). */
  readonly clipEveryCopy?: boolean;
}

/** The painter SVG of the epoch containing `t`. */
export function paintSvg(
  scene: Scene,
  result: DepthEpochResult,
  t: number,
  view: View,
  opts: PaintOptions = {},
): string {
  const mode = opts.clipMode ?? "host";
  const keys = [...scene.items].map((i) => i.key).sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const byKey = new Map(scene.items.map((i) => [i.key, i]));
  const clips = new Map(result.clips.map((c) => [c.item, c]));
  // clips per copy (§9.4): an item clipped only while it crosses has unclipped copies (§9.5)
  const copyClips = new Map(result.items.map((i) => [i.item, i.clips]));
  const visible = new Set(epochAt(result, t).order);
  const forced = new Set(opts.forceVisible ?? []);
  const round = new Set(scene.zcyl ?? []);
  const defs: string[] = [];
  const body: string[] = [];
  const tr = (v: Vec3): string => {
    const q = proj(v);
    return `translate(${q.x.toFixed(4)} ${q.y.toFixed(4)})`;
  };
  // The DOM order holds copy keys (§9.4): each copy draws its item; one copy is visible per epoch.
  for (const copyKey of result.order) {
    const { item: key, copy } = parseCopyKey(copyKey);
    if (!visible.has(copyKey) && !(copy === 0 && forced.has(key))) continue;
    const it = byKey.get(key)!;
    const fill = hex(colorOf(index.get(key)!));
    const polys = (it.boxes ?? [it.box])
      .map((b) => `<polygon points="${silhouette(b, round.has(key))}" fill="${fill}"/>`)
      .join("");
    const d = displacementAt(scene.moves, it.path, t);
    const clip =
      opts.clipEveryCopy || copyClips.get(key)?.[copy] !== undefined ? clips.get(key) : undefined;
    if (!clip || mode === "none") {
      body.push(`<g transform="${tr(d)}">${polys}</g>`);
      continue;
    }
    const cid = `c${index.get(key)!}-${copy}`;
    const prism = opts.prism ? opts.prism(key, clip.prism) : clip.prism;
    defs.push(`<clipPath id="${cid}"><polygon points="${silhouette(prism)}"/></clipPath>`);
    const solid = byKey.get(clip.solid)!;
    const h = opts.host ? opts.host(clip.solid, t) : displacementAt(scene.moves, solid.path, t);
    if (mode === "host") {
      const rel = { x: d.x - h.x, y: d.y - h.y, z: d.z - h.z };
      body.push(
        `<g transform="${tr(h)}"><g clip-path="url(#${cid})"><g transform="${tr(rel)}">${polys}</g></g></g>`,
      );
    } else {
      body.push(`<g transform="${tr(d)}"><g clip-path="url(#${cid})">${polys}</g></g>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${view.w}" height="${view.h}" ` +
    `viewBox="${view.x} ${view.y} ${view.w} ${view.h}" shape-rendering="crispEdges">` +
    `<defs>${defs.join("")}</defs>${body.join("")}</svg>`
  );
}

/** Per-pixel item index from the rendered painter SVG (-1 background, -2 unknown colour). */
export async function painterIds(scene: Scene, svg: string, view: View): Promise<Int32Array> {
  const png = await rasterize(svg, { scale: view.scale, fonts: [] });
  const img = decodePng(png);
  const keys = [...scene.items].map((i) => i.key).sort();
  const rev = new Map<number, number>();
  keys.forEach((_, i) => rev.set(colorOf(i), i));
  const out = new Int32Array(img.width * img.height);
  for (let p = 0; p < out.length; p++) {
    const r = img.data[4 * p]!;
    const g = img.data[4 * p + 1]!;
    const b = img.data[4 * p + 2]!;
    const a = img.data[4 * p + 3]!;
    if (a === 0) out[p] = -1;
    else if (a < 255) out[p] = -2;
    else out[p] = rev.get((r << 16) | (g << 8) | b) ?? -2;
  }
  return out;
}

/** Exact per-pixel visible item index at time `t` (ray cast). */
export function zbufferIds(scene: Scene, t: number, view: View): Int32Array {
  const keys = [...scene.items].map((i) => i.key).sort();
  const boxes: { idx: number; b: number[]; round: boolean }[] = [];
  const round = new Set(scene.zcyl ?? []);
  for (const it of scene.items) {
    if (it.present && !it.present.some((w) => t >= w[0] && t <= w[1])) continue; // not built yet
    const d = displacementAt(scene.moves, it.path, t);
    const idx = keys.indexOf(it.key);
    for (const b of it.boxes ?? [it.box]) {
      boxes.push({
        idx,
        round: round.has(it.key),
        b: [
          b.origin.x + d.x,
          b.origin.y + d.y,
          b.origin.z + d.z,
          b.origin.x + b.size.x + d.x,
          b.origin.y + b.size.y + d.y,
          b.origin.z + b.size.z + d.z,
        ],
      });
    }
  }
  const W = Math.round(view.w * view.scale);
  const Hh = Math.round(view.h * view.scale);
  const out = new Int32Array(W * Hh).fill(-1);
  for (let py = 0; py < Hh; py++) {
    for (let px = 0; px < W; px++) {
      const sx = view.x + (px + 0.5) / view.scale;
      const sy = view.y + (py + 0.5) / view.scale;
      const x0 = (sx / HW + sy / HH) / 2;
      const y0 = (sy / HH - sx / HW) / 2;
      let best = -Infinity;
      let who = -1;
      let tie = false;
      for (const { idx, b, round: cyl } of boxes) {
        let lo = Math.max(b[0]! - x0, b[1]! - y0, b[2]!);
        let hi = Math.min(b[3]! - x0, b[4]! - y0, b[5]!);
        if (cyl) {
          // ((x0 + s - cx)/rx)^2 + ((y0 + s - cy)/ry)^2 <= 1: a quadratic in s.
          const rx = (b[3]! - b[0]!) / 2;
          const ry = (b[4]! - b[1]!) / 2;
          const ax = (x0 - (b[0]! + rx)) / rx;
          const ay = (y0 - (b[1]! + ry)) / ry;
          const A = 1 / (rx * rx) + 1 / (ry * ry);
          const B = 2 * (ax / rx + ay / ry);
          const Cc = ax * ax + ay * ay - 1;
          const disc = B * B - 4 * A * Cc;
          if (disc < 0) continue;
          const sq = Math.sqrt(disc);
          lo = Math.max(lo, (-B - sq) / (2 * A));
          hi = Math.min(hi, (-B + sq) / (2 * A));
        }
        if (!(hi - lo > 1e-9)) continue;
        if (Math.abs(hi - best) <= 1e-7 && idx !== who) tie = true;
        else if (hi > best) {
          best = hi;
          who = idx;
          tie = false;
        }
      }
      // Coplanar visible faces of two items (a flush end face): no single right answer.
      out[py * W + px] = tie ? AMBIGUOUS : who;
    }
  }
  return out;
}

export interface Comparison {
  readonly pixels: number;
  /** Non-background reference pixels (the denominator of `fraction`). */
  readonly covered: number;
  /** Non-boundary pixels where painter and reference disagree. */
  readonly mismatches: number;
  /** `mismatches / covered`. */
  readonly fraction: number;
  /** Per reference item index: non-boundary pixels the painter shows as something else. */
  readonly byItem: ReadonlyMap<number, number>;
  /** Worst per-item share: an item's wrong pixels over its reference pixels (≥ 5 px only). */
  readonly worstItem: number;
}

export function compare(ref: Int32Array, got: Int32Array, view: View): Comparison {
  const W = Math.round(view.w * view.scale);
  const Hh = Math.round(view.h * view.scale);
  let mismatches = 0;
  let covered = 0;
  const byItem = new Map<number, number>();
  const refCount = new Map<number, number>();
  for (const r of ref) {
    if (r >= 0) {
      covered++;
      refCount.set(r, (refCount.get(r) ?? 0) + 1);
    }
  }
  for (let y = 1; y < Hh - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      const r = ref[p]!;
      let boundary = false;
      for (let dy = -1; dy <= 1 && !boundary; dy++) {
        for (let dx = -1; dx <= 1; dx++) if (ref[p + dy * W + dx] !== r) boundary = true;
      }
      if (boundary || r === AMBIGUOUS || got[p] === r) continue;
      mismatches++;
      byItem.set(r, (byItem.get(r) ?? 0) + 1);
    }
  }
  let worstItem = 0;
  for (const [k, n] of byItem) {
    if (n >= 5) worstItem = Math.max(worstItem, n / Math.max(1, refCount.get(k) ?? 0));
  }
  return {
    pixels: W * Hh,
    covered,
    mismatches,
    fraction: mismatches / Math.max(1, covered),
    byItem,
    worstItem,
  };
}

/** Painter vs z-buffer at time t. */
export async function check(
  scene: Scene,
  result: DepthEpochResult,
  t: number,
  view: View,
  opts: PaintOptions = {},
): Promise<Comparison & { ref: Int32Array; got: Int32Array }> {
  const svg = paintSvg(scene, result, t, view, opts);
  const got = await painterIds(scene, svg, view);
  const ref = zbufferIds(scene, t, view);
  return { ...compare(ref, got, view), ref, got };
}

/** Item index (sorted keys) of a key. */
export function indexOf(scene: Scene, key: string): number {
  return [...scene.items]
    .map((i) => i.key)
    .sort()
    .indexOf(key);
}

/** Count of pixels showing item `idx`. */
export function count(ids: Int32Array, idx: number): number {
  let n = 0;
  for (const v of ids) if (v === idx) n++;
  return n;
}

export function box(x: number, y: number, z: number, sx: number, sy: number, sz: number): Box3 {
  return { origin: { x, y, z }, size: { x: sx, y: sy, z: sz } };
}

export function v(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}
