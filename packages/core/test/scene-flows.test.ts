import { describe, expect, test } from "vitest";
import { buildScene, validate } from "../src/index.js";
import type {
  DcPack,
  DcSceneFragment,
  PlatformCosmoSpec,
  SceneEdge,
  SceneObject,
} from "../src/index.js";

function spec(extra: Record<string, unknown> = {}): PlatformCosmoSpec {
  const raw = {
    meta: { version: "1" },
    nodes: [
      { id: "users", type: "users" },
      { id: "lb", type: "lb" },
      { id: "app-1", type: "server" },
      { id: "app-2", type: "server" },
    ],
    edges: [
      { id: "e1", from: "users", to: "lb" },
      { id: "e2", from: "lb", to: "app-1" },
    ],
    metrics: [{ id: "rps", label: "RPS", value: 10 }],
    ...extra,
  };
  const r = validate(raw);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.spec!;
}

describe("flows", () => {
  test("edge refs, matching edges (forward/reverse) and hidden synthetic edges", () => {
    const g = buildScene(
      spec({
        flows: [
          { edge: "e1", kind: "heavy", rate: 2, color: "#ABC" },
          { from: "lb", to: "users", color: "teal" },
          { from: "lb", to: "app-2", color: "power" },
          { from: "lb", to: "app-2" },
        ],
      }),
      {},
    );
    expect(g.flows.map((f) => f.id)).toEqual(["f_1", "f_2", "f_3", "f_4"]);
    expect(g.flows[0]).toMatchObject({
      edge: "e1",
      kind: "heavy",
      rate: 2,
      color: "#aabbcc",
      reverse: false,
    });
    expect(g.flows[1]).toMatchObject({
      edge: "e1",
      reverse: true,
      color: "palette:teal",
      kind: "normal",
      rate: 1,
    });
    expect(g.flows[2]).toMatchObject({ edge: "e_lb_app-2", reverse: false, color: "flow:power" });
    expect(g.flows[3]!.edge).toBe("e_lb_app-2");
    const hidden = g.edges.filter((e) => e.hidden);
    expect(hidden.map((e) => e.id)).toEqual(["e_lb_app-2"]);
    expect(hidden[0]!.arrow).toEqual({ start: false, end: false });
    expect(g.edges[g.edges.length - 1]!.hidden).toBe(true);
  });
});

describe("timeline", () => {
  const s = () =>
    spec({
      flows: [{ edge: "e1" }],
      steps: [
        { caption: "one", set: { "app-1": "degraded" }, metrics: { rps: 20 }, focus: "lb" },
        { set: { "app-2": "down" }, flows: [{ edge: "e2", rate: 3 }], duration: 5 },
        { flows: [], metrics: { rps: "30" } },
      ],
    });

  test("states and metrics are cumulative; durations default to 3", () => {
    const t = buildScene(s(), {}).timeline;
    expect(t.map((x) => x.index)).toEqual([1, 2, 3]);
    expect(t.map((x) => x.duration)).toEqual([3, 5, 3]);
    expect(t[0]!.states["app-1"]).toBe("degraded");
    expect(t[0]!.states["app-2"]).toBe("healthy");
    expect(t[1]!.states).toMatchObject({ "app-1": "degraded", "app-2": "down" });
    expect(t[2]!.states).toMatchObject({ "app-1": "degraded", "app-2": "down" });
    expect(t.map((x) => x.metrics.rps)).toEqual([20, 20, "30"]);
    expect(t[0]!.caption).toBe("one");
    expect(t[0]!.focus).toBe("lb");
    expect(t[1]!.focus).toBeUndefined();
  });

  test("a step with flows replaces the base flows; without, shows them", () => {
    const g = buildScene(s(), {});
    expect(g.timeline[0]!.flows).toEqual(g.flows);
    expect(g.timeline[1]!.flows.map((f) => `${f.id}:${f.edge}:${f.rate}`)).toEqual(["s2_f_1:e2:3"]);
    expect(g.timeline[2]!.flows).toEqual([]);
  });

  test("no steps → empty timeline", () => {
    expect(buildScene(spec(), {}).timeline).toEqual([]);
  });
});

describe("legend", () => {
  test("auto lists used flow kinds in canonical order; manual resolves colors", () => {
    const g = buildScene(
      spec({
        legend: "auto",
        flows: [{ edge: "e1", kind: "failed" }, { edge: "e2" }],
        steps: [{ flows: [{ edge: "e1", kind: "heavy" }] }],
      }),
      {},
    );
    expect(g.legend).toEqual([
      { label: "Traffic", color: "flow:normal" },
      { label: "Heavy traffic", color: "flow:heavy" },
      { label: "Failed", color: "flow:failed" },
    ]);
    const m = buildScene(spec({ legend: [{ label: "A", color: "red" }, { label: "B" }] }), {});
    expect(m.legend).toEqual([
      { label: "A", color: "palette:red" },
      { label: "B", color: "palette:gray" },
    ]);
    expect(buildScene(spec(), {}).legend).toEqual([]);
  });
});

