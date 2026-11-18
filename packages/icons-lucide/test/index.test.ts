import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createIconResolver, sanitizeSvg } from "../../core/src/icons/index.js";
import { pack } from "../src/index.js";

describe("icons-lucide", () => {
  const resolver = createIconResolver([pack], sanitizeSvg);

  test("metadata", () => {
    expect(pack.manifest.pack).toMatchObject({
      id: "lucide",
      license: "ISC",
      redistributable: true,
    });
    expect(pack.manifest.pack.attribution).toMatch(/Cole Bemis/);
    expect(pack.manifest.icons.length).toBeGreaterThanOrEqual(150);
  });

  test("Feather-derived icons carry the MIT license, others inherit ISC", () => {
    const byId = new Map(pack.manifest.icons.map((e) => [e.id, e]));
    for (const id of ["server", "database", "lock", "key", "monitor", "smartphone"]) {
      expect(byId.get(id)?.license, id).toBe("MIT");
      expect(resolver.resolve(`lucide:${id}`)?.license).toBe("MIT");
    }
    expect(byId.get("brain")?.license).toBeUndefined();
    expect(resolver.resolve("lucide:brain")?.license).toBe("ISC");
    for (const e of pack.manifest.icons) expect([undefined, "MIT"]).toContain(e.license);
  });

  test("every icon sanitizes, is monochrome and within 8 KB", () => {
    for (const e of pack.manifest.icons) {
      const r = sanitizeSvg(pack.files[e.file] as string, { monochrome: true });
      expect(r.ok, e.id).toBe(true);
      if (r.ok) {
        expect(r.svg.body.length, e.id).toBeLessThanOrEqual(8192);
        expect(r.svg.viewBox).toBe("0 0 24 24");
        expect(e.sourceUrl).toContain("lucide-static@");
      }
    }
  });

  test("old names resolve as aliases", () => {
    expect(resolver.resolve("lucide:alert-circle")?.ref).toBe("lucide:circle-alert");
  });

  test("license notices are shipped", () => {
    const text = readFileSync(new URL("../LICENSE-LUCIDE", import.meta.url), "utf8");
    expect(text).toContain("ISC License");
    expect(text).toContain("Cole Bemis");
    expect(existsSync(new URL("../../../LICENSES/lucide.txt", import.meta.url))).toBe(true);
  });
});
