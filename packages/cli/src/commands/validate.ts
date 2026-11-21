import type { Diagnostic } from "@platformcosmo/core";
import { flag, parse } from "../args.js";
import { loadSpec, makeResolver } from "../common.js";
import { type Ctx, EXIT, UsageError } from "../deps.js";
import { formatDiagnostics, hasErrors, plural } from "../format.js";
import { formatSuggestions, suggest, type SuggestReport } from "../suggest.js";

export const HELP = `Usage: pcosmo validate <spec> [options]

Schema and semantic checks, with fix suggestions. Exit code 0 when the spec is valid.

Options:
  --json         Print diagnostics as JSON
  --strict       Treat warnings as errors
  --suggest      Propose an explode program and story for assemblies that have none
                 (assemblies section 17); text, or a "suggestions" key with --json
  --packs-dir <dir>  Icon pack directory (default: $CLAUDE_PLUGIN_DATA/icons or ~/.platformcosmo/icons)
  -h, --help     Show this help
`;

export async function validateCommand(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    json: { type: "boolean" },
    strict: { type: "boolean" },
    suggest: { type: "boolean" },
  });
  if (p.positionals.length !== 1) throw new UsageError("validate needs exactly one spec file");
  const file = p.positionals[0]!;
  const { spec, diagnostics: parseDiag } = await loadSpec(ctx, file);
  const all: Diagnostic[] = [...parseDiag];
  if (!hasErrors(parseDiag) && spec !== undefined) {
    const { resolver, diagnostics: packDiag } = await makeResolver(ctx);
    all.push(...packDiag);
    const report = ctx.deps.core.validate(spec, {
      icons: resolver,
      ...(ctx.deps.dcPack ? { dc: ctx.deps.dcPack } : {}),
      ...(ctx.deps.parts ? { parts: ctx.deps.parts } : {}),
      ...(ctx.deps.placement ? { placement: ctx.deps.placement } : {}),
    });
    all.push(...report.diagnostics);
  }
  let suggestions: SuggestReport | undefined;
  if (flag(p, "suggest") && spec !== undefined && !hasErrors(all)) {
    suggestions = suggest(spec, ctx.deps.parts);
  }
  const errors = all.filter((d) => d.severity === "error").length;
  const warnings = all.filter((d) => d.severity === "warning").length;
  const failed = errors > 0 || (flag(p, "strict") && warnings > 0);
  if (flag(p, "json")) {
    ctx.out(
      `${JSON.stringify({ file, valid: !failed, diagnostics: all, ...(suggestions ? { suggestions } : {}) }, null, 2)}\n`,
    );
  } else {
    if (all.length > 0) ctx.err(formatDiagnostics(all, file));
    ctx.out(
      failed
        ? `${file}: invalid (${plural(errors, "error")}, ${plural(warnings, "warning")})\n`
        : `${file}: valid${warnings ? ` (${plural(warnings, "warning")})` : ""}\n`,
    );
    if (suggestions) ctx.out(formatSuggestions(file, suggestions));
  }
  return failed ? EXIT.failed : EXIT.ok;
}
