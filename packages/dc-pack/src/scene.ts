/**
 * DC hall layout and scene fragment (PLAN §9). Everything is placed on the 600 mm grid
 * starting at the world origin; positions are integers in tiles (before the hall margin).
 *
 * Conventions:
 * - A component's front is +y in its own frame. Rows with `facing: "front"` (the default)
 *   keep that, so fronts face the +y neighbour; `facing: "back"` mirrors the row.
 * - Aisles between two rows default the facing: a cold aisle makes both rows face it, a hot
 *   aisle makes both rows turn their backs to it. Explicit `facing` always wins.
 * - Rows run along +x and stack along +y with a 2-tile aisle gap.
 * - Items outside any row go in a strip after the last row (or the first row if there are none).
 */
import type {
  Box3,
  Diagnostic,
  PlatformCosmoSpec,
  SceneGroup,
  SceneObject,
  ScenePart,
  SpecAisle,
  SpecEquipment,
  SpecRack,
  SpecRackSlot,
  SpecRow,
  SpecState,
  Vec3,
  DcSceneFragment,
} from "@platformcosmo/core";
import { connect, type Ref, type RefPort } from "./connect.js";
import { DEVICE_WIDTH_MM } from "./components/devices.js";
import {
  RACK_BASE_MM,
  RACK_DEPTH_MM,
  RACK_FRONT_INSET_MM,
  RACK_WIDTH_MM,
  readRackParams,
} from "./components/rack.js";
import { DC_DEFAULTS } from "./defaults.js";
import { registry } from "./registry.js";
import { depthSort } from "./sort.js";
import { MM_PER_TILE, U_MM, box, mm, r4, unionBox, vec } from "./units.js";

const GAP = 2; // tiles between rows (aisle width, 1200 mm)
const HALL_MARGIN = 1;
const RAISED_FLOOR_H = 0.3;
const SLAB_H = 0.04;
const GROUP_H = 0.02;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Item {
  readonly kind: "rack" | "equipment";
  readonly id: string;
  readonly index: number;
  readonly rack?: SpecRack;
  readonly equip?: SpecEquipment;
  /** Cell size in tiles. */
  readonly w: number;
  readonly d: number;
  rowId?: string;
  cx: number;
  cy: number;
  mirror: boolean;
  placed: boolean;
}

interface ActiveRow {
  readonly spec: SpecRow;
  readonly index: number;
  readonly items: Item[];
  y: number;
  d: number;
  x0: number;
  x1: number;
  mirror: boolean;
}

interface Placement {
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly mirror: boolean;
  /** Component depth (world units) the mirror reflects about. */
  readonly depth: number;
}

const tb = (b: Box3, p: Placement): Box3 =>
  box(
    p.ox + b.origin.x,
    p.mirror ? p.oy + p.depth - b.origin.y - b.size.y : p.oy + b.origin.y,
    p.oz + b.origin.z,
    b.size.x,
    b.size.y,
    b.size.z,
  );

const tv = (v: Vec3, p: Placement): Vec3 =>
  vec(p.ox + v.x, p.mirror ? p.oy + p.depth - v.y : p.oy + v.y, p.oz + v.z);

const off = (b: Box3, dx: number, dy: number, dz: number): Box3 =>
  box(b.origin.x + dx, b.origin.y + dy, b.origin.z + dz, b.size.x, b.size.y, b.size.z);

const err = (
  code: string,
  path: string,
  message: string,
  extra?: Partial<Diagnostic>,
): Diagnostic => ({
  severity: "error",
  code,
  path,
  message,
  ...extra,
});

interface ValidSlot {
  readonly index: number;
  readonly id: string;
  readonly at: number;
  readonly size: number;
  readonly spec: SpecRackSlot;
}

