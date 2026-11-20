/**
 * Labels, leaders and top-face labels of the assembly layer (docs/design/assemblies.md §6.6).
 *
 * Leader labels. A stage with `labels: "show"` shows the label of each moved node once it
 * arrives (fade in over the last 20% of its move); the label hides at the start of the reverse
 * move and when the loop closes. Placement is computed once per node, at the pose it first
 * shows in: eight candidate boxes around the node's screen box at 18 px, preferring the side
 * of its screen motion vector, then clockwise; the first box that overlaps neither a placed
 * label nor another part's box at that pose wins, else the preferred one nudged by the existing
 * `nudgeLabel` (injected). The leader is a 1 px line between the closest points of the two
 * boxes. The label group is authored in REST coordinates and rides the node's total track.
 *
 * Top-face labels (`labels: "always"`): each labelled leaf's text upright on its projected top
 * face, truncated to fit, visible while the leaf is at its base pose.
 *
 * Deterministic: candidate order, obstacle order (leaf order) and rounding are fixed; nothing
 * depends on object identity. Work: one pass over the leaves per placed label.
 */
import type {
  IdScheme,
  OpacityKey,
  Projection,
  Rect,
  SceneAssembly,
  SvgElement,
  SvgNode,
  TrackKey,
} from "../../contracts/index.js";
import type { AssemblyIdScheme } from "../../contracts/index.js";
import { movesPath } from "../../depth/epochs.js";
import { h } from "../../emit/xml.js";
import { fmt, projectBoxBounds, unionRects } from "../../geometry/index.js";
import { measureText } from "../../text/index.js";
import type { StageRun } from "./loop.js";
import { r4 } from "./loop.js";
import { MoveIndex, offsetTrack, plain, round2, screenOf } from "./tracks.js";
import type { WorldLeaf } from "./world.js";

const GAP = 18;
const EPS = 1e-9;
/** Fraction of a move over which its label fades in (§6.6). */
const FADE_FRACTION = 0.2;

export interface LabelTrack {
  /** Label group id (`ids.partLabel(path)`, `…__top` for top-face labels). */
  readonly id: string;
  readonly path: string;
  readonly kind: "leader" | "top";
  /** Total screen translation of the node (the label group rides it). */
  readonly motion: readonly TrackKey[];
  readonly opacity: readonly OpacityKey[];
  /** Opacity at t = 0. */
  readonly initial: number;
}

export interface TextSpec {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly anchor?: "start" | "middle" | "end";
  readonly cls: string;
  readonly bold?: boolean;
  readonly content: string;
}

export interface LabelContext {
  readonly projection: Projection;
  readonly prefix: string;
  readonly ids: IdScheme & AssemblyIdScheme;
  readonly labelSize: number;
  readonly fs: number;
  readonly text: (o: TextSpec) => SvgElement;
  readonly fit: (text: string, size: number, bold: boolean, maxWidth: number) => string;
  readonly nudge: (box: Rect, placed: readonly Rect[]) => { dy: number };
  readonly assemblies: readonly SceneAssembly[];
  readonly labelMode: (assembly: string) => "exploded" | "always" | "never";
  readonly leaves: readonly WorldLeaf[];
  readonly index: MoveIndex;
  readonly runs: readonly StageRun[];
  readonly loop: number;
  readonly closure?: { readonly t0: number; readonly t1: number };
}

export interface LabelOutput {
  readonly nodes: SvgNode[];
  readonly tracks: LabelTrack[];
  readonly extents: Rect[];
  readonly elements: number;
}

