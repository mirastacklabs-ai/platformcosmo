// Scores a generated spec against an image's ground truth (no LLM involved).
// Usage: node tests/from-image/check.mjs <spec.cosmo.json> <truth.json> [--no-validate]
// Exit 1 when the spec is invalid or below thresholds: label recall >= 90%, directed edge recall >= 80%
// (a reversed edge counts 0.5; undirected recall is printed as a diagnostic), group membership >= 80%,
// node and edge precision >= 90%, steps === truth.steps (0 when the truth has none), and step i animating
// truth.stepEdges[i] when listed.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const THRESHOLDS = { labels: 0.9, edges: 0.8, groups: 0.8, precision: 0.9 };

/** Case/whitespace/punctuation-insensitive form of a label. */
export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const ratio = (hit, total) => (total === 0 ? 1 : hit / total);

/** Pure scoring. `spec` and `truth` are parsed JSON. */
export function score(spec, truth) {
  const nodes = spec.nodes ?? [];
  const byLabel = new Map(); // normalised label -> node ids
  for (const n of nodes) {
    const k = norm(n.label ?? n.id);
    byLabel.set(k, [...(byLabel.get(k) ?? []), n.id]);
  }
  const ids = (label) => byLabel.get(norm(label)) ?? [];

  const missingLabels = (truth.nodes ?? []).filter((n) => ids(n.label).length === 0);
  const labelRecall = ratio(
    (truth.nodes ?? []).length - missingLabels.length,
    (truth.nodes ?? []).length,
  );

  // Directed pairs; a bidirectional spec edge counts in both directions.
  const directed = new Set();
  for (const e of spec.edges ?? []) {
    directed.add(`${e.from}\u0000${e.to}`);
    if (e.bidirectional) directed.add(`${e.to}\u0000${e.from}`);
  }
  const hasDir = (fromLabel, toLabel) =>
    ids(fromLabel).some((a) => ids(toLabel).some((b) => directed.has(`${a}\u0000${b}`)));
  const truthEdges = truth.edges ?? [];
  const missingEdges = [];
  const reversedEdges = [];
  let directedHits = 0;
  let undirectedHits = 0;
  for (const e of truthEdges) {
    if (hasDir(e.from, e.to)) {
      directedHits += 1;
      undirectedHits += 1;
    } else if (hasDir(e.to, e.from)) {
      directedHits += 0.5; // right pair, wrong direction
      undirectedHits += 1;
      reversedEdges.push(`${e.from} -> ${e.to}`);
    } else missingEdges.push(`${e.from} -> ${e.to}`);
  }
  const edgeRecall = ratio(directedHits, truthEdges.length);
  const undirectedEdgeRecall = ratio(undirectedHits, truthEdges.length); // diagnostic only

  // Precision: nothing invented.
  const truthLabels = new Set((truth.nodes ?? []).map((n) => norm(n.label)));
  const extraNodes = nodes.filter((n) => !truthLabels.has(norm(n.label ?? n.id)));
  const nodePrecision = ratio(nodes.length - extraNodes.length, nodes.length);
  const truthPairs = new Set();
  for (const e of truthEdges) {
    truthPairs.add(`${norm(e.from)}\u0000${norm(e.to)}`);
    truthPairs.add(`${norm(e.to)}\u0000${norm(e.from)}`);
  }
  const labelOf = new Map(nodes.map((n) => [n.id, norm(n.label ?? n.id)]));
  const specEdges = spec.edges ?? [];
  const extraEdges = specEdges.filter(
    (e) => !truthPairs.has(`${labelOf.get(e.from)}\u0000${labelOf.get(e.to)}`),
  );
  const edgePrecision = ratio(specEdges.length - extraEdges.length, specEdges.length);

  const parentOf = new Map((spec.groups ?? []).map((g) => [g.id, g.parent]));
  const inGroup = (groupId, start) => {
    for (let g = start, hops = 0; g && hops < 50; g = parentOf.get(g), hops++)
      if (g === groupId) return true;
    return false;
  };
  let memberTotal = 0;
  let memberHit = 0;
  const missingMembers = [];
  for (const tg of truth.groups ?? []) {
    const gids = (spec.groups ?? [])
      .filter((g) => norm(g.label ?? g.id) === norm(tg.label))
      .map((g) => g.id);
    for (const m of tg.members ?? []) {
      memberTotal++;
      const ok = ids(m).some((id) => {
        const n = nodes.find((x) => x.id === id);
        return gids.some((g) => inGroup(g, n?.group));
      });
      if (ok) memberHit++;
      else missingMembers.push(`${m} in ${tg.label}`);
    }
  }
  const groupRecall = ratio(memberHit, memberTotal);

  const stepsWanted = truth.steps ?? 0;
  const stepsHave = (spec.steps ?? []).length;
  // Step i must animate truth.stepEdges[i] (when the truth lists them).
  const edgeById = new Map(specEdges.filter((e) => e.id).map((e) => [e.id, e]));
  const stepMisses = [];
  (truth.stepEdges ?? []).forEach((te, i) => {
    const flows = spec.steps?.[i]?.flows ?? [];
    const covered = flows.some((f) => {
      const e = f.edge ? edgeById.get(f.edge) : f;
      if (!e) return false;
      const a = labelOf.get(e.from);
      const b = labelOf.get(e.to);
      return a === norm(te.from) && b === norm(te.to);
    });
    if (!covered) stepMisses.push(`step ${i + 1} should animate ${te.from} -> ${te.to}`);
  });
  const stepsOk = stepsHave === stepsWanted && stepMisses.length === 0;

  const failures = [];
  if (labelRecall < THRESHOLDS.labels)
    failures.push(`label recall ${pct(labelRecall)} < ${pct(THRESHOLDS.labels)}`);
  if (edgeRecall < THRESHOLDS.edges)
    failures.push(`directed edge recall ${pct(edgeRecall)} < ${pct(THRESHOLDS.edges)}`);
  if (groupRecall < THRESHOLDS.groups)
    failures.push(`group membership ${pct(groupRecall)} < ${pct(THRESHOLDS.groups)}`);
  if (nodePrecision < THRESHOLDS.precision)
    failures.push(`node precision ${pct(nodePrecision)} < ${pct(THRESHOLDS.precision)}`);
  if (edgePrecision < THRESHOLDS.precision)
    failures.push(`edge precision ${pct(edgePrecision)} < ${pct(THRESHOLDS.precision)}`);
  if (stepsHave !== stepsWanted) failures.push(`steps ${stepsHave} != expected ${stepsWanted}`);
  for (const m of stepMisses) failures.push(m);

  return {
    labelRecall,
    edgeRecall,
    undirectedEdgeRecall,
    nodePrecision,
    edgePrecision,
    groupRecall,
    steps: { have: stepsHave, wanted: stepsWanted, ok: stepsOk },
    missing: {
      labels: missingLabels.map((n) => n.label),
      edges: missingEdges,
      reversed: reversedEdges,
      members: missingMembers,
      extraNodes: extraNodes.map((n) => n.label ?? n.id),
      extraEdges: extraEdges.map((e) => `${e.from} -> ${e.to}`),
    },
    failures,
    pass: failures.length === 0,
  };
}

