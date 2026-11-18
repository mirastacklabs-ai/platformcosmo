/** Scene builder (Track A2): validated spec (+ DC fragment) → `SceneGraph` (world space). */
import type {
  Box3,
  BuildSceneFn,
  DcSceneFragment,
  Diagnostic,
  FlowKind,
  LegendEntry,
  ObjectState,
  SceneEdge,
  SceneFlow,
  SceneGraph,
  SceneGroup,
  SceneObject,
  SceneStep,
  Vec3,
} from "../contracts/index.js";
import { layoutSpec } from "../layout/index.js";
import { routeEdge } from "../routing/router.js";
import { particleCount, PARTICLE_LIMIT } from "../schema/semantic.js";
import type { PlatformCosmoSpec, SpecFlow, SpecNode } from "../schema/types.gen.js";
import { NODE_TYPES, PRIMITIVE_HEIGHT } from "./categories.js";
import { NODE_HEIGHT, footprintOf } from "./sizes.js";

const r2 = (v: number): number => Math.round(v * 100) / 100;
const byId = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const encodeEnd = (id: string): string => id.replace(/\//g, ".");

/** Gap (tiles) between the DC hall and the node area (contracts/dc.ts placement rule). */
const DC_GAP = 2;

const PALETTE = new Set([
  "blue",
  "green",
  "red",
  "orange",
  "yellow",
  "purple",
  "teal",
  "pink",
  "gray",
]);

const FLOW_KIND_ORDER: readonly FlowKind[] = [
  "normal",
  "heavy",
  "health",
  "failed",
  "airflow",
  "power",
];
const FLOW_LABEL: Record<FlowKind, string> = {
  normal: "Traffic",
  heavy: "Heavy traffic",
  health: "Health check",
  failed: "Failed",
  airflow: "Airflow",
  power: "Power",
};

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

function resolveColor(c: string | undefined): string | undefined {
  if (c === undefined) return undefined;
  if (c.startsWith("#")) {
    const h = c.toLowerCase();
    return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
  }
  return PALETTE.has(c) ? `palette:${c}` : `flow:${c}`;
}

const hasDcContent = (s: PlatformCosmoSpec): boolean =>
  s.racks !== undefined ||
  s.equipment !== undefined ||
  s.rows !== undefined ||
  s.aisles !== undefined ||
  s.cables !== undefined ||
  s.facility !== undefined;

export const buildScene: BuildSceneFn = (spec: PlatformCosmoSpec, context) => {
  const diagnostics: Diagnostic[] = [];
  const nodes = spec.nodes ?? [];
  const groupsSpec = spec.groups ?? [];
  const edgesSpec = spec.edges ?? [];

  // ---- DC fragment --------------------------------------------------------------------
  let frag: DcSceneFragment | undefined;
  if (hasDcContent(spec)) {
    if (context.dc) frag = context.dc.buildScene(spec);
    else {
      diagnostics.push({
        severity: "error",
        code: "semantic/dc-pack-required",
        path: "",
        message: "The spec has data-center content but no DC pack was provided",
        suggestion: "Install and pass @platformcosmo/dc-pack (the CLI does this automatically)",
      });
    }
  }
  if (frag) diagnostics.push(...frag.diagnostics);
  const fragHasContent = frag !== undefined && (frag.objects.length > 0 || frag.groups.length > 0);

  // ---- layout: nodes go +x of the DC hall with a 2-tile gap ---------------------------------
  const layout = layoutSpec({ nodes, groups: groupsSpec, edges: edgesSpec });
  const ox = fragHasContent ? r2(frag!.bounds.origin.x + frag!.bounds.size.x + DC_GAP) : 0;
  const oy = fragHasContent ? frag!.bounds.origin.y : 0;

  const objects: SceneObject[] = [];
  const boxes = new Map<string, Box3>();
  const nodeIndex = new Map<string, number>();
  nodes.forEach((n, i) => {
    nodeIndex.set(n.id, i);
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
  });
  const dcObjects = frag?.objects ?? [];
  for (const o of dcObjects) boxes.set(o.id, o.box);
  const allObjects = [...objects, ...dcObjects].sort(byId);

  // ---- groups ------------------------------------------------------------------------
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
  const dcGroups = frag?.groups ?? [];
  for (const g of dcGroups) boxes.set(g.id, g.box);
  const allGroups = [...groups, ...dcGroups].sort((a, b) => a.level - b.level || byId(a, b));

  // ---- routing -----------------------------------------------------------------------
  const objectById = new Map(allObjects.map((o) => [o.id, o]));
  const route = (from: string, to: string): { path: Vec3[]; blocked: boolean } | undefined => {
    const a = boxes.get(from);
    const b = boxes.get(to);
    if (!a || !b) return undefined;
    const skip = new Set<string>([from, to]);
    for (const e of [from, to]) {
      const slash = e.indexOf("/");
      if (slash > 0) skip.add(e.slice(0, slash)); // the rack holding an endpoint slot
    }
    const obstacles: Box3[] = [];
    for (const o of allObjects) {
      if (skip.has(o.id) || o.id.includes("/")) continue;
      obstacles.push(o.box);
    }
    const portsOf = (id: string): Vec3[] | undefined => {
      const p = objectById.get(id)?.ports;
      if (!p) return undefined;
      const keys = Object.keys(p).sort();
      const net = keys.filter((k) => /^(net|fiber|mgmt|management)/.test(k));
      const use = net.length > 0 ? net : keys;
      return use.length > 0 ? use.map((k) => p[k]!) : undefined;
    };
    const pf = portsOf(from);
    const pt = portsOf(to);
    return routeEdge(
      { box: a, ...(pf ? { ports: pf } : {}) },
      { box: b, ...(pt ? { ports: pt } : {}) },
      obstacles,
    );
  };

  const edges: SceneEdge[] = [];
  const usedEdgeIds = new Set<string>([
    ...edgesSpec.flatMap((e) => (e.id === undefined ? [] : [e.id])),
    ...(frag?.edges ?? []).map((e) => e.id),
  ]);
  const uniqueId = (base: string): string => {
    let id = base;
    for (let k = 2; usedEdgeIds.has(id); k++) id = `${base}_${k}`;
    usedEdgeIds.add(id);
    return id;
  };
  edgesSpec.forEach((e, i) => {
    const id = e.id ?? uniqueId(`e_${encodeEnd(e.from)}_${encodeEnd(e.to)}`);
    const routed = route(e.from, e.to);
    if (!routed) {
      diagnostics.push({
        severity: "error",
        code: "semantic/unknown-node",
        path: `/edges/${i}`,
        message: `Edge ${JSON.stringify(id)} has an endpoint with no geometry (${JSON.stringify(boxes.has(e.from) ? e.to : e.from)})`,
      });
      return;
    }
    if (routed.blocked) {
      diagnostics.push({
        severity: "warning",
        code: "routing/blocked",
        path: `/edges/${i}`,
        message: `No obstacle-free route from "${e.from}" to "${e.to}"; drew a direct path`,
        suggestion: "Move nodes apart or remove the manual positions in between",
      });
    }
    edges.push({
      id,
      from: e.from,
      to: e.to,
      kind: "edge",
      style: e.style ?? "solid",
      bidirectional: e.bidirectional ?? false,
      hidden: false,
      ...(e.label === undefined ? {} : { label: e.label }),
      path: routed.path,
      arrow: { start: e.bidirectional ?? false, end: true },
      labelAnchor: labelAnchorOf(routed.path),
    });
  });
  const fragEdges = frag?.edges ?? [];
  edges.push(...fragEdges.filter((e) => !e.hidden), ...fragEdges.filter((e) => e.hidden));

  // ---- flows (synthetic hidden edges are appended to `edges`) ---------------------------------
  const synthetic = new Map<string, SceneEdge>();
  const findEdge = (
    from: string,
    to: string,
  ): { edge: SceneEdge; reverse: boolean } | undefined => {
    const fwd = edges.find((e) => e.from === from && e.to === to);
    if (fwd) return { edge: fwd, reverse: false };
    const back = edges.find((e) => e.from === to && e.to === from);
    return back ? { edge: back, reverse: true } : undefined;
  };
  const resolveFlow = (f: SpecFlow, id: string, path: string): SceneFlow | undefined => {
    let edgeId: string;
    let reverse = false;
    if ("edge" in f) {
      edgeId = f.edge;
      if (!edges.some((e) => e.id === edgeId)) {
        diagnostics.push({
          severity: "error",
          code: "semantic/unknown-edge",
          path: `${path}/edge`,
          message: `Unknown edge "${f.edge}"`,
        });
        return undefined;
      }
    } else {
      const hit = findEdge(f.from, f.to);
      if (hit) {
        edgeId = hit.edge.id;
        reverse = hit.reverse;
      } else {
        const key = `${f.from}>${f.to}`;
        let s = synthetic.get(key);
        if (!s) {
          const routed = route(f.from, f.to);
          if (!routed) {
            diagnostics.push({
              severity: "error",
              code: "semantic/unknown-node",
              path,
              message: `Flow endpoint "${boxes.has(f.from) ? f.to : f.from}" has no geometry`,
            });
            return undefined;
          }
          s = {
            id: uniqueId(`e_${encodeEnd(f.from)}_${encodeEnd(f.to)}`),
            from: f.from,
            to: f.to,
            kind: "edge",
            style: "solid",
            bidirectional: false,
            hidden: true,
            path: routed.path,
            arrow: { start: false, end: false },
          };
          synthetic.set(key, s);
        }
        edgeId = s.id;
      }
    }
    const color = resolveColor(f.color);
    return {
      id,
      edge: edgeId,
      kind: f.kind ?? "normal",
      rate: f.rate ?? 1,
      ...(color === undefined ? {} : { color }),
      reverse,
    };
  };

  const baseFlows: SceneFlow[] = [];
  (spec.flows ?? []).forEach((f, i) => {
    const sf = resolveFlow(f, `f_${i + 1}`, `/flows/${i}`);
    if (sf) baseFlows.push(sf);
  });
  const flows: SceneFlow[] = [...baseFlows, ...(frag?.flows ?? [])];

  // ---- timeline ---------------------------------------------------------------------------
  const states: Record<string, ObjectState> = Object.create(null) as Record<string, ObjectState>;
  for (const o of allObjects) states[o.id] = o.state;
  const metricVals: Record<string, string | number> = Object.create(null) as Record<
    string,
    string | number
  >;
  for (const m of spec.metrics ?? []) metricVals[m.id] = m.value;
  const focusTargets: Record<string, Box3> = Object.create(null) as Record<string, Box3>;
  const focusSource = new Map<string, Box3>(Object.entries(frag?.focusTargets ?? {}));
  for (const o of allObjects) focusSource.set(o.id, o.box); // every object box, slots included
  for (const g of groups) focusSource.set(g.id, g.box);
  for (const k of [...focusSource.keys()].sort()) focusTargets[k] = focusSource.get(k)!;

  const rackSpecs = new Map((spec.racks ?? []).map((r) => [r.id, r]));
  const timeline: SceneStep[] = [];
  const stepOwnFlows: SceneFlow[] = [];
  (spec.steps ?? []).forEach((s, si) => {
    // Rack-wide `set` also covers the front shell and slot devices without their own spec state;
    // explicit slot keys in the same step are applied last and win.
    const entries = Object.entries(s.set ?? {});
    const apply = (k: string, v: ObjectState): void => {
      if (Object.hasOwn(states, k)) states[k] = v;
    };
    for (const [k, v] of entries) {
      const rack = rackSpecs.get(k);
      if (!rack) continue;
      apply(k, v);
      apply(`${k}_front`, v);
      for (const sl of rack.slots ?? []) {
        if (sl.state === undefined) apply(`${k}/${sl.id ?? `u${sl.at}`}`, v);
      }
    }
    for (const [k, v] of entries) if (!rackSpecs.has(k)) apply(k, v);
    for (const [k, v] of Object.entries(s.metrics ?? {})) metricVals[k] = v;
    // Step flows hold spec flows only; DC flows (dc_f_*) live in scene.flows alone.
    let stepFlows: readonly SceneFlow[] = baseFlows;
    if (s.flows !== undefined) {
      const list: SceneFlow[] = [];
      s.flows.forEach((f, fi) => {
        const sf = resolveFlow(f, `s${si + 1}_f_${fi + 1}`, `/steps/${si}/flows/${fi}`);
        if (sf) list.push(sf);
      });
      stepFlows = list;
      stepOwnFlows.push(...list);
    }
    let focus: string | undefined = s.focus;
    if (focus !== undefined && !Object.hasOwn(focusTargets, focus)) {
      diagnostics.push({
        severity: "warning",
        code: "semantic/unknown-focus",
        path: `/steps/${si}/focus`,
        message: `Focus target ${JSON.stringify(focus)} has no geometry; showing the full view`,
      });
      focus = undefined;
    }
    timeline.push({
      index: si + 1,
      ...(s.caption === undefined ? {} : { caption: s.caption }),
      duration: s.duration ?? 3,
      states: Object.assign(Object.create(null), states) as Record<string, ObjectState>,
      flows: stepFlows,
      metrics: Object.assign(Object.create(null), metricVals) as Record<string, string | number>,
      ...(focus === undefined ? {} : { focus }),
    });
  });

  // Hidden synthetic edges come last (contract order).
  edges.push(...synthetic.values());

  // ---- budget re-check over every scene flow (DC flows exist only here) ------------------------
  const particles = particleCount([...flows, ...stepOwnFlows]);
  if (particles > PARTICLE_LIMIT) {
    diagnostics.push({
      severity: "error",
      code: "budget/particles",
      path: "",
      message: `Flows need about ${particles} particle elements (limit ${PARTICLE_LIMIT})`,
      suggestion: "Lower flow rates or remove flows (each flow costs ceil(rate x 2))",
      params: { particles, limit: PARTICLE_LIMIT },
    });
  }

  // ---- overlaps (nodes vs nodes / DC objects) --------------------------------------------------
  const solid = allObjects.filter((o) => !o.id.includes("/"));
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i]!.box;
      const b = solid[j]!.box;
      const hit =
        Math.min(a.origin.x + a.size.x, b.origin.x + b.size.x) > Math.max(a.origin.x, b.origin.x) &&
        Math.min(a.origin.y + a.size.y, b.origin.y + b.size.y) > Math.max(a.origin.y, b.origin.y);
      if (hit) {
        const ni = nodeIndex.get(solid[j]!.id) ?? nodeIndex.get(solid[i]!.id);
        diagnostics.push({
          severity: "warning",
          code: "layout/overlap",
          path: ni === undefined ? "" : `/nodes/${ni}`,
          message: `"${solid[i]!.id}" and "${solid[j]!.id}" overlap`,
          suggestion: "Move one of them or drop the manual position",
        });
      }
    }
  }

  // ---- legend ----------------------------------------------------------------------------
  const legend: LegendEntry[] = [];
  if (spec.legend === "auto") {
    const kinds = new Set<FlowKind>();
    for (const f of [...flows, ...stepOwnFlows]) kinds.add(f.kind);
    for (const k of FLOW_KIND_ORDER) {
      if (kinds.has(k)) legend.push({ label: FLOW_LABEL[k], color: `flow:${k}` });
    }
  } else if (Array.isArray(spec.legend)) {
    for (const l of spec.legend) {
      legend.push({ label: l.label, color: resolveColor(l.color) ?? "palette:gray" });
    }
  }

  const bounds = unionBox([
    ...boxes.values(),
    ...(frag ? [frag.bounds] : []),
    ...edges.flatMap((e) => e.path.map((p) => ({ origin: p, size: { x: 0, y: 0, z: 0 } }))),
  ]);

  const outDiagnostics = diagnostics.sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );

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
    objects: allObjects,
    groups: allGroups,
    edges,
    flows,
    metrics: (spec.metrics ?? []).map((m) => ({ id: m.id, label: m.label, value: m.value })),
    legend,
    timeline,
    focusTargets,
    bounds,
    diagnostics: outDiagnostics,
  };
};
