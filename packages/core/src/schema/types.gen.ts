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
} | {
assemblies: unknown
} | {
storyboards: unknown
} | {
figures: unknown
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
/**
 * Component-driven units (an engine, a server, a brick model) built from parts, with programmable explode and build programs (schema 1.2.0).
 * 
 * @minItems 1
 * @maxItems 50
 */
assemblies?: [SpecAssembly, ...(SpecAssembly)[]]
/**
 * Images that parts and storyboards use: local files next to the spec or inline base64 data, never URLs (schema 1.2.0).
 * 
 * @maxItems 256
 */
images?: SpecImage[]
/**
 * Flat build storyboards made from a document's own step renders and part thumbnails; build forward and back only, no explode (schema 1.2.0).
 * 
 * @minItems 1
 * @maxItems 10
 */
storyboards?: [SpecStoryboard]|[SpecStoryboard, SpecStoryboard]|[SpecStoryboard, SpecStoryboard, SpecStoryboard]|[SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard]|[SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard]|[SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard]|[SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard]|[SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard]|[SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard]|[SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard, SpecStoryboard]
/**
 * Document figures animated in their own drawn plane: cut-out sprites move between the drawn exploded and seated positions (schema 1.2.0).
 * 
 * @minItems 1
 * @maxItems 20
 */
figures?: [SpecFigure]|[SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]|[SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure, SpecFigure]
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
/**
 * An id, or up to 8 ids joined by / that address a rack slot (rackId/slotId) or an assembly part (assemblyId/partId/...).
 */
export type SpecPartPath = string
/**
 * A pose change of an assembly, sub-assembly, rack or storyboard in a step.
 */
export type SpecAssemblyAction = (SpecExplodeAction | SpecImplodeAction | SpecBuildAction | SpecUnbuildAction)
export type SpecDcSlotType = ("server-1u" | "server-2u" | "server-4u" | "blade-chassis" | "gpu-node" | "switch-tor" | "switch-leaf" | "switch-spine" | "patch-panel" | "storage-shelf" | "storage-flash" | "storage-jbod" | "pdu-1u" | "ups-2u" | "blank")
/**
 * An explode program (ordered stages) or a build program (ordered build steps).
 */
export type SpecProgram = (SpecExplodeProgram | SpecBuildProgram)
/**
 * Union of selectors.
 * 
 * @minItems 1
 * @maxItems 64
 */
export type SpecPartSelectors = [SpecPartSelector, ...(SpecPartSelector)[]]
/**
 * Selects parts of the program's assembly: a part path relative to the assembly (head/cam-intake), a glob (cyl-*, head/**, dimm-?), or tag:<tag>, type:<type>, role:<role>, id:<glob>. * matches within one path segment, ** any number of segments, ? one character. A selected sub-assembly moves as one unit.
 */
export type SpecPartSelector = string
/**
 * Where a part travels. Presets: away (from the surface it mates with; the default), up, down, +x, -x, +y, -y, +z, -z (axes of the assembly frame), out (away from the parent's centre, snapped to the nearest horizontal axis), radial (away from the parent's centre in the horizontal plane, not snapped), axis (along the part's own cylinder or shaft axis, away from the parent's centre), drawer (toward the assembly front, like a rack device sliding out) and lift (up, stacked in layers so every layer clears the one below). Or an explicit [x, y, z] vector.
 */
export type SpecDirection = (("away" | "up" | "down" | "+x" | "-x" | "+y" | "-y" | "+z" | "-z" | "out" | "radial" | "axis" | "drawer" | "lift") | SpecVec3)
/**
 * [x, y, z] in the assembly's units: x runs to the lower right of the screen, y to the lower left, z up.
 * 
 * @minItems 3
 * @maxItems 3
 */
export type SpecVec3 = [number, number, number]
/**
 * How far a part travels: a number in the assembly's units, "auto" (clear its seat and every part it stacks with, plus the program gap) or a multiple of the auto distance such as "1.5x".
 */
export type SpecDistance = (number | string)
/**
 * Motion easing. All are monotonic (no overshoot), so a part never leaves the segment between its two poses.
 */
export type SpecEasing = ("linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out")
export type SpecDcEquipmentType = ("ups" | "busway" | "pdu-floor" | "crah" | "in-row-cooler" | "cdu" | "tape-library")
/**
 * [width along x, depth along y, height along z] in the assembly's units, each > 0.
 * 
 * @minItems 3
 * @maxItems 3
 */
export type SpecSize3 = [number, number, number]
/**
 * An image on a part: an image id (shown as an upright billboard), or an object with face, crop and fit.
 */
export type SpecPartImage = (SpecId | {
ref: SpecId
/**
 * billboard: upright and never skewed, scaled to the part's screen silhouette; top, left (+y) or right (+x): a decal mapped onto that face of the part's box.
 */
face?: ("billboard" | "top" | "left" | "right")
crop?: SpecPixelRect
/**
 * How the image fills its face or silhouette.
 */
fit?: ("contain" | "cover" | "stretch")
})
/**
 * [x, y, width, height] in image pixels (SVG images: viewBox units), from the top-left corner.
 * 
 * @minItems 4
 * @maxItems 4
 */
export type SpecPixelRect = [number, number, number, number]

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
 * State changes from this step onward (cumulative), keyed by object id, rackId/slotId or an assembly part path (assemblyId/partId/...).
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
focus?: SpecPartPath
/**
 * Explode, implode, build or unbuild actions played in this step, in order (each starts when the previous one ends unless it sets start). Poses are cumulative across steps.
 * 
 * @minItems 1
 * @maxItems 20
 */
assembly?: [SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]|[SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction, SpecAssemblyAction]
}
export interface SpecExplodeAction {
explode: SpecPartPath
program?: SpecId
/**
 * Stage to reach (partial explode); default the last stage.
 */
to?: number
/**
 * Seconds after the step's motion window opens, at speed 1; default right after the previous action.
 */
start?: number
}
export interface SpecImplodeAction {
implode: SpecPartPath
program?: SpecId
/**
 * Stage to return to; default 0 (assembled).
 */
to?: number
/**
 * Seconds after the step's motion window opens, at speed 1.
 */
start?: number
}
export interface SpecBuildAction {
build: SpecPartPath
program?: SpecId
/**
 * Build step (or storyboard frame) to reach; default the last.
 */
to?: number
/**
 * Build this many more steps instead of naming to; default 1 when neither is set.
 */
advance?: number
/**
 * Seconds after the step's motion window opens, at speed 1.
 */
start?: number
}
export interface SpecUnbuildAction {
unbuild: SpecPartPath
program?: SpecId
/**
 * Build step to return to; default 0 (empty).
 */
to?: number
/**
 * Seconds after the step's motion window opens, at speed 1.
 */
start?: number
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
/**
 * Explode programs for the rack as an assembly; selectors address slot ids, slot types (type:server-2u) and the rack's own parts. Without one the rack has the built-in drawers program (schema 1.2.0).
 * 
 * @maxItems 8
 */
programs?: []|[SpecProgram]|[SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]
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
assembly?: SpecId
closeup?: SpecId
}
export interface SpecExplodeProgram {
id: SpecId
/**
 * Explode program (the default kind).
 */
kind?: "explode"
label?: SpecText
/**
 * Clearance between parts after an auto-distance move, in the assembly's units; default 10% of the assembly's largest extent.
 */
gap?: number
/**
 * Stages in order; explode to stage k plays stages 1..k, implode plays them backwards.
 * 
 * @minItems 1
 * @maxItems 32
 */
stages: [SpecStage, ...(SpecStage)[]]
}
/**
 * One stage of an explode program: which parts move, where, how far and when.
 */
