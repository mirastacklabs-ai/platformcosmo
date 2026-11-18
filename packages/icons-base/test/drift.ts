import { readFileSync } from "node:fs";
import { expect } from "vitest";
import type { LoadedIconPack } from "../../core/src/index.js";
import { minify } from "../scripts/minify.mjs";

/**
 * Fails when a pack's generated module is out of sync with its `icons.json` + `svg/` sources
 * (run `node packages/icons-base/scripts/gen-pack.mjs <package dir>` to regenerate).
 */
export function expectNoDrift(pack: LoadedIconPack, packageDir: URL): void {
  const manifest = JSON.parse(readFileSync(new URL("icons.json", packageDir), "utf8")) as {
    icons: { id: string; file: string }[];
  };
  manifest.icons.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  expect(JSON.parse(JSON.stringify(pack.manifest))).toEqual(manifest);
  expect(Object.keys(pack.files).sort()).toEqual(manifest.icons.map((i) => i.file).sort());
  for (const i of manifest.icons) {
    const src = readFileSync(new URL(i.file, packageDir), "utf8");
    expect(pack.files[i.file], i.file).toBe(minify(src));
  }
}
