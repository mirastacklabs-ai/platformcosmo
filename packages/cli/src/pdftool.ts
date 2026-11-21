/**
 * The optional external PDF renderer for `pcosmo assets pdf render` (ingestion §3, §13): `pdftoppm`
 * (poppler) or `mutool` (MuPDF). The renderer is the one place where the CLI runs somebody else's
 * code on an untrusted PDF, so everything about the call is fixed here and nothing in it comes from
 * the PDF or from a free-form option:
 *
 *   - no shell for the tool: it is started as `/bin/sh -c '<fixed script>' <tool> <argv...>`, a
 *     constant script that applies `ulimit -f` (RLIMIT_FSIZE, the real bound on what the tool can
 *     write; the wrapper exits 125 if it cannot be set) and `ulimit -v` (address space, best
 *     effort: where the OS supports it) and then `exec "$0" "$@"`.
 *     The tool path and the arguments are positional parameters, never part of the script text;
 *     the two numbers in the script are integers this module computes;
 *   - the argument list is a constant template over integers this module formats itself: the page
 *     number and the output size in pixels. The pixel size is passed to the tool (`-scale-to-x/y`,
 *     `draw -w/-h`), computed from the page size and dpi and clamped to 16 MP, so the tool cannot
 *     exceed it whatever page size or UserUnit it reads from the file;
 *   - the tool is found in a fixed list of directories (`DEFAULT_TOOL_DIRS`), never through the
 *     inherited PATH, and there is no environment override (tests inject directories through the
 *     `Deps.pdfRender` seam);
 *   - the environment is minimal: `PATH` (the fixed list), `LANG=C`, `HOME`/`TMPDIR` pointing into
 *     the private directory; nothing is inherited (no `LD_*`, `DYLD_*`, proxies, tokens);
 *   - the PDF is the safely read byte array, written (full-write loop) into a fixed-name file in
 *     the private directory, closed, reopened read-only and handed over as descriptor 3
 *     (`/dev/fd/3`) so the tool cannot write through it; no path is passed;
 *   - the tool runs with the private directory as its working directory and writes one fixed
 *     relative name there (`out.png`). The directory is created `0700` with a random name below
 *     the allowed root, checked with `lstat` (directory, ours, mode 0700), refused when the root is
 *     writable by other users (and not sticky), and removed afterwards, also when SIGINT, SIGTERM
 *     or SIGHUP arrive while the tool runs (the group is killed, the directory removed, the signal
 *     re-raised). Any subdirectory or non-regular file the tool creates fails the render;
 *   - the child is a process-group leader; a timeout, an output over the cap (polled every 20 ms,
 *     on top of RLIMIT_FSIZE), a flood on stdout/stderr or a forbidden entry kills the group. On
 *     Linux, when `unshare --user --map-root-user --net --pid --fork --kill-child --mount-proc`
 *     works unprivileged (probed once; a probe timeout is not cached), the tool also runs without
 *     network and in its own PID namespace, so the kernel kills every descendant when the wrapper
 *     dies. Without it the group is killed on every exit path;
 *   - afterwards the produced file is read through `readFileSafe` (no symlink, regular file, size
 *     cap), must start with the PNG signature and declare dimensions within the 16 MP cap before
 *     anything decodes it.
 *
 * Residual (documented, not closed): without a PID namespace a descendant that calls `setsid`
 * leaves the process group and survives the kill (on a host where `unshare` is unavailable, such
 * as many containers). Node has no seccomp or filesystem sandbox, so a compromised tool can still
 * read and write anything the user can, and use the network, while it runs; RLIMIT_FSIZE,
 * the timeout and the private directory bound what it leaves behind, not what it can do. Writes
 * outside the private directory are not prevented. Windows is not supported.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, rmSync } from "node:fs";
import { access, lstat, mkdir, open, opendir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { foreignWritableDir, readFileSafe } from "./images.js";

export const TOOL_NAMES = ["pdftoppm", "mutool"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Where tools are looked for (the inherited PATH is never used). */
export const DEFAULT_TOOL_DIRS: readonly string[] = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/opt/homebrew/bin",
];

