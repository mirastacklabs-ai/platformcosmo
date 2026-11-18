import type { DcComponentDef, DcComponentRegistry } from "@platformcosmo/core";
import { deviceDefs } from "./components/devices.js";
import { equipmentDefs } from "./components/equipment.js";
import { rackDef } from "./components/rack.js";

/** Rack first, then the 15 slot types and 7 equipment types, in schema enum order. */
const defs: readonly DcComponentDef[] = [rackDef, ...deviceDefs, ...equipmentDefs];

const byType: ReadonlyMap<string, DcComponentDef> = new Map(defs.map((d) => [d.type, d]));

export const registry: DcComponentRegistry = {
  get(type: string): DcComponentDef | undefined {
    return byType.get(type);
  },
  list(): readonly DcComponentDef[] {
    return defs;
  },
};
