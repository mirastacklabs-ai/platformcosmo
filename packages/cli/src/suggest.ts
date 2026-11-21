/**
 * `pcosmo validate --suggest`: proposes an explode program and a story for assemblies that have
 * none, following docs/design/assemblies.md section 17 (the skill prints the same). Pure and
 * deterministic: the proposal depends only on the spec and the installed shape registry, never on
 * time, randomness or the environment. It works from what the spec states (role, type, shape,
 * `at`, `size`, `axis`, `mates`), so a part without an explicit `size` takes no part in geometric
 * rules (thin covers, enclosure), and the rules fall back to roles and types.
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
const COVER = /(^|-)(lid|panel|cover|pan|door|cap)$/;
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
  box?: Box;
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

/** The placement the scene tree resolved (a counted part: the union of its instances), else the stated one. */
function placedBox(
  p: P,
  id: string,
  path: string,
  placed: PlacedBoxes | undefined,
): Box | undefined {
  if (!placed || isGroup(p)) return boxOf(p);
  const n = countOf(p);
  const names =
    n > 1 ? Array.from({ length: Math.min(n, 1024) }, (_, k) => `${id}-${k + 1}`) : [id];
  let u: Box | undefined;
  for (const name of names) {
    const b = placed.get(`${path}/${name}`);
    if (!b) continue;
    const a = u;
    u = a
      ? {
          min: [0, 1, 2].map((k) => Math.min(a.min[k]!, b.min[k]!)) as Box["min"],
          max: [0, 1, 2].map((k) => Math.max(a.max[k]!, b.max[k]!)) as Box["max"],
        }
      : { min: [...b.min], max: [...b.max] };
  }
  return u ?? boxOf(p);
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

/** Some two boxes of the group interpenetrate at rest. */
function overlapEach(g: Item[]): boolean {
  for (const [i, a] of g.entries()) {
    for (const b of g.slice(i + 1)) {
      if (!a.box || !b.box) continue;
      if (
        [0, 1, 2].every(
          (k) => a.box!.min[k]! < b.box!.max[k]! - TOL && b.box!.min[k]! < a.box!.max[k]! - TOL,
        )
      )
        return true;
    }
  }
  return false;
}

/**
 * One distance that takes the whole group out of the body (top of the body above its lowest
 * part) plus the default gap (10% of the owner's largest extent), so it moves as one.
 */
function rigidLift(g: Item[], body: Item | undefined, all: Item[]): number {
  const boxes = all.flatMap((it) => (it.box ? [it.box] : []));
  const ext = Math.max(
    0,
    ...[0, 1, 2].map(
      (k) => Math.max(...boxes.map((b) => b.max[k]!)) - Math.min(...boxes.map((b) => b.min[k]!)),
    ),
  );
  const low = Math.min(...g.flatMap((it) => (it.box ? [it.box.min[2]] : [])));
  const out = body?.box ? Math.max(0, body.box.max[2] - low) : 0;
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
    memo.set(it, v);
    return v;
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
 * A cover is thin AND spans at least half of the body's face on its side: a flat part on top of
 * a board (a DIMM, a chip) is thin too, but covers nothing.
 */
function coversBody(b: Box, body: Box): boolean {
  const side = sideOf(b, body);
  if (side === undefined) return false;
  const k = AXIS_INDEX[side[1] as "x" | "y" | "z"];
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
  if (it.box && ctx.body?.box && thin(it.box) && coversBody(it.box, ctx.body.box)) return "cover";
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

/** `q` holds `it` on its top face: `it` starts at or above `q`'s top, over its footprint. */
const carries = (q: Item, it: Item): boolean =>
  q.box !== undefined &&
  it.box !== undefined &&
  !q.isGroup &&
  it.box.min[2] >= q.box.max[2] - TOL &&
  overlapXY(it.box, q.box) > 0;

const sel = (it: Item): string => (it.count > 1 ? `${it.id}-*` : it.id);

function direction(it: Item, cls: PartClass, body: Item | undefined, internals: Item[]): string {
  const p = it.p;
  switch (cls) {
    case "fastener":
      return p.axis === "x" || p.axis === "y" ? `+${p.axis}` : "+z";
    case "cover":
      return (it.box && body?.box ? sideOf(it.box, body.box) : undefined) ?? "away";
    case "unit":
      if (
        (p.shape?.startsWith("dc:") ?? false) ||
        RACK_DEVICE.test(p.type ?? "") ||
        (it.isGroup && RACK_DEVICE.test(it.id))
      )
        return "drawer";
      return p.mates !== undefined || p.inserts !== undefined ? "away" : "out";
    case "internal":
      return internals.length >= 2 ? "lift" : "away";
    case "mounted":
      return "+z";
    default:
      return "out";
  }
}

const hidden = (d: string): boolean => d.startsWith("-");

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
      ...(b ? { box: b } : {}),
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
      const v = volume(it.box);
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
  const of = (c: PartClass): Item[] => items.filter((it) => it.cls === c);
  const classes = {
    fastener: of("fastener"),
    cover: of("cover"),
    unit: of("unit"),
    internal: of("internal"),
    mounted: of("mounted"),
    loose: of("loose"),
  };
  levels([...classes.internal, ...classes.mounted, ...classes.loose]);

  // 3-4. One stage per class and direction (a class larger than STAGE_MAX is split in order);
  // covers on a hidden side go last, with the others faded.
  const stages: SuggestedStage[] = [];
  const counts: number[] = [];
  const push = (
    name: string,
    group: Item[],
    dir: string,
    distance: SuggestedStage["distance"] = "auto",
    stagger = STAGGER,
  ): void => {
    if (group.length === 0) return;
    const chunks: Item[][] = [];
    let cur: Item[] = [];
    let n = 0;
    for (const it of group) {
      if (cur.length > 0 && n + it.count > STAGE_MAX) {
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
  const byDirection = (group: Item[], cls: PartClass): Map<string, Item[]> => {
    const m = new Map<string, Item[]>();
    for (const it of group) {
      const d = direction(it, cls, body, classes.internal);
      const g = m.get(d);
      if (g) g.push(it);
      else m.set(d, [it]);
    }
    return m;
  };
  for (const [d, g] of byDirection(classes.fastener, "fastener"))
    push(d === "+z" ? "Fasteners" : `Fasteners (${d})`, g, d);
  const covers = byDirection(classes.cover, "cover");
  const late: [string, Item[]][] = [];
  for (const [d, g] of covers) {
    if (hidden(d)) late.push([d, g]);
    else push(covers.size === 1 ? "Covers" : `Covers (${d})`, g, d);
  }
  for (const [d, g] of byDirection(classes.unit, "unit"))
    push(d === "drawer" ? "Devices" : "Sub-assemblies", g, d);
  // Parts mounted on another part leave in an earlier stage than their carrier: deepest first.
  const byLevel = (group: Item[]): [number, Item[]][] => {
    const top = Math.max(...group.map((it) => it.level));
    const out: [number, Item[]][] = [];
    for (let l = top; l >= 0; l--) {
      const g = group.filter((it) => it.level === l);
      if (g.length > 0) out.push([l, g]);
    }
    return out;
  };
  if (classes.internal.length > 0) {
    const lv = byLevel(classes.internal);
    // `lift` stacks parts of equal rest height as one layer, which can sort a carrier above what
    // it carries (a board with the fans beside it, under its heat sinks): with several levels a
    // stage uses plain +z, whose stacking follows the footprints (6.3). Parts that interpenetrate
    // at rest (a crank through its rods) must move as one: a single number clears them all and
    // the stage has no stagger.
    const base = direction(classes.internal[0]!, "internal", body, classes.internal);
    for (const [l, g] of lv) {
      const name = lv.length === 1 ? "Internals" : `Internals (level ${l})`;
      if (overlapEach(g)) push(name, g, "+z", rigidLift(g, body, items), 0);
      else push(name, g, lv.length > 1 && base === "lift" ? "+z" : base);
    }
  }
  if (classes.mounted.length > 0) {
    // One lift off the body's top face, clearly visible: a quarter of the body's footprint (or
    // 1.5 times the tallest part, if more), one step further for each level of mounting so that
    // a part stays clear above its carrier.
    const bb = body!.box!;
    const foot = Math.max(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]);
    const tall = Math.max(...classes.mounted.map((it) => it.box!.max[2] - it.box!.min[2]));
    const step = Math.round(Math.max(0.25 * foot, 1.5 * tall) * 100) / 100;
    const lv = byLevel(classes.mounted);
    for (const [l, g] of lv)
      push(
        lv.length === 1 ? "Components" : `Components (level ${l})`,
        g,
        "+z",
        Math.round(step * (l + 1) * 100) / 100,
      );
  }
  push("Other parts", classes.loose, "out");
  for (const [d, g] of late) push(`Covers (${d}, hidden side)`, g, d);

  if (stages.length === 0) {
    return "no stages: no part other than the body is movable";
  }

  const total = stages.reduce((a, s, i) => a + stageTime(s, counts[i]!), 0);
  const stepDuration = fitStep(total);
  const names = (c: Item[]): string[] => c.map((it) => it.id);
  const explanation = [
    ...why,
    `${stages.length} stage${stages.length === 1 ? "" : "s"}: fasteners first, then covers, sub-assemblies, internals, parts mounted on the body and loose parts; parts mounted on another part leave before it; hidden-side covers last with the rest faded`,
    `timing: stagger ${STAGGER} s outside-in, ${DURATION} s per part; a step of ${stepDuration} s plays the whole program`,
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
          sug.pointer = ptr;
          owners++;
          nested.push(sug);
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
