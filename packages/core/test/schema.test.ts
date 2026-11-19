import { describe, expect, test } from "vitest";
import type { IconResolver } from "../src/index.js";
import { parseSpec, validate } from "../src/index.js";
import { closestMatches, editDistance } from "../src/schema/suggest.js";

const base = (): Record<string, unknown> => ({
  meta: { version: "1" },
  groups: [{ id: "web" }, { id: "inner", parent: "web" }],
  nodes: [
    { id: "users", type: "users" },
    { id: "lb", type: "lb" },
    { id: "app-1", type: "server", group: "web" },
  ],
  edges: [
    { id: "e1", from: "users", to: "lb" },
    { from: "lb", to: "app-1" },
  ],
  flows: [{ edge: "e1" }, { from: "lb", to: "app-1", rate: 2 }],
  metrics: [{ id: "rps", label: "RPS", value: 1 }],
  steps: [{ set: { "app-1": "down" }, metrics: { rps: 5 }, focus: "lb", flows: [{ edge: "e1" }] }],
});

const codes = (s: unknown, ctx?: Parameters<typeof validate>[1]) =>
  validate(s, ctx).diagnostics.map((d) => `${d.code}@${d.path}`);

describe("parseSpec", () => {
  test("json ok / error with line+col", () => {
    expect(parseSpec('{"a":1}', "json").spec).toEqual({ a: 1 });
    const r = parseSpec('{\n  "a": 1,\n  oops\n}', "json");
    expect(r.diagnostics[0]?.code).toBe("parse/json");
    expect(r.diagnostics[0]?.params).toMatchObject({ line: 3, column: 3 });
  });
  test("yaml 1.2 core: yes/on stay strings", () => {
    const r = parseSpec("meta:\n  version: '1'\nflag: yes\non: on\n", "yaml");
    expect(r.spec).toEqual({ meta: { version: "1" }, flag: "yes", on: "on" });
  });
  test("yaml errors carry line/col; duplicate keys rejected", () => {
    const r = parseSpec("a: 1\nb: [\n", "yaml");
    expect(r.diagnostics[0]?.code).toBe("parse/yaml");
    expect(r.diagnostics[0]?.params).toEqual({ line: 3, column: 1 });
    expect(parseSpec("a: 1\na: 2\n", "yaml").diagnostics).toHaveLength(1);
  });
  test("BOM and unknown format", () => {
    expect(parseSpec('﻿{"a":1}', "json").spec).toEqual({ a: 1 });
    expect(parseSpec("{}", "toml" as never).diagnostics[0]?.code).toBe("parse/format");
  });
});

describe("union collapse (one diagnostic per location)", () => {
  const withFlow = (flow: Record<string, unknown>) => ({
    ...base(),
    flows: [flow],
    steps: undefined,
  });
  test("flow kind typo", () => {
    const d = validate(withFlow({ edge: "e1", kind: "nrmal" })).diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      code: "schema/enum",
      path: "/flows/0/kind",
      suggestion: 'Did you mean "normal"?',
    });
  });
  test("color typo", () => {
    const d = validate(withFlow({ edge: "e1", color: "bleu" })).diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ code: "semantic/unknown-color", path: "/flows/0/color" });
  });
  test("endpoint typo", () => {
    const d = validate(withFlow({ from: "lb", to: "Bad_Id" })).diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ code: "schema/pattern", path: "/flows/0/to" });
  });
  test("two bad flows give one diagnostic each", () => {
    const s = {
      ...base(),
      flows: [{ kind: "x" }, { edge: "e1", kind: "nrmal" }],
      steps: undefined,
    };
    const d = validate(s).diagnostics;
    expect(d.map((x) => x.path)).toEqual(["/flows/0", "/flows/1/kind"]);
  });
});

describe("suggest", () => {
  test("edit distance and ranking", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("ab", "ba")).toBe(1);
    expect(closestMatches("servr", ["server", "queue", "vm"])[0]).toBe("server");
    expect(closestMatches("zzzz", ["server"])).toEqual([]);
  });

  test("transposition and rolling rows agree with the textbook values", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abcd", "acbd")).toBe(1);
    expect(editDistance("flaw", "lawn")).toBe(2);
    expect(editDistance("a".repeat(40), "a".repeat(39) + "b")).toBe(1);
  });

  test("huge inputs are bounded (no |a| x |b| tables)", () => {
    const big = "x".repeat(1_000_000);
    const cands = ["server", "queue", "database", "x".repeat(70)];
    expect(closestMatches(big, cands)).toEqual([cands[3]]); // prefix compared, still a plausible match
    expect(closestMatches(big, ["server", "queue"])).toEqual([]);
    expect(closestMatches("srvr", [big, "server"])).toEqual(["server"]);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) closestMatches(big, cands);
    expect(performance.now() - t0).toBeLessThan(5000); // generous: 200 x 1 MB would take minutes unbounded
  });
});

