import type { SpecNode } from "../schema/types.gen.js";

/** Square footprint edge (tiles) per spec node size; shared by validation (overlap) and layout. */
export const NODE_FOOTPRINT: Readonly<Record<NonNullable<SpecNode["size"]>, number>> = {
  sm: 1,
  md: 2,
  lg: 3,
};

/** Object height (tiles) per spec node size. */
export const NODE_HEIGHT: Readonly<Record<NonNullable<SpecNode["size"]>, number>> = {
  sm: 1,
  md: 1.5,
  lg: 2,
};

export function footprintOf(node: Pick<SpecNode, "size">): number {
  return NODE_FOOTPRINT[node.size ?? "md"];
}

/** Rack height in U for the default rack and fallback slot heights (1U = 44.45 mm). */
export const DEFAULT_RACK_U = 42;

/** Default device height in rack units, used when `size` is omitted and no DC registry is given. */
export const SLOT_HEIGHT_U: Readonly<Record<string, number>> = {
  "server-1u": 1,
  "server-2u": 2,
  "server-4u": 4,
  "blade-chassis": 10,
  "gpu-node": 4,
  "switch-tor": 1,
  "switch-leaf": 1,
  "switch-spine": 2,
  "patch-panel": 1,
  "storage-shelf": 2,
  "storage-flash": 2,
  "storage-jbod": 4,
  "pdu-1u": 1,
  "ups-2u": 2,
  blank: 1,
};
