import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test, vi } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import type { RenderModel, RenderOptions, VideoEncoder } from "../../src/contracts/index.js";
import { buildFfmpegArgs, createFfmpegEncoder } from "../../src/export/ffmpeg.js";
import { gifEncoder } from "../../src/export/gif.js";
import { exportOutputs, rasterize } from "../../src/export/index.js";
import { validateRenderOptions } from "../../src/export/options.js";
import { pngSize } from "../../src/export/png.js";
import { buildFixture, emit, withVariant } from "../anim/fixtures/render-model.js";

vi.setConfig({ testTimeout: 60_000 });

function depsWith(spy?: () => void) {
  return {
    animator: createAnimator(),
    emit,
    optimize: (s: string) => s,
    rasterize: (async (svg, o) => {
      spy?.();
      return rasterize(svg, o);
    }) as typeof rasterize,
    withVariant,
  };
}
const run = (
  kinds: Parameters<typeof exportOutputs>[1],
  options: RenderOptions = {},
  model: RenderModel = buildFixture(),
  spy?: () => void,
) => exportOutputs(model, kinds, depsWith(spy), options);

describe("validateRenderOptions", () => {
  const codes = (o: RenderOptions) => validateRenderOptions(o).map((d) => d.code);

  test("valid and empty options", () => {
    expect(validateRenderOptions(undefined)).toEqual([]);
    expect(
      validateRenderOptions({
        name: "a.b_c-1",
        idPrefix: "pc-x",
        speed: 10,
        png: { scale: 8 },
        video: { fps: 60, durationSec: 120 },
      }),
    ).toEqual([]);
  });

  test.each([
    [{ name: "../x" }, "options/invalid-name"],
    [{ name: "" }, "options/invalid-name"],
    [{ name: "a/b" }, "options/invalid-name"],
    [{ name: "x".repeat(65) }, "options/invalid-name"],
    [{ idPrefix: "Pc" }, "options/invalid-id-prefix"],
    [{ idPrefix: "1pc" }, "options/invalid-id-prefix"],
    [{ idPrefix: "a".repeat(33) }, "options/invalid-id-prefix"],
    [{ speed: 0 }, "options/invalid-speed"],
    [{ speed: 10.01 }, "options/invalid-speed"],
    [{ speed: Number.NaN }, "options/invalid-speed"],
    [{ png: { scale: 0 } }, "options/invalid-png-scale"],
    [{ png: { scale: 8.5 } }, "options/invalid-png-scale"],
    [{ png: { time: -1 } }, "options/invalid-png-time"],
    [{ video: { fps: 0.5 } }, "options/invalid-video-fps"],
    [{ video: { fps: 61 } }, "options/invalid-video-fps"],
    [{ video: { durationSec: 0 } }, "options/invalid-video-duration"],
    [{ video: { durationSec: 121 } }, "options/invalid-video-duration"],
  ] as [RenderOptions, string][])("%j -> %s", (o, code) => {
    expect(codes(o)).toEqual([code]);
    expect(validateRenderOptions(o)[0]?.severity).toBe("error");
  });

  test("exportOutputs returns no outputs for invalid options", async () => {
    const r = await run(["static", "png"], { name: "../x" });
    expect(r.outputs).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["options/invalid-name"]);
  });
});

describe("raster size", () => {
  test("zoomed and unzoomed png frames share one non-integer-scale size", async () => {
    const a = await run(["png"], { png: { scale: 1.5, time: 0 } });
    const b = await run(["png"], { png: { scale: 1.5, time: 3.5 } });
    const sa = pngSize(a.outputs[0]!.data as Uint8Array);
    expect(sa).toEqual({ width: 840, height: 480 });
    expect(pngSize(b.outputs[0]!.data as Uint8Array)).toEqual(sa);
  });

  test("every video frame has the same size across camera transitions", async () => {
    const sizes: string[] = [];
    const encoder: VideoEncoder = {
      encode: async (frames, o) => {
        for (const f of frames) {
          const s = pngSize(f);
          sizes.push(`${s.width}x${s.height}`);
          expect(s).toEqual({ width: o.width, height: o.height });
        }
        return new Uint8Array([0]);
      },
    };
    await run(["mp4"], { video: { fps: 8, durationSec: 8, encoder } });
    expect(sizes).toHaveLength(64);
    expect(new Set(sizes)).toEqual(new Set(["560x320"]));
  });

  test("gif and mp4 share one rasterization pass", async () => {
    let calls = 0;
    const encoder: VideoEncoder = { encode: async () => new Uint8Array([0]) };
    const video = { fps: 4, durationSec: 2, encoder };
    await run(["gif"], { video }, buildFixture(), () => calls++);
    const single = calls;
    calls = 0;
    const r = await run(["gif", "mp4"], { video }, buildFixture(), () => calls++);
    expect(r.outputs.map((o) => o.kind)).toEqual(["gif", "mp4"]);
    expect(calls).toBe(single);
  });
});

