import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createIconResolver, sanitizeSvg } from "../../core/src/icons/index.js";
import { expectNoDrift } from "../../icons-base/test/drift.js";
import { pack } from "../src/index.js";

const ALLOWED = ["CC0-1.0", "MIT", "Apache-2.0"];

describe("icons-simple", () => {
  const resolver = createIconResolver([pack], sanitizeSvg);

  test("generated module matches icons.json and svg/", () => {
    expectNoDrift(pack, new URL("../", import.meta.url));
  });

  test("metadata and trademark notice", () => {
    expect(pack.manifest.pack).toMatchObject({ id: "simple", redistributable: true });
    expect(pack.manifest.pack.trademarkNotice).toMatch(/trademarks of their respective owners/);
    expect(pack.manifest.icons.length).toBeGreaterThanOrEqual(85);
  });

  test("only icons with an explicit permissive license are bundled", () => {
    for (const e of pack.manifest.icons) {
      expect(ALLOWED, e.id).toContain(e.license);
      expect(e.category).toBe("brand");
      expect(e.sourceUrl, e.id).toBeTypeOf("string");
      expect(resolver.resolve(`simple:${e.id}`)?.license).toBe(e.license);
    }
  });

  test("known non-permissive or unlicensed brands are absent", () => {
    for (const id of ["github", "docker", "kubernetes", "amazonaws", "googlecloud", "postgresql"]) {
      expect(
        pack.manifest.icons.some((e) => e.id === id),
        id,
      ).toBe(false);
    }
  });

  test("every icon sanitizes, is monochrome and within 8 KB", () => {
    for (const e of pack.manifest.icons) {
      const r = sanitizeSvg(pack.files[e.file] as string, { monochrome: true });
      expect(r.ok, e.id).toBe(true);
      if (r.ok) {
        expect(r.svg.body.length, e.id).toBeLessThanOrEqual(8192);
        expect(r.svg.body).toContain("currentColor");
      }
    }
  });

  test("every MIT/Apache icon has an entry and the full license texts are shipped", () => {
    const notice = readFileSync(new URL("../NOTICE-SIMPLE-ICONS.txt", import.meta.url), "utf8");
    const mirror = readFileSync(
      new URL("../../../LICENSES/NOTICE-SIMPLE-ICONS.txt", import.meta.url),
      "utf8",
    );
    expect(mirror).toBe(notice);
    const nonCc0 = pack.manifest.icons.filter((e) => e.license !== "CC0-1.0");
    expect(nonCc0.length).toBeGreaterThan(0);
    for (const e of nonCc0) {
      expect(notice, e.id).toContain(`(simple:${e.id})`);
      expect(e.sourceUrl, e.id).toMatch(/^https:\/\//);
      expect(notice, e.id).toContain(e.sourceUrl as string);
    }
    expect(notice).toContain("Permission is hereby granted, free of charge");
    expect(notice).toContain("Apache License");
    expect(notice).toContain("Version 2.0, January 2004");
    expect(notice).toMatch(/Linux Foundation trademark usage guidelines/);
  });

  test("CNCF/LF-hosted marks carry the Linux Foundation trademark note", () => {
    expect(pack.manifest.pack.trademarkNotice).toMatch(
      /Linux Foundation trademark usage guidelines/,
    );
    expect(pack.manifest.icons.some((e) => e.id === "fluentd")).toBe(true);
  });

  test("notices are shipped", () => {
    expect(existsSync(new URL("../DISCLAIMER-SIMPLE-ICONS.txt", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../../../LICENSES/simple-icons.txt", import.meta.url))).toBe(true);
  });
});
