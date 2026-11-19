import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { norm, score, validateWithCli } from "./check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const truth = {
  nodes: [{ label: "Client" }, { label: "Web Pod 1" }, { label: "Database" }],
  groups: [{ label: "Kubernetes Cluster", members: ["Web Pod 1"] }],
  edges: [
    { from: "Client", to: "Web Pod 1" },
    { from: "Web Pod 1", to: "Database" },
  ],
  steps: 2,
};
const spec = {
  nodes: [
    { id: "c", type: "client", label: "  client " },
    { id: "p", type: "pod", label: "Web  Pod 1", group: "inner" },
    { id: "d", type: "sql", label: "DATABASE" },
  ],
  groups: [
    { id: "k8s", label: "Kubernetes cluster" },
    { id: "inner", label: "Pods", parent: "k8s" },
  ],
  edges: [
    { from: "c", to: "p" },
    { from: "p", to: "d" },
  ],
  steps: [{ caption: "a" }, { caption: "b" }],
};

describe("norm", () => {
  it("ignores case, whitespace and punctuation", () => {
    expect(norm("  Web-Pod   1! ")).toBe("web pod 1");
  });
});

describe("score", () => {
  it("scores a perfect spec (nested groups, normalised labels)", () => {
    const r = score(spec, truth);
    expect(r.labelRecall).toBe(1);
    expect(r.edgeRecall).toBe(1);
    expect(r.groupRecall).toBe(1);
    expect(r.steps).toEqual({ have: 2, wanted: 2, ok: true });
    expect(r.pass).toBe(true);
  });

  it("scores a reversed edge 0.5 directed, 1 undirected, and fails below 80%", () => {
    const rev = {
      ...spec,
      edges: [
        { from: "p", to: "c" },
        { from: "p", to: "d" },
      ],
    };
    const r = score(rev, truth);
    expect(r.edgeRecall).toBe(0.75);
    expect(r.undirectedEdgeRecall).toBe(1);
    expect(r.missing.reversed).toEqual(["Client -> Web Pod 1"]);
    expect(r.pass).toBe(false);
    const bidir = { ...spec, edges: [{ from: "p", to: "c", bidirectional: true }, spec.edges[1]] };
    expect(score(bidir, truth).edgeRecall).toBe(1);
  });

  it("penalises invented nodes and edges (precision >= 90%)", () => {
    const extra = {
      ...spec,
      nodes: [...spec.nodes, { id: "x", type: "server", label: "Invented" }],
      edges: [...spec.edges, { from: "x", to: "d" }],
    };
    const r = score(extra, truth);
    expect(r.nodePrecision).toBe(0.75);
    expect(r.edgePrecision).toBeCloseTo(2 / 3);
    expect(r.missing.extraNodes).toEqual(["Invented"]);
    expect(r.pass).toBe(false);
  });

  it("requires steps === expected and step i to animate stepEdges[i]", () => {
    const t = { ...truth, stepEdges: [truth.edges[0], truth.edges[1]] };
    const withIds = {
      ...spec,
      edges: [
        { id: "e1", from: "c", to: "p" },
        { id: "e2", from: "p", to: "d" },
      ],
    };
    const ok = { ...withIds, steps: [{ flows: [{ edge: "e1" }] }, { flows: [{ edge: "e2" }] }] };
    expect(score(ok, t).pass).toBe(true);
    const swapped = {
      ...withIds,
      steps: [{ flows: [{ edge: "e2" }] }, { flows: [{ edge: "e1" }] }],
    };
    const r = score(swapped, t);
    expect(r.pass).toBe(false);
    expect(r.failures).toHaveLength(2);
    const tooMany = { ...ok, steps: [...ok.steps, { caption: "extra" }] };
    expect(score(tooMany, t).pass).toBe(false);
    expect(
      score({ ...withIds, steps: [{ caption: "x" }] }, { ...truth, steps: 0, stepEdges: [] }).pass,
    ).toBe(false);
  });

  it("reports missing labels, edges, members and steps", () => {
    const bad = {
      nodes: [{ id: "c", type: "client", label: "Client" }],
      edges: [],
    };
    const r = score(bad, truth);
    expect(r.labelRecall).toBeCloseTo(1 / 3);
    expect(r.edgeRecall).toBe(0);
    expect(r.groupRecall).toBe(0);
    expect(r.missing.labels).toEqual(["Web Pod 1", "Database"]);
    expect(r.missing.edges).toEqual(["Client -> Web Pod 1", "Web Pod 1 -> Database"]);
    expect(r.missing.members).toEqual(["Web Pod 1 in Kubernetes Cluster"]);
    expect(r.pass).toBe(false);
    expect(r.failures).toHaveLength(4);
  });

  it("applies the thresholds (labels 90%, edges 80%)", () => {
    const names = Array.from({ length: 10 }, (_, i) => `N${i}`);
    const t = { nodes: names.map((label) => ({ label })), edges: [], groups: [], steps: 0 };
    const nodes = (k) =>
      names.slice(0, k).map((label, i) => ({ id: `n${i}`, type: "server", label }));
    expect(score({ nodes: nodes(9) }, t).pass).toBe(true); // 90%
    expect(score({ nodes: nodes(8) }, t).pass).toBe(false); // 80%

    const e = {
      nodes: Array.from({ length: 5 }, (_, i) => [{ label: `A${i}` }, { label: `B${i}` }]).flat(),
      groups: [],
      steps: 0,
      edges: Array.from({ length: 5 }, (_, i) => ({ from: `A${i}`, to: `B${i}` })),
    };
    const sp = (k) => ({
      nodes: e.edges.flatMap((x, i) => [
        { id: `a${i}`, type: "server", label: x.from },
        { id: `b${i}`, type: "server", label: x.to },
      ]),
      edges: e.edges.slice(0, k).map((_, i) => ({ from: `a${i}`, to: `b${i}` })),
    });
    expect(score(sp(4), e).pass).toBe(true); // 80%
    expect(score(sp(3), e).pass).toBe(false); // 60%
  });

  it("treats empty truth sections as fully recalled but still enforces the step count", () => {
    const t = { nodes: [], edges: [], groups: [], steps: 1 };
    expect(score({ nodes: [], steps: [{}] }, t).pass).toBe(true);
    expect(score({ nodes: [], steps: [{}, {}, {}] }, t).pass).toBe(false);
  });
});

