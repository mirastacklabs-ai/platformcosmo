/**
 * Pipeline outputs (ingestion §6.3, §6.4, §6.6): one clean template sprite per instance class,
 * the clean base (moved parts and annotations erased, filled from the other drawing), seat and
 * exploded positions in base pixels, the draw order, and the spec fragment.
 */
import { luminancePlane, type LuminancePlane } from "../locate.js";
import type { Raster } from "../raster.js";
import type { Analysis, Unit } from "./analyze.js";
import { inBox } from "./annotations.js";
import type { FigureState } from "./manifest.js";
import { blank, dilate, erode1, filter, has, labelMask, minus, union, type Mask } from "./mask.js";

export interface FigureOutputPart {
  /** The unit's group id: the figure part id of the spec. */
  readonly id: string;
  /** Index into `sprites`. */
  readonly sprite: number;
  /** Top-left of the sprite in base pixels, seated and exploded. */
  readonly seat: readonly [number, number];
  readonly exploded: readonly [number, number];
  readonly z?: number;
  /** A position not drawn in the figure (single-state figures). */
  readonly inferred?: "seat" | "exploded";
}

export interface FigureOutputs {
  readonly base: Raster;
  readonly sprites: readonly Raster[];
  readonly parts: readonly FigureOutputPart[];
}

const other = (s: FigureState): FigureState => (s === "exploded" ? "assembled" : "exploded");

/** The base model shared with the gate: what was erased and how each erased pixel is recovered. */
export interface BaseModel {
  /** Erased pixels in the base frame. */
  readonly erase: Mask;
  /** Colour from the other drawing, or undefined when no other depiction shows the pixel. */
  readonly recover: (x: number, y: number) => readonly [number, number, number] | undefined;
}

/** The components of `ink` (inside `hull`) with no raw-ink neighbour outside the hull. */
function endingInk(ink: Mask, hull: Mask, raw: Uint8Array, W: number, H: number): Mask {
  if (ink.w === 0) return ink;
  const lab = labelMask(ink);
  const runsOn = new Uint8Array(lab.count + 1);
  for (let j = 0; j < ink.h; j++) {
    for (let i = 0; i < ink.w; i++) {
      const l = lab.labels[j * ink.w + i]!;
      if (!l || runsOn[l]) continue;
      for (let dy = -1; dy <= 1 && !runsOn[l]; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = i + ink.x + dx;
          const y = j + ink.y + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          if (raw[y * W + x] && !has(hull, x, y)) {
            runsOn[l] = 1;
            break;
          }
        }
    }
  }
  return filter(ink, (x, y) => {
    const l = lab.labels[(y - ink.y) * ink.w + x - ink.x]!;
    return l > 0 && runsOn[l] === 0;
  });
}

export function baseModel(a: Analysis): BaseModel {
  const b = a.base;
  const st = a.img[b]!;
  // Each moved part's expected silhouette and its part ink in the hull, dilated by 1 (the
  // anti-aliased fringe goes with the part), where another drawing can restore what lies under
  // it. With one drawing nothing can: the silhouette goes, of the 1 px ring only fringe
  // (pixels that are not raw ink), so touching strokes of the board stay, and the part ink in
  // the hull that ends there (a lever tip the mask missed; a stroke running on out of the hull
  // is the board's).
  const twoStates = a.states.length === 2;
  const parts: Mask[] = a.units.map((u) => {
    const p = u.place[b]!;
    if (twoStates) return dilate(union(p.E, p.partInk), 1, st.W, st.H);
    return union(
      p.E,
      filter(dilate(p.E, 1, st.W, st.H), (x, y) => !st.rawInk[y * st.W + x]),
      endingInk(minus(p.partInk, p.E), p.hull, st.rawInk, st.W, st.H),
    );
  });
  const allowB = a.annotations.filter((g) => g.state === b).flatMap((g) => g.allowances);
  const partInk = union(...a.units.map((u) => u.place[b]!.partInk));
  const annErase: Mask[] = a.annotations
    .filter((g) => g.state === b)
    .map((g) => {
      const m = g.mask;
      const data = new Uint8Array(m.data);
      for (let j = 0; j < m.h; j++) {
        for (let i = 0; i < m.w; i++) {
          if (!data[j * m.w + i]) continue;
          const x = i + m.x;
          const y = j + m.y;
          if (has(partInk, x, y) && !allowB.some((q) => inBox(q, x, y))) data[j * m.w + i] = 0;
        }
      }
      return { ...m, data };
    });
  const erase = union(...parts, ...annErase);
  const o = a.states.includes(other(b)) ? other(b) : undefined;
  if (!o) return { erase, recover: () => undefined };
  const so = a.img[o]!;
  const [dx, dy] = a.d[o]!;
  // Recovery never copies a part (its silhouette or part ink, with its fringe) or an annotation.
  const blocked = union(
    ...a.units.map((u) => dilate(union(u.place[o]!.E, u.place[o]!.partInk), 1, so.W, so.H)),
    ...a.annotations.filter((g) => g.state === o).map((g) => g.mask),
  );
  return {
    erase,
    recover: (x, y) => {
      const qx = x + dx;
      const qy = y + dy;
      if (qx < 0 || qy < 0 || qx >= so.W || qy >= so.H || has(blocked, qx, qy)) return undefined;
      const q = (qy * so.W + qx) * 4;
      return [so.image.data[q]!, so.image.data[q + 1]!, so.image.data[q + 2]!];
    },
  };
}

