import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(repo, "scripts/sync-plugin-version.mjs");
const pkgFile = "packages/cli/package.json";
const pluginFile = "plugin/.claude-plugin/plugin.json";
const marketFile = ".claude-plugin/marketplace.json";
const files = [pkgFile, pluginFile, marketFile];
let tmp = "";

const sync = (...a: string[]) =>
  spawnSync(process.execPath, [script, ...a, "--root", tmp], { encoding: "utf8" });
const read = (f: string) => readFileSync(join(tmp, f), "utf8");

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "pc-sync-"));
  for (const f of files) {
    mkdirSync(dirname(join(tmp, f)), { recursive: true });
    cpSync(join(repo, f), join(tmp, f));
  }
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("sync-plugin-version", () => {
  test("real manifests are in sync", () => {
    const r = spawnSync(process.execPath, [script, "--check", "--root", repo], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
  });

  test("bump in a temp copy: check fails, sync fixes, idempotent, formatting kept", () => {
    const pkg = JSON.parse(read(pkgFile));
    pkg.version = "9.8.7";
    writeFileSync(join(tmp, pkgFile), JSON.stringify(pkg, null, 2) + "\n");

    const bad = sync("--check");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("expected 9.8.7");

    expect(sync().status).toBe(0);
    expect(JSON.parse(read(pluginFile)).version).toBe("9.8.7");
    const m = JSON.parse(read(marketFile));
    expect(m.plugins.find((p: { name: string }) => p.name === "platformcosmo").version).toBe(
      "9.8.7",
    );
    expect(sync("--check").status).toBe(0);

    const snapshot = files.map(read);
    expect(sync().status).toBe(0);
    expect(files.map(read)).toEqual(snapshot);
    expect(read(pluginFile)).toContain('"keywords": ["diagram"');
  });
});