describe("DC merge", () => {
  const rackObj: SceneObject = {
    id: "r1",
    source: "dc",
    type: "rack",
    category: "dc",
    primitive: "cube",
    box: { origin: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 2, z: 3 } },
    state: "healthy",
    ports: { "net-0": { x: 1, y: 1, z: 1.5 } },
  };
  const slotObj: SceneObject = {
    ...rackObj,
    id: "r1/srv",
    type: "server-1u",
    box: { origin: { x: 0, y: 0, z: 1 }, size: { x: 1, y: 2, z: 0.1 } },
  };
  const cable: SceneEdge = {
    id: "c1",
    from: "r1/srv",
    to: "r1",
    kind: "cable",
    cableKind: "network",
    style: "solid",
    bidirectional: false,
    hidden: false,
    path: [
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 1, z: 1 },
    ],
    arrow: { start: false, end: false },
  };
  const airflow: SceneEdge = { ...cable, id: "air", hidden: true, kind: "edge" };
  const frag: DcSceneFragment = {
    objects: [rackObj, slotObj],
    groups: [
      {
        id: "dc_hall",
        kind: "hall",
        style: "zone",
        level: 0,
        box: { origin: { x: -1, y: -1, z: -0.1 }, size: { x: 4, y: 5, z: 0.1 } },
      },
    ],
    edges: [airflow, cable],
    flows: [{ id: "dc_f_1", edge: "air", kind: "airflow", rate: 1, reverse: false }],
    focusTargets: {
      r1: rackObj.box,
      "r1/srv": slotObj.box,
      dc_hall: { origin: { x: -1, y: -1, z: -0.1 }, size: { x: 4, y: 5, z: 0.1 } },
    },
    bounds: { origin: { x: -1, y: -1, z: -0.1 }, size: { x: 4, y: 5, z: 3.1 } },
    diagnostics: [],
  };
  let seen: PlatformCosmoSpec | undefined;
  const dc: DcPack = {
    registry: { get: () => undefined, list: () => [] },
    buildScene: (s) => {
      seen = s;
      return frag;
    },
  };
  const dcSpec = () =>
    spec({
      racks: [{ id: "r1", slots: [{ id: "srv", at: 1, type: "server-1u" }] }],
      cables: [{ id: "c1", from: "r1/srv", to: "r1" }],
      facility: {},
      edges: [
        { id: "e1", from: "users", to: "lb" },
        { id: "e3", from: "app-1", to: "r1" },
      ],
      flows: [{ edge: "c1" }],
    });

  test("nodes go +x of the hall with a 2 tile gap; merged ordering", () => {
    const g = buildScene(dcSpec(), { dc });
    const minNodeX = Math.min(
      ...g.objects.filter((o) => o.source === "node").map((o) => o.box.origin.x),
    );
    expect(minNodeX).toBeGreaterThanOrEqual(3 + 2);
    expect(g.objects.map((o) => o.id)).toEqual([...g.objects.map((o) => o.id)].sort());
    expect(g.objects.map((o) => o.id)).toContain("r1/srv");
    expect(g.groups.map((x) => x.id)).toContain("dc_hall");
    expect(g.focusTargets).toHaveProperty("dc_hall");
    expect(g.focusTargets).toHaveProperty("r1/srv");
    expect(g.focusTargets).toHaveProperty("lb");
    // spec edges, then cables, then hidden (DC airflow), then synthetic.
    const ids = g.edges.map((e) => e.id);
    expect(ids.indexOf("e3")).toBeLessThan(ids.indexOf("c1"));
    expect(ids.indexOf("c1")).toBeLessThan(ids.indexOf("air"));
    expect(g.flows.map((f) => f.id)).toEqual(["f_1", "dc_f_1"]);
  });

  test("node to DC edge routes to the DC port", () => {
    const g = buildScene(dcSpec(), { dc });
    const e3 = g.edges.find((e) => e.id === "e3")!;
    const end = e3.path[e3.path.length - 1]!;
    expect(end).toEqual({ x: 1, y: 1, z: 1.5 });
    expect(e3.path[e3.path.length - 2]).toEqual({ x: 1, y: 1, z: 0 });
  });

  test("schema defaults are applied before the DC pack sees the spec", () => {
    buildScene(dcSpec(), { dc });
    expect(seen?.racks?.[0]).toMatchObject({ u: 42, pdu: "dual" });
    expect(seen?.cables?.[0]?.kind).toBe("network");
    expect(seen?.facility).toEqual({
      raisedFloor: true,
      perforatedTiles: true,
      cableTrays: "overhead",
    });
  });

  test("DC content without a pack is an error diagnostic", () => {
    const g = buildScene(dcSpec(), {});
    expect(g.diagnostics.map((d) => d.code)).toContain("semantic/dc-pack-required");
  });

  test("particle budget re-checked over DC flows", () => {
    const heavy: DcSceneFragment = {
      ...frag,
      flows: Array.from({ length: 101 }, (_, i) => ({
        id: `dc_f_${i + 1}`,
        edge: "air",
        kind: "airflow" as const,
        rate: 10,
        reverse: false,
      })),
    };
    const g = buildScene(dcSpec(), { dc: { ...dc, buildScene: () => heavy } });
    expect(g.diagnostics.find((d) => d.code === "budget/particles")?.severity).toBe("error");
  });

  test("deterministic", () => {
    const a = JSON.stringify(buildScene(dcSpec(), { dc }));
    expect(a).toBe(JSON.stringify(buildScene(dcSpec(), { dc })));
  });
});
