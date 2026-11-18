// Renders the example specs into examples/gallery/ with the built CLI (packages/cli/dist/bin.js):
//   <name>.svg (animated), <name>.static.svg, <name>.png, and <name>.steps/step-NN.svg for specs with steps.
// Output is deterministic (same spec, same bytes), so re-running changes nothing unless an engine changed.
//
//   scripts/pc run build                       (the CLI must be built first)
//   scripts/pc run gen:gallery                 render everything that can be rendered
//   node packages/cli/scripts/gen-gallery.mjs [--only a,b] [--packs-dir <dir>]
//
// Provider examples (aws:, azure:, gcp: icons) need the provider packs, which are fetched on the user's
// machine and never committed (DECISIONS D12): pass --packs-dir to a directory filled by
// `pcosmo icons add aws|gcp`. Azure's icon terms must be accepted by a human, so Azure examples are
// always skipped here. Only the rendered diagrams are committed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bin = `${root}packages/cli/dist/bin.js`;
const outDir = `${root}examples/gallery`;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt("--only")?.split(",").filter(Boolean);
const packsDir = opt("--packs-dir");

if (!existsSync(bin)) {
  console.error("packages/cli/dist/bin.js is missing; run: scripts/pc run build");
  process.exit(1);
}

const names = readdirSync(`${root}examples`)
  .filter((f) => f.endsWith(".cosmo.json"))
  .map((f) => f.replace(/\.cosmo\.json$/, ""))
  .sort();
for (const n of only ?? []) {
  if (!names.includes(n)) {
    console.error(`unknown example "${n}"`);
    process.exit(1);
  }
}

// An empty pack directory keeps host-installed packs from influencing non-provider renders.
const emptyPacks = mkdtempSync(join(tmpdir(), "pcosmo-gallery-"));
mkdirSync(outDir, { recursive: true });
let rendered = 0;
let skipped = 0;

for (const name of names) {
  if (only && !only.includes(name)) continue;
  const text = readFileSync(`${root}examples/${name}.cosmo.json`, "utf8");
  const spec = JSON.parse(text);
  const providers = [
    ...new Set([...text.matchAll(/"icon"\s*:\s*"([a-z0-9-]+):/g)].map((m) => m[1])),
  ].filter((p) => ["aws", "azure", "gcp", "cncf"].includes(p));

  if (providers.includes("azure")) {
    console.log(
      `skip ${name}: it uses Azure icons and Azure's icon terms must be accepted by a human ` +
        "(pcosmo icons add azure --accept-terms); not rendered",
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

  for (const f of [`${name}.svg`, `${name}.static.svg`, `${name}.png`])
    rmSync(join(outDir, f), { force: true });
  rmSync(join(outDir, `${name}.steps`), { recursive: true, force: true });

  const flags = ["--static", "--png"];
  if ((spec.steps?.length ?? 0) > 0) flags.push("--steps");
  const r = spawnSync(
    process.execPath,
    [bin, "build", `${root}examples/${name}.cosmo.json`, "-o", outDir, ...flags],
    {
      encoding: "utf8",
      env: { ...process.env, PCOSMO_PACKS_DIR: providers.length > 0 ? packsDir : emptyPacks },
    },
  );
  if (r.status !== 0) {
    console.error(`${name}: build failed (exit ${r.status})\n${r.stderr}${r.stdout}`);
    rmSync(emptyPacks, { recursive: true, force: true });
    process.exit(1);
  }
  const warnings = r.stderr.trim();
  console.log(`ok   ${name}${warnings ? `\n${warnings.replace(/^/gm, "     ")}` : ""}`);
  rendered++;
}
rmSync(emptyPacks, { recursive: true, force: true });
console.log(`gallery: ${rendered} rendered, ${skipped} skipped`);
