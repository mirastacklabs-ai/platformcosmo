/**
 * Cables, airflow, power and network flows. Works on world-space `Ref`s (one per rack,
 * equipment and slot object) and produces orthogonal `SceneEdge`s plus `SceneFlow`s.
 */
import type {
  Box3,
  DcPortKind,
  Diagnostic,
  SceneEdge,
  SceneFlow,
  SpecCable,
  Vec3,
} from "@platformcosmo/core";
import { DC_DEFAULTS } from "./defaults.js";
import { r4, vec } from "./units.js";

export interface RefPort {
  readonly id: string;
  readonly kind: DcPortKind;
  readonly at: Vec3;
}

/** A connectable object in world space. */
export interface Ref {
  readonly id: string;
  readonly type: string;
  readonly box: Box3;
  /** +1 when the front faces +y, -1 when it faces -y. */
  readonly front: 1 | -1;
  readonly ports: readonly RefPort[];
  /** Owning rack id for slot objects. */
  readonly rack?: string;
}

export type CableKind = "power" | "network" | "fiber" | "management";

/** DC flows together may use at most this many particles (each flow uses ceil(rate x 2)). */
export const MAX_DC_PARTICLES = 1000;

interface PendingFlow {
  readonly edge: string;
  readonly kind: SceneFlow["kind"];
  readonly rate: number;
}

const center = (b: Box3): Vec3 =>
  vec(b.origin.x + b.size.x / 2, b.origin.y + b.size.y / 2, b.origin.z + b.size.z / 2);

/** Picks the next port of the wanted kind(s), rotating through them per object. */
export class PortAllocator {
  private readonly used = new Map<string, number>();

  pick(ref: Ref, cableKind: CableKind): RefPort | undefined {
    const groups: readonly (readonly DcPortKind[])[] =
      cableKind === "power"
        ? [["power-a", "power-b"]]
        : cableKind === "fiber"
          ? [["fiber"], ["network"]]
          : [["network"]];
    for (const group of groups) {
      const cands = ref.ports.filter((p) => group.includes(p.kind));
      if (cands.length > 0) {
        const key = `${ref.id}|${cableKind}`;
        const n = this.used.get(key) ?? 0;
        this.used.set(key, n + 1);
        return cands[n % cands.length];
      }
    }
    return undefined;
  }
}

/** Drops repeated points and merges collinear runs so paths stay minimal polylines. */
export function simplify(points: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y && last.z === p.z) continue;
    out.push(p);
  }
  const res: Vec3[] = [];
  for (let i = 0; i < out.length; i++) {
    const a = res[res.length - 1];
    const b = out[i]!;
    const c = out[i + 1];
    if (a && c) {
      const same = (k: "x" | "y" | "z"): boolean => a[k] === b[k] && b[k] === c[k];
      const axes = Number(same("x")) + Number(same("y")) + Number(same("z"));
      if (axes === 2) continue;
    }
    res.push(b);
  }
  return res;
}

/**
 * Orthogonal route: out of the front face, up (or down) to the lane height, across x then y,
 * then back into the other port. Lanes fan out per cable index so parallel cables do not overlap.
 */
export function route(
  from: Ref,
  fromAt: Vec3,
  to: Ref,
  toAt: Vec3,
  laneZ: number,
  lane: number,
): Vec3[] {
  const stepOut = 0.15 + (lane % 4) * 0.04;
  const z = r4(laneZ + (lane % 5) * 0.025);
  const a1 = vec(fromAt.x, fromAt.y + from.front * stepOut, fromAt.z);
  const b1 = vec(toAt.x, toAt.y + to.front * stepOut, toAt.z);
  return simplify([
    fromAt,
    a1,
    vec(a1.x, a1.y, z),
    vec(b1.x, a1.y, z),
    vec(b1.x, b1.y, z),
    b1,
    toAt,
  ]);
}

export function midpoint(path: readonly Vec3[]): Vec3 {
  const m = path[Math.floor(path.length / 2)] ?? vec(0, 0, 0);
  return m;
}

export interface Connections {
  readonly edges: SceneEdge[];
  readonly flows: SceneFlow[];
  readonly diagnostics: Diagnostic[];
}

export interface ConnectInput {
  readonly refs: ReadonlyMap<string, Ref>;
  readonly cables: readonly SpecCable[];
  /** Height of the cable lane (tray or default overhead / underfloor). */
  readonly laneZ: number;
  /** Particle budget for all DC flows (global budget minus the spec's own flow cost). */
  readonly particleBudget: number;
  /** Rack ids in spec order with airflow inputs. */
  readonly airflow: readonly {
    readonly rack: string;
    readonly cold?: string;
    readonly hot?: string;
  }[];
}

