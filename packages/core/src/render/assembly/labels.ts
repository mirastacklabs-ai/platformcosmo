/**
 * Labels, leaders and top-face labels of the assembly layer (docs/design/assemblies.md §6.6).
 *
 * Leader labels. A stage with `labels: "show"` shows the label of each moved node once it
 * arrives (fade in over the last 20% of its move); the label hides at the start of the reverse
 * move and when the loop closes. A labelled node no stage moves shows its label with the first
 * `labels: "show"` stage of its assembly and hides with the implode; it is placed after the
 * moved ones. Placement is computed once per node, at the pose it first shows in: eight
 * candidate boxes around the node's visible screen extent at 18 px (then at 36 and 54 px), preferring the side of its
 * screen motion vector, then clockwise. The first box that covers no other showing label (at its
 * pose then), no showing label's leader end and no other part's projected hull (carriers that
 * hold the node's own hull excepted) with a leader of at most 54 px wins, else the cheapest
 * (leader ends, crossings, labels, then parts and leader length). The leader is a 1 px line from an ANCHOR
 * to the label box: the sample of the node's visible surface (not behind another part along the
 * view ray, at the pose it shows in and at the end of each later stage while it is up; interior
 * of what shows when possible) nearest to the label, so it ends on the part's own geometry even
 * where its screen box is mostly empty or covered. The label group is authored in REST
 * coordinates and rides the node's total track.
 *
 * Occlusion is bounded: displaced primitive boxes are built once per time and shared, culled per
 * node to those whose screen rect overlaps the node's, and the sample x occluder tests of a build
 * are capped (`RAY_BUDGET`); beyond it a node is placed without occlusion (all of it in view).
 *
 * Top-face labels (`labels: "always"`): each labelled leaf's text upright on its projected top
 * face, truncated to fit, visible while the leaf is at its base pose.
 *
 * Deterministic: candidate order, obstacle order (leaf order) and rounding are fixed; nothing
 * depends on object identity.
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
import { viewDir } from "../../geometry/parts.js";
import { measureText } from "../../text/index.js";
import {
  boundsOf,
  clipArea,
  containsPoint,
  faceSamples,
  hullContains,
  hullOfBoxes,
  inflate,
  neighbours,
  rayHits,
  rectArea,
  rectsOverlap,
  segmentHitsRect,
  type Sample,
} from "./anchors.js";
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
/** Most poses (stage ends while a label is up) a placement is checked against. */
const MAX_POSES = 6;
/** Most surface samples considered per node. */
const MAX_SAMPLES = 1200;
/** Sample × occluder tests allowed over a whole build; beyond it nodes are placed without occlusion. */
/** Samples per face side of the retry grid for a node covered everywhere the coarse grid looked. */
const FINE_GRID = 8;
const RAY_BUDGET = 2_000_000;

