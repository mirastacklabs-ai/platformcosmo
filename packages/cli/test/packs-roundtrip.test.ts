import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { computeIconIntegrity, verifyIconIntegrity } from "@platformcosmo/core";
import { describe, expect, test } from "vitest";
import { loadUserPacks, readPackDir, savePack } from "../src/packs.js";
import { iconPack, tmp } from "./helpers.js";

const ENTRY = { source: "./x", resolved: "x", license: "MIT", redistributable: true };

describe("write -> read -> verify with core's integrity", () => {
  const awkward = [
    "<svg viewBox='0 0 1 1'/>",
    "﻿<svg>\r\n  <title>café ☃ \u{1F600}</title>\r\n</svg>\r\n  ",
    "<svg>\ttabs and trailing space \n\n</svg>\n\n",
  ];

  test.each(awkward)("file content %j survives byte-exact", async (svg) => {
    const dir = await tmp();
    const pack = iconPack("mine", svg);
    const entry = await savePack(dir, pack, ENTRY);
    // The lockfile hash is core's, over what a reader will see.
    expect(entry.integrity).toBe(computeIconIntegrity(pack));
    const raw = await readFile(join(dir, "mine", "svg", "dot.svg"));
    expect(Buffer.compare(raw, Buffer.from(svg, "utf8"))).toBe(0);
    const back = await readPackDir(join(dir, "mine"));
    expect(back.files["svg/dot.svg"]).toBe(svg);
    expect(verifyIconIntegrity(back, entry.integrity)).toBe(true);
    const loaded = await loadUserPacks(dir);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.packs).toHaveLength(1);
  });

  test("text that is not valid UTF-8 (lone surrogate) is refused instead of silently altered", async () => {
    const dir = await tmp();
    await expect(savePack(dir, iconPack("mine", "<svg>\uD800</svg>"), ENTRY)).rejects.toThrow(
      /not valid UTF-8/,
    );
  });
});
