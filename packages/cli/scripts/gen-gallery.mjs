// Renders the example specs into examples/gallery/ with the built CLI (packages/cli/dist/bin.js):
//   <name>.svg (animated), <name>.static.svg, <name>.png, and <name>.steps/step-NN.svg for specs with steps.
// Output is deterministic (same spec, same bytes), so re-running changes nothing unless an engine changed.
//
//   scripts/pc run build                       (the CLI must be built first)
//   scripts/pc run gen:gallery                 render everything that can be rendered
//   scripts/pc run check:gallery               re-render the bundled-icon examples to a temp dir and fail
//                                              when a committed render differs (skips specs with none yet)
//   node packages/cli/scripts/gen-gallery.mjs [--only a,b] [--packs-dir <dir>] [--check [--min N]]
//   --check also compares provider examples whose packs are given with --packs-dir; it fails when an
//   example has no committed render and when fewer than --min (default 1) examples were compared.
//
// Provider examples (aws:, azure:, gcp: icons) need the provider packs, which are fetched on the user's
// machine and never committed (DECISIONS D12): pass --packs-dir to a directory filled by
// `pcosmo icons add aws`. Providers whose icon terms are not confirmed (Azure, Google Cloud; D30) are
// always skipped. Only rendered diagrams are committed. Each example is built into a temp directory
// and moved into place only on success.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = `${root}packages/cli/dist/bin.js`;
const outDir = `${root}examples/gallery`;

/** Providers whose icon terms need human confirmation before anything is rendered or committed. */
const TERMS_UNCONFIRMED = { azure: "Azure", gcp: "Google Cloud" };
const KNOWN_PROVIDERS = ["aws", "azure", "gcp", "cncf"];

const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--only", "--packs-dir", "--check", "--min"]);
for (const a of args) {
  if (a.startsWith("--") && !KNOWN_FLAGS.has(a)) fail(`unknown option ${a}`);
}
function opt(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--") || v === "") fail(`${name} needs a value`);
  return v;
}
function fail(msg) {
  console.error(msg);
  process.exit(1);
}
const only = opt("--only")?.split(",").filter(Boolean);
const packsDir = opt("--packs-dir");
const check = args.includes("--check");
const min = opt("--min") === undefined ? 1 : Number(opt("--min"));
if (!Number.isInteger(min) || min < 1) fail("--min must be a positive integer");

if (!existsSync(bin)) fail("packages/cli/dist/bin.js is missing; run: scripts/pc run build");

const names = readdirSync(`${root}examples`)
  .filter((f) => f.endsWith(".cosmo.json"))
  .map((f) => f.replace(/\.cosmo\.json$/, ""))
  .sort();
for (const n of only ?? []) if (!names.includes(n)) fail(`unknown example "${n}"`);

