/**
 * `pcosmo validate --suggest`: proposes an explode program and a story for assemblies that have
 * none, following docs/design/assemblies.md section 17 (the skill prints the same). Pure and
 * deterministic: the proposal depends only on the spec and the installed shape registry, never on
 * time, randomness or the environment. Geometry (body pick, covers, enclosure, mounting) uses the
 * effective boxes the resolved assembly tree gives (`PlacedBoxes`, from core), falling back to the
 * `at`/`size` the spec states; a part with neither takes no part in geometric rules, and the
 * rules fall back to roles, types, `axis` and `mates`.
 */
import type { PartShapeRegistry } from "@platformcosmo/core";

export type PartClass = "body" | "fastener" | "cover" | "unit" | "internal" | "mounted" | "loose";

/** A box in the owner's local units (the scene tree's `local`, or what the spec states). */
export interface PlacedBox {
  min: [number, number, number];
  max: [number, number, number];
}
/** Effective boxes the scene tree resolves, keyed by node path (`assembly/part`, `.../part-2`). */
export type PlacedBoxes = ReadonlyMap<string, PlacedBox>;

export interface SuggestedStage {
  label: string;
  parts: string[];
  direction: string;
  /** `auto` (section 6.3), or a number in owner units for lift-offs from a body's top face. */
  distance: "auto" | number;
  order: "outside-in";
  stagger: number;
  duration: number;
  labels: "show" | "hide";
  fade?: "unselected";
}

export interface SuggestedStep {
  caption: string;
  duration: number;
  focus?: string;
  assembly?: ({ explode: string; program: string; to: number } | { implode: string })[];
}

export interface Suggestion {
  /** Path of the program owner: the assembly id, or `assembly/sub/...` for a nested explode. */
  owner: string;
  /** JSON pointer of the owner in the spec: `programs` goes to `<pointer>/programs`. */
  pointer: string;
  body: string | null;
  classes: Record<Exclude<PartClass, "body">, string[]>;
  program: { id: string; label: string; stages: SuggestedStage[] };
  /** Seconds a step playing the whole program needs (stage times plus a hold). */
  stepDuration: number;
  /** Leaf parts moved by each stage (for step durations). */
  stageLeaves: number[];
  /** Present for top-level assemblies; nested owners are covered by it. */
  steps?: SuggestedStep[];
  explanation: string[];
}

export interface SuggestReport {
  suggestions: Suggestion[];
  /** Assemblies skipped, with the reason (already has a program, template, nothing to move). */
  skipped: { owner: string; reason: string }[];
}

interface P {
  id?: string;
  label?: string;
  type?: string;
  role?: string;
  shape?: string;
  axis?: string;
  at?: unknown;
  size?: unknown;
  count?: number;
  mates?: unknown;
  inserts?: unknown;
  parts?: P[];
  use?: unknown;
  programs?: unknown[];
}
interface A extends P {
  template?: boolean;
  program?: unknown;
  parts: P[];
}

/** Stages hold at most this many parts (assemblies.md section 17.3). */
export const STAGE_MAX = 24;
const LABELS_MAX = 12;
const STAGGER = 0.08;
const DURATION = 0.8;
const MAX_OWNERS = 64;
const MAX_DEPTH = 3;
const TOL = 1e-6;
const PROGRAM_ID = "suggested";

const FASTENER = /^(screw|bolt|clip|pin|nut|washer|rivet|fastener)s?$/;
// a bare `cap` is a capacitor; only a compound (`dust-cap`) is a cover
const COVER = /(^|-)(lid|panel|cover|pan|door)$|-cap$/;
const RACK_DEVICE = /^(server|storage|switch|psu|router|firewall|chassis)/;

type Box = PlacedBox;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const vec = (v: unknown): [number, number, number] | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(isNum)
    ? [v[0] as number, v[1] as number, v[2] as number]
    : undefined;

interface Item {
  p: P;
  id: string;
  isGroup: boolean;
  count: number;
  /** All instances of a counted part (their union), else the part's own box. */
  box?: Box;
  /** The first instance (`id-1`) of a counted part: what one part looks like (volume, thinness). */
  inst?: Box;
  cls: PartClass;
  /** Mounting level within its stage class: 0 sits on the body or a seat, n on a part of level n-1. */
  level: number;
}

const isGroup = (p: P): boolean => p.parts !== undefined || p.use !== undefined;
const countOf = (p: P): number => (isNum(p.count) && p.count >= 1 ? Math.floor(p.count) : 1);

function boxOf(p: P): Box | undefined {
  const at = vec(p.at);
  const size = vec(p.size);
  if (!at || !size || isGroup(p)) return undefined;
  return { min: at, max: [at[0] + size[0], at[1] + size[1], at[2] + size[2]] };
}

