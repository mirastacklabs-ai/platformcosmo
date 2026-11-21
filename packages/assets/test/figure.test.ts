/**
 * Figure pipeline (C-4): every synthetic trap figure passes the gate with zero errors, sprites
 * match the generator's ground truth pixel for pixel, the base equals the clean board, the spec
 * fragment validates, single-state figures report reduced confidence, the output is
 * deterministic, metrics are local, and the gate's re-render equals resvg's.
 */
import { createHash } from "node:crypto";
import { decodePng, rasterize, validateSpec } from "@platformcosmo/core";
import { describe, expect, it } from "vitest";
import { PRESET_NAMES, STROKE2_ONLY, figure } from "../../../tests/fixtures/figures/gen.mjs";
import { analyzeFigure } from "../src/figure/analyze.js";
import { rerender } from "../src/figure/gate.js";
import {
  cutout,
  encodePng,
  runFigure,
  stableStringify,
  type FigureReport,
  type Raster,
} from "../src/index.js";
import { check, clone, eachInMask, errorCodes, maskHas, run, sourcesOf } from "./figure-helpers.js";

const HS_DUAL = ["main", "arrows", "leaders", "callout-text", "busy-callout"];
const DUAL = [...HS_DUAL, "twins", "occluded", "cage", "screw", "dense"];
const SINGLE = [
  "exploded-only",
  "assembled-only",
  "dense-exploded",
  "dense-assembled",
  "cage-assembled",
  "screw-assembled",
];
/** Every preset at stroke 2; every preset but the 1 px comb at stroke 5; main anti-aliased. */
const VARIANTS: [string, string][] = [
  ...[...DUAL, ...SINGLE].map((n) => [n, ""] as [string, string]),
  ...[...DUAL, ...SINGLE]
    .filter((n) => !STROKE2_ONLY.includes(n))
    .map((n) => [n, "s5"] as [string, string]),
  ["main", "aa"],
];
const label = (n: string, t: string): string => (t ? `${n}@${t}` : n);
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

const statusOf = (r: FigureReport, check: string): string | undefined =>
  r.checks.find((c) => c.check === check)?.status;

