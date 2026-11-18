/** Scene builder (Track A2): validated spec → `SceneGraph` (world space). */
import type {
  Box3,
  BuildSceneFn,
  Diagnostic,
  SceneEdge,
  SceneGraph,
  SceneGroup,
  SceneObject,
  Vec3,
} from "../contracts/index.js";
import { layoutSpec } from "../layout/index.js";
import { center, routeSimple } from "../routing/index.js";
import type { PlatformCosmoSpec, SpecNode } from "../schema/types.gen.js";
import { NODE_TYPES, PRIMITIVE_HEIGHT } from "./categories.js";
import { NODE_HEIGHT, footprintOf } from "./sizes.js";

const r2 = (v: number): number => Math.round(v * 100) / 100;
const byId = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const encodeEnd = (id: string): string => id.replace(/\//g, ".");

function unionBox(boxes: readonly Box3[]): Box3 {
  if (boxes.length === 0) {
    return { origin: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } };
  }
  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const b of boxes) {
    min = {
      x: Math.min(min.x, b.origin.x),
      y: Math.min(min.y, b.origin.y),
      z: Math.min(min.z, b.origin.z),
    };
    max = {
      x: Math.max(max.x, b.origin.x + b.size.x),
      y: Math.max(max.y, b.origin.y + b.size.y),
      z: Math.max(max.z, b.origin.z + b.size.z),
    };
  }
  return {
    origin: { x: r2(min.x), y: r2(min.y), z: r2(min.z) },
    size: { x: r2(max.x - min.x), y: r2(max.y - min.y), z: r2(max.z - min.z) },
  };
}

function iconSize(size: SpecNode["size"]): number {
  return size === "sm" ? 28 : size === "lg" ? 44 : 36;
}

function labelAnchorOf(path: readonly Vec3[]): Vec3 {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  const a = path[best]!;
  const b = path[best + 1] ?? a;
  return { x: r2((a.x + b.x) / 2), y: r2((a.y + b.y) / 2), z: r2((a.z + b.z) / 2) };
}

export const buildScene: BuildSceneFn = (spec: PlatformCosmoSpec, context) => {
  const diagnostics: Diagnostic[] = [];
  const nodes = spec.nodes ?? [];
  const groupsSpec = spec.groups ?? [];
  const edgesSpec = spec.edges ?? [];

  const layout = layoutSpec({ nodes, groups: groupsSpec, edges: edgesSpec });
  const ox = 0;
  const oy = 0;

  const objects: SceneObject[] = [];
  const boxes = new Map<string, Box3>();
  for (const n of nodes) {
    const info = NODE_TYPES[n.type];
    const rect = layout.nodes.get(n.id);
    const f = footprintOf(n);
    const h = r2(NODE_HEIGHT[n.size ?? "md"] * PRIMITIVE_HEIGHT[info.primitive]);
    const box: Box3 = {
      origin: { x: r2(ox + (rect?.x ?? 0)), y: r2(oy + (rect?.y ?? 0)), z: 0 },
      size: { x: f, y: f, z: h },
    };
    boxes.set(n.id, box);
    const iconRef = n.icon ?? context.icons?.defaultFor(n.type);
    const resolved = iconRef === undefined ? undefined : context.icons?.resolve(iconRef);
    objects.push({
      id: n.id,
      source: "node",
      type: n.type,
      category: info.category,
      primitive: info.primitive,
      box,
      ...(n.label === undefined ? {} : { label: n.label }),
      ...(n.badge === undefined ? {} : { badge: n.badge }),
      ...(resolved
        ? {
            icon: {
              ref: resolved.ref,
              anchor: {
                x: r2(box.origin.x + f / 2),
                y: r2(box.origin.y + f),
                z: r2(box.origin.z + h / 2),
              },
              size: iconSize(n.size),
            },
          }
        : {}),
      ...(n.group === undefined ? {} : { group: n.group }),
      state: n.state ?? "healthy",
    });
  }
  objects.sort(byId);

  // Groups: level = nesting depth.
  const parentOf = new Map(groupsSpec.map((g) => [g.id, g.parent]));
  const levelOf = (id: string): number => {
    let d = 0;
    const seen = new Set<string>([id]);
    let p = parentOf.get(id);
    while (p !== undefined && !seen.has(p)) {
      seen.add(p);
      d++;
      p = parentOf.get(p);
    }
    return d;
  };
  const groups: SceneGroup[] = groupsSpec.map((g) => {
    const r = layout.groups.get(g.id) ?? { x: 0, y: 0, w: 2, d: 2 };
    const box: Box3 = {
      origin: { x: r2(ox + r.x), y: r2(oy + r.y), z: -0.1 },
      size: { x: r2(r.w), y: r2(r.d), z: 0.1 },
    };
    boxes.set(g.id, box);
    return {
      id: g.id,
      kind: "group" as const,
      ...(g.label === undefined ? {} : { label: g.label }),
      style: g.style ?? "zone",
      ...(g.parent === undefined ? {} : { parent: g.parent }),
      box,
      level: levelOf(g.id),
    };
  });
  groups.sort((a, b) => a.level - b.level || byId(a, b));

  // Edges.
  const edges: SceneEdge[] = [];
  const used = new Set(edgesSpec.flatMap((e) => (e.id === undefined ? [] : [e.id])));
  for (const e of edgesSpec) {
    let id = e.id;
    if (id === undefined) {
      const base = `e_${encodeEnd(e.from)}_${encodeEnd(e.to)}`;
      id = base;
      for (let k = 2; used.has(id); k++) id = `${base}_${k}`;
      used.add(id);
    }
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
    const path = routeSimple(a, b);
    edges.push({
      id,
      from: e.from,
      to: e.to,
      kind: "edge",
      style: e.style ?? "solid",
      bidirectional: e.bidirectional ?? false,
      hidden: false,
      ...(e.label === undefined ? {} : { label: e.label }),
      path,
      arrow: { start: e.bidirectional ?? false, end: true },
      labelAnchor: labelAnchorOf(path),
    });
  }

  const focusTargets: Record<string, Box3> = {};
  for (const id of [...boxes.keys()].sort()) focusTargets[id] = boxes.get(id)!;
  const bounds = unionBox([
    ...boxes.values(),
    ...edges.flatMap((e) => e.path.map((p) => ({ origin: p, size: { x: 0, y: 0, z: 0 } }) as Box3)),
  ]);
  void center;

  return {
    meta: {
      ...(spec.meta.title === undefined ? {} : { title: spec.meta.title }),
      ...(spec.meta.description === undefined ? {} : { description: spec.meta.description }),
    },
    canvas: {
      theme: spec.canvas?.theme ?? "light",
      grid: spec.canvas?.grid ?? false,
      padding: spec.canvas?.padding ?? 32,
      aspect: (spec.canvas?.aspect ?? "auto") as SceneGraph["canvas"]["aspect"],
    },
    objects,
    groups,
    edges,
    flows: [],
    metrics: (spec.metrics ?? []).map((m) => ({ id: m.id, label: m.label, value: m.value })),
    legend: [],
    timeline: [],
    focusTargets,
    bounds,
    diagnostics,
  };
};
