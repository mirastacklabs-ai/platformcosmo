/* eslint-disable */
/**
 * GENERATED from schema/v1.json by scripts/gen-types.mjs. Do not edit.
 * Run `pnpm gen:types` to regenerate.
 */

export type SpecId = string
export type SpecNodeType = ("server" | "vm" | "container" | "pod" | "function" | "lb" | "gateway" | "cdn" | "dns" | "firewall" | "vpc" | "sql" | "nosql" | "cache" | "object-store" | "warehouse" | "queue" | "stream" | "users" | "client" | "mobile" | "metrics" | "logs" | "traces" | "repo" | "pipeline" | "registry" | "iam" | "secrets" | "waf" | "llm" | "embedding" | "vector-db" | "gpu" | "inference-server" | "agent" | "tool" | "rag" | "guardrail" | "feature-store" | "training-job")
export type SpecFlow = (SpecFlowByEdge | SpecFlowByEndpoints)
export type SpecColor = string
export type SpecState = ("healthy" | "degraded" | "down" | "highlighted")

/**
 * Draft v1 schema (M0). Subject to change until v1.0.
 */
export interface PlatformCosmoSpec {
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
nodes: [SpecNode, ...(SpecNode)[]]
groups?: SpecGroup[]
edges?: SpecEdge[]
flows?: SpecFlow[]
metrics?: SpecMetric[]
steps?: SpecStep[]
legend?: ("auto" | {
label: string
color?: SpecColor
}[])
}
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
}
export interface SpecGroup {
id: SpecId
label?: string
style?: ("zone" | "vpc" | "cluster" | "platform")
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
kind?: ("normal" | "heavy" | "health" | "failed")
rate?: number
color?: SpecColor
}
export interface SpecFlowByEndpoints {
from: SpecId
to: SpecId
kind?: ("normal" | "heavy" | "health" | "failed")
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
}
