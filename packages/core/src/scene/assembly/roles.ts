/**
 * Roles, `mates` and `inserts` inference for one group of siblings (Track A2, A2-2; design
 * docs/design/assemblies.md §5, §9.5, §17). Pure, deterministic (spec order breaks every tie) and
 * bounded: groups larger than `INFER_CAP` skip inference (explicit relations still apply), so
 * the quadratic scans stay within the build-time budget (§13).
 *
 * Boxes are in the assembly's local units, all in one frame (siblings share their parent's
 * frame), so contact tests need no scale.
 */
import type { PartRole } from "../../contracts/index.js";

/** Axis-aligned box as min/max corners (local units). */
export interface LBox {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
}

/** Tolerance of every contact and containment test (assemblies §9.5). */
export const EPS = 1e-6;
/** Sibling groups above this size skip inferred roles, mates and inserts. */
export const INFER_CAP = 400;

export interface RoleItem {
  /** Full scene path; the key of the result. */
  readonly path: string;
  readonly kind: "leaf" | "sub";
  readonly box: LBox;
  readonly type?: string;
  /** Spec shape (`tray`, `pack:id`, ...). */
  readonly shape?: string;
  /** Spec role, else the pack shape's role. */
  readonly role?: PartRole;
  /** A leaf whose geometry is `solid` (can enclose or be inserted into). */
  readonly solid: boolean;
  /** Scene paths of explicit `mates` / `inserts` targets that exist; others are dropped. */
  readonly mates?: string;
  readonly inserts?: string;
}

export interface RoleResult {
  readonly role: PartRole;
  readonly mates?: string;
  readonly inserts?: string;
}

const FASTENER = new Set([
  "screw",
  "bolt",
  "nut",
  "washer",
  "clip",
  "pin",
  "rivet",
  "fastener",
  "standoff",
]);
const CABLE = new Set(["cable", "wire", "hose", "ribbon", "cord", "harness"]);
const SHELL = new Set(["chassis", "housing", "enclosure", "case", "shell", "tray"]);
const COVER = new Set([
  "lid",
  "cover",
  "panel",
  "pan",
  "door",
  "cap",
  "hood",
  "bezel",
  "faceplate",
]);

const words = (it: RoleItem): Set<string> => {
  const out = new Set<string>();
  for (const s of [it.type, it.shape?.slice(it.shape.indexOf(":") + 1)]) {
    if (s !== undefined) for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) out.add(w);
  }
  return out;
};
const any = (w: ReadonlySet<string>, set: ReadonlySet<string>): boolean => {
  for (const x of w) if (set.has(x)) return true;
  return false;
};

const ext = (b: LBox): [number, number, number] => [b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0];
const lo = (b: LBox): [number, number, number] => [b.x0, b.y0, b.z0];
const hi = (b: LBox): [number, number, number] => [b.x1, b.y1, b.z1];
const volume = (b: LBox): number => {
  const [x, y, z] = ext(b);
  return x * y * z;
};

/** Overlap length of two intervals (negative: a gap). */
const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.min(a1, b1) - Math.max(a0, b0);

/** Area of the shared face when `a` and `b` touch along a plane (0 when they do not). */
export function contactArea(a: LBox, b: LBox): number {
  const al = lo(a);
  const ah = hi(a);
  const bl = lo(b);
  const bh = hi(b);
  let best = 0;
  for (let u = 0; u < 3; u++) {
    if (Math.abs(ah[u]! - bl[u]!) > EPS && Math.abs(bh[u]! - al[u]!) > EPS) continue;
    let area = 1;
    for (let v = 0; v < 3; v++) {
      if (v === u) continue;
      const o = overlap(al[v]!, ah[v]!, bl[v]!, bh[v]!);
      if (o <= EPS) {
        area = 0;
        break;
      }
      area *= o;
    }
    if (area > best) best = area;
  }
  return best;
}

/** Closed containment `a ⊆ b` (flush faces count). */
export function inside(a: LBox, b: LBox): boolean {
  return (
    a.x0 >= b.x0 - EPS &&
    a.y0 >= b.y0 - EPS &&
    a.z0 >= b.z0 - EPS &&
    a.x1 <= b.x1 + EPS &&
    a.y1 <= b.y1 + EPS &&
    a.z1 <= b.z1 + EPS
  );
}

/** Solids whose boxes share a face (or overlap) with positive area, not just an edge or corner. */
function touching(a: LBox, b: LBox): boolean {
  const al = lo(a);
  const ah = hi(a);
  const bl = lo(b);
  const bh = hi(b);
  let positive = 0;
  for (let u = 0; u < 3; u++) {
    const o = overlap(al[u]!, ah[u]!, bl[u]!, bh[u]!);
    if (o < -EPS) return false;
    if (o > EPS) positive++;
  }
  return positive >= 2;
}

