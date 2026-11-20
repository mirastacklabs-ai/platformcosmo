/**
 * The broken-variant table of tracks C-4 (normative): each deliberately broken variant fails the
 * gate with at least the listed codes, all at error severity. Variants are built from the correct
 * pipeline's outputs (or manifest) of the synthetic trap figures, using the generator's ground
 * truth to place each defect exactly.
 */
import { describe, expect, it } from "vitest";
import { figure } from "../../../tests/fixtures/figures/gen.mjs";
import { analyzeFigure, type Analysis } from "../src/figure/analyze.js";
import { buildOutputs, type FigureOutputs } from "../src/figure/build.js";
import { runGate, type FigureReport } from "../src/figure/gate.js";
import { crop } from "../src/ops.js";
import type { Raster } from "../src/raster.js";
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
  sourcesOf,
  type GenFigure,
} from "./figure-helpers.js";

interface Ctx {
  readonly f: GenFigure;
  readonly o: FigureOutputs;
  readonly an: Analysis;
}

const ctxCache = new Map<string, Ctx>();
function ctx(name: string): Ctx {
  const hit = ctxCache.get(name);
  if (hit) return hit;
  const { f, result } = run(name);
  expect(result.report.ok).toBe(true);
  const an = analyzeFigure(f.manifest, sourcesOf(f)).value!;
  const c = { f, o: result.outputs, an };
  ctxCache.set(name, c);
  return c;
}

/** Gate on modified outputs (same manifest and sources: the cached analysis is reused). */
const gate = (c: Ctx, o: FigureOutputs): FigureReport => runGate(c.an, o);

function expectCodes(r: FigureReport, codes: readonly string[]): void {
  const got = errorCodes(r);
  for (const code of codes) expect(got, `${code} in ${[...got].join(", ")}`).toContain(code);
}

/** Layer-local coordinates of a unit in a state: local (lx, ly) is image (lx + pos.x, ly + pos.y). */
const pos = (c: Ctx, id: string, s: "assembled" | "exploded") =>
  c.f.states[s]!.truth.units[id]!.pos;
const gtFull = (c: Ctx, id: string, s: "assembled" | "exploded") =>
  c.f.states[s]!.truth.units[id]!.full;

/** Base with the assembled drawing's pixels of `id` restored where `pred(local x, local y)` holds. */
function restore(
  c: Ctx,
  base: Raster,
  id: string,
  pred: (lx: number, ly: number) => boolean,
  inkOnly = false,
): number {
  const A = c.f.states.assembled!.image;
  const [px, py] = pos(c, id, "assembled");
  let n = 0;
  eachInMask(gtFull(c, id, "assembled"), (x, y) => {
    if (!pred(x - px, y - py)) return;
    if (inkOnly && lumAt(A, x, y) >= 96) return;
    copyPx(base, A, x, y);
    n++;
  });
  return n;
}

/** Sprite with pixels where `pred(local x, local y)` holds made transparent (sprite (i, j) = local (i, j + 2)). */
function cut(
  c: Ctx,
  sprite: Raster,
  id: string,
  pred: (lx: number, ly: number) => boolean,
): Raster {
  const out = clone(sprite);
  const full = gtFull(c, id, "assembled");
  const [px, py] = pos(c, id, "assembled");
  const ox = full.x - px;
  const oy = full.y - py;
  for (let j = 0; j < out.height; j++)
    for (let i = 0; i < out.width; i++)
      if (pred(i + ox, j + oy)) out.data[(j * out.width + i) * 4 + 3] = 0;
  return out;
}

const withSprite = (
  o: FigureOutputs,
  k: number,
  sprite: Raster,
  seat?: readonly [number, number],
): FigureOutputs => {
  const parts = o.parts.map((p, i) => {
    if (i !== k) return p;
    const dx = seat ? seat[0] - p.seat[0] : 0;
    const dy = seat ? seat[1] - p.seat[1] : 0;
    return {
      ...p,
      sprite: o.sprites.length,
      seat: seat ?? p.seat,
      exploded: [p.exploded[0] + dx, p.exploded[1] + dy] as const,
    };
  });
  return { ...o, sprites: [...o.sprites, sprite], parts };
};

