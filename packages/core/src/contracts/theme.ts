/**
 * Theme token contract (frozen). Themes are data (Track E, `packages/themes`,
 * which exports `themeRegistry: ThemeRegistry` and `validateTheme: ValidateThemeFn`);
 * the emitter (Track A) turns tokens into CSS custom properties.
 *
 * CSS variable naming rule, shared by emit (A) and animation (B):
 * `--pc-` + the token path joined with `-`, e.g.
 * `categories.compute.top` → `--pc-categories-compute-top`,
 * `states.down.overlay` → `--pc-states-down-overlay`, `palette.red` → `--pc-palette-red`.
 * Numbers are emitted unitless. Variables are scoped to the diagram root
 * (`#<ids.root()>`), never `:root`/`svg`, so inlined diagrams don't leak. The light
 * theme's values are the defaults; the dark theme's override them inside
 * `@media (prefers-color-scheme: dark)` (PLAN §7).
 *
 * Trust: custom theme files are untrusted. `validateTheme` must accept only
 * colors matching `^#[0-9a-fA-F]{3,8}$` or `^rgba?\([0-9., %]+\)$`, a font family
 * matching `^[A-Za-z0-9 ,'"-]+$` with balanced quotes, `edge.dash` values matching
 * `^([0-9.]+([ ,][0-9.]+)*)?$`, `id` matching `^[a-z][a-z0-9-]{0,63}$`, `name` as SpecText
 * (never written into CSS), and finite numbers. The rule covers every string token;
 * the emitter re-checks every value it writes into CSS or attributes.
 */
import type { Diagnostic } from "./diagnostics.js";
import type {
  EdgeStyle,
  FlowKind,
  GroupStyle,
  NodeCategory,
  ObjectState,
  PartTone,
} from "./scene.js";

/** Built-in theme ids (PLAN §10 `--theme`). A file path may name a custom theme. */
export type ThemeId = "light" | "dark" | "blueprint" | "mono";

/** CSS color string: hex (`#rgb`…`#rrggbbaa`) or `rgb()/rgba()`. Never `url()` or anything else. */
export type CssColor = string;

/** Palette names usable as spec colors (schema `SpecColor` description lists them). */
export type PaletteName =
  "blue" | "green" | "red" | "orange" | "yellow" | "purple" | "teal" | "pink" | "gray";

/** Four-tone shading for a solid: top / left / right faces + outline. */
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
  readonly palette: Readonly<Record<PaletteName, CssColor>>;
  readonly categories: Readonly<Record<NodeCategory, FaceTones>>;
  /** Tones for composite parts (DC devices, frames, floor). */
  readonly parts: Readonly<Record<PartTone, FaceTones>>;
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
  /** State visuals: overlay fill drawn over the object silhouette, outline stroke, overall opacity. */
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
  readonly caption: { readonly fill: CssColor; readonly text: CssColor };
  readonly badge: { readonly fill: CssColor; readonly text: CssColor };
  /** Monochrome icons use `currentColor` = `color`; `plate` is the backing tile behind any icon. */
  readonly icon: { readonly color: CssColor; readonly plate: CssColor };
  /** Data-center pack tones (PLAN §9). */
  readonly dc: {
    readonly led: { readonly ok: CssColor; readonly warn: CssColor; readonly fail: CssColor };
    readonly cable: Readonly<Record<"power" | "network" | "fiber" | "management", CssColor>>;
    readonly coldAisle: CssColor;
    readonly hotAisle: CssColor;
    readonly containment: CssColor;
    readonly hall: CssColor;
  };
}

/** Lookup of themes by id; the CLI wires `@platformcosmo/themes` in. */
export interface ThemeRegistry {
  get(id: string): ThemeTokens | undefined;
  list(): readonly string[];
}

/** Validates an untrusted theme object (custom `--theme <file>`). */
export type ValidateThemeFn = (input: unknown) => {
  readonly theme?: ThemeTokens;
  readonly diagnostics: readonly Diagnostic[];
};
