import { UnsafePathError, writeInside } from "../fsafe.js";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  Diagnostic,
  FontMode,
  OutputKind,
  RenderOptions,
  VideoEncoder,
  VideoSink,
} from "@platformcosmo/core";
import { type Parsed, flag, num, parse, str } from "../args.js";
import { loadSpec, makeResolver, resolveTheme, specBaseName } from "../common.js";
import { type Ctx, EXIT, UsageError } from "../deps.js";
import { errorDiagnostic, formatDiagnostics, hasErrors, plural } from "../format.js";

export const BUILD_OPTIONS = {
  static: { type: "boolean" },
  steps: { type: "boolean" },
  interactive: { type: "boolean" },
  png: { type: "boolean" },
  gif: { type: "boolean" },
  mp4: { type: "boolean" },
  "no-animated": { type: "boolean" },
  theme: { type: "string" },
  font: { type: "string" },
  speed: { type: "string" },
  out: { type: "string", short: "o" },
  name: { type: "string" },
  scale: { type: "string" },
  time: { type: "string" },
  fps: { type: "string" },
  duration: { type: "string" },
  "no-optimize": { type: "boolean" },
  "id-prefix": { type: "string" },
  json: { type: "boolean" },
} as const;

export const HELP = `Usage: pcosmo build <spec> [options]

Renders a spec. By default writes <name>.svg (animated, looping, self-contained).
Output flags add to it:

  --static          <name>.static.svg   first frame, no animation
  --steps           <name>.steps/step-NN.svg   one SVG per step
  --interactive     <name>.interactive.svg   Play/Pause/Step (works only when inlined)
  --png             <name>.png
  --gif             <name>.gif   (animation frames; slow for long loops)
  --mp4             <name>.mp4   (needs ffmpeg on PATH)
  --no-animated     skip <name>.svg

Options:
  --theme <t>       light | dark | blueprint | mono | path to a theme JSON file
  --font <mode>     embed (default) | outline | system
  --speed <n>       animation speed multiplier, 0 < n <= 10 (default 1)
  -o, --out <dir>   output directory (default: the spec's directory)
  --name <name>     base file name (default: spec file name without .cosmo.json)
  --scale <n>       PNG scale (default 2)      --time <s>      PNG animation time (default 0)
  --fps <n>         gif/mp4 frame rate (24)    --duration <s>  gif/mp4 length in seconds
  --no-optimize     skip the SVGO pass
  --id-prefix <p>   SVG id prefix, ^[a-z][a-z0-9-]{0,31}$ (default derived from the spec)
  --json            print a machine-readable result
  --packs-dir <dir> Icon pack directory (default: $CLAUDE_PLUGIN_DATA/icons or ~/.platformcosmo/icons)
  -h, --help        Show this help

Exit codes: 0 ok, 1 spec or render errors, 2 usage, 3 internal error.
`;

export interface BuildSettings {
  file: string;
  outputs: OutputKind[];
  themeArg?: string | undefined;
  font?: FontMode | undefined;
  speed?: number | undefined;
  outDir: string;
  name: string;
  scale?: number | undefined;
  time?: number | undefined;
  fps?: number | undefined;
  duration?: number | undefined;
  optimize: boolean;
  idPrefix?: string | undefined;
  json: boolean;
}

export function settingsFrom(ctx: Ctx, p: Parsed): BuildSettings {
  if (p.positionals.length !== 1) throw new UsageError("build needs exactly one spec file");
  const file = p.positionals[0]!;
  const outputs: OutputKind[] = [];
  if (!flag(p, "no-animated")) outputs.push("animated");
  for (const k of ["static", "steps", "interactive", "png", "gif", "mp4"] as const) {
    if (flag(p, k)) outputs.push(k);
  }
  if (outputs.length === 0)
    throw new UsageError("--no-animated needs at least one other output flag");
  const font = str(p, "font");
  if (font !== undefined && font !== "embed" && font !== "outline" && font !== "system") {
    throw new UsageError("--font must be embed, outline or system");
  }
  const out = str(p, "out");
  return {
    file,
    outputs,
    themeArg: str(p, "theme"),
    font: font as FontMode | undefined,
    speed: num(p, "speed"),
    outDir: out ? resolve(ctx.deps.cwd, out) : dirname(resolve(ctx.deps.cwd, file)),
    name: str(p, "name") ?? specBaseName(file),
    scale: num(p, "scale"),
    time: num(p, "time"),
    fps: num(p, "fps"),
    duration: num(p, "duration"),
    optimize: !flag(p, "no-optimize"),
    idPrefix: str(p, "id-prefix"),
    json: flag(p, "json"),
  };
}

