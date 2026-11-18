import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createIconResolver, sanitizeSvg } from "../../core/src/icons/index.js";
import { pack } from "../src/index.js";

describe("icons-k8s", () => {
  const resolver = createIconResolver([pack], sanitizeSvg);

  test("metadata", () => {
    expect(pack.manifest.pack).toMatchObject({
      id: "k8s",
      license: "Apache-2.0",
      redistributable: true,
    });
    expect(pack.manifest.pack.trademarkNotice).toMatch(/Linux Foundation/);
    expect(pack.manifest.pack.version).toMatch(/^community@[0-9a-f]{12}$/);
    expect(pack.manifest.icons.length).toBeGreaterThanOrEqual(30);
  });

  test("every icon sanitizes cleanly, keeps its colors and is within 8 KB", () => {
    for (const e of pack.manifest.icons) {
      expect(e.monochrome).toBe(false);
      expect(e.provider).toBe("kubernetes");
      expect(e.sourceUrl).toMatch(/kubernetes\/community\/blob\/[0-9a-f]{40}\/icons\/svg\//);
      const r = sanitizeSvg(pack.files[e.file] as string);
      expect(r.ok, e.id).toBe(true);
      if (r.ok) {
        expect(r.removed, e.id).toEqual([]);
        expect(r.svg.body.length, e.id).toBeLessThanOrEqual(8192);
        expect(r.svg.body, e.id).toContain("#326ce5");
        expect(r.svg.body).not.toMatch(/<text|<style|sodipodi|inkscape/);
      }
    }
  });

  test("short kubectl names are aliases", () => {
    expect(resolver.resolve("k8s:deploy")?.ref).toBe("k8s:deployment");
    expect(resolver.resolve("k8s:svc")?.ref).toBe("k8s:service");
    expect(resolver.resolve("k8s:ing")?.ref).toBe("k8s:ingress");
    expect(resolver.resolve("k8s:pod")?.license).toBe("Apache-2.0");
  });

  test("notices are shipped", () => {
    expect(existsSync(new URL("../NOTICE-K8S.txt", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../../../LICENSES/k8s.txt", import.meta.url))).toBe(true);
  });
});
