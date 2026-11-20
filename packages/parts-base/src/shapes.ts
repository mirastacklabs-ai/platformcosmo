import type { PartShapeDef } from "@platformcosmo/core";
import { defineShape, type ParamSpec } from "./define.js";

/**
 * The `hw:` shapes (assemblies §5): generic server internals in millimetres, true scale.
 * Local frame: x = width, y = depth, z = height, min corner at the origin. One canonical
 * orientation per shape (turn it with the part's `rotate`). Devices with a front (psu, e1s,
 * nic-ocp3, chassis-2u, fan) put it at +y, the side the iso viewer sees, matching DC racks and
 * `"front": "+y"` in the spec. Each shape is authored at its default size and scaled per axis
 * when the spec gives `size`. `depthBox` is the solid core (see `finish`): fingers, ears,
 * handles, connectors and sockets are drawn but excluded, so a part seated on a board is not
 * enclosed by it.
 * Nothing here copies a vendor's industrial design; sizes follow public form-factor envelopes
 * (EATX board, DDR5 DIMM, PCIe CEM, M.2 2280, E1.S 9.5 mm, OCP NIC 3.0 SFF, 19 in rack ears).
 */

const int = (min: number, max: number, def: number): ParamSpec => ({
  kind: "int",
  min,
  max,
  def,
});
const bool = (def: boolean): ParamSpec => ({ kind: "bool", def });
const enumOf = (values: readonly string[], def: string): ParamSpec => ({
  kind: "enum",
  values,
  def,
});

/** Evenly spaced origin of item `i` of `n`, each `w` wide, inside [lo, hi] (n >= 1). */
function spread(i: number, n: number, w: number, lo: number, hi: number): number {
  const gap = (hi - lo - n * w) / (n + 1);
  return lo + gap + i * (w + gap);
}

const board = defineShape({
  id: "board",
  label: "Server board",
  type: "board",
  role: "internal",
  size: [305, 330, 12],
  params: { sockets: int(0, 2, 2), dimmSlots: int(0, 16, 8) },
  draw(g, p, tone) {
    g.add("pcb", "plate", [0, 0, 0], [305, 330, 1.6], tone, { paint: true });
    for (let i = 0; i < (p.sockets as number); i++) {
      g.add(`socket-${i}`, "box", [60, 50 + i * 130, 1.6], [60, 60, 4], "muted", { core: false });
    }
    for (let i = 0; i < (p.dimmSlots as number); i++) {
      g.add(`dimm-slot-${i}`, "box", [165, 5 + i * 20, 1.6], [133, 5.5, 10.4], "muted", {
        core: false,
      });
    }
    g.add("io-header", "box", [4, 10, 1.6], [30, 50, 10.4], "muted", { core: false });
    return undefined;
  },
});

const cpu = defineShape({
  id: "cpu",
  label: "CPU package",
  type: "cpu",
  role: "internal",
  size: [76, 56, 5],
  params: { lid: bool(true) },
  draw(g, p, tone) {
    g.add("substrate", "plate", [0, 0, 0], [76, 56, 1.2], tone, { paint: true });
    if (p.lid) g.add("lid", "box", [8, 6, 1.2], [60, 44, 3.8], "metal");
    else g.add("die", "box", [22, 16, 1.2], [32, 24, 3.8], "metal");
    return undefined;
  },
});

const heatsink = defineShape({
  id: "heatsink",
  label: "Heatsink",
  type: "heatsink",
  role: "internal",
  size: [105, 90, 60],
  params: { fins: int(2, 48, 20) },
  draw(g, p) {
    g.add("base", "box", [0, 0, 0], [105, 90, 6], "metal", { paint: true });
    const n = p.fins as number;
    for (let i = 0; i < n; i++) {
      g.add(`fin-${i}`, "plate", [(i * 104) / (n - 1), 0, 6], [1, 90, 54], "metal");
    }
    return undefined;
  },
});

