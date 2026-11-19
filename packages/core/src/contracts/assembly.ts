/**
 * Assembly contract (frozen once merged; schema revision 1.2.0). Types only. Design:
 * `docs/design/assemblies.md` (section numbers below refer to it); tracks and owners:
 * `docs/design/assemblies-tracks.md`.
 *
 * An assembly is a tree of parts (leaves are drawn, sub-assemblies only group). Programs move
 * leaves by world-space translations only (rotations are quarter turns about z, fixed per part),
 * so every motion is a screen-space translation of the part's SVG group (PLAN §6 projection is
 * linear). Owners:
 *   resolve spec → `SceneAssemblies` (tree, frames, programs, step plan)   A2  `scene/assembly/`
 *   geometry, depth epochs, clips, bounds → `AssemblyRenderModel`         A1  `render/assembly/`
 *   tracks → CSS keyframes / frame attributes / interactive targets        B   `anim/assembly.ts`
 *   image bytes → `ImageAsset` (validation, metadata strip, SVG sanitize)  C   `assets/`
 *   pack shapes (`dc:`, `hw:`, `auto:`, `brick:`)                           E   packs
 *
 * Determinism: every array below has a stated order; every number that reaches SVG is rounded
 * by the emitter (2 decimals coordinates, 4 decimals timing), and every time is in seconds at
 * speed 1 (B divides by `speed`).
 */
import type {
  PlatformCosmoSpec,
  SpecAssembly,
  SpecColor,
  SpecEasing,
  SpecExplodeProgram,
  SpecImage,
  SpecPart,
  SpecProgram,
  SpecStage,
  SpecState,
  SpecStep,
} from "../schema/types.gen.js";
import type { Diagnostic } from "./diagnostics.js";
import type { Box3, FaceName, Rect, Vec2, Vec3 } from "./geometry.js";
import type { SanitizedSvg } from "./icons.js";
import type { PartTone } from "./scene.js";

// ---------------------------------------------------------------------------------------------
// Frames and units (§4)
// ---------------------------------------------------------------------------------------------

/** Spec `assemblies[].units`. `stud`: x/y in 8 mm studs, z in 3.2 mm plates. */
export type AssemblyUnits = "mm" | "cm" | "in" | "tile" | "stud";

export type Axis = "x" | "y" | "z";

/** Quarter turn about +z, degrees (spec `rotate`, build-step `view`). */
export type QuarterTurn = 0 | 90 | 180 | 270;

/** Assembly front side (spec `front`); `drawer` moves toward it. */
export type FrontSide = "+x" | "-x" | "+y" | "-y";

/**
 * Maps assembly-local units to world (grid tiles):
 * `world = origin + R(rotate) · (scale ⊙ local)`, rotation about the assembly's rest-bounds
 * centre, then re-anchored so the rotated bounds' minimum corner is `origin`.
 * `scale` is per axis because `stud` units are anisotropic (x, y: 8 mm; z: 3.2 mm).
 * Physical units inside a DC rack slot use true scale (1 tile = 600 mm, `fit` ignored).
 */
export interface AssemblyFrame {
  readonly units: AssemblyUnits;
  /** World units per local unit, per axis. */
  readonly scale: Vec3;
  /** World position of the rotated rest bounds' minimum corner. */
  readonly origin: Vec3;
  readonly rotate: QuarterTurn;
  /** Front side in WORLD axes (after `rotate`). */
  readonly front: FrontSide;
}

// ---------------------------------------------------------------------------------------------
// Part geometry (§5)
// ---------------------------------------------------------------------------------------------

