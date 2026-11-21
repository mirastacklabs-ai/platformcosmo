/**
 * Output side of `pcosmo assets`: write a set of files into one directory below a root without
 * ever following or overwriting-in-place anything that is already there.
 *
 *   1. Walk the directory below the (realpath-ed) root one component at a time: `lstat`, create
 *      what is missing, refuse symlinks and non-directories.
 *   2. Create a fresh private temp directory inside it (random name, never derived from input).
 *   3. Create each file in the temp directory with `O_CREAT|O_EXCL|O_NOFOLLOW`, `fstat` the
 *      descriptor (regular file, `nlink == 1`), write it, close it.
 *   4. Check every final name (not a directory), compare `realpath(dir)` with the expected
 *      directory, then `rename` each file over its final name. A rename replaces the directory
 *      entry itself, so a hard link, a symlink or a FIFO at the name is replaced and what it
 *      pointed to is never touched or blocked on.
 *   5. Compare `realpath(dir)` once more, remove the temp directory (the only thing deleted is
 *      what this call created).
 *
 * A refusal in steps 1-4 leaves none of the final names changed (the set is written to the temp
 * directory first). Residual race: Node has no `openat`/`renameat`, so the final renames resolve
 * the directory path again; an attacker who may swap the directory between the second `realpath`
 * and the renames can redirect them. Within a private directory that cannot happen.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, sep } from "node:path";

export interface OutputFile {
  /** A plain file name (no separators). */
  readonly name: string;
  readonly data: Uint8Array;
}

export interface WriteHooks {
  /** Runs after the temp files exist and before the final checks and renames. */
  readonly beforeRename?: () => void | Promise<void>;
}

export type WriteSetResult =
  | { readonly ok: true; readonly written: readonly { name: string; bytes: number }[] }
  | { readonly ok: false; readonly message: string };

const refuse = (message: string): WriteSetResult => ({ ok: false, message });
const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;
// eslint-disable-next-line no-control-regex
const PLAIN = /^[^/\\\u0000-\u001f]{1,255}$/;

/**
 * Writes `files` into `<rootDir>/<dirRel>` (`dirRel` uses `/`, may be empty, no `..`). Never
 * throws. `shown` names the directory in messages (relative to the cwd).
 */
export async function writeSet(
  rootDir: string,
  dirRel: string,
  files: readonly OutputFile[],
  hooks: WriteHooks = {},
  shown = dirRel,
): Promise<WriteSetResult> {
  try {
    return await writeSetUnsafe(rootDir, dirRel, files, hooks, shown || ".");
  } catch (e) {
    return refuse(`could not write to ${shown || "."}: ${errno(e) ?? "I/O error"}`);
  }
}

async function writeSetUnsafe(
  rootDir: string,
  dirRel: string,
  files: readonly OutputFile[],
  hooks: WriteHooks,
  shown: string,
): Promise<WriteSetResult> {
  const names = new Set<string>();
  for (const f of files) {
    if (!PLAIN.test(f.name) || f.name === "." || f.name === ".." || names.has(f.name)) {
      return refuse(`"${f.name.slice(0, 40)}" is not a plain output file name`);
    }
    names.add(f.name);
  }
  const parts = dirRel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || p.includes("\0"))) return refuse(`${shown} is not allowed`);

  const rootReal = await realpath(rootDir);
  let dir = rootReal;
  for (const part of parts) {
    dir = join(dir, part);
    let st;
    try {
      st = await lstat(dir);
    } catch (e) {
      if (errno(e) !== "ENOENT") throw e;
      await mkdir(dir);
      continue;
    }
    if (st.isSymbolicLink()) return refuse(`${shown} goes through a symbolic link`);
    if (!st.isDirectory()) return refuse(`${shown} is not a directory`);
  }
  if ((await realpath(dir)) !== dir) return refuse(`${shown} goes through a symbolic link`);

  // Final names must not be directories (a rename over a directory would fail half way).
  for (const f of files) {
    try {
      if ((await lstat(join(dir, f.name))).isDirectory()) {
        return refuse(`${shown}/${f.name} is a directory`);
      }
    } catch (e) {
      if (errno(e) !== "ENOENT") throw e;
    }
  }

  const tmp = join(dir, `.pcosmo-${randomBytes(8).toString("hex")}`);
  await mkdir(tmp, { mode: 0o700 });
  const made: string[] = [];
  const cleanup = async (): Promise<void> => {
    for (const n of made) await unlink(join(tmp, n)).catch(() => undefined);
    await rmdir(tmp).catch(() => undefined);
  };
  try {
    const flags =
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    for (const f of files) {
      const fh = await open(join(tmp, f.name), flags, 0o644);
      made.push(f.name);
      try {
        const st = await fh.stat();
        if (!st.isFile() || st.nlink !== 1)
          return (await cleanup(), refuse(`cannot create ${f.name}`));
        await fh.writeFile(f.data);
      } finally {
        await fh.close();
      }
    }
    await hooks.beforeRename?.();
    if ((await realpath(dir)) !== dir) {
      await cleanup();
      return refuse(`${shown} changed while it was being written`);
    }
    for (const f of files) await rename(join(tmp, f.name), join(dir, f.name));
    made.length = 0;
    const after = (await realpath(dir).catch(() => undefined)) === dir;
    await rmdir(tmp).catch(() => undefined);
    if (!after) return refuse(`${shown} changed while it was being written`);
    return {
      ok: true,
      written: files.map((f) => ({ name: f.name, bytes: f.data.byteLength })),
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/**
 * Names in `<rootDir>/<dirRel>` that look like outputs of an earlier run (`base.png`,
 * `sprite-N.png`, `fragment.json`, `report.json`, `exclusions-<state>.png`) and are not in
 * `current`. Bounded scan; nothing is deleted.
 */
export async function staleOutputs(
  dirAbs: string,
  current: ReadonlySet<string>,
): Promise<string[]> {
  const out: string[] = [];
  const pat =
    /^(base\.png|sprite-[1-9][0-9]{0,2}\.png|fragment\.json|report\.json|exclusions-(exploded|assembled)\.png)$/;
  try {
    let n = 0;
    for await (const e of await opendir(dirAbs)) {
      if (++n > 2000) break;
      if (pat.test(e.name) && !current.has(e.name)) out.push(e.name);
    }
  } catch {
    // no directory, nothing stale
  }
  return out.sort();
}

export const relFromCwd = (cwd: string, abs: string): string => {
  if (abs === cwd) return ".";
  return abs.startsWith(cwd + sep)
    ? abs
        .slice(cwd.length + 1)
        .split(sep)
        .join("/")
    : abs;
};
