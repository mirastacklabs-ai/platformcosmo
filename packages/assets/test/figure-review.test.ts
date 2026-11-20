/**
 * Fixtures for the second review of C-4 (gate G-Q*, segmentation S-Q*). Each states the defect it
 * traps; the PR lists which fail on the previous code (mutation-checked) and which strengthen.
 */
import { describe, expect, it } from "vitest";
import { figure } from "../../../tests/fixtures/figures/gen.mjs";
import { analyzeFigure, compareTemplates } from "../src/figure/analyze.js";
import { runGate } from "../src/figure/gate.js";
import { locate, luminancePlane } from "../src/locate.js";
import { crop } from "../src/ops.js";
import {
  checkFigure,
  cutout,
  exclusionOverlay,
  outputsFromFragment,
  runFigure,
  type FigureOutputs,
  type Raster,
} from "../src/index.js";
import {
  check,
  clone,
  copyPx,
  drawArrow,
  eachInMask,
  errorCodes,
  line1,
  lumAt,
  maskHas,
  run,
  setPx,
  sourcesOf,
} from "./figure-helpers.js";

const BLACK = [0, 0, 0, 255] as const;
const line2 = (r: Raster, x0: number, y0: number, x1: number, y1: number): void => {
  line1(r, x0, y0, x1, y1);
  line1(r, x0 + 1, y0, x1 + 1, y1);
};
const messages = (
  r: { diagnostics: readonly { severity: string; code: string; message: string }[] },
  code: string,
): string[] =>
  r.diagnostics.filter((d) => d.severity === "error" && d.code === code).map((d) => d.message);
const restoreAll = (
  base: Raster,
  A: Raster,
  m: { x: number; y: number; w: number; h: number; data: Uint8Array },
): void => eachInMask(m, (x, y) => copyPx(base, A, x, y));

describe("gate (G-Q01): foreign pixels and unrecovered occlusion are not tautological", () => {
  it("a seed leaking into a neighbour fails with foreign-pixels on its own (outputs unedited)", () => {
    const f = figure("twins");
    // tw-1 in its own class; in the assembled drawing one of its seeds lands on the board
    // component touching it, so its segmentation there swallows that component.
    const parts = f.manifest.parts.map((p: Record<string, unknown>) => {
      const { instanceOf: _drop, ...rest } = p;
      void _drop;
      return rest;
    });
    const leak = parts[0] as { seeds: { assembled: number[][] } };
    const A0 = f.states.assembled!.truth.units["tw-1"]!.pos;
    leak.seeds.assembled = [...leak.seeds.assembled, [A0[0] - 7, A0[1] + 19]];
    const manifest = { ...f.manifest, parts };
    const r = runFigure(manifest, sourcesOf(f));
    expect(r.value, JSON.stringify(r.diagnostics.slice(0, 3))).toBeDefined();
    expect(errorCodes(r.value!.report)).toContain("asset/foreign-pixels");
  });

  it("template pixels hidden in every depiction are reported, from the analysis's record", () => {
    // One drawing only: the tag hides tw-1's lower left; nothing can show it.
    const f = figure("occluded");
    const manifest = {
      sources: { assembled: "assembled.png" },
      parts: f.manifest.parts.map((p: { seeds: Record<string, unknown> }) => ({
        ...p,
        seeds: { assembled: p.seeds.assembled },
      })),
    };
    const sources = { "assembled.png": f.states.assembled!.image };
    const an = analyzeFigure(manifest, sources).value!;
    const c = an.classes[an.units[0]!.cls]!;
    let n = 0;
    eachInMask(c.unrecovered, () => n++);
    expect(n).toBeGreaterThan(24);
    // With the tag where it is, the hidden pixels stay hidden; moved away, they show.
    const o = runFigure(manifest, sources).value!.outputs;
    expect(errorCodes(runGate(an, o)).has("asset/occluded-unrecovered")).toBe(false);
    const moved: FigureOutputs = {
      ...o,
      parts: o.parts.map((p, i) =>
        i === 1 ? { ...p, seat: [p.seat[0] + 120, p.seat[1]] as const } : p,
      ),
    };
    const rm = runGate(an, moved);
    expect(errorCodes(rm)).toContain("asset/occluded-unrecovered");
    // The record itself drives a diagnostic (not only the expected-silhouette check).
    expect(
      rm.diagnostics.some(
        (d) =>
          d.code === "asset/occluded-unrecovered" && /hidden in every depiction/.test(d.message),
      ),
    ).toBe(true);
  });
});

