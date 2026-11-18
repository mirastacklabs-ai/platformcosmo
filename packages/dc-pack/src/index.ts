/** PlatformCosmo data-center pack (Track E): parametric components and hall layout. */
import type {
  DcPack,
  DcSceneFragment,
  SpecDcEquipmentType,
  SpecDcSlotType,
} from "@platformcosmo/core";
import { box } from "./units.js";
import { registry } from "./registry.js";

export { registry } from "./registry.js";

/** Slot types mirror the schema's SpecDcSlotType enum. */
export const slotTypes = [
  "server-1u",
  "server-2u",
  "server-4u",
  "blade-chassis",
  "gpu-node",
  "switch-tor",
  "switch-leaf",
  "switch-spine",
  "patch-panel",
  "storage-shelf",
  "storage-flash",
  "storage-jbod",
  "pdu-1u",
  "ups-2u",
  "blank",
] as const satisfies readonly SpecDcSlotType[];

export const equipmentTypes = [
  "ups",
  "busway",
  "pdu-floor",
  "crah",
  "in-row-cooler",
  "cdu",
  "tape-library",
] as const satisfies readonly SpecDcEquipmentType[];

/** Replaced by the hall layout in the next PR. */
const empty: DcSceneFragment = {
  objects: [],
  groups: [],
  edges: [],
  flows: [],
  focusTargets: {},
  bounds: box(0, 0, 0, 0, 0, 0),
  diagnostics: [],
};

export const dcPack: DcPack = {
  registry,
  buildScene: () => empty,
};
