/**
 * `DcPack.buildAssembly` (assemblies.md 8, Track E-1): a rack as a `SceneAssembly`.
 *
 * Called only for racks a step action targets (the pack checks again and builds nothing for any
 * other rack, so every 1.1 spec keeps its pre-1.2 objects and bytes). The tree:
 *
 *   <rack>                       sub, `source: "dc"`
 *     frame/<part>               posts, base, PDUs, top rails (shell); rear-door/* (cover)
 *     <slot>                     one sub per occupied slot (type = the slot type)
 *       leaves of the device     chassis (shell) and front details; or, with `slots[].assembly`:
 *       tray, lid (cover), faceplate/*, rear/*, then the template's parts at true scale
 *
 * Coordinates: local millimetres in WORLD axes, origin at the rack's minimum corner, frame
 * scale 1/600 (true scale), `rotate` 0. A rack in a mirrored row (front at -y) is turned half a
 * turn here (boxes and geometry), so `front` is `-y` and the drawer slides toward it.
 *
 * Programs are resolved by `programs.ts`: the built-in `drawers` (doors, then every slot),
 * the rack's own `programs`, and `internals` per slot with a template (lid up, then the
 * template's default program). Nothing here throws; bad input is a diagnostic and, where the
 * tree cannot be trusted, no assembly.
 */
import {
  readRackParams,
  RACK_BASE_MM,
  RACK_DEPTH_MM,
  RACK_FRONT_INSET_MM,
  RACK_WIDTH_MM,
} from "./components/rack.js";
import { DEVICE_WIDTH_MM } from "./components/devices.js";
import { checkSlots } from "./scene.js";
import { registry } from "./registry.js";
import { depthSort } from "./sort.js";
import { U_MM } from "./units.js";
import { partKind, tileToMm, unitMm } from "./shapes.js";
import {
  resolveProgram,
  toPNode,
  type ProgramIn,
  type ResolveResult,
  type StageIn,
} from "./programs.js";
import type {
  AssemblyFrame,
  Box3,
  DcSceneFragment,
  Diagnostic,
  PartGeometry,
  PartPrimitive,
  PartRole,
  PlatformCosmoSpec,
  ResolvedExplodeProgram,
  ResolvedProgram,
  ResolvedStage,
  SceneAssembly,
  SceneAssemblyNode,
  ScenePart,
  SpecAssembly,
  SpecExplodeProgram,
  SpecRack,
  SpecState,
  Vec3,
} from "@platformcosmo/core";

const MM = 600;
const EPS = 1e-6;
/** Leaf parts per spec (assemblies.md 13). */
export const MAX_LEAVES = 2000;
/** Slots per rack (schema `maxItems`). */
export const MAX_SLOTS = 48;
const MAX_DEPTH = 8;
const WALL_MM = 2;
const LID_MM = 2;
/** Ids the pack owns inside a slot that has internals. */
const RESERVED = ["tray", "lid", "faceplate", "rear"] as const;

const rnd = (v: number): number => Math.round(v * 1e9) / 1e9 + 0;
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------------------------

const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number): Box3 => ({
  origin: { x: r6(x), y: r6(y), z: r6(z) },
  size: { x: r6(sx), y: r6(sy), z: r6(sz) },
});

function unionOf(boxes: readonly Box3[]): Box3 | undefined {
  if (boxes.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.origin.x);
    y0 = Math.min(y0, b.origin.y);
    z0 = Math.min(z0, b.origin.z);
    x1 = Math.max(x1, b.origin.x + b.size.x);
    y1 = Math.max(y1, b.origin.y + b.size.y);
    z1 = Math.max(z1, b.origin.z + b.size.z);
  }
  return box(x0, y0, z0, x1 - x0, y1 - y0, z1 - z0);
}

/** Component-local scene part (tiles) as a box in mm, offset by (dx, dy, dz) mm. */
const partBox = (p: ScenePart, dx: number, dy: number, dz: number): Box3 =>
  box(
    tileToMm(p.box.origin.x) + dx,
    tileToMm(p.box.origin.y) + dy,
    tileToMm(p.box.origin.z) + dz,
    tileToMm(p.box.size.x),
    tileToMm(p.box.size.y),
    tileToMm(p.box.size.z),
  );

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

const origin3: Vec3 = { x: 0, y: 0, z: 0 };

/** A single-box leaf geometry (kind `box` or `plate`) in its own frame. */
function boxGeometry(size: Vec3, p: ScenePart): PartGeometry {
  const b: Box3 = { origin: origin3, size };
  return {
    primitives: [{ id: "main", kind: partKind(p.primitive), box: b, tone: p.tone }],
    bounds: b,
    depthBox: b,
    solid: true,
  };
}

/** Open-top tray: floor and four walls (ids as core's `tray` primitive), `wall` thick, in mm. */
function trayGeometry(size: Vec3, p: ScenePart): PartGeometry {
  const w = Math.min(WALL_MM, size.x / 4, size.y / 4, size.z / 2);
  const mk = (id: string, b: Box3): PartPrimitive => ({
    id: `tray.${id}`,
    kind: "box",
    box: b,
    tone: p.tone,
  });
  const inner = size.x - 2 * w;
  const whole: Box3 = { origin: origin3, size };
  return {
    primitives: [
      mk("floor", box(0, 0, 0, size.x, size.y, w)),
      mk("wall-nx", box(0, 0, w, w, size.y, size.z - w)),
      mk("wall-ny", box(w, 0, w, inner, w, size.z - w)),
      mk("wall-py", box(w, size.y - w, w, inner, w, size.z - w)),
      mk("wall-px", box(size.x - w, 0, w, w, size.y, size.z - w)),
    ],
    bounds: whole,
    depthBox: whole,
    solid: false,
    split: {
      back: ["tray.floor", "tray.wall-nx", "tray.wall-ny"],
      front: ["tray.wall-py", "tray.wall-px"],
    },
  };
}