/** Validates slot ranges/overlaps/ids for one rack; returns the buildable slots. */
function checkSlots(rack: SpecRack, rackIndex: number, diags: Diagnostic[]): ValidSlot[] {
  const u = readRackParams({ u: rack.u }).u;
  const slots = (rack.slots ?? []).map((s, index) => {
    const def = registry.get(s.type);
    const size = s.size ?? def?.heightU ?? 1;
    return { index, id: s.id ?? `u${s.at}`, at: s.at, size, spec: s };
  });
  const order = [...slots].sort((a, b) => a.at - b.at || a.index - b.index);
  const ids = new Set<string>();
  const occupied = new Map<number, string>();
  const ok: ValidSlot[] = [];
  for (const s of order) {
    const path = `/racks/${rackIndex}/slots/${s.index}`;
    if (
      !Number.isInteger(s.at) ||
      !Number.isInteger(s.size) ||
      s.at < 1 ||
      s.size < 1 ||
      s.at + s.size - 1 > u
    ) {
      diags.push(
        err(
          "dc/slot-out-of-range",
          path,
          `Slot "${s.id}" (U${s.at}, ${s.size}U) does not fit in a ${u}U rack.`,
          { params: { at: s.at, size: s.size, rackU: u } },
        ),
      );
      continue;
    }
    if (ids.has(s.id)) {
      diags.push(
        err(
          "dc/duplicate-slot-id",
          `${path}/id`,
          `Slot id "${s.id}" is used twice in rack "${rack.id}".`,
        ),
      );
      continue;
    }
    let clash: string | undefined;
    for (let k = s.at; k < s.at + s.size; k++) clash = clash ?? occupied.get(k);
    if (clash !== undefined) {
      diags.push(
        err(
          "dc/slot-overlap",
          path,
          `Slot "${s.id}" overlaps slot "${clash}" in rack "${rack.id}".`,
          {
            params: { with: clash },
          },
        ),
      );
      continue;
    }
    ids.add(s.id);
    for (let k = s.at; k < s.at + s.size; k++) occupied.set(k, s.id);
    ok.push(s);
  }
  return ok;
}

