import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { flag, parse, str } from "../args.js";
import { type Ctx, EXIT, Failure, UsageError } from "../deps.js";
import { examples } from "../examples.gen.js";

export const HELP = `Usage: pcosmo examples [list | show <name> | copy <name|all> [--out <dir>]]

  list                 List the gallery specs (default)
  show <name>          Print a spec to stdout
  copy <name|all>      Copy spec(s) into a directory (default: current directory)

Options:
  -o, --out <dir>      Target directory for copy
  --force              Overwrite existing files
  -h, --help           Show this help
`;

export async function examplesCommand(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { out: { type: "string", short: "o" }, force: { type: "boolean" } });
  const [sub = "list", name] = p.positionals;
  if (sub === "list") {
    for (const e of examples) ctx.out(`${e.name.padEnd(26)} ${e.title}\n`);
    return EXIT.ok;
  }
  if (sub !== "show" && sub !== "copy") throw new UsageError(`unknown subcommand "${sub}"`);
  if (!name) throw new UsageError(`${sub} needs an example name`);
  const picked =
    name === "all" && sub === "copy" ? examples : examples.filter((e) => e.name === name);
  if (picked.length === 0) {
    throw new Failure(
      `unknown example "${name}". Available: ${examples.map((e) => e.name).join(", ")}`,
    );
  }
  if (sub === "show") {
    ctx.out(picked[0]!.json);
    return EXIT.ok;
  }
  const dir = resolve(ctx.deps.cwd, str(p, "out") ?? ".");
  await mkdir(dir, { recursive: true });
  for (const e of picked) {
    const file = join(dir, `${e.name}.cosmo.json`);
    try {
      await writeFile(file, e.json, { flag: flag(p, "force") ? "w" : "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Failure(`${file} already exists (use --force to overwrite)`);
      }
      throw err;
    }
    ctx.out(`wrote ${file}\n`);
  }
  return EXIT.ok;
}