describe("trap figures pass the gate", () => {
  it("covers every preset of the generator", () => {
    expect([...DUAL, ...SINGLE].sort()).toEqual([...PRESET_NAMES].sort());
  });

  it.each(VARIANTS.map(([n, t]) => [label(n, t), n, t] as const))(
    "%s: zero errors",
    { timeout: 60_000 },
    (_l, name, tag) => {
      const { result } = run(name, 0, tag);
      const errors = result.report.diagnostics.filter((d) => d.severity === "error");
      expect(errors, JSON.stringify(errors, null, 1)).toEqual([]);
      expect(result.report.ok).toBe(true);
      for (const c of result.report.checks) expect(["pass", "warn", "not-run"]).toContain(c.status);
    },
  );

  it.each(
    HS_DUAL.flatMap(
      (n) =>
        [
          [n, ""],
          [n, "s5"],
        ] as [string, string][],
    ),
  )(
    "%s %s: full confidence, both residuals run, alignment found",
    { timeout: 60_000 },
    (name, tag) => {
      const { f, result } = run(name, 0, tag);
      const r = result.report;
      expect(r.confidence).toBe("full");
      expect(r.notRun).toEqual([]);
      expect(statusOf(r, "assembled-residual")).toBe("pass");
      expect(statusOf(r, "exploded-residual")).toBe("pass");
      expect(r.alignment).not.toBeNull();
      expect([r.alignment!.dx, r.alignment!.dy]).toEqual(f.offset);
      // Every unit stands alone in the exploded drawing: the hull comes from its whole ink.
      expect(r.parts.map((p) => p.standalone)).toEqual(["exploded", "exploded"]);
    },
  );

  it("annotations of the main figure are all measured as valid strokes", () => {
    const { result } = run("main");
    const ann = result.report.annotations;
    expect(ann.map((a) => a.kind)).toEqual([
      "arrow",
      "arrow",
      "text",
      "leader",
      "arrow",
      "text",
      "leader",
    ]);
    expect(ann.every((a) => a.valid)).toBe(true);
    expect(
      ann.filter((a) => a.kind === "arrow").every((a) => a.arrowhead && a.medianRun === 2),
    ).toBe(true);
    // 1 px leaders: the stroke run (lower quartile) ignores the traces the callout leader crosses.
    expect(
      ann.filter((a) => a.kind === "leader").every((a) => a.medianRun >= 1 && a.medianRun <= 2),
    ).toBe(true);
  });

  it("twins: overlapping identical parts are separated and the rear one is recovered", () => {
    const { f, result } = run("twins");
    const r = result.report;
    // Neither twin stands alone (overlap in the exploded drawing, the board in the assembled one).
    expect(r.confidence).toBe("reduced");
    expect(statusOf(r, "hull-uncertain")).toBe("warn");
    expect(statusOf(r, "exploded-residual")).toBe("pass");
    expect(r.parts.map((p) => p.z)).toEqual([undefined, undefined]);
    expect(r.parts.map((p) => p.exploded)).toEqual(
      ["tw-1", "tw-2"].map((id) => {
        const t = f.states.exploded!.truth.units[id]!.full;
        return [t.x - f.offset[0], t.y - f.offset[1]];
      }),
    );
  });

  it("cage, screw: a part next to static ink its size is not alone there, and the template never swallows it", () => {
    for (const name of ["cage", "screw"]) {
      const { f, result } = run(name);
      expect(result.report.parts[0]!.standalone).toBe("exploded");
      // Seated in the cage or bracket it is not alone (that ink is static, in both drawings).
      const an = analyzeFigure(f.manifest, sourcesOf(f)).value!;
      expect(an.units[0]!.dep.assembled!.standalone, name).toBe(false);
      const sp = result.outputs.sprites[0]!;
      const gt = f.sprites[f.units[0]!]!.raster;
      expect([sp.width, sp.height]).toEqual([gt.width, gt.height]);
      expect(Buffer.from(sp.data).equals(Buffer.from(gt.data))).toBe(true);
    }
  });

  it("occluded: a part hidden differently in each drawing is recovered whole from both", () => {
    const { f, result } = run("occluded");
    const sp = result.outputs.sprites[result.outputs.parts[0]!.sprite]!;
    const gt = f.sprites["tw-1"]!.raster;
    expect([sp.width, sp.height]).toEqual([gt.width, gt.height]);
    expect(Buffer.from(sp.data).equals(Buffer.from(gt.data))).toBe(true);
    // Neither depiction alone holds the whole silhouette.
    for (const s of ["exploded", "assembled"] as const) {
      const t = f.states[s]!.truth.units["tw-1"]!;
      let hidden = 0;
      eachInMask(t.full, (x, y) => {
        if (!maskHas(t.visible, x, y)) hidden++;
      });
      expect(hidden).toBeGreaterThan(100);
    }
  });

  it("dense comb fins: no seeds between the fins; the gaps stay transparent and show the board", () => {
    for (const name of ["dense", "dense-exploded", "dense-assembled"]) {
      const { f, result } = run(name);
      const sp = result.outputs.sprites[0]!;
      const gt = f.sprites["sink-1"]!.raster;
      expect([sp.width, sp.height], name).toEqual([gt.width, gt.height]);
      expect(Buffer.from(sp.data).equals(Buffer.from(gt.data)), name).toBe(true);
      // One seed only: the plate.
      expect(
        Object.values(f.manifest.parts[0].seeds).every((v) => (v as unknown[]).length === 1),
      ).toBe(true);
    }
    // Seated, the board's traces run behind the comb: the clean base keeps them all.
    const { f, result } = run("dense");
    const board = f.states.assembled!.board;
    expect(Buffer.from(result.outputs.base.data).equals(Buffer.from(board.data))).toBe(true);
  });
});