export interface RenderLimits {
  /** Wall-clock time for one render. */
  readonly timeoutMs: number;
  /** Size of the produced PNG (also RLIMIT_FSIZE for the tool). */
  readonly maxOutputBytes: number;
  /** Bytes kept from stdout / stderr each. */
  readonly maxStreamBytes: number;
  /** Output pixels (ingestion §14: 16 MP). */
  readonly maxPixels: number;
  /** Output pixels per side. */
  readonly maxSide: number;
  /** Address-space limit for the tool in KiB (`ulimit -v`, honoured on Linux). */
  readonly maxVirtualKb: number;
}

/** Test-only seam (`Deps.pdfRender`): tighter limits and the directories to look for tools in. */
export type RenderSeam = Partial<RenderLimits> & {
  readonly toolDirs?: readonly string[];
  /** false: never use `unshare`. */
  readonly useUnshare?: boolean;
};

export const RENDER_LIMITS: RenderLimits = Object.freeze({
  timeoutMs: 60_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxStreamBytes: 64 * 1024,
  maxPixels: 16_777_216,
  maxSide: 16_384,
  maxVirtualKb: 2 * 1024 * 1024,
});

export const DPI_RANGE = { min: 10, max: 1200, default: 150 } as const;
const OUT_NAME = "out.png";
const IN_NAME = "in";
const POLL_MS = 20;
const MAX_DIR_ENTRIES = 16;
const SHELL = "/bin/sh";
const UNSHARE_FLAGS = [
  "--user",
  "--map-root-user",
  "--net", // a new, empty network namespace: the tool has no network
  "--pid",
  "--fork",
  "--kill-child",
  "--mount-proc",
] as const;

/** The directories searched (fixed; the seam may replace them in tests). */
export const toolDirs = (seam?: RenderSeam): readonly string[] =>
  seam?.toolDirs ?? DEFAULT_TOOL_DIRS;

