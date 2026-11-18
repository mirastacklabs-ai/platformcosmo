/** Tiny deterministic color helpers (hex and rgb()). Used to derive face tones and by contrast tests. */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; `undefined` otherwise. */
export function parseColor(input: string): Rgba | undefined {
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(input);
  if (hex?.[1]) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = [...h].map((c) => c + c).join("");
    }
    if (h.length !== 6 && h.length !== 8) return undefined;
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([0-9., %]+)\)$/.exec(input);
  if (fn?.[1]) {
    const parts = fn[1].split(/[ ,]+/).filter((p) => p !== "");
    const nums = parts.map((p) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    if (nums.length < 3 || nums.some((x) => !Number.isFinite(x))) return undefined;
    const alpha = parts[3];
    const a =
      alpha === undefined ? 1 : alpha.endsWith("%") ? parseFloat(alpha) / 100 : parseFloat(alpha);
    return { r: nums[0]!, g: nums[1]!, b: nums[2]!, a: Number.isFinite(a) ? a : 1 };
  }
  return undefined;
}

const h2 = (n: number): string =>
  Math.round(clamp(n, 0, 255))
    .toString(16)
    .padStart(2, "0");

export function toHex(c: Rgba): string {
  return `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
}

/** Linear mix of two colors: t=0 gives `a`, t=1 gives `b`. Returns `#rrggbb`. */
export function mix(a: string, b: string, t: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) throw new Error(`mix: bad color ${a} / ${b}`);
  return toHex({
    r: x.r + (y.r - x.r) * t,
    g: x.g + (y.g - x.g) * t,
    b: x.b + (y.b - x.b) * t,
    a: 1,
  });
}

/** Composites `fg` (with its alpha, times `opacity`) over an opaque `bg`. */
export function over(fg: string, bg: string, opacity = 1): Rgba {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) throw new Error(`over: bad color ${fg} / ${bg}`);
  const a = f.a * opacity;
  return {
    r: f.r * a + b.r * (1 - a),
    g: f.g * a + b.g * (1 - a),
    b: f.b * a + b.b * (1 - a),
    a: 1,
  };
}

function lin(v: number): number {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgba): number {
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio of two opaque colors. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Contrast of `fg` text over `fill` (which may be translucent over `bg`). */
export function contrastOn(fg: string, fill: string, bg: string): number {
  const base = over(fill, bg);
  return contrastRatio(over(fg, toHex(base)), base);
}