describe("single-state figures", () => {
  it.each([
    ["exploded-only", "assembled-residual", "seat"],
    ["assembled-only", "exploded-residual", "exploded"],
    ["dense-exploded", "assembled-residual", "seat"],
    ["dense-assembled", "exploded-residual", "exploded"],
  ] as const)("%s: %s is not-run and confidence is reduced", (name, missing, inferred) => {
    const { result } = run(name);
    const r = result.report;
    expect(r.confidence).toBe("reduced");
    expect(r.notRun).toEqual([missing]);
    expect(statusOf(r, missing)).toBe("not-run");
    expect(r.parts.every((p) => p.inferred === inferred)).toBe(true);
  });

  it("exploded-only: the seat found along the arrow is the true seat and is verified", () => {
    const { f, result } = run("exploded-only");
    const truthA = figure("main").states.assembled!.truth.units;
    const off = figure("main").offset;
    for (const p of result.report.parts) {
      const t = truthA[p.id]!.full;
      expect(p.seat).toEqual([t.x + off[0], t.y + off[1]]);
    }
    expect(statusOf(result.report, "seat-unverified")).toBe("pass");
    expect(f.base).toBe("exploded");
  });

  it("exploded-only: a seat moved off its footprint is reported as seat-unverified", () => {
    const { f, result } = run("exploded-only");
    const o = result.outputs;
    const moved = {
      ...o,
      parts: o.parts.map((p, i) =>
        i === 0 ? { ...p, seat: [p.seat[0] + 60, p.seat[1] - 40] as const } : p,
      ),
    };
    const r = check(f.manifest, sourcesOf(f), moved);
    const w = r.diagnostics.filter((d) => d.code === "asset/seat-unverified");
    expect(w).toHaveLength(1);
    expect(w[0]!.severity).toBe("warning");
    expect(w[0]!.params?.part).toBe("hs-1");
  });
});

