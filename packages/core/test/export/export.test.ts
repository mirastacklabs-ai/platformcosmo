import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { createAnimator } from "../../src/anim/index.js";
import type { RenderModel, RenderOptions } from "../../src/contracts/index.js";
import { buildFfmpegArgs, createFfmpegEncoder } from "../../src/export/ffmpeg.js";
import { gifEncoder } from "../../src/export/gif.js";
import { exportOutputs, MAX_RASTER_BYTES, rasterize } from "../../src/export/index.js";
import { decodePng, pngSize } from "../../src/export/png.js";
import { buildFixture, emit, withVariant } from "../anim/fixtures/render-model.js";

vi.setConfig({ testTimeout: 60_000 });

const deps = {
  animator: createAnimator(),
  emit,
  optimize: (s: string) => s,
  rasterize,
  withVariant,
};
const run = (
  kinds: Parameters<typeof exportOutputs>[1],
  options: RenderOptions = {},
  model: RenderModel = buildFixture(),
) => exportOutputs(model, kinds, deps, options);

const text = (d: string | Uint8Array) => (typeof d === "string" ? d : "");

describe("svg outputs", () => {
  test("static: one frame, own id variant, no animation constructs", async () => {
    const { outputs } = await run(["static"], { name: "arch" });
    expect(outputs).toHaveLength(1);
    const o = outputs[0]!;
    expect(o).toMatchObject({ kind: "static", path: "arch.static.svg", mime: "image/svg+xml" });
    expect(text(o.data)).toContain('id="pc-test-st-root"');
    expect(text(o.data)).not.toContain("@keyframes");
    expect(text(o.data)).not.toContain("<animateMotion");
    expect(text(o.data)).toContain("<circle");
  });

  test("steps: one svg per step with variants and zoomed viewBox", async () => {
    const { outputs } = await run(["steps"]);
    expect(outputs.map((o) => o.path)).toEqual([
      "diagram.steps/step-01.svg",
      "diagram.steps/step-02.svg",
      "diagram.steps/step-03.svg",
    ]);
    expect(outputs.map((o) => o.step)).toEqual([1, 2, 3]);
    expect(text(outputs[0]!.data)).toContain('id="pc-test-s01-root"');
    expect(text(outputs[0]!.data)).not.toContain('viewBox="0 0 560 320"');
    expect(text(outputs[1]!.data)).toContain('viewBox="0 0 560 320"');
    expect(text(outputs[1]!.data)).toContain("<animateMotion");
  });

  test("steps without a timeline: info diagnostic, no output", async () => {
    const r = await run(["steps"], {}, buildFixture({ noSteps: true }));
    expect(r.outputs).toHaveLength(0);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["export/no-steps"]);
  });

  test("interactive: script and controls", async () => {
    const { outputs } = await run(["interactive"]);
    const svg = text(outputs[0]!.data);
    expect(outputs[0]!.path).toBe("diagram.interactive.svg");
    expect(svg).toContain("<script>");
    expect(svg).toContain("pc-test-x_btn_play");
  });

  test("optimize runs on svg outputs unless disabled", async () => {
    let calls = 0;
    const d = { ...deps, optimize: (s: string) => (calls++, s) };
    await exportOutputs(buildFixture(), ["static", "interactive"], d, {});
    expect(calls).toBe(2);
    await exportOutputs(buildFixture(), ["static"], d, { optimize: false });
    expect(calls).toBe(2);
  });

  test("animated kind is not produced here; output is deterministic", async () => {
    const a = await run(["animated", "static", "steps", "interactive"]);
    const b = await run(["interactive", "steps", "static", "animated"]);
    expect(a.outputs.map((o) => o.path)).toEqual(b.outputs.map((o) => o.path));
    expect(a.outputs.map((o) => o.data)).toEqual(b.outputs.map((o) => o.data));
    expect(a.outputs.some((o) => o.kind === "animated")).toBe(false);
  });
});