const FLOW_RATE: Record<"airflow" | "power" | "normal", number> = {
  airflow: 1,
  power: 1,
  normal: 1.5,
};

const isServer = (t: string): boolean =>
  t === "server-1u" ||
  t === "server-2u" ||
  t === "server-4u" ||
  t === "blade-chassis" ||
  t === "gpu-node";

function dist(a: Ref, b: Ref): number {
  const ca = center(a.box);
  const cb = center(b.box);
  return Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
}

function nearest(from: Ref, cands: readonly Ref[]): Ref | undefined {
  let best: Ref | undefined;
  let bd = Infinity;
  for (const c of cands) {
    const d = dist(from, c);
    if (d < bd || (d === bd && best !== undefined && c.id < best.id)) {
      best = c;
      bd = d;
    }
  }
  return best;
}

export function connect(input: ConnectInput): Connections {
  const { refs, cables, laneZ } = input;
  const budget = Math.max(0, Math.min(MAX_DC_PARTICLES, input.particleBudget));
  const edges: SceneEdge[] = [];
  const hidden: SceneEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const alloc = new PortAllocator();
  const airflowFlows: PendingFlow[] = [];
  const cableFlows: PendingFlow[] = [];
  const synthFlows: PendingFlow[] = [];
  const flows: SceneFlow[] = [];

  // ---- airflow: cold aisle -> through the rack -> hot aisle (hidden paths) ----
  for (const a of input.airflow) {
    const r = refs.get(a.rack);
    if (!r) continue;
    const c = center(r.box);
    const frontY = r.front === 1 ? r.box.origin.y + r.box.size.y : r.box.origin.y;
    const backY = r.front === 1 ? r.box.origin.y : r.box.origin.y + r.box.size.y;
    const z = r4(r.box.origin.z + r.box.size.z * 0.5);
    const path = [vec(c.x, frontY + r.front * 0.9, z), vec(c.x, backY - r.front * 0.9, z)];
    const id = `dc_air_${a.rack}`;
    hidden.push({
      id,
      from: a.cold ?? a.rack,
      to: a.hot ?? a.rack,
      kind: "edge",
      style: "dashed",
      bidirectional: false,
      hidden: true,
      path,
      arrow: { start: false, end: false },
    });
    airflowFlows.push({ edge: id, kind: "airflow", rate: FLOW_RATE.airflow });
  }

  // ---- user cables ----
  const cableEdges: { edge: SceneEdge; kind: CableKind }[] = [];
  const cableIds = new Set<string>();
  cables.forEach((c, i) => {
    const cableId = c.id ?? `dc_cable_${i + 1}`;
    if (cableIds.has(cableId)) {
      diagnostics.push({
        severity: "error",
        code: "dc/duplicate-cable-id",
        path: `/cables/${i}/id`,
        message: `Cable id "${cableId}" is used more than once; the duplicate was skipped.`,
      });
      return;
    }
    cableIds.add(cableId);
    const from = refs.get(c.from);
    const to = refs.get(c.to);
    if (!from) {
      diagnostics.push({
        severity: "error",
        code: "dc/unknown-cable-endpoint",
        path: `/cables/${i}/from`,
        message: `Cable endpoint "${c.from}" is not a rack, equipment or slot.`,
      });
    }
    if (!to) {
      diagnostics.push({
        severity: "error",
        code: "dc/unknown-cable-endpoint",
        path: `/cables/${i}/to`,
        message: `Cable endpoint "${c.to}" is not a rack, equipment or slot.`,
      });
    }
    if (!from || !to) return;
    if (from.id === to.id) {
      diagnostics.push({
        severity: "warning",
        code: "dc/cable-self-loop",
        path: `/cables/${i}`,
        message: `Cable connects "${c.from}" to itself and was skipped.`,
      });
      return;
    }
    const kind: CableKind = c.kind ?? DC_DEFAULTS.cableKind;
    const path = pathBetween(from, to, kind, alloc, laneZ, i, `/cables/${i}`, diagnostics);
    const edge: SceneEdge = {
      id: cableId,
      from: c.from,
      to: c.to,
      kind: "cable",
      cableKind: kind,
      style: kind === "management" ? "dotted" : "solid",
      bidirectional: false,
      hidden: false,
      ...(c.label !== undefined ? { label: c.label, labelAnchor: midpoint(path) } : {}),
      path,
      arrow: { start: false, end: false },
    };
    edges.push(edge);
    cableEdges.push({ edge, kind });
  });

  // ---- power flows ----
  const hasPower = cables.some((c) => c.kind === "power");
  const hasNet = cables.some(
    (c) => c.kind === "network" || c.kind === "fiber" || c.kind === undefined,
  );
  for (const { edge, kind } of cableEdges) {
    if (kind === "power") cableFlows.push({ edge: edge.id, kind: "power", rate: FLOW_RATE.power });
    else if (kind === "network" || kind === "fiber") {
      cableFlows.push({ edge: edge.id, kind: "normal", rate: FLOW_RATE.normal });
    }
  }

  let synth = 0;
  const synthEdge = (
    prefix: string,
    from: Ref,
    to: Ref,
    kind: CableKind,
    flowKind: "power" | "normal",
  ): void => {
    const f = alloc.pick(from, kind);
    const t = alloc.pick(to, kind);
    const fa = f?.at ?? center(from.box);
    const ta = t?.at ?? center(to.box);
    synth++;
    const id = `dc_${prefix}_${synth}`;
    hidden.push({
      id,
      from: from.id,
      to: to.id,
      kind: "edge",
      style: "solid",
      bidirectional: false,
      hidden: true,
      path: route(from, fa, to, ta, laneZ, synth),
      arrow: { start: false, end: false },
    });
    synthFlows.push({ edge: id, kind: flowKind, rate: FLOW_RATE[flowKind] });
  };

  const all = [...refs.values()];
  const byType = (t: string): Ref[] => all.filter((r) => r.type === t);
  const racks = byType("rack");

  if (!hasPower) {
    const ups = byType("ups");
    const pdus = byType("pdu-floor");
    const sources = pdus.length > 0 ? pdus : ups;
    for (const p of pdus) {
      const u = nearest(p, ups);
      if (u) synthEdge("p", u, p, "power", "power");
    }
    for (const rack of racks) {
      const src = nearest(rack, sources);
      if (src) synthEdge("p", src, rack, "power", "power");
      const servers = all
        .filter((r) => r.rack === rack.id && isServer(r.type))
        .sort((a, b) => a.box.origin.z - b.box.origin.z || (a.id < b.id ? -1 : 1))
        .slice(0, 4);
      for (const s of servers) synthEdge("p", rack, s, "power", "power");
    }
  }

  if (!hasNet) {
    const spines = byType("switch-spine");
    const leafs = byType("switch-leaf");
    const tors = byType("switch-tor");
    for (const tor of tors) {
      const up = nearest(tor, leafs.length > 0 ? leafs : spines);
      if (up) synthEdge("n", tor, up, "network", "normal");
      const servers = all
        .filter((r) => r.rack === tor.rack && isServer(r.type))
        .sort((a, b) => a.box.origin.z - b.box.origin.z || (a.id < b.id ? -1 : 1))
        .slice(0, 6);
      for (const s of servers) synthEdge("n", s, tor, "network", "normal");
    }
    for (const leaf of leafs) {
      const sp = nearest(leaf, spines);
      if (sp) synthEdge("n", leaf, sp, "fiber", "normal");
    }
  }

  // ---- particle budget: user cables, then airflow, then synthesized flows ----
  let used = 0;
  let dropped = 0;
  const keep = new Set<PendingFlow>();
  const droppedEdges = new Set<string>();
  for (const group of [cableFlows, airflowFlows, synthFlows]) {
    for (const f of group) {
      const n = Math.ceil(f.rate * 2);
      if (used + n <= budget) {
        used += n;
        keep.add(f);
      } else {
        dropped++;
        droppedEdges.add(f.edge);
      }
    }
  }
  [...airflowFlows, ...cableFlows, ...synthFlows]
    .filter((f) => keep.has(f))
    .forEach((f, i) =>
      flows.push({ id: `dc_f_${i + 1}`, edge: f.edge, kind: f.kind, rate: f.rate, reverse: false }),
    );
  if (dropped > 0) {
    diagnostics.push({
      severity: "warning",
      code: "dc/flow-budget",
      path: "",
      message: `${dropped} DC flows were dropped to stay within the ${budget}-particle budget (cables first, then airflow, then automatic flows).`,
      params: { dropped, budget },
    });
  }

  return {
    edges: [...edges, ...hidden.filter((e) => !droppedEdges.has(e.id))],
    flows,
    diagnostics,
  };
}

function pathBetween(
  from: Ref,
  to: Ref,
  kind: CableKind,
  alloc: PortAllocator,
  laneZ: number,
  lane: number,
  at: string,
  diagnostics: Diagnostic[],
): Vec3[] {
  const f = alloc.pick(from, kind);
  const t = alloc.pick(to, kind);
  if (!f || !t) {
    diagnostics.push({
      severity: "info",
      code: "dc/cable-no-port",
      path: at,
      message: `A ${kind} cable endpoint has no matching port; it attaches to the object centre.`,
    });
  }
  return route(from, f?.at ?? center(from.box), to, t?.at ?? center(to.box), laneZ, lane);
}
