/**
 * Limits (ingestion §14) and robustness: every cap returns a diagnostic before the work it bounds,
 * nothing throws on hostile input, and runs stay bounded in time. The internal bug guard of the
 * public API must never fire (it would hide a throw).
 */
import { describe, expect, it } from "vitest";
import { figure } from "../../../tests/fixtures/figures/gen.mjs";
import { checkFigure, cutout, runFigure, type Raster } from "../src/index.js";
import { rng } from "./fixtures.js";
import { run, sourcesOf } from "./figure-helpers.js";

const GUARD = /could not be processed/;
const codes = (r: { diagnostics: readonly { code: string }[] }): string[] =>
  r.diagnostics.map((d) => d.code);
const noGuard = (r: { diagnostics: readonly { message: string }[] }): void => {
  for (const d of r.diagnostics) expect(d.message).not.toMatch(GUARD);
};

describe("figure limits", () => {
  it("refuses a source above 16 MP before analysing it", () => {
    const big: Raster = { width: 4097, height: 4097, data: new Uint8Array(4097 * 4097 * 4) };
    const m = {
      sources: { exploded: "a.png" },
      parts: [{ id: "a", seeds: { exploded: [[1, 1]] } }],
    };
    const t0 = Date.now();
    const r = runFigure(m, { "a.png": big });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.value).toBeUndefined();
    expect(codes(r)).toEqual(["asset/too-large"]);
  });

  it("honours a lower pixel limit and refuses more than 64 parts", () => {
    const f = figure("main");
    expect(codes(runFigure(f.manifest, sourcesOf(f), { maxPixels: 10_000 }))).toContain(
      "asset/too-large",
    );
    const parts = Array.from({ length: 65 }, (_, i) => ({
      id: `p${i}`,
      seeds: { exploded: [[1, 1]] },
    }));
    expect(codes(runFigure({ ...f.manifest, parts }, sourcesOf(f)))).toEqual(["asset/too-large"]);
  });

  it("refuses matching above the multiply-add budget (asset/too-expensive), quickly", () => {
    const f = figure("main");
    const t0 = Date.now();
    const r = runFigure(f.manifest, sourcesOf(f), { maxMultiplyAdds: 100_000 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.value).toBeUndefined();
    expect(codes(r)).toContain("asset/too-expensive");
  });

  it("refuses annotation polylines longer than the measuring budget", () => {
    const f = figure("main");
    const zig = Array.from({ length: 256 }, (_, i) => [i % 2 ? 370 : 5, 5 + i]);
    const r = runFigure(
      { ...f.manifest, annotations: [{ kind: "leader", state: "exploded", polyline: zig }] },
      sourcesOf(f),
    );
    expect(codes(r)).toEqual(["asset/too-expensive"]);
  });

  it("reports coordinates outside the drawing, missing images and bad rasters as diagnostics", () => {
    const f = figure("main");
    const off = {
      ...f.manifest,
      parts: [
        { ...f.manifest.parts[0], seeds: { exploded: [[5000, 5]] } },
        ...f.manifest.parts.slice(1),
      ],
    };
    const r1 = runFigure(off, sourcesOf(f));
    expect(r1.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["asset/bad-option", "/parts/0/seeds/exploded/0"],
    ]);
    expect(codes(runFigure(f.manifest, {}))).toEqual(["asset/bad-option", "asset/bad-option"]);
    const bad = {
      ...sourcesOf(f),
      "exploded.png": { width: 10, height: 10, data: new Uint8Array(7) },
    };
    expect(codes(runFigure(f.manifest, bad))).toEqual(["asset/bad-raster"]);
    const background = {
      ...f.manifest,
      parts: [
        { ...f.manifest.parts[0], seeds: { exploded: [[2, 2]] } },
        ...f.manifest.parts.slice(1),
      ],
    };
    expect(codes(runFigure(background, sourcesOf(f)))).toContain("asset/not-found");
  });

  it("checks malformed outputs without throwing", { timeout: 120_000 }, () => {
    const { f, result } = run("main");
    const o = result.outputs;
    const cases: unknown[] = [
      null,
      {},
      { ...o, base: { width: 1, height: 1, data: new Uint8Array(4) } },
      { ...o, sprites: [] },
      { ...o, parts: [] },
      { ...o, parts: o.parts.map((p) => ({ ...p, sprite: 7 })) },
      { ...o, parts: o.parts.map((p) => ({ ...p, seat: [Number.NaN, 0] })) },
      { ...o, parts: o.parts.map((p) => ({ ...p, exploded: [1e9, 0] })) },
      { ...o, parts: [...o.parts].reverse() },
      { ...o, sprites: [{ width: 3, height: 3, data: new Uint8Array(5) }] },
    ];
    for (const c of cases) {
      const r = checkFigure(f.manifest, sourcesOf(f), c as never);
      noGuard(r);
      expect(r.diagnostics.some((d) => d.severity === "error")).toBe(true);
      if (r.value) expect(r.value.ok).toBe(false);
    }
  });

  it("never throws on fuzzed manifests and stays bounded", { timeout: 120_000 }, () => {
    const f = figure("leaders");
    const src = sourcesOf(f);
    const rand = rng(7);
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]!;
    const values = [
      null,
      true,
      0,
      -1,
      1.5,
      1e9,
      "",
      "x",
      "exploded",
      [],
      {},
      [0, 0],
      [[0, 0]],
      [16384, 16384],
    ];
    const mutate = (v: unknown, depth: number): unknown => {
      if (depth > 4 || rand() < 0.15) return pick(values);
      if (Array.isArray(v))
        return v.map((x) => mutate(x, depth + 1)).slice(0, rand() < 0.2 ? 1 : undefined);
      if (v && typeof v === "object") {
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v))
          if (rand() > 0.1) o[k] = rand() < 0.3 ? mutate(x, depth + 1) : x;
        if (rand() < 0.1) o.extra = 1;
        return o;
      }
      return rand() < 0.5 ? v : pick(values);
    };
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      const m = mutate(f.manifest, 0);
      const r = runFigure(m, src);
      noGuard(r);
    }
    expect(Date.now() - t0).toBeLessThan(100_000);
  });

  it(
    "a hostile but valid manifest (64 parts, 32 seeds each, every annotation slot) finishes",
    { timeout: 120_000 },
    () => {
      const f = figure("leaders");
      const parts = Array.from({ length: 64 }, (_, i) => ({
        id: `p${i}`,
        seeds: {
          exploded: Array.from({ length: 32 }, (_, k) => [
            20 + ((i * 5 + k) % 340),
            230 + ((i * 7 + k * 3) % 160),
          ]),
        },
      }));
      const annotations = Array.from({ length: 128 }, (_, i) => ({
        kind: i % 2 ? "leader" : "arrow",
        state: "exploded",
        polyline: [
          [10 + i, 10],
          [10 + i, 60 + (i % 40)],
        ],
      }));
      const t0 = Date.now();
      const r = runFigure(
        { sources: { exploded: "exploded.png" }, parts, annotations },
        sourcesOf(f),
      );
      expect(Date.now() - t0).toBeLessThan(100_000);
      noGuard(r);
      expect(r.diagnostics.length).toBeGreaterThan(0);
    },
  );

  it("cutout reports bad input as diagnostics", () => {
    const img: Raster = { width: 20, height: 20, data: new Uint8Array(20 * 20 * 4).fill(255) };
    expect(codes(cutout(img, { seeds: [] }))).toContain("asset/bad-option");
    expect(codes(cutout(img, { seeds: [[50, 50]] }))).toContain("asset/bad-option");
    expect(
      codes(cutout({ width: 2, height: 2, data: new Uint8Array(3) }, { seeds: [[1, 1]] })),
    ).toContain("asset/bad-raster");
  });
});