describe("gate (G-Q02, G-Q06): contact allowances", () => {
  it("leaders ending at fin-to-plate junctions do not sever the comb's outer fins", () => {
    const f = figure("dense");
    const E = clone(f.states.exploded!.image);
    const [px, py] = f.states.exploded!.truth.units["sink-1"]!.pos;
    const y = py + 24;
    // Left: a mark, then a leader to the first fin's root. Right: the same at the last fin.
    for (let k = 0; k < 9; k++) setPx(E, px - 28, y - 4 + k, BLACK);
    line1(E, px - 24, y, px, y);
    for (let k = 0; k < 9; k++) setPx(E, px + 108, y - 4 + k, BLACK);
    line1(E, px + 104, y, px + 81, y);
    const annotations = [
      { kind: "text", state: "exploded", rect: [px - 29, y - 5, 3, 11] },
      {
        kind: "leader",
        state: "exploded",
        polyline: [
          [px - 24, y],
          [px, y],
        ],
      },
      { kind: "text", state: "exploded", rect: [px + 107, y - 5, 3, 11] },
      {
        kind: "leader",
        state: "exploded",
        polyline: [
          [px + 104, y],
          [px + 81, y],
        ],
      },
    ];
    const r = runFigure({ ...f.manifest, annotations }, { ...sourcesOf(f), "exploded.png": E });
    expect(r.value).toBeDefined();
    expect(errorCodes(r.value!.report).size).toBe(0);
    const sp = r.value!.outputs.sprites[0]!;
    const gt = f.sprites["sink-1"]!.raster;
    expect(Buffer.from(sp.data).equals(Buffer.from(gt.data))).toBe(true);
  });

  it("a polyline with no stroke of its own outside its allowances is not an annotation", () => {
    const { f } = run("main");
    const E = clone(f.states.exploded!.image);
    const [px, py] = f.states.exploded!.truth.units["hs-2"]!.pos;
    // A 3 px dash touching the clip, with a mark next to it.
    line1(E, px + 94, py + 30, px + 96, py + 30);
    for (let k = 0; k < 7; k++) setPx(E, px + 99, py + 27 + k, BLACK);
    const annotations = [
      ...f.manifest.annotations,
      { kind: "text", state: "exploded", rect: [px + 98, py + 26, 3, 9] },
      {
        kind: "leader",
        state: "exploded",
        polyline: [
          [px + 94, py + 30],
          [px + 96, py + 30],
        ],
      },
    ];
    const r = check(
      { ...f.manifest, annotations },
      { ...sourcesOf(f), "exploded.png": E },
      run("main").result.outputs,
    );
    expect(
      messages(r, "asset/annotation-invalid").some((m) => /of its own \(non-part\) ink/.test(m)),
    ).toBe(true);
  });
});

