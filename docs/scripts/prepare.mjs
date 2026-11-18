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
import { fileURLToPath, URL } from "node:url";

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