/** Largest face area of a box (the contact area of an item buried in another). */
const largestFace = (b: LBox): number => {
  const [x, y, z] = ext(b);
  return Math.max(x * y, y * z, x * z);
};

interface Neighbour {
  /** Index of the neighbour in `items`. */
  readonly j: number;
  readonly area: number;
}

/** Neighbours of item `i` by (area desc, spec index): face contact, or `i` buried in `j`. */
function neighboursOf(items: readonly RoleItem[], i: number): Neighbour[] {
  const a = items[i] as RoleItem;
  const out: Neighbour[] = [];
  items.forEach((other, j) => {
    if (j === i) return;
    const area = contactArea(a.box, other.box);
    if (area > 0) out.push({ j, area });
    else if (inside(a.box, other.box) && volume(other.box) > volume(a.box) + EPS) {
      out.push({ j, area: largestFace(a.box) });
    }
  });
  return out.sort((p, q) => q.area - p.area || p.j - q.j);
}

/** The solid block faces a leaf crosses: `(block member, axis, side)`; used for `inserts`. */
function crossingInsert(
  items: readonly RoleItem[],
  i: number,
  blocks: number[][],
): string | undefined {
  const p = (items[i] as RoleItem).box;
  const pl = lo(p);
  const ph = hi(p);
  const found = new Set<number>();
  let crossings = 0;
  for (const members of blocks) {
    for (const m of members) {
      if (m === i) continue;
      const b = (items[m] as RoleItem).box;
      const bl = lo(b);
      const bh = hi(b);
      for (let u = 0; u < 3; u++) {
        for (const side of [0, 1] as const) {
          const plane = side === 0 ? bl[u]! : bh[u]!;
          // `p` spans the face plane strictly
          if (!(pl[u]! < plane - EPS && ph[u]! > plane + EPS)) continue;
          // footprint ⊥ u inside the face
          let within = true;
          for (let v = 0; v < 3; v++) {
            if (v === u) continue;
            if (pl[v]! < bl[v]! - EPS || ph[v]! > bh[v]! + EPS) within = false;
          }
          if (!within) continue;
          // the face is exterior: no other member of the block lies just beyond it
          const probe: [number, number, number] = [
            (pl[0]! + ph[0]!) / 2,
            (pl[1]! + ph[1]!) / 2,
            (pl[2]! + ph[2]!) / 2,
          ];
          probe[u] = plane + (side === 0 ? -1 : 1) * 4 * EPS;
          const covered = members.some((o) => {
            if (o === m || o === i) return false;
            const c = (items[o] as RoleItem).box;
            return (
              probe[0] >= c.x0 &&
              probe[0] <= c.x1 &&
              probe[1] >= c.y0 &&
              probe[1] <= c.y1 &&
              probe[2] >= c.z0 &&
              probe[2] <= c.z1
            );
          });
          if (covered) continue;
          crossings++;
          found.add(m);
        }
      }
    }
  }
  if (crossings !== 1 || found.size !== 1) return undefined;
  return (items[[...found][0] as number] as RoleItem).path;
}

