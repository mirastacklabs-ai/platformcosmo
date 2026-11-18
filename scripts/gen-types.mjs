// Generate TS types from schema/v1.json (single source of truth).
// `--check` regenerates to a temp file and fails if the committed output differs.
import { compile } from "json-schema-to-typescript";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCHEMA = "schema/v1.json";
const OUT = "packages/core/src/schema/types.gen.ts";

const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
const ts = await compile(schema, "PlatformCosmoSpec", {
  bannerComment:
    "/* eslint-disable */\n/**\n * GENERATED from schema/v1.json by scripts/gen-types.mjs. Do not edit.\n * Run `pnpm gen:types` to regenerate.\n */",
  additionalProperties: false,
  format: false,
  cwd: process.cwd(),
});

if (process.argv.includes("--check")) {
  const tmp = join(mkdtempSync(join(tmpdir(), "pcosmo-gen-")), "types.gen.ts");
  writeFileSync(tmp, ts);
  const current = readFileSync(OUT, "utf8");
  if (readFileSync(tmp, "utf8") !== current) {
    console.error(`${OUT} is stale. Run "pnpm gen:types" and commit the result.`);
    process.exit(1);
  }
  console.log(`${OUT} is up to date.`);
} else {
  writeFileSync(OUT, ts);
  console.log(`wrote ${OUT}`);
}
