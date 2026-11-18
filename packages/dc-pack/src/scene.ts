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
const MAX_GRID_TILES = 500;
const MAX_VENT_TILES = 100;
/** The tile grid sits strictly below the floor surface so it never competes with objects in depth. */
const GRID_H = 0.004;

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
  /** Cable lane y (tile space, pre-margin): row centre, strip centre or own centre. */
  lane: number;
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
    if (!registry.get(s.spec.type)) {
      diags.push(
        err("dc/unknown-component", `${path}/type`, `Unknown slot type "${s.spec.type}".`),
      );
      continue;
    }
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
        lane: 0,
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
        lane: 0,
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
  const aisleInfo = aislesSpec.map((a, ai) => ({ spec: a, rows: aisleRows(a, ai), index: ai }));
  for (const { spec: a, rows, index } of aisleInfo) {
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
      } else if (r.mirror !== mirror) {
        diags.push({
          severity: "warning",
          code: "dc/facing-conflict",
          path: `/aisles/${index}`,
          message: `Aisle "${a.id}" would turn row "${r.spec.id}" the other way; the earlier facing was kept.`,
        });
      }
    }
    if (lower.index !== upper.index + 1) {
      diags.push({
        severity: "warning",
        code: "dc/aisle-rows-not-adjacent",
        path: `/aisles/${index}/rows`,
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
  // Row extents from the members (manual positions may move them off the nominal line).
  const fixRowExtents = (r: ActiveRow): void => {
    r.x0 = Math.min(...r.items.map((i) => i.cx));
    r.x1 = Math.max(...r.items.map((i) => i.cx + i.w));
    const y1 = Math.max(...r.items.map((i) => i.cy + i.d));
    r.y = Math.min(...r.items.map((i) => i.cy));
    r.d = y1 - r.y;
    for (const it of r.items) it.lane = r.y - 0.5;
  };
  for (const r of active) fixRowExtents(r);

  // Aisle footprint (tile space) from its bounding rows.
  const aisleGeom = (a: SpecAisle, rows: readonly ActiveRow[]) => {
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
    return { x0, x1, y0, y1 };
  };

  // The viewer looks from +x,+y, so anything at larger x or y stands IN FRONT of the rows on
  // screen. Loose items therefore go to the far side: CRAHs at the -x end of the cold aisle
  // (1 tile clear of the row start) and the service strip (UPS, PDUs, busway, loose racks) 3
  // tiles behind the first row on the -y side.
  const loose = order.filter((i) => i.rowId === undefined);
  const isCrah = (i: Item): boolean =>
    i.equip?.type === "crah" && i.equip.pos === undefined && active.length > 0;
  const crahs = loose.filter(isCrah);
  const strip = loose.filter((i) => !isCrah(i));
  const rowsMinX = active.length > 0 ? Math.min(...active.map((r) => r.x0)) : 0;
  if (crahs.length > 0) {
    const ai =
      aisleInfo.find((a) => a.spec.kind === "cold" && a.rows.length > 0) ??
      aisleInfo.find((a) => a.rows.length > 0);
    let y = Math.min(...active.map((r) => r.y));
    if (ai) {
      const g = aisleGeom(ai.spec, ai.rows);
      if (g.y1 > g.y0) y = g.y0;
    }
    for (const it of crahs) {
      place(it, rowsMinX - 2 - it.w, y, false);
      it.lane = y + it.d / 2;
      y += it.d;
    }
  }
  if (strip.length > 0) {
    const stripD = Math.max(...strip.map((i) => i.d));
    const firstY =
      active.length > 0
        ? Math.min(
            ...active.map((r) => r.y),
            ...aisleInfo.filter((a) => a.rows.length > 0).map((a) => aisleGeom(a.spec, a.rows).y0),
          )
        : cursorY + stripD + 3; // no rows: the strip is the hall, start at y 0
    const bottom = active.length > 0 ? firstY - 3 : stripD;
    let x = 0;
    for (const it of strip) {
      const pos = it.rack?.pos ?? it.equip?.pos;
      if (pos) place(it, Math.round(pos.x), Math.round(pos.y), false);
      else {
        place(it, x, bottom - it.d, false);
        x += it.w;
      }
      it.lane = it.cy + it.d / 2;
    }
  }
  for (const r of active) {
    r.x0 = Math.min(...r.items.map((i) => i.cx));
    r.x1 = Math.max(...r.items.map((i) => i.cx + i.w));
    // Manual positions may move members off the nominal row line: derive y from the members.
    const y1 = Math.max(...r.items.map((i) => i.cy + i.d));
    r.y = Math.min(...r.items.map((i) => i.cy));
    r.d = y1 - r.y;
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
  for (const { spec: a, rows, index } of aisleInfo) {
    if (rows.length === 0) continue;
    const { x0, x1, y0, y1 } = aisleGeom(a, rows);
    if (!(x1 > x0) || !(y1 > y0)) {
      diags.push({
        severity: "warning",
        code: "dc/aisle-no-space",
        path: `/aisles/${index}`,
        message: `Aisle "${a.id}" has no floor space between its rows and was skipped.`,
      });
      continue;
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
  for (const r of active) grow(r.x1 + 1, r.y, r.x1 + 2, r.y + r.d);
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
    laneY: number,
    rack?: string,
  ): void => {
    refs.set(id, {
      id,
      type,
      box: b,
      front: mirror ? -1 : 1,
      ports,
      laneY,
      ...(rack ? { rack } : {}),
    });
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
      const state: SpecState = rack.state ?? DC_DEFAULTS.state;
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
      // The viewer-side shell (corner posts, top cap; for mirrored rows the rear door, PDUs and
      // posts) is its own sibling object so it can draw after the slot devices.
      const nearIds = it.mirror
        ? ["post-bl", "post-br", "rear-", "pdu-", "top"]
        : ["post-fl", "post-fr", "top"];
      const worldParts = built.parts.map((q) => ({ ...q, box: tb(q.box, p) }));
      const isNear = (id: string): boolean =>
        nearIds.some((n) => (n.endsWith("-") ? id.startsWith(n) : id === n)) ||
        id.startsWith("top");
      const shellParts = worldParts.filter((q) => isNear(q.id));
      const bodyParts = worldParts.filter((q) => !isNear(q.id));
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
        parts: depthSort(bodyParts),
        ports: portMap(rackPorts),
      });
      const shellBox = shellParts.reduce<Box3 | undefined>(
        (acc, q) => (acc ? unionBox(acc, q.box) : q.box),
        undefined,
      );
      if (shellBox) {
        objects.push({
          id: `${rack.id}_front`,
          source: "dc",
          type: "rack-front",
          category: "dc",
          primitive: "cube",
          box: shellBox,
          group,
          state,
          parts: depthSort(shellParts),
        });
      }
      finishRef(rack.id, "rack", rackBox, it.mirror, rackPorts, it.lane + sy);

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
        finishRef(sid, s.spec.type, devBox, it.mirror, devPorts, it.lane + sy, rack.id);
      }
    } else {
      const eq = it.equip!;
      const def = registry.get(eq.type)!;
      const state: SpecState = eq.state ?? DC_DEFAULTS.state;
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
      finishRef(eq.id, eq.type, b, it.mirror, ports, it.lane + sy);
    }
  }

  // ---- groups ----
  const groups: SceneGroup[] = [
    { id: "dc_hall", kind: "hall", style: "zone", box: hallBox, level: 0 },
  ];
  const slab = (x0: number, y0: number, x1: number, y1: number): Box3 =>
    box(x0 + sx, y0 + sy, zBase, x1 - x0, y1 - y0, GROUP_H);
  for (const r of active) {
    // A's group label sits at the group box's low-x/high-y corner. The row group is therefore
    // the one-tile end cap on the viewer (+x) side of the row, which puts the label at the row
    // end in the aisle, never on equipment. Focus still covers the member boxes.
    const rb = slab(r.x1 + 0.5, r.y, r.x1 + 1.5, r.y + r.d + 0.5); // label clear of rack labels; hall grows by whole tiles
    groups.push({
      id: r.spec.id,
      kind: "row",
      style: "zone",
      parent: "dc_hall",
      box: rb,
      level: 1,
      ...(r.spec.label !== undefined ? { label: r.spec.label } : {}),
    });
    focus[r.spec.id] =
      r.items.reduce<Box3 | undefined>((acc, i) => {
        const b = refs.get(i.id)?.box;
        return b ? (acc ? unionBox(acc, b) : b) : acc;
      }, undefined) ?? rb;
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
  }

  // ---- facility objects: containment roofs, perforated tiles, cable trays ----
  const rowTop = (rows: readonly ActiveRow[]): number =>
    Math.max(
      zBase,
      ...rows.flatMap((r) => r.items.map((i) => (refs.get(i.id)?.box.size.z ?? 0) + zBase)),
    );
  for (const a of aisleBoxes) {
    focus[a.spec.id] = box(
      a.x0 + sx,
      a.y0 + sy,
      zBase,
      a.x1 - a.x0,
      a.y1 - a.y0,
      Math.max(GROUP_H, rowTop(a.rows) - zBase),
    );
    if (a.spec.contained ?? DC_DEFAULTS.aisleContained) {
      const z = rowTop(a.rows);
      const b = box(a.x0 + sx, a.y0 + sy, z, a.x1 - a.x0, a.y1 - a.y0, 0.04);
      // A see-through frame (rails only) so the top devices stay visible through the roof.
      const w = 0.1;
      const rails: ScenePart[] = [
        {
          id: "rail-b",
          primitive: "slab",
          tone: "glass",
          box: box(b.origin.x, b.origin.y, z, b.size.x, w, 0.04),
        },
        {
          id: "rail-f",
          primitive: "slab",
          tone: "glass",
          box: box(b.origin.x, b.origin.y + b.size.y - w, z, b.size.x, w, 0.04),
        },
        {
          id: "rail-l",
          primitive: "slab",
          tone: "glass",
          box: box(b.origin.x, b.origin.y + w, z, w, b.size.y - 2 * w, 0.04),
        },
        {
          id: "rail-r",
          primitive: "slab",
          tone: "glass",
          box: box(b.origin.x + b.size.x - w, b.origin.y + w, z, w, b.size.y - 2 * w, 0.04),
        },
        {
          id: "rail-m",
          primitive: "slab",
          tone: "glass",
          box: box(b.origin.x + w, b.origin.y + b.size.y / 2 - w / 2, z, b.size.x - 2 * w, w, 0.04),
        },
      ];
      objects.push({
        ...facilityObject(`dc_roof_${a.spec.id}`, "containment", b, "glass", a.spec.id),
        parts: rails,
      });
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
        const tiles: ScenePart[] = [];
        // Slits are decoration: skip them on big aisles to keep the part count down.
        const ventSlits = Math.round((a.x1 - a.x0) * (a.y1 - a.y0)) <= MAX_VENT_TILES;
        for (let x = a.x0; x < a.x1; x++) {
          for (let y = a.y0; y < a.y1; y++) {
            const n = tiles.length + 1;
            tiles.push({
              id: `tile-${n}`,
              primitive: "slab",
              tone: "perforated",
              box: box(x + sx, y + sy, zBase, 1, 1, 0.01),
            });
            // Vent slits so the tile reads as perforated at a glance.
            for (let k = 0; k < (ventSlits ? 3 : 0); k++) {
              tiles.push({
                id: `vent-${n}-${k}`,
                primitive: "slab",
                tone: "base",
                box: box(x + sx + 0.15, y + sy + 0.2 + k * 0.28, zBase + 0.01, 0.7, 0.06, 0.004),
              });
            }
          }
        }
        const fb = box(a.x0 + sx, a.y0 + sy, zBase, a.x1 - a.x0, a.y1 - a.y0, 0.014);
        objects.push({
          ...facilityObject(
            `dc_tiles_${a.spec.id}`,
            "perforated-tiles",
            fb,
            "perforated",
            a.spec.id,
          ),
          parts: tiles,
        });
      }
    }
  }
  if (raised) {
    const tilesX = Math.round(hallBox.size.x);
    const tilesY = Math.round(hallBox.size.y);
    if (tilesX * tilesY <= MAX_GRID_TILES) {
      const parts: ScenePart[] = [];
      for (let x = 0; x < tilesX; x++) {
        for (let y = 0; y < tilesY; y++) {
          parts.push({
            id: `tile-${parts.length + 1}`,
            primitive: "slab",
            tone: "floor",
            box: box(x, y, zBase - GRID_H, 1, 1, GRID_H),
          });
        }
      }
      const gb = box(0, 0, zBase - GRID_H, tilesX, tilesY, GRID_H);
      objects.push({
        ...facilityObject("dc_floor_grid", "floor-grid", gb, "floor", "dc_hall"),
        parts,
      });
    } else {
      diags.push({
        severity: "info",
        code: "dc/floor-grid-skipped",
        path: "/facility/raisedFloor",
        message: `The hall has more than ${MAX_GRID_TILES} floor tiles; the tile grid was not drawn.`,
      });
    }
  }
  const trays = facility.cableTrays ?? DC_DEFAULTS.facility.cableTrays;
  let laneZ = r4(top + 0.2);
  let tray: { spineX: number; z: number } | undefined;
  if (trays === "underfloor" && !raised) {
    diags.push({
      severity: "warning",
      code: "dc/underfloor-without-raised-floor",
      path: "/facility/cableTrays",
      message: "Underfloor cable trays need a raised floor; cables use overhead lanes instead.",
      suggestion: "Set facility.raisedFloor to true.",
    });
  }
  if (trays === "overhead") {
    // One tray height for the whole hall: just above the tallest rack (never equipment tops).
    const rackTops = [...refs.values()]
      .filter((r) => r.type === "rack")
      .map((r) => r.box.origin.z + r.box.size.z);
    const trayZ = r4((rackTops.length > 0 ? Math.max(...rackTops) : top) + 0.12);
    // The spine runs in the 1-tile gap just before the rows start (between the CRAHs and the
    // racks); trays exist only over rows and on the way to cabled equipment.
    const spineX =
      (active.length > 0 ? rowsMinX : Math.min(...placedItems.map((i) => i.cx))) + sx - 0.5;
    // Equipment that really gets a cable: accepted spec cables (endpoints known, no self-loop,
    // unique id), plus the UPS/PDUs the automatic power flows will route to.
    const cabled = new Set<string>();
    const cableIds = new Set<string>();
    let hasPowerCable = false;
    (spec.cables ?? []).forEach((c, ci) => {
      const id = c.id ?? `dc_cable_${ci + 1}`;
      if (cableIds.has(id) || !refs.has(c.from) || !refs.has(c.to) || c.from === c.to) return;
      cableIds.add(id);
      cabled.add(c.from.split("/")[0]!);
      cabled.add(c.to.split("/")[0]!);
      if (c.kind === "power") hasPowerCable = true;
    });
    if (!hasPowerCable) {
      for (const r of refs.values()) {
        if (r.type === "ups" || r.type === "pdu-floor") cabled.add(r.id);
      }
    }
    const lanes: { id: string; xa: number; xb: number; y: number; group: string }[] = active.map(
      (r) => ({
        id: r.spec.id,
        xa: spineX - 0.25,
        xb: r.x1 + sx,
        y: r.y - 0.5 + sy,
        group: r.spec.id,
      }),
    );
    for (const it of [...crahs, ...strip]) {
      if (!it.placed || !cabled.has(it.id)) continue;
      const cx = it.cx + it.w / 2 + sx;
      lanes.push({
        id: it.id,
        xa: Math.min(cx, spineX - 0.25),
        xb: Math.max(cx, spineX + 0.25),
        y: it.lane + sy,
        group: "dc_hall",
      });
    }
    for (const l of lanes) {
      const b = box(l.xa, l.y - 0.25, trayZ, l.xb - l.xa, 0.5, 0.05);
      objects.push(facilityObject(`dc_tray_${l.id}`, "cable-tray", b, "metal", l.group));
    }
    const laneYs = lanes.map((l) => l.y);
    if (new Set(laneYs.map(r4)).size > 1) {
      const y0 = Math.min(...laneYs) - 0.25;
      const y1 = Math.max(...laneYs) + 0.25;
      objects.push(
        facilityObject(
          "dc_tray_spine",
          "cable-tray",
          box(spineX - 0.25, y0, trayZ, 0.5, y1 - y0, 0.05),
          "metal",
          "dc_hall",
        ),
      );
    }
    top = Math.max(top, trayZ + 0.05);
    laneZ = r4(trayZ + 0.05);
    tray = { spineX, z: laneZ };
  } else if (trays === "underfloor" && raised) {
    for (const r of active) {
      const z = r4(zBase * 0.4);
      const b = box(r.x0 + sx, r.y + r.d / 2 + sy - 0.25, z, r.x1 - r.x0, 0.5, 0.05);
      objects.push(facilityObject(`dc_tray_${r.spec.id}`, "cable-tray", b, "metal", r.spec.id));
    }
    laneZ = r4(zBase * 0.4 + 0.05);
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
  const conn = connect({
    refs,
    cables: spec.cables ?? [],
    laneZ,
    ...(tray ? { tray } : {}),
    airflow,
    particleBudget: GLOBAL_PARTICLES - specFlowCost(spec),
  });
  diags.push(...conn.diagnostics);

  objects.sort((a, b) => cmp(a.id, b.id));
  groups.sort((a, b) => a.level - b.level || cmp(a.id, b.id));
  let bounds = hallBox;
  for (const o of objects) bounds = unionBox(bounds, o.box);
  for (const e of conn.edges) {
    for (const v of [...e.path, ...(e.labelAnchor ? [e.labelAnchor] : [])]) {
      bounds = unionBox(bounds, box(v.x, v.y, v.z, 0, 0, 0));
    }
  }
  focus["dc_hall"] = bounds;
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

/** Global particle budget shared by spec flows and DC flows. */
const GLOBAL_PARTICLES = 2000;

/** Particles used by the spec's base flows plus every step's flows: sum of ceil(rate x 2). */
export function specFlowCost(spec: PlatformCosmoSpec): number {
  const cost = (fs: readonly { rate?: number }[] | undefined): number =>
    (fs ?? []).reduce((n, f) => n + Math.ceil((f.rate ?? 1) * 2), 0);
  return cost(spec.flows) + (spec.steps ?? []).reduce((n, st) => n + cost(st.flows), 0);
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
    state: DC_DEFAULTS.state,
    parts: [{ id: "body", primitive: "slab", box: b, tone }],
  };
}

function sortDiags(d: Diagnostic[]): Diagnostic[] {
  return [...d].sort((a, b) => cmp(a.path, b.path) || cmp(a.code, b.code));
}