/**
 * The placement the scene tree resolved, else the stated one: `box` is the union of a counted
 * part's instances, `inst` its first instance.
 */
function placedBox(
  p: P,
  id: string,
  path: string,
  placed: PlacedBoxes | undefined,
): { box?: Box; inst?: Box } {
  const stated = boxOf(p);
  if (!placed) return stated ? { box: stated, inst: stated } : {};
  const n = countOf(p);
  const names =
    n > 1 ? Array.from({ length: Math.min(n, 1024) }, (_, k) => `${id}-${k + 1}`) : [id];
  let u: Box | undefined;
  let first: Box | undefined;
  for (const name of names) {
    const b = placed.get(`${path}/${name}`);
    if (!b) continue;
    first ??= { min: [...b.min], max: [...b.max] };
    const a = u;
    u = a
      ? {
          min: [0, 1, 2].map((k) => Math.min(a.min[k]!, b.min[k]!)) as Box["min"],
          max: [0, 1, 2].map((k) => Math.max(a.max[k]!, b.max[k]!)) as Box["max"],
        }
      : { min: [...b.min], max: [...b.max] };
  }
  if (u && first) return { box: u, inst: first };
  return stated ? { box: stated, inst: stated } : {};
}

/** Area of the overlap of two boxes in the horizontal plane. */
function overlapXY(a: Box, b: Box): number {
  const w = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const d = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  return w > TOL && d > TOL ? w * d : 0;
}

/** Sits on the body's top face: at or above it, over its footprint. */
const onTop = (b: Box, body: Box): boolean =>
  b.min[2] >= body.max[2] - TOL && overlapXY(b, body) > 0;

const interpenetrate = (a: Box, b: Box): boolean =>
  [0, 1, 2].every((k) => a.min[k]! < b.max[k]! - TOL && b.min[k]! < a.max[k]! - TOL);

/** The parts of the group that interpenetrate another part of it at rest (a crank through rods). */
function linked(g: Item[]): Item[] {
  return g.filter((a) =>
    g.some(
      (b) => b !== a && a.box !== undefined && b.box !== undefined && interpenetrate(a.box, b.box),
    ),
  );
}

/**
 * One distance that takes the whole group out of its seat (the top of the body, and of every
 * shell over a member, above the lowest part) plus the default gap (10% of the owner's largest
 * extent), so it moves as one. With neither body nor shell there is nothing to clear: the gap.
 */
function rigidLift(g: Item[], body: Item | undefined, shells: Item[], all: Item[]): number {
  const boxes = all.flatMap((it) => (it.box ? [it.box] : []));
  const ext = Math.max(
    0,
    ...[0, 1, 2].map(
      (k) => Math.max(...boxes.map((b) => b.max[k]!)) - Math.min(...boxes.map((b) => b.min[k]!)),
    ),
  );
  const mine = g.flatMap((it) => (it.box ? [it.box] : []));
  const low = Math.min(...mine.map((b) => b.min[2]));
  const tops = [body, ...shells].flatMap((o) =>
    o?.box && mine.some((b) => overlapXY(b, o.box!) > 0) ? [o.box.max[2]] : [],
  );
  const out = Math.max(0, ...tops.map((t) => t - low));
  return Math.round((out + 0.1 * ext) * 100) / 100;
}

/**
 * Mounting level of each item of `group`: 0 when nothing in the group carries it, else one more
 * than its carrier (the item with the highest top at or below its bottom, under its footprint).
 */
function levels(group: Item[]): void {
  const memo = new Map<Item, number>();
  const level = (it: Item, seen: Set<Item>): number => {
    const known = memo.get(it);
    if (known !== undefined) return known;
    let carrier: Item | undefined;
    if (it.box && !seen.has(it)) {
      for (const q of group) {
        if (q === it || !carries(q, it)) continue;
        if (!carrier || q.box!.max[2] > carrier.box!.max[2] + TOL) carrier = q;
      }
    }
    const v = carrier ? 1 + level(carrier, new Set(seen).add(it)) : 0;
    if (!memo.has(it)) memo.set(it, v);
    return memo.get(it)!;
  };
  for (const it of group) it.level = level(it, new Set());
}

const volume = (b: Box | undefined): number =>
  b === undefined ? 0 : (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);

function inside(inner: Box, outer: Box): boolean {
  for (let k = 0; k < 3; k++) {
    if (inner.min[k]! < outer.min[k]! - TOL || inner.max[k]! > outer.max[k]! + TOL) return false;
  }
  return true;
}

