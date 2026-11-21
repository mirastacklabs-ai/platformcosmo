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
  SpecBuildProgram,
  SpecBuildStep,
  SpecColor,
  SpecEasing,
  SpecExplodeProgram,
  SpecFigure,
  SpecFigurePart,
  SpecFigureStage,
  SpecImage,
  SpecPart,
  SpecProgram,
  SpecRack,
  SpecStage,
  SpecState,
  SpecStep,
  SpecStoryboard,
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
  /**
   * `billboard`: upright, never skewed; otherwise an affine decal on that face of `bounds`.
   * `left`/`right` are faces of the part in the ASSEMBLY-LOCAL frame; the renderer maps them
   * through `AssemblyFrame.rotate` (also in quarter-turn views, where scenes keep the data and
   * only the frame changes), so a face turned away is the renderer's to omit, never the scene's.
   */
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

/**
 * One spec part with a pack shape, as handed to a placement check (generic: core knows no pack
 * types). Spec fields are passed as written, in the assembly's resolved `units`.
 */
export interface PartPlacement {
  /** JSON pointer of the part in the spec, e.g. `/assemblies/0/parts/2`. */
  readonly path: string;
  /** `group`: a sub-assembly (`parts` or `use`) with `at` or `pitch`; default a leaf part. */
  readonly kind?: "part" | "group";
  /** Full shape ref, e.g. `brick:brick`; absent for a group. */
  readonly shape?: string;
  /** Group only: the pack shape refs of the leaves below it (sorted, bounded). */
  readonly shapes?: readonly string[];
  /** The declaring assembly's resolved units (`mm` when the spec gives none). */
  readonly units: string;
  readonly at?: readonly unknown[];
  readonly pitch?: readonly unknown[];
  readonly count?: number;
  readonly size?: readonly unknown[];
  /** Spec `axis` (round parts). */
  readonly axis?: string;
  readonly params?: unknown;
}

/**
 * Pack-supplied placement check (`brick/off-grid`). Called once per spec part with a valid pack
 * shape ref; core catches throws and caps what it returns, so a pack cannot break validation.
 */
export type PartPlacementCheck = (p: PartPlacement) => readonly Diagnostic[];

// ---------------------------------------------------------------------------------------------
// Image assets (§11). Core never reads files: the CLI loads bytes, core validates them.
// ---------------------------------------------------------------------------------------------

/** WebP, GIF, AVIF and others are rejected (`image/format`, hint: convert to PNG or JPEG). */
export type ImageFormat = "png" | "jpeg" | "svg";

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
 * JPEG drops APP1..APP15 except APP14 Adobe, and COM, after reading the EXIF orientation into
 * `orientation`). APNG is rejected. SVG: `svg` holds the sanitizer output (icon allowlist),
 * embedded as a `<symbol>`. Text inside images is pixels, never read or interpreted.
 */
export interface ImageAsset {
  readonly key: string;
  readonly format: ImageFormat;
  /** `image/png` | `image/jpeg` | `image/svg+xml`. */
  readonly mime: string;
  /** Display size AFTER applying `orientation` (5–8 swap the stored width and height). */
  readonly width: number;
  readonly height: number;
  /**
   * EXIF orientation 1–8 of a JPEG (1 for everything else). Emit applies it as a fixed
   * rotate/flip transform on the `<image>` in `<defs>`, so every use shows the image upright
   * although the EXIF block itself was removed.
   */
  readonly orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** `sha256-<base64>` of `data` (SVG: of `svg.viewBox + "\n" + svg.body`); emit embeds each hash once (dedupe). */
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
  /**
   * Solid sibling this leaf is inserted into (spec `inserts`, or inferred when the leaf crosses
   * exactly one face plane of exactly one solid with its footprint inside that face): drawn after
   * (visible entry face) or before (hidden entry face) that solid, clipped at the entry face
   * (assemblies §9.5). Never a collision.
   */
  readonly inserts?: string;
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
   * the move. A leaf's displacement is the SUM of the moves of itself and its ancestors; moves
   * that overlap in time compose concurrently, so a leaf's path is then not one straight
   * segment and swept bounds use the Minkowski sum of each move's offset interval (§9.3).
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
  /** Program id; a figure's stage list is the program `"stages"`. */
  readonly program: string;
  readonly level: number;
  /**
   * Implicit access (§8.3). In `ResolvedAction.implied`: only the moves of these node paths (the
   * target's own move in the program) play, not the whole stage. In `AssemblyStepPlan.poses`:
   * the pose of `level` plus these individually opened moves. Absent: the whole level.
   */
  readonly only?: readonly string[];
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
  /**
   * Loop-start opacity fades of build programs whose timeline start differs from the base pose
   * (§7.4); absent when there are none. Computed with the plan's own opening transition.
   */
  readonly loopStart?: LoopStart;
}

