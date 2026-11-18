import pkg from "../package.json" with { type: "json" };
import { UsageError, Failure, EXIT, type Ctx, type Deps, type RunResult } from "./deps.js";
import { HELP as BUILD_HELP, buildCommand } from "./commands/build.js";
import { HELP as EXAMPLES_HELP, examplesCommand } from "./commands/examples.js";
import { HELP as ICONS_HELP, iconsCommand } from "./commands/icons.js";
import { HELP as INIT_HELP, initCommand } from "./commands/init.js";
import { HELP as MIGRATE_HELP, migrateCommand } from "./commands/migrate.js";
import { HELP as VALIDATE_HELP, validateCommand } from "./commands/validate.js";
import { HELP as WATCH_HELP, watchCommand } from "./commands/watch.js";

export type { Deps, RunResult } from "./deps.js";
import { defaultDeps } from "./wire.js";
export { defaultDeps };
export { createIconHttpClient, isBlockedAddress, HttpPolicyError } from "./http.js";

const HELP = `pcosmo ${pkg.version}

Turn a spec (*.cosmo.json) into an animated isometric SVG diagram.

Usage: pcosmo <command> [options]

Commands:
  init [file]            Write a starter spec (--template, --list)
  validate <spec>        Schema and semantic checks, with fix suggestions
  build <spec>           Render outputs (--static --steps --interactive --png --gif --mp4 ...)
  watch <spec>           Rebuild on change
  icons <sub>            add | list | search | remove icon packs
  examples [sub]         list | show | copy gallery specs
  migrate <spec>         Migrate a spec to the current spec major (no-op for major 1)

Options:
  -v, --version          Print version
  -h, --help             Show help (also: pcosmo <command> --help)

Exit codes: 0 ok, 1 spec/build errors, 2 usage error, 3 internal error.
`;

type Command = { run: (ctx: Ctx, args: string[]) => Promise<number>; help: string };
const COMMANDS: Readonly<Record<string, Command>> = {
  init: { run: initCommand, help: INIT_HELP },
  validate: { run: validateCommand, help: VALIDATE_HELP },
  build: { run: buildCommand, help: BUILD_HELP },
  watch: { run: watchCommand, help: WATCH_HELP },
  icons: { run: iconsCommand, help: ICONS_HELP },
  examples: { run: examplesCommand, help: EXAMPLES_HELP },
  migrate: { run: migrateCommand, help: MIGRATE_HELP },
};

export async function run(argv: string[], deps?: Deps): Promise<RunResult> {
  const d = deps ?? defaultDeps();
  let stdout = "";
  let stderr = "";
  const ctx: Ctx = {
    deps: d,
    out: (t) => (d.io ? d.io.out(t) : void (stdout += t)),
    err: (t) => (d.io ? d.io.err(t) : void (stderr += t)),
  };
  const done = (code: number): RunResult => ({ code, stdout, stderr });

  const [first, ...rest] = argv;
  if (first === undefined || first === "-h" || first === "--help" || first === "help") {
    ctx.out(HELP);
    return done(EXIT.ok);
  }
  if (first === "-v" || first === "--version") {
    ctx.out(`${pkg.version}\n`);
    return done(EXIT.ok);
  }
  const cmd = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
  if (!cmd) {
    ctx.err(`unknown command "${first}"\n\n${HELP}`);
    return done(EXIT.usage);
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    ctx.out(cmd.help);
    return done(EXIT.ok);
  }
  try {
    return done(await cmd.run(ctx, rest));
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.err(`error: ${e.message}\n\n${cmd.help}`);
      return done(EXIT.usage);
    }
    if (e instanceof Failure) {
      ctx.err(`error: ${e.message}\n`);
      return done(EXIT.failed);
    }
    ctx.err(`internal error: ${(e as Error).message}\n`);
    return done(EXIT.internal);
  }
}
