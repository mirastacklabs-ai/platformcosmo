/* eslint-disable */
/**
 * GENERATED from schema/v1.json by scripts/gen-types.mjs. Do not edit.
 * Run `pnpm gen:types` to regenerate.
 */

/**
 * PlatformCosmo spec, format major version 1. Draft until v1.0.
 */
export type PlatformCosmoSpec = (({
nodes: unknown
} | {
racks: unknown
} | {
equipment: unknown
}) & {
/**
 * Schema URL that editors use for completion, normally https://platformcosmo.io/schema/v1.json.
 */
$schema?: string
/**
 * Spec metadata: format version, title and description.
 */
meta: {
/**
 * Spec format major version, always the string "1".
 */
version: "1"
title?: SpecText
/**
 * Longer description of the spec, used as the SVG desc element.
 */
description?: string
}
/**
 * Canvas appearance: theme, background grid, padding and aspect ratio.
 */
canvas?: {
/**
 * Color theme for the diagram: light, dark, blueprint or mono.
 */
theme?: ("light" | "dark" | "blueprint" | "mono")
/**
 * Whether to draw the iso ground grid behind the diagram (on by default; set false for a plain background).
 */
grid?: boolean
/**
 * Empty space around the diagram in pixels, from 0 to 1000.
 */
padding?: number
/**
 * Output aspect ratio: "auto" or "width:height" such as 16:9.
 */
aspect?: string
}
/**
 * Components to draw, each with a semantic type and an optional icon.
 * 
 * @minItems 1
 * @maxItems 500
 */
nodes?: [SpecNode, ...(SpecNode)[]]
/**
 * Zones, VPCs, clusters or platforms that group nodes, optionally nested.
 * 
 * @maxItems 200
 */
groups?: SpecGroup[]
/**
 * Connections between objects (nodes, racks, equipment, or rackId/slotId).
 * 
 * @maxItems 1000
 */
edges?: SpecEdge[]
/**
 * Animated flows of traffic or power along an edge, a cable or a pair of endpoints.
 * 
 * @maxItems 200
 */
flows?: SpecFlow[]
/**
 * Headline metric tiles shown with the diagram.
 * 
 * @maxItems 50
 */
metrics?: SpecMetric[]
/**
 * Animation steps, each with a caption, state changes, flows, metrics and a focus target.
 * 
 * @maxItems 99
 */
steps?: SpecStep[]
/**
 * Legend mode: "auto" to derive entries from the diagram, or a manual list of label and color pairs.
 */
legend?: ("auto" | {
label: SpecText
color?: SpecColor
}[])
/**
 * Equipment racks, each with a height in rack units and optional slots.
 * 
 * @minItems 1
 * @maxItems 500
 */
racks?: [SpecRack, ...(SpecRack)[]]
/**
 * Data-center equipment items (UPS, CRAH, CDU and similar) placed on the floor.
 * 
 * @minItems 1
 * @maxItems 200
 */
equipment?: [SpecEquipment, ...(SpecEquipment)[]]
/**
 * Ordered rows of racks or equipment on the floor, with a facing direction.
 * 
 * @maxItems 100
 */
rows?: SpecRow[]
/**
 * Cold or hot aisles, each grouping rows of racks.
 * 
 * @maxItems 100
 */
aisles?: SpecAisle[]
/**
 * DC cables (power, network, fiber or management) between racks, slots and equipment.
 * 
 * @maxItems 2000
 */
cables?: SpecCable[]
facility?: SpecFacility
})
export type SpecText = string
export type SpecId = string
export type SpecNodeType = ("server" | "vm" | "container" | "pod" | "function" | "lb" | "gateway" | "cdn" | "dns" | "firewall" | "vpc" | "sql" | "nosql" | "cache" | "object-store" | "warehouse" | "queue" | "stream" | "users" | "client" | "mobile" | "metrics" | "logs" | "traces" | "repo" | "pipeline" | "registry" | "iam" | "secrets" | "waf" | "llm" | "embedding" | "vector-db" | "gpu" | "inference-server" | "agent" | "tool" | "rag" | "guardrail" | "feature-store" | "training-job")
export type SpecState = ("healthy" | "degraded" | "down" | "highlighted")
/**
 * An object id, or rackId/slotId for a device in a rack slot.
 */
export type SpecEndpoint = string
export type SpecFlow = (SpecFlowByEdge | SpecFlowByEndpoints)
export type SpecFlowKind = ("normal" | "heavy" | "health" | "failed" | "airflow" | "power")
/**
 * #rgb or #rrggbb hex, a palette name (blue, green, red, orange, yellow, purple, teal, pink, gray) or a flow kind name. Flow kind names: normal, heavy, health, failed, airflow, power.
 */
export type SpecColor = string
export type SpecMetricValue = (string | number)
export type SpecDcSlotType = ("server-1u" | "server-2u" | "server-4u" | "blade-chassis" | "gpu-node" | "switch-tor" | "switch-leaf" | "switch-spine" | "patch-panel" | "storage-shelf" | "storage-flash" | "storage-jbod" | "pdu-1u" | "ups-2u" | "blank")
export type SpecDcEquipmentType = ("ups" | "busway" | "pdu-floor" | "crah" | "in-row-cooler" | "cdu" | "tape-library")

