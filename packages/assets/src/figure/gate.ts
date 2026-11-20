/**
 * The quality gate (ingestion §6.5). Re-renders every drawn state from the outputs (base plus
 * each sprite at its seat or exploded position, no redrawn hints), compares it with the source
 * drawing after alignment, and runs every check of the §6.5 table against the reference
 * analysis. All residual metrics are local: the largest connected component (8-connectivity),
 * in pixels, with declared annotations excluded but connective.
 */
import type { Diagnostic } from "@platformcosmo/core";
import { crop } from "../ops.js";
import { nccAt, luminancePlane } from "../locate.js";
import { checkRaster, err, luminanceOverWhite, type Raster } from "../raster.js";
import { clipMask, spriteLum, thresholds, type Analysis, type Unit } from "./analyze.js";
import { baseModel, renderOrder, ringScore, ringTemplate, type FigureOutputs } from "./build.js";
import type { FigureState } from "./manifest.js";
import {
  EMPTY,
  blank,
  bounds,
  byPixels,
  clipBox,
  components,
  count,
  dilate,
  filter,
  has,
  holes,
  overlapCount,
  shifted,
  type Box,
  type Component,
  type Mask,
} from "./mask.js";
import { lumOf } from "./state.js";

export type CheckStatus = "pass" | "fail" | "warn" | "not-run";

export interface CheckItem {
  readonly state?: FigureState;
  readonly part?: string;
  readonly annotation?: number;
  readonly pixels?: number;
  readonly score?: number;
  readonly bbox?: Box;
  readonly reason?: string;
}

export interface CheckEntry {
  readonly check: string;
  readonly code: string;
  readonly status: CheckStatus;
  /** The worst measured value (pixels, or a score for NCC checks). */
  readonly value: number;
  readonly limit: number;
  readonly items: readonly CheckItem[];
}

export interface FigureReport {
  readonly schema: "platformcosmo/figure-report@1";
  readonly ok: boolean;
  readonly confidence: "full" | "reduced";
  readonly strict: boolean;
  readonly states: readonly FigureState[];
  readonly base: FigureState;
  readonly notRun: readonly string[];
  readonly alignment: {
    readonly dx: number;
    readonly dy: number;
    readonly score: number;
    readonly support: number;
  } | null;
  readonly checks: readonly CheckEntry[];
  readonly annotations: readonly {
    readonly index: number;
    readonly kind: string;
    readonly state: FigureState;
    readonly medianRun: number;
    readonly halfWidth: number;
    readonly onInk: number;
    readonly arrowhead: boolean;
    readonly valid: boolean;
  }[];
  readonly excluded: Partial<
    Record<FigureState, { readonly pixels: number; readonly fraction: number }>
  >;
  readonly parts: readonly {
    readonly id: string;
    readonly parts: readonly string[];
    readonly sprite: number;
    readonly seat: readonly [number, number];
    readonly exploded: readonly [number, number];
    readonly z?: number;
    readonly inferred?: string;
    readonly standalone: FigureState | null;
    readonly template: boolean;
    /** The drawing the sprite was cut from (the template depiction's state). */
    readonly source: FigureState;
  }[];
  readonly residualRisk: string;
  readonly diagnostics: readonly Diagnostic[];
}

const MAX_ITEMS = 20;
const RESIDUAL_RISK =
  "Only for a part that stands alone in no state (asset/hull-uncertain) could a stroke missed by segmentation " +
  "outside its mask-and-prior hull, ending at a declared text rectangle, still be declared as a leader; the " +
  "exclusion overlay and the verification renders are the backstop.";

const r1 = (v: number): number => Math.round(v * 1000) / 1000;
/** Code-unit string order (no locale: the report must not depend on the host). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Composites `sprite` over `dst` (straight alpha) with its top-left at (x, y); marks coverage. */
function over(
  dst: Raster,
  sprite: Raster,
  x: number,
  y: number,
  cover?: Uint8Array,
  top?: Int16Array,
  rank = 0,
): void {
  for (let j = 0; j < sprite.height; j++) {
    const gy = y + j;
    if (gy < 0 || gy >= dst.height) continue;
    for (let i = 0; i < sprite.width; i++) {
      const gx = x + i;
      if (gx < 0 || gx >= dst.width) continue;
      const s = (j * sprite.width + i) * 4;
      const a = sprite.data[s + 3]!;
      if (a === 0) continue;
      const d = (gy * dst.width + gx) * 4;
      if (a === 255) {
        dst.data[d] = sprite.data[s]!;
        dst.data[d + 1] = sprite.data[s + 1]!;
        dst.data[d + 2] = sprite.data[s + 2]!;
        dst.data[d + 3] = 255;
      } else {
        for (let c = 0; c < 3; c++)
          dst.data[d + c] = Math.round(
            (sprite.data[s + c]! * a + dst.data[d + c]! * (255 - a)) / 255,
          );
        dst.data[d + 3] = 255;
      }
      if (cover) cover[gy * dst.width + gx] = 1;
      if (top) top[gy * dst.width + gx] = rank;
    }
  }
}