/** One leaf fading at the start of the loop. Times are loop seconds at speed 1. */
export interface LoopFade {
  /** Leaf path. */
  readonly path: string;
  readonly t0: number;
  readonly t1: number;
  /** Opacity at `t0` and at `t1`: 1 -> 0 fades a base-pose part out, 0 -> 1 fades one in. */
  readonly from: 0 | 1;
  readonly to: 0 | 1;
}

export interface LoopStart {
  /** Sorted by (path). */
  readonly fades: readonly LoopFade[];
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
  /** Program id; figure actions use the constant `"stages"`. */
  readonly program: string;
  readonly from: number;
  readonly to: number;
  /** Seconds after the step's motion window opens (speed 1, after compression). */
  readonly start: number;
  readonly length: number;
  /** Compression applied so the action fits the window (1 = none, §7.3). */
  readonly scale: number;
  /**
   * Seconds of `length` (compressed like it, floored) taken by the implied access moves. On an explode
   * they play first, then the target's own program; on an implode the target's program plays
   * first and the access moves are undone last. 0 or absent without `implied`.
   */
  readonly accessLength?: number;
  /**
   * Node paths whose moves implicit access had already opened before this action: its segment
   * does not play them again, they stay where they are.
   */
  readonly opened?: readonly string[];
  /**
   * Access moves prepended for nested targets (a slot's drawer before its internals, §8.3),
   * as `ProgramLevel`s of ancestor programs.
   */
  readonly implied: readonly ProgramLevel[];
  /**
   * View switches of a build/unbuild action (§7.7), in the action's own time (seconds from its
   * start, speed 1, BEFORE compression like `PartMove.start`; multiply by `scale`): one entry per
   * build step that sets `view` (a build: the step's start; an unbuild, the exact reverse: the
   * start of the reversed step, switching back to the view before it). Sorted by `at`. Absent
   * when the action changes no view. `AssemblyStepPlan.view` is the view at the END of the step.
   */
  readonly views?: readonly { readonly at: number; readonly view: QuarterTurn }[];
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
  /**
   * Close-up levels (§8.4), sorted by path; absent without close-ups. Instances are NOT in
   * `assemblies`. `images` and `credits` above include theirs.
   */
  readonly levels?: readonly SceneLevel[];
  /**
   * Quarter-turn view scenes (§7.7), sorted by turn and including 0; absent when no build step
   * uses `view`.
   */
  readonly views?: readonly SceneView[];
}

