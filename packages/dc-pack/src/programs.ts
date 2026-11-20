/**
 * Explode programs of a rack in assembly mode (assemblies.md 6, 8.1, 8.2; Track E-1).
 *
 * The A2 planner resolves programs of spec assemblies; a rack is built by the DC pack, so its
 * programs (the built-in `drawers`, the slot `internals`, a rack's own `programs`) are resolved
 * here, over the same rules for the subset a rack needs:
 *  - selectors (6.1): owner-scoped, `scope/term`, `**`, `tag:` / `type:` / `role:`, `except`;
 *  - directions (6.2): axes, `up`, `down`, `drawer`, `out`, `radial`, `lift`, vectors;
 *    `away` and `axis` fall back to `out` (no contact analysis in a rack);
 *  - distances (6.3): numbers, `auto`, `<k>x`, stacking by direction, clearance of static parts,
 *    the full exit of the unit for `drawer`;
 *  - timing (6.4, 7.1): stagger orders, `delay`, `with`, per-part overrides.
 * Geometry is in the rack's local millimetres (world axes, a mirrored row already turned); moves
 * are returned in world tiles.
 * Pure and deterministic: spec order and stable sorts everywhere, bounded work, never throws.
 */
import { didYouMean } from "@platformcosmo/core";
import type {
  Diagnostic,
  PartMove,
  ResolvedExplodeProgram,
  ResolvedStage,
  SceneAssemblyNode,
  SpecDirection,
  SpecDistance,
  SpecEasing,
  SpecStage,
  Vec3,
} from "@platformcosmo/core";

export const EPS = 1e-6;
const MM = 600;
const MAX_CANDIDATES = 4096;
const MAX_SELECTORS = 64;
const MAX_SEGMENTS = 8;
const MAX_STAGES = 32;
/** Stacking and clearance are quadratic: past this many movers the pairwise terms are skipped. */
const MAX_PAIRWISE = 600;
/** Static parts considered by the clearance test. */
const MAX_STATICS = 4096;

const rnd = (v: number): number => Math.round(v * 1e9) / 1e9 + 0;

export interface MBox {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
}

/** A node of the program owner's subtree, in rack-local millimetres. */
export interface PNode {
  readonly path: string;
  readonly id: string;
  readonly leaf: boolean;
  readonly role: string;
  readonly type?: string;
  readonly tags: readonly string[];
  readonly box: MBox;
  readonly children: readonly PNode[];
}

/** A stage as the resolver reads it: the spec stage plus the pack's own `leaveOwner` flag. */
export interface StageIn extends Omit<SpecStage, "parts" | "except"> {
  readonly parts: readonly string[];
  readonly except?: readonly string[];
  /** Any axis direction clears the whole owner, as `drawer` does (the rack's rear doors). */
  readonly leaveOwner?: boolean;
}

export interface ProgramIn {
  readonly id: string;
  readonly label?: string;
  readonly gap?: number;
  readonly stages: readonly StageIn[];
  /** JSON pointer of the program, for diagnostics (empty for built-ins). */
  readonly ptr: string;
}

export interface ProgramEnv {
  /** Path of the program owner. */
  readonly owner: PNode;
  /** Paths (subtrees) never selected and never obstacles (the pack's own tray, lid, ...). */
  readonly exclude: ReadonlySet<string>;
  /** Unit vector of the owner's front (`drawer`): `(0, 1, 0)`, or `(0, -1, 0)` in a mirrored row. */
  readonly front: Vec3;
}

export interface ResolveResult {
  readonly program: ResolvedExplodeProgram;
  /** Total local displacement (mm) of each moved node. */
  readonly shifts: ReadonlyMap<string, Vec3>;
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------------------------

/** The node tree under `owner` for the resolver. */
export function toPNode(n: SceneAssemblyNode): PNode {
  const b = n.local;
  return {
    path: n.path,
    id: n.id,
    leaf: n.kind === "leaf",
    role: n.role,
    ...(n.type === undefined ? {} : { type: n.type }),
    tags: n.tags,
    box: {
      x0: b.origin.x,
      y0: b.origin.y,
      z0: b.origin.z,
      x1: b.origin.x + b.size.x,
      y1: b.origin.y + b.size.y,
      z1: b.origin.z + b.size.z,
    },
    children: n.children.map(toPNode),
  };
}

function globMatch(pat: string, s: string): boolean {
  let p = 0;
  let i = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (p < pat.length && pat[p] === "*") {
      star = p++;
      mark = i;
    } else if (p < pat.length && (pat[p] === "?" || pat[p] === s[i])) {
      p++;
      i++;
    } else if (star >= 0) {
      p = star + 1;
      i = ++mark;
    } else return false;
  }
  while (p < pat.length && pat[p] === "*") p++;
  return p === pat.length;
}

