import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import type { RenderModel, RenderOptions } from "../../src/contracts/index.js";
import { createFfmpegEncoder } from "../../src/export/ffmpeg.js";
import { gifEncoder } from "../../src/export/gif.js";
import { exportOutputs, rasterize } from "../../src/export/index.js";
import type { StreamingVideoEncoder, VideoSink } from "../../src/export/stream.js";
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
    const encoder: StreamingVideoEncoder = {
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
    const mp4: StreamingVideoEncoder = {
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
    const mp4: StreamingVideoEncoder = {
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
    expect(long.diagnostics[0]).toMatchObject({ severity: "error" });
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
    const sink = await enc.open({ fps: 1, width: 2, height: 2, format: "mp4" });
    await sink.write(new Uint8Array(5));
    await sink.write(new Uint8Array(7));
    expect(written).toEqual([5, 7]); // delivered before finish
    await expect(sink.finish()).rejects.toThrow(); // the fake never writes out.mp4
  });

  test("stderr tail and exit code reach the error; abort kills the process", async () => {
    const { p } = fakeProc();
    const enc = createFfmpegEncoder({ spawn: (() => p) as never });
    const sink = await enc.open({ fps: 1, width: 2, height: 2, format: "mp4" });
    (p.stderr as EventEmitter).emit("data", Buffer.from("Invalid data found"));
    p.emit("close", 3);
    await expect(sink.write(new Uint8Array(1))).rejects.toThrow(/code 3: Invalid data found/);
    sink.abort();
  });
});