// An empty pack directory keeps host-installed packs from influencing non-provider renders.
const emptyPacks = mkdtempSync(join(tmpdir(), "pcosmo-gallery-packs-"));
const cleanup = [emptyPacks];
process.on("exit", () => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

/** Files a build of `name` produces, relative to its output dir. */
function listFiles(dir, prefix = "") {
  const out = [];
  for (const e of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${e}` : e;
    if (statSync(join(dir, e)).isDirectory()) out.push(...listFiles(join(dir, e), rel));
    else out.push(rel);
  }
  return out.sort();
}

function renderTo(name, spec, packs, dest) {
  const flags = ["--static", "--png"];
  if ((spec.steps?.length ?? 0) > 0) flags.push("--steps");
  const r = spawnSync(
    process.execPath,
    [bin, "build", `${root}examples/${name}.cosmo.json`, "-o", dest, "--name", name, ...flags],
    { encoding: "utf8", env: { ...process.env, PCOSMO_PACKS_DIR: packs } },
  );
  return r;
}

const ownedBy = (name) => (f) =>
  f === `${name}.svg` ||
  f === `${name}.static.svg` ||
  f === `${name}.png` ||
  f.startsWith(`${name}.steps/`);

let rendered = 0;
let skipped = 0;
let differing = 0;
let compared = 0;

for (const name of names) {
  if (only && !only.includes(name)) continue;
  const text = readFileSync(`${root}examples/${name}.cosmo.json`, "utf8");
  const spec = JSON.parse(text);
  const providers = [
    ...new Set([...text.matchAll(/"icon"\s*:\s*"([a-z0-9-]+):/g)].map((m) => m[1])),
  ].filter((p) => KNOWN_PROVIDERS.includes(p));

  const unconfirmed = providers.filter((p) => p in TERMS_UNCONFIRMED);
  if (unconfirmed.length > 0) {
    console.log(
      `skip ${name}: it uses ${unconfirmed.map((p) => TERMS_UNCONFIRMED[p]).join(", ")} icons; their terms require human ` +
        "confirmation, so it is not rendered",
    );
    skipped++;
    continue;
  }
  const missing = providers.filter(
    (p) => !packsDir || !existsSync(join(packsDir, p, "icons.json")),
  );
  if (missing.length > 0) {
    console.log(
      `skip ${name}: needs the ${missing.join(", ")} icon pack(s); run pcosmo icons add ${missing[0]} ` +
        "into a temp directory and pass --packs-dir (packs are never committed)",
    );
    skipped++;
    continue;
  }

  const tmp = mkdtempSync(join(tmpdir(), "pcosmo-gallery-"));
  cleanup.push(tmp);
  const r = renderTo(name, spec, providers.length > 0 ? packsDir : emptyPacks, tmp);
  if (r.status !== 0) fail(`${name}: build failed (exit ${r.status})\n${r.stderr}${r.stdout}`);
  const produced = listFiles(tmp);

  if (check) {
    const committed = existsSync(outDir) ? listFiles(outDir).filter(ownedBy(name)) : [];
    if (committed.length === 0) {
      console.error(`FAIL ${name}: no committed render; run: scripts/pc run gen:gallery`);
      differing++;
      continue;
    }
    compared++;
    const bad = [
      ...produced.filter((f) => !committed.includes(f)).map((f) => `missing: ${f}`),
      ...committed.filter((f) => !produced.includes(f)).map((f) => `stale: ${f}`),
      ...produced
        .filter((f) => committed.includes(f))
        .filter((f) => !readFileSync(join(tmp, f)).equals(readFileSync(join(outDir, f))))
        .map((f) => `differs: ${f}`),
    ];
    if (bad.length > 0) {
      console.error(`FAIL ${name}\n  ${bad.join("\n  ")}\n  run: scripts/pc run gen:gallery`);
      differing++;
    } else console.log(`ok   ${name} (${produced.length} files identical)`);
    continue;
  }

  // Success: replace this example's outputs in one step.
  mkdirSync(outDir, { recursive: true });
  for (const f of listFiles(outDir).filter(ownedBy(name))) rmSync(join(outDir, f), { force: true });
  rmSync(join(outDir, `${name}.steps`), { recursive: true, force: true });
  for (const f of produced) {
    const dest = join(outDir, f);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(tmp, f), dest);
  }
  const warnings = r.stderr.trim();
  console.log(`ok   ${name}${warnings ? `\n${warnings.replace(/^/gm, "     ")}` : ""}`);
  rendered++;
}

if (!check && packsDir) {
  const lockPath = join(packsDir, "platformcosmo-icons.lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    for (const [id, e] of Object.entries(lock.packs ?? {})) {
      console.log(
        `pack ${id}: integrity ${e.integrity}, ${e.iconCount} icons, resolved ${e.resolved}`,
      );
    }
  }
}
console.log(
  check
    ? `gallery check: compared ${compared}, ${differing === 0 ? "all identical" : `${differing} differ`}, ${skipped} skipped`
    : `gallery: ${rendered} rendered, ${skipped} skipped`,
);
if (differing > 0) process.exit(1);
if (check && compared < min) {
  console.error(`gallery check compared ${compared} example(s); at least ${min} required`);
  process.exit(1);
}