export const pct = (x) => `${Math.round(x * 1000) / 10}%`;

/** Runs `pcosmo validate` from the bundled plugin CLI; returns { ok, output }. */
export function validateWithCli(specPath, cli) {
  const bin =
    cli ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "bin", "pcosmo.mjs");
  try {
    const out = execFileSync(process.execPath, [bin, "validate", specPath], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { ok: true, output: out.trim() };
  } catch (e) {
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const [specPath, truthPath] = args;
  if (!specPath || !truthPath) {
    console.error("usage: check.mjs <spec.cosmo.json> <truth.json> [--no-validate]");
    return 2;
  }
  let failed = false;
  if (!argv.includes("--no-validate")) {
    const v = validateWithCli(specPath);
    console.log(`validate: ${v.ok ? "ok" : "FAILED"}${v.ok ? "" : `\n${v.output}`}`);
    failed ||= !v.ok;
  }
  const r = score(
    JSON.parse(readFileSync(specPath, "utf8")),
    JSON.parse(readFileSync(truthPath, "utf8")),
  );
  console.log(`labels:  ${pct(r.labelRecall)}`);
  console.log(`edges:   ${pct(r.edgeRecall)} directed (${pct(r.undirectedEdgeRecall)} undirected)`);
  console.log(`node precision: ${pct(r.nodePrecision)}, edge precision: ${pct(r.edgePrecision)}`);
  console.log(`groups:  ${pct(r.groupRecall)}`);
  console.log(`steps:   ${r.steps.have} (expected ${r.steps.wanted})`);
  for (const [k, v] of Object.entries(r.missing))
    if (v.length) console.log(`missing ${k}: ${v.join("; ")}`);
  for (const f of r.failures) console.log(`FAIL: ${f}`);
  return failed || !r.pass ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
