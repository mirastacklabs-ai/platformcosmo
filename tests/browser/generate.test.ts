/**
 * Generates the browser-check fixtures into tests/browser/out/ (git-ignored). Run through
 * `tests/browser/run.sh`; it is not part of the normal test run.
 *
 * Fixtures come from the fixture RenderModel (packages/core/test/fixtures) until Track A's render
 * pipeline lands; swap `buildSvg` for `render()` output then.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { createAnimator } from "../../packages/core/src/anim/index.js";
import { buildFixture, emit } from "../../packages/core/test/anim/fixtures/render-model.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "out");
const animator = createAnimator();

function buildSvg(mode: "loop" | "interactive", prefix: string): string {
  const model = buildFixture({ prefix });
  return emit(model, animator.animate(model, { speed: 1, mode }), { font: "system" });
}

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title><style>` +
  `html,body{margin:0;background:#fff}#host{width:560px;height:320px}` +
  `#host>svg,#host>img,#host>object{width:560px;height:320px;display:block}</style></head>` +
  `<body><div id="host">${body}</div></body></html>`;

test("generate browser fixtures", () => {
  mkdirSync(out, { recursive: true });
  const loop = buildSvg("loop", "pc-test");
  const interactive = buildSvg("interactive", "pc-x");
  writeFileSync(join(out, "loop.svg"), loop);
  writeFileSync(join(out, "interactive.svg"), interactive);
  writeFileSync(join(out, "page-img.html"), page('<img id="el" src="loop.svg" alt="">'));
  // Same diagram without the reduced-motion block: shows <img> animation works where an engine's
  // image documents report reduced motion (headless WebKit).
  const stripped = loop.replace(
    /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\n\}(?=\]\]>)/,
    "",
  );
  if (stripped === loop) throw new Error("reduced-motion block not found");
  writeFileSync(join(out, "loop-noreduced.svg"), stripped);
  writeFileSync(
    join(out, "page-img-noreduced.html"),
    page('<img id="el" src="loop-noreduced.svg" alt="">'),
  );
  writeFileSync(
    join(out, "page-object.html"),
    page('<object id="el" data="loop.svg" type="image/svg+xml"></object>'),
  );
  writeFileSync(join(out, "page-inline.html"), page(loop));
  writeFileSync(join(out, "page-interactive.html"), page(interactive));
});
