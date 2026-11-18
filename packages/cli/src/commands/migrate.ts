import { parse } from "../args.js";
import { readText, MAX_SPEC_BYTES } from "../common.js";
import { type Ctx, EXIT, UsageError } from "../deps.js";
import { resolve } from "node:path";

export const HELP = `Usage: pcosmo migrate <spec>

Migrates a spec to the current spec major version. Only major 1 exists, so this is a
no-op that confirms the spec's version. A future major adds real migrations here.

Options:
  -h, --help   Show this help
`;

export const CURRENT_MAJOR = "1";

export async function migrateCommand(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {});
  if (p.positionals.length !== 1) throw new UsageError("migrate needs exactly one spec file");
  const file = p.positionals[0]!;
  const text = await readText(resolve(ctx.deps.cwd, file), MAX_SPEC_BYTES);
  const major = /["']?version["']?\s*:\s*["']?(\d+)["']?/.exec(text)?.[1];
  if (major === CURRENT_MAJOR) {
    ctx.out(`${file}: already at spec major ${CURRENT_MAJOR}; nothing to migrate\n`);
    return EXIT.ok;
  }
  ctx.err(
    `${file}: cannot migrate spec major ${major ?? "unknown"} (supported: ${CURRENT_MAJOR})\n`,
  );
  return EXIT.failed;
}
