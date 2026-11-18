import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoEncoder } from "@platformcosmo/core";

type Spawn = (cmd: string, args: string[]) => ChildProcess;

/** ffmpeg arguments: PNG frames on stdin → H.264 mp4 file (even dimensions, yuv420p). */
export function ffmpegArgs(fps: number, outFile: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(fps),
    "-i",
    "-",
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outFile,
  ];
}

function run(spawn: Spawn, args: string[], input?: readonly Uint8Array[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with ${code}: ${stderr.trim().slice(0, 500)}`)),
    );
    const stdin = child.stdin;
    if (!stdin) return;
    stdin.on("error", () => undefined); // surfaced through the exit code
    for (const f of input ?? []) stdin.write(f);
    stdin.end();
  });
}

/** Returns an ffmpeg-backed mp4 encoder, or undefined when ffmpeg is not on PATH. */
export async function createFfmpegEncoder(
  spawn: Spawn = nodeSpawn,
): Promise<VideoEncoder | undefined> {
  try {
    await run(spawn, ["-version"]);
  } catch {
    return undefined;
  }
  return {
    async encode(frames, options) {
      const dir = await mkdtemp(join(tmpdir(), "pcosmo-"));
      const out = join(dir, "out.mp4");
      try {
        await run(spawn, ffmpegArgs(options.fps, out), frames);
        return new Uint8Array(await readFile(out));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