/**
 * Primitives available to parts. Kept separate from `PrimitiveKind` (geometry.ts) so existing
 * exhaustive `Record<PrimitiveKind, …>` maps stay source-compatible.
 * - `box`, `plate` (thin box), `prism` (hexagonal, vertical), `wedge` (45°-class slope: a
 *   right-triangle prism, high side at -x before `rotate`), `card` (thin upright plate whose
 *   visible face carries an image billboard): convex solids.
 * - `cylinder`, `shaft` (thin cylinder), `stud`: circular along `axis` (x | y | z).
 * - `ring`: hollow cylinder; drawn as two depth items, `back` and `front` halves (split along
 *   the viewer diagonal), so a shaft through it sorts correctly.
 * - `tray`: open-top box (floor + four walls); drawn as `back` (floor, -x and -y walls) and
 *   `front` (+x and +y walls) depth items so contents sort between them.
 * - `sprite`: no solid; a pre-rendered image covering the box's screen silhouette.
 */
export type PartPrimitiveKind =
  | "box"
  | "plate"
  | "prism"
  | "wedge"
  | "card"
  | "cylinder"
  | "shaft"
  | "stud"
  | "ring"
  | "tray"
  | "sprite";

/** One solid of a leaf part, in the PART's local frame (origin = part min corner, local units). */
export interface PartPrimitive {
  /** Unique within the leaf, `^[a-z0-9_.-]+$`; becomes the `part` argument of `ids.face`. */
  readonly id: string;
  readonly kind: PartPrimitiveKind;
  readonly box: Box3;
  /** For circular kinds; default `z`. */
  readonly axis?: Axis;
  /** Rotation of a `wedge`'s slope (quarter turns about z). */
  readonly rotate?: QuarterTurn;
  readonly tone: PartTone;
  /** Resolved spec color (hex or `palette:<name>`); overrides `tone` fills. */
  readonly color?: SpecColor;
}

/** Where an image goes on a leaf (spec `image`). */
export interface PartImagePlacement {
  /** `ImageAsset.key` (spec image id). */
  readonly image: string;
  /** `billboard`: upright, never skewed; otherwise an affine decal on that face of `bounds`. */
  readonly face: "billboard" | FaceName;
  /** Pixel rect (part crop, else image crop, else the whole image). */
  readonly crop: Rect;
  readonly fit: "contain" | "cover" | "stretch";
}

/**
 * Geometry of a leaf part in its own frame (local units). Built by core for primitives and by a
 * `PartShapeDef` for pack shapes. Pure and deterministic.
 */
export interface PartGeometry {
  /** Back-to-front within the part (the part is one depth item unless `split`). */
  readonly primitives: readonly PartPrimitive[];
  /** Everything drawn, including studs and billboards' implied box. */
  readonly bounds: Box3;
  /**
   * Box used for depth ordering and enclosure tests; may be smaller than `bounds` (brick studs
   * are excluded so stacked bricks do not interpenetrate, §9.3).
   */
  readonly depthBox: Box3;
  /** False for `tray`, `ring` and `sprite`: never encloses other parts (§9.5). */
  readonly solid: boolean;
  /** `tray`/`ring`: ids of the primitives in the `back` and `front` depth items. */
  readonly split?: { readonly back: readonly string[]; readonly front: readonly string[] };
  readonly images?: readonly PartImagePlacement[];
}

/** Parameters handed to a pack shape's `build`. */
export interface PartShapeContext {
  /** Unrotated extent in the assembly's local units (spec `size`, else the def's default). */
  readonly size: Vec3;
  readonly units: AssemblyUnits;
  readonly axis: Axis;
  readonly tone: PartTone;
  readonly color?: SpecColor;
  readonly state: SpecState;
}

/** A named part shape from a pack (`dc:server-2u`, `hw:dimm`, `auto:piston`, `brick:brick`). */
export interface PartShapeDef<P extends object = Record<string, unknown>> {
  /** Id within the pack, kebab-case. */
  readonly id: string;
  readonly label: string;
  /** Default `type` for parts using this shape (selectors, suggestion heuristics). */
  readonly type: string;
  readonly role?: "body" | "cover" | "fastener" | "internal" | "cable" | "shell";
  /** Default size in `defaultUnits` (spec `size` overrides). */
  readonly defaultSize: Vec3;
  readonly defaultUnits: AssemblyUnits;
  readonly defaults: P;
  /** Validates and merges spec `params` (unknown keys → diagnostics, did-you-mean). */
  readParams(params: Readonly<Record<string, unknown>>): {
    readonly params: P;
    readonly diagnostics: readonly Diagnostic[];
  };
  build(params: P, ctx: PartShapeContext): PartGeometry;
}