interface Selector {
  readonly scopes: readonly string[];
  readonly term: string;
}

function parseSelector(s: unknown): Selector | undefined {
  if (typeof s !== "string" || s.length === 0 || s.length > 256) return undefined;
  const segs = s.split("/");
  if (segs.length > MAX_SEGMENTS || segs.some((x) => x.length === 0)) return undefined;
  return { scopes: segs.slice(0, -1), term: segs[segs.length - 1] as string };
}

function scopeMatch(sc: readonly string[], i: number, pre: readonly string[], j: number): boolean {
  if (i === sc.length) return j === pre.length;
  const s = sc[i] as string;
  if (s === "**") {
    for (let k = j; k <= pre.length; k++) if (scopeMatch(sc, i + 1, pre, k)) return true;
    return false;
  }
  return j < pre.length && globMatch(s, pre[j] as string) && scopeMatch(sc, i + 1, pre, j + 1);
}

function termMatch(term: string, n: PNode): boolean {
  if (term === "**") return true;
  const m = /^(tag|type|role):(.+)$/.exec(term);
  if (m === null) return globMatch(term, n.id);
  const g = m[2] as string;
  if (m[1] === "tag") return n.tags.some((t) => globMatch(g, t));
  if (m[1] === "type") return n.type !== undefined && globMatch(g, n.type);
  return globMatch(g, n.role);
}

interface Cand {
  readonly node: PNode;
  /** Ids from the owner's child down to the node's parent. */
  readonly pre: readonly string[];
  readonly index: number;
}

/** Descendants of the owner in depth-first spec order (bounded; `exclude` subtrees skipped). */
function candidates(env: ProgramEnv): { list: Cand[]; truncated: boolean } {
  const list: Cand[] = [];
  let truncated = false;
  const walk = (n: PNode, pre: readonly string[]): void => {
    for (const c of n.children) {
      if (env.exclude.has(c.path)) continue;
      if (list.length >= MAX_CANDIDATES) {
        truncated = true;
        return;
      }
      list.push({ node: c, pre, index: list.length });
      walk(c, [...pre, c.id]);
    }
  };
  walk(env.owner, []);
  return { list, truncated };
}

function select(cands: readonly Cand[], selectors: readonly Selector[]): Cand[] {
  return cands.filter((c) =>
    selectors.some((s) => scopeMatch(s.scopes, 0, c.pre, 0) && termMatch(s.term, c.node)),
  );
}

// ---------------------------------------------------------------------------------------------
// Directions and distances
// ---------------------------------------------------------------------------------------------

interface Dir {
  readonly u: Vec3;
  readonly lift: boolean;
  readonly drawer: boolean;
}

const AXES: Readonly<Record<string, Vec3>> = {
  up: { x: 0, y: 0, z: 1 },
  "+z": { x: 0, y: 0, z: 1 },
  down: { x: 0, y: 0, z: -1 },
  "-z": { x: 0, y: 0, z: -1 },
  "+x": { x: 1, y: 0, z: 0 },
  "-x": { x: -1, y: 0, z: 0 },
  "+y": { x: 0, y: 1, z: 0 },
  "-y": { x: 0, y: -1, z: 0 },
};

const centre = (b: MBox): Vec3 => ({
  x: (b.x0 + b.x1) / 2,
  y: (b.y0 + b.y1) / 2,
  z: (b.z0 + b.z1) / 2,
});

