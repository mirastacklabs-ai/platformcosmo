/**
 * The hostile PDFs of C-2's crafted.test.ts, driven through the CLI: each must finish in bounded
 * time with bounded output, exit 0 or 1 (never a crash, never exit 3), and say what happened
 * with documented diagnostic codes that carry page / image / bbox params.
 */
import { readdir } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { CASES } from "../../pdf/test/fixtures/crafted.js";
import * as g from "../../pdf/test/fixtures/gen.js";
import { type Diag, expectKnownCodes, json, pdf, put, work } from "./pdf-helpers.js";

const argsFor = (walk: string): string[] => {
  switch (walk) {
    case "open":
      return ["info"];
    case "list":
      return ["list", "--pages", "1"];
    case "list-all-pages":
      return ["list"];
    default:
      return ["text", "--page", "1"];
  }
};

describe("crafted inputs through the CLI", () => {
  test.each(CASES.map((c) => [c.name, c] as const))(
    "%s",
    async (_name, c) => {
      const dir = await work();
      await put(dir, "h.pdf", c.build());
      const [sub, ...rest] = argsFor(c.walk);
      const t0 = performance.now();
      const r = await pdf(dir, [sub!, "h.pdf", ...rest, "--json"]);
      const ms = performance.now() - t0;
      expect(ms, "time (ms)").toBeLessThan(30_000);
      expect([0, 1], `exit ${r.code}: ${r.stderr.slice(0, 300)}`).toContain(r.code);
      expect(r.stdout.length).toBeLessThan(8 * 1024 * 1024);
      const j = json(r.stdout);
      expect(typeof j.ok).toBe("boolean");
      expect(j.ok).toBe(r.code === 0);
      expectKnownCodes(j.diagnostics);
      expect(j.diagnostics.length).toBeLessThanOrEqual(300);
      for (const d of j.diagnostics as Diag[]) {
        if (d.code.startsWith("pdf/") && !d.code.startsWith("pdf/renderer")) {
          for (const k of ["page", "image", "bbox"]) expect(d.params, d.code).toHaveProperty(k);
        }
      }
      expect(await readdir(dir)).toEqual(["h.pdf"]);
    },
    90_000,
  );

  test("extract --all and compose on hostile images stay bounded and write only fixed names", async () => {
    const dir = await work();
    await put(dir, "bomb.pdf", g.bombImagePdf(300 * 1024 * 1024));
    await put(dir, "act.pdf", g.activeContentPdf());
    for (const f of ["bomb.pdf", "act.pdf"]) {
      for (const args of [
        ["extract", f, "--all", "-d", `o-${f}`, "--min-px", "0"],
        ["compose", f, "--page", "1", "-o", `${f}.png`, "--dpi", "36"],
        ["compose", f, "--page", "1", "-o", `${f}.svg`],
        ["text", f, "--page", "1"],
      ]) {
        const r = await pdf(dir, [...args, "--json"]);
        expect([0, 1], `${args.join(" ")}: ${r.stderr.slice(0, 200)}`).toContain(r.code);
        expectKnownCodes(json(r.stdout).diagnostics);
      }
    }
    for (const n of await readdir(dir))
      expect(n).toMatch(/^(bomb\.pdf|act\.pdf)(\.png|\.svg)?$|^o-(bomb|act)\.pdf$/);
  }, 90_000);
});
