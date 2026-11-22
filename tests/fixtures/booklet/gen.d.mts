/** Types for the synthetic brick rover booklet generator (gen.mjs). */
export interface BookletPicture {
  readonly w: number;
  readonly h: number;
  /** RGBA, 8 bits per channel, straight alpha. */
  readonly rgba: Uint8Array;
}
export function booklet(): Uint8Array;
export function pictures(): Record<string, BookletPicture>;
export function counts(): Record<string, number>;
export function spec(): Record<string, unknown>;
export function png(r: BookletPicture): Uint8Array;
export function pngPixels(buf: Uint8Array): BookletPicture;
/** Problems found: determinism and the committed examples/rover-booklet.cosmo.json (empty: ok). */
export function check(read?: () => string): string[];
