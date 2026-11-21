/**
 * Labels, leaders and top-face labels of the assembly layer (docs/design/assemblies.md §6.6).
 *
 * Leader labels. A stage with `labels: "show"` shows the label of each moved node once it
 * arrives (fade in over the last 20% of its move); the label hides at the start of the reverse
 * move and when the loop closes. Placement is computed once per node, at the pose it first
 * shows in: eight candidate boxes around the node's visible screen extent at 18 px, preferring the side
 * of its screen motion vector, then clockwise; the first box that overlaps neither a placed
 * label nor another part's box at that pose wins, else the preferred one nudged by the existing
 * `nudgeLabel` (injected). The leader is a 1 px line from an ANCHOR to the label box: the sample
 * point of the node's visible surface (not hidden behind another part along the view ray, at the
 * pose it shows in and at the end of each later stage while it is up) nearest to the label, so it
 * ends on the part's own geometry even where the part's screen box is mostly empty (thin plates)
 * or covered (parts lifted under a plate). Candidates whose leader would be long are passed over. The label group is authored in REST coordinates and rides the node's total track.
 *
 * Top-face labels (`labels: "always"`): each labelled leaf's text upright on its projected top
 * face, truncated to fit, visible while the leaf is at its base pose.
 *
 * Deterministic: candidate order, obstacle order (leaf order) and rounding are fixed; nothing
 * depends on object identity. Work: one pass over the leaves per placed label.
 */
import type {
  Box3,
  Diagnostic,
  IdScheme,
  OpacityKey,
  Projection,
  Rect,
  SceneAssembly,
  SvgElement,
  SvgNode,
  TrackKey,
  Vec2,
  Vec3,
} from "../../contracts/index.js";
import type { AssemblyIdScheme } from "../../contracts/index.js";
import { movesPath } from "../../depth/epochs.js";
import { h } from "../../emit/xml.js";
import { fmt, projectBoxBounds, unionRects } from "../../geometry/index.js";
import { measureText } from "../../text/index.js";
import type { StageRun } from "./loop.js";
import { r4 } from "./loop.js";
import {
  MoveIndex,
  evalOffset,
  evalOpacity,
  offsetTrack,
  plain,
  round2,
  screenOf,
  translateOf,
} from "./tracks.js";
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
  /** Leader end on the part, in the group's REST coordinates (leader labels with a leader). */
  readonly anchor?: { readonly x: number; readonly y: number };
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
  /** Top-face labels by leaf path: drawn INSIDE the part group, after its faces (shared depth). */
  readonly top: ReadonlyMap<string, SvgElement>;
  /** `assembly/label-omitted`: a requested top-face label that did not fit and was not drawn. */
  readonly diagnostics: Diagnostic[];
  /**
   * Boxes (label and leader) of the leader labels of `path` and everything below it over the
   * window `[a, b]` of loop time, wherever they are visible: what a camera that frames `path`
   * during that window must contain.
   */
  readonly rectsUnder: (path: string, a: number, b: number) => Rect[];
}

interface NodeInfo {
  readonly path: string;
  readonly assembly: string;
  readonly label: string;
  readonly detail: readonly string[];
  readonly leaves: readonly WorldLeaf[];
}

/** Longest leader a candidate may have before the next candidate is tried (§6.6). */
const MAX_LEADER = 3 * GAP;
const SAMPLE_STEPS = [1 / 6, 3 / 6, 5 / 6] as const;
const NEAR = 1e-6;
/** Most surface samples considered per node. */
const MAX_SAMPLES = 1200;

interface Sample {
  readonly world: Vec3;
  /** Which leaf of the node it lies on. */
  readonly leaf: number;
}

