/**
 * Icon contract (frozen). Track C implements packs (`packages/icons-*`, each
 * exporting `pack: LoadedIconPack`), the resolver, the sanitizer and remote fetch
 * (`packages/core/src/icons`, exporting `sanitizeSvg: SvgSanitizer`,
 * `createIconResolver: CreateIconResolverFn`, `fetchIconPack: FetchIconPackFn`).
 * Rendering (Track A) only sees `ResolvedIcon`s, which are already sanitized.
 *
 * Placement: emit puts each used icon once in `<defs>` as
 * `<symbol id="<ids.icon(ref)>" viewBox="…">` and places it with `<use href="#…">`.
 * Sanitized bodies use the placeholder `__PCID__` as their id prefix
 * (`id="__PCID__-0"`, `url(#__PCID__-0)`, `href="#__PCID__-0"`); emit replaces it
 * with `ids.icon(ref)`, so ids are unique per icon and per diagram.
 */
import type { SpecNodeType } from "../schema/types.gen.js";
import type { Diagnostic } from "./diagnostics.js";

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
  /** Attribution text required by the license, shown in NOTICE/docs. */
  readonly attribution?: string;
  /** Trademark notice (Simple Icons, Kubernetes, providers). */
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
  /** Path of the SVG file relative to the manifest (forward slashes, no `..`). */
  readonly file: string;
  /** Overrides the pack license for this icon (SPDX). */
  readonly license?: string;
  readonly sourceUrl?: string;
  /** Single-color icon: the sanitizer rewrites fills/strokes to `currentColor`. */
  readonly monochrome: boolean;
}

/** `icons.json`. */
export interface IconManifest {
  readonly manifestVersion: 1;
  readonly pack: IconPackInfo;
  readonly icons: readonly IconEntry[];
  /** Default glyph (`pack:id`) per semantic node type (the `cosmo` base pack sets all of them). */
  readonly defaults?: Readonly<Partial<Record<SpecNodeType, string>>>;
}

/** A pack in memory: manifest plus raw (unsanitized) SVG text keyed by `IconEntry.file`. */
export interface LoadedIconPack {
  readonly manifest: IconManifest;
  readonly files: Readonly<Record<string, string>>;
}

/** Output of the sanitizer: a safe inner body plus its viewBox. */
export interface SanitizedSvg {
  readonly viewBox: string;
  /** Inner markup only (no `<svg>` wrapper); ids use the `__PCID__` placeholder prefix. */
  readonly body: string;
  readonly monochrome: boolean;
}

export type SanitizeResult =
  | { readonly ok: true; readonly svg: SanitizedSvg; readonly removed: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Allowlist-based sanitizer: removes scripts, event handlers, `foreignObject`,
 * `<style>` with `@import`/`url(` to anything but `#`, entities/DTDs/PIs, and every
 * external, `javascript:` or `data:` reference except `data:image/(png|jpeg|webp)`
 * (never `image/svg+xml`); rewrites ids and internal refs to the `__PCID__` prefix;
 * rejects input over `maxBytes` (default 65536).
 */
export type SvgSanitizer = (
  input: string,
  options?: { readonly maxBytes?: number; readonly monochrome?: boolean },
) => SanitizeResult;

/** An icon ready to place. `svg.body` is trusted and may become `SvgRaw`. */
export interface ResolvedIcon {
  /** `pack:id` (canonical, after alias resolution). */
  readonly ref: string;
  readonly svg: SanitizedSvg;
  readonly license: string;
  readonly attribution?: string;
}

export interface IconMatch {
  readonly ref: string;
  /** 0..1, higher is better. Ties are ordered by `ref` ascending. */
  readonly score: number;
}

/** Resolves refs across installed packs. Pure and offline. */
export interface IconResolver {
  /** Resolves `pack:id` or `pack:alias`. */
  resolve(ref: string): ResolvedIcon | undefined;
  /** Default `pack:id` for a semantic node type, if any pack defines one. */
  defaultFor(type: SpecNodeType): string | undefined;
  /** Fuzzy search over ids, aliases and tags, for "did you mean" and `icons search`. */
  search(query: string, limit?: number): readonly IconMatch[];
  /** Installed pack ids, in precedence order. */
  packs(): readonly string[];
}

/** Builds a resolver; earlier packs win on duplicate pack ids. Sanitizes lazily or eagerly, deterministically. */
export type CreateIconResolverFn = (
  packs: readonly LoadedIconPack[],
  sanitize: SvgSanitizer,
) => IconResolver;

/** Lockfile for user-added packs (`platformcosmo-icons.lock.json`); no timestamps (determinism). */
export interface IconLockfile {
  readonly lockfileVersion: 1;
  readonly packs: Readonly<Record<string, IconLockEntry>>;
}

export interface IconLockEntry {
  /** What the user asked for: a URL, `aws`/`azure`/`gcp`/`cncf`, or a local path. */
  readonly source: string;
  /** Final URL actually fetched, or a path relative to the lockfile (never absolute). */
  readonly resolved: string;
  /** `sha256-<base64>` over the normalized manifest plus every icon file, sorted by path. */
  readonly integrity: string;
  readonly license: string;
  readonly redistributable: boolean;
  readonly iconCount: number;
}

/** HTTP is injected by the CLI so core stays network-free; implementations must enforce SSRF rules. */
export interface IconHttpClient {
  /** GET with redirects handled by the caller's policy; returns body bytes and final URL. */
  get(
    url: string,
    options: { readonly maxBytes: number; readonly timeoutMs: number },
  ): Promise<{ readonly url: string; readonly contentType: string; readonly body: Uint8Array }>;
}

/**
 * `pcosmo icons add <source>`: fetches (URL to a single SVG, an SVG folder listing,
 * a zip, or a provider id) and builds a pack. Requires https, public addresses only
 * (no loopback/private/link-local/metadata IPs, re-checked after redirects), size and
 * file-count caps, zip path-traversal protection, and sanitizes every SVG.
 */
export type FetchIconPackFn = (
  source: string,
  options: {
    readonly http: IconHttpClient;
    /** Pack id to assign (kebab-case); default derived from the source. */
    readonly packId?: string;
    /** Required for packs whose terms need explicit acceptance (Azure). */
    readonly acceptTerms?: boolean;
  },
) => Promise<{
  readonly pack?: LoadedIconPack;
  readonly lock?: IconLockEntry;
  /** Terms text the CLI must show the user (provider packs). */
  readonly terms?: string;
  readonly diagnostics: readonly Diagnostic[];
}>;
