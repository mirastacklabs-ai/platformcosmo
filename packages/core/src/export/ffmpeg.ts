/**
 * ffmpeg-backed `VideoEncoder` for mp4 (Node only). The CLI builds one and passes it as
 * `RenderOptions.video.encoder`; core itself never spawns processes. Output depends on the
 * system ffmpeg, so mp4 is the one output that is not byte-reproducible. Frames are streamed
 * into ffmpeg's stdin one at a time (D33), so memory is bounded by one frame.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoEncoder, VideoSink } from "../contracts/index.js";
import { MAX_OUTPUT_BYTES, OutputTooLargeError } from "./stream.js";

export interface FfmpegEncoderOptions {
  /** Executable name or path, default `ffmpeg`. */
  readonly ffmpegPath?: string;
  /** x264 quality, default 18 (visually lossless for flat diagrams). */
  readonly crf?: number;
  /** Kill ffmpeg and fail after this many ms, default 10 minutes. */
  readonly timeoutMs?: number;
  /** Pad colour for odd frame sizes, e.g. `white` (the CLI uses it for light diagrams). */
  readonly padColor?: string;
  /** Fail with `export/too-large` when the mp4 is bigger than this, default 1 GiB. */
  readonly maxOutputBytes?: number;
  /** Injection point for tests. */
  readonly spawn?: typeof nodeSpawn;
}

/** Arguments for PNG frames on stdin to an H.264 mp4 file. */
export function buildFfmpegArgs(opts: {
  readonly fps: number;
  readonly outPath: string;
  readonly crf: number;
  /** Colour of the 1 px pad that makes odd sizes even (ffmpeg colour name), default ffmpeg black. */
  readonly padColor?: string;
}): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(opts.fps),
    "-c:v",
    "png",
    "-i",
    "pipe:0",
    // yuv420p needs even dimensions
    "-vf",
    `pad=ceil(iw/2)*2:ceil(ih/2)*2${opts.padColor ? `:color=${opts.padColor}` : ""}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    String(opts.crf),
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-flags:v",
    "+bitexact",
    "-movflags",
    "+faststart",
    opts.outPath,
  ];
}

export function createFfmpegEncoder(options: FfmpegEncoderOptions = {}): VideoEncoder {
  const bin = options.ffmpegPath ?? "ffmpeg";
  const spawn = options.spawn ?? nodeSpawn;
  const crf = options.crf ?? 18;
  if (!Number.isFinite(crf) || crf < 0 || crf > 51) throw new Error("ffmpeg crf must be in 0..51");
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxOutput = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const open: NonNullable<VideoEncoder["open"]> = async (o) => {
    if (o.format !== "mp4") {
      throw new Error(`the ffmpeg encoder only produces mp4, not ${o.format}`);
    }
    const dir = await mkdtemp(join(tmpdir(), "pcosmo-"));
    const outPath = join(dir, "out.mp4");
    const session = startFfmpeg(
      spawn,
      bin,
      buildFfmpegArgs({
        fps: o.fps,
        outPath,
        crf,
        ...(options.padColor ? { padColor: options.padColor } : {}),
      }),
      timeoutMs,
    );
    const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
    const sink: VideoSink = {
      write: (frame) => session.write(frame),
      async finish() {
        try {
          await session.end();
          const size = (await stat(outPath)).size;
          if (size > maxOutput) throw new OutputTooLargeError(size, maxOutput);
          return new Uint8Array(await readFile(outPath));
        } finally {
          await cleanup();
        }
      },
      async abort() {
        // Wait for ffmpeg to be gone before removing its output directory.
        await session.kill().catch(() => undefined);
        await cleanup().catch(() => undefined);
      },
    };
    return sink;
  };
  return {
    open,
    async encode(frames, o) {
      const sink = await open(o);
      try {
        for (const f of frames) await sink.write(f);
        return await sink.finish();
      } catch (e) {
        await sink.abort();
        throw e;
      }
    },
  };
}

/** True when `ffmpeg -version` runs. */
export async function ffmpegAvailable(
  ffmpegPath = "ffmpeg",
  spawn: typeof nodeSpawn = nodeSpawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ["-version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}

interface FfmpegSession {
  /** Resolves when the frame was accepted (after `drain` under backpressure). */
  write(frame: Uint8Array): Promise<void>;
  /** Closes stdin and resolves on exit code 0. */
  end(): Promise<void>;
  /** SIGKILLs ffmpeg and resolves once it has exited (or after a short grace period). */
  kill(): Promise<void>;
}

function startFfmpeg(
  spawn: typeof nodeSpawn,
  bin: string,
  args: readonly string[],
  timeoutMs: number,
): FfmpegSession {
  const p = spawn(bin, [...args], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  let failure: Error | undefined;
  let exited = false;
  let exitCode: number | null | undefined;
  const waiters: (() => void)[] = [];
  const settle = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  const timer = setTimeout(() => {
    failure ??= new Error(`ffmpeg timed out after ${timeoutMs} ms`);
    p.kill("SIGKILL");
    settle();
  }, timeoutMs);
  p.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  p.on("error", (e: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    exited = true;
    failure ??=
      e.code === "ENOENT"
        ? new Error(`ffmpeg not found (${bin}); install it or point to it with its path option`)
        : e;
    settle();
  });
  p.on("close", (code) => {
    clearTimeout(timer);
    exited = true;
    exitCode = code;
    if (code !== 0) {
      failure ??= new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`);
    }
    settle();
  });
  const stdin = p.stdin;
  if (!stdin) {
    clearTimeout(timer);
    p.kill("SIGKILL");
    failure = new Error("ffmpeg stdin unavailable");
  } else {
    stdin.on("error", () => undefined); // surfaced through the exit code
  }
  const wait = (): Promise<void> => new Promise<void>((r) => waiters.push(r));
  const kill = async (): Promise<void> => {
    clearTimeout(timer);
    if (exited) return;
    const gone = new Promise<void>((r) => waiters.push(r));
    p.kill("SIGKILL");
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      gone,
      new Promise<void>((r) => {
        grace = setTimeout(r, 2000);
      }),
    ]);
    clearTimeout(grace);
  };
  return {
    async write(frame) {
      if (failure) throw failure;
      if (exited) throw new Error(`ffmpeg exited early with code ${exitCode}: ${stderr.trim()}`);
      if (!stdin!.write(frame)) {
        // Wake on drain or when the process goes away, so a dead ffmpeg cannot hang the writer.
        await new Promise<void>((r) => {
          const done = (): void => {
            stdin!.off("drain", done);
            const i = waiters.indexOf(done);
            if (i >= 0) waiters.splice(i, 1);
            r();
          };
          stdin!.once("drain", done);
          waiters.push(done);
        });
        if (failure) {
          void kill();
          throw failure;
        }
      }
    },
    async end() {
      if (failure) {
        await kill();
        throw failure;
      }
      if (!exited) {
        const closed = wait();
        stdin!.end();
        await closed;
      }
      clearTimeout(timer);
      if (failure) throw failure;
    },
    kill,
  };
}
