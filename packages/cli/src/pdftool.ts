/**
 * The optional external PDF renderer for `pcosmo assets pdf render` (ingestion §3, §13): `pdftoppm`
 * (poppler) or `mutool` (MuPDF). The renderer is the one place where the CLI runs somebody else's
 * code on an untrusted PDF, so everything about the call is fixed here and nothing in it comes from
 * the PDF or from a free-form option:
 *
 *   - no shell: `spawn(absolutePath, argv, { shell: false })`;
 *   - the argument list is a constant template; the only variable parts are two integers this
 *     module formats itself (the page number and the dpi), both range-checked by the caller;
 *   - the tool is found in a fixed list of directories (`DEFAULT_TOOL_DIRS`, or only the optional
 *     `PCOSMO_PDF_TOOLS_DIR` the user's own environment sets), never through the inherited PATH;
 *   - the environment is minimal: `PATH` (the search directories, then the fixed list), `LANG=C`, `HOME`/`TMPDIR` pointing
 *     into the private directory; nothing is inherited (no `LD_*`, `DYLD_*`, proxies, tokens);
 *   - the PDF is the safely read byte array, written into a fixed-name file in the
 *     private directory and handed over as descriptor 3 (`/dev/fd/3`); no path is passed;
 *   - the tool runs with the private directory as its working directory and writes one fixed
 *     relative name there (`out.png`); the directory is created `0700` with a random name below
 *     the allowed root and removed afterwards;
 *   - a timeout kills the whole process group (the child is a group leader), and so does exceeding
 *     the output cap, which a poll of the private directory enforces while the tool runs;
 *   - stdout and stderr are drained into bounded buffers (the child is killed past the cap);
 *   - afterwards the produced file is read through `readFileSafe` (no symlink, regular file, size
 *     cap), must start with the PNG signature and declare dimensions within the 16 MP cap before
 *     anything decodes it. Whatever else the tool left in the directory is ignored and removed.
 *
 * Residual: Node has no rlimit or sandbox, so a tool that is itself compromised can still act as
 * the user (read files, use the network) for the time it runs; the cap on its time, memory
 * (not limited), and output bound what it can leave behind, not what it can do. Windows is not
 * supported (no process groups, no `/dev/fd`).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, opendir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readFileSafe } from "./images.js";

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
  /** Size of the produced PNG. */
  readonly maxOutputBytes: number;
  /** Bytes kept from stdout / stderr each. */
  readonly maxStreamBytes: number;
  /** Output pixels (ingestion §14: 16 MP). */
  readonly maxPixels: number;
  /** Output pixels per side. */
  readonly maxSide: number;
}

export const RENDER_LIMITS: RenderLimits = Object.freeze({
  timeoutMs: 60_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxStreamBytes: 64 * 1024,
  maxPixels: 16_777_216,
  maxSide: 16_384,
});

export const DPI_RANGE = { min: 10, max: 1200, default: 150 } as const;
const OUT_NAME = "out.png";
const IN_NAME = "in";
const POLL_MS = 20;
const MAX_DIR_ENTRIES = 16;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The directories searched: the fixed list, or only `PCOSMO_PDF_TOOLS_DIR` when the user sets it
 * to an absolute path (for tests and for tools installed elsewhere). Never the inherited PATH.
 */
export function toolDirs(env: Env): string[] {
  const own = env.PCOSMO_PDF_TOOLS_DIR;
  return own !== undefined && own !== "" && isAbsolute(own) ? [own] : [...DEFAULT_TOOL_DIRS];
}

/** Absolute path of an executable regular file called `name` in `toolDirs`, or undefined. */
export async function findTool(env: Env, name: ToolName): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  for (const dir of toolDirs(env)) {
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
  env: Env,
  want?: ToolName,
): Promise<{ name: ToolName; path: string } | undefined> {
  for (const name of want === undefined ? TOOL_NAMES : [want]) {
    const path = await findTool(env, name);
    if (path !== undefined) return { name, path };
  }
  return undefined;
}

