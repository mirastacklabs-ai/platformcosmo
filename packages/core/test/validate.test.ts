import { describe, expect, test } from "vitest";
import { validateSpec } from "../src/index.js";

const valid = () => ({
  $schema: "https://platformcosmo.io/schema/v1.json",
  meta: { version: "1", title: "Load balancer", description: "Round robin" },
  canvas: { theme: "light", grid: true, padding: 2, aspect: "16:9" },
  groups: [{ id: "web", label: "Web tier", style: "zone" }],
  nodes: [
    { id: "users", type: "users", label: "Users" },
    { id: "lb", type: "lb", label: "LB", badge: "L7", size: "lg", pos: { x: 1, y: 0 } },
    { id: "app-1", type: "server", icon: "lucide:server", group: "web" },
    { id: "app-2", type: "server", group: "web" },
  ],
  edges: [
    { id: "e1", from: "users", to: "lb", style: "solid" },
    { id: "e2", from: "lb", to: "app-1", label: "50%" },
  ],
  flows: [
    { edge: "e1", kind: "heavy", rate: 2, color: "#ff8800" },
    { from: "lb", to: "app-2" },
  ],
  metrics: [{ id: "rps", label: "RPS", value: 1200 }],
  steps: [{ caption: "Failover", set: { "app-2": "down" }, flows: [{ edge: "e2" }], duration: 3 }],
  legend: "auto",
});

describe("validateSpec", () => {
  test("accepts a load-balancer spec", () => {
    const r = validateSpec(valid());
    expect(r.valid).toBe(true);
  });

  test("rejects unknown field", () => {
    const r = validateSpec({ ...valid(), bogus: 1 });
    expect(r.valid).toBe(false);
    expect(r.errors[0]?.keyword).toBe("additionalProperties");
    expect(r.errors[0]?.path).toBe("/bogus");
    expect(r.errors[0]?.params).toEqual({ additionalProperty: "bogus" });
  });

  test("flow must reference an edge by id or by from+to, not neither or both", () => {
    const neither = valid();
    neither.flows = [{ kind: "normal" } as never];
    expect(validateSpec(neither).valid).toBe(false);
    const both = valid();
    both.flows = [{ edge: "e1", from: "lb", to: "app-1" } as never];
    expect(validateSpec(both).valid).toBe(false);
    const partial = valid();
    partial.flows = [{ from: "lb" } as never];
    expect(validateSpec(partial).valid).toBe(false);
  });

  test("step flows accept both reference forms", () => {
    const s = valid();
    s.steps = [{ flows: [{ edge: "e1" }, { from: "lb", to: "app-1" }] } as never];
    expect(validateSpec(s).valid).toBe(true);
  });

  test("empty nodes and empty step are rejected", () => {
    const a = valid();
    a.nodes = [];
    expect(validateSpec(a).valid).toBe(false);
    const b = valid();
    b.steps = [{} as never];
    expect(validateSpec(b).valid).toBe(false);
  });

  test("rejects bad node id", () => {
    const s = valid();
    s.nodes[0]!.id = "Bad_ID";
    const r = validateSpec(s);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === "/nodes/0/id")).toBe(true);
  });

  test("rejects bad node type", () => {
    const s = valid();
    s.nodes[1]!.type = "toaster";
    const r = validateSpec(s);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path === "/nodes/1/type")).toBe(true);
  });

  test("rejects missing meta", () => {
    const s: Record<string, unknown> = valid();
    delete s.meta;
    const r = validateSpec(s);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.keyword === "required")).toBe(true);
  });
});
