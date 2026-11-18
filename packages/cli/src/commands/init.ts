import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { flag, parse, str } from "../args.js";
import { type Ctx, EXIT, Failure, UsageError } from "../deps.js";
import { templates } from "../examples.gen.js";

export const HELP = `Usage: pcosmo init [file] [options]

Writes a starter spec (default file: diagram.cosmo.json).

Options:
  --template <name>  Start from a template (default: starter). See --list.
  --list             List templates
  --force            Overwrite an existing file
  -h, --help         Show this help
`;

export async function initCommand(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    template: { type: "string" },
    list: { type: "boolean" },
    force: { type: "boolean" },
  });
  if (flag(p, "list")) {
    for (const t of templates) ctx.out(`${t.name.padEnd(28)} ${t.title}\n`);
    return EXIT.ok;
  }
  if (p.positionals.length > 1) throw new UsageError("init takes at most one file name");
  const name = str(p, "template") ?? "starter";
  const tpl = templates.find((t) => t.name === name);
  if (!tpl) {
    throw new Failure(
      `unknown template "${name}". Available: ${templates.map((t) => t.name).join(", ")}`,
    );
  }
  const file = p.positionals[0] ?? "diagram.cosmo.json";
  if (!/\.cosmo\.json$/.test(file)) throw new UsageError("the file name must end in .cosmo.json");
  const full = resolve(ctx.deps.cwd, file);
  await mkdir(dirname(full), { recursive: true });
  try {
    await writeFile(full, tpl.json, { flag: flag(p, "force") ? "w" : "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Failure(`${file} already exists (use --force to overwrite)`);
    }
    throw e;
  }
  ctx.out(
    `wrote ${file} (template: ${tpl.name})\nNext: pcosmo validate ${file} && pcosmo build ${file}\n`,
  );
  return EXIT.ok;
}
