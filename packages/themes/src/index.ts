/** Placeholder until M2/M5 (theme tokens). Names mirror the schema's canvas.theme enum. */
export const themeNames = ["light", "dark", "blueprint", "mono"] as const;
export type ThemeName = (typeof themeNames)[number];
