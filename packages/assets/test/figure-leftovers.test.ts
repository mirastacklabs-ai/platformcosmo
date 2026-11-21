/**
 * No 1 px leftovers in the clean base or the sprites (C-4 follow-up): a polyline's ends follow
 * the stroke as drawn (a tip drawn past the declared end, a shaft declared short of the part it
 * touches), any annotation ink left in the base or carried by a sprite fails arrow-residual; with
 * one drawing, the erase takes only the annotation's own stroke, the board strokes under it stay
 * or are rebuilt across it (and any of them missing from the base fails base-unrecovered), and a
 * cut stroke that cannot be rebuilt is reported (base-unrecovered, warning).
 */
import { describe, expect, it } from "vitest";
import { figure, type GenFigure } from "../../../tests/fixtures/figures/gen.mjs";
import { runFigure, type FigureOutputs, type FigureReport, type Raster } from "../src/index.js";
import {
  check,
  clone,
  copyPx,
  drawArrow,
  errorCodes,
  line1,
  lumAt,
  maskHas,
  setPx,
  sourcesOf,
} from "./figure-helpers.js";

const BLACK = [0, 0, 0, 255] as const;
const WHITE = [255, 255, 255, 255] as const;

const errorsOf = (r: FigureReport) => r.diagnostics.filter((d) => d.severity === "error");

function fill(r: Raster, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(r, x, y, BLACK);
}

function paste(dst: Raster, sp: Raster, x: number, y: number): void {
  for (let j = 0; j < sp.height; j++)
    for (let i = 0; i < sp.width; i++) {
      const s = (j * sp.width + i) * 4;
      if (!sp.data[s + 3]) continue;
      const gx = x + i;
      const gy = y + j;
      if (gx < 0 || gy < 0 || gx >= dst.width || gy >= dst.height) continue;
      dst.data.set(sp.data.subarray(s, s + 4), (gy * dst.width + gx) * 4);
    }
}

/** Pixels of two rasters that differ by more than a grey step. */
function differences(a: Raster, b: Raster): number {
  let n = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) if (Math.abs(lumAt(a, x, y) - lumAt(b, x, y)) > 48) n++;
  return n;
}

/**
 * The outputs composited in a drawn state (base at the alignment offset, sprites at their
 * positions in draw order) next to the ground truth there: the clean board plus the clean
 * sprites at their true places.
 */
function poses(f: GenFigure, out: FigureOutputs, s: "assembled" | "exploded"): [Raster, Raster] {
  const st = f.states[s]!;
  const d = s === f.base ? [0, 0] : f.offset;
  const ours: Raster = {
    width: st.image.width,
    height: st.image.height,
    data: new Uint8Array(st.image.width * st.image.height * 4).fill(255),
  };
  paste(ours, out.base, d[0]!, d[1]!);
  const order = out.parts
    .map((p, i) => ({ p, i }))
    .sort(
      (a, b) =>
        (a.p.z ?? 0) - (b.p.z ?? 0) ||
        a.p.seat[1] +
          out.sprites[a.p.sprite]!.height -
          (b.p.seat[1] + out.sprites[b.p.sprite]!.height) ||
        a.i - b.i,
    );
  for (const { p } of order) {
    const q = s === "assembled" ? p.seat : p.exploded;
    paste(ours, out.sprites[p.sprite]!, q[0] + d[0]!, q[1] + d[1]!);
  }
  const truth = clone(st.board);
  const units = Object.entries(st.truth.units).sort(
    (a, b) => a[1].full.y + a[1].full.h - (b[1].full.y + b[1].full.h),
  );
  for (const [id, t] of units) paste(truth, f.sprites[id]!.raster, t.full.x, t.full.y);
  return [ours, truth];
}

