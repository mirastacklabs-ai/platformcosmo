/**
 * Figure pipeline (ingestion §6): `runFigure` (what `pcosmo assets figure` calls) and
 * `checkFigure` (`pcosmo assets check`), plus `cutout` for one part. Pure functions over decoded
 * rasters; the CLI (D-2a) loads and writes files. Nothing throws on bad input: every problem is a
 * diagnostic, and every limit (ingestion §14) is checked before the work it bounds.
 */
import type { Diagnostic } from "@platformcosmo/core";
import { encodePng } from "../png.js";
import { err, type OpResult, type Raster } from "../raster.js";
import {
  analyzeFigure,
  type FigureLimits,
  type FigureOptions,
  type FigureSources,
} from "./analyze.js";
import { buildOutputs, type FigureOutputs } from "./build.js";
import { runGate, type FigureReport } from "./gate.js";
import type { FigureState } from "./manifest.js";
import { tight, type Mask } from "./mask.js";

export { validateManifest, MANIFEST_LIMITS, STATES } from "./manifest.js";
export type {
  FigureManifest,
  ManifestPart,
  Annotation,
  FigureState,
  Point,
  RectTuple,
  PerState,
} from "./manifest.js";
export type { FigureOptions, FigureSources, FigureLimits } from "./analyze.js";
export type { FigureOutputs, FigureOutputPart } from "./build.js";
export type { FigureReport, CheckEntry, CheckItem, CheckStatus } from "./gate.js";

/** Provenance copied onto every image and the figure (spec `source`). */
export interface FigureSourceInfo {
  readonly document?: string;
  readonly page?: number;
  readonly figure?: string;
  readonly attribution?: string;
  readonly license?: string;
  readonly url?: string;
}

export interface RunFigureOptions extends FigureOptions {
  /** Figure id in the spec fragment (default "figure"; at most 48 characters). */
  readonly figureId?: string;
  /** Prefix for image `src` paths in the fragment, e.g. "fig/" (default ""). */
  readonly dir?: string;
  readonly label?: string;
  readonly source?: FigureSourceInfo;
}

export interface FigureFragment {
  readonly images: readonly {
    readonly id: string;
    readonly src: string;
    readonly source?: FigureSourceInfo;
  }[];
  readonly figures: readonly {
    readonly id: string;
    readonly label?: string;
    readonly base: string;
    readonly pose: "assembled" | "exploded";
    readonly parts: readonly {
      readonly id: string;
      readonly image: string;
      readonly seat: readonly [number, number];
      readonly exploded: readonly [number, number];
      readonly z?: number;
    }[];
    readonly source?: FigureSourceInfo;
  }[];
}

export interface FigureFile {
  /** Output file name; never derived from input content. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface FigureResult {
  readonly outputs: FigureOutputs;
  readonly report: FigureReport;
  readonly fragment: FigureFragment;
  /** base.png, sprite-1.png, ..., report.json and fragment.json (sorted keys). */
  readonly files: readonly FigureFile[];
}

const FIGURE_ID = /^[a-z][a-z0-9-]*$/;
const DIR_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** JSON with sorted object keys and no whitespace variance (deterministic output). */
export function stableStringify(v: unknown, indent = 2): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        const val = (x as Record<string, unknown>)[k];
        if (val !== undefined) o[k] = norm(val);
      }
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(v), null, indent) + "\n";
}

export function fragmentOf(
  outputs: FigureOutputs,
  base: "assembled" | "exploded",
  options: RunFigureOptions = {},
): FigureFragment {
  const fid = options.figureId ?? "figure";
  const dir = options.dir ?? "";
  const src = options.source ? { source: options.source } : {};
  return {
    images: [
      { id: `${fid}-base`, src: `${dir}base.png`, ...src },
      ...outputs.sprites.map((_, i) => ({
        id: `${fid}-sprite-${i + 1}`,
        src: `${dir}sprite-${i + 1}.png`,
        ...src,
      })),
    ],
    figures: [
      {
        id: fid,
        ...(options.label ? { label: options.label } : {}),
        base: `${fid}-base`,
        pose: base,
        parts: outputs.parts.map((p) => ({
          id: p.id,
          image: `${fid}-sprite-${p.sprite + 1}`,
          seat: [p.seat[0], p.seat[1]] as const,
          exploded: [p.exploded[0], p.exploded[1]] as const,
          ...(p.z !== undefined ? { z: p.z } : {}),
        })),
        ...src,
      },
    ],
  };
}

/** A relative directory ending in "/": segments of [A-Za-z0-9._-], none "." or "..". */
function validDir(d: string): boolean {
  if (!d.endsWith("/")) return false;
  const segs = d.slice(0, -1).split("/");
  return segs.every((x) => DIR_SEGMENT.test(x) && x !== "." && x !== "..");
}

