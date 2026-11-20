import type { DcPack, Diagnostic, IconResolver, PartShapeRegistry } from "../contracts/index.js";
import { DEFAULT_RACK_U, SLOT_HEIGHT_U, footprintOf } from "../scene/sizes.js";
import type { PlatformCosmoSpec, SpecFlow } from "./types.gen.js";
import { closest, didYouMean, q } from "./suggest.js";
import { assemblyDiagnostics, figureDiagnostics, isAssemblyPath } from "./assembly-semantic.js";
import { unsupportedDiagnostics } from "./unsupported.js";

/** Σ over every flow of ceil(rate × 2); shared formula with Track B (no path lengths needed). */
export const PARTICLE_LIMIT = 2000;

type Kind =
  | "node"
  | "group"
  | "rack"
  | "equipment"
  | "row"
  | "aisle"
  | "cable"
  | "figure"
  | "assembly"
  | "storyboard";

export interface SemanticContext {
  readonly icons?: IconResolver;
  readonly dc?: DcPack;
  /** Schema 1.2.0: installed pack shapes; unknown `pack:id` shapes become errors. */
  readonly parts?: PartShapeRegistry;
}

export function particleCount(flows: readonly SpecFlow[]): number {
  let n = 0;
  for (const f of flows) n += Math.ceil((f.rate ?? 1) * 2);
  return n;
}

