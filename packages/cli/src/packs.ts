/**
 * User icon packs on disk.
 *
 *   <packsDir>/platformcosmo-icons.lock.json     IconLockfile (no timestamps)
 *   <packsDir>/<packId>/icons.json               IconManifest
 *   <packsDir>/<packId>/<IconEntry.file>         SVG files
 *
 * `packsDir` is `--packs-dir`, else `$PCOSMO_PACKS_DIR`, else `$CLAUDE_PLUGIN_DATA/icons`
 * (persistent across plugin updates), else `~/.platformcosmo/icons`. Every pack is verified
 * against its lockfile `integrity` before it is loaded; mismatches are diagnostics, never loaded.
 */
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { PACK_ID_RE } from "@platformcosmo/core";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { computeIconIntegrity, verifyIconIntegrity } from "@platformcosmo/core";
import type {
  Diagnostic,
  IconLockEntry,
  IconLockfile,
  IconManifest,
  LoadedIconPack,
} from "@platformcosmo/core";
import { type Deps, Failure } from "./deps.js";
import { errorDiagnostic } from "./format.js";

export const LOCKFILE_NAME = "platformcosmo-icons.lock.json";
export { PACK_ID_RE };
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SVG_BYTES = 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_PACK_BYTES = 64 * 1024 * 1024;

export function packsDirFor(deps: Deps, override?: string): string {
  const e = deps.env;
  let dir: string;
  if (override) dir = resolve(deps.cwd, override);
  else if (e["PCOSMO_PACKS_DIR"]) dir = resolve(deps.cwd, e["PCOSMO_PACKS_DIR"]);
  else if (e["CLAUDE_PLUGIN_DATA"]) dir = join(e["CLAUDE_PLUGIN_DATA"], "icons");
  else dir = join(deps.homedir, ".platformcosmo", "icons");
  // A skill passes "${CLAUDE_PLUGIN_DATA}/icons"; when that variable was not substituted the shell
  // turns it into "/icons" (or leaves a literal "${"). Never use such a directory.
  if (dir === "/icons" || dir.includes("${")) {
    throw new Failure(
      `cli/plugin-data-unset: the icon pack directory "${dir}" looks like an unexpanded \${CLAUDE_PLUGIN_DATA}; ` +
        "pass a real directory with --packs-dir or set PCOSMO_PACKS_DIR",
    );
  }
  return dir;
}

/** A manifest file path must be relative, forward-slashed and stay inside the pack. */
export function isSafeRelPath(p: string): boolean {
  if (p === "" || p.includes("\\") || p.includes("\0") || isAbsolute(p) || p.startsWith("/")) {
    return false;
  }
  const n = posix.normalize(p);
  return n === p && n !== ".." && !n.startsWith("../") && !n.split("/").includes("..");
}

/** Structural check of an untrusted manifest. Returns problems (empty = ok). */
export function checkManifest(m: unknown): string[] {
  const out: string[] = [];
  if (m === null || typeof m !== "object") return ["manifest is not an object"];
  const man = m as Partial<IconManifest>;
  if (man.manifestVersion !== 1) out.push("manifestVersion must be 1");
  const info = man.pack;
  if (!info || typeof info !== "object") out.push("pack is missing");
  else {
    if (typeof info.id !== "string" || !PACK_ID_RE.test(info.id)) {
      out.push("pack.id must match ^[a-z][a-z0-9-]{0,31}$");
    }
    for (const k of ["name", "version", "license", "source"] as const) {
      if (typeof info[k] !== "string") out.push(`pack.${k} must be a string`);
    }
    if (typeof info.redistributable !== "boolean") out.push("pack.redistributable must be boolean");
  }
  if (!Array.isArray(man.icons)) out.push("icons must be an array");
  else if (man.icons.length > MAX_FILES) out.push(`too many icons (limit ${MAX_FILES})`);
  else {
    const seen = new Set<string>();
    for (const [i, ic] of man.icons.entries()) {
      if (!ic || typeof ic.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(ic.id)) {
        out.push(`icons[${i}].id is invalid`);
      } else if (seen.has(ic.id)) out.push(`icons[${i}].id "${ic.id}" is duplicated`);
      else seen.add(ic.id);
      if (!ic || typeof ic.file !== "string" || !isSafeRelPath(ic.file)) {
        out.push(`icons[${i}].file must be a relative path without ".."`);
      }
    }
  }
  return out;
}

