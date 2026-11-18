/**
 * Visual regression (PLAN §13): renders every bundled-icon example (examples/*.cosmo.json except
 * the provider-icon examples, D12), the lesson templates and the harness fixtures to PNG with the
 * built CLI (resvg raster path, deterministic) and compares them with committed goldens through a
 * pure-JS pixelmatch-style diff. Exact match by default.
 *
 *   scripts/pc run visual                 compare (build first)
 *   VISUAL_UPDATE=1 scripts/pc run visual write/refresh the goldens (local only)
 *   VISUAL_REQUIRE_GOLDENS=1 ...          a missing golden fails (default: skipped with a notice)
 *   VISUAL_MAX_FRACTION=0.001             local escape hatch: allowed share of differing pixels
 *                                         (0 <= x < 1, default 0 = exact)
 *   VISUAL_ONLY=examples/a,templates/b    local: restrict to these group/name keys (or bare names)
 *   VISUAL_THRESHOLD=0.1                  local: per-pixel YIQ threshold, 0 < x <= 1 (default 0.1)
 *
 * With CI set or VISUAL_REQUIRE_GOLDENS=1 (strict mode): VISUAL_UPDATE is refused (exit 2),
 * VISUAL_ONLY / VISUAL_MAX_FRACTION / VISUAL_THRESHOLD are ignored with a notice, fewer than
 * MIN_GALLERY_CASES gallery cases fail, and goldens without a spec (orphans) fail.
 *
 * Cases and goldens are keyed group/name: tests/visual/golden/<group>/<name>.png with group in
 * examples | templates | fixtures. Failures write tests/visual/out/{actual,diff}/<group>/<name>.png;
 * tests/visual/out/results.json is always written.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, decodePng, encodePng } from "./png.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const OUT = join(here, "out");
const GOLDEN = join(here, "golden");
const CLI = join(root, "packages/cli/dist/bin.js");
const PROVIDER_EXAMPLES = new Set(["aws-three-tier", "azure-web-app", "gcp-data-pipeline"]); // D12
const MIN_GALLERY_CASES = 12; // examples + templates; raise when the gallery grows

const ci = !["", "0", "false"].includes((process.env.CI ?? "").toLowerCase());
const strict = ci || process.env.VISUAL_REQUIRE_GOLDENS === "1";
const notices = [];

function configError(msg) {
  console.error(`visual: ${msg}`);
  process.exit(2);
}

function envNumber(name, fallback, ok, rule) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const x = Number(raw);
  if (!Number.isFinite(x) || !ok(x)) configError(`${name}=${JSON.stringify(raw)} invalid: ${rule}`);
  return x;
}
// Validate even in strict mode so a typo is never silently accepted.
const reqFraction = envNumber(
  "VISUAL_MAX_FRACTION",
  0,
  (x) => x >= 0 && x < 1,
  "must be a finite number with 0 <= x < 1",
);
const reqThreshold = envNumber(
  "VISUAL_THRESHOLD",
  0.1,
  (x) => x > 0 && x <= 1,
  "must be a finite number with 0 < x <= 1",
);

const wantUpdate = process.env.VISUAL_UPDATE === "1";
if (wantUpdate && strict) {
  configError(
    "VISUAL_UPDATE is refused when CI is set or VISUAL_REQUIRE_GOLDENS=1; update goldens locally",
  );
}
const update = wantUpdate;
const requireGoldens = strict;
let maxFraction = reqFraction;
let threshold = reqThreshold;
let only = process.env.VISUAL_ONLY?.split(",").filter(Boolean);
if (strict) {
  if (only) notices.push(`VISUAL_ONLY=${process.env.VISUAL_ONLY} IGNORED in strict mode`);
  if (process.env.VISUAL_MAX_FRACTION)
    notices.push(`VISUAL_MAX_FRACTION=${process.env.VISUAL_MAX_FRACTION} IGNORED in strict mode`);
  if (process.env.VISUAL_THRESHOLD)
    notices.push(`VISUAL_THRESHOLD=${process.env.VISUAL_THRESHOLD} IGNORED in strict mode`);
  only = undefined;
  maxFraction = 0;
  threshold = 0.1;
}

const specs = (group, dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".cosmo.json"))
        .sort()
        .map((f) => {
          const name = f.replace(/\.cosmo\.json$/, "");
          return {
            group,
            name,
            key: `${group}/${name}`,
            file: join(dir, f),
            golden: join(GOLDEN, group, `${name}.png`),
          };
        })
    : [];

const gallery = [
  ...specs("examples", join(root, "examples")).filter((c) => !PROVIDER_EXAMPLES.has(c.name)),
  // Lesson templates (bundled icons only) and the starter spec.
  ...specs("templates", join(root, "examples", "templates")),
];
const allCases = [...gallery, ...specs("fixtures", join(here, "fixtures"))];
const cases = only
  ? allCases.filter((c) => only.includes(c.key) || only.includes(c.name))
  : allCases;

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

if (!existsSync(CLI)) configError(`${CLI} not found: build first (pnpm build)`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const rows = [];
let failed = 0;
const fail = (key, detail) => {
  failed++;
  rows.push({ name: key, status: "FAIL", detail });
};

function finish() {
  for (const r of rows) console.log(`${r.status.padEnd(8)} ${r.name}: ${r.detail}`);
  const count = (s) => rows.filter((r) => r.status === s).length;
  const mode = strict ? "strict" : "local";
  const summary = `${count("PASS")} pass, ${count("UPDATED")} updated, ${count("SKIP")} skipped (no golden), ${failed} FAIL [${mode}]`;
  for (const n of notices) console.log(`NOTICE: ${n}`);
  console.log(summary);
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "results.json"), JSON.stringify({ summary, notices, rows }, null, 2));
  } catch (e) {
    console.error(`could not write results.json: ${e}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

try {
  if (strict && gallery.length < MIN_GALLERY_CASES) {
    fail(
      "(gallery)",
      `${gallery.length} gallery cases found, at least ${MIN_GALLERY_CASES} required`,
    );
  }
  if (!only) {
    const known = new Set(allCases.map((c) => resolve(c.golden)));
    for (const g of walk(GOLDEN).filter((p) => p.endsWith(".png"))) {
      if (!known.has(resolve(g))) {
        fail(relative(root, g), "orphan golden: no matching spec (delete it or restore the spec)");
      }
    }
  }
  for (const c of cases) {
    try {
      const renderDir = join(OUT, "render", c.group, c.name);
      const run = spawnSync(
        process.execPath,
        [
          CLI,
          "build",
          c.file,
          "-o",
          renderDir,
          "--name",
          c.name,
          "--no-animated",
          "--static",
          "--png",
        ],
        { cwd: root, encoding: "utf8" },
      );
      const pngPath = join(renderDir, `${c.name}.png`);
      if (run.status !== 0 || !existsSync(pngPath)) {
        fail(c.key, `render failed: ${(run.stderr ?? "").trim().slice(0, 300)}`);
        continue;
      }
      const actualBuf = readFileSync(pngPath);
      mkdirSync(join(OUT, "actual", c.group), { recursive: true });
      writeFileSync(join(OUT, "actual", c.group, `${c.name}.png`), actualBuf);
      if (update) {
        mkdirSync(dirname(c.golden), { recursive: true });
        writeFileSync(c.golden, actualBuf);
        rows.push({ name: c.key, status: "UPDATED", detail: relative(root, c.golden) });
        continue;
      }
      if (!existsSync(c.golden)) {
        if (requireGoldens) fail(c.key, "no golden (run with VISUAL_UPDATE=1 locally)");
        else
          rows.push({
            name: c.key,
            status: "SKIP",
            detail: "no golden (run with VISUAL_UPDATE=1)",
          });
        continue;
      }
      const result = compare(decodePng(readFileSync(c.golden)), decodePng(actualBuf), threshold);
      if (!result.sameSize) {
        fail(c.key, "image size differs from the golden");
      } else if (result.fraction > maxFraction) {
        mkdirSync(join(OUT, "diff", c.group), { recursive: true });
        writeFileSync(join(OUT, "diff", c.group, `${c.name}.png`), encodePng(result.diff));
        fail(
          c.key,
          `${result.differing} px differ (${(result.fraction * 100).toFixed(3)} % > ${(maxFraction * 100).toFixed(3)} %)`,
        );
      } else {
        rows.push({
          name: c.key,
          status: "PASS",
          detail: `${result.differing} px differ (${(result.fraction * 100).toFixed(4)} %)`,
        });
      }
    } catch (e) {
      fail(c.key, `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
  }
} catch (e) {
  fail("(run)", `unexpected error: ${e instanceof Error ? e.stack : String(e)}`.slice(0, 500));
}
finish();