/** Build options: `erase` overrides the manifest's (the broken-variant tests use "fill"). */
export interface BuildOptions {
  readonly erase?: "recover" | "fill";
}

export function buildOutputs(
  a: Analysis,
  options: BuildOptions = {},
): { outputs: FigureOutputs; filled: number } {
  const sprites = a.classes.map((c) => c.sprite);
  const b = a.base;
  const st = a.img[b]!;
  const model = baseModel(a);
  const erase = options.erase ?? a.manifest.erase ?? "recover";
  const data = new Uint8Array(st.image.data);
  let filled = 0;
  const m = model.erase;
  for (let j = 0; j < m.h; j++) {
    for (let i = 0; i < m.w; i++) {
      if (!m.data[j * m.w + i]) continue;
      const x = i + m.x;
      const y = j + m.y;
      const c = erase === "recover" ? model.recover(x, y) : undefined;
      const o = (y * st.W + x) * 4;
      const col = c ?? st.background;
      if (!c) filled++;
      data[o] = col[0];
      data[o + 1] = col[1];
      data[o + 2] = col[2];
      data[o + 3] = 255;
    }
  }
  const base: Raster = { width: st.W, height: st.H, data };
  const plane = luminancePlane(base);
  // The seat search of exploded-only figures shares the matcher budget (3 per ring pixel).
  const budget = { left: a.maxMultiplyAdds };
  const parts = a.units.map((u) => positions(a, u, sprites[u.cls]!, base, plane, budget));
  return { outputs: { base, sprites, parts: drawOrder(a, parts, sprites) }, filled };
}

export interface RingTemplate {
  /** Offsets from the sprite's top-left (the ring reaches 2 px outside it). */
  readonly dx: Int32Array;
  readonly dy: Int32Array;
  /** Mean-removed template values (dark inside, light outside). */
  readonly t: Float32Array;
  readonly denT: number;
  readonly w: number;
  readonly h: number;
}

/** Silhouette ring template of a sprite: 2 px inside (dark) and 2 px outside (light), built once. */
export function ringTemplate(sprite: Raster): RingTemplate {
  const w = sprite.width + 4;
  const h = sprite.height + 4;
  const O = blank(0, 0, w, h);
  for (let y = 0; y < sprite.height; y++) {
    for (let x = 0; x < sprite.width; x++)
      if (sprite.data[(y * sprite.width + x) * 4 + 3]) O.data[(y + 2) * w + x + 2] = 1;
  }
  const inner = erode1(erode1(O));
  const outer = dilate(O, 2, w, h);
  const dx: number[] = [];
  const dy: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < w * h; i++) {
    const inO = O.data[i] === 1;
    const ring = inO ? !inner.data[i] : has(outer, i % w, Math.floor(i / w));
    if (!ring) continue;
    dx.push((i % w) - 2);
    dy.push(Math.floor(i / w) - 2);
    v.push(inO ? 0 : 255);
  }
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const t = Float32Array.from(v, (x) => x - mean);
  let denT = 0;
  for (const x of t) denT += x * x;
  return { dx: Int32Array.from(dx), dy: Int32Array.from(dy), t, denT, w, h };
}

/** Ring NCC with the sprite's top-left at (x, y); undefined when the ring leaves the plane. */
function ringNcc(plane: LuminancePlane, r: RingTemplate, x: number, y: number): number | undefined {
  if (x - 2 < 0 || y - 2 < 0 || x - 2 + r.w > plane.width || y - 2 + r.h > plane.height)
    return undefined;
  const n = r.t.length;
  if (n === 0 || r.denT <= 0) return 0;
  let ss = 0;
  let sss = 0;
  let sts = 0;
  for (let i = 0; i < n; i++) {
    const v = plane.data[(y + r.dy[i]!) * plane.width + x + r.dx[i]!]!;
    ss += v;
    sss += v * v;
    sts += r.t[i]! * v;
  }
  const varS = sss - (ss * ss) / n;
  if (varS <= 1e-6 * n) return 0;
  return Math.round((sts / Math.sqrt(r.denT * varS)) * 1e6) / 1e6;
}

/** Best ring NCC with the sprite's top-left within ±r of (x, y); -1 when none fits. */
export function ringScore(
  plane: LuminancePlane,
  ring: RingTemplate,
  x: number,
  y: number,
  r: number,
): number {
  let best = -1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const v = ringNcc(plane, ring, x + dx, y + dy);
      if (v !== undefined && v > best) best = v;
    }
  }
  return best;
}