export interface SpecStage {
label?: SpecText
parts: SpecPartSelectors
except?: SpecPartSelectors
direction?: SpecDirection
distance?: SpecDistance
/**
 * Stagger order: spec order, by distance from the assembly centre, by height, or by nearness to the viewer.
 */
order?: ("spec" | "outside-in" | "inside-out" | "top-down" | "bottom-up" | "front-first" | "back-first")
/**
 * Seconds between the starts of consecutive parts, at speed 1.
 */
stagger?: number
/**
 * Seconds before the stage starts, at speed 1.
 */
delay?: number
/**
 * Seconds each part travels, at speed 1.
 */
duration?: number
easing?: SpecEasing
/**
 * after: start when the previous stage ends; previous: start together with it.
 */
with?: ("after" | "previous")
/**
 * Show each moved part's label (with a leader line) once it arrives.
 */
labels?: ("show" | "hide")
/**
 * Draw leader lines from labels to their parts.
 */
leaders?: boolean
/**
 * Also show each part's detail lines under its label.
 */
details?: boolean
/**
 * Dim parts this stage does not move (unselected) or everything outside the assembly (others) while the stage is shown.
 */
fade?: ("none" | "unselected" | "others")
/**
 * Per-part direction, distance, delay or order, keyed by part path relative to the assembly.
 */
overrides?: {
[k: string]: SpecPartOverride
}
}
/**
 * Per-part changes inside one stage.
 */