/** Thin: the smallest extent is at most 20% of the largest. */
function thin(b: Box): boolean {
  const e = [0, 1, 2].map((k) => b.max[k]! - b.min[k]!);
  return Math.min(...e) <= 0.2 * Math.max(...e);
}

const AXES = ["z", "x", "y"] as const;
const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

/** Direction away from the body: visible sides first (+z, +x, +y), then hidden ones. */
function sideOf(b: Box, body: Box): string | undefined {
  for (const sign of ["+", "-"] as const) {
    for (const a of AXES) {
      const k = AXIS_INDEX[a];
      if (sign === "+" && b.min[k]! >= body.max[k]! - TOL) return `+${a}`;
      if (sign === "-" && b.max[k]! <= body.min[k]! + TOL) return `-${a}`;
    }
  }
  return undefined;
}

/**
 * A cover (`b` is one part, not a row of them) is thin, lies flat against the body (its thin axis
 * is the side's axis and it touches that face) and spans at least half of the body's face: a flat
 * part on a board (a DIMM, a chip) is thin too, but covers nothing.
 */
function coversBody(b: Box, body: Box): boolean {
  const side = sideOf(b, body);
  if (side === undefined) return false;
  const k = AXIS_INDEX[side[1] as "x" | "y" | "z"];
  const ext = [0, 1, 2].map((a) => b.max[a]! - b.min[a]!);
  if (ext[k]! > Math.min(...ext) + TOL) return false;
  const gap = side[0] === "+" ? b.min[k]! - body.max[k]! : body.min[k]! - b.max[k]!;
  if (Math.abs(gap) > TOL) return false;
  const [i, j] = [0, 1, 2].filter((a) => a !== k) as [number, number];
  const w = Math.min(b.max[i]!, body.max[i]!) - Math.max(b.min[i]!, body.min[i]!);
  const d = Math.min(b.max[j]!, body.max[j]!) - Math.max(b.min[j]!, body.min[j]!);
  const face = (body.max[i]! - body.min[i]!) * (body.max[j]! - body.min[j]!);
  return w > 0 && d > 0 && w * d >= 0.5 * face - TOL;
}

function classify(it: Item, reg: PartShapeRegistry | undefined, ctx: Ctx): PartClass {
  const p = it.p;
  if (it.isGroup) return "unit";
  const def = p.shape !== undefined && p.shape.includes(":") ? reg?.get(p.shape) : undefined;
  // A pack's default role `body` (every brick, many auto parts) does not make a part THE body:
  // only an explicit spec role does, and only the one part chosen as the body is classified so.
  const role = p.role ?? (def?.role === "body" ? undefined : def?.role);
  if (role === "body") return "loose";
  if (role === "cover") return "cover";
  if (role === "fastener") return "fastener";
  if (role === "internal") return "internal";
  if (role === "shell") return "unit";
  if (role === "cable") return "loose";
  const words = [p.type, def?.type, p.shape?.split(":").pop()].filter(
    (w): w is string => typeof w === "string",
  );
  if (words.some((w) => FASTENER.test(w))) return "fastener";
  if (words.some((w) => COVER.test(w))) return "cover";
  if (it.inst && ctx.body?.box && thin(it.inst) && coversBody(it.inst, ctx.body.box))
    return "cover";
  if (it.box && ctx.shells.some((s) => s !== it && s.box && inside(it.box!, s.box!)))
    return "internal";
  if (it.box && ctx.body?.box && onTop(it.box, ctx.body.box)) return "mounted";
  // seated on another part inside the body (a card on a board in a case): it leaves with the
  // internals, before its carrier
  if (
    it.box &&
    ctx.body?.box &&
    inside(it.box, ctx.body.box) &&
    ctx.items.some((q) => q !== it && q !== ctx.body && carries(q, it))
  )
    return "internal";
  return "loose";
}

interface Ctx {
  body?: Item;
  shells: Item[];
  items: Item[];
}

/**
 * `q` holds `it` on its top face: `it` starts at `q`'s top over its footprint, give or take 1% of
 * the carrier's height (a part sunk into a recess, or a small gap).
 */
const carries = (q: Item, it: Item): boolean =>
  q.box !== undefined &&
  it.box !== undefined &&
  !q.isGroup &&
  q.box.max[2] > q.box.min[2] + TOL &&
  Math.abs(it.box.min[2] - q.box.max[2]) <= Math.max(TOL, 0.01 * (q.box.max[2] - q.box.min[2])) &&
  overlapXY(it.box, q.box) > 0;

const sel = (it: Item): string => (it.count > 1 ? `${it.id}-*` : it.id);

