import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamingVideoEncoder, VideoSink } from "@platformcosmo/core";

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

/** Runs ffmpeg to completion (used for the `-version` probe). */
function probe(spawn: Spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-version"]);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    child.stdin?.end();
  });
}

interface Session {
  write(frame: Uint8Array): Promise<void>;
  end(): Promise<void>;
  kill(): void;
}

/**
 * One ffmpeg process fed frame by frame on stdin. `write` waits for `drain` (backpressure) and
 * rejects as soon as ffmpeg has failed; the error carries the exit code and the stderr tail.
 */
function startFfmpeg(spawn: Spawn, args: string[]): Session {
  const child = spawn("ffmpeg", args);
  let stderr = "";
  let failure: Error | undefined;
  let exited = false;
  const waiters: (() => void)[] = [];
  const wake = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  child.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  child.on("error", (e) => {
    exited = true;
    failure ??= e;
    wake();
  });
  child.on("close", (code) => {
    exited = true;
    if (code !== 0) failure ??= new Error(`ffmpeg exited with ${code}: ${stderr.trim()}`);
    wake();
  });
  const stdin = child.stdin;
  if (stdin)
    stdin.on("error", () => undefined); // surfaced through the exit code
  else failure = new Error("ffmpeg stdin unavailable");
  const kill = (): void => {
    if (!exited) child.kill("SIGKILL");
  };
  return {
    async write(frame) {
      if (failure) throw failure;
      if (exited) throw new Error(`ffmpeg exited early: ${stderr.trim()}`);
      if (!stdin!.write(frame)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            stdin!.off("drain", done);
            const i = waiters.indexOf(done);
            if (i >= 0) waiters.splice(i, 1);
            resolve();
          };
          stdin!.once("drain", done);
          waiters.push(done);
        });
        if (failure) {
          kill();
          throw failure;
        }
      }
    },
    async end() {
      if (failure) {
        kill();
        throw failure;
      }
      if (!exited) {
        const closed = new Promise<void>((r) => waiters.push(r));
        stdin!.end();
        await closed;
      }
      if (failure) throw failure;
    },
    kill,
  };
}

/** Returns an ffmpeg-backed mp4 encoder (streams frames), or undefined when ffmpeg is not on PATH. */
export async function createFfmpegEncoder(
  spawn: Spawn = nodeSpawn,
): Promise<StreamingVideoEncoder | undefined> {
  try {
    await probe(spawn);
  } catch {
    return undefined;
  }
  const open: StreamingVideoEncoder["open"] = async (options) => {
    const dir = await mkdtemp(join(tmpdir(), "pcosmo-"));
    const out = join(dir, "out.mp4");
    const session = startFfmpeg(spawn, ffmpegArgs(options.fps, out));
    const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });
    const sink: VideoSink = {
      write: (frame) => session.write(frame),
      async finish() {
        try {
          await session.end();
          return new Uint8Array(await readFile(out));
        } finally {
          await cleanup();
        }
      },
      abort() {
        session.kill();
        void cleanup();
      },
    };
    return sink;
  };
  return {
    open,
    async encode(frames, options) {
      const sink = await open(options);
      try {
        for (const f of frames) await sink.write(f);
        return await sink.finish();
      } catch (e) {
        sink.abort();
        throw e;
      }
    },
  };
}