/** One close-up instance (a level of detail, assemblies §8.4). */
export interface SceneLevel {
  /** Scene path of the instance: `<host>/closeup`. Unique. */
  readonly path: string;
  /** The coarse node (part, sub-assembly, rack slot) the instance replaces when focused. */
  readonly host: string;
  /** Id of the assembly, figure or storyboard drawn. */
  readonly ref: string;
  readonly kind: "assembly" | "figure" | "storyboard";
  /** Path of the level the host lives in (an instance path); absent: the main scene. */
  readonly parent?: string;
  /** 1 = a close-up of a node of the main scene; at most 4. */
  readonly depth: number;
  /** World box of the host in its own level: where the close-up cross-fades in from. */
  readonly hostBox: Box3;
  /**
   * Assemblies only: the instance, in its own world at the origin. `id === root.path === path`.
   * Focus targets inside it (its node paths) are in this world, not the main scene's.
   */
  readonly assembly?: SceneAssembly;
  /** Quarter turn that aligns the template's front with the host's front in world axes. */
  readonly turn: QuarterTurn;
  /** Uniform factor on true scale, at most 1 (shrunk to fit the host's interior, §8.5). */
  readonly fit: number;
  /** Per-axis template size relative to the host interior, minus 1 (physical units only). */
  readonly mismatch?: Vec3;
}

/** The main scene turned by -`turn` about the centre of the assemblies' rest bounds (§7.7). */
export interface SceneView {
  readonly turn: QuarterTurn;
  /** The placed assemblies of the scene, rotated; turn 0 is `SceneAssemblies.assemblies`. */
  readonly assemblies: readonly SceneAssembly[];
}

// ---------------------------------------------------------------------------------------------
// Render model: depth epochs, copies, tracks (A1 → B)
// ---------------------------------------------------------------------------------------------

/**
 * A drawable unit of the assembly layer: a leaf, or the `back`/`front` half of a split leaf.
 * Keys are id-safe (spec ids never contain `_`): `item` = `path`, `path__back` or
 * `path__front`; a copy key is `item` (copy 0) or `item__c<k>` (k ≥ 1).
 */
export interface AssemblyDrawItem {
  readonly item: string;
  readonly path: string;
  /** DOM copies of this item (≥ 1); copy 0 is the canonical one (§9.4). */
  readonly copies: number;
  /**
   * Clip per copy, by copy index (face-exit or insert clip, §9.5): the clip path id and the
   * clipping solid's item key. The clip is static in the SOLID's frame, so it sits on a wrapper
   * that carries the solid's track (`partHost`), outside the leaf's own motion; absent = none.
   */
  readonly clips?: Readonly<Record<number, { readonly clip: string; readonly solid: string }>>;
}

/** A time window with one valid back-to-front order (§9.3). Times: loop seconds, speed 1. */
export interface DepthEpoch {
  readonly t0: number;
  readonly t1: number;
  /** Copy keys (`item`, `item__c<k>`), back to front; only copies visible in the epoch. */
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
  /**
   * Easing of the segment that STARTS at this key; `step` = hold until the next key; a 4-tuple is
   * a CSS `cubic-bezier(x1, y1, x2, y2)` (the camera's curve of the loop closure, §7.4).
   */
  readonly easing: SpecEasing | "step" | readonly [number, number, number, number];
}

/** Visibility key (copy swaps, enclosure hiding, build appearance): always a step change. */
export interface VisibilityKey {
  readonly t: number;
  readonly visible: boolean;
}

/** Opacity key (stage fades, build fade-in/out, label fades, level cross-fades). */
export interface OpacityKey {
  readonly t: number;
  /** 0..1, rounded to 2 decimals. */
  readonly opacity: number;
  readonly easing: SpecEasing | "step";
}

/**
 * Tracks of one copy. Each property animates on its OWN nested wrapper, so CSS animations never
 * fight over one property and opacities multiply (§9.4):
 * [`<g id=partHost>` (transform: the clipping solid's track) > `<g clip-path>` (static in the
 * solid's frame)] > `<g id=partMotion>` (transform) > `<g id=partVisible>` (visibility) >
 * `<g id=partFade>` (opacity) > the object-like part group (state class, whose opacity comes
 * from the state CSS). The bracketed pair exists only for clipped copies; `partHost` is omitted
 * when the solid is static. A wrapper without a track is omitted.
 * Sorted by t; first key at t = 0, last at the loop end. Identical tracks share keyframes.
 */