describe("gate (G-Q03): the shape prior bounds the mask and widens the hull", () => {
  it("twin fins clipped from the mask, hidden by a text rect just outside it, fail", () => {
    const f = figure("twins");
    const parts = f.manifest.parts.map((p: Record<string, unknown>, i: number) => {
      if (i !== 0) return p;
      const { instanceOf: _drop, ...rest } = p;
      void _drop;
      // A rough polygon that clips the bottom of tw-1 (its dangling fins) in both drawings.
      const poly: Record<string, number[][]> = {};
      for (const s of ["exploded", "assembled"] as const) {
        const t = f.states[s]!.truth.units["tw-1"]!.full;
        poly[s] = [
          [t.x, t.y],
          [t.x + t.w - 1, t.y],
          [t.x + t.w - 1, t.y + 26],
          [t.x, t.y + 26],
        ];
      }
      return { ...rest, polygon: poly };
    });
    const manifest0 = { ...f.manifest, parts };
    const out = runFigure(manifest0, sourcesOf(f)).value!.outputs;
    // The fins stay in the base at the seat; in the exploded drawing a text rect covers that
    // place, just outside the (clipped) mask.
    const t = f.states.assembled!.truth.units["tw-1"]!.full;
    const [dx, dy] = f.offset;
    const rect = [t.x + 6 + dx, t.y + 33 + dy, 28, 10];
    const manifest = { ...manifest0, annotations: [{ kind: "text", state: "exploded", rect }] };
    const r = check(manifest, sourcesOf(f), out);
    expect(
      messages(r, "asset/annotation-invalid").some((m) => /hull of tw-1|part ink of tw-1/.test(m)),
    ).toBe(true);
  });
});