export async function readLockfile(dir: string): Promise<IconLockfile> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, LOCKFILE_NAME), "utf8")) as IconLockfile;
    if (parsed.lockfileVersion !== 1 || typeof parsed.packs !== "object" || !parsed.packs) {
      throw new Error("unsupported lockfile");
    }
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { lockfileVersion: 1, packs: {} };
    throw new Error(`cannot read ${join(dir, LOCKFILE_NAME)}: ${(e as Error).message}`, {
      cause: e,
    });
  }
}

async function writeLockfile(dir: string, lock: IconLockfile): Promise<void> {
  const sorted: Record<string, IconLockEntry> = {};
  for (const k of Object.keys(lock.packs).sort()) sorted[k] = lock.packs[k]!;
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${LOCKFILE_NAME}.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify({ lockfileVersion: 1, packs: sorted }, null, 2)}\n`);
  await rename(tmp, join(dir, LOCKFILE_NAME));
}

/** Reads one pack directory (manifest plus its files). Symlinks are rejected. Throws with a readable message. */
export async function readPackDir(dir: string): Promise<LoadedIconPack> {
  const root = await realpath(dir);
  let total = 0;
  const readSafe = async (full: string, max: number, what: string): Promise<string> => {
    const st = await lstat(full);
    if (st.isSymbolicLink()) throw new Error(`${what} is a symbolic link`);
    if (!st.isFile()) throw new Error(`${what} is not a regular file`);
    if (st.size > max) throw new Error(`${what} is too large`);
    total += st.size;
    if (total > MAX_PACK_BYTES) throw new Error(`pack is larger than ${MAX_PACK_BYTES} bytes`);
    if (!(await realpath(full)).startsWith(root + sep)) throw new Error(`${what} escapes the pack`);
    return readFile(full, "utf8");
  };
  const manifest = JSON.parse(
    await readSafe(join(root, "icons.json"), MAX_MANIFEST_BYTES, "icons.json"),
  ) as IconManifest;
  const problems = checkManifest(manifest);
  if (problems.length > 0) throw new Error(problems.slice(0, 5).join("; "));
  const files: Record<string, string> = {};
  for (const ic of manifest.icons) {
    const full = resolve(root, ic.file);
    if (!full.startsWith(root + sep)) throw new Error(`icon path escapes the pack: ${ic.file}`);
    files[ic.file] = await readSafe(full, MAX_SVG_BYTES, ic.file);
  }
  return { manifest, files };
}

/** Loads every locked user pack, verifying integrity. Bad packs become diagnostics and are skipped. */
export async function loadUserPacks(
  dir: string,
): Promise<{ packs: LoadedIconPack[]; diagnostics: Diagnostic[] }> {
  const packs: LoadedIconPack[] = [];
  const diagnostics: Diagnostic[] = [];
  let lock: IconLockfile;
  try {
    lock = await readLockfile(dir);
  } catch (e) {
    return {
      packs,
      diagnostics: [errorDiagnostic("packs/lockfile-invalid", (e as Error).message)],
    };
  }
  for (const id of Object.keys(lock.packs).sort()) {
    const entry = lock.packs[id]!;
    try {
      if (!PACK_ID_RE.test(id)) throw new Error("invalid pack id in lockfile");
      const pack = await readPackDir(join(dir, id));
      if (pack.manifest.pack.id !== id)
        throw new Error("manifest pack.id does not match its folder");
      if (!verifyIconIntegrity(pack, entry.integrity)) {
        diagnostics.push(
          errorDiagnostic(
            "packs/integrity-mismatch",
            `icon pack "${id}" does not match ${LOCKFILE_NAME} (files changed on disk); it was not loaded`,
            `run: pcosmo icons remove ${id}, then pcosmo icons add ${entry.source}`,
          ),
        );
        continue;
      }
      packs.push(pack);
    } catch (e) {
      diagnostics.push(
        errorDiagnostic(
          "packs/load-failed",
          `icon pack "${id}" could not be loaded: ${(e as Error).message}`,
          `run: pcosmo icons remove ${id}`,
        ),
      );
    }
  }
  return { packs, diagnostics };
}

/** The pack exactly as it will exist on disk: JSON round-tripped manifest, referenced files only. */
function normalizePack(pack: LoadedIconPack): LoadedIconPack {
  const manifest = JSON.parse(JSON.stringify(pack.manifest)) as IconManifest;
  const files: Record<string, string> = {};
  for (const ic of manifest.icons) {
    const text = pack.files[ic.file];
    if (text === undefined) throw new Error(`pack is missing file ${ic.file}`);
    // Files are stored as UTF-8; text that would not read back identically (lone surrogates) is refused.
    if (Buffer.from(text, "utf8").toString("utf8") !== text) {
      throw new Error(`${ic.file} is not valid UTF-8 text`);
    }
    files[ic.file] = text;
  }
  return { manifest, files };
}

/**
 * Writes a pack and records it in the lockfile. The pack is written to a temp directory and
 * renamed into place, then the lockfile is updated (integrity is computed over what was written).
 * An existing pack with the same id is refused unless `overwrite` is set.
 */
export async function savePack(
  dir: string,
  input: LoadedIconPack,
  entry: Omit<IconLockEntry, "integrity" | "iconCount">,
  overwrite = false,
): Promise<IconLockEntry> {
  const problems = checkManifest(input.manifest);
  if (problems.length > 0) throw new Error(`invalid pack: ${problems.slice(0, 5).join("; ")}`);
  const pack = normalizePack(input);
  const id = pack.manifest.pack.id;
  const lock = await readLockfile(dir);
  const target = resolve(dir, id);
  const exists =
    Object.hasOwn(lock.packs, id) ||
    (await lstat(target).then(
      () => true,
      () => false,
    ));
  if (exists && !overwrite) {
    throw new Error(
      `icon pack "${id}" is already installed; choose another id with --id <name> (or pass --force to replace it)`,
    );
  }
  await mkdir(dir, { recursive: true });
  const tmp = resolve(dir, `.tmp-${id}-${process.pid}-${Date.now()}`);
  try {
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, "icons.json"), `${JSON.stringify(pack.manifest, null, 2)}\n`);
    for (const ic of pack.manifest.icons) {
      const full = resolve(tmp, ic.file);
      if (!full.startsWith(tmp + sep)) throw new Error(`icon path escapes the pack: ${ic.file}`);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, pack.files[ic.file]!);
    }
    // Integrity over exactly what landed on disk.
    const written = await readPackDir(tmp);
    const integrity = computeIconIntegrity(written);
    await rm(target, { recursive: true, force: true });
    await rename(tmp, target);
    const full: IconLockEntry = { ...entry, integrity, iconCount: pack.manifest.icons.length };
    await writeLockfile(dir, { lockfileVersion: 1, packs: { ...lock.packs, [id]: full } });
    return full;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function removePack(dir: string, id: string): Promise<boolean> {
  if (!PACK_ID_RE.test(id)) throw new Error(`invalid pack id "${id}"`);
  const lock = await readLockfile(dir);
  const had = Object.hasOwn(lock.packs, id);
  if (had) {
    const rest = { ...lock.packs };
    delete rest[id];
    await writeLockfile(dir, { lockfileVersion: 1, packs: rest });
  }
  await rm(resolve(dir, id), { recursive: true, force: true });
  return had;
}

/** Folder-of-SVGs pack (`pcosmo icons add ./path`): needs `icons.json` next to the SVG files. */
export async function readLocalPack(path: string): Promise<LoadedIconPack> {
  try {
    await readdir(path);
  } catch {
    throw new Error(`not a directory: ${path}`);
  }
  try {
    return await readPackDir(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `${join(path, "icons.json")} not found; a custom pack is a folder of SVGs plus icons.json`,
        { cause: e },
      );
    }
    throw e;
  }
}
