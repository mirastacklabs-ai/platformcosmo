/**
 * Scene graph contract (frozen). Built by Track A's scene builder from a
 * validated spec (plus the DC pack's fragment); consumed by projection, depth
 * sort, routing, animation and export.
 *
 * Every coordinate in the scene graph (boxes, parts, ports, paths, anchors) is
 * WORLD space. (Only `DcBuildResult` is component-local; the DC pack translates.)
 *
 * Generated ids contain `_`, which spec ids cannot, so they never collide:
 * edges `e_<from>_<to>` (then `_2`, `_3`…; `/` in endpoints becomes `.`),
 * base flows `f_<n>`, step flows `s<step>_f_<n>`, DC flows `dc_f_<n>`,
 * rack slots without an id `u<at>` (a valid spec id, unique per rack).
 *
 * Array order (determinism): objects by id; groups by (level, id); edges in
 * spec order, then DC cables, then hidden synthetic edges; flows in spec order;
 * diagnostics by (path, code).
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
 * `anchor` (PLAN §8 rule 2). `ref` is canonical `pack:id`.
 */
export interface IconPlacement {
  readonly ref: string;
  readonly anchor: Vec3;
  /** Icon box edge length in screen units. */
  readonly size: number;
}

/**
 * Material hint for a part; each maps to `ThemeTokens.parts[tone]`.
 * `led` parts follow the part/object state: healthy → `dc.led.ok`,
 * degraded → `dc.led.warn`, down → `dc.led.fail`, highlighted → `dc.led.ok`.
 */
export type PartTone =
  "base" | "accent" | "muted" | "glass" | "metal" | "led" | "floor" | "perforated";

/** A sub-solid of a composite object (DC devices in a rack, a rack's frame, LEDs, floor tiles). */
export interface ScenePart {
  /** Unique within its object, matches `^[a-z0-9_.-]+$`. */
  readonly id: string;
  readonly primitive: PrimitiveKind;
  /** World space. */
  readonly box: Box3;
  readonly tone: PartTone;
  readonly state?: ObjectState;
  readonly label?: string;
}

/** A drawable solid: a spec node, a DC rack/equipment, or a DC slot device. */
export interface SceneObject {
  /** Spec id (nodes, racks, equipment). Slot devices use `rackId/slotId`. */
  readonly id: string;
  readonly source: "node" | "dc";
  /** `SpecNodeType` for nodes; DC slot or equipment type (or `rack`) for DC objects. */
  readonly type: SpecNodeType | string;
  readonly category: NodeCategory;
  readonly primitive: PrimitiveKind;
  /** World space. */
  readonly box: Box3;
  readonly label?: string;
  readonly badge?: string;
  readonly icon?: IconPlacement;
  readonly group?: string;
  /** Initial state (spec `state`, default `healthy`). */
  readonly state: ObjectState;
  /** Composite sub-solids, world space, already in back-to-front order within the object. */
  readonly parts?: readonly ScenePart[];
  /** Named attachment points for edges and cables (e.g. `power-a`, `net-0`), world space. */
  readonly ports?: Readonly<Record<string, Vec3>>;
}

/** What a group represents; DC rows/aisles/hall come from the DC pack. */
export type GroupKind = "group" | "row" | "cold-aisle" | "hot-aisle" | "hall";

/** A zone/vpc/cluster/platform, or a DC row/aisle/hall: a slab or outline under its members. */
export interface SceneGroup {
  readonly id: string;
  readonly kind: GroupKind;
  readonly label?: string;
  /** Visual style for `kind: "group"`; DC kinds use `zone` and their own theme tones. */
  readonly style: GroupStyle;
  readonly parent?: string;
  /** Aisle containment (PLAN §9). */
  readonly contained?: boolean;
  /** Footprint (x/y) and slab thickness (z), world space. */
  readonly box: Box3;
  /** Nesting depth, 0 = top-level. Deeper groups draw above shallower ones. */
  readonly level: number;
}

/** A routed connection. Edges, DC cables and synthetic flow paths are all SceneEdges. */
export interface SceneEdge {
  /** Spec edge id, cable id, or a generated id (see module doc). */
  readonly id: string;
  /** Object ids (`rackId/slotId` allowed) or, for airflow, group ids. */
  readonly from: string;
  readonly to: string;
  readonly kind: "edge" | "cable";
  /** For cables: power | network | fiber | management. */
  readonly cableKind?: "power" | "network" | "fiber" | "management";
  readonly style: EdgeStyle;
  readonly bidirectional: boolean;
  /**
   * True for synthetic paths that exist only for particles: a `from`+`to` flow with
   * no matching edge, and DC airflow. Emit puts only the path (in `<defs>`), never a visible line.
   */
  readonly hidden: boolean;
  readonly label?: string;
  /** Orthogonal polyline along the iso axes (PLAN §6 routing), start to end, world space. */
  readonly path: readonly Vec3[];
  readonly arrow: { readonly start: boolean; readonly end: boolean };
  readonly labelAnchor?: Vec3;
}

/** Particles travelling along an edge path. */
export interface SceneFlow {
  /** Generated id (see module doc). */
  readonly id: string;
  /** Id of the SceneEdge whose path the particles follow (possibly a hidden one). */
  readonly edge: string;
  readonly kind: FlowKind;
  /** Particles per second at speed 1 (default 1, max 20). */
  readonly rate: number;
  /** Resolved color: hex or `palette:<name>` / `flow:<kind>` theme reference; undefined = `flows[kind]`. */
  readonly color?: string;
  /** True when particles travel `to` → `from`. */
  readonly reverse: boolean;
}

export interface SceneMetric {
  readonly id: string;
  readonly label: string;
  readonly value: string | number;
}

/**
 * One step of the timeline (PLAN §7). Semantics:
 * - `index` is 1-based; output `step-NN` uses it.
 * - `states` and `metrics` are cumulative (base, then each earlier step's changes).
 * - A spec step that lists `flows` (even `[]`) replaces the base flows for that step
 *   only; a step without `flows` shows the base flows. Step flows never carry over.
 * - `focus` applies to that step only; absent = full view (the whole diagram / hall).
 * - The looping timeline plays steps 1..n; the base state is shown only when there are no steps.
 * - Time 0 (static frame, default PNG) = the start of step 1, or the base state.
 */
export interface SceneStep {
  readonly index: number;
  readonly caption?: string;
  /** Seconds at speed 1 (default 3, max 600). */
  readonly duration: number;
  readonly states: Readonly<Record<string, ObjectState>>;
  readonly flows: readonly SceneFlow[];
  readonly metrics: Readonly<Record<string, string | number>>;
  /** Object/group/row/rack/slot id to zoom to. */
  readonly focus?: string;
}

export interface LegendEntry {
  readonly label: string;
  /** Resolved color (hex or theme reference, as in `SceneFlow.color`). */
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
  readonly objects: readonly SceneObject[];
  readonly groups: readonly SceneGroup[];
  readonly edges: readonly SceneEdge[];
  readonly flows: readonly SceneFlow[];
  readonly metrics: readonly SceneMetric[];
  readonly legend: readonly LegendEntry[];
  /** Empty when the spec has no steps. */
  readonly timeline: readonly SceneStep[];
  /** World boxes of every valid `focus` target (objects, slots, groups, rows, racks). */
  readonly focusTargets: Readonly<Record<string, Box3>>;
  /** World bounds of everything drawn. */
  readonly bounds: Box3;
  readonly diagnostics: readonly Diagnostic[];
}
