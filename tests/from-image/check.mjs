// Scores a generated spec against an image's ground truth (no LLM involved).
// Usage: node tests/from-image/check.mjs <spec.cosmo.json> <truth.json> [--no-validate]
// Exit 1 when the spec is invalid or below thresholds (labels >= 90%, edges >= 80%, groups >= 80%,
// steps >= truth.steps).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const THRESHOLDS = { labels: 0.9, edges: 0.8, groups: 0.8 };

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

  const pairs = new Set();
  for (const e of spec.edges ?? []) {
    pairs.add(`${e.from}\u0000${e.to}`);
    pairs.add(`${e.to}\u0000${e.from}`); // order-insensitive
  }
  const missingEdges = (truth.edges ?? []).filter(
    (e) => !ids(e.from).some((a) => ids(e.to).some((b) => pairs.has(`${a}\u0000${b}`))),
  );
  const edgeRecall = ratio(
    (truth.edges ?? []).length - missingEdges.length,
    (truth.edges ?? []).length,
  );

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
  const stepsOk = stepsHave >= stepsWanted;

  const failures = [];
  if (labelRecall < THRESHOLDS.labels)
    failures.push(`label recall ${pct(labelRecall)} < ${pct(THRESHOLDS.labels)}`);
  if (edgeRecall < THRESHOLDS.edges)
    failures.push(`edge recall ${pct(edgeRecall)} < ${pct(THRESHOLDS.edges)}`);
  if (groupRecall < THRESHOLDS.groups)
    failures.push(`group membership ${pct(groupRecall)} < ${pct(THRESHOLDS.groups)}`);
  if (!stepsOk) failures.push(`steps ${stepsHave} < expected ${stepsWanted}`);

  return {
    labelRecall,
    edgeRecall,
    groupRecall,
    steps: { have: stepsHave, wanted: stepsWanted, ok: stepsOk },
    missing: {
      labels: missingLabels.map((n) => n.label),
      edges: missingEdges.map((e) => `${e.from} -> ${e.to}`),
      members: missingMembers,
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
  console.log(`edges:   ${pct(r.edgeRecall)}`);
  console.log(`groups:  ${pct(r.groupRecall)}`);
  console.log(`steps:   ${r.steps.have} (expected >= ${r.steps.wanted})`);
  for (const [k, v] of Object.entries(r.missing))
    if (v.length) console.log(`missing ${k}: ${v.join("; ")}`);
  for (const f of r.failures) console.log(`FAIL: ${f}`);
  return failed || !r.pass ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
