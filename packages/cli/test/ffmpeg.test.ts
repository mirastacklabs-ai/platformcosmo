import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
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

/** Fake ffmpeg that consumes stdin, counts the bytes and writes a stub output file on exit. */
function consumingSpawn(exit = 0, stderrText = "") {
  const state = { bytes: 0, frames: 0 };
  const spawn = (_cmd: string, args: string[]): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    const stderr = new PassThrough();
    (child as unknown as { stderr: PassThrough }).stderr = stderr;
    const stdin = new PassThrough();
    (child as unknown as { stdin: PassThrough }).stdin = stdin;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    if (args[0] === "-version") {
      setImmediate(() => child.emit("close", 0));
      return child;
    }
    stdin.on("data", (d: Buffer) => {
      state.bytes += d.length;
      state.frames++;
    });
    stdin.on("finish", () =>
      setImmediate(() => {
        void (async () => {
          if (stderrText) stderr.write(stderrText);
          if (exit === 0) await writeFile(args.at(-1)!, Buffer.from("mp4!"));
          child.emit("close", exit);
        })();
      }),
    );
    return child;
  };
  return { spawn, state };
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

describe("ffmpeg streaming (D33)", () => {
  test("open() pipes every frame to stdin as written and returns the file", async () => {
    const { spawn, state } = consumingSpawn();
    const enc = (await createFfmpegEncoder(spawn))!;
    const sink = await enc.open({ fps: 24, width: 4, height: 4, format: "mp4" });
    const frame = new Uint8Array(1000);
    for (let i = 0; i < 336; i++) await sink.write(frame);
    const out = await sink.finish();
    expect(state.bytes).toBe(336 * 1000);
    expect(new TextDecoder().decode(out)).toBe("mp4!");
  });

  test("encode() of a frame list goes through the same stream", async () => {
    const { spawn, state } = consumingSpawn();
    const enc = (await createFfmpegEncoder(spawn))!;
    const out = await enc.encode([new Uint8Array(10), new Uint8Array(20)], {
      fps: 24,
      width: 4,
      height: 4,
      format: "mp4",
    });
    expect(state.bytes).toBe(30);
    expect(out.length).toBe(4);
  });

  test("a failing ffmpeg reports exit code and stderr tail", async () => {
    const { spawn } = consumingSpawn(1, "Invalid argument");
    const enc = (await createFfmpegEncoder(spawn))!;
    const sink = await enc.open({ fps: 24, width: 4, height: 4, format: "mp4" });
    await sink.write(new Uint8Array(10));
    await expect(sink.finish()).rejects.toThrow(/ffmpeg exited with 1: Invalid argument/);
  });
});
