/**
 * Scene graph contract (frozen). Built by Track A's scene builder from a
 * validated spec (plus the DC pack's fragment); consumed by projection, depth
 * sort, routing, animation and export. All coordinates are world space.
 */
import type { SpecFlowKind, SpecNodeType, SpecState } from "../schema/types.gen.js";
import type { Diagnostic } from "./diagnostics.js";
import type { Box3, PrimitiveKind, Vec3 } from "./geometry.js";

/** Theme palette bucket for a node (PLAN §8 semantic type families, plus DC). */
export type NodeCategory =
  "compute" | "network" | "data" | "client" | "observability" | "cicd" | "security" | "ai" | "dc";

export type GroupStyle = "zone" | "vpc" | "cluster" | "platform";
export type EdgeStyle = "solid" | "dashed" | "dotted";
export type FlowKind = SpecFlowKind;
export type ObjectState = SpecState;

/**
 * An upright (never skewed) icon drawn flat on the object's front, centered at
 * `anchor` (PLAN §8 rule 2). `ref` is `pack:id`.
 */
export interface IconPlacement {
  readonly ref: string;
  readonly anchor: Vec3;
  /** Icon box edge length in screen units. */
  readonly size: number;
}

/** Material hint for a part, mapped to theme tones by the emitter. */
export type PartTone = "base" | "accent" | "muted" | "glass" | "metal" | "led";

/** A sub-solid of a composite object (DC servers in a rack, a rack's frame, LEDs). */
export interface ScenePart {
  /** Unique within its object. */
  readonly id: string;
  readonly primitive: PrimitiveKind;
  readonly box: Box3;
  readonly tone: PartTone;
  readonly state?: ObjectState;
  readonly label?: string;
}

/** A drawable solid: a spec node, a DC rack/equipment, or a DC slot device. */
export interface SceneObject {
  /** Spec id (racks/equipment/nodes). Slot devices use `rackId/slotId`. */
  readonly id: string;
  readonly source: "node" | "dc";
  /** `SpecNodeType` for nodes; DC slot or equipment type for DC objects. */
  readonly type: SpecNodeType | string;
  readonly category: NodeCategory;
  readonly primitive: PrimitiveKind;
  readonly box: Box3;
  readonly label?: string;
  readonly badge?: string;
  readonly icon?: IconPlacement;
  readonly group?: string;
  /** Initial state (spec `state`, default `healthy`). */
  readonly state: ObjectState;
  /** Composite sub-solids, already in back-to-front order within the object. */
  readonly parts?: readonly ScenePart[];
  /** Named attachment points for edges and cables (e.g. `power-a`, `net-0`). */
  readonly ports?: Readonly<Record<string, Vec3>>;
}

/** A zone/vpc/cluster/platform: a slab or outline under its members. */
export interface SceneGroup {
  readonly id: string;
  readonly label?: string;
  readonly style: GroupStyle;
  readonly parent?: string;
  /** Footprint (x/y) and slab thickness (z). */
  readonly box: Box3;
  /** Nesting depth, 0 = top-level. Deeper groups draw above shallower ones. */
  readonly level: number;
}

/** A routed connection. Edges and DC cables both become SceneEdges. */
export interface SceneEdge {
  /** Spec edge id, cable id, or a deterministic generated id (`from--to`, then `-2`, `-3`…). */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "edge" | "cable";
  /** For cables: power | network | fiber | management. */
  readonly cableKind?: string;
  readonly style: EdgeStyle;
  readonly bidirectional: boolean;
  readonly label?: string;
  /** Orthogonal polyline along the iso axes (PLAN §6 routing), start to end. */
  readonly path: readonly Vec3[];
  readonly arrow: { readonly start: boolean; readonly end: boolean };
  readonly labelAnchor?: Vec3;
}

/** Particles travelling along an edge (or between aisles for airflow). */
export interface SceneFlow {
  /** Deterministic: `f-<index>` in spec order (base flows), `s<step>-f-<index>` for step flows. */
  readonly id: string;
  /** Edge id the particles follow. Airflow between aisles uses a synthetic edge of kind `edge`. */
  readonly edge: string;
  readonly kind: FlowKind;
  /** Particles per second at speed 1 (default 1). */
  readonly rate: number;
  /** Hex color or theme token name; undefined = theme color for `kind`. */
  readonly color?: string;
  /** True when particles travel `to` → `from`. */
  readonly reverse: boolean;
}

export interface SceneMetric {
  readonly id: string;
  readonly label: string;
  readonly value: string | number;
}

/** One step of the timeline (PLAN §7). */
export interface SceneStep {
  readonly index: number;
  readonly caption?: string;
  /** Seconds at speed 1 (default 3). */
  readonly duration: number;
  /** Full state map for this step (base states with the step's `set` applied, cumulative). */
  readonly states: Readonly<Record<string, ObjectState>>;
  /** Active flows during this step (replace the base flows when the step lists any). */
  readonly flows: readonly SceneFlow[];
  /** Full metric values for this step (cumulative). */
  readonly metrics: Readonly<Record<string, string | number>>;
  /** Object/group/row/rack id to zoom to (DC zoom levels: hall → row → rack → server). */
  readonly focus?: string;
}

export interface LegendEntry {
  readonly label: string;
  /** Hex color or theme token name. */
  readonly color: string;
}

export interface SceneGraph {
  readonly meta: { readonly title?: string; readonly description?: string };
  readonly canvas: {
    readonly theme: string;
    readonly grid: boolean;
    readonly padding: number;
    readonly aspect: "auto" | `${number}:${number}`;
  };
  /** Sorted by id for determinism; draw order comes from the depth stage, not this array. */
  readonly objects: readonly SceneObject[];
  readonly groups: readonly SceneGroup[];
  readonly edges: readonly SceneEdge[];
  readonly flows: readonly SceneFlow[];
  readonly metrics: readonly SceneMetric[];
  readonly legend: readonly LegendEntry[];
  /** Empty when the spec has no steps. */
  readonly timeline: readonly SceneStep[];
  /** World bounds of everything drawn. */
  readonly bounds: Box3;
  readonly diagnostics: readonly Diagnostic[];
}
