// Prepares generated site inputs: the schema at its $id path and the committed gallery renders.
// Renders live in examples/gallery (made by `scripts/pc run gen:gallery`, committed); they are copied
// into public/gallery so the gallery page can show them. Specs without a committed render appear
// without an image.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const docs = fileURLToPath(new URL("../", import.meta.url));
const root = `${docs}../`;

mkdirSync(`${docs}public/schema`, { recursive: true });
copyFileSync(`${root}schema/v1.json`, `${docs}public/schema/v1.json`);

rmSync(`${docs}public/gallery`, { recursive: true, force: true });
mkdirSync(`${docs}public/gallery`, { recursive: true });
const src = `${root}examples/gallery`;
if (existsSync(src)) {
  cpSync(src, `${docs}public/gallery`, { recursive: true, filter: (p) => !p.endsWith(".md") });
  const n = readdirSync(src).filter((f) => f.endsWith(".svg") && !f.endsWith(".static.svg")).length;
  console.log(`gallery: ${n} committed renders copied`);
} else {
  console.warn("gallery: examples/gallery not found; the page shows specs without images");
}