const tmpDirs = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("validateWithCli", () => {
  it("reports ok for a valid spec and failure for an invalid one", () => {
    const dir = mkdtempSync(join(tmpdir(), "from-image-"));
    tmpDirs.push(dir);
    const good = join(dir, "good.cosmo.json");
    const bad = join(dir, "bad.cosmo.json");
    writeFileSync(
      good,
      JSON.stringify({ meta: { version: "1", title: "t" }, nodes: [{ id: "a", type: "server" }] }),
    );
    writeFileSync(
      bad,
      JSON.stringify({ meta: { version: "1", title: "t" }, nodes: [{ id: "a", type: "nope" }] }),
    );
    expect(validateWithCli(good).ok).toBe(true);
    expect(validateWithCli(bad).ok).toBe(false);
  });
});

describe("committed inputs", () => {
  const dir = join(here, "inputs");
  const truths = readdirSync(dir).filter((f) => f.endsWith(".truth.json"));
  it("has three images with ground truth, each under 150 KB", () => {
    expect(truths).toHaveLength(3);
    for (const f of truths) {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
      expect(statSync(join(dir, t.image)).size).toBeLessThan(150 * 1024);
      const labels = new Set(t.nodes.map((n) => n.label));
      for (const e of t.edges) {
        expect(labels.has(e.from) && labels.has(e.to)).toBe(true);
      }
      for (const g of t.groups) for (const m of g.members) expect(labels.has(m)).toBe(true);
    }
  });
});

describe("make-inputs --check", () => {
  it("committed PNGs match a fresh deterministic render", () => {
    const out = execFileSync(process.execPath, [join(here, "make-inputs.mjs"), "--check"], {
      encoding: "utf8",
    });
    expect(out).not.toContain("STALE");
    expect(out.match(/ok /g)).toHaveLength(3);
  });
});