/** The fixed argument lists. `page` and `dpi` are integers the caller validated. */
export function toolArgv(tool: ToolName, page: number, dpi: number): string[] {
  const p = String(Math.trunc(page));
  const r = String(Math.trunc(dpi));
  return tool === "pdftoppm"
    ? ["-png", "-singlefile", "-cropbox", "-r", r, "-f", p, "-l", p, "/dev/fd/3", "out"]
    : ["draw", "-q", "-F", "png", "-r", r, "-o", OUT_NAME, "/dev/fd/3", p];
}

export function minimalEnv(env: Env, home: string): Record<string, string> {
  return {
    PATH: [...toolDirs(env), ...DEFAULT_TOOL_DIRS.filter((d) => !toolDirs(env).includes(d))].join(
      ":",
    ),
    LANG: "C",
    LC_ALL: "C",
    HOME: home,
    TMPDIR: home,
  };
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
  | { readonly ok: true; readonly png: Uint8Array; readonly width: number; readonly height: number }
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

/** True when `entries` (a bounded scan of the private directory) hold more than `cap` bytes. */
async function dirBytes(dir: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  try {
    for await (const e of await opendir(dir)) {
      entries++;
      if (entries > MAX_DIR_ENTRIES) break;
      try {
        const st = await lstat(join(dir, e.name));
        if (st.isFile() && e.name !== IN_NAME) bytes += st.size;
      } catch {
        // vanished
      }
    }
  } catch {
    // gone
  }
  return { bytes, entries };
}

export interface RenderRequest {
  readonly env: Env;
  /** The root the private directory is created below (already confined by the caller). */
  readonly rootDir: string;
  readonly tool: { readonly name: ToolName; readonly path: string };
  readonly pdf: Uint8Array;
  readonly page: number;
  readonly dpi: number;
  readonly limits?: Partial<RenderLimits>;
}

/** Runs the renderer once. Never throws. The private directory is always removed. */
export async function renderPage(req: RenderRequest): Promise<RenderResult> {
  if (process.platform === "win32") return fail("unsupported", "not supported on Windows");
  const lim: RenderLimits = { ...RENDER_LIMITS, ...req.limits };
  const work = join(req.rootDir, `.pcosmo-render-${randomBytes(8).toString("hex")}`);
  try {
    await mkdir(work, { mode: 0o700 });
  } catch (e) {
    return fail(
      "setup",
      `cannot create a private directory (${(e as NodeJS.ErrnoException).code})`,
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

async function renderIn(
  work: string,
  req: RenderRequest,
  lim: RenderLimits,
): Promise<RenderResult> {
  // The input: a file with a fixed name in the private directory, handed over as fd 3 (it stays
  // linked: re-opening /dev/fd/3 of an unlinked file fails on some file systems).
  const inName = join(work, IN_NAME);
  const fh = await open(
    inName,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await fh.write(req.pdf, 0, req.pdf.length, 0);
    const outcome = await new Promise<
      | { kind: "done"; code: number | null; signal: string | null; stderr: string }
      | { kind: RenderFailure; detail: string }
    >((resolveRun) => {
      let settled = false;
      let child;
      try {
        child = spawn(req.tool.path, toolArgv(req.tool.name, req.page, req.dpi), {
          shell: false,
          cwd: work,
          env: minimalEnv(req.env, work),
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
      let stderr = "";
      let streamed = 0;
      let abort: { kind: RenderFailure; detail: string } | undefined;
      const end = (v: Parameters<typeof resolveRun>[0]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        killGroup(); // stragglers of the group
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolveRun(v);
      };
      const stop = (kind: RenderFailure, detail: string): void => {
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
        void dirBytes(work).then(({ bytes, entries }) => {
          if (bytes > lim.maxOutputBytes) {
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
    if (outcome.code !== 0) {
      return fail(
        "exit",
        `exit ${outcome.code ?? outcome.signal ?? "?"}${outcome.stderr ? `: ${tidy(outcome.stderr)}` : ""}`,
      );
    }
  } finally {
    await fh.close().catch(() => undefined);
  }
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
  return { ok: true, png: r.bytes, width: size.width, height: size.height };
}
