/**
 * Render API and stage contracts (frozen).
 *
 * Pipeline (PLAN §3), with owners and module entry points:
 *   parseSpec, validate              A  `schema/index.ts`  (parseSpec, validate, specSchema)
 *   buildScene (+ DcPack from E)     A  `scene/index.ts`   (buildScene)
 *   project + route + depth → model  A  `render/index.ts`  (buildModel)
 *   Animator → AnimationLayer        B  `anim/index.ts`    (createAnimator)
 *   emit, optimize                   A  `emit/index.ts`, `optimize/index.ts` (emit, optimize)
 *   exporters → RenderOutput[]       B  `export/index.ts`  (exportOutputs, rasterize, gifEncoder)
 *   render() orchestrates            A  `render/index.ts`  (render)
 *   icons                            C  `icons/index.ts`   (sanitizeSvg, createIconResolver, fetchIconPack)
 *
 * Every stage is pure and deterministic: same spec + options → byte-identical
 * output (exception: mp4, which depends on the system ffmpeg). No stage touches
 * the network or the file system; the CLI does all I/O.
 *
 * SVG structure that emit (A) always produces and animation (B) relies on:
 * - `<svg id=root() role="img" viewBox>` with `<title id=title()>` and `<desc id=desc()>`.
 * - One `<style>` (CDATA-wrapped; `]]>` in content is rejected): theme variables scoped
 *   to `#root`, dark overrides in `@media (prefers-color-scheme: dark)`, the base state rules,
 *   then `AnimationLayer.css`. Base state rules, for each state s (`P` = prefix):
 *     `.stateClass(s) { opacity: var(--pc-states-s-opacity) }`
 *     `.stateClass(s) > .P-overlay { fill: var(--pc-states-s-overlay); stroke: var(--pc-states-s-stroke) }`
 *     `.stateClass(s) .ledClass() { fill: var(--pc-dc-led-<ok|warn|fail>) }` (healthy/highlighted → ok,
 *     degraded → warn, down → fail). Overlay paths carry class `P-overlay`; faces of parts with
 *     tone `led` carry `ledClass()`.
 * - Raster target (`EmitOptions.target: "raster"`, used for PNG/GIF/MP4 frames): resvg supports no
 *   custom properties, `@keyframes` or `@media`, so emit substitutes every `var(--pc-…)` (also in
 *   `AnimationLayer.css`) with the literal theme value and drops `@media`/`@font-face`/keyframes.
 *   In `frame` mode B's CSS uses only plain id/class selectors and plain properties.
 * - Selectors: B builds every id selector with `ids.sel(id)` (CSS-escapes `.` in slot ids).
 * - `<g id=camera()>` wrapping every layer in `Layer` order; B zooms by animating its `transform`.
 * - Object groups are flat siblings in the `objects` layer, never nested (a rack and its slot
 *   devices are separate groups ordered by depth).
 * - Each object: `<g id=object(id) class="<stateClass(initial state)>">` holding its faces
 *   (`face(id, f[, part])`) and an always-present `<path id=overlay(id)>` over its silhouette,
 *   so any object can change state by CSS alone (classes are never mutated; B overrides with
 *   per-id rules/keyframes).
 * - Hidden edges: path only, in `<defs>`, id `edgePath(id)`. Visible edges: `<g id=edge(id)>`
 *   containing `<path id=edgePath(id)>`.
 * - Captions: A emits a caption box `<g id=caption()>` and one `<text id=captionStep(n)>` per
 *   step; metrics: a tile `<g id=metric(id)>` with one `<text id=metricValue(id, n)>` for the
 *   base value (n = 0) and each step that changes it. Only the time-0 caption/value is visible;
 *   the others carry `visibility="hidden"`, and B's CSS (`visibility: visible`) decides which one
 *   shows at each time (in `frame`/`step` modes B emits static rules).
 * - Icons: `<symbol id=icon(ref)>` in `<defs>`, placed with `<use>`.
 * - `prefers-reduced-motion: reduce` (B's CSS): pause CSS animations at the rest frame (full view, D27) and
 *   hide the `flows` layer (SMIL cannot be paused by CSS).
 */
import type { PlatformCosmoSpec } from "../schema/types.gen.js";
import type { DcPack } from "./dc.js";
import type { Diagnostic, ValidationReport } from "./diagnostics.js";
import type { FaceName, Projection, Rect, Vec2 } from "./geometry.js";
import type { IconResolver } from "./icons.js";
import type { SceneGraph } from "./scene.js";
import type { SvgNode } from "./svg.js";
import type { ThemeRegistry, ThemeTokens } from "./theme.js";

