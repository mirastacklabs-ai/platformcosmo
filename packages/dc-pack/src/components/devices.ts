/** Rack-mounted devices (the 15 slot types): generic 19-inch shapes, vendor-neutral. */
import type { DcBuildResult, DcCategory, DcComponentDef } from "@platformcosmo/core";
import { U_MM } from "../units.js";
import { Kit } from "./kit.js";

/** 19-inch rack-mount width. */
export const DEVICE_WIDTH_MM = 482;
/** Visual gap between stacked devices. */
const GAP_MM = 1.5;

type Params = Record<string, unknown>;

interface Dev {
  readonly type: string;
  readonly category: DcCategory;
  readonly label: string;
  readonly heightU: number;
  readonly depthMm: number;
  /** Adds the type-specific front details to the kit. `h` is the device height in mm. */
  detail(k: Kit, h: number): void;
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 1 ? v : fallback;

/** Status LEDs near the left edge of the front panel. */
function leds(k: Kit, h: number, n = 2): void {
  for (let i = 0; i < n; i++) {
    k.part(`led-${i}`, "cube", "led", 14 + i * 9, k.depthMm - 5, h / 2 - 3, 5, 5, 6);
  }
}

function netPorts(k: Kit, h: number, n: number, kind: "network" | "fiber" = "network"): void {
  const prefix = kind === "network" ? "net" : "up";
  for (let i = 0; i < n; i++) {
    k.port(`${prefix}-${i}`, kind, 300 + i * 26, k.depthMm, h * 0.3);
  }
}

function psuPorts(k: Kit, h: number): void {
  k.port("psu-a", "power-a", 60, k.depthMm, h * 0.7);
  k.port("psu-b", "power-b", 420, k.depthMm, h * 0.7);
}

function server(type: string, label: string, u: number, depth: number): Dev {
  return {
    type,
    category: "server",
    label,
    heightU: u,
    depthMm: depth,
    detail(k, h) {
      k.part("bezel", "slab", "base", 20, k.depthMm - 4, 3, 442, 4, h - 6);
      k.row("vent", 3, "muted", 90, 250, 5, 40, Math.max(4, h - 12), 5);
      leds(k, h);
      k.row("drive", u >= 2 ? 6 : 3, "muted", 260, 440, 6, 24, Math.max(6, h - 14), 5);
      netPorts(k, h, 2);
      psuPorts(k, h);
    },
  };
}

const devices: readonly Dev[] = [
  server("server-1u", "Server 1U", 1, 750),
  server("server-2u", "Server 2U", 2, 780),
  server("server-4u", "Server 4U", 4, 800),
  {
    type: "blade-chassis",
    category: "server",
    label: "Blade chassis",
    heightU: 10,
    depthMm: 800,
    detail(k, h) {
      k.row("blade", 8, "accent", 24, 458, 8, 44, h - 28, 6);
      k.row("blade-led", 8, "led", 30, 452, h - 14, 4, 4, 8);
      netPorts(k, h, 2);
      psuPorts(k, h);
    },
  },
  {
    type: "gpu-node",
    category: "server",
    label: "GPU node",
    heightU: 4,
    depthMm: 820,
    detail(k, h) {
      k.part("bezel", "slab", "base", 20, k.depthMm - 4, 3, 442, 4, h - 6);
      k.row("gpu", 8, "accent", 30, 452, 10, 38, h - 20, 6);
      leds(k, h);
      netPorts(k, h, 4);
      psuPorts(k, h);
    },
  },
  {
    type: "switch-tor",
    category: "network",
    label: "Top-of-rack switch",
    heightU: 1,
    depthMm: 450,
    detail(k, h) {
      k.row("port", 12, "metal", 70, 450, 6, 20, Math.max(6, h - 14), 5);
      leds(k, h, 2);
      netPorts(k, h, 4);
      k.port("up-0", "fiber", 330, k.depthMm, h * 0.7);
      psuPorts(k, h);
    },
  },
  {
    type: "switch-leaf",
    category: "network",
    label: "Leaf switch",
    heightU: 1,
    depthMm: 450,
    detail(k, h) {
      k.row("port", 16, "metal", 60, 452, 6, 18, Math.max(6, h - 14), 5);
      leds(k, h, 2);
      netPorts(k, h, 4);
      netPorts(k, h, 2, "fiber");
      psuPorts(k, h);
    },
  },
  {
    type: "switch-spine",
    category: "network",
    label: "Spine switch",
    heightU: 2,
    depthMm: 600,
    detail(k, h) {
      k.row("port", 16, "metal", 60, 452, 8, 18, Math.max(6, h * 0.35), 5);
      k.row("port-lo", 16, "metal", 60, 452, h * 0.55, 18, Math.max(6, h * 0.35), 5);
      leds(k, h, 3);
      netPorts(k, h, 4);
      netPorts(k, h, 2, "fiber");
      psuPorts(k, h);
    },
  },
  {
    type: "patch-panel",
    category: "network",
    label: "Patch panel",
    heightU: 1,
    depthMm: 120,
    detail(k, h) {
      k.row("jack", 12, "metal", 40, 440, 8, 22, Math.max(6, h - 16), 4);
      for (let i = 0; i < 4; i++) k.port(`net-${i}`, "network", 120 + i * 80, k.depthMm, h / 2);
    },
  },
  {
    type: "storage-shelf",
    category: "storage",
    label: "Storage shelf",
    heightU: 2,
    depthMm: 700,
    detail(k, h) {
      k.row("bay", 12, "muted", 30, 450, 6, 26, h - 14, 5);
      k.row("bay-led", 12, "led", 36, 456, 3, 4, 3, 6);
      netPorts(k, h, 2);
      psuPorts(k, h);
    },
  },
  {
    type: "storage-flash",
    category: "storage",
    label: "All-flash array",
    heightU: 2,
    depthMm: 720,
    detail(k, h) {
      k.row("bay", 24, "glass", 24, 458, 6, 13, h - 14, 5);
      leds(k, h);
      netPorts(k, h, 2);
      netPorts(k, h, 2, "fiber");
      psuPorts(k, h);
    },
  },
  {
    type: "storage-jbod",
    category: "storage",
    label: "JBOD enclosure",
    heightU: 4,
    depthMm: 900,
    detail(k, h) {
      k.row("bay", 12, "muted", 28, 454, 6, 28, h * 0.4, 5);
      k.row("bay-lo", 12, "muted", 28, 454, h * 0.55, 28, h * 0.4, 5);
      leds(k, h);
      netPorts(k, h, 2);
      psuPorts(k, h);
    },
  },
  {
    type: "pdu-1u",
    category: "power",
    label: "Rack PDU 1U",
    heightU: 1,
    depthMm: 120,
    detail(k, h) {
      k.row("outlet", 8, "muted", 60, 440, 8, 28, Math.max(6, h - 16), 4);
      leds(k, h, 1);
      k.port("psu-a", "power-a", 40, k.depthMm, h / 2);
      k.port("psu-b", "power-b", 440, k.depthMm, h / 2);
    },
  },
  {
    type: "ups-2u",
    category: "power",
    label: "Rack UPS 2U",
    heightU: 2,
    depthMm: 600,
    detail(k, h) {
      k.part("display", "slab", "glass", 300, k.depthMm - 4, 12, 90, 4, h * 0.4);
      k.row("vent", 4, "muted", 40, 220, 8, 40, h - 16, 5);
      leds(k, h);
      psuPorts(k, h);
    },
  },
  {
    type: "blank",
    category: "facility",
    label: "Blanking panel",
    heightU: 1,
    depthMm: 20,
    detail(k, h) {
      k.part("plate", "slab", "muted", 10, k.depthMm - 4, 2, 462, 4, Math.max(2, h - 4));
    },
  },
];

function deviceDef(d: Dev): DcComponentDef {
  return {
    type: d.type,
    category: d.category,
    label: d.label,
    heightU: d.heightU,
    defaults: { heightU: d.heightU } as Params,
    build(params: Params): DcBuildResult {
      const u = num(params.heightU, d.heightU);
      const h = u * U_MM - GAP_MM;
      const k = new Kit(DEVICE_WIDTH_MM, d.depthMm, h);
      // Chassis first (back-most), then front details in drawing order.
      k.part("chassis", "cube", "base", 0, 0, 0, DEVICE_WIDTH_MM, d.depthMm - 6, h);
      d.detail(k, h);
      k.airflow();
      return k.done();
    },
  };
}

export const deviceDefs: readonly DcComponentDef[] = devices.map(deviceDef);

/** Default device depth by type in mm (used by the rack layout to seat devices). */
export const deviceDepthMm: Readonly<Record<string, number>> = Object.fromEntries(
  devices.map((d) => [d.type, d.depthMm]),
);