describe("ground truth", () => {
  it.each(VARIANTS.filter(([, t]) => t !== "aa").map(([n, t]) => [label(n, t), n, t] as const))(
    "%s: sprites hold the whole silhouette and never another part's pixels",
    { timeout: 60_000 },
    (_l, name, tag) => {
      const { f, result } = run(name, 0, tag);
      const o = result.outputs;
      expect(o.parts.map((p) => p.id)).toEqual(f.units);
      for (const p of o.parts) {
        const rp = result.report.parts.find((q) => q.id === p.id)!;
        const tplUnit = result.report.parts.find((q) => q.template && q.sprite === p.sprite)!;
        // Exact where the template stands alone. Where it never does (one drawing, or touching
        // parts in both), segmentation is by distance: a stroke touching the outline can leave a
        // stub (foreign < 4 px, ingestion §6.5) and a corner tip may be lost (at most 2%).
        const exact = tplUnit.standalone !== null;
        const sp = o.sprites[p.sprite]!;
        if (exact) {
          const gt = f.sprites[p.id]!.raster;
          expect([sp.width, sp.height]).toEqual([gt.width, gt.height]);
          expect(Buffer.from(sp.data).equals(Buffer.from(gt.data))).toBe(true);
        }
        for (const [s, st] of Object.entries(f.states)) {
          const pos = s === "assembled" ? p.seat : p.exploded;
          const [dx, dy] = f.base === s ? [0, 0] : f.offset;
          const truth = st!.truth.units;
          const own = truth[p.id]!.full;
          let inside = 0;
          const stray: [number, number][] = [];
          for (let j = 0; j < sp.height; j++) {
            for (let i = 0; i < sp.width; i++) {
              if (!sp.data[(j * sp.width + i) * 4 + 3]) continue;
              const x = i + pos[0] + dx;
              const y = j + pos[1] + dy;
              if (maskHas(own, x, y)) {
                inside++;
                continue;
              }
              stray.push([x, y]);
              // Never a pixel of another part, in the drawing the sprite was cut from (a stub
              // of board ink placed elsewhere may land on anything).
              if (s === tplUnit.source)
                for (const [id, t] of Object.entries(truth))
                  if (id !== p.id) expect(maskHas(t.full, x, y), `${id} at ${x},${y}`).toBe(false);
            }
          }
          let n = 0;
          eachInMask(own, () => n++);
          if (exact) {
            expect(inside).toBe(n);
            expect(stray).toEqual([]);
          } else {
            expect(n - inside).toBeLessThanOrEqual(Math.ceil(0.02 * n));
            // Stub bound: every 8-connected piece of stray pixels is under 4 px.
            const set = new Set(stray.map(([x, y]) => `${x},${y}`));
            const seen = new Set<string>();
            for (const [x, y] of stray) {
              const k0 = `${x},${y}`;
              if (seen.has(k0)) continue;
              let size = 0;
              const stack = [[x, y]];
              seen.add(k0);
              while (stack.length) {
                const [a, b] = stack.pop()!;
                size++;
                for (let dy2 = -1; dy2 <= 1; dy2++)
                  for (let dx2 = -1; dx2 <= 1; dx2++) {
                    const k = `${a! + dx2},${b! + dy2}`;
                    if (set.has(k) && !seen.has(k)) {
                      seen.add(k);
                      stack.push([a! + dx2, b! + dy2]);
                    }
                  }
              }
              expect(size, `stub at ${x},${y} in ${s}`).toBeLessThan(4);
            }
          }
          void rp;
        }
      }
    },
  );

  it.each([...HS_DUAL, "twins", "cage", "screw", "dense", "exploded-only"])(
    "%s: the clean base is the board without parts and annotations",
    (name) => {
      const { f, result } = run(name);
      const board = f.states[f.base]!.board;
      expect(Buffer.from(result.outputs.base.data).equals(Buffer.from(board.data))).toBe(true);
    },
  );

  it("main anti-aliased: the clean base matches the board, fringes and all (within a grey step)", () => {
    const { f, result } = run("main", 0, "aa");
    const board = f.states.assembled!.board;
    const b = result.outputs.base;
    let worst = 0;
    for (let i = 0; i < b.width * b.height; i++) {
      const l1 = 0.299 * b.data[i * 4]! + 0.587 * b.data[i * 4 + 1]! + 0.114 * b.data[i * 4 + 2]!;
      const l2 =
        0.299 * board.data[i * 4]! +
        0.587 * board.data[i * 4 + 1]! +
        0.114 * board.data[i * 4 + 2]!;
      worst = Math.max(worst, Math.abs(l1 - l2));
    }
    expect(worst).toBeLessThanOrEqual(48);
  });

  it("ink the mask misses (a polygon clips the fins) is erased from the base with the part", () => {
    const f = figure("main");
    const parts = f.manifest.parts.map((p: Record<string, unknown>, i: number) => {
      if (i > 1) return p;
      const poly: Record<string, number[][]> = {};
      for (const s of ["exploded", "assembled"] as const) {
        const t = f.states[s]!.truth.units[i === 0 ? "hs-1" : "hs-2"]!.full;
        poly[s] = [
          [t.x - 1, t.y + 13],
          [t.x + t.w, t.y + 13],
          [t.x + t.w, t.y + t.h],
          [t.x - 1, t.y + t.h],
        ];
      }
      return { ...p, polygon: poly };
    });
    const out = runFigure({ ...f.manifest, parts }, sourcesOf(f)).value!.outputs;
    const board = f.states.assembled!.board;
    const b = out.base;
    const lum = (r: Raster, i: number): number =>
      0.299 * r.data[i * 4]! + 0.587 * r.data[i * 4 + 1]! + 0.114 * r.data[i * 4 + 2]!;
    let left = 0;
    for (const id of ["hs-1", "hs-2"]) {
      const t = f.states.assembled!.truth.units[id]!.full;
      for (let y = t.y; y < t.y + 13; y++)
        for (let x = t.x; x < t.x + t.w; x++)
          if (
            maskHas(t, x, y) &&
            Math.abs(lum(b, y * b.width + x) - lum(board, y * b.width + x)) > 48
          )
            left++;
    }
    expect(left).toBe(0);
  });

  it("assembled-only: the base equals the board outside the seats and annotations (nothing to recover from)", () => {
    const { f, result } = run("assembled-only");
    const st = f.states.assembled!;
    const b = result.outputs.base;
    const an = analyzeFigure(f.manifest, sourcesOf(f)).value!;
    const near = (x: number, y: number): boolean =>
      an.annotations.some((g) => {
        const m = g.mask;
        return (
          x >= m.x &&
          y >= m.y &&
          x < m.x + m.w &&
          y < m.y + m.h &&
          m.data[(y - m.y) * m.w + x - m.x] === 1
        );
      }) ||
      Object.values(st.truth.units).some((t) => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) if (maskHas(t.full, x + dx, y + dy)) return true;
        return false;
      });
    let diff = 0;
    for (let y = 0; y < b.height; y++) {
      for (let x = 0; x < b.width; x++) {
        const o = (y * b.width + x) * 4;
        if (
          !near(x, y) &&
          (b.data[o] !== st.board.data[o] || b.data[o + 1] !== st.board.data[o + 1])
        )
          diff++;
      }
    }
    expect(diff).toBe(0);
  });
});