/**
 * The gate's re-render of state `s`: the state's canvas filled with the background, the base at
 * the alignment offset, then every sprite at its position in the renderer's draw order (z, the
 * seat's bottom edge, spec order). For integer positions and binary alpha this equals resvg's
 * rendering of the spec fragment (tested).
 */
export function rerender(
  a: Analysis,
  out: FigureOutputs,
  s: FigureState,
): { image: Raster; cover: Uint8Array; top: Int16Array } {
  const st = a.img[s]!;
  const [dx, dy] = a.d[s]!;
  const data = new Uint8Array(st.W * st.H * 4);
  for (let i = 0; i < st.W * st.H; i++) {
    data[i * 4] = st.background[0];
    data[i * 4 + 1] = st.background[1];
    data[i * 4 + 2] = st.background[2];
    data[i * 4 + 3] = 255;
  }
  const image: Raster = { width: st.W, height: st.H, data };
  over(image, out.base, dx, dy);
  const cover = new Uint8Array(st.W * st.H);
  // top[q] = 1 + draw rank of the last sprite covering q (0 = none).
  const top = new Int16Array(st.W * st.H);
  renderOrder(out.parts, out.sprites).forEach((k, rank) => {
    const p = out.parts[k]!;
    const pos = s === "assembled" ? p.seat : p.exploded;
    const x = Math.round(pos[0]) + dx;
    const y = Math.round(pos[1]) + dy;
    over(image, out.sprites[p.sprite]!, x, y, cover, top, rank + 1);
  });
  return { image, cover, top };
}

/** Residual pixels (|Δ luminance| > limit with a 3x3 tolerance both ways). */
function residualMap(
  A: Uint8Array,
  B: Uint8Array,
  W: number,
  H: number,
  limit: number,
): Uint8Array {
  const out = new Uint8Array(W * H);
  const near = (P: Uint8Array, Q: Uint8Array, x: number, y: number): boolean => {
    const v = P[y * W + x]!;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        if (Math.abs(v - Q[yy * W + xx]!) <= limit) return true;
      }
    }
    return false;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (Math.abs(A[i]! - B[i]!) <= limit) continue;
      if (!near(A, B, x, y) || !near(B, A, x, y)) out[i] = 1;
    }
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const rasterLike = (v: unknown): v is Raster => isObj(v) && v.data instanceof Uint8Array;

/** Structural check of untrusted outputs (`assets check` reads them from disk). */
function validOutputs(a: Analysis, out: unknown): Diagnostic | undefined {
  const bad = (msg: string): Diagnostic =>
    err("asset/bad-option", msg, { params: { option: "outputs" } });
  const st = a.img[a.base]!;
  if (!isObj(out)) return bad("the outputs are missing");
  if (!rasterLike(out.base)) return bad("the outputs have no base image");
  const b = checkRaster(out.base, "the base");
  if (b) return b;
  if (out.base.width !== st.W || out.base.height !== st.H) {
    return bad(
      `the base is ${out.base.width}x${out.base.height}, the ${a.base} drawing is ${st.W}x${st.H}`,
    );
  }
  const sprites = out.sprites;
  if (!Array.isArray(sprites) || sprites.length < 1 || sprites.length > 64)
    return bad("there must be 1 to 64 sprites");
  // Bounded work: no sprite larger than the largest drawing, and all sprites together at most
  // 8 drawings' worth of pixels (the gate allocates per sprite and state).
  let maxW = 0;
  let maxH = 0;
  let area = 0;
  for (const s of a.states) {
    maxW = Math.max(maxW, a.img[s]!.W);
    maxH = Math.max(maxH, a.img[s]!.H);
    area += a.img[s]!.W * a.img[s]!.H;
  }
  let total = 0;
  for (const s of sprites) {
    if (!rasterLike(s)) return bad("a sprite is not an image");
    const e = checkRaster(s, "a sprite");
    if (e) return e;
    if (s.width > maxW || s.height > maxH) {
      return bad(`a sprite of ${s.width}x${s.height} is larger than the drawings`);
    }
    for (let i = 3; i < s.data.length; i += 4) {
      if (s.data[i] !== 0 && s.data[i] !== 255) return bad("sprite alpha must be 0 or 255");
    }
    total += s.width * s.height;
  }
  for (let i = 3; i < out.base.data.length; i += 4) {
    if (out.base.data[i] !== 255) return bad("the base must be opaque");
  }
  if (total > 8 * area) return bad("the sprites together are larger than eight drawings");
  const parts = out.parts;
  if (!Array.isArray(parts) || parts.length !== a.units.length)
    return bad(`there must be one output part per group (${a.units.length})`);
  // Integer positions and binary alpha: the composite equals resvg's rendering only then.
  const pos = (v: unknown): boolean =>
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= 100000);
  for (let i = 0; i < parts.length; i++) {
    const p: unknown = parts[i];
    if (!isObj(p)) return bad(`output part ${i} is not an object`);
    if (p.id !== a.units[i]!.id)
      return bad(
        `output part ${i} is "${String(p.id).slice(0, 64)}", expected "${a.units[i]!.id}"`,
      );
    if (
      typeof p.sprite !== "number" ||
      !Number.isInteger(p.sprite) ||
      p.sprite < 0 ||
      p.sprite >= sprites.length
    ) {
      return bad(`output part ${a.units[i]!.id} has no sprite`);
    }
    if (!pos(p.seat) || !pos(p.exploded))
      return bad(`output part ${a.units[i]!.id} needs a finite seat and exploded position`);
    if (p.inferred !== undefined && p.inferred !== "seat" && p.inferred !== "exploded") {
      return bad(`output part ${a.units[i]!.id} has an invalid "inferred"`);
    }
    if (
      p.z !== undefined &&
      !(typeof p.z === "number" && Number.isInteger(p.z) && Math.abs(p.z) <= 1000)
    ) {
      return bad(`output part ${a.units[i]!.id} has an invalid z`);
    }
  }
  return undefined;
}