/** Absolute path of an executable regular file called `name` in `dirs`, or undefined. */
export async function findTool(
  dirs: readonly string[],
  name: ToolName,
): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  for (const dir of dirs) {
    const p = join(dir, name);
    try {
      if ((await stat(p)).isFile()) {
        await access(p, constants.X_OK);
        return p;
      }
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The first available tool (pdftoppm, then mutool), or the one asked for. */
export async function pickTool(
  dirs: readonly string[],
  want?: ToolName,
): Promise<{ name: ToolName; path: string } | undefined> {
  for (const name of want === undefined ? TOOL_NAMES : [want]) {
    const path = await findTool(dirs, name);
    if (path !== undefined) return { name, path };
  }
  return undefined;
}

/**
 * The output size in pixels for a page of `pw` x `ph` pt at `dpi`, clamped so that
 * `px * py <= maxPixels` and each side `<= maxSide`.
 */
export function renderSize(
  pw: number,
  ph: number,
  dpi: number,
  maxPixels = RENDER_LIMITS.maxPixels,
  maxSide = RENDER_LIMITS.maxSide,
): { px: number; py: number } {
  const safe = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 1);
  const side = (v: number): number =>
    Math.min(maxSide, Math.max(1, Math.ceil((safe(v) * dpi) / 72)));
  let px = side(pw);
  let py = side(ph);
  const k = Math.min(1, Math.sqrt(maxPixels / (px * py)), maxSide / px, maxSide / py);
  if (k < 1) {
    px = Math.max(1, Math.floor(px * k));
    py = Math.max(1, Math.floor(py * k));
  }
  return { px, py };
}

/** The fixed argument lists. `page`, `px` and `py` are integers the caller computed. */
export function toolArgv(tool: ToolName, page: number, px: number, py: number): string[] {
  const p = String(Math.trunc(page));
  const x = String(Math.trunc(px));
  const y = String(Math.trunc(py));
  return tool === "pdftoppm"
    ? [
        "-png",
        "-singlefile",
        "-cropbox",
        "-scale-to-x",
        x,
        "-scale-to-y",
        y,
        "-f",
        p,
        "-l",
        p,
        "/dev/fd/3",
        "out",
      ]
    : ["draw", "-q", "-F", "png", "-w", x, "-h", y, "-o", OUT_NAME, "/dev/fd/3", p];
}

/** The constant script of the limit wrapper; the two numbers are integers computed here. */
export function limitScript(fsizeBlocks: number, vmemKb: number): string {
  const n = (v: number, what: string): number => {
    const t = Math.trunc(v);
    if (!Number.isSafeInteger(t) || t < 1) throw new Error(`invalid ${what} limit`);
    return t;
  };
  const f = n(fsizeBlocks, "file size");
  const m = n(vmemKb, "memory");
  return `ulimit -f ${f} || exit 125; ulimit -v ${m} 2>/dev/null; exec "$0" "$@"`;
}

export function minimalEnv(dirs: readonly string[], home: string): Record<string, string> {
  return {
    PATH: [...new Set([...dirs, ...DEFAULT_TOOL_DIRS])].join(":"),
    LANG: "C",
    LC_ALL: "C",
    HOME: home,
    TMPDIR: home,
    // a cache directory that does not exist: fontconfig must not create one in the private dir
    XDG_CACHE_HOME: join(home, "no-cache", "x"),
    FONTCONFIG_CACHE: join(home, "no-cache", "x"),
  };
}

let unsharePath: Promise<string | undefined> | undefined;

/** Path of a working unprivileged `unshare` (Linux only; probed once), or undefined. */
export function unshareAvailable(): Promise<string | undefined> {
  unsharePath ??= (async () => {
    let timedOut = false;
    if (process.platform !== "linux") return undefined;
    for (const dir of ["/usr/bin", "/bin", "/usr/local/bin"]) {
      const p = join(dir, "unshare");
      try {
        await access(p, constants.X_OK);
      } catch {
        continue;
      }
      const ok = await new Promise<boolean | "timeout">((done) => {
        try {
          const c = spawn(p, [...UNSHARE_FLAGS, "/bin/true"], {
            shell: false,
            stdio: "ignore",
            env: { PATH: DEFAULT_TOOL_DIRS.join(":") },
          });
          const t = setTimeout(() => (c.kill("SIGKILL"), done("timeout")), 10_000);
          c.on("error", () => (clearTimeout(t), done(false)));
          c.on("close", (code) => (clearTimeout(t), done(code === 0)));
        } catch {
          done(false);
        }
      });
      if (ok === "timeout") {
        timedOut = true;
        continue;
      }
      if (ok) return p;
    }
    // a probe that timed out (load) says nothing about unshare: do not cache it as a failure
    if (timedOut) unsharePath = undefined;
    return undefined;
  })();
  return unsharePath;
}

export type RenderFailure =
  | "unsupported"
  | "missing"
  | "setup"
  | "spawn"
  | "timeout"
  | "output-too-large"
  | "exit"
  | "no-output"
  | "bad-output";

export type RenderResult =
  | {
      readonly ok: true;
      readonly png: Uint8Array;
      readonly width: number;
      readonly height: number;
      /** `unshare`: no network, own PID namespace; `none`: process-group kill only. */
      readonly sandbox: "unshare" | "none";
    }
  | { readonly ok: false; readonly reason: RenderFailure; readonly detail: string };

const fail = (reason: RenderFailure, detail: string): RenderResult => ({
  ok: false,
  reason,
  detail,
});

/** Printable ASCII only, short: what a tool said, as data in a message. */
export function tidy(text: string, max = 200): string {
  return text
    .replace(/[^\x20-\x7e]+/g, " ")
    .trim()
    .slice(0, max);
}

/** PNG signature + IHDR: the declared size, or undefined when it is not a plausible PNG. */
export function pngSize(b: Uint8Array): { width: number; height: number } | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(8) !== 13 || dv.getUint32(12) !== 0x49484452) return undefined;
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** A bounded scan of the private directory: bytes of the tool's files, entries, forbidden ones. */
async function scanDir(
  dir: string,
): Promise<{ bytes: number; entries: number; forbidden: string | undefined }> {
  let bytes = 0;
  let entries = 0;
  let forbidden: string | undefined;
  try {
    for await (const e of await opendir(dir)) {
      entries++;
      if (entries > MAX_DIR_ENTRIES) break;
      try {
        const st = await lstat(join(dir, e.name));
        if (!st.isFile()) forbidden ??= "a subdirectory, link or special file was created";
        else if (e.name !== IN_NAME) bytes += st.size;
      } catch {
        // vanished
      }
    }
  } catch {
    // gone
  }
  return { bytes, entries, forbidden };
}