describe("spec fragment", () => {
  it.each(["main", "exploded-only", "assembled-only"])(
    "%s: validates against schema/v1.json",
    (name) => {
      const f = figure(name);
      const r = runFigure(f.manifest, sourcesOf(f), {
        figureId: "hs-install",
        dir: "fig/",
        label: "Installing the heat sinks",
        source: { document: "Synthetic manual", page: 3, figure: "Figure 2" },
      });
      const frag = r.value!.fragment;
      const spec = { meta: { version: "1", title: "Figure" }, ...frag };
      const v = validateSpec(spec);
      expect(v.errors).toEqual([]);
      expect(frag.images.map((i) => i.src)).toEqual(["fig/base.png", "fig/sprite-1.png"]);
      expect(frag.figures[0]!.parts.map((p) => [p.id, p.image])).toEqual([
        ["hs-1", "hs-install-sprite-1"],
        ["hs-2", "hs-install-sprite-1"],
      ]);
      expect(frag.figures[0]!.pose).toBe(f.base);
      expect(r.value!.files.map((x) => x.name)).toEqual([
        "base.png",
        "sprite-1.png",
        "report.json",
        "fragment.json",
      ]);
    },
  );

  it("rejects ids and directories that could escape or break the spec", () => {
    const f = figure("main");
    for (const o of [
      { figureId: "Bad Id" },
      { figureId: "a".repeat(49) },
      { dir: "../x/" },
      { dir: "/abs/" },
      { dir: "fig" },
    ]) {
      const r = runFigure(f.manifest, sourcesOf(f), o);
      expect(r.value).toBeUndefined();
      expect(r.diagnostics[0]!.code).toBe("asset/bad-option");
    }
  });
});

describe("determinism", () => {
  it(
    "same inputs give byte-identical reports and sprites (golden hashes)",
    { timeout: 60_000 },
    () => {
      const hashes = (name: string) => {
        const f = figure(name);
        const r = runFigure(f.manifest, sourcesOf(f)).value!;
        return {
          report: sha(stableStringify(r.report)),
          files: r.files.map((x) => `${x.name}:${sha(x.bytes).slice(0, 16)}`),
        };
      };
      const a = hashes("main");
      expect(hashes("main")).toEqual(a);
      expect(a).toEqual(GOLDEN_MAIN);
      expect(hashes("twins")).toEqual(GOLDEN_TWINS);
    },
  );

  it("report.json has sorted keys", () => {
    const { result } = run("main");
    const json = new TextDecoder().decode(
      result.files.find((x) => x.name === "report.json")!.bytes,
    );
    expect(json).toBe(stableStringify(JSON.parse(json)));
    expect(Object.keys(JSON.parse(json))).toEqual([...Object.keys(JSON.parse(json))].sort());
  });
});

describe("local metrics", () => {
  it(
    "the same figure padded to over 4x the area passes, and a ghost heat sink still fails by the same pixels",
    { timeout: 120_000 },
    () => {
      const small = run("main");
      const big = run("main", 220);
      expect(big.result.report.ok).toBe(true);
      const ghost = (v: typeof small) => {
        const base = clone(v.result.outputs.base);
        const A = v.f.states.assembled!.image;
        eachInMask(v.f.states.assembled!.truth.units["hs-1"]!.full, (x, y) => {
          base.data.set(
            A.data.subarray((y * A.width + x) * 4, (y * A.width + x) * 4 + 4),
            (y * A.width + x) * 4,
          );
        });
        const r = check(v.f.manifest, sourcesOf(v.f), { ...v.result.outputs, base });
        return r.checks.find((c) => c.check === "exploded-residual")!.value;
      };
      const a = ghost(small);
      expect(a).toBeGreaterThan(24);
      expect(ghost(big)).toBe(a);
    },
  );
});

