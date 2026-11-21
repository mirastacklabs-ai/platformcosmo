import { round2 } from "@platformcosmo/core";

/**
 * Documented placements of the default `auto:` engine shapes (assemblies §5.2). Every number is
 * in millimetres in the BLOCK's frame: the block's min corner is the origin, x runs along the
 * crankshaft, +y is the intake side, z is up. `engineLayout` returns the `at` (and, where it is
 * not the shape's default, the `size`) of each part so that, at default sizes, no two parts
 * interpenetrate at rest except the declared contacts (rod big end around its crank pin, rod
 * small end inside its piston, every internal part inside the block).
 */

/** Default block (`auto:block-i4`): length, depth, height; core depth runs y 12..218. */
export const BLOCK = { length: 420, depth: 230, height: 260, coreY0: 12, coreY1: 218 } as const;
/** Bores sit on the block's centre line, flush with the deck (the block's top face). */
export const BORE_Y = BLOCK.depth / 2;
export const DECK_Z = BLOCK.height;

/** Crank min-corner height: its 120 mm flange tops out at 133, under the lowest piston (down throws, z 133). */
export const CRANK_Z = 13;
/** Crankshaft (`auto:crankshaft`, default size 500 x 120 x 120): axis at (y, z) = (60, 60) in its own frame. */
export const CRANK = { length: 500, nose: 40, axis: 60, throw: 30, journal: 50 } as const;
/** Rod (`auto:rod`, default 24 x 50 x 156): big-end and small-end centres, on the rod's z axis. */
export const ROD = { width: 24, depth: 50, length: 156, bigEnd: 25, smallEnd: 142 } as const;
/** Piston (`auto:piston`, default 82 x 82 x 66): the gudgeon (small-end) centre height. */
export const PISTON = { bore: 82, height: 66, gudgeon: 27 } as const;
/** Distance from crank-pin centre to piston gudgeon centre: `ROD.smallEnd - ROD.bigEnd`. */
export const ROD_CENTRES = ROD.smallEnd - ROD.bigEnd;

/** Flat-plane throw order, as drawn by `auto:crankshaft`: down, up, up, down, ... */
export const throwUp = (i: number): boolean => ((i + 1) >> 1) % 2 === 1;

type V3 = [number, number, number];

export interface EngineLayout {
  cylinders: number;
  /** Distance between bore centres: block length / cylinders. */
  borePitch: number;
  /** Largest piston / bore diameter that fits the pitch (the block clamps `bore` to 80% of it). */
  bore: number;
  /** Bore centre x of cylinder `i` (0-based), on the block centre line `y = 115`. */
  boreX: number[];
  /** Crank axis height above the block's bottom (z), and its y. */
  crankAxis: { y: number; z: number };
  /** Crank pin centre height of cylinder `i`: axis +/- 30. */
  pinZ: number[];
  /** Rod centre distance (big-end to small-end centre). */
  rodLength: number;
  at: {
    block: V3;
    crankshaft: V3;
    "oil-pan": V3;
    "head-gasket": V3;
    head: V3;
    "valve-cover": V3;
    intake: V3;
    exhaust: V3;
    "cam-intake": V3;
    "cam-exhaust": V3;
    rod: V3[];
    piston: V3[];
  };
  /** Sizes to pass: the gasket always; pistons from 5 cylinders, rods from 6 (always passing all is safe). */
  size: { "head-gasket": V3; piston: V3; rod: V3 };
}

/** Placements of the engine parts for `cylinders` (an integer 2..8; else RangeError), relative to the block. */
export function engineLayout(cylinders = 4): EngineLayout {
  if (!Number.isInteger(cylinders) || cylinders < 2 || cylinders > 8) {
    throw new RangeError(`engineLayout: cylinders must be an integer 2..8, got ${cylinders}`);
  }
  const n = cylinders;
  const pitch = round2(BLOCK.length / n);
  const bore = Math.min(PISTON.bore, Math.floor((0.8 * BLOCK.length) / n));
  const boreX = Array.from({ length: n }, (_, i) => round2((i + 0.5) * pitch));
  const axisZ = CRANK_Z + CRANK.axis;
  const pinZ = boreX.map((_, i) => axisZ + (throwUp(i) ? CRANK.throw : -CRANK.throw));
  const rodWidth = Math.min(ROD.width, Math.floor(0.3 * pitch));
  const headZ = DECK_Z + 4;
  return {
    cylinders: n,
    borePitch: pitch,
    bore,
    boreX,
    crankAxis: { y: BORE_Y, z: axisZ },
    pinZ,
    rodLength: ROD_CENTRES,
    at: {
      block: [0, 0, 0],
      crankshaft: [-CRANK.nose, BORE_Y - CRANK.axis, CRANK_Z],
      "oil-pan": [0, 0, -90],
      "head-gasket": [0, BLOCK.coreY0, DECK_Z],
      head: [0, 0, headZ],
      "valve-cover": [0, 15, headZ + 100],
      intake: [0, BLOCK.depth, headZ + 5],
      exhaust: [0, -90, headZ + 10],
      "cam-intake": [0, 60, headZ + 50],
      "cam-exhaust": [0, 130, headZ + 50],
      rod: pinZ.map((z, i) => [
        round2(boreX[i]! - rodWidth / 2),
        BORE_Y - ROD.bigEnd,
        z - ROD.bigEnd,
      ]),
      piston: pinZ.map((z, i) => [
        round2(boreX[i]! - bore / 2),
        round2(BORE_Y - bore / 2),
        z + ROD_CENTRES - PISTON.gudgeon,
      ]),
    },
    size: {
      "head-gasket": [BLOCK.length, BLOCK.coreY1 - BLOCK.coreY0, 4],
      piston: [bore, bore, PISTON.height],
      // The rod stays within its crank pin (0.3 pitch wide), clear of the webs.
      rod: [rodWidth, ROD.depth, ROD.length],
    },
  };
}