export function semanticDiagnostics(
  spec: PlatformCosmoSpec,
  ctx: SemanticContext = {},
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (
    code: string,
    path: string,
    message: string,
    suggestion?: string,
    params?: Record<string, unknown>,
  ): void => {
    out.push({
      severity: "error",
      code,
      path,
      message,
      ...(suggestion === undefined ? {} : { suggestion }),
      ...(params === undefined ? {} : { params }),
    });
  };

  // Schema 1.2.0 fields that this build cannot render yet (merge guard, unsupported.ts).
  out.push(...unsupportedDiagnostics(spec));

  const nodes = spec.nodes ?? [];
  const groups = spec.groups ?? [];
  const racks = spec.racks ?? [];
  const equipment = spec.equipment ?? [];
  const rows = spec.rows ?? [];
  const aisles = spec.aisles ?? [];
  const cables = spec.cables ?? [];
  const edges = spec.edges ?? [];

  // ---- one id namespace -------------------------------------------------------------
  const ids = new Map<string, { kind: Kind; path: string }>();
  // The kinds named in the duplicate-id suggestion: 1.1 kinds, then the 1.2.0 ones present.
  const sharedKinds = [
    "nodes",
    "groups",
    "racks",
    "equipment",
    "rows",
    "aisles",
    "cables",
    ...(spec.figures === undefined ? [] : ["figures"]),
    ...(spec.assemblies === undefined ? [] : ["assemblies"]),
    ...(spec.storyboards === undefined ? [] : ["storyboards"]),
  ];
  const shared = `${sharedKinds.slice(0, -1).join(", ")} and ${sharedKinds[sharedKinds.length - 1]}`;
  const declare = (id: string, kind: Kind, path: string): void => {
    const prev = ids.get(id);
    if (prev) {
      err(
        "semantic/duplicate-id",
        path,
        `Duplicate id ${q(id)} (already used by a ${prev.kind} at ${prev.path})`,
        `Ids are shared by ${shared}; rename one`,
        { id, first: prev.path },
      );
    } else ids.set(id, { kind, path });
  };
  nodes.forEach((n, i) => declare(n.id, "node", `/nodes/${i}/id`));
  groups.forEach((g, i) => declare(g.id, "group", `/groups/${i}/id`));
  racks.forEach((r, i) => declare(r.id, "rack", `/racks/${i}/id`));
  equipment.forEach((q, i) => declare(q.id, "equipment", `/equipment/${i}/id`));
  rows.forEach((r, i) => declare(r.id, "row", `/rows/${i}/id`));
  aisles.forEach((a, i) => declare(a.id, "aisle", `/aisles/${i}/id`));
  cables.forEach((c, i) => {
    if (c.id !== undefined) declare(c.id, "cable", `/cables/${i}/id`);
  });
  (spec.figures ?? []).forEach((f, i) => declare(f.id, "figure", `/figures/${i}/id`));
  (spec.assemblies ?? []).forEach((a, i) => declare(a.id, "assembly", `/assemblies/${i}/id`));
  (spec.storyboards ?? []).forEach((b, i) => declare(b.id, "storyboard", `/storyboards/${i}/id`));

  // Edge ids and cable ids share the namespace flows refer to.
  const edgeIds = new Map<string, string>();
  edges.forEach((e, i) => {
    if (e.id === undefined) return;
    const prev = edgeIds.get(e.id);
    if (prev) {
      err(
        "semantic/duplicate-id",
        `/edges/${i}/id`,
        `Duplicate edge id ${q(e.id)} (first at ${prev})`,
        "Rename one edge",
        {
          id: e.id,
          first: prev,
        },
      );
    } else edgeIds.set(e.id, `/edges/${i}/id`);
  });
  cables.forEach((c, i) => {
    if (c.id === undefined) return;
    const prev = edgeIds.get(c.id);
    if (prev === undefined) edgeIds.set(c.id, `/cables/${i}/id`);
    else
      err(
        "semantic/duplicate-id",
        `/cables/${i}/id`,
        `Duplicate id ${q(c.id)} (also used at ${prev})`,
        "Rename one",
      );
  });

  const metricIds = new Set<string>();
  (spec.metrics ?? []).forEach((m, i) => {
    if (metricIds.has(m.id))
      err("semantic/duplicate-id", `/metrics/${i}/id`, `Duplicate metric id ${q(m.id)}`);
    metricIds.add(m.id);
  });

  // ---- slots ------------------------------------------------------------------------
  const slotRefs = new Set<string>();
  const rackIds = new Set(racks.map((r) => r.id));
  racks.forEach((r, ri) => {
    const rackU = r.u ?? DEFAULT_RACK_U;
    const seen = new Map<string, number>();
    const taken: { id: string; lo: number; hi: number }[] = [];
    (r.slots ?? []).forEach((s, si) => {
      const sid = s.id ?? `u${s.at}`;
      const base = `/racks/${ri}/slots/${si}`;
      if (seen.has(sid)) {
        err(
          "semantic/duplicate-id",
          `${base}/id`,
          `Duplicate slot id ${q(sid)} in rack ${q(r.id)}`,
          "Give the slot an explicit unique id",
        );
      } else {
        seen.set(sid, si);
        slotRefs.add(`${r.id}/${sid}`);
      }
      const height = s.size ?? ctx.dc?.registry.get(s.type)?.heightU ?? SLOT_HEIGHT_U[s.type] ?? 1;
      const lo = s.at;
      const hi = s.at + height - 1;
      if (hi > rackU) {
        err(
          "semantic/slot-out-of-range",
          `${base}/at`,
          `Slot ${q(sid)} occupies U${lo}-U${hi} but rack ${q(r.id)} has ${rackU}U`,
          `Lower "at" or "size", or use a taller rack`,
        );
      }
      for (const t of taken) {
        if (lo <= t.hi && t.lo <= hi) {
          err(
            "semantic/slot-overlap",
            `${base}/at`,
            `Slot ${q(sid)} (U${lo}-U${hi}) overlaps slot ${q(t.id)} (U${t.lo}-U${t.hi}) in rack ${q(r.id)}`,
            "Move one of the devices",
          );
          break;
        }
      }
      taken.push({ id: sid, lo, hi });
    });
  });

  // ---- reference helpers ------------------------------------------------------------
  const objectIds = [...ids.entries()]
    .filter(([, v]) => v.kind === "node" || v.kind === "rack" || v.kind === "equipment")
    .map(([k]) => k);
  const objectCandidates = [...objectIds, ...slotRefs];
  const isObject = (ep: string): boolean => {
    if (ep.includes("/")) return slotRefs.has(ep);
    const k = ids.get(ep)?.kind;
    return k === "node" || k === "rack" || k === "equipment";
  };
  // Edge and flow endpoints may also name a whole assembly (never a part). Figures and
  // storyboards stay errors here, as they were (their renderers define their endpoints).
  const isBoard = (k: Kind | undefined): boolean => k === "assembly";
  const isEndpoint = (ep: string): boolean =>
    isObject(ep) || (!ep.includes("/") && isBoard(ids.get(ep)?.kind));
  const isAreaRef = (ep: string): boolean => {
    const k = ids.get(ep)?.kind;
    return k === "group" || k === "row" || k === "aisle";
  };
  const unknownObject = (path: string, ep: string, what: string, allowAreas = false): void => {
    const slash = ep.indexOf("/");
    let message = `Unknown ${what} ${q(ep)}`;
    if (slash > 0 && isBoard(ids.get(ep.slice(0, slash))?.kind)) {
      const root = ep.slice(0, slash);
      err(
        "assembly/edge-to-part",
        path,
        `${what[0]!.toUpperCase()}${what.slice(1)} ${q(ep)} is a part path; endpoints name a whole ${ids.get(root)!.kind}`,
        `Use "${root}"`,
        { id: ep },
      );
      return;
    }
    if (slash > 0) {
      const rack = ep.slice(0, slash);
      if (!rackIds.has(rack))
        message = `${what[0]!.toUpperCase()}${what.slice(1)} ${q(ep)}: ${q(rack)} is not a rack`;
      else
        message = `${what[0]!.toUpperCase()}${what.slice(1)} ${q(ep)}: rack ${q(rack)} has no such slot`;
    } else if (ids.has(ep)) {
      message = `${what[0]!.toUpperCase()}${what.slice(1)} ${q(ep)} is a ${ids.get(ep)!.kind} and is not allowed here`;
    }
    const cands = allowAreas
      ? [
          ...objectCandidates,
          ...[...ids.entries()]
            .filter(([, v]) => v.kind === "group" || v.kind === "row" || v.kind === "aisle")
            .map(([k]) => k),
        ]
      : objectCandidates;
    err("semantic/unknown-node", path, message, didYouMean(ep, cands), { id: ep });
  };

  // ---- groups -----------------------------------------------------------------------
  const groupIds = new Set(groups.map((g) => g.id));
  nodes.forEach((n, i) => {
    if (n.group !== undefined && !groupIds.has(n.group)) {
      err(
        "semantic/unknown-group",
        `/nodes/${i}/group`,
        `Unknown group ${q(n.group)}`,
        didYouMean(n.group, groupIds),
        { id: n.group },
      );
    }
  });
  const parentOf = new Map<string, string>();
  groups.forEach((g, i) => {
    if (g.parent === undefined) return;
    if (!groupIds.has(g.parent)) {
      err(
        "semantic/unknown-group",
        `/groups/${i}/parent`,
        `Unknown parent group ${q(g.parent)}`,
        didYouMean(g.parent, groupIds),
        { id: g.parent },
      );
    } else if (!parentOf.has(g.id)) parentOf.set(g.id, g.parent);
  });
  const inCycle = new Set<string>();
  groups.forEach((g, i) => {
    if (inCycle.has(g.id)) return;
    const chain: string[] = [];
    const pos = new Map<string, number>();
    let cur: string | undefined = g.id;
    while (cur !== undefined && !pos.has(cur) && !inCycle.has(cur)) {
      pos.set(cur, chain.length);
      chain.push(cur);
      cur = parentOf.get(cur);
    }
    if (cur !== undefined && pos.has(cur)) {
      const cycle = chain.slice(pos.get(cur)!);
      for (const c of cycle) inCycle.add(c);
      const first = groups.findIndex((x) => cycle.includes(x.id));
      err(
        "semantic/group-cycle",
        `/groups/${first === -1 ? i : first}/parent`,
        `Group parents form a cycle: ${[...cycle, cycle[0]!].join(" -> ")}`,
        "Remove one parent link",
        { cycle },
      );
    }
  });

  // ---- edges, cables ----------------------------------------------------------------
  const isDcObject = (ep: string): boolean => {
    if (ep.includes("/")) return slotRefs.has(ep);
    const k = ids.get(ep)?.kind;
    return k === "rack" || k === "equipment";
  };
  const checkEnds = (
    list: { from: string; to: string }[],
    base: string,
    what: string,
    ok: (ep: string) => boolean,
  ): void => {
    list.forEach((e, i) => {
      if (!ok(e.from)) unknownObject(`${base}/${i}/from`, e.from, what);
      if (!ok(e.to)) unknownObject(`${base}/${i}/to`, e.to, what);
      if (e.from === e.to)
        err(
          "semantic/self-edge",
          `${base}/${i}/to`,
          `Connects ${q(e.from)} to itself`,
          "Point to a different endpoint",
        );
    });
  };
  // Cables connect DC gear only (racks, equipment, rack/slot); edges connect any object.
  checkEnds(edges, "/edges", "node", isEndpoint);
  checkEnds(cables, "/cables", "cable endpoint", isDcObject);

  // ---- DC refs ----------------------------------------------------------------------
  const rowIds = new Set(rows.map((r) => r.id));
  rows.forEach((r, ri) => {
    r.members.forEach((m, mi) => {
      const k = ids.get(m)?.kind;
      if (k !== "rack" && k !== "equipment") {
        err(
          "semantic/unknown-node",
          `/rows/${ri}/members/${mi}`,
          k
            ? `Row member ${q(m)} is a ${k}, not a rack or equipment`
            : `Unknown row member ${q(m)}`,
          didYouMean(m, [...rackIds, ...equipment.map((q) => q.id)]),
          { id: m },
        );
      }
    });
  });
  aisles.forEach((a, ai) => {
    a.rows.forEach((r, ri) => {
      if (!rowIds.has(r))
        err(
          "semantic/unknown-row",
          `/aisles/${ai}/rows/${ri}`,
          `Unknown row ${q(r)}`,
          didYouMean(r, rowIds),
          { id: r },
        );
    });
  });

  // ---- flows, steps -----------------------------------------------------------------
  const checkFlows = (flows: readonly SpecFlow[], base: string): void => {
    flows.forEach((f, i) => {
      const p = `${base}/${i}`;
      if ("edge" in f) {
        if (!edgeIds.has(f.edge)) {
          err(
            "semantic/unknown-edge",
            `${p}/edge`,
            `Unknown edge ${q(f.edge)}`,
            didYouMean(f.edge, edgeIds.keys()) ?? "Edges are referenced by their explicit id",
            { id: f.edge },
          );
        }
        return;
      }
      const areas = f.kind === "airflow";
      for (const end of ["from", "to"] as const) {
        const ep = f[end];
        if (isEndpoint(ep) || (areas && isAreaRef(ep))) continue;
        unknownObject(`${p}/${end}`, ep, "flow endpoint", areas);
      }
      if (f.from === f.to)
        err(
          "semantic/self-edge",
          `${p}/to`,
          `Flow starts and ends at ${q(f.from)}`,
          "Point to a different endpoint",
        );
    });
  };
  checkFlows(spec.flows ?? [], "/flows");
  // Images, figures and figure actions (A2-F); these run alongside the guard. Focus ids that
  // zoom are the ones the check below accepts, as in the scene.
  // Assembly checks (A2-1) name more targets than the figure planner does, so where both report
  // the same code at the same path the assembly check's did-you-mean wins.
  const assembly = assemblyDiagnostics(spec, undefined, ctx);
  const taken = new Set(assembly.map((d) => `${d.path}\0${d.code}`));
  out.push(...assembly);
  out.push(
    ...figureDiagnostics(spec, undefined, (id) => isObject(id) || isAreaRef(id)).filter(
      (d) => !taken.has(`${d.path}\0${d.code}`),
    ),
  );
  (spec.steps ?? []).forEach((s, si) => {
    const base = `/steps/${si}`;
    for (const key of Object.keys(s.set ?? {})) {
      if (!isObject(key) && !isAssemblyPath(spec, key)) {
        unknownObject(`${base}/set/${key}`, key, "step target");
      }
    }
    for (const key of Object.keys(s.metrics ?? {})) {
      if (!metricIds.has(key))
        err(
          "semantic/unknown-metric",
          `${base}/metrics/${key}`,
          `Unknown metric ${q(key)}`,
          didYouMean(key, metricIds),
          { id: key },
        );
    }
    if (
      s.focus !== undefined &&
      !isObject(s.focus) &&
      !isAreaRef(s.focus) &&
      !isAssemblyPath(spec, s.focus)
    ) {
      unknownObject(`${base}/focus`, s.focus, "focus target", true);
    }
    checkFlows(s.flows ?? [], `${base}/flows`);
  });

  // ---- icons ------------------------------------------------------------------------
  const icons = ctx.icons;
  if (icons) {
    nodes.forEach((n, i) => {
      if (n.icon === undefined || icons.resolve(n.icon) !== undefined) return;
      const pack = n.icon.slice(0, n.icon.indexOf(":"));
      const installed = icons.packs();
      let hint: string | undefined;
      if (!installed.includes(pack)) {
        const near = closest(pack, installed);
        hint = near
          ? `Did you mean pack ${q(near)}?`
          : `Pack ${q(pack)} is not installed; try: pcosmo icons add ${pack}`;
      } else {
        const m = icons.search(n.icon, 3)[0];
        hint = m ? `Did you mean ${q(m.ref)}?` : undefined;
      }
      err(
        "semantic/icon-not-installed",
        `/nodes/${i}/icon`,
        `Icon ${q(n.icon)} is not installed`,
        hint,
        { ref: n.icon },
      );
    });
  }

  // ---- overlapping manual positions
  // Node footprints are checked here (shared sizes with layout). Rack/equipment footprints belong
  // to the DC pack, so only exact-tile collisions are rejected for them. -------------------------------------------------
  const placed = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.pos !== undefined);
  for (let b = 1; b < placed.length; b++) {
    const B = placed[b]!;
    const fb = footprintOf(B.n);
    for (let a = 0; a < b; a++) {
      const A = placed[a]!;
      const fa = footprintOf(A.n);
      const dx = Math.min(A.n.pos!.x + fa, B.n.pos!.x + fb) - Math.max(A.n.pos!.x, B.n.pos!.x);
      const dy = Math.min(A.n.pos!.y + fa, B.n.pos!.y + fb) - Math.max(A.n.pos!.y, B.n.pos!.y);
      if (dx > 0 && dy > 0) {
        err(
          "layout/overlap",
          `/nodes/${B.i}/pos`,
          `Node ${q(B.n.id)} overlaps ${q(A.n.id)} at its manual position`,
          'Move it, or drop "pos" to use auto layout',
          { a: A.n.id, b: B.n.id },
        );
        break;
      }
    }
  }
  const dcPos = new Map<string, string>();
  const dcItems: { id: string; path: string; pos?: { x: number; y: number } }[] = [
    ...racks.map((r, i) => ({
      id: r.id,
      path: `/racks/${i}/pos`,
      ...(r.pos ? { pos: r.pos } : {}),
    })),
    ...equipment.map((q, i) => ({
      id: q.id,
      path: `/equipment/${i}/pos`,
      ...(q.pos ? { pos: q.pos } : {}),
    })),
  ];
  for (const it of dcItems) {
    if (!it.pos) continue;
    const key = `${it.pos.x},${it.pos.y}`;
    const other = dcPos.get(key);
    if (other !== undefined) {
      err(
        "layout/overlap",
        it.path,
        `${q(it.id)} shares grid position (${key}) with ${q(other)}`,
        "Give each rack or equipment its own tile",
      );
    } else dcPos.set(key, it.id);
  }

  // ---- budget -----------------------------------------------------------------------
  let particles = particleCount(spec.flows ?? []);
  for (const s of spec.steps ?? []) particles += particleCount(s.flows ?? []);
  if (particles > PARTICLE_LIMIT) {
    err(
      "budget/particles",
      "",
      `Flows need about ${particles} particle elements (limit ${PARTICLE_LIMIT})`,
      "Lower flow rates or remove flows (each flow costs ceil(rate x 2))",
      { particles, limit: PARTICLE_LIMIT },
    );
  }

  return out;
}
