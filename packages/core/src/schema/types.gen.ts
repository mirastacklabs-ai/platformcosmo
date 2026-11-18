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
 * Whether to draw a background grid behind the diagram.
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
 * Logical connections between nodes, drawn as lines with optional labels.
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
label: SpecText7
color?: SpecColor2
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
 * Physical cables between endpoints, carrying power, network or fiber.
 * 
 * @maxItems 2000
 */
cables?: SpecCable[]
facility?: SpecFacility
})
/**
 * Short title of the spec, used as the SVG title element.
 */
export type SpecText = string
/**
 * Unique identifier of the node, used by edges, flows and steps.
 */
export type SpecId = string
/**
 * Semantic component type, such as lb, sql or queue.
 */
export type SpecNodeType = ("server" | "vm" | "container" | "pod" | "function" | "lb" | "gateway" | "cdn" | "dns" | "firewall" | "vpc" | "sql" | "nosql" | "cache" | "object-store" | "warehouse" | "queue" | "stream" | "users" | "client" | "mobile" | "metrics" | "logs" | "traces" | "repo" | "pipeline" | "registry" | "iam" | "secrets" | "waf" | "llm" | "embedding" | "vector-db" | "gpu" | "inference-server" | "agent" | "tool" | "rag" | "guardrail" | "feature-store" | "training-job")
/**
 * Text label shown for the node.
 */
export type SpecText1 = string
/**
 * Short badge text shown on the node.
 */
export type SpecText2 = string
/**
 * Id of the group that contains the node.
 */
export type SpecId1 = string
/**
 * Initial operational state of the node: healthy, degraded, down or highlighted.
 */
export type SpecState = ("healthy" | "degraded" | "down" | "highlighted")
/**
 * Unique identifier of the group.
 */
export type SpecId2 = string
/**
 * Text label shown for the group.
 */
export type SpecText3 = string
/**
 * Id of the enclosing group, used for nesting.
 */
export type SpecId3 = string
/**
 * Optional unique identifier of the edge, used to reference it from flows.
 */
export type SpecId4 = string
/**
 * Source endpoint of the edge, as an object id or a rackId/slotId pair.
 */
export type SpecEndpoint = string
/**
 * Destination endpoint of the edge, as an object id or a rackId/slotId pair.
 */
export type SpecEndpoint1 = string
/**
 * Text label shown on the edge.
 */
export type SpecText4 = string
export type SpecFlow = (SpecFlowByEdge | SpecFlowByEndpoints)
/**
 * Id of the edge or cable that the flow travels along.
 */
export type SpecId5 = string
/**
 * Flow kind that sets the default look: normal, heavy, health, failed, airflow or power.
 */
export type SpecFlowKind = ("normal" | "heavy" | "health" | "failed" | "airflow" | "power")
/**
 * Color of the flow animation, as a hex value or palette name.
 */
export type SpecColor = string
/**
 * Source endpoint of the flow, as an object id or a rackId/slotId pair.
 */
export type SpecEndpoint2 = string
/**
 * Destination endpoint of the flow, as an object id or a rackId/slotId pair.
 */
export type SpecEndpoint3 = string
/**
 * Flow kind that sets the default look: normal, heavy, health, failed, airflow or power.
 */
export type SpecFlowKind1 = ("normal" | "heavy" | "health" | "failed" | "airflow" | "power")
/**
 * Color of the flow animation, as a hex value or palette name.
 */
export type SpecColor1 = string
/**
 * Unique identifier of the metric tile.
 */
export type SpecId6 = string
/**
 * Text label shown on the metric tile.
 */
export type SpecText5 = string
/**
 * Value shown on the metric tile, as text or a number.
 */
export type SpecMetricValue = (string | number)
/**
 * Text caption shown while the step plays.
 */
export type SpecText6 = string
export type SpecState1 = ("healthy" | "degraded" | "down" | "highlighted")
export type SpecMetricValue1 = (string | number)
/**
 * An object id, or rackId/slotId for a device in a rack slot.
 */
export type SpecEndpoint4 = string
/**
 * Text shown for the legend entry.
 */
export type SpecText7 = string
/**
 * Color swatch for the legend entry, as a hex value or palette name.
 */
export type SpecColor2 = string
/**
 * Unique identifier of the rack.
 */
export type SpecId7 = string
/**
 * Text label shown for the rack.
 */
export type SpecText8 = string
/**
 * Operational state of the rack.
 */
export type SpecState2 = ("healthy" | "degraded" | "down" | "highlighted")
/**
 * Defaults to u<at>.
 */
export type SpecId8 = string
/**
 * Device type placed in the slot, such as server-1u or switch-tor.
 */
export type SpecDcSlotType = ("server-1u" | "server-2u" | "server-4u" | "blade-chassis" | "gpu-node" | "switch-tor" | "switch-leaf" | "switch-spine" | "patch-panel" | "storage-shelf" | "storage-flash" | "storage-jbod" | "pdu-1u" | "ups-2u" | "blank")
/**
 * Text label shown for the device in the slot.
 */
export type SpecText9 = string
/**
 * Operational state of the device in the slot.
 */
export type SpecState3 = ("healthy" | "degraded" | "down" | "highlighted")
/**
 * Unique identifier of the equipment item.
 */