export interface SpecPartOverride {
direction?: SpecDirection
distance?: SpecDistance
/**
 * Extra seconds before this part starts, at speed 1.
 */
delay?: number
/**
 * Rank in the stage's stagger order (lower moves first); ties keep the stage order.
 */
order?: number
}
export interface SpecBuildProgram {
id: SpecId
/**
 * Build program.
 */
kind: "build"
label?: SpecText
/**
 * Build steps in order; parts not added by any step are the base and are present from the start.
 * 
 * @minItems 1
 * @maxItems 500
 */
steps: [SpecBuildStep, ...(SpecBuildStep)[]]
}
/**
 * One build step: parts appear at an origin and travel to their seats.
 */
export interface SpecBuildStep {
/**
 * Step number printed in the document (booklet step), shown in the caption and the parts callout.
 */
number?: number
caption?: SpecText
add: SpecPartSelectors
/**
 * Where added parts come from: above their seat, the parts callout (fly from the callout box, then drop), outside the model bounds along their nearest free side, an axis, or an explicit vector.
 */
from?: (("above" | "callout" | "outside" | "+x" | "-x" | "+y" | "-y") | SpecVec3)
distance?: SpecDistance
subBuild?: SpecPartPath
program?: SpecId
/**
 * Rotate the view about the vertical axis (degrees, quarter turns only) from this step on, like a booklet's rotate-model hint. Assembly-only specs.
 */
view?: (0 | 90 | 180 | 270)
/**
 * Show the parts callout (count x part thumbnail) for this step.
 */
callout?: boolean
/**
 * Seconds each part travels, at speed 1.
 */
duration?: number
/**
 * Seconds between consecutive parts, at speed 1.
 */
stagger?: number
easing?: SpecEasing
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
/**
 * A component-driven unit drawn assembled in isometric view, with explode and build programs.
 */
export interface SpecAssembly {
id: SpecId
label?: SpecText
badge?: SpecText
/**
 * Units of at, size, pitch and distances: mm, cm, in, tile (one world grid tile) or stud (x and y in 8 mm studs, z in 3.2 mm plates; a brick is 3 plates).
 */
units?: ("mm" | "cm" | "in" | "tile" | "stud")
/**
 * Scale so the assembled unit's largest horizontal extent is this many grid tiles; ignored for units tile and inside a rack slot.
 */
fit?: number
/**
 * Side of the unit that is its front (the drawer direction). +y faces the viewer's lower left, +x the lower right.
 */
front?: ("+y" | "+x" | "-y" | "-x")
/**
 * Quarter-turn rotation of the whole unit about the vertical axis.
 */
rotate?: (0 | 90 | 180 | 270)
pos?: SpecGridPos
group?: SpecId
state?: SpecState
/**
 * exploded: part labels appear (with leader lines) when stages show them; always: also print each leaf's label upright on its top face at rest (plans, board layouts); never: no part labels.
 */
labels?: ("exploded" | "always" | "never")
/**
 * Base pose, shown in the static output, the poster frame and at the start of the loop: assembled, exploded (default program, all stages) or empty (only parts no build step adds).
 */
pose?: ("assembled" | "exploded" | "empty")
program?: SpecId
closeup?: SpecId
/**
 * Not drawn by itself; instanced by parts[].use, racks[].slots[].assembly or closeup.
 */
template?: boolean
/**
 * Top-level parts (at most 2000 leaf parts per spec after count and use are expanded).
 * 
 * @minItems 1
 * @maxItems 500
 */
parts: [SpecPart, ...(SpecPart)[]]
/**
 * Explode and build programs; when there is none the skill or pcosmo suggest one.
 * 
 * @maxItems 16
 */
programs?: []|[SpecProgram]|[SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]
source?: SpecSource
}
/**
 * A part of an assembly: a primitive or pack shape, optionally image-fed, or a sub-assembly with its own parts.
 */
export interface SpecPart {
id: SpecId
label?: SpecText
/**
 * Detail lines shown under the label when a stage enables details.
 * 
 * @maxItems 6
 */
detail?: []|[SpecText]|[SpecText, SpecText]|[SpecText, SpecText, SpecText]|[SpecText, SpecText, SpecText, SpecText]|[SpecText, SpecText, SpecText, SpecText, SpecText]|[SpecText, SpecText, SpecText, SpecText, SpecText, SpecText]
badge?: SpecText
/**
 * Free part type such as cpu, dimm, piston or valve, used by type: selectors, callouts and the suggestion heuristics.
 */
type?: string
/**
 * Tags for tag: selectors.
 * 
 * @maxItems 16
 */
tags?: []|[SpecId]|[SpecId, SpecId]|[SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]
/**
 * Structural role used by the suggestion heuristics: body (never moves by default), cover (lids, panels), fastener, internal, cable or shell (open container).
 */
role?: ("body" | "cover" | "fastener" | "internal" | "cable" | "shell")
/**
 * Primitive (box, plate, cylinder, ring, shaft, prism, wedge, tray, card, sprite) or a pack shape such as dc:server-2u, hw:dimm, auto:piston, brick:brick. Ignored for sub-assemblies.
 */
shape?: string
at?: SpecVec3
size?: SpecSize3
/**
 * Axis of a cylinder, ring or shaft.
 */
axis?: ("x" | "y" | "z")
/**
 * Quarter-turn rotation about the vertical axis (degrees); 90 and 270 swap width and depth.
 */
rotate?: (0 | 90 | 180 | 270)
/**
 * Shape parameters for a pack shape (for example studs or hollow for brick shapes).
 */
params?: {
[k: string]: number | boolean | string
}
/**
 * Theme material of a primitive part.
 */
tone?: ("base" | "accent" | "muted" | "glass" | "metal" | "led")
color?: SpecColor
image?: SpecPartImage
state?: SpecState
/**
 * Repeat the part count times; copies get ids <id>-1 ... <id>-n and are offset by pitch.
 */
count?: number
pitch?: SpecVec3
mates?: SpecPartPath
closeup?: SpecId
use?: SpecId
/**
 * Child parts: makes this part a sub-assembly that moves as one unit unless a selector picks its children.
 * 
 * @minItems 1
 * @maxItems 200
 */
parts?: [SpecPart, ...(SpecPart)[]]
/**
 * Programs of this sub-assembly; selectors are relative to it.
 * 
 * @maxItems 8
 */
programs?: []|[SpecProgram]|[SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]|[SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram, SpecProgram]
source?: SpecSource
}
/**
 * Provenance of an image or a part taken from a document. Shown in the credits line when attribution or license is set; never fetched, never a link.
 */
export interface SpecSource {
document?: SpecText
/**
 * 1-based page number in the document.
 */
page?: number
figure?: SpecText
license?: SpecText
attribution?: SpecText
/**
 * Where the document is published; printed as text in the credits, never fetched.
 */
url?: string
}
/**
 * An image asset. src is a file path relative to the spec's directory (no .., no absolute paths, no URLs) or an inline data:image/(png|jpeg|webp|svg+xml);base64 URI. Formats are checked by magic bytes; metadata is dropped; SVG goes through the icon sanitizer.
 */
export interface SpecImage {
id: SpecId
/**
 * Relative file path (png, jpg, jpeg, webp, svg) or an inline base64 data URI of up to about 256 KiB.
 */
src: string
crop?: SpecPixelRect
alt?: SpecText
source?: SpecSource
}
/**
 * A flat, faithful build sequence made from a document's own step renders and part thumbnails (tier A of document ingestion).
 */
export interface SpecStoryboard {
id: SpecId
label?: SpecText
pos?: SpecGridPos
/**
 * Width of the storyboard panel in grid tiles.
 */
width?: number
/**
 * How the model image changes between steps.
 */
transition?: ("fade" | "wipe" | "cut")
/**
 * Document steps in order.
 * 
 * @minItems 1
 * @maxItems 500
 */
frames: [SpecStoryboardFrame, ...(SpecStoryboardFrame)[]]
source?: SpecSource
}
/**
 * One document step: the model render after the step, the parts callout and an optional sub-build.
 */
export interface SpecStoryboardFrame {
/**
 * Step number printed in the document.
 */
number?: number
caption?: SpecText
model: SpecId
/**
 * Parts callout of the step.
 * 
 * @maxItems 40
 */
parts?: SpecStoryboardItem[]
/**
 * [x, y] in percent of the model image where the step's parts land; default the centre.
 * 
 * @minItems 2
 * @maxItems 2
 */
attach?: [number, number]
/**
 * Sub-build mini-step images in order (count unused); the last one docks at attach before the model image changes.
 * 
 * @minItems 1
 * @maxItems 20
 */
sub?: [SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]|[SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem, SpecStoryboardItem]
}
/**
 * A part thumbnail in a storyboard callout.
 */
export interface SpecStoryboardItem {
image: SpecId
/**
 * How many of this part the step uses, shown as <count>x.
 */
count?: number
label?: SpecText
}
/**
 * Figure mode: a document figure (exploded and/or assembled drawing) animated in its own drawn plane by moving cut-out sprites; no 3D inference.
 */
export interface SpecFigure {
id: SpecId
label?: SpecText
pos?: SpecGridPos
/**
 * Width of the figure panel in grid tiles.
 */
width?: number
base: SpecId
/**
 * Base pose for the static output and the start of the loop.
 */
pose?: ("assembled" | "exploded")
/**
 * Moving sprites.
 * 
 * @minItems 1
 * @maxItems 200
 */
parts: [SpecFigurePart, ...(SpecFigurePart)[]]
/**
 * Stages; default one stage moving every part in spec order.
 * 
 * @maxItems 32
 */
stages?: SpecFigureStage[]
source?: SpecSource
}
/**
 * A part sprite cut out of a figure, with its seated and exploded positions in the figure's pixel frame.
 */
export interface SpecFigurePart {
id: SpecId
label?: SpecText
/**
 * Detail lines shown under the label when a stage enables details.
 * 
 * @maxItems 6
 */
detail?: []|[SpecText]|[SpecText, SpecText]|[SpecText, SpecText, SpecText]|[SpecText, SpecText, SpecText, SpecText]|[SpecText, SpecText, SpecText, SpecText, SpecText]|[SpecText, SpecText, SpecText, SpecText, SpecText, SpecText]
/**
 * Free part type for type: selectors.
 */
type?: string
/**
 * Tags for tag: selectors.
 * 
 * @maxItems 16
 */
tags?: []|[SpecId]|[SpecId, SpecId]|[SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]|[SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId, SpecId]
image: SpecId
/**
 * [x, y] of the sprite's top-left corner in the base image's pixels when seated (from pcosmo assets locate).
 * 
 * @minItems 2
 * @maxItems 2
 */
seat: [number, number]
/**
 * [x, y] of the sprite's top-left corner when exploded; default straight up by the sprite height plus 20%.
 * 
 * @minItems 2
 * @maxItems 2
 */
exploded?: [number, number]
/**
 * Draw-order override; default by the seat's bottom edge (lower on screen draws later).
 */
z?: number
/**
 * Draw a fading motion arrow between seat and exploded position.
 */
arrow?: boolean
source?: SpecSource
}
/**
 * A stage of a figure: which sprites move and when (motion is between the drawn seat and exploded positions).
 */
export interface SpecFigureStage {
label?: SpecText
parts: SpecPartSelectors
/**
 * Stagger order.
 */
order?: ("spec" | "top-down" | "bottom-up")
/**
 * Seconds between consecutive parts, at speed 1.
 */
stagger?: number
/**
 * Seconds before the stage starts, at speed 1.
 */
delay?: number
/**
 * Seconds each part travels, at speed 1.
 */
duration?: number
easing?: SpecEasing
/**
 * Show labels with leader lines once parts arrive.
 */
labels?: ("show" | "hide")
}
