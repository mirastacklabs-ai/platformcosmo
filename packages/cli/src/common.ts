import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { Diagnostic, IconResolver, ThemeTokens } from "@platformcosmo/core";
import { type Ctx, Failure } from "./deps.js";
import { errorDiagnostic } from "./format.js";
import { loadUserPacks, packsDirFor } from "./packs.js";

export const MAX_SPEC_BYTES = 5 * 1024 * 1024;
export const BUILTIN_THEMES = ["light", "dark", "blueprint", "mono"] as const;

export function specFormat(path: string): "json" | "yaml" {
  const e = extname(path).toLowerCase();
  return e === ".yaml" || e === ".yml" ? "yaml" : "json";
}

/** `foo.cosmo.json` / `foo.cosmo.yaml` / `foo.json` → `foo`. */
export function specBaseName(path: string): string {
  return basename(path).replace(/(\.cosmo)?\.(json|ya?ml)$/i, "");
}

export async function readText(path: string, maxBytes: number): Promise<string> {
  let st;
  try {
    st = await stat(path);
  } catch {
    throw new Failure(`cannot read ${path}: no such file`);
  }
  if (!st.isFile()) throw new Failure(`${path} is not a file`);
  if (st.size > maxBytes) throw new Failure(`${path} is larger than ${maxBytes} bytes`);
  return readFile(path, "utf8");
}

export async function loadSpec(
  ctx: Ctx,
  file: string,
): Promise<{ spec?: unknown; diagnostics: readonly Diagnostic[] }> {
  const text = await readText(resolve(ctx.deps.cwd, file), MAX_SPEC_BYTES);
  return ctx.deps.core.parseSpec(text, specFormat(file));
}

/** Bundled packs first (they cannot be shadowed), then verified user packs. */
export async function makeResolver(
  ctx: Ctx,
): Promise<{ resolver: IconResolver; diagnostics: Diagnostic[] }> {
  const { packs, diagnostics } = await loadUserPacks(packsDirFor(ctx.deps, ctx.packsDir));
  const resolver = ctx.deps.core.createIconResolver(
    [...ctx.deps.bundledPacks, ...packs],
    ctx.deps.core.sanitizeSvg,
  );
  return { resolver, diagnostics };
}

/**
 * `--theme light|dark|blueprint|mono|<file>`. Built-in names resolve through the registry
 * (core also looks them up from `canvas.theme` when no theme is given); anything else is a
 * theme file that must pass `validateTheme`.
 */
export async function resolveTheme(
  ctx: Ctx,
  value: string,
): Promise<{ theme?: ThemeTokens; diagnostics: Diagnostic[] }> {
  const { themes, validateTheme } = ctx.deps;
  if ((BUILTIN_THEMES as readonly string[]).includes(value)) {
    const theme = themes?.get(value);
    if (!theme) {
      return {
        diagnostics: [
          errorDiagnostic("theme/unavailable", `built-in theme "${value}" is not available`),
        ],
      };
    }
    return { theme, diagnostics: [] };
  }
  if (!validateTheme) {
    return {
      diagnostics: [
        errorDiagnostic("theme/unavailable", "custom themes are not available in this build"),
      ],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(resolve(ctx.deps.cwd, value), 256 * 1024));
  } catch (e) {
    return {
      diagnostics: [
        errorDiagnostic(
          "theme/unreadable",
          `cannot read theme "${value}": ${(e as Error).message}`,
          `use one of ${BUILTIN_THEMES.join(", ")} or a path to a theme JSON file`,
        ),
      ],
    };
  }
  const r = validateTheme(raw);
  return r.theme
    ? { theme: r.theme, diagnostics: [...r.diagnostics] }
    : { diagnostics: [...r.diagnostics] };
}

const dkey = (d: Diagnostic): string => `${d.code}\0${d.path}\0${JSON.stringify(d.params ?? null)}`;

/**
 * Close-up size and depth checks (assemblies 8.5, 8.2: `assembly/size-mismatch`,
 * `assembly/closeup-turned`, `assembly/too-deep`, `budget/levels`) appended to `all`, each once,
 * for `validate`, which never builds the scene (`build` gets them from `render`'s scene, which
 * builds the close-ups and the racks in assembly mode itself). Anything already in `all` (same
 * code, path and params) is skipped as a safety net. Only for a spec without errors: a gated or
 * invalid spec never gets here.
 */
export function addCloseupChecks(ctx: Ctx, spec: unknown, all: Diagnostic[]): void {
  const check = ctx.deps.core.closeupDiagnostics;
  if (!check || all.some((d) => d.severity === "error")) return;
  const seen = new Set(all.map(dkey));
  const extra = check(spec as Parameters<typeof check>[0], {
    ...(ctx.deps.parts ? { parts: ctx.deps.parts } : {}),
    ...(ctx.deps.dcPack ? { dc: ctx.deps.dcPack } : {}),
  });
  for (const d of extra) {
    if (seen.has(dkey(d))) continue;
    seen.add(dkey(d));
    all.push(d);
  }
}