interface NodeInfo {
  readonly path: string;
  readonly assembly: string;
  readonly label: string;
  readonly detail: readonly string[];
  readonly leaves: readonly WorldLeaf[];
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - EPS &&
  b.x < a.x + a.width - EPS &&
  a.y < b.y + b.height - EPS &&
  b.y < a.y + a.height - EPS;

/** Closest points of two rects (a on `a`, b on `b`). */
function closest(a: Rect, b: Rect): { a: { x: number; y: number }; b: { x: number; y: number } } {
  const pick = (a0: number, a1: number, b0: number, b1: number): [number, number] => {
    if (a1 < b0) return [a1, b0];
    if (b1 < a0) return [a0, b1];
    const m = (Math.max(a0, b0) + Math.min(a1, b1)) / 2;
    return [m, m];
  };
  const [ax, bx] = pick(a.x, a.x + a.width, b.x, b.x + b.width);
  const [ay, by] = pick(a.y, a.y + a.height, b.y, b.y + b.height);
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

/** Candidate directions clockwise from north. */
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function candidate(dir: (typeof DIRS)[number], bb: Rect, w: number, h2: number): Rect {
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;
  const right = bb.x + bb.width + GAP;
  const left = bb.x - GAP - w;
  const top = bb.y - GAP - h2;
  const bottom = bb.y + bb.height + GAP;
  const x = dir === "N" || dir === "S" ? cx - w / 2 : dir.includes("E") ? right : left;
  const y = dir === "E" || dir === "W" ? cy - h2 / 2 : dir.includes("N") ? top : bottom;
  return { x, y, width: w, height: h2 };
}

function preferred(v: { x: number; y: number }): number {
  if (Math.abs(v.x) < 1e-6 && Math.abs(v.y) < 1e-6) return 0;
  const a = Math.atan2(v.x, -v.y); // clockwise from north
  const turn = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return Math.round(turn / (Math.PI / 4)) % 8;
}

export function buildLabels(ctx: LabelContext): LabelOutput {
  const { projection, ids, runs, index } = ctx;
  const P = ctx.prefix;
  const nodes: SvgNode[] = [];
  const tracks: LabelTrack[] = [];
  const extents: Rect[] = [];
  let elements = 0;

  // Nodes (leaf or sub) with a label, from the assemblies' trees.
  const info = new Map<string, NodeInfo>();
  for (const asm of ctx.assemblies) {
    if (ctx.labelMode(asm.id) === "never") continue;
    const walk = (n: SceneAssembly["root"]): void => {
      if (n.label !== undefined && n.label !== "" && n.path !== asm.id) {
        const under = ctx.leaves.filter((l) => movesPath(n.path, l.path));
        if (under.length > 0)
          info.set(n.path, {
            path: n.path,
            assembly: asm.id,
            label: n.label,
            detail: n.detail,
            leaves: under,
          });
      }
      for (const c of n.children) walk(c);
    };
    walk(asm.root);
  }

  const leafBounds = (l: WorldLeaf, t: number): Rect => {
    const d = index.displacement(l.path, t);
    const b = l.geometry.bounds;
    return projectBoxBounds(projection, {
      origin: { x: b.origin.x + d.x, y: b.origin.y + d.y, z: b.origin.z + d.z },
      size: b.size,
    });
  };

  // ---- leader labels --------------------------------------------------------------------
  interface Event {
    readonly t: number;
    readonly kind: "in" | "out";
    readonly t1?: number;
  }
  const events = new Map<string, Event[]>();
  const firstShow = new Map<string, { t: number; details: boolean }>();
  const addEvent = (path: string, e: Event): void => {
    const l = events.get(path);
    if (l === undefined) events.set(path, [e]);
    else l.push(e);
  };
  for (const run of runs) {
    for (const mv of run.moves) {
      const inf = info.get(mv.path);
      if (run.kind === "implode") {
        if (inf !== undefined) addEvent(mv.path, { t: mv.t0, kind: "out" });
        continue;
      }
      if (inf === undefined || run.stage.labels !== "show") continue;
      const dur = mv.t1 - mv.t0;
      addEvent(mv.path, { t: r4(mv.t1 - dur * FADE_FRACTION), kind: "in", t1: mv.t1 });
      const prev = firstShow.get(mv.path);
      if (prev === undefined || mv.t1 < prev.t) {
        firstShow.set(mv.path, { t: mv.t1, details: run.stage.details });
      } else if (run.stage.details && !prev.details) {
        firstShow.set(mv.path, { t: prev.t, details: true });
      }
    }
  }

  const placed: Rect[] = [];
  const size = ctx.labelSize;
  const lineH = size * 1.25;
  for (const path of [...firstShow.keys()].sort()) {
    const inf = info.get(path) as NodeInfo;
    const show = firstShow.get(path) as { t: number; details: boolean };
    const runWith = runs.find((r) => r.kind === "explode" && r.moves.some((m) => m.path === path));
    const leaders = runWith?.stage.leaders !== false;
    // text lines
    const lines = [inf.label, ...(show.details ? inf.detail : [])].map((s, i) =>
      ctx.fit(s, i === 0 ? size : size - 1, false, 150 * ctx.fs),
    );
    const w =
      Math.max(...lines.map((s, i) => measureText(s, i === 0 ? size : size - 1, "regular"))) +
      8 * ctx.fs;
    const hgt = lines.length * lineH + 4;
    // node box at the pose where the label shows
    const bb = unionRects(inf.leaves.map((l) => leafBounds(l, show.t)));
    const mv = screenOf(projection, index.displacement(path, show.t));
    const mv0 = screenOf(projection, index.displacement(path, 0));
    const vec = { x: mv.x - mv0.x, y: mv.y - mv0.y };
    const own = new Set(inf.leaves.map((l) => l.path));
    const obstacles = ctx.leaves.filter((l) => !own.has(l.path)).map((l) => leafBounds(l, show.t));
    const start = preferred(vec);
    let box: Rect | undefined;
    for (let k = 0; k < 8 && box === undefined; k++) {
      const c = candidate(DIRS[(start + k) % 8] as (typeof DIRS)[number], bb, w, hgt);
      if (placed.some((p) => overlaps(p, c)) || obstacles.some((o) => overlaps(o, c))) continue;
      box = c;
    }
    if (box === undefined) {
      const c = candidate(DIRS[start] as (typeof DIRS)[number], bb, w, hgt);
      const { dy } = ctx.nudge(c, placed);
      box = { ...c, y: c.y + dy };
    }
    placed.push(box);
    extents.push(box, bb);
    // rest coordinates: subtract the node's displacement at the show pose
    const sx = mv.x;
    const sy = mv.y;
    const r = (n: number): number => Number(fmt(n));
    const kids: SvgNode[] = [];
    if (leaders) {
      const cl = closest(bb, box);
      kids.push(
        h("path", {
          class: `${P}-leader`,
          d: `M${fmt(cl.a.x - sx)} ${fmt(cl.a.y - sy)}L${fmt(cl.b.x - sx)} ${fmt(cl.b.y - sy)}`,
        }),
      );
      extents.push({
        x: Math.min(cl.a.x, cl.b.x),
        y: Math.min(cl.a.y, cl.b.y),
        width: Math.abs(cl.a.x - cl.b.x),
        height: Math.abs(cl.a.y - cl.b.y),
      });
    }
    kids.push(
      h("rect", {
        class: `${P}-elabel`,
        x: r(box.x - sx),
        y: r(box.y - sy),
        width: r(w),
        height: r(hgt),
        rx: 3,
      }),
    );
    lines.forEach((s, i) =>
      kids.push(
        ctx.text({
          x: r(box.x - sx + 4 * ctx.fs),
          y: r(box.y - sy + 2 + lineH * i + size),
          size: i === 0 ? size : size - 1,
          cls: "t-primary",
          content: s,
          ...(i === 0 ? { bold: true } : {}),
        }),
      ),
    );
    const id = ids.partLabel(path);
    // opacity keys from the events
    const evs = (events.get(path) ?? [])
      .slice()
      .sort((a, b) => a.t - b.t || (a.kind < b.kind ? -1 : 1));
    if (ctx.closure !== undefined) evs.push({ t: ctx.closure.t0, kind: "out" });
    const keys: OpacityKey[] = [{ t: 0, opacity: 0, easing: "linear" }];
    const put = (t: number, opacity: number, easing: OpacityKey["easing"]): void => {
      const last = keys[keys.length - 1] as OpacityKey;
      const tt = r4(Math.min(ctx.loop, Math.max(t, 0)));
      if (tt <= last.t + EPS) {
        if (last.opacity === opacity) return;
        keys[keys.length - 1] = { t: last.t, opacity, easing };
        return;
      }
      keys.push({ t: tt, opacity, easing });
    };
    for (const e of evs) {
      const last = keys[keys.length - 1] as OpacityKey;
      if (e.kind === "in") {
        if (last.opacity === 1 && last.t >= e.t - EPS) continue;
        put(e.t, 0, "linear");
        put(e.t1 as number, 1, "linear");
      } else if (last.opacity > 0) {
        // hold until the start of the reverse move, then drop
        keys[keys.length - 1] = { ...last, easing: "step" };
        put(e.t, 0, "linear");
      }
    }
    if (ctx.loop > 0 && (keys[keys.length - 1] as OpacityKey).t < ctx.loop - EPS) {
      put(ctx.loop, (keys[keys.length - 1] as OpacityKey).opacity, "linear");
    }
    const motion = offsetTrack(plain(index.chain(path)), ctx.loop, projection);
    tracks.push({ id, path, kind: "leader", motion, opacity: keys, initial: 0 });
    nodes.push(h("g", { id, class: `${P}-plabel` }, ...kids));
    elements += 2 + kids.length;
  }

  // ---- top-face labels ------------------------------------------------------------------
  for (const l of ctx.leaves) {
    if (ctx.labelMode(l.assembly) !== "always") continue;
    const label = l.node.label;
    if (label === undefined || label === "") continue;
    const b = l.depthBox;
    const top = projection.project({
      x: b.origin.x + b.size.x / 2,
      y: b.origin.y + b.size.y / 2,
      z: b.origin.z + b.size.z,
    });
    const faceW = ((b.size.x + b.size.y) * projection.tileWidth) / 2;
    const fs2 = Math.max(8, size - 2);
    const text = ctx.fit(label, fs2, false, faceW * 0.8);
    if (text === "" || faceW * 0.8 < fs2 * 2) continue;
    const id = `${ids.partLabel(l.path)}__top`;
    const chain = index.chain(l.path);
    const motion = offsetTrack(plain(chain), ctx.loop, projection);
    // visible while the leaf is at its base pose: hidden between a move's start and the time
    // its displacement is back to the base value
    const opacity = restOpacity(chain, ctx.loop, (t) =>
      screenOf(projection, index.displacement(l.path, t)),
    );
    tracks.push({
      id,
      path: l.path,
      kind: "top",
      motion,
      opacity,
      initial: opacity[0]?.opacity ?? 1,
    });
    nodes.push(
      h(
        "g",
        { id, class: `${P}-plabel` },
        ctx.text({
          x: round2(top.x),
          y: round2(top.y + fs2 / 3),
          size: fs2,
          anchor: "middle",
          cls: "t-primary",
          content: text,
        }),
      ),
    );
    elements += 2;
    extents.push({ x: top.x - faceW / 2, y: top.y - fs2, width: faceW, height: fs2 * 2 });
  }
  return { nodes, tracks, extents, elements };
}

/** Opacity 1 while the displacement equals its t = 0 value, 0 otherwise (step changes). */
function restOpacity(
  chain: readonly { readonly t0: number; readonly t1: number }[],
  loop: number,
  disp: (t: number) => { x: number; y: number },
): OpacityKey[] {
  if (loop <= 0 || chain.length === 0) return [];
  const times = [...new Set([0, r4(loop), ...chain.flatMap((m) => [r4(m.t0), r4(m.t1)])])]
    .filter((t) => t >= 0 && t <= loop)
    .sort((a, b) => a - b);
  const d0 = disp(0);
  const atRest = (t: number): boolean => {
    const d = disp(t);
    return Math.abs(d.x - d0.x) < 0.005 && Math.abs(d.y - d0.y) < 0.005;
  };
  const keys: OpacityKey[] = [];
  for (let i = 0; i < times.length; i++) {
    const a = times[i] as number;
    const b = times[i + 1];
    const v = atRest(a) && (b === undefined || atRest(b)) ? 1 : 0;
    const last = keys[keys.length - 1];
    if (last !== undefined && last.opacity === v) continue;
    if (last !== undefined) keys[keys.length - 1] = { ...last, easing: "step" };
    keys.push({ t: a, opacity: v, easing: "linear" });
  }
  if (keys.every((k) => k.opacity === 1)) return [];
  const lastKey = keys[keys.length - 1] as OpacityKey;
  if (lastKey.t < loop - EPS)
    keys.push({ t: r4(loop), opacity: lastKey.opacity, easing: "linear" });
  return keys;
}
