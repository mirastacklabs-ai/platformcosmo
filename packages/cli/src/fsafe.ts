import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

export class UnsafePathError extends Error {}

const isDir = async (p: string): Promise<boolean | undefined> => {
  try {
    const st = await lstat(p);
    if (st.isSymbolicLink()) throw new UnsafePathError(`${p} is a symbolic link`);
    return st.isDirectory();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

/**
 * Writes `data` to `<outDir>/<rel>` and refuses to follow symlinks: every directory below
 * `outDir` is lstat-ed (missing ones are created one level at a time), the target must not be a
 * symlink or directory, and the file is opened with O_NOFOLLOW. `outDir` itself is resolved with
 * realpath (the user chose it). `rel` must already be relative and free of `..` (see `isInside`).
 */
export async function writeInside(
  outDir: string,
  rel: string,
  data: string | Uint8Array,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const root = await realpath(outDir);
  const parts = rel.split(/[\\/]+/).filter((x) => x !== "" && x !== ".");
  const file = parts.pop();
  if (file === undefined) throw new UnsafePathError(`empty output path`);
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    const dir = await isDir(cur);
    if (dir === undefined) await mkdir(cur);
    else if (!dir) throw new UnsafePathError(`${cur} is not a directory`);
  }
  const full = join(cur, file);
  if (!full.startsWith(root + sep)) throw new UnsafePathError(`${full} escapes ${root}`);
  const existing = await isDir(full);
  if (existing === true) throw new UnsafePathError(`${full} is a directory`);
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  let fh;
  try {
    fh = await open(full, flags, 0o644);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      throw new UnsafePathError(`${full} is a symbolic link`, { cause: e });
    }
    throw e;
  }
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
  return full;
}