/**
 * The open face an enclosed part leaves through: the first face of the body (`+z`, `+x`, `+y`,
 * then the hidden ones) its box is flush with. Undefined when it is not inside the body or touches
 * no face, where `away` finds the shortest exit.
 */
function exitFace(it: Item, body: Item | undefined): string | undefined {
  const bb = body?.box;
  if (!bb || !it.box || !inside(it.box, bb)) return undefined;
  for (const sign of ["+", "-"] as const)
    for (const a of AXES) {
      const k = AXIS_INDEX[a];
      if (sign === "+" ? it.box.max[k]! >= bb.max[k]! - TOL : it.box.min[k]! <= bb.min[k]! + TOL)
        return `${sign}${a}`;
    }
  return undefined;
}

function direction(it: Item, cls: PartClass, body: Item | undefined, internals: Item[]): string {
  const p = it.p;
  switch (cls) {
    case "fastener":
      return p.axis === "x" || p.axis === "y" ? `+${p.axis}` : "+z";
    case "cover":
      return (it.inst && body?.box ? sideOf(it.inst, body.box) : undefined) ?? "away";
    case "unit":
      if (
        (p.shape?.startsWith("dc:") ?? false) ||
        RACK_DEVICE.test(p.type ?? "") ||
        (it.isGroup && RACK_DEVICE.test(it.id))
      )
        return "drawer";
      return (
        exitFace(it, body) ?? (p.mates !== undefined || p.inserts !== undefined ? "away" : "out")
      );
    case "internal":
      return internals.length >= 2 ? "lift" : (exitFace(it, body) ?? "away");
    case "mounted":
      return "+z";
    default:
      return "out";
  }
}

const hidden = (d: string): boolean => d.startsWith("-");

/** The program's default gap: 10% of the owner's largest extent (assemblies.md 6.3). */
function ownerGap(items: Item[]): number {
  const boxes = items.flatMap((it) => (it.box ? [it.box] : []));
  if (boxes.length === 0) return 0;
  const ext = Math.max(
    ...[0, 1, 2].map(
      (k) => Math.max(...boxes.map((b) => b.max[k]!)) - Math.min(...boxes.map((b) => b.min[k]!)),
    ),
  );
  return 0.1 * ext;
}

/**
 * Top covers that move aside. A cover lying on the body's top face whose thin axis is z, one cover
 * (not a row, not a group) that carries no other cover, with parts under it that leave in later
 * stages, would end above the exploded stack and hide it in the isometric view: it slides off
 * along a visible horizontal axis of the owner (`+x` or `+y`, the shorter side first, `+x` on a
 * tie), at its own height, by `auto` = its extent plus the gap (assemblies.md 6.3). An axis is
 * taken only when the path is free (no other part rises above the cover's underside between its
 * rest and end positions) and the end position lies beyond the body and over none of the parts
 * that leave later, so nothing then passes through it; else the longer side, else it keeps `+z`.
 * Maps the cover to its direction.
 */
function asideCovers(covers: Item[], later: Item[], items: Item[], body: Item | undefined) {
  const out = new Map<Item, string>();
  const bb = body?.box;
  if (!bb) return out;
  const gap = ownerGap(items);
  for (const c of covers) {
    const b = c.inst;
    const cb = c.box;
    if (!b || !cb || c.isGroup || c.count > 1) continue;
    const e3 = [0, 1, 2].map((k) => b.max[k]! - b.min[k]!);
    if (e3[2]! > 0.2 * Math.max(...e3)) continue; // z is the thin axis
    if (Math.abs(b.min[2] - bb.max[2]) > TOL) continue; // lies on the body's top face
    if (covers.some((q) => q !== c && carries(c, q))) continue;
    const under = later.some(
      (q) => q.box && q.box.max[2] <= cb.min[2] + TOL && overlapXY(q.box, cb) > 0,
    );
    if (!under) continue;
    const ext = [0, 1].map((k) => cb.max[k]! - cb.min[k]!);
    const axes = (ext[1]! < ext[0]! - TOL ? [1, 0] : [0, 1]) as number[];
    for (const k of axes) {
      const o = 1 - k;
      const d = ext[k]! + gap;
      const apart = (q: Box, lo: number, hi: number): boolean =>
        q.max[o]! <= cb.min[o]! + TOL ||
        q.min[o]! >= cb.max[o]! - TOL ||
        q.max[k]! <= lo + TOL ||
        q.min[k]! >= hi - TOL;
      const free = items.every(
        (q) =>
          q === c ||
          !q.box ||
          q.box.max[2] <= cb.min[2] + TOL ||
          apart(q.box, cb.min[k]!, cb.max[k]! + d),
      );
      const clear =
        cb.min[k]! + d >= bb.max[k]! - TOL &&
        later.every((q) => !q.box || apart(q.box, cb.min[k]! + d, cb.max[k]! + d));
      if (free && clear) {
        out.set(c, k === 0 ? "+x" : "+y");
        break;
      }
    }
  }
  return out;
}

