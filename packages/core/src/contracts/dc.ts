/**
 * Data-center pack contract (frozen). Track E implements it in
 * `packages/dc-pack`, which exports `dcPack: DcPack`. Track A's scene builder
 * calls `DcPack.buildScene` when a spec has `racks`, `equipment`, `rows`,
 * `aisles`, `cables` or `facility`.
 *
 * Units (PLAN §9): 1 world unit = one 600 mm floor tile; 1U = 44.45 mm, so
 * world height of n U = n * 44.45 / 600. Shapes are generic and vendor-neutral.
 *
 * Placement: DC positions are authoritative and start at the world origin. Track
 * A lays out spec nodes in the +x direction beyond `DcSceneFragment.bounds` with a
 * 2-tile gap, and routes node↔DC edges to DC object `ports` (or box centers).
 * Rack slot size: spec `size` wins; otherwise the component's `heightU`.
 */
import type { PlatformCosmoSpec, SpecState } from "../schema/types.gen.js";
import type { Diagnostic } from "./diagnostics.js";
import type { Box3, Vec3 } from "./geometry.js";
import type { SceneEdge, SceneFlow, SceneGroup, SceneObject, ScenePart } from "./scene.js";

export type DcCategory =
  "rack" | "server" | "network" | "storage" | "power" | "cooling" | "facility";

export type DcPortKind = "power-a" | "power-b" | "network" | "fiber" | "airflow-in" | "airflow-out";

export interface DcPort {
  /** Unique within the component, e.g. `psu-a`, `net-0`, `intake`. */
  readonly id: string;
  readonly kind: DcPortKind;
  /** Component-local position. */
  readonly at: Vec3;
}

export interface DcBuildContext {
  /** Scene id of the object being built (`rackId` or `rackId/slotId`). */
  readonly id: string;
  readonly state: SpecState;
  readonly label?: string;
}

/** Component-local geometry (origin = component minimum corner); `buildScene` translates to world. */
export interface DcBuildResult {
  /** Sub-solids in back-to-front order. */
  readonly parts: readonly ScenePart[];
  readonly ports: readonly DcPort[];
  /** Overall extent. */
  readonly bounds: Box3;
}

/** A parametric component (rack, server, switch, UPS, CRAH, …). */
export interface DcComponentDef<P extends object = Record<string, unknown>> {
  /** Matches `SpecDcSlotType` / `SpecDcEquipmentType`, or `rack`. */
  readonly type: string;
  readonly category: DcCategory;
  readonly label: string;
  /** Rack units for rack-mounted gear. */
  readonly heightU?: number;
  /** Floor-standing footprint and height in mm. */
  readonly footprintMm?: {
    readonly width: number;
    readonly depth: number;
    readonly height: number;
  };
  readonly defaults: P;
  /** Pure and deterministic. */
  build(params: P, ctx: DcBuildContext): DcBuildResult;
}

export interface DcComponentRegistry {
  get(type: string): DcComponentDef | undefined;
  list(): readonly DcComponentDef[];
}

/** What the DC pack contributes to the scene (world space); merged with node content by Track A. */
export interface DcSceneFragment {
  /** Racks, equipment, and one object per occupied slot (`rackId/slotId`). */
  readonly objects: readonly SceneObject[];
  /** Hall, rows and aisles (`kind` `hall` | `row` | `cold-aisle` | `hot-aisle`). */
  readonly groups: readonly SceneGroup[];
  /** Cables (`kind: "cable"`) and hidden airflow paths (`hidden: true`). */
  readonly edges: readonly SceneEdge[];
  /** Airflow (cold → hot aisle through racks), power and network flows; ids `dc_f_<n>`. */
  readonly flows: readonly SceneFlow[];
  /** Ids usable as step `focus` (hall, rows, aisles, racks, slots) and their world boxes. */
  readonly focusTargets: Readonly<Record<string, Box3>>;
  /** World extent of the whole DC content. */
  readonly bounds: Box3;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DcPack {
  readonly registry: DcComponentRegistry;
  /** Lays out the hall (rows, aisles, racks, equipment, cables) on the 600 mm grid from the world origin. */
  buildScene(spec: PlatformCosmoSpec): DcSceneFragment;
}
