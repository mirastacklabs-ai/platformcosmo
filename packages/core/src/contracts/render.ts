/**
 * Render API and stage contracts (frozen).
 *
 * Pipeline (PLAN §3), with owners:
 *   validate (A) → buildScene (A, + DcPack from E) → project/route/depth (A) → RenderModel
 *   → Animator (B) → AnimationLayer → emit (A) → optimize (A) → exporters (B) → RenderOutput[]
 *
 * Every stage is pure and deterministic: same spec + options → byte-identical output.
 * No stage touches the network or the file system; the CLI does I/O.
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

/** Encodes PNG frames into a video. The CLI supplies an ffmpeg-backed one for mp4; gif is built in. */
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

export interface RenderOptions {
  /** Default `["animated"]`. */
  readonly outputs?: readonly OutputKind[];
  /** Explicit theme; otherwise `spec.canvas.theme` (default `light`) looked up in `themes`. */
  readonly theme?: ThemeTokens;
  /** Theme for `prefers-color-scheme: dark`; default `themes.get("dark")`; `null` disables. */
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
  /** Prefix for every SVG id/class; default `pc-` + 8 hex chars of a hash of the canonical spec. */
  readonly idPrefix?: string;
  /** Base output name, default `diagram`. */
  readonly name?: string;
  /** SVGO pass (PLAN §6 optimize), default true. */
  readonly optimize?: boolean;
  readonly png?: {
    /** Default 2. */
    readonly scale?: number;
    /** Animation time in seconds to capture, default 0 (the static frame). */
    readonly time?: number;
  };
  readonly video?: {
    /** Default 24. */
    readonly fps?: number;
    /** Default one full loop of the timeline. */
    readonly durationSec?: number;
    /** Needed for mp4. */
    readonly encoder?: VideoEncoder;
  };
}

export interface RenderOutput {
  readonly kind: OutputKind;
  /** Suggested relative path: `diagram.svg`, `diagram.static.svg`, `steps/step-01.svg`, … (PLAN §10). */
  readonly path: string;
  readonly mime: string;
  readonly data: string | Uint8Array;
  /** 1-based step number for `steps` outputs. */
  readonly step?: number;
}

export interface RenderStats {
  /** SVG element count of the animated output (PLAN §6 budget: hard limit 5000). */
  readonly elements: number;
  /** Byte size per output path. */
  readonly bytes: Readonly<Record<string, number>>;
}

export interface RenderResult {
  /** Empty when there are error diagnostics. */
  readonly outputs: readonly RenderOutput[];
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

/** Public validation entry point: schema + semantic checks + "did you mean". */
export type ValidateFn = (
  spec: unknown,
  context?: { readonly icons?: IconResolver; readonly dc?: DcPack },
) => ValidationReport<PlatformCosmoSpec>;

/**
 * Deterministic id/class names inside one SVG. Every id starts with `prefix`,
 * so several diagrams can be inlined in one page (PLAN §6 emit).
 * Animation (B) targets elements only through this scheme.
 */
export interface IdScheme {
  readonly prefix: string;
  root(): string;
  title(): string;
  desc(): string;
  /** Group wrapping a whole object (`<g>`); carries state classes. */
  object(id: string): string;
  /** One face of an object (or of a part: `object(id)` + part id). */
  face(id: string, face: FaceName, part?: string): string;
  group(id: string): string;
  edge(id: string): string;
  /** The `<path>` particles follow (referenced by `<mpath href>`). */
  edgePath(id: string): string;
  flow(id: string): string;
  caption(): string;
  /** Caption text for one step (1-based). */
  captionStep(step: number): string;
  metric(id: string): string;
  /** Value text of a metric for one step (0 = base value). */
  metricValue(id: string, step: number): string;
  /** Class applied for a state, e.g. `${prefix}-s-down`. */
  stateClass(state: string): string;
}

/** Drawing layers, bottom to top. Ground-level edges are drawn before objects, so objects occlude them correctly. */
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

/** Output of projection + routing + depth sort (Track A); input to animation and emit. */
export interface RenderModel {
  readonly scene: SceneGraph;
  readonly theme: ThemeTokens;
  readonly darkTheme?: ThemeTokens;
  readonly projection: Projection;
  readonly ids: IdScheme;
  readonly viewBox: Rect;
  /** Static content per layer, already depth-ordered. */
  readonly layers: Readonly<Record<Layer, readonly SvgNode[]>>;
  readonly edgePaths: Readonly<Record<string, EdgePath>>;
  readonly anchors: Readonly<Record<string, ObjectAnchor>>;
  /** Screen rects for step `focus` targets (zoom). */
  readonly focusRects: Readonly<Record<string, Rect>>;
  readonly font: FontMode;
}

/** What animation adds on top of the static model (Track B). */
export interface AnimationLayer {
  /** CSS inserted into the SVG `<style>`, after the theme variables. Must include the reduced-motion rule. */
  readonly css: string;
  readonly defs: readonly SvgNode[];
  /** Extra nodes appended to layers (particles to `flows`, captions/metric values to `overlay`). */
  readonly layers: Readonly<Partial<Record<Layer, readonly SvgNode[]>>>;
  /** Inline script (only for `interactive`). */
  readonly script?: string;
  /** Root `viewBox` override (zoomed per-step outputs). */
  readonly viewBox?: Rect;
  /** Loop length in seconds at the chosen speed (0 = no timeline). */
  readonly duration: number;
}

export interface AnimateOptions {
  readonly speed: number;
  /**
   * `loop`: one looping master timeline over all steps (animated output).
   * `step`: static states of one step with its own particle loops (per-step output).
   * `frame`: no CSS/SMIL animation at all; particles frozen at `time` (static, png, gif/mp4 frames).
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
  /** Base64 WOFF2 subset for `font: embed`, or glyph outlines handled by the emitter for `outline`. */
  readonly font: FontMode;
}

/** Serializes model + animation into one self-contained SVG string (no external refs). */
export type EmitFn = (
  model: RenderModel,
  animation: AnimationLayer,
  options: EmitOptions,
) => string;

/** SVGO with an animation-safe config (keeps ids, SMIL, CSS keyframes). */
export type OptimizeFn = (svg: string) => string;

/** Rasterizes an SVG string to PNG (resvg-wasm; PLAN §6 export, no browser). */
export type RasterizeFn = (
  svg: string,
  options: { readonly scale: number; readonly fonts: readonly Uint8Array[] },
) => Promise<Uint8Array>;
