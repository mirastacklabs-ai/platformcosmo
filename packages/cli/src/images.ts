/**
 * Image loading for the CLI (assemblies §11.1). The files are untrusted: they come from a spec, a
 * figure manifest or the command line, and the directory may be writable by someone else while
 * we run. So there is no check-then-use:
 *
 *   1. the directory is resolved with `realpath` (the user chose it);
 *   2. the relative path is walked one component at a time with `lstat` (no symlink components,
 *      directories until the last one, a regular file at the end);
 *   3. the file is opened ONCE with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` (the last component is
 *      never followed; a FIFO swapped in cannot block the open);
 *   4. `fstat` on that same descriptor: a regular file, size within the cap;
 *   5. a bounded read from the descriptor: never more than cap + 1 bytes;
 *   6. a final identity check: the path still names the file we hold (dev/ino) and still resolves
 *      to the same place (catches a directory component swapped for a symlink after step 2,
 *      which `O_NOFOLLOW` does not cover).
 *
 *   7. On Linux the kernel's own answer is compared with the expected path
 *      (`readlink /proc/self/fd/N`), which also catches a parent directory renamed after the walk
 *      even when the new file is a hard link to ours. Elsewhere the read is refused when a
 *      directory above the file is writable by another user (and not sticky) or owned by a user
 *      other than us or root.
 *
 * Residual race (documented in assemblies §11.1): there is no `openat`/`O_PATH` walk in Node, so
 * an attacker who may rename directories above the file can still swap them between the walk and
 * the open on platforms without /proc; the file read is then a real file of the same directory
 * tree at open time, never one reached through a symlink we followed. Within one user's private
 * directories the race does not exist.
 *
 * Platforms without `O_NOFOLLOW` (Windows): the flag is simply absent, so step 3 does not refuse
 * a symlink by itself; steps 2 and 6 still refuse symlinks (lstat, realpath, dev/ino), which
 * narrows the race but cannot close it. `assets doctor` reports which mode is in effect.
 *
 * Nothing here throws out of a command: every refusal is a diagnostic (`image/not-found`,
 * `image/unsafe-path`, `image/too-large`). Names of output files are never derived from what a
 * file contains.
 */
import { constants } from "node:fs";
import { lstat, opendir, open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  DEFAULT_IMAGE_LIMITS,
  didYouMean,
  prepareImage,
  type Diagnostic,
  type ImageAsset,
  type ImageAssetResolver,
  type ImageLimits,
} from "@platformcosmo/core";

export type SafeReadCode = "image/not-found" | "image/unsafe-path" | "image/too-large";

export type SafeRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly code: SafeReadCode;
      readonly message: string;
      readonly suggestion?: string;
    };

/** Test seam: runs between the checks and the open (an attacker's window). Never set in production. */
export interface SafeReadHooks {
  readonly afterChecks?: () => void | Promise<void>;
  /** Runs right after the open succeeded. */
  readonly afterOpen?: () => void | Promise<void>;
  /** Runs after `fstat`, before the read. */
  readonly afterStat?: () => void | Promise<void>;
  /** Overrides `process.platform` for the fallback directory-permission rule. */
  readonly platform?: NodeJS.Platform;
}

/** True when the platform can refuse a symlink as the last component at open time. */
export const HAS_NOFOLLOW = constants.O_NOFOLLOW !== undefined;

const MAX_REL = 512;
/** Windows device names (with or without an extension): never a file we should open. */
const WINDOWS_ODD = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_SUGGEST_ENTRIES = 1000;

const fail = (
  code: SafeReadCode,
  message: string,
  suggestion?: string,
): Extract<SafeRead, { ok: false }> => ({
  ok: false,
  code,
  message,
  ...(suggestion === undefined ? {} : { suggestion }),
});

/** True when `a` and `b` differ only by case or Unicode normalization. */
const sameSpelling = (a: string, b: string): boolean =>
  a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();

/**
 * Directory writable by someone other than its owner (and not sticky), or by a uid that is not
 * ours: anyone there could rename a component under a reader between our checks and our open.
 */
export function foreignWritableDir(mode: number, uid: number, me: number | undefined): boolean {
  if (me !== undefined && uid !== me && uid !== 0) return true;
  const otherWritable = (mode & 0o022) !== 0;
  const sticky = (mode & 0o1000) !== 0;
  return otherWritable && !sticky;
}

