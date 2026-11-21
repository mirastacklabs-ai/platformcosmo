/**
 * Helpers shared by the `pcosmo assets` command files (assets.ts, assets-pdf.ts): argument
 * helpers, the confined reader (`readIn`), the set writer (`writeFiles`, `writeOne`) and the
 * result printer (`finish`). Moved out of assets.ts unchanged so the PDF commands reuse them.
 */
import { dirname, basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Diagnostic } from "@platformcosmo/core";
import { stableStringify } from "@platformcosmo/assets";
import { type Parsed, str } from "../args.js";
import { type Ctx, EXIT, UsageError } from "../deps.js";
import { formatDiagnostics, hasErrors } from "../format.js";
import { insideAssetsRoot, readExplicitFile, type SafeRead } from "../images.js";
import { relFromCwd, writeSet } from "../outputs.js";

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const bad = (option: string, message: string): Diagnostic => ({
  severity: "error",
  code: "asset/bad-option",
  path: "",
  message,
  params: { option },
});

export function strs(p: Parsed, name: string): string[] {
  const v = p.values[name];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

export function oneInput(p: Parsed, cmd: string, n: number, what: string): string[] {
  if (p.positionals.length !== n) throw new UsageError(`${cmd} needs ${what}`);
  return p.positionals;
}

export function needed(p: Parsed, name: string, cmd: string): string {
  const v = str(p, name);
  if (v === undefined || v === "") throw new UsageError(`${cmd} needs --${name}`);
  return v;
}

export function readDiag(r: Extract<SafeRead, { ok: false }>, what: string): Diagnostic {
  return {
    severity: "error",
    code: r.code,
    path: "",
    message: `${what}: ${r.message}`,
    ...(r.suggestion === undefined ? {} : { suggestion: r.suggestion }),
  };
}

/** The path as the user should see it: relative to the working directory when inside it. */
export const shown = (ctx: Ctx, path: string): string =>
  relFromCwd(resolve(ctx.deps.cwd), resolve(ctx.deps.cwd, path)).slice(0, 160);

export const assetsRoot = (ctx: Ctx): string => ctx.assetsRoot ?? resolve(ctx.deps.cwd);
export const outsideRoot = (ctx: Ctx): string =>
  `it is outside the allowed directory ${relFromCwd(resolve(ctx.deps.cwd), assetsRoot(ctx))}`;
export const ROOT_HINT = "pass --root <dir> to allow another directory";

/** An explicit input: confined by PCOSMO_ASSETS_ROOT when set, then read through the path guard. */
export async function readIn(ctx: Ctx, path: string, maxBytes: number): Promise<SafeRead> {
  const abs = resolve(ctx.deps.cwd, path);
  if (!(await insideAssetsRoot(assetsRoot(ctx), dirname(abs)))) {
    return {
      ok: false,
      code: "image/unsafe-path",
      message: outsideRoot(ctx),
      suggestion: ROOT_HINT,
    };
  }
  return readExplicitFile(ctx.deps.cwd, path, maxBytes);
}

export interface Written {
  readonly name: string;
  readonly bytes: number;
}

/**
 * Writes `files` into the directory `dirTarget` (relative to the working directory, or absolute
 * but inside it) as one set: temp directory first, then rename into place (outputs.ts). Refusals
 * are `asset/unsafe-path` diagnostics and leave every final name untouched.
 */
export async function writeFiles(
  ctx: Ctx,
  dirTarget: string,
  files: readonly { name: string; data: Uint8Array }[],
  diags: Diagnostic[],
): Promise<Written[]> {
  const cwd = resolve(ctx.deps.cwd);
  const root = assetsRoot(ctx);
  const abs = resolve(cwd, dirTarget);
  const rel = relative(root, abs);
  const label = relFromCwd(cwd, abs);
  const refuse = (why: string): Written[] => {
    diags.push({
      severity: "error",
      code: "asset/unsafe-path",
      path: "",
      message: `refusing to write to ${label.slice(0, 160)}: ${why}`,
      suggestion: `write below ${relFromCwd(cwd, root)} without symbolic links, or ${ROOT_HINT}`,
    });
    return [];
  };
  if (dirTarget.includes("\0")) return refuse("the path is not valid");
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return refuse(outsideRoot(ctx));
  }
  if (!(await insideAssetsRoot(root, abs))) {
    return refuse(outsideRoot(ctx));
  }
  const r = await writeSet(root, rel.split(sep).join("/"), files, {}, label);
  if (!r.ok) return refuse(r.message);
  return r.written.map((w) => ({
    name: relFromCwd(cwd, join(abs, w.name)),
    bytes: w.bytes,
  }));
}

/** One file at a typed `-o` path. */
export function writeOne(
  ctx: Ctx,
  target: string,
  data: Uint8Array,
  diags: Diagnostic[],
): Promise<Written[]> {
  const abs = resolve(ctx.deps.cwd, target);
  return writeFiles(ctx, dirname(abs), [{ name: basename(abs), data }], diags);
}

export const pngExt = (p: string): boolean => /\.png$/i.test(p);

export function finish(
  ctx: Ctx,
  json: boolean,
  command: string,
  diags: readonly Diagnostic[],
  payload: Obj,
  written: readonly Written[],
  summary: string[],
  okOverride?: boolean,
): number {
  const failed = hasErrors(diags) || okOverride === false;
  if (json) {
    ctx.out(
      stableStringify({ command, ok: !failed, diagnostics: diags, files: written, ...payload }),
    );
  } else {
    if (diags.length > 0) ctx.err(formatDiagnostics(diags));
    for (const w of written) ctx.out(`wrote ${w.name} (${w.bytes} bytes)\n`);
    for (const l of summary) ctx.out(`${l}\n`);
  }
  return failed ? EXIT.failed : EXIT.ok;
}