/** True when `path` (from a render output) is relative and stays inside `dir`. */
export function isInside(dir: string, path: string): boolean {
  if (isAbsolute(path) || path.includes("\0")) return false;
  const rel = relative(dir, resolve(dir, path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}

/** One build. Returns an exit code; all reporting goes through `ctx`. */
export async function buildOnce(ctx: Ctx, s: BuildSettings): Promise<number> {
  const diagnostics: Diagnostic[] = [];
  const { spec, diagnostics: parseDiag } = await loadSpec(ctx, s.file);
  diagnostics.push(...parseDiag);
  const written: { kind: string; path: string; bytes: number }[] = [];
  const stats: { elements?: number } = {};

  const finish = (code: number): number => {
    if (s.json) {
      ctx.out(
        `${JSON.stringify({ file: s.file, ok: code === EXIT.ok, outputs: written, elements: stats.elements, diagnostics }, null, 2)}\n`,
      );
    } else {
      if (diagnostics.length > 0) ctx.err(formatDiagnostics(diagnostics, s.file));
      for (const w of written) ctx.out(`wrote ${w.path} (${w.bytes} bytes)\n`);
      if (code !== EXIT.ok)
        ctx.err(
          `build failed: ${plural(diagnostics.filter((d) => d.severity === "error").length, "error")}\n`,
        );
    }
    return code;
  };

  if (hasErrors(parseDiag) || spec === undefined) return finish(EXIT.failed);

  const options: { -readonly [K in keyof RenderOptions]: RenderOptions[K] } = {
    outputs: s.outputs,
    name: s.name,
    optimize: s.optimize,
  };
  if (ctx.deps.themes) options.themes = ctx.deps.themes;
  if (ctx.deps.dcPack) options.dc = ctx.deps.dcPack;
  if (s.themeArg !== undefined) {
    const t = await resolveTheme(ctx, s.themeArg);
    diagnostics.push(...t.diagnostics);
    if (!t.theme || hasErrors(t.diagnostics)) return finish(EXIT.failed);
    options.theme = t.theme;
  }
  const { resolver, diagnostics: packDiag } = await makeResolver(ctx);
  diagnostics.push(...packDiag);
  options.icons = resolver;
  if (s.font) options.font = s.font;
  if (s.speed !== undefined) options.speed = s.speed;
  if (s.idPrefix !== undefined) options.idPrefix = s.idPrefix;
  if (s.scale !== undefined || s.time !== undefined) {
    options.png = {
      ...(s.scale === undefined ? {} : { scale: s.scale }),
      ...(s.time === undefined ? {} : { time: s.time }),
    };
  }
  if (s.outputs.includes("gif") || s.outputs.includes("mp4")) {
    let encoder = ctx.deps.core.gifEncoder;
    if (s.outputs.includes("mp4")) {
      encoder = await ctx.deps.createMp4Encoder();
      if (!encoder) {
        diagnostics.push(
          errorDiagnostic(
            "export/ffmpeg-missing",
            "--mp4 needs ffmpeg, which was not found on PATH",
            "install ffmpeg, or use --gif",
          ),
        );
        return finish(EXIT.failed);
      }
    }
    options.video = {
      ...(s.fps === undefined ? {} : { fps: s.fps }),
      ...(s.duration === undefined ? {} : { durationSec: s.duration }),
      ...(encoder ? { encoder: abortableEncoder(encoder, ctx.deps.signal) } : {}),
    };
  }

  const result = await ctx.deps.core.render(spec, options);
  diagnostics.push(...result.diagnostics);
  stats.elements = result.stats.elements;
  if (hasErrors(diagnostics)) return finish(EXIT.failed);

  for (const o of result.outputs) {
    if (!isInside(s.outDir, o.path)) {
      diagnostics.push(
        errorDiagnostic(
          "cli/unsafe-output-path",
          `refusing to write outside the output directory: ${o.path}`,
        ),
      );
      return finish(EXIT.failed);
    }
  }
  for (const o of result.outputs) {
    let full: string;
    try {
      full = await writeInside(s.outDir, o.path, o.data);
    } catch (e) {
      if (!(e instanceof UnsafePathError)) throw e;
      diagnostics.push(
        errorDiagnostic("cli/unsafe-output-path", `refusing to write ${o.path}: ${e.message}`),
      );
      return finish(EXIT.failed);
    }
    written.push({
      kind: o.kind,
      path: full,
      bytes: typeof o.data === "string" ? Buffer.byteLength(o.data) : o.data.byteLength,
    });
  }
  return finish(EXIT.ok);
}

/**
 * Ties streaming sinks to the process signal (Ctrl-C / SIGTERM): an interrupt aborts every open
 * sink at once (ffmpeg is killed, temp directories removed) and later writes fail fast.
 */
export function abortableEncoder(enc: VideoEncoder, signal?: AbortSignal): VideoEncoder {
  const open = enc.open;
  if (!signal || !open) return enc;
  const live = new Set<VideoSink>();
  // One listener while any sink is live; none otherwise, so `watch` rebuilds on the shared
  // signal never accumulate listeners.
  const onAbort = (): void => {
    for (const s of live) void Promise.resolve(s.abort()).catch(() => undefined);
    live.clear();
  };
  const track = (s: VideoSink): void => {
    if (live.size === 0) signal.addEventListener("abort", onAbort, { once: true });
    live.add(s);
  };
  const untrack = (s: VideoSink): void => {
    live.delete(s);
    if (live.size === 0) signal.removeEventListener("abort", onAbort);
  };
  const interrupted = (): Error => new Error("interrupted");
  return {
    encode: (frames, o) => enc.encode(frames, o),
    open: async (o) => {
      if (signal.aborted) throw interrupted();
      const sink = await open.call(enc, o);
      if (signal.aborted) {
        await sink.abort();
        throw interrupted();
      }
      track(sink);
      return {
        write: async (frame) => {
          if (signal.aborted) throw interrupted();
          await sink.write(frame);
        },
        finish: async () => {
          if (signal.aborted) throw interrupted();
          try {
            return await sink.finish();
          } finally {
            untrack(sink);
          }
        },
        abort: async () => {
          untrack(sink);
          await sink.abort();
        },
      };
    },
  };
}

export async function buildCommand(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, BUILD_OPTIONS);
  return buildOnce(ctx, settingsFrom(ctx, p));
}
