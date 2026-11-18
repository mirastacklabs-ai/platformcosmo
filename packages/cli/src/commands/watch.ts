import { basename, dirname, resolve } from "node:path";
import { parse } from "../args.js";
import { type Ctx, EXIT } from "../deps.js";
import { BUILD_OPTIONS, HELP as BUILD_HELP, buildOnce, settingsFrom } from "./build.js";

export const HELP = `Usage: pcosmo watch <spec> [build options]

Builds once, then rebuilds whenever the spec file changes. Stop with Ctrl+C.
Accepts every option of \`pcosmo build\`.

${BUILD_HELP.split("\n").slice(2).join("\n")}`;

export async function watchCommand(ctx: Ctx, args: string[]): Promise<number> {
  const s = settingsFrom(ctx, parse(args, BUILD_OPTIONS));
  const specPath = resolve(ctx.deps.cwd, s.file);
  const base = basename(specPath);
  ctx.out(`watching ${s.file} (Ctrl+C to stop)\n`);

  let running = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rebuild = async (): Promise<void> => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    do {
      dirty = false;
      await safeBuild(ctx, s);
    } while (dirty);
    running = false;
  };

  const watcher = ctx.deps.watch(dirname(specPath), (file) => {
    if (file !== null && file !== base) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), ctx.deps.watchDebounceMs);
  });

  await rebuild();

  await new Promise<void>((done) => {
    const sig = ctx.deps.signal;
    if (!sig || sig.aborted) return done();
    sig.addEventListener("abort", () => done(), { once: true });
  });
  if (timer) clearTimeout(timer);
  watcher.close();
  while (running) await new Promise((r) => setTimeout(r, 10));
  return EXIT.ok;
}

async function safeBuild(ctx: Ctx, s: Parameters<typeof buildOnce>[1]): Promise<number> {
  try {
    return await buildOnce(ctx, s);
  } catch (e) {
    // Keep watching after a failed build (e.g. the file was mid-save).
    ctx.err(`error: ${(e as Error).message}\n`);
    return EXIT.failed;
  }
}