function direction(d: SpecDirection | undefined, node: PNode, owner: PNode, front: Vec3): Dir {
  const dir = d ?? "away";
  if (Array.isArray(dir)) {
    const [x, y, z] = [Number(dir[0]), Number(dir[1]), Number(dir[2])];
    const len = Math.hypot(x, y, z);
    if (!(len > 0) || !Number.isFinite(len))
      return { u: AXES["up"] as Vec3, lift: false, drawer: false };
    const u = { x: x / len, y: y / len, z: z / len };
    return { u, lift: false, drawer: false };
  }
  if (dir === "drawer") return { u: front, lift: false, drawer: true };
  if (dir === "lift") return { u: AXES["up"] as Vec3, lift: true, drawer: false };
  const axis = AXES[dir];
  if (axis !== undefined) return { u: axis, lift: false, drawer: false };
  // out (also away and axis): the horizontal axis with the larger |c|; radial: the unit c
  const c = centre(node.box);
  const o = centre(owner.box);
  const cx = c.x - o.x;
  const cy = c.y - o.y;
  if (dir === "radial") {
    const len = Math.hypot(cx, cy);
    return len > EPS
      ? { u: { x: cx / len, y: cy / len, z: 0 }, lift: false, drawer: false }
      : { u: AXES["up"] as Vec3, lift: false, drawer: false };
  }
  if (Math.abs(cx) < EPS && Math.abs(cy) < EPS) {
    return { u: AXES["up"] as Vec3, lift: false, drawer: false };
  }
  const u =
    Math.abs(cx) > Math.abs(cy) + EPS
      ? (AXES[cx < 0 ? "-x" : "+x"] as Vec3)
      : (AXES[cy < 0 ? "-y" : "+y"] as Vec3);
  return { u, lift: false, drawer: false };
}

/** The single signed axis of a unit vector, if it is axis-aligned. */
function axisOf(u: Vec3): { readonly k: "x" | "y" | "z"; readonly s: 1 | -1 } | undefined {
  const parts = (["x", "y", "z"] as const).filter((k) => Math.abs(u[k]) > EPS);
  if (parts.length !== 1) return undefined;
  const k = parts[0] as "x" | "y" | "z";
  return { k, s: u[k] > 0 ? 1 : -1 };
}

/** Interval of a box along a signed axis. */
function span(b: MBox, k: "x" | "y" | "z", s: 1 | -1): { lo: number; hi: number } {
  const lo = b[`${k}0` as "x0"];
  const hi = b[`${k}1` as "x1"];
  return s === 1 ? { lo, hi } : { lo: -hi, hi: -lo };
}

function overlapsPerp(a: MBox, b: MBox, k: "x" | "y" | "z"): boolean {
  return (["x", "y", "z"] as const)
    .filter((q) => q !== k)
    .every(
      (q) =>
        a[`${q}0` as "x0"] < b[`${q}1` as "x1"] - EPS &&
        b[`${q}0` as "x0"] < a[`${q}1` as "x1"] - EPS,
    );
}

function parseK(distance: SpecDistance | undefined): { n?: number; k: number } {
  if (typeof distance === "number") {
    return { n: Number.isFinite(distance) ? Math.max(0, distance) : 0, k: 1 };
  }
  if (typeof distance === "string") {
    const m = /^(\d+(?:\.\d+)?)x$/.exec(distance);
    if (m !== null) return { k: Math.min(100, Number(m[1])) };
  }
  return { k: 1 };
}

const isDescendant = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

// ---------------------------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------------------------

interface Mover {
  readonly stage: number;
  readonly cand: Cand;
  readonly dir: Dir;
  readonly dist: ReturnType<typeof parseK>;
  /** Distance along `dir.u`, mm. */
  d: number;
}