export interface PartShapePack {
  /** Prefix before `:` in shape refs: `dc`, `hw`, `auto`, `brick`, or a user pack id. */
  readonly id: string;
  readonly name: string;
  /** SPDX. Packs never carry third-party artwork or trademarks (§13). */
  readonly license: string;
  readonly shapes: readonly PartShapeDef[];
}

/** Lookup of `pack:id` shape refs; wired by the CLI like icons (D4). */
export interface PartShapeRegistry {
  get(ref: string): PartShapeDef | undefined;
  /** For did-you-mean: canonical refs, sorted. */
  list(): readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Image assets (§11). Core never reads files: the CLI loads bytes, core validates them.
// ---------------------------------------------------------------------------------------------

export type ImageFormat = "png" | "jpeg" | "webp" | "svg";

/** Raw input for one spec image, loaded by the CLI (path guard) or decoded from a data URI. */
export interface ImageAssetInput {
  /** Spec image id. */
  readonly key: string;
  /** The spec `src` (for diagnostics only; never re-read). */
  readonly src: string;
  readonly bytes: Uint8Array;
}

/**
 * A validated image. Raster: format from magic bytes (never the extension), dimensions from the
 * header, metadata removed without re-encoding (PNG keeps IHDR, PLTE, tRNS, IDAT, IEND only;
 * JPEG drops APP1..APP15 except APP14 Adobe, and COM; WebP keeps VP8/VP8L/VP8X/ALPH/ANIM
 * frames only, then rejects animation). SVG: `svg` holds the sanitizer output (icon allowlist),
 * embedded as a `<symbol>`. Text inside images is pixels, never read or interpreted.
 */
export interface ImageAsset {
  readonly key: string;
  readonly format: ImageFormat;
  /** `image/png` | `image/jpeg` | `image/webp` | `image/svg+xml`. */
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** `sha256-<base64>` of `data` (or of `svg.body`); emit embeds each hash once (dedupe). */
  readonly hash: string;
  /** Cleaned raster bytes; empty for SVG. */
  readonly data: Uint8Array;
  readonly svg?: SanitizedSvg;
}

/** Caps (§11.4). Exceeding a per-image cap is an error; the total cap too; warnings below. */
export interface ImageLimits {
  /** Default 2 MiB per raster file. */
  readonly maxBytes: number;
  /** Default 256 KiB per SVG (sanitizer `maxBytes`). */
  readonly maxSvgBytes: number;
  /** Default 8192 px per side. */
  readonly maxDimension: number;
  /** Default 16 777 216 px (width × height). */
  readonly maxPixels: number;
  /** Default 8 MiB over all distinct embedded images. */
  readonly maxTotalBytes: number;
  /** Default 256 distinct images per spec. */
  readonly maxImages: number;
  /** Warn (`budget/images`) above this total, default 1 MiB (document class: 4 MiB, §12). */
  readonly warnTotalBytes: number;
}

/** Validates and cleans one image. Pure; never throws for bad bytes. Track C. */
export type PrepareImageFn = (
  input: ImageAssetInput,
  limits: ImageLimits,
) => { readonly asset?: ImageAsset; readonly diagnostics: readonly Diagnostic[] };

/** Prepared images by spec image id; built by the CLI with `PrepareImageFn`. */
export interface ImageAssetResolver {
  get(key: string): ImageAsset | undefined;
  /** Spec image ids, sorted. */
  keys(): readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Scene: assembly tree and programs (A2 → A1), all WORLD space unless noted
// ---------------------------------------------------------------------------------------------

export type PartRole = "body" | "cover" | "fastener" | "internal" | "cable" | "shell";

/** Provenance from spec `source`. Only escaped text ever reaches the SVG (credits line). */
export interface AssetSource {
  readonly document?: string;
  readonly page?: number;
  readonly figure?: string;
  readonly license?: string;
  readonly attribution?: string;
  readonly url?: string;
}

/**
 * One node of the assembly tree. `path` is the full scene id: `<assemblyId>/<partId>/…`
 * (racks: `<rackId>/<slotId>/…`). Repeated parts expand to `<id>-1 … <id>-n` before paths are
 * built; `use` and `racks[].slots[].assembly` instance the template's tree under the path.
 */
export interface SceneAssemblyNode {
  readonly path: string;
  /** Last path segment. */
  readonly id: string;
  readonly kind: "leaf" | "sub";
  readonly type?: string;
  /** Sorted, unique. */
  readonly tags: readonly string[];
  /** Spec role, else the shape's role, else inferred (§10.1). */
  readonly role: PartRole;
  readonly label?: string;
  readonly detail: readonly string[];
  readonly badge?: string;
  readonly state: SpecState;
  /** Rest pose box in the assembly's local units (rotations applied). */
  readonly local: Box3;
  /** Rest pose box in world space (`depthBox` for leaves). */
  readonly world: Box3;
  /** Leaves only. Local units, part frame. */
  readonly geometry?: PartGeometry;
  /** Sibling path this part mates with (spec `mates` or inferred contact), if any. */
  readonly mates?: string;
  /** Spec `closeup`: id of an assembly, figure or storyboard shown when focused (§8.4). */
  readonly closeup?: string;
  readonly source?: AssetSource;
  /** Children in spec order (after `count` expansion). */
  readonly children: readonly SceneAssemblyNode[];
}

/** One straight move of a node (leaf or sub-assembly) within a program. */
export interface PartMove {
  /** Node moved; a sub-assembly moves all its leaves as one rigid unit. */
  readonly path: string;
  /**
   * World displacement at the END of this move, relative to the node's pose at the start of
   * the move (moves of ancestors and earlier stages compose by addition).
   */
  readonly offset: Vec3;
  /** Seconds from the program segment's start (before compression), speed 1. */
  readonly start: number;
  readonly duration: number;
  readonly easing: SpecEasing;
  /**
   * Build moves from `from: "callout"`: the first `overlayDuration` seconds fly in screen space
   * from the callout slot to the hover point in the overlay layer (§7.6), the rest is `offset`.
   */
  readonly overlayDuration?: number;
}

export interface ResolvedStage {
  /** 1-based. */
  readonly index: number;
  readonly label?: string;
  /** Sorted by (start, path). */
  readonly moves: readonly PartMove[];
  /** Seconds from program start, speed 1, uncompressed. */
  readonly start: number;
  readonly end: number;
  readonly labels: "show" | "hide";
  readonly leaders: boolean;
  readonly details: boolean;
  readonly fade: "none" | "unselected" | "others";
}

export interface ResolvedExplodeProgram {
  readonly kind: "explode";
  readonly id: string;
  /** Path of the assembly or sub-assembly owning the program. */
  readonly owner: string;
  readonly label?: string;
  readonly stages: readonly ResolvedStage[];
}

export interface CalloutEntry {
  readonly count: number;
  /** A representative leaf (thumbnail is its geometry or image at a fixed callout scale). */
  readonly sample: string;
  readonly label?: string;
}

export interface ResolvedBuildStep {
  /** 1-based position in the program. */
  readonly index: number;
  /** Booklet step number (spec `number`, default `index`). */
  readonly number: number;
  readonly caption?: string;
  /** Leaves made visible by this step, sorted. */
  readonly adds: readonly string[];
  /** From origin to seat; `offset` is seat − origin (so the origin is `−offset`). */
  readonly moves: readonly PartMove[];
  readonly callout: readonly CalloutEntry[];
  /** View rotation from this step on (assembly-only specs). */
  readonly view?: QuarterTurn;
  /** Sub-build played first at `staging` (world offset of the sub-assembly), then attached. */
  readonly subBuild?: {
    readonly path: string;
    readonly program: string;
    readonly staging: Vec3;
  };
  readonly start: number;
  readonly end: number;
}

export interface ResolvedBuildProgram {
  readonly kind: "build";
  readonly id: string;
  readonly owner: string;
  readonly label?: string;
  readonly steps: readonly ResolvedBuildStep[];
  /** Leaves no step adds (present from the start), sorted. */
  readonly base: readonly string[];
}

export type ResolvedProgram = ResolvedExplodeProgram | ResolvedBuildProgram;

/** Pose level of one program: stages applied (explode) or build steps done (build). */
export interface ProgramLevel {
  readonly program: string;
  readonly level: number;
}

/**
 * A resolved assembly. `source: "dc"` for a rack in assembly mode (§8): built by
 * `DcPack.buildAssembly`, only when a step action targets it (otherwise the rack keeps its
 * pre-1.2 objects and output bytes).
 */
export interface SceneAssembly {
  readonly id: string;
  readonly source: "spec" | "dc";
  readonly label?: string;
  readonly frame: AssemblyFrame;
  /** `root.path === id`. */
  readonly root: SceneAssemblyNode;
  /** Every leaf path, depth-first in spec order. */
  readonly leaves: readonly string[];
  /** Programs of the assembly and of its sub-assemblies, sorted by (owner, id). */
  readonly programs: readonly ResolvedProgram[];
  readonly defaultProgram?: string;
  /** Spec `pose`: the rest pose (D27 rest frame shows it, §7.2). */
  readonly basePose: readonly ProgramLevel[];
  /** World bounds at rest. */
  readonly restBounds: Box3;
  /** World bounds over every reachable pose (layout spacing and focus). */
  readonly reachBounds: Box3;
}

/** A flat document storyboard (tier A, §14) or figure (figure mode, §15). */
export interface SceneFlatBoard {
  readonly id: string;
  readonly kind: "storyboard" | "figure";
  readonly label?: string;
  /** Upright panel: world anchor of its bottom-left corner and size in tiles. */
  readonly anchor: Vec3;
  readonly width: number;
  /** Image keys in first-use order. */
  readonly images: readonly string[];
  readonly source?: AssetSource;
}

/** One resolved step action (spec `steps[].assembly[]`). */
export interface ResolvedAction {
  /** Assembly, sub-assembly, rack, slot, storyboard or figure path. */
  readonly target: string;
  readonly kind: "explode" | "implode" | "build" | "unbuild";
  readonly program: string;
  readonly from: number;
  readonly to: number;
  /** Seconds after the step's motion window opens (speed 1, after compression). */
  readonly start: number;
  readonly length: number;
  /** Compression applied so the action fits the window (1 = none, §7.3). */
  readonly scale: number;
  /**
   * Access moves prepended for nested targets (a slot's drawer before its internals, §8.3),
   * as `ProgramLevel`s of ancestor programs.
   */
  readonly implied: readonly ProgramLevel[];
}

/** Assembly content of one timeline step (aligned with `SceneGraph.timeline`). */
export interface AssemblyStepPlan {
  /** 1-based, = `SceneStep.index`. */
  readonly step: number;
  /** In play order. */
  readonly actions: readonly ResolvedAction[];
  /** Cumulative pose at the end of the step, per assembly id, sorted by (assembly, program). */
  readonly poses: Readonly<Record<string, readonly ProgramLevel[]>>;
  /** View rotation in effect at the end of the step. */
  readonly view: QuarterTurn;
}

/** What the scene builder adds for 1.2.0 content (`SceneGraph.assemblies`). */
export interface SceneAssemblies {
  /** Sorted by id; templates are not listed (they are expanded into their instances). */
  readonly assemblies: readonly SceneAssembly[];
  readonly boards: readonly SceneFlatBoard[];
  /** One entry per `SceneGraph.timeline` step; empty without steps. */
  readonly plan: readonly AssemblyStepPlan[];
  /** Image keys used anywhere, sorted. */
  readonly images: readonly string[];
  /** Credits line entries (§11.6), in first-use order, deduplicated. */
  readonly credits: readonly AssetSource[];
}

// ---------------------------------------------------------------------------------------------
// Render model: depth epochs, copies, tracks (A1 → B)
// ---------------------------------------------------------------------------------------------

/**
 * A drawable unit of the assembly layer: a leaf, or the `back`/`front` half of a split leaf.
 * `item` = `path` or `path#back` / `path#front`.
 */
export interface AssemblyDrawItem {
  readonly item: string;
  readonly path: string;
  /** DOM copies of this item (≥ 1); copy 0 is the canonical one (§9.4). */
  readonly copies: number;
  /** Static clip (face-exit clipping, §9.5) per copy, by copy index; absent = none. */
  readonly clips?: Readonly<Record<number, string>>;
}

/** A time window with one valid back-to-front order (§9.3). Times: loop seconds, speed 1. */
export interface DepthEpoch {
  readonly t0: number;
  readonly t1: number;
  /** `item~copy` keys, back to front; only items that are visible somewhere in the epoch. */
  readonly order: readonly string[];
  /** True when a pair could not be certified within the bisection limit (approximate). */
  readonly approximate: boolean;
}

/** Screen-space translation key of one motion group (`ids.partMotion`). */
export interface TrackKey {
  /** Loop seconds at speed 1. */
  readonly t: number;
  /** Screen translation relative to rest, user units (already projected). */
  readonly offset: Vec2;
  /** Easing of the segment that STARTS at this key; `step` = hold until the next key. */
  readonly easing: SpecEasing | "step";
}

/** Visibility key: copy swaps, enclosure hiding, build appearance, fades, labels. */
export interface OpacityKey {
  readonly t: number;
  /** 0 hidden, 1 visible; values in between only for fades (`unselected`, `others`). */
  readonly opacity: number;
  readonly easing: SpecEasing | "step";
}

export interface PartTrack {
  /** `ids.partMotion(path, copy)` target. */
  readonly target: string;
  /** Sorted by t; first key at t = 0, last at the loop end. Identical tracks share keyframes. */
  readonly motion: readonly TrackKey[];
  readonly opacity: readonly OpacityKey[];
}

/** Pose of every motion group at one time (frame mode, per-step outputs, static). */
export interface AssemblyFrameState {
  /** Motion group id → SVG `transform` attribute value (`translate(x y)`), only when non-zero. */
  readonly transforms: Readonly<Record<string, string>>;
  /** Element ids hidden at this time (copies not in use, enclosed or not-yet-built parts). */
  readonly hidden: readonly string[];
  /** Element ids with opacity < 1 (fades), value rounded to 2 decimals. */
  readonly opacity: Readonly<Record<string, number>>;
}

/** What A1 adds to `RenderModel` for 1.2.0 content (`RenderModel.assembly`). */
export interface AssemblyRenderModel {
  readonly ids: AssemblyIdScheme;
  /** Sorted by item. */
  readonly items: readonly AssemblyDrawItem[];
  /** Cover [0, loop length]; consecutive epochs differ in order. */
  readonly epochs: readonly DepthEpoch[];
  /** Sorted by target. */
  readonly tracks: readonly PartTrack[];
  /** Loop length at speed 1 (= sum of step durations), or 0 without steps. */
  readonly loop: number;
  /** Per step (1-based index − 1): time at which the step's motion has settled (§7.5). */
  readonly settled: readonly number[];
  /**
   * Focus rect of an id at the END pose of a step (assembly, sub-assembly or part focus);
   * B uses it instead of `RenderModel.focusRects` when present (§7.4).
   */
  focusRect(step: number, id: string): Rect | undefined;
  /** Exact pose at time `t` (loop seconds, speed 1); `t = 0` and outside steps: base pose. */
  frameAt(t: number): AssemblyFrameState;
  /** Pose at the end of a step (per-step outputs and reduced-motion keyframes). */
  stepEnd(step: number): AssemblyFrameState;
  /** Element estimate added by assemblies (copies, labels, leaders, callouts). */
  readonly elements: number;
}

/**
 * Ids for assembly content. Parts reuse `IdScheme.object/face/overlay` with the part path
 * (`/` encoded as `.`, as for slots), so state CSS works unchanged. A1's `createIds` returns
 * `IdScheme & AssemblyIdScheme` once implemented.
 */
export interface AssemblyIdScheme {
  /** Motion group (`<g>` carrying the translate track) of an item copy; copy 0 has no suffix. */
  partMotion(item: string, copy?: number): string;
  /** Label group (label text, details, leader line) of a part; moves with copy 0. */
  partLabel(path: string): string;
  /** Static clip path for face-exit clipping. */
  partClip(item: string, copy: number): string;
  /** `<image>` (raster) or `<symbol>` (SVG) of an asset in `<defs>`, by asset hash. */
  image(hash: string): string;
  /** Parts callout of one build step. */
  callout(owner: string, program: string, step: number): string;
  /** Storyboard or figure panel. */
  board(id: string): string;
  /** One storyboard frame / figure sprite. */
  boardItem(id: string, item: string): string;
  /** Per-view camera group for quarter-turn views (§7.7). */
  view(turn: QuarterTurn): string;
  /** Wrapper around a non-assembly object, emitted only when a stage fades `others`. */
  fadeWrap(id: string): string;
  /** Credits line (pinned like the legend). */
  credits(): string;
  /** Close-up level group (§8.4). */
  level(id: string): string;
}

// ---------------------------------------------------------------------------------------------
// Programmatic builder (§16), implemented by A2 in `scene/assembly/builder.ts`
// ---------------------------------------------------------------------------------------------

/** Children of an assembly or sub-assembly. */
export interface PartsBuilder {
  part(id: string, fields?: Omit<SpecPart, "id">): this;
  /** Sub-assembly; `build` adds its children and programs (selectors relative to it). */
  sub(id: string, fields: Omit<SpecPart, "id" | "parts">, build: (b: PartsBuilder) => void): this;
  program(program: SpecProgram | ProgramBuilder): this;
}

export interface AssemblyBuilder extends PartsBuilder {
  /** Plain spec JSON, keys in schema property order (deterministic serialization). */
  toJSON(): SpecAssembly;
}

/** `explode("service").stage({ parts: ["role:cover"], direction: "up" })`. */
export interface ProgramBuilder {
  stage(stage: SpecStage): this;
  toJSON(): SpecProgram;
}

/** Whole-spec builder; `toJSON()` output still goes through `validate`. */
export interface SpecBuilder {
  assembly(a: SpecAssembly | AssemblyBuilder): this;
  image(image: SpecImage): this;
  step(step: SpecStep): this;
  toJSON(): PlatformCosmoSpec;
}

/**
 * Builder entry points exported by `@platformcosmo/core` (A2, `scene/assembly/builder.ts`):
 * `spec(meta)`, `assembly(id, fields)`, `explode(id, fields)`. No I/O, no scene, no defaults
 * filled in (the engine applies schema defaults).
 */
export interface AssemblyBuilders {
  spec(meta: Omit<PlatformCosmoSpec["meta"], "version">): SpecBuilder;
  assembly(id: string, fields?: Omit<SpecAssembly, "id" | "parts" | "programs">): AssemblyBuilder;
  explode(id: string, fields?: Omit<SpecExplodeProgram, "id" | "stages" | "kind">): ProgramBuilder;
}
