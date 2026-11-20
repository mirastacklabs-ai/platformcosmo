/**
 * Figure pipeline (C-4): every synthetic trap figure passes the gate with zero errors, sprites
 * match the generator's ground truth pixel for pixel, the base equals the clean board, the spec
 * fragment validates, single-state figures report reduced confidence, the output is
 * deterministic, metrics are local, and the gate's re-render equals resvg's.
 */
import { createHash } from "node:crypto";
import { decodePng, rasterize, validateSpec } from "@platformcosmo/core";
import { describe, expect, it } from "vitest";
import { PRESET_NAMES, figure } from "../../../tests/fixtures/figures/gen.mjs";
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

const DUAL = ["main", "arrows", "leaders", "callout-text", "busy-callout", "twins"];
const SINGLE = ["exploded-only", "assembled-only"];
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

const statusOf = (r: FigureReport, check: string): string | undefined =>
  r.checks.find((c) => c.check === check)?.status;

describe("trap figures pass the gate", () => {
  it("covers every preset of the generator", () => {
    expect([...DUAL, ...SINGLE].sort()).toEqual([...PRESET_NAMES].sort());
  });

  it.each([...DUAL, ...SINGLE])("%s: zero errors", (name) => {
    const { result } = run(name);
    const errors = result.report.diagnostics.filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors, null, 1)).toEqual([]);
    expect(result.report.ok).toBe(true);
    for (const c of result.report.checks) expect(["pass", "warn", "not-run"]).toContain(c.status);
  });

  it.each(DUAL.filter((n) => n !== "twins"))(
    "%s: full confidence, both residuals run, alignment found",
    (name) => {
      const { f, result } = run(name);
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
    // 1 px leaders; the diagonal callout leader crosses traces and steps diagonally (runs of 1-3).
    expect(
      ann.filter((a) => a.kind === "leader").every((a) => a.medianRun >= 1 && a.medianRun <= 3),
    ).toBe(true);
  });

  it("twins: overlapping identical parts are separated and the rear one is recovered", () => {
    const { f, result } = run("twins");
    const r = result.report;
    // Neither twin stands alone (overlap in the exploded drawing, the board in the assembled one).
    expect(r.confidence).toBe("reduced");
    expect(statusOf(r, "hull-uncertain")).toBe("warn");
    expect(statusOf(r, "exploded-residual")).toBe("pass");
    // tw-2 is drawn in front in both states; the default order (seat bottom edge) agrees, so no z.
    expect(r.parts.map((p) => p.z)).toEqual([undefined, undefined]);
    expect(r.parts.map((p) => p.exploded)).toEqual(
      ["tw-1", "tw-2"].map((id) => {
        const t = f.states.exploded!.truth.units[id]!.full;
        return [t.x - f.offset[0], t.y - f.offset[1]];
      }),
    );
  });
});