export interface RenderRequest {
  /** The root the private directory is created below (already confined by the caller). */
  readonly rootDir: string;
  readonly tool: { readonly name: ToolName; readonly path: string };
  readonly pdf: Uint8Array;
  readonly page: number;
  /** Output size in pixels (the caller clamps with `renderSize`). */
  readonly px: number;
  readonly py: number;
  /** The page's /Rotate as our parser read it (0, 90, 180, 270). */
  readonly rotate?: number;
  readonly seam?: RenderSeam | undefined;
}

/** Runs the renderer once. Never throws. The private directory is always removed. */
export async function renderPage(req: RenderRequest): Promise<RenderResult> {
  if (process.platform === "win32") return fail("unsupported", "not supported on Windows");
  const lim: RenderLimits = { ...RENDER_LIMITS, ...req.seam };
  const work = join(req.rootDir, `.pcosmo-render-${randomBytes(8).toString("hex")}`);
  try {
    const rs = await lstat(req.rootDir);
    if (foreignWritableDir(rs.mode, rs.uid, process.getuid?.())) {
      return fail(
        "setup",
        "the directory is writable by other users (and not sticky); use a private directory",
      );
    }
    await mkdir(work, { mode: 0o700 });
    const st = await lstat(work);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      (process.getuid && st.uid !== process.getuid()) ||
      (st.mode & 0o777) !== 0o700
    ) {
      return fail("setup", "the private directory is not private");
    }
  } catch (e) {
    return fail(
      "setup",
      `cannot create a private directory (${(e as NodeJS.ErrnoException).code ?? "error"})`,
    );
  }
  try {
    return await renderIn(work, req, lim);
  } catch (e) {
    return fail("setup", tidy((e as Error).message));
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

type Outcome =
  | { kind: "done"; code: number | null; signal: string | null; stderr: string }
  | { kind: RenderFailure; detail: string };

async function renderIn(
  work: string,
  req: RenderRequest,
  lim: RenderLimits,
): Promise<RenderResult> {
  // The input: a fixed-name file in the private directory, written fully, closed, reopened
  // read-only and handed over as fd 3 (it stays linked: re-opening /dev/fd/3 of an unlinked file
  // fails on some file systems).
  const inName = join(work, IN_NAME);
  const wfh = await open(
    inName,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    let off = 0;
    while (off < req.pdf.length) {
      const { bytesWritten } = await wfh.write(req.pdf, off, req.pdf.length - off, off);
      if (bytesWritten <= 0) throw new Error("short write of the input copy");
      off += bytesWritten;
    }
  } finally {
    await wfh.close();
  }
  const fh = await open(inName, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const dirs = toolDirs(req.seam);
  // pdftoppm applies -scale-to-x/-y before /Rotate: swap them for a page rotated 90 or 270
  const swap = req.tool.name === "pdftoppm" && (req.rotate === 90 || req.rotate === 270);
  const argv = swap
    ? toolArgv(req.tool.name, req.page, req.py, req.px)
    : toolArgv(req.tool.name, req.page, req.px, req.py);
  const script = limitScript(Math.floor(lim.maxOutputBytes / 512), lim.maxVirtualKb);
  const unshare = req.seam?.useUnshare === false ? undefined : await unshareAvailable();
  const file = unshare ?? SHELL;
  const fileArgs = [
    ...(unshare ? [...UNSHARE_FLAGS, SHELL] : []),
    "-c",
    script,
    req.tool.path,
    ...argv,
  ];
  try {
    const outcome = await new Promise<Outcome>((resolveRun) => {
      let settled = false;
      let child;
      try {
        child = spawn(file, fileArgs, {
          shell: false,
          cwd: work,
          env: minimalEnv(dirs, work),
          stdio: ["ignore", "pipe", "pipe", fh.fd],
          detached: true, // its own process group, so one kill reaches every descendant
          windowsHide: true,
        });
      } catch (e) {
        resolveRun({ kind: "spawn", detail: tidy((e as Error).message) });
        return;
      }
      const pid = child.pid;
      const killGroup = (): void => {
        if (pid !== undefined) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      };
      // SIGINT / SIGTERM / SIGHUP while the tool runs: kill the group, remove the directory,
      // then let the signal take its course.
      const handlers = new Map<NodeJS.Signals, () => void>();
      const dropSignals = (): void => {
        for (const [sig, h] of handlers) process.removeListener(sig, h);
        handlers.clear();
      };
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        const h = (): void => {
          killGroup();
          try {
            rmSync(work, { recursive: true, force: true });
          } catch {
            // best effort
          }
          dropSignals();
          process.kill(process.pid, sig);
        };
        handlers.set(sig, h);
        process.on(sig, h);
      }
      let stderr = "";
      let streamed = 0;
      let abort: { kind: RenderFailure; detail: string } | undefined;
      const end = (v: Outcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        dropSignals();
        killGroup(); // every path: a descendant that closed its stdio must not outlive the render
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolveRun(v);
      };
      const stop = (kind: RenderFailure, detail: string): void => {
        if (settled) return; // the group may be reaped and its pid reused
        abort ??= { kind, detail };
        killGroup();
        // a descendant that left the group could keep the pipes open: do not wait for 'close'
        setTimeout(() => end(abort as { kind: RenderFailure; detail: string }), 500).unref();
      };
      const drain =
        (keep: boolean) =>
        (chunk: Buffer): void => {
          streamed += chunk.length;
          if (keep && stderr.length < lim.maxStreamBytes) {
            stderr += chunk.toString("latin1").slice(0, lim.maxStreamBytes - stderr.length);
          }
          if (streamed > 2 * lim.maxStreamBytes)
            stop("output-too-large", "too much text on stdout/stderr");
        };
      child.stdout?.on("data", drain(false));
      child.stderr?.on("data", drain(true));
      const timer = setTimeout(
        () => stop("timeout", `no result after ${lim.timeoutMs} ms`),
        lim.timeoutMs,
      );
      const poll = setInterval(() => {
        void scanDir(work).then(({ bytes, entries, forbidden }) => {
          if (forbidden) stop("bad-output", forbidden);
          else if (bytes > lim.maxOutputBytes) {
            stop("output-too-large", `output over ${lim.maxOutputBytes} bytes`);
          } else if (entries > MAX_DIR_ENTRIES) stop("output-too-large", "too many files created");
        });
      }, POLL_MS);
      child.on("error", (e: NodeJS.ErrnoException) =>
        end({ kind: e.code === "ENOENT" ? "missing" : "spawn", detail: tidy(e.message) }),
      );
      child.on("close", (code, signal) => {
        end(abort ?? { kind: "done", code, signal, stderr });
      });
    });
    if (outcome.kind !== "done") return fail(outcome.kind, outcome.detail);
    if (outcome.signal === "SIGXFSZ") {
      return fail("output-too-large", "the tool hit the file size limit (SIGXFSZ)");
    }
    if (outcome.code !== 0) {
      return fail(
        "exit",
        `exit ${outcome.code ?? outcome.signal ?? "?"}${outcome.stderr ? `: ${tidy(outcome.stderr)}` : ""}`,
      );
    }
  } finally {
    await fh.close().catch(() => undefined);
  }
  const scan = await scanDir(work);
  if (scan.forbidden) return fail("bad-output", scan.forbidden);
  // The tool wrote `out.png` (pdftoppm: root "out" + ".png"; mutool: -o out.png).
  const r = await readFileSafe(work, OUT_NAME, lim.maxOutputBytes);
  if (!r.ok) {
    return fail(
      r.code === "image/not-found"
        ? "no-output"
        : r.code === "image/too-large"
          ? "output-too-large"
          : "bad-output",
      tidy(r.message),
    );
  }
  const size = pngSize(r.bytes);
  if (!size) return fail("bad-output", "the output is not a PNG");
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > lim.maxSide ||
    size.height > lim.maxSide ||
    size.width * size.height > lim.maxPixels
  ) {
    return fail("bad-output", `the output is ${size.width}x${size.height}, over the pixel cap`);
  }
  return {
    ok: true,
    png: r.bytes,
    width: size.width,
    height: size.height,
    sandbox: unshare ? "unshare" : "none",
  };
}