/** Connected components of touching solid leaves, members in spec order, blocks by first member. */
function solidBlocks(items: readonly RoleItem[]): number[][] {
  const solids = items
    .map((it, k) => (it.kind === "leaf" && it.solid ? k : -1))
    .filter((k) => k >= 0);
  const parent = new Map<number, number>(solids.map((k) => [k, k]));
  const find = (k: number): number => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    return r;
  };
  for (let a = 0; a < solids.length; a++) {
    for (let b = a + 1; b < solids.length; b++) {
      const ka = solids[a] as number;
      const kb = solids[b] as number;
      if (touching((items[ka] as RoleItem).box, (items[kb] as RoleItem).box)) {
        const ra = find(ka);
        const rb = find(kb);
        if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (const k of solids) {
    const r = find(k);
    const g = groups.get(r);
    if (g === undefined) groups.set(r, [k]);
    else g.push(k);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
}

/** A thin part: its smallest extent is a quarter of the next one or less. */
function thinAxis(b: LBox): number | undefined {
  const e = ext(b);
  const order = [0, 1, 2].sort((p, q) => e[p]! - e[q]! || p - q);
  const [s, m] = order as [number, number, number];
  return e[s]! <= 0.25 * e[m]! + EPS && e[m]! > EPS ? s : undefined;
}

/**
 * Roles, `mates` and `inserts` of a sibling group, keyed by item path. Order of precedence:
 * spec value, pack-shape role, inference (§17: body = the part most others mate with, else the
 * largest; fasteners and cables by type; shells by shape; covers by type or as thin parts on the
 * outer bounds touching the body; everything else is `internal`).
 */
export function classifySiblings(items: readonly RoleItem[]): Map<string, RoleResult> {
  const out = new Map<string, RoleResult>();
  const infer = items.length <= INFER_CAP;
  const nb: Neighbour[][] = infer
    ? items.map((_, i) => neighboursOf(items, i))
    : items.map(() => []);

  // typed-away classes never become the body
  const typed = (it: RoleItem): PartRole | undefined => {
    const w = words(it);
    if (any(w, FASTENER)) return "fastener";
    if (any(w, CABLE)) return "cable";
    if (it.kind === "leaf" && (it.shape === "tray" || it.shape === "ring")) return "shell";
    if (any(w, SHELL)) return "shell";
    if (any(w, COVER)) return "cover";
    return undefined;
  };

  // body: explicit, else the most-mated-with candidate, else the largest
  let body = items.findIndex((it) => it.role === "body");
  if (body < 0) {
    const incoming = new Array<number>(items.length).fill(0);
    nb.forEach((list) => {
      const first = list[0];
      if (first !== undefined) incoming[first.j] = (incoming[first.j] ?? 0) + 1;
    });
    for (const it of items)
      if (it.mates !== undefined) {
        const j = items.findIndex((o) => o.path === it.mates);
        if (j >= 0) incoming[j] = (incoming[j] ?? 0) + 1;
      }
    let best = -1;
    items.forEach((it, i) => {
      if (it.role !== undefined || typed(it) !== undefined) return;
      if (
        best < 0 ||
        (incoming[i] as number) > (incoming[best] as number) ||
        (incoming[i] === incoming[best] &&
          volume(it.box) > volume((items[best] as RoleItem).box) + EPS)
      ) {
        best = i;
      }
    });
    body = best;
  }

  const bounds = infer && items.length > 0 ? unionLBox(items.map((it) => it.box)) : undefined;
  const blocks = infer ? solidBlocks(items) : [];

  items.forEach((it, i) => {
    // role
    let role: PartRole;
    if (it.role !== undefined) role = it.role;
    else if (i === body) role = "body";
    else {
      const t = typed(it);
      if (t !== undefined) role = t;
      else if (
        infer &&
        body >= 0 &&
        bounds !== undefined &&
        isThinCover(it.box, (items[body] as RoleItem).box, bounds)
      ) {
        role = "cover";
      } else role = "internal";
    }

    // mates: explicit, else the body when in contact, else the best neighbour
    let mates = it.mates;
    if (mates === undefined && infer && i !== body) {
      const list = nb[i] as Neighbour[];
      const hit = list.find((n) => n.j === body) ?? list[0];
      if (hit !== undefined) {
        // mutual best partners: only the smaller one mates (a lid on a tray, not the reverse)
        const other = (nb[hit.j] as Neighbour[])[0];
        const vi = volume(it.box);
        const vj = volume((items[hit.j] as RoleItem).box);
        const holder = other?.j === i && (vi > vj + EPS || (Math.abs(vi - vj) <= EPS && i < hit.j));
        if (!holder) mates = (items[hit.j] as RoleItem).path;
      }
    }

    // inserts: explicit, else exactly one face plane of exactly one solid block
    let inserts = it.inserts;
    if (inserts === undefined && infer && it.kind === "leaf")
      inserts = crossingInsert(items, i, blocks);

    out.set(it.path, {
      role,
      ...(mates === undefined ? {} : { mates }),
      ...(inserts === undefined ? {} : { inserts }),
    });
  });
  return out;
}

function unionLBox(boxes: readonly LBox[]): LBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    z0 = Math.min(z0, b.z0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1);
    z1 = Math.max(z1, b.z1);
  }
  return { x0, y0, z0, x1, y1, z1 };
}

/** Thin, on the outer bounds along its thin axis, and its largest face touches the body. */
function isThinCover(b: LBox, body: LBox, bounds: LBox): boolean {
  const u = thinAxis(b);
  if (u === undefined) return false;
  const bl = lo(b);
  const bh = hi(b);
  const ol = lo(bounds);
  const oh = hi(bounds);
  const outer = Math.abs(bl[u]! - ol[u]!) <= EPS || Math.abs(bh[u]! - oh[u]!) <= EPS;
  if (!outer) return false;
  // contact with the body on a plane ⊥ u
  const cl = lo(body);
  const ch = hi(body);
  if (Math.abs(bh[u]! - cl[u]!) > EPS && Math.abs(ch[u]! - bl[u]!) > EPS) return false;
  for (let v = 0; v < 3; v++) {
    if (v !== u && overlap(bl[v]!, bh[v]!, cl[v]!, ch[v]!) <= EPS) return false;
  }
  return true;
}