export interface PartTrack {
  /** Copy key (`item` or `item__c<k>`). */
  readonly copy: string;
  /**
   * Clipped copies only: the clipping solid's TOTAL screen track (its own `host`, when it is
   * clipped itself, plus its motion), so nested inserts compose; else empty. A copy is clipped
   * only if its motion relative to the solid has no component ⊥ the clip axis anywhere in the
   * loop (§9.5); otherwise the crossing epochs fall back (Phase 1b) or use a separate clipped
   * copy swapped with an unclipped one (Phase 3).
   */
  readonly host: readonly TrackKey[];
  /**
   * The leaf's screen translation; for clipped copies RELATIVE to `host` (leaf track minus solid
   * track), so the clip stays fixed to the solid while the leaf moves through it.
   */
  readonly motion: readonly TrackKey[];
  readonly visibility: readonly VisibilityKey[];
  readonly opacity: readonly OpacityKey[];
}

/**
 * FULL pose of every wrapper at one time (frame mode, per-step outputs, static, and the DOM's own
 * attributes at t = 0). Every registered id is listed: attribute overrides must write the whole
 * state, because the DOM carries the t = 0 pose as attributes and an omitted id would keep it.
 */
export interface AssemblyFrameState {
  /** Every `partHost` / `partMotion` / label group id → `translate(x y)` (`translate(0 0)` included). */
  readonly transforms: Readonly<Record<string, string>>;
  /** `partVisible` ids hidden at this time (unused copies, enclosed or not-yet-built parts). */
  readonly hidden: readonly string[];
  /** Every `partFade` / static fade / label group id → opacity 0..1 (1 included), 2 decimals. */
  readonly opacity: Readonly<Record<string, number>>;
  /** `partVisible` ids visible at this time (the complement of `hidden`, so overrides are total). */
  readonly visible: readonly string[];
}

/** Label group (leader or top-face label) of a part and its tracks. */
export interface AssemblyLabelTrack {
  readonly id: string;
  /** Total screen translation of the node the label rides. */
  readonly motion: readonly TrackKey[];
  readonly opacity: readonly OpacityKey[];
}

/** A non-assembly object wrapped in `ids.fadeWrap` because a stage fades `others`. */
export interface AssemblyStaticFade {
  readonly key: string;
  readonly id: string;
  readonly opacity: readonly OpacityKey[];
}

export interface AssemblyStepClock {
  /** 1-based. */
  readonly step: number;
  readonly start: number;
  readonly duration: number;
  /** Motion window opens. */
  readonly open: number;
  /** Closing hold ends: the END pose of the step is shown here. */
  readonly end: number;
}