/** Geometry turned half a turn about z inside a part box of `size` (x, y). */
function turnGeometry(g: PartGeometry, size: Vec3): PartGeometry {
  const flip = (b: Box3): Box3 => ({
    origin: {
      x: r6(size.x - b.origin.x - b.size.x),
      y: r6(size.y - b.origin.y - b.size.y),
      z: b.origin.z,
    },
    size: b.size,
  });
  const primitives = g.primitives.map((p) => ({
    ...p,
    box: flip(p.box),
    ...(p.kind === "wedge"
      ? { rotate: ((((p.rotate ?? 0) / 90 + 2) % 4) * 90) as 0 | 90 | 180 | 270 }
      : {}),
  }));
  const bounds = flip(g.bounds);
  const depthBox = flip(g.depthBox);
  let split = g.split;
  if (split !== undefined) {
    const ids = new Set([...split.back, ...split.front]);
    const cx = bounds.origin.x + bounds.size.x / 2;
    const cy = bounds.origin.y + bounds.size.y / 2;
    const old = new Set(split.front);
    const back: string[] = [];
    const front: string[] = [];
    for (const p of primitives) {
      if (!ids.has(p.id)) continue;
      let isFront: boolean;
      if (p.kind === "box") {
        // as core's reassignSplit: the floor and every -x / -y wall draw behind
        isFront =
          p.box.origin.x + p.box.size.x / 2 > cx + 1e-9 ||
          p.box.origin.y + p.box.size.y / 2 > cy + 1e-9;
      } else {
        isFront = !old.has(p.id); // a ring half swaps with the other half
      }
      (isFront ? front : back).push(p.id);
    }
    split = { back, front };
  }
  const images = g.images?.filter((im) => im.face === "billboard" || im.face === "top");
  return {
    ...g,
    primitives,
    bounds,
    depthBox,
    ...(split === undefined ? {} : { split }),
    ...(images === undefined ? {} : { images }),
  };
}