/** `n` of the (sorted) values, evenly spaced by index, first and last included. */
function thin(values: readonly number[], n: number): number[] {
  return Array.from(
    { length: n },
    (_, k) => values[Math.round((k * (values.length - 1)) / (n - 1))] as number,
  );
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

function candidate(dir: (typeof DIRS)[number], bb: Rect, w: number, h2: number, gap = GAP): Rect {
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;
  const right = bb.x + bb.width + gap;
  const left = bb.x - gap - w;
  const top = bb.y - gap - h2;
  const bottom = bb.y + bb.height + gap;
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
  const view = viewDir(projection);
  const hollow = new Set(["ring", "tray", "sprite"]);
  const shiftOf = (v: Vec3, d: Vec3): Vec3 => ({ x: v.x + d.x, y: v.y + d.y, z: v.z + d.z });
  const project = (p: Vec3): Vec2 => projection.project(p);

  /** Displaced solid primitive boxes of every leaf at `t`, with their screen rects (shared). */
  interface Occ {
    readonly boxes: Box3[];
    readonly rects: Rect[];
    readonly owner: string[];
  }
  const occCache = new Map<number, Occ>();
  const occAt = (t: number): Occ => {
    let o = occCache.get(t);
    if (o === undefined) {
      o = { boxes: [], rects: [], owner: [] };
      for (const l of ctx.leaves) {
        const d = index.displacement(l.path, t);
        for (const p of l.geometry.primitives) {
          if (hollow.has(p.kind)) continue;
          const b: Box3 = { origin: shiftOf(p.box.origin, d), size: p.box.size };
          o.boxes.push(b);
          o.rects.push(projectBoxBounds(projection, b));
          o.owner.push(l.path);
        }
      }
      occCache.set(t, o);
    }
    return o;
  };
  /** Projected hulls of the leaves at `t`, built on demand (shared). */
  const hullCache = new Map<number, ({ hull: Vec2[]; rect: Rect } | undefined)[]>();
  const hullOf = (li: number, t: number): { hull: Vec2[]; rect: Rect } => {
    let all = hullCache.get(t);
    if (all === undefined) {
      all = [];
      hullCache.set(t, all);
    }
    let e = all[li];
    if (e === undefined) {
      const l = ctx.leaves[li] as WorldLeaf;
      const boxes = l.geometry.primitives.filter((p) => !hollow.has(p.kind)).map((p) => p.box);
      const hull = hullOfBoxes(
        boxes.length > 0 ? boxes : [l.geometry.bounds],
        project,
        index.displacement(l.path, t),
      );
      e = { hull, rect: boundsOf(hull) };
      all[li] = e;
    }
    return e;
  };

  /** Ray tests (samples × candidate occluders) still allowed in total: beyond, no occlusion. */
  let rayBudget = RAY_BUDGET;

  /**
   * Surface samples of `leaves` (rest pose) that are in view at the first of `times` and, among
   * those, in view at the most later times, preferring samples whose face neighbours are in view
   * too (not just under the edge of what covers them). When nothing is in view at all, `pool` is every sample.
   */
  const anchorPool = (
    leaves: readonly WorldLeaf[],
    own: ReadonlySet<string>,
    times: readonly number[],
  ): { pool: Sample[]; total: number } => {
    const prims = leaves.flatMap((l, i) =>
      l.geometry.primitives.filter((p) => p.kind !== "sprite").map((p) => ({ box: p.box, i })),
    );
    // decimated per primitive (never per face): coarser grids first, then fewer primitives
    const sampled = (n: number): Sample[] => {
      const stride = Math.max(1, Math.ceil((prims.length * 3 * n * n) / MAX_SAMPLES));
      const out: Sample[] = [];
      prims.forEach((p, k) => {
        if (k % stride === 0) faceSamples(p.box, p.i, n, out);
      });
      return out;
    };
    let all = sampled(
      prims.length * 27 <= MAX_SAMPLES ? 3 : prims.length * 12 <= MAX_SAMPLES ? 2 : 1,
    );
    const visibleAt = (t: number): boolean[] | undefined => {
      const occ = occAt(t);
      const d = leaves.map((l) => index.displacement(l.path, t));
      const nodeRect = unionRects(leaves.map((l) => leafBounds(l, t)));
      const near: number[] = [];
      occ.rects.forEach((r, k) => {
        if (!own.has(occ.owner[k] as string) && rectsOverlap(r, nodeRect)) near.push(k);
      });
      const cost = all.length * near.length;
      if (cost > rayBudget) return undefined;
      rayBudget -= cost;
      return all.map((q) => {
        const p = shiftOf(q.world, d[q.leaf] as Vec3);
        const sp = project(p);
        return !near.some(
          (k) => containsPoint(occ.rects[k] as Rect, sp) && rayHits(p, view, occ.boxes[k] as Box3),
        );
      });
    };
    let first = visibleAt(times[0] as number);
    if (first === undefined) return { pool: all, total: all.length };
    let idx = all.map((_, i) => i).filter((i) => (first as boolean[])[i]);
    if (idx.length === 0) {
      // covered everywhere the coarse grid looked: a fine grid finds what shows along the edges
      all = sampled(FINE_GRID);
      first = visibleAt(times[0] as number);
      idx = first === undefined ? [] : all.map((_, i) => i).filter((i) => (first as boolean[])[i]);
      // nothing shows at all: the anchor is on the (hidden) surface nearest the label
      if (idx.length === 0) return { pool: all, total: all.length };
    }
    const later: boolean[][] = [];
    for (const t of times.slice(1)) {
      const v = visibleAt(t);
      if (v === undefined) break;
      later.push(v);
    }
    const score = (i: number): number => later.filter((v) => v[i]).length;
    const top = Math.max(...idx.map(score));
    idx = idx.filter((i) => score(i) === top);
    const ok = new Set(idx);
    const inner = idx.filter((i) => neighbours(all[i] as Sample).every((j) => ok.has(j)));
    return {
      pool: (inner.length > 0 ? inner : idx).map((i) => all[i] as Sample),
      total: all.length,
    };
  };

  // ---- leader labels --------------------------------------------------------------------
  interface Event {
    readonly t: number;
    readonly kind: "in" | "out";
    readonly t1?: number;
  }
  interface Show {
    t: number;
    details: boolean;
    leaders: boolean;
  }
  const events = new Map<string, Event[]>();
  const firstShow = new Map<string, Show>();
  const addEvent = (path: string, e: Event): void => {
    const l = events.get(path);
    if (l === undefined) events.set(path, [e]);
    else l.push(e);
  };
  const noteShow = (path: string, run: StageRun, t: number): void => {
    const prev = firstShow.get(path);
    if (prev === undefined || t < prev.t) {
      firstShow.set(path, { t, details: run.stage.details, leaders: run.stage.leaders });
    } else if (run.stage.details && !prev.details) {
      firstShow.set(path, { ...prev, details: true });
    }
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
      noteShow(mv.path, run, mv.t1);
    }
  }
  // A labelled node that no stage moves (or moves only through an ancestor) shows its label
  // with the first `labels: show` stage of its assembly and hides with the implode, like the
  // moved ones (it is placed after them). A leaf of a `labels: always` assembly has its top-face
  // label instead.
  const moved = new Set(runs.flatMap((run) => run.moves.map((mv) => mv.path)));
  const unmoved = [...info.keys()].sort().filter((path) => {
    const inf = info.get(path) as NodeInfo;
    const leaf = inf.leaves.length === 1 && inf.leaves[0]?.path === path;
    return !moved.has(path) && !(leaf && ctx.labelMode(inf.assembly) === "always");
  });
  const omit = (path: string, why: string, suggestion: string): void => {
    const inf = info.get(path) as NodeInfo;
    diagnostics.push({
      severity: "info",
      code: "assembly/label-omitted",
      path: "",
      message: `The label of part ${JSON.stringify(path)} (${JSON.stringify(inf.label)}) is not drawn: ${why}`,
      suggestion,
      params: { part: path, label: inf.label },
    });
  };
  // an unmoved node under a labelled ancestor is named by that ancestor's label: no label of its own
  const statics: string[] = [];
  for (const path of unmoved) {
    const up = [...info.keys()]
      .filter((a) => path.startsWith(`${a}/`))
      .sort((x, y) => y.length - x.length)[0];
    if (up === undefined) statics.push(path);
    else
      omit(
        path,
        `it moves only as part of ${JSON.stringify(up)} (${JSON.stringify((info.get(up) as NodeInfo).label)}), whose label names it`,
        "Move it in a stage of its own to give it a leader label, or label only the group",
      );
  }
  const upState = new Map<string, boolean>();
  for (const run of [...runs].sort((a, b) => a.t0 - b.t0)) {
    const asm = run.assembly;
    if (run.kind === "implode") {
      if (upState.get(asm) === true) {
        for (const path of statics)
          if ((info.get(path) as NodeInfo).assembly === asm)
            addEvent(path, { t: run.t0, kind: "out" });
        upState.set(asm, false);
      }
      continue;
    }
    if (run.stage.labels !== "show" || upState.get(asm) === true) continue;
    upState.set(asm, true);
    const dur = run.t1 - run.t0;
    for (const path of statics) {
      if ((info.get(path) as NodeInfo).assembly !== asm) continue;
      addEvent(path, { t: r4(run.t1 - dur * FADE_FRACTION), kind: "in", t1: run.t1 });
      noteShow(path, run, run.t1);
    }
  }
  for (const path of statics) {
    if (firstShow.has(path)) continue;
    omit(
      path,
      "no stage moves it, and its assembly has no stage with labels: show to show it in",
      "Set labels: show on a stage, or set the assembly's labels to always to print it on its top face",
    );
  }

  interface Placed {
    readonly path: string;
    readonly box: Rect;
    readonly at: number;
    readonly anchor: Vec2 | undefined;
    /** The leader segment at the pose of `at` (anchor on the part to the box). */
    readonly leader: readonly [Vec2, Vec2] | undefined;
    keys: readonly OpacityKey[];
    /** Screen displacement of the node relative to its pose at `at`, by time (memo). */
    readonly shifts: Map<number, Vec2>;
  }
  const placed: Placed[] = [];
  /** Boxes, leader ends and leaders of the placed labels showing (even fading) at `t`, at their pose then. */
  const placedAt = (
    t: number,
  ): { boxes: Rect[]; anchors: Vec2[]; leaders: (readonly [Vec2, Vec2])[] } => {
    const boxes: Rect[] = [];
    const anchors: Vec2[] = [];
    const leaders: (readonly [Vec2, Vec2])[] = [];
    for (const p of placed) {
      if (evalOpacity(p.keys, t) <= 0) continue;
      let sh = p.shifts.get(t);
      if (sh === undefined) {
        const a = screenOf(projection, index.displacement(p.path, t));
        const b = screenOf(projection, index.displacement(p.path, p.at));
        sh = { x: a.x - b.x, y: a.y - b.y };
        p.shifts.set(t, sh);
      }
      boxes.push({ ...p.box, x: p.box.x + sh.x, y: p.box.y + sh.y });
      if (p.anchor !== undefined) anchors.push({ x: p.anchor.x + sh.x, y: p.anchor.y + sh.y });
      if (p.leader !== undefined) {
        const [a, b] = p.leader;
        leaders.push([
          { x: a.x + sh.x, y: a.y + sh.y },
          { x: b.x + sh.x, y: b.y + sh.y },
        ]);
      }
    }
    return { boxes, anchors, leaders };
  };

  const size = ctx.labelSize;
  const lineH = size * 1.25;
  const place = (path: string): void => {
    const inf = info.get(path) as NodeInfo;
    const show = firstShow.get(path) as Show;
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
    const pts = pool.map((q) => project(shiftOf(q.world, at0[q.leaf] as Vec3)));
    // a node with part of its surface hidden is placed around what shows
    const shown0 = pts.length < total ? unionPoints(pts, bb) : bb;
    // The label stays up while later stages move other parts (and itself): it must be clear of
    // them at each of those poses (`times`, thinned to `MAX_POSES`). Other parts count as their
    // projected hulls; carriers (hulls that hold the node's own) do not.
    const posed = times.length <= MAX_POSES ? times : thin(times, MAX_POSES);
    const base = screenOf(projection, index.displacement(path, show.t));
    const reach = inflate(shown0, 2 * GAP + Math.max(w, hgt));
    const poses = posed.map((t) => {
      const at = screenOf(projection, index.displacement(path, t));
      const shift = { x: at.x - base.x, y: at.y - base.y };
      const ownHull = hullOfBoxes(
        inf.leaves.flatMap((l) =>
          l.geometry.primitives
            .filter((p) => !hollow.has(p.kind))
            .map((p) => ({
              origin: shiftOf(p.box.origin, index.displacement(l.path, t)),
              size: p.box.size,
            })),
        ),
        project,
        { x: 0, y: 0, z: 0 },
      );
      const near = { ...reach, x: reach.x + shift.x, y: reach.y + shift.y };
      const hulls: { hull: Vec2[]; rect: Rect }[] = [];
      ctx.leaves.forEach((l, li) => {
        if (own.has(l.path)) return;
        const e = hullOf(li, t);
        if (!rectsOverlap(e.rect, near) || hullContains(e.hull, ownHull)) return;
        hulls.push(e);
      });
      return { shift, hulls, now: placedAt(t) };
    });
    const start = preferred(vec);
    /** The leader a candidate would have: nearest sample to the box, and the box point it meets. */
    const leaderOf = (c: Rect): { len: number; seg: readonly [Vec2, Vec2] | undefined } => {
      let nearest: { d: number; from: Vec2; to: Vec2 } | undefined;
      for (const q of pts) {
        const n = toRect(q, c);
        if (nearest === undefined || n.d < nearest.d - EPS) nearest = { d: n.d, from: q, to: n.at };
      }
      return nearest === undefined
        ? { len: 0, seg: undefined }
        : { len: nearest.d, seg: [nearest.from, nearest.to] };
    };
    // first free candidate in preference order; else the one covering the least
    let box: Rect | undefined;
    let bestCost = Infinity;
    let best: Rect | undefined;
    for (let k = 0; k < 24 && box === undefined; k++) {
      const gap = GAP * (1 + Math.floor(k / 8));
      const c = candidate(DIRS[(start + k) % 8] as (typeof DIRS)[number], shown0, w, hgt, gap);
      let labels = 0;
      let parts = 0;
      let covers = 0;
      let crosses = 0;
      const lead = leaderOf(c);
      for (const q of poses) {
        const cc = { ...c, x: c.x + q.shift.x, y: c.y + q.shift.y };
        // the leader must not cross a showing label, nor a showing leader this box
        if (leaders && lead.seg !== undefined) {
          const [a, b] = lead.seg;
          const sa = { x: a.x + q.shift.x, y: a.y + q.shift.y };
          const sb = { x: b.x + q.shift.x, y: b.y + q.shift.y };
          crosses += q.now.boxes.filter((bx) => segmentHitsRect(sa, sb, bx)).length;
        }
        crosses += q.now.leaders.filter(([a, b]) => segmentHitsRect(a, b, cc)).length;
        labels += q.now.boxes.reduce((sum, b) => sum + rectArea(b, cc), 0);
        for (const hu of q.hulls) if (rectsOverlap(hu.rect, cc)) parts += clipArea(hu.hull, cc);
        covers += q.now.anchors.filter((a) => containsPoint(cc, a)).length;
      }
      const len = lead.len;
      if (labels < 1 && parts < 1 && covers === 0 && crosses === 0 && len <= MAX_LEADER) {
        box = c;
        break;
      }
      const cost =
        1e6 * covers + 5000 * crosses + 50 * labels + parts + 20 * Math.max(0, len - MAX_LEADER);
      if (cost < bestCost - EPS) {
        bestCost = cost;
        best = c;
      }
    }
    box ??= best as Rect;
    extents.push(box, bb);
    // rest coordinates: subtract the node's displacement at the show pose
    const sx = mv.x;
    const sy = mv.y;
    const r = (n: number): number => Number(fmt(n));
    const kids: SvgNode[] = [];
    let leaderRect: Rect | undefined;
    let anchor: Vec2 | undefined;
    let anchorNow: Vec2 | undefined;
    let leaderNow: readonly [Vec2, Vec2] | undefined;
    if (leaders) {
      let nearest: { d: number; from: Vec2; to: Vec2 } | undefined;
      for (const q of pts) {
        const n = toRect(q, box);
        if (nearest === undefined || n.d < nearest.d - EPS) nearest = { d: n.d, from: q, to: n.at };
      }
      const cl = nearest === undefined ? closest(bb, box) : { a: nearest.from, b: nearest.to };
      anchorNow = cl.a;
      leaderNow = [cl.a, cl.b];
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
    placed.push({
      path,
      box,
      at: show.t,
      anchor: anchorNow,
      leader: leaderNow,
      keys,
      shifts: new Map(),
    });
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
  };
  const movedOrder = [...firstShow.keys()].filter((q) => !statics.includes(q)).sort();
  for (const path of [...movedOrder, ...statics.filter((q) => firstShow.has(q))]) place(path);

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