const dimm = defineShape({
  id: "dimm",
  label: "Memory module",
  type: "dimm",
  role: "internal",
  size: [133.35, 4, 31.25],
  params: { chips: int(0, 9, 8), spreader: bool(false) },
  draw(g, p, tone) {
    const sp = p.spreader as boolean;
    const y0 = sp ? 0.5 : 0; // chips sit under the spreader plates
    const t = 1.4 - y0;
    g.add("pins", "plate", [4, 1.4, 0], [125, 1.2, 3], "metal", { core: false });
    g.add("pcb", "plate", [0, 1.4, 3], [133.35, 1.2, 28.25], tone, { paint: true });
    for (let i = 0; i < (p.chips as number); i++) {
      g.add(`chip-f-${i}`, "box", [6 + i * 13.4, y0, 4], [11, t, 10], "muted");
      g.add(`chip-b-${i}`, "box", [6 + i * 13.4, 2.6, 4], [11, t, 10], "muted");
    }
    g.add("rcd-f", "box", [61, y0, 16], [11, t, 10], "muted");
    g.add("rcd-b", "box", [61, 2.6, 16], [11, t, 10], "muted");
    if (sp) {
      g.add("spreader-f", "plate", [3, 0, 3], [127, 0.5, 28.25], "metal");
      g.add("spreader-b", "plate", [3, 3.5, 3], [127, 0.5, 28.25], "metal");
    }
    return undefined;
  },
});

const gpuCard = defineShape({
  id: "gpu-card",
  label: "GPU card",
  type: "gpu",
  role: "internal",
  size: [267, 38, 111],
  params: { fans: int(0, 3, 2), bracket: bool(true) },
  draw(g, p, tone) {
    const x0 = p.bracket ? 1.6 : 0;
    if (p.bracket) g.add("bracket", "plate", [0, 0, 0], [1.6, 38, 111], "metal", { core: false });
    g.add("pcb", "plate", [x0, 0, 6], [267 - x0, 1.6, 105], "muted");
    g.add("fingers", "plate", [40, 0, 0], [89, 1.6, 6], "metal", { core: false });
    g.add("shroud", "box", [14, 1.6, 10], [250, 33.4, 95], tone, { paint: true });
    const n = p.fans as number;
    if (n === 0) g.add("cover", "plate", [14, 35, 10], [250, 3, 95], "accent");
    for (let i = 0; i < n; i++) {
      const x = spread(i, n, 76, 14, 264);
      g.add(`fan-${i}`, "cylinder", [x, 35, 19.5], [76, 2, 76], "muted", { axis: "y" });
      g.add(`hub-${i}`, "cylinder", [x + 27, 37, 46.5], [22, 1, 22], "metal", { axis: "y" });
    }
    return undefined;
  },
});

const nicOcp3 = defineShape({
  id: "nic-ocp3",
  label: "OCP 3.0 NIC (SFF)",
  type: "nic",
  role: "internal",
  size: [76, 115, 16],
  params: { ports: int(1, 4, 2) },
  draw(g, p, tone) {
    g.add("pcb", "plate", [0, 0, 0], [76, 115, 1.6], tone, { paint: true });
    // Front (ports) at +y; the edge connector sits at the rear.
    const n = p.ports as number;
    const w = (68 - (n - 1) * 2) / n;
    for (let i = 0; i < n; i++) {
      g.add(`cage-${i}`, "box", [4 + i * (w + 2), 85, 1.6], [w, 30, 12], "metal", { core: false });
    }
    g.add("heatsink", "box", [8, 24, 1.6], [60, 58, 14.4], "metal");
    g.add("connector", "box", [8, 0, 1.6], [60, 15, 6], "muted", { core: false });
    return undefined;
  },
});

const nvmeM2 = defineShape({
  id: "nvme-m2",
  label: "NVMe M.2 2280",
  type: "ssd",
  role: "internal",
  size: [80, 22, 3.8],
  params: { chips: int(1, 4, 3), doubleSided: bool(true) },
  draw(g, p, tone) {
    g.add("pcb", "plate", [0, 0, 1.3], [80, 22, 0.8], tone, { paint: true });
    for (let i = 0; i < (p.chips as number); i++) {
      g.add(`chip-t-${i}`, "box", [12 + i * 17, 3, 2.1], [15, 16, 1.7], "muted");
      if (p.doubleSided) g.add(`chip-b-${i}`, "box", [12 + i * 17, 3, 0], [15, 16, 1.3], "muted");
    }
    return undefined;
  },
});

