/**
 * SVG node model (frozen). Stages hand each other SVG as this small tree, and
 * only Track A's emitter serializes it, so escaping, attribute order and
 * number formatting live in one place (PLAN §17.3 determinism).
 *
 * Emitter rules (defense in depth):
 * - text nodes and attribute values are XML-escaped; lone surrogates and XML-invalid
 *   control characters are stripped;
 * - tag and attribute names must match `^[A-Za-z][\w:.-]*$`;
 * - `on*` attributes, and `href`/`xlink:href` values not starting with `#`, throw;
 * - attributes are serialized in insertion order; numbers with at most 2 decimals.
 */

/** Brand that only the icon sanitizer and the emitter may attach (via a cast). */
declare const svgRawBrand: unique symbol;

/** An SVG element. */
export interface SvgElement {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, string | number>>;
  readonly children?: readonly SvgNode[];
}

/**
 * Trusted markup inserted verbatim. Only two producers may create it: the icon
 * sanitizer (icon `<symbol>` bodies) and the emitter itself (font CSS). Spec
 * strings (labels, captions) must never become `SvgRaw`.
 */
export interface SvgRaw {
  readonly raw: string;
  readonly [svgRawBrand]: true;
}

/** A text node (escaped on emit), an element, or trusted raw markup. */
export type SvgNode = SvgElement | SvgRaw | string;
