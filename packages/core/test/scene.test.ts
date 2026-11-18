import { describe, expect, test } from "vitest";
import { buildScene, validate } from "../src/index.js";
import type { PlatformCosmoSpec, SpecNodeType } from "../src/index.js";
import schema from "../../../schema/v1.json" with { type: "json" };
import { NODE_TYPES } from "../src/scene/categories.js";

const lb = (): PlatformCosmoSpec => {
  const spec = {
    meta: { version: "1", title: "LB" },
    groups: [
      { id: "web", label: "Web", style: "vpc" },
      { id: "inner", parent: "web" },
    ],
    nodes: [
      { id: "users", type: "users", label: "Users" },
      { id: "lb", type: "lb", badge: "L7", size: "lg" },
      { id: "app-1", type: "server", group: "web" },
      { id: "app-2", type: "server", group: "inner", state: "down" },
      { id: "db", type: "sql", size: "sm" },
    ],
    edges: [
      { from: "users", to: "lb" },
      { from: "lb", to: "app-1", label: "50%", style: "dashed" },
      { from: "lb", to: "app-2", bidirectional: true },
      { from: "app-1", to: "db" },
      { from: "app-2", to: "db" },
    ],
    metrics: [{ id: "rps", label: "RPS", value: 12 }],
  };
  const r = validate(spec);
  expect(r.diagnostics).toEqual([]);
  return r.spec!;
};

const NODE_TYPE_LIST: SpecNodeType[] = Object.keys(NODE_TYPES) as SpecNodeType[];

describe("buildScene (objects, groups, edges)", () => {
  test("maps all 41 node types to a category and primitive", () => {
    expect(NODE_TYPE_LIST).toHaveLength(41);
    const cats = new Set(Object.values(NODE_TYPES).map((t) => t.category));
    expect([...cats].sort()).toEqual(
      ["ai", "cicd", "client", "compute", "data", "network", "observability", "security"].sort(),
    );
  });

  test("defaults, sizes, ordering", () => {
    const g = buildScene(lb(), {});
    expect(g.objects.map((o) => o.id)).toEqual(["app-1", "app-2", "db", "lb", "users"]);
    const o = (id: string) => g.objects.find((x) => x.id === id)!;
    expect(o("app-1").state).toBe("healthy");
    expect(o("app-2").state).toBe("down");
    expect(o("lb").box.size.x).toBe(3);
    expect(o("db").box.size.x).toBe(1);
    expect(o("users").box.size.x).toBe(2);
    expect(o("db").category).toBe("data");
    expect(o("db").primitive).toBe("cylinder");
    expect(g.canvas).toEqual({ theme: "light", grid: false, padding: 32, aspect: "auto" });
    expect(g.groups.map((x) => `${x.level}:${x.id}`)).toEqual(["0:web", "1:inner"]);
    expect(g.groups.find((x) => x.id === "web")!.style).toBe("vpc");
    expect(g.groups.find((x) => x.id === "inner")!.style).toBe("zone");
  });

  test("group boxes enclose members and are nested", () => {
    const g = buildScene(lb(), {});
    const web = g.groups.find((x) => x.id === "web")!.box;
    const inner = g.groups.find((x) => x.id === "inner")!.box;
    const a2 = g.objects.find((x) => x.id === "app-2")!.box;
    const inb = (b: typeof a2, o: typeof a2) =>
      b.origin.x >= o.origin.x &&
      b.origin.y >= o.origin.y &&
      b.origin.x + b.size.x <= o.origin.x + o.size.x &&
      b.origin.y + b.size.y <= o.origin.y + o.size.y;
    expect(inb(a2, inner)).toBe(true);
    expect(inb(inner, web)).toBe(true);
  });

  test("edges: generated ids, defaults, arrows, label anchors", () => {
    const g = buildScene(lb(), {});
    expect(g.edges.map((e) => e.id)).toEqual([
      "e_users_lb",
      "e_lb_app-1",
      "e_lb_app-2",
      "e_app-1_db",
      "e_app-2_db",
    ]);
    const e2 = g.edges[1]!;
    expect(e2).toMatchObject({ style: "dashed", label: "50%", hidden: false, kind: "edge" });
    expect(e2.labelAnchor).toBeDefined();
    expect(g.edges[2]!.arrow).toEqual({ start: true, end: true });
    expect(g.edges[0]!.arrow).toEqual({ start: false, end: true });
    for (const e of g.edges) {
      expect(e.path.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i + 1 < e.path.length; i++) {
        const a = e.path[i]!;
        const b = e.path[i + 1]!;
        const changed = [a.x !== b.x, a.y !== b.y, a.z !== b.z].filter(Boolean).length;
        expect(changed).toBe(1);
      }
    }
  });

  test("deterministic and focus targets", () => {
    const a = JSON.stringify(buildScene(lb(), {}));
    expect(a).toBe(JSON.stringify(buildScene(lb(), {})));
    const g = buildScene(lb(), {});
    expect(Object.keys(g.focusTargets)).toEqual([
      "app-1",
      "app-2",
      "db",
      "inner",
      "lb",
      "users",
      "web",
    ]);
    expect(g.bounds.size.x).toBeGreaterThan(0);
  });

  test("icons come from the resolver (explicit or default)", () => {
    const icons = {
      resolve: (ref: string) => (ref === "lucide:server" ? ({ ref, svg: "" } as never) : undefined),
      defaultFor: () => "lucide:server",
      search: () => [],
      packs: () => ["lucide"],
    };
    const g = buildScene(lb(), { icons });
    expect(g.objects[0]!.icon?.ref).toBe("lucide:server");
    expect(buildScene(lb(), {}).objects[0]!.icon).toBeUndefined();
  });

  test("engine defaults equal the schema `default`s (non-DC fields)", () => {
    const defs = schema.$defs as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const flow = defs.flow.oneOf[0].properties;
    const canvas = (schema.properties as any).canvas.properties; // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = validate({
      meta: { version: "1" },
      groups: [{ id: "g" }],
      nodes: [
        { id: "a", type: "server", group: "g" },
        { id: "b", type: "server" },
      ],
      edges: [{ from: "a", to: "b" }],
      flows: [{ from: "a", to: "b" }],
      steps: [{ caption: "s" }],
    });
    const g = buildScene(r.spec!, {});
    expect(g.canvas).toEqual({
      theme: canvas.theme.default,
      grid: canvas.grid.default,
      padding: canvas.padding.default,
      aspect: canvas.aspect.default,
    });
    const a = g.objects.find((o) => o.id === "a")!;
    expect(a.state).toBe(defs.node.properties.state.default);
    expect(a.box.size.x).toBe({ sm: 1, md: 2, lg: 3 }[defs.node.properties.size.default as "md"]);
    expect(g.groups[0]!.style).toBe(defs.group.properties.style.default);
    expect(g.edges[0]!.style).toBe(defs.edge.properties.style.default);
    expect(g.edges[0]!.bidirectional).toBe(defs.edge.properties.bidirectional.default);
    expect(g.flows[0]!.kind).toBe(flow.kind.default);
    expect(g.flows[0]!.rate).toBe(flow.rate.default);
    expect(g.timeline[0]!.duration).toBe(defs.step.properties.duration.default);
  });
});