export function resolveProgram(prog: ProgramIn, env: ProgramEnv): ResolveResult {
  const diagnostics: Diagnostic[] = [];
  const cap = (d: Diagnostic): void => {
    if (diagnostics.length < 50) diagnostics.push(d);
  };
  const { list: cands } = candidates(env);
  const owner = env.owner;
  const ob = owner.box;
  const extent = Math.max(ob.x1 - ob.x0, ob.y1 - ob.y0, ob.z1 - ob.z0);
  const gap = prog.gap !== undefined && prog.gap >= 0 ? prog.gap : extent * 0.1;
  const stagesIn = prog.stages.slice(0, MAX_STAGES);

  // ---- pass 1: selection ----
  const moved = new Set<string>();
  const perStage: Mover[][] = [];
  for (let si = 0; si < stagesIn.length; si++) {
    const st = stagesIn[si] as StageIn;
    const ptr = `${prog.ptr}/stages/${si}`;
    const sel = (xs: readonly unknown[] | undefined): Selector[] =>
      (xs ?? [])
        .slice(0, MAX_SELECTORS)
        .map(parseSelector)
        .filter((s): s is Selector => s !== undefined);
    const chosen = select(cands, sel(st.parts));
    const drop = new Set(select(cands, sel(st.except)).map((c) => c.node.path));
    const picked = chosen.filter((c) => !drop.has(c.node.path));
    if (picked.length === 0) {
      const hint = didYouMean(
        String(st.parts[0] ?? ""),
        cands.slice(0, 256).map((c) => [...c.pre, c.node.id].join("/")),
      );
      cap({
        severity: "warning",
        code: "assembly/selector-empty",
        path: `${ptr}/parts`,
        message: `Stage ${si + 1} of "${prog.id}" selects no part.`,
        ...(hint === undefined ? {} : { suggestion: hint }),
      });
    }
    const chosenPaths = new Set(picked.map((c) => c.node.path));
    const hasAncestor = (p: string): boolean => {
      let q = p;
      for (;;) {
        const i = q.lastIndexOf("/");
        if (i <= owner.path.length) return false;
        q = q.slice(0, i);
        if (chosenPaths.has(q)) return true;
      }
    };
    const movers: Mover[] = [];
    for (const c of picked) {
      if (hasAncestor(c.node.path)) continue; // moves with its selected ancestor
      if (moved.has(c.node.path)) {
        cap({
          severity: "error",
          code: "assembly/moved-twice",
          path: `${ptr}/parts`,
          message: `"${c.node.path}" is moved by two stages of "${prog.id}".`,
          params: { part: c.node.path },
        });
        continue;
      }
      moved.add(c.node.path);
      const rel = [...c.pre, c.node.id].join("/");
      const ov = st.overrides?.[rel];
      const dir = direction(ov?.direction ?? st.direction, c.node, owner, env.front);
      const drawerDir = st.leaveOwner === true ? { ...dir, drawer: true } : dir;
      movers.push({
        stage: si,
        cand: c,
        dir: drawerDir,
        dist: parseK(ov?.distance ?? st.distance),
        d: 0,
      });
    }
    perStage.push(movers);
  }

  // ---- pass 2: distances (per program, grouped by direction) ----
  const all = perStage.flat();
  const moverPaths = new Set(all.map((m) => m.cand.node.path));
  const statics: PNode[] = [];
  const collect = (n: PNode): void => {
    if (env.exclude.has(n.path)) return;
    if (moverPaths.has(n.path)) return;
    if (n.leaf) {
      if (statics.length < MAX_STATICS) statics.push(n);
      return;
    }
    for (const c of n.children) collect(c);
  };
  for (const c of owner.children) collect(c);
  const pairwise = all.length <= MAX_PAIRWISE;
  const groups = new Map<string, Mover[]>();
  for (const m of all) {
    const key = `${rnd(m.dir.u.x)},${rnd(m.dir.u.y)},${rnd(m.dir.u.z)}|${m.dir.lift ? 1 : 0}`;
    const g = groups.get(key);
    if (g === undefined) groups.set(key, [m]);
    else g.push(m);
  }
  for (const group of groups.values()) {
    const first = group[0] as Mover;
    const ax = axisOf(first.dir.u);
    if (ax === undefined) {
      for (const m of group) {
        if (m.dist.n !== undefined) m.d = m.dist.n;
        else {
          const b = m.cand.node.box;
          const e =
            Math.abs(m.dir.u.x) * (b.x1 - b.x0) +
            Math.abs(m.dir.u.y) * (b.y1 - b.y0) +
            Math.abs(m.dir.u.z) * (b.z1 - b.z0);
          m.d = m.dist.k * (e + gap);
        }
      }
      continue;
    }
    const sp = (m: Mover): { lo: number; hi: number } => span(m.cand.node.box, ax.k, ax.s);
    const sorted = [...group].sort((p, q) => {
      const a = sp(p);
      const b = sp(q);
      return a.hi - b.hi || a.lo - b.lo || (p.cand.node.path < q.cand.node.path ? -1 : 1);
    });
    const done: Mover[] = [];
    for (const m of sorted) {
      const { lo, hi } = sp(m);
      if (m.dist.n !== undefined) m.d = m.dist.n;
      else {
        let clear = hi - lo + gap;
        if (m.dir.drawer) clear = Math.max(clear, span(ob, ax.k, ax.s).hi - lo + gap);
        if (pairwise) {
          for (const e of statics) {
            if (!overlapsPerp(m.cand.node.box, e.box, ax.k)) continue;
            const eh = span(e.box, ax.k, ax.s).hi;
            if (eh > lo + EPS) clear = Math.max(clear, eh - lo + gap);
          }
        }
        let d = m.dist.k * clear;
        if (pairwise) {
          for (const q of done) {
            if (isDescendant(q.cand.node.path, m.cand.node.path)) continue;
            const qs = sp(q);
            const counts = m.dir.lift
              ? Math.abs(qs.lo - lo) > EPS
              : overlapsPerp(q.cand.node.box, m.cand.node.box, ax.k);
            if (counts) d = Math.max(d, qs.hi + q.d + gap - lo);
          }
        }
        m.d = Math.max(0, d);
      }
      done.push(m);
    }
  }

  // ---- pass 3: timing ----
  const shifts = new Map<string, Vec3>();
  const stages: ResolvedStage[] = [];
  let prevS = 0;
  let prevE = 0;
  const oc = centre(ob);
  const worldKey = (b: MBox): number => {
    const c = centre(b);
    return c.x + c.y + c.z;
  };
  for (let si = 0; si < stagesIn.length; si++) {
    const st = stagesIn[si] as StageIn;
    const S = (si > 0 && st.with === "previous" ? prevS : prevE) + (st.delay ?? 0);
    const dur = st.duration !== undefined && st.duration > 0 ? st.duration : 0.8;
    const stagger = st.stagger !== undefined && st.stagger >= 0 ? st.stagger : 0.08;
    const easing: SpecEasing = st.easing ?? "ease-in-out";
    const key = (m: Mover): number => {
      const b = m.cand.node.box;
      switch (st.order ?? "spec") {
        case "outside-in":
          return -Math.hypot(centre(b).x - oc.x, centre(b).y - oc.y, centre(b).z - oc.z);
        case "inside-out":
          return Math.hypot(centre(b).x - oc.x, centre(b).y - oc.y, centre(b).z - oc.z);
        case "top-down":
          return -b.z1;
        case "bottom-up":
          return b.z0;
        case "front-first":
          return -worldKey(b);
        case "back-first":
          return worldKey(b);
        default:
          return m.cand.index;
      }
    };
    const ovOrder = (m: Mover): number => {
      const rel = [...m.cand.pre, m.cand.node.id].join("/");
      return st.overrides?.[rel]?.order ?? 0;
    };
    const ranked = [...(perStage[si] ?? [])].sort(
      (p, q) =>
        ovOrder(p) - ovOrder(q) ||
        key(p) - key(q) ||
        (p.cand.node.path < q.cand.node.path ? -1 : p.cand.node.path > q.cand.node.path ? 1 : 0),
    );
    const moves: PartMove[] = [];
    let E = S;
    ranked.forEach((m, r) => {
      const rel = [...m.cand.pre, m.cand.node.id].join("/");
      const start = rnd(S + r * stagger + (st.overrides?.[rel]?.delay ?? 0));
      const local = { x: m.dir.u.x * m.d, y: m.dir.u.y * m.d, z: m.dir.u.z * m.d };
      shifts.set(m.cand.node.path, local);
      moves.push({
        path: m.cand.node.path,
        offset: {
          x: rnd(local.x / MM),
          y: rnd(local.y / MM),
          z: rnd(local.z / MM),
        },
        start,
        duration: rnd(dur),
        easing,
      });
      E = Math.max(E, start + dur);
    });
    moves.sort((a, b) => a.start - b.start || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    stages.push({
      index: si + 1,
      ...(st.label === undefined ? {} : { label: st.label }),
      moves,
      start: rnd(S),
      end: rnd(E),
      labels: st.labels ?? "show",
      leaders: st.leaders ?? true,
      details: st.details ?? false,
      fade: st.fade ?? "none",
    });
    prevS = S;
    prevE = E;
  }

  return {
    program: {
      kind: "explode",
      id: prog.id,
      owner: owner.path,
      ...(prog.label === undefined ? {} : { label: prog.label }),
      stages,
    },
    shifts,
    diagnostics,
  };
}
