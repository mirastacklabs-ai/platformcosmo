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
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import type {
  Diagnostic,
  IconLockEntry,
  IconLockfile,
  IconManifest,
  LoadedIconPack,
} from "@platformcosmo/core";
import type { Deps } from "./deps.js";
import { errorDiagnostic } from "./format.js";

export const LOCKFILE_NAME = "platformcosmo-icons.lock.json";
export const PACK_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SVG_BYTES = 1024 * 1024;
const MAX_FILES = 20_000;

export function packsDirFor(deps: Deps, override?: string): string {
  const e = deps.env;
  if (override) return resolve(deps.cwd, override);
  if (e["PCOSMO_PACKS_DIR"]) return resolve(deps.cwd, e["PCOSMO_PACKS_DIR"]);
  if (e["CLAUDE_PLUGIN_DATA"]) return join(e["CLAUDE_PLUGIN_DATA"], "icons");
  return join(deps.homedir, ".platformcosmo", "icons");
}

/** A manifest file path must be relative, forward-slashed and stay inside the pack. */
export function isSafeRelPath(p: string): boolean {
  if (p === "" || p.includes("\\") || p.includes("\0") || isAbsolute(p) || p.startsWith("/")) {
    return false;
  }
  const n = posix.normalize(p);
  return n === p && n !== ".." && !n.startsWith("../") && !n.split("/").includes("..");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * `sha256-<base64>` over the canonical (key-sorted) manifest, then each file as
 * `path NUL content NUL` in path order. The CLI always records and verifies this value itself.
 */
export function computeIntegrity(pack: LoadedIconPack): string {
  const h = createHash("sha256");
  h.update(canonical(pack.manifest));
  h.update("\0");
  for (const path of Object.keys(pack.files).sort()) {
    h.update(path);
    h.update("\0");
    h.update(pack.files[path]!);
    h.update("\0");
  }
  return `sha256-${h.digest("base64")}`;
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
  await writeFile(
    join(dir, LOCKFILE_NAME),
    `${JSON.stringify({ lockfileVersion: 1, packs: sorted }, null, 2)}\n`,
  );
}

/** Reads one pack directory (manifest plus its files). Throws with a readable message. */
export async function readPackDir(dir: string): Promise<LoadedIconPack> {
  const mp = join(dir, "icons.json");
  if ((await stat(mp)).size > MAX_MANIFEST_BYTES) throw new Error("icons.json is too large");
  const manifest = JSON.parse(await readFile(mp, "utf8")) as IconManifest;
  const problems = checkManifest(manifest);
  if (problems.length > 0) throw new Error(problems.slice(0, 5).join("; "));
  const files: Record<string, string> = {};
  const root = resolve(dir);
  for (const ic of manifest.icons) {
    const full = resolve(root, ic.file);
    if (!full.startsWith(root + sep)) throw new Error(`icon path escapes the pack: ${ic.file}`);
    if ((await stat(full)).size > MAX_SVG_BYTES) throw new Error(`${ic.file} is too large`);
    files[ic.file] = await readFile(full, "utf8");
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
      if (computeIntegrity(pack) !== entry.integrity) {
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

/** Writes a pack and records it in the lockfile (integrity is computed here). */
export async function savePack(
  dir: string,
  pack: LoadedIconPack,
  entry: Omit<IconLockEntry, "integrity" | "iconCount">,
): Promise<IconLockEntry> {
  const id = pack.manifest.pack.id;
  const problems = checkManifest(pack.manifest);
  if (problems.length > 0) throw new Error(`invalid pack: ${problems.slice(0, 5).join("; ")}`);
  const target = resolve(dir, id);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "icons.json"), `${JSON.stringify(pack.manifest, null, 2)}\n`);
  for (const ic of pack.manifest.icons) {
    const full = resolve(target, ic.file);
    if (!full.startsWith(target + sep)) throw new Error(`icon path escapes the pack: ${ic.file}`);
    const text = pack.files[ic.file];
    if (text === undefined) throw new Error(`pack is missing file ${ic.file}`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text);
  }
  const lock = await readLockfile(dir);
  const full: IconLockEntry = {
    ...entry,
    integrity: computeIntegrity(pack),
    iconCount: pack.manifest.icons.length,
  };
  await writeLockfile(dir, { lockfileVersion: 1, packs: { ...lock.packs, [id]: full } });
  return full;
}

export async function removePack(dir: string, id: string): Promise<boolean> {
  if (!PACK_ID_RE.test(id)) throw new Error(`invalid pack id "${id}"`);
  const lock = await readLockfile(dir);
  const had = id in lock.packs;
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
