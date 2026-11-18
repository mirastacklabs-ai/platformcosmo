/**
 * Rack frame (42/45/48U): an open frame (plinth, corner posts, top cap, rear panel/door,
 * optional vertical PDUs) so slot devices, which are separate scene objects, stay visible.
 * Local frame: x width, y depth (front at +y), z up. All sizes in mm.
 */
import type { DcBuildResult, DcComponentDef } from "@platformcosmo/core";
import { U_MM } from "../units.js";
import { Kit } from "./kit.js";

export const RACK_WIDTH_MM = 600;
export const RACK_DEPTH_MM = 1200;
/** Plinth below U1. */
export const RACK_BASE_MM = 50;
/** Top cap above the top U. */
export const RACK_TOP_MM = 50;
/** Gap between the rack front plane and device fronts. */
export const RACK_FRONT_INSET_MM = 30;

export const RACK_HEIGHTS_U = [42, 45, 48] as const;

export type RackPdu = "none" | "single" | "dual";

export interface RackParams {
  readonly u: number;
  readonly pdu: RackPdu;
  readonly rearDoorHeatExchanger: boolean;
}

type Params = Record<string, unknown>;

export function rackHeightMm(u: number): number {
  return RACK_BASE_MM + u * U_MM + RACK_TOP_MM;
}

export function readRackParams(p: Params): RackParams {
  const u = RACK_HEIGHTS_U.find((x) => x === p.u) ?? 42;
  const pdu: RackPdu =
    p.pdu === "none" || p.pdu === "dual" || p.pdu === "single" ? p.pdu : "single";
  return { u, pdu, rearDoorHeatExchanger: p.rearDoorHeatExchanger === true };
}

export const rackDef: DcComponentDef = {
  type: "rack",
  category: "rack",
  label: "Rack",
  heightU: 42,
  footprintMm: { width: RACK_WIDTH_MM, depth: RACK_DEPTH_MM, height: Math.round(rackHeightMm(42)) },
  defaults: { u: 42, pdu: "single", rearDoorHeatExchanger: false } as Params,
  build(params: Params): DcBuildResult {
    const { u, pdu, rearDoorHeatExchanger } = readRackParams(params);
    const W = RACK_WIDTH_MM;
    const D = RACK_DEPTH_MM;
    const H = rackHeightMm(u);
    const post = 30;
    const k = new Kit(W, D, H);

    // Back to front: plinth, rear, back posts, PDUs, front posts, top cap.
    k.part("base", "slab", "muted", 0, 0, 0, W, D, RACK_BASE_MM);
    if (rearDoorHeatExchanger) {
      k.part(
        "rear-door",
        "slab",
        "glass",
        0,
        0,
        RACK_BASE_MM,
        W,
        110,
        H - RACK_BASE_MM - RACK_TOP_MM,
      );
      k.row("rear-fan", 3, "accent", 90, 510, H * 0.4, 60, 60, 4, "cylinder");
    } else {
      k.part(
        "rear-panel",
        "slab",
        "muted",
        0,
        0,
        RACK_BASE_MM,
        W,
        12,
        H - RACK_BASE_MM - RACK_TOP_MM,
      );
    }
    const bodyH = H - RACK_BASE_MM - RACK_TOP_MM;
    k.part("post-bl", "cube", "metal", 0, 0, RACK_BASE_MM, post, post, bodyH);
    k.part("post-br", "cube", "metal", W - post, 0, RACK_BASE_MM, post, post, bodyH);
    const pduH = u * U_MM * 0.8;
    if (pdu !== "none") {
      k.part("pdu-a", "cube", "muted", 40, 120, RACK_BASE_MM + 60, 40, 50, pduH);
      k.part("pdu-a-led", "cube", "led", 48, 168, RACK_BASE_MM + 60 + pduH - 30, 8, 4, 8);
    }
    if (pdu === "dual") {
      k.part("pdu-b", "cube", "muted", W - 80, 120, RACK_BASE_MM + 60, 40, 50, pduH);
      k.part("pdu-b-led", "cube", "led", W - 72, 168, RACK_BASE_MM + 60 + pduH - 30, 8, 4, 8);
    }
    k.part("post-fl", "cube", "metal", 0, D - post, RACK_BASE_MM, post, post, bodyH);
    k.part("post-fr", "cube", "metal", W - post, D - post, RACK_BASE_MM, post, post, bodyH);
    k.part("top", "slab", "muted", 0, 0, H - RACK_TOP_MM, W, D, RACK_TOP_MM);

    k.port("power-a", "power-a", 60, 140, H);
    if (pdu === "dual") k.port("power-b", "power-b", W - 60, 140, H);
    k.port("net-0", "network", W / 2, D - 60, H);
    k.airflow();
    return k.done();
  },
};