function badRunOptions(o: RunFigureOptions): Diagnostic | undefined {
  if (
    o.figureId !== undefined &&
    (typeof o.figureId !== "string" || o.figureId.length > 48 || !FIGURE_ID.test(o.figureId))
  ) {
    return err("asset/bad-option", "figureId must be an id of at most 48 characters", {
      params: { option: "figureId" },
    });
  }
  if (
    o.dir !== undefined &&
    o.dir !== "" &&
    (typeof o.dir !== "string" ||
      o.dir.length > 256 ||
      !validDir(o.dir) ||
      o.dir.split("/").includes(".."))
  ) {
    return err("asset/bad-option", 'dir must be a relative directory ending in "/" without ".."', {
      params: { option: "dir" },
    });
  }
  if (o.label !== undefined && (typeof o.label !== "string" || o.label.length > 200)) {
    return err("asset/bad-option", "label must be text of at most 200 characters", {
      params: { option: "label" },
    });
  }
  return undefined;
}

/**
 * The whole figure pipeline: analysis, sprites, clean base, positions, gate report and spec
 * fragment. `value` is present whenever the analysis succeeds (even when the gate fails, so the
 * report can be written); `report.ok` says whether the outputs may be used.
 */
export function runFigure(
  manifest: unknown,
  sources: FigureSources,
  options: RunFigureOptions = {},
): OpResult<FigureResult> {
  try {
    const bad = badRunOptions(options);
    if (bad) return { diagnostics: [bad] };
    const an = analyzeFigure(manifest, sources, options);
    if (!an.value) return { diagnostics: an.diagnostics };
    const { outputs } = buildOutputs(an.value);
    const report = runGate(an.value, outputs);
    const fragment = fragmentOf(outputs, an.value.base, options);
    const files: FigureFile[] = [
      { name: "base.png", bytes: encodePng(outputs.base) },
      ...outputs.sprites.map((s, i) => ({ name: `sprite-${i + 1}.png`, bytes: encodePng(s) })),
      { name: "report.json", bytes: new TextEncoder().encode(stableStringify(report)) },
      { name: "fragment.json", bytes: new TextEncoder().encode(stableStringify(fragment)) },
    ];
    return { value: { outputs, report, fragment, files }, diagnostics: [...report.diagnostics] };
  } catch (e) {
    return { diagnostics: [internal(e)] };
  }
}

/** Re-runs the gate on existing outputs (`assets check`). */
export function checkFigure(
  manifest: unknown,
  sources: FigureSources,
  outputs: FigureOutputs,
  options: FigureOptions = {},
): OpResult<FigureReport> {
  try {
    const an = analyzeFigure(manifest, sources, options);
    if (!an.value) return { diagnostics: an.diagnostics };
    const report = runGate(an.value, outputs);
    return { value: report, diagnostics: [...report.diagnostics] };
  } catch (e) {
    return { diagnostics: [internal(e)] };
  }
}

/** A bug guard: nothing should throw, but if something does it becomes a diagnostic. */
function internal(e: unknown): Diagnostic {
  return err(
    "asset/bad-raster",
    `the figure could not be processed: ${e instanceof Error ? e.message : String(e)}`,
  );
}

export interface CutoutOptions {
  readonly seeds: readonly (readonly [number, number])[];
  readonly polygon?: readonly (readonly [number, number])[];
  readonly prior?: "box" | "cylinder" | "none";
  readonly holes?: boolean;
  /** "rect" exists only for diagnostics (§6.2 step 5): the bbox of the auto mask, fully opaque. */
  readonly mask?: "auto" | "rect";
}

export interface CutoutResult {
  /** Silhouette-cut sprite (transparent outside). */
  readonly sprite: Raster;
  /** Top-left of the sprite in the image. */
  readonly x: number;
  readonly y: number;
}

