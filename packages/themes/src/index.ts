/** Built-in PlatformCosmo themes (light, dark, blueprint, mono), the registry and `validateTheme`. */
import type { ThemeId, ThemeRegistry, ThemeTokens } from "@platformcosmo/core";
import { builtinThemes } from "./themes.js";

export { validateTheme } from "./validate.js";

/** Names mirror the schema's canvas.theme enum. */
export const themeNames = Object.freeze([
  "light",
  "dark",
  "blueprint",
  "mono",
] as const satisfies readonly ThemeId[]);
export type ThemeName = (typeof themeNames)[number];

export const themeRegistry: ThemeRegistry = {
  get(id: string): ThemeTokens | undefined {
    return Object.hasOwn(builtinThemes, id) ? builtinThemes[id as ThemeId] : undefined;
  },
  list(): readonly string[] {
    return themeNames;
  },
};
