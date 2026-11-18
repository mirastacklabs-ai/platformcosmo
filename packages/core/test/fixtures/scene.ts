import type { SceneGraph, SceneObject, Vec3 } from "../../src/contracts/index.js";

const box = (x: number, y: number, z: number, w: number, d: number, h: number) => ({
  origin: { x, y, z },
  size: { x: w, y: d, z: h },
});

const node = (
  id: string,
  type: string,
  category: SceneObject["category"],
  x: number,
  y: number,
  label: string,
  extra: Partial<SceneObject> = {},
): SceneObject => ({
  id,
  source: "node",
  type,
  category,
  primitive: "cube",
  box: box(x, y, 0, 1, 1, 0.8),
  label,
  state: "healthy",
  ...extra,
});

const p = (x: number, y: number, z = 0.05): Vec3 => ({ x, y, z });

/** The load-balancer example as a SceneGraph (what A2's `buildScene` is expected to produce). */
export function loadBalancerScene(): SceneGraph {
  const objects: SceneObject[] = [
    node("app-1", "server", "compute", 5, -1, "app-1", { group: "web" }),
    node("app-2", "server", "compute", 5, 3, "app-2", { group: "web", badge: "v2" }),
    node("lb", "lb", "network", 2.5, 1, "Load balancer", { badge: "L7", primitive: "hex-prism" }),
    node("users", "users", "client", 0, 1, "Users", { primitive: "cylinder" }),
  ];
  return {
    meta: { title: "Load balancer", description: "Round robin with failover" },
    canvas: { theme: "light", grid: true, padding: 2, aspect: "auto" },
    objects,
    groups: [
      {
        id: "web",
        kind: "group",
        label: "Web tier",
        style: "zone",
        box: box(4.5, -1.5, 0, 2, 6, 0.1),
        level: 0,
      },
    ],
    edges: [
      {
        id: "e_users_lb",
        from: "users",
        to: "lb",
        kind: "edge",
        style: "solid",
        bidirectional: false,
        hidden: false,
        path: [p(1, 1.5), p(2.5, 1.5)],
        arrow: { start: false, end: true },
      },
      {
        id: "e_lb_app-1",
        from: "lb",
        to: "app-1",
        kind: "edge",
        style: "dashed",
        bidirectional: false,
        hidden: false,
        label: "50%",
        path: [p(3.5, 1.5), p(4.25, 1.5), p(4.25, -0.5), p(5, -0.5)],
        arrow: { start: false, end: true },
      },
      {
        id: "e_lb_app-2",
        from: "lb",
        to: "app-2",
        kind: "edge",
        style: "solid",
        bidirectional: false,
        hidden: false,
        path: [p(3.5, 1.5), p(4.25, 1.5), p(4.25, 3.5), p(5, 3.5)],
        arrow: { start: false, end: true },
      },
      {
        id: "e_users_app-1",
        from: "users",
        to: "app-1",
        kind: "edge",
        style: "solid",
        bidirectional: false,
        hidden: true,
        path: [p(1, 1.5), p(5, -0.5)],
        arrow: { start: false, end: false },
      },
    ],
    flows: [
      { id: "f_1", edge: "e_users_lb", kind: "heavy", rate: 2, reverse: false },
      { id: "f_2", edge: "e_lb_app-2", kind: "normal", rate: 1, reverse: false },
    ],
    metrics: [
      { id: "rps", label: "Requests/s", value: 1200 },
      { id: "err", label: "Errors", value: "0.1%" },
    ],
    legend: [
      { label: "Normal", color: "flow:normal" },
      { label: "Heavy", color: "#ff8800" },
    ],
    timeline: [
      {
        index: 1,
        caption: "Round robin",
        duration: 3,
        states: {},
        flows: [],
        metrics: {},
      },
      {
        index: 2,
        caption: "app-2 fails",
        duration: 3,
        states: { "app-2": "down" },
        flows: [],
        metrics: { rps: 900, err: "0.1%" },
        focus: "app-2",
      },
    ],
    focusTargets: { "app-2": objects[1]!.box, web: box(4.5, -1.5, 0, 2, 6, 0.1) },
    bounds: box(0, -1.5, 0, 7, 6, 0.8),
    diagnostics: [],
  };
}
