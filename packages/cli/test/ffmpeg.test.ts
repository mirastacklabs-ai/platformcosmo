import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createFfmpegEncoder, ffmpegArgs } from "../src/ffmpeg.js";

function fakeSpawn(exit: number) {
  const calls: string[][] = [];
  const spawn = (_cmd: string, args: string[]): ChildProcess => {
    calls.push(args);
    const child = new EventEmitter() as ChildProcess;
    (child as unknown as { stderr: PassThrough }).stderr = new PassThrough();
    const stdin = new PassThrough();
    (child as unknown as { stdin: PassThrough }).stdin = stdin;
    stdin.on("finish", () => setImmediate(() => child.emit("close", exit)));
    if (args[0] === "-version") setImmediate(() => child.emit("close", exit));
    return child;
  };
  return { spawn, calls };
}

describe("ffmpeg", () => {
  test("args read PNG frames from stdin and write an even-sized yuv420p mp4", () => {
    const a = ffmpegArgs(24, "/o/out.mp4");
    expect(a).toContain("image2pipe");
    expect(a).toContain("yuv420p");
    expect(a.at(-1)).toBe("/o/out.mp4");
    expect(a[a.indexOf("-framerate") + 1]).toBe("24");
  });

  test("returns undefined when ffmpeg is missing", async () => {
    const { spawn } = fakeSpawn(1);
    expect(await createFfmpegEncoder(spawn)).toBeUndefined();
  });

  test("detects ffmpeg and surfaces encode failures", async () => {
    const { spawn, calls } = fakeSpawn(0);
    const enc = await createFfmpegEncoder(spawn);
    expect(enc).toBeDefined();
    expect(calls[0]).toEqual(["-version"]);
    // The fake never writes the output file, so reading it back fails.
    await expect(
      enc!.encode([new Uint8Array([1])], { fps: 24, width: 2, height: 2, format: "mp4" }),
    ).rejects.toThrow();
  });
});
