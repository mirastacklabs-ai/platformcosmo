/**
 * ffmpeg-backed `VideoEncoder` for mp4 (Node only). The CLI builds one and passes it as
 * `RenderOptions.video.encoder`; core itself never spawns processes. Output depends on the
 * system ffmpeg, so mp4 is the one output that is not byte-reproducible.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoEncoder } from "../contracts/index.js";

export interface FfmpegEncoderOptions {
  /** Executable name or path, default `ffmpeg`. */
  readonly ffmpegPath?: string;
  /** x264 quality, default 18 (visually lossless for flat diagrams). */
  readonly crf?: number;
  /** Kill ffmpeg and fail after this many ms, default 10 minutes. */
  readonly timeoutMs?: number;
  /** Injection point for tests. */
  readonly spawn?: typeof nodeSpawn;
}

/** Arguments for PNG frames on stdin to an H.264 mp4 file. */
export function buildFfmpegArgs(opts: {
  readonly fps: number;
  readonly outPath: string;
  readonly crf: number;
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
    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
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
  return {
    async encode(frames, o) {
      if (o.format !== "mp4") {
        throw new Error(`the ffmpeg encoder only produces mp4, not ${o.format}`);
      }
      const dir = await mkdtemp(join(tmpdir(), "pcosmo-"));
      const outPath = join(dir, "out.mp4");
      try {
        await run(spawn, bin, buildFfmpegArgs({ fps: o.fps, outPath, crf }), frames, timeoutMs);
        return new Uint8Array(await readFile(outPath));
      } finally {
        await rm(dir, { recursive: true, force: true });
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

function run(
  spawn: typeof nodeSpawn,
  bin: string,
  args: readonly string[],
  frames: readonly Uint8Array[],
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, [...args], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let closed = false;
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    p.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    p.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      closed = true;
      reject(
        e.code === "ENOENT"
          ? new Error(`ffmpeg not found (${bin}); install it or point to it with its path option`)
          : e,
      );
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      closed = true;
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
    const stdin = p.stdin;
    if (!stdin) {
      clearTimeout(timer);
      reject(new Error("ffmpeg stdin unavailable"));
      return;
    }
    stdin.on("error", () => undefined); // surfaced through the exit code
    void (async () => {
      for (const f of frames) {
        if (closed) return;
        if (!stdin.write(f)) {
          // Wake on drain or when the process goes away, so a dead ffmpeg cannot hang the writer.
          await new Promise<void>((r) => {
            const done = () => {
              stdin.off("drain", done);
              p.off("close", done);
              r();
            };
            stdin.once("drain", done);
            p.once("close", done);
          });
        }
      }
      if (!closed) stdin.end();
    })();
  });
}
