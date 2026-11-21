import { dirname, resolve } from "node:path";
import type { Diagnostic } from "@platformcosmo/core";
import { flag, parse } from "../args.js";
import { addCloseupChecks, loadSpec, makeResolver } from "../common.js";
import { loadSpecImages } from "../images.js";
import { type Ctx, type Deps, EXIT, UsageError } from "../deps.js";
import { formatDiagnostics, hasErrors, plural } from "../format.js";
import {
  formatSuggestions,
  suggest,
  type PlacedBox,
  type PlacedBoxes,
  type SuggestReport,
} from "../suggest.js";

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

/** Effective boxes of every node of the resolved assembly trees (undefined when core lacks them). */
function placedBoxes(spec: unknown, deps: Deps): PlacedBoxes | undefined {
  if (!deps.core.buildAssemblies) return undefined;
  const out = new Map<string, PlacedBox>();
  try {
    const built = deps.core.buildAssemblies(spec as never, {
      ...(deps.parts ? { parts: deps.parts } : {}),
      ...(deps.dcPack?.shapes ? { dcShapes: deps.dcPack.shapes } : {}),
    });
    const walk = (n: (typeof built.assemblies)[number]["root"]): void => {
      const { origin: o, size: z } = n.local;
      out.set(n.path, {
        min: [o.x, o.y, o.z],
        max: [o.x + z.x, o.y + z.y, o.z + z.z],
      });
      for (const c of n.children) walk(c);
    };
    for (const a of built.assemblies) walk(a.root);
  } catch {
    return undefined; // the stated placement is used instead
  }
  return out;
}

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
    const imgs = await loadSpecImages(spec, dirname(resolve(ctx.deps.cwd, file)));
    all.push(...imgs.diagnostics);
    const report = ctx.deps.core.validate(spec, {
      icons: resolver,
      ...(imgs.resolver ? { images: imgs.resolver } : {}),
      ...(ctx.deps.dcPack ? { dc: ctx.deps.dcPack } : {}),
      ...(ctx.deps.parts ? { parts: ctx.deps.parts } : {}),
      ...(ctx.deps.placement ? { placement: ctx.deps.placement } : {}),
    });
    all.push(...report.diagnostics);
    addCloseupChecks(ctx, spec, all, { closeups: true }); // assemblies 8.5: needs the scene's geometry
  }
  let suggestions: SuggestReport | undefined;
  const SKIPPED = "suggestions skipped: fix errors first";
  const wantSuggest = flag(p, "suggest");
  const suggestSkipped = wantSuggest && (spec === undefined || hasErrors(all));
  if (wantSuggest && !suggestSkipped)
    suggestions = suggest(spec, ctx.deps.parts, placedBoxes(spec, ctx.deps));
  const errors = all.filter((d) => d.severity === "error").length;
  const warnings = all.filter((d) => d.severity === "warning").length;
  const failed = errors > 0 || (flag(p, "strict") && warnings > 0);
  if (flag(p, "json")) {
    ctx.out(
      `${JSON.stringify({ file, valid: !failed, diagnostics: all, ...(wantSuggest ? { suggestions: suggestions ?? null } : {}), ...(suggestSkipped ? { suggestionsSkipped: SKIPPED } : {}) }, null, 2)}\n`,
    );
  } else {
    if (all.length > 0) ctx.err(formatDiagnostics(all, file));
    ctx.out(
      failed
        ? `${file}: invalid (${plural(errors, "error")}, ${plural(warnings, "warning")})\n`
        : `${file}: valid${warnings ? ` (${plural(warnings, "warning")})` : ""}\n`,
    );
    if (suggestions) ctx.out(formatSuggestions(file, suggestions));
    if (suggestSkipped) ctx.out(`${file}: ${SKIPPED}\n`);
  }
  return failed ? EXIT.failed : EXIT.ok;
}
