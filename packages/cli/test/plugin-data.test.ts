import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { run } from "../src/index.js";
import { SPEC, makeDeps, tmp } from "./helpers.js";

describe("unsubstituted CLAUDE_PLUGIN_DATA", () => {
  test.each(["/icons", "${CLAUDE_PLUGIN_DATA}/icons"])("--packs-dir %s is refused", async (v) => {
    const dir = await tmp();
    await writeFile(join(dir, "demo.cosmo.json"), SPEC);
    for (const args of [
      ["validate", "demo.cosmo.json", "--packs-dir", v],
      ["build", "demo.cosmo.json", "--packs-dir", v],
      ["icons", "list", "--packs-dir", v],
    ]) {
      const r = await run(args, makeDeps(dir));
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("cli/plugin-data-unset");
    }
  });

  test("the guard also covers PCOSMO_PACKS_DIR; a real directory works", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "demo.cosmo.json"), SPEC);
    const bad = await run(
      ["validate", "demo.cosmo.json"],
      makeDeps(dir, { env: { PCOSMO_PACKS_DIR: "/icons" } }),
    );
    expect(bad.stderr).toContain("cli/plugin-data-unset");
    const ok = await run(
      ["validate", "demo.cosmo.json", "--packs-dir", join(dir, "p")],
      makeDeps(dir),
    );
    expect(ok.code).toBe(0);
  });
});

describe("third-party notices", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  test("generated file carries full license text for the bundled packages", () => {
    const text = readFileSync(join(root, "plugin/THIRD_PARTY_NOTICES.md"), "utf8");
    expect(text).toContain("## ajv ");
    expect(text).toMatch(/Permission is hereby granted, free of charge/);
    expect(text).not.toContain("## @platformcosmo/");
  });
  test("skills no longer pre-approve a bare `examples *`", () => {
    const text = readFileSync(join(root, "plugin/skills/diagram/SKILL.md"), "utf8");
    const tools = /^allowed-tools: (.*)$/m.exec(text)?.[1] ?? "";
    expect(tools).not.toMatch(/examples \*/);
    expect(tools).toContain("examples copy *");
  });
});