describe("validate: schema layer", () => {
  test("valid spec", () => {
    const r = validate(base());
    expect(r.diagnostics).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.spec).toBeDefined();
  });
  test("did-you-mean for enum, field, required typo, color", () => {
    const s = base();
    (s.nodes as { type: string }[])[1]!.type = "lbb";
    (s as Record<string, unknown>).metrcs = [];
    const d = validate(s).diagnostics;
    expect(d.find((x) => x.path === "/nodes/1/type")?.suggestion).toBe('Did you mean "lb"?');
    expect(d.find((x) => x.path === "/metrcs")?.suggestion).toBe('Did you mean "metrics"?');
    const c = base();
    (c.flows as { color?: string }[])[0]!.color = "bleu";
    const dc = validate(c).diagnostics.find((x) => x.code === "semantic/unknown-color");
    expect(dc?.suggestion).toBe('Did you mean "blue"?');
  });
  test("unknown top-level field suggests upgrade", () => {
    const d = validate({ ...base(), futureThing: 1 }).diagnostics[0]!;
    expect(d.code).toBe("schema/additional-property");
    expect(d.suggestion).toMatch(/upgrade platformcosmo/);
  });
  test("oneOf collapse: one diagnostic per location", () => {
    const s = base();
    s.flows = [{ kind: "normal" }];
    const d = validate(s).diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ code: "schema/one-of", path: "/flows/0" });
    expect(d[0]?.suggestion).toMatch(/SpecFlowByEdge/);
  });
  test("oneOf collapse keeps best branch errors", () => {
    const s = base();
    s.flows = [{ edge: "e1", rate: -1 }];
    const d = validate(s).diagnostics;
    expect(d.map((x) => x.path)).toEqual(["/flows/0/rate"]);
  });
  test("anyOf root and metric value", () => {
    const r = validate({ meta: { version: "1" } });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.message).toMatch(/nodes, racks, equipment/);
    const s = base();
    (s.metrics as { value: unknown }[])[0]!.value = true;
    expect(validate(s).diagnostics).toHaveLength(1);
  });
  test("deterministic and sorted", () => {
    const s = base();
    s.bogus = 1;
    s.zzz = 1;
    const a = JSON.stringify(validate(s).diagnostics);
    expect(a).toBe(JSON.stringify(validate(s).diagnostics));
    const paths = validate(s).diagnostics.map((d) => d.path);
    expect(paths).toEqual([...paths].sort());
  });
});