function positions(
  a: Analysis,
  u: Unit,
  sprite: Raster,
  base: Raster,
  plane: LuminancePlane,
  budget: { left: number },
): FigureOutputPart {
  const inBase = (s: FigureState): [number, number] => {
    const p = u.place[s]!;
    const [dx, dy] = a.d[s]!;
    return [p.x - dx, p.y - dy];
  };
  const lift = Math.round(sprite.height * 1.2);
  if (a.states.length === 2) {
    return { id: u.id, sprite: u.cls, seat: inBase("assembled"), exploded: inBase("exploded") };
  }
  if (a.states[0] === "assembled") {
    const seat = inBase("assembled");
    return {
      id: u.id,
      sprite: u.cls,
      seat,
      exploded: [seat[0], seat[1] - lift],
      inferred: "exploded",
    };
  }
  // Exploded only: follow the first arrow that touches the part to the best silhouette match.
  const ex = inBase("exploded");
  const st = a.img.exploded!;
  const E = dilate(u.place.exploded!.E, 4, st.W, st.H);
  let seat: [number, number] = [ex[0], ex[1] + lift];
  for (const g of a.annotations) {
    if (g.kind !== "arrow" || g.state !== "exploded") continue;
    const ends = [g.points[0]!, g.points[g.points.length - 1]!];
    const touch = ends.findIndex(([x, y]) => has(E, Math.round(x), Math.round(y)));
    if (touch < 0) continue;
    const c = ends[touch]!;
    const f = ends[1 - touch]!;
    const L = Math.hypot(f[0] - c[0], f[1] - c[1]);
    if (L === 0) continue;
    const ux = (f[0] - c[0]) / L;
    const uy = (f[1] - c[1]) / L;
    const ring = ringTemplate(sprite);
    let best = -1;
    let at: [number, number] = [Math.round(ex[0] + f[0] - c[0]), Math.round(ex[1] + f[1] - c[1])];
    const reach = Math.ceil(L + 2 * (sprite.width + sprite.height));
    for (let t = Math.floor(L); t <= reach; t++) {
      const px = Math.round(ex[0] + ux * t);
      const py = Math.round(ex[1] + uy * t);
      if (px < 0 || py < 0 || px + sprite.width > base.width || py + sprite.height > base.height)
        continue;
      const cost = 3 * ring.t.length;
      if (budget.left < cost) break;
      budget.left -= cost;
      const v = ringScore(plane, ring, px, py, 0);
      if (v > best) {
        best = v;
        at = [px, py];
      }
    }
    seat = at;
    break;
  }
  return { id: u.id, sprite: u.cls, seat, exploded: ex, inferred: "seat" };
}

/** Default draw key of the renderer: z, then the seat's bottom edge, then spec order. */
export function drawKey(
  p: FigureOutputPart,
  spriteH: number,
  index: number,
): [number, number, number] {
  return [p.z ?? 0, p.seat[1] + spriteH, index];
}

export function renderOrder(
  parts: readonly FigureOutputPart[],
  sprites: readonly Raster[],
): number[] {
  const keys = parts.map((p, i) => drawKey(p, sprites[p.sprite]?.height ?? 0, i));
  return parts
    .map((_, i) => i)
    .sort(
      (x, y) => keys[x]![0] - keys[y]![0] || keys[x]![1] - keys[y]![1] || keys[x]![2] - keys[y]![2],
    );
}

/** Applies the manifest's z, or assigns z when the drawing's occlusions contradict the default order. */
function drawOrder(
  a: Analysis,
  parts: FigureOutputPart[],
  sprites: readonly Raster[],
): FigureOutputPart[] {
  const withZ = parts.map((p, i) => (a.units[i]!.z !== undefined ? { ...p, z: a.units[i]!.z } : p));
  if (a.units.some((u) => u.z !== undefined)) return withZ;
  const rel: [number, number][] = [];
  for (const s of a.states) {
    for (const r of a.front[s] ?? []) {
      const [f, b] = r.split(">").map(Number) as [number, number];
      rel.push([f, b]);
    }
  }
  rel.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const order = renderOrder(withZ, sprites);
  const rank = new Map(order.map((u, k) => [u, k]));
  if (rel.every(([f, b]) => rank.get(f)! > rank.get(b)!)) return withZ;
  // Topological order (behind first), ties by the default order.
  const placed: number[] = [];
  const left = new Set(order);
  while (left.size > 0) {
    let pick: number | undefined;
    for (const u of order) {
      if (!left.has(u)) continue;
      if (rel.every(([f, b]) => f !== u || !left.has(b))) {
        pick = u;
        break;
      }
    }
    pick ??= order.find((u) => left.has(u))!;
    placed.push(pick);
    left.delete(pick);
  }
  return withZ.map((p, i) => ({ ...p, z: placed.indexOf(i) }));
}
