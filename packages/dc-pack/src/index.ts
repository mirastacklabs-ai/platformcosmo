/** Placeholder until v1.1 (Track E). Slot types mirror the schema's SpecDcSlotType enum. */
import type { SpecDcEquipmentType, SpecDcSlotType } from "@platformcosmo/core";

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