export interface SpecNode {
id: SpecId
type: SpecNodeType
/**
 * Icon name to draw, such as aws:rds, which must be installed.
 */
icon?: string
label?: SpecText
badge?: SpecText
/**
 * Node size: sm, md or lg.
 */
size?: ("sm" | "md" | "lg")
pos?: SpecGridPos
group?: SpecId
state?: SpecState
}
/**
 * Manual grid position override (tiles).
 */
export interface SpecGridPos {
/**
 * Horizontal grid tile coordinate, from -1000 to 1000.
 */
x: number
/**
 * Vertical grid tile coordinate, from -1000 to 1000.
 */
y: number
}
export interface SpecGroup {
id: SpecId
label?: SpecText
/**
 * Visual style of the group: zone, vpc, cluster or platform.
 */
style?: ("zone" | "vpc" | "cluster" | "platform")
parent?: SpecId
}
export interface SpecEdge {
id?: SpecId
from: SpecEndpoint
to: SpecEndpoint
label?: SpecText
/**
 * Line style of the edge: solid, dashed or dotted.
 */
style?: ("solid" | "dashed" | "dotted")
/**
 * Whether the edge is drawn as two-way rather than one-way.
 */
bidirectional?: boolean
}
export interface SpecFlowByEdge {
edge: SpecId
kind?: SpecFlowKind
/**
 * Particles emitted per second (0 < rate <= 20). Each flow costs ceil(rate x 2) particles; the total over base and all step flows must be <= 2000.
 */
rate?: number
color?: SpecColor
}
export interface SpecFlowByEndpoints {
from: SpecEndpoint
to: SpecEndpoint
kind?: SpecFlowKind
/**
 * Particles emitted per second (0 < rate <= 20). Each flow costs ceil(rate x 2) particles; the total over base and all step flows must be <= 2000.
 */
rate?: number
color?: SpecColor
}
export interface SpecMetric {
id: SpecId
label: SpecText
value: SpecMetricValue
}
export interface SpecStep {
caption?: SpecText
/**
 * State changes from this step onward (cumulative), keyed by object id or rackId/slotId.
 */
set?: {
[k: string]: SpecState
}
/**
 * If present (even []), replaces the base flows for this step only; omit to keep the base flows.
 * 
 * @maxItems 200
 */
flows?: SpecFlow[]
/**
 * Metric values from this step onward (cumulative), keyed by metric id.
 */
metrics?: {
[k: string]: SpecMetricValue
}
/**
 * Step length in seconds at speed 1 (> 0, <= 600).
 */
duration?: number
focus?: SpecEndpoint
}
export interface SpecRack {
id: SpecId
label?: SpecText
/**
 * Rack height in rack units: 42, 45 or 48.
 */
u?: (42 | 45 | 48)
pos?: SpecGridPos
state?: SpecState
/**
 * PDU redundancy for the rack: none, single or dual.
 */
pdu?: ("none" | "single" | "dual")
/**
 * Whether the rack has a rear-door heat exchanger.
 */
rearDoorHeatExchanger?: boolean
/**
 * Devices placed in the rack's rack units.
 * 
 * @maxItems 48
 */
slots?: SpecRackSlot[]
}
export interface SpecRackSlot {
id?: SpecId
/**
 * Lowest rack unit the device occupies (1 = bottom).
 */
at: number
/**
 * Rack units; defaults to the device type height.
 */
size?: number
type: SpecDcSlotType
label?: SpecText
state?: SpecState
}
export interface SpecEquipment {
id: SpecId
type: SpecDcEquipmentType
label?: SpecText
pos?: SpecGridPos
state?: SpecState
}
export interface SpecRow {
id: SpecId
label?: SpecText
/**
 * Ids of the racks or equipment items in the row, in order.
 * 
 * @minItems 1
 * @maxItems 100
 */
members: [SpecId, ...(SpecId)[]]
/**
 * Which side of the rack faces the row front. Omit to derive it from the aisles: rows face their cold aisle and turn their backs to their hot aisle.
 */
facing?: ("front" | "back")
}
export interface SpecAisle {
id: SpecId
label?: SpecText
/**
 * Whether the aisle is a cold aisle or a hot aisle.
 */
kind: ("cold" | "hot")
/**
 * The one or two rows bounding the aisle.
 * 
 * @minItems 1
 * @maxItems 2
 */
rows: [SpecId]|[SpecId, SpecId]
/**
 * Whether the aisle is enclosed by doors or containment.
 */
contained?: boolean
}
export interface SpecCable {
id?: SpecId
from: SpecEndpoint
to: SpecEndpoint
/**
 * Cable type: power, network, fiber or management.
 */
kind?: ("power" | "network" | "fiber" | "management")
label?: SpecText
}
export interface SpecFacility {
/**
 * Whether the room has a raised floor.
 */
raisedFloor?: boolean
/**
 * Whether the raised floor uses perforated airflow tiles.
 */
perforatedTiles?: boolean
/**
 * Where cable trays run: none, overhead or underfloor.
 */
cableTrays?: ("none" | "overhead" | "underfloor")
}