function scaleGeometry(g: PartGeometry, s: Vec3): PartGeometry {
  const sb = (b: Box3): Box3 => ({
    origin: { x: r6(b.origin.x * s.x), y: r6(b.origin.y * s.y), z: r6(b.origin.z * s.z) },
    size: { x: r6(b.size.x * s.x), y: r6(b.size.y * s.y), z: r6(b.size.z * s.z) },
  });
  return {
    ...g,
    primitives: g.primitives.map((p) => ({ ...p, box: sb(p.box) })),
    bounds: sb(g.bounds),
    depthBox: sb(g.depthBox),
  };
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

interface NodeInit {
  readonly type?: string;
  readonly label?: string;
  readonly role: PartRole;
  readonly state: SpecState;
  readonly mates?: string;
}

function leafNode(
  path: string,
  local: Box3,
  geometry: PartGeometry,
  init: NodeInit,
): SceneAssemblyNode {
  return {
    path,
    id: path.slice(path.lastIndexOf("/") + 1),
    kind: "leaf",
    ...(init.type === undefined ? {} : { type: init.type }),
    tags: [],
    role: init.role,
    ...(init.label === undefined ? {} : { label: init.label }),
    detail: [],
    state: init.state,
    local,
    world: local,
    geometry,
    ...(init.mates === undefined ? {} : { mates: init.mates }),
    children: [],
  };
}

function subNode(
  path: string,
  children: readonly SceneAssemblyNode[],
  init: NodeInit,
): SceneAssemblyNode {
  const local = unionOf(children.map((c) => c.local)) ?? box(0, 0, 0, 0, 0, 0);
  return {
    path,
    id: path.slice(path.lastIndexOf("/") + 1),
    kind: "sub",
    ...(init.type === undefined ? {} : { type: init.type }),
    tags: [],
    role: init.role,
    ...(init.label === undefined ? {} : { label: init.label }),
    detail: [],
    state: init.state,
    local,
    world: local,
    children,
  };
}

interface Placer {
  readonly origin: Vec3;
  readonly mirror: boolean;
  readonly w: number;
  readonly d: number;
}

/** Local mm box to world tiles. */
function worldBox(b: Box3, pl: Placer): Box3 {
  const s = (v: number, o: number): number => rnd(o + v / MM);
  return {
    origin: {
      x: s(b.origin.x, pl.origin.x),
      y: s(b.origin.y, pl.origin.y),
      z: s(b.origin.z, pl.origin.z),
    },
    size: { x: rnd(b.size.x / MM), y: rnd(b.size.y / MM), z: rnd(b.size.z / MM) },
  };
}

/** Turns the finished tree into its final pose: mirrored rows are turned half a turn. */
function place(n: SceneAssemblyNode, pl: Placer): SceneAssemblyNode {
  const kids = n.children.map((k) => place(k, pl));
  const local = pl.mirror
    ? box(
        pl.w - n.local.origin.x - n.local.size.x,
        pl.d - n.local.origin.y - n.local.size.y,
        n.local.origin.z,
        n.local.size.x,
        n.local.size.y,
        n.local.size.z,
      )
    : n.local;
  if (n.kind === "leaf" && n.geometry !== undefined) {
    const g = pl.mirror ? turnGeometry(n.geometry, n.local.size) : n.geometry;
    const d = g.depthBox;
    const world = worldBox(
      box(
        local.origin.x + d.origin.x,
        local.origin.y + d.origin.y,
        local.origin.z + d.origin.z,
        d.size.x,
        d.size.y,
        d.size.z,
      ),
      pl,
    );
    return { ...n, local, world, geometry: g, children: kids };
  }
  const world = unionOf(kids.map((k) => k.world)) ?? worldBox(local, pl);
  return { ...n, local, world, children: kids };
}

function leavesOf(n: SceneAssemblyNode, out: string[] = []): string[] {
  for (const c of n.children) {
    if (c.kind === "leaf") out.push(c.path);
    else leavesOf(c, out);
  }
  return out;
}

function countLeaves(n: SceneAssemblyNode, limit: number): number {
  let count = 0;
  const walk = (x: SceneAssemblyNode): void => {
    for (const c of x.children) {
      if (count > limit) return;
      if (c.kind === "leaf") count++;
      else walk(c);
    }
  };
  walk(n);
  return count;
}

// ---------------------------------------------------------------------------------------------
// Templates (slot internals, 8.2)
// ---------------------------------------------------------------------------------------------

interface TemplateFit {
  readonly nodes: SceneAssemblyNode[];
  /** Uniform shrink applied (1 = none). */
  readonly factor: number;
}

function leafBoundsOf(n: SceneAssemblyNode, out: Box3[]): void {
  if (n.kind === "leaf") {
    const g = n.geometry;
    out.push(
      g === undefined
        ? n.local
        : box(
            n.local.origin.x + g.bounds.origin.x,
            n.local.origin.y + g.bounds.origin.y,
            n.local.origin.z + g.bounds.origin.z,
            g.bounds.size.x,
            g.bounds.size.y,
            g.bounds.size.z,
          ),
    );
  } else for (const c of n.children) leafBoundsOf(c, out);
}

/**
 * The template's children at true scale inside `interior` (rack-local mm, unturned): the
 * template's bounds are moved to the interior's minimum corner and shrunk uniformly when they
 * do not fit. Paths are rebased under `host`; nodes deeper than 8 segments are dropped.
 */
function fitTemplate(
  tpl: SceneAssemblyNode,
  units: SpecAssembly["units"],
  interior: Box3,
  host: string,
  state: SpecState,
): TemplateFit | undefined {
  const bounds: Box3[] = [];
  leafBoundsOf(tpl, bounds);
  const tb = unionOf(bounds);
  if (tb === undefined) return undefined;
  const m = unitMm(units ?? "mm");
  const ext = { x: tb.size.x * m.x, y: tb.size.y * m.y, z: tb.size.z * m.z };
  const ratio = (room: number, need: number): number => (need > EPS ? room / need : Infinity);
  const f = Math.min(
    1,
    ratio(interior.size.x, ext.x),
    ratio(interior.size.y, ext.y),
    ratio(interior.size.z, ext.z),
  );
  if (!(f > 0) || !Number.isFinite(f)) return undefined;
  const s = { x: m.x * f, y: m.y * f, z: m.z * f };
  const t = {
    x: interior.origin.x - tb.origin.x * s.x,
    y: interior.origin.y - tb.origin.y * s.y,
    z: interior.origin.z - tb.origin.z * s.z,
  };
  const mapBox = (b: Box3): Box3 =>
    box(
      b.origin.x * s.x + t.x,
      b.origin.y * s.y + t.y,
      b.origin.z * s.z + t.z,
      b.size.x * s.x,
      b.size.y * s.y,
      b.size.z * s.z,
    );
  const prefix = `${tpl.path}/`;
  const rebase = (p: string | undefined): string | undefined =>
    p !== undefined && p.startsWith(prefix) ? `${host}/${p.slice(prefix.length)}` : undefined;
  const convert = (n: SceneAssemblyNode): SceneAssemblyNode | undefined => {
    const path = rebase(n.path);
    if (path === undefined || path.split("/").length > MAX_DEPTH) return undefined;
    const kids: SceneAssemblyNode[] = [];
    for (const c of n.children) {
      const k = convert(c);
      if (k !== undefined) kids.push(k);
    }
    const { mates: m0, inserts: i0, geometry: g0, ...rest } = n;
    const mates = rebase(m0);
    const inserts = rebase(i0);
    const local = mapBox(n.local);
    return {
      ...rest,
      path,
      state: n.state === "healthy" ? state : n.state,
      local,
      world: local,
      ...(g0 === undefined ? {} : { geometry: scaleGeometry(g0, s) }),
      ...(mates === undefined ? {} : { mates }),
      ...(inserts === undefined ? {} : { inserts }),
      children: kids,
    };
  };
  const nodes: SceneAssemblyNode[] = [];
  for (const c of tpl.children) {
    const k = convert(c);
    if (k !== undefined) nodes.push(k);
  }
  return { nodes, factor: f };
}

// ---------------------------------------------------------------------------------------------
// Rack
// ---------------------------------------------------------------------------------------------

const FRAME_ROLE: Readonly<Record<string, PartRole>> = {
  base: "shell",
  "post-bl": "shell",
  "post-br": "shell",
  "post-fl": "shell",
  "post-fr": "shell",
  top: "shell",
  "top-b": "shell",
  "top-l": "shell",
  "top-r": "shell",
};

const DOOR_NAMES: Readonly<Record<string, string>> = {
  "rear-door": "top",
  "rear-door-b": "bottom",
  "rear-door-l": "left",
  "rear-door-r": "right",
};

/** Does a step action target this rack or something below it? */
export function isTargeted(spec: PlatformCosmoSpec, rackId: string): boolean {
  for (const step of Array.isArray(spec.steps) ? spec.steps : []) {
    const list: unknown = isObj(step) ? step["assembly"] : undefined;
    for (const a of Array.isArray(list) ? list : []) {
      if (!isObj(a)) continue;
      const t = a["explode"] ?? a["implode"] ?? a["build"] ?? a["unbuild"];
      if (typeof t === "string" && (t === rackId || t.startsWith(`${rackId}/`))) return true;
    }
  }
  return false;
}

/** A rack in a mirrored row has its front toward -y: the post pairs swap sides in the fragment. */
function isMirrored(fragment: DcSceneFragment, rackId: string): boolean {
  const y = new Map<string, number>();
  for (const o of fragment.objects) {
    if (o.id !== rackId && o.id !== `${rackId}_front`) continue;
    for (const p of o.parts ?? []) {
      if (p.id === "post-fl" || p.id === "post-bl") y.set(p.id, p.box.origin.y);
    }
  }
  const fl = y.get("post-fl");
  const bl = y.get("post-bl");
  return fl !== undefined && bl !== undefined && fl < bl - EPS;
}

const err = (
  code: string,
  path: string,
  message: string,
  params?: Record<string, unknown>,
): Diagnostic => ({
  severity: "error",
  code,
  path,
  message,
  ...(params === undefined ? {} : { params }),
});

interface SlotBuild {
  readonly node: SceneAssemblyNode;
  /** Present when the slot has internals. */
  readonly internals?: {
    readonly lid: string;
    readonly exclude: ReadonlySet<string>;
    readonly template: SpecAssembly;
    readonly factor: number;
    readonly ptr: string;
  };
}

/** The default program of a template: its `program`, else its first explode program. */
function defaultTemplateProgram(a: SpecAssembly): { explode?: SpecExplodeProgram; steps: number } {
  const list: readonly unknown[] = Array.isArray(a.programs) ? a.programs : [];
  const progs = list.filter(isObj);
  const named = progs.find((p) => p["id"] === a.program);
  const pick = named ?? progs.find((p) => p["kind"] !== "build");
  if (pick === undefined) return { steps: 0 };
  if (Array.isArray(pick["stages"])) {
    return { explode: pick as unknown as SpecExplodeProgram, steps: pick["stages"].length };
  }
  return { steps: Array.isArray(pick["steps"]) ? pick["steps"].length : 0 };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const fin = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const oneOf = <T extends string>(v: unknown, set: readonly T[]): T | undefined =>
  typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : undefined;
const DIRECTIONS = [
  "away",
  "up",
  "down",
  "+x",
  "-x",
  "+y",
  "-y",
  "+z",
  "-z",
  "out",
  "radial",
  "axis",
  "drawer",
  "lift",
] as const;
const EASINGS = ["linear", "ease", "ease-in", "ease-out", "ease-in-out"] as const;

/** A distance in owner units to millimetres (`k` per unit); `auto` and `<n>x` pass through. */
function distanceOf(d: unknown, k: number): number | string | undefined {
  const n = fin(d);
  if (n !== undefined) return n * k;
  return typeof d === "string" && /^(auto|\d{1,3}(\.\d{1,3})?x)$/.test(d) ? d : undefined;
}

function directionOf(d: unknown): StageIn["direction"] {
  if (Array.isArray(d)) {
    const v = d.slice(0, 3).map(fin);
    return v.length === 3 && v.every((x) => x !== undefined) ? [v[0]!, v[1]!, v[2]!] : undefined;
  }
  return oneOf(d, DIRECTIONS);
}

/**
 * A spec stage as the resolver reads it: unknown shapes, non-finite numbers and values outside
 * the enums are dropped (validation reports them; the scene never trusts them), numeric
 * distances are converted from `k` mm per owner unit.
 */
function stageOf(st: unknown, k: number): StageIn {
  const s = isObj(st) ? st : {};
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const ov: Record<string, NonNullable<StageIn["overrides"]>[string]> = {};
  if (isObj(s["overrides"])) {
    for (const [key, o] of Object.entries(s["overrides"]).slice(0, 200)) {
      if (!isObj(o)) continue;
      const direction = directionOf(o["direction"]);
      const distance = distanceOf(o["distance"], k);
      const delay = fin(o["delay"]);
      const order = fin(o["order"]);
      ov[key] = {
        ...(direction === undefined ? {} : { direction }),
        ...(distance === undefined ? {} : { distance }),
        ...(delay === undefined ? {} : { delay }),
        ...(order === undefined ? {} : { order }),
      };
    }
  }
  const direction = directionOf(s["direction"]);
  const distance = distanceOf(s["distance"], k);
  const order = oneOf(s["order"], [
    "spec",
    "outside-in",
    "inside-out",
    "top-down",
    "bottom-up",
    "front-first",
    "back-first",
  ] as const);
  const stagger = fin(s["stagger"]);
  const delay = fin(s["delay"]);
  const duration = fin(s["duration"]);
  const easing = oneOf(s["easing"], EASINGS);
  const wth = oneOf(s["with"], ["after", "previous"] as const);
  const labels = oneOf(s["labels"], ["show", "hide"] as const);
  const fade = oneOf(s["fade"], ["none", "unselected", "others"] as const);
  const label = typeof s["label"] === "string" ? s["label"].slice(0, 200) : undefined;
  return {
    parts: strings(s["parts"]).slice(0, 64),
    ...(s["except"] === undefined ? {} : { except: strings(s["except"]).slice(0, 64) }),
    ...(label === undefined ? {} : { label }),
    ...(direction === undefined ? {} : { direction }),
    ...(distance === undefined ? {} : { distance }),
    ...(order === undefined ? {} : { order }),
    ...(stagger === undefined ? {} : { stagger }),
    ...(delay === undefined ? {} : { delay }),
    ...(duration === undefined ? {} : { duration }),
    ...(easing === undefined ? {} : { easing }),
    ...(wth === undefined ? {} : { with: wth }),
    ...(labels === undefined ? {} : { labels }),
    ...(typeof s["leaders"] === "boolean" ? { leaders: s["leaders"] } : {}),
    ...(typeof s["details"] === "boolean" ? { details: s["details"] } : {}),
    ...(fade === undefined ? {} : { fade }),
    ...(Object.keys(ov).length === 0 ? {} : { overrides: ov }),
  };
}

export function buildRackAssembly(
  spec: PlatformCosmoSpec,
  rackId: string,
  fragment: DcSceneFragment,
  templates: Readonly<Record<string, SceneAssemblyNode>>,
): { readonly assembly?: SceneAssembly; readonly diagnostics: readonly Diagnostic[] } {
  const none = { diagnostics: [] as Diagnostic[] };
  const racks = spec.racks ?? [];
  const ri = racks.findIndex((r) => isObj(r) && r.id === rackId);
  if (ri < 0 || !isTargeted(spec, rackId)) return none;
  const rack: SpecRack = racks[ri] as SpecRack;
  const rackObj = fragment.objects.find((o) => o.id === rackId && o.type === "rack");
  const rackDef = registry.get("rack");
  if (rackObj === undefined || rackDef === undefined) return none;

  const diagnostics: Diagnostic[] = [];
  const base = `/racks/${ri}`;
  const state: SpecState = rack.state ?? "healthy";
  const params = readRackParams({
    u: rack.u,
    pdu: rack.pdu,
    rearDoorHeatExchanger: rack.rearDoorHeatExchanger,
  });
  const built = rackDef.build(params as unknown as Record<string, unknown>, { id: rackId, state });
  const W = tileToMm(built.bounds.size.x);
  const D = tileToMm(built.bounds.size.y);
  const mirror = isMirrored(fragment, rackId);
  const pl: Placer = { origin: rackObj.box.origin, mirror, w: W, d: D };
  const front: Vec3 = mirror ? { x: 0, y: -1, z: 0 } : { x: 0, y: 1, z: 0 };
  const frontSide = mirror ? "-y" : "+y";

  // ---- frame ----
  let leafCount = 0;
  const frameKids: SceneAssemblyNode[] = [];
  const doorKids: SceneAssemblyNode[] = [];
  for (const p of built.parts) {
    const b = partBox(p, 0, 0, 0);
    const doorId = DOOR_NAMES[p.id];
    const init: NodeInit = {
      role: doorId !== undefined ? "cover" : (FRAME_ROLE[p.id] ?? "body"),
      state,
    };
    const g = boxGeometry(b.size, p);
    leafCount++;
    if (doorId !== undefined)
      doorKids.push(leafNode(`${rackId}/frame/rear-door/${doorId}`, b, g, init));
    else frameKids.push(leafNode(`${rackId}/frame/${p.id}`, b, g, init));
  }
  if (doorKids.length > 0) {
    frameKids.splice(
      1,
      0,
      subNode(`${rackId}/frame/rear-door`, doorKids, { role: "cover", state }),
    );
  }
  const frameNode = subNode(`${rackId}/frame`, frameKids, { role: "shell", state });

  // ---- slots ----
  const rawSlots: readonly unknown[] = Array.isArray(rack.slots) ? rack.slots : [];
  // non-objects keep their index but are skipped by the slot check (unknown type)
  const capped = {
    ...rack,
    slots: rawSlots.slice(0, MAX_SLOTS).map((x) => (isObj(x) ? x : { at: 0, type: "" })),
  } as unknown as SpecRack;
  const sink: Diagnostic[] = [];
  const valid = checkSlots(capped, ri, sink).sort((a, b) => a.index - b.index);
  const slotKids: SceneAssemblyNode[] = [];
  const slots = new Map<string, SlotBuild>();
  let overBudget = false;
  for (const s of valid) {
    const spath = `${base}/slots/${s.index}`;
    if (s.id === "frame") {
      diagnostics.push(
        err(
          "assembly/reserved-id",
          `${spath}/id`,
          'The slot id "frame" is reserved for the rack frame parts in assembly mode.',
          { id: s.id },
        ),
      );
      continue;
    }
    const sdef = registry.get(s.spec.type);
    if (sdef === undefined) continue;
    const sstate: SpecState = s.spec.state ?? state;
    const dev = sdef.build(
      { ...sdef.defaults, heightU: s.size },
      { id: `${rackId}/${s.id}`, state: sstate },
    );
    const dx = (RACK_WIDTH_MM - DEVICE_WIDTH_MM) / 2;
    const dy = RACK_DEPTH_MM - RACK_FRONT_INSET_MM - tileToMm(dev.bounds.size.y);
    const dz = RACK_BASE_MM + (s.at - 1) * U_MM;
    const sp = `${rackId}/${s.id}`;
    const parts = depthSort(dev.parts);
    const sinit: NodeInit = {
      type: s.spec.type,
      ...(s.spec.label === undefined ? {} : { label: s.spec.label }),
      role: "body",
      state: sstate,
    };

    // internals: tray + lid + faceplate + rear, with the template inside
    let internals: SlotBuild["internals"] | undefined;
    let node: SceneAssemblyNode | undefined;
    const tid = typeof s.spec.assembly === "string" ? s.spec.assembly : undefined;
    const chassis = parts.find((p) => p.id === "chassis");
    if (tid !== undefined && chassis !== undefined) {
      const tpl = templates[tid];
      const tspec = (spec.assemblies ?? []).find((a) => a.id === tid);
      if (tpl === undefined || tspec === undefined) {
        diagnostics.push(
          err(
            "assembly/unknown-target",
            `${spath}/assembly`,
            `Slot "${s.id}" names the template "${tid.slice(0, 64)}", which is not available.`,
            { template: tid.slice(0, 64) },
          ),
        );
      } else if (tpl.children.some((c) => (RESERVED as readonly string[]).includes(c.id))) {
        diagnostics.push(
          err(
            "assembly/duplicate-part",
            `${spath}/assembly`,
            `The template "${tid.slice(0, 64)}" has a part named ${RESERVED.map((r) => `"${r}"`).join(", ")}; the pack owns those ids inside a slot with internals.`,
            { template: tid.slice(0, 64) },
          ),
        );
      } else if (leafCount + countLeaves(tpl, MAX_LEAVES) > MAX_LEAVES) {
        overBudget = true;
        break;
      } else {
        const cb = partBox(chassis, dx, dy, dz);
        const trayH = Math.max(cb.size.z - LID_MM, cb.size.z / 2);
        const w = Math.min(WALL_MM, cb.size.x / 4, cb.size.y / 4);
        const trayBox = box(cb.origin.x, cb.origin.y, cb.origin.z, cb.size.x, cb.size.y, trayH);
        const interior = box(
          cb.origin.x + w,
          cb.origin.y + w,
          cb.origin.z + w,
          cb.size.x - 2 * w,
          cb.size.y - 2 * w,
          trayH - w,
        );
        const fit = fitTemplate(tpl, tspec.units, interior, sp, sstate);
        if (fit !== undefined) {
          if (fit.factor < 1 - 1e-9) {
            diagnostics.push({
              severity: "warning",
              code: "assembly/size-mismatch",
              path: `${spath}/assembly`,
              message: `The template "${tid.slice(0, 64)}" does not fit the ${s.spec.type} interior at true scale; scaled down to ${Math.round(fit.factor * 1000) / 10}%.`,
              params: { template: tid.slice(0, 64), factor: r6(fit.factor) },
            });
          }
          const tint: NodeInit = { role: "shell", state: sstate };
          const tray = leafNode(`${sp}/tray`, trayBox, trayGeometry(trayBox.size, chassis), tint);
          const lidBox = box(
            cb.origin.x,
            cb.origin.y,
            cb.origin.z + trayH,
            cb.size.x,
            cb.size.y,
            cb.size.z - trayH,
          );
          const lid = leafNode(
            `${sp}/lid`,
            lidBox,
            boxGeometry(lidBox.size, { ...chassis, primitive: "slab" }),
            { role: "cover", label: "Lid", state: sstate, mates: tray.path },
          );
          const face: SceneAssemblyNode[] = [];
          const rear: SceneAssemblyNode[] = [];
          for (const p of parts) {
            if (p.id === "chassis") continue;
            const isRear = p.id.startsWith("rear");
            const b = partBox(p, dx, dy, dz);
            (isRear ? rear : face).push(
              leafNode(
                `${sp}/${isRear ? "rear" : "faceplate"}/${p.id}`,
                b,
                boxGeometry(b.size, p),
                { role: "body", state: sstate },
              ),
            );
          }
          const kids: SceneAssemblyNode[] = [
            ...(rear.length === 0
              ? []
              : [subNode(`${sp}/rear`, rear, { role: "body", state: sstate })]),
            tray,
            ...fit.nodes,
            lid,
            ...(face.length === 0
              ? []
              : [subNode(`${sp}/faceplate`, face, { role: "body", state: sstate })]),
          ];
          node = subNode(sp, kids, sinit);
          leafCount += leavesOf(node).length;
          internals = {
            lid: lid.path,
            exclude: new Set(RESERVED.map((r) => `${sp}/${r}`)),
            template: tspec,
            factor: fit.factor,
            ptr: spath,
          };
        }
      }
    }
    if (node === undefined) {
      const kids: SceneAssemblyNode[] = [];
      for (const p of parts) {
        const b = partBox(p, dx, dy, dz);
        kids.push(
          leafNode(`${sp}/${p.id}`, b, boxGeometry(b.size, p), {
            role: p.id === "chassis" ? "shell" : "body",
            state: sstate,
          }),
        );
      }
      if (leafCount + kids.length > MAX_LEAVES) {
        overBudget = true;
        break;
      }
      leafCount += kids.length;
      node = subNode(sp, kids, sinit);
    }
    slotKids.push(node);
    slots.set(sp, { node, ...(internals === undefined ? {} : { internals }) });
  }
  if (overBudget || leafCount > MAX_LEAVES) {
    diagnostics.push(
      err(
        "budget/assembly-parts",
        base,
        `Rack "${rackId}" in assembly mode would have more than ${MAX_LEAVES} leaf parts.`,
        { limit: MAX_LEAVES },
      ),
    );
    return { diagnostics };
  }

  // ---- tree (unturned), programs, then the final pose ----
  const rootInit: NodeInit = {
    ...(rack.label === undefined ? {} : { label: rack.label }),
    role: "body",
    state,
  };
  const draft = subNode(rackId, [frameNode, ...slotKids], rootInit);
  const root = place(draft, pl);
  const resolved = resolvePrograms(rack, base, root, slots, front, diagnostics);
  if (resolved === undefined) return { diagnostics };

  const leaves = leavesOf(root);
  const rest = unionOf(
    (function collect(n: SceneAssemblyNode, out: Box3[]): Box3[] {
      if (n.kind === "leaf") out.push(boundsWorld(n, pl));
      else for (const c of n.children) collect(c, out);
      return out;
    })(root, []),
  );
  const restBounds = rest ?? root.world;
  const reach = unionOf([restBounds, ...resolved.reach.map((b) => worldBox(b, pl))]) ?? restBounds;
  const frame: AssemblyFrame = {
    units: "mm",
    scale: { x: 1 / MM, y: 1 / MM, z: 1 / MM },
    origin: rackObj.box.origin,
    rotate: 0,
    front: frontSide,
  };
  const programs = [...resolved.programs].sort((a, b) => cmp(a.owner, b.owner) || cmp(a.id, b.id));
  const first = programs.find((p) => p.owner === rackId);
  return {
    assembly: {
      id: rackId,
      source: "dc",
      ...(rack.label === undefined ? {} : { label: rack.label }),
      frame,
      root,
      leaves,
      programs,
      ...(first === undefined ? {} : { defaultProgram: first.id }),
      basePose: [],
      restBounds,
      reachBounds: reach,
    },
    diagnostics,
  };
}

/** World box of everything a leaf draws (its geometry bounds). */
function boundsWorld(n: SceneAssemblyNode, pl: Placer): Box3 {
  const g = n.geometry;
  if (g === undefined) return n.world;
  return worldBox(
    box(
      n.local.origin.x + g.bounds.origin.x,
      n.local.origin.y + g.bounds.origin.y,
      n.local.origin.z + g.bounds.origin.z,
      g.bounds.size.x,
      g.bounds.size.y,
      g.bounds.size.z,
    ),
    pl,
  );
}

// ---------------------------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------------------------

interface Resolved {
  readonly programs: ResolvedProgram[];
  /** Local boxes (mm, final pose) of every leaf at every program's end pose. */
  readonly reach: Box3[];
}

function resolvePrograms(
  rack: SpecRack,
  base: string,
  turned: SceneAssemblyNode,
  slots: ReadonlyMap<string, SlotBuild>,
  front: Vec3,
  diagnostics: Diagnostic[],
): Resolved | undefined {
  const owner = toPNode(turned);
  const programs: ResolvedProgram[] = [];
  const reach: Box3[] = [];
  const nodeBox = new Map<string, Box3>();
  const parentOf = new Map<string, string>();
  (function index(n: SceneAssemblyNode): void {
    nodeBox.set(n.path, n.local);
    for (const c of n.children) {
      parentOf.set(c.path, n.path);
      index(c);
    }
  })(turned);

  const ancestorsOf = (path: string): string[] => {
    const out: string[] = [];
    for (let p: string | undefined = path; p !== undefined; p = parentOf.get(p)) out.push(p);
    return out;
  };
  const add = (b: Box3, v: Vec3): Box3 =>
    box(b.origin.x + v.x, b.origin.y + v.y, b.origin.z + v.z, b.size.x, b.size.y, b.size.z);
  const sum = (a: Vec3, b: Vec3 | undefined): Vec3 =>
    b === undefined ? a : { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };

  // below the floor (z < 0 in rack-local mm): every moved node at the end of its program
  let below = false;
  const checkFloor = (res: ResolveResult, ptr: string, lift: ReadonlyMap<string, Vec3>): void => {
    for (const [path, v] of res.shifts) {
      const b = nodeBox.get(path);
      if (b === undefined) continue;
      let total = v;
      for (const a of ancestorsOf(path).slice(1)) total = sum(total, res.shifts.get(a));
      for (const a of ancestorsOf(path)) total = sum(total, lift.get(a));
      const z = b.origin.z + total.z;
      if (z < -EPS) {
        below = true;
        diagnostics.push(
          err(
            "assembly/below-ground",
            ptr,
            `"${path}" would move below the floor (${Math.round(z * 10) / 10} mm).`,
            { part: path, z: r6(z) },
          ),
        );
      }
    }
  };
  const leafReach = (res: ReadonlyMap<string, Vec3>, within: SceneAssemblyNode): void => {
    (function walk(n: SceneAssemblyNode): void {
      if (n.kind === "leaf") {
        let v: Vec3 = { x: 0, y: 0, z: 0 };
        for (const a of ancestorsOf(n.path)) v = sum(v, res.get(a));
        const g = n.geometry;
        reach.push(
          add(
            g === undefined
              ? n.local
              : box(
                  n.local.origin.x + g.bounds.origin.x,
                  n.local.origin.y + g.bounds.origin.y,
                  n.local.origin.z + g.bounds.origin.z,
                  g.bounds.size.x,
                  g.bounds.size.y,
                  g.bounds.size.z,
                ),
            v,
          ),
        );
      } else for (const c of n.children) walk(c);
    })(within);
  };

  // ---- rack programs ----
  const rear: Vec3 = { x: -front.x, y: -front.y, z: 0 };
  const custom = (Array.isArray(rack.programs) ? (rack.programs as readonly unknown[]) : [])
    .filter(isObj)
    .filter((p) => Array.isArray(p["stages"]) && typeof p["id"] === "string")
    .slice(0, 8) as unknown as SpecExplodeProgram[];
  const rackIns: ProgramIn[] =
    custom.length > 0
      ? custom.map((p, i) => ({
          id: p.id,
          ...(typeof p.label === "string" ? { label: p.label.slice(0, 200) } : {}),
          ...(fin(p.gap) === undefined ? {} : { gap: fin(p.gap) as number }),
          stages: p.stages.slice(0, 32).map((st) => stageOf(st, 1)),
          ptr: `${base}/programs/${i}`,
        }))
      : [
          {
            id: "drawers",
            label: "Drawers",
            ptr: base,
            stages: [
              {
                label: "Doors",
                parts: ["frame/role:cover"],
                direction: [rear.x, rear.y, rear.z],
                labels: "hide",
                leaveOwner: true,
              },
              {
                label: "Drawers",
                parts: ["type:*"],
                direction: "drawer",
                order: "top-down",
                stagger: 0.1,
              },
            ],
          },
        ];
  const rackRes = rackIns.map((p) => resolveProgram(p, { owner, exclude: new Set(), front }));
  rackRes.forEach((r, i) => {
    // the built-in program has no doors on a rack without a rear-door heat exchanger
    diagnostics.push(
      ...r.diagnostics.filter((d) => custom.length > 0 || d.code !== "assembly/selector-empty"),
    );
    programs.push(r.program);
    checkFloor(r, (rackIns[i] as ProgramIn).ptr, new Map());
    leafReach(r.shifts, turned);
  });
  // the default program's shifts: a slot's own program plays on top of its drawer
  const drawerShifts = rackRes[0]?.shifts ?? new Map<string, Vec3>();

  // ---- slot internals ----
  const turnedByPath = new Map<string, SceneAssemblyNode>();
  (function walk(n: SceneAssemblyNode): void {
    turnedByPath.set(n.path, n);
    for (const c of n.children) walk(c);
  })(turned);
  for (const [path, s] of slots) {
    const ix = s.internals;
    if (ix === undefined) continue;
    const slot = turnedByPath.get(path);
    if (slot === undefined) continue;
    const pnode = toPNode(slot);
    const k = unitMm(ix.template.units ?? "mm").x * ix.factor;
    const def = defaultTemplateProgram(ix.template);
    const exclude = ix.exclude;
    const env = { owner: pnode, exclude, front };
    const stagesFor = (): ResolveResult | undefined =>
      def.explode === undefined
        ? undefined
        : resolveProgram(
            {
              id: "internals",
              ptr: `${ix.ptr}/assembly`,
              ...(fin(def.explode.gap) === undefined
                ? {}
                : { gap: (fin(def.explode.gap) as number) * k }),
              stages: def.explode.stages.slice(0, 32).map((st) => stageOf(st, k)),
            },
            env,
          );
    const tplRes = stagesFor();
    if (tplRes !== undefined) diagnostics.push(...tplRes.diagnostics);
    // lid: up, clearing the tallest pose of the internals
    const lidNode = turnedByPath.get(ix.lid);
    const lidStage = (distance: number | string): StageIn => ({
      label: "Lid",
      parts: ["lid"],
      direction: "up",
      distance,
    });
    const lidAuto = resolveProgram(
      { id: "internals", ptr: "", stages: [lidStage("auto")] },
      { owner: pnode, exclude: new Set([...exclude].filter((p) => !p.endsWith("/lid"))), front },
    );
    let need = lidAuto.shifts.get(ix.lid)?.z ?? 0;
    if (tplRes !== undefined && lidNode !== undefined) {
      const gap =
        (fin(def.explode?.gap) ?? 0) * k ||
        Math.max(...[slot.local.size.x, slot.local.size.y, slot.local.size.z]) * 0.1;
      for (const [p, v] of tplRes.shifts) {
        const b = nodeBox.get(p);
        if (b === undefined) continue;
        need = Math.max(need, b.origin.z + b.size.z + v.z - lidNode.local.origin.z + gap);
      }
    }
    const lidRes = resolveProgram(
      { id: "internals", ptr: "", stages: [lidStage(need)] },
      { owner: pnode, exclude: new Set([...exclude].filter((p) => !p.endsWith("/lid"))), front },
    );
    const lidStageOut = lidRes.program.stages[0] as ResolvedStage;
    const shift = lidStageOut.end;
    const tplStages: ResolvedStage[] =
      tplRes !== undefined
        ? tplRes.program.stages.map((st) => ({
            ...st,
            index: st.index + 1,
            start: rnd(st.start + shift),
            end: rnd(st.end + shift),
            moves: st.moves.map((m) => ({ ...m, start: rnd(m.start + shift) })),
          }))
        : Array.from({ length: def.steps }, (_, i) => ({
            // a build program as default: stages exist (1 + steps) but carry no moves here
            index: i + 2,
            moves: [],
            start: shift,
            end: shift,
            labels: "show" as const,
            leaders: true,
            details: false,
            fade: "none" as const,
          }));
    const prog: ResolvedExplodeProgram = {
      kind: "explode",
      id: "internals",
      owner: path,
      stages: [lidStageOut, ...tplStages],
    };
    programs.push(prog);
    const shifts = new Map<string, Vec3>(lidRes.shifts);
    for (const [p, v] of tplRes?.shifts ?? []) shifts.set(p, v);
    checkFloor({ program: prog, shifts, diagnostics: [] }, `${ix.ptr}/assembly`, drawerShifts);
    // the slot sits where its drawer left it
    const lift = new Map<string, Vec3>();
    for (const a of ancestorsOf(path)) {
      const v = drawerShifts.get(a);
      if (v !== undefined) lift.set(a, v);
    }
    const merged = new Map<string, Vec3>([...lift, ...shifts]);
    for (const [p, v] of lift) merged.set(p, sum(v, shifts.get(p)));
    leafReach(merged, slot);
  }
  if (below) return undefined;
  return { programs, reach };
}