/** Bounding rect of points (`fallback` when there are none). */
function unionPoints(pts: readonly Vec2[], fallback: Rect): Rect {
  if (pts.length === 0) return fallback;
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Distance from a point to a rect (0 inside) and the point of the rect nearest to it. */
function toRect(p: Vec2, r: Rect): { d: number; at: Vec2 } {
  const x = Math.min(Math.max(p.x, r.x), r.x + r.width);
  const y = Math.min(Math.max(p.y, r.y), r.y + r.height);
  return { d: Math.hypot(p.x - x, p.y - y), at: { x, y } };
}

/** Whether the ray `p + s·dir` (s > 0) passes through the interior of `box`. */
function rayHits(p: Vec3, dir: Vec3, box: Box3): boolean {
  let lo = 0;
  let hi = Infinity;
  const axes = ["x", "y", "z"] as const;
  for (const a of axes) {
    const a0 = box.origin[a] + NEAR;
    const a1 = box.origin[a] + box.size[a] - NEAR;
    if (a1 <= a0) return false;
    const t0 = (a0 - p[a]) / dir[a];
    const t1 = (a1 - p[a]) / dir[a];
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
    if (hi - lo <= NEAR) return false;
  }
  return hi > NEAR;
}

/** Nine points on each of the three faces of a box that face the viewer (+x, +y, +z). */
function faceSamples(b: Box3, leaf: number, out: Sample[]): void {
  const { origin: o, size: s } = b;
  for (const u of SAMPLE_STEPS) {
    for (const v of SAMPLE_STEPS) {
      out.push({ world: { x: o.x + s.x, y: o.y + u * s.y, z: o.z + v * s.z }, leaf });
      out.push({ world: { x: o.x + u * s.x, y: o.y + s.y, z: o.z + v * s.z }, leaf });
      out.push({ world: { x: o.x + u * s.x, y: o.y + v * s.y, z: o.z + s.z }, leaf });
    }
  }
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
  const topLabels = new Map<string, SvgElement>();
  const extents: Rect[] = [];
  const diagnostics: Diagnostic[] = [];
  const shown: {
    path: string;
    rest: Rect[];
    motion: readonly TrackKey[];
    keys: readonly OpacityKey[];
  }[] = [];
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

  // ---- anchors --------------------------------------------------------------------------
  /** Direction toward the viewer: the screen position of a point is the same along it. */
  const view: Vec3 = { x: 1, y: 1, z: projection.tileWidth / 2 / projection.zScale };
  const hollow = new Set(["ring", "tray", "sprite"]);
  const occluders = (own: ReadonlySet<string>, t: number): Box3[] => {
    const out: Box3[] = [];
    for (const l of ctx.leaves) {
      if (own.has(l.path)) continue;
      const d = index.displacement(l.path, t);
      for (const p of l.geometry.primitives) {
        if (hollow.has(p.kind)) continue;
        const o = p.box.origin;
        out.push({ origin: { x: o.x + d.x, y: o.y + d.y, z: o.z + d.z }, size: p.box.size });
      }
    }
    return out;
  };
  /**
   * Surface samples of `leaves` (world, rest pose) that are in view at the first of `times` and,
   * among those, in view at the most of the later times. `total` is the number of samples.
   */
  const anchorPool = (
    leaves: readonly WorldLeaf[],
    own: ReadonlySet<string>,
    times: readonly number[],
  ): { pool: Sample[]; total: number } => {
    let all: Sample[] = [];
    leaves.forEach((l, i) => {
      for (const p of l.geometry.primitives) if (p.kind !== "sprite") faceSamples(p.box, i, all);
    });
    if (all.length > MAX_SAMPLES) {
      const stride = Math.ceil(all.length / MAX_SAMPLES);
      all = all.filter((_, i) => i % stride === 0);
    }
    const visibleAt = (t: number): boolean[] => {
      const occ = occluders(own, t);
      const d = leaves.map((l) => index.displacement(l.path, t));
      return all.map((q) => {
        const o = d[q.leaf] as Vec3;
        const p = { x: q.world.x + o.x, y: q.world.y + o.y, z: q.world.z + o.z };
        return !occ.some((b) => rayHits(p, view, b));
      });
    };
    const first = visibleAt(times[0] as number);
    let idx = all.map((_, i) => i).filter((i) => first[i]);
    if (idx.length === 0) return { pool: all, total: all.length };
    const later = times.slice(1).map(visibleAt);
    const score = (i: number): number => later.filter((v) => v[i]).length;
    const top = Math.max(...idx.map(score));
    idx = idx.filter((i) => score(i) === top);
    return { pool: idx.map((i) => all[i] as Sample), total: all.length };
  };

  // ---- leader labels --------------------------------------------------------------------
  interface Event {
    readonly t: number;
    readonly kind: "in" | "out";
    readonly t1?: number;
  }
  const events = new Map<string, Event[]>();
  const firstShow = new Map<string, { t: number; details: boolean; leaders: boolean }>();
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
        firstShow.set(mv.path, {
          t: mv.t1,
          details: run.stage.details,
          leaders: run.stage.leaders,
        });
      } else if (run.stage.details && !prev.details) {
        firstShow.set(mv.path, { ...prev, details: true });
      }
    }
  }

  // a labelled node that no stage moves (or moves only through an ancestor) never shows its
  // leader label: say so (a leaf of a `labels: always` assembly has its top-face label)
  const moved = new Set(runs.flatMap((run) => run.moves.map((mv) => mv.path)));
  for (const path of [...info.keys()].sort()) {
    const inf = info.get(path) as NodeInfo;
    const leaf = inf.leaves.length === 1 && inf.leaves[0]?.path === path;
    if (moved.has(path) || (leaf && ctx.labelMode(inf.assembly) === "always")) continue;
    diagnostics.push({
      severity: "info",
      code: "assembly/label-omitted",
      path: "",
      message: `The label of part ${JSON.stringify(path)} (${JSON.stringify(inf.label)}) is not drawn: no stage moves it, and leader labels mark moved parts`,
      suggestion:
        "Move it in a stage with labels: show, or set the assembly's labels to always to print it on its top face",
      params: { part: path, label: inf.label },
    });
  }

  const placed: Rect[] = [];
  const size = ctx.labelSize;
  const lineH = size * 1.25;
  for (const path of [...firstShow.keys()].sort()) {
    const inf = info.get(path) as NodeInfo;
    const show = firstShow.get(path) as { t: number; details: boolean; leaders: boolean };
    const leaders = show.leaders;
    // text lines
    const lines = [inf.label, ...(show.details ? inf.detail : [])].map((s, i) =>
      ctx.fit(s, i === 0 ? size : size - 1, i === 0, 150 * ctx.fs),
    );
    const w =
      Math.max(
        ...lines.map((s, i) =>
          measureText(s, i === 0 ? size : size - 1, i === 0 ? "bold" : "regular"),
        ),
      ) +
      8 * ctx.fs;
    const hgt = lines.length * lineH + 4;
    // node box at the pose where the label shows
    const bb = unionRects(inf.leaves.map((l) => leafBounds(l, show.t)));
    const mv = screenOf(projection, index.displacement(path, show.t));
    const mv0 = screenOf(projection, index.displacement(path, 0));
    const vec = { x: mv.x - mv0.x, y: mv.y - mv0.y };
    const own = new Set(inf.leaves.map((l) => l.path));
    const obstacles = ctx.leaves.filter((l) => !own.has(l.path)).map((l) => leafBounds(l, show.t));
    // anchors: surface points of the node that stay in view while its label shows
    const hideAt = Math.min(
      ctx.loop,
      ctx.closure?.t0 ?? Infinity,
      ...(events.get(path) ?? []).filter((e) => e.kind === "out" && e.t > show.t).map((e) => e.t),
    );
    const times = [
      show.t,
      ...[...new Set(runs.filter((r) => r.t1 > show.t + EPS && r.t1 < hideAt).map((r) => r.t1))],
    ].sort((p1, p2) => p1 - p2);
    const { pool, total } = anchorPool(inf.leaves, own, times);
    const at0 = inf.leaves.map((l) => index.displacement(l.path, show.t));
    const pts = pool.map((q) => {
      const d = at0[q.leaf] as Vec3;
      return projection.project({ x: q.world.x + d.x, y: q.world.y + d.y, z: q.world.z + d.z });
    });
    // a node with part of its surface hidden is placed around what shows
    const shown0 = pts.length < total ? unionPoints(pts, bb) : bb;
    const start = preferred(vec);
    const leaderLen = (c: Rect): number =>
      pts.length === 0 ? 0 : Math.min(...pts.map((q) => toRect(q, c).d));
    let box: Rect | undefined;
    let best: { c: Rect; len: number } | undefined;
    for (let k = 0; k < 8 && box === undefined; k++) {
      const c = candidate(DIRS[(start + k) % 8] as (typeof DIRS)[number], shown0, w, hgt);
      if (placed.some((p) => overlaps(p, c)) || obstacles.some((o) => overlaps(o, c))) continue;
      const len = leaderLen(c);
      if (len <= MAX_LEADER) box = c;
      else if (best === undefined || len < best.len - EPS) best = { c, len };
    }
    box ??= best?.c;
    if (box === undefined) {
      const c = candidate(DIRS[start] as (typeof DIRS)[number], shown0, w, hgt);
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
    let leaderRect: Rect | undefined;
    let anchor: Vec2 | undefined;
    if (leaders) {
      let nearest: { d: number; from: Vec2; to: Vec2 } | undefined;
      for (const q of pts) {
        const n = toRect(q, box);
        if (nearest === undefined || n.d < nearest.d - EPS) nearest = { d: n.d, from: q, to: n.at };
      }
      // no sample at all (a node without solids): the closest points of the two boxes
      const cl = nearest === undefined ? closest(bb, box) : { a: nearest.from, b: nearest.to };
      anchor = { x: r(cl.a.x - sx), y: r(cl.a.y - sy) };
      kids.push(
        h("path", {
          class: `${P}-leader`,
          d: `M${fmt(cl.a.x - sx)} ${fmt(cl.a.y - sy)}L${fmt(cl.b.x - sx)} ${fmt(cl.b.y - sy)}`,
        }),
      );
      leaderRect = {
        x: Math.min(cl.a.x, cl.b.x),
        y: Math.min(cl.a.y, cl.b.y),
        width: Math.abs(cl.a.x - cl.b.x),
        height: Math.abs(cl.a.y - cl.b.y),
      };
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
    tracks.push({
      id,
      path,
      kind: "leader",
      motion,
      opacity: keys,
      initial: 0,
      ...(anchor === undefined ? {} : { anchor }),
    });
    // the label's boxes over its visible window: the part's track moves them (§10)
    const rest = [box, ...(leaderRect === undefined ? [] : [leaderRect])].map((q) => ({
      ...q,
      x: q.x - sx,
      y: q.y - sy,
    }));
    shown.push({ path, rest, motion, keys });
    const stamps = [...new Set([...motion.map((k) => k.t), ...keys.map((k) => k.t)])];
    for (const t of stamps) {
      const seen =
        evalOpacity(keys, t) > 0 ||
        evalOpacity(keys, t + 1e-3) > 0 ||
        evalOpacity(keys, t - 1e-3) > 0;
      if (!seen) continue;
      const o = evalOffset(motion, t);
      for (const q of rest) extents.push({ ...q, x: q.x + o.x, y: q.y + o.y });
    }
    const tf = translateOf(evalOffset(motion, 0));
    nodes.push(
      h(
        "g",
        { id, class: `${P}-plabel`, opacity: 0, ...(tf === undefined ? {} : { transform: tf }) },
        ...kids,
      ),
    );
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
    if (text === "" || faceW * 0.8 < fs2 * 2) {
      diagnostics.push({
        severity: "info",
        code: "assembly/label-omitted",
        path: "",
        message: `The label of part ${JSON.stringify(l.path)} (${JSON.stringify(label)}) is not drawn: its top face is too small for the text`,
        suggestion:
          "Raise the assembly's fit, enlarge the part, or label it with a leader (explode it with labels: show)",
        params: { part: l.path, label },
      });
      continue;
    }
    const id = `${ids.partLabel(l.path)}__top`;
    const chain = index.chain(l.path);
    // visible while the leaf is at its base pose: hidden between a move's start and the time
    // its displacement is back to the base value
    const opacity = restOpacity(chain, ctx.loop, (t) =>
      screenOf(projection, index.displacement(l.path, t)),
    );
    tracks.push({
      id,
      path: l.path,
      kind: "top",
      motion: [],
      opacity,
      initial: opacity[0]?.opacity ?? 1,
    });
    topLabels.set(
      l.path,
      h(
        "g",
        {
          id,
          class: `${P}-plabel`,
          ...((opacity[0]?.opacity ?? 1) < 1 ? { opacity: opacity[0]?.opacity ?? 1 } : {}),
        },
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
  const rectsUnder = (under: string, a: number, b: number): Rect[] => {
    const out: Rect[] = [];
    for (const e of shown) {
      if (e.path !== under && !e.path.startsWith(`${under}/`)) continue;
      const times = [
        a,
        b,
        ...[...e.motion.map((k) => k.t), ...e.keys.map((k) => k.t)].filter((t) => t > a && t < b),
      ];
      for (const t of times) {
        if (evalOpacity(e.keys, t) <= 0 && evalOpacity(e.keys, t + 1e-3) <= 0) continue;
        const o = evalOffset(e.motion, t);
        for (const q of e.rest) out.push({ ...q, x: q.x + o.x, y: q.y + o.y });
      }
    }
    return out;
  };
  return { nodes, tracks, extents, elements, top: topLabels, diagnostics, rectsUnder };
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
