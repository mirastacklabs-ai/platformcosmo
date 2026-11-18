/** Floor-standing equipment (the 7 equipment types): generic cabinets, vendor-neutral. */
import type { DcBuildResult, DcCategory, DcComponentDef } from "@platformcosmo/core";
import { Kit } from "./kit.js";

type Params = Record<string, unknown>;

interface Eq {
  readonly type: string;
  readonly category: DcCategory;
  readonly label: string;
  readonly w: number;
  readonly d: number;
  readonly h: number;
  /** Adds the type-specific parts after the main body (which `build` creates first). */
  detail(k: Kit): void;
  /** Skip the generic body (busway builds its own). */
  readonly bodyless?: boolean;
}

function ledStrip(k: Kit, n: number, z: number): void {
  for (let i = 0; i < n; i++) {
    k.part(`led-${i}`, "cube", "led", 40 + i * 12, k.depthMm - 5, z, 6, 5, 6);
  }
}

const equipment: readonly Eq[] = [
  {
    type: "ups",
    category: "power",
    label: "UPS",
    w: 800,
    d: 1000,
    h: 1900,
    detail(k) {
      k.part("door", "slab", "base", 30, k.depthMm - 6, 60, k.widthMm - 60, 6, k.heightMm - 120);
      k.part("display", "slab", "glass", 520, k.depthMm - 8, 1500, 220, 4, 160);
      k.row("vent", 4, "muted", 60, 400, 200, 60, 900, 5);
      ledStrip(k, 3, 1560);
      k.port("power-a", "power-a", 200, k.depthMm, 300);
      k.port("power-b", "power-b", 600, k.depthMm, 300);
      k.port("in", "power-a", 400, k.depthMm, 1200);
    },
  },
  {
    type: "busway",
    category: "power",
    label: "Busway",
    w: 6000,
    d: 200,
    h: 2600,
    bodyless: true,
    detail(k) {
      k.part("post-0", "cube", "muted", 100, 50, 0, 100, 100, 2400);
      k.part("post-1", "cube", "muted", k.widthMm - 200, 50, 0, 100, 100, 2400);
      k.part("bar", "cube", "accent", 0, 0, 2400, k.widthMm, k.depthMm, 200);
      for (let i = 0; i < 6; i++) {
        const x = 500 + i * 900;
        k.part(`tap-${i}`, "cube", "metal", x, k.depthMm - 20, 2340, 120, 20, 60);
        k.port(`tap-${i}`, "power-a", x + 60, k.depthMm, 2370);
      }
    },
  },
  {
    type: "pdu-floor",
    category: "power",
    label: "Floor PDU",
    w: 600,
    d: 900,
    h: 1800,
    detail(k) {
      k.part("door", "slab", "base", 20, k.depthMm - 6, 60, k.widthMm - 40, 6, k.heightMm - 120);
      k.row("breaker", 6, "muted", 60, 520, 1300, 50, 120, 6);
      k.row("breaker-lo", 6, "muted", 60, 520, 1100, 50, 120, 6);
      ledStrip(k, 3, 1600);
      k.port("power-a", "power-a", 200, k.depthMm, 300);
      k.port("power-b", "power-b", 400, k.depthMm, 300);
    },
  },
  {
    type: "crah",
    category: "cooling",
    label: "CRAH",
    w: 1800,
    d: 900,
    h: 2000,
    detail(k) {
      k.part("panel", "slab", "base", 30, k.depthMm - 6, 60, k.widthMm - 60, 6, k.heightMm - 120);
      k.part("grille", "slab", "glass", 100, k.depthMm - 8, 200, k.widthMm - 200, 4, 700);
      k.part("fan-0", "cylinder", "accent", 400, 300, k.heightMm, 400, 400, 40);
      k.part("fan-1", "cylinder", "accent", 1000, 300, k.heightMm, 400, 400, 40);
      ledStrip(k, 3, 1750);
      k.port("supply", "airflow-out", k.widthMm / 2, k.depthMm, 300);
      k.port("return", "airflow-in", k.widthMm / 2, 0, 1700);
      k.port("power-a", "power-a", 200, k.depthMm, 1400);
      k.port("net-0", "network", 1600, k.depthMm, 1400);
    },
  },
  {
    type: "in-row-cooler",
    category: "cooling",
    label: "In-row cooler",
    w: 600,
    d: 1200,
    h: 2000,
    detail(k) {
      k.part("door", "slab", "glass", 30, k.depthMm - 6, 60, k.widthMm - 60, 6, k.heightMm - 300);
      k.row("fan", 4, "accent", 80, 440, 150, 80, 80, 8, "cylinder");
      ledStrip(k, 2, 1800);
      k.port("intake", "airflow-in", k.widthMm / 2, 0, 1000);
      k.port("exhaust", "airflow-out", k.widthMm / 2, k.depthMm, 1000);
      k.port("power-a", "power-a", 150, k.depthMm, 300);
      k.port("net-0", "network", 450, k.depthMm, 300);
    },
  },
  {
    type: "cdu",
    category: "cooling",
    label: "CDU",
    w: 600,
    d: 1200,
    h: 1500,
    detail(k) {
      k.part("door", "slab", "base", 20, k.depthMm - 6, 60, k.widthMm - 40, 6, k.heightMm - 120);
      k.part("pipe-supply", "cylinder", "accent", 80, k.depthMm - 80, k.heightMm, 90, 90, 140);
      k.part("pipe-return", "cylinder", "muted", 300, k.depthMm - 80, k.heightMm, 90, 90, 140);
      k.part("display", "slab", "glass", 160, k.depthMm - 8, 1100, 280, 4, 160);
      ledStrip(k, 3, 900);
      k.port("power-a", "power-a", 150, k.depthMm, 300);
      k.port("net-0", "network", 450, k.depthMm, 300);
    },
  },
  {
    type: "tape-library",
    category: "storage",
    label: "Tape library",
    w: 600,
    d: 1200,
    h: 2000,
    detail(k) {
      k.part("door", "slab", "glass", 30, k.depthMm - 6, 100, k.widthMm - 60, 6, 1200);
      for (let r = 0; r < 3; r++) {
        k.row(`tape-${r}`, 6, "muted", 60, 520, 200 + r * 340, 60, 240, 8);
      }
      ledStrip(k, 3, 1500);
      k.port("power-a", "power-a", 150, k.depthMm, 300);
      k.port("net-0", "network", 450, k.depthMm, 300);
      k.port("up-0", "fiber", 520, k.depthMm, 300);
    },
  },
];

function equipmentDef(e: Eq): DcComponentDef {
  return {
    type: e.type,
    category: e.category,
    label: e.label,
    footprintMm: { width: e.w, depth: e.d, height: e.h },
    defaults: {} as Params,
    build(): DcBuildResult {
      const k = new Kit(e.w, e.d, e.h);
      // Body first (back-most), then detail in drawing order.
      if (!e.bodyless) {
        k.part("plinth", "slab", "muted", 0, 0, 0, e.w, e.d, 40);
        k.part("body", "cube", "base", 0, 0, 40, e.w, e.d - 6, e.h - 40);
      }
      e.detail(k);
      if (!e.bodyless && !k.ports.some((p) => p.kind === "airflow-in")) {
        k.airflow();
      }
      return k.done();
    },
  };
}

export const equipmentDefs: readonly DcComponentDef[] = equipment.map(equipmentDef);