describe("gate (G-Q04): arrowheads are the wedge's own ink", () => {
  it("a board trace with a crossing declared as an arrow has no arrowhead", () => {
    const { f, result } = run("main");
    // Trace x = 160 (board) meets trace y = 60 (board); in the exploded drawing.
    const bx = 20 + 160;
    const by = 220;
    const arrow = {
      kind: "arrow",
      state: "exploded",
      polyline: [
        [bx, by + 30],
        [bx, by + 64],
      ],
    };
    const r = check(
      { ...f.manifest, annotations: [...f.manifest.annotations, arrow] },
      sourcesOf(f),
      result.outputs,
    );
    const idx = f.manifest.annotations.length;
    expect(
      r.diagnostics.some(
        (d) =>
          d.code === "asset/annotation-invalid" &&
          d.path === `/annotations/${idx}` &&
          /no arrowhead/.test(d.message),
      ),
    ).toBe(true);
  });

  it("a stroke crossing near the end (drawn in one state only) is not an arrowhead", () => {
    const f = figure("main");
    const E = clone(f.states.exploded!.image);
    const bg = E.data.slice(0, 4);
    // A quiet 80x60 patch of the exploded drawing.
    let spot: [number, number] | undefined;
    for (let y0 = 0; y0 + 60 < E.height && !spot; y0 += 4) {
      for (let x0 = 0; x0 + 80 < E.width && !spot; x0 += 4) {
        let clean = true;
        for (let y = y0; y < y0 + 60 && clean; y++)
          for (let x = x0; x < x0 + 80 && clean; x++)
            for (let c = 0; c < 3; c++)
              if (E.data[(y * E.width + x) * 4 + c] !== bg[c]) clean = false;
        if (clean) spot = [x0, y0];
      }
    }
    expect(spot).toBeDefined();
    const [x0, y0] = spot!;
    const x = x0 + 40;
    // A vertical stroke and a 3 px bar across it 5 px before its end, running far to both sides:
    // the widths widen and narrow like a head, but the ink runs out of the window sideways.
    line1(E, x, y0 + 10, x, y0 + 50);
    line1(E, x + 1, y0 + 10, x + 1, y0 + 50);
    for (let k = 0; k < 3; k++) line1(E, x0 + 2, y0 + 44 + k, x0 + 78, y0 + 44 + k);
    const arrow = {
      kind: "arrow",
      state: "exploded",
      polyline: [
        [x, y0 + 10],
        [x, y0 + 50],
      ],
    };
    const an = analyzeFigure(
      { ...f.manifest, annotations: [...f.manifest.annotations, arrow] },
      { ...sourcesOf(f), "exploded.png": E },
    ).value!;
    const g = an.annotations[an.annotations.length - 1]!;
    expect(g.problems.some((p) => /no arrowhead/.test(p))).toBe(true);
  });

  it("S-Q03: the template is the least occluded depiction, never the largest", () => {
    const V = (n: number) => ({ x: 0, y: 0, w: n, h: 1, data: new Uint8Array(n).fill(1) });
    // The exploded depiction is larger (it swallowed neighbouring ink) but 40 px of the prior
    // are hidden there; the assembled one shows everything.
    const big = {
      u: { index: 0, dep: { exploded: { V: V(900) } } },
      s: "exploded" as const,
      occ: 40,
      alone: 0,
      cons: 900,
    };
    const small = {
      u: { index: 0, dep: { assembled: { V: V(700) } } },
      s: "assembled" as const,
      occ: 0,
      alone: 0,
      cons: 900,
    };
    expect([big, small].sort(compareTemplates)[0]).toBe(small);
    // Equal occlusion: the depiction that stands alone, then the more consistent one.
    const alone = { ...small, occ: 40 };
    expect([{ ...big, alone: 1 }, alone].sort(compareTemplates)[0]).toBe(alone);
    const consistent = { ...small, occ: 40, cons: 950 };
    expect([big, consistent].sort(compareTemplates)[0]).toBe(consistent);
  });

  it("a ghost next to an open arrowhead over a busy board still fails exploded-residual", () => {
    const { f, result } = run("main");
    const base = clone(result.outputs.base);
    const A = f.states.assembled!.image;
    const t = f.states.assembled!.truth.units["hs-1"]!;
    const [ax, ay] = t.pos;
    // Ghost: hs-1's top fins left at its seat (ink only; the footprint does not have them).
    let ghost = 0;
    eachInMask(t.full, (x, y) => {
      const lx = x - ax;
      const ly = y - ay;
      if (ly >= 3 && ly <= 13 && lx >= 26 && lx <= 70 && lumAt(A, x, y) < 96) {
        copyPx(base, A, x, y);
        ghost++;
      }
    });
    expect(ghost).toBeGreaterThan(60);
    // An open arrow in the exploded drawing, over the busy board, whose head ends just left of
    // the ghost's place there (within the old 3w span of it).
    const [dx, dy] = f.offset;
    const E = clone(f.states.exploded!.image);
    const tipX = ax + 16 + dx;
    const tipY = ay + 10 + dy;
    line2(E, tipX, tipY - 40, tipX, tipY);
    line2(E, tipX, tipY, tipX - 8, tipY - 9);
    line2(E, tipX, tipY, tipX + 8, tipY - 9);
    const arrow = {
      kind: "arrow",
      state: "exploded",
      polyline: [
        [tipX, tipY - 40],
        [tipX, tipY],
      ],
    };
    const manifest = { ...f.manifest, annotations: [...f.manifest.annotations, arrow] };
    const r = check(manifest, { ...sourcesOf(f), "exploded.png": E }, { ...result.outputs, base });
    expect(errorCodes(r)).toContain("asset/exploded-residual");
  });

  it("an arrow whose tip lies on a part's edge is valid in a correct figure", () => {
    const f = figure("leaders");
    const A = clone(f.states.assembled!.image);
    const [px, py] = f.states.assembled!.truth.units["hs-2"]!.pos;
    const x = px + 56;
    drawArrow(A, x, py - 28, py + 2); // the tip on the top edge's first row
    const annotations = [
      ...f.manifest.annotations,
      {
        kind: "arrow",
        state: "assembled",
        polyline: [
          [x, py - 28],
          [x, py + 2],
        ],
      },
    ];
    const r = runFigure({ ...f.manifest, annotations }, { ...sourcesOf(f), "assembled.png": A });
    expect(r.value).toBeDefined();
    expect(r.value!.report.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.value!.report.annotations[r.value!.report.annotations.length - 1]!.arrowhead).toBe(
      true,
    );
  });
});