export function buildDcScene(spec: PlatformCosmoSpec): DcSceneFragment {
  const diags: Diagnostic[] = [];
  const racks = spec.racks ?? [];
  const equipment = spec.equipment ?? [];
  const rowsSpec = spec.rows ?? [];
  const aislesSpec = spec.aisles ?? [];
  const facility = spec.facility ?? {};

  // ---- items ----
  const items = new Map<string, Item>();
  const order: Item[] = [];
  const add = (it: Item, path: string): void => {
    if (items.has(it.id)) {
      diags.push(
        err("dc/duplicate-id", path, `Id "${it.id}" is used by more than one rack or equipment.`),
      );
      return;
    }
    items.set(it.id, it);
    order.push(it);
  };
  racks.forEach((r, index) =>
    add(
      {
        kind: "rack",
        id: r.id,
        index,
        rack: r,
        w: 1,
        d: 2,
        cx: 0,
        cy: 0,
        mirror: false,
        placed: false,
      },
      `/racks/${index}/id`,
    ),
  );
  equipment.forEach((e, index) => {
    const def = registry.get(e.type);
    if (!def?.footprintMm) {
      diags.push(
        err(
          "dc/unknown-component",
          `/equipment/${index}/type`,
          `Unknown equipment type "${e.type}".`,
        ),
      );
      return;
    }
    add(
      {
        kind: "equipment",
        id: e.id,
        index,
        equip: e,
        w: Math.max(1, Math.ceil(def.footprintMm.width / MM_PER_TILE)),
        d: Math.max(1, Math.ceil(def.footprintMm.depth / MM_PER_TILE)),
        cx: 0,
        cy: 0,
        mirror: false,
        placed: false,
      },
      `/equipment/${index}/id`,
    );
  });

  // ---- rows ----
  const active: ActiveRow[] = [];
  rowsSpec.forEach((row, ri) => {
    const members: Item[] = [];
    row.members.forEach((m, mi) => {
      const it = items.get(m);
      if (!it) {
        diags.push(
          err(
            "dc/unknown-row-member",
            `/rows/${ri}/members/${mi}`,
            `Row "${row.id}" lists unknown member "${m}".`,
          ),
        );
        return;
      }
      if (it.rowId !== undefined) {
        diags.push({
          severity: "warning",
          code: "dc/member-in-multiple-rows",
          path: `/rows/${ri}/members/${mi}`,
          message: `"${m}" is already in row "${it.rowId}" and was skipped here.`,
        });
        return;
      }
      it.rowId = row.id;
      members.push(it);
    });
    if (members.length > 0) {
      active.push({
        spec: row,
        index: ri,
        items: members,
        y: 0,
        d: 1,
        x0: 0,
        x1: 0,
        mirror: false,
      });
    }
  });
  const rowById = new Map(active.map((r) => [r.spec.id, r]));

  // ---- facing: explicit first, then derived from aisles ----
  const facingSet = new Set<string>();
  for (const r of active) {
    if (r.spec.facing) {
      r.mirror = r.spec.facing === "back";
      facingSet.add(r.spec.id);
    }
  }
  const aisleRows = (a: SpecAisle, ai: number): ActiveRow[] => {
    const rs: ActiveRow[] = [];
    a.rows.forEach((rid, k) => {
      const r = rowById.get(rid);
      if (!r) {
        diags.push(
          err(
            "dc/unknown-aisle-row",
            `/aisles/${ai}/rows/${k}`,
            `Aisle "${a.id}" references unknown or empty row "${rid}".`,
          ),
        );
      } else if (!rs.includes(r)) rs.push(r);
    });
    return rs.sort((x, y) => x.index - y.index);
  };
  const aisleInfo = aislesSpec.map((a, ai) => ({ spec: a, rows: aisleRows(a, ai) }));
  for (const { spec: a, rows } of aisleInfo) {
    if (rows.length !== 2) continue;
    const [upper, lower] = rows as [ActiveRow, ActiveRow];
    const cold = a.kind === "cold";
    for (const [r, mirror] of [
      [upper, !cold],
      [lower, cold],
    ] as const) {
      if (!facingSet.has(r.spec.id)) {
        r.mirror = mirror;
        facingSet.add(r.spec.id);
      }
    }
    if (lower.index !== upper.index + 1) {
      diags.push({
        severity: "warning",
        code: "dc/aisle-rows-not-adjacent",
        path: `/aisles/${aislesSpec.indexOf(a)}/rows`,
        message: `Aisle "${a.id}" spans rows that are not neighbours; other rows sit between them.`,
      });
    }
  }

  // ---- placement (tile space, pre-margin) ----
  let cursorY = 0;
  const place = (it: Item, x: number, y: number, mirror: boolean): void => {
    it.cx = x;
    it.cy = y;
    it.mirror = mirror;
    it.placed = true;
  };
  for (const r of active) {
    r.d = Math.max(...r.items.map((i) => i.d));
    r.y = cursorY;
    let x = 0;
    for (const it of r.items) {
      const pos = it.rack?.pos ?? it.equip?.pos;
      if (pos) {
        place(it, Math.round(pos.x), Math.round(pos.y), r.mirror);
      } else {
        place(it, x, r.mirror ? r.y : r.y + r.d - it.d, r.mirror);
        x += it.w;
      }
    }
    cursorY += r.d + GAP;
  }
  const loose = order.filter((i) => i.rowId === undefined);
  if (loose.length > 0) {
    const stripD = Math.max(...loose.map((i) => i.d));
    let x = 0;
    for (const it of loose) {
      const pos = it.rack?.pos ?? it.equip?.pos;
      if (pos) place(it, Math.round(pos.x), Math.round(pos.y), false);
      else {
        place(it, x, cursorY + stripD - it.d, false);
        x += it.w;
      }
    }
  }
  for (const r of active) {
    r.x0 = Math.min(...r.items.map((i) => i.cx));
    r.x1 = Math.max(...r.items.map((i) => i.cx + i.w));
  }
  // overlaps (only reachable with manual positions)
  const placedItems = order.filter((i) => i.placed);
  for (let a = 0; a < placedItems.length; a++) {
    for (let b = a + 1; b < placedItems.length; b++) {
      const p = placedItems[a]!;
      const q = placedItems[b]!;
      if (p.cx < q.cx + q.w && q.cx < p.cx + p.w && p.cy < q.cy + q.d && q.cy < p.cy + p.d) {
        const it = q;
        diags.push({
          severity: "warning",
          code: "dc/footprint-overlap",
          path: `/${it.kind === "rack" ? "racks" : "equipment"}/${it.index}`,
          message: `"${q.id}" overlaps "${p.id}" on the floor grid.`,
          params: { with: p.id },
        });
      }
    }
  }

  // ---- aisle boxes (tile space) ----
  interface AisleBox {
    readonly spec: SpecAisle;
    readonly rows: ActiveRow[];
    readonly x0: number;
    readonly x1: number;
    readonly y0: number;
    readonly y1: number;
  }
  const aisleBoxes: AisleBox[] = [];
  for (const { spec: a, rows } of aisleInfo) {
    if (rows.length === 0) continue;
    const x0 = Math.min(...rows.map((r) => r.x0));
    const x1 = Math.max(...rows.map((r) => r.x1));
    let y0: number;
    let y1: number;
    if (rows.length === 2) {
      const [u, l] = rows as [ActiveRow, ActiveRow];
      y0 = u.y + u.d;
      y1 = l.y;
    } else {
      const r = rows[0]!;
      // Cold aisles sit on the row's front side, hot aisles on its back.
      const frontPlus = !r.mirror;
      const onPlus = a.kind === "cold" ? frontPlus : !frontPlus;
      if (onPlus) {
        y0 = r.y + r.d;
        y1 = y0 + GAP;
      } else {
        y1 = r.y;
        y0 = y1 - GAP;
      }
    }
    aisleBoxes.push({ spec: a, rows, x0, x1, y0, y1 });
  }

  // ---- hall bounds, margin shift ----
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x0: number, y0: number, x1: number, y1: number): void => {
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
  };
  for (const it of placedItems) grow(it.cx, it.cy, it.cx + it.w, it.cy + it.d);
  for (const a of aisleBoxes) grow(a.x0, a.y0, a.x1, a.y1);
  if (!Number.isFinite(minX)) {
    return {
      objects: [],
      groups: [],
      edges: [],
      flows: [],
      focusTargets: {},
      bounds: box(0, 0, 0, 0, 0, 0),
      diagnostics: sortDiags(diags),
    };
  }
  const sx = HALL_MARGIN - minX;
  const sy = HALL_MARGIN - minY;
  const raised = facility.raisedFloor ?? DC_DEFAULTS.facility.raisedFloor;
  const floorH = raised ? RAISED_FLOOR_H : SLAB_H;
  const zBase = floorH;
  const hallBox = box(
    0,
    0,
    0,
    maxX - minX + 2 * HALL_MARGIN,
    maxY - minY + 2 * HALL_MARGIN,
    floorH,
  );

  // ---- objects ----
  const objects: SceneObject[] = [];
  const refs = new Map<string, Ref>();
  const focus: Record<string, Box3> = { dc_hall: hallBox };
  let top = zBase;

  const finishRef = (
    id: string,
    type: string,
    b: Box3,
    mirror: boolean,
    ports: readonly RefPort[],
    rack?: string,
  ): void => {
    refs.set(id, { id, type, box: b, front: mirror ? -1 : 1, ports, ...(rack ? { rack } : {}) });
    focus[id] = b;
    top = Math.max(top, b.origin.z + b.size.z);
  };

  for (const it of order) {
    if (!it.placed) continue;
    const group = it.rowId ?? "dc_hall";
    if (it.kind === "rack") {
      const rack = it.rack!;
      const def = registry.get("rack")!;
      const params = readRackParams({
        u: rack.u,
        pdu: rack.pdu,
        rearDoorHeatExchanger: rack.rearDoorHeatExchanger,
      });
      const state: SpecState = rack.state ?? "healthy";
      const built = def.build(params as unknown as Record<string, unknown>, {
        id: rack.id,
        state,
        ...(rack.label !== undefined ? { label: rack.label } : {}),
      });
      const D = built.bounds.size.y;
      const p: Placement = {
        ox: it.cx + sx,
        oy: it.mirror ? it.cy + sy : it.cy + sy + it.d - D,
        oz: zBase,
        mirror: it.mirror,
        depth: D,
      };
      const rackBox = tb(built.bounds, p);
      const rackPorts: RefPort[] = built.ports.map((q) => ({
        id: q.id,
        kind: q.kind,
        at: tv(q.at, p),
      }));
      objects.push({
        id: rack.id,
        source: "dc",
        type: "rack",
        category: "dc",
        primitive: "cube",
        box: rackBox,
        ...(rack.label !== undefined ? { label: rack.label } : {}),
        group,
        state,
        parts: depthSort(built.parts.map((q) => ({ ...q, box: tb(q.box, p) }))),
        ports: portMap(rackPorts),
      });
      finishRef(rack.id, "rack", rackBox, it.mirror, rackPorts);

      const slots = checkSlots(rack, it.index, diags);
      for (const s of slots) {
        const sdef = registry.get(s.spec.type);
        if (!sdef) continue;
        const sid = `${rack.id}/${s.id}`;
        const sstate: SpecState = s.spec.state ?? state;
        const dev = sdef.build(
          { ...sdef.defaults, heightU: s.size },
          {
            id: sid,
            state: sstate,
            ...(s.spec.label !== undefined ? { label: s.spec.label } : {}),
          },
        );
        const dy = mm(RACK_DEPTH_MM - RACK_FRONT_INSET_MM) - dev.bounds.size.y;
        const dx = mm((RACK_WIDTH_MM - DEVICE_WIDTH_MM) / 2);
        const dz = mm(RACK_BASE_MM + (s.at - 1) * U_MM);
        const local = (b: Box3): Box3 => tb(off(b, dx, dy, dz), p);
        const devBox = local(dev.bounds);
        const devPorts: RefPort[] = dev.ports.map((q) => ({
          id: q.id,
          kind: q.kind,
          at: tv(vec(q.at.x + dx, q.at.y + dy, q.at.z + dz), p),
        }));
        objects.push({
          id: sid,
          source: "dc",
          type: s.spec.type,
          category: "dc",
          primitive: "cube",
          box: devBox,
          ...(s.spec.label !== undefined ? { label: s.spec.label } : {}),
          group,
          state: sstate,
          parts: depthSort(dev.parts.map((q) => ({ ...q, box: local(q.box) }))),
          ports: portMap(devPorts),
        });
        finishRef(sid, s.spec.type, devBox, it.mirror, devPorts, rack.id);
      }
    } else {
      const eq = it.equip!;
      const def = registry.get(eq.type)!;
      const state: SpecState = eq.state ?? "healthy";
      const built = def.build(def.defaults, {
        id: eq.id,
        state,
        ...(eq.label !== undefined ? { label: eq.label } : {}),
      });
      const D = built.bounds.size.y;
      const p: Placement = {
        ox: it.cx + sx,
        oy: it.mirror ? it.cy + sy : it.cy + sy + it.d - D,
        oz: zBase,
        mirror: it.mirror,
        depth: D,
      };
      const b = tb(built.bounds, p);
      const ports: RefPort[] = built.ports.map((q) => ({
        id: q.id,
        kind: q.kind,
        at: tv(q.at, p),
      }));
      objects.push({
        id: eq.id,
        source: "dc",
        type: eq.type,
        category: "dc",
        primitive: "cube",
        box: b,
        ...(eq.label !== undefined ? { label: eq.label } : {}),
        group,
        state,
        parts: depthSort(built.parts.map((q) => ({ ...q, box: tb(q.box, p) }))),
        ports: portMap(ports),
      });
      finishRef(eq.id, eq.type, b, it.mirror, ports);
    }
  }

  // ---- groups ----
  const groups: SceneGroup[] = [
    { id: "dc_hall", kind: "hall", style: "zone", box: hallBox, level: 0 },
  ];
  const slab = (x0: number, y0: number, x1: number, y1: number): Box3 =>
    box(x0 + sx, y0 + sy, zBase, x1 - x0, y1 - y0, GROUP_H);
  for (const r of active) {
    const rb = r.items.reduce<Box3 | undefined>((acc, i) => {
      const b = slab(i.cx, i.cy, i.cx + i.w, i.cy + i.d);
      return acc ? unionBox(acc, b) : b;
    }, undefined)!;
    groups.push({
      id: r.spec.id,
      kind: "row",
      style: "zone",
      parent: "dc_hall",
      box: rb,
      level: 1,
      ...(r.spec.label !== undefined ? { label: r.spec.label } : {}),
    });
    focus[r.spec.id] = rb;
  }
  for (const a of aisleBoxes) {
    const ab = slab(a.x0, a.y0, a.x1, a.y1);
    groups.push({
      id: a.spec.id,
      kind: a.spec.kind === "cold" ? "cold-aisle" : "hot-aisle",
      style: "zone",
      parent: "dc_hall",
      contained: a.spec.contained ?? DC_DEFAULTS.aisleContained,
      box: ab,
      level: 1,
      ...(a.spec.label !== undefined ? { label: a.spec.label } : {}),
    });
    focus[a.spec.id] = ab;
  }

  // ---- facility objects: containment roofs, perforated tiles, cable trays ----
  const rowTop = (rows: readonly ActiveRow[]): number =>
    Math.max(
      zBase,
      ...rows.flatMap((r) => r.items.map((i) => (refs.get(i.id)?.box.size.z ?? 0) + zBase)),
    );
  for (const a of aisleBoxes) {
    if (a.spec.contained ?? DC_DEFAULTS.aisleContained) {
      const z = rowTop(a.rows);
      const b = box(a.x0 + sx, a.y0 + sy, z, a.x1 - a.x0, a.y1 - a.y0, 0.04);
      objects.push(facilityObject(`dc_roof_${a.spec.id}`, "containment", b, "glass", a.spec.id));
      top = Math.max(top, z + 0.04);
    }
  }
  if (facility.perforatedTiles ?? DC_DEFAULTS.facility.perforatedTiles) {
    if (!raised) {
      diags.push({
        severity: "warning",
        code: "dc/perforated-without-raised-floor",
        path: "/facility/perforatedTiles",
        message: "Perforated tiles need a raised floor; none were drawn.",
        suggestion: "Set facility.raisedFloor to true.",
      });
    } else {
      for (const a of aisleBoxes.filter((x) => x.spec.kind === "cold")) {
        let n = 0;
        for (let x = a.x0; x < a.x1; x++) {
          for (let y = a.y0; y < a.y1; y++) {
            n++;
            const b = box(x + sx, y + sy, zBase, 1, 1, 0.01);
            objects.push(
              facilityObject(
                `dc_tile_${a.spec.id}_${n}`,
                "perforated-tile",
                b,
                "perforated",
                a.spec.id,
              ),
            );
          }
        }
      }
    }
  }
  const trays = facility.cableTrays ?? DC_DEFAULTS.facility.cableTrays;
  let laneZ = r4(top + 0.2);
  if (trays === "underfloor" && !raised) {
    diags.push({
      severity: "warning",
      code: "dc/underfloor-without-raised-floor",
      path: "/facility/cableTrays",
      message: "Underfloor cable trays need a raised floor; cables use overhead lanes instead.",
      suggestion: "Set facility.raisedFloor to true.",
    });
  }
  if (trays === "overhead" || (trays === "underfloor" && raised)) {
    const lanes: { id: string; x0: number; x1: number; y0: number; y1: number; h: number }[] = [
      ...active.map((r) => ({
        id: r.spec.id,
        x0: r.x0,
        x1: r.x1,
        y0: r.y,
        y1: r.y + r.d,
        h: rowTop([r]),
      })),
    ];
    const looseItems = placedItems.filter((i) => i.rowId === undefined);
    if (looseItems.length > 0) {
      lanes.push({
        id: "loose",
        x0: Math.min(...looseItems.map((i) => i.cx)),
        x1: Math.max(...looseItems.map((i) => i.cx + i.w)),
        y0: Math.min(...looseItems.map((i) => i.cy)),
        y1: Math.max(...looseItems.map((i) => i.cy + i.d)),
        h: Math.max(...looseItems.map((i) => (refs.get(i.id)?.box.size.z ?? 0) + zBase)),
      });
    }
    const under = trays === "underfloor";
    for (const l of lanes) {
      const z = under ? r4(zBase * 0.4) : r4(l.h + 0.12);
      const midY = (l.y0 + l.y1) / 2 - 0.25;
      const b = box(l.x0 + sx, midY + sy, z, l.x1 - l.x0, 0.5, 0.05);
      objects.push(
        facilityObject(
          `dc_tray_${l.id}`,
          "cable-tray",
          b,
          "metal",
          l.id === "loose" ? "dc_hall" : l.id,
        ),
      );
      top = Math.max(top, z + 0.05);
    }
    laneZ = under ? r4(zBase * 0.4 + 0.05) : r4(Math.max(...lanes.map((l) => l.h)) + 0.17);
  }

  // ---- cables and flows ----
  const airflow = placedItems
    .filter((i) => i.kind === "rack")
    .map((i) => {
      const cold = aisleBoxes.find(
        (a) =>
          a.spec.kind === "cold" &&
          i.rowId !== undefined &&
          a.rows.some((r) => r.spec.id === i.rowId),
      );
      const hot = aisleBoxes.find(
        (a) =>
          a.spec.kind === "hot" &&
          i.rowId !== undefined &&
          a.rows.some((r) => r.spec.id === i.rowId),
      );
      return {
        rack: i.id,
        ...(cold ? { cold: cold.spec.id } : {}),
        ...(hot ? { hot: hot.spec.id } : {}),
      };
    });
  const conn = connect({ refs, cables: spec.cables ?? [], laneZ, airflow });
  diags.push(...conn.diagnostics);

  objects.sort((a, b) => cmp(a.id, b.id));
  groups.sort((a, b) => a.level - b.level || cmp(a.id, b.id));
  let bounds = hallBox;
  for (const o of objects) bounds = unionBox(bounds, o.box);
  const focusSorted = Object.fromEntries(Object.entries(focus).sort(([a], [b]) => cmp(a, b)));

  return {
    objects,
    groups,
    edges: conn.edges,
    flows: conn.flows,
    focusTargets: focusSorted,
    bounds,
    diagnostics: sortDiags(diags),
  };
}

function portMap(ports: readonly RefPort[]): Record<string, Vec3> {
  return Object.fromEntries(ports.map((p) => [p.id, p.at]));
}

function facilityObject(
  id: string,
  type: string,
  b: Box3,
  tone: ScenePart["tone"],
  group: string,
): SceneObject {
  return {
    id,
    source: "dc",
    type,
    category: "dc",
    primitive: "slab",
    box: b,
    group,
    state: "healthy",
    parts: [{ id: "body", primitive: "slab", box: b, tone }],
  };
}

function sortDiags(d: Diagnostic[]): Diagnostic[] {
  return [...d].sort((a, b) => cmp(a.path, b.path) || cmp(a.code, b.code));
}