const e1s = defineShape({
  id: "e1s",
  label: "E1.S drive",
  type: "ssd",
  role: "internal",
  // Flat (default): 33.75 wide, 118.75 long (front at +y), 9.5 thick.
  size: [33.75, 118.75, 9.5],
  params: { fins: int(0, 12, 6), orientation: enumOf(["flat", "upright"], "flat") },
  // Upright: the drive stands on its long edge, so x is the 9.5 mm thickness and z the 33.75 mm
  // width (default size [9.5, 118.75, 33.75]).
  swapXZ: (p) => p.orientation === "upright",
  draw(g, p, tone) {
    g.add("bezel", "box", [0, 115.75, 0], [33.75, 3, 7.5], "accent");
    g.add("body", "box", [0, 0, 0], [33.75, 115.75, 7.5], tone, { paint: true });
    const n = p.fins as number;
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 16.4 : 3 + (i * 26.75) / (n - 1);
      g.add(`fin-${i}`, "plate", [x, 5, 7.5], [1, 105.75, 2], "metal", { core: false });
    }
    return undefined;
  },
});

const psu = defineShape({
  id: "psu",
  label: "Power supply (CRPS)",
  type: "psu",
  role: "internal",
  size: [73.5, 185, 39],
  params: { handle: bool(true) },
  draw(g, p, tone) {
    g.add("grille", "plate", [0, 0, 0], [73.5, 10, 39], "perforated");
    g.add("body", "box", [0, 10, 0], [73.5, 169, 39], tone, { paint: true });
    // Front (handle) at +y.
    if (p.handle) g.add("handle", "box", [8, 179, 10], [57.5, 6, 19], "muted", { core: false });
    return undefined;
  },
});

const fan = defineShape({
  id: "fan",
  label: "Chassis fan",
  type: "fan",
  role: "internal",
  size: [60, 56, 60],
  params: { blades: int(3, 10, 7), grille: bool(false) },
  draw(g, p, tone) {
    g.add("frame-l", "box", [0, 0, 0], [3, 56, 60], tone, { paint: true });
    g.add("frame-r", "box", [57, 0, 0], [3, 56, 60], tone, { paint: true });
    g.add("frame-b", "box", [3, 0, 0], [54, 56, 3], tone, { paint: true });
    g.add("frame-t", "box", [3, 0, 57], [54, 56, 3], tone, { paint: true });
    g.add("hub", "cylinder", [22, 14, 22], [16, 28, 16], "muted", { axis: "y" });
    const n = p.blades as number;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      const c = Math.cos(a);
      const s = Math.sin(a);
      // Axis-aligned bounding box of a 9 x 1.5 mm blade centred at radius 19 (iso parts are
      // axis-aligned). With 3..10 blades neighbours stay separated on x or z.
      const w = Math.abs(c) * 9 + Math.abs(s) * 1.5;
      const h = Math.abs(s) * 9 + Math.abs(c) * 1.5;
      g.add(
        `blade-${i}`,
        "plate",
        [30 + 19 * c - w / 2, 18, 30 + 19 * s - h / 2],
        [w, 20, h],
        "accent",
      );
    }
    if (p.grille) {
      // On the +y (front) face; the vertical bar is split around the crossing.
      g.add("bar-h", "plate", [3, 54.5, 29], [54, 1.5, 2], "metal");
      g.add("bar-v-lo", "plate", [29, 54.5, 3], [2, 1.5, 26], "metal");
      g.add("bar-v-hi", "plate", [29, 54.5, 31], [2, 1.5, 26], "metal");
    }
    return undefined;
  },
});

