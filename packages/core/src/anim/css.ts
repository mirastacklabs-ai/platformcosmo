/** CSS and number helpers for the animator. Deterministic: no locale, no Date, no randomness. */
import type { SvgElement } from "../contracts/index.js";

/** Up to 4 decimals, no exponent, trimmed (timing values are passed to the emitter as strings). */
export function t4(n: number): string {
  const v = Number(n.toFixed(4));
  return String(Object.is(v, -0) ? 0 : v);
}

/** Up to 2 decimals (screen geometry). */
export function r2(n: number): number {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
}

export function pct(fraction: number): string {
  return `${t4(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

export function el(
  tag: string,
  attrs?: Readonly<Record<string, string | number>>,
  children?: readonly (SvgElement | string)[],
): SvgElement {
  return { tag, ...(attrs ? { attrs } : {}), ...(children ? { children } : {}) };
}

/** Registry of `@keyframes` blocks, deduplicated by body so identical timelines share one block. */
export class Keyframes {
  private readonly byBody = new Map<string, string>();
  private readonly order: string[] = [];

  constructor(private readonly prefix: string) {}

  /** `stops` are `[fraction, declarations]` in ascending order. Returns the keyframes name. */
  add(stops: readonly (readonly [number, string])[]): string {
    const body = stops.map(([f, decl]) => `${pct(f)}{${decl}}`).join("");
    let name = this.byBody.get(body);
    if (name === undefined) {
      name = `${this.prefix}-kf${this.byBody.size + 1}`;
      this.byBody.set(body, name);
      this.order.push(`@keyframes ${name}{${body}}`);
    }
    return name;
  }

  css(): string {
    return this.order.join("\n");
  }
}

/**
 * Collapses a per-step value list into keyframe stops at each step start, merging equal
 * neighbours. `starts[i]` is the start time of step i; `total` the loop length.
 */
export function stopsFor(
  values: readonly string[],
  starts: readonly number[],
  total: number,
): [number, string][] {
  const out: [number, string][] = [];
  values.forEach((v, i) => {
    if (out.length === 0 || out[out.length - 1]?.[1] !== v) out.push([(starts[i] ?? 0) / total, v]);
  });
  return out;
}
