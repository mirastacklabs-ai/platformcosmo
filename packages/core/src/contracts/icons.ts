/**
 * Icon contract (frozen). Track C implements packs (`packages/icons-*`), the
 * resolver, the sanitizer and remote fetch (`packages/core/src/icons`).
 * Rendering (Track A) only sees `ResolvedIcon`s, which are already sanitized.
 */
import type { SpecNodeType } from "../schema/types.gen.js";

export type IconCategory =
  | "compute"
  | "network"
  | "data"
  | "client"
  | "observability"
  | "cicd"
  | "security"
  | "ai"
  | "dc"
  | "brand"
  | "general";

/** Pack-level metadata. One `icons.json` per pack (PLAN §8). */
export interface IconPackInfo {
  /** Pack id, the part before `:` in an icon ref (`cosmo`, `lucide`, `k8s`, `simple`, `aws`, …). */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** SPDX identifier of the pack's license, or `LicenseRef-…` for provider terms. */
  readonly license: string;
  readonly licenseUrl?: string;
  /** Attribution text required by the license (CC-BY), shown in NOTICE/docs. */
  readonly attribution?: string;
  /** Trademark notice (Simple Icons, providers). */
  readonly trademarkNotice?: string;
  /** Canonical upstream source URL. */
  readonly source: string;
  /** False for provider packs: fetched on the user's machine, never redistributed. */
  readonly redistributable: boolean;
}

export interface IconEntry {
  /** Unique within the pack, kebab-case. */
  readonly id: string;
  readonly aliases: readonly string[];
  readonly category: IconCategory;
  /** e.g. `aws`, `kubernetes`, `postgresql`. */
  readonly provider?: string;
  readonly tags?: readonly string[];
  /** Path of the SVG file relative to the manifest. */
  readonly file: string;
  /** Overrides the pack license for this icon (SPDX). */
  readonly license?: string;
  readonly sourceUrl?: string;
  /** True when the icon is single-color and should take the theme icon color. */
  readonly monochrome: boolean;
}

/** `icons.json`. */
export interface IconManifest {
  readonly manifestVersion: 1;
  readonly pack: IconPackInfo;
  readonly icons: readonly IconEntry[];
  /** Default glyph per semantic node type (only the base/cosmo pack sets this). */
  readonly defaults?: Readonly<Partial<Record<SpecNodeType, string>>>;
}

/** Output of the SVG sanitizer: a safe inner body plus its viewBox. */
export interface SanitizedSvg {
  readonly viewBox: string;
  /** Inner markup only (no `<svg>` wrapper), ids prefixed, no scripts/handlers/external refs. */
  readonly body: string;
  readonly monochrome: boolean;
}

export type SanitizeResult =
  | { readonly ok: true; readonly svg: SanitizedSvg; readonly removed: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Sanitizer: allowlist-based; strips scripts, event handlers, `foreignObject`,
 * external/`javascript:`/`data:` (except safe raster data) references, `<style>`
 * with `@import`/`url()`, entities/DTDs; enforces `maxBytes`; prefixes ids with `idPrefix`.
 */
export type SvgSanitizer = (
  input: string,
  options: { readonly idPrefix: string; readonly maxBytes?: number },
) => SanitizeResult;

/** An icon ready to place. `body` is safe to insert verbatim as `SvgRaw`. */
export interface ResolvedIcon {
  /** `pack:id` (canonical, after alias resolution). */
  readonly ref: string;
  readonly svg: SanitizedSvg;
  readonly license: string;
  readonly attribution?: string;
}

export interface IconMatch {
  readonly ref: string;
  /** 0..1, higher is better. */
  readonly score: number;
}

/** Resolves refs across installed packs. Pure and offline. */
export interface IconResolver {
  /** Resolves `pack:id` or `pack:alias`. */
  resolve(ref: string): ResolvedIcon | undefined;
  /** Default `pack:id` for a semantic node type. */
  defaultFor(type: SpecNodeType): string;
  /** Fuzzy search over ids, aliases and tags, for "did you mean" and `icons search`. */
  search(query: string, limit?: number): readonly IconMatch[];
  /** Installed pack ids. */
  packs(): readonly string[];
}

/** Lockfile for user-added packs (`platformcosmo-icons.lock.json`); no timestamps (determinism). */
export interface IconLockfile {
  readonly lockfileVersion: 1;
  readonly packs: Readonly<Record<string, IconLockEntry>>;
}

export interface IconLockEntry {
  /** What the user asked for: a URL, `aws`/`azure`/`gcp`, or a local path. */
  readonly source: string;
  /** Final URL or absolute path actually read. */
  readonly resolved: string;
  /** `sha256-<base64>` over the normalized manifest plus every icon file, sorted by path. */
  readonly integrity: string;
  readonly license: string;
  readonly redistributable: boolean;
  readonly iconCount: number;
}