describe("png", () => {
  test("renders a PNG at the requested scale", async () => {
    const { outputs } = await run(["png"], { png: { scale: 1 } });
    const png = outputs[0]!.data as Uint8Array;
    expect(outputs[0]).toMatchObject({ path: "diagram.png", mime: "image/png" });
    expect(pngSize(png)).toEqual({ width: 560, height: 320 });
    const img = decodePng(png);
    // not blank: the objects are drawn
    expect(new Set(Array.from(img.data.filter((_, i) => i % 4 === 0))).size).toBeGreaterThan(3);
  });

  test("zoomed first frame keeps the full pixel size", async () => {
    const { outputs } = await run(["png"], { png: { scale: 2, time: 0 } });
    expect(pngSize(outputs[0]!.data as Uint8Array)).toEqual({ width: 1120, height: 640 });
  });

  test("png.time selects the frame (step 2 differs from step 1)", async () => {
    const a = await run(["png"], { png: { scale: 1, time: 0.5 } });
    const b = await run(["png"], { png: { scale: 1, time: 3.5 } });
    expect(a.outputs[0]!.data).not.toEqual(b.outputs[0]!.data);
  });

  test("byte-identical across runs", async () => {
    const a = await run(["png"], { png: { scale: 1 } });
    const b = await run(["png"], { png: { scale: 1 } });
    expect(a.outputs[0]!.data).toEqual(b.outputs[0]!.data);
  });

  test("memory cap reports export/too-large", async () => {
    const r = await run(["png"], { png: { scale: 8 } }, bigModel());
    expect(r.outputs).toHaveLength(0);
    expect(r.diagnostics[0]).toMatchObject({ severity: "error", code: "export/too-large" });
  });
});

function bigModel(): RenderModel {
  const m = buildFixture();
  return { ...m, viewBox: { x: 0, y: 0, width: 20000, height: 20000 } };
}

describe("gif and mp4", () => {
  const opts: RenderOptions = { video: { fps: 4, durationSec: 2 } };

  test("gif: valid GIF89a with the expected frame count", async () => {
    const { outputs } = await run(["gif"], opts);
    const gif = outputs[0]!.data as Uint8Array;
    expect(outputs[0]).toMatchObject({ path: "diagram.gif", mime: "image/gif" });
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe("GIF89a");
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(countGifFrames(gif)).toBe(8);
  });

  test("gif: default duration is one timeline loop", async () => {
    const { outputs } = await run(["gif"], { video: { fps: 1 } });
    expect(countGifFrames(outputs[0]!.data as Uint8Array)).toBe(8);
  });

  test("gif is deterministic", async () => {
    const a = await run(["gif"], opts);
    const b = await run(["gif"], opts);
    expect(a.outputs[0]!.data).toEqual(b.outputs[0]!.data);
  });

  test("mp4 without an encoder is a programmer error", async () => {
    await expect(run(["mp4"], opts)).rejects.toThrow(/encoder/);
  });

  test("mp4 uses the supplied encoder with PNG frames", async () => {
    let seen: { frames: number; format: string; width: number; fps: number } | undefined;
    const r = await run(["mp4"], {
      video: {
        ...opts.video,
        encoder: {
          encode: async (frames, o) => {
            seen = { frames: frames.length, format: o.format, width: o.width, fps: o.fps };
            return new Uint8Array([1, 2, 3]);
          },
        },
      },
    });
    expect(seen).toEqual({ frames: 8, format: "mp4", width: 560, fps: 4 });
    expect(r.outputs[0]).toMatchObject({ kind: "mp4", path: "diagram.mp4", mime: "video/mp4" });
  });

  test("video memory cap", async () => {
    const r = await run(
      ["gif"],
      { video: { fps: 60, durationSec: 120 } },
      {
        ...buildFixture(),
        viewBox: { x: 0, y: 0, width: 4000, height: 3000 },
      },
    );
    expect(r.diagnostics.map((d) => d.code)).toContain("export/too-large");
    expect(MAX_RASTER_BYTES).toBe(1024 ** 3);
  });

  test("gifEncoder refuses other formats and wrong-sized frames", async () => {
    await expect(
      gifEncoder.encode([], { fps: 1, width: 1, height: 1, format: "mp4" }),
    ).rejects.toThrow(/cannot encode/);
  });
});