describe("re-render", () => {
  it.each(["main", "twins"])(
    "%s: the gate's composite equals resvg's rendering of the same base and sprites",
    { timeout: 60_000 },
    async (name) => {
      const f = figure(name);
      const an = analyzeFigure(f.manifest, sourcesOf(f)).value!;
      const { result } = run(name);
      const o = result.outputs;
      for (const s of ["assembled", "exploded"] as const) {
        const mine = rerender(an, o, s).image;
        const [dx, dy] = an.d[s]!;
        const st = an.img[s]!;
        const img = (r: Raster, x: number, y: number): string =>
          `<image x="${x}" y="${y}" width="${r.width}" height="${r.height}" href="data:image/png;base64,${Buffer.from(encodePng(r)).toString("base64")}"/>`;
        const parts = [...o.parts]
          .map((p, i) => ({ p, i }))
          .sort(
            (a, b) =>
              a.p.seat[1] +
                o.sprites[a.p.sprite]!.height -
                (b.p.seat[1] + o.sprites[b.p.sprite]!.height) || a.i - b.i,
          );
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${st.W}" height="${st.H}" viewBox="0 0 ${st.W} ${st.H}">` +
          `<rect width="${st.W}" height="${st.H}" fill="rgb(${st.background.join(",")})"/>` +
          img(o.base, dx, dy) +
          parts
            .map(({ p }) =>
              img(
                o.sprites[p.sprite]!,
                (s === "assembled" ? p.seat : p.exploded)[0] + dx,
                (s === "assembled" ? p.seat : p.exploded)[1] + dy,
              ),
            )
            .join("") +
          `</svg>`;
        const theirs = decodePng(await rasterize(svg, { scale: 1, fonts: [] }));
        expect([theirs.width, theirs.height]).toEqual([mine.width, mine.height]);
        expect(Buffer.from(theirs.data).equals(Buffer.from(mine.data))).toBe(true);
      }
    },
  );
});

describe("one source image with a region per state", () => {
  it("gives the same outputs as two images (manifest coordinates in the source file)", () => {
    const f = figure("main");
    const E = f.states.exploded!.image;
    const A = f.states.assembled!.image;
    const W = Math.max(E.width, A.width);
    const data = new Uint8Array(W * (E.height + A.height) * 4).fill(255);
    for (let y = 0; y < E.height; y++)
      data.set(E.data.subarray(y * E.width * 4, (y + 1) * E.width * 4), y * W * 4);
    for (let y = 0; y < A.height; y++)
      data.set(A.data.subarray(y * A.width * 4, (y + 1) * A.width * 4), (E.height + y) * W * 4);
    const sheet: Raster = { width: W, height: E.height + A.height, data };
    const dy = E.height;
    const move = (pts: number[][]) => pts.map(([x, y]) => [x!, y! + dy]);
    const manifest = {
      ...f.manifest,
      sources: { exploded: "sheet.png" },
      regions: { exploded: [0, 0, E.width, E.height], assembled: [0, dy, A.width, A.height] },
      background: "#ffffff",
      parts: f.manifest.parts.map(
        (p: { seeds: { exploded: number[][]; assembled: number[][] } }) => ({
          ...p,
          seeds: { exploded: p.seeds.exploded, assembled: move(p.seeds.assembled) },
        }),
      ),
      annotations: f.manifest.annotations.map(
        (a: { state: string; rect?: number[]; polyline?: number[][] }) =>
          a.state !== "assembled"
            ? a
            : a.rect
              ? { ...a, rect: [a.rect[0], a.rect[1]! + dy, a.rect[2], a.rect[3]] }
              : { ...a, polyline: move(a.polyline!) },
      ),
    };
    const r = runFigure(manifest, { "sheet.png": sheet });
    expect(
      r.value?.report.ok,
      JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")),
    ).toBe(true);
    const ref = run("main").result.outputs;
    expect(r.value!.outputs.parts).toEqual(ref.parts);
    expect(Buffer.from(r.value!.outputs.base.data).equals(Buffer.from(ref.base.data))).toBe(true);
    expect(
      Buffer.from(r.value!.outputs.sprites[0]!.data).equals(Buffer.from(ref.sprites[0]!.data)),
    ).toBe(true);
  });
});

