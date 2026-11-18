/**
 * SVG node model (frozen). Stages hand each other SVG as this small tree, and
 * only Track A's emitter serializes it, so escaping, attribute order and
 * number formatting live in one place (PLAN §17.3 determinism).
 */

/** An SVG element. Attributes are serialized in insertion order. */
export interface SvgElement {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, string | number>>;
  readonly children?: readonly SvgNode[];
}

/**
 * Pre-sanitized markup inserted verbatim (icon bodies from the sanitizer,
 * embedded font CSS). Only trusted producers may create it: the icon
 * sanitizer and the emitter's own font/CSS code.
 */
export interface SvgRaw {
  readonly raw: string;
}

/** A text node (escaped on emit), an element, or trusted raw markup. */
export type SvgNode = SvgElement | SvgRaw | string;
