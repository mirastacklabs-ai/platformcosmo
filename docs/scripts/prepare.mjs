// Prepares generated site inputs: the schema at its $id path and gallery SVG previews.
// Previews need the built CLI (scripts/pc run build) and a working engine; when either is
// missing the gallery page shows the specs without images and the build still succeeds.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const docs = fileURLToPath(new URL("../", import.meta.url));
const root = `${docs}../`;

mkdirSync(`${docs}public/schema`, { recursive: true });
copyFileSync(`${root}schema/v1.json`, `${docs}public/schema/v1.json`);

const bin = `${root}packages/cli/dist/bin.js`;
mkdirSync(`${docs}public/gallery`, { recursive: true });
if (!existsSync(bin)) {
  console.warn("gallery: packages/cli/dist/bin.js not built; skipping previews");
} else {
  let ok = 0;
  let skipped = 0;
  for (const f of readdirSync(`${root}examples`).filter((n) => n.endsWith(".cosmo.json"))) {
    const r = spawnSync(
      process.execPath,
      [bin, "build", `${root}examples/${f}`, "-o", `${docs}public/gallery`],
      { encoding: "utf8" },
    );
    if (r.status === 0) ok++;
    else skipped++;
  }
  console.log(
    `gallery: ${ok} previews rendered, ${skipped} skipped (engine or icon packs missing)`,
  );
}