/** Runs the gate. */
export function runGate(a: Analysis, out: FigureOutputs): FigureReport {
  const T = thresholds(a.strict);
  const checks: CheckEntry[] = [];
  const diagnostics: Diagnostic[] = [...a.diagnostics];
  const invalidOut = validOutputs(a, out);
  if (invalidOut) diagnostics.push(invalidOut);
  const states = a.states;
  const b = a.base;
  const sb = a.img[b]!;
  const model = baseModel(a);
  const posIn = (k: number, s: FigureState): [number, number] => {
    const p = out.parts[k]!;
    const q = s === "assembled" ? p.seat : p.exploded;
    return [Math.round(q[0]) + a.d[s]![0], Math.round(q[1]) + a.d[s]![1]];
  };
  const unitOf = (k: number): Unit => a.units[k]!;
  const usable = !invalidOut;

  const entry = (
    check: string,
    code: string,
    items: CheckItem[],
    limit: number,
    severity: "error" | "warning" | "info",
    opts: { notRun?: boolean; value?: number; message?: (i: CheckItem) => string } = {},
  ): void => {
    const sorted = [...items].sort(
      (x, y) =>
        (y.pixels ?? 0) - (x.pixels ?? 0) ||
        cmp(x.state ?? "", y.state ?? "") ||
        cmp(x.part ?? "", y.part ?? "") ||
        (x.annotation ?? -1) - (y.annotation ?? -1) ||
        (x.bbox?.y ?? 0) - (y.bbox?.y ?? 0) ||
        (x.bbox?.x ?? 0) - (y.bbox?.x ?? 0) ||
        cmp(x.reason ?? "", y.reason ?? ""),
    );
    const status: CheckStatus = opts.notRun
      ? "not-run"
      : items.length === 0
        ? "pass"
        : severity === "error"
          ? "fail"
          : "warn";
    const value = opts.value ?? sorted.reduce((m, i) => Math.max(m, i.pixels ?? 0), 0);
    checks.push({ check, code, status, value, limit, items: sorted.slice(0, MAX_ITEMS) });
    for (const it of sorted.slice(0, MAX_ITEMS)) {
      diagnostics.push({
        severity,
        code,
        path: it.annotation !== undefined ? `/annotations/${it.annotation}` : "",
        message: opts.message
          ? opts.message(it)
          : `${check}${it.part ? ` (${it.part})` : ""}${it.state ? ` in the ${it.state} drawing` : ""}: ${it.reason ?? `${it.pixels} px`}`,
        params: {
          ...(it.state ? { state: it.state } : {}),
          ...(it.part ? { part: it.part } : {}),
          ...(it.pixels !== undefined ? { pixels: it.pixels, limit } : {}),
          ...(it.score !== undefined ? { score: it.score, limit } : {}),
          ...(it.bbox ? { bbox: it.bbox } : {}),
        },
      });
    }
  };

  // ---- residuals per state
  const renders: Partial<Record<FigureState, ReturnType<typeof rerender>>> = {};
  for (const s of ["assembled", "exploded"] as const) {
    const code = `asset/${s}-residual`;
    if (!states.includes(s)) {
      entry(`${s}-residual`, code, [], T.residual, "error", { notRun: true });
      continue;
    }
    if (!usable) {
      entry(`${s}-residual`, code, [], T.residual, "error", { notRun: true });
      continue;
    }
    const st = a.img[s]!;
    const r = rerender(a, out, s);
    renders[s] = r;
    const L = luminanceOverWhite(r.image);
    const res = residualMap(st.lum, L, st.W, st.H, T.luminance);
    const X = a.excluded[s]!;
    const isRes = (x: number, y: number): boolean => res[y * st.W + x] === 1 && !has(X, x, y);
    const comps = components(
      { x: 0, y: 0, w: st.W, h: st.H },
      (x, y) => res[y * st.W + x] === 1 || has(X, x, y),
      8,
      isRes,
    );
    const items: CheckItem[] = comps
      .filter((c) => c.pixels > T.residual)
      .sort(byPixels)
      .map((c) => ({ state: s, pixels: c.pixels, bbox: c.box }));
    // Residual pixels touching each annotation band (within 2 px of its mask), per band.
    for (const g of a.annotations) {
      const [dx, dy] = [a.d[s]![0] - a.d[g.state]![0], a.d[s]![1] - a.d[g.state]![1]];
      const near = dilate(shifted(g.mask, dx, dy), 2, st.W, st.H);
      let n = 0;
      for (let j = 0; j < near.h; j++)
        for (let i = 0; i < near.w; i++)
          if (near.data[j * near.w + i] && isRes(i + near.x, j + near.y)) n++;
      if (n > T.residual)
        items.push({
          state: s,
          annotation: g.index,
          pixels: n,
          ...(bounds(near) ? { bbox: bounds(near)! } : {}),
          reason: `${n} residual px touch annotation ${g.index}`,
        });
    }
    entry(`${s}-residual`, code, items, T.residual, "error");
  }

  // Output geometry: placed sprite masks per part and state.
  const spriteInk = (k: number, s: FigureState): Mask => {
    const sp = out.sprites[out.parts[k]!.sprite]!;
    const [px, py] = posIn(k, s);
    const st = a.img[s]!;
    const m = blank(px, py, sp.width, sp.height);
    for (let j = 0; j < sp.height; j++) {
      for (let i = 0; i < sp.width; i++) {
        const o = (j * sp.width + i) * 4;
        if (!sp.data[o + 3]) continue;
        const lum = Math.round(
          0.299 * sp.data[o]! + 0.587 * sp.data[o + 1]! + 0.114 * sp.data[o + 2]!,
        );
        const al = sp.data[o + 3]!;
        const over = Math.round((lum * al + 255 * (255 - al)) / 255);
        if (over < st.threshold) m.data[j * sp.width + i] = 1;
      }
    }
    return m;
  };
  const opaque = (k: number, s: FigureState): Mask => {
    const sp = out.sprites[out.parts[k]!.sprite]!;
    const [px, py] = posIn(k, s);
    const m = blank(px, py, sp.width, sp.height);
    for (let i = 0; i < m.data.length; i++) m.data[i] = sp.data[i * 4 + 3]! > 0 ? 1 : 0;
    return m;
  };

  // ---- leftover fragments
  {
    const items: CheckItem[] = [];
    if (usable) {
      const basePlane = luminancePlane(out.base);
      const outLum = luminanceOverWhite(out.base);
      const t = sb.threshold;
      for (let k = 0; k < a.units.length; k++) {
        const u = unitOf(k);
        const region = dilate(u.place[b]!.E, 1, sb.W, sb.H);
        const cand = (x: number, y: number): boolean => {
          if (!has(region, x, y) || outLum[y * sb.W + x]! >= t) return false;
          const rec = model.recover(x, y);
          return !(rec && lumOf(rec) < t);
        };
        const comps = components(region, cand, 8).filter((c) => c.pixels >= T.leftover);
        const sp = out.sprites[out.parts[k]!.sprite]!;
        const [px, py] = posIn(k, b);
        for (const c of comps) {
          const box = clipBox(
            { x: c.box.x - 2, y: c.box.y - 2, w: c.box.w + 4, h: c.box.h + 4 },
            sb.W,
            sb.H,
          );
          const sbx = clipBox(
            { x: box.x - px, y: box.y - py, w: box.w, h: box.h },
            sp.width,
            sp.height,
          );
          if (sbx.w <= 0 || sbx.h <= 0) continue;
          const sub = crop(sp, sbx).value;
          if (!sub) continue;
          const candBox = blank(c.box.x, c.box.y, c.box.w, c.box.h);
          for (let j = 0; j < candBox.h; j++)
            for (let i = 0; i < candBox.w; i++)
              if (cand(i + candBox.x, j + candBox.y)) candBox.data[j * candBox.w + i] = 1;
          const wm = dilate(candBox, 2, sb.W, sb.H);
          const weights = new Uint8Array(sub.width * sub.height);
          for (let j = 0; j < sub.height; j++) {
            for (let i = 0; i < sub.width; i++) {
              if (sub.data[(j * sub.width + i) * 4 + 3] && has(wm, sbx.x + px + i, sbx.y + py + j))
                weights[j * sub.width + i] = 255;
            }
          }
          const v = nccAt(basePlane, sub, sbx.x + px, sbx.y + py, weights);
          if (v !== undefined && v >= T.leftoverNcc)
            items.push({ state: b, part: u.id, pixels: c.pixels, score: r1(v), bbox: c.box });
        }
      }
    }
    entry("leftover-fragment", "asset/leftover-fragment", items, T.leftover, "error");
  }

  // ---- foreign pixels (against each state's OWN segmentation, never the template), rect
  // masks, holes, connectivity. A sprite ink pixel that is visible on top in a re-render is
  // foreign unless it lies on the unit's own regions there (seeded regions, enclosed regions and
  // bounding ink; the whole silhouette where the unit stands alone), or continues them on ink
  // that the drawing itself shows at that place (strokes segmentation missed).
  const foreignAny = new Set<number>();
  {
    const items: CheckItem[] = [];
    if (usable) {
      const order = renderOrder(out.parts, out.sprites);
      for (let k = 0; k < a.units.length; k++) {
        const u = unitOf(k);
        const sp = out.sprites[out.parts[k]!.sprite]!;
        const rank = order.indexOf(k) + 1;
        for (const s of states) {
          const dp = u.dep[s];
          const r = renders[s];
          if (!dp || !r) continue;
          const st = a.img[s]!;
          const [px, py] = posIn(k, s);
          const inkM = spriteInk(k, s);
          const top = (x: number, y: number): boolean =>
            x >= 0 && y >= 0 && x < st.W && y < st.H && r.top[y * st.W + x] === rank;
          const agrees = (x: number, y: number): boolean => {
            const v = spriteLum(sp, x - px, y - py);
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const qx = x + dx;
                const qy = y + dy;
                if (qx < 0 || qy < 0 || qx >= st.W || qy >= st.H) continue;
                if (Math.abs(st.lum[qy * st.W + qx]! - v) <= T.luminance) return true;
              }
            }
            return false;
          };
          const own0 = dilate(dp.V, 1, st.W, st.H);
          const ext = filter(
            inkM,
            (x, y) => !has(own0, x, y) && st.ink[y * st.W + x] !== 0 && agrees(x, y),
          );
          // Continuations: consistent ink 8-connected to the own regions.
          const reach = blank(ext.x, ext.y, ext.w, ext.h);
          const stack: number[] = [];
          for (let j = 0; j < ext.h; j++) {
            for (let i = 0; i < ext.w; i++) {
              if (!ext.data[j * ext.w + i]) continue;
              const x = i + ext.x;
              const y = j + ext.y;
              let adj = false;
              for (let dy = -1; dy <= 1 && !adj; dy++)
                for (let dx = -1; dx <= 1; dx++) if (has(own0, x + dx, y + dy)) adj = true;
              if (adj) {
                reach.data[j * ext.w + i] = 1;
                stack.push(j * ext.w + i);
              }
            }
          }
          while (stack.length > 0) {
            const q = stack.pop()!;
            const i = q % ext.w;
            const j = (q - i) / ext.w;
            for (let dj = -1; dj <= 1; dj++) {
              for (let di = -1; di <= 1; di++) {
                const a2 = i + di;
                const b2 = j + dj;
                if (a2 < 0 || b2 < 0 || a2 >= ext.w || b2 >= ext.h) continue;
                const q2 = b2 * ext.w + a2;
                if (reach.data[q2] || !ext.data[q2]) continue;
                reach.data[q2] = 1;
                stack.push(q2);
              }
            }
          }
          const f = (x: number, y: number): boolean =>
            has(inkM, x, y) && top(x, y) && !has(own0, x, y) && !has(reach, x, y);
          const comps = components(inkM, f, 8);
          if (comps.some((c) => c.pixels > 0)) foreignAny.add(k);
          for (const c of comps.filter((c) => c.pixels >= T.foreign).sort(byPixels))
            items.push({ state: s, part: u.id, pixels: c.pixels, bbox: c.box });
        }
      }
    }
    entry("foreign-pixels", "asset/foreign-pixels", items, T.foreign, "error");
  }
  {
    const holeItems: CheckItem[] = [];
    const rectItems: CheckItem[] = [];
    const groupItems: CheckItem[] = [];
    if (usable) {
      for (let k = 0; k < a.units.length; k++) {
        const u = unitOf(k);
        const m = opaque(k, b);
        const local = shifted(m, -m.x, -m.y);
        if (!u.holes) {
          const hm = holes(local);
          const n = count(hm);
          if (n > 0)
            holeItems.push({ part: u.id, pixels: n, ...(bounds(hm) ? { bbox: bounds(hm)! } : {}) });
        }
        const bb = bounds(local);
        if (bb && count(local) === bb.w * bb.h && foreignAny.has(k)) {
          rectItems.push({
            part: u.id,
            pixels: bb.w * bb.h,
            bbox: { x: m.x + bb.x, y: m.y + bb.y, w: bb.w, h: bb.h },
            reason: `${u.id}'s sprite is a full rectangle that carries ink not its own`,
          });
        }
        if (!u.allowDisjoint) {
          const comps = components(local, (x, y) => has(local, x, y), 8);
          if (comps.length > 1)
            groupItems.push({
              part: u.id,
              pixels: comps.length,
              reason: `${u.id}'s sprite has ${comps.length} separate pieces`,
            });
        }
      }
    }
    entry("mask-hole", "asset/mask-hole", holeItems, 0, "error");
    entry("rect-mask", "asset/rect-mask", rectItems, 0, "error");
    entry("group-disconnected", "asset/group-disconnected", groupItems, 1, "error");
  }

  // ---- instance assignment
  {
    const items: CheckItem[] = [];
    const ambiguous: string[] = [];
    if (usable) {
      for (const c of a.classes) {
        if (c.units.length < 2) continue;
        for (const s of states) {
          const st = a.img[s]!;
          const placed = (k: number): Mask => {
            const [x, y] = posIn(k, s);
            return shifted(c.mask, x - c.mask.x, y - c.mask.y);
          };
          const cost = (u: Unit, k: number): number => {
            const m = dilate(placed(k), 1, st.W, st.H);
            const miss = (u.seeds[s] ?? []).filter(([x, y]) => !has(m, x, y)).length;
            const n = u.nearest[s];
            const [x, y] = posIn(k, s);
            const dist = n ? Math.hypot(x + c.mask.w / 2 - n[0], y + c.mask.h / 2 - n[1]) : 0;
            return miss * 1e6 + Math.round(dist);
          };
          for (let ii = 0; ii < c.units.length; ii++) {
            for (let jj = ii + 1; jj < c.units.length; jj++) {
              const ka = c.units[ii]!;
              const kb = c.units[jj]!;
              const hint = (u: Unit): boolean =>
                (u.seeds[s]?.length ?? 0) > 0 || u.nearest[s] !== undefined;
              if (!hint(unitOf(ka)) && !hint(unitOf(kb)) && ambiguous.length < MAX_ITEMS) {
                ambiguous.push(`${unitOf(ka).id} and ${unitOf(kb).id} (${s})`);
              }
              const ma = placed(ka);
              const mb = placed(kb);
              const ov = overlapCount(ma, mb);
              const iou = ov / (count(ma) + count(mb) - ov || 1);
              const ua = unitOf(ka);
              const ub = unitOf(kb);
              if (iou > 0.8) {
                items.push({
                  state: s,
                  part: `${ua.id}, ${ub.id}`,
                  reason: `${ua.id} and ${ub.id} are assigned to the same peak in the ${s} drawing`,
                  ...(bounds(ma) ? { bbox: bounds(ma)! } : {}),
                });
              } else if (cost(ua, kb) + cost(ub, ka) < cost(ua, ka) + cost(ub, kb)) {
                items.push({
                  state: s,
                  part: `${ua.id}, ${ub.id}`,
                  reason: `swapping ${ua.id} and ${ub.id} in the ${s} drawing fits their seeds and hints better`,
                  ...(bounds(ma) ? { bbox: bounds(ma)! } : {}),
                });
              }
            }
          }
        }
      }
    }
    entry("instance-swap", "asset/instance-swap", items, 0, "error");
    for (const pair of ambiguous) {
      diagnostics.push({
        severity: "warning",
        code: "asset/ambiguous",
        path: "",
        message: `instances ${pair} have no seeds or nearest hint there, so their assignment is unverified`,
        suggestion: "add seeds or a nearest hint for each instance in every drawn state",
      });
    }
  }

  // ---- unrecovered base
  {
    const items: CheckItem[] = [];
    let invisible = 0;
    if (usable) {
      const outLum = luminanceOverWhite(out.base);
      const Lbg = sb.backgroundLum;
      const Z = model.erase;
      // Visible in a re-render where that drawing shows something other than background there.
      const visible = (x: number, y: number): boolean =>
        states.some((s) => {
          const r = renders[s];
          if (!r) return false;
          const st = a.img[s]!;
          const qx = x + a.d[s]![0];
          const qy = y + a.d[s]![1];
          if (qx < 0 || qy < 0 || qx >= st.W || qy >= st.H) return false;
          const q = qy * st.W + qx;
          return (
            !r.cover[q] && !has(a.excluded[s]!, qx, qy) && Math.abs(st.lum[q]! - Lbg) > T.luminance
          );
        });
      const cand = (x: number, y: number): boolean => {
        if (!has(Z, x, y) || Math.abs(outLum[y * sb.W + x]! - Lbg) > T.luminance) return false;
        const rec = model.recover(x, y);
        return !rec || Math.abs(lumOf(rec) - Lbg) > T.luminance;
      };
      const comps = components(Z, (x, y) => cand(x, y) && visible(x, y), 8);
      for (const c of comps.filter((c) => c.pixels > T.unrecovered).sort(byPixels))
        items.push({ state: b, pixels: c.pixels, bbox: c.box });
      for (let j = 0; j < Z.h; j++)
        for (let i = 0; i < Z.w; i++)
          if (Z.data[j * Z.w + i] && cand(i + Z.x, j + Z.y) && !visible(i + Z.x, j + Z.y))
            invisible++;
    }
    entry("base-unrecovered", "asset/base-unrecovered", items, T.unrecovered, "error");
    if (invisible > 0) {
      diagnostics.push({
        severity: "info",
        code: "asset/base-unrecovered",
        path: "",
        message: `${invisible} erased base pixels were filled with the background where no re-render shows other content`,
        params: { pixels: invisible },
      });
    }
  }

  // ---- unrecovered occlusion (missing silhouette pixels visible in a re-render)
  {
    const items: CheckItem[] = [];
    const warnItems: CheckItem[] = [];
    if (usable) {
      const order = renderOrder(out.parts, out.sprites);
      for (const s of states) {
        const st = a.img[s]!;
        for (let k = 0; k < a.units.length; k++) {
          const u = unitOf(k);
          const op = opaque(k, s);
          const top = renders[s]!.top;
          const rank = order.indexOf(k) + 1;
          // Missing: in the expected silhouette, not in this sprite, and no later sprite on top.
          const miss = (x: number, y: number): boolean =>
            x >= 0 &&
            y >= 0 &&
            x < st.W &&
            y < st.H &&
            has(u.place[s]!.E, x, y) &&
            !has(op, x, y) &&
            top[y * st.W + x]! < rank &&
            !has(a.excluded[s]!, x, y);
          for (const c of components(u.place[s]!.E, miss, 8).sort(byPixels)) {
            (c.pixels > T.occluded ? items : warnItems).push({
              state: s,
              part: u.id,
              pixels: c.pixels,
              bbox: c.box,
            });
          }
          // The analysis's record: template pixels hidden in its drawing that no other
          // depiction showed, placed with this unit's sprite.
          const cls = a.classes[u.cls]!;
          const [px, py] = posIn(k, s);
          const lost = shifted(cls.unrecovered, px - cls.mask.x, py - cls.mask.y);
          const seen = (x: number, y: number): boolean =>
            x >= 0 &&
            y >= 0 &&
            x < st.W &&
            y < st.H &&
            has(lost, x, y) &&
            top[y * st.W + x]! < rank &&
            !has(a.excluded[s]!, x, y);
          for (const c of components(lost, seen, 8).sort(byPixels)) {
            (c.pixels > T.occluded ? items : warnItems).push({
              state: s,
              part: u.id,
              pixels: c.pixels,
              bbox: c.box,
              reason: `${c.pixels} px of ${u.id} were hidden in every depiction`,
            });
          }
        }
      }
    }
    entry("occluded-unrecovered", "asset/occluded-unrecovered", items, T.occluded, "error");
    if (warnItems.length > 0) {
      for (const it of warnItems.slice(0, MAX_ITEMS)) {
        diagnostics.push({
          severity: "warning",
          code: "asset/occluded-unrecovered",
          path: "",
          message: `${it.part} misses ${it.pixels} px of its silhouette in the ${it.state} re-render`,
          params: { state: it.state, part: it.part, pixels: it.pixels, bbox: it.bbox },
        });
      }
    }
  }

  // ---- annotation residual (ink left in the base inside declared annotation masks)
  {
    const items: CheckItem[] = [];
    if (usable) {
      const outLum = luminanceOverWhite(out.base);
      const t = sb.threshold;
      for (const g of a.annotations) {
        if (g.state !== b) continue;
        const m = g.mask;
        const f = (x: number, y: number): boolean => {
          if (!has(model.erase, x, y) || !has(m, x, y) || outLum[y * sb.W + x]! >= t) return false;
          const rec = model.recover(x, y);
          return !(rec && lumOf(rec) < t);
        };
        for (const c of components(m, f, 8)
          .filter((c) => c.pixels >= T.annotationResidual)
          .sort(byPixels)) {
          items.push({ state: b, annotation: g.index, pixels: c.pixels, bbox: c.box });
        }
      }
      // Annotations of the other drawing, mapped into the base: there the base may hold no ink
      // that the base drawing does not have (recovery never copies an annotation).
      for (const g of a.annotations) {
        if (g.state === b) continue;
        const m = clipMask(
          shifted(g.mask, a.d[b]![0] - a.d[g.state]![0], a.d[b]![1] - a.d[g.state]![1]),
          sb.W,
          sb.H,
        );
        const f = (x: number, y: number): boolean => {
          if (!has(m, x, y) || outLum[y * sb.W + x]! >= t) return false;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const qx = x + dx;
              const qy = y + dy;
              if (qx >= 0 && qy >= 0 && qx < sb.W && qy < sb.H && sb.lum[qy * sb.W + qx]! < t)
                return false;
            }
          }
          return true;
        };
        for (const c of components(m, f, 8)
          .filter((c) => c.pixels >= T.annotationResidual)
          .sort(byPixels)) {
          items.push({ state: b, annotation: g.index, pixels: c.pixels, bbox: c.box });
        }
      }
    }
    entry("arrow-residual", "asset/arrow-residual", items, T.annotationResidual, "error");
  }

  // ---- hull confidence and annotation validity (from the analysis)
  const uncertain = a.units.filter((u) => !u.standaloneState);
  checks.push({
    check: "hull-uncertain",
    code: "asset/hull-uncertain",
    status: uncertain.length > 0 ? "warn" : "pass",
    value: uncertain.length,
    limit: 0,
    items: uncertain.map((u) => ({ part: u.id, reason: "stands alone in no state" })),
  });
  entry(
    "annotation-invalid",
    "asset/annotation-invalid",
    a.invalid.map((v) => ({
      state: v.state,
      ...(v.annotation !== null ? { annotation: v.annotation } : {}),
      reason: v.reason,
      ...(v.bbox ? { bbox: v.bbox } : {}),
    })),
    0,
    "error",
    {
      message: (i) =>
        `annotation${i.annotation !== undefined ? ` ${i.annotation}` : "s"}${i.state ? ` (${i.state})` : ""}: ${i.reason}`,
    },
  );

  // ---- seat verification (exploded-only figures)
  {
    const items: CheckItem[] = [];
    const run = states.length === 1 && states[0] === "exploded";
    let worst = 1;
    if (run && usable) {
      const plane = luminancePlane(out.base);
      for (let k = 0; k < a.units.length; k++) {
        const p = out.parts[k]!;
        const sp = out.sprites[p.sprite]!;
        const v = ringScore(
          plane,
          ringTemplate(sp),
          Math.round(p.seat[0]),
          Math.round(p.seat[1]),
          2,
        );
        worst = Math.min(worst, v);
        if (v < T.seatNcc)
          items.push({
            part: p.id,
            score: r1(v),
            bbox: { x: Math.round(p.seat[0]), y: Math.round(p.seat[1]), w: sp.width, h: sp.height },
          });
      }
    }
    entry("seat-unverified", "asset/seat-unverified", items, T.seatNcc, "warning", {
      notRun: !run,
      value: run ? r1(worst) : 0,
    });
  }

  const notRun = checks
    .filter((c) => c.status === "not-run" && c.check.endsWith("-residual"))
    .map((c) => c.check);
  const ok = !diagnostics.some((x) => x.severity === "error");
  const confidence = states.length < 2 || uncertain.length > 0 ? "reduced" : "full";
  return {
    schema: "platformcosmo/figure-report@1",
    ok,
    confidence,
    strict: a.strict,
    states,
    base: b,
    notRun,
    alignment: a.alignment ?? null,
    checks,
    annotations: a.annotations.map((g) => ({
      index: g.index,
      kind: g.kind,
      state: g.state,
      medianRun: g.medianRun,
      halfWidth: g.halfWidth,
      onInk: r1(g.onInk),
      arrowhead: g.head !== undefined,
      valid: !a.invalid.some((v) => v.annotation === g.index),
    })),
    excluded: Object.fromEntries(
      states.map((s) => {
        const n = count(a.excluded[s] ?? EMPTY);
        return [s, { pixels: n, fraction: r1(n / (a.img[s]!.W * a.img[s]!.H)) }];
      }),
    ),
    parts: usable
      ? out.parts.map((p, k) => ({
          id: p.id,
          parts: a.units[k]!.partIds,
          sprite: p.sprite,
          seat: p.seat,
          exploded: p.exploded,
          ...(p.z !== undefined ? { z: p.z } : {}),
          ...(p.inferred ? { inferred: p.inferred } : {}),
          standalone: a.units[k]!.standaloneState ?? null,
          template: a.classes[a.units[k]!.cls]!.unit === k,
          source: a.classes[a.units[k]!.cls]!.state,
        }))
      : [],
    residualRisk: RESIDUAL_RISK,
    diagnostics,
  };
}

export type { Component };