/** PLAN §10 outputs. */
export type OutputKind = "animated" | "static" | "steps" | "interactive" | "png" | "gif" | "mp4";

/** PLAN §10 `--font`. */
export type FontMode = "embed" | "outline" | "system";

/** Encodes PNG frames into a video. Built-in for gif; the CLI supplies an ffmpeg-backed one for mp4. */
export interface VideoEncoder {
  encode(
    frames: readonly Uint8Array[],
    options: {
      readonly fps: number;
      readonly width: number;
      readonly height: number;
      readonly format: "gif" | "mp4";
    },
  ): Promise<Uint8Array>;
}

/**
 * Options. Invalid values produce `error` diagnostics (`options/*`) and no outputs:
 * `idPrefix` must match `^[a-z][a-z0-9-]{0,31}$`; `name` must match `^[A-Za-z0-9._-]{1,64}$`;
 * `speed` must be in (0, 10]; `png.scale` in (0, 8]; `video.fps` in [1, 60];
 * `video.durationSec` in (0, 120].
 */
export interface RenderOptions {
  /** Default `["animated"]`. */
  readonly outputs?: readonly OutputKind[];
  /** Explicit theme; otherwise `spec.canvas.theme` (default `light`) looked up in `themes`. */
  readonly theme?: ThemeTokens;
  /** Theme for `prefers-color-scheme: dark`; default `themes.get("dark")` when the main theme is light; `null` disables. */
  readonly darkTheme?: ThemeTokens | null;
  readonly themes?: ThemeRegistry;
  /** Installed icon packs. Without one, nodes render without icons and a warning. */
  readonly icons?: IconResolver;
  /** Required when the spec has DC content; otherwise an error diagnostic. */
  readonly dc?: DcPack;
  /** Default `embed`. */
  readonly font?: FontMode;
  /** Animation speed multiplier, default 1. */
  readonly speed?: number;
  /**
   * Prefix for every SVG id; default `pc-` + the first 8 hex chars of SHA-256 over the
   * RFC 8785 (JCS) canonical JSON of `{ spec, options }` (render-affecting options only).
   * Per-output variants are made by `ExportFn` `deps.withVariant`.
   */
  readonly idPrefix?: string;
  /** Base output name, default `diagram`. */
  readonly name?: string;
  /** SVGO pass (PLAN §6 optimize), default true. */
  readonly optimize?: boolean;
  readonly png?: {
    /** Default 2. */
    readonly scale?: number;
    /** Animation time in seconds to capture, default 0. */
    readonly time?: number;
  };
  readonly video?: {
    /** Default 24. */
    readonly fps?: number;
    /** Default one full timeline loop, or one particle period when there are no steps; max 120 s. */
    readonly durationSec?: number;
    /** Needed for mp4. */
    readonly encoder?: VideoEncoder;
  };
}

export interface RenderOutput {
  readonly kind: OutputKind;
  /**
   * Relative path, always under the output directory: `<name>.svg`, `<name>.static.svg`,
   * `<name>.steps/step-NN.svg`, `<name>.interactive.svg`, `<name>.png`, `<name>.gif`, `<name>.mp4`.
   */
  readonly path: string;
  readonly mime: string;
  readonly data: string | Uint8Array;
  /** 1-based step number for `steps` outputs. */
  readonly step?: number;
}

export interface RenderStats {
  /** SVG element count of the animated output (PLAN §6 budget: warn > 5000). */
  readonly elements: number;
  /** Byte size per output path. */
  readonly bytes: Readonly<Record<string, number>>;
}

export interface RenderResult {
  /** Empty when there are error diagnostics. */
  readonly outputs: readonly RenderOutput[];
  /** Sorted by (path, code). */
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: RenderStats;
  /** Absent when validation failed. */
  readonly scene?: SceneGraph;
}

/**
 * Public entry point (`@platformcosmo/core` `render`). Never throws for bad
 * input: problems come back as diagnostics. Rejects only on programmer error
 * (e.g. mp4 requested without an encoder).
 */
export type RenderFn = (spec: unknown, options?: RenderOptions) => Promise<RenderResult>;

/**
 * Parses `.cosmo.json` / `.cosmo.yaml` text. YAML uses the 1.2 core schema (no `yes`/`on`
 * booleans). Parse errors carry `params.line` / `params.column` (1-based).
 */