/** `p' = scale * p + (tx, ty)`: uniform scale and translation of screen coordinates. */
export interface AssemblyAffine {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

/**
 * One close-up level group (§8.4, A1-4). All rects are screen rects (user units). A level has
 * its own coordinates ("local": its world projected, no camera); `overview` places them in the
 * main viewport. The level group `<g id=group>` sits in the overlay layer, INSIDE the camera
 * group (the parent camera composes its zoom onto the group's own placement), with
 * `transform = overview` and `opacity = 0` at rest.
 *
 * Entry (B-3): for a focus transition into step k the group starts at
 * `fromHost(hostAt(k - 1))` (zoom 1: the camera that is in effect at that time composes the
 * parent's zoom, so it is NOT applied again here) and eases to `overview`; leaving reverses it.
 * `AssemblyRenderModel.frameAt` and the animator use the same keys (`groups`).
 *
 * Occluders (B-3): the main world's layer groups (objects, labels, flows) cross-fade against the
 * level over the same windows, so nothing of the main scene slides under the level.
 *
 * Figure and storyboard levels (`model` absent): `rest`, `reach`, `overview`, `focus` and `enter`
 * are PLACEHOLDERS derived from the host rect; R-2 owns their real fit to the host's zoomed rect.
 */
export interface AssemblyLevelRender {
  readonly path: string;
  readonly host: string;
  readonly kind: "assembly" | "figure" | "storyboard";
  readonly depth: number;
  readonly parent?: string;
  /** `ids.level(path)`. */
  readonly group: string;
  /** The level's own model (ids, tracks, epochs, frames in LOCAL coordinates); assemblies only. */
  readonly model?: AssemblyRenderModel;
  /** Rest bounds of the level's content, local. Figure and storyboard levels: `hostLocal`. */
  readonly rest: Rect;
  /** Everything the level draws (swept boxes, labels, leaders), local. */
  readonly reach: Rect;
  /** Screen rect of the host box in its PARENT level's local coordinates, at rest. */
  readonly hostLocal: Rect;
  /** The host rect in the main viewport at the parent's overview (no camera). */
  readonly hostRect: Rect;
  /** Camera rect that frames the host (in the viewport): `hostRect` plus the focus margins. */
  readonly hostFocus: Rect;
  /** Level overview: local -> viewport, the reach contained in the main overview area. */
  readonly overview: AssemblyAffine;
  /** Where the overview puts the level's reach in the viewport: the level camera's focus rect. */
  readonly focus: Rect;
  /**
   * Start of the cross-fade for a host that never moved, at zoom 1: local -> viewport with `rest`
   * contained in `hostRect`. The group eases from here to `overview` while the parent camera
   * zooms to `hostFocus` (see the entry rule above).
   */
  readonly enter: AssemblyAffine;
  /** `enter` for any (zoomed) host rect: `rest` contained in `zoomed`, centred. */
  fromHost(zoomed: Rect): AssemblyAffine;
  /** Host rect (viewport, no camera) at the END pose of a step: the host may have moved. */
  hostAt(step: number): Rect;
  /** Elements of the group, its content included. */
  readonly elements: number;
}

/** One quarter-turn view group (§7.7, A1-4): the scene turned by -`turn`, drawn on its own. */
export interface AssemblyViewRender {
  readonly turn: QuarterTurn;
  /** `ids.view(turn)`: objects and labels of this view; views other than 0 start at opacity 0. */
  readonly group: string;
  /**
   * This view's model: its own projection, depth epochs, tracks and frames, with ids scoped to the
   * view (`__v<turn>` suffix on every part, label, clip and fade id; view 0 is unscoped).
   */
  readonly model: AssemblyRenderModel;
  /** Screen rect of the rotated `reachBounds` plus labels: this view's viewBox. */
  readonly viewBox: Rect;
  /** Elements of the group, its content included. */
  readonly elements: number;
}

/** What A1 adds to `RenderModel` for 1.2.0 content (`RenderModel.assembly`). */
export interface AssemblyRenderModel {
  readonly ids: AssemblyIdScheme;
  /** Sorted by item. */
  readonly items: readonly AssemblyDrawItem[];
  /** Cover [0, loop length]; consecutive epochs differ in order. */
  readonly epochs: readonly DepthEpoch[];
  /** Sorted by copy key. */
  readonly tracks: readonly PartTrack[];
  /** Loop length at speed 1 (= sum of step durations), or 0 without steps. */
  readonly loop: number;
  /** Per step (1-based index − 1): when its actions have settled (§7.5); undefined without actions. */
  readonly settled: readonly (number | undefined)[];
  /** Label groups, sorted by id. */
  readonly labelTracks: readonly AssemblyLabelTrack[];
  /** Statics wrapped in a fade group (only when a stage fades `others`). */
  readonly staticFades: readonly AssemblyStaticFade[];
  /** Image assets used by decals and billboards, by hash (the emitter encodes them). */
  readonly assets: ReadonlyMap<string, ImageAsset>;
  /** One entry per timeline step. */
  readonly clock: readonly AssemblyStepClock[];
  /** Fast return of the loop closure (§7.4), when some program ends away from its base level. */
  readonly closure?: { readonly t0: number; readonly t1: number };
  /** Approximate depth time ranges (`assembly/depth-approx`). */
  readonly approximate: readonly { readonly t0: number; readonly t1: number }[];
  /** Union of the swept screen boxes of every leaf (reach bounds, §10). */
  readonly reach: Rect | undefined;
  /**
   * Focus rect of an id at the END pose of a step (assembly, sub-assembly or part focus);
   * B uses it instead of `RenderModel.focusRects` when present (§7.4). WORLD rects only, in the
   * view in effect at that step (`SceneAssemblies.plan[step - 1].view`); ids inside a close-up
   * level give undefined (see `levelFocusRect`).
   */
  focusRect(step: number, id: string): Rect | undefined;
  /**
   * Focus rect of an id inside a close-up level, in OVERLAY (viewport) coordinates: the level's
   * own rect placed by its overview, with the focus margins. Level paths are not in
   * `RenderModel.focusRects`. Absent without levels.
   */
  levelFocusRect?(step: number, id: string): Rect | undefined;
  /**
   * Exact pose at time `t` (loop seconds, speed 1); `t = 0` and outside steps: base pose. With
   * views or levels it also holds the opacity of every view group and level group, and the
   * placement (`matrix(s 0 0 s tx ty)`) of every level group, so one state shows the right view
   * and level (the cross-fades are linear: 0.3 s for views, the camera transition for levels).
   */
  frameAt(t: number): AssemblyFrameState;
  /** Pose at the end of a step (per-step outputs and reduced-motion keyframes). */
  stepEnd(step: number): AssemblyFrameState;
  /**
   * Element count added by assemblies (copies, labels, leaders, callouts): every level and every
   * view included (§13).
   */
  readonly elements: number;
  /**
   * Close-up levels (§8.4), sorted by path; absent without. `frameAt`, `stepEnd`, `focusRect`
   * and `elements` above already include them; `items`, `tracks`, `epochs` and the rest of this
   * model describe the main scene (view 0) only.
   */
  readonly levels?: readonly AssemblyLevelRender[];
  /** Quarter-turn views, sorted by turn, view 0 first; absent when no build step uses `view`. */
  readonly views?: readonly AssemblyViewRender[];
}

/**
 * Ids for assembly content. Copy 0 of a part reuses `IdScheme.object/face/overlay` with the
 * part path (`/` encoded as `.`, as for slots), so state CSS works unchanged. A copy k ≥ 1 is a
 * full duplicate subtree in which EVERY id gets the suffix `__c<k>` (object, faces, overlay,
 * wrappers); B emits each per-id state or track rule for every copy id (`copyIds`). A1's
 * `createIds` returns `IdScheme & AssemblyIdScheme` once implemented.
 */
export interface AssemblyIdScheme {
  /** Outer transform wrapper of a clipped copy: carries the clipping solid's track. */
  partHost(item: string, copy?: number): string;
  /** Transform wrapper of an item copy (copy 0 has no suffix). */
  partMotion(item: string, copy?: number): string;
  /** Visibility wrapper of an item copy. */
  partVisible(item: string, copy?: number): string;
  /** Opacity wrapper of an item copy. */
  partFade(item: string, copy?: number): string;
  /** Every id of the given element id across all copies of its item (copy 0 first). */
  copyIds(id: string): readonly string[];
  /** Label group (label text, details, leader line) of a part; moves with copy 0. */
  partLabel(path: string): string;
  /** Static clip path for face-exit clipping. */
  partClip(item: string, copy: number): string;
  /** `<image>` (raster) or `<symbol>` (SVG) of an asset in `<defs>`, by asset hash. */
  image(hash: string): string;
  /** Parts callout of one build step. */
  callout(owner: string, program: string, step: number): string;
  /**
   * Overlay copy of a leaf that flies in from a callout (§7.6): one wrapper carrying its
   * `transform`, `visibility` and `opacity`; ids inside it get the suffix `__f`.
   */
  flight(path: string): string;
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
  sub(
    id: string,
    fields: Omit<SpecPart, "id" | "parts" | "programs">,
    build: (b: PartsBuilder) => void,
  ): this;
  /** A builder passed here is snapshotted (its `toJSON()` is taken) when this is called. */
  program(program: SpecProgram | ProgramBuilder | BuildProgramBuilder): this;
}

export interface AssemblyBuilder extends PartsBuilder {
  /** Plain spec JSON (compare with JCS; see `SpecBuilder`). */
  toJSON(): SpecAssembly;
}

/** `explode("service").stage({ parts: ["role:cover"], direction: "up" })`. */
export interface ProgramBuilder {
  stage(stage: SpecStage): this;
  toJSON(): SpecExplodeProgram;
}

/** `build("assemble").step({ add: ["board"] })`. */
export interface BuildProgramBuilder {
  step(step: SpecBuildStep): this;
  toJSON(): SpecBuildProgram;
}

/** Figure-mode builder: `figure("hs", { base: "hs-base" }).part({...}).stage({...})`. */
export interface FigureBuilder {
  part(part: SpecFigurePart): this;
  stage(stage: SpecFigureStage): this;
  toJSON(): SpecFigure;
}

/**
 * Top-level spec fields the builder has no method for (canvas, legend, nodes, edges, flows,
 * equipment, rows, aisles, cables, facility, ...). Passed through unchanged by `spec(meta, rest)`.
 */
export type SpecRest = Partial<
  Omit<
    PlatformCosmoSpec,
    "$schema" | "meta" | "images" | "figures" | "storyboards" | "assemblies" | "racks" | "steps"
  >
>;

/**
 * Whole-spec builder; `toJSON()` output still goes through `validate`. Output equality is
 * defined on RFC 8785 (JCS) canonical JSON, so key order is irrelevant; arrays keep call order.
 */
export interface SpecBuilder {
  /** A builder passed here is snapshotted (its `toJSON()` is taken) when this is called. */
  assembly(a: SpecAssembly | AssemblyBuilder): this;
  rack(rack: SpecRack): this;
  /** A builder passed here is snapshotted (its `toJSON()` is taken) when this is called. */
  figure(f: SpecFigure | FigureBuilder): this;
  storyboard(s: SpecStoryboard): this;
  image(image: SpecImage): this;
  step(step: SpecStep): this;
  toJSON(): PlatformCosmoSpec;
}

/**
 * Builder entry points exported by `@platformcosmo/core` (A2, `scene/assembly/builder.ts`):
 * `spec(meta, rest?)`, `assembly(id, fields)`, `explode(id, fields)`. No I/O, no scene, no
 * defaults filled in (the engine applies schema defaults).
 *
 * `toJSON()` output is unvalidated: run `validate()` before rendering. Empty builders emit
 * invalid empty arrays on purpose (`parts: []`, `stages: []`, `steps: []`) so the schema reports
 * them, instead of the builder throwing.
 */
export interface AssemblyBuilders {
  spec(meta: Omit<PlatformCosmoSpec["meta"], "version">, rest?: SpecRest): SpecBuilder;
  assembly(id: string, fields?: Omit<SpecAssembly, "id" | "parts" | "programs">): AssemblyBuilder;
  explode(id: string, fields?: Omit<SpecExplodeProgram, "id" | "stages" | "kind">): ProgramBuilder;
  build(id: string, fields?: Omit<SpecBuildProgram, "id" | "steps" | "kind">): BuildProgramBuilder;
  figure(id: string, fields: Omit<SpecFigure, "id" | "parts" | "stages">): FigureBuilder;
}