export type SpecId9 = string
/**
 * Kind of data-center equipment, such as ups, crah or cdu.
 */
export type SpecDcEquipmentType = ("ups" | "busway" | "pdu-floor" | "crah" | "in-row-cooler" | "cdu" | "tape-library")
/**
 * Text label shown for the equipment item.
 */
export type SpecText10 = string
/**
 * Operational state of the equipment item.
 */
export type SpecState4 = ("healthy" | "degraded" | "down" | "highlighted")
/**
 * Unique identifier of the row.
 */
export type SpecId10 = string
/**
 * Text label shown for the row.
 */
export type SpecText11 = string
export type SpecId11 = string
/**
 * Unique identifier of the aisle.
 */
export type SpecId12 = string
/**
 * Text label shown for the aisle.
 */
export type SpecText12 = string
/**
 * Unique identifier of the cable.
 */
export type SpecId13 = string
/**
 * An object id, or rackId/slotId for a device in a rack slot.
 */
export type SpecEndpoint5 = string
/**
 * An object id, or rackId/slotId for a device in a rack slot.
 */
export type SpecEndpoint6 = string
/**
 * Text label shown on the cable.
 */
export type SpecText13 = string

export interface SpecNode {
id: SpecId
type: SpecNodeType
/**
 * Icon name to draw, such as aws:rds, which must be installed.
 */
icon?: string
label?: SpecText1
badge?: SpecText2
/**
 * Node size: sm, md or lg.
 */
size?: ("sm" | "md" | "lg")
pos?: SpecGridPos
group?: SpecId1
state?: SpecState
}
/**
 * Optional manual grid position that overrides automatic layout.
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
id: SpecId2
label?: SpecText3
/**
 * Visual style of the group: zone, vpc, cluster or platform.
 */
style?: ("zone" | "vpc" | "cluster" | "platform")
parent?: SpecId3
}
export interface SpecEdge {
id?: SpecId4
from: SpecEndpoint
to: SpecEndpoint1
label?: SpecText4
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
edge: SpecId5
kind?: SpecFlowKind
/**
 * Relative speed of the flow animation, greater than 0 and at most 20.
 */
rate?: number
color?: SpecColor
}
export interface SpecFlowByEndpoints {
from: SpecEndpoint2
to: SpecEndpoint3
kind?: SpecFlowKind1
/**
 * Relative speed of the flow animation, greater than 0 and at most 20.
 */
rate?: number
color?: SpecColor1
}
export interface SpecMetric {
id: SpecId6
label: SpecText5
value: SpecMetricValue
}
export interface SpecStep {
caption?: SpecText6
/**
 * State changes applied during this step, keyed by endpoint id.
 */
set?: {
[k: string]: SpecState1
}
/**
 * Flows animated during this step.
 * 
 * @maxItems 200
 */
flows?: SpecFlow[]
/**
 * Metric values set during this step, keyed by metric id.
 */
metrics?: {
[k: string]: SpecMetricValue1
}
/**
 * Length of the step, greater than 0 and at most 600.
 */
duration?: number
focus?: SpecEndpoint4
}
export interface SpecRack {
id: SpecId7
label?: SpecText8
/**
 * Rack height in rack units: 42, 45 or 48.
 */
u?: (42 | 45 | 48)
pos?: SpecGridPos1
state?: SpecState2
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
/**
 * Optional manual grid position that overrides automatic placement.
 */
export interface SpecGridPos1 {
/**
 * Horizontal grid tile coordinate, from -1000 to 1000.
 */
x: number
/**
 * Vertical grid tile coordinate, from -1000 to 1000.
 */
y: number
}
export interface SpecRackSlot {
id?: SpecId8
/**
 * Starting rack unit of the device within the rack.
 */
at: number
/**
 * Rack units; defaults to the device type height.
 */
size?: number
type: SpecDcSlotType
label?: SpecText9
state?: SpecState3
}
export interface SpecEquipment {
id: SpecId9
type: SpecDcEquipmentType
label?: SpecText10
pos?: SpecGridPos2
state?: SpecState4
}
/**
 * Optional manual grid position that overrides automatic placement.
 */
export interface SpecGridPos2 {
/**
 * Horizontal grid tile coordinate, from -1000 to 1000.
 */
x: number
/**
 * Vertical grid tile coordinate, from -1000 to 1000.
 */
y: number
}
export interface SpecRow {
id: SpecId10
label?: SpecText11
/**
 * Ids of the racks or equipment items in the row, in order.
 * 
 * @minItems 1
 * @maxItems 100
 */
members: [SpecId11, ...(SpecId11)[]]
/**
 * Direction the row's equipment faces: front or back.
 */
facing?: ("front" | "back")
}
export interface SpecAisle {
id: SpecId12
label?: SpecText12
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
rows: [SpecId11]|[SpecId11, SpecId11]
/**
 * Whether the aisle is enclosed by doors or containment.
 */
contained?: boolean
}
export interface SpecCable {
id?: SpecId13
from: SpecEndpoint5
to: SpecEndpoint6
/**
 * Cable type: power, network, fiber or management.
 */
kind?: ("power" | "network" | "fiber" | "management")
label?: SpecText13
}
/**
 * Facility-wide settings: raised floor, perforated tiles and cable trays.
 */
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