/**
 * Smallest step duration (to 0.1 s) whose motion window holds `need` seconds even when a camera
 * transition leads into and out of the step: the validator's window is
 * `D - 2 * min(0.8, 0.25 * D) - 0.2` (core `fitDuration`), so a suggested step never compresses.
 */
export function fitStep(need: number): number {
  for (let t = Math.max(1, Math.ceil(need * 10)); t < 6000; t++) {
    const d = t / 10;
    if (d - 2 * Math.min(0.8, 0.25 * d) - 0.2 >= need - 1e-9) return d;
  }
  return 600;
}

function stageTime(s: SuggestedStage, n: number): number {
  return s.duration + s.stagger * Math.max(0, n - 1);
}

function suggestOwner(
  path: string,
  label: string,
  parts: P[],
  reg: PartShapeRegistry | undefined,
  placed: PlacedBoxes | undefined,
): Suggestion | string {
  const items: Item[] = parts.map((p, i) => {
    const id = p.id ?? `part-${i + 1}`;
    const b = placedBox(p, id, path, placed);
    return {
      p,
      id,
      isGroup: isGroup(p),
      count: countOf(p),
      ...(b.box ? { box: b.box } : {}),
      ...(b.inst ? { inst: b.inst } : {}),
      cls: "loose" as PartClass,
      level: 0,
    };
  });
  if (items.length < 2) return "nothing to move (fewer than two parts)";

  // 1. Body: role body, else the part most others mate with, else the largest volume.
  let body = items.find((it) => it.cls === "loose" && (it.p.role ?? "") === "body");
  const why: string[] = [];
  if (body) why.push(`body: ${body.id} (role body)`);
  if (!body) {
    const mated = new Map<string, number>();
    const counted = new Set(items.filter((it) => it.count > 1).map((it) => it.id));
    for (const it of items) {
      const m = it.p.mates;
      if (typeof m === "string") {
        // `cpu-1` names one instance of the counted part `cpu`.
        const inst = /^(.+)-\d+$/.exec(m);
        const head = inst && counted.has(inst[1]!) ? inst[1]! : m;
        mated.set(head, (mated.get(head) ?? 0) + 1);
      }
    }
    let best = 0;
    for (const it of items) {
      const n = mated.get(it.id) ?? 0;
      if (n > best) {
        best = n;
        body = it;
      }
    }
    if (body) why.push(`body: ${body.id} (${best} part${best === 1 ? "" : "s"} mate with it)`);
  }
  if (!body) {
    let best = 0;
    for (const it of items) {
      const v = volume(it.inst);
      if (v > best) {
        best = v;
        body = it;
      }
    }
    if (body) why.push(`body: ${body.id} (largest volume)`);
  }
  if (!body) why.push("body: none found (no role, mates or sizes); every part may move");

  // 2. Classify the rest.
  const roleOf = (p: P): string | undefined => {
    const def = p.shape !== undefined && p.shape.includes(":") ? reg?.get(p.shape) : undefined;
    return p.role ?? def?.role;
  };
  const ctx: Ctx = {
    shells: items.filter((it) => roleOf(it.p) === "shell" || it.p.shape === "tray"),
    items,
  };
  if (body) ctx.body = body;
  for (const it of items) it.cls = it === body ? "body" : classify(it, reg, ctx);
  // A part leaves before its carrier, so it cannot be left in a later class than the one that
  // carries it (a component on a lid, a part on a component that overhangs the body): it joins
  // the carrier's class, where mounting levels order the two.
  const RANK: PartClass[] = ["fastener", "cover", "unit", "internal", "mounted", "loose"];
  const FOLD = new Set<PartClass>(["cover", "internal", "mounted"]);
  const folded = new Map<Item, string>();
  for (let pass = 0; pass < items.length; pass++) {
    let changed = false;
    for (const it of items) {
      if (it === body || it.isGroup || it.cls === "body") continue;
      for (const q of items) {
        if (q === it || q === body || !FOLD.has(q.cls) || !carries(q, it)) continue;
        // a cover on a hidden side leaves last, after everything it carries
        if (q.cls === "cover" && hidden(direction(q, "cover", body, []))) continue;
        if (RANK.indexOf(q.cls) < RANK.indexOf(it.cls)) {
          it.cls = q.cls;
          folded.set(
            it,
            `${it.id} joins ${q.cls === "mounted" ? "components" : `${q.cls}s`} (carried by ${q.id})`,
          );
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const of = (c: PartClass): Item[] => items.filter((it) => it.cls === c);
  const classes = {
    fastener: of("fastener"),
    cover: of("cover"),
    unit: of("unit"),
    internal: of("internal"),
    mounted: of("mounted"),
    loose: of("loose"),
  };
  // a carrier in an earlier class took its carried parts in above, so levels are per class
  for (const g of Object.values(classes)) levels(g.filter((it) => !it.isGroup));

  // 3-4. One stage per class, direction and mounting level (a class larger than STAGE_MAX is
  // split in order); covers on a hidden side go last, with the others faded.
  const stages: SuggestedStage[] = [];
  const counts: number[] = [];
  let rigid = false;
  const push = (
    name: string,
    group: Item[],
    dir: string,
    distance: SuggestedStage["distance"] = "auto",
    stagger = STAGGER,
    chunk = true,
  ): void => {
    if (group.length === 0) return;
    const chunks: Item[][] = [];
    let cur: Item[] = [];
    let n = 0;
    for (const it of group) {
      if (chunk && cur.length > 0 && n + it.count > STAGE_MAX) {
        chunks.push(cur);
        cur = [];
        n = 0;
      }
      cur.push(it);
      n += it.count;
    }
    chunks.push(cur);
    chunks.forEach((c, k) => {
      const leaves = c.reduce((a, it) => a + it.count, 0);
      const suffix = chunks.length > 1 ? ` ${k + 1}/${chunks.length}` : "";
      stages.push({
        label: `${name}${suffix}`,
        parts: c.map(sel),
        direction: dir,
        distance,
        order: "outside-in",
        stagger,
        duration: DURATION,
        // labelled parts keep their labels when exploded (a plan's components are meant to be read)
        labels: leaves <= LABELS_MAX || c.every((it) => it.p.label !== undefined) ? "show" : "hide",
        ...(hidden(dir) ? { fade: "unselected" as const } : {}),
      });
      counts.push(leaves);
    });
  };
  const aside = asideCovers(
    classes.cover,
    [...classes.unit, ...classes.internal, ...classes.mounted, ...classes.loose],
    items,
    body,
  );
  const byDirection = (group: Item[], cls: PartClass): Map<string, Item[]> => {
    const m = new Map<string, Item[]>();
    for (const it of group) {
      const d = aside.get(it) ?? direction(it, cls, body, classes.internal);
      const g = m.get(d);
      if (g) g.push(it);
      else m.set(d, [it]);
    }
    return m;
  };
  // A part mounted on another leaves in an earlier stage than its carrier: deepest level first.
  const byLevel = (group: Item[]): [number, Item[]][] => {
    const top = Math.max(...group.map((it) => it.level));
    const out: [number, Item[]][] = [];
    for (let l = top; l >= 0; l--) {
      const g = group.filter((it) => it.level === l);
      if (g.length > 0) out.push([l, g]);
    }
    return out;
  };
  const named = (base: string, tags: string[]): string =>
    tags.length > 0 ? `${base} (${tags.join(", ")})` : base;
  /** One stage per mounting level of `group`; `each` is given the level's parts and its tags. */
  const pushLevels = (
    base: string,
    tags: string[],
    group: Item[],
    each: (name: (extra?: string) => string, g: Item[], l: number) => void,
  ): void => {
    const lv = byLevel(group);
    for (const [l, g] of lv)
      each(
        (extra) =>
          named(base, [
            ...tags,
            ...(lv.length > 1 ? [`level ${l}`] : []),
            ...(extra ? [extra] : []),
          ]),
        g,
        l,
      );
  };
  for (const [d, g] of byDirection(classes.fastener, "fastener"))
    pushLevels("Fasteners", d === "+z" ? [] : [d], g, (name, grp) => push(name(), grp, d));
  const covers = byDirection(classes.cover, "cover");
  const late: [string, Item[]][] = [];
  for (const [d, g] of covers) {
    if (hidden(d)) late.push([d, g]);
    else pushLevels("Covers", covers.size === 1 ? [] : [d], g, (name, grp) => push(name(), grp, d));
  }
  // a part that exits through a hidden face passes through the cover there: that cover leaves first
  const exits = new Set(
    [...classes.unit, ...classes.internal].map((it) =>
      direction(it, it.cls, body, classes.internal),
    ),
  );
  for (const [d, g] of late.filter(([d]) => exits.has(d)))
    pushLevels("Covers", [d, "hidden side"], g, (name, grp) => push(name(), grp, d));
  const rest = late.filter(([d]) => !exits.has(d));
  for (const [d, g] of byDirection(classes.unit, "unit"))
    push(d === "drawer" ? "Devices" : "Sub-assemblies", g, d);
  if (classes.internal.length > 0) {
    // `lift` stacks parts of equal rest height as one layer, which can sort a carrier above what
    // it carries (a board with the fans beside it, under its heat sinks): with several levels a
    // stage uses plain +z, whose stacking follows the footprints (6.3). Parts that interpenetrate
    // at rest (a crank through its rods) must move as one: a single number clears them all, the
    // stage has no stagger and is never split; the other parts of the level move normally.
    const base = direction(classes.internal[0]!, "internal", body, classes.internal);
    const multi = byLevel(classes.internal).length > 1;
    pushLevels("Internals", [], classes.internal, (name, g) => {
      const tied = linked(g);
      const rest = g.filter((it) => !tied.includes(it));
      push(name(), rest, multi && base === "lift" ? "+z" : base);
      if (tied.length > 0) {
        rigid = true;
        push(name("moving as one"), tied, "+z", rigidLift(tied, body, ctx.shells, items), 0, false);
      }
    });
  }
  if (classes.mounted.length > 0) {
    // One lift off the body's top face, clearly visible: a quarter of the body's footprint (or
    // 1.5 times the tallest part, if more), one step further for each level of mounting so that
    // a part stays clear above its carrier.
    const bb = body!.box!;
    const foot = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
    const tall = Math.max(...classes.mounted.map((it) => it.box!.max[2] - it.box!.min[2]));
    const step = Math.round(Math.max(0.25 * foot, 1.5 * tall) * 100) / 100;
    pushLevels("Components", [], classes.mounted, (name, g, l) =>
      push(name(), g, "+z", Math.round(step * (l + 1) * 100) / 100),
    );
  }
  push("Other parts", classes.loose, "out");
  for (const [d, g] of rest)
    pushLevels("Covers", [d, "hidden side"], g, (name, grp) => push(name(), grp, d));

  if (stages.length === 0) {
    return "no stages: no part other than the body is movable";
  }

  const total = stages.reduce((a, s, i) => a + stageTime(s, counts[i]!), 0);
  const stepDuration = fitStep(total);
  const names = (c: Item[]): string[] => c.map((it) => it.id);
  const explanation = [
    ...why,
    ...[...folded.values()],
    `${stages.length} stage${stages.length === 1 ? "" : "s"}: fasteners first, then covers, sub-assemblies, internals, parts mounted on the body and loose parts; parts mounted on another part leave before it; hidden-side covers last with the rest faded`,
    `timing: stagger ${STAGGER} s outside-in${rigid ? ", 0 for parts that move as one" : ""}, ${DURATION} s per part; a step of ${stepDuration} s plays the whole program`,
    `labels shown for stages with ${LABELS_MAX} parts or fewer, or whose parts all have a label`,
  ];
  return {
    owner: path,
    pointer: "",
    body: body?.id ?? null,
    classes: {
      fastener: names(classes.fastener),
      cover: names(classes.cover),
      unit: names(classes.unit),
      internal: names(classes.internal),
      mounted: names(classes.mounted),
      loose: names(classes.loose),
    },
    program: { id: PROGRAM_ID, label: `${label}: suggested explode`, stages },
    stepDuration,
    stageLeaves: counts,
    explanation,
  };
}

function story(root: Suggestion, label: string, nested: Suggestion[]): SuggestedStep[] {
  const steps: SuggestedStep[] = [{ caption: `${label} assembled`, duration: 2 }];
  const run = (s: Suggestion, caption: (st: SuggestedStage) => string, focus: boolean): void => {
    s.program.stages.forEach((st, k) => {
      steps.push({
        caption: caption(st),
        duration: fitStep(stageTime(st, s.stageLeaves[k] ?? 1)),
        // never a part of the root (the zoom crops what the explode reveals); a nested owner is
        // focused whole
        ...(focus ? { focus: s.owner } : {}),
        assembly: [{ explode: s.owner, program: PROGRAM_ID, to: k + 1 }],
      });
    });
  };
  run(root, (st) => st.label, false);
  for (const n of nested) run(n, (st) => `${n.owner.split("/").pop()}: ${st.label}`, true);
  steps.push({
    caption: `${label} reassembled`,
    duration: fitStep(
      [root, ...nested].reduce(
        (a, x) =>
          a + x.program.stages.reduce((b, st, k) => b + stageTime(st, x.stageLeaves[k] ?? 1), 0),
        0,
      ),
    ),
    // Levels are per target, so an implode of the root does not reset nested owners.
    assembly: [...nested.map((n) => ({ implode: n.owner })), { implode: root.owner }],
  });
  return steps;
}

/** Proposals for every assembly without a program (top level, and nested groups up to depth 3). */
export function suggest(
  spec: unknown,
  reg?: PartShapeRegistry,
  placed?: PlacedBoxes,
): SuggestReport {
  const out: SuggestReport = { suggestions: [], skipped: [] };
  const assemblies = (spec as { assemblies?: A[] } | null)?.assemblies;
  if (!Array.isArray(assemblies)) return out;
  let owners = 0;
  for (const [ai, a] of assemblies.entries()) {
    if (a === null || typeof a !== "object" || typeof a.id !== "string") continue;
    if (!Array.isArray(a.parts)) continue;
    if (a.template === true) {
      out.skipped.push({ owner: a.id, reason: "template (instanced by other assemblies)" });
      continue;
    }
    if (a.program !== undefined || (Array.isArray(a.programs) && a.programs.length > 0)) {
      out.skipped.push({ owner: a.id, reason: "already has a program" });
      continue;
    }
    if (owners >= MAX_OWNERS) {
      out.skipped.push({ owner: a.id, reason: `owner limit reached (${MAX_OWNERS})` });
      continue;
    }
    const label = a.label ?? a.id;
    const root = suggestOwner(a.id, label, a.parts, reg, placed);
    if (typeof root === "string") {
      out.skipped.push({ owner: a.id, reason: root });
      continue;
    }
    root.pointer = `/assemblies/${ai}`;
    owners++; // the root counts before the walk, so nested owners cannot push past the limit
    const nested: Suggestion[] = [];
    const walk = (parts: P[], base: string, pointer: string, depth: number): void => {
      if (depth >= MAX_DEPTH) return;
      parts.forEach((p, k) => {
        if (owners >= MAX_OWNERS) return;
        if (!Array.isArray(p.parts) || typeof p.id !== "string") return;
        if (Array.isArray(p.programs) && p.programs.length > 0) return;
        // a counted group has instances id-1..id-n; the program (on the part) serves each, the story plays the first
        const path = `${base}/${p.id}${countOf(p) > 1 ? "-1" : ""}`;
        const ptr = `${pointer}/parts/${k}`;
        const sug = suggestOwner(path, p.label ?? p.id, p.parts, reg, placed);
        if (typeof sug !== "string") {
          // fewer than two parts move, or the one stage moves as one: the root program already
          // moves the sub-assembly as a unit, a nested program would add nothing
          const leaves = sug.stageLeaves.reduce((x, y) => x + y, 0);
          const rigidOnly =
            sug.program.stages.length === 1 && /moving as one/.test(sug.program.stages[0]!.label);
          if (leaves < 2 || rigidOnly) {
            out.skipped.push({ owner: path, reason: "one stage: the root moves it as a unit" });
          } else {
            sug.pointer = ptr;
            owners++;
            nested.push(sug);
          }
        }
        walk(p.parts, path, ptr, depth + 1);
      });
    };
    walk(a.parts, a.id, root.pointer, 1);
    root.steps = story(root, label, nested);
    out.suggestions.push(root, ...nested);
  }
  return out;
}

/** The text form: what the skill prints too. */
export function formatSuggestions(file: string, r: SuggestReport): string {
  const lines: string[] = [];
  for (const s of r.suggestions) {
    lines.push(`${file}: suggested program for ${s.owner}`);
    for (const e of s.explanation) lines.push(`  - ${e}`);
    s.program.stages.forEach((st, k) => {
      lines.push(
        `  stage ${k + 1}: ${st.label} -> ${st.direction} (${st.parts.join(", ")})${st.fade ? `, fade ${st.fade}` : ""}`,
      );
    });
    const indent = (v: unknown): string[] =>
      JSON.stringify(v, null, 2)
        .split("\n")
        .map((l) => `    ${l}`);
    lines.push(
      `  add to "programs" at ${s.pointer}/programs (create the array if missing); the lines below are its one entry:`,
      ...indent(s.program),
    );
    if (s.steps) {
      lines.push(
        '  append to the top-level "steps" array (these steps play the program; keep existing steps before them):',
        ...indent(s.steps),
      );
    }
  }
  for (const k of r.skipped) lines.push(`${file}: no suggestion for ${k.owner}: ${k.reason}`);
  if (r.suggestions.length === 0 && r.skipped.length === 0) {
    lines.push(`${file}: no assemblies to suggest a program for`);
  }
  return `${lines.join("\n")}\n`;
}
