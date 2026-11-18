import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeIconIntegrity as computeIntegrity } from "@platformcosmo/core";
import { describe, expect, test } from "vitest";
import {
  LOCKFILE_NAME,
  checkManifest,
  isSafeRelPath,
  loadUserPacks,
  packsDirFor,
  readLocalPack,
  removePack,
  savePack,
} from "../src/packs.js";
import { iconPack, makeDeps, tmp } from "./helpers.js";

const ENTRY = { source: "./x", resolved: "x", license: "MIT", redistributable: true };

describe("packsDirFor", () => {
  test("precedence: flag, PCOSMO_PACKS_DIR, CLAUDE_PLUGIN_DATA, home", () => {
    const d = (env: Record<string, string>) => makeDeps("/w", { env, homedir: "/h" });
    expect(packsDirFor(d({}), "rel")).toBe("/w/rel");
    expect(packsDirFor(d({ PCOSMO_PACKS_DIR: "/p" }))).toBe("/p");
    expect(packsDirFor(d({ CLAUDE_PLUGIN_DATA: "/pd" }))).toBe("/pd/icons");
    expect(packsDirFor(d({}))).toBe("/h/.platformcosmo/icons");
  });
});

describe("isSafeRelPath", () => {
  test.each(["a.svg", "svg/a.svg"])("accepts %s", (p) => expect(isSafeRelPath(p)).toBe(true));
  test.each(["", "../a.svg", "a/../../b", "/etc/passwd", "a\\b.svg", "./a.svg", "a//b.svg", ".."])(
    "rejects %j",
    (p) => expect(isSafeRelPath(p)).toBe(false),
  );
});

describe("checkManifest", () => {
  test("accepts a valid manifest and rejects bad ones", () => {
    expect(checkManifest(iconPack().manifest)).toEqual([]);
    const bad = iconPack("Bad_ID").manifest;
    expect(checkManifest(bad).join()).toMatch(/pack\.id/);
    expect(checkManifest(null)).toHaveLength(1);
    const traversal = {
      ...iconPack().manifest,
      icons: [{ id: "x", aliases: [], category: "general", file: "../x.svg", monochrome: true }],
    };
    expect(checkManifest(traversal).join()).toMatch(/relative path/);
  });
});

describe("integrity", () => {
  test("is stable and sensitive to content", () => {
    const a = computeIntegrity(iconPack());
    expect(a).toBe(computeIntegrity(iconPack()));
    expect(a).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    expect(computeIntegrity(iconPack("mine", "<svg/>"))).not.toBe(a);
  });
});

describe("save, load, tamper, remove", () => {
  test("round trip with lockfile", async () => {
    const dir = await tmp();
    const e = await savePack(dir, iconPack(), ENTRY);
    expect(e.iconCount).toBe(1);
    const lock = JSON.parse(await readFile(join(dir, LOCKFILE_NAME), "utf8"));
    expect(lock.packs.mine.integrity).toBe(e.integrity);
    const r = await loadUserPacks(dir);
    expect(r.diagnostics).toEqual([]);
    expect(r.packs.map((p) => p.manifest.pack.id)).toEqual(["mine"]);
    expect(r.packs[0]!.files["svg/dot.svg"]).toContain("viewBox");
  });

  test("a modified icon file fails integrity and is not loaded", async () => {
    const dir = await tmp();
    await savePack(dir, iconPack(), ENTRY);
    await writeFile(join(dir, "mine", "svg", "dot.svg"), "<svg onload='x'/>");
    const r = await loadUserPacks(dir);
    expect(r.packs).toEqual([]);
    expect(r.diagnostics[0]!.code).toBe("packs/integrity-mismatch");
  });

  test("a manifest edited on disk fails integrity", async () => {
    const dir = await tmp();
    await savePack(dir, iconPack(), ENTRY);
    const mp = join(dir, "mine", "icons.json");
    const m = JSON.parse(await readFile(mp, "utf8"));
    m.pack.license = "Proprietary";
    await writeFile(mp, JSON.stringify(m));
    expect((await loadUserPacks(dir)).diagnostics[0]!.code).toBe("packs/integrity-mismatch");
  });

  test("a manifest with a traversal path is rejected on load", async () => {
    const dir = await tmp();
    await savePack(dir, iconPack(), ENTRY);
    const mp = join(dir, "mine", "icons.json");
    const m = JSON.parse(await readFile(mp, "utf8"));
    m.icons[0].file = "../../secret.svg";
    await writeFile(mp, JSON.stringify(m));
    const r = await loadUserPacks(dir);
    expect(r.packs).toEqual([]);
    expect(r.diagnostics[0]!.code).toBe("packs/load-failed");
  });

  test("savePack refuses an invalid manifest", async () => {
    const dir = await tmp();
    const p = iconPack();
    const bad = {
      ...p,
      manifest: { ...p.manifest, icons: [{ ...p.manifest.icons[0]!, file: "../x.svg" }] },
    };
    await expect(savePack(dir, bad, ENTRY)).rejects.toThrow(/invalid pack/);
  });

  test("no lockfile means no user packs; remove deletes files and entry", async () => {
    const dir = await tmp();
    expect(await loadUserPacks(dir)).toEqual({ packs: [], diagnostics: [] });
    await savePack(dir, iconPack(), ENTRY);
    expect(await removePack(dir, "mine")).toBe(true);
    expect((await loadUserPacks(dir)).packs).toEqual([]);
    expect(await removePack(dir, "mine")).toBe(false);
    await expect(removePack(dir, "../x")).rejects.toThrow(/invalid pack id/);
  });

  test("a corrupt lockfile is a diagnostic", async () => {
    const dir = await tmp();
    await writeFile(join(dir, LOCKFILE_NAME), "{nope");
    expect((await loadUserPacks(dir)).diagnostics[0]!.code).toBe("packs/lockfile-invalid");
  });
});

describe("readLocalPack", () => {
  test("reads a folder pack and explains a missing manifest", async () => {
    const dir = await tmp();
    await expect(readLocalPack(join(dir, "nope"))).rejects.toThrow(/not a directory/);
    await expect(readLocalPack(dir)).rejects.toThrow(/icons\.json not found/);
    await mkdir(join(dir, "svg"));
    await writeFile(join(dir, "icons.json"), JSON.stringify(iconPack().manifest));
    await writeFile(join(dir, "svg", "dot.svg"), "<svg/>");
    expect((await readLocalPack(dir)).manifest.pack.id).toBe("mine");
  });
});
