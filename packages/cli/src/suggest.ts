/**
 * `pcosmo validate --suggest`: proposes an explode program and a story for assemblies that have
 * none, following docs/design/assemblies.md section 17 (the skill prints the same). Pure and
 * deterministic: the proposal depends only on the spec and the installed shape registry, never on
 * time, randomness or the environment. It works from what the spec states (role, type, shape,
 * `at`, `size`, `axis`, `mates`), so a part without an explicit `size` takes no part in geometric
 * rules (thin covers, enclosure), and the rules fall back to roles and types.
 */
import type { PartShapeRegistry } from "@platformcosmo/core";

export type PartClass = "body" | "fastener" | "cover" | "unit" | "internal" | "loose";

export interface SuggestedStage {
  label: string;
  parts: string[];
  direction: string;
  distance: "auto";
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
  body: string | null;
  classes: Record<Exclude<PartClass, "body">, string[]>;
  program: { id: string; label: string; stages: SuggestedStage[] };
  /** Seconds a step playing the whole program needs (stage times plus a hold). */
  stepDuration: number;
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
const HOLD = 0.4;
const MAX_OWNERS = 64;
const MAX_DEPTH = 3;
const TOL = 1e-6;
const PROGRAM_ID = "suggested";

const FASTENER = /^(screw|bolt|clip|pin|nut|washer|rivet|fastener)s?$/;
const COVER = /(^|-)(lid|panel|cover|pan|door|cap)$/;
const RACK_DEVICE = /^(server|storage|switch|psu|router|firewall|chassis)/;

type Box = { min: [number, number, number]; max: [number, number, number] };
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
}

const isGroup = (p: P): boolean => p.parts !== undefined || p.use !== undefined;
const countOf = (p: P): number => (isNum(p.count) && p.count >= 1 ? Math.floor(p.count) : 1);

function boxOf(p: P): Box | undefined {
  const at = vec(p.at);
  const size = vec(p.size);
  if (!at || !size || isGroup(p)) return undefined;
  return { min: at, max: [at[0] + size[0], at[1] + size[1], at[2] + size[2]] };
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

const touchesOuter = (b: Box, body: Box): boolean => sideOf(b, body) !== undefined;

function classify(it: Item, reg: PartShapeRegistry | undefined, ctx: Ctx): PartClass {
  const p = it.p;
  if (it.isGroup) return "unit";
  const def = p.shape !== undefined && p.shape.includes(":") ? reg?.get(p.shape) : undefined;
  const role = p.role ?? def?.role;
  if (role === "body") return "body";
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
  if (it.box && ctx.body?.box && thin(it.box) && touchesOuter(it.box, ctx.body.box)) return "cover";
  if (it.box && ctx.shells.some((s) => s !== it && s.box && inside(it.box!, s.box!)))
    return "internal";
  return "loose";
}

interface Ctx {
  body?: Item;
  shells: Item[];
}

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
    default:
      return "out";
  }
}

const hidden = (d: string): boolean => d.startsWith("-");

function stageTime(s: SuggestedStage, n: number): number {
  return s.duration + s.stagger * Math.max(0, n - 1);
}

function suggestOwner(
  path: string,
  label: string,
  parts: P[],
  reg: PartShapeRegistry | undefined,
): Suggestion | undefined {
  const items: Item[] = parts.map((p, i) => {
    const b = boxOf(p);
    return {
      p,
      id: p.id ?? `part-${i + 1}`,
      isGroup: isGroup(p),
      count: countOf(p),
      ...(b ? { box: b } : {}),
      cls: "loose" as PartClass,
    };
  });
  if (items.length < 2) return undefined;

  // 1. Body: role body, else the part most others mate with, else the largest volume.
  let body = items.find((it) => it.cls === "loose" && (it.p.role ?? "") === "body");
  const why: string[] = [];
  if (body) why.push(`body: ${body.id} (role body)`);
  if (!body) {
    const mated = new Map<string, number>();
    for (const it of items) {
      const m = it.p.mates;
      if (typeof m === "string") {
        const head = m.split("/")[0] as string;
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
  const ctx: Ctx = { shells: items.filter((it) => it.p.role === "shell" || it.p.shape === "tray") };
  if (body) ctx.body = body;
  for (const it of items) it.cls = it === body ? "body" : classify(it, reg, ctx);
  const of = (c: PartClass): Item[] => items.filter((it) => it.cls === c);
  const classes = {
    fastener: of("fastener"),
    cover: of("cover"),
    unit: of("unit"),
    internal: of("internal"),
    loose: of("loose"),
  };

  // 3-4. One stage per class and direction (a class larger than STAGE_MAX is split in order);
  // covers on a hidden side go last, with the others faded.
  const stages: SuggestedStage[] = [];
  const counts: number[] = [];
  const push = (name: string, group: Item[], cls: PartClass, dir: string): void => {
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
        distance: "auto",
        order: "outside-in",
        stagger: STAGGER,
        duration: DURATION,
        labels: leaves <= LABELS_MAX ? "show" : "hide",
        ...(hidden(dir) ? { fade: "unselected" as const } : {}),
      });
      counts.push(leaves);
    });
    void cls;
  };
  const byDirection = (group: Item[], cls: PartClass): Map<string, Item[]> => {
    const m = new Map<string, Item[]>();
    for (const it of group) {
      const d = direction(it, cls, body, classes.internal);
      m.set(d, [...(m.get(d) ?? []), it]);
    }
    return m;
  };
  for (const [d, g] of byDirection(classes.fastener, "fastener"))
    push(d === "+z" ? "Fasteners" : `Fasteners (${d})`, g, "fastener", d);
  const covers = byDirection(classes.cover, "cover");
  const late: [string, Item[]][] = [];
  for (const [d, g] of covers) {
    if (hidden(d)) late.push([d, g]);
    else push(covers.size === 1 ? "Covers" : `Covers (${d})`, g, "cover", d);
  }
  for (const [d, g] of byDirection(classes.unit, "unit"))
    push(d === "drawer" ? "Devices" : "Sub-assemblies", g, "unit", d);
  if (classes.internal.length > 0) {
    push(
      "Internals",
      classes.internal,
      "internal",
      direction(classes.internal[0]!, "internal", body, classes.internal),
    );
  }
  push("Other parts", classes.loose, "loose", "out");
  for (const [d, g] of late) push(`Covers (${d}, hidden side)`, g, "cover", d);

  if (stages.length === 0) return undefined;

  const total = stages.reduce((a, s, i) => a + stageTime(s, counts[i]!), 0);
  const stepDuration = Math.ceil((total + HOLD) * 10) / 10;
  const names = (c: Item[]): string[] => c.map((it) => it.id);
  const explanation = [
    ...why,
    `${stages.length} stage${stages.length === 1 ? "" : "s"}: fasteners first, then covers, sub-assemblies, internals and loose parts; hidden-side covers last with the rest faded`,
    `timing: stagger ${STAGGER} s outside-in, ${DURATION} s per part; a step of ${stepDuration} s plays the whole program`,
    `labels shown for stages with ${LABELS_MAX} parts or fewer`,
  ];
  return {
    owner: path,
    body: body?.id ?? null,
    classes: {
      fastener: names(classes.fastener),
      cover: names(classes.cover),
      unit: names(classes.unit),
      internal: names(classes.internal),
      loose: names(classes.loose),
    },
    program: { id: PROGRAM_ID, label: `${label}: suggested explode`, stages },
    stepDuration,
    explanation,
  };
}

