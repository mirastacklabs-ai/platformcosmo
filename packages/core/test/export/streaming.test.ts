import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import type {
  RenderModel,
  RenderOptions,
  VideoEncoder,
  VideoSink,
} from "../../src/contracts/index.js";
import { createFfmpegEncoder, ffmpegAvailable } from "../../src/export/ffmpeg.js";
import { createGifEncoder, gifEncoder } from "../../src/export/gif.js";
import { exportOutputs, rasterize } from "../../src/export/index.js";
import { OutputTooLargeError } from "../../src/export/stream.js";
import { buildFixture, emit, withVariant } from "../anim/fixtures/render-model.js";

vi.setConfig({ testTimeout: 60_000 });

function depsWith(spy: () => void) {
  return {
    animator: createAnimator(),
    emit,
    optimize: (s: string) => s,
    rasterize: (async (svg, o) => {
      spy();
      return rasterize(svg, o);
    }) as typeof rasterize,
    withVariant,
  };
}

describe("streaming export (D33)", () => {
  test("a streaming encoder gets frames one at a time, never a batch", async () => {
    let rendered = 0;
    let written = 0;
    let peak = 0;
    let encodeCalls = 0;
    const encoder: VideoEncoder = {
      encode: async () => {
        encodeCalls++;
        return new Uint8Array();
      },
      open: (): VideoSink => ({
        write: async () => {
          written++;
          peak = Math.max(peak, rendered - written + 1);
        },
        finish: async () => new Uint8Array([written]),
        abort: () => undefined,
      }),
    };
    const r = await exportOutputs(
      buildFixture(),
      ["mp4"],
      depsWith(() => rendered++),
      { video: { fps: 4, durationSec: 3, encoder } },
    );
    expect(encodeCalls).toBe(0);
    expect(written).toBe(12);
    expect(peak).toBe(1); // a frame is handed over before the next one is rasterized
    expect((r.outputs[0]!.data as Uint8Array)[0]).toBe(12);
  });

  test("gif and mp4 at one rate share a single pass", async () => {
    let rendered = 0;
    const seen: Record<string, number> = { gif: 0, mp4: 0 };
    const mp4: VideoEncoder = {
      encode: async () => new Uint8Array(),
      open: (): VideoSink => ({
        write: async () => {
          seen.mp4!++;
        },
        finish: async () => new Uint8Array([1]),
        abort: () => undefined,
      }),
    };
    const r = await exportOutputs(
      buildFixture(),
      ["gif", "mp4"],
      depsWith(() => rendered++),
      { video: { fps: 4, durationSec: 2, encoder: mp4 } },
    );
    expect(r.outputs.map((o) => o.kind)).toEqual(["gif", "mp4"]);
    expect(seen.mp4).toBe(8);
    expect(rendered).toBeLessThanOrEqual(8);
  });

  test("a failing sink aborts, reports, and leaves the other output intact", async () => {
    let aborted = 0;
    const mp4: VideoEncoder = {
      encode: async () => new Uint8Array(),
      open: (): VideoSink => ({
        write: async () => {
          throw new Error("ffmpeg exited with 1: boom");
        },
        finish: async () => new Uint8Array(),
        abort: () => {
          aborted++;
        },
      }),
    };
    const r = await exportOutputs(
      buildFixture(),
      ["gif", "mp4"],
      depsWith(() => undefined),
      { video: { fps: 2, durationSec: 1, encoder: mp4 } },
    );
    expect(r.outputs.map((o) => o.kind)).toEqual(["gif"]);
    expect(aborted).toBe(1);
    expect(r.diagnostics[0]).toMatchObject({ code: "export/encode-failed" });
    expect(r.diagnostics[0]!.message).toContain("boom");
  });

  test("streamed gif is byte-identical to encoding the whole frame list", async () => {
    const frames: Uint8Array[] = [];
    const capture = depsWith(() => undefined);
    const raster: typeof rasterize = async (svg, o) => {
      const png = await capture.rasterize(svg, o);
      frames.push(png);
      return png;
    };
    const options: RenderOptions = { video: { fps: 4, durationSec: 2 } };
    const a = await exportOutputs(
      buildFixture(),
      ["gif"],
      { ...capture, rasterize: raster },
      options,
    );
    const b = await exportOutputs(buildFixture(), ["gif"], capture, options);
    expect(a.outputs[0]!.data).toEqual(b.outputs[0]!.data);
    const { width, height } = await import("../../src/export/png.js").then((m) =>
      m.pngSize(frames[0]!),
    );
    const whole = await gifEncoder.encode(frames, { fps: 4, width, height, format: "gif" });
    expect(a.outputs[0]!.data).toEqual(whole);
  });

  test("limits: oversized frame and more than 120 s are errors with a hint", async () => {
    const big: RenderModel = {
      ...buildFixture(),
      viewBox: { x: 0, y: 0, width: 12000, height: 6000 },
    };
    const d = depsWith(() => undefined);
    const frame = await exportOutputs(big, ["gif"], d, { video: { fps: 1, durationSec: 1 } });
    expect(frame.outputs).toHaveLength(0);
    expect(frame.diagnostics[0]).toMatchObject({ code: "export/too-large", severity: "error" });
    expect(frame.diagnostics[0]!.suggestion).toMatch(/scale|diagram/);

    const long = await exportOutputs(buildFixture(), ["gif"], d, {
      video: { fps: 1, durationSec: 121 },
    });
    expect(long.outputs).toHaveLength(0);
    expect(long.diagnostics[0]).toMatchObject({
      code: "options/invalid-video-duration",
      severity: "error",
    });
  });

  test("an encoder without open keeps the whole-clip 1 GiB cap", async () => {
    let rendered = 0;
    const model: RenderModel = {
      ...buildFixture(),
      viewBox: { x: 0, y: 0, width: 4000, height: 3000 }, // 48 MB a frame, 24 frames > 1 GiB
    };
    const encoder: VideoEncoder = { encode: async () => new Uint8Array([1]) };
    const r = await exportOutputs(
      model,
      ["mp4"],
      depsWith(() => rendered++),
      { video: { fps: 24, durationSec: 1, encoder } },
    );
    expect(rendered).toBe(0);
    expect(r.outputs).toHaveLength(0);
    expect(r.diagnostics[0]).toMatchObject({ code: "export/too-large" });
    expect(r.diagnostics[0]!.message).toContain("whole clip");
  });

  test("output cap: a sink reporting an oversized result becomes export/too-large", async () => {
    const encoder: VideoEncoder = {
      encode: async () => new Uint8Array(),
      open: (): VideoSink => ({
        write: async () => undefined,
        finish: async () => {
          throw new OutputTooLargeError(2048, 1024);
        },
        abort: () => undefined,
      }),
    };
    const r = await exportOutputs(
      buildFixture(),
      ["mp4"],
      depsWith(() => undefined),
      { video: { fps: 1, durationSec: 1, encoder } },
    );
    expect(r.outputs).toHaveLength(0);
    expect(r.diagnostics[0]).toMatchObject({ code: "export/too-large", severity: "error" });
  });

  test("gif encoder enforces an injected output cap while writing", async () => {
    const frames: Uint8Array[] = [];
    const d = depsWith(() => undefined);
    await exportOutputs(
      buildFixture(),
      ["png"],
      { ...d, rasterize: async (s, o) => (frames.push(await rasterize(s, o)), frames[0]!) },
      { png: { scale: 1 } },
    );
    const png = frames[0]!;
    const { pngSize } = await import("../../src/export/png.js");
    const { width, height } = pngSize(png);
    const sink = createGifEncoder(50).open!({ fps: 1, width, height, format: "gif" }) as VideoSink;
    await expect(sink.write(png)).rejects.toBeInstanceOf(OutputTooLargeError);
  });
});