describe("gate (G-Q05): rule 4 counts both placements of a part in each drawing", () => {
  it("an exploded-state arrow over the seat location is capped", () => {
    const { f, result } = run("main");
    const [ax, ay] = f.states.assembled!.truth.units["hs-1"]!.pos;
    const [dx, dy] = f.offset;
    const E = clone(f.states.exploded!.image);
    const x = ax + 40 + dx;
    drawArrow(E, x, ay - 10 + dy, ay + 40 + dy);
    const arrow = {
      kind: "arrow",
      state: "exploded",
      polyline: [
        [x, ay - 10 + dy],
        [x, ay + 40 + dy],
      ],
    };
    const r = check(
      { ...f.manifest, annotations: [...f.manifest.annotations, arrow] },
      { ...sourcesOf(f), "exploded.png": E },
      result.outputs,
    );
    expect(
      messages(r, "asset/annotation-invalid").some((m) =>
        /px of hs-1 lie inside annotations/.test(m),
      ),
    ).toBe(true);
  });
});

describe("gate: stronger variants (G-Q07, G-Q08, G-Q09, G-Q10, G-Q11, G-Q12)", () => {
  it("G-Q07: a 12 px stroke across a ghost, no width declared: the measured band hides only part of it", () => {
    const { f, result } = run("main");
    const base = clone(result.outputs.base);
    restoreAll(base, f.states.assembled!.image, f.states.assembled!.truth.units["hs-1"]!.full);
    const [ax, ay] = f.states.assembled!.truth.units["hs-1"]!.pos;
    const [dx, dy] = f.offset;
    const E = clone(f.states.exploded!.image);
    const x = ax + 50 + dx;
    for (let yy = ay - 6 + dy; yy <= ay + 70 + dy; yy++)
      for (let k = 0; k < 12; k++) setPx(E, x - 6 + k, yy, BLACK);
    const stroke = {
      kind: "arrow",
      state: "exploded",
      polyline: [
        [x, ay - 6 + dy],
        [x, ay + 70 + dy],
      ],
    };
    const manifest = { ...f.manifest, annotations: [...f.manifest.annotations, stroke] };
    const an = analyzeFigure(manifest, { ...sourcesOf(f), "exploded.png": E }).value!;
    expect(an.annotations[an.annotations.length - 1]!.medianRun).toBe(12);
    const r = runGate(an, { ...result.outputs, base });
    expect(errorCodes(r)).toContain("asset/exploded-residual");
  });

  it("G-Q08: many grazes under 16 px each, the bands never touching the part, add up", () => {
    const { f, result } = run("main");
    const E = clone(f.states.exploded!.image);
    const [px, py] = f.states.exploded!.truth.units["hs-1"]!.pos;
    const top = py + 2;
    const extra: unknown[] = [];
    // Ten 5 px leaders 3 px above the top edge, each with a mark: their bands stay off the part,
    // their masks graze it (about 7 px each); the first four use up the part's 8 allowances.
    for (let k = 0; k < 10; k++) {
      const x0 = px + 34 + 5 * k;
      line1(E, x0, top - 3, x0 + 4, top - 3);
      for (let j = 0; j < 4; j++) setPx(E, x0 + 2, top - 10 + j, BLACK);
      extra.push({ kind: "text", state: "exploded", rect: [x0 + 1, top - 11, 3, 6] });
      extra.push({
        kind: "leader",
        state: "exploded",
        polyline: [
          [x0, top - 3],
          [x0 + 4, top - 3],
        ],
      });
    }
    const r = check(
      { ...f.manifest, annotations: [...f.manifest.annotations, ...extra] },
      { ...sourcesOf(f), "exploded.png": E },
      result.outputs,
    );
    const msgs = messages(r, "asset/annotation-invalid");
    expect(msgs.some((m) => /px of hs-1 lie inside annotations/.test(m))).toBe(true);
    expect(msgs.some((m) => /band covers/.test(m))).toBe(false);
  });

  it("G-Q09: fins the mask really misses (a polygon clips them), hidden by text, fail by part ink or hull", () => {
    const f = figure("main");
    const parts = f.manifest.parts.map((p: Record<string, unknown>, i: number) => {
      if (i > 1) return p;
      const poly: Record<string, number[][]> = {};
      for (const s of ["exploded", "assembled"] as const) {
        const t = f.states[s]!.truth.units["hs-1"]!.full;
        poly[s] = [
          [t.x - 1, t.y + 13],
          [t.x + t.w, t.y + 13],
          [t.x + t.w, t.y + t.h],
          [t.x - 1, t.y + t.h],
        ];
      }
      return { ...p, polygon: poly };
    });
    const manifest0 = { ...f.manifest, parts };
    const out = runFigure(manifest0, sourcesOf(f)).value!.outputs;
    const [px, py] = f.states.exploded!.truth.units["hs-1"]!.pos;
    const rect = [px + 20, py, 56, 9];
    const r = check(
      {
        ...manifest0,
        annotations: [...f.manifest.annotations, { kind: "text", state: "exploded", rect }],
      },
      sourcesOf(f),
      out,
    );
    expect(
      messages(r, "asset/annotation-invalid").some((m) => /part ink of hs-1|hull of hs-1/.test(m)),
    ).toBe(true);
  });

  it("comb fins every depiction misses (a polygon clips them) fail as one residual, not 32 small ones", () => {
    const f = figure("dense");
    const parts = f.manifest.parts.map((p: Record<string, unknown>) => {
      const poly: Record<string, number[][]> = {};
      for (const s of ["exploded", "assembled"] as const) {
        const t = f.states[s]!.truth.units["sink-1"]!.full;
        poly[s] = [
          [t.x - 1, t.y + 20],
          [t.x + t.w, t.y + 20],
          [t.x + t.w, t.y + t.h + 1],
          [t.x - 1, t.y + t.h + 1],
        ];
      }
      return { ...p, polygon: poly };
    });
    // Each 1 px fin's clipped top is about 20 px, under the 24 px threshold on its own.
    const r = runFigure({ ...f.manifest, parts }, sourcesOf(f)).value!;
    expect(errorCodes(r.report)).toContain("asset/exploded-residual");
  });

  it("G-Q10: a rectangle sprite with transparent padding is still a rectangle mask", () => {
    const { f, result } = run("main");
    const box = f.states.assembled!.truth.units["hs-1"]!.full;
    const rect = crop(f.states.assembled!.image, { x: box.x, y: box.y, w: box.w, h: box.h }).value!;
    const padded: Raster = {
      width: rect.width + 2,
      height: rect.height + 2,
      data: new Uint8Array((rect.width + 2) * (rect.height + 2) * 4),
    };
    for (let y = 0; y < rect.height; y++)
      padded.data.set(
        rect.data.subarray(y * rect.width * 4, (y + 1) * rect.width * 4),
        ((y + 1) * padded.width + 1) * 4,
      );
    const o = result.outputs;
    const parts = o.parts.map((p, i) =>
      i === 0
        ? {
            ...p,
            sprite: 1,
            seat: [box.x - 1, box.y - 1] as const,
            exploded: [p.exploded[0] - 1, p.exploded[1] - 1] as const,
          }
        : p,
    );
    expect(
      errorCodes(check(f.manifest, sourcesOf(f), { ...o, sprites: [...o.sprites, padded], parts })),
    ).toContain("asset/rect-mask");
  });

  it("G-Q11: positions must be integers and sprite alpha binary", () => {
    const { f, result } = run("main");
    const o = result.outputs;
    const frac = {
      ...o,
      parts: o.parts.map((p, i) =>
        i === 0 ? { ...p, seat: [p.seat[0] + 0.5, p.seat[1]] as const } : p,
      ),
    };
    const soft = clone(o.sprites[0]!);
    soft.data[3 + 4 * 200] = 128;
    for (const bad of [frac, { ...o, sprites: [soft] }]) {
      const r = checkFigure(f.manifest, sourcesOf(f), bad);
      expect(r.diagnostics.find((d) => d.severity === "error")?.params?.option).toBe("outputs");
    }
  });

  it("G-Q12: annotation ink of the other drawing copied into the base is an arrow residual", () => {
    const { f, result } = run("main");
    const an = analyzeFigure(f.manifest, sourcesOf(f)).value!;
    const base = clone(result.outputs.base);
    const E = f.states.exploded!.image;
    const [dx, dy] = f.offset;
    const g = an.annotations.find((x) => x.kind === "arrow" && x.state === "exploded")!;
    let n = 0;
    eachInMask(g.band, (x, y) => {
      const bx = x - dx;
      const by = y - dy;
      if (bx < 0 || by < 0 || bx >= base.width || by >= base.height || lumAt(E, x, y) >= 96) return;
      copyPx(base, E, bx, by, x, y);
      n++;
    });
    if (n === 0) {
      // The exploded arrows map above the base's frame: use the label leader instead.
      const h = an.annotations.find((x) => x.kind === "leader" && x.state === "exploded")!;
      eachInMask(h.band, (x, y) => {
        const bx = x - dx;
        const by = y - dy;
        if (bx < 0 || by < 0 || bx >= base.width || by >= base.height) return;
        setPx(base, bx, by, BLACK);
        n++;
      });
    }
    // Nothing maps inside the base for main; build the case on twins with a declared exploded leader instead.
    expect(n).toBeGreaterThanOrEqual(0);
    const t = figure("twins");
    const ET = clone(t.states.exploded!.image);
    const lx = 200;
    line1(ET, lx, 230, lx + 30, 230);
    for (let k = 0; k < 7; k++) setPx(ET, lx + 33, 227 + k, BLACK);
    const ann = [
      {
        kind: "leader",
        state: "exploded",
        polyline: [
          [lx, 230],
          [lx + 30, 230],
        ],
      },
      { kind: "text", state: "exploded", rect: [lx + 32, 226, 3, 9] },
    ];
    const tm = { ...t.manifest, annotations: ann };
    const tsrc = { ...sourcesOf(t), "exploded.png": ET };
    const tout = runFigure(tm, tsrc).value!.outputs;
    const tb = clone(tout.base);
    const [tdx, tdy] = t.offset;
    for (let x = lx; x <= lx + 30; x++) setPx(tb, x - tdx, 230 - tdy, BLACK);
    expect(errorCodes(check(tm, tsrc, { ...tout, base: tb }))).toContain("asset/arrow-residual");
  });
});

