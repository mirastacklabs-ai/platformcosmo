/**
 * Generic brick colours (assemblies section 5.1). Plain colour words only: no brand palettes, no
 * catalogue colour names. The spec's own `color` (palette name or hex) always wins; this palette
 * adds names for the `paint` param so a shape can be coloured without a spec `color`.
 */
export const palette = {
  white: "#f2f2ee",
  "light-gray": "#b4b8bd",
  gray: "#8a9099",
  "dark-gray": "#4b5058",
  black: "#1f2328",
  red: "#c8352f",
  orange: "#e8872a",
  yellow: "#f2c81e",
  lime: "#9bc53d",
  green: "#2f9e5b",
  teal: "#1f9aa3",
  "light-blue": "#6fb4e0",
  blue: "#2b6cc4",
  "dark-blue": "#1d3f7a",
  purple: "#7a4bb0",
  pink: "#e87aa8",
  tan: "#d6bf8c",
  brown: "#7a4e2c",
} as const satisfies Record<string, string>;

export type PaletteColour = keyof typeof palette;

/** Palette names, in definition order. */
export const paletteNames = Object.keys(palette) as PaletteColour[];
