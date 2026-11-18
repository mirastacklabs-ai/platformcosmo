/**
 * Number rounding and formatting shared by every stage that emits coordinates.
 * Rounding rule (PLAN §17.3 determinism): at most 2 decimals, never `-0`,
 * never exponent notation for the magnitudes the engine produces.
 */

/** Round to at most 2 decimals, halves away from zero; normalizes `-0` to `0`. Non-finite input throws. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) throw new RangeError(`non-finite coordinate: ${String(n)}`);
  const r = (Math.sign(n) * Math.round(Math.abs(n) * 100)) / 100;
  return r === 0 ? 0 : r;
}

/** Format a coordinate: `round2` then shortest decimal string ("12.5", "3", "-0.25"). */
export function fmt(n: number): string {
  return String(round2(n));
}
