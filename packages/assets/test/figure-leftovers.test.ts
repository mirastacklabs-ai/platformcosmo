/**
 * No 1 px leftovers in the clean base (C-4 follow-up): an arrow's tip drawn past its declared
 * end is erased with it and any annotation ink left in the base fails arrow-residual; with one
 * drawing, a straight board line cut by an annotation's erase is rebuilt by continuity, and a cut
 * stroke that cannot be rebuilt is reported (base-unrecovered, warning).
 */
import { describe, expect, it } from "vitest";
import { figure } from "../../../tests/fixtures/figures/gen.mjs";
import { runFigure, type Raster } from "../src/index.js";
import {
  check,
  clone,
  copyPx,
  drawArrow,
  errorCodes,
  line1,
  lumAt,
  maskHas,
  sourcesOf,
} from "./figure-helpers.js";

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

describe("no 1 px leftovers in the clean base", () => {
  it("an arrow whose drawn tip runs past its declared end is erased whole, and any leftover fails", () => {
    const f = figure("main");
    const [x0, y0] = quietPatch(f, 24, 60);
    const x = x0 + 12;
    const A = clone(f.states.assembled!.image);
    // A head-down arrow; its drawn tip runs on as a 1 px needle 6 px past the declared end
    // (as a sharp or anti-aliased tip does), beyond the annotation mask.
    drawArrow(A, x, y0 + 2, y0 + 48);
    line1(A, x, y0 + 49, x, y0 + 54);
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
});
