import { expect } from "vitest";
import { sanitizeSvg } from "../src/icons/index.js";

/** Best of three runs, so the measure reflects algorithmic cost rather than scheduler/JIT noise. */
export function bestMs(input: string, maxBytes = 200_000): number {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t = performance.now();
    sanitizeSvg(input, { maxBytes });
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

/**
 * Asserts roughly linear scaling: doubling the input must not much more than double the time
 * (ratio < 3; skipped when the base time is too small to measure), plus a generous absolute
 * ceiling that no linear implementation approaches.
 */
export function expectLinear(label: string, gen: (n: number) => string, n: number): void {
  const small = gen(n);
  const big = gen(2 * n);
  bestMs(small); // warm up
  const t1 = bestMs(small);
  const t2 = bestMs(big);
  expect(t2, `${label}: absolute ceiling`).toBeLessThan(2000);
  if (t1 >= 8) expect(t2 / t1, `${label}: t(2n)/t(n)`).toBeLessThan(3);
}
