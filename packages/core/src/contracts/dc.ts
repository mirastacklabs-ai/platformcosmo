/**
 * Data-center pack contract (frozen). Track E implements it in
 * `packages/dc-pack`; Track A's scene builder calls `DcPack.buildScene` when
 * a spec has `racks`, `equipment`, `rows`, `aisles`, `cables` or `facility`.
 *
 * Units (PLAN §9): 1 world unit = one 600 mm floor tile; 1U = 44.45 mm, so
 * world height of n U = n * 44.45 / 600. Shapes are generic and vendor-neutral.
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
  /** World position, relative to the component origin. */
  readonly at: Vec3;
}

export interface DcBuildContext {
  /** Scene id of the object being built (`rackId` or `rackId/slotId`). */
  readonly id: string;
  /** World position of the component's minimum corner. */
  readonly origin: Vec3;
  readonly state: SpecState;
  readonly label?: string;
}

export interface DcBuildResult {
  /** Sub-solids in back-to-front order, positioned relative to `origin`. */
  readonly parts: readonly ScenePart[];
  readonly ports: readonly DcPort[];
  /** Overall extent relative to `origin`. */
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

/** What the DC pack contributes to the scene; merged with node-derived content by Track A. */
export interface DcSceneFragment {
  readonly objects: readonly SceneObject[];
  /** Rows and aisles become groups (aisles carry hot/cold tones via `style: "zone"` + id). */
  readonly groups: readonly SceneGroup[];
  /** Cables as `SceneEdge` with `kind: "cable"`. */
  readonly edges: readonly SceneEdge[];
  /** Airflow (cold → hot aisle through racks), power and network flows. */
  readonly flows: readonly SceneFlow[];
  /** Ids usable as step `focus` (hall, rows, racks, slots) and their world boxes. */
  readonly focusTargets: Readonly<Record<string, Box3>>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DcPack {
  readonly registry: DcComponentRegistry;
  /** Lays out the hall (rows, aisles, racks, equipment, cables) on the 600 mm grid. */
  buildScene(spec: PlatformCosmoSpec): DcSceneFragment;
}