describe("ffmpeg abort, hang and output cap", () => {
  type Proc = EventEmitter & {
    stdin: EventEmitter & { write: (b: Uint8Array) => boolean; end: () => void };
    stderr: EventEmitter;
    kill: (sig?: string) => boolean;
  };
  /** `exitOnKill`: a real process dies on SIGKILL; a hung fake never does. */
  function proc(opts: { exitOnKill: boolean; backpressure?: boolean; outBytes?: number }) {
    let outPath = "";
    const p = new EventEmitter() as Proc;
    p.stdin = Object.assign(new EventEmitter(), {
      write: () => !opts.backpressure,
      end: () => {
        if (opts.outBytes !== undefined) writeFileSync(outPath, Buffer.alloc(opts.outBytes));
        setImmediate(() => p.emit("close", 0));
      },
    });
    p.stderr = new EventEmitter();
    p.kill = () => {
      if (opts.exitOnKill) setImmediate(() => p.emit("close", null));
      return true;
    };
    const spawn = ((_bin: string, args: string[]) => {
      outPath = args.at(-1)!;
      return p;
    }) as never;
    return { spawn, dir: () => dirname(outPath) };
  }
  const o = { fps: 1, width: 2, height: 2, format: "mp4" } as const;

  test("abort on a live ffmpeg waits for its exit, removes the temp dir, never rejects", async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      const f = proc({ exitOnKill: true });
      const sink = await createFfmpegEncoder({ spawn: f.spawn }).open!(o);
      await sink.write(new Uint8Array(4));
      expect(existsSync(f.dir())).toBe(true);
      await sink.abort();
      expect(existsSync(f.dir())).toBe(false);
      await sink.abort(); // idempotent
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });

  test("a hung ffmpeg (stops reading, never exits) fails with a timeout and cleans up", async () => {
    const f = proc({ exitOnKill: false, backpressure: true });
    const sink = await createFfmpegEncoder({ spawn: f.spawn, timeoutMs: 50 }).open!(o);
    await expect(sink.write(new Uint8Array(4))).rejects.toThrow(/timed out/);
    await sink.abort();
    expect(existsSync(f.dir())).toBe(false);
  });

  test("padColor is validated", () => {
    for (const bad of ["white;rm", "#fff", "red:x=1", "", "Red1"]) {
      expect(() => createFfmpegEncoder({ padColor: bad })).toThrow(/padColor/);
    }
    expect(() => createFfmpegEncoder({ padColor: "white" })).not.toThrow();
    expect(() => createFfmpegEncoder({ padColor: "#A0b1C2" })).not.toThrow();
  });

  test("ffmpegAvailable gives up on a probe that never exits", async () => {
    const kill = vi.fn();
    const hung = Object.assign(new EventEmitter(), { kill });
    const ok = await ffmpegAvailable("ffmpeg", (() => hung) as never, 30);
    expect(ok).toBe(false);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("an OutputTooLargeError from a duplicated class is still export/too-large", async () => {
    class Dup extends Error {
      override name = "OutputTooLargeError";
      bytes = 5;
    }
    const encoder: VideoEncoder = {
      encode: async () => new Uint8Array(),
      open: (): VideoSink => ({
        write: async () => undefined,
        finish: async () => {
          throw new Dup("x");
        },
        abort: () => undefined,
      }),
    };
    const r = await exportOutputs(
      buildFixture(),
      ["mp4"],
      depsWith(() => undefined),
      { video: { fps: 1, durationSec: 1, encoder } },
    );
    expect(r.diagnostics[0]).toMatchObject({ code: "export/too-large" });
  });

  test("mp4 larger than the output cap is an OutputTooLargeError", async () => {
    const f = proc({ exitOnKill: true, outBytes: 50 });
    const sink = await createFfmpegEncoder({ spawn: f.spawn, maxOutputBytes: 10 }).open!(o);
    await sink.write(new Uint8Array(4));
    await expect(sink.finish()).rejects.toBeInstanceOf(OutputTooLargeError);
    expect(existsSync(f.dir())).toBe(false);
  });
});

describe("core ffmpeg streaming session", () => {
  function fakeProc() {
    const written: number[] = [];
    const p = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = Object.assign(new EventEmitter(), {
      write: (b: Uint8Array) => {
        written.push(b.length);
        return true;
      },
      end: () => setImmediate(() => p.emit("close", 0)),
    });
    p.stdin = stdin;
    p.stderr = new EventEmitter();
    p.kill = vi.fn();
    return { p, written };
  }

  test("writes each frame to stdin as it arrives", async () => {
    const { p, written } = fakeProc();
    const enc = createFfmpegEncoder({ spawn: (() => p) as never });
    const sink = await enc.open!({ fps: 1, width: 2, height: 2, format: "mp4" });
    await sink.write(new Uint8Array(5));
    await sink.write(new Uint8Array(7));
    expect(written).toEqual([5, 7]); // delivered before finish
    await expect(sink.finish()).rejects.toThrow(); // the fake never writes out.mp4
  });

  test("stderr tail and exit code reach the error; abort kills the process", async () => {
    const { p } = fakeProc();
    const enc = createFfmpegEncoder({ spawn: (() => p) as never });
    const sink = await enc.open!({ fps: 1, width: 2, height: 2, format: "mp4" });
    (p.stderr as EventEmitter).emit("data", Buffer.from("Invalid data found"));
    p.emit("close", 3);
    await expect(sink.write(new Uint8Array(1))).rejects.toThrow(/code 3: Invalid data found/);
    sink.abort();
  });
});