export type ParseSpecFn = (
  text: string,
  format: "json" | "yaml",
) => { readonly spec?: unknown; readonly diagnostics: readonly Diagnostic[] };

/**
 * Public validation entry point: schema + semantic checks + "did you mean".
 * `oneOf`/`anyOf` failures are collapsed into one diagnostic per location.
 */
export type ValidateFn = (
  spec: unknown,
  context?: { readonly icons?: IconResolver; readonly dc?: DcPack },
) => ValidationReport<PlatformCosmoSpec>;

/**
 * Deterministic ids inside one SVG. Every id starts with `prefix` (PLAN §6 emit),
 * so several diagrams can be inlined in one page. Spec ids are used verbatim
 * except `/` (slot refs), which becomes `.`. B targets elements only through this scheme.
 */
export interface IdScheme {
  readonly prefix: string;
  root(): string;
  title(): string;
  desc(): string;
  /** `<g>` wrapping all layers; zoom target. */
  camera(): string;
  /** Group wrapping a whole object; carries its initial state class. */
  object(id: string): string;
  /** One face of an object, or of one of its parts. */
  face(id: string, face: FaceName, part?: string): string;
  /** State overlay path over the object silhouette. */
  overlay(id: string): string;
  group(id: string): string;
  edge(id: string): string;
  /** The path particles follow (`<mpath href>`). */
  edgePath(id: string): string;
  flow(id: string): string;
  /** `<symbol>` of an icon, by canonical ref. */
  icon(ref: string): string;
  caption(): string;
  /** Legend group; pinned against camera zoom like caption/metrics. */
  legend(): string;
  /** Caption text for one step (1-based). */
  captionStep(step: number): string;
  metric(id: string): string;
  /** Value text of a metric for one step (0 = base value). */
  metricValue(id: string, step: number): string;
  /** Class for a state, e.g. `${prefix}-s-down`. */
  stateClass(state: string): string;
  /** Class on faces of `led`-tone parts. */
  ledClass(): string;
  /** CSS selector for an element id: `#` + CSS-escaped id. */
  sel(id: string): string;
}

/**
 * Drawing layers, bottom to top, inside `camera()`. Ground-level edges are drawn before
 * objects so objects occlude them. DC exception (D31): floor-type DC objects draw in the
 * ground layer after group slabs, DC cables are depth-sorted segments among objects, and
 * DC particles (`dc_f_*`) draw in a group right after `objects`.
 */
export type Layer = "background" | "groups" | "edges" | "flows" | "objects" | "labels" | "overlay";

export interface EdgePath {
  readonly edgeId: string;
  /** SVG path data in screen space. */
  readonly d: string;
  readonly points: readonly Vec2[];
  /** Screen-space length. */
  readonly length: number;
}

export interface ObjectAnchor {
  readonly id: string;
  readonly bbox: Rect;
  readonly center: Vec2;
  /** Top-center of the object (badges, state markers). */
  readonly top: Vec2;
}

/** Font data for rasterizing (resvg needs TTF/OTF, not WOFF2). Always passed to `rasterize`, whatever `font` mode. */
export interface FontAsset {
  readonly family: string;
  readonly weight: number;
  /** TTF/OTF bytes (subset or full). */
  readonly sfnt: Uint8Array;
}

/** Output of projection + routing + depth sort (Track A); input to animation, emit and export. */
export interface RenderModel {
  readonly scene: SceneGraph;
  readonly theme: ThemeTokens;
  readonly darkTheme?: ThemeTokens;
  readonly projection: Projection;
  readonly ids: IdScheme;
  readonly viewBox: Rect;
  /** Static content per layer, already depth-ordered. */
  readonly layers: Readonly<Record<Layer, readonly SvgNode[]>>;
  /** Every edge, visible or hidden. */
  readonly edgePaths: Readonly<Record<string, EdgePath>>;
  readonly anchors: Readonly<Record<string, ObjectAnchor>>;
  /** Screen rects of `scene.focusTargets` (zoom). */
  readonly focusRects: Readonly<Record<string, Rect>>;
  readonly captionRect?: Rect;
  readonly metricRects: Readonly<Record<string, Rect>>;
  readonly font: FontMode;
  readonly fontAssets: readonly FontAsset[];
}