describe("validate: semantic layer", () => {
  test("duplicate ids span one namespace", () => {
    const s = base();
    (s.groups as { id: string }[])[0]!.id = "lb";
    expect(codes(s)).toContain("semantic/duplicate-id@/groups/0/id");
  });
  test("unknown node in edge/flow/step with suggestions", () => {
    const s = base();
    (s.edges as { to: string }[])[1]!.to = "app-2";
    (s.steps as { set: Record<string, string> }[])[0]!.set = { lbb: "down" };
    const d = validate(s).diagnostics;
    expect(d.find((x) => x.path === "/edges/1/to")?.suggestion).toBe('Did you mean "app-1"?');
    expect(d.find((x) => x.path === "/steps/0/set/lbb")?.suggestion).toBe('Did you mean "lb"?');
  });
  test("unknown edge, metric, group, focus", () => {
    const s = base();
    (s.flows as unknown[])[0] = { edge: "e2" };
    (s.steps as { metrics: unknown; focus: string }[])[0]!.metrics = { rpz: 1 };
    (s.steps as { focus: string }[])[0]!.focus = "nope";
    (s.nodes as { group?: string }[])[2]!.group = "wev";
    const c = codes(s);
    expect(c).toContain("semantic/unknown-edge@/flows/0/edge");
    expect(c).toContain("semantic/unknown-metric@/steps/0/metrics/rpz");
    expect(c).toContain("semantic/unknown-node@/steps/0/focus");
    expect(c).toContain("semantic/unknown-group@/nodes/2/group");
  });
  test("group cycles and self-edge", () => {
    const s = base();
    (s.groups as { parent?: string }[])[0]!.parent = "inner";
    expect(codes(s).filter((c) => c.startsWith("semantic/group-cycle"))).toHaveLength(1);
    const t = base();
    (t.edges as { to: string }[])[0]!.to = "users";
    expect(codes(t)).toContain("semantic/self-edge@/edges/0/to");
  });
  test("icons not installed (only with a resolver)", () => {
    const s = base();
    (s.nodes as { icon?: string }[])[0]!.icon = "aws:ec2";
    expect(validate(s).valid).toBe(true);
    const icons: IconResolver = {
      resolve: () => undefined,
      defaultFor: () => undefined,
      search: () => [{ ref: "lucide:server", score: 1 }],
      packs: () => ["lucide"],
    };
    const d = validate(s, { icons }).diagnostics;
    expect(d[0]?.code).toBe("semantic/icon-not-installed");
    expect(d[0]?.suggestion).toMatch(/icons add aws/);
  });
  test("overlapping manual positions", () => {
    const s = base();
    const n = s.nodes as { pos?: unknown }[];
    n[0]!.pos = { x: 0, y: 0 };
    n[1]!.pos = { x: 1, y: 1 };
    n[2]!.pos = { x: 2, y: 0 };
    expect(codes(s)).toEqual(["layout/overlap@/nodes/1/pos", "layout/overlap@/nodes/2/pos"]);
  });
  test("particle budget: ceil(rate*2) per flow, base + steps", () => {
    const s = base();
    (s.steps as { flows: unknown[] }[])[0]!.flows = [];
    s.flows = Array.from({ length: 100 }, () => ({ edge: "e1", rate: 10 }));
    expect(validate(s).valid).toBe(true); // 100 * 20 = 2000
    (s.steps as { flows: unknown[] }[])[0]!.flows = [{ edge: "e1" }];
    expect(codes(s)).toEqual(["budget/particles@"]); // 2002
    s.flows = [{ edge: "e1", rate: 0.1 }];
    expect(validate(s).valid).toBe(true);
  });
  test("DC refs: rows, aisles, slots, cables", () => {
    const dc = {
      meta: { version: "1" },
      racks: [
        {
          id: "r1",
          u: 42,
          slots: [
            { at: 1, type: "server-2u" },
            { at: 2, type: "server-1u" },
            { id: "tor", at: 42, type: "switch-spine" },
          ],
        },
      ],
      equipment: [{ id: "ups1", type: "ups" }],
      rows: [{ id: "row1", members: ["r1", "ups1", "zz"] }],
      aisles: [{ id: "a1", kind: "cold", rows: ["row2"] }],
      cables: [{ from: "r1/tor", to: "r1/u9", kind: "network" }],
    };
    const c = codes(dc);
    expect(c).toContain("semantic/slot-overlap@/racks/0/slots/1/at");
    expect(c).toContain("semantic/slot-out-of-range@/racks/0/slots/2/at");
    expect(c).toContain("semantic/unknown-node@/rows/0/members/2");
    expect(c).toContain("semantic/unknown-row@/aisles/0/rows/0");
    expect(c).toContain("semantic/unknown-node@/cables/0/to");
  });
  test("cables connect DC gear only", () => {
    const dc = {
      meta: { version: "1" },
      nodes: [{ id: "n1", type: "server" }],
      racks: [{ id: "r1", slots: [{ id: "a", at: 1, type: "server-1u" }] }],
      cables: [{ from: "r1/a", to: "n1" }],
    };
    expect(codes(dc)).toEqual(["semantic/unknown-node@/cables/0/to"]);
  });
  test("unknown ids are quoted and truncated in messages", () => {
    const s = base();
    (s.edges as { to: string }[])[1]!.to = "a".repeat(100);
    const m = validate(s).diagnostics.find((d) => d.path === "/edges/1/to")?.message ?? "";
    expect(m.length).toBeLessThan(120);
  });
  test("airflow flows may target aisles; others may not", () => {
    const dc = {
      meta: { version: "1" },
      racks: [{ id: "r1" }],
      rows: [{ id: "row1", members: ["r1"] }],
      aisles: [
        { id: "cold", kind: "cold", rows: ["row1"] },
        { id: "hot", kind: "hot", rows: ["row1"] },
      ],
      flows: [{ from: "cold", to: "hot", kind: "airflow" }],
    };
    expect(validate(dc).valid).toBe(true);
    dc.flows = [{ from: "cold", to: "hot", kind: "normal" as never }];
    expect(validate(dc).valid).toBe(false);
  });
});