describe("limits and helpers (S-Q08, S-Q09, S-Q12, S-Q13)", () => {
  it("S-Q08: locate with a precomputed luminance plane gives the same matches", () => {
    const f = figure("twins");
    const E = f.states.exploded!.image;
    const sprite = f.sprites["tw-2"]!.raster;
    const a = locate(E, sprite, { scales: [1], top: 3, nmsIoU: 0.8 });
    const b = locate(E, sprite, { scales: [1], top: 3, nmsIoU: 0.8, plane: luminancePlane(E) });
    expect(b.value!.matches).toEqual(a.value!.matches);
    expect(b.value!.matches.length).toBeGreaterThan(0);
  });

  it("S-Q12: non-finite or non-positive limits are refused", () => {
    const f = figure("main");
    for (const o of [
      { maxPixels: 0 },
      { maxPixels: Number.NaN },
      { maxMultiplyAdds: -1 },
      { maxMultiplyAdds: Infinity },
    ]) {
      const r = runFigure(f.manifest, sourcesOf(f), o);
      expect(r.value).toBeUndefined();
      expect(r.diagnostics[0]!.code).toBe("asset/bad-option");
    }
  });

  it("S-Q13: outputs rebuilt from fragment.json and the PNGs pass the same gate", () => {
    const { f, result } = run("main");
    const frag = JSON.parse(
      new TextDecoder().decode(result.files.find((x) => x.name === "fragment.json")!.bytes),
    );
    const images: Record<string, Raster> = {
      "base.png": result.outputs.base,
      "sprite-1.png": result.outputs.sprites[0]!,
    };
    const o = outputsFromFragment(frag, images);
    expect(o.value).toBeDefined();
    const r = checkFigure(f.manifest, sourcesOf(f), o.value!);
    expect(r.value!.ok).toBe(true);
    expect(outputsFromFragment({ images: [], figures: [] }, images).diagnostics[0]!.code).toBe(
      "asset/bad-option",
    );
  });

  it("S-Q13: the exclusion overlay tints exactly the excluded pixels", () => {
    const f = figure("main");
    const r = exclusionOverlay(f.manifest, sourcesOf(f));
    const an = analyzeFigure(f.manifest, sourcesOf(f)).value!;
    for (const s of ["exploded", "assembled"] as const) {
      const ov = r.value![s]!;
      const src = f.states[s]!.image;
      let changed = 0;
      for (let i = 0; i < ov.width * ov.height; i++)
        if (ov.data[i * 4 + 1] !== src.data[i * 4 + 1]) changed++;
      let n = 0;
      eachInMask(an.excluded[s]!, (x, y) => {
        if (src.data[(y * src.width + x) * 4 + 1]! > 0) n++;
      });
      expect(changed).toBe(n);
      expect(n).toBeGreaterThan(0);
    }
  });

  it("S-Q13: cutout honours the prior and the limits", () => {
    const f = figure("leaders");
    const E = f.states.exploded!.image;
    const seeds = f.manifest.parts
      .filter((p: { group: string }) => p.group === "hs-1")
      .flatMap((p: { seeds: { exploded: number[][] } }) => p.seeds.exploded);
    expect(cutout(E, { seeds, prior: "box" }).value).toBeDefined();
    expect(cutout(E, { seeds }, { maxPixels: 1000 }).diagnostics[0]!.code).toBe("asset/too-large");
  });

  it(
    "S-Q09: a realistic 4 MP figure with 32 parts and 64 annotations finishes in bounded time",
    { timeout: 300_000 },
    () => {
      const W = 2048;
      const data = new Uint8Array(W * W * 4).fill(255);
      const ink = (x: number, y: number): void => data.set(BLACK, (y * W + x) * 4);
      const parts: unknown[] = [];
      const annotations: unknown[] = [];
      for (let k = 0; k < 32; k++) {
        const x0 = 100 + (k % 8) * 230;
        const y0 = 150 + Math.floor(k / 8) * 450;
        for (let i = 0; i < 120; i++) {
          for (const t of [0, 1]) {
            ink(x0 + i, y0 + t);
            ink(x0 + i, y0 + 118 + t);
            ink(x0 + t, y0 + i);
            ink(x0 + 118 + t, y0 + i);
          }
        }
        for (let i = 10; i < 110; i += 12) for (let j = 0; j < 40; j++) ink(x0 + i, y0 + 40 + j);
        parts.push({ id: `p${k}`, seeds: { exploded: [[x0 + 60, y0 + 20]] }, prior: "box" });
        for (const a of [0, 1]) {
          const lx = x0 + 20 + 60 * a;
          for (let j = 0; j < 30; j++) ink(lx, y0 - 40 + j);
          for (let j = 0; j < 9; j++) ink(lx - 3, y0 - 52 + j);
          annotations.push({
            kind: "leader",
            state: "exploded",
            polyline: [
              [lx, y0 - 40],
              [lx, y0 - 11],
            ],
          });
        }
      }
      for (let k = 0; k < 32; k++) {
        const x0 = 100 + (k % 8) * 230;
        const y0 = 150 + Math.floor(k / 8) * 450;
        void x0;
        void y0;
      }
      const t0 = Date.now();
      const r = runFigure(
        { sources: { exploded: "s.png" }, parts, annotations },
        { "s.png": { width: W, height: W, data } },
      );
      const ms = Date.now() - t0;
      console.log(`S-Q09: 4 MP, 32 parts, 64 annotations: ${ms} ms`);
      expect(r.value).toBeDefined();
      expect(r.value!.report.parts).toHaveLength(32);
      expect(ms).toBeLessThan(240_000);
    },
  );
});

void maskHas;