function story(root: Suggestion, label: string, nested: Suggestion[]): SuggestedStep[] {
  const steps: SuggestedStep[] = [{ caption: `${label} assembled`, duration: 2 }];
  const run = (s: Suggestion, caption: (st: SuggestedStage) => string): void => {
    s.program.stages.forEach((st, k) => {
      const first = st.parts[0]!.replace(/-\*$/, (m) => (st.parts[0]!.endsWith("-*") ? "-1" : m));
      steps.push({
        caption: caption(st),
        duration: Math.ceil((stageTime(st, STAGE_MAX) / 2 + HOLD) * 10) / 10,
        focus: `${s.owner}/${first}`,
        assembly: [{ explode: s.owner, program: PROGRAM_ID, to: k + 1 }],
      });
    });
  };
  run(root, (st) => st.label);
  for (const n of nested) run(n, (st) => `${n.owner.split("/").pop()}: ${st.label}`);
  steps.push({
    caption: `${label} reassembled`,
    duration: 2,
    assembly: [{ implode: root.owner }],
  });
  return steps;
}

/** Proposals for every assembly without a program (top level, and nested groups up to depth 3). */
export function suggest(spec: unknown, reg?: PartShapeRegistry): SuggestReport {
  const out: SuggestReport = { suggestions: [], skipped: [] };
  const assemblies = (spec as { assemblies?: A[] } | null)?.assemblies;
  if (!Array.isArray(assemblies)) return out;
  let owners = 0;
  for (const a of assemblies) {
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
    const label = a.label ?? a.id;
    const root = suggestOwner(a.id, label, a.parts, reg);
    if (!root) {
      out.skipped.push({ owner: a.id, reason: "nothing to move (fewer than two parts)" });
      continue;
    }
    const nested: Suggestion[] = [];
    const walk = (parts: P[], base: string, depth: number): void => {
      if (depth >= MAX_DEPTH) return;
      for (const p of parts) {
        if (owners >= MAX_OWNERS) return;
        if (!Array.isArray(p.parts) || typeof p.id !== "string") continue;
        if (Array.isArray(p.programs) && p.programs.length > 0) continue;
        const path = `${base}/${p.id}`;
        const s = suggestOwner(path, p.label ?? p.id, p.parts, reg);
        if (s) {
          owners++;
          nested.push(s);
        }
        walk(p.parts, path, depth + 1);
      }
    };
    walk(a.parts, a.id, 1);
    root.steps = story(root, label, nested);
    out.suggestions.push(root, ...nested);
    owners++;
    if (owners >= MAX_OWNERS) break;
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
    const snippet = {
      programs: [s.program],
      ...(s.steps ? { steps: s.steps } : {}),
    };
    lines.push(
      "  spec fragment:",
      ...JSON.stringify(snippet, null, 2)
        .split("\n")
        .map((l) => `    ${l}`),
    );
  }
  for (const k of r.skipped) lines.push(`${file}: no suggestion for ${k.owner}: ${k.reason}`);
  if (r.suggestions.length === 0 && r.skipped.length === 0) {
    lines.push(`${file}: no assemblies to suggest a program for`);
  }
  return `${lines.join("\n")}\n`;
}