/** What animation adds on top of the static model (Track B). */
export interface AnimationLayer {
  /** CSS appended after emit's base rules. Includes the reduced-motion rule in animated modes. */
  readonly css: string;
  readonly defs: readonly SvgNode[];
  /** Extra nodes appended to layers (particles go to `flows`). */
  readonly layers: Readonly<Partial<Record<Layer, readonly SvgNode[]>>>;
  /** Inline script (only for `interactive`). Reads the DOM; never embeds spec strings. */
  readonly script?: string;
  /** Root `viewBox` override (zoomed per-step outputs). */
  readonly viewBox?: Rect;
  /** Loop length in seconds at the chosen speed (0 = nothing animates). */
  readonly duration: number;
}

export interface AnimateOptions {
  readonly speed: number;
  /**
   * `loop`: one looping master timeline over all steps (animated output).
   * `step`: static states of one step with its own particle loops (per-step output).
   * `frame`: no CSS/SMIL animation at all; particles frozen at `time` (static, png, gif/mp4 frames); time 0 = the rest frame (no zoom).
   * `interactive`: `loop` plus Play/Pause/Step script.
   */
  readonly mode: "loop" | "step" | "frame" | "interactive";
  /** 1-based, for `step`. */
  readonly step?: number;
  /** Seconds, for `frame`. */
  readonly time?: number;
}

export interface Animator {
  animate(model: RenderModel, options: AnimateOptions): AnimationLayer;
}

export interface EmitOptions {
  readonly font: FontMode;
  /** `browser` (default) keeps CSS variables/media queries; `raster` inlines literal values for resvg. */
  readonly target?: "browser" | "raster";
}

/** Serializes model + animation into one self-contained SVG string (no external refs). */
export type EmitFn = (
  model: RenderModel,
  animation: AnimationLayer,
  options: EmitOptions,
) => string;

/**
 * SVGO (exact version pinned) with an animation-safe config: disabled plugins include
 * `cleanupIds`, `minifyStyles`, `inlineStyles`, `removeHiddenElems`, `removeUselessDefs`,
 * `convertShapeToPath` on animated elements, and `removeUnknownsAndDefaults` for SMIL attrs.
 */
export type OptimizeFn = (svg: string) => string;

/**
 * Rasterizes a `target: "raster"` SVG string to PNG with resvg-wasm (PLAN §6 export, no
 * browser). Loads `fonts` and sets resvg's default font family to `fonts[0].family`.
 */
export type RasterizeFn = (
  svg: string,
  options: { readonly scale: number; readonly fonts: readonly FontAsset[] },
) => Promise<Uint8Array>;

/**
 * Builds every non-`animated` output (B). `render()` (A) calls it with its own stages.
 * Memory cap: frames × width × height × 4 ≤ 1 GiB, otherwise an `export/too-large` error.
 */
export type ExportFn = (
  model: RenderModel,
  kinds: readonly OutputKind[],
  deps: {
    readonly animator: Animator;
    readonly emit: EmitFn;
    readonly optimize: OptimizeFn;
    readonly rasterize: RasterizeFn;
    /**
     * Same model with every id re-prefixed `prefix + variant` (A1 rebuilds ids and layers).
     * Variants: `-s01`… per step, `-x` interactive, `-st` static, so outputs of one spec
     * can be inlined together. `variant` must match `^-[a-z0-9]{1,7}$`.
     */
    readonly withVariant: (model: RenderModel, variant: string) => RenderModel;
  },
  options: RenderOptions,
) => Promise<{
  readonly outputs: readonly RenderOutput[];
  readonly diagnostics: readonly Diagnostic[];
}>;

/**
 * Scene builder (A2 → A1 seam): semantic defaults, layout on the iso grid, group packing,
 * DC fragment merge, orthogonal routing (world-space `SceneEdge.path`), flows and timeline.
 * Called only with a spec that passed `validate`. One id namespace spans nodes, groups, racks,
 * equipment, rows, aisles and cables (duplicates are a `semantic/duplicate-id` error); the DC
 * hall group is `dc_hall`. `validate` also enforces `budget/particles`: the estimated particle
 * count: each flow contributes ceil(rate × 2) particles (fixed 2 s traversal at speed 1,
 * independent of path length; Track B emits exactly that many); the sum over base flows and
 * every step's flows must be ≤ 2000.
 * `buildModel` (scene → RenderModel) is A1-internal.
 */
export type BuildSceneFn = (
  spec: PlatformCosmoSpec,
  context: { readonly icons?: IconResolver; readonly dc?: DcPack },
) => SceneGraph;