/** Counts image descriptors by walking GIF blocks. */
function countGifFrames(g: Uint8Array): number {
  let o = 13;
  if (g[10]! & 0x80) o += 3 * (1 << ((g[10]! & 7) + 1));
  let frames = 0;
  while (o < g.length) {
    const b = g[o]!;
    if (b === 0x3b) break;
    if (b === 0x21) {
      o += 2;
      while (g[o] !== 0) o += g[o]! + 1;
      o++;
    } else if (b === 0x2c) {
      frames++;
      const packed = g[o + 9]!;
      o += 10;
      if (packed & 0x80) o += 3 * (1 << ((packed & 7) + 1));
      o++;
      while (g[o] !== 0) o += g[o]! + 1;
      o++;
    } else throw new Error(`bad gif block ${b}`);
  }
  return frames;
}

describe("ffmpeg encoder factory", () => {
  test("argument list", () => {
    const args = buildFfmpegArgs({ fps: 24, outPath: "/tmp/x.mp4", crf: 18 });
    expect(args).toContain("image2pipe");
    expect(args.slice(args.indexOf("-framerate"), args.indexOf("-framerate") + 2)).toEqual([
      "-framerate",
      "24",
    ]);
    expect(args.at(-1)).toBe("/tmp/x.mp4");
  });

  test("spawns ffmpeg, pipes frames, reads the output file", async () => {
    const { writeFile } = await import("node:fs/promises");
    const received: Buffer[] = [];
    let argv: string[] = [];
    const fake = ((bin: string, args: string[]) => {
      argv = [bin, ...args];
      const p = new EventEmitter() as EventEmitter & { stdin: PassThrough; stderr: PassThrough };
      p.stdin = new PassThrough();
      p.stderr = new PassThrough();
      p.stdin.on("data", (d: Buffer) => received.push(d));
      p.stdin.on("end", () => {
        void writeFile(args.at(-1)!, "mp4data").then(() => p.emit("close", 0));
      });
      return p;
    }) as never;
    const enc = createFfmpegEncoder({ ffmpegPath: "ffm", spawn: fake });
    const out = await enc.encode([new Uint8Array([1, 2]), new Uint8Array([3])], {
      fps: 10,
      width: 4,
      height: 4,
      format: "mp4",
    });
    expect(Buffer.from(out).toString()).toBe("mp4data");
    expect(Buffer.concat(received)).toEqual(Buffer.from([1, 2, 3]));
    expect(argv[0]).toBe("ffm");
  });

  test("failure and ENOENT surface as errors", async () => {
    const failing = (() => {
      const p = new EventEmitter() as EventEmitter & { stdin: PassThrough; stderr: PassThrough };
      p.stdin = new PassThrough();
      p.stderr = new PassThrough();
      p.stdin.resume();
      p.stdin.on("end", () => {
        p.stderr.write("boom");
        p.emit("close", 1);
      });
      return p;
    }) as never;
    const frame = [new Uint8Array([1])];
    const o = { fps: 1, width: 2, height: 2, format: "mp4" } as const;
    await expect(createFfmpegEncoder({ spawn: failing }).encode(frame, o)).rejects.toThrow(
      /code 1: boom/,
    );
    const missing = (() => {
      const p = new EventEmitter() as EventEmitter & { stdin: PassThrough; stderr: PassThrough };
      p.stdin = new PassThrough();
      p.stderr = new PassThrough();
      queueMicrotask(() => p.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })));
      return p;
    }) as never;
    await expect(createFfmpegEncoder({ spawn: missing }).encode(frame, o)).rejects.toThrow(
      /ffmpeg not found/,
    );
    await expect(createFfmpegEncoder().encode(frame, { ...o, format: "gif" })).rejects.toThrow(
      /only produces mp4/,
    );
  });
});
