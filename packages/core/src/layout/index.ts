/**
 * Layered left-to-right layout on the iso grid (Track A2).
 *
 * Coordinates are node-area local tiles: `x` = layer axis, `y` = stacking axis. The scene builder
 * adds the node-area origin. Algorithm, per container (the root, or a group):
 *   1. items = direct auto-placed nodes + child groups (each laid out first, recursively, as a block);
 *   2. edges between nodes are lifted to the items containing them;
 *   3. cycles are broken by DFS back-edge removal; longest-path layering;
 *   4. barycenter crossing reduction (deterministic, stable);
 *   5. columns by layer, rows centered; group blocks get padding.
 * Nodes with a manual `pos` are fixed and exempt from packing; root-level items are pushed off them.
 */
import { footprintOf } from "../scene/sizes.js";
import type { SpecEdge, SpecGroup, SpecNode } from "../schema/types.gen.js";

export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  d: number;
}

export interface LayoutResult {
  /** Node id → footprint rect (node-area local tiles). */
  readonly nodes: ReadonlyMap<string, LayoutRect>;
  /** Group id → footprint rect, parents enclose children and members. */
  readonly groups: ReadonlyMap<string, LayoutRect>;
}

export const GAP_X = 3;
export const GAP_Y = 2;
export const GROUP_PAD = 1;

const snap = (v: number): number => Math.round(v * 2) / 2;

interface Item {
  kind: "node" | "group";
  id: string;
  w: number;
  d: number;
  /** Local rects of everything inside (relative to the item's own origin). */
  nodes: Map<string, LayoutRect>;
  groups: Map<string, LayoutRect>;
}

interface Spec {
  nodes: readonly SpecNode[];
  groups: readonly SpecGroup[];
  edges: readonly SpecEdge[];
}

function intersects(a: LayoutRect, b: LayoutRect, margin = 0): boolean {
  return (
    a.x < b.x + b.w + margin &&
    b.x < a.x + a.w + margin &&
    a.y < b.y + b.d + margin &&
    b.y < a.y + a.d + margin
  );
}