describe("cutout", () => {
  it("cuts one part by its seeds with the exact silhouette, or a rectangle for diagnostics", () => {
    // The leaders preset: nothing but the part touches hs-1 in the exploded drawing.
    const f = figure("leaders");
    const E = f.states.exploded!.image;
    const seeds = f.manifest.parts
      .filter((p: { group: string }) => p.group === "hs-1")
      .flatMap((p: { seeds: { exploded: number[][] } }) => p.seeds.exploded);
    // One image: the part stands alone (its whole ink) only inside a polygon or a declared prior.
    const t0 = f.states.exploded!.truth.units["hs-1"]!.full;
    const polygon: [number, number][] = [
      [t0.x - 2, t0.y - 2],
      [t0.x + t0.w + 1, t0.y - 2],
      [t0.x + t0.w + 1, t0.y + t0.h + 1],
      [t0.x - 2, t0.y + t0.h + 1],
    ];
    const c = cutout(E, { seeds, polygon });
    expect(c.value).toBeDefined();
    const gt = f.sprites["hs-1"]!.raster;
    expect(Buffer.from(c.value!.sprite.data).equals(Buffer.from(gt.data))).toBe(true);
    const t = f.states.exploded!.truth.units["hs-1"]!.full;
    expect([c.value!.x, c.value!.y]).toEqual([t.x, t.y]);
    const r = cutout(E, { seeds, mask: "rect" });
    expect(r.value!.sprite.data.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
    expect(cutout(E, { seeds: [[2, 2]] }).diagnostics.map((d) => d.code)).toContain(
      "asset/not-found",
    );
  });
});

describe("error codes", () => {
  it("every code the pipeline emits is listed in ingestion §6.5 or §13", () => {
    const allowed = new Set(
      [
        ...[
          "assembled-residual",
          "exploded-residual",
          "leftover-fragment",
          "foreign-pixels",
          "mask-hole",
          "rect-mask",
          "group-disconnected",
          "instance-swap",
          "base-unrecovered",
          "occluded-unrecovered",
          "arrow-residual",
          "hull-uncertain",
          "annotation-invalid",
          "seat-unverified",
        ],
        ...[
          "too-expensive",
          "unsafe-path",
          "bad-option",
          "bad-raster",
          "too-large",
          "empty",
          "flat",
          "not-found",
          "renderer-failed",
          "rect-clamped",
          "no-background",
          "background-covers-image",
          "ambiguous",
          "shrink-passthrough",
        ],
      ].map((c) => `asset/${c}`),
    );
    for (const name of PRESET_NAMES) {
      const { result } = run(name);
      for (const d of result.report.diagnostics) expect(allowed.has(d.code), d.code).toBe(true);
      for (const c of result.report.checks) expect(allowed.has(c.code), c.code).toBe(true);
    }
    expect(errorCodes(run("main").result.report).size).toBe(0);
  });
});

// Golden hashes: update only when an intended change alters the outputs, and review the diff.
const GOLDEN_MAIN = {
  report: "5384cedc50fca1d07a137535c7e7d879ae7b26791f4e97c0113c889141d2eca6",
  files: [
    "base.png:07ae16ca138387cb",
    "sprite-1.png:ed91d850d0dd47f7",
    "report.json:5384cedc50fca1d0",
    "fragment.json:3c56bbeb00811bae",
  ],
};
const GOLDEN_TWINS = {
  report: "cc65cbf55553ce9cdb185a9a6a511f4da88a3d758ef3ef0146ffd409a5535253",
  files: [
    "base.png:6125ab9b234e6a93",
    "sprite-1.png:984b868295e185aa",
    "report.json:cc65cbf55553ce9c",
    "fragment.json:c97f7f273f455d2a",
  ],
};
