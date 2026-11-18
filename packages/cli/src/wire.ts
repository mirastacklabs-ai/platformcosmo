/**
 * Real wiring: the engine from core plus the optional packs, which plug in through RenderOptions
 * (DECISIONS D4). Packs are read by property so the CLI keeps working while a pack package
 * does not export its entry yet.
 */
import { watch } from "node:fs";
import { homedir } from "node:os";
import * as core from "@platformcosmo/core";
import type { DcPack, LoadedIconPack, ThemeRegistry, ValidateThemeFn } from "@platformcosmo/core";
import * as dcPackModule from "@platformcosmo/dc-pack";
import * as iconsBase from "@platformcosmo/icons-base";
import * as themesModule from "@platformcosmo/themes";
import type { Deps } from "./deps.js";
import { createFfmpegEncoder } from "./ffmpeg.js";
import { createIconHttpClient } from "./http.js";

const named = <T>(mod: unknown, key: string): T | undefined =>
  (mod as Record<string, unknown>)[key] as T | undefined;

export function defaultDeps(): Deps {
  const basePack = named<LoadedIconPack>(iconsBase, "pack");
  return {
    core: {
      parseSpec: core.parseSpec,
      validate: core.validate,
      render: core.render,
      createIconResolver: core.createIconResolver,
      sanitizeSvg: core.sanitizeSvg,
      fetchIconPack: core.fetchIconPack,
      gifEncoder: core.gifEncoder,
    },
    themes: named<ThemeRegistry>(themesModule, "themeRegistry"),
    validateTheme: named<ValidateThemeFn>(themesModule, "validateTheme"),
    dcPack: named<DcPack>(dcPackModule, "dcPack"),
    bundledPacks: basePack ? [basePack] : [],
    http: createIconHttpClient(),
    env: process.env,
    cwd: process.cwd(),
    homedir: homedir(),
    createMp4Encoder: () => createFfmpegEncoder(),
    watch: (dir, onChange) => {
      const w = watch(dir, (_event, name) => onChange(name));
      return { close: () => w.close() };
    },
    watchDebounceMs: 150,
  };
}
