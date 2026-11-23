// Prepares generated site inputs: the schema at its $id path and the gallery renders.
// Committed renders (examples/gallery, made by `scripts/pc run gen:gallery`) are copied into public/gallery.
// A bundled-icon example without a committed render is rendered here with the built CLI so the gallery
// never loses its preview; provider examples are only shown when their render is committed (their icon
// packs are user-installed and their terms are handled in examples/gallery/PROVIDERS.md).
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const docs = fileURLToPath(new URL("../", import.meta.url));
const root = `${docs}../`;

mkdirSync(`${docs}public/schema`, { recursive: true });
copyFileSync(`${root}schema/v1.json`, `${docs}public/schema/v1.json`);

const target = `${docs}public/gallery`;
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const src = `${root}examples/gallery`;
if (existsSync(src)) {
  cpSync(src, target, { recursive: true, filter: (p) => !p.endsWith(".md") });
}

const bin = `${root}packages/cli/dist/bin.js`;
const missing = readdirSync(`${root}examples`)
  .filter((f) => f.endsWith(".cosmo.json"))
  .filter((f) => !existsSync(`${target}/${f.replace(/\.cosmo\.json$/, "")}.svg`))
  .filter(
    (f) =>
      !/"icon"\s*:\s*"(aws|azure|gcp|cncf):/.test(readFileSync(`${root}examples/${f}`, "utf8")),
  );
let fallback = 0;
if (missing.length > 0 && existsSync(bin)) {
  const empty = mkdtempSync(join(tmpdir(), "pcosmo-docs-packs-"));
  for (const f of missing) {
    const r = spawnSync(process.execPath, [bin, "build", `${root}examples/${f}`, "-o", target], {
      encoding: "utf8",
      env: { ...process.env, PCOSMO_PACKS_DIR: empty },
    });
    if (r.status === 0) fallback++;
    else
      console.warn(
        `gallery: ${f} could not be rendered (exit ${r.status})\n${(r.stderr || "").trim()}`,
      );
  }
  rmSync(empty, { recursive: true, force: true });
} else if (missing.length > 0) {
  console.warn(
    "gallery: packages/cli/dist/bin.js not built; previews without a committed render are skipped",
  );
}
const total = readdirSync(target).filter(
  (f) => f.endsWith(".svg") && !f.endsWith(".static.svg"),
).length;
console.log(`gallery: ${total} previews (${total - fallback} committed, ${fallback} rendered now)`);

// Light and dark variants for the site, so diagrams follow the VitePress appearance toggle. A light render
// normally carries a `@media (prefers-color-scheme: dark)` block, and inside an <img> that query follows the
// OS, not the site's toggle; the light variant is rendered without it (core `darkTheme: null`, through the
// CLI's programmatic `run` with its render wrapped) and the dark variant with `--theme dark`. The page shows
// the one that matches the active appearance (`.pc-theme-light` / `.pc-theme-dark` in brand.css).
// Needs the built CLI; without it the gallery falls back to the single committed render.
const cliIndex = `${root}packages/cli/dist/index.js`;
const cli = existsSync(cliIndex) ? await import(pathToFileURL(cliIndex).href) : undefined;

/** Renders `<name>.light.svg` and `<name>.dark.svg` into `outDir`; returns stderr on failure. */
async function renderThemed(specFile, outDir, name, packsDir) {
  for (const theme of ["light", "dark"]) {
    const deps = cli.defaultDeps();
    const render = deps.core.render;
    deps.core = {
      ...deps.core,
      render: (spec, options) => render(spec, { ...options, darkTheme: null }),
    };
    const argv = ["build", specFile, "--theme", theme, "-o", outDir, "--name", `${name}.${theme}`];
    if (packsDir) argv.push("--packs-dir", packsDir);
    const r = await cli.run(argv, deps);
    if (r.code !== 0) return `${theme}: exit ${r.code}\n${(r.stderr || "").trim()}`;
  }
  return undefined;
}

const noPacks = mkdtempSync(join(tmpdir(), "pcosmo-docs-packs-"));
if (cli) {
  // Gallery: every bundled-icon example (provider packs are user-installed, so those keep the committed
  // render). Rendered with an empty packs dir, like the fallback above.
  let themed = 0;
  for (const f of readdirSync(`${root}examples`).filter((x) => x.endsWith(".cosmo.json"))) {
    if (/"icon"\s*:\s*"(aws|azure|gcp|cncf):/.test(readFileSync(`${root}examples/${f}`, "utf8")))
      continue;
    const name = f.replace(/\.cosmo\.json$/, "");
    const err = await renderThemed(`${root}examples/${f}`, target, name, noPacks);
    if (err === undefined) themed++;
    else {
      for (const t of ["light", "dark"]) rmSync(`${target}/${name}.${t}.svg`, { force: true });
      console.warn(`gallery: ${f} light/dark variants could not be rendered (${err})`);
    }
  }
  console.log(`gallery: ${themed} examples rendered in light and dark`);
} else {
  console.warn(
    "gallery: packages/cli/dist/index.js not built; previews keep the committed render (OS color scheme)",
  );
}

// Home-page hero diagram: one example in both variants.
const heroDir = `${docs}public/hero`;
rmSync(heroDir, { recursive: true, force: true });
mkdirSync(heroDir, { recursive: true });
if (cli) {
  const err = await renderThemed(
    `${root}examples/gpu-inference-cluster.cosmo.json`,
    heroDir,
    "hero",
    noPacks,
  );
  if (err !== undefined) throw new Error(`hero could not be rendered (${err})`);
  console.log("hero: rendered light and dark");
} else {
  console.warn(
    "hero: packages/cli/dist/index.js not built; the home page hero diagram will be missing",
  );
}
rmSync(noPacks, { recursive: true, force: true });