const FIN_BLOCK = (lx: number): boolean => lx <= 11;
const CLIP = (lx: number): boolean => lx >= 86;

describe("broken variants fail with their codes (tracks C-4, normative)", () => {
  it("rectangle mask: asset/rect-mask, asset/foreign-pixels, asset/exploded-residual", () => {
    const c = ctx("main");
    const box = gtFull(c, "hs-1", "assembled");
    const rect = crop(c.f.states.assembled!.image, {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
    }).value!;
    const r = gate(c, withSprite(c.o, 0, rect, [box.x, box.y]));
    expectCodes(r, ["asset/rect-mask", "asset/foreign-pixels", "asset/exploded-residual"]);
  });

  it("base not erased (ghost fins): asset/leftover-fragment, asset/exploded-residual", () => {
    const c = ctx("main");
    const base = clone(c.o.base);
    expect(restore(c, base, "hs-1", () => true)).toBeGreaterThan(1000);
    expectCodes(gate(c, { ...c.o, base }), ["asset/leftover-fragment", "asset/exploded-residual"]);
  });

  it("enclosed interior left transparent: asset/mask-hole, asset/assembled-residual", () => {
    const c = ctx("main");
    const sp = clone(c.o.sprites[0]!);
    // Paper reachable from the seeds through paper stays; enclosed paper (fin strips) is cleared.
    const seat = c.o.parts[0]!.seat;
    const seeds: number[][] = c.f.manifest.parts
      .filter((p: { group: string }) => p.group === "hs-1")
      .flatMap((p: { seeds: { assembled: number[][] } }) => p.seeds.assembled);
    const paper = (i: number, j: number): boolean =>
      sp.data[(j * sp.width + i) * 4 + 3] !== 0 && lumAt(sp, i, j) >= 128;
    const seen = new Uint8Array(sp.width * sp.height);
    const stack = seeds
      .map(([x, y]) => [x! - seat[0], y! - seat[1]] as [number, number])
      .filter(([i, j]) => paper(i, j));
    for (const [i, j] of stack) seen[j * sp.width + i] = 1;
    while (stack.length > 0) {
      const [i, j] = stack.pop()!;
      for (const [a, b] of [
        [i - 1, j],
        [i + 1, j],
        [i, j - 1],
        [i, j + 1],
      ] as const) {
        if (
          a < 0 ||
          b < 0 ||
          a >= sp.width ||
          b >= sp.height ||
          seen[b * sp.width + a] ||
          !paper(a, b)
        )
          continue;
        seen[b * sp.width + a] = 1;
        stack.push([a, b]);
      }
    }
    let cleared = 0;
    for (let j = 0; j < sp.height; j++) {
      for (let i = 0; i < sp.width; i++) {
        if (paper(i, j) && !seen[j * sp.width + i]) {
          sp.data[(j * sp.width + i) * 4 + 3] = 0;
          cleared++;
        }
      }
    }
    expect(cleared).toBeGreaterThan(200);
    const sprites = [...c.o.sprites];
    sprites[0] = sp;
    expectCodes(gate(c, { ...c.o, sprites }), ["asset/mask-hole", "asset/assembled-residual"]);
  });

  it.each(["main", "twins"])(
    "%s: twin instances assigned crosswise: asset/instance-swap",
    (name) => {
      const c = ctx(name);
      const [a, b] = c.o.parts;
      const parts = [
        { ...a!, exploded: b!.exploded },
        { ...b!, exploded: a!.exploded },
      ];
      expectCodes(gate(c, { ...c.o, parts }), ["asset/instance-swap"]);
    },
  );

  it("board under a moved part not recovered: asset/base-unrecovered, asset/exploded-residual", () => {
    const c = ctx("main");
    const { outputs } = buildOutputs(c.an, { erase: "fill" });
    expectCodes(gate(c, outputs), ["asset/base-unrecovered", "asset/exploded-residual"]);
    // The manifest switch does the same.
    const f = figure("main");
    const r = check({ ...f.manifest, erase: "fill" }, sourcesOf(f), outputs);
    expectCodes(r, ["asset/base-unrecovered", "asset/exploded-residual"]);
  });

  /** Ink of the annotations of `state` restored into the base (only ink outside every part). */
  function keepAnnotations(c: Ctx, which: (i: number) => boolean): Raster {
    const base = clone(c.o.base);
    const st = c.f.base;
    const img = c.f.states[st]!.image;
    const parts = Object.values(c.f.states[st]!.truth.units);
    let n = 0;
    for (const g of c.an.annotations) {
      if (g.state !== st || !which(g.index)) continue;
      const m = g.mask;
      for (let j = 0; j < m.h; j++) {
        for (let i = 0; i < m.w; i++) {
          const x = i + m.x;
          const y = j + m.y;
          if (
            !m.data[j * m.w + i] ||
            lumAt(img, x, y) >= 96 ||
            parts.some((t) => maskHas(t.full, x, y))
          )
            continue;
          copyPx(base, img, x, y);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(40);
    return base;
  }

  it("arrows left in the base: asset/arrow-residual", () => {
    const c = ctx("main");
    const press = c.an.annotations.find(
      (g) => g.kind === "arrow" && g.state === "assembled",
    )!.index;
    expectCodes(gate(c, { ...c.o, base: keepAnnotations(c, (i) => i === press) }), [
      "asset/arrow-residual",
    ]);
    const e = ctx("exploded-only");
    expectCodes(gate(e, { ...e.o, base: keepAnnotations(e, () => true) }), [
      "asset/arrow-residual",
    ]);
  });

  it("arrow declared but not erased: asset/arrow-residual", () => {
    const e = ctx("exploded-only");
    expectCodes(gate(e, { ...e.o, base: keepAnnotations(e, (i) => i === 0) }), [
      "asset/arrow-residual",
    ]);
  });

  it("arrow erased but not declared: asset/exploded-residual (undeclared ink is never excluded)", () => {
    const e = ctx("exploded-only");
    const manifest = { ...e.f.manifest, annotations: e.f.manifest.annotations.slice(1) };
    expectCodes(check(manifest, sourcesOf(e.f), e.o), ["asset/exploded-residual"]);
  });

  describe("residual hidden by a declared annotation", () => {
    it("a text rect over a ghost fin: asset/annotation-invalid", () => {
      const c = ctx("main");
      const base = clone(c.o.base);
      expect(
        restore(c, base, "hs-1", (lx, ly) => ly <= 15 && lx >= 18 && lx <= 76, true),
      ).toBeGreaterThan(40);
      const [px, py] = pos(c, "hs-1", "assembled");
      const [dx, dy] = c.f.offset;
      const rect = [px + 16 + dx, py - 1 + dy, 62, 18];
      const manifest = {
        ...c.f.manifest,
        annotations: [...c.f.manifest.annotations, { kind: "text", state: "exploded", rect }],
      };
      const r = check(manifest, sourcesOf(c.f), { ...c.o, base });
      expectCodes(r, ["asset/annotation-invalid"]);
      expect(
        r.diagnostics.some(
          (d) =>
            d.code === "asset/annotation-invalid" &&
            /overlaps the hull of hs-1|contains part ink of hs-1/.test(d.message),
        ),
      ).toBe(true);
    });

    it("a text rect over a seated clip lever: asset/annotation-invalid", () => {
      const c = ctx("main");
      const base = clone(c.o.base);
      restore(c, base, "hs-1", CLIP);
      restore(c, base, "hs-2", CLIP);
      const sprites = [cut(c, c.o.sprites[0]!, "hs-1", CLIP)];
      const [px, py] = pos(c, "hs-1", "assembled");
      const [dx, dy] = c.f.offset;
      const rect = [px + 84 + dx, py + 12 + dy, 12, 34];
      const manifest = {
        ...c.f.manifest,
        annotations: [...c.f.manifest.annotations, { kind: "text", state: "exploded", rect }],
      };
      expectCodes(check(manifest, sourcesOf(c.f), { ...c.o, base, sprites }), [
        "asset/annotation-invalid",
        "asset/exploded-residual",
      ]);
    });

    it("a wide polyline across a fragment: asset/annotation-invalid and/or asset/exploded-residual", () => {
      const c = ctx("main");
      const base = clone(c.o.base);
      restore(c, base, "hs-1", CLIP);
      const [px, py] = pos(c, "hs-1", "assembled");
      const [dx, dy] = c.f.offset;
      // A real 2 px arrow drawn across the ghost clip's place, declared 20 px wide to cover it.
      const x = px + 89 + dx;
      const E = clone(c.f.states.exploded!.image);
      drawArrow(E, x, py + 50 + dy, py + 4 + dy);
      const arrow = {
        kind: "arrow",
        state: "exploded",
        polyline: [
          [x, py + 50 + dy],
          [x, py + 4 + dy],
        ],
        width: 20,
      };
      const manifest = { ...c.f.manifest, annotations: [...c.f.manifest.annotations, arrow] };
      const sources = { ...sourcesOf(c.f), "exploded.png": E };
      const r = check(manifest, sources, { ...c.o, base });
      // The declared width is refused (the band is measured, never the declared width); the
      // ghost clip itself is also found in the base.
      expectCodes(r, ["asset/annotation-invalid", "asset/leftover-fragment"]);
      expect(r.diagnostics.some((d) => /declared width 20/.test(d.message))).toBe(true);
      expect(r.diagnostics.some((d) => /no arrowhead|not on ink/.test(d.message))).toBe(false);
    });
  });

  /** Outputs where segmentation missed the outer fin block: not in the sprite, left in the base. */
  function finsMissed(c: Ctx): FigureOutputs {
    const base = clone(c.o.base);
    expect(restore(c, base, "hs-1", FIN_BLOCK)).toBeGreaterThan(200);
    restore(c, base, "hs-2", FIN_BLOCK);
    return { ...c.o, base, sprites: [cut(c, c.o.sprites[0]!, "hs-1", FIN_BLOCK)] };
  }

  it.each([["exploded"], ["exploded", "assembled"]] as const)(
    "fins the segmentation missed, declared as text in %j: asset/annotation-invalid",
    (...states) => {
      const c = ctx("main");
      const rects = states.flatMap((s) =>
        ["hs-1", "hs-2"].map((id) => {
          const [px, py] = pos(c, id, s);
          return { kind: "text", state: s, rect: [px - 1, py + 25, 13, 36] };
        }),
      );
      const manifest = { ...c.f.manifest, annotations: [...c.f.manifest.annotations, ...rects] };
      const r = check(manifest, sourcesOf(c.f), finsMissed(c));
      expectCodes(r, ["asset/annotation-invalid"]);
      expect(r.diagnostics.some((d) => /contains part ink of hs-1/.test(d.message))).toBe(true);
    },
  );

  it("outermost fin row missed, declared as a leader: asset/annotation-invalid", () => {
    const c = ctx("main");
    const [px, py] = pos(c, "hs-1", "exploded");
    const leader = {
      kind: "leader",
      state: "exploded",
      polyline: [
        [px, py + 28],
        [px, py + 56],
      ],
    };
    const manifest = { ...c.f.manifest, annotations: [...c.f.manifest.annotations, leader] };
    const r = check(manifest, sourcesOf(c.f), finsMissed(c));
    expectCodes(r, ["asset/annotation-invalid"]);
    expect(r.diagnostics.some((d) => /covers hs-1/.test(d.message))).toBe(true);
  });

  it("a leader traced along a fin's own ink: asset/annotation-invalid", () => {
    const c = ctx("main");
    const [px, py] = pos(c, "hs-1", "exploded");
    const leader = {
      kind: "leader",
      state: "exploded",
      polyline: [
        [px + 24, py + 14],
        [px + 44, py + 2],
      ],
    };
    const manifest = { ...c.f.manifest, annotations: [...c.f.manifest.annotations, leader] };
    const r = check(manifest, sourcesOf(c.f), c.o);
    expectCodes(r, ["asset/annotation-invalid"]);
    expect(r.diagnostics.some((d) => /covers hs-1/.test(d.message))).toBe(true);
  });

  it("many small annotations each touching a part (cumulative overlap): asset/annotation-invalid", () => {
    const c = ctx("main");
    const E = clone(c.f.states.exploded!.image);
    const [px, py] = pos(c, "hs-1", "exploded");
    const extra: unknown[] = [];
    for (let k = 0; k < 12; k++) {
      const x = px + 34 + 4 * k;
      line1(E, x, py - 16, x, py - 11); // a tiny callout mark
      line1(E, x, py - 8, x, py + 1); // its leader, touching the top edge
      extra.push({ kind: "text", state: "exploded", rect: [x - 1, py - 17, 3, 8] });
      extra.push({
        kind: "leader",
        state: "exploded",
        polyline: [
          [x, py - 8],
          [x, py + 1],
        ],
      });
    }
    const sources = { ...sourcesOf(c.f), "exploded.png": E };
    const manifest = { ...c.f.manifest, annotations: [...c.f.manifest.annotations, ...extra] };
    const r = check(manifest, sources, c.o);
    expectCodes(r, ["asset/annotation-invalid"]);
    expect(r.diagnostics.some((d) => /px of hs-1 lie inside annotations/.test(d.message))).toBe(
      true,
    );
  });

  it("a 40 px ghost cut in two by an arrow band: asset/exploded-residual (the band bridges the pieces)", () => {
    const c = ctx("main");
    const base = clone(c.o.base);
    // Ghost: a piece of the top face's front edge (A-G), left in the base at the seat.
    const ghost: [number, number][] = [];
    const A = c.f.states.assembled!.image;
    const [px, py] = pos(c, "hs-1", "assembled");
    eachInMask(gtFull(c, "hs-1", "assembled"), (x, y) => {
      const lx = x - px;
      const ly = y - py;
      if (lx >= 30 && lx <= 51 && ly >= 14 && ly <= 15 && lumAt(A, x, y) < 96) ghost.push([x, y]);
    });
    for (const [x, y] of ghost) base.data.set([0, 0, 0, 255], (y * base.width + x) * 4);
    expect(ghost.length).toBeGreaterThanOrEqual(30);
    expect(ghost.length).toBeLessThanOrEqual(50);
    // An arrow drawn and declared in the exploded drawing across the ghost's place there.
    const [dx, dy] = c.f.offset;
    const xs = ghost.map((g) => g[0]).sort((a, b) => a - b);
    const ax = xs[xs.length >> 1]! + dx;
    const E = clone(c.f.states.exploded!.image);
    // Pointing up, so the ghost lies under the shaft (the band there is the measured stroke).
    drawArrow(E, ax, py + 18 + dy, py - 16 + dy);
    const arrow = {
      kind: "arrow",
      state: "exploded",
      polyline: [
        [ax, py + 18 + dy],
        [ax, py - 16 + dy],
      ],
    };
    const manifest = { ...c.f.manifest, annotations: [...c.f.manifest.annotations, arrow] };
    const sources = { ...sourcesOf(c.f), "exploded.png": E };
    const an = analyzeFigure(manifest, sources).value!;
    const band = an.annotations[an.annotations.length - 1]!;
    expect(band.problems).toEqual([]);
    // Each piece on its own is below the threshold; only bridged through the band is it above.
    const inMask = (x: number, y: number): boolean => {
      const m = band.mask;
      const X = x + dx;
      const Y = y + dy;
      return (
        X >= m.x &&
        Y >= m.y &&
        X < m.x + m.w &&
        Y < m.y + m.h &&
        m.data[(Y - m.y) * m.w + X - m.x] === 1
      );
    };
    const left = ghost.filter(([x, y]) => !inMask(x, y) && x + dx < ax).length;
    const right = ghost.filter(([x, y]) => !inMask(x, y) && x + dx > ax).length;
    expect(left).toBeLessThanOrEqual(24);
    expect(right).toBeLessThanOrEqual(24);
    expect(left + right).toBeGreaterThan(24);
    const r = runGate(an, { ...c.o, base });
    expectCodes(r, ["asset/exploded-residual"]);
    // The bridged component itself (not only the per-band sum) carries every residual pixel.
    const items = r.checks.find((x) => x.check === "exploded-residual")!.items;
    expect(items.some((i) => i.annotation === undefined && (i.pixels ?? 0) >= left + right)).toBe(
      true,
    );
  });

  it("clip lever not grouped with its heat sink: asset/exploded-residual (the lever stays seated)", () => {
    const c = ctx("main");
    const base = clone(c.o.base);
    restore(c, base, "hs-1", CLIP);
    restore(c, base, "hs-2", CLIP);
    const sprites = [cut(c, c.o.sprites[0]!, "hs-1", CLIP)];
    expectCodes(gate(c, { ...c.o, base, sprites }), ["asset/exploded-residual"]);
  });

  it("sprite carrying a neighbour's sliver: asset/foreign-pixels", () => {
    const c = ctx("main");
    const sp = clone(c.o.sprites[0]!);
    const seat = c.o.parts[0]!.seat;
    const A = c.f.states.assembled!.image;
    const own = gtFull(c, "hs-1", "assembled");
    let n = 0;
    // The board trace that runs into hs-1's top-left corner, next to its outline.
    for (let y = seat[1]; y < seat[1] + sp.height && n < 8; y++) {
      for (let x = seat[0]; x < seat[0] + 8 && n < 8; x++) {
        if (maskHas(own, x, y) || lumAt(A, x, y) >= 96) continue;
        copyPx(sp, A, x - seat[0], y - seat[1], x, y);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(4);
    const r = gate(c, withSprite(c.o, 0, sp));
    expectCodes(r, ["asset/foreign-pixels"]);
    expect(errorCodes(r).has("asset/rect-mask")).toBe(false);
  });

  it("an annotation of the other drawing mapped over a seated part hides nothing of it", () => {
    const c = ctx("main");
    // Fin-block strips transparent in the sprite: the board's dark pad shows through when seated.
    const sp = cut(
      c,
      c.o.sprites[0]!,
      "hs-1",
      (lx, ly) =>
        lx >= 2 &&
        lx <= 11 &&
        ly >= 28 &&
        ly <= 57 &&
        ![32, 33, 38, 39, 44, 45, 50, 51].includes(ly),
    );
    // A drawn, valid exploded-state arrow whose place maps onto hs-1's seated fin block.
    const [px, py] = pos(c, "hs-1", "assembled");
    const [dx, dy] = c.f.offset;
    const x = px + 6 + dx;
    const E = clone(c.f.states.exploded!.image);
    drawArrow(E, x, py + 62 + dy, py + 24 + dy);
    const arrow = {
      kind: "arrow",
      state: "exploded",
      polyline: [
        [x, py + 62 + dy],
        [x, py + 24 + dy],
      ],
    };
    const manifest = { ...c.f.manifest, annotations: [...c.f.manifest.annotations, arrow] };
    const sources = { ...sourcesOf(c.f), "exploded.png": E };
    const r = check(manifest, sources, { ...c.o, sprites: [sp] });
    expectCodes(r, ["asset/assembled-residual"]);
  });

  it("the correct outputs pass the same gate (control)", () => {
    const c = ctx("main");
    expect(errorCodes(gate(c, c.o)).size).toBe(0);
  });
});