describe("failures become diagnostics", () => {
  test("encoder failure", async () => {
    const encoder: VideoEncoder = {
      encode: async () => {
        throw new Error("boom");
      },
    };
    const r = await run(["mp4", "gif"], { video: { fps: 2, durationSec: 1, encoder } });
    expect(r.outputs.map((o) => o.kind)).toEqual(["gif"]);
    expect(r.diagnostics[0]).toMatchObject({ code: "export/encode-failed", severity: "error" });
    expect(r.diagnostics[0]?.message).toContain("boom");
  });

  test("mp4 without an encoder rejects before any work", async () => {
    let calls = 0;
    await expect(run(["static", "png", "mp4"], {}, buildFixture(), () => calls++)).rejects.toThrow(
      /encoder/,
    );
    expect(calls).toBe(0);
  });

  test("gifEncoder rejects wrong-size and non-PNG frames", async () => {
    const png = (await run(["png"], { png: { scale: 1 } })).outputs[0]!.data as Uint8Array;
    await expect(
      gifEncoder.encode([png], { fps: 1, width: 100, height: 100, format: "gif" }),
    ).rejects.toThrow(/frame is 560x320, expected 100x100/);
    await expect(
      gifEncoder.encode([new Uint8Array(40)], { fps: 1, width: 1, height: 1, format: "gif" }),
    ).rejects.toThrow(/not a PNG/);
  });
});

/** Sum of GIF graphic-control delays in centiseconds. */
function gifTotalCentis(g: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < g.length - 7; i++) {
    if (g[i] === 0x21 && g[i + 1] === 0xf9 && g[i + 2] === 4) sum += g[i + 4]! | (g[i + 5]! << 8);
  }
  return sum;
}

describe("gif timing", () => {
  test("centisecond remainders are distributed (24 fps x 1 s = 100 cs)", async () => {
    const r = await run(["gif"], { video: { fps: 24, durationSec: 1 } });
    expect(gifTotalCentis(r.outputs[0]!.data as Uint8Array)).toBe(100);
  });
});

describe("text rasterization with a TTF", () => {
  const ttf = readFileSync(
    createRequire(import.meta.url).resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"),
  );
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60" viewBox="0 0 200 60">' +
    '<rect width="200" height="60" fill="#fff"/>' +
    '<text x="10" y="40" font-family="DejaVu Sans" font-size="32" fill="#000">Cosmo</text></svg>';
  const dark = (png: Uint8Array): number => {
    // count non-white pixels by inflating through the exporter's own PNG reader
    return decodeNonWhite(png);
  };

  test("fonts render text; without fonts nothing is drawn", async () => {
    const withFont = await rasterize(svg, {
      scale: 1,
      fonts: [{ family: "DejaVu Sans", weight: 400, sfnt: new Uint8Array(ttf) }],
    });
    const without = await rasterize(svg, { scale: 1, fonts: [] });
    expect(dark(withFont)).toBeGreaterThan(200);
    expect(dark(without)).toBe(0);
  });
});

import { decodePng } from "../../src/export/png.js";
function decodeNonWhite(png: Uint8Array): number {
  const { data } = decodePng(png);
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i]! < 128) n++;
  return n;
}

describe("ffmpeg encoder hardening", () => {
  type Fake = EventEmitter & {
    stdin: EventEmitter & { write: () => boolean; end: () => void };
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  const fake = (): Fake => {
    const p = new EventEmitter() as Fake;
    p.stdin = Object.assign(new EventEmitter(), { write: () => true, end: () => undefined });
    p.stderr = new EventEmitter();
    p.kill = vi.fn();
    return p;
  };
  const o = { fps: 1, width: 2, height: 2, format: "mp4" } as const;

  test("deterministic-output flags", () => {
    const args = buildFfmpegArgs({ fps: 24, outPath: "o.mp4", crf: 18 }).join(" ");
    expect(args).toContain("-map_metadata -1");
    expect(args).toContain("-fflags +bitexact");
    expect(args).toContain("-flags:v +bitexact");
  });

  test("crf range", () => {
    expect(() => createFfmpegEncoder({ crf: 52 })).toThrow(/crf/);
    expect(() => createFfmpegEncoder({ crf: -1 })).toThrow(/crf/);
    expect(() => createFfmpegEncoder({ crf: 0 })).not.toThrow();
  });

  test("a hung ffmpeg is killed and rejected", async () => {
    const p = fake();
    const enc = createFfmpegEncoder({ spawn: (() => p) as never, timeoutMs: 20 });
    await expect(enc.encode([new Uint8Array([1])], o)).rejects.toThrow(/timed out/);
    expect(p.kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("a dead ffmpeg does not hang a blocked writer", async () => {
    const p = fake();
    p.stdin.write = () => false; // backpressure that never drains
    const enc = createFfmpegEncoder({ spawn: (() => p) as never, timeoutMs: 5000 });
    // Deterministic: the process only exists after open() resolved, and the writer is parked on
    // backpressure (write() returned false) before ffmpeg is made to exit.
    const sink = await enc.open(o);
    let settled = false;
    const blocked = sink.write(new Uint8Array([1])).then(
      () => {
        settled = true;
      },
      (e: unknown) => {
        settled = true;
        throw e;
      },
    );
    blocked.catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false); // still waiting for a drain that never comes
    p.emit("close", 1);
    await expect(blocked).rejects.toThrow(/code 1/);
  });
});