/** The path the kernel reports for an open descriptor (Linux `/proc/self/fd`), or undefined. */
async function descriptorPath(fd: number, platform: NodeJS.Platform): Promise<string | undefined> {
  if (platform !== "linux") return undefined;
  try {
    return await readlink(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | undefined)?.code;

/**
 * Splits a spec-relative path into components, refusing anything that could leave the directory:
 * absolute paths, drive letters and URLs (`:`), backslashes, NUL, empty or `..` components,
 * components ending in `.` or a space and Windows device names (CON, NUL, COM1, ...).
 * `.` components are dropped.
 */
export function relativeParts(rel: string): string[] | undefined {
  if (rel.length === 0 || rel.length > MAX_REL) return undefined;
  if (rel.includes("\0") || rel.includes("\\") || rel.includes(":") || rel.startsWith("/")) {
    return undefined;
  }
  const parts: string[] = [];
  for (const p of rel.split("/")) {
    if (p === ".") continue;
    if (p === "" || p === ".." || WINDOWS_ODD.test(p) || /[. ]$/.test(p)) return undefined;
    parts.push(p);
  }
  return parts.length > 0 ? parts : undefined;
}

/** `Did you mean "x"?` over the file names of `dir` (a bounded scan), or undefined. */
async function nearestName(dir: string, name: string): Promise<string | undefined> {
  const names: string[] = [];
  let d;
  try {
    d = await opendir(dir);
    for await (const e of d) {
      names.push(e.name);
      if (names.length >= MAX_SUGGEST_ENTRIES) break;
    }
  } catch {
    // opendir closes itself when the loop ends; an error here only loses the suggestion
  }
  return didYouMean(name, names);
}

/**
 * Reads `<rootDir>/<rel>` without ever following a symlink out of `rootDir`, at most `maxBytes`
 * bytes. See the module comment for the exact sequence.
 */
export async function readFileSafe(
  rootDir: string,
  rel: string,
  maxBytes: number,
  hooks: SafeReadHooks = {},
): Promise<SafeRead> {
  const parts = relativeParts(rel);
  if (parts === undefined) {
    return fail(
      "image/unsafe-path",
      `"${rel.slice(0, 120)}" is not a plain relative path`,
      "use a path relative to the spec's directory, without '..', ':' or backslashes",
    );
  }
  let root: string;
  try {
    root = await realpath(rootDir);
  } catch {
    return fail("image/not-found", "the directory does not exist");
  }

  // 2. walk the components
  const dirModes: { mode: number; uid: number }[] = [];
  try {
    const rs = await lstat(root);
    dirModes.push({ mode: rs.mode, uid: rs.uid });
  } catch {
    return fail("image/not-found", "the directory does not exist");
  }
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    const last = i === parts.length - 1;
    let st;
    try {
      st = await lstat(cur);
    } catch (e) {
      if (errno(e) === "ENOENT" || errno(e) === "ENOTDIR") {
        const hint = await nearestName(dirname(cur), parts[i]!);
        return fail("image/not-found", `no such file: ${parts.slice(0, i + 1).join("/")}`, hint);
      }
      return fail("image/unsafe-path", `cannot inspect ${parts.slice(0, i + 1).join("/")}`);
    }
    if (st.isSymbolicLink()) {
      return fail(
        "image/unsafe-path",
        `${parts.slice(0, i + 1).join("/")} is a symbolic link; images must be plain files below the spec's directory`,
      );
    }
    if (last ? !st.isFile() : !st.isDirectory()) {
      return fail(
        "image/unsafe-path",
        `${parts.slice(0, i + 1).join("/")} is not a ${last ? "regular file" : "directory"}`,
      );
    }
    if (!last) dirModes.push({ mode: st.mode, uid: st.uid });
  }

  await hooks.afterChecks?.();

  // 3. one open, never following the last component, never blocking on a FIFO
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fh;
  try {
    fh = await open(cur, flags);
  } catch (e) {
    const c = errno(e);
    if (c === "ENOENT") return fail("image/not-found", `no such file: ${parts.join("/")}`);
    // ELOOP (Linux, macOS) or EMLINK (BSD): the last component became a symlink.
    return fail(
      "image/unsafe-path",
      `${parts.join("/")} cannot be opened safely (${c ?? "error"})`,
    );
  }
  try {
    await hooks.afterOpen?.();
    // 4. fstat the descriptor we hold
    const st = await fh.stat();
    if (!st.isFile()) {
      return fail("image/unsafe-path", `${parts.join("/")} is not a regular file`);
    }
    if (st.size > maxBytes) {
      return fail("image/too-large", `${parts.join("/")} is ${st.size} bytes (limit ${maxBytes})`);
    }
    await hooks.afterStat?.();
    // 6. the path must still name this file and still resolve inside the directory
    try {
      const now = await lstat(cur);
      if (now.isSymbolicLink() || now.dev !== st.dev || now.ino !== st.ino) {
        return fail("image/unsafe-path", `${parts.join("/")} changed while it was being opened`);
      }
      const real = await realpath(cur);
      if (real !== cur) {
        if (sameSpelling(real, cur)) {
          return fail(
            "image/not-found",
            `no such file: ${parts.join("/")}`,
            `the file system matched it case-insensitively; spell it exactly as "${basename(real)}"`,
          );
        }
        return fail("image/unsafe-path", `${parts.join("/")} resolves outside its directory`);
      }
    } catch {
      return fail("image/unsafe-path", `${parts.join("/")} changed while it was being opened`);
    }
    // 6b. which path does the kernel say this descriptor is? On Linux the answer is exact and
    // catches a directory swapped after the walk even when the new file is a hard link to ours.
    // Elsewhere, refuse when a directory above the file can be renamed under us by another user.
    const platform = hooks.platform ?? process.platform;
    const via = await descriptorPath(fh.fd, platform);
    if (via !== undefined) {
      if (via !== cur) {
        return fail("image/unsafe-path", `${parts.join("/")} changed while it was being opened`);
      }
    } else if (platform !== "win32") {
      const bad = dirModes.some((d) => foreignWritableDir(d.mode, d.uid, process.getuid?.()));
      if (bad) {
        return fail(
          "image/unsafe-path",
          `a directory above ${parts.join("/")} is writable by other users, so it cannot be read safely`,
          "make the directories private (chmod go-w), or use a directory you own",
        );
      }
    }
    // 5. bounded read: the buffer is sized by the (already capped) fstat size, plus one byte to
    //    notice a file that grew.
    const buf = Buffer.allocUnsafe(Math.min(st.size, maxBytes) + 1);
    let n = 0;
    while (n < buf.length) {
      const r = await fh.read(buf, n, buf.length - n, null);
      if (r.bytesRead === 0) break;
      n += r.bytesRead;
    }
    // A file that is not exactly as long as fstat said was written to while we read it.
    if (n !== st.size) {
      return fail("image/unsafe-path", `${parts.join("/")} changed while it was being read`);
    }
    return { ok: true, bytes: new Uint8Array(buf.buffer, buf.byteOffset, n) };
  } finally {
    await fh.close();
  }
}

/**
 * A file named on the command line: its directory is the user's own choice (resolved with
 * realpath), the file itself gets the same treatment as a spec image (no symlink, regular file,
 * one `O_NOFOLLOW` open, bounded read).
 */
export function readExplicitFile(
  cwd: string,
  path: string,
  maxBytes: number,
  hooks?: SafeReadHooks,
): Promise<SafeRead> {
  if (path.includes("\0") || path.length > 4096) {
    return Promise.resolve(fail("image/unsafe-path", "the path is not valid"));
  }
  const abs = resolve(cwd, path);
  return readFileSafe(dirname(abs), basename(abs), maxBytes, hooks);
}

/** `realpath` of the deepest existing ancestor of `abs`, with the missing rest appended. */
export async function realResolve(abs: string): Promise<string | undefined> {
  const rest: string[] = [];
  let cur = resolve(abs);
  for (let i = 0; i < 4096; i++) {
    try {
      return join(await realpath(cur), ...rest.reverse());
    } catch (e) {
      if (errno(e) !== "ENOENT") return undefined;
      const up = dirname(cur);
      if (up === cur) return undefined;
      rest.push(basename(cur));
      cur = up;
    }
  }
  return undefined;
}

/**
 * `PCOSMO_ASSETS_ROOT`: when set, a path (after resolving every symlink of the part that exists)
 * must lie inside that directory. Unset means no confinement.
 */
export async function insideAssetsRoot(root: string | undefined, abs: string): Promise<boolean> {
  if (root === undefined || root === "") return true;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return false;
  }
  const p = await realResolve(abs);
  return p !== undefined && (p === rootReal || p.startsWith(rootReal + sep));
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface ImageLoad {
  /** Undefined when the spec declares no images (renders stay byte-identical to 1.1). */
  readonly resolver?: ImageAssetResolver;
  readonly diagnostics: Diagnostic[];
}

/** Largest file the spec image reader will take: the bigger of the raster and SVG caps. */
const fileCap = (limits: ImageLimits, src: string): number =>
  /\.svg$/i.test(src) ? limits.maxSvgBytes : Math.max(limits.maxBytes, limits.maxSvgBytes);

/**
 * Builds the `ImageAssetResolver` from a spec's `images[]`: files relative to `specDir` are read
 * through `readFileSafe`, inline data URIs are decoded by core, everything goes through C-1's
 * `prepareImage`. The spec has not been validated yet, so every shape is checked here. Caps are
 * enforced before reading: at most `maxImages` entries, and the raw bytes read over all files
 * stay within twice the embedded-total cap.
 */
export async function loadSpecImages(
  spec: unknown,
  specDir: string,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): Promise<ImageLoad> {
  const diagnostics: Diagnostic[] = [];
  const list = isObj(spec) && Array.isArray(spec.images) ? (spec.images as unknown[]) : undefined;
  if (list === undefined || list.length === 0) return { diagnostics };
  if (list.length > limits.maxImages) {
    diagnostics.push({
      severity: "error",
      code: "image/too-many",
      path: "/images",
      message: `The spec declares ${list.length} images (limit ${limits.maxImages})`,
      suggestion: "Share sprites between parts or split the figures over several specs",
      params: { count: list.length, limit: limits.maxImages },
    });
    return { diagnostics };
  }

  const assets = new Map<string, ImageAsset>();
  const files = new Map<string, SafeRead>();
  let budget = limits.maxTotalBytes * 2;
  let exhausted = false;
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    if (!isObj(img) || typeof img.id !== "string" || typeof img.src !== "string") continue;
    if (assets.has(img.id)) continue; // duplicate ids are core's to report
    let bytes: Uint8Array = new Uint8Array(0);
    if (!img.src.startsWith("data:")) {
      const path = `/images/${i}/src`;
      const totalDiag = (): void => {
        diagnostics.push({
          severity: "error",
          code: "image/too-large",
          path,
          message: `Image "${img.id}" was not read: the images together exceed the total limit of ${limits.maxTotalBytes * 2} bytes`,
          suggestion: "Shrink the images (pcosmo assets shrink) or use fewer of them",
          params: { id: img.id, reason: "total", limit: limits.maxTotalBytes * 2 },
        });
      };
      if (exhausted) {
        totalDiag();
        continue;
      }
      let r = files.get(img.src);
      if (r === undefined) {
        const cap = fileCap(limits, img.src);
        r = await readFileSafe(specDir, img.src, Math.min(cap, budget));
        files.set(img.src, r);
        if (r.ok) budget -= r.bytes.length;
        else if (r.code === "image/too-large" && budget < cap) {
          exhausted = true;
          totalDiag();
          continue;
        }
      }
      if (!r.ok) {
        diagnostics.push({
          severity: "error",
          code: r.code,
          path,
          message: `Image "${img.id}": ${r.message}`,
          ...(r.suggestion === undefined ? {} : { suggestion: r.suggestion }),
          params: { id: img.id },
        });
        continue;
      }
      bytes = r.bytes;
    }
    const p = prepareImage({ key: img.id, src: img.src, bytes }, limits);
    diagnostics.push(...p.diagnostics);
    if (p.asset) assets.set(img.id, p.asset);
  }
  const keys = [...assets.keys()].sort();
  return {
    resolver: { get: (k) => assets.get(k), keys: () => keys },
    diagnostics,
  };
}
