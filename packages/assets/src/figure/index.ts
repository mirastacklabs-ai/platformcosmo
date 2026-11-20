/**
 * Figure pipeline (ingestion §6): `runFigure` (what `pcosmo assets figure` calls) and
 * `checkFigure` (`pcosmo assets check`), plus `cutout` for one part. Pure functions over decoded
 * rasters; the CLI (D-2a) loads and writes files. Nothing throws on bad input: every problem is a
 * diagnostic, and every limit (ingestion §14) is checked before the work it bounds.
 */
import type { Diagnostic } from "@platformcosmo/core";
import { encodePng } from "../png.js";
import { err, type OpResult, type Raster } from "../raster.js";
import { analyzeFigure, type FigureOptions, type FigureSources } from "./analyze.js";
import { buildOutputs, type FigureOutputs } from "./build.js";
import { runGate, type FigureReport } from "./gate.js";
import { tight } from "./mask.js";

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
  /** base.png, sprite-1.png, ... and report.json (sorted keys). */
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
export function cutout(image: Raster, options: CutoutOptions): OpResult<CutoutResult> {
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
    const an = analyzeFigure(manifest, { "image.png": image });
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

export type { Raster };
