import { dirname, resolve } from "node:path";
import type { Diagnostic } from "@platformcosmo/core";
import { flag, parse } from "../args.js";
import { loadSpec, makeResolver } from "../common.js";
import { loadSpecImages } from "../images.js";
import { type Ctx, EXIT, UsageError } from "../deps.js";
import { formatDiagnostics, hasErrors, plural } from "../format.js";

export const HELP = `Usage: pcosmo validate <spec> [options]

Schema and semantic checks, with fix suggestions. Exit code 0 when the spec is valid.

Options:
  --json         Print diagnostics as JSON
  --strict       Treat warnings as errors
  --packs-dir <dir>  Icon pack directory (default: $CLAUDE_PLUGIN_DATA/icons or ~/.platformcosmo/icons)
  -h, --help     Show this help
`;

export async function validateCommand(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { json: { type: "boolean" }, strict: { type: "boolean" } });
  if (p.positionals.length !== 1) throw new UsageError("validate needs exactly one spec file");
  const file = p.positionals[0]!;
  const { spec, diagnostics: parseDiag } = await loadSpec(ctx, file);
  const all: Diagnostic[] = [...parseDiag];
  if (!hasErrors(parseDiag) && spec !== undefined) {
    const { resolver, diagnostics: packDiag } = await makeResolver(ctx);
    all.push(...packDiag);
    const imgs = await loadSpecImages(spec, dirname(resolve(ctx.deps.cwd, file)));
    all.push(...imgs.diagnostics);
    const report = ctx.deps.core.validate(spec, {
      icons: resolver,
      ...(imgs.resolver ? { images: imgs.resolver } : {}),
      ...(ctx.deps.dcPack ? { dc: ctx.deps.dcPack } : {}),
    });
    all.push(...report.diagnostics);
  }
  const errors = all.filter((d) => d.severity === "error").length;
  const warnings = all.filter((d) => d.severity === "warning").length;
  const failed = errors > 0 || (flag(p, "strict") && warnings > 0);
  if (flag(p, "json")) {
    ctx.out(`${JSON.stringify({ file, valid: !failed, diagnostics: all }, null, 2)}\n`);
  } else {
    if (all.length > 0) ctx.err(formatDiagnostics(all, file));
    ctx.out(
      failed
        ? `${file}: invalid (${plural(errors, "error")}, ${plural(warnings, "warning")})\n`
        : `${file}: valid${warnings ? ` (${plural(warnings, "warning")})` : ""}\n`,
    );
  }
  return failed ? EXIT.failed : EXIT.ok;
}
