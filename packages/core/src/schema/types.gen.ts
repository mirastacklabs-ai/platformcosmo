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
title?: string
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
 */
nodes?: [SpecNode, ...(SpecNode)[]]
groups?: SpecGroup[]
edges?: SpecEdge[]
flows?: SpecFlow[]
metrics?: SpecMetric[]
steps?: SpecStep[]
legend?: ("auto" | {
label: string
color?: SpecColor
}[])
/**
 * @minItems 1
 */
racks?: [SpecRack, ...(SpecRack)[]]
/**
 * @minItems 1
 */
equipment?: [SpecEquipment, ...(SpecEquipment)[]]
rows?: SpecRow[]
aisles?: SpecAisle[]
cables?: SpecCable[]
facility?: SpecFacility
})
export type SpecId = string
export type SpecNodeType = ("server" | "vm" | "container" | "pod" | "function" | "lb" | "gateway" | "cdn" | "dns" | "firewall" | "vpc" | "sql" | "nosql" | "cache" | "object-store" | "warehouse" | "queue" | "stream" | "users" | "client" | "mobile" | "metrics" | "logs" | "traces" | "repo" | "pipeline" | "registry" | "iam" | "secrets" | "waf" | "llm" | "embedding" | "vector-db" | "gpu" | "inference-server" | "agent" | "tool" | "rag" | "guardrail" | "feature-store" | "training-job")
export type SpecState = ("healthy" | "degraded" | "down" | "highlighted")
export type SpecFlow = (SpecFlowByEdge | SpecFlowByEndpoints)
export type SpecFlowKind = ("normal" | "heavy" | "health" | "failed" | "airflow" | "power")
export type SpecColor = string
export type SpecDcSlotType = ("server-1u" | "server-2u" | "server-4u" | "blade-chassis" | "gpu-node" | "switch-tor" | "switch-leaf" | "switch-spine" | "patch-panel" | "storage-shelf" | "storage-flash" | "storage-jbod" | "pdu-1u" | "ups-2u" | "blank")
export type SpecDcEquipmentType = ("ups" | "busway" | "pdu-floor" | "crah" | "in-row-cooler" | "cdu" | "tape-library")
/**
 * An object id, or rackId/slotId for a rack slot.
 */
export type SpecEndpoint = string

export interface SpecNode {
id: SpecId
type: SpecNodeType
icon?: string
label?: string
badge?: string
size?: ("sm" | "md" | "lg")
pos?: {
x: number
y: number
}
group?: SpecId
state?: SpecState
}
export interface SpecGroup {
id: SpecId
label?: string
style?: ("zone" | "vpc" | "cluster" | "platform")
parent?: SpecId
}
export interface SpecEdge {
id?: SpecId
from: SpecId
to: SpecId
label?: string
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
from: SpecId
to: SpecId
kind?: SpecFlowKind
rate?: number
color?: SpecColor
}
export interface SpecMetric {
id: SpecId
label: string
value: (string | number)
}
export interface SpecStep {
caption?: string
set?: {
[k: string]: SpecState
}
flows?: SpecFlow[]
metrics?: {
[k: string]: string | number
}
duration?: number
focus?: SpecId
}
export interface SpecRack {
id: SpecId
label?: string
u?: (42 | 45 | 48)
pos?: {
x: number
y: number
}
state?: SpecState
pdu?: ("none" | "single" | "dual")
rearDoorHeatExchanger?: boolean
slots?: SpecRackSlot[]
}
export interface SpecRackSlot {
id?: SpecId
at: number
size?: number
type: SpecDcSlotType
label?: string
state?: SpecState
}
export interface SpecEquipment {
id: SpecId
type: SpecDcEquipmentType
label?: string
pos?: {
x: number
y: number
}
state?: SpecState
}
export interface SpecRow {
id: SpecId
label?: string
/**
 * @minItems 1
 */
members: [SpecId, ...(SpecId)[]]
facing?: ("front" | "back")
}
export interface SpecAisle {
id: SpecId
label?: string
kind: ("cold" | "hot")
/**
 * @minItems 2
 * @maxItems 2
 */
rows: [SpecId, SpecId]
contained?: boolean
}
export interface SpecCable {
id?: SpecId
from: SpecEndpoint
to: SpecEndpoint
kind?: ("power" | "network" | "fiber" | "management")
label?: string
}
export interface SpecFacility {
raisedFloor?: boolean
perforatedTiles?: boolean
cableTrays?: ("none" | "overhead" | "underfloor")
busway?: boolean
}
