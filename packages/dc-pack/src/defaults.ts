/**
 * Fallbacks for omitted DC spec fields. They mirror the `default` values in
 * schema/v1.json (DECISIONS D18); a test keeps the two in sync.
 */
export const DC_DEFAULTS = {
  rack: { u: 42, pdu: "dual", rearDoorHeatExchanger: false },
  state: "healthy",
  rowFacing: "front",
  aisleContained: false,
  cableKind: "network",
  facility: { raisedFloor: true, perforatedTiles: true, cableTrays: "overhead" },
} as const;