export function layoutSpec(spec: Spec): LayoutResult {
  const groupIds = new Set(spec.groups.map((g) => g.id));
  // Parent chain for every node/group (cycles are rejected by validate; guard anyway).
  const parentOfGroup = new Map<string, string | undefined>();
  for (const g of spec.groups) {
    parentOfGroup.set(
      g.id,
      g.parent !== undefined && groupIds.has(g.parent) ? g.parent : undefined,
    );
  }
  const nodeGroup = new Map(
    spec.nodes.map((n) => [
      n.id,
      n.group !== undefined && groupIds.has(n.group) ? n.group : undefined,
    ]),
  );

  const childNodes = new Map<string | undefined, SpecNode[]>();
  for (const n of spec.nodes) {
    if (n.pos !== undefined) continue;
    const k = nodeGroup.get(n.id);
    const list = childNodes.get(k) ?? [];
    list.push(n);
    childNodes.set(k, list);
  }
  const childGroups = new Map<string | undefined, SpecGroup[]>();
  for (const g of spec.groups) {
    const k = parentOfGroup.get(g.id);
    const list = childGroups.get(k) ?? [];
    list.push(g);
    childGroups.set(k, list);
  }

  // Groups that are part of a parent cycle never get a block (validate rejects such specs);
  // they are skipped so layout still terminates.
  const reachable = new Set<string>();
  const markReach = (parent: string | undefined, depth: number): void => {
    if (depth > spec.groups.length + 1) return;
    for (const g of childGroups.get(parent) ?? []) {
      if (reachable.has(g.id)) continue;
      reachable.add(g.id);
      markReach(g.id, depth + 1);
    }
  };
  markReach(undefined, 0);

  const blockCache = new Map<string, Item>();
  const anchored = new Set<string>();

  function layoutContainer(
    containerId: string | undefined,
    pad: number,
    fixed: readonly LayoutRect[],
  ): Item {
    const items: Item[] = [];
    for (const n of childNodes.get(containerId) ?? []) {
      const f = footprintOf(n);
      items.push({
        kind: "node",
        id: n.id,
        w: f,
        d: f,
        nodes: new Map([[n.id, { x: 0, y: 0, w: f, d: f }]]),
        groups: new Map(),
      });
    }
    for (const g of childGroups.get(containerId) ?? []) {
      if (!reachable.has(g.id) || anchored.has(g.id)) continue;
      let b = blockCache.get(g.id);
      if (!b) {
        b = layoutContainer(g.id, GROUP_PAD, []);
        const self: LayoutRect = { x: 0, y: 0, w: b.w, d: b.d };
        b = { ...b, kind: "group", id: g.id, groups: new Map(b.groups).set(g.id, self) };
        blockCache.set(g.id, b);
      }
      items.push(b);
    }

    // Item index per auto node within this container.
    const itemOfNode = new Map<string, number>();
    items.forEach((it, idx) => {
      if (it.kind === "node") itemOfNode.set(it.id, idx);
      else for (const nid of it.nodes.keys()) itemOfNode.set(nid, idx);
    });

    // Lifted, de-duplicated edges between distinct items.
    const seenEdge = new Set<string>();
    const lifted: [number, number][] = [];
    for (const e of spec.edges) {
      const a = itemOfNode.get(e.from);
      const b = itemOfNode.get(e.to);
      if (a === undefined || b === undefined || a === b) continue;
      const key = `${a}>${b}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      lifted.push([a, b]);
    }

    const n = items.length;
    const succ: number[][] = Array.from({ length: n }, () => []);
    for (const [a, b] of lifted) succ[a]!.push(b);
    // Break cycles: iterative DFS, drop back edges.
    const state = new Array<number>(n).fill(0);
    const dag: number[][] = Array.from({ length: n }, () => []);
    const visit = (root: number): void => {
      const stack: { v: number; i: number }[] = [{ v: root, i: 0 }];
      state[root] = 1;
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        const outs = succ[top.v]!;
        if (top.i < outs.length) {
          const w = outs[top.i++]!;
          if (state[w] === 1) continue; // back edge
          dag[top.v]!.push(w);
          if (state[w] === 0) {
            state[w] = 1;
            stack.push({ v: w, i: 0 });
          }
        } else {
          state[top.v] = 2;
          stack.pop();
        }
      }
    };
    for (let i = 0; i < n; i++) if (state[i] === 0) visit(i);

    // Longest-path layering (Kahn, index order).
    const indeg = new Array<number>(n).fill(0);
    for (let v = 0; v < n; v++) for (const w of dag[v]!) indeg[w]!++;
    const layer = new Array<number>(n).fill(0);
    const queue: number[] = [];
    for (let v = 0; v < n; v++) if (indeg[v] === 0) queue.push(v);
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi]!;
      for (const w of dag[v]!) {
        layer[w] = Math.max(layer[w]!, layer[v]! + 1);
        if (--indeg[w]! === 0) queue.push(w);
      }
    }
    const nLayers = n === 0 ? 0 : Math.max(...layer) + 1;
    const columns: number[][] = Array.from({ length: nLayers }, () => []);
    for (let v = 0; v < n; v++) columns[layer[v]!]!.push(v);

    // Crossing reduction: barycenter sweeps over all (kept) edges.
    const neigh: number[][] = Array.from({ length: n }, () => []);
    for (let v = 0; v < n; v++) {
      for (const w of dag[v]!) {
        neigh[v]!.push(w);
        neigh[w]!.push(v);
      }
    }
    const order = new Array<number>(n).fill(0);
    const refresh = (): void => columns.forEach((c) => c.forEach((v, i) => (order[v] = i)));
    refresh();
    const sweep = (from: number, to: number, step: number): void => {
      for (let l = from; step > 0 ? l <= to : l >= to; l += step) {
        const prevLayer = l - step;
        const col = columns[l]!;
        const bary = new Map<number, number>();
        for (const v of col) {
          const ps = neigh[v]!.filter((w) => layer[w] === prevLayer);
          bary.set(
            v,
            ps.length === 0 ? order[v]! : ps.reduce((s, w) => s + order[w]!, 0) / ps.length,
          );
        }
        col.sort((a, b) => bary.get(a)! - bary.get(b)! || order[a]! - order[b]!);
        col.forEach((v, i) => (order[v] = i));
      }
    };
    for (let pass = 0; pass < 4; pass++) {
      sweep(1, nLayers - 1, 1);
      sweep(nLayers - 2, 0, -1);
    }

    // Geometry: column widths, centered rows.
    const colW = columns.map((c) => Math.max(0, ...c.map((v) => items[v]!.w)));
    const colD = columns.map(
      (c) => c.reduce((s, v) => s + items[v]!.d, 0) + Math.max(0, c.length - 1) * GAP_Y,
    );
    const maxD = Math.max(0, ...colD);
    const out: Item = {
      kind: "group",
      id: containerId ?? "",
      w: 0,
      d: 0,
      nodes: new Map(),
      groups: new Map(),
    };
    let x = pad;
    const placedRects: LayoutRect[] = [];
    columns.forEach((col, l) => {
      let y = pad + snap((maxD - colD[l]!) / 2);
      for (const v of col) {
        const it = items[v]!;
        const ix = x;
        let iy = y;
        // Root only: keep clear of fixed (manual) nodes, 1 tile margin.
        for (let guard = 0; guard < 2000; guard++) {
          const r: LayoutRect = { x: ix, y: iy, w: it.w, d: it.d };
          if (!fixed.some((f) => intersects(r, f, 1))) break;
          iy += 0.5;
        }
        for (const [id, r] of it.nodes) out.nodes.set(id, { ...r, x: r.x + ix, y: r.y + iy });
        for (const [id, r] of it.groups) out.groups.set(id, { ...r, x: r.x + ix, y: r.y + iy });
        placedRects.push({ x: ix, y: iy, w: it.w, d: it.d });
        y = iy + it.d + GAP_Y;
      }
      x += colW[l]! + GAP_X;
    });
    const right = placedRects.reduce((m, r) => Math.max(m, r.x + r.w), pad);
    const bottom = placedRects.reduce((m, r) => Math.max(m, r.y + r.d), pad);
    out.w = right + pad;
    out.d = bottom + pad;
    return out;
  }

  const fixedRects: LayoutRect[] = spec.nodes
    .filter((n) => n.pos !== undefined)
    .map((n) => ({ x: n.pos!.x, y: n.pos!.y, w: footprintOf(n), d: footprintOf(n) }));

  // Top-level groups that (transitively) hold manually positioned nodes are "anchored": their
  // rect is the fixed members' bounding box plus the packed auto content placed to its right.
  // The whole rect is computed before packing and acts as a fixed obstacle for everything else.
  const topOf = (gid: string | undefined): string | undefined => {
    let g = gid;
    const seen = new Set<string>();
    while (g !== undefined && !seen.has(g)) {
      seen.add(g);
      const p = parentOfGroup.get(g);
      if (p === undefined) return g;
      g = p;
    }
    return undefined;
  };
  const fixedByTop = new Map<string, SpecNode[]>();
  for (const n of spec.nodes) {
    if (n.pos === undefined) continue;
    const t = topOf(nodeGroup.get(n.id));
    if (t === undefined || !reachable.has(t)) continue;
    const list = fixedByTop.get(t) ?? [];
    list.push(n);
    fixedByTop.set(t, list);
  }
  for (const t of fixedByTop.keys()) anchored.add(t);
  const anchoredNodes = new Map<string, LayoutRect>();
  const anchoredGroups = new Map<string, LayoutRect>();
  for (const g of spec.groups) {
    const fixedList = fixedByTop.get(g.id);
    if (!fixedList) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of fixedList) {
      const f = footprintOf(n);
      x0 = Math.min(x0, n.pos!.x);
      y0 = Math.min(y0, n.pos!.y);
      x1 = Math.max(x1, n.pos!.x + f);
      y1 = Math.max(y1, n.pos!.y + f);
    }
    const block = layoutContainer(g.id, GROUP_PAD, []);
    const hasAuto = block.nodes.size > 0 || block.groups.size > 0;
    const bx = x1 + GROUP_PAD;
    const by = y0 - GROUP_PAD;
    for (const [id, r] of block.nodes) anchoredNodes.set(id, { ...r, x: r.x + bx, y: r.y + by });
    for (const [id, r] of block.groups) anchoredGroups.set(id, { ...r, x: r.x + bx, y: r.y + by });
    const rx1 = hasAuto ? Math.max(x1 + GROUP_PAD, bx + block.w) : x1 + GROUP_PAD;
    const ry1 = hasAuto ? Math.max(y1 + GROUP_PAD, by + block.d) : y1 + GROUP_PAD;
    const rect: LayoutRect = {
      x: x0 - GROUP_PAD,
      y: Math.min(y0 - GROUP_PAD, hasAuto ? by : Infinity),
      w: rx1 - (x0 - GROUP_PAD),
      d: 0,
    };
    rect.d = ry1 - rect.y;
    anchoredGroups.set(g.id, rect);
    fixedRects.push(rect);
  }

  const root = layoutContainer(undefined, 0, fixedRects);
  const nodes = new Map<string, LayoutRect>(root.nodes);
  const groups = new Map<string, LayoutRect>(root.groups);
  for (const [id, r] of anchoredNodes) nodes.set(id, r);
  for (const [id, r] of anchoredGroups) groups.set(id, r);
  for (const n of spec.nodes) {
    if (n.pos !== undefined) {
      const f = footprintOf(n);
      nodes.set(n.id, { x: n.pos.x, y: n.pos.y, w: f, d: f });
    }
  }

  // Groups with fixed members (or members in cyclic/unreachable groups) grow to cover them,
  // children before parents.
  const depthOf = (id: string): number => {
    let d = 0;
    let g = parentOfGroup.get(id);
    const seen = new Set<string>();
    while (g !== undefined && !seen.has(g)) {
      seen.add(g);
      d++;
      g = parentOfGroup.get(g);
    }
    return d;
  };
  const ordered = [...spec.groups].sort((a, b) => depthOf(b.id) - depthOf(a.id));
  const grow = (gid: string, r: LayoutRect, pad: number): void => {
    const cur = groups.get(gid);
    if (!cur) {
      groups.set(gid, { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, d: r.d + 2 * pad });
      return;
    }
    const x0 = Math.min(cur.x, r.x - pad);
    const y0 = Math.min(cur.y, r.y - pad);
    const x1 = Math.max(cur.x + cur.w, r.x + r.w + pad);
    const y1 = Math.max(cur.y + cur.d, r.y + r.d + pad);
    groups.set(gid, { x: x0, y: y0, w: x1 - x0, d: y1 - y0 });
  };
  for (const n of spec.nodes) {
    if (n.pos === undefined || n.group === undefined || !groupIds.has(n.group)) continue;
    grow(n.group, nodes.get(n.id)!, GROUP_PAD);
  }
  for (const g of ordered) {
    const parent = parentOfGroup.get(g.id);
    const r = groups.get(g.id);
    if (parent !== undefined && r) grow(parent, r, GROUP_PAD);
  }
  return { nodes, groups };
}