/** Base pixels that differ from the board outside the seated parts (dilated by 1 px). */
function baseVsBoard(f: GenFigure, base: Raster, board: Raster = f.states[f.base]!.board): number {
  const parts = Object.values(f.states[f.base]!.truth.units).map((t) => t.full);
  let n = 0;
  for (let y = 0; y < board.height; y++)
    for (let x = 0; x < board.width; x++) {
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (parts.some((t) => maskHas(t, x + dx, y + dy))) near = true;
      if (!near && Math.abs(lumAt(base, x, y) - lumAt(board, x, y)) > 48) n++;
    }
  return n;
}

/** A copy of `sp` with `n` more transparent rows at the bottom. */
function taller(sp: Raster, n: number): Raster {
  const data = new Uint8Array(sp.width * (sp.height + n) * 4);
  data.set(sp.data);
  return { width: sp.width, height: sp.height + n, data };
}

/** A quiet w x h patch: paper in every drawing at the aligned place, and no part there. */
function quietPatch(f: ReturnType<typeof figure>, w: number, h: number): [number, number] {
  const A = f.states.assembled!.image;
  const X = f.states.exploded?.image;
  const [dx, dy] = f.offset;
  const paper = (r: Raster, x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < r.width && y < r.height && lumAt(r, x, y) > 250;
  const parts = Object.values(f.states.assembled!.truth.units).map((t) => t.full);
  for (let y0 = 0; y0 + h < A.height; y0 += 2)
    for (let x0 = 0; x0 + w < A.width; x0 += 2) {
      let ok = true;
      for (let y = y0; y < y0 + h && ok; y++)
        for (let x = x0; x < x0 + w && ok; x++)
          if (!paper(A, x, y) || (X && !paper(X, x + dx, y + dy))) ok = false;
          else if (parts.some((t) => maskHas(t, x, y))) ok = false;
      if (ok) return [x0, y0];
    }
  throw new Error("no quiet patch");
}

/** Pixels of the base that differ from the board by more than a grey step, in a box. */
function differing(
  base: Raster,
  board: Raster,
  x0: number,
  y0: number,
  w: number,
  h: number,
): number {
  let n = 0;
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++)
      if (Math.abs(lumAt(base, x, y) - lumAt(board, x, y)) > 48) n++;
  return n;
}

/**
 * `main` with a 2 px pin, L px long, under each heat sink in both drawings where the exploded
 * arrow's shaft starts (the shaft drawn over it); the arrows are declared from `short` px past
 * the pin's end.
 */
function pinned(L: number, short: number) {
  const f = figure("main");
  const manifest = structuredClone(f.manifest);
  const X = clone(f.states.exploded!.image);
  const A = clone(f.states.assembled!.image);
  const pins: ["assembled" | "exploded", number, number][] = [];
  for (const [k, id] of (["hs-1", "hs-2"] as const).entries()) {
    const [x, y0] = manifest.annotations[k].polyline[0] as [number, number];
    const e = f.states.exploded!.truth.units[id]!.pos;
    const s = f.states.assembled!.truth.units[id]!.pos;
    for (let t = 0; t < L; t++)
      for (const xx of [x, x + 1])
        pins.push(["exploded", xx, y0 + t], ["assembled", xx - e[0] + s[0], y0 + t - e[1] + s[1]]);
    manifest.annotations[k].polyline[0] = [x, y0 + L + short];
  }
  for (const [s, x, y] of pins) setPx(s === "exploded" ? X : A, x, y, BLACK);
  return { f, manifest, sources: { "exploded.png": X, "assembled.png": A }, pins };
}

/**
 * A board trace (the figure's stroke wide) ending exactly on a part's outline, from the left,
 * right or top, `pct` percent along that side of its bbox: drawn into the drawing and its board.
 */
