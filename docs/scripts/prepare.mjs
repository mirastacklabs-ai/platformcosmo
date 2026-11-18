// Prepares generated site inputs: the schema at its $id path and gallery SVG previews.
// Previews need the built CLI (scripts/pc run build). While the engine stages are stubs every
// render fails; then the gallery shows specs without images and the build still succeeds
// (set PC_GALLERY_STRICT=1 to fail instead). Once at least one preview renders, a failing
// bundled-icon example is an error; provider-icon examples may fail (their packs are user-installed).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const docs = fileURLToPath(new URL("../", import.meta.url));
const root = `${docs}../`;

mkdirSync(`${docs}public/schema`, { recursive: true });
copyFileSync(`${root}schema/v1.json`, `${docs}public/schema/v1.json`);

const bin = `${root}packages/cli/dist/bin.js`;
rmSync(`${docs}public/gallery`, { recursive: true, force: true });
mkdirSync(`${docs}public/gallery`, { recursive: true });

if (!existsSync(bin)) {
  console.warn("gallery: packages/cli/dist/bin.js not built; skipping previews");
} else {
  let ok = 0;
  const failed = [];
  const hard = [];
  for (const f of readdirSync(`${root}examples`).filter((n) => n.endsWith(".cosmo.json"))) {
    const r = spawnSync(
      process.execPath,
      [bin, "build", `${root}examples/${f}`, "-o", `${docs}public/gallery`],
      { encoding: "utf8" },
    );
    if (r.status === 0) {
      ok++;
      continue;
    }
    failed.push(f);
    console.warn(`gallery: ${f} failed (exit ${r.status})\n${(r.stderr || "").trim()}`);
    const text = readFileSync(`${root}examples/${f}`, "utf8");
    if (!/"icon"\s*:\s*"(aws|azure|gcp):/.test(text)) hard.push(f);
  }
  console.log(`gallery: ${ok} previews rendered, ${failed.length} failed`);
  const engineMissing = ok === 0 && process.env.PC_GALLERY_STRICT !== "1";
  if (hard.length > 0 && !engineMissing) {
    console.error(`gallery: bundled-icon examples failed to render: ${hard.join(", ")}`);
    process.exit(1);
  }
}
