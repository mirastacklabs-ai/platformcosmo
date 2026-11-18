/**
 * Visual regression (PLAN §13): renders every bundled-icon example (examples/*.cosmo.json except
 * the provider-icon examples, D12) and the harness fixtures to PNG with the built CLI (resvg
 * raster path, deterministic) and compares them with committed goldens through a pure-JS
 * pixelmatch-style diff.
 *
 *   scripts/pc run visual                 compare (build first)
 *   VISUAL_UPDATE=1 scripts/pc run visual write/refresh the goldens
 *   VISUAL_REQUIRE_GOLDENS=1 ...          a missing golden fails (default: skipped with a notice)
 *   VISUAL_MAX_FRACTION=0.001             allowed share of differing pixels (default 0.1 %)
 *   VISUAL_ONLY=a,b                       restrict to these names
 *   VISUAL_THRESHOLD=0.1                per-pixel YIQ threshold, pixelmatch semantics
 *
 * Gallery goldens: tests/visual/golden/<name>.png. Fixture goldens (harness self-check):
 * tests/visual/fixtures/golden/<name>.png. Failures write tests/visual/out/{actual,diff}/.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, decodePng, encodePng } from "./png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const OUT = join(here, "out");
const CLI = join(root, "packages/cli/dist/bin.js");
const PROVIDER_EXAMPLES = new Set(["aws-three-tier", "azure-web-app", "gcp-data-pipeline"]); // D12

const update = process.env.VISUAL_UPDATE === "1";
const requireGoldens = process.env.VISUAL_REQUIRE_GOLDENS === "1";
const maxFraction = Number(process.env.VISUAL_MAX_FRACTION ?? "0.001");
const threshold = Number(process.env.VISUAL_THRESHOLD ?? "0.1");

const specs = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".cosmo.json"))
        .sort()
        .map((f) => ({ name: f.replace(/\.cosmo\.json$/, ""), file: join(dir, f) }))
    : [];

const cases = [
  ...specs(join(root, "examples"))
    .filter((c) => !PROVIDER_EXAMPLES.has(c.name))
    .map((c) => ({ ...c, golden: join(here, "golden", `${c.name}.png`) })),
  // Lesson templates (bundled icons only) and the starter spec.
  ...specs(join(root, "examples", "templates")).map((c) => ({
    ...c,
    golden: join(here, "golden", "templates", `${c.name}.png`),
  })),
  ...specs(join(here, "fixtures")).map((c) => ({
    ...c,
    golden: join(here, "fixtures", "golden", `${c.name}.png`),
  })),
];

const only = process.env.VISUAL_ONLY?.split(",").filter(Boolean);
if (only) cases.splice(0, cases.length, ...cases.filter((c) => only.includes(c.name)));

if (!existsSync(CLI)) {
  console.error(`${CLI} not found: build first (pnpm build)`);
  process.exit(2);
}
rmSync(OUT, { recursive: true, force: true });
for (const d of ["actual", "diff", "render"]) mkdirSync(join(OUT, d), { recursive: true });

const rows = [];
let failed = 0;
for (const c of cases) {
  const renderDir = join(OUT, "render", c.name);
  const run = spawnSync(
    process.execPath,
    [CLI, "build", c.file, "-o", renderDir, "--name", c.name, "--no-animated", "--static", "--png"],
    { cwd: root, encoding: "utf8" },
  );
  const pngPath = join(renderDir, `${c.name}.png`);
  if (run.status !== 0 || !existsSync(pngPath)) {
    rows.push({
      name: c.name,
      status: "FAIL",
      detail: `render failed: ${run.stderr.trim().slice(0, 300)}`,
    });
    failed++;
    continue;
  }
  const actualBuf = readFileSync(pngPath);
  writeFileSync(join(OUT, "actual", `${c.name}.png`), actualBuf);
  if (update) {
    mkdirSync(dirname(c.golden), { recursive: true });
    writeFileSync(c.golden, actualBuf);
    rows.push({ name: c.name, status: "UPDATED", detail: c.golden.replace(`${root}/`, "") });
    continue;
  }
  if (!existsSync(c.golden)) {
    const status = requireGoldens ? "FAIL" : "SKIP";
    if (requireGoldens) failed++;
    rows.push({ name: c.name, status, detail: "no golden (run with VISUAL_UPDATE=1)" });
    continue;
  }
  const result = compare(decodePng(readFileSync(c.golden)), decodePng(actualBuf), threshold);
  if (!result.sameSize) {
    failed++;
    rows.push({ name: c.name, status: "FAIL", detail: "image size differs from the golden" });
  } else if (result.fraction > maxFraction) {
    failed++;
    writeFileSync(join(OUT, "diff", `${c.name}.png`), encodePng(result.diff));
    rows.push({
      name: c.name,
      status: "FAIL",
      detail: `${result.differing} px differ (${(result.fraction * 100).toFixed(3)} % > ${(maxFraction * 100).toFixed(3)} %)`,
    });
  } else {
    rows.push({
      name: c.name,
      status: "PASS",
      detail: `${result.differing} px differ (${(result.fraction * 100).toFixed(4)} %)`,
    });
  }
}

for (const r of rows) console.log(`${r.status.padEnd(8)} ${r.name}: ${r.detail}`);
const count = (s) => rows.filter((r) => r.status === s).length;
const summary = `${count("PASS")} pass, ${count("UPDATED")} updated, ${count("SKIP")} skipped (no golden), ${failed} FAIL`;
console.log(summary);
writeFileSync(join(OUT, "results.json"), JSON.stringify({ summary, rows }, null, 2));
process.exit(failed === 0 ? 0 : 1);
