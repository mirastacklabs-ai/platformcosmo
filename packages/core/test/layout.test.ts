import { describe, expect, test } from "vitest";
import { layoutSpec, type LayoutRect } from "../src/layout/index.js";
import type { SpecEdge, SpecGroup, SpecNode } from "../src/index.js";

const n = (id: string, extra: Partial<SpecNode> = {}): SpecNode => ({
  id,
  type: "server",
  ...extra,
});
const e = (from: string, to: string): SpecEdge => ({ from, to });

const hit = (a: LayoutRect, b: LayoutRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.d && b.y < a.y + a.d;
const inside = (a: LayoutRect, outer: LayoutRect): boolean =>
  a.x >= outer.x &&
  a.y >= outer.y &&
  a.x + a.w <= outer.x + outer.w &&
  a.y + a.d <= outer.y + outer.d;

/** Seeded PRNG (mulberry32) so property tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkInvariants(
  nodes: SpecNode[],
  groups: SpecGroup[],
  r: ReturnType<typeof layoutSpec>,
): void {
  const ids = nodes.map((x) => x.id);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      expect(hit(r.nodes.get(ids[i]!)!, r.nodes.get(ids[j]!)!), `${ids[i]} vs ${ids[j]}`).toBe(
        false,
      );
    }
  }
  const anc = (gid: string | undefined): string[] => {
    const out: string[] = [];
    while (gid !== undefined) {
      out.push(gid);
      gid = groups.find((g) => g.id === gid)?.parent;
    }
    return out;
  };
  for (const node of nodes) {
    const rect = r.nodes.get(node.id)!;
    const chain = anc(node.group);
    for (const g of groups) {
      const gr = r.groups.get(g.id)!;
      if (chain.includes(g.id)) expect(inside(rect, gr), `${node.id} in ${g.id}`).toBe(true);
      else expect(hit(rect, gr), `${node.id} outside ${g.id}`).toBe(false);
    }
  }
  for (const a of groups) {
    for (const b of groups) {
      if (a.id >= b.id) continue;
      if (anc(a.id).includes(b.id) || anc(b.id).includes(a.id)) continue;
      expect(hit(r.groups.get(a.id)!, r.groups.get(b.id)!), `${a.id} vs ${b.id}`).toBe(false);
    }
  }
}

describe("layoutSpec", () => {
  test("layers go left to right along x by longest path", () => {
    const nodes = [n("a"), n("b"), n("c"), n("d")];
    const r = layoutSpec({
      nodes,
      groups: [],
      edges: [e("a", "b"), e("b", "c"), e("a", "c"), e("a", "d")],
    });
    const x = (id: string) => r.nodes.get(id)!.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
    expect(x("d")).toBe(x("b"));
    checkInvariants(nodes, [], r);
  });

  test("cycles terminate", () => {
    const nodes = [n("a"), n("b"), n("c")];
    const r = layoutSpec({ nodes, groups: [], edges: [e("a", "b"), e("b", "c"), e("c", "a")] });
    checkInvariants(nodes, [], r);
  });

  test("crossing reduction orders siblings by their neighbours", () => {
    const nodes = [n("a1"), n("a2"), n("b1"), n("b2")];
    const r = layoutSpec({ nodes, groups: [], edges: [e("a1", "b2"), e("a2", "b1")] });
    const y = (id: string) => r.nodes.get(id)!.y;
    expect(y("b2") < y("b1")).toBe(y("a1") < y("a2"));
  });

  test("groups wrap members; nesting; siblings do not overlap", () => {
    const groups: SpecGroup[] = [{ id: "g1" }, { id: "g2", parent: "g1" }, { id: "g3" }];
    const nodes = [
      n("a", { group: "g2" }),
      n("b", { group: "g1" }),
      n("c", { group: "g3" }),
      n("d"),
    ];
    const r = layoutSpec({ nodes, groups, edges: [e("d", "a"), e("a", "b"), e("b", "c")] });
    checkInvariants(nodes, groups, r);
    expect(inside(r.groups.get("g2")!, r.groups.get("g1")!)).toBe(true);
  });

  test("manual positions are kept and avoided", () => {
    const nodes = [n("a"), n("b", { pos: { x: 0, y: 0 } }), n("c")];
    const r = layoutSpec({ nodes, groups: [], edges: [e("a", "c")] });
    expect(r.nodes.get("b")).toMatchObject({ x: 0, y: 0 });
    checkInvariants(nodes, [], r);
  });

  test("deterministic", () => {
    const nodes = [n("a"), n("b"), n("c")];
    const spec = { nodes, groups: [], edges: [e("a", "b"), e("a", "c")] };
    const s = (x: ReturnType<typeof layoutSpec>) => JSON.stringify([[...x.nodes], [...x.groups]]);
    expect(s(layoutSpec(spec))).toBe(s(layoutSpec(spec)));
  });

  test("property: random graphs with nested groups never overlap", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rand = rng(seed);
      const gCount = Math.floor(rand() * 5);
      const groups: SpecGroup[] = [];
      for (let i = 0; i < gCount; i++) {
        const parent = i > 0 && rand() < 0.5 ? `g${Math.floor(rand() * i)}` : undefined;
        groups.push({ id: `g${i}`, ...(parent ? { parent } : {}) });
      }
      const nCount = 1 + Math.floor(rand() * 25);
      const nodes: SpecNode[] = [];
      for (let i = 0; i < nCount; i++) {
        const group = gCount > 0 && rand() < 0.6 ? `g${Math.floor(rand() * gCount)}` : undefined;
        const size = (["sm", "md", "lg"] as const)[Math.floor(rand() * 3)]!;
        nodes.push(n(`n${i}`, { size, ...(group ? { group } : {}) }));
      }
      const edges: SpecEdge[] = [];
      const eCount = Math.floor(rand() * nCount * 2);
      for (let i = 0; i < eCount; i++) {
        edges.push(e(`n${Math.floor(rand() * nCount)}`, `n${Math.floor(rand() * nCount)}`));
      }
      checkInvariants(nodes, groups, layoutSpec({ nodes, groups, edges }));
    }
  });

  test("property: random manual positions never overlap auto nodes", () => {
    for (let seed = 100; seed < 130; seed++) {
      const rand = rng(seed);
      const nodes: SpecNode[] = [];
      for (let i = 0; i < 12; i++) {
        nodes.push(
          n(
            `n${i}`,
            i % 4 === 0 ? { pos: { x: Math.floor(rand() * 20), y: Math.floor(rand() * 20) } } : {},
          ),
        );
      }
      const edges = [e("n1", "n2"), e("n2", "n3"), e("n5", "n6")];
      const r = layoutSpec({ nodes, groups: [], edges });
      for (const a of nodes) {
        for (const b of nodes) {
          if (a.id >= b.id || (a.pos && b.pos)) continue; // validate rejects fixed-fixed overlaps
          expect(hit(r.nodes.get(a.id)!, r.nodes.get(b.id)!)).toBe(false);
        }
      }
    }
  });
});