/** `assets cutout`: silhouette segmentation of one part in one image (§6.2). */
export function cutout(
  image: Raster,
  options: CutoutOptions,
  limits: FigureLimits = {},
): OpResult<CutoutResult> {
  try {
    const manifest = {
      sources: { exploded: "image.png" },
      parts: [
        {
          id: "part",
          seeds: { exploded: options.seeds.map(([x, y]) => [x, y]) },
          ...(options.polygon
            ? { polygon: { exploded: options.polygon.map(([x, y]) => [x, y]) } }
            : {}),
          ...(options.prior ? { prior: options.prior } : {}),
          ...(options.holes ? { holes: true } : {}),
        },
      ],
    };
    const an = analyzeFigure(manifest, { "image.png": image }, limits);
    if (!an.value) return { diagnostics: an.diagnostics };
    const c = an.value.classes[0]!;
    const m = tight(c.mask);
    let sprite: Raster = c.sprite;
    if (options.mask === "rect") {
      const data = new Uint8Array(m.w * m.h * 4);
      for (let j = 0; j < m.h; j++) {
        for (let i = 0; i < m.w; i++) {
          const q = ((j + m.y) * image.width + i + m.x) * 4;
          data.set(image.data.subarray(q, q + 3), (j * m.w + i) * 4);
          data[(j * m.w + i) * 4 + 3] = 255;
        }
      }
      sprite = { width: m.w, height: m.h, data };
    }
    return {
      value: { sprite, x: m.x, y: m.y },
      diagnostics: an.diagnostics.filter((d) => d.code !== "asset/hull-uncertain"),
    };
  } catch (e) {
    return { diagnostics: [internal(e)] };
  }
}

/**
 * The outputs a spec fragment describes (`assets check` reads report.json or fragment.json and
 * the PNGs): `images` maps each image `src` of the fragment to its decoded raster.
 */
export function outputsFromFragment(
  fragment: unknown,
  images: Readonly<Record<string, Raster>>,
): OpResult<FigureOutputs> {
  const bad = (msg: string): OpResult<FigureOutputs> => ({
    diagnostics: [err("asset/bad-option", msg, { params: { option: "outputs" } })],
  });
  try {
    const f = fragment as FigureFragment;
    if (!f || !Array.isArray(f.images) || !Array.isArray(f.figures) || f.figures.length !== 1)
      return bad("the fragment must have images and exactly one figure");
    const fig = f.figures[0]!;
    if (!fig || typeof fig.base !== "string" || !Array.isArray(fig.parts))
      return bad("the figure needs a base and parts");
    if (f.images.length > 65 || fig.parts.length > 64)
      return bad("the fragment has too many images or parts");
    const srcOf = new Map<string, string>();
    for (const im of f.images) {
      if (!im || typeof im.id !== "string" || typeof im.src !== "string")
        return bad("every image needs an id and a src");
      srcOf.set(im.id, im.src);
    }
    const raster = (id: string): Raster | undefined => {
      const src = srcOf.get(id);
      return src !== undefined && Object.prototype.hasOwnProperty.call(images, src)
        ? images[src]
        : undefined;
    };
    const base = raster(fig.base);
    if (!base) return bad(`no image for the base "${String(fig.base).slice(0, 64)}"`);
    const spriteIds: string[] = [];
    const sprites: Raster[] = [];
    const parts = [];
    for (const p of fig.parts) {
      if (!p || typeof p.id !== "string" || typeof p.image !== "string")
        return bad("every part needs an id and an image");
      let k = spriteIds.indexOf(p.image);
      if (k < 0) {
        const r = raster(p.image);
        if (!r) return bad(`no image for "${p.image.slice(0, 64)}"`);
        k = sprites.length;
        spriteIds.push(p.image);
        sprites.push(r);
      }
      parts.push({
        id: p.id,
        sprite: k,
        seat: p.seat,
        exploded: p.exploded,
        ...(p.z !== undefined ? { z: p.z } : {}),
      });
    }
    return { value: { base, sprites, parts }, diagnostics: [] };
  } catch (e) {
    return { diagnostics: [internal(e)] };
  }
}

/**
 * `--show-exclusions` (§6.5 rule 5): each drawing with every excluded pixel (the annotation
 * masks of both states, mapped) tinted red, for the user to see what the gate did not compare.
 */
export function exclusionOverlay(
  manifest: unknown,
  sources: FigureSources,
  options: FigureOptions = {},
): OpResult<Partial<Record<FigureState, Raster>>> {
  try {
    const an = analyzeFigure(manifest, sources, options);
    if (!an.value) return { diagnostics: an.diagnostics };
    const out: Partial<Record<FigureState, Raster>> = {};
    const value = an.value;
    for (const s of value.states) {
      const st = value.img[s]!;
      const data = new Uint8Array(st.image.data);
      const X: Mask = value.excluded[s]!;
      for (let j = 0; j < X.h; j++) {
        for (let i = 0; i < X.w; i++) {
          if (!X.data[j * X.w + i]) continue;
          const o = ((j + X.y) * st.W + i + X.x) * 4;
          data[o] = Math.round((data[o]! + 255) / 2);
          data[o + 1] = Math.round(data[o + 1]! / 2);
          data[o + 2] = Math.round(data[o + 2]! / 2);
          data[o + 3] = 255;
        }
      }
      out[s] = { width: st.W, height: st.H, data };
    }
    return { value: out, diagnostics: an.diagnostics };
  } catch (e) {
    return { diagnostics: [internal(e)] };
  }
}

export type { Raster };
