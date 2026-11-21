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
import * as partsAuto from "@platformcosmo/parts-auto";
import * as partsBase from "@platformcosmo/parts-base";
import * as partsBrick from "@platformcosmo/parts-brick";
import * as iconsBase from "@platformcosmo/icons-base";
import * as iconsK8s from "@platformcosmo/icons-k8s";
import * as iconsLucide from "@platformcosmo/icons-lucide";
import * as iconsSimple from "@platformcosmo/icons-simple";
import * as themesModule from "@platformcosmo/themes";
import type { Deps } from "./deps.js";
import { createFfmpegEncoder, ffmpegAvailable } from "@platformcosmo/core/node";
import { createIconHttpClient } from "./http.js";
import { combineRegistries } from "./parts.js";

const named = <T>(mod: unknown, key: string): T | undefined =>
  (mod as Record<string, unknown>)[key] as T | undefined;

export function defaultDeps(): Deps {
  // Every redistributable pack ships with the CLI, in precedence order (provider packs are user-installed).
  const bundledPacks = [iconsBase, iconsLucide, iconsK8s, iconsSimple]
    .map((m) => named<LoadedIconPack>(m, "pack"))
    .filter((p): p is LoadedIconPack => p !== undefined);
  return {
    core: {
      parseSpec: core.parseSpec,
      validate: core.validate,
      render: core.render,
      createIconResolver: core.createIconResolver,
      sanitizeSvg: core.sanitizeSvg,
      fetchIconPack: core.fetchIconPack,
      buildAssemblies: core.buildAssemblies,
      gifEncoder: core.gifEncoder,
    },
    themes: named<ThemeRegistry>(themesModule, "themeRegistry"),
    validateTheme: named<ValidateThemeFn>(themesModule, "validateTheme"),
    dcPack: named<DcPack>(dcPackModule, "dcPack"),
    parts: combineRegistries([partsBase.registry, partsBrick.registry, partsAuto.registry]),
    placement: partsBrick.checkBrickPlacement,
    bundledPacks,
    http: createIconHttpClient(),
    env: process.env,
    cwd: process.cwd(),
    homedir: homedir(),
    createMp4Encoder: async () =>
      (await ffmpegAvailable()) ? createFfmpegEncoder({ padColor: "white" }) : undefined,
    watch: (dir, onChange) => {
      const w = watch(dir, (_event, name) => onChange(name));
      return { close: () => w.close() };
    },
    watchDebounceMs: 150,
  };
}
