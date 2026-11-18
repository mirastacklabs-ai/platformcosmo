// Builds the single-file CLI the Claude Code plugin ships: plugin/bin/pcosmo.mjs.
// Bundles the CLI and every @platformcosmo/* package from source (no build order needed) plus
// all third-party deps, so the installed plugin needs nothing but Node >= 22.12.
//
//   node packages/cli/scripts/bundle-plugin.mjs            rebuild plugin/bin/pcosmo.mjs
//   node packages/cli/scripts/bundle-plugin.mjs --check    fail when the committed bundle is stale
//
// The output is minified with no path comments, so it is byte-stable for identical sources.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const outfile = `${root}plugin/bin/pcosmo.mjs`;
const src = (pkg) => `${root}packages/${pkg}/src/index.ts`;

const result = await build({
  entryPoints: [`${root}packages/cli/src/bin.ts`],
  outfile,
  write: false,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  charset: "ascii",
  logLevel: "warning",
  alias: {
    "@platformcosmo/core": src("core"),
    "@platformcosmo/themes": src("themes"),
    "@platformcosmo/dc-pack": src("dc-pack"),
    "@platformcosmo/icons-base": src("icons-base"),
  },
  // CommonJS deps (ajv) call require() on Node builtins; give the ESM bundle a require.
  banner: {
    js: '/* eslint-disable */\nimport{createRequire as __pcRequire}from"node:module";const require=__pcRequire(import.meta.url);',
  },
});

const text = result.outputFiles[0].text;
// esbuild keeps the entry's shebang first; the launcher runs `node pcosmo.mjs`, so drop it.
const out = text.startsWith("#!") ? text.slice(text.indexOf("\n") + 1) : text;

if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(outfile, "utf8");
  } catch {
    /* missing */
  }
  if (cur !== out) {
    console.error(
      "plugin/bin/pcosmo.mjs is stale (sources changed). Run: scripts/pc run bundle:plugin and commit it.",
    );
    process.exit(1);
  }
  console.log("plugin/bin/pcosmo.mjs is up to date");
} else {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(`${root}plugin/bin`, { recursive: true });
  writeFileSync(outfile, out);
  console.log(`wrote plugin/bin/pcosmo.mjs (${out.length} bytes)`);
}