const riser = defineShape({
  id: "riser",
  label: "PCIe riser",
  type: "riser",
  role: "internal",
  size: [130, 12, 100],
  params: { slots: int(1, 4, 2) },
  draw(g, p, tone) {
    g.add("pcb", "plate", [0, 0, 0], [130, 1.6, 100], tone, { paint: true });
    for (let i = 0; i < (p.slots as number); i++) {
      g.add(`slot-${i}`, "box", [8, 1.6, 10 + i * 22], [89, 10.4, 7], "muted", { core: false });
    }
    g.add("power", "box", [105, 1.6, 10], [20, 6, 20], "muted", { core: false });
    return undefined;
  },
});

const pcieCard = defineShape({
  id: "pcie-card",
  label: "PCIe add-in card (HHHL)",
  type: "card",
  role: "internal",
  size: [168, 20, 69],
  params: { bracket: bool(true), heatsink: bool(true) },
  draw(g, p, tone) {
    const x0 = p.bracket ? 1.6 : 0;
    if (p.bracket) g.add("bracket", "plate", [0, 0, 0], [1.6, 20, 69], "metal", { core: false });
    g.add("pcb", "plate", [x0, 0, 6], [168 - x0, 1.6, 63], tone, { paint: true });
    g.add("fingers", "plate", [40, 0, 0], [76, 1.6, 6], "metal", { core: false });
    g.add("chip-0", "box", [30, 1.6, 18], [22, 2, 22], "muted");
    g.add("chip-1", "box", [62, 1.6, 18], [16, 2, 16], "muted");
    if (p.heatsink) g.add("heatsink", "box", [90, 1.6, 12], [60, 18.4, 45], "metal");
    return undefined;
  },
});

const chassis2u = defineShape({
  id: "chassis-2u",
  label: "2U chassis (open top)",
  type: "chassis",
  role: "shell",
  size: [482.6, 740, 88.9],
  params: { ears: bool(true) },
  draw(g, p, tone) {
    // Open-top tray (floor + four walls): the back half is drawn first, contents sort between.
    const back = ["floor", "wall-nx", "wall-ny"];
    const front = ["wall-py", "wall-px"];
    g.add("floor", "box", [17.5, 0, 0], [447.6, 740, 1.5], tone, { paint: true });
    g.add("wall-nx", "box", [17.5, 0, 1.5], [1.5, 740, 87.4], tone, { paint: true });
    g.add("wall-ny", "box", [19, 0, 1.5], [444.6, 1.5, 87.4], tone, { paint: true });
    g.add("wall-py", "box", [19, 738.5, 1.5], [444.6, 1.5, 87.4], tone, { paint: true });
    g.add("wall-px", "box", [463.6, 0, 1.5], [1.5, 740, 87.4], tone, { paint: true });
    if (p.ears) {
      // Rack ears at the front (+y); the left one sorts with the back half, the right one with
      // the front half (it is in front of the -y wall).
      g.add("ear-l", "plate", [0, 737.5, 0], [17.5, 2.5, 88.9], "metal", { core: false });
      g.add("ear-r", "plate", [465.1, 737.5, 0], [17.5, 2.5, 88.9], "metal", { core: false });
      back.push("ear-l");
      front.push("ear-r");
    }
    return { back, front };
  },
});

const lid = defineShape({
  id: "lid",
  label: "Chassis lid",
  type: "lid",
  role: "cover",
  size: [447.6, 740, 3],
  params: { vents: int(0, 8, 2) },
  draw(g, p, tone) {
    g.add("panel", "plate", [0, 0, 0], [447.6, 740, 2.4], tone, { paint: true });
    for (let i = 0; i < (p.vents as number); i++) {
      g.add(`vent-${i}`, "plate", [20, 60 + i * 80, 2.4], [407.6, 40, 0.6], "perforated", {
        core: false,
      });
    }
    return undefined;
  },
});

/** In the order of assemblies §5. */
export const hwShapes: readonly PartShapeDef[] = [
  board,
  cpu,
  heatsink,
  dimm,
  gpuCard,
  nicOcp3,
  nvmeM2,
  e1s,
  psu,
  fan,
  riser,
  pcieCard,
  chassis2u,
  lid,
];
