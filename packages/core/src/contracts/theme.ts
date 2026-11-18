/**
 * Theme token contract (frozen). Themes are data (Track E, `packages/themes`);
 * the emitter (Track A) turns tokens into CSS custom properties.
 *
 * CSS variable naming rule, shared by emit (A) and animation (B):
 * `--pc-` + the token path joined with `-`, e.g.
 * `categories.compute.top` → `--pc-categories-compute-top`,
 * `states.down.overlay` → `--pc-states-down-overlay`.
 * Numbers are emitted unitless. The light theme's variables are the defaults on
 * the SVG root; the dark theme's override them inside
 * `@media (prefers-color-scheme: dark)` (PLAN §7).
 */
import type { EdgeStyle, FlowKind, GroupStyle, NodeCategory, ObjectState } from "./scene.js";

/** Built-in theme ids (PLAN §10 `--theme`). A file path may name a custom theme. */
export type ThemeId = "light" | "dark" | "blueprint" | "mono";

/** CSS color string: hex (`#rrggbb` / `#rgb`) or `rgba(...)`. No `url()` ever. */
export type CssColor = string;

/** Four-tone shading for a solid (PLAN anatomy: top / left / right + outline). */
export interface FaceTones {
  readonly top: CssColor;
  readonly left: CssColor;
  readonly right: CssColor;
  readonly stroke: CssColor;
}

export interface ThemeTokens {
  /** `light` | `dark` | `blueprint` | `mono` | custom id (kebab-case). */
  readonly id: string;
  readonly name: string;
  readonly colorScheme: "light" | "dark";
  readonly background: CssColor;
  readonly grid: { readonly stroke: CssColor; readonly opacity: number };
  readonly text: {
    readonly primary: CssColor;
    readonly secondary: CssColor;
    readonly inverse: CssColor;
  };
  readonly font: {
    /** CSS font-family list; the embedded font's family name comes first. */
    readonly family: string;
    readonly label: number;
    readonly badge: number;
    readonly caption: number;
    readonly title: number;
    readonly weightRegular: number;
    readonly weightBold: number;
  };
  readonly categories: Readonly<Record<NodeCategory, FaceTones>>;
  readonly groups: Readonly<
    Record<
      GroupStyle,
      {
        readonly fill: CssColor;
        readonly stroke: CssColor;
        readonly label: CssColor;
        readonly opacity: number;
      }
    >
  >;
  readonly edge: {
    readonly stroke: CssColor;
    readonly width: number;
    readonly labelFill: CssColor;
    readonly labelText: CssColor;
    /** SVG stroke-dasharray per style ("" for solid). */
    readonly dash: Readonly<Record<EdgeStyle, string>>;
  };
  /** Particle color per flow kind. */
  readonly flows: Readonly<Record<FlowKind, CssColor>>;
  /** State overlays: tint applied over faces, stroke, and overall opacity. */
  readonly states: Readonly<
    Record<
      ObjectState,
      { readonly overlay: CssColor; readonly stroke: CssColor; readonly opacity: number }
    >
  >;
  readonly metric: {
    readonly fill: CssColor;
    readonly stroke: CssColor;
    readonly label: CssColor;
    readonly value: CssColor;
  };
  readonly badge: { readonly fill: CssColor; readonly text: CssColor };
  /** Monochrome icons are filled with `color`; `plate` is the backing tile behind any icon. */
  readonly icon: { readonly color: CssColor; readonly plate: CssColor };
  /** Data-center pack tones (PLAN §9). */
  readonly dc: {
    readonly rack: FaceTones;
    readonly device: FaceTones;
    readonly equipment: FaceTones;
    readonly led: { readonly ok: CssColor; readonly warn: CssColor; readonly fail: CssColor };
    readonly cable: Readonly<Record<"power" | "network" | "fiber" | "management", CssColor>>;
    readonly coldAisle: CssColor;
    readonly hotAisle: CssColor;
    readonly floor: FaceTones;
    readonly perforatedTile: CssColor;
  };
}

/** Lookup of themes by id; the CLI wires `@platformcosmo/themes` in. */
export interface ThemeRegistry {
  get(id: string): ThemeTokens | undefined;
  list(): readonly string[];
}
