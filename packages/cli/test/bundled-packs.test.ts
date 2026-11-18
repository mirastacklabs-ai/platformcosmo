import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { defaultDeps, run } from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("bundled icon packs (real wiring)", () => {
  test("icons list shows cosmo, lucide, k8s and simple, in that order, with 276 icons in total", async () => {
    const packs = await mkdtemp(join(tmpdir(), "pcosmo-packs-"));
    dirs.push(packs);
    const r = await run(["icons", "list", "--packs-dir", packs], {
      ...defaultDeps(),
      env: {},
    });
    expect(r.code).toBe(0);
    const rows = r.stdout
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/));
    expect(rows.map((c) => c[0])).toEqual(["cosmo", "lucide", "k8s", "simple"]);
    expect(rows.every((c) => c[1] === "bundled")).toBe(true);
    const counts = r.stdout.match(/(\d+) icons?/g)?.map((m) => Number.parseInt(m, 10)) ?? [];
    expect(counts.reduce((a, b) => a + b, 0)).toBe(276);
  });
});
