/** PlatformCosmo data-center pack (Track E): parametric components and hall layout. */
import type { DcPack, SpecDcEquipmentType, SpecDcSlotType } from "@platformcosmo/core";
import { buildDcScene } from "./scene.js";
import { buildRackAssembly, slotHosts } from "./assembly.js";
import { dcShapePack } from "./shapes.js";
import { registry } from "./registry.js";

export { registry } from "./registry.js";
export { estimateDcElements } from "./scene.js";
export { dcShapePack } from "./shapes.js";
export { assemblyPlanner } from "./assembly.js";

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

export const dcPack: DcPack = {
  registry,
  buildScene: buildDcScene,
  buildAssembly: buildRackAssembly,
  slotHosts,
  shapes: dcShapePack,
};
