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
$schema?: string
meta: {
version: "1"
title?: SpecText
description?: string
}
canvas?: {
theme?: ("light" | "dark" | "blueprint" | "mono")
grid?: boolean
padding?: number
aspect?: string
}
/**
 * @minItems 1
 * @maxItems 500
 */
nodes?: [SpecNode, ...(SpecNode)[]]
/**
 * @maxItems 200
 */
groups?: SpecGroup[]
/**
 * @maxItems 1000
 */
edges?: SpecEdge[]
/**
 * @maxItems 200
 */
flows?: SpecFlow[]
/**
 * @maxItems 50
 */
metrics?: SpecMetric[]
/**
 * @maxItems 99
 */
steps?: SpecStep[]
legend?: ("auto" | {
label: SpecText
color?: SpecColor
}[])
/**
 * @minItems 1
 * @maxItems 500
 */
racks?: [SpecRack, ...(SpecRack)[]]
/**
 * @minItems 1
 * @maxItems 200
 */
equipment?: [SpecEquipment, ...(SpecEquipment)[]]
/**
 * @maxItems 100
 */
rows?: SpecRow[]
/**
 * @maxItems 100
 */
aisles?: SpecAisle[]
/**
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
 * Hex (#rgb/#rrggbb) or a theme palette name: blue, green, red, orange, yellow, purple, teal, pink, gray, or a flow kind (normal, heavy, health, failed, airflow, power).
 */
export type SpecColor = string
export type SpecMetricValue = (string | number)
/**
 * Defaults to u<at>.
 */
export type SpecId1 = string
export type SpecDcSlotType = ("server-1u" | "server-2u" | "server-4u" | "blade-chassis" | "gpu-node" | "switch-tor" | "switch-leaf" | "switch-spine" | "patch-panel" | "storage-shelf" | "storage-flash" | "storage-jbod" | "pdu-1u" | "ups-2u" | "blank")
export type SpecDcEquipmentType = ("ups" | "busway" | "pdu-floor" | "crah" | "in-row-cooler" | "cdu" | "tape-library")

export interface SpecNode {
id: SpecId
type: SpecNodeType
icon?: string
label?: SpecText
badge?: SpecText
size?: ("sm" | "md" | "lg")
pos?: SpecGridPos
group?: SpecId
state?: SpecState
}
/**
 * Manual grid position override (tiles).
 */
export interface SpecGridPos {
x: number
y: number
}
export interface SpecGroup {
id: SpecId
label?: SpecText
style?: ("zone" | "vpc" | "cluster" | "platform")
parent?: SpecId
}
export interface SpecEdge {
id?: SpecId
from: SpecEndpoint
to: SpecEndpoint
label?: SpecText
style?: ("solid" | "dashed" | "dotted")
bidirectional?: boolean
}
export interface SpecFlowByEdge {
edge: SpecId
kind?: SpecFlowKind
rate?: number
color?: SpecColor
}
export interface SpecFlowByEndpoints {
from: SpecEndpoint
to: SpecEndpoint
kind?: SpecFlowKind
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
set?: {
[k: string]: SpecState
}
/**
 * @maxItems 200
 */
flows?: SpecFlow[]
metrics?: {
[k: string]: SpecMetricValue
}
duration?: number
focus?: SpecEndpoint
}
export interface SpecRack {
id: SpecId
label?: SpecText
u?: (42 | 45 | 48)
pos?: SpecGridPos
state?: SpecState
pdu?: ("none" | "single" | "dual")
rearDoorHeatExchanger?: boolean
/**
 * @maxItems 48
 */
slots?: SpecRackSlot[]
}
export interface SpecRackSlot {
id?: SpecId1
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
 * @minItems 1
 * @maxItems 100
 */
members: [SpecId, ...(SpecId)[]]
facing?: ("front" | "back")
}
export interface SpecAisle {
id: SpecId
label?: SpecText
kind: ("cold" | "hot")
/**
 * The one or two rows bounding the aisle.
 * 
 * @minItems 1
 * @maxItems 2
 */
rows: [SpecId]|[SpecId, SpecId]
contained?: boolean
}
export interface SpecCable {
id?: SpecId
from: SpecEndpoint
to: SpecEndpoint
kind?: ("power" | "network" | "fiber" | "management")
label?: SpecText
}
export interface SpecFacility {
raisedFloor?: boolean
perforatedTiles?: boolean
cableTrays?: ("none" | "overhead" | "underfloor")
}