describe("single-state figures", () => {
  it.each([
    ["exploded-only", "assembled-residual", "seat"],
    ["assembled-only", "exploded-residual", "exploded"],
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
      // Main's assembled seat, moved into the exploded drawing's frame.
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
  it.each([...DUAL, ...SINGLE])(
    "%s: sprites hold the whole silhouette and never another part's pixels",
    (name) => {
      const { f, result } = run(name);
      const o = result.outputs;
      expect(o.parts.map((p) => p.id)).toEqual(f.units);
      const template = result.report.parts.find((p) => p.template)!;
      // Where the template depiction stands alone the sprite is exact; where it never does
      // (single-state assembled), a stroke touching the outline can leave a stub of board ink of
      // up to 3 px (in a concave notch of the silhouette), never another part's pixels.
      const exact = template.standalone !== null;
      for (const p of o.parts) {
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
          let stray = 0;
          for (let j = 0; j < sp.height; j++) {
            for (let i = 0; i < sp.width; i++) {
              if (!sp.data[(j * sp.width + i) * 4 + 3]) continue;
              const x = i + pos[0] + dx;
              const y = j + pos[1] + dy;
              if (maskHas(own, x, y)) {
                inside++;
                continue;
              }
              stray++;
              // Never a pixel of another part.
              for (const [id, t] of Object.entries(truth))
                if (id !== p.id) expect(maskHas(t.full, x, y), `${id} at ${x},${y}`).toBe(false);
              let near = false;
              for (let b = -3; b <= 3; b++)
                for (let a = -3; a <= 3; a++) if (maskHas(own, x + a, y + b)) near = true;
              expect(near).toBe(true);
            }
          }
          let n = 0;
          eachInMask(own, () => n++);
          expect(inside).toBe(n);
          expect(stray).toBeLessThanOrEqual(exact ? 0 : 8);
        }
      }
    },
  );

  it.each([...DUAL, "exploded-only"])(
    "%s: the clean base is the board without parts and annotations",
    (name) => {
      const { f, result } = run(name);
      const board = f.states[f.base]!.board;
      expect(Buffer.from(result.outputs.base.data).equals(Buffer.from(board.data))).toBe(true);
    },
  );

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
        // Stubs of up to 3 px, erased with a 1 px margin.
        for (let dy = -4; dy <= 4; dy++)
          for (let dx = -4; dx <= 4; dx++) if (maskHas(t.full, x + dx, y + dy)) return true;
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
  it(
    "the gate's composite equals resvg's rendering of the same base and sprites",
    { timeout: 60_000 },
    async () => {
      const f = figure("main");
      const an = analyzeFigure(f.manifest, sourcesOf(f)).value!;
      const { result } = run("main");
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
    for (let y = 0; y < E.height; y++) data.set(E.data.subarray(y * E.width * 4, (y + 1) * E.width * 4), y * W * 4);
    for (let y = 0; y < A.height; y++) data.set(A.data.subarray(y * A.width * 4, (y + 1) * A.width * 4), (E.height + y) * W * 4);
    const sheet: Raster = { width: W, height: E.height + A.height, data };
    const dy = E.height;
    const move = (pts: number[][]) => pts.map(([x, y]) => [x!, y! + dy]);
    const manifest = {
      ...f.manifest,
      sources: { exploded: "sheet.png" },
      regions: { exploded: [0, 0, E.width, E.height], assembled: [0, dy, A.width, A.height] },
      background: "#ffffff",
      parts: f.manifest.parts.map((p: { seeds: { exploded: number[][]; assembled: number[][] } }) => ({ ...p, seeds: { exploded: p.seeds.exploded, assembled: move(p.seeds.assembled) } })),
      annotations: f.manifest.annotations.map((a: { state: string; rect?: number[]; polyline?: number[][] }) =>
        a.state !== "assembled" ? a : a.rect ? { ...a, rect: [a.rect[0], a.rect[1]! + dy, a.rect[2], a.rect[3]] } : { ...a, polyline: move(a.polyline!) },
      ),
    };
    const r = runFigure(manifest, { "sheet.png": sheet });
    expect(r.value?.report.ok, JSON.stringify(r.diagnostics.filter((d) => d.severity === "error"))).toBe(true);
    const ref = run("main").result.outputs;
    expect(r.value!.outputs.parts).toEqual(ref.parts);
    expect(Buffer.from(r.value!.outputs.base.data).equals(Buffer.from(ref.base.data))).toBe(true);
    expect(Buffer.from(r.value!.outputs.sprites[0]!.data).equals(Buffer.from(ref.sprites[0]!.data))).toBe(true);
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
    const c = cutout(E, { seeds });
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
  report: "7595fe53b9a4c8c0dc36008d16b1b0170d47ef7025bbe67a1672d8ea5e66cea7",
  files: ["base.png:07ae16ca138387cb", "sprite-1.png:ed91d850d0dd47f7", "report.json:7595fe53b9a4c8c0"],
};
const GOLDEN_TWINS = {
  report: "97b17425eda6cd1be83dedccf7e66d012a18a3db9300546d07843d6e78a782de",
  files: ["base.png:e6b114549e337db9", "sprite-1.png:984b868295e185aa", "report.json:97b17425eda6cd1b"],
};