function traced(
  f: GenFigure,
  unit: string,
  dir: "L" | "R" | "U",
  pct: number,
): [GenFigure, Raster] {
  const st = f.states.assembled!;
  const full = st.truth.units[unit]!.full;
  const T = f.stroke;
  const image = clone(st.image);
  const hit = (x: number, y: number): boolean => maskHas(full, x, y);
  for (let t = 0; t < T; t++) {
    if (dir === "U") {
      const x = full.x + Math.round(((full.w - T) * pct) / 100) + t;
      for (let y = full.y - 30; !hit(x, y); y++) {
        setPx(image, x, y, BLACK);
        setPx(st.board, x, y, BLACK);
      }
    } else {
      const y = full.y + Math.round(((full.h - T) * pct) / 100) + t;
      const step = dir === "L" ? 1 : -1;
      for (let x = dir === "L" ? full.x - 30 : full.x + full.w + 30; !hit(x, y); x += step) {
        setPx(image, x, y, BLACK);
        setPx(st.board, x, y, BLACK);
      }
    }
  }
  return [f, image];
}

// Every case runs the whole figure pipeline (analysis, build, gate) at least once: allow CI headroom.
describe("no 1 px leftovers in the clean base", { timeout: 120_000 }, () => {
  it("an arrow whose drawn tip runs past its declared end is erased whole, and any leftover fails", () => {
    const f = figure("main");
    const [x0, y0] = quietPatch(f, 24, 60);
    const x = x0 + 12;
    const A = clone(f.states.assembled!.image);
    // A head-down arrow; its drawn tip runs on as a 1 px needle 6 px past the declared end
    // (as a sharp or anti-aliased tip does), beyond the annotation mask.
    drawArrow(A, x, y0 + 2, y0 + 48);
    line1(A, x, y0 + 48, x, y0 + 54);
    const arrow = {
      kind: "arrow",
      state: "assembled",
      polyline: [
        [x, y0 + 2],
        [x, y0 + 48],
      ],
    };
    const manifest = { ...f.manifest, annotations: [...f.manifest.annotations, arrow] };
    const sources = { ...sourcesOf(f), "assembled.png": A };
    const r = runFigure(manifest, sources).value!;
    expect(r.report.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const board = f.states.assembled!.board;
    expect(differing(r.outputs.base, board, x0, y0, 24, 60)).toBe(0);
    // One pixel of the needle left in the base (outputs edited) fails arrow-residual.
    const base = clone(r.outputs.base);
    copyPx(base, A, x, y0 + 53);
    const g = check(manifest, sources, { ...r.outputs, base });
    expect(errorCodes(g)).toContain("asset/arrow-residual");
  });

  it("assembled-only: the board line the press arrow crosses is rebuilt, not left as a gap", () => {
    const f = figure("assembled-only");
    const r = runFigure(f.manifest, sourcesOf(f)).value!;
    const board = f.states.assembled!.board;
    // The press arrow's tail ends on a board line (a contact square there): the line runs
    // straight through the erase.
    const press = f.manifest.annotations.find(
      (a: { kind: string; state: string }) => a.kind === "arrow" && a.state === "assembled",
    ) as { polyline: [number, number][] };
    const [px, py0] = press.polyline[0]!;
    let lineY = -1;
    for (let y = py0; y > py0 - 8 && lineY < 0; y--) if (lumAt(board, px - 8, y) < 128) lineY = y;
    expect(lineY).toBeGreaterThan(0);
    expect(differing(r.outputs.base, board, px - 8, lineY - 2, 17, 6)).toBe(0);
    // The whole base is the board outside the parts: the callout leader crosses the left end of
    // a trace (its end under the leader's mask), and every board line the annotations cross
    // stays or is rebuilt.
    expect(errorsOf(r.report)).toEqual([]);
    expect(
      r.report.diagnostics.filter(
        (d) => d.code === "asset/base-unrecovered" && d.severity !== "info",
      ),
    ).toEqual([]);
    expect(baseVsBoard(f, r.outputs.base)).toBe(0);
    // The trace end cut under the leader (as before this fix: 11 x 2 px at (120, 152)) fails.
    const cut = clone(r.outputs.base);
    for (let y = 152; y <= 153; y++)
      for (let x = 120; x <= 130; x++) if (lumAt(board, x, y) < 128) setPx(cut, x, y, WHITE);
    const g = check(f.manifest, sourcesOf(f), { ...r.outputs, base: cut });
    expect(errorCodes(g)).toContain("asset/base-unrecovered");
  });

  it("one drawing: a lined-up line under an arrow is rebuilt; one that does not line up is reported", () => {
    for (const aligned of [true, false]) {
      const f = figure("assembled-only");
      const [x0, y0] = quietPatch(f, 24, 60);
      const x = x0 + 12;
      const A = clone(f.states.assembled!.image);
      // Board lines first (one straight line, or two halves 4 px apart), then the arrow drawn
      // over them.
      const yr = aligned ? y0 + 15 : y0 + 19;
      for (const t of [0, 1]) {
        line1(A, x0, y0 + 15 + t, x + 1, y0 + 15 + t);
        line1(A, x, yr + t, x0 + 23, yr + t);
      }
      const board = clone(A);
      drawArrow(A, x, y0 + 2, y0 + 50);
      const arrow = {
        kind: "arrow",
        state: "assembled",
        polyline: [
          [x, y0 + 2],
          [x, y0 + 50],
        ],
      };
      const manifest = { ...f.manifest, annotations: [...f.manifest.annotations, arrow] };
      const r = runFigure(manifest, { "assembled.png": A }).value!;
      expect(r.report.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const idx = f.manifest.annotations.length;
      const warned = r.report.diagnostics.some(
        (d) =>
          d.severity === "warning" &&
          d.code === "asset/base-unrecovered" &&
          d.path === `/annotations/${idx}`,
      );
      if (aligned) {
        // The line is whole again under the band, and nothing is reported for it.
        expect(differing(r.outputs.base, board, x0, y0 + 13, 24, 5)).toBe(0);
        expect(warned).toBe(false);
      } else {
        expect(warned).toBe(true);
      }
    }
  });
  it("an arrow declared 2 or 4 px short of the part it touches leaves no stub in the sprites", () => {
    for (const k of [2, 4]) {
      const f = figure("main");
      const manifest = structuredClone(f.manifest);
      // Exploded arrow 0 starts under hs-1's bottom outline; declared k px down the shaft.
      const [sx, sy] = manifest.annotations[0].polyline[0] as [number, number];
      manifest.annotations[0].polyline[0] = [sx, sy + k];
      const sources = sourcesOf(f);
      const r = runFigure(manifest, sources).value!;
      expect(errorsOf(r.report), `${k} px`).toEqual([]);
      // The moved end is reported (info), never silent.
      const info = r.report.diagnostics.find(
        (d) => d.code === "asset/annotation-erased" && d.path === "/annotations/0",
      );
      expect(info?.params?.snaps).toEqual([{ end: 0, distance: k }]);
      // Both poses equal the ground truth: no shaft stub under the lifted or seated sinks.
      for (const s of ["assembled", "exploded"] as const) {
        const [ours, truth] = poses(f, r.outputs, s);
        expect(differences(ours, truth), `${k} px, ${s}`).toBe(0);
      }
      // As before this fix: the stub (the shaft from the outline to the declared start) cut
      // with hs-1 into the template sprite. The gate fails it, even 1 px of it.
      const p = r.outputs.parts[0]!;
      const [dx, dy] = [r.report.alignment!.dx, r.report.alignment!.dy];
      const ox = p.exploded[0] + dx;
      const oy = p.exploded[1] + dy;
      for (const n of [k, 1]) {
        const sp = taller(r.outputs.sprites[p.sprite]!, k);
        for (let y = sy; y < sy + n; y++)
          for (const x of [sx, sx + 1]) setPx(sp, x - ox, y - oy, BLACK);
        const sprites = r.outputs.sprites.map((q, i) => (i === p.sprite ? sp : q));
        const g = check(manifest, sources, { ...r.outputs, sprites });
        expect(errorCodes(g), `${k} px, stub ${n}`).toContain("asset/arrow-residual");
      }
    }
  });

  it("one drawing: an arrow between two thick strokes is erased whole, its head's corners too", () => {
    // Reviewer's case: a vertical arrow, tail on a 5 px stroke, tip on another; walks along the
    // arrow from its head's corners used to reach both strokes and "rebuild" the corners.
    const f = figure("assembled-only", { pad: 90 });
    const A = clone(f.states.assembled!.image);
    const board = clone(f.states.assembled!.board);
    for (const r of [A, board]) {
      fill(r, 2, 8, 30, 5);
      fill(r, 2, 39, 30, 5);
    }
    drawArrow(A, 14, 13, 38);
    const arrow = {
      kind: "arrow",
      state: "assembled",
      polyline: [
        [14, 13],
        [14, 38],
      ],
    };
    const manifest = { ...f.manifest, annotations: [...f.manifest.annotations, arrow] };
    const sources = { "assembled.png": A };
    const r = runFigure(manifest, sources).value!;
    expect(errorsOf(r.report)).toEqual([]);
    expect(differing(r.outputs.base, board, 0, 0, 40, 50)).toBe(0);
    // The corners left dark (as before this fix) fail arrow-residual.
    const base = clone(r.outputs.base);
    for (const [x, y] of [
      [10, 30],
      [18, 30],
      [18, 31],
      [18, 32],
    ] as const)
      copyPx(base, A, x, y);
    expect(errorCodes(check(manifest, sources, { ...r.outputs, base }))).toContain(
      "asset/arrow-residual",
    );
  });

  it("one drawing: lined-up 3 px lines, and a line touching one side, are kept and not reported", () => {
    const f = figure("assembled-only");
    const [x0, y0] = quietPatch(f, 24, 60);
    const x = x0 + 12;
    const A = clone(f.states.assembled!.image);
    // A 3 px line across the arrow, and a 2 px line from the right that ends at the shaft.
    for (let t = 0; t < 3; t++) line1(A, x0, y0 + 15 + t, x0 + 23, y0 + 15 + t);
    for (let t = 0; t < 2; t++) line1(A, x + 2, y0 + 30 + t, x0 + 23, y0 + 30 + t);
    const board = clone(A);
    drawArrow(A, x, y0 + 2, y0 + 50);
    const arrow = {
      kind: "arrow",
      state: "assembled",
      polyline: [
        [x, y0 + 2],
        [x, y0 + 50],
      ],
    };
    const manifest = { ...f.manifest, annotations: [...f.manifest.annotations, arrow] };
    const r = runFigure(manifest, { "assembled.png": A }).value!;
    expect(errorsOf(r.report)).toEqual([]);
    const idx = f.manifest.annotations.length;
    expect(
      r.report.diagnostics.filter(
        (d) => d.code === "asset/base-unrecovered" && d.path === `/annotations/${idx}`,
      ),
    ).toEqual([]);
    expect(differing(r.outputs.base, board, x0, y0, 24, 60)).toBe(0);
  });

  it("one drawing: a 3 px board tick straddling an arrow's mask near its end stays whole", () => {
    const f = figure("assembled-only");
    const [x0, y0] = quietPatch(f, 24, 60);
    const x = x0 + 12;
    const A = clone(f.states.assembled!.image);
    // 2 px above the tail, 3 to 5 px to its right: across the edge of the arrow's mask.
    line1(A, x + 3, y0 + 6, x + 5, y0 + 6);
    const board = clone(A);
    drawArrow(A, x, y0 + 8, y0 + 50);
    const arrow = {
      kind: "arrow",
      state: "assembled",
      polyline: [
        [x, y0 + 8],
        [x, y0 + 50],
      ],
    };
    const manifest = { ...f.manifest, annotations: [...f.manifest.annotations, arrow] };
    const sources = { "assembled.png": A };
    const r = runFigure(manifest, sources).value!;
    expect(errorsOf(r.report)).toEqual([]);
    expect(differing(r.outputs.base, board, x0, y0, 24, 60)).toBe(0);
    // The tick erased (as before this fix, taken as the arrow's own ink) fails.
    const base = clone(r.outputs.base);
    for (let xx = x + 3; xx <= x + 5; xx++) setPx(base, xx, y0 + 6, WHITE);
    expect(errorCodes(check(manifest, sources, { ...r.outputs, base }))).toContain(
      "asset/base-unrecovered",
    );
  });
  it("two drawings: a pin the arrow starts from stays the part's, and a sprite without it fails", () => {
    for (const L of [3, 6]) {
      const { f, manifest, sources, pins } = pinned(L, 0);
      const r = runFigure(manifest, sources).value!;
      expect(errorsOf(r.report), `${L} px`).toEqual([]);
      for (const s of ["assembled", "exploded"] as const) {
        const [ours, truth] = poses(f, r.outputs, s);
        for (const [ps, x, y] of pins) if (ps === s) setPx(truth, x, y, BLACK);
        expect(differences(ours, truth), `${L} px, ${s}`).toBe(0);
      }
      // As before this fix: the pin taken as the arrow's (snapped over) and cut from the sprite.
      const p = r.outputs.parts[0]!;
      const sp = clone(r.outputs.sprites[p.sprite]!);
      const ox = p.exploded[0] + r.report.alignment!.dx;
      const oy = p.exploded[1] + r.report.alignment!.dy;
      for (const [ps, x, y] of pins.slice(0, 4 * L))
        if (ps === "exploded") setPx(sp, x - ox, y - oy, [0, 0, 0, 0]);
      const sprites = r.outputs.sprites.map((q, i) => (i === p.sprite ? sp : q));
      expect(errorCodes(check(manifest, sources, { ...r.outputs, sprites }))).toContain(
        "asset/occluded-unrecovered",
      );
    }
  });

  it("one drawing: the template carries no board trace where it touches it", () => {
    const f = figure("assembled-only");
    const r = runFigure(f.manifest, sourcesOf(f)).value!;
    expect(errorsOf(r.report)).toEqual([]);
    const [ours, truth] = poses(f, r.outputs, "assembled");
    expect(differences(ours, truth)).toBe(0);
    // As before this fix: 2 px of the trace that meets hs-1's top-left edge in its template,
    // which seated hs-2 (whose drawing is paper there) shows as a burr.
    const k = r.outputs.parts.findIndex((p) => p.id === "hs-2");
    const p = r.outputs.parts[k]!;
    const sp = clone(r.outputs.sprites[p.sprite]!);
    for (const [x, y] of [
      [230, 98],
      [228, 99],
    ] as const) {
      expect(lumAt(f.states.assembled!.image, x, y)).toBeGreaterThan(200);
      setPx(sp, x - p.seat[0], y - p.seat[1], BLACK);
    }
    const sprites = r.outputs.sprites.map((q, i) => (i === p.sprite ? sp : q));
    expect(errorCodes(check(f.manifest, sourcesOf(f), { ...r.outputs, sprites }))).toContain(
      "asset/foreign-pixels",
    );
  });

  it("one drawing: ink entirely inside an arrow's mask is erased with it and reported", () => {
    const f = figure("assembled-only");
    const [x0, y0] = quietPatch(f, 24, 60);
    const x = x0 + 12;
    const A = clone(f.states.assembled!.image);
    drawArrow(A, x, y0 + 8, y0 + 50);
    // A 2 x 2 dot beside the shaft, inside the mask, touching nothing.
    fill(A, x + 3, y0 + 24, 1, 2);
    const arrow = {
      kind: "arrow",
      state: "assembled",
      polyline: [
        [x, y0 + 8],
        [x, y0 + 50],
      ],
    };
    const manifest = { ...f.manifest, annotations: [...f.manifest.annotations, arrow] };
    const r = runFigure(manifest, { "assembled.png": A }).value!;
    expect(errorsOf(r.report)).toEqual([]);
    const idx = f.manifest.annotations.length;
    const info = r.report.diagnostics.find(
      (d) => d.code === "asset/annotation-erased" && d.path === `/annotations/${idx}`,
    );
    expect(info?.severity).toBe("info");
    expect(info?.params?.inside).toBe(2);
  });
  it("two drawings: a shaft stub kept with an end declared short of a pin fails the gate", () => {
    // The end's walk over the shaft and the pin is vetoed (the pin is the part's), so the 3 px of
    // shaft between the declared end and the pin join the part: the gate must not pass that.
    for (const L of [4, 6]) {
      const { manifest, sources } = pinned(L, 3);
      const r = runFigure(manifest, sources).value!;
      expect(errorCodes(r.report), `${L} px`).toContain("asset/arrow-residual");
    }
  });

  it("one drawing, s5: each sprite equals its truth sprite, or the gate names what differs", () => {
    // The 5 px trace remnant on the heat sinks' diagonal edge (sides of the edge disagree there:
    // undecided, kept and named), a trace from the right onto the fan's 32-gon, one from the top
    // onto the heat sink's diagonal/top-edge vertex (no dent), and the comb on its board line.
    const cases: [string, GenFigure, Raster][] = [];
    const s5 = { scale: 2, stroke: 5 };
    for (const name of ["assembled-only", "dense-assembled"]) {
      const f = figure(name, s5);
      cases.push([name, f, f.states.assembled!.image]);
    }
    cases.push(["fan R20", ...traced(figure("cage-assembled", s5), "fan-1", "R", 20)]);
    cases.push(["heat sink U62", ...traced(figure("assembled-only", s5), "hs-1", "U", 62)]);
    for (const [name, f, image] of cases) {
      const r = runFigure(f.manifest, { "assembled.png": image }).value!;
      expect(errorsOf(r.report), name).toEqual([]);
      const named = r.report.diagnostics
        .filter((d) => d.code === "asset/rim-stroke")
        .flatMap((d) => (d.params?.pixels ?? []) as [number, number][]);
      const st = f.states.assembled!;
      for (const p of r.outputs.parts) {
        const tpl = r.outputs.parts.find(
          (q, k) => q.sprite === p.sprite && r.report.parts[k]!.template,
        )!;
        const t = st.truth.units[p.id]!.full;
        const sp = r.outputs.sprites[p.sprite]!;
        const truth = f.sprites[p.id]!.raster;
        // Every pixel where the sprite and the truth sprite differ, placed at the template's
        // seat (where the analysis decided it), is named within 1 px.
        const unexplained: [number, number][] = [];
        const x0 = Math.min(p.seat[0], t.x);
        const y0 = Math.min(p.seat[1], t.y);
        const x1 = Math.max(p.seat[0] + sp.width, t.x + truth.width);
        const y1 = Math.max(p.seat[1] + sp.height, t.y + truth.height);
        const lumIn = (r2: Raster, x: number, y: number): number =>
          x < 0 || y < 0 || x >= r2.width || y >= r2.height || !r2.data[(y * r2.width + x) * 4 + 3]
            ? 255
            : lumAt(r2, x, y);
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const a = lumIn(sp, x - p.seat[0], y - p.seat[1]);
            const b = lumIn(truth, x - t.x, y - t.y);
            if (Math.abs(a - b) <= 48) continue;
            const qx = x - p.seat[0] + tpl.seat[0];
            const qy = y - p.seat[1] + tpl.seat[1];
            if (!named.some(([nx, ny]) => Math.abs(nx - qx) <= 1 && Math.abs(ny - qy) <= 1))
              unexplained.push([x, y]);
          }
        expect(unexplained, `${name} ${p.id}`).toEqual([]);
      }
    }
  });

  it("one drawing: a stroke left on an undecidable rim pixel is named in a warning", () => {
    const f = figure("assembled-only", { scale: 2, stroke: 5 });
    const r = runFigure(f.manifest, sourcesOf(f)).value!;
    const warned = r.report.diagnostics.filter(
      (d) => d.code === "asset/rim-stroke" && d.severity === "warning",
    );
    expect(warned.flatMap((d) => d.params?.pixels as [number, number][])).toContainEqual([
      155, 176,
    ]);
  });
});
